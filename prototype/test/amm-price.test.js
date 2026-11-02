// The AMM price layer reads Aquarius and Soroswap pools directly.
//
// It used to ask the Soroswap Aggregator contract for quotes through method
// names the contract doesn't have, so it never priced anything. These tests
// run it against a small fake chain: an Aquarius router and pools, a Soroswap
// factory, pairs and router, all constant-product with a 0.3% fee.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Address, StrKey, nativeToScVal, scValToNative, xdr } = require("@stellar/stellar-sdk");

const rpc = require("../lib/soroban-rpc");
const xlmPrice = require("../lib/xlm-price");
xlmPrice.getXLMPrice = async () => ({ usd: 0.2 });

const amm = require("../lib/soroswap-aggregator");
const { USDC_SAC_CONTRACT: USDC, XLM_SAC_CONTRACT: XLM } = amm;
const AQUARIUS_ROUTER = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";
const SOROSWAP_FACTORY = "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2";
const SOROSWAP_ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";

const randomContract = () => StrKey.encodeContract(crypto.randomBytes(32));
const E7 = 10_000_000n;
const FEE_BPS = 30n;

// ── Fake chain ───────────────────────────────────────────────────────────────

let pools; // pool contract → { dex, tokens: [token, quote], reserves: [raw, raw] }
let calls;
let rpcDown;

/** A pool holding `tokenAmount` of `token` and `quoteAmount` of `quote` (whole units, 7 decimals). */
function addPool(dex, token, quote, tokenAmount, quoteAmount) {
  const id = randomContract();
  pools.set(id, { dex, tokens: [token, quote], reserves: [BigInt(tokenAmount) * E7, BigInt(quoteAmount) * E7] });
  return id;
}
const sorted = (a, b) => [a, b].sort((x, y) =>
  Buffer.compare(new Address(x).toScAddress().toXDR(), new Address(y).toScAddress().toXDR()));
const findPools = (dex, a, b) => [...pools].filter(([, p]) =>
  p.dex === dex && p.tokens.includes(a) && p.tokens.includes(b));

function swapOut(p, iIn, iOut, amountIn) {
  const inAfterFee = amountIn * (10_000n - FEE_BPS);
  return (inAfterFee * p.reserves[iOut]) / (p.reserves[iIn] * 10_000n + inAfterFee);
}
const contractError = (n) => new Error(`Simulation failed: HostError: Error(Contract, #${n})`);
const vec = (list) => xdr.ScVal.scvVec(list);
const addrs = (list) => vec(list.map((c) => new Address(c).toScVal()));

rpc.simulateContractCall = async (contractId, method, args = []) => {
  calls++;
  if (rpcDown) throw new Error("connect ECONNREFUSED");
  const a = args.map((x) => scValToNative(x));
  if (contractId === AQUARIUS_ROUTER && method === "get_pools") {
    const [t0, t1] = a[0];
    assert.deepEqual([t0, t1], sorted(t0, t1), "Aquarius wants the pair sorted");
    return xdr.ScVal.scvMap(findPools("aquarius", t0, t1).map(([id]) => new xdr.ScMapEntry({
      key: xdr.ScVal.scvBytes(crypto.randomBytes(32)), val: new Address(id).toScVal(),
    })));
  }
  if (contractId === SOROSWAP_FACTORY && method === "get_pair") {
    const found = findPools("soroswap", a[0], a[1]);
    if (!found.length) throw contractError(205);
    return new Address(found[0][0]).toScVal();
  }
  if (contractId === SOROSWAP_ROUTER && method === "router_get_amounts_out") {
    let amount = BigInt(a[0]);
    const path = a[1];
    const out = [amount];
    for (let i = 0; i + 1 < path.length; i++) {
      const [[, p]] = findPools("soroswap", path[i], path[i + 1]);
      amount = swapOut(p, p.tokens.indexOf(path[i]), p.tokens.indexOf(path[i + 1]), amount);
      out.push(amount);
    }
    return vec(out.map((n) => nativeToScVal(n, { type: "i128" })));
  }
  const p = pools.get(contractId);
  if (p) {
    if (method === "get_tokens") return addrs(p.tokens);
    if (method === "token_0") return new Address(p.tokens[0]).toScVal();
    if (method === "get_reserves") return vec(p.reserves.map((n) => nativeToScVal(n, { type: "u128" })));
    if (method === "estimate_swap") return nativeToScVal(swapOut(p, a[0], a[1], BigInt(a[2])), { type: "u128" });
  }
  throw contractError(1); // e.g. name() on a token that isn't a SAC
};

test.beforeEach(() => {
  pools = new Map();
  calls = 0;
  rpcDown = false;
  amm._resetForTests();
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("a token is priced from its deepest pool, without the pool's fee", async () => {
  const TOK = randomContract();
  addPool("aquarius", TOK, USDC, 1_000_000, 1_073_000);
  addPool("soroswap", TOK, USDC, 100_000, 106_000); // also deep enough, but less deep
  const p = await amm.priceSorobanTokenInUSD(TOK, 7);
  assert.equal(p.source, "aquarius");
  assert.ok(Math.abs(p.usd - 1.073) < 1e-4, `got ${p.usd}`);
  assert.ok(Math.abs(p.depthUSD - 1_073_000) < 1);
});

test("a thin pool's price is never used", async () => {
  // Like EURx on Soroswap in October 2026: $0.0001 with a few dollars of USDC.
  const TOK = randomContract();
  addPool("soroswap", TOK, USDC, 50_000, 5);
  assert.equal(await amm.priceSorobanTokenInUSD(TOK, 7), null, "only a thin pool: no price");

  addPool("soroswap", TOK, XLM, 20_000, 200_000); // $40k of XLM at $0.20
  amm._resetForTests(); // pool lists are cached for an hour (next test)
  const p = await amm.priceSorobanTokenInUSD(TOK, 7);
  assert.equal(p.source, "soroswap");
  assert.ok(Math.abs(p.usd - 2) < 1e-3, `10 XLM at $0.20, got ${p.usd}`);
});

test("pools are looked up once an hour, and a token without any then costs nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const TOK = randomContract();
  assert.equal(await amm.priceSorobanTokenInUSD(TOK, 7), null);
  assert.ok(calls > 0);
  calls = 0;
  assert.equal(await amm.priceSorobanTokenInUSD(TOK, 7), null);
  assert.equal(calls, 0, "no pools, remembered");

  addPool("aquarius", TOK, USDC, 500_000, 500_000);
  t.mock.timers.setTime(1_800_000_000_000 + 61 * 60_000);
  assert.ok(Math.abs((await amm.priceSorobanTokenInUSD(TOK, 7)).usd - 1) < 1e-4, "found after an hour");
});

test("an RPC failure isn't remembered as no pools", async () => {
  const TOK = randomContract();
  addPool("aquarius", TOK, USDC, 300_000, 600_000);
  rpcDown = true;
  assert.equal(await amm.priceSorobanTokenInUSD(TOK, 7), null);
  rpcDown = false;
  const p = await amm.priceSorobanTokenInUSD(TOK, 7);
  assert.ok(Math.abs(p.usd - 2) < 1e-4, `got ${p.usd}`);
});

test("token decimals are respected", async () => {
  const TOK = randomContract(); // 6 decimals: 1 token = 1e6 raw
  const id = addPool("aquarius", TOK, USDC, 0, 100_000); // $100k of USDC
  pools.get(id).reserves[0] = 400_000n * 1_000_000n; // 400k tokens
  assert.ok(Math.abs((await amm.priceSorobanTokenInUSD(TOK, 6)).usd - 0.25) < 1e-4);
});

test("the pricing engine uses it when nothing else prices a token", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const pricing = require("../lib/pricing-engine");
    const TOK = randomContract();
    addPool("aquarius", TOK, USDC, 250_000, 250_000);
    const p = await pricing.priceSorobanToken(TOK, { decimals: 7 });
    assert.equal(p.source, "aquarius");
    assert.ok(Math.abs(p.usd - 1) < 1e-4);
  } finally {
    global.fetch = realFetch;
    clearInterval(keepAlive);
  }
});
