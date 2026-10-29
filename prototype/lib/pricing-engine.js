/**
 * Pricing Engine
 *
 * Single entry point for valuing any Stellar/Soroban asset in USD.
 *
 * Layered fallback (highest priority → lowest):
 *   1. Stablecoin shortcut    — hardcoded $1 for verified stablecoin issuers
 *   2. Token price map        — CoinGecko-id lookup, then fetch CoinGecko price
 *   3. Stellar SDEX orderbook — for classic assets, via Horizon
 *   4. AMM pools              — the deepest Aquarius or Soroswap pool against
 *                               USDC or XLM (lib/soroswap-aggregator.js)
 *   5. Unpriced               — return null, caller renders "No price"
 *
 * Soroban tokens: the CoinGecko map by contract id; then, for a Stellar Asset
 * Contract, the stablecoin list and CoinGecko for the classic asset it wraps;
 * then the AMM pools.
 *
 * Each layer returns a consistent shape so callers don't need to branch:
 *   { usd, change24h, source, confidence?, depthUSD? } | null
 *
 * `source` values: 'stablecoin' | 'coingecko' | 'sdex' | 'aquarius' | 'soroswap'
 * `confidence` (when present): 'high'
 */

const StellarSdk = require("@stellar/stellar-sdk");
const priceMap = require("./token-price-map");
const aggregator = require("./soroswap-aggregator");
const sacMapping = require("./sac-mapping");

// ── Configuration ────────────────────────────────────────────────────────────

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const PRICE_TTL_MS = parseInt(process.env.PRICE_TTL_MS || "60000", 10); // 1 min
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// Hardcoded stablecoin issuers (preserved from server.js for compatibility)
const STABLECOINS = {
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": 1.0,
  "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP": 1.0,
  "yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF": 1.0,
};

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map(); // key → { price, ts }; price null = "no price found"

// "No price" is remembered too, and for longer than a price. Finding none
// means trying every layer, and the AMM layer alone makes several RPC
// calls (about half a second) per token. Before this was cached, a wallet
// holding a few unpriced tokens paid that on every load: about 3 of the
// ~8 seconds a large Blend wallet took, against an 8-second adapter timeout.
const UNPRICED_TTL_MS = 5 * 60 * 1000;

// Except when CoinGecko is why there is no price. Its free tier rate-limits
// shared IPs, so a token CoinGecko does price can come back empty for a
// moment; remembering that kept e.g. Blend's EURC at "No price" (and out of
// every total) for 5 minutes after CoinGecko answered again. Each pricing
// run notes whether a CoinGecko lookup for it came back empty (set in
// _coingeckoPrice, so every layer that asks CoinGecko is covered), and such
// a "no price" is not cached at all: the next load asks again.
const { AsyncLocalStorage } = require("async_hooks");
const pricingRun = new AsyncLocalStorage();

/** The cached price (null = known to have none), or undefined if not cached. */
function _cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  const ttl = hit.price == null ? UNPRICED_TTL_MS : PRICE_TTL_MS;
  if (Date.now() - hit.ts > ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.price;
}
function _cacheSet(key, price) {
  if (price == null && pricingRun.getStore()?.coingeckoMissed) return; // see pricingRun
  cache.set(key, { price, ts: Date.now() });
}

// ── In-flight dedup ──────────────────────────────────────────────────────────

const inFlight = new Map();
async function _dedup(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = pricingRun.run({ coingeckoMissed: false }, fn).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ── CoinGecko fetcher ────────────────────────────────────────────────────────

const cgPriceCache = new Map(); // coingeckoId → { usd, change24h, ts }

// Micro-batched fetcher. CoinGecko's free tier rate-limits per REQUEST,
// not per id — a portfolio render used to fire one /simple/price call per
// asset, and the burst tripped 429s on every cold cache. Assets then fell
// through to the SDEX/venue fallbacks (or went unpriced) for a cycle,
// which is exactly the "wrong total on first load, corrects a minute
// later" symptom. Lookups arriving within the same tick-window now share
// ONE request for all their ids.
let cgBatchQueue = new Map(); // coingeckoId → [resolve, ...]
let cgBatchTimer = null;
const CG_BATCH_WINDOW_MS = 25;
// When CoinGecko fails, its last price for an id is served for at most this
// long (marked stale); after that the asset falls through to the next layer
// (SDEX, the AMM pools) or goes unpriced. A silently frozen price is how
// the old Freighter XLM feed went wrong for weeks.
const CG_MAX_STALE_MS = 15 * 60 * 1000;

function _coingeckoPrice(coingeckoId) {
  if (!coingeckoId) return Promise.resolve(null);
  return _coingeckoBatched(coingeckoId).then((r) => {
    const run = pricingRun.getStore();
    if (!r && run) run.coingeckoMissed = true;
    return r;
  });
}

function _coingeckoBatched(coingeckoId) {
  const hit = cgPriceCache.get(coingeckoId);
  if (hit && Date.now() - hit.ts < PRICE_TTL_MS) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const waiters = cgBatchQueue.get(coingeckoId);
    if (waiters) waiters.push(resolve);
    else cgBatchQueue.set(coingeckoId, [resolve]);
    if (!cgBatchTimer) {
      cgBatchTimer = setTimeout(_flushCoingeckoBatch, CG_BATCH_WINDOW_MS);
      cgBatchTimer.unref?.();
    }
  });
}

async function _flushCoingeckoBatch() {
  const queue = cgBatchQueue;
  cgBatchQueue = new Map();
  cgBatchTimer = null;

  let data = {};
  try {
    const ids = [...queue.keys()].join(",");
    const url = `${COINGECKO_API}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    if (res.ok) data = await res.json();
    // Non-ok (429/5xx) leaves data empty → per-id stale fallback below.
  } catch (e) {
    // Network / parse failure — same stale-fallback policy.
  }

  for (const [id, resolvers] of queue) {
    const entry = data[id];
    let out;
    if (entry && entry.usd) {
      out = { usd: entry.usd, change24h: entry.usd_24h_change || 0, ts: Date.now() };
      cgPriceCache.set(id, out);
    } else {
      // A recent price is much better than zeroing out a position, but it
      // says it is stale, and it isn't served forever (CG_MAX_STALE_MS).
      const last = cgPriceCache.get(id);
      out = last && Date.now() - last.ts <= CG_MAX_STALE_MS ? { ...last, stale: true } : null;
    }
    for (const resolve of resolvers) resolve(out);
  }
}

// A stale CoinGecko price carries stale: true and the time it was fetched.
function _staleFields(cg) {
  return cg.stale ? { stale: true, asOf: cg.ts } : {};
}

// ── Cache priming ────────────────────────────────────────────────────────────

let lastPrimeTs = 0;
let primeInFlight = null;

/**
 * Warm the CoinGecko cache for EVERY id the token map knows, in one
 * batched request. Portfolio routes price assets sequentially, so without
 * this a cold cache meant one CG call per asset — a burst the free tier
 * answers with 429s, sending assets down the SDEX/venue fallbacks (or
 * unpriced) for a cycle and producing wrong first-load totals. Throttled
 * to once per TTL window; failures are silent (per-asset lookups still
 * run their own fallback chain).
 */
async function primeKnownPrices() {
  if (Date.now() - lastPrimeTs < PRICE_TTL_MS) return;
  if (primeInFlight) return primeInFlight;
  primeInFlight = (async () => {
    lastPrimeTs = Date.now();
    try {
      const ids = priceMap.allCoingeckoIds();
      if (ids.length === 0) return;
      const url = `${COINGECKO_API}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const now = Date.now();
      for (const [id, entry] of Object.entries(data)) {
        if (entry && entry.usd) {
          cgPriceCache.set(id, { usd: entry.usd, change24h: entry.usd_24h_change || 0, ts: now });
        }
      }
    } catch (e) {
      // Cold-start network hiccup — fallback chain covers it.
    } finally {
      primeInFlight = null;
    }
  })();
  return primeInFlight;
}

// ── Stellar Asset Contracts ──────────────────────────────────────────────────
//
// Much of what Soroban protocols hold is a Stellar Asset Contract (SAC): the
// Soroban face of a classic asset. Blend's reserves include the SACs of EURC,
// AQUA, CETES, USDGLO and TESOURO. Nothing priced those through their classic
// asset, so they came back unpriced and their positions dropped out of
// totals. lib/sac-mapping.js resolveSacAsset() identifies them (verified
// against the contract id, so a contract can't just claim to be one).

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
  if (cached !== undefined) return cached;

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
    // Strict: only the issuer CoinGecko lists gets its price. Anyone can
    // issue an asset with any code, and spam issuers do (a wallet holding
    // 103M fake PYUSD showed as $103M). Those fall through to the market
    // layers below and get what their own market says.
    const cgId = priceMap.lookupClassic(code, issuer, { strict: true });
    if (cgId) {
      const cg = await _coingeckoPrice(cgId);
      if (cg) {
        const p = { usd: cg.usd, change24h: cg.change24h, source: "coingecko", confidence: "high", ..._staleFields(cg) };
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

    // Layer 4: AMM pools, via the asset's Stellar Asset Contract
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
  if (cached !== undefined) return cached;

  return _dedup(cacheKey, async () => {
    // Layer 2: CoinGecko via price map (using contract ID)
    priceMap._maybeRefresh();
    const cgId = priceMap.lookupSoroban(contractId);
    if (cgId) {
      const cg = await _coingeckoPrice(cgId);
      if (cg) {
        const p = { usd: cg.usd, change24h: cg.change24h, source: "coingecko", confidence: "high", ..._staleFields(cg) };
        _cacheSet(cacheKey, p);
        return p;
      }
    }

    // Layer 3: a Stellar Asset Contract takes the stablecoin or CoinGecko
    // price of the classic asset it wraps, matched strictly on code and
    // issuer. Not the classic SDEX layer: on thin books it values off the
    // best bid (e.g. EURx at $0.11, GBPx at $0.29), worse than no price.
    const classic = await sacMapping.resolveSacAsset(contractId);
    if (classic) {
      const stable = STABLECOINS[`${classic.code}:${classic.issuer}`];
      if (stable !== undefined) {
        const p = { usd: stable, change24h: 0, source: "stablecoin", confidence: "high" };
        _cacheSet(cacheKey, p);
        return p;
      }
      const classicCgId = priceMap.lookupClassic(classic.code, classic.issuer, { strict: true });
      if (classicCgId) {
        const cg = await _coingeckoPrice(classicCgId);
        if (cg) {
          const p = { usd: cg.usd, change24h: cg.change24h, source: "coingecko", confidence: "high" };
          _cacheSet(cacheKey, p);
          return p;
        }
      }
    }

    // Layer 4: AMM pools
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
  primeKnownPrices,
  seedSorobanPrice,
  STABLECOINS,
  stats,
};
