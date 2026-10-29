// A snapshot is not recorded while a protocol's positions can't be read.
//
// The scheduler's portfolio fetch ignored an adapter that failed, and the
// snapshot was recorded without that protocol: in the history chart and the
// value for a past date, the wallet looked that much poorer at that time (a
// $39.7M Upshift position, for one, when Upshift timed out). The portfolio
// route's auto-snapshot did the same with the protocols it reports degraded.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const historyDb = require("../lib/history-db");
const scheduler = require("../lib/snapshot-scheduler");
const server = require("../server.js");
const { app, __setTestDeps, PROTOCOL_ADAPTERS } = server;

// ── Fakes: no Horizon, no prices, and two protocols we control ─────────────

let degraded = []; // what collectDefiPositions reports for POST /api/v1/portfolio
__setTestDeps({
  getHorizon: () => ({
    loadAccount: async () => ({
      balances: [{ asset_type: "native", balance: "1000.0000000" }],
      subentry_count: 0, num_sponsoring: 0, num_sponsored: 0,
    }),
  }),
  getXLMPrice: async () => ({ usd: 0.2, change24h: 0, source: "test" }),
  collectDefiPositions: async () => ({ defiPositions: [], defiByPool: [], totalUSD: 0, degraded }),
  resolveSorobanTokens: async () => [],
  discoverSorobanTokens: async () => [],
  primeKnownPrices: async () => {},
});

let vaultState; // "ok" | "fail" | "hang"
const lending = { name: "Lending", protocolId: "lending", isConfigured: () => true,
  getPositions: async () => [{ protocol: "lending", valueUSD: 300 }] };
const vaults = { name: "Vaults", protocolId: "vaults", isConfigured: () => true,
  getPositions: () => {
    if (vaultState === "fail") return Promise.reject(new Error("Vaults timed out after 8000ms"));
    if (vaultState === "hang") return new Promise(() => {});
    return Promise.resolve([{ protocol: "vaults", valueUSD: 39_700_000 }]);
  } };
const realAdapters = PROTOCOL_ADAPTERS.slice();
test.before(() => PROTOCOL_ADAPTERS.splice(0, PROTOCOL_ADAPTERS.length, lending, vaults));
test.after(() => PROTOCOL_ADAPTERS.splice(0, PROTOCOL_ADAPTERS.length, ...realAdapters));

const snapshots = (a) =>
  historyDb.db.prepare("SELECT total_value_usd FROM portfolio_snapshots WHERE address = ? ORDER BY id").all(a);
const XLM_USD = 1000 * 0.2;

test.beforeEach(() => {
  vaultState = "ok";
  degraded = [];
});

// ── The scheduler ───────────────────────────────────────────────────────────

test("a protocol that fails is listed in defiDegraded, not silently left out", async () => {
  vaultState = "fail";
  const p = await server.fetchPortfolioForScheduler(Keypair.random().publicKey());
  assert.deepEqual(p.defiDegraded, ["Vaults"]);
  assert.equal(p.defiPositions.length, 1);
});

test("a protocol that never answers is given up on, not waited for forever", { timeout: 10_000 }, async (t) => {
  vaultState = "hang";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = server.fetchPortfolioForScheduler(Keypair.random().publicKey());
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); // let it reach the adapters
  t.mock.timers.tick(60_000);
  const p = await pending;
  assert.deepEqual(p.defiDegraded, ["Vaults"]);
});

test("the scheduler records no snapshot while a protocol fails, and tries again 5 minutes later", { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = Keypair.random().publicKey();
  historyDb.trackWallet(a);

  vaultState = "fail";
  await scheduler.tick();
  assert.deepEqual(snapshots(a), [], "a snapshot without the $39.7M vault position");
  const stats = scheduler.getStats();
  assert.equal(stats.incompleteSkipped, 1);
  assert.deepEqual(stats.lastIncomplete?.protocols, ["Vaults"]);
  assert.ok(!JSON.stringify(stats).includes(a), "stats don't name the wallet");

  vaultState = "ok";
  await scheduler.tick();
  assert.deepEqual(snapshots(a), [], "not retried on the very next tick");

  t.mock.timers.setTime(Date.now() + 6 * 60_000);
  await scheduler.tick();
  assert.deepEqual(snapshots(a).map((s) => s.total_value_usd), [XLM_USD + 300 + 39_700_000]);
});

// ── The portfolio route's auto-snapshot ─────────────────────────────────────

test("POST /api/v1/portfolio doesn't auto-snapshot a wallet while a protocol is degraded", async () => {
  const a = Keypair.random().publicKey();
  historyDb.trackWallet(a);

  degraded = ["Upshift"];
  const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body.wallets[0].defiDegraded, ["Upshift"], "the page still says so");
  assert.deepEqual(snapshots(a), []);

  degraded = [];
  await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
  assert.equal(snapshots(a).length, 1, "recorded once every protocol answers");
});
