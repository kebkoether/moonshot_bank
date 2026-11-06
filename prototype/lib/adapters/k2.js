// K2 Lend (Kinetic) position adapter — Aave-V3-style lending on Soroban.
// Docs: https://docs.k2lend.com  Contracts: https://docs.k2lend.com/contracts
//
// Model: each reserve has an aToken (supply receipt) and a variable-debt
// ledger. Wallet balances on those tokens are *scaled*; multiply by the
// reserve's liquidity_index / variable_borrow_index (RAY = 1e27) to get
// underlying units. current_liquidity_rate / current_variable_borrow_rate are
// RAY-scaled rates — verified empirically 2026-08-14: the SolvBTC reserve
// returned 0.10228, matching the 10.23% APY shown on app.k2lend.com.
const { simulateContractCall, getTokenBalanceStrict } = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative } = StellarSdk;
const { priceSorobanToken } = require("../pricing-engine");

const K2_ROUTER =
  process.env.K2_ROUTER_CONTRACT ||
  "CCTUJZLYFAW7ZNQD2SXMUZIHBUUJJICYRKWLZJ6SK6TGNAWNXOJIV6J7";

const RAY = 1e27;

let reserveListCache = null;          // asset contract ids (never change)
const reserveMetaCache = new Map();   // asset -> { symbol, decimals, aToken, debtToken }

async function view(contractId, method, args = []) {
  const r = await simulateContractCall(contractId, method, args);
  return r == null ? null : scValToNative(r);
}

async function getReservesList() {
  if (reserveListCache) return reserveListCache;
  const list = await view(K2_ROUTER, "get_reserves_list");
  if (Array.isArray(list) && list.length) reserveListCache = list;
  return list || [];
}

async function getReserveData(asset) {
  return view(K2_ROUTER, "get_reserve_data", [new Address(asset).toScVal()]);
}

// Read a token's decimals, retrying on transient RPC failures.
//
// This MUST NOT fall back to a guess. Reserves here are not uniform — USDC,
// XLM and PYUSD are 7-decimal but SolvBTC is 8 — so defaulting to 7 silently
// overstates an 8-decimal position by exactly 10x. That is precisely what
// happened in production when the public RPC started returning 429s: the
// decimals call failed, the old code swallowed the error and defaulted, and
// a $8.05 SolvBTC position rendered as $80.53. A missing position is
// recoverable; a confidently wrong balance is not.
async function readDecimals(asset) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = Number(await view(asset, "decimals"));
      if (Number.isFinite(d) && d >= 0 && d <= 18) return d;
      lastErr = new Error(`implausible decimals: ${d}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt)); // 250ms, 500ms
  }
  throw new Error(`could not read decimals for ${asset}: ${lastErr && lastErr.message}`);
}

// Throws when the reserve's decimals can't be read: the whole read fails (the
// server then serves K2's last good result, or shows it as unavailable), as
// skipping the reserve dropped the wallet's position in it without a sign.
async function getReserveMeta(asset, data) {
  if (reserveMetaCache.has(asset)) return reserveMetaCache.get(asset);
  const decimals = await readDecimals(asset);
  let symbol = null;
  try { symbol = await view(asset, "symbol"); } catch (_) {}
  let cleanSymbol = typeof symbol === "string" ? symbol.replace(/\0+$/, "") : asset.slice(0, 4);
  if (cleanSymbol === "native") cleanSymbol = "XLM"; // SAC XLM reports "native"
  const meta = {
    asset,
    symbol: cleanSymbol,
    decimals,
    aToken: data.a_token_address,
    debtToken: data.debt_token_address,
  };
  reserveMetaCache.set(asset, meta);
  return meta;
}

// A balance that can't be read throws (after the RPC retries): read as 0, a
// failed debt read dropped the wallet's K2 borrow and overstated its net worth
// by the whole debt, and the server kept that as K2's last good result.
async function tokenBalance(tokenId, userAddress) {
  return BigInt(await getTokenBalanceStrict(tokenId, userAddress));
}

/** One reserve's row for the wallet, or null if it has nothing there. Throws if any read fails. */
async function readReserve(asset, userAddress) {
  const data = await getReserveData(asset);
  if (!data) return null;
  const meta = await getReserveMeta(asset, data);
  const [scaledSupply, scaledDebt] = await Promise.all([
    tokenBalance(meta.aToken, userAddress),
    tokenBalance(meta.debtToken, userAddress),
  ]);
  if (scaledSupply === 0n && scaledDebt === 0n) return null;

  const liquidityIndex = Number(data.liquidity_index) / RAY;
  const borrowIndex = Number(data.variable_borrow_index) / RAY;
  const supplyApy = Number(data.current_liquidity_rate) / RAY;
  const borrowApy = Number(data.current_variable_borrow_rate) / RAY;
  const denom = 10 ** meta.decimals;
  const supplied = (Number(scaledSupply) / denom) * liquidityIndex;
  const borrowed = (Number(scaledDebt) / denom) * borrowIndex;

  let price = null;
  // Second arg is an OPTIONS object ({ decimals }), not a symbol string.
  // No price is shown as "no price", not dropped (see getPositions).
  try { price = await priceSorobanToken(asset, { decimals: meta.decimals }); } catch (_) {}
  const usd = price && price.usd != null ? price.usd : null;
  const suppliedUSD = usd != null ? supplied * usd : 0;
  const borrowedUSD = usd != null ? borrowed * usd : 0;

  return {
    asset: meta.symbol,
    assetAddress: asset,
    decimals: meta.decimals,
    supplied,
    suppliedUSD,
    supplyApy,
    borrowed,
    borrowedUSD,
    borrowApy,
    netUSD: suppliedUSD - borrowedUSD,
    price: usd != null ? { usd, source: price.source || "pricing-engine" } : null,
    utilization: null,
  };
}

/**
 * Returns the flat positions array (server sums valueUSD; borrows negative)
 * with a __blendPoolGroups property attached for the profile table renderer.
 * Each group carries protocol:"k2" which overrides the server's default
 * `{ protocol: "blend", ...group }` spread.
 */
async function getPositions(userAddress) {
  const reserves = await getReservesList();
  if (!reserves.length) return [];

  // Every reserve at once (they were read one after another: about 15 RPC
  // calls in a row, which ran past the 8-second adapter limit when several
  // wallets loaded together). Any read that fails fails the whole result.
  const rows = (await Promise.all(reserves.map((asset) => readReserve(asset, userAddress)))).filter(Boolean);
  let totalSuppliedUSD = 0;
  let totalBorrowedUSD = 0;
  for (const r of rows) {
    totalSuppliedUSD += r.suppliedUSD;
    totalBorrowedUSD += r.borrowedUSD;
  }

  if (!rows.length) return [];

  const group = {
    protocol: "k2",
    protocolLabel: "K2 Lend",
    poolContractId: K2_ROUTER,
    poolName: "Primary Market",
    rows,
    totalSuppliedUSD,
    totalBorrowedUSD,
    netUSD: totalSuppliedUSD - totalBorrowedUSD,
    debtRatio: totalSuppliedUSD > 0 ? totalBorrowedUSD / totalSuppliedUSD : 0,
  };

  const flat = [];
  for (const r of rows) {
    // Gate on TOKEN AMOUNTS, not USD value: when the price lookup fails,
    // USD is 0 but the position — especially a borrow LIABILITY — still
    // exists. Dropping unpriced borrows overstated net worth by the whole
    // debt. Unpriced positions carry valueUSD 0 and unpriced:true so the
    // UI can render the amount with a "no price" marker.
    const unpriced = r.price == null;
    if (r.supplied > 0) {
      flat.push({
        protocol: "k2", type: "lending", subtype: "collateral",
        poolContractId: K2_ROUTER, poolName: group.poolName,
        asset: r.asset, assetAddress: r.assetAddress, decimals: r.decimals,
        underlyingAmount: r.supplied, valueUSD: r.suppliedUSD,
        apy: r.supplyApy, price: r.price, unpriced,
      });
    }
    if (r.borrowed > 0) {
      flat.push({
        protocol: "k2", type: "borrowing", subtype: "liability",
        poolContractId: K2_ROUTER, poolName: group.poolName,
        asset: r.asset, assetAddress: r.assetAddress, decimals: r.decimals,
        underlyingAmount: r.borrowed, valueUSD: -r.borrowedUSD,
        apy: r.borrowApy, price: r.price, unpriced,
      });
    }
  }
  flat.__blendPoolGroups = [group];
  return flat;
}

function isConfigured() {
  return Boolean(K2_ROUTER);
}

module.exports = {
  name: "K2 Lend",
  protocolId: "k2",
  isConfigured,
  getPositions,
};
