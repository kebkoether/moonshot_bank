// The Blend history search answers by its deadline, whatever Horizon or the
// RPC does, so it can't hold Blend's whole read past its 8-second limit.
//
// With six wallets loading together, Blend sometimes timed out because the
// search never returned: a page's body read (res.json()) was still pending
// long after its request's abort signal had fired. Node's fetch can leave a
// gzip body (Horizon's are) in that state when the signal fires while the
// body is still arriving. Real timers here, not a mocked clock.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Address, StrKey, nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

// No real network, here or in the price and token lists the adapter loads.
global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });

// Both modules destructure these at require time: mocks first.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");
let contractData = async () => null;
let contractDataCalls = 0;
rpcLib.getContractData = (...a) => { contractDataCalls++; return contractData(...a); };
rpcLib.simulateContractCall = async (contract, method, args = []) => {
  if (method === "is_pool") return nativeToScVal(true);
  if (method === "get_positions") return nativeToScVal({ collateral: {}, liabilities: {}, supply: {} });
  if (method === "get_reserve_list") return nativeToScVal([]);
  if (method === "get_config") return nativeToScVal(null);
  throw new Error(`unexpected simulate ${method}`);
};
rpcLib.getTokenMetadata = async () => ({ symbol: "XLM", decimals: 7 });
pricing.priceSorobanToken = async () => ({ usd: 0.17, source: "test" });
const walletPools = require("../lib/adapters/blend-wallet-pools");
const Blend = require("../lib/adapters/blend");

const FACTORY = "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU";
const PACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const POOL_INSTANCE = { val: { contractData: { val: { instance: {
  executable: { type: "wasm", wasmHash: Buffer.from(walletPools.BLEND_V2_POOL_WASM, "hex") },
  storage: [{ key: nativeToScVal("Name", { type: "symbol" }), val: nativeToScVal("Pact", { type: "string" }) }],
} } } } };
const invokePact = {
  type: "invoke_host_function",
  paging_token: "1",
  parameters: [{ type: "Address", value: new Address(PACT).toScVal().toXDR("base64") }],
};

let horizonCalls;
const page = (records) => ({ ok: true, status: 200, json: async () => ({ _embedded: { records } }) });
const never = () => new Promise(() => {});

/** The search's result, or "STILL WAITING" if it hasn't answered `graceMs` after its deadline. */
async function findBy(address, budgetMs, graceMs = 250) {
  const started = Date.now();
  const result = await Promise.race([
    walletPools.walletBlendPools(address, { deadline: started + budgetMs, factoryId: FACTORY }),
    new Promise((r) => setTimeout(() => r("STILL WAITING"), budgetMs + graceMs)),
  ]);
  return { result, ms: Date.now() - started };
}

test.beforeEach(() => {
  walletPools._resetForTests();
  horizonCalls = [];
  contractDataCalls = 0;
  contractData = async () => POOL_INSTANCE;
});

test("a history page whose body never arrives doesn't hold up the search", async () => {
  walletPools._deps.fetch = async (url) => { horizonCalls.push(String(url)); return { ok: true, status: 200, json: never }; };
  const a = wallet().publicKey();
  const { result, ms } = await findBy(a, 1300); // 300 ms for Horizon, 1 s kept for checking contracts
  assert.deepEqual(result, []);
  assert.ok(ms < 1300, `answered after ${ms} ms`);

  // The page wasn't read, so the next load asks for it again.
  walletPools._deps.fetch = async (url) => { horizonCalls.push(String(url)); return page([invokePact]); };
  const next = await findBy(a, 1300);
  assert.deepEqual(next.result.map((p) => p.contractId), [PACT]);
  assert.equal(horizonCalls[0], horizonCalls[1], "same first page");
});

test("a history request that never answers doesn't hold it up either", async () => {
  walletPools._deps.fetch = () => never(); // not even the abort signal
  const { result, ms } = await findBy(wallet().publicKey(), 1300);
  assert.deepEqual(result, []);
  assert.ok(ms < 1300, `answered after ${ms} ms`);
});

test("a contract check still running at the deadline isn't waited for, and its answer is used next time", async () => {
  walletPools._deps.fetch = async () => page([invokePact]);
  contractData = () => new Promise((r) => setTimeout(() => r(POOL_INSTANCE), 1800));
  const a = wallet().publicKey();
  const first = await findBy(a, 1300);
  assert.deepEqual(first.result, []);
  assert.ok(first.ms < 1400, `answered after ${first.ms} ms`);

  await new Promise((r) => setTimeout(r, 700)); // the check finishes meanwhile
  const next = await findBy(a, 1300);
  assert.deepEqual(next.result.map((p) => p.contractId), [PACT]);
  assert.equal(contractDataCalls, 1, "the late answer was kept, not asked again");
});

test("Blend answers well within its 8 s limit when a history body never arrives", async () => {
  walletPools._deps.fetch = async () => ({ ok: true, status: 200, json: never });
  const started = Date.now();
  const positions = await Promise.race([
    Blend.getPositions(wallet().publicKey()),
    new Promise((r) => setTimeout(() => r("STILL WAITING"), 8000)),
  ]);
  assert.ok(Array.isArray(positions) && positions.length === 0, `got ${JSON.stringify(positions)}`);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
});
