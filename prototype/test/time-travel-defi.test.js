// Snapshots keep each DeFi position, so a past date shows what its DeFi
// total was made of.
//
// A snapshot kept the portfolio total and only a COUNT of DeFi positions, so
// "View balances at" a past date could not say which venues the DeFi part
// was in or how much of each asset: the one thing needed to close a period.
// Now each position is summarized into defi_snapshot_positions
// (lib/defi-snapshot.js) and returned by /snapshot-at.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const historyDb = require("../lib/history-db");
const { summarizeDefiPosition } = require("../lib/defi-snapshot");
const { app } = require("../server.js");

const addr = () => Keypair.random().publicKey();

// One position of each shape the adapters return (trimmed to what matters).
const BLEND_SUPPLY = { protocol: "blend", type: "lending", subtype: "collateral", poolName: "Fixed Pool V2", asset: "XLM", underlyingAmount: 698040240.12, valueUSD: 118000000 };
const BLEND_BORROW = { protocol: "blend", type: "borrowing", subtype: "liability", poolName: "Fixed Pool V2", asset: "USDC", underlyingAmount: 39276416.17, valueUSD: -39276416.17 };
const AQUARIUS_LP = { protocol: "aquarius", type: "lp", token0: { symbol: "PYUSD" }, token1: { symbol: "USDC" }, amounts: { token0: "4447280.19", token1: "3554114.75" }, valueUSD: 8001394.94 };
const SUSHI_LP = { protocol: "sushiswap-v3", type: "concentrated_lp", poolName: "SushiSwap V3 PYUSD/USDC (full range)", token0: { symbol: "PYUSD" }, token1: { symbol: "USDC" }, amounts: { token0: "2.0", token1: "2.0" }, valueUSD: 4 };
const UPSHIFT = { protocol: "upshift", type: "vault", vaultName: "Sentora USDC", deposited: { amount: "38705049", asset: "USDC" }, yield: { accrued: "1007975", asset: "USDC", apy: 7.99 }, valueUSD: 39713024.62 };
const TEMPLAR = { protocol: "templar", type: "vault", vaultName: "Templar lending position", deposited: { amount: "1000.00", asset: "USDC" }, borrow: { amount: "500.00", asset: "XLM" }, valueUSD: 900 };
const TEMPLAR_BORROW_ONLY = { protocol: "templar", type: "vault", vaultName: "Templar XLM deposit", deposited: null, borrow: { amount: "50", asset: "USDC" }, valueUSD: -50 };
const SOLV_STAKE = { protocol: "solv-protocol", type: "staking", staked: { amount: "1.5", asset: "SolvBTC" }, valueUSD: 0 };
const AQUA_ADAPTER_LP = { protocol: "aquarius", type: "lp", tokens: [{ symbol: "XLM" }, { symbol: "USDC" }], amounts: [{ symbol: "XLM", amount: "100" }, { symbol: "USDC", amount: "17" }], valueUSD: 34 };

// ── The summary ─────────────────────────────────────────────────────────────

test("lending rows: the asset and whether it is supplied or borrowed", () => {
  assert.deepEqual(summarizeDefiPosition(BLEND_SUPPLY), {
    protocol: "blend", name: "Fixed Pool V2",
    legs: [{ amount: 698040240.12, asset: "XLM", side: "supplied" }],
    valueUSD: 118000000, stale: false,
  });
  assert.deepEqual(summarizeDefiPosition(BLEND_BORROW).legs, [{ amount: 39276416.17, asset: "USDC", side: "borrowed" }]);
});

test("LPs: both tokens, named by the pool or the pair", () => {
  const aqua = summarizeDefiPosition(AQUARIUS_LP);
  assert.equal(aqua.name, "PYUSD/USDC");
  assert.deepEqual(aqua.legs, [
    { amount: 4447280.19, asset: "PYUSD", side: "pooled" },
    { amount: 3554114.75, asset: "USDC", side: "pooled" },
  ]);
  assert.equal(summarizeDefiPosition(SUSHI_LP).name, "SushiSwap V3 PYUSD/USDC (full range)");
  assert.deepEqual(summarizeDefiPosition(AQUA_ADAPTER_LP).legs.map((l) => l.asset), ["XLM", "USDC"]);
});

test("vaults: the deposit, and a Templar borrow as its own leg", () => {
  assert.deepEqual(summarizeDefiPosition(UPSHIFT).legs, [{ amount: 38705049, asset: "USDC", side: "deposited" }]);
  assert.equal(summarizeDefiPosition(UPSHIFT).name, "Sentora USDC");
  assert.deepEqual(summarizeDefiPosition(TEMPLAR).legs, [
    { amount: 1000, asset: "USDC", side: "deposited" },
    { amount: 500, asset: "XLM", side: "borrowed" },
  ]);
  assert.deepEqual(summarizeDefiPosition(TEMPLAR_BORROW_ONLY).legs, [{ amount: 50, asset: "USDC", side: "borrowed" }]);
  assert.deepEqual(summarizeDefiPosition(SOLV_STAKE).legs, [{ amount: 1.5, asset: "SolvBTC", side: "staked" }]);
});

test("odd input doesn't throw: unknown shapes, display strings with commas, NaN values", () => {
  assert.deepEqual(summarizeDefiPosition({ protocol: "new-thing", valueUSD: 5 }), { protocol: "new-thing", name: null, legs: [], valueUSD: 5, stale: false });
  assert.equal(summarizeDefiPosition({ ...UPSHIFT, deposited: { amount: "38,705,049", asset: "USDC" } }).legs[0].amount, 38705049);
  assert.equal(summarizeDefiPosition({ ...UPSHIFT, valueUSD: NaN }).valueUSD, 0);
  assert.equal(summarizeDefiPosition({ ...BLEND_SUPPLY, stale: true }).stale, true);
});

// ── Recording and reading back ──────────────────────────────────────────────

function record(address, defiPositions) {
  return historyDb.recordSnapshot({
    address, totalValueUSD: 1, balances: [{ type: "native", balance: "10", valueUSD: 1, price: { usd: 0.1 } }],
    defiPositions, xlmPrice: { usd: 0.1 }, balanceCount: 1,
  }, "mainnet", { autoTrack: true });
}

test("a snapshot keeps its DeFi positions, and a past date returns them, largest first", () => {
  const a = addr();
  record(a, [TEMPLAR, BLEND_BORROW, { ...BLEND_SUPPLY, stale: true }, UPSHIFT]);
  const snap = historyDb.getSnapshotAtDate(a, new Date().toISOString());
  assert.deepEqual(snap.defiPositions.map((d) => [d.protocol, d.valueUSD]), [
    ["blend", 118000000], ["upshift", 39713024.62], ["blend", -39276416.17], ["templar", 900],
  ]);
  assert.equal(snap.defiPositions[0].stale, true);
  assert.deepEqual(snap.defiPositions[3].legs, summarizeDefiPosition(TEMPLAR).legs);
});

test("odd positions are kept as well as they can be", () => {
  const a = addr();
  record(a, [{ protocol: null, amounts: "?", valueUSD: Infinity }, null, UPSHIFT]);
  const snap = historyDb.getSnapshotAtDate(a, new Date().toISOString());
  assert.deepEqual(snap.defiPositions.map((d) => [d.protocol, d.legs.length, d.valueUSD]), [
    ["upshift", 1, 39713024.62], ["unknown", 0, 0],
  ]);
});

test("a position that breaks the summary doesn't stop the snapshot", () => {
  const a = addr();
  const broken = Object.defineProperty({ protocol: "x" }, "type", { get() { throw new Error("boom"); } });
  const id = record(a, [UPSHIFT, broken]);
  assert.ok(id, "the snapshot is recorded");
  assert.ok(historyDb.db.prepare("SELECT last_snapshot_at FROM tracked_wallets WHERE address = ?").get(a).last_snapshot_at);
  assert.deepEqual(historyDb.getSnapshotAtDate(a, new Date().toISOString()).defiPositions, []);
});

test("retention removes the DeFi rows with their snapshot (no foreign-key error)", () => {
  const a = addr();
  const id = Number(record(a, [UPSHIFT, TEMPLAR]));
  historyDb.db.prepare("DELETE FROM token_snapshots WHERE snapshot_id = ?").run(id); // as cleanup does, children first
  historyDb.db.prepare("UPDATE portfolio_snapshots SET snapshot_at = datetime('now', '-500 days') WHERE id = ?").run(id);
  assert.doesNotThrow(() => historyDb.cleanupOldSnapshots(a, 365));
  assert.equal(historyDb.db.prepare("SELECT COUNT(*) AS c FROM defi_snapshot_positions WHERE snapshot_id = ?").get(id).c, 0);
});

// ── The route ───────────────────────────────────────────────────────────────

test("GET /snapshot-at returns the DeFi positions", async () => {
  const a = addr();
  record(a, [AQUARIUS_LP, BLEND_BORROW]);
  const res = await request(app, "GET", `/api/v1/account/${a}/snapshot-at?date=${encodeURIComponent(new Date().toISOString())}`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body.defiPositions, [
    { protocol: "blend", name: "Fixed Pool V2", legs: [{ amount: 39276416.17, asset: "USDC", side: "borrowed" }], valueUSD: -39276416.17, stale: false },
    { protocol: "aquarius", name: "PYUSD/USDC", legs: summarizeDefiPosition(AQUARIUS_LP).legs, valueUSD: 8001394.94, stale: false },
  ]);
});

test("a snapshot from before positions were kept returns an empty list, with its count", async () => {
  const a = addr();
  historyDb.trackWallet(a);
  historyDb.db.prepare(`
    INSERT INTO portfolio_snapshots (address, network, total_value_usd, defi_position_count, snapshot_at)
    VALUES (?, 'mainnet', 100, 3, datetime('now'))
  `).run(a);
  const res = await request(app, "GET", `/api/v1/account/${a}/snapshot-at?date=${encodeURIComponent(new Date().toISOString())}`);
  assert.deepEqual(res.body.defiPositions, []);
  assert.equal(res.body.defiPositionCount, 3);
});
