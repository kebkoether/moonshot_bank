/**
 * Pricing Engine
 *
 * Single entry point for valuing any Stellar/Soroban asset in USD.
 *
 * Layered fallback (highest priority → lowest):
 *   1. Stablecoin shortcut    — hardcoded $1 for verified stablecoin issuers
 *   2. Token price map        — CoinGecko-id lookup, then fetch CoinGecko price
 *   3. Stellar SDEX orderbook — for classic assets, via Horizon
 *   4. Soroswap Aggregator    — via the unified Soroban AMM aggregator
 *   5. Unpriced               — return null, caller renders "No price"
 *
 * Each layer returns a consistent shape so callers don't need to branch:
 *   { usd, change24h, source, confidence?, depthOk?, priceImpact? } | null
 *
 * `source` values: 'stablecoin' | 'coingecko' | 'sdex' | 'soroswap-aggregator'
 * `confidence` (when present): 'high' | 'thin-liquidity'
 */

const StellarSdk = require("@stellar/stellar-sdk");
const priceMap = require("./token-price-map");
const aggregator = require("./soroswap-aggregator");

// ── Configuration ────────────────────────────────────────────────────────────

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const PRICE_TTL_MS = parseInt(process.env.PRICE_TTL_MS || "60000", 10); // 1 min
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// Hardcoded stablecoin issuers (preserved from server.js for compatibility)
const STABLECOINS = {
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": 1.0,
  "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP": 1.0,
  "yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6FDFDZQI3D2URRQMHI4BSFS7SN2F": 1.0,
};

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map(); // key → { price, ts }

function _cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PRICE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.price;
}
function _cacheSet(key, price) {
  cache.set(key, { price, ts: Date.now() });
}

// ── In-flight dedup ──────────────────────────────────────────────────────────

const inFlight = new Map();
async function _dedup(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ── CoinGecko fetcher ────────────────────────────────────────────────────────

const cgPriceCache = new Map(); // coingeckoId → { usd, change24h, ts }

async function _coingeckoPrice(coingeckoId) {
  if (!coingeckoId) return null;
  const hit = cgPriceCache.get(coingeckoId);
  if (hit && Date.now() - hit.ts < PRICE_TTL_MS) return hit;
  try {
    const url = `${COINGECKO_API}/simple/price?ids=${encodeURIComponent(coingeckoId)}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    if (!res.ok) {
      // 429 (rate limit) / 5xx: return stale cache if available rather
      // than null. Stale price is much better than zeroing out a position.
      if (hit) return hit;
      return null;
    }
    const data = await res.json();
    const entry = data[coingeckoId];
    if (!entry || !entry.usd) {
      if (hit) return hit;
      return null;
    }
    const out = {
      usd: entry.usd,
      change24h: entry.usd_24h_change || 0,
      ts: Date.now(),
    };
    cgPriceCache.set(coingeckoId, out);
    return out;
  } catch (e) {
    // Network / parse failure — same stale-fallback policy.
    if (hit) return hit;
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Price a classic Stellar trustline asset.
 * @param {object} ctx - { horizon, getXLMPrice } — caller supplies Horizon SDK + XLM price fetcher
 * @param {string} code
 * @param {string} issuer
 * @returns {Promise<{usd, change24h, source, confidence?}|null>}
 */
async function priceClassicAsset(ctx, code, issuer) {
  const cacheKey = `classic:${code}:${issuer}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  return _dedup(cacheKey, async () => {
    // Layer 1: stablecoin shortcut
    const stableKey = `${code}:${issuer}`;
    if (STABLECOINS[stableKey] !== undefined) {
      const p = { usd: STABLECOINS[stableKey], change24h: 0, source: "stablecoin", confidence: "high" };
      _cacheSet(cacheKey, p);
      return p;
    }

    // Layer 2: CoinGecko via price map
    priceMap._maybeRefresh();
    const cgId = priceMap.lookupClassic(code, issuer);
    if (cgId) {
      const cg = await _coingeckoPrice(cgId);
      if (cg) {
        const p = { usd: cg.usd, change24h: cg.change24h, source: "coingecko", confidence: "high" };
        _cacheSet(cacheKey, p);
        return p;
      }
    }

    // Layer 3: SDEX (delegated to caller's existing fn, passed via ctx)
    if (ctx && typeof ctx.priceViaSDEX === "function") {
      const sdex = await ctx.priceViaSDEX(code, issuer);
      if (sdex && sdex.usd > 0) {
        const p = { ...sdex, source: "sdex", confidence: "high" };
        _cacheSet(cacheKey, p);
        return p;
      }
    }

    // Layer 4: Soroswap Aggregator via SAC wrapper
    const aggResult = await aggregator.priceClassicAssetViaSACInUSD(code, issuer);
    if (aggResult && aggResult.usd > 0) {
      _cacheSet(cacheKey, aggResult);
      return aggResult;
    }

    // Layer 5: unpriced
    _cacheSet(cacheKey, null);
    return null;
  });
}

/**
 * Price a Soroban token.
 * @param {string} contractId C-strkey
 * @param {object} [opts]
 * @param {number} [opts.decimals=7] Token decimals (defaults to Stellar's 7 if unknown)
 * @returns {Promise<{usd, change24h, source, confidence?}|null>}
 */
async function priceSorobanToken(contractId, opts = {}) {
  if (!contractId) return null;
  const cacheKey = `soroban:${contractId}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  return _dedup(cacheKey, async () => {
    // Layer 2: CoinGecko via price map (using contract ID)
    priceMap._maybeRefresh();
    const cgId = priceMap.lookupSoroban(contractId);
    if (cgId) {
      const cg = await _coingeckoPrice(cgId);
      if (cg) {
        const p = { usd: cg.usd, change24h: cg.change24h, source: "coingecko", confidence: "high" };
        _cacheSet(cacheKey, p);
        return p;
      }
    }

    // Layer 4: Soroswap Aggregator
    const aggResult = await aggregator.priceSorobanTokenInUSD(contractId, opts.decimals || 7);
    if (aggResult && aggResult.usd > 0) {
      _cacheSet(cacheKey, aggResult);
      return aggResult;
    }

    // Unpriced
    _cacheSet(cacheKey, null);
    return null;
  });
}

/**
 * Convenience: enrich a discovered/registered Soroban token result with a
 * priced valueUSD. Pass through the same shape; mutate valueUSD/price/source.
 */
async function enrichSorobanTokenWithPrice(token) {
  if (!token || !token.asset || !token.asset.contractId) return token;
  const price = await priceSorobanToken(token.asset.contractId, { decimals: token.decimals });
  if (price) {
    const balanceNum = parseFloat(token.balance);
    token.price = price;
    token.valueUSD = Number.isFinite(balanceNum) ? balanceNum * price.usd : 0;
    token.priceSource = price.source;
    token.priceConfidence = price.confidence || "high";
  }
  return token;
}

// ── Stats / debugging ────────────────────────────────────────────────────────

/**
 * Pre-seed the Soroban token price cache. Useful for avoiding redundant
 * CoinGecko calls when the caller already knows the price (e.g. the server
 * fetches the XLM price for native balances — seeding the XLM SAC contract
 * here prevents a second CoinGecko call that may hit rate limits).
 */
function seedSorobanPrice(contractId, priceObj) {
  if (!contractId || !priceObj) return;
  _cacheSet(`soroban:${contractId}`, priceObj);
}

function stats() {
  return {
    cacheSize: cache.size,
    cgCacheSize: cgPriceCache.size,
    inFlight: inFlight.size,
    priceMap: priceMap.stats(),
  };
}

module.exports = {
  priceClassicAsset,
  priceSorobanToken,
  enrichSorobanTokenWithPrice,
  seedSorobanPrice,
  STABLECOINS,
  stats,
};
