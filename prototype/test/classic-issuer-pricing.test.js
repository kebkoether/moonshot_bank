// A classic asset gets CoinGecko's price only if it comes from the issuer
// CoinGecko lists.
//
// The price map fell back to matching on the asset code alone, so an asset
// called PYUSD, yUSDC, AQUA, ... from ANY issuer got the real token's price.
// Anyone can issue an asset with any code, and spam issuers do: a mainnet
// wallet holding 103M PYUSD from a look-alike issuer showed as a $103M
// portfolio, priced by CoinGecko with "high" confidence.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Keypair, StrKey } = require("@stellar/stellar-sdk");

// No real network: the aggregator (last layer) is mocked, and CoinGecko is a fake.
const aggregator = require("../lib/soroswap-aggregator");
let aggregatorAnswer = null;
aggregator.priceClassicAssetViaSACInUSD = async () => aggregatorAnswer;
aggregator.priceSorobanTokenInUSD = async () => null;

const realFetch = global.fetch;
let coinsList = null; // CoinGecko /coins/list answer for the price-map refresh
// The CoinGecko micro-batch timer is unref()'d (the server's listener keeps
// the process alive); without a live handle a test would exit mid-await.
let keepAlive;
test.before(() => {
  keepAlive = setInterval(() => {}, 1000);
  global.fetch = async (url) => {
    url = String(url);
    if (url.includes("/simple/price")) {
      const ids = decodeURIComponent(new URL(url).searchParams.get("ids") || "").split(",");
      const all = {
        "paypal-usd": { usd: 0.9998, usd_24h_change: 0 },
        "stellar-yusdc": { usd: 0.9996, usd_24h_change: 0 },
        aquarius: { usd: 0.00029, usd_24h_change: 1.9 },
        "test-coin": { usd: 42, usd_24h_change: 0 },
      };
      const body = Object.fromEntries(ids.filter((id) => all[id]).map((id) => [id, all[id]]));
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.includes("/coins/list") && coinsList) return { ok: true, status: 200, json: async () => coinsList };
    return { ok: false, status: 503, json: async () => ({}) };
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

const pricing = require("../lib/pricing-engine");
const priceMap = require("../lib/token-price-map");

const PAYPAL_PYUSD = "GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5"; // its SAC is CoinGecko's PYUSD contract
const LOOKALIKE_PYUSD = "GCWNY7C67QF44H7JI7FBYUYBGZ6HSSANZPWN7SUK6BAKWDS3YHU4UIED"; // a real spam issuer on mainnet
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const ULTRA_YUSDC = "GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF"; // CoinGecko's stellar-yusdc

/** A valid issuer that starts with the same 14 characters as `issuer` (a vanity look-alike). */
function lookAlike(issuer) {
  const raw = StrKey.decodeEd25519PublicKey(issuer);
  return StrKey.encodeEd25519PublicKey(Buffer.concat([raw.subarray(0, 8), crypto.randomBytes(24)]));
}

const noMarket = { priceViaSDEX: async () => null };

test.beforeEach(() => {
  aggregatorAnswer = null;
});

test("an asset with a known code from another issuer doesn't get the real token's price", async () => {
  // Its own market still prices it (here: almost nothing).
  const sdex = { priceViaSDEX: async () => ({ usd: 0.000001, change24h: 0 }) };
  const p = await pricing.priceClassicAsset(sdex, "PYUSD", LOOKALIKE_PYUSD);
  assert.equal(p.source, "sdex");
  assert.equal(p.usd, 0.000001);

  // No market at all: unpriced, not $1.
  assert.equal(await pricing.priceClassicAsset(noMarket, "yUSDC", Keypair.random().publicKey()), null);
  assert.equal(await pricing.priceClassicAsset(noMarket, "AQUA", Keypair.random().publicKey()), null);
});

test("an issuer sharing the real one's first characters doesn't get its price either", async () => {
  const fake = lookAlike(AQUA_ISSUER);
  assert.equal(fake.slice(0, 12), AQUA_ISSUER.slice(0, 12), "same 12-character map key");
  assert.equal(await pricing.priceClassicAsset(noMarket, "AQUA", fake), null);
});

test("the real issuers still get CoinGecko's price", async () => {
  const pyusd = await pricing.priceClassicAsset(noMarket, "PYUSD", PAYPAL_PYUSD);
  assert.equal(pyusd.source, "coingecko");
  assert.equal(pyusd.usd, 0.9998);

  const aqua = await pricing.priceClassicAsset(noMarket, "AQUA", AQUA_ISSUER);
  assert.equal(aqua.source, "coingecko");
  assert.equal(aqua.usd, 0.00029);
});

test("Ultra Capital's yUSDC is on the stablecoin list", async () => {
  const p = await pricing.priceClassicAsset(noMarket, "yUSDC", ULTRA_YUSDC);
  assert.equal(p.source, "stablecoin");
  assert.equal(p.usd, 1);
});

test("Figure's YLDS is $1 (its issuer anchors it to USD); YLDS from a look-alike issuer isn't", async () => {
  const p = await pricing.priceClassicAsset(noMarket, "YLDS", "GAC7MOPTQLQUM3KC24AW4GHS3RLF72LPEZO54AH7EZ6TSMGRB5SOAVH3");
  assert.deepEqual(p, { usd: 1, change24h: 0, source: "stablecoin", confidence: "high" });
  // A real look-alike on mainnet: 900M "YLDS", one holder, home domain xlmcoins.club.
  assert.equal(await pricing.priceClassicAsset(noMarket, "YLDS", "GBA2ZKISUQKBZ7FEIDI3VVPI2SXVMO4MJD77IQMRA7ZYTPTLZVJFY7R5"), null);
});

test("a token CoinGecko lists only in its refresh is matched on the full issuer", async () => {
  const real = Keypair.random().publicKey();
  coinsList = [{ id: "test-coin", symbol: "tst", platforms: { stellar: `TSTX-${real}` } }];
  await priceMap.refreshFromCoinGecko();
  coinsList = null;

  assert.equal((await pricing.priceClassicAsset(noMarket, "TSTX", real))?.usd, 42);
  assert.equal(await pricing.priceClassicAsset(noMarket, "TSTX", lookAlike(real)), null);
  assert.equal(await pricing.priceClassicAsset(noMarket, "TSTX", Keypair.random().publicKey()), null);
});

test("every full issuer in the hardcoded price lists is a valid Stellar address", () => {
  const issuers = Object.keys(pricing.STABLECOINS).map((k) => k.split(":")[1]);
  const seedSource = fs.readFileSync(path.join(__dirname, "../lib/token-price-map.js"), "utf8");
  for (const m of seedSource.matchAll(/issuer: "(G[A-Z2-7]{55})"/g)) issuers.push(m[1]);
  assert.ok(issuers.length >= 9, `found ${issuers.length}`); // 4 stablecoins + 5 full seed issuers today
  const invalid = issuers.filter((i) => !StrKey.isValidEd25519PublicKey(i));
  assert.deepEqual(invalid, []);
});
