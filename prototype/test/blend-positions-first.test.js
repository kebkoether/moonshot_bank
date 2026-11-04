// A Blend pool the wallet holds nothing in costs one call, and the pools found
// in the wallet's history are read without waiting for the built-in ones.
//
// getPositions asked each built-in pool for three things before it knew
// whether the wallet held anything there (reserve list, positions, config),
// one pool after another. For the biggest wallet that was about 3 s of the
// server's 8-second adapter budget warm, and up to 8.9 s on a cold start, when
// Blend ($114M supplied) showed as "unavailable".

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { nativeToScVal, scValToNative, StrKey, xdr } = require("@stellar/stellar-sdk");

const FIXED = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"; // built in, first
const YIELDBLOX = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS"; // built in, second
const ORBIT = "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC";
const FOREX = "CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF";
const ETHERFUSE = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
const FOUND = StrKey.encodeContract(crypto.randomBytes(32)); // from the wallet's history
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

// ── Fakes (the adapter destructures these at require time) ─────────────────

let held; // pool → reserve index → units supplied
let slow; // pool → extra ms on its get_positions
let failing; // `${pool}:${method}` → Error
let discoveryMs;
let calls; // { pool, method, at }
let t0;

const walletPools = require("../lib/adapters/blend-wallet-pools");
walletPools.walletBlendPools = async () => {
  await new Promise((r) => setTimeout(r, discoveryMs));
  return [{ contractId: FOUND, name: "Found Pool", factory: true, pool: true }];
};
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");
rpcLib.getTokenMetadata = async () => ({ symbol: "USDC", decimals: 7 });
pricing.priceSorobanToken = async () => ({ usd: 1, source: "test" });
rpcLib.simulateContractCall = async (pool, method, args = []) => {
  calls.push({ pool, method, at: Date.now() - t0 });
  await new Promise((r) => setTimeout(r, 15 + (method === "get_positions" ? slow[pool] || 0 : 0)));
  const err = failing[`${pool}:${method}`];
  if (err) throw err;
  if (method === "get_positions") {
    const units = held[pool] || {};
    return nativeToScVal({ collateral: {}, liabilities: {}, supply: Object.fromEntries(Object.entries(units).map(([i, u]) => [i, BigInt(u) * 10_000_000n])) });
  }
  if (method === "get_reserve_list") return nativeToScVal([USDC]);
  if (method === "get_config") return nativeToScVal({ bstop_rate: 0n });
  if (method === "get_reserve") {
    return nativeToScVal({
      asset: scValToNative(args[0]),
      data: { b_rate: 10n ** 12n, d_rate: 10n ** 12n, ir_mod: 10_000_000n, b_supply: 10n ** 14n, d_supply: 0n },
    });
  }
  if (method.endsWith("_emissions")) return xdr.ScVal.scvVoid(); // no emissions
  throw new Error(`unexpected ${method}`);
};

const Blend = require("../lib/adapters/blend");

test.beforeEach(() => {
  held = { [FIXED]: { 0: 500 }, [FOUND]: { 0: 7 } };
  slow = {};
  failing = {};
  discoveryMs = 0;
  calls = [];
  t0 = Date.now();
  Blend._clearEmissionsCache();
});

const methodsFor = (pool) => calls.filter((c) => c.pool === pool).map((c) => c.method);

test("a pool the wallet holds nothing in costs one call: its positions", async () => {
  const positions = await Blend.getPositions(wallet().publicKey());
  for (const pool of [YIELDBLOX, ORBIT, FOREX, ETHERFUSE]) assert.deepEqual(methodsFor(pool), ["get_positions"]);
  assert.ok(methodsFor(FIXED).includes("get_reserve"), "the held pool is read in full");
  assert.deepEqual(positions.map((p) => [p.poolName, p.underlyingAmount]), [["Fixed Pool V2", 500], ["Found Pool", 7]]);
});

test("the groups keep the pools' order, the wallet's own pools last, whichever answers first", async () => {
  held[YIELDBLOX] = { 0: 20 };
  slow[FIXED] = 120; // the first pool answers last
  const positions = await Blend.getPositions(wallet().publicKey());
  assert.deepEqual(positions.__blendPoolGroups.map((g) => g.poolName), ["Fixed Pool V2", "YieldBlox Pool V2", "Found Pool"]);
});

test("a pool found in the wallet's history is read as soon as it's found, not after the built-in pools", async () => {
  slow[FIXED] = 200;
  discoveryMs = 10;
  await Blend.getPositions(wallet().publicKey());
  const foundAt = calls.find((c) => c.pool === FOUND).at;
  const fixedDoneAt = calls.filter((c) => c.pool === FIXED && c.method === "get_positions")[0].at + 200;
  assert.ok(foundAt < fixedDoneAt, `found pool asked at ${foundAt} ms, Fixed answered at about ${fixedDoneAt} ms`);
});

test("a pool that can't be read still fails the whole read, never a smaller total", async () => {
  failing[`${ORBIT}:get_positions`] = new Error("Simulation failed: preflight queue full");
  await assert.rejects(Blend.getPositions(wallet().publicKey()), /Blend: 1\/6 pools failed to resolve/);
  failing = { [`${FIXED}:get_reserve`]: new Error("Simulation failed: 503") };
  await assert.rejects(Blend.getPositions(wallet().publicKey()), /Blend: 1\/6 pools failed to resolve/);
});
