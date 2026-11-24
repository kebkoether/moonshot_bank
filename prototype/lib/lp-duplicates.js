/**
 * One liquidity pool counts once.
 *
 * LP Positions (lib/adapters/lp-positions.js) is the catch-all LP adapter:
 * besides SushiSwap V3, it reads any AMM pool the wallet invoked in its last
 * 200 operations. That includes Aquarius and Soroswap pools, which LP
 * Discovery already reports (from Aquarius's API and Soroswap's factory).
 * Nothing compared the two, so a wallet that deposited straight into an
 * Aquarius pool had that position twice: listed twice on its DeFi tab, and
 * added twice to its total (on 2026-11-24, a $2.9M USDT0/USDC position).
 */

/** The pool an LP position is in, or null for any other position. */
function lpPoolKey(pos) {
  if (!pos || pos.type !== "lp") return null;
  return pos.poolContractId || pos.contractId || null;
}

/**
 * entries: [{ adapter, positions, ... }], one per adapter. Returns them in the
 * same order, with the LP positions of a fallback adapter (adapter.lpFallback)
 * removed where another adapter reports the same pool. Everything else is
 * kept as it is, including several positions one adapter reports in one pool
 * (SushiSwap V3 positions).
 */
function dropFallbackLpDuplicates(entries) {
  const reported = new Set();
  for (const e of entries) {
    if (e.adapter && e.adapter.lpFallback) continue;
    for (const pos of e.positions || []) {
      const key = lpPoolKey(pos);
      if (key) reported.add(key);
    }
  }
  return entries.map((e) => {
    if (!(e.adapter && e.adapter.lpFallback)) return e;
    const positions = (e.positions || []).filter((pos) => !reported.has(lpPoolKey(pos)));
    return { ...e, positions };
  });
}

module.exports = { lpPoolKey, dropFallbackLpDuplicates };
