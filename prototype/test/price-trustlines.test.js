// A wallet's trustlines are priced eight at a time, not one after another.
//
// Each wallet load priced its classic assets in a loop, awaiting each price
// before asking for the next. A wallet with 572 non-empty trustlines took
// 80 s to load cold on the live site. These run All Wallets and the snapshot
// path (the GET /account route has no test seam for Horizon; it uses the
// same helper) against a fake pricing engine that counts how many prices are
// being worked out at once.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@stellar/stellar-sdk");

const pricing = require("../lib/pricing-engine");
const { app, __setTestDeps, fetchPortfolioForScheduler } = require("../server.js");

// ── A fake wallet and a fake pricing engine ─────────────────────────────────

const ISSUER = Keypair.random().publicKey();
let accountBalances;
let priceOf; // code -> USD, or undefined for no price
let inFlight, maxInFlight, asked;

__setTestDeps({
  getHorizon: () => ({
    loadAccount: async (address) => ({
      accountId: () => address,
      balances: accountBalances,
      subentry_count: accountBalances.length,
      num_sponsoring: 0,
      num_sponsored: 0,
    }),
  }),
  getXLMPrice: async () => ({ usd: 0.2, change24h: 0, source: "test" }),
  collectDefiPositions: async () => ({ defiPositions: [], defiByPool: [], totalUSD: 0, degraded: [] }),
  resolveSorobanTokens: async () => [],
  discoverSorobanTokens: async () => [],
  primeKnownPrices: async () => {},
});

const realPrice = pricing.priceClassicAsset;
test.before(() => {
  pricing.priceClassicAsset = async (ctx, code, issuer) => {
    assert.equal(typeof ctx?.priceViaSDEX, "function", "with the order-book layer");
    assert.equal(issuer, ISSUER);
    asked.push(code);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return priceOf[code] === undefined ? null : { usd: priceOf[code], source: "test" };
  };
});
test.after(() => { pricing.priceClassicAsset = realPrice; });

/** A wallet with `n` trustlines T0..T(n-1), each holding i+1 units at $i, plus XLM, an empty trustline and pool shares. */
function wallet(n) {
  accountBalances = [
    { asset_type: "native", balance: "100.0000000" },
    ...Array.from({ length: n }, (_, i) => ({ asset_type: "credit_alphanum4", asset_code: `T${i}`, asset_issuer: ISSUER, balance: `${i + 1}.0000000` })),
    { asset_type: "credit_alphanum4", asset_code: "EMPTY", asset_issuer: ISSUER, balance: "0.0000000" },
    { asset_type: "liquidity_pool_shares", liquidity_pool_id: "ab".repeat(32), balance: "5.0000000" },
  ];
  priceOf = Object.fromEntries(Array.from({ length: n }, (_, i) => [`T${i}`, i]));
  inFlight = 0;
  maxInFlight = 0;
  asked = [];
  // T0 is priced at $0: a price, but nothing to add. Expected total:
  // XLM $20 + sum over i of (i+1) * i.
  return 100 * 0.2 + Array.from({ length: n }, (_, i) => (i + 1) * i).reduce((a, b) => a + b, 0);
}

const tokens = (balances) => balances.filter((b) => b.type === "token");

// ── Tests ────────────────────────────────────────────────────────────────────

test("All Wallets: a wallet's trustlines are priced eight at a time, each once", async () => {
  const total = wallet(40);
  const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [Keypair.random().publicKey()] } });
  assert.equal(res.status, 200, res.raw);
  assert.equal(maxInFlight, 8, "eight at a time, not one");
  assert.deepEqual(asked.slice().sort(), Array.from({ length: 40 }, (_, i) => `T${i}`).sort(), "each once, the empty trustline not at all");

  const [w] = res.body.wallets;
  const rows = tokens(w.balances);
  assert.equal(rows.length, 40);
  for (const r of rows) {
    const i = Number(r.asset.code.slice(1));
    assert.equal(r.valueUSD, (i + 1) * i, r.asset.code);
    assert.equal(r.price.usd, i);
  }
  assert.ok(Math.abs(res.body.totalValueUSD - total) < 1e-9, `total ${res.body.totalValueUSD} vs ${total}`);
});

test("snapshots: the same, through fetchPortfolioForScheduler", async () => {
  const total = wallet(30);
  const p = await fetchPortfolioForScheduler(Keypair.random().publicKey());
  assert.equal(maxInFlight, 8);
  assert.equal(asked.length, 30);
  assert.equal(tokens(p.balances).length, 30);
  assert.ok(Math.abs(p.totalValueUSD - total) < 1e-9, `total ${p.totalValueUSD} vs ${total}`);
});

test("fewer trustlines than eight: all at once", async () => {
  wallet(3);
  await fetchPortfolioForScheduler(Keypair.random().publicKey());
  assert.equal(maxInFlight, 3);
});

test("an asset with no price is still listed, at $0", async () => {
  wallet(10);
  delete priceOf.T5;
  const p = await fetchPortfolioForScheduler(Keypair.random().publicKey());
  const t5 = tokens(p.balances).find((b) => b.asset.code === "T5");
  assert.equal(t5.price, null);
  assert.equal(t5.valueUSD, 0);
  assert.equal(tokens(p.balances).length, 10);
});

test("the wallet page's route prices through the same helper", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = src.slice(src.indexOf('app.get("/api/v1/account/:address", '), src.indexOf("// ── Soroban token balances"));
  assert.ok(route.length > 0, "route found");
  assert.match(route, /const trustlinePrices = await priceTrustlines\(account\.balances\);/);
  assert.match(route, /price = trustlinePrices\.get\(`\$\{code\}:\$\{issuer\}`\) \?\? null;/);
  assert.doesNotMatch(route, /await pricingEngine\.priceClassicAsset\(/, "no price awaited inside the loop");
});
