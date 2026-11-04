/**
 * The supply of a classic Stellar asset: every unit its issuer has issued
 * and not burned, from a record of Horizon's /assets endpoint.
 *
 * Horizon reports the supply split by where the units sit:
 *   balances.authorized                           trustlines that can transact
 *   balances.authorized_to_maintain_liabilities   trustlines limited to existing offers
 *   balances.unauthorized                         trustlines the issuer has frozen
 *   claimable_balances_amount                     claimable balances
 *   liquidity_pools_amount                        classic AMM pools
 *   contracts_amount                              Soroban contracts (Blend pools, vaults, ...)
 *
 * The RWA tab used to count `balances.authorized` alone, which leaves out
 * every unit deposited in a contract: on 2026-11-04 it counted 102,853
 * USDM1 of 1,107,379 (1,004,526 were in contracts), and 36.0M of CETES's
 * 54.2M. The sum of all six matches Stellar Expert's supply figure.
 *
 * Amounts are summed in stroops (1e-7) so the result is exact to 7 decimals.
 */

const STROOPS_PER_UNIT = 10_000_000n;

/** "1234.5678900" → 12345678900n stroops. Anything unparseable → null. */
function toStroops(amount) {
  if (typeof amount === "number") amount = amount.toFixed(7);
  if (typeof amount !== "string") return null;
  const m = /^(\d+)(?:\.(\d{0,7}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]) * STROOPS_PER_UNIT + BigInt((m[2] || "").padEnd(7, "0"));
}

const SUPPLY_PARTS = [
  (r) => r.balances?.authorized,
  (r) => r.balances?.authorized_to_maintain_liabilities,
  (r) => r.balances?.unauthorized,
  (r) => r.claimable_balances_amount,
  (r) => r.liquidity_pools_amount,
  (r) => r.contracts_amount,
];

/**
 * @param {object} record One entry of Horizon /assets `_embedded.records`.
 * @returns {number|null} Supply in whole units, or null if the record has none.
 */
function classicSupply(record) {
  if (!record || typeof record !== "object") return null;
  let total = 0n;
  let found = false;
  for (const part of SUPPLY_PARTS) {
    const value = part(record);
    if (value === undefined || value === null) continue;
    const stroops = toStroops(value);
    if (stroops === null) return null; // a malformed figure: better no supply than a wrong one
    total += stroops;
    found = true;
  }
  // Horizon releases before the split reported a flat `amount`.
  if (!found) {
    const stroops = toStroops(record.amount);
    if (stroops === null) return null;
    total = stroops;
  }
  return Number(total) / Number(STROOPS_PER_UNIT);
}

module.exports = { classicSupply };
