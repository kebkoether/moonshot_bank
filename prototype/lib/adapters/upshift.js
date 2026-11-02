/**
 * Upshift Finance Adapter for Stellar/Soroban
 *
 * Upshift runs vaults across many chains; their Stellar deployment uses
 * ERC-4626-style "AugustVault" contracts where the vault contract IS the
 * share-token contract. Users deposit USDC or XLM and receive share tokens
 * (earnUSDC, avXLM, etc.). Share value grows with accrued yield.
 *
 * This adapter:
 * 1. Reads the Stellar vaults it knows: the ones built in below, plus any
 *    https://api.upshift.finance/v1/tokenized_vaults lists (filtered to
 *    chain_type === "stellar"), which also carries their APY
 * 2. For each vault, queries the user's share balance via balance()
 * 3. Returns a "vault" position with deposited amount, APY from the API,
 *    and USD value (convert_to_assets: what the shares redeem for)
 *
 * The vault list is never waited for. Upshift's endpoint lists every chain's
 * vaults with their history: about 13 MB, taking 9 to 16 seconds. Fetched
 * inline, it ran past the server's 8-second adapter budget on the first load
 * after every restart and on the first load after it expired each hour, and
 * Upshift showed as not responding (on one wallet, $39.7M of sentUSDC
 * missing from the total). It is now fetched in the background; until it
 * arrives, the built-in vaults are read and their APY is unknown.
 */
const { getTokenBalanceStrict, simulateContractCall, isTransientRpcError } = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { nativeToScVal, scValToNative } = StellarSdk;

const UPSHIFT_API_BASE = "https://api.upshift.finance/v1";
const VAULT_LIST_TTL_MS = 60 * 60_000; // 1 hour; vault list is stable
const VAULT_LIST_RETRY_MS = 5 * 60_000; // after a failed fetch
const VAULT_LIST_TIMEOUT_MS = 60_000;

// Upshift's Stellar vaults (the active ones its API listed in October 2026,
// less two test vaults), so positions can be read before the list arrives.
// All take 7-decimal deposit tokens. The API adds APY and any newer vaults.
const KNOWN_VAULTS = [
  ["CALFCZ4TY2CLHDHNJWCZX6JKYGUPV7P3GNQ3UVABXNE5JCV2E774APUM", "Sentora USDC", "sentUSDC", "USDC"],
  ["CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY", "Gami earnUSDC", "earnUSDC", "USDC"],
  ["CC6TRAPQD3NK7THUKWPV5SL2JHKQGNXZVB6S6MVYFSLRWAKEFUWZKZ7J", "Gami earnXLM", "earnXLM", "XLM"],
  ["CBCE3JI4D4BQ3DYMUAMGGSGVCJQSYQDNLEMMZBVFUVNLCLNZSSUJQLEQ", "earnRWA", "earnRWA", "USDC"],
  ["CDUUKPCCGY5NAGCYWEBXVAGVUEDGICB4QLBQMLJTOE4F62AKOEVQPQTH", "Sentora PYUSD", "sentPYUSD", "PYUSD"],
  ["CAY66YC6UHJVYN2UZJSTT3N6EKAXEWGLUDRVFVCUDKXIIF62I4SZFFNJ", "Sentora XLM", "sentXLM", "XLM"],
  ["CAI2TYZGVKLQ4CHSMHPHWXZVQFX5SHKJA2Q3WUQVUBI73NGL6SHVAK4L", "Upshift Stellar XLM Vault", "avXLM", "XLM"],
].map(([address, vault_name, receipt_token_symbol, deposit_token_symbol]) => ({
  address,
  vault_name,
  receipt_token_symbol,
  stellar_vault_metadata: { deposit_token_symbol, deposit_token_decimals: 7 },
}));

let apiVaults = null; // the API's Stellar vaults, from the last good fetch
let listedAt = 0; // when apiVaults was fetched
let listFailedAt = 0;
let listRefresh = null; // the fetch in progress, if any

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
 * Fetch the Stellar subset of Upshift's vault list into apiVaults. One fetch
 * at a time; a failure keeps the last good list. Never rejects.
 */
function refreshVaultList() {
  if (listRefresh) return listRefresh;
  listRefresh = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VAULT_LIST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(`${UPSHIFT_API_BASE}/tokenized_vaults`, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const all = await res.json();
      apiVaults = (Array.isArray(all) ? all : []).filter(
        (v) => v.chain_type === "stellar" && v.status === "active" && v.stellar_vault_metadata
      );
      listedAt = Date.now();
    } catch (e) {
      listFailedAt = Date.now();
      console.warn("Upshift vault list fetch failed:", e.message);
    } finally {
      clearTimeout(timer);
      listRefresh = null;
    }
  })();
  return listRefresh;
}

/**
 * The vaults to read: the built-in ones, and the API's (whose entries carry
 * APY). Starts a background refresh when the API's list is due; never waits.
 */
function stellarVaults() {
  const now = Date.now();
  if (now - listedAt > VAULT_LIST_TTL_MS && now - listFailedAt > VAULT_LIST_RETRY_MS) {
    refreshVaultList();
  }
  const byAddress = new Map(KNOWN_VAULTS.map((v) => [v.address, v]));
  for (const v of apiVaults || []) byAddress.set(v.address, v);
  return [...byAddress.values()];
}

/**
 * Build a position object from a vault + the user's share balance.
 * Returns null if the user holds 0 shares. Throws if the vault could not be
 * read: a failed read is not "no position".
 */
async function getVaultPosition(vault, userAddress, priceCtx) {
  // Strict: a contract that answers with an error means no shares, but an
  // RPC failure (a 429, a timeout) throws. Read as 0, it made a position
  // vanish from the total without any sign that it was missing.
  const rawBalance = await getTokenBalanceStrict(vault.address, userAddress);
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
    // If the vault doesn't expose convert_to_assets we fall back below. A
    // failed read must not fall back: 38.7M sentUSDC shares valued 1:1
    // would be about $1M short.
    if (isTransientRpcError(e)) throw e;
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

  // APY: prefer 7-day, fall back to 30-day, then 1-day. (A built-in vault
  // has none until the API's list arrives.)
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
}

// ── Adapter interface ────────────────────────────────────────────────────────

const UpshiftAdapter = {
  protocolId: "upshift",
  name: "Upshift",
  type: "yield",

  isConfigured() {
    // Always configured: the built-in vaults need nothing, and the API's
    // list is public. No env vars needed.
    return true;
  },

  /**
   * Get all Upshift Stellar vault positions for a user.
   * @param {string} userAddress G-strkey
   * @param {object} [priceCtx]  Optional { xlmPrice: { usd } } for valuation
   *
   * Rejects if any vault could not be read: a vault that failed may hold a
   * real position, and returning the others as a clean result showed a
   * smaller total as if it were complete. The server then serves Upshift's
   * last good result, or says it isn't responding.
   */
  async getPositions(userAddress, priceCtx) {
    const positions = await Promise.all(
      stellarVaults().map((v) => getVaultPosition(v, userAddress, priceCtx))
    );
    return positions.filter((p) => p !== null);
  },

  // Tests only.
  _vaultListSettled: () => listRefresh || Promise.resolve(),
  _resetForTests() {
    apiVaults = null;
    listedAt = 0;
    listFailedAt = 0;
    listRefresh = null;
  },
};

module.exports = UpshiftAdapter;
