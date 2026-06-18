/**
 * Soroban Token Resolver
 *
 * Discovers and resolves Soroban-native token balances for a given address.
 * Handles both SAC (Stellar Asset Contract) wrappers and custom SEP-41 tokens
 * like SolvBTC that live entirely in contract storage.
 */
const { getTokenBalance, getTokenMetadata, formatTokenAmount } = require("./soroban-rpc");

// ── Contract Registry ─────────────────────────────────────────────────────────
// Add known Soroban token contract IDs here.
// These won't appear in Horizon trustlines — they must be tracked explicitly.

const SOROBAN_TOKEN_REGISTRY = [
  {
    contractId: process.env.SOLVBTC_CONTRACT_ID || "PLACEHOLDER_SOLVBTC_CONTRACT_ID",
    symbol: "SolvBTC",
    name: "Solv Protocol BTC",
    decimals: 8,
    category: "bridge",
    coingeckoId: "bitcoin", // Price proxy — SolvBTC tracks BTC
    enabled: !!process.env.SOLVBTC_CONTRACT_ID,
  },
  {
    contractId: process.env.SOLVBTC_BBN_CONTRACT_ID || "PLACEHOLDER_SOLVBTC_BBN",
    symbol: "SolvBTC.BBN",
    name: "Solv Protocol BTC (Babylon)",
    decimals: 8,
    category: "bridge",
    coingeckoId: "bitcoin",
    enabled: !!process.env.SOLVBTC_BBN_CONTRACT_ID,
  },
  // ── Upshift Finance Stellar vaults ─────────────────────────────────────────
  // Contract addresses sourced from https://api.upshift.finance/v1/tokenized_vaults
  // filtered by chain_type === "stellar". The vault contract IS the share-token
  // contract (ERC-4626-style), so the user's balance of the vault contract
  // equals their position in share units. We price share 1:1 with the deposit
  // token here — this ignores accrued yield (small at current APYs), refine
  // later with a real adapter that calls convert_to_assets.
  {
    contractId: "CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY",
    symbol: "earnUSDC",
    name: "Gami earnUSDC (Upshift)",
    decimals: 13,
    category: "vault",
    coingeckoId: "usd-coin",
    enabled: true,
  },
  {
    contractId: "CAI2TYZGVKLQ4CHSMHPHWXZVQFX5SHKJA2Q3WUQVUBI73NGL6SHVAK4L",
    symbol: "avXLM",
    name: "Upshift Stellar XLM Vault",
    decimals: 13,
    category: "vault",
    coingeckoId: "stellar",
    enabled: true,
  },
  {
    contractId: "CC6TRAPQD3NK7THUKWPV5SL2JHKQGNXZVB6S6MVYFSLRWAKEFUWZKZ7J",
    symbol: "earnXLM",
    name: "Gami earnXLM (Upshift)",
    decimals: 13,
    category: "vault",
    coingeckoId: "stellar",
    enabled: true,
  },
  {
    contractId: "CBOAUJOUVV4YKIHKEGKSP66LMEYPL4PZWGF5GNQJVJMY4Q35BSDDWUP2",
    symbol: "GamiTestUSDC",
    name: "Gami earnUSDC Test (Upshift)",
    decimals: 13,
    category: "vault",
    coingeckoId: "usd-coin",
    enabled: true,
  },

  // Add more Soroban tokens here as they deploy on Stellar:
  // {
  //   contractId: "C...",
  //   symbol: "TOKEN",
  //   name: "Token Name",
  //   decimals: 7,
  //   category: "defi",
  //   coingeckoId: null,
  //   enabled: true,
  // },
];

// ── Price lookups for Soroban tokens ──────────────────────────────────────────

const tokenPriceCache = new Map();
const PRICE_TTL = 60_000;

async function getExternalPrice(coingeckoId) {
  if (!coingeckoId) return null;

  const cached = tokenPriceCache.get(coingeckoId);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_24hr_change=true`
    );
    const data = await res.json();
    if (data[coingeckoId]) {
      const price = {
        usd: data[coingeckoId].usd,
        change24h: data[coingeckoId].usd_24h_change || 0,
      };
      tokenPriceCache.set(coingeckoId, { price, ts: Date.now() });
      return price;
    }
    return null;
  } catch (e) {
    console.error(`Price fetch failed for ${coingeckoId}:`, e.message);
    return null;
  }
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve all Soroban token balances for an address.
 * Returns an array of balance objects compatible with the portfolio API.
 */
async function resolveSorobanTokens(userAddress) {
  const enabledTokens = SOROBAN_TOKEN_REGISTRY.filter((t) => t.enabled);
  if (enabledTokens.length === 0) return [];

  const results = await Promise.allSettled(
    enabledTokens.map(async (token) => {
      const rawBalance = await getTokenBalance(token.contractId, userAddress);
      const balance = BigInt(rawBalance);

      if (balance === 0n) return null;

      const formatted = formatTokenAmount(rawBalance, token.decimals);
      const price = await getExternalPrice(token.coingeckoId);
      const valueUSD = price ? parseFloat(formatted) * price.usd : 0;

      return {
        type: "soroban_token",
        asset: {
          code: token.symbol,
          issuer: null,
          contractId: token.contractId,
          domain: null,
          logo: null,
          category: token.category,
        },
        balance: formatted,
        rawBalance: rawBalance,
        decimals: token.decimals,
        valueUSD,
        price,
        source: "soroban",
      };
    })
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

/**
 * Look up a single Soroban token by contract ID (for ad-hoc queries).
 * Fetches metadata from the contract itself if not in the registry.
 */
async function resolveCustomToken(contractId, userAddress) {
  try {
    const [rawBalance, metadata] = await Promise.all([
      getTokenBalance(contractId, userAddress),
      getTokenMetadata(contractId),
    ]);

    const balance = BigInt(rawBalance);
    if (balance === 0n) return null;

    const formatted = formatTokenAmount(rawBalance, metadata.decimals);

    return {
      type: "soroban_token",
      asset: {
        code: metadata.symbol,
        issuer: null,
        contractId,
        domain: null,
        logo: null,
        category: "custom",
      },
      balance: formatted,
      rawBalance,
      decimals: metadata.decimals,
      valueUSD: 0, // No automatic pricing for custom tokens
      price: null,
      source: "soroban",
    };
  } catch (e) {
    console.error(`Custom token resolve error for ${contractId}:`, e.message);
    return null;
  }
}

/**
 * Get the full registry (for UI display / management)
 */
function getRegistry() {
  return SOROBAN_TOKEN_REGISTRY.map((t) => ({
    contractId: t.contractId,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    category: t.category,
    enabled: t.enabled,
  }));
}

module.exports = {
  resolveSorobanTokens,
  resolveCustomToken,
  getRegistry,
  SOROBAN_TOKEN_REGISTRY,
};
