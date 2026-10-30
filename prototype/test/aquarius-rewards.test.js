// Aquarius LP positions show the rewards waiting to be claimed.
//
// An Aquarius pool owes its LPs AQUA, and some pools have gauges that pay an
// extra token. Neither was shown anywhere: one wallet had 6.6M AQUA waiting in
// its PYUSD/USDC pool. Now each Aquarius position carries unclaimedRewards
// (lib/aquarius-rewards.js), read from the pool and valued, but not added to
// the position's value until claimed.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("@stellar/stellar-sdk");

// aquarius-rewards and lp-discovery destructure simulateContractCall at
// require time: install an indirection first, then steer it per test.
const rpcLib = require("../lib/soroban-rpc");
let simulate = async () => { throw new Error("simulate mock not set"); };
rpcLib.simulateContractCall = (...a) => simulate(...a);
const rewards = require("../lib/aquarius-rewards");
const LPDiscovery = require("../lib/adapters/lp-discovery");
const pricingEngine = require("../lib/pricing-engine");

const { AQUA_SAC, XLM_SAC } = rewards;
const PYUSD_SAC = "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2";
const SOLVBTC = S.StrKey.encodeContract(Buffer.alloc(32, 7)); // an 8-decimal token
const POOL_A = "CDMH535JSD224YXPET3B4SJOLXTQQ24GRSCWACGYBKSH2DKFJYWI7SUW"; // PYUSD/USDC
const POOL_B = "CAFHLHGZXOVNCGFJ7DOXL7JDNMBCEZKDI3LS5NRQH3GXC7CSIMQZHUSM"; // USDY/USDC
const XLM = { xlmPrice: { usd: 0.1669 } };
const user = () => S.Keypair.random().publicKey();

const u128 = (v) => S.nativeToScVal(BigInt(v), { type: "u128" });
// gauges_get_reward_info: Map<token address, { expired_at, tps, user_reward }>
function gaugeInfo(entries) {
  return S.xdr.ScVal.scvMap(Object.entries(entries).map(([token, reward]) => new S.xdr.ScMapEntry({
    key: new S.Address(token).toScVal(),
    val: S.nativeToScVal({ expired_at: 0n, tps: 0n, user_reward: BigInt(reward) },
      { type: { expired_at: ["symbol", "u64"], tps: ["symbol", "u128"], user_reward: ["symbol", "u128"] } }),
  })));
}
const missing = () => new Error("Simulation failed: HostError: Error(WasmVm, MissingValue)");
function rateLimit() { const e = new Error("Request failed with status code 429"); e.response = { status: 429 }; return e; }

// One pool's answers: { aqua: raw | Error, gauges: {token: raw} | Error }
function pools(byPool, tokens = {}) {
  return async (contract, method) => {
    const p = byPool[contract];
    if (p) {
      const v = method === "get_user_reward" ? p.aqua : method === "gauges_get_reward_info" ? p.gauges : undefined;
      if (v instanceof Error) throw v;
      if (method === "get_user_reward") return u128(v ?? 0);
      if (method === "gauges_get_reward_info") return gaugeInfo(v || {});
    }
    const t = tokens[contract];
    if (t && method === "symbol") return S.nativeToScVal(t.symbol, { type: "string" });
    if (t && method === "decimals") { if (t.decimals instanceof Error) throw t.decimals; return S.nativeToScVal(t.decimals, { type: "u32" }); }
    throw new Error(`unexpected simulate ${contract.slice(0, 6)} ${method}`);
  };
}

test.beforeEach((t) => {
  rewards._resetForTests();
  const prices = { [AQUA_SAC]: 0.00028102, [PYUSD_SAC]: 1 };
  t.mock.method(pricingEngine, "priceSorobanToken", async (id) => (prices[id] ? { usd: prices[id] } : null));
});

// ── One pool ────────────────────────────────────────────────────────────────

test("the AQUA a pool owes is read and valued", async () => {
  simulate = pools({ [POOL_A]: { aqua: 66330872810957n, gauges: {} } });
  const r = await rewards.readPoolRewards(POOL_A, user(), XLM);
  assert.equal(r.length, 1);
  assert.deepEqual({ ...r[0], valueUSD: undefined }, { asset: "AQUA", contractId: AQUA_SAC, amount: 6633087.2810957, valueUSD: undefined, source: "aqua" });
  assert.ok(Math.abs(r[0].valueUSD - 6633087.2810957 * 0.00028102) < 1e-6);
});

test("gauge rewards: each paying token at its own decimals and price; zero ones are left out", async () => {
  simulate = pools(
    { [POOL_A]: { aqua: 0, gauges: { [XLM_SAC]: 2180555539275n, [PYUSD_SAC]: 0, [SOLVBTC]: 123456789n } } },
    { [SOLVBTC]: { symbol: "SolvBTC", decimals: 8 } },
  );
  const r = await rewards.readPoolRewards(POOL_A, user(), XLM);
  assert.deepEqual(r.map((x) => [x.asset, x.amount, x.source]).sort(), [
    ["SolvBTC", 1.23456789, "gauge"],
    ["XLM", 218055.5539275, "gauge"],
  ]);
  const xlm = r.find((x) => x.asset === "XLM");
  assert.ok(Math.abs(xlm.valueUSD - 218055.5539275 * 0.1669) < 1e-6, "XLM at the request's XLM price");
  assert.equal(r.find((x) => x.asset === "SolvBTC").valueUSD, null, "no price: amount only");
});

test("nothing owed: an empty list", async () => {
  simulate = pools({ [POOL_A]: { aqua: 0, gauges: { [PYUSD_SAC]: 0 } } });
  assert.deepEqual(await rewards.readPoolRewards(POOL_A, user(), XLM), []);
});

test("a pool without gauges (no such function) still reports its AQUA", async () => {
  simulate = pools({ [POOL_A]: { aqua: 50000000n, gauges: missing() } });
  const r = await rewards.readPoolRewards(POOL_A, user(), XLM);
  assert.deepEqual(r.map((x) => [x.asset, x.amount]), [["AQUA", 5]]);
});

test("a reward token whose decimals can't be read fails the pool rather than guess them", async () => {
  simulate = pools({ [POOL_A]: { aqua: 0, gauges: { [SOLVBTC]: 123456789n } } }, { [SOLVBTC]: { symbol: "SolvBTC", decimals: rateLimit() } });
  await assert.rejects(rewards.readPoolRewards(POOL_A, user(), XLM), /429/);
});

// ── On the positions ────────────────────────────────────────────────────────

test("a pool that can't be read gets null; the other pools and the positions are unaffected", async () => {
  simulate = pools({ [POOL_A]: { aqua: rateLimit(), gauges: {} }, [POOL_B]: { aqua: 17660795042300n, gauges: {} } });
  const positions = [
    { protocol: "aquarius", poolContractId: POOL_A, valueUSD: 8001394 },
    { protocol: "aquarius", poolContractId: POOL_B, valueUSD: 1907206 },
    { protocol: "soroswap", poolContractId: "CSORO", valueUSD: 5 },
  ];
  const out = await rewards.attachAquariusRewards(positions, user(), XLM);
  assert.equal(out.length, 3);
  assert.equal(out[0].unclaimedRewards, null);
  assert.deepEqual(out[1].unclaimedRewards.map((x) => [x.asset, x.amount]), [["AQUA", 1766079.50423]]);
  assert.equal("unclaimedRewards" in out[2], false, "not an Aquarius position");
});

function aquariusApi(rows) {
  return async (url) => {
    assert.match(String(url), /amm-api\.aqua\.network/);
    return { ok: true, status: 200, json: async () => ({ count: rows.length, results: rows }) };
  };
}
const ROW_A = {
  address: POOL_A,
  tokens_addresses: [PYUSD_SAC, "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"],
  tokens_str: ["PYUSD:GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
  pool_type: "stable",
  deposited_tokens: {
    "PYUSD:GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5": "4446868.59",
    "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": "3554526.53",
  },
};

test("LP discovery: an Aquarius position carries its unclaimed rewards, and its value doesn't include them", async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = aquariusApi([ROW_A]);
  const byPool = pools({ [POOL_A]: { aqua: 66330872810957n, gauges: { [PYUSD_SAC]: 0 } } });
  simulate = async (contract, method, args) => {
    if (method === "all_pairs_length") return S.nativeToScVal(0, { type: "u32" }); // no Soroswap pairs
    return byPool(contract, method, args);
  };
  const [pos] = await LPDiscovery.getPositions(user(), XLM);
  assert.equal(pos.protocol, "aquarius");
  assert.deepEqual(pos.unclaimedRewards.map((x) => [x.asset, x.amount]), [["AQUA", 6633087.2810957]]);
  assert.equal(pos.valueUSD, 4446868.59 + 3554526.53, "value is the deposit only");
});

test("LP discovery: a rewards read that fails doesn't fail the positions", async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = aquariusApi([ROW_A]);
  simulate = async (contract, method) => {
    if (method === "all_pairs_length") return S.nativeToScVal(0, { type: "u32" });
    throw rateLimit();
  };
  const [pos] = await LPDiscovery.getPositions(user(), XLM);
  assert.equal(pos.protocol, "aquarius");
  assert.equal(pos.unclaimedRewards, null);
  assert.equal(pos.valueUSD, 4446868.59 + 3554526.53);
});
