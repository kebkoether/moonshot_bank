// Blend positions in pools outside the five built-in ones are found from the
// wallet's own history.
//
// The adapter's pool-factory discovery called rpc.getEventsForContract, which
// doesn't exist, so only the five built-in pools were ever read: one wallet's
// 900 XLM in "Fixed v2.1" (a Blend pool deployed outside the factory) didn't
// show. lib/adapters/blend-wallet-pools.js reads the contracts the wallet has
// called from Horizon and keeps the ones running Blend's v2 pool code.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Address, StrKey, nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

// Both modules destructure these at require time: mocks first, steered per test.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");
let contractData = async () => null; // contractId -> instance entry
let simulate = async () => { throw new Error("simulate mock not set"); };
rpcLib.getContractData = (c, ...rest) => contractData(c, ...rest);
rpcLib.simulateContractCall = (...a) => simulate(...a);
rpcLib.getTokenMetadata = async () => ({ symbol: "XLM", decimals: 7 });
pricing.priceSorobanToken = async () => ({ usd: 0.17, source: "test" });
const walletPools = require("../lib/adapters/blend-wallet-pools");
const Blend = require("../lib/adapters/blend");

const { BLEND_V2_POOL_WASM } = walletPools;
const id = (n) => StrKey.encodeContract(Buffer.alloc(32, n));
const FACTORY = "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU";
const FIXED = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"; // built in
const PACT = id(1); //    a factory pool that isn't built in
const CUSTOM = id(2); //  Blend's code, not deployed by the factory
const AMM = id(3); //     some other contract
const SAC = id(4); //     a Stellar Asset Contract
const GONE = id(5); //    no instance on the ledger
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

function instance(wasmHex, name) {
  const storage = name ? [{ key: nativeToScVal("Name", { type: "symbol" }), val: nativeToScVal(name, { type: "string" }) }] : [];
  const executable = wasmHex ? { type: "wasm", wasmHash: Buffer.from(wasmHex, "hex") } : { type: "stellarAsset" };
  return { val: { contractData: { val: { instance: { executable, storage } } } } };
}
const LEDGER = {
  [FIXED]: instance(BLEND_V2_POOL_WASM, "Fixed"),
  [PACT]: instance(BLEND_V2_POOL_WASM, "Pact"),
  [CUSTOM]: instance(BLEND_V2_POOL_WASM, "Fixed v2.1"),
  [AMM]: instance("ab".repeat(32), null),
  [SAC]: instance(null, null),
};
const FACTORY_POOLS = new Set([FIXED, PACT]);
function rateLimit() { const e = new Error("Request failed with status code 429"); e.response = { status: 429 }; return e; }

function classifyMocks() {
  contractData = async (c) => LEDGER[c] || null;
  simulate = async (contract, method, args) => {
    if (contract === FACTORY && method === "is_pool") return nativeToScVal(FACTORY_POOLS.has(scValToNative(args[0])));
    throw new Error(`unexpected simulate ${method}`);
  };
}

// ── A fake Horizon ──────────────────────────────────────────────────────────

const invoke = (contract) => ({
  type: "invoke_host_function",
  parameters: [
    { type: "Address", value: new Address(contract).toScVal().toXDR("base64") },
    { type: "Sym", value: nativeToScVal("submit", { type: "symbol" }).toXDR("base64") },
  ],
});
const payment = () => ({ type: "payment" });

let clock;
let horizonCalls;
// ops oldest first; each Horizon request moves the clock on by msPerCall.
function horizon(ops, msPerCall = 0) {
  walletPools._deps.fetch = async (url) => {
    horizonCalls.push(String(url));
    clock += msPerCall;
    const q = new URL(url).searchParams;
    const cursor = q.get("cursor") == null ? null : Number(q.get("cursor"));
    let list = ops.map((op, i) => ({ ...op, paging_token: String(i + 1) }));
    if (q.get("order") === "desc") list = list.reverse().filter((o) => cursor == null || Number(o.paging_token) < cursor);
    else list = list.filter((o) => cursor == null || Number(o.paging_token) > cursor);
    return { ok: true, status: 200, json: async () => ({ _embedded: { records: list.slice(0, Number(q.get("limit"))) } }) };
  };
}

test.beforeEach((t) => {
  walletPools._resetForTests();
  horizonCalls = [];
  clock = Date.UTC(2026, 9, 30, 12);
  t.mock.method(Date, "now", () => clock);
  classifyMocks();
});

const find = (address, ms = 3000) => walletPools.walletBlendPools(address, { deadline: Date.now() + ms, factoryId: FACTORY });

// ── Finding pools ───────────────────────────────────────────────────────────

test("keeps the contracts the wallet called that run Blend's pool code, with their names", async () => {
  horizon([invoke(AMM), payment(), invoke(PACT), invoke(SAC), invoke(GONE), invoke(CUSTOM), invoke(PACT), invoke(FIXED)]);
  const pools = await find(wallet().publicKey());
  assert.deepEqual(pools.map((p) => [p.contractId, p.name, p.factory]).sort(), [
    [FIXED, "Fixed", true],
    [PACT, "Pact", true],
    [CUSTOM, "Fixed v2.1", false],
  ].sort());
});

test("a long history is read newest first, and the next load carries on where this one stopped", async () => {
  const ops = Array.from({ length: 450 }, payment);
  ops[3] = invoke(CUSTOM); // early in the history
  ops[440] = invoke(PACT); // recent
  horizon(ops, 1000);
  const a = wallet().publicKey();

  // 1 s per request, and 2.5 s of budget (1.5 s for Horizon): two pages of 200, newest first.
  assert.deepEqual((await find(a, 2500)).map((p) => p.contractId), [PACT]);
  assert.equal(horizonCalls.length, 2);
  assert.match(horizonCalls[0], /order=desc&limit=200$/);
  assert.match(horizonCalls[1], /order=desc&limit=200&cursor=251$/);

  // The next load reads the last 50 and finds the early pool.
  const pools = await find(a, 2500);
  assert.match(horizonCalls[2], /order=desc&limit=200&cursor=51$/);
  assert.deepEqual(pools.map((p) => p.contractId).sort(), [PACT, CUSTOM].sort());
});

test("once the history is read, a load only asks for newer operations, at most once a minute", async () => {
  const ops = [invoke(FIXED), payment()];
  horizon(ops);
  const a = wallet().publicKey();
  await find(a);
  assert.equal(horizonCalls.length, 1);

  clock += 30_000;
  await find(a);
  assert.equal(horizonCalls.length, 1, "nothing asked within the minute");

  ops.push(invoke(CUSTOM));
  clock += 31_000;
  const pools = await find(a);
  assert.equal(horizonCalls.length, 2);
  assert.match(horizonCalls[1], /order=asc&limit=200&cursor=2$/, "only what's newer than the last read");
  assert.deepEqual(pools.map((p) => p.contractId).sort(), [FIXED, CUSTOM].sort());
});

test("a Horizon failure keeps what was found and never throws", async () => {
  horizon([invoke(PACT)]);
  const a = wallet().publicKey();
  assert.equal((await find(a)).length, 1);
  walletPools._deps.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  clock += 61_000;
  assert.deepEqual((await find(a)).map((p) => p.contractId), [PACT]);
  walletPools._deps.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await find(wallet().publicKey()), [], "a wallet never read: nothing, no throw");
});

test("an account Horizon doesn't know has no pools", async () => {
  walletPools._deps.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.deepEqual(await find(wallet().publicKey()), []);
});

test("a contract that can't be checked now is asked about again, not remembered as 'not a pool'", async () => {
  horizon([invoke(PACT)]);
  const a = wallet().publicKey();
  contractData = async () => { throw rateLimit(); };
  assert.deepEqual(await find(a), []);
  classifyMocks();
  assert.deepEqual((await find(a)).map((p) => p.contractId), [PACT]);
});

// ── In the Blend adapter ────────────────────────────────────────────────────

let poolReads;
function blendPoolMocks({ failCustom = false } = {}) {
  poolReads = [];
  simulate = async (contract, method, args = []) => {
    if (contract === FACTORY && method === "is_pool") return nativeToScVal(FACTORY_POOLS.has(scValToNative(args[0])));
    if (method === "get_reserve_list") {
      poolReads.push(contract);
      if (contract === CUSTOM && failCustom) throw rateLimit();
      return nativeToScVal(contract === CUSTOM ? [XLM_SAC] : []);
    }
    if (method === "get_positions") {
      return nativeToScVal({ collateral: { 0: 900_0000000n }, liabilities: {}, supply: {} });
    }
    if (method === "get_reserve") {
      return nativeToScVal({
        asset: scValToNative(args[0]),
        data: { b_rate: 1_000_000_000_000n, d_rate: 1_000_000_000_000n, b_supply: 10n ** 14n, d_supply: 10n ** 13n, ir_mod: 10_000_000n },
      });
    }
    if (method === "get_config") throw new Error("not needed");
    return nativeToScVal(null); // no emissions
  };
}

test("Blend: a pool from the wallet's history is read, named, and a built-in pool isn't read twice", async () => {
  horizon([invoke(CUSTOM), invoke(FIXED)]);
  blendPoolMocks();
  const positions = await Blend.getPositions(wallet().publicKey());
  assert.deepEqual(positions.map((p) => [p.poolName, p.asset, p.underlyingAmount]), [
    ["Fixed v2.1 (not deployed by Blend's factory)", "XLM", 900],
  ]);
  assert.ok(Math.abs(positions[0].valueUSD - 900 * 0.17) < 1e-9);
  assert.equal(poolReads.filter((c) => c === FIXED).length, 1, "a built-in pool in the history isn't read a second time");
  assert.equal(positions.__blendPoolGroups[0].poolContractId, CUSTOM);
});

test("Blend: a found pool that can't be read fails the adapter, like a built-in pool", async () => {
  horizon([invoke(CUSTOM)]);
  blendPoolMocks({ failCustom: true });
  await assert.rejects(Blend.getPositions(wallet().publicKey()), /Blend: 1\/6 pools failed to resolve/);
});
