// Blend positions carry their protocol units and interest index, and every
// snapshot stores them, so interest between two snapshots can be computed
// exactly: units × (rate₂ − rate₁). Drives the real Blend adapter against a
// mocked RPC, then the real history database.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeToScVal } = require("@stellar/stellar-sdk");

// The Blend adapter destructures these at require time, so the mocks go in
// before it is loaded.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");

const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"; // a built-in Blend pool
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

// Positions above 2^53 on purpose: a JS number would round them.
const COLLATERAL_B = 12_345_678_901_234_567_890n; // bTokens, 7 decimals
const LIABILITY_D = 4_000_000_000n; // dTokens: 400.0

const chain = { bRate: 1_100_000_000_000n, dRate: 1_200_000_000_000n }; // 1.1 and 1.2 at 10^12

rpcLib.getTokenMetadata = async () => ({ symbol: "USDC", decimals: 7 });
pricing.priceSorobanToken = async () => ({ usd: 1, source: "test" });
rpcLib.simulateContractCall = async (contractId, method) => {
  if (method === "get_reserve_list") return nativeToScVal(contractId === POOL ? [USDC] : []);
  if (method === "get_positions") {
    return nativeToScVal({ collateral: { 0: COLLATERAL_B }, liabilities: { 0: LIABILITY_D }, supply: {} });
  }
  if (method === "get_reserve") {
    return nativeToScVal({
      asset: USDC,
      data: {
        b_rate: chain.bRate, d_rate: chain.dRate, b_supply: 10n ** 14n, d_supply: 10n ** 13n, ir_mod: 1_000_000_000n,
      },
    });
  }
  if (method === "get_config") throw new Error("not needed");
  return nativeToScVal(null);
};

// No Horizon here: the wallet has no history, so only the built-in pools are read.
require("../lib/adapters/blend-wallet-pools")._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) });
const Blend = require("../lib/adapters/blend");
const historyDb = require("../lib/history-db");

const toUnderlying = (units, rate, rateDecimals, decimals) =>
  Number((BigInt(units) * BigInt(rate)) / 10n ** BigInt(rateDecimals)) / 10 ** decimals;

test("Blend positions carry their units and index, exactly", async () => {
  const positions = await Blend.getPositions(wallet().publicKey());
  const supply = positions.find((p) => p.subtype === "collateral");
  const borrow = positions.find((p) => p.subtype === "liability");

  assert.deepEqual(supply.accrual, { side: "supply", units: COLLATERAL_B.toString(), rate: "1100000000000", rateDecimals: 12 });
  assert.deepEqual(borrow.accrual, { side: "borrow", units: LIABILITY_D.toString(), rate: "1200000000000", rateDecimals: 12 });
  // The stored inputs reproduce the amount the adapter reports.
  assert.ok(Math.abs(toUnderlying(supply.accrual.units, supply.accrual.rate, 12, 7) - supply.underlyingAmount) < 1e-6);
  assert.equal(toUnderlying(borrow.accrual.units, borrow.accrual.rate, 12, 7), 480);
  assert.doesNotThrow(() => JSON.stringify(positions), "positions must stay JSON-serialisable (no BigInt)");
});

test("snapshots store them, and two snapshots give the interest earned and payable", async () => {
  const address = wallet().publicKey();
  historyDb.trackWallet(address);
  const snap = async () =>
    historyDb.recordSnapshot({ address, balances: [], defiPositions: await Blend.getPositions(address) });

  chain.bRate = 1_100_000_000_000n;
  chain.dRate = 1_200_000_000_000n;
  await snap();
  chain.bRate = 1_105_000_000_000n; // supply index +0.5%
  chain.dRate = 1_212_000_000_000n; // borrow index +1.0%
  await snap();

  const rows = historyDb.getDefiPositionHistory(address, "mainnet", "all");
  assert.equal(rows.length, 4, "two positions × two snapshots");
  // Identify rows by units, then check the stored side: a wrong side must fail.
  const supplyRows = rows.filter((r) => r.units_raw === COLLATERAL_B.toString());
  const borrowRows = rows.filter((r) => r.units_raw === LIABILITY_D.toString());
  assert.equal(supplyRows.length, 2);
  assert.equal(borrowRows.length, 2);
  for (const r of supplyRows) assert.equal(r.side, "supply");
  for (const r of borrowRows) assert.equal(r.side, "borrow");
  const [s1, s2] = supplyRows;
  const [b1, b2] = borrowRows;
  for (const r of rows) {
    assert.equal(r.protocol, "blend");
    assert.equal(r.pool_id, POOL);
    assert.equal(r.asset_address, USDC);
    assert.equal(r.rate_decimals, 12);
    assert.equal(r.asset_decimals, 7);
  }
  assert.equal(s1.units_raw, COLLATERAL_B.toString(), "units survive storage exactly");

  // Units unchanged, so all of the change is interest: units × Δrate.
  const interest = (a, b) =>
    toUnderlying(a.units_raw, BigInt(b.rate_raw) - BigInt(a.rate_raw), a.rate_decimals, a.asset_decimals);
  assert.equal(interest(b1, b2), 4.8, "borrow: 400 dTokens × 0.012 = 4.8 USDC payable");
  assert.ok(Math.abs(interest(s1, s2) - (s2.underlying - s1.underlying)) < 1e-3, "supply interest matches the change in value");
  assert.ok(interest(s1, s2) > 0);
});

test("only accruing, fresh positions are stored", () => {
  const address = wallet().publicKey();
  historyDb.trackWallet(address);
  const base = { protocol: "blend", poolContractId: POOL, asset: "USDC", assetAddress: USDC, decimals: 7 };
  historyDb.recordSnapshot({
    address,
    balances: [],
    defiPositions: [
      { ...base, subtype: "collateral", valueUSD: 10, underlyingAmount: 10, accrual: { units: "1", rate: "1", rateDecimals: 12 } },
      { ...base, subtype: "collateral", valueUSD: 10, stale: true, accrual: { units: "2", rate: "1", rateDecimals: 12 } },
      { protocol: "k2", subtype: "collateral", valueUSD: 5 }, // no accrual data yet
    ],
  });
  const rows = historyDb.getDefiPositionHistory(address, "mainnet", "all");
  assert.deepEqual(rows.map((r) => r.units_raw), ["1"]);
});

test("malformed accrual data is skipped and the snapshot still completes", () => {
  const address = wallet().publicKey();
  historyDb.trackWallet(address);
  historyDb.recordSnapshot({
    address,
    balances: [],
    defiPositions: [
      { protocol: "x", subtype: "collateral", valueUSD: 1, accrual: { units: "1.5", rate: "1", rateDecimals: 12 } },
      { protocol: "x", subtype: "collateral", valueUSD: 1, accrual: { units: "1", rate: "1" } },
    ],
  });
  assert.equal(historyDb.getDefiPositionHistory(address, "mainnet", "all").length, 0);
  const w = historyDb.getTrackedWallets().find((t) => t.address === address);
  assert.ok(w && w.last_snapshot_at, "last_snapshot_at must still be set");
});

test("retention deletes take the position rows with them, with no foreign-key error", () => {
  const address = wallet().publicKey();
  historyDb.trackWallet(address);
  const id = historyDb.recordSnapshot({
    address,
    balances: [{ type: "native", balance: "1", asset: { code: "XLM" } }],
    defiPositions: [
      { protocol: "blend", subtype: "collateral", valueUSD: 1, decimals: 7, accrual: { units: "5", rate: "7", rateDecimals: 12 } },
    ],
  });
  historyDb.db.prepare("UPDATE portfolio_snapshots SET snapshot_at = datetime('now', '-400 days') WHERE id = ?").run(Number(id));
  const count = () =>
    historyDb.db.prepare("SELECT COUNT(*) AS c FROM defi_position_snapshots WHERE snapshot_id = ?").get(Number(id)).c;
  assert.equal(count(), 1);
  assert.doesNotThrow(() => historyDb.cleanupOldSnapshots(address, 365));
  assert.equal(count(), 0, "cascade removed the child rows");
});
