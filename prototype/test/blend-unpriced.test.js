// Blend positions in an asset with no price are kept, by token amount.
//
// The Blend adapter used to emit a position only when its USD value was
// non-zero, so a position in an unpriced asset — USTRY, oUSD and the Forex
// coins have no reliable price today — silently disappeared from the API, the
// position count and every snapshot, even though it exists on-chain (a borrow
// especially). K2 already gates on token amounts; Blend now does the same.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { nativeToScVal, scValToNative, StrKey } = require("@stellar/stellar-sdk");

// The adapter destructures these at require time, so the mocks go in first.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");

const POOL = "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC"; // a built-in Blend pool
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const OUSD = StrKey.encodeContract(crypto.randomBytes(32)); // an asset with no price

const RATE = 1_000_000_000_000n; // 1.0 at 10^12
rpcLib.getTokenMetadata = async (c) => ({ symbol: c === USDC ? "USDC" : "oUSD", decimals: 7 });
pricing.priceSorobanToken = async (c) => (c === USDC ? { usd: 1, source: "test" } : null);
rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  if (method === "get_reserve_list") return nativeToScVal(contractId === POOL ? [USDC, OUSD] : []);
  if (method === "get_positions") {
    return nativeToScVal({
      collateral: { 0: 100_0000000n, 1: 250_0000000n }, // 100 USDC, 250 oUSD
      liabilities: { 1: 40_0000000n }, //                     40 oUSD borrowed
      supply: {},
    });
  }
  if (method === "get_reserve") {
    return nativeToScVal({
      asset: scValToNative(args[0]),
      data: { b_rate: RATE, d_rate: RATE, b_supply: 10n ** 14n, d_supply: 10n ** 13n, ir_mod: 10_000_000n },
    });
  }
  if (method === "get_config") throw new Error("not needed");
  return nativeToScVal(null); // no emissions
};

// No Horizon here: the wallet has no history, so only the built-in pools are read.
require("../lib/adapters/blend-wallet-pools")._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) });
const Blend = require("../lib/adapters/blend");

test("a position in an unpriced asset is kept, by amount, marked unpriced", async () => {
  const positions = await Blend.getPositions(wallet().publicKey());
  const by = (asset, subtype) => positions.find((p) => p.asset === asset && p.subtype === subtype);

  const usdc = by("USDC", "collateral");
  assert.equal(usdc.valueUSD, 100);
  assert.equal(usdc.unpriced, false);

  const supplied = by("oUSD", "collateral");
  const borrowed = by("oUSD", "liability");
  assert.ok(supplied && borrowed, "both oUSD positions are there");
  assert.deepEqual([supplied.underlyingAmount, supplied.valueUSD, supplied.unpriced], [250, 0, true]);
  assert.deepEqual([borrowed.underlyingAmount, borrowed.unpriced], [40, true]);
  assert.equal(borrowed.valueUSD, 0);
  assert.equal(positions.length, 3, "no position for a side with no amount (USDC has no borrow)");
});

test("the pool's USD totals are unchanged: an unpriced position adds nothing", async () => {
  const positions = await Blend.getPositions(wallet().publicKey());
  const [group] = positions.__blendPoolGroups;
  assert.equal(group.totalSuppliedUSD, 100);
  assert.equal(group.totalBorrowedUSD, 0);
  assert.equal(positions.reduce((s, p) => s + p.valueUSD, 0), 100);
  const oUSD = group.rows.find((r) => r.asset === "oUSD");
  assert.equal(oUSD.price, null, "the row says it has no price, for the UI's \"No price\"");
});
