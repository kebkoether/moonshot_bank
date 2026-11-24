/**
 * An Upshift vault's APY as Upshift shows it ("Total APY (30D)" or "(7D)" on
 * app.upshift.finance), from its entry in Upshift's vault list.
 *
 * The site showed two other figures:
 * - The DeFi tab's Upshift card took reported_apy.apy, which only the Gami
 *   vaults have. Sentora USDC, the largest Stellar vault ($61M), and Sentora
 *   XLM showed "—"; Upshift shows 8.04% and 4.45%.
 * - A wallet's Upshift position took the 7-day historical APY. For Gami
 *   earnUSDC that was 3.01%; Upshift shows 10.00%, because the campaign tops
 *   the vault up to that. For Sentora USDC it was 6.95%, not 8.04%.
 *
 * Upshift's figure, which matches all four Stellar vaults on 2026-11-24:
 * - the window is the vault's default_apy_horizon (7 or 30 days);
 * - over it, historical_compound_apy when apy_override.is_show_compound_apy,
 *   else historical_apy (both fractions);
 * - plus campaign_apy (a percentage) when the campaign tops the vault up to
 *   a target (apy_override.is_campaign_apy_target_top_up).
 *
 *   Sentora USDC  compound, 30 days            0.08037          → 8.04%
 *   Gami earnUSDC 30 days 0.03383 + 6.617/100  0.10000          → 10.00%
 *   Gami earnXLM  7 days  0.01851 + 3.149/100  0.05000          → 5.00%
 *   Sentora XLM   7 days                       0.04454          → 4.45%
 */

const WINDOWS = [7, 30, 1];
// A figure above this is a broken metric, not a yield: Upshift's inactive
// Sentora PYUSD vault reported a 7-day APY of 1477 (147,743%).
const MAX_APY = 5;

/** { apy, days }: apy as a fraction (0.0804 = 8.04%), or null if there's none. */
function upshiftApy(vault) {
  if (!vault) return null;
  const override = vault.apy_override || {};
  const series = override.is_show_compound_apy ? vault.historical_compound_apy : vault.historical_apy;
  if (!series) return null;
  const preferred = Number(vault.default_apy_horizon);
  const days = [preferred, ...WINDOWS].find((d) => WINDOWS.includes(d) && series[String(d)] != null);
  if (days == null) return null;
  let apy = Number(series[String(days)]);
  if (override.is_campaign_apy_target_top_up && Number.isFinite(Number(vault.campaign_apy))) {
    apy += Number(vault.campaign_apy) / 100;
  }
  if (!Number.isFinite(apy) || apy > MAX_APY) return null;
  return { apy, days };
}

module.exports = { upshiftApy };
