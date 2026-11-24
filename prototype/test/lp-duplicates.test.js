// A liquidity pool two adapters report is counted once.
//
// LP Positions reads any AMM pool a wallet invoked in its last 200
// operations, and LP Discovery reads Aquarius (its API) and Soroswap (its
// factory). Both reported a pool the wallet had deposited into directly, and
// both were added up: on 2026-11-24 a wallet's $2.9M Aquarius USDT0/USDC
// position was listed twice and counted twice in its total ($6.76M instead
// of $3.86M).

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Keypair, StrKey } = require("@stellar/stellar-sdk");

const server = require("../server.js");
const { app, __setTestDeps, PROTOCOL_ADAPTERS } = server;
const { dropFallbackLpDuplicates, lpPoolKey } = require("../lib/lp-duplicates");
const LPPositionsAdapter = require("../lib/adapters/lp-positions");

const contract = () => StrKey.encodeContract(crypto.randomBytes(32));
const AQUA_POOL = contract(); // both adapters find it
const SOROSWAP_PAIR = contract(); // only LP Positions finds it
const SUSHI_POOL = contract(); // two SushiSwap V3 positions, LP Positions only
const BLEND_POOL = contract();

// ── Fakes: no Horizon, no prices; the adapters are ours ─────────────────────

const XLM = 1000;
__setTestDeps({
  getHorizon: () => ({
    loadAccount: async () => ({
      balances: [{ asset_type: "native", balance: String(XLM) }],
      subentry_count: 0, num_sponsoring: 0, num_sponsored: 0,
    }),
  }),
  getXLMPrice: async () => ({ usd: 1, change24h: 0, source: "test" }),
  resolveSorobanTokens: async () => [],
  discoverSorobanTokens: async () => [],
  primeKnownPrices: async () => {},
});

// The shapes the two real adapters return for the same Aquarius pool.
const fromDiscovery = { protocol: "aquarius", type: "lp", subtype: "stable", poolContractId: AQUA_POOL, valueUSD: 2_897_684 };
const fromFallback = { protocol: "aquarius", type: "lp", contractId: AQUA_POOL, poolName: "Aquarius USDT0/USDC", valueUSD: 2_897_684 };
const pair = { protocol: "soroswap", type: "lp", contractId: SOROSWAP_PAIR, valueUSD: 100 };
const sushi = (valueUSD) => ({ protocol: "sushiswap", type: "lp", contractId: SUSHI_POOL, valueUSD });

let discoveryState; // "ok" | "fail"
const blend = { name: "Blend", protocolId: "blend", isConfigured: () => true,
  getPositions: async () => [
    { protocol: "blend", type: "lending", poolContractId: BLEND_POOL, valueUSD: 50 },
    { protocol: "blend", type: "borrowing", poolContractId: BLEND_POOL, valueUSD: -20 },
  ] };
const discovery = { name: "LP Discovery", protocolId: "lp-discovery", isConfigured: () => true,
  getPositions: async () => {
    if (discoveryState === "fail") throw new Error("LP Discovery timed out after 8000ms");
    return [fromDiscovery];
  } };
const fallback = { name: "LP Positions", protocolId: "lp-positions", lpFallback: true, isConfigured: () => true,
  getPositions: async () => [fromFallback, pair, sushi(10), sushi(20)] };

const realAdapters = PROTOCOL_ADAPTERS.slice();
test.before(() => PROTOCOL_ADAPTERS.splice(0, PROTOCOL_ADAPTERS.length, blend, discovery, fallback));
test.after(() => PROTOCOL_ADAPTERS.splice(0, PROTOCOL_ADAPTERS.length, ...realAdapters));
test.beforeEach(() => { discoveryState = "ok"; });

const ONCE = XLM + 50 - 20 + 2_897_684 + 100 + 10 + 20;

async function portfolio(address) {
  const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [address] } });
  assert.equal(res.status, 200, res.raw);
  return res.body.wallets[0];
}

// ── The registry ────────────────────────────────────────────────────────────

test("LP Positions is the one fallback adapter", () => {
  assert.equal(LPPositionsAdapter.lpFallback, true);
  assert.deepEqual(realAdapters.filter((a) => a.lpFallback), [LPPositionsAdapter]);
});

// ── The wallet page and All Wallets (collectDefiPositions) ──────────────────

test("a pool LP Discovery and LP Positions both report is listed and counted once", async () => {
  const w = await portfolio(Keypair.random().publicKey());
  assert.equal(w.totalValueUSD, ONCE);
  const inPool = w.defiPositions.filter((p) => lpPoolKey(p) === AQUA_POOL);
  assert.equal(inPool.length, 1);
  assert.equal(inPool[0].subtype, "stable", "LP Discovery's, with its pool type and rewards");
  // Everything else LP Positions found stays: a pool only it found, and two
  // SushiSwap positions in one pool. Blend's two positions in its pool too.
  assert.equal(w.defiPositions.length, 6);
  assert.equal(w.defiPositions.filter((p) => lpPoolKey(p) === SUSHI_POOL).length, 2);
  assert.ok(w.defiPositions.some((p) => lpPoolKey(p) === SOROSWAP_PAIR));
});

test("with LP Discovery's last good answer served stale, the pool still counts once", async () => {
  const a = Keypair.random().publicKey();
  await portfolio(a); // caches LP Discovery's answer
  discoveryState = "fail";
  const w = await portfolio(a);
  assert.equal(w.totalValueUSD, ONCE);
  const inPool = w.defiPositions.filter((p) => lpPoolKey(p) === AQUA_POOL);
  assert.equal(inPool.length, 1);
  assert.equal(inPool[0].stale, true);
});

test("with LP Discovery down and nothing cached, LP Positions' copy is kept", async () => {
  discoveryState = "fail";
  const w = await portfolio(Keypair.random().publicKey());
  assert.deepEqual(w.defiDegraded, ["LP Discovery"]);
  const inPool = w.defiPositions.filter((p) => lpPoolKey(p) === AQUA_POOL);
  assert.equal(inPool.length, 1);
  assert.equal(inPool[0].poolName, "Aquarius USDT0/USDC");
  assert.equal(w.totalValueUSD, ONCE);
});

// ── Snapshots and the public API (fetchPortfolioForScheduler) ───────────────

test("the scheduler's portfolio counts the pool once too", async () => {
  const p = await server.fetchPortfolioForScheduler(Keypair.random().publicKey());
  assert.equal(p.totalValueUSD, ONCE);
  assert.equal(p.defiPositions.filter((x) => lpPoolKey(x) === AQUA_POOL).length, 1);
  assert.equal(p.defiPositions.length, 6);
});

// ── The rule itself ─────────────────────────────────────────────────────────

test("only a fallback adapter's LP positions are dropped, and only for a pool another adapter reports", () => {
  const other = { name: "Other" };
  const fb = { name: "Fallback", lpFallback: true };
  const lend = { type: "lending", poolContractId: AQUA_POOL, valueUSD: 1 }; // not an LP position
  const out = dropFallbackLpDuplicates([
    { adapter: fb, positions: [fromFallback, pair, lend], stale: false },
    { adapter: other, positions: [fromDiscovery, { ...fromDiscovery, subtype: "staked" }] },
  ]);
  assert.deepEqual(out[0].positions, [pair, lend]);
  assert.equal(out[0].stale, false, "the entry's other fields are kept");
  assert.equal(out[1].positions.length, 2, "a non-fallback adapter never loses a position");
  assert.equal(lpPoolKey({ type: "lp" }), null);
  assert.equal(lpPoolKey(null), null);
});
