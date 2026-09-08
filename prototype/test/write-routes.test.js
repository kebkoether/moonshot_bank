const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const historyDb = require("../lib/history-db");
const { app, __setTestDeps } = require("../server.js");

// No Horizon, no CoinGecko, no adapters.
__setTestDeps({
  getHorizon: () => ({
    loadAccount: async (address) => ({
      balances: [{ asset_type: "native", balance: "1000.0000000" }],
      accountId: () => address,
    }),
  }),
  getXLMPrice: async () => ({ usd: 0.12, change24h: 0, source: "test", confidence: "high" }),
  collectDefiPositions: async () => ({ defiPositions: [], defiByPool: [], totalUSD: 0, degraded: [] }),
  resolveSorobanTokens: async () => [],
  discoverSorobanTokens: async () => [],
  primeKnownPrices: async () => {},
});

const addr = () => Keypair.random().publicKey();
const snapshotCount = (a) =>
  historyDb.db.prepare("SELECT COUNT(*) AS c FROM portfolio_snapshots WHERE address = ?").get(a).c;
const walletRow = (a) =>
  historyDb.db.prepare("SELECT * FROM tracked_wallets WHERE address = ?").get(a);

const tokenRowCount = (a) => historyDb.db.prepare(`
  SELECT COUNT(*) AS c FROM token_snapshots
   WHERE snapshot_id IN (SELECT id FROM portfolio_snapshots WHERE address = ?)
`).get(a).c;

/**
 * Seed realistic history: hourly snapshots over the last `hours` hours, each
 * with a token row. Backdating matters — snapshots written in the current second
 * are not "older than now", so a test that inserts and immediately downsamples
 * passes even against the unclamped code and proves nothing. The token rows
 * matter too: they are what makes the parent delete hit a foreign key.
 */
function seedHistory(a, hours = 24) {
  historyDb.trackWallet(a);
  for (let h = 1; h <= hours; h++) {
    const info = historyDb.db.prepare(`
      INSERT INTO portfolio_snapshots (address, network, total_value_usd, snapshot_at)
      VALUES (?, 'mainnet', ?, datetime('now', ?))
    `).run(a, 1000 + h, `-${h} hours`);
    historyDb.db.prepare(
      "INSERT INTO token_snapshots (snapshot_id, asset_code, balance) VALUES (?, 'XLM', 1)"
    ).run(Number(info.lastInsertRowid));
  }
}

test("REMOVED: the unauthenticated snapshot-delete route is gone", async () => {
  const a = addr();
  seedHistory(a);
  assert.equal(snapshotCount(a), 24);

  const res = await request(app, "POST", "/api/v1/history/downsample", {
    body: { fullResDays: 0, maxDays: 0 },
  });
  assert.equal(res.status, 404);
  assert.equal(snapshotCount(a), 24, "history must survive");
});

test("downsample cannot be turned into a wipe by any argument", () => {
  // Reachable through the (now removed) unauthenticated route, which passed
  // req.body straight through. Clamping only fullResDays is not enough:
  // {fullResDays:-1, maxDays:1} still deleted everything older than 24 hours.
  const a = addr();
  seedHistory(a);
  assert.equal(snapshotCount(a), 24);

  for (const options of [
    { fullResDays: 0, maxDays: 0 },
    { fullResDays: -1, maxDays: 1 },
    { fullResDays: "0", maxDays: "0" },
    {},
  ]) {
    historyDb.downsample(a, options);
    assert.equal(snapshotCount(a), 24, `wiped by ${JSON.stringify(options)}`);
  }
  historyDb.downsampleAll({ fullResDays: 0, maxDays: 0 });
  assert.equal(snapshotCount(a), 24, "downsampleAll wiped it");
});

test("downsample actually prunes, and does not trip a foreign key", () => {
  // token_snapshots.snapshot_id has no ON DELETE CASCADE and better-sqlite3
  // enables foreign_keys by default, so deleting a parent snapshot that still
  // has token rows raised SQLITE_CONSTRAINT_FOREIGNKEY. Retention pruning had
  // therefore never worked — the startup call threw and was swallowed by a
  // try/catch. Children are deleted before parents now.
  const a = addr();
  historyDb.trackWallet(a);
  // Two snapshots a year and a half old, each with a token row.
  for (const days of [540, 560]) {
    const info = historyDb.db.prepare(`
      INSERT INTO portfolio_snapshots (address, network, total_value_usd, snapshot_at)
      VALUES (?, 'mainnet', 1, datetime('now', ?))
    `).run(a, `-${days} days`);
    historyDb.db.prepare(
      "INSERT INTO token_snapshots (snapshot_id, asset_code, balance) VALUES (?, 'XLM', 1)"
    ).run(Number(info.lastInsertRowid));
  }
  // Plus fresh history that must survive.
  seedHistory(a, 3);
  assert.equal(snapshotCount(a), 5);

  assert.doesNotThrow(() => historyDb.downsample(a));
  assert.equal(snapshotCount(a), 3, "rows past the 365-day retention should be gone");
  assert.equal(tokenRowCount(a), 3, "their token rows should be gone too");
  assert.equal(
    historyDb.db.prepare(
      "SELECT COUNT(*) AS c FROM token_snapshots WHERE snapshot_id NOT IN (SELECT id FROM portfolio_snapshots)"
    ).get().c,
    0,
    "no orphaned token rows"
  );
});

test("cleanupOldSnapshots does not trip a foreign key either", () => {
  const a = addr();
  historyDb.trackWallet(a);
  const info = historyDb.db.prepare(`
    INSERT INTO portfolio_snapshots (address, network, total_value_usd, snapshot_at)
    VALUES (?, 'mainnet', 1, datetime('now', '-400 days'))
  `).run(a);
  historyDb.db.prepare(
    "INSERT INTO token_snapshots (snapshot_id, asset_code, balance) VALUES (?, 'XLM', 1)"
  ).run(Number(info.lastInsertRowid));

  assert.doesNotThrow(() => historyDb.cleanupOldSnapshots(a, 365));
  assert.equal(snapshotCount(a), 0);
});

test("REMOVED: the unauthenticated tier bump is gone", async () => {
  const a = addr();
  historyDb.trackWallet(a);
  const res = await request(app, "POST", `/api/v1/account/${a}/tier`, { body: { tier: "premium" } });
  assert.equal(res.status, 404);
  assert.equal(walletRow(a).tier, "free");
});

test("REMOVED: the callerless /track routes are gone", async () => {
  const a = addr();
  const post = await request(app, "POST", `/api/v1/account/${a}/track`, {
    body: { label: "<img src=x onerror=alert(1)>", tier: "premium" },
  });
  assert.equal(post.status, 404);
  assert.equal(walletRow(a), undefined, "must not have created a tracked wallet");

  historyDb.trackWallet(a);
  const del = await request(app, "DELETE", `/api/v1/account/${a}/track`);
  assert.equal(del.status, 404);
  assert.equal(walletRow(a).tracking_enabled, 1);
});

test("POST /api/v1/wallets ignores a tier in the body", async () => {
  const a = addr();
  const res = await request(app, "POST", "/api/v1/wallets", {
    body: { address: a, label: "mine", tier: "premium" },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(walletRow(a).tier, "free");
});

test("trackWallet validates its own inputs, not just the route", () => {
  assert.throws(() => historyDb.trackWallet("not-an-address"), /Invalid Stellar address/);
  assert.throws(() => historyDb.trackWallet(addr(), "mainnet", null, "premium-plus"), /Invalid tier/);
  // lowercase and 0/1 are outside the base32 alphabet
  assert.throws(() => historyDb.trackWallet("g" + "A".repeat(55)), /Invalid Stellar address/);
  assert.throws(() => historyDb.trackWallet("G" + "0".repeat(55)), /Invalid Stellar address/);
});

test("an anonymous portfolio read does not enrol the address", async () => {
  const a = addr();
  const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
  assert.equal(res.status, 200, res.raw);
  assert.equal(walletRow(a), undefined, "must not enrol an untracked address");
  assert.equal(snapshotCount(a), 0, "must not write history for an untracked address");
});

test("an anonymous portfolio read does not resurrect an untracked wallet", async () => {
  const a = addr();
  historyDb.trackWallet(a);
  historyDb.untrackWallet(a);
  assert.equal(walletRow(a).tracking_enabled, 0);

  const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
  assert.equal(res.status, 200, res.raw);
  assert.equal(walletRow(a).tracking_enabled, 0, "untracking must stick");
});

test("the five-minute snapshot throttle actually throttles", async () => {
  // snapshot_at is SQLite "YYYY-MM-DD HH:MM:SS"; it was string-compared against
  // an ISO timestamp, and ' ' < 'T' at index 10 made the comparison always true.
  const a = addr();
  historyDb.trackWallet(a);
  assert.equal(snapshotCount(a), 0);

  for (let i = 0; i < 3; i++) {
    const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
    assert.equal(res.status, 200, res.raw);
  }
  assert.equal(snapshotCount(a), 1, "three reads inside five minutes wrote more than one snapshot");
});

test("addresses are validated and capped", async () => {
  const bad = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: ["gABC"] } });
  assert.equal(bad.status, 400);

  const many = await request(app, "POST", "/api/v1/portfolio", {
    body: { addresses: Array.from({ length: 26 }, addr) },
  });
  assert.equal(many.status, 400);
  assert.match(many.body.error, /Too many addresses/);

  // The empty-payload response is unchanged.
  const empty = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [] } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.walletCount, 0);

  const history = await request(app, "POST", "/api/v1/portfolio/history", {
    body: { addresses: ["nope"] },
  });
  assert.equal(history.status, 400);
});

test("GET /api/v1/account/:address rejects malformed addresses", async () => {
  const res = await request(app, "GET", `/api/v1/account/${"g" + "A".repeat(55)}`);
  assert.equal(res.status, 400);
});

test("PATCH /api/v1/wallets/:address validates the address", async () => {
  const res = await request(app, "PATCH", "/api/v1/wallets/not-an-address", { body: { label: "x" } });
  assert.equal(res.status, 400);
});

test("sameOriginOnly accepts Sec-Fetch-Site and rejects a foreign origin", async () => {
  const a = addr();
  // Same-origin GETs carry no Origin header at all; before Sec-Fetch-Site was
  // accepted, these depended entirely on Referer.
  const viaFetchSite = await request(app, "POST", "/api/v1/wallets", {
    body: { address: a },
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(viaFetchSite.status, 200, viaFetchSite.raw);

  const noSignals = await request(app, "POST", "/api/v1/wallets", {
    body: { address: addr() },
    headers: { "Sec-Fetch-Site": "" },
  });
  assert.equal(noSignals.status, 403);

  const foreign = await request(app, "POST", "/api/v1/wallets", {
    body: { address: addr() },
    headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);

  const allowed = await request(app, "POST", "/api/v1/wallets", {
    body: { address: addr() },
    headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://stellarscope.xyz" },
  });
  assert.equal(allowed.status, 200, allowed.raw);
});
