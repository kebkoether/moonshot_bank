/**
 * A classic asset's USD price from Stellar's order books: the pricing
 * engine's "sdex" layer, which it asks after the stablecoin list and
 * CoinGecko and before the AMM pools.
 *
 * 1. The asset's XLM book: its mid price × XLM's, if the spread is under 10%.
 * 2. Otherwise the asset's USDC book: its mid price, if the spread is under
 *    10% and it has at least USDC_MIN_DEPTH_USD of orders on each side within
 *    10% of that mid.
 * 3. Otherwise a bid: the XLM book's best × XLM's price, or the USDC book's
 *    if that's higher, with at least USDC_MIN_BID_USD of bids at or above it
 *    and not above the XLM book's ask. No price if nobody bids in XLM.
 *
 * Step 2 is new. Many assets trade in USDC, not XLM, and their XLM book is a
 * few stray offers far apart, so step 3 valued them off a lowball bid. On
 * 2026-11-04 Etherfuse's USTRY had a USDC book of 1.0790 / 1.0795 with about
 * $275K of orders on each side within 2%, but an XLM book of 5.07 / 7.00 XLM
 * (a 38% spread). The bid made it $0.83, so every wallet holding USTRY, and
 * the RWA tab, was 23% short. Step 2 asks for depth because a USDC book is
 * as easy to set up as an XLM one: a few dollars of orders shouldn't set the
 * price of a whole holding (the AMM layer asks pools for $10,000 of depth).
 *
 * Step 3 used to take the XLM bid alone. An asset traded in USDC can have a
 * USDC bid close to its value and an XLM bid far below it. On 2026-11-06:
 * Zeam's gold token XAUZ (backed by PAXG and XAUT) had $150 bid at 4,016
 * USDC and an ask of 4,067 ($450 and $327 within 10%, under step 2's $1,000),
 * but an XLM bid of 1,298.5 XLM: $202 for an ounce of gold. Zeam's ZARZ (a
 * rand, 181,527 holders): $75 bid at $0.0601, against an XLM bid worth
 * $0.016. FxDAO's USDx: $4,386 bid at $1.00, against $0.80. A bid is what
 * someone will pay for the asset now; the USDC one needs $20 behind it, as
 * most USDC books' best bid is a stray order of cents.
 */

const { Asset } = require("@stellar/stellar-sdk");
const { USDC_ISSUER } = require("./xlm-price");

const MAX_SPREAD = 0.1;
const USDC_MIN_DEPTH_USD = 1000;
const USDC_MIN_BID_USD = 20;
const PRICE_TTL_MS = 60_000;
const USDC = new Asset("USDC", USDC_ISSUER);

function spreadOk(bid, ask) {
  return bid > 0 && ask > 0 && (ask - bid) / bid < MAX_SPREAD;
}

/**
 * The mid price of an asset/USDC order book, if it is tight and deep enough
 * to stand for the asset's price; null otherwise. In Horizon's order book a
 * bid's amount is in USDC and an ask's is in the asset.
 */
function usdcBookMid(book) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];
  if (bids.length === 0 || asks.length === 0) return null;
  const bid = parseFloat(bids[0].price);
  const ask = parseFloat(asks[0].price);
  if (!spreadOk(bid, ask)) return null;
  const mid = (bid + ask) / 2;
  let bidUSD = 0;
  for (const o of bids) if (parseFloat(o.price) >= mid * (1 - MAX_SPREAD)) bidUSD += parseFloat(o.amount);
  let askUSD = 0;
  for (const o of asks) if (parseFloat(o.price) <= mid * (1 + MAX_SPREAD)) askUSD += parseFloat(o.amount) * parseFloat(o.price);
  if (!(bidUSD >= USDC_MIN_DEPTH_USD && askUSD >= USDC_MIN_DEPTH_USD)) return null;
  return mid;
}

/**
 * The price at which the asset/USDC book's bids, from the best down, add up
 * to USDC_MIN_BID_USD: what that much of the asset sells for there now. null
 * if they add up to less. (A bid's amount is in USDC.)
 */
function usdcBidPrice(book) {
  let total = 0;
  for (const o of book?.bids || []) {
    total += parseFloat(o.amount);
    if (total >= USDC_MIN_BID_USD) return parseFloat(o.price);
  }
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.horizon A StellarSdk Horizon.Server (only .orderbook is used).
 * @param {function} deps.getXLMPrice Resolves to { usd, ... }.
 * @returns {function(string, string): Promise<{usd, xlm?, change24h, pair}|null>}
 */
function createSdexPricer({ horizon, getXLMPrice }) {
  const cache = new Map();

  return async function getAssetPriceViaSDEX(assetCode, assetIssuer) {
    const cacheKey = `${assetCode}:${assetIssuer}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.price;

    try {
      const asset = new Asset(assetCode, assetIssuer);
      const book = await horizon.orderbook(asset, Asset.native()).call();
      const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
      const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;

      let priceInXLM = null;
      if (bestBid !== null && bestAsk !== null && (bestAsk - bestBid) / bestBid < MAX_SPREAD) {
        priceInXLM = (bestBid + bestAsk) / 2;
      } else {
        // No usable mid in XLM: a tight, deep USDC book is a better price
        // than a lone bid.
        let usdcBook = null;
        if (!asset.equals(USDC)) {
          try {
            usdcBook = await horizon.orderbook(asset, USDC).call();
          } catch (e) {
            console.warn(`USDC book for ${assetCode} unavailable: ${e.message}`);
          }
        }
        const usdcMid = usdcBook ? usdcBookMid(usdcBook) : null;
        if (usdcMid !== null) {
          const price = { usd: usdcMid, change24h: 0, pair: "USDC" };
          cache.set(cacheKey, { price, ts: Date.now() });
          return price;
        }
        // Asks only (or nothing): nobody is bidding. A lone seller's wishful
        // ask is not a market price, and valuing a holding off it can inflate
        // a wallet by orders of magnitude. Leave unpriced; later layers may
        // still price it.
        if (bestBid === null) return null;
        // Conservative: a bid. The USDC book's, when it's higher than the XLM
        // bid and at least USDC_MIN_BID_USD stands at or above it; not above
        // the XLM book's ask, as anyone could fill such a bid from that ask.
        const xlmUsd = (await getXLMPrice()).usd;
        const usdcBid = usdcBook ? usdcBidPrice(usdcBook) : null;
        if (usdcBid !== null && usdcBid > bestBid * xlmUsd && !(bestAsk !== null && usdcBid > bestAsk * xlmUsd)) {
          const price = { usd: usdcBid, change24h: 0, pair: "USDC" };
          cache.set(cacheKey, { price, ts: Date.now() });
          return price;
        }
        priceInXLM = bestBid;
      }

      const xlmPrice = await getXLMPrice();
      const price = { usd: priceInXLM * xlmPrice.usd, xlm: priceInXLM, change24h: 0, pair: "XLM" };
      cache.set(cacheKey, { price, ts: Date.now() });
      return price;
    } catch (e) {
      console.error(`Failed to price ${assetCode}:`, e.message);
      return null;
    }
  };
}

module.exports = { createSdexPricer, usdcBookMid, usdcBidPrice, MAX_SPREAD, USDC_MIN_DEPTH_USD, USDC_MIN_BID_USD };
