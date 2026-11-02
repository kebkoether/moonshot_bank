/**
 * A DeFi position as a snapshot keeps it: the protocol, the pool or vault,
 * the amount of each asset, and the USD value.
 *
 * Snapshots used to keep only the portfolio total and how many DeFi
 * positions there were, so looking at a past date ("View balances at")
 * could not say what the DeFi part was made of: which venues, how much of
 * each asset. The adapters return a few different shapes; this reduces each
 * to one small record:
 *
 *   { protocol, name, legs: [{ amount, asset, side }], valueUSD, stale }
 *
 * side is "supplied" or "borrowed" (Blend, K2), "deposited" or "borrowed"
 * (Upshift, Sentora, Templar, Solv), "pooled" (LPs) or "staked".
 */

/** A number from an adapter's number or display string ("1234.56"), or null. */
function _num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function _leg(amount, asset, side) {
  const n = _num(amount);
  if (n == null || !asset) return null;
  return { amount: n, asset: String(asset), side };
}

/**
 * @param {object} p a position from any adapter (an element of defiPositions)
 * @returns {{protocol: string, name: string|null, legs: Array<{amount: number, asset: string, side: string}>, valueUSD: number, stale: boolean}}
 */
function summarizeDefiPosition(p) {
  const legs = [];
  if (p.type === "lending" || p.type === "borrowing") {
    const borrowed = p.type === "borrowing" || p.subtype === "liability";
    legs.push(_leg(p.underlyingAmount, p.asset, borrowed ? "borrowed" : "supplied"));
  } else if (p.token0 && p.token1 && p.amounts && !Array.isArray(p.amounts)) {
    legs.push(_leg(p.amounts.token0, p.token0.symbol, "pooled"));
    legs.push(_leg(p.amounts.token1, p.token1.symbol, "pooled"));
  } else if (Array.isArray(p.amounts)) {
    for (const a of p.amounts) legs.push(_leg(a.amount, a.symbol, "pooled"));
  } else {
    if (p.deposited) legs.push(_leg(p.deposited.amount, p.deposited.asset, "deposited"));
    if (p.staked) legs.push(_leg(p.staked.amount, p.staked.asset, "staked"));
    if (p.borrow) legs.push(_leg(p.borrow.amount, p.borrow.asset, "borrowed"));
  }
  const pair = p.token0?.symbol && p.token1?.symbol ? `${p.token0.symbol}/${p.token1.symbol}` : null;
  return {
    protocol: String(p.protocol || "unknown"),
    name: p.poolName || p.vaultName || pair || null,
    legs: legs.filter(Boolean),
    valueUSD: Number.isFinite(p.valueUSD) ? p.valueUSD : 0,
    stale: !!p.stale,
  };
}

module.exports = { summarizeDefiPosition };
