/**
 * LP Auto-Discovery Adapter
 *
 * Finds a wallet's liquidity-pool positions across Stellar Soroban DEXes
 * without a hardcoded pool catalog. Two strategies, one per protocol:
 *
 *   Aquarius   — HTTP API. GET amm-api.aqua.network/api/external/v2/pools/user/{addr}/
 *                returns the exact pool list the wallet holds shares in,
 *                including per-token deposited amounts.
 *
 *   Soroswap   — Factory contract enumeration. factory.all_pairs_length() +
 *                factory.all_pairs(i) yields every pair on mainnet (once,
 *                cached for 1 hour). Then balance(user) on each pair; any
 *                nonzero result is a position.
 *
 * SushiSwap V3 is intentionally NOT handled here — the existing
 * lp-positions.js already implements Uniswap-V3 concentrated-liquidity
 * position detection for it. Duplicating would double-count.
 *
 * The manual-pool catalog in lp-positions.js is cleared for Aquarius +
 * Soroswap (discovery covers them) but the file mechanism remains for
 * pools on protocols too new for us to have written a discovery path.
 */
const {
  simulateContractCall,
  getTokenBalance,
  getLPTotalSupply,
  getPoolReserves,
  getTokenMetadata,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, nativeToScVal, scValToNative } = StellarSdk;

// ── Config ──────────────────────────────────────────────────────────────────

const AQUA_API = "https://amm-api.aqua.network/api/external/v2";
const SOROSWAP_FACTORY = "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2";

const SOROSWAP_UNIVERSE_TTL = 60 * 60_000; // pool universe changes rarely; refresh hourly
// Soroban RPC parallel batch size. 5 was safe-but-slow: a 214-pair balance
// sweep took ~8s/wallet and dominated portfolio load time. 10 halves that;
// tune via env if the RPC provider starts returning 429s.
const CONCURRENCY = parseInt(process.env.LP_DISCOVERY_CONCURRENCY || "10", 10);
const USER_POSITIONS_TTL = 5 * 60_000;     // per-user LP-position result cache

// ── Utilities ───────────────────────────────────────────────────────────────

function _shortAmount(v, decimals = 7) {
  const raw = BigInt(v || "0");
  if (raw === 0n) return 0;
  const div = 10n ** BigInt(decimals);
  const whole = raw / div;
  const frac = Number(raw % div) / Number(div);
  return Number(whole) + frac;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run `worker` over each item with bounded concurrency. Retries once on
// transient rate-limit errors (HTTP 429) with a small backoff, since
// Soroban RPC providers return those under load. Errors that survive the
// retry produce a null slot for that item.
async function _parallelMap(items, worker, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  async function pump() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (e) {
        if (/429|rate/i.test(e?.message || "")) {
          await _sleep(300 + Math.random() * 400);
          try { out[idx] = await worker(items[idx], idx); }
          catch (e2) { out[idx] = null; }
        } else { out[idx] = null; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pump));
  return out;
}

// Cache for token metadata (code, decimals) — a lookup we do a LOT
// during pool hydration. TTL: none, contracts don't change.
const _tokenMetaCache = new Map();
async function _getMeta(contractId) {
  if (_tokenMetaCache.has(contractId)) return _tokenMetaCache.get(contractId);
  const m = await getTokenMetadata(contractId).catch(() => null);
  const meta = m || { symbol: "???", decimals: 7 };
  _tokenMetaCache.set(contractId, meta);
  return meta;
}

// Stellar's native XLM asset shows up as "native" both in Aquarius's HTTP
// API (via tokens_str) and in Soroban SAC metadata (symbol() returns
// "native"). Normalize to XLM so it renders like every other asset.
function _normalizeSymbol(sym) {
  if (!sym) return "?";
  const s = String(sym).trim();
  if (s.toLowerCase() === "native") return "XLM";
  return s;
}

function _priceUSD(code, priceCtx) {
  if (!code) return 0;
  const c = _normalizeSymbol(code).toUpperCase();
  // Stablecoins we treat as $1. USDY drifts up over time, but treating
  // it as $1 is close enough for LP valuation.
  if (["USDC","USDY","PYUSD","USDX","EURC","MGUSD","USST","YLDS","USTBL"].includes(c)) return 1;
  if (c === "XLM") return priceCtx?.xlmPrice?.usd || 0;
  return 0;
}

// ── Aquarius (HTTP API) ─────────────────────────────────────────────────────

async function discoverAquariusPositions(userAddress, priceCtx) {
  const url = `${AQUA_API}/pools/user/${encodeURIComponent(userAddress)}/`;
  let res;
  try {
    res = await fetch(url);
    if (!res.ok) return [];
  } catch (e) {
    console.warn("[lp-discovery] Aquarius API failed:", e.message);
    return [];
  }
  const data = await res.json();
  const rows = data?.results || [];
  if (rows.length === 0) return [];

  // Aquarius returns `balance` (LP share amount as decimal string) and
  // `deposited_tokens` (per-token underlying amount at current price).
  // Both fields are floats, high-precision — we just parse and format.
  return rows.map(row => {
    const tokensStr = row.tokens_str || [];  // "USDY:G...", "USDC:G..."
    const codes = tokensStr.map(t => _normalizeSymbol((t.split(":")[0] || "").trim() || "?"));
    const deposited = row.deposited_tokens || {};
    const amounts = [];
    let valueUSD = 0;
    for (let i = 0; i < codes.length; i++) {
      const key = tokensStr[i];
      const amountStr = deposited[key] || "0";
      const amount = parseFloat(amountStr) || 0;
      const price = _priceUSD(codes[i], priceCtx);
      valueUSD += amount * price;
      amounts.push({ symbol: codes[i], amount: amount.toFixed(6).replace(/\.?0+$/, "") });
    }
    return {
      protocol: "aquarius",
      type: "lp",
      subtype: row.pool_type || "constant_product",
      poolContractId: row.address,
      // Rendered as "USDY / USDC" in the UI when tokens is [{symbol}, {symbol}]
      tokens: codes.map((s, i) => ({ symbol: s, contractId: (row.tokens_addresses || [])[i] || null })),
      token0: { symbol: codes[0] || "?" },
      token1: { symbol: codes[1] || "?" },
      amounts: {
        token0: amounts[0]?.amount || "0",
        token1: amounts[1]?.amount || "0",
      },
      apy7d: null, // Aquarius API doesn't expose per-pool APR/APY directly
      valueUSD,
    };
  });
}

// ── Soroswap (on-chain factory enumeration) ─────────────────────────────────

let _soroswapUniverse = { pairs: [], ts: 0 };

async function _refreshSoroswapUniverse() {
  const now = Date.now();
  if (_soroswapUniverse.pairs.length > 0 && now - _soroswapUniverse.ts < SOROSWAP_UNIVERSE_TTL) {
    return _soroswapUniverse.pairs;
  }
  try {
    const lenResult = await simulateContractCall(SOROSWAP_FACTORY, "all_pairs_length");
    const total = Number(scValToNative(lenResult));
    if (!Number.isFinite(total) || total <= 0) return _soroswapUniverse.pairs;

    const indices = Array.from({ length: total }, (_, i) => i);
    const addresses = await _parallelMap(indices, async (i) => {
      const r = await simulateContractCall(SOROSWAP_FACTORY, "all_pairs", [
        nativeToScVal(i, { type: "u32" }),
      ]);
      const v = scValToNative(r);
      return typeof v === "string" ? v : (v?.toString?.() || null);
    });
    const pairs = addresses.filter(Boolean);
    _soroswapUniverse = { pairs, ts: Date.now() };
    console.log(`[lp-discovery] Soroswap universe: ${pairs.length} pairs cached`);
    return pairs;
  } catch (e) {
    console.warn("[lp-discovery] Soroswap universe fetch failed:", e.message);
    return _soroswapUniverse.pairs;
  }
}

async function discoverSoroswapPositions(userAddress, priceCtx) {
  const pairs = await _refreshSoroswapUniverse();
  if (pairs.length === 0) return [];

  // Phase 1: fan out balance() calls in parallel. Almost all wallets hold
  // shares in 0-5 pairs, so 99% of these return "0".
  const balances = await _parallelMap(pairs, async (pair) => {
    const bal = await getTokenBalance(pair, userAddress).catch(() => "0");
    return BigInt(bal || "0") > 0n ? { pair, bal } : null;
  });
  const hits = balances.filter(Boolean);
  if (hits.length === 0) return [];

  // Phase 2: hydrate each hit with reserves + token metadata.
  return (await _parallelMap(hits, async ({ pair, bal }) => {
    try {
      const [totalSupply, reserves, t0Result, t1Result] = await Promise.all([
        getLPTotalSupply(pair),
        getPoolReserves(pair),
        simulateContractCall(pair, "token_0").catch(() => null),
        simulateContractCall(pair, "token_1").catch(() => null),
      ]);
      const total = BigInt(totalSupply || "0");
      if (total === 0n) return null;
      const share = Number(bal) / Number(total);

      // reserves shape varies (tuple vs array) — normalize
      const reserveArr = Array.isArray(reserves) ? reserves : [reserves?.[0], reserves?.[1]];
      const t0Addr = t0Result ? scValToNative(t0Result) : null;
      const t1Addr = t1Result ? scValToNative(t1Result) : null;
      const [m0, m1] = await Promise.all([
        t0Addr ? _getMeta(t0Addr.toString()) : Promise.resolve({ symbol: "?", decimals: 7 }),
        t1Addr ? _getMeta(t1Addr.toString()) : Promise.resolve({ symbol: "?", decimals: 7 }),
      ]);
      const sym0 = _normalizeSymbol(m0.symbol);
      const sym1 = _normalizeSymbol(m1.symbol);

      const userAmt0 = Number(reserveArr[0] || 0) * share;
      const userAmt1 = Number(reserveArr[1] || 0) * share;
      const amount0 = userAmt0 / (10 ** m0.decimals);
      const amount1 = userAmt1 / (10 ** m1.decimals);
      const valueUSD = amount0 * _priceUSD(sym0, priceCtx)
                     + amount1 * _priceUSD(sym1, priceCtx);

      return {
        protocol: "soroswap",
        type: "lp",
        subtype: "constant_product",
        poolContractId: pair,
        tokens: [
          { symbol: sym0, contractId: t0Addr?.toString() || null, decimals: m0.decimals },
          { symbol: sym1, contractId: t1Addr?.toString() || null, decimals: m1.decimals },
        ],
        token0: { symbol: sym0 },
        token1: { symbol: sym1 },
        amounts: {
          token0: amount0.toFixed(6).replace(/\.?0+$/, ""),
          token1: amount1.toFixed(6).replace(/\.?0+$/, ""),
        },
        apy7d: null,
        valueUSD,
      };
    } catch (e) {
      console.warn(`[lp-discovery] Soroswap hydrate failed for ${pair}:`, e.message);
      return null;
    }
  })).filter(Boolean);
}

// Per-user position cache. LP balances change over time but not per-request;
// caching for a few minutes keeps the RPC load sane on repeated views.
const _userPositionsCache = new Map();

// ── Adapter interface ───────────────────────────────────────────────────────

const LPDiscoveryAdapter = {
  protocolId: "lp-discovery",
  name: "LP Discovery (Aquarius + Soroswap)",
  type: "amm",

  isConfigured() { return true; },

  async getPositions(userAddress, priceCtx) {
    if (!userAddress || !userAddress.startsWith("G")) return [];
    const cached = _userPositionsCache.get(userAddress);
    if (cached && Date.now() - cached.ts < USER_POSITIONS_TTL) return cached.positions;

    const [aqua, soro] = await Promise.all([
      discoverAquariusPositions(userAddress, priceCtx).catch(e => {
        console.warn("[lp-discovery] Aquarius failed:", e.message); return [];
      }),
      discoverSoroswapPositions(userAddress, priceCtx).catch(e => {
        console.warn("[lp-discovery] Soroswap failed:", e.message); return [];
      }),
    ]);
    const positions = [...aqua, ...soro];
    _userPositionsCache.set(userAddress, { ts: Date.now(), positions });
    return positions;
  },
};

module.exports = LPDiscoveryAdapter;
module.exports.discoverAquariusPositions = discoverAquariusPositions;
module.exports.discoverSoroswapPositions = discoverSoroswapPositions;
// Exposed so the server can hydrate the Soroswap pair universe at boot /
// on a schedule — enumerating the factory takes many seconds, and doing it
// lazily made the first wallet load of the hour eat the whole cost.
module.exports.warmSoroswapUniverse = _refreshSoroswapUniverse;
