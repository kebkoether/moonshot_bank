/**
 * XLM/USD.
 *
 * Primary: Stellar's own DEX (SDEX), the XLM/USDC order book on Horizon —
 * first-party, deep (the spread is normally ~0.1%), and the same Horizon the
 * app already reads every balance from. Circle's USDC is taken as $1.
 * Fallback: CoinGecko. Last resort: the last good price, flagged as stale.
 *
 * This used to come from the Freighter backend's /token-prices endpoint. In
 * late October 2026 that endpoint was found stuck: the same XLM price, to 17
 * significant digits, hours apart — $0.2152 (+7.91%, about where XLM was on
 * 22 September) while XLM traded at ~$0.172 on SDEX, Kraken and CoinGecko.
 * Its response carries no timestamp, so a stuck value cannot be detected, and
 * every XLM holding (and each snapshot's xlm_price_usd) was ~25% too high.
 */

const { untilAborted } = require("./until-aborted");

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// Circle's USDC, the deepest USD market for XLM on SDEX.
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_QUERY = `credit_alphanum4&{side}_asset_code=USDC&{side}_asset_issuer=${USDC_ISSUER}`;

const PRICE_TTL_MS = 60_000;
// After every source has failed, wait this long before asking them again
// (callers keep getting the stale price meanwhile), so an outage doesn't turn
// every portfolio request into two more failing requests. Not applied before
// the first good price: there is nothing to serve but 0, so keep trying.
const FAILURE_BACKOFF_MS = 15_000;
const FETCH_TIMEOUT_MS = 8000;
// A best bid/ask further apart than this is not a market to price from.
const MAX_SPREAD = 0.02;
const HOUR_MS = 3_600_000;

let cached = null; // { price, ts } — the last good price
let lastFailureTs = 0;
let inFlight = null; // one refresh at a time; concurrent callers share it

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The timeout covers the body too: a read left pending would hold the
    // shared refresh, and every price request after it, for good.
    return await untilAborted(res.json(), ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The close of the hourly XLM/USDC bucket that contains "24h ago", from SDEX
 * trade aggregations (base XLM, counter USDC: USDC per XLM). null if there
 * were no trades to compare with.
 */
async function sdexClose24hAgo(now) {
  const counter = USDC_QUERY.replaceAll("{side}", "counter");
  const url = `${HORIZON_URL}/trade_aggregations?base_asset_type=native&counter_asset_type=${counter}` +
    `&resolution=${HOUR_MS}&order=desc&limit=30`;
  const records = (await fetchJson(url))?._embedded?.records || [];
  const target = now - 24 * HOUR_MS;
  // Newest first: the first bucket that starts at or before 24h ago.
  const then = records.find((r) => Number(r.timestamp) <= target);
  const close = then ? parseFloat(then.close) : NaN;
  return close > 0 ? close : null;
}

/** Mid price of the XLM/USDC book (USDC per XLM), or null if it is one-sided, crossed or too wide. */
async function fromSdex(now = Date.now()) {
  const buying = USDC_QUERY.replaceAll("{side}", "buying");
  const [book, close24hAgo] = await Promise.all([
    fetchJson(`${HORIZON_URL}/order_book?selling_asset_type=native&buying_asset_type=${buying}&limit=1`),
    sdexClose24hAgo(now).catch(() => null), // the price is good without it
  ]);
  const bid = parseFloat(book?.bids?.[0]?.price);
  const ask = parseFloat(book?.asks?.[0]?.price);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  if ((ask - bid) / bid > MAX_SPREAD) return null;
  const usd = (bid + ask) / 2;
  if (!Number.isFinite(usd)) return null;
  const change24h = close24hAgo ? (usd / close24hAgo - 1) * 100 : null;
  return { usd, change24h, source: "sdex" };
}

async function fromCoingecko() {
  const data = await fetchJson(`${COINGECKO_API}/simple/price?ids=stellar&vs_currencies=usd&include_24hr_change=true`);
  const usd = data?.stellar?.usd;
  if (!(usd > 0)) return null;
  const change = data.stellar.usd_24h_change;
  return { usd, change24h: Number.isFinite(change) ? change : null, source: "coingecko" };
}

async function refresh() {
  for (const [name, source] of [["SDEX", fromSdex], ["CoinGecko", fromCoingecko]]) {
    try {
      const p = await source();
      if (p) {
        const known = Number.isFinite(p.change24h);
        const price = { usd: p.usd, change24h: known ? p.change24h : 0, change24hKnown: known, source: p.source };
        cached = { price, ts: Date.now() };
        return price;
      }
      console.warn(`XLM price: ${name} gave no usable price`);
    } catch (e) {
      console.warn(`XLM price: ${name} failed: ${e.message}`);
    }
  }
  lastFailureTs = Date.now();
  console.warn(`XLM price: all sources failed; ${cached ? "serving the last good price, marked stale" : "no price yet"}`);
  return staleOrZero();
}

/**
 * Every source failed. A stale price is better than zero, which would cascade
 * into bogus totals across every Stellar holding — but it must say so: it is
 * marked stale, carries the time it was good, and its 24h change is unknown.
 */
function staleOrZero() {
  if (cached) {
    return { ...cached.price, change24h: 0, change24hKnown: false, stale: true, asOf: cached.ts };
  }
  return { usd: 0, change24h: 0, change24hKnown: false, source: "none" };
}

/**
 * { usd, change24h, change24hKnown, source, stale?, asOf? }. change24h is
 * always a number (0 when unknown, since the UI does arithmetic on it);
 * change24hKnown says whether it is real. usd is 0 only if every source
 * failed and there has never been a good price.
 */
async function getXLMPrice() {
  const now = Date.now();
  if (cached && now - cached.ts < PRICE_TTL_MS) return cached.price;
  if (cached && now - lastFailureTs < FAILURE_BACKOFF_MS) return staleOrZero();
  if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

function _resetForTests() {
  cached = null;
  lastFailureTs = 0;
  inFlight = null;
}

module.exports = { getXLMPrice, _resetForTests, USDC_ISSUER, MAX_SPREAD, PRICE_TTL_MS, FAILURE_BACKOFF_MS };
