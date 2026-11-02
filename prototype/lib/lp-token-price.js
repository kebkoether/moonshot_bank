/**
 * USD price of a token held in a liquidity pool.
 *
 * The LP adapters (lp-discovery.js, lp-positions.js) priced pool tokens by
 * their symbol alone: a short list at $1, XLM at the XLM price, everything
 * else at $0. So coins that aren't worth $1 were counted as $1 (USDY, which
 * accrues yield, at ~$1.15; EURC at ~$1.12), and one side of every pool with
 * any other token was dropped (AQUA, SHX, BLND, sUSD, yUSDC...): an XLM/SHX
 * position worth about $14,600 showed about $5,500.
 *
 * Pool tokens are now priced like every other Soroban token (Blend's and
 * K2's reserves already are): by contract, through the pricing engine. When
 * the engine has no price for a token, the old symbol rule still applies, so
 * no pool is valued lower than it was: CoinGecko rate-limits us now and then,
 * and FxDAO's USDx has no source the engine uses. (That also means a
 * look-alike token named "USDC" still counts as $1 when the engine can't
 * price it, as it did before.)
 */
const StellarSdk = require("@stellar/stellar-sdk");
// Called as pricing.priceSorobanToken (not destructured) so tests can stub it.
const pricing = require("./pricing-engine");

const XLM_SAC = StellarSdk.Asset.native().contractId(StellarSdk.Networks.PUBLIC);

// lp-discovery.js's symbol list (lp-positions.js had USDC, PYUSD and USDY).
const FALLBACK_DOLLAR_SYMBOLS = new Set(["USDC", "USDY", "PYUSD", "USDX", "EURC", "MGUSD", "USST", "YLDS", "USTBL"]);

/** The old symbol rule: the listed stablecoins $1, XLM at the XLM price, else 0. */
function fallbackUSD(symbol, xlmPrice) {
  const s = String(symbol || "").trim().toUpperCase();
  if (s === "XLM" || s === "NATIVE") return xlmPrice?.usd || 0;
  return FALLBACK_DOLLAR_SYMBOLS.has(s) ? 1 : 0;
}

/**
 * @param {string|null} contractId the token's contract (C-strkey)
 * @param {object} [opts]
 * @param {string} [opts.symbol] the token's symbol, for the fallback
 * @param {number} [opts.decimals=7]
 * @param {{usd:number}} [opts.xlmPrice] the request's XLM price: XLM in a
 *   pool is valued like the wallet's own XLM in the same response
 * @returns {Promise<number>} USD per token, 0 if unknown
 */
async function lpTokenUSD(contractId, { symbol, decimals = 7, xlmPrice } = {}) {
  if (contractId === XLM_SAC && xlmPrice?.usd > 0) return xlmPrice.usd;
  if (contractId) {
    try {
      const p = await pricing.priceSorobanToken(contractId, { decimals });
      if (p && Number.isFinite(p.usd) && p.usd > 0) return p.usd;
    } catch (e) { /* fall back */ }
  }
  return fallbackUSD(symbol, xlmPrice);
}

module.exports = { lpTokenUSD, XLM_SAC };
