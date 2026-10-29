// The Stellar Asset Contracts (SACs) of XLM and of the listed stablecoins are
// priced exactly as plain XLM and those stablecoins are.
//
// XLM's SAC was priced through CoinGecko, unless server.js had happened to
// seed XLM's price in the last minute. CoinGecko's free tier rate-limits
// shared IPs, often right after a restart, and then the XLM in Blend could
// have no price and count as $0 (for the Blend adapter on its own, a Fixed
// Pool wallet with 698M XLM supplied showed -$39M instead of +$79M). Plain
// XLM never had that problem: lib/xlm-price.js values it from Stellar's own
// DEX first. And CoinGecko had Blend's USDC at $0.9995 while plain USDC
// counted as $1.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Asset, Keypair, Networks, nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

const sac = (asset) => asset.contractId(Networks.PUBLIC);
const XLM_SAC = sac(Asset.native());
const CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_SAC = sac(new Asset("USDC", CIRCLE));
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"; // Blend's Fixed Pool V2

// ── Fakes ───────────────────────────────────────────────────────────────────
// The Blend adapter destructures the RPC helpers at require time, so these
// go in first.

const RATE = 1_000_000_000_000n; // a b_rate/d_rate of 1.0 (12 decimals)
const XLM_SUPPLIED = 1_000_000;
const USDC_BORROWED = 100_000;

const rpcLib = require("../lib/soroban-rpc");
const nameCalls = [];
rpcLib.getEventsForContract = async () => [];
rpcLib.getTokenMetadata = async (c) => ({ symbol: c === XLM_SAC ? "XLM" : "USDC", decimals: 7 });
rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  if (method === "name") {
    nameCalls.push(contractId);
    throw new Error("no name() in this test");
  }
  if (method === "get_reserve_list") return nativeToScVal(contractId === POOL ? [XLM_SAC, USDC_SAC] : []);
  if (contractId !== POOL) throw new Error(`unexpected ${method}`);
  if (method === "get_positions") {
    return nativeToScVal({
      collateral: { 0: BigInt(XLM_SUPPLIED) * 10_000_000n },
      liabilities: { 1: BigInt(USDC_BORROWED) * 10_000_000n },
      supply: {},
    });
  }
  if (method === "get_reserve") {
    return nativeToScVal({
      asset: scValToNative(args[0]),
      data: { b_rate: RATE, d_rate: RATE, b_supply: 10n ** 17n, d_supply: 10n ** 16n, ir_mod: 10_000_000n },
    });
  }
  if (method === "get_config") throw new Error("not needed");
  return nativeToScVal(null); // no emissions
};

const aggregator = require("../lib/soroswap-aggregator");
let aggregatorAnswer = null;
aggregator.priceSorobanTokenInUSD = async () => aggregatorAnswer;
aggregator.priceClassicAssetViaSACInUSD = async () => aggregatorAnswer;

// Stellar's DEX (Horizon's XLM/USDC book) and CoinGecko, each up or down.
const BID = 0.1698;
const ASK = 0.17;
const SDEX_MID = (BID + ASK) / 2;
const COINGECKO = { stellar: { usd: 0.1703, usd_24h_change: 1.2 }, "usd-coin": { usd: 0.999524, usd_24h_change: 0 } };
let horizonUp;
let coingeckoUp;
const realFetch = global.fetch;
let keepAlive; // the CoinGecko micro-batch timer is unref()'d
test.before(() => {
  keepAlive = setInterval(() => {}, 1000);
  global.fetch = async (url) => {
    url = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("/order_book") && horizonUp) {
      return json({ bids: [{ price: String(BID) }], asks: [{ price: String(ASK) }] });
    }
    if (url.includes("/trade_aggregations") && horizonUp) return json({ _embedded: { records: [] } });
    if (url.includes("/simple/price")) {
      if (!coingeckoUp) return { ok: false, status: 429, json: async () => ({}) };
      const ids = decodeURIComponent(new URL(url).searchParams.get("ids") || "").split(",");
      return json(Object.fromEntries(ids.filter((id) => COINGECKO[id]).map((id) => [id, COINGECKO[id]])));
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

const xlmPrice = require("../lib/xlm-price");
const pricing = require("../lib/pricing-engine");
const Blend = require("../lib/adapters/blend");

// Each test starts an hour after the last, so no price cached by one
// (CoinGecko's, XLM's or the engine's) is fresh in the next.
let clock = 1_800_000_000_000;
test.beforeEach((t) => {
  clock += 60 * 60_000;
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  xlmPrice._resetForTests();
  horizonUp = true;
  coingeckoUp = true;
  aggregatorAnswer = null;
  nameCalls.length = 0;
});

// ── XLM ─────────────────────────────────────────────────────────────────────

test("XLM's contract is valued at plain XLM's price, from Stellar's DEX", async () => {
  const p = await pricing.priceSorobanToken(XLM_SAC);
  assert.equal(p.usd, (await xlmPrice.getXLMPrice()).usd);
  assert.equal(p.usd, SDEX_MID, "not CoinGecko's $0.1703");
  assert.equal(p.source, "sdex");
});

test("while CoinGecko is rate-limiting, XLM's contract still has XLM's price", async () => {
  coingeckoUp = false;
  const p = await pricing.priceSorobanToken(XLM_SAC);
  assert.equal(p?.usd, SDEX_MID);
});

test("with Stellar's DEX and CoinGecko both down, it gets XLM's last good price, marked stale", async (t) => {
  coingeckoUp = false;
  const goodAt = Date.now();
  assert.equal((await pricing.priceSorobanToken(XLM_SAC)).usd, SDEX_MID);
  horizonUp = false;
  t.mock.timers.setTime(goodAt + 2 * 60_000); // past XLM's 1-minute cache
  const p = await pricing.priceSorobanToken(XLM_SAC);
  assert.equal(p.usd, SDEX_MID);
  assert.equal(p.stale, true);
  assert.equal(p.asOf, goodAt);
});

test("if XLM has never had a price, the other layers are still asked", async () => {
  horizonUp = false;
  coingeckoUp = false;
  aggregatorAnswer = { usd: 0.171, change24h: 0, source: "aquarius", confidence: "high" };
  assert.deepEqual(await pricing.priceSorobanToken(XLM_SAC), aggregatorAnswer);
});

// ── Stablecoins ─────────────────────────────────────────────────────────────

test("Circle USDC's contract is $1, as plain USDC is, though CoinGecko says $0.9995", async () => {
  const p = await pricing.priceSorobanToken(USDC_SAC);
  assert.deepEqual(p, { usd: 1, change24h: 0, source: "stablecoin", confidence: "high" });
  assert.equal((await pricing.priceClassicAsset(null, "USDC", CIRCLE)).usd, 1);
});

test("every listed stablecoin's contract is $1, with no name() lookup, while CoinGecko is down", async () => {
  coingeckoUp = false;
  for (const key of Object.keys(pricing.STABLECOINS)) {
    const [code, issuer] = key.split(":");
    const p = await pricing.priceSorobanToken(sac(new Asset(code, issuer)));
    assert.equal(p?.usd, pricing.STABLECOINS[key], key);
  }
  assert.deepEqual(nameCalls, []);
});

test("another issuer's USDC contract is not a stablecoin", async () => {
  coingeckoUp = false;
  const fake = sac(new Asset("USDC", Keypair.random().publicKey()));
  assert.equal(await pricing.priceSorobanToken(fake), null);
});

// ── Blend ───────────────────────────────────────────────────────────────────

test("XLM supplied to Blend keeps its value while CoinGecko is rate-limiting", async () => {
  coingeckoUp = false;
  const positions = await Blend.getPositions(wallet().publicKey());
  const xlm = positions.find((p) => p.asset === "XLM");
  const usdc = positions.find((p) => p.asset === "USDC");
  assert.equal(xlm.unpriced, false);
  assert.equal(xlm.valueUSD, XLM_SUPPLIED * SDEX_MID);
  assert.equal(usdc.valueUSD, -USDC_BORROWED);
  const net = positions.reduce((s, p) => s + p.valueUSD, 0);
  assert.ok(net > 0, `net ${net}: the XLM is counted, not $0`);
});
