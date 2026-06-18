/**
 * Upshift Finance Adapter for Stellar/Soroban
 *
 * Upshift runs vaults across many chains; their Stellar deployment uses
 * ERC-4626-style "AugustVault" contracts where the vault contract IS the
 * share-token contract. Users deposit USDC or XLM and receive share tokens
 * (earnUSDC, avXLM, etc.). Share value grows with accrued yield.
 *
 * This adapter:
 * 1. Loads the vault list from https://api.upshift.finance/v1/tokenized_vaults
 *    (filtered to chain_type === "stellar"), cached server-side
 * 2. For each vault, queries the user's share balance via balance()
 * 3. Returns a "vault" position with deposited amount, APY from the API,
 *    and USD value (shares priced 1:1 with deposit token for v1 — refines
 *    later with convert_to_assets calls)
 */
const { getTokenBalance, simulateContractCall, formatTokenAmount } = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { nativeToScVal, scValToNative } = StellarSdk;

const UPSHIFT_API_BASE = "https://api.upshift.finance/v1";
const VAULT_CACHE_TTL = 60 * 60_000; // 1 hour; vault list is stable
let vaultCache = { ts: 0, vaults: null };

// Display formatter for token amounts in the DeFi position cards.
// We trim trailing zeros and pick a sensible decimal count by magnitude.
function fmtTokenAmount(n) {
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return String(n);
  if (v === 0) return "0.00";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  // Sub-cent: more decimals to show non-zero value
  return v.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Fetch the Stellar-chain subset of Upshift's vault list.
 * Returns array of vault metadata, cached for VAULT_CACHE_TTL.
 */
async function fetchStellarVaults() {
  if (vaultCache.vaults && Date.now() - vaultCache.ts < VAULT_CACHE_TTL) {
    return vaultCache.vaults;
  }
  try {
    const res = await fetch(`${UPSHIFT_API_BASE}/tokenized_vaults`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const all = await res.json();
    const stellar = (all || []).filter(
      (v) => v.chain_type === "stellar" && v.status === "active" && v.stellar_vault_metadata
    );
    vaultCache = { ts: Date.now(), vaults: stellar };
    return stellar;
  } catch (e) {
    console.warn("Upshift vault list fetch failed:", e.message);
    // Fall back to stale cache if available, else empty
    return vaultCache.vaults || [];
  }
}

/**
 * Build a position object from a vault + the user's share balance.
 * Returns null if the user holds 0 shares.
 */
async function getVaultPosition(vault, userAddress, priceCtx) {
  try {
    const rawBalance = await getTokenBalance(vault.address, userAddress);
    if (!rawBalance || rawBalance === "0") return null;
    if (BigInt(rawBalance) === 0n) return null;

    // Share token uses 13 decimals (confirmed via decimals() probe on each
    // Upshift Stellar vault); deposit token is 7 decimals (Stellar standard).
    const SHARE_DECIMALS = 13;
    const meta = vault.stellar_vault_metadata || {};
    const depositSymbol = meta.deposit_token_symbol || "?";
    const depositDecimals = meta.deposit_token_decimals ?? 7;

    // Ask the vault what the user's shares are currently worth in deposit-
    // token units. ERC-4626-style — exact, accounts for accrued yield.
    let rawAssets = null;
    try {
      const result = await simulateContractCall(
        vault.address,
        "convert_to_assets",
        [nativeToScVal(BigInt(rawBalance), { type: "i128" })]
      );
      if (result) rawAssets = scValToNative(result);
    } catch (e) {
      // If the vault doesn't expose convert_to_assets we fall back below.
    }

    // Shares as deposit-token units (the 1:1 baseline used to mint at deposit).
    // We can't recover the true initial deposit on-chain, but new shares are
    // minted in proportion to deposit_assets / share_price_at_deposit, and
    // share_price was ≈ 1 deposit_token / share at vault inception. So this
    // is a close approximation of "what the user originally deposited",
    // and `current_value - this` ≈ accrued yield.
    const sharesAsDepositUnits = Number(BigInt(rawBalance)) / Math.pow(10, SHARE_DECIMALS);

    // Current redeemable value in deposit-token units.
    const currentAssetUnits = rawAssets != null
      ? Number(BigInt(rawAssets)) / Math.pow(10, depositDecimals)
      : sharesAsDepositUnits; // fallback if convert_to_assets isn't exposed

    const accruedUnits = Math.max(0, currentAssetUnits - sharesAsDepositUnits);

    let depositPriceUSD = 0;
    if (depositSymbol === "USDC") {
      depositPriceUSD = 1;
    } else if (depositSymbol === "XLM" && priceCtx?.xlmPrice?.usd) {
      depositPriceUSD = priceCtx.xlmPrice.usd;
    }
    const valueUSD = currentAssetUnits * depositPriceUSD;

    // APY: prefer 7-day, fall back to 30-day, then 1-day.
    const apyMap = vault.historical_apy || {};
    const apyFraction = apyMap["7"] ?? apyMap["30"] ?? apyMap["1"] ?? null;
    const apyPercent = apyFraction != null ? apyFraction * 100 : null;

    return {
      protocol: "upshift",
      type: "vault",
      contractId: vault.address,
      vaultName: vault.vault_name,
      receiptSymbol: vault.receipt_token_symbol,
      deposited: {
        // Approximate initial deposit (shares × 1.0). True initial requires
        // event history; this is correct within the first deposit cycle.
        amount: fmtTokenAmount(sharesAsDepositUnits),
        asset: depositSymbol,
      },
      yield: {
        // Difference between current redeemable value and the 1:1 baseline.
        accrued: fmtTokenAmount(accruedUnits),
        asset: depositSymbol,
        apy: apyPercent,
      },
      valueUSD,
    };
  } catch (e) {
    console.warn(`Upshift vault ${vault.address} position error:`, e.message);
    return null;
  }
}

// ── Adapter interface ────────────────────────────────────────────────────────

const UpshiftAdapter = {
  protocolId: "upshift",
  name: "Upshift",
  type: "yield",

  isConfigured() {
    // Always configured — the vault list is fetched from the public API at
    // call time and cached. No env vars needed.
    return true;
  },

  /**
   * Get all Upshift Stellar vault positions for a user.
   * @param {string} userAddress G-strkey
   * @param {object} [priceCtx]  Optional { xlmPrice: { usd } } for valuation
   */
  async getPositions(userAddress, priceCtx) {
    const vaults = await fetchStellarVaults();
    if (vaults.length === 0) return [];

    const results = await Promise.allSettled(
      vaults.map((v) => getVaultPosition(v, userAddress, priceCtx))
    );

    return results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
  },
};

module.exports = UpshiftAdapter;
