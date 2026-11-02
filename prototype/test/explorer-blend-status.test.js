// The DeFi tab showed Blend at $0 with no pools: it listed only fully Active
// pools, and every built-in Blend pool is now On Ice or Frozen.
//
// On Ice pools still take deposits (only new borrowing is paused), and every
// pool's deposits are real money. Now all pools count in Blend's total, On Ice
// pools are listed with a note saying what's paused, and Frozen pools (no
// deposits) are on Blend's own page but kept out of the summary and its
// "Top APY".

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

// The adapter destructures these at require time, so the mocks go in first.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");

const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
// The five built-in pools, with the statuses they had on 2026-11-02 except
// Etherfuse, made Active here so every kind is covered. Supplied USDC each.
const POOLS = {
  CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD: { name: "Fixed Pool V2", status: 3, usdc: 100_000_000 },
  CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS: { name: "YieldBlox Pool V2", status: 3, usdc: 5_000_000 },
  CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC: { name: "Orbit Pool V2", status: 4, usdc: 2_000_000 },
  CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF: { name: "Forex Pool V2", status: 5, usdc: 1_000_000 },
  CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI: { name: "Etherfuse Pool V2", status: 1, usdc: 3_000_000 },
};
let statusOf = (c) => POOLS[c].status;

rpcLib.getTokenMetadata = async () => ({ symbol: "USDC", decimals: 7 });
pricing.priceSorobanToken = async () => ({ usd: 1, source: "test" });
rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  const pool = POOLS[contractId];
  if (!pool) throw new Error(`unexpected contract ${contractId}`);
  if (method === "get_reserve_list") return nativeToScVal([USDC]);
  if (method === "get_config") return nativeToScVal({ status: statusOf(contractId), bstop_rate: 2_000_000, max_positions: 6 });
  if (method === "get_reserve") {
    return nativeToScVal({
      asset: scValToNative(args[0]),
      data: { b_rate: 1_000_000_000_000n, d_rate: 1_000_000_000_000n, b_supply: BigInt(pool.usdc) * 10_000_000n, d_supply: 0n, ir_mod: 10_000_000n },
    });
  }
  throw new Error(`unexpected method ${method}`);
};

const Blend = require("../lib/adapters/blend");
const explorer = require("../lib/defi-explorer");
const { _fetchBlend: fetchBlend, _cache: cache } = explorer.getSnapshot;

test.afterEach(() => { statusOf = (c) => POOLS[c].status; cache.clear(); });

const ALL = Object.values(POOLS).reduce((s, p) => s + p.usdc, 0);

test("the pool overview returns every pool, with its status", async () => {
  const overview = await Blend.getPoolsOverview();
  assert.deepEqual(overview.map((p) => [p.name, p.status, p.statusLabel]).sort(), [
    ["Etherfuse Pool V2", 1, "Active"],
    ["Fixed Pool V2", 3, "On Ice"],
    ["Forex Pool V2", 5, "Frozen"],
    ["Orbit Pool V2", 4, "Frozen"],
    ["YieldBlox Pool V2", 3, "On Ice"],
  ]);
});

test("Blend's card: every pool counts in the total, each with a note on what its status allows", async () => {
  const card = await fetchBlend();
  assert.equal(card.totalTvlUSD, ALL);
  const by = Object.fromEntries(card.pools.map((p) => [p.name, p]));
  assert.match(by["Fixed Pool V2"].note, /^On Ice: you can still supply USDC and earn interest; new borrowing is paused\.$/);
  assert.match(by["Orbit Pool V2"].note, /^Frozen: no new deposits or borrowing\. Existing positions can still be repaid and withdrawn\.$/);
  assert.match(by["Etherfuse Pool V2"].note, /^Lending market with USDC/);
  assert.deepEqual(card.pools.filter((p) => p.closed).map((p) => p.name).sort(), ["Forex Pool V2", "Orbit Pool V2"]);
});

test("the summary lists pools that take deposits; Blend's own page lists them all", async () => {
  cache.set("blend", { ts: Date.now(), value: await fetchBlend(), error: null, lastAttempt: Date.now() });
  const summary = explorer.getSnapshot().protocols.find((p) => p.id === "blend");
  assert.deepEqual(summary.pools.map((p) => p.name), ["Fixed Pool V2", "YieldBlox Pool V2", "Etherfuse Pool V2"]);
  assert.equal(summary.totalTvlUSD, ALL, "the total still counts the frozen pools' deposits");
  const detail = explorer.getProtocolDetail("blend");
  assert.equal(detail.pools.length, 5);
});

test("with every pool On Ice or Frozen, as on 2026-11-02, Blend is no longer $0 with no pools", async () => {
  statusOf = (c) => (POOLS[c].status === 1 ? 4 : POOLS[c].status); // Etherfuse back to Frozen
  cache.set("blend", { ts: Date.now(), value: await fetchBlend(), error: null, lastAttempt: Date.now() });
  const summary = explorer.getSnapshot().protocols.find((p) => p.id === "blend");
  assert.equal(summary.totalTvlUSD, ALL);
  assert.deepEqual(summary.pools.map((p) => p.name), ["Fixed Pool V2", "YieldBlox Pool V2"]);
});
