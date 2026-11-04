/**
 * A classic asset's USD price from Stellar's order books: the pricing
 * engine's "sdex" layer, which it asks after the stablecoin list and
 * CoinGecko and before the AMM pools.
 *
 * 1. The asset's XLM book: its mid price × XLM's, if the spread is under 10%.
 * 2. Otherwise the asset's USDC book: its mid price, if the spread is under
 *    10% and it has at least USDC_MIN_DEPTH_USD of orders on each side within
 *    10% of that mid.
 * 3. Otherwise the XLM book's best bid × XLM's price, or no price if nobody
 *    bids for the asset in XLM.
 *
 * Step 2 is new. Many assets trade in USDC, not XLM, and their XLM book is a
 * few stray offers far apart, so step 3 valued them off a lowball bid. On
 * 2026-11-04 Etherfuse's USTRY had a USDC book of 1.0790 / 1.0795 with about
 * $275K of orders on each side within 2%, but an XLM book of 5.07 / 7.00 XLM
 * (a 38% spread). The bid made it $0.83, so every wallet holding USTRY, and
 * the RWA tab, was 23% short. Step 2 asks for depth because a USDC book is
 * as easy to set up as an XLM one: a few dollars of orders shouldn't set the
 * price of a whole holding (the AMM layer asks pools for $10,000 of depth).
 */

const { Asset } = require("@stellar/stellar-sdk");
const { USDC_ISSUER } = require("./xlm-price");

const MAX_SPREAD = 0.1;
const USDC_MIN_DEPTH_USD = 1000;
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
        let usdcMid = null;
        if (!asset.equals(USDC)) {
          try {
            usdcMid = usdcBookMid(await horizon.orderbook(asset, USDC).call());
          } catch (e) {
            console.warn(`USDC book for ${assetCode} unavailable: ${e.message}`);
          }
        }
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
        priceInXLM = bestBid; // conservative: the bid
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

module.exports = { createSdexPricer, usdcBookMid, MAX_SPREAD, USDC_MIN_DEPTH_USD };
