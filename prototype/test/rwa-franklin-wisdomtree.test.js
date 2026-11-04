// Franklin Templeton's gBENJI and grBENJI and WisdomTree's WTGX, Dollar Token
// and Gold Token are on the RWA tab, and the pricing engine values each of
// them, so the tab can show their Stellar market cap (Horizon supply × price).
// None of the five has a DEX market, and only WTGX is on CoinGecko.
//
// Every code here is also issued by spam accounts on mainnet (3 billion
// "gBENJI", 91 trillion "GOLD"), so only the real issuers get a price.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { StrKey } = require("@stellar/stellar-sdk");

// No real network: the aggregator (last layer) is mocked, and CoinGecko is a fake.
const aggregator = require("../lib/soroswap-aggregator");
aggregator.priceClassicAssetViaSACInUSD = async () => null;
aggregator.priceSorobanTokenInUSD = async () => null;

const PAXG_USD = 4012.5;
const realFetch = global.fetch;
let keepAlive; // the CoinGecko micro-batch timer is unref()'d
test.before(() => {
  keepAlive = setInterval(() => {}, 1000);
  global.fetch = async (url) => {
    url = String(url);
    if (url.includes("/simple/price")) {
      const ids = decodeURIComponent(new URL(url).searchParams.get("ids") || "").split(",");
      const all = {
        "pax-gold": { usd: PAXG_USD, usd_24h_change: 0.4 },
        "wisdomtree-treasury-money-market-digital-fund": { usd: 1.0, usd_24h_change: 0 },
      };
      const body = Object.fromEntries(ids.filter((id) => all[id]).map((id) => [id, all[id]]));
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

const pricing = require("../lib/pricing-engine");

const ISSUERS = {
  gBENJI: "GD5J73EKK5IYL5XS3FBTHHX7CZIYRP7QXDL57XFWGC2WVYWT326OBXRP",
  grBENJI: "GA3ZBL3LBRKOF7CZ6MCA7JLPHWQCGYCCGKH4GVWNEDZOXW4IPXFGN2FQ",
  WTGX: "GDMBNMFJ3TRFLASJ6UGETFME3PJPNKPU24C7KFDBEBPQFG2CI6UC3JG6",
  USD: "GC2ATEL4K2O5BJO7Z76MYSV6TKHCROKV5GXEOU7NO2TUEOOMFDDIPWID",
  GOLD: "GCK75CK3VX5L4ZLSD7HHNVA4L3LKGIAYWLCZO2IBNGOFTBV3HJBE2MPJ",
};
// Real spam issuers on mainnet (Horizon, 2026-11-04).
const SPAM_GBENJI = "GAYBNOMQB6723Q546PLGZ5PU2SG534WFI4LENDF5UK4BWVZUXUXSIWCE"; // 3,000,000,000 "gBENJI"
const SPAM_GOLD = "GA2AZ7XYAUOIWIEGSV6WGQUDHTMVYIPJBGXCVG3ITVKOFEMK4TV6W35Q"; // 91.8 trillion "GOLD"

/** A valid issuer that starts with the same 14 characters as `issuer` (a vanity look-alike). */
function lookAlike(issuer) {
  const raw = StrKey.decodeEd25519PublicKey(issuer);
  return StrKey.encodeEd25519PublicKey(Buffer.concat([raw.subarray(0, 8), crypto.randomBytes(24)]));
}

const noMarket = { priceViaSDEX: async () => null };
const price = (code, issuer) => pricing.priceClassicAsset(noMarket, code, issuer);

test("gBENJI, grBENJI and WisdomTree's Dollar Token are $1 from their issuers", async () => {
  for (const code of ["gBENJI", "grBENJI", "USD"]) {
    const p = await price(code, ISSUERS[code]);
    assert.equal(p?.usd, 1, code);
    assert.equal(p.source, "stablecoin", code);
  }
});

test("WisdomTree's Gold Token is priced as one troy ounce (PAXG)", async () => {
  const p = await price("GOLD", ISSUERS.GOLD);
  assert.equal(p?.usd, PAXG_USD);
  assert.equal(p.source, "coingecko");
});

test("WTGX takes CoinGecko's price for WisdomTree's fund", async () => {
  const p = await price("WTGX", ISSUERS.WTGX);
  assert.equal(p?.usd, 1);
  assert.equal(p.source, "coingecko");
});

test("the same codes from other issuers get no price", async () => {
  assert.equal(await price("gBENJI", SPAM_GBENJI), null);
  assert.equal(await price("GOLD", SPAM_GOLD), null);
  for (const code of Object.keys(ISSUERS)) {
    const fake = lookAlike(ISSUERS[code]);
    assert.equal(fake.slice(0, 12), ISSUERS[code].slice(0, 12), "same 12-character map key");
    assert.equal(await price(code, fake), null, `${code} from a look-alike issuer`);
  }
});

test("the five are on the RWA tab, in their categories, and the tab can value each", async () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rwa-catalog.json"), "utf8"));
  const where = {};
  for (const cat of catalog.categories) {
    for (const a of cat.assets) {
      if (a.issuer && ISSUERS[a.code] === a.issuer) where[a.code] = cat.id;
    }
  }
  assert.deepEqual(where, {
    gBENJI: "us-treasuries",
    grBENJI: "us-treasuries",
    WTGX: "us-treasuries",
    USD: "us-stablecoins",
    GOLD: "tokenized-gold",
  });
  // server.js values a classic RWA as Horizon supply × priceClassicAsset.
  for (const [code, issuer] of Object.entries(ISSUERS)) {
    assert.ok((await price(code, issuer))?.usd > 0, `${code} has a price`);
  }
});

test("no two RWA tab assets share a slug", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rwa-catalog.json"), "utf8"));
  const slugs = catalog.categories.flatMap((c) => c.assets).map(
    (a) => `${a.code.toLowerCase()}-${(a.issuer || a.contractId).toLowerCase().slice(0, 6)}`,
  );
  assert.equal(new Set(slugs).size, slugs.length);
});
