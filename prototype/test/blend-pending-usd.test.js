// Pending BLND gets a USD value next to its amount.
//
// The Blend cards said "+551,263.68 BLND pending" with no value, while
// Aquarius rewards carry one. Pending BLND is rewards income, so the books
// need what it's worth: each pool group now has totalPendingBlndUSD, at BLND's
// price now, shown on the page and in the CSV download's notes. Like the
// amount, it is not added to any total.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

// The adapter destructures these at require time, so the mocks go in first.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");

const BLND_SAC = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"; // Fixed Pool V2
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

let price = async () => ({ usd: 0.00714833, source: "test" });
const asked = [];
rpcLib.getTokenMetadata = async () => ({ symbol: "XLM", decimals: 7 });
pricing.priceSorobanToken = async (id, ...rest) => {
  asked.push(id);
  return id === BLND_SAC ? price(id, ...rest) : { usd: 0.17, source: "test" };
};
rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  if (contractId !== POOL) {
    if (method === "get_reserve_list") return nativeToScVal([]);
    throw new Error("unexpected pool");
  }
  if (method === "get_reserve_list") return nativeToScVal([XLM]);
  if (method === "get_positions") return nativeToScVal({ collateral: { 0: 900_0000000n }, liabilities: {}, supply: {} });
  if (method === "get_config") return nativeToScVal({ bstop_rate: 0n });
  if (method === "get_reserve") {
    return nativeToScVal({
      asset: scValToNative(args[0]),
      data: { b_rate: 10n ** 12n, d_rate: 10n ** 12n, ir_mod: 10_000_000n, b_supply: 10n ** 14n, d_supply: 0n },
    });
  }
  return nativeToScVal(null); // no emissions: nothing pending
};

// No Horizon calls: the wallet has used no other Blend pools.
require("../lib/adapters/blend-wallet-pools")._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) });

const Blend = require("../lib/adapters/blend");
const attach = Blend._attachPendingBlndUSD;

test.beforeEach(() => {
  asked.length = 0;
  price = async () => ({ usd: 0.00714833, source: "test" });
});

const soon = () => Date.now() + 5000;

test("pending BLND is valued at BLND's price; nothing owed is $0, an unknown amount stays unknown", async () => {
  const groups = [{ totalPendingBlnd: 551263.6829543 }, { totalPendingBlnd: 0 }, { totalPendingBlnd: null }];
  await attach(groups, soon());
  assert.ok(Math.abs(groups[0].totalPendingBlndUSD - 551263.6829543 * 0.00714833) < 1e-9);
  assert.equal(groups[1].totalPendingBlndUSD, 0);
  assert.equal(groups[2].totalPendingBlndUSD, null);
  assert.deepEqual(asked, [BLND_SAC], "BLND's contract, asked once");
});

test("no BLND price: the value is unknown, not $0", async () => {
  price = async () => null;
  const groups = [{ totalPendingBlnd: 10 }];
  await attach(groups, soon());
  assert.equal(groups[0].totalPendingBlndUSD, null);
  price = async () => { throw new Error("CoinGecko 429"); };
  await attach(groups, soon());
  assert.equal(groups[0].totalPendingBlndUSD, null);
});

test("a slow price doesn't hold up the positions: it gives up within a second, or at the adapter's deadline", async () => {
  price = () => new Promise((r) => setTimeout(() => r({ usd: 1 }), 3000));
  const groups = [{ totalPendingBlnd: 10 }];
  let t0 = Date.now();
  await attach(groups, soon());
  assert.ok(Date.now() - t0 < 1500, `waited ${Date.now() - t0} ms`);
  assert.equal(groups[0].totalPendingBlndUSD, null);
  t0 = Date.now();
  await attach(groups, Date.now() + 100);
  assert.ok(Date.now() - t0 < 600, `waited ${Date.now() - t0} ms past a 100 ms deadline`);
});

test("nothing owed anywhere: no price lookup at all", async () => {
  const groups = [{ totalPendingBlnd: 0 }, { totalPendingBlnd: null }];
  await attach(groups, soon());
  assert.deepEqual(asked, []);
  assert.deepEqual(groups.map((g) => g.totalPendingBlndUSD), [0, null]);
});

test("getPositions puts the value on each pool group, and the positions' values don't change", async () => {
  const positions = await Blend.getPositions(wallet().publicKey());
  const [group] = positions.__blendPoolGroups;
  assert.equal(group.totalPendingBlnd, 0);
  assert.equal(group.totalPendingBlndUSD, 0);
  assert.equal(positions.reduce((s, p) => s + p.valueUSD, 0), 900 * 0.17);
});

test("the page shows the value next to the amount, in the pool's pill and the summary", () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /BLND pending\$\{blndUsd\(group\.totalPendingBlndUSD\)\}/);
  assert.match(html, /\$\{fmtBlnd\(totalPendingBlnd\)\}\$\{blndUsd\(totalPendingBlndUSD\)\}/);
});

test("the CSV download's pending-BLND row carries the estimate in notes, still with no value_usd", () => {
  const H = require("../public/holdings-csv.js");
  const csv = H.build([{
    address: "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6",
    defiByPool: [
      { protocol: "blend", poolName: "Fixed Pool V2", totalPendingBlnd: 551263.68, totalPendingBlndUSD: 3942.9576 },
      { protocol: "blend", poolName: "YieldBlox Pool V2", totalPendingBlnd: 12, totalPendingBlndUSD: null },
    ],
  }], { asOf: "2026-11-03T12:00:00.000Z" });
  const [head, ...rows] = csv.trimEnd().split("\r\n").map((l) => l.split(","));
  const col = (r, name) => r[head.indexOf(name)];
  assert.deepEqual(rows.map((r) => [col(r, "position"), col(r, "amount_1"), col(r, "value_usd"), col(r, "notes")]), [
    ["Fixed Pool V2", "551263.68", "", "about $3942.96 at the current price; not in the total until claimed"],
    ["YieldBlox Pool V2", "12", "", "no price; not in the total until claimed"],
  ]);
});
