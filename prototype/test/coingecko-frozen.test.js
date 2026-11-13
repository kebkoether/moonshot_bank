// A price CoinGecko has stopped updating isn't used.
//
// CoinGecko's /simple/price goes on answering for coins it no longer tracks,
// with the last price it had. On 2026-11-12, 13 of the 61 ids the site maps
// were 40 to 316 days old (12 of them delisted from CoinGecko), and the site
// showed them as live CoinGecko prices: VNX's euro (VEUR) at $0.29 since 21
// June 2026, YieldBlox at $0.19, NewsCrypto at $0.0055 (its order book: about
// $0.0003). Every live id was under a day old. Now a price CoinGecko last
// updated more than 3 days ago counts as no CoinGecko price: the asset goes on
// to the order books and pools.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const rpcLib = require("../lib/soroban-rpc");
rpcLib.simulateContractCall = async () => { throw new Error("no RPC in this test"); };

const aggregator = require("../lib/soroswap-aggregator");
aggregator.priceClassicAssetViaSACInUSD = async () => null;
aggregator.priceSorobanTokenInUSD = async () => null;

const pricing = require("../lib/pricing-engine");

const T0 = 1_800_000_000_000; // ms
const DAY = 24 * 3600_000;
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const YBX_ISSUER = "GBUYYBXWCLT2MOSSHRFCKMEDFOVSCAXNIEW424GLN666OEXHAAWBDYMX";
const SOLVBTC = "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN";

let ages; // coingecko id -> how old CoinGecko's price is (ms)
let urls;
let sdexCalls;
const ctx = { priceViaSDEX: async () => { sdexCalls++; return { usd: 0.0566, change24h: 0 }; } };
const PRICES = { aquarius: 0.00029, yieldblox: 0.193247, "solv-btc": 104000 };

const realFetch = global.fetch;
let keepAlive; // the CoinGecko batch timer is unref()'d
test.before(() => {
  keepAlive = setInterval(() => {}, 1000);
  global.fetch = async (url) => {
    url = String(url);
    urls.push(url);
    if (!url.includes("/simple/price")) return { ok: false, status: 404, json: async () => ({}) };
    const ids = decodeURIComponent(/ids=([^&]*)/.exec(url)[1]).split(",");
    const body = {};
    for (const id of ids) {
      if (PRICES[id] == null) continue;
      body[id] = { usd: PRICES[id], usd_24h_change: 1 };
      if (url.includes("include_last_updated_at=true")) body[id].last_updated_at = Math.floor((Date.now() - (ages[id] || 0)) / 1000);
    }
    return { ok: true, status: 200, json: async () => body };
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

let clock = T0;
test.beforeEach((t) => {
  clock += DAY; // a new day each test: nothing cached carries over
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  ages = {};
  urls = [];
  sdexCalls = 0;
});

test("coingeckoIsLive: a price updated in the last 3 days", () => {
  const now = T0;
  const at = (ms) => Math.floor((now - ms) / 1000);
  assert.equal(pricing.coingeckoIsLive({ usd: 1, last_updated_at: at(60_000) }, now), true);
  assert.equal(pricing.coingeckoIsLive({ usd: 1, last_updated_at: at(21 * 3600_000) }, now), true, "the oldest live id seen");
  assert.equal(pricing.coingeckoIsLive({ usd: 1, last_updated_at: at(2.9 * DAY) }, now), true);
  assert.equal(pricing.coingeckoIsLive({ usd: 1, last_updated_at: at(3.1 * DAY) }, now), false);
  assert.equal(pricing.coingeckoIsLive({ usd: 0.289208, last_updated_at: at(144 * DAY) }, now), false, "VEUR");
  assert.equal(pricing.coingeckoIsLive({ usd: 1 }, now), true, "no date given: can't tell, taken as live");
  assert.equal(pricing.coingeckoIsLive({ usd: 0, last_updated_at: at(0) }, now), false);
  assert.equal(pricing.coingeckoIsLive(undefined, now), false);
});

test("a live CoinGecko price is used as before, and asked for with its date", async () => {
  ages.aquarius = 5 * 60_000;
  const p = await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER);
  assert.deepEqual(p, { usd: 0.00029, change24h: 1, source: "coingecko", confidence: "high" });
  assert.ok(urls.some((u) => u.includes("include_last_updated_at=true")));
  assert.equal(sdexCalls, 0);
});

test("a frozen CoinGecko price isn't used: the order book prices the asset", async () => {
  ages.yieldblox = 316 * DAY;
  const p = await pricing.priceClassicAsset(ctx, "YBX", YBX_ISSUER);
  assert.equal(p.source, "sdex");
  assert.equal(p.usd, 0.0566);
  assert.equal(sdexCalls, 1);
});

test("a frozen price is an answer, not a miss: even 'no price' is kept like any other", async () => {
  // A CoinGecko miss (a rate limit) isn't remembered, so the next load asks
  // again; a frozen price is CoinGecko's answer, so the "no price" that
  // follows is remembered for its usual 5 minutes.
  ages.yieldblox = 316 * DAY;
  const noBook = { priceViaSDEX: async () => { sdexCalls++; return null; } };
  assert.equal(await pricing.priceClassicAsset(noBook, "YBX", YBX_ISSUER), null);
  assert.equal(await pricing.priceClassicAsset(noBook, "YBX", YBX_ISSUER), null);
  assert.equal(sdexCalls, 1, "the second lookup is served from the cache");
  assert.equal(urls.filter((u) => u.includes("/simple/price")).length, 1);
});

test("a price that was live and then froze isn't served as 'stale' either", async (t) => {
  ages.aquarius = 0;
  assert.equal((await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER)).source, "coingecko");
  // Ten minutes on (past the 60 s price cache, inside the 15-minute stale
  // window), CoinGecko answers with a price it hasn't updated in 4 days.
  t.mock.timers.setTime(clock + 10 * 60_000);
  ages.aquarius = 4 * DAY;
  const p = await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER);
  assert.equal(p.source, "sdex");
  assert.equal(p.stale, undefined);
});

test("a Soroban token with a frozen CoinGecko price goes on to the pools, else unpriced", async () => {
  ages["solv-btc"] = 40 * DAY;
  assert.equal(await pricing.priceSorobanToken(SOLVBTC), null);
});

test("warming the cache skips frozen prices", async () => {
  ages.yieldblox = 316 * DAY;
  ages.aquarius = 0;
  await pricing.primeKnownPrices();
  assert.ok(urls.some((u) => u.includes("include_last_updated_at=true")));
  urls = [];
  // AQUA comes from the warmed cache (no request); YBX isn't in it, so it's
  // asked for, found frozen, and priced by its order book.
  assert.equal((await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER)).source, "coingecko");
  assert.equal((await pricing.priceClassicAsset(ctx, "YBX", YBX_ISSUER)).source, "sdex");
  const asked = urls.filter((u) => u.includes("/simple/price"));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes("yieldblox") && !asked[0].includes("aquarius"), asked[0]);
});
