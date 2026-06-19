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
 * SushiSwap V3 (concentrated liquidity) uses an NFT pattern; we just
 * detect ownership and render a placeholder card linking to their UI.
 * Tick-math + NFT-tokenId enumeration is a follow-up.
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

// Known LP pool catalog. Add new pools here as users provide liquidity.
// pattern:
//   "soroswap" — pool contract IS the LP share token, total via total_supply
//   "aquarius" — separate share token via share_id(), total via get_total_shares
//   "sushiswap-v3" — NFT-based, just detect ownership
const KNOWN_POOLS = [
  {
    protocol: "soroswap",
    pattern: "soroswap",
    name: "Soroswap XLM/USDC",
    poolContractId: "CAM7DY53G63XA4AJRS24Z6VFYAFSSF76C3RZ45BE5YU3FQS5255OOABP",
    shareTokenContractId: "CAM7DY53G63XA4AJRS24Z6VFYAFSSF76C3RZ45BE5YU3FQS5255OOABP",
    tokens: [TOKENS.XLM, TOKENS.USDC],
  },
  {
    protocol: "aquarius",
    pattern: "aquarius",
    name: "Aquarius USDY/USDC",
    poolContractId: "CAFHLHGZXOVNCGFJ7DOXL7JDNMBCEZKDI3LS5NRQH3GXC7CSIMQZHUSM",
    shareTokenContractId: "CCYD4C2WFWIIDF235SCDXEWL5RT6S53WQWLDHUTQ5USZ5VNF5NHJGVW7",
    tokens: [TOKENS.USDY, TOKENS.USDC],
  },
];

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

// SushiSwap V3 NFT enumeration cache. Max tokenId is binary-searched once,
// then we scan a recent window. Cache results per-wallet to avoid the scan
// on every portfolio refresh.
const SUSHI_TTL = 5 * 60_000;
const sushiCache = new Map(); // userAddress -> { ts, positions }
const MIN_TICK = -887272;
const MAX_TICK = 887272;

async function _sushiOwnerOf(tokenId) {
  try {
    const r = await simulateContractCall(SUSHI_V3_POSITIONS_NFT, "owner_of",
      [StellarSdk.nativeToScVal(tokenId, { type: "u32" })]);
    if (!r) return null;
    const v = scValToNative(r);
    return typeof v === "string" ? v : null;
  } catch (e) {
    return null;
  }
}

async function _sushiMaxTokenId() {
  // Doubling probe + binary search to find max valid tokenId.
  let lo = 0, hi = 1;
  while ((await _sushiOwnerOf(hi)) !== null) {
    lo = hi;
    hi *= 2;
    if (hi > 100000) break;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await _sushiOwnerOf(mid)) !== null) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function _sushiUserTokenIds(userAddress, expectedCount, maxId) {
  // Scan descending from maxId until we've found all the user's tokens or
  // walked SCAN_DEPTH ids. Most users mint recently, so descending hits
  // their positions quickly.
  const SCAN_DEPTH = 500;
  const found = [];
  const lower = Math.max(0, maxId - SCAN_DEPTH);
  for (let id = maxId; id >= lower; id--) {
    const o = await _sushiOwnerOf(id);
    if (o === userAddress) {
      found.push(id);
      if (found.length >= expectedCount) break;
    }
  }
  return found;
}

async function _readSushiPosition(tokenId) {
  try {
    const r = await simulateContractCall(SUSHI_V3_POSITIONS_NFT, "positions",
      [StellarSdk.nativeToScVal(tokenId, { type: "u32" })]);
    if (!r) return null;
    const arr = scValToNative(r);
    // Layout: [nonce, token0, token1, fee, tickLower, tickUpper, liquidity,
    //          feeGrowthInside0LastX128, feeGrowthInside1LastX128,
    //          tokensOwed0, tokensOwed1]
    if (!Array.isArray(arr) || arr.length < 7) return null;
    return {
      tokenId,
      token0Address: arr[1],
      token1Address: arr[2],
      fee: Number(arr[3]),
      tickLower: Number(arr[4]),
      tickUpper: Number(arr[5]),
      liquidity: BigInt(arr[6] || 0),
      tokensOwed0: BigInt(arr[9] || 0),
      tokensOwed1: BigInt(arr[10] || 0),
    };
  } catch (e) {
    return null;
  }
}

// Approximate token amounts in a Uniswap V3 position. For full-range
// positions (tickLower=MIN_TICK, tickUpper=MAX_TICK), liquidity at price=1
// resolves to ~liquidity-units of each token, which works well for stable
// pairs like PYUSD/USDC. For concentrated positions we'd need the pool's
// slot0() current sqrtPriceX96 — punt with a TVL-based approximation.
function _approxAmounts(pos, token0, token1, sqrtPriceCurrent) {
  const L = Number(pos.liquidity);
  const isFullRange = pos.tickLower <= MIN_TICK + 10 && pos.tickUpper >= MAX_TICK - 10;
  const sqrtPa = Math.pow(1.0001, pos.tickLower / 2);
  const sqrtPb = Math.pow(1.0001, pos.tickUpper / 2);

  // Default sqrtP=1 (stable-pair assumption). The caller can pass the
  // pool's actual slot0 if known.
  const sqrtP = sqrtPriceCurrent || 1;

  let amount0Raw = 0;
  let amount1Raw = 0;
  if (sqrtP <= sqrtPa) {
    amount0Raw = L * (sqrtPb - sqrtPa) / (sqrtPa * sqrtPb);
  } else if (sqrtP >= sqrtPb) {
    amount1Raw = L * (sqrtPb - sqrtPa);
  } else {
    amount0Raw = L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb);
    amount1Raw = L * (sqrtP - sqrtPa);
  }

  // Sushi V3 uses 7-decimal token amounts on Soroban. Divide by 10^7.
  // The math above gives raw token amounts in the contract's scale.
  return {
    amount0: amount0Raw / Math.pow(10, token0.decimals),
    amount1: amount1Raw / Math.pow(10, token1.decimals),
    isFullRange,
  };
}

async function _detectSushiV3(userAddress, priceCtx) {
  const cached = sushiCache.get(userAddress);
  if (cached && Date.now() - cached.ts < SUSHI_TTL) return cached.positions;

  try {
    const balance = await getTokenBalance(SUSHI_V3_POSITIONS_NFT, userAddress).catch(() => "0");
    const count = Number(BigInt(balance || "0"));
    if (count === 0) {
      sushiCache.set(userAddress, { ts: Date.now(), positions: [] });
      return [];
    }

    const maxId = await _sushiMaxTokenId();
    const userTokenIds = await _sushiUserTokenIds(userAddress, count, maxId);

    const { getTokenMetadata } = require("../soroban-rpc");
    const positions = [];
    for (const tokenId of userTokenIds) {
      const pos = await _readSushiPosition(tokenId);
      if (!pos) continue;

      const [meta0, meta1] = await Promise.all([
        getTokenMetadata(pos.token0Address).catch(() => null),
        getTokenMetadata(pos.token1Address).catch(() => null),
      ]);
      const token0 = {
        contractId: pos.token0Address,
        code: meta0?.symbol || "?",
        decimals: meta0?.decimals ?? 7,
      };
      const token1 = {
        contractId: pos.token1Address,
        code: meta1?.symbol || "?",
        decimals: meta1?.decimals ?? 7,
      };

      const amts = _approxAmounts(pos, token0, token1, null);
      const price0 = _tokenPriceUSD(token0.code, priceCtx);
      const price1 = _tokenPriceUSD(token1.code, priceCtx);
      const valueUSD = amts.amount0 * price0 + amts.amount1 * price1;

      positions.push({
        protocol: "sushiswap-v3",
        type: "concentrated_lp",
        contractId: SUSHI_V3_POSITIONS_NFT,
        tokenId,
        token0: { symbol: token0.code, contractId: token0.contractId, decimals: token0.decimals },
        token1: { symbol: token1.code, contractId: token1.contractId, decimals: token1.decimals },
        amounts: {
          token0: _fmtAmount(amts.amount0),
          token1: _fmtAmount(amts.amount1),
        },
        feeTier: pos.fee,
        position: { inRange: amts.isFullRange ? true : null },
        unclaimedFees: {
          token0: _fmtAmount(Number(pos.tokensOwed0) / Math.pow(10, token0.decimals)),
          token1: _fmtAmount(Number(pos.tokensOwed1) / Math.pow(10, token1.decimals)),
        },
        poolName: `SushiSwap V3 ${token0.code}/${token1.code}${amts.isFullRange ? " (full range)" : ""}`,
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
