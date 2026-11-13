// Each RWA figure carries its own date.
//
// /api/v1/rwa-stats had one asOf per asset, and the live Horizon market cap
// set it to today. The page shows that date under the yields, so BENJI's
// curated 3.49% from 2026-06-18 showed "as of" today, and the 14-day "stale"
// mark never appeared. Now asOf is the yields' date and marketCapAsOf the
// market cap's (Stellar TVL on the detail page).

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const pricing = require("../lib/pricing-engine");
const fetcher = require("../lib/rwa-yield-fetcher");

const CURATED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lib", "rwa-yields.json"), "utf8")).stats;
const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// What the live yield fetchers have (rwa-yield-fetcher.getFreshYield).
const FRESH = {
  // A live yield and, from Horizon, a live market cap.
  "usdy-gajmpx": { yield7d: "3.75%", yield30d: "3.75%", asOf: "2026-11-10", source: "Ondo" },
  // A live TVL only: the yield stays curated.
  "jtrsy-cbhoek": { tvl: "$5.1M", supplyTokens: 5_100_000, tvlSource: "Centrifuge", asOf: "2026-11-11" },
};

let stats;
test.before(async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, ...rest);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes("/assets?asset_code=")) {
      // Every classic asset: 1,000,000 units on trustlines.
      return ok({ _embedded: { records: [{ balances: { authorized: "1000000.0000000" } }] } });
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };
  pricing.primeKnownPrices = async () => {};
  // $1 a unit, except YLDS: no price (a CoinGecko miss, say).
  pricing.priceClassicAsset = async (_ctx, code) => (code === "YLDS" ? null : { usd: 1, source: "test" });
  fetcher.getFreshYield = (slug) => FRESH[slug] || null;

  const { app } = require("../server.js");
  const server = app.listen(0);
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/v1/rwa-stats`);
    assert.equal(res.status, 200);
    stats = (await res.json()).stats;
  } finally {
    server.close();
    global.fetch = realFetch;
  }
});

const today = () => new Date().toISOString().slice(0, 10);

test("a curated yield keeps its date when the market cap is live", () => {
  const benji = stats["benji-gbhngl"];
  assert.ok(CURATED["benji-gbhngl"].yield7d, "BENJI's yield is curated");
  assert.equal(benji.yield7d, CURATED["benji-gbhngl"].yield7d);
  assert.equal(benji.asOf, CURATED["benji-gbhngl"].asOf, "the yield's own date, not today");
  assert.equal(benji.marketCap, "$1.0M");
  assert.equal(benji.marketCapAsOf, today());
  assert.equal(benji.tvlSource, "Horizon (supply × price)");
});

test("a live yield takes its fetcher's date; the live market cap, today", () => {
  const usdy = stats["usdy-gajmpx"];
  assert.equal(usdy.yield7d, "3.75%");
  assert.equal(usdy.asOf, "2026-11-10");
  assert.equal(usdy.marketCapAsOf, today());
});

test("a live TVL alone doesn't re-date a curated yield", () => {
  const jtrsy = stats["jtrsy-cbhoek"];
  assert.equal(jtrsy.yield7d, CURATED["jtrsy-cbhoek"].yield7d);
  assert.equal(jtrsy.asOf, CURATED["jtrsy-cbhoek"].asOf);
  assert.equal(jtrsy.marketCap, "$5.1M");
  assert.equal(jtrsy.marketCapAsOf, "2026-11-11");
  assert.equal(jtrsy.tvlSource, "Centrifuge");
});

test("with no price, the curated market cap shows with its own (old) date", () => {
  // YLDS: a curated market cap and no curated yield. Its yield is SOFR less
  // 35 bps, and the NY Fed doesn't answer here, so it has none.
  const ylds = stats["ylds-gac7mo"];
  assert.ok(CURATED["ylds-gac7mo"].asOf && !CURATED["ylds-gac7mo"].yield7d);
  assert.equal(ylds.marketCap, CURATED["ylds-gac7mo"].marketCap);
  assert.equal(ylds.marketCapAsOf, CURATED["ylds-gac7mo"].asOf);
  assert.equal(ylds.yield7d, null);
  assert.equal(ylds.asOf, null, "no yield, so no yield date");
});

test("no yield, no yield date", () => {
  const gold = stats["gold-gck75c"];
  assert.equal(gold.yield7d, null);
  assert.equal(gold.asOf, null);
  assert.equal(gold.marketCapAsOf, today());
  const pyusd = stats["pyusd-cccrwh"];
  assert.equal(pyusd.asOf, null);
  assert.equal(pyusd.marketCapAsOf, null);
});

test("the page shows each date with its figure", () => {
  assert.match(INDEX, /marketCapAsOf: s\.marketCapAsOf \|\| null/);
  // Stellar TVL, on the detail page:
  assert.match(INDEX, /escapeHtml\(a\.marketCap\)\}<\/div>\$\{renderAsOf\(a\.marketCapAsOf, /);
  // The yields, in the table (both columns) and on the detail page:
  assert.match(INDEX, /const asOfSuffix = renderAsOf\(a\.statsAsOf, a\.statsSource\);/);
  assert.match(INDEX, /parts\.push\(`yields as of \$\{escapeHtml\(a\.statsAsOf\)\}`\)/);
});
