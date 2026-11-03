// A busy RPC ("preflight queue full") is asked again.
//
// The RPC runs simulations on a few workers with a short queue in front. When
// more are waiting, it answers "preflight queue full", as a simulation error.
// That read as the contract's own answer, so it wasn't retried: loading six
// wallets together put up to 120 simulations in flight, and Blend, K2 and
// Upshift dropped out of the portfolio as "unavailable". Upshift valued its
// shares 1:1 instead (a separate test in upshift.test.js).

process.env.RPC_RETRY_BASE_MS = "20";
process.env.RPC_RETRY_ATTEMPTS = "4";

const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

const rpcLib = require("../lib/soroban-rpc");

const BLND = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";
const BUSY = { error: "preflight queue full", latestLedger: 1 };
const ok = (v) => ({ result: { retval: nativeToScVal(v, { type: "u32" }) }, latestLedger: 1 });

const original = rpcLib.server.simulateTransaction;
test.afterEach(() => { rpcLib.server.simulateTransaction = original; });

test("a 'preflight queue full' answer is asked again, and the real answer comes back", async () => {
  let calls = 0;
  rpcLib.server.simulateTransaction = async () => (++calls < 3 ? BUSY : ok(7));
  const out = await rpcLib.simulateContractCall(BLND, "decimals");
  assert.equal(scValToNative(out), 7);
  assert.equal(calls, 3);
});

test("still busy after every attempt: it throws, and callers see a busy RPC, not the contract's answer", async () => {
  let calls = 0;
  rpcLib.server.simulateTransaction = async () => { calls++; return BUSY; };
  const err = await rpcLib.simulateContractCall(BLND, "decimals").catch((e) => e);
  assert.match(err.message, /preflight queue full/);
  assert.equal(calls, 4, "RPC_RETRY_ATTEMPTS");
  assert.equal(rpcLib.isTransientRpcError(err), true);
});

test("a contract's own error is an answer: not asked again, and not read as busy", async () => {
  let calls = 0;
  rpcLib.server.simulateTransaction = async () => { calls++; return { error: "HostError: Error(Contract, #6)", latestLedger: 1 }; };
  const err = await rpcLib.simulateContractCall(BLND, "decimals").catch((e) => e);
  assert.match(err.message, /Error\(Contract, #6\)/);
  assert.equal(calls, 1);
  assert.equal(rpcLib.isTransientRpcError(err), false);
});
