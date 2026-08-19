/**
 * Generic LP Positions Adapter for Stellar/Soroban
 *
 * Detects user liquidity-pool positions across Soroswap, Aquarius, and
 * SushiSwap V3 from a hardcoded list of known pools. Easier to extend
 * than the existing per-protocol adapters (which require env vars), and
 * has a single position-rendering shape.
 *
 * Two AMM patterns supported:
 *   1. Soroswap-style — the pool contract IS the LP share token.
 *      balance(user) on the pool returns shares directly.
 *   2. Aquarius-style — a separate share-token contract identified via
 *      share_id(). balance(user) goes against the share token.
 *
 * SushiSwap V3 (concentrated liquidity) uses an NFT pattern; positions are
 * read via the position manager's batch view (see _detectSushiV3) and valued
 * at the pool's live price.
 *
 * To add a new pool: append to KNOWN_POOLS with the right pattern.
 */
const { simulateContractCall, getTokenBalance } = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { scValToNative } = StellarSdk;
const fs = require("fs");
const path = require("path");

// Curated APYs (manually maintained, no live AMM yield feed exists for
// Soroswap/Aquarius pools yet). null entries render as "—".
const LP_YIELDS_PATH = path.join(__dirname, "..", "lp-yields.json");
let lpYieldsCache = null;
function _loadLpYields() {
  if (lpYieldsCache) return lpYieldsCache;
  try {
    lpYieldsCache = JSON.parse(fs.readFileSync(LP_YIELDS_PATH, "utf8"));
  } catch (e) {
    lpYieldsCache = { pools: {} };
  }
  return lpYieldsCache;
}

// Common Soroban token contract IDs we use for token resolution.
const TOKENS = {
  XLM: { code: "XLM", contractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", decimals: 7 },
  USDC: { code: "USDC", contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", decimals: 7 },
  USDY: { code: "USDY", contractId: "CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP", decimals: 7 },
  PYUSD: { code: "PYUSD", contractId: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2", decimals: 7 },
};

// Known LP pool catalog — MANUAL FALLBACK for pools not covered by
// lib/adapters/lp-discovery.js (which auto-discovers Aquarius via HTTP API
// and Soroswap via factory enumeration). Add entries here only for
// protocols that lp-discovery doesn't cover yet — e.g. Phoenix AMM, or
// pools on protocols too new for us to have written a discovery path.
// Aquarius + Soroswap pools should NOT be added here; they'd duplicate
// what discovery already surfaces.
//
// pattern:
//   "soroswap" — pool contract IS the LP share token, total via total_supply
//   "aquarius" — separate share token via share_id(), total via get_total_shares
//   "sushiswap-v3" — NFT-based, just detect ownership
const KNOWN_POOLS = [];

// SushiSwap V3 Positions NFT registry. Each user-held NFT is one
// concentrated-liquidity position.
const SUSHI_V3_POSITIONS_NFT = "CARTUL5AWDZYBSN7HUUJZSKCAKCIAKM7M54Z76G6KRYCK4XPR3OHUQZ4";

function _tokenPriceUSD(code, priceCtx) {
  if (code === "USDC" || code === "PYUSD" || code === "USDY") return 1; // close enough; USDY accrues yield via price drift
  if (code === "XLM") return priceCtx?.xlmPrice?.usd || 0;
  return 0;
}

function _fmtAmount(n) {
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return String(n);
  if (v === 0) return "0.00";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Read pool reserves + total shares according to the protocol pattern,
 * compute the user's pro-rata share, return a position object.
 */
async function _readLPPosition(pool, userAddress, priceCtx) {
  const userBalance = await getTokenBalance(pool.shareTokenContractId, userAddress).catch(() => "0");
  const userBn = BigInt(userBalance || "0");
  if (userBn === 0n) return null;

  let reserves = null;
  let totalShares = null;
  try {
    const rR = await simulateContractCall(pool.poolContractId, "get_reserves", []);
    if (rR) reserves = scValToNative(rR);
  } catch (e) {}

  const totalMethod = pool.pattern === "soroswap" ? "total_supply" : "get_total_shares";
  try {
    const tR = await simulateContractCall(pool.poolContractId, totalMethod, []);
    if (tR) totalShares = scValToNative(tR);
  } catch (e) {}

  if (!Array.isArray(reserves) || reserves.length < 2 || !totalShares) return null;
  const total = BigInt(totalShares);
  if (total === 0n) return null;

  // userPct as a JS number (loses some precision but fine for display)
  const userPct = Number(userBn) / Number(total);
  const amounts = pool.tokens.map((t, i) => {
    const reserve = Number(BigInt(reserves[i] || 0));
    return reserve * userPct / Math.pow(10, t.decimals);
  });
  const valueUSD = pool.tokens.reduce(
    (s, t, i) => s + amounts[i] * _tokenPriceUSD(t.code, priceCtx),
    0
  );

  const yields = _loadLpYields();
  const y = yields.pools?.[pool.poolContractId] || {};

  return {
    protocol: pool.protocol,
    type: "lp",
    contractId: pool.poolContractId,
    token0: { symbol: pool.tokens[0].code, contractId: pool.tokens[0].contractId, decimals: pool.tokens[0].decimals },
    token1: { symbol: pool.tokens[1].code, contractId: pool.tokens[1].contractId, decimals: pool.tokens[1].decimals },
    amounts: {
      token0: _fmtAmount(amounts[0]),
      token1: _fmtAmount(amounts[1]),
    },
    poolName: pool.name,
    apy7d: y.apy7d || null,
    apyAsOf: y.asOf || null,
    apySource: y.source || null,
    valueUSD,
  };
}

// SushiSwap V3 positions come from the position manager's batch view:
// get_user_positions_with_fees(owner, skip, take) returns every position
// (pair, fee tier, tick range, liquidity, accrued-but-uncollected fees) in
// ONE simulation. Amounts are then valued at the pool's live slot0 price via
// position_principal(token_id, sqrt_price_x96), so concentrated (non-stable)
// pairs value correctly on either side of the range.
const SUSHI_TTL = 5 * 60_000;
const sushiCache = new Map(); // userAddress -> { ts, positions }
const SUSHI_V3_FACTORY = "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF";
const MIN_TICK = -887272;
const MAX_TICK = 887272;

const sushiPoolCache = new Map(); // "token0|token1|fee" -> pool contract id (immutable mapping)

function _u32(n) {
  return StellarSdk.nativeToScVal(Number(n), { type: "u32" });
}

async function _sushiPool(token0, token1, fee) {
  const key = `${token0}|${token1}|${fee}`;
  if (sushiPoolCache.has(key)) return sushiPoolCache.get(key);
  const r = await simulateContractCall(SUSHI_V3_FACTORY, "get_pool", [
    new StellarSdk.Address(token0).toScVal(),
    new StellarSdk.Address(token1).toScVal(),
    _u32(fee),
  ]);
  const pool = r ? scValToNative(r) : null;
  if (typeof pool !== "string" || !pool.startsWith("C")) return null;
  sushiPoolCache.set(key, pool);
  return pool;
}

// Symbol-keyed pricing first (free), pricing engine as fallback so pairs
// beyond XLM/stables (e.g. SolvBTC pools) still get a USD value.
async function _sushiTokenPriceUSD(token, priceCtx) {
  const bySymbol = _tokenPriceUSD(token.code, priceCtx);
  if (bySymbol > 0) return bySymbol;
  try {
    const { priceSorobanToken } = require("../pricing-engine");
    const p = await priceSorobanToken(token.contractId, { decimals: token.decimals });
    if (p && Number.isFinite(p.usd)) return p.usd;
  } catch (e) {}
  return 0;
}

async function _detectSushiV3(userAddress, priceCtx) {
  const cached = sushiCache.get(userAddress);
  if (cached && Date.now() - cached.ts < SUSHI_TTL) return cached.positions;

  try {
    const raw = await simulateContractCall(
      SUSHI_V3_POSITIONS_NFT,
      "get_user_positions_with_fees",
      [new StellarSdk.Address(userAddress).toScVal(), _u32(0), _u32(100)]
    );
    const infos = raw ? scValToNative(raw) : [];

    const { getTokenMetadata } = require("../soroban-rpc");
    const positions = [];
    for (const info of infos || []) {
      const liquidity = BigInt(info.liquidity ?? 0);
      const owed0 = BigInt(info.tokens_owed0 ?? 0);
      const owed1 = BigInt(info.tokens_owed1 ?? 0);
      if (liquidity === 0n && owed0 === 0n && owed1 === 0n) continue; // closed-out NFT

      const [meta0, meta1] = await Promise.all([
        getTokenMetadata(info.token0).catch(() => null),
        getTokenMetadata(info.token1).catch(() => null),
      ]);
      const token0 = { contractId: info.token0, code: meta0?.symbol || "?", decimals: meta0?.decimals ?? 7 };
      const token1 = { contractId: info.token1, code: meta1?.symbol || "?", decimals: meta1?.decimals ?? 7 };

      // Principal at the live pool price. If the pool read fails we still
      // list the position (with fees) rather than hide it — but never guess
      // amounts from a price assumption.
      let amount0 = 0;
      let amount1 = 0;
      let inRange = null;
      if (liquidity > 0n) {
        try {
          const pool = await _sushiPool(info.token0, info.token1, info.fee);
          if (pool) {
            const slot0 = scValToNative(await simulateContractCall(pool, "slot0", []));
            inRange = slot0.tick >= info.tick_lower && slot0.tick < info.tick_upper;
            const principal = scValToNative(await simulateContractCall(
              SUSHI_V3_POSITIONS_NFT,
              "position_principal",
              [_u32(info.token_id), StellarSdk.nativeToScVal(BigInt(slot0.sqrt_price_x96), { type: "u256" })]
            ));
            amount0 = Number(BigInt(principal[0])) / Math.pow(10, token0.decimals);
            amount1 = Number(BigInt(principal[1])) / Math.pow(10, token1.decimals);
          }
        } catch (e) {
          console.warn(`SushiV3 principal read failed for token #${info.token_id}:`, e.message);
        }
      }

      const [price0, price1] = await Promise.all([
        _sushiTokenPriceUSD(token0, priceCtx),
        _sushiTokenPriceUSD(token1, priceCtx),
      ]);
      const fees0 = Number(owed0) / Math.pow(10, token0.decimals);
      const fees1 = Number(owed1) / Math.pow(10, token1.decimals);
      const valueUSD = (amount0 + fees0) * price0 + (amount1 + fees1) * price1;

      const isFullRange = info.tick_lower <= MIN_TICK + 10 && info.tick_upper >= MAX_TICK - 10;
      positions.push({
        protocol: "sushiswap-v3",
        type: "concentrated_lp",
        contractId: SUSHI_V3_POSITIONS_NFT,
        tokenId: Number(info.token_id),
        token0: { symbol: token0.code, contractId: token0.contractId, decimals: token0.decimals },
        token1: { symbol: token1.code, contractId: token1.contractId, decimals: token1.decimals },
        amounts: {
          token0: _fmtAmount(amount0),
          token1: _fmtAmount(amount1),
        },
        feeTier: Number(info.fee),
        position: { inRange, tickLower: info.tick_lower, tickUpper: info.tick_upper },
        unclaimedFees: {
          token0: _fmtAmount(fees0),
          token1: _fmtAmount(fees1),
        },
        poolName: `SushiSwap V3 ${token0.code}/${token1.code}${isFullRange ? " (full range)" : ""}`,
        valueUSD,
      });
    }

    sushiCache.set(userAddress, { ts: Date.now(), positions });
    return positions;
  } catch (e) {
    console.warn("SushiSwap V3 detection failed:", e.message);
    return [];
  }
}

// ── Auto-discovery ────────────────────────────────────────────────────────────
// Walk the user's recent Soroban activity, find any contracts they've invoked
// that expose AMM pool methods (get_reserves + get_tokens), classify pattern
// (Soroswap vs Aquarius), and merge with the hardcoded KNOWN_POOLS list.
// Cached per-wallet for 5 min — Horizon walks are expensive.

const HORIZON_BASE = "https://horizon.stellar.org";
const DISCOVERY_TTL = 5 * 60_000;
const discoveryCache = new Map(); // userAddress -> { ts, pools }

async function _userInvokedContracts(userAddress) {
  // Walk last 200 ops; collect first-Address-param of each Soroban invocation.
  const contracts = new Set();
  try {
    const res = await fetch(`${HORIZON_BASE}/accounts/${userAddress}/operations?order=desc&limit=200`);
    if (!res.ok) return contracts;
    const data = await res.json();
    for (const op of (data?._embedded?.records || [])) {
      if (op.type !== "invoke_host_function") continue;
      const addrParam = (op.parameters || []).find((p) => p.type === "Address");
      if (!addrParam) continue;
      try {
        const sv = StellarSdk.xdr.ScVal.fromXDR(addrParam.value, "base64");
        const c = scValToNative(sv);
        if (typeof c === "string" && c.startsWith("C")) contracts.add(c);
      } catch (e) {}
    }
  } catch (e) {
    console.warn("LP discovery: tx walk failed:", e.message);
  }
  return contracts;
}

async function _classifyPool(contractId) {
  // Probe: get_reserves should return array of i128 reserves; get_tokens
  // should return array of token contract addresses. If both present, it's
  // an AMM pool. share_id() returning a separate contract distinguishes
  // Aquarius-style from Soroswap-style.
  let reserves = null;
  let tokens = null;
  try {
    const r = await simulateContractCall(contractId, "get_reserves", []);
    if (r) reserves = scValToNative(r);
  } catch (e) {}
  if (!Array.isArray(reserves) || reserves.length < 2) return null;

  try {
    const r = await simulateContractCall(contractId, "get_tokens", []);
    if (r) tokens = scValToNative(r);
  } catch (e) {}
  if (!Array.isArray(tokens) || tokens.length < 2) return null;

  let pattern = "soroswap";
  let shareTokenContractId = contractId;
  try {
    const r = await simulateContractCall(contractId, "share_id", []);
    if (r) {
      const id = scValToNative(r);
      if (typeof id === "string" && id.startsWith("C")) {
        pattern = "aquarius";
        shareTokenContractId = id;
      }
    }
  } catch (e) {}

  // Resolve token metadata for nice display.
  const { getTokenMetadata } = require("../soroban-rpc");
  const tokenMeta = await Promise.all(
    tokens.map((t) =>
      getTokenMetadata(t)
        .then((m) => ({
          contractId: t,
          code: m?.symbol || "?",
          decimals: m?.decimals ?? 7,
        }))
        .catch(() => ({ contractId: t, code: "?", decimals: 7 }))
    )
  );

  return {
    protocol: pattern,
    pattern,
    name: `${pattern === "aquarius" ? "Aquarius" : "Soroswap"} ${tokenMeta.map((t) => t.code).join("/")}`,
    poolContractId: contractId,
    shareTokenContractId,
    tokens: tokenMeta,
  };
}

async function _discoverPools(userAddress) {
  const cached = discoveryCache.get(userAddress);
  if (cached && Date.now() - cached.ts < DISCOVERY_TTL) return cached.pools;

  const contracts = await _userInvokedContracts(userAddress);
  // Skip contracts we've already cataloged in KNOWN_POOLS
  const known = new Set(KNOWN_POOLS.map((p) => p.poolContractId));
  const candidates = [...contracts].filter((c) => !known.has(c) && c !== SUSHI_V3_POSITIONS_NFT);

  // Probe in parallel — each takes ~3 RPC calls, so cap concurrency.
  const classifications = await Promise.allSettled(candidates.map((c) => _classifyPool(c)));
  const discovered = classifications
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);

  const pools = [...KNOWN_POOLS, ...discovered];
  discoveryCache.set(userAddress, { ts: Date.now(), pools });
  return pools;
}

const LPPositionsAdapter = {
  protocolId: "lp-positions",
  name: "LP Positions",
  type: "dex",

  isConfigured() {
    return true; // auto-discovery means we're always configured
  },

  async getPositions(userAddress, priceCtx) {
    const pools = await _discoverPools(userAddress);
    const [poolResults, sushiPositions] = await Promise.all([
      Promise.allSettled(pools.map((p) => _readLPPosition(p, userAddress, priceCtx))),
      _detectSushiV3(userAddress, priceCtx).catch(() => []),
    ]);
    const lpPositions = poolResults
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
    return [...lpPositions, ...(sushiPositions || [])];
  },
};

module.exports = LPPositionsAdapter;
