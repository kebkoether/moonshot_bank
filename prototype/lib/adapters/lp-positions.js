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

async function _detectSushiV3(userAddress, priceCtx) {
  try {
    const balance = await getTokenBalance(SUSHI_V3_POSITIONS_NFT, userAddress).catch(() => "0");
    const count = BigInt(balance || "0");
    if (count === 0n) return null;
    // We can detect the count of position NFTs but not the per-position
    // token amounts without enumerating each tokenId + reading its tick
    // range + reserves. Render a placeholder with the count and a link.
    return {
      protocol: "sushiswap-v3",
      type: "concentrated_lp",
      contractId: SUSHI_V3_POSITIONS_NFT,
      token0: { symbol: "—" },
      token1: { symbol: "—" },
      amounts: { token0: count.toString() + " NFT", token1: "—" },
      position: { inRange: null },
      unclaimedFees: { token0: "—", token1: "—" },
      poolName: `SushiSwap V3 (${count} position${count === 1n ? "" : "s"})`,
      valueUSD: 0, // unknown without per-position tick math
    };
  } catch (e) {
    return null;
  }
}

const LPPositionsAdapter = {
  protocolId: "lp-positions",
  name: "LP Positions",
  type: "dex",

  isConfigured() {
    return KNOWN_POOLS.length > 0;
  },

  async getPositions(userAddress, priceCtx) {
    const results = await Promise.allSettled([
      ...KNOWN_POOLS.map((p) => _readLPPosition(p, userAddress, priceCtx)),
      _detectSushiV3(userAddress, priceCtx),
    ]);
    return results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
  },
};

module.exports = LPPositionsAdapter;
