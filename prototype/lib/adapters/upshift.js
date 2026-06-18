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
const { getTokenBalance, formatTokenAmount } = require("../soroban-rpc");

const UPSHIFT_API_BASE = "https://api.upshift.finance/v1";
const VAULT_CACHE_TTL = 60 * 60_000; // 1 hour; vault list is stable
let vaultCache = { ts: 0, vaults: null };

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

    // Share token decimals — confirmed 13 across all current Upshift Stellar
    // vaults by querying decimals() on each contract. Hard-coded rather than
    // re-fetched because (a) it's stable and (b) saves a per-position RPC.
    const SHARE_DECIMALS = 13;
    const sharesHuman = formatTokenAmount(rawBalance, SHARE_DECIMALS);
    const sharesNum = parseFloat(sharesHuman);

    const meta = vault.stellar_vault_metadata || {};
    const depositSymbol = meta.deposit_token_symbol || "?";

    // v1 simplification: price 1 share = 1 deposit token. Real share price
    // would come from vault.convert_to_assets(shares). At current APYs
    // (~3%) the under-report is small.
    let depositPriceUSD = 0;
    if (depositSymbol === "USDC") {
      depositPriceUSD = 1;
    } else if (depositSymbol === "XLM" && priceCtx?.xlmPrice?.usd) {
      depositPriceUSD = priceCtx.xlmPrice.usd;
    }
    const valueUSD = sharesNum * depositPriceUSD;

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
        // We don't have convert_to_assets yet — show share count as
        // the deposited amount, scaled to deposit-token units (1:1).
        amount: sharesHuman,
        asset: depositSymbol,
      },
      yield: {
        // No on-chain accrued-yield query yet — leave 0 and let APY tell
        // the story. Refine with convert_to_assets in a follow-up.
        accrued: "0",
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
