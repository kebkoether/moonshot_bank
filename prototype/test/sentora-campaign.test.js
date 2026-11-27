// The DeFi tab's Sentora card stops quoting a campaign's reward once it ends.
//
// Sentora's three deposit vaults pay a published reward rate for a fixed-term
// campaign. On 2026-11-24 the Stellar DeFi Hub marked all three "Campaign
// Complete · Rewards Claimable" (XLM ended 2026-11-09, USDC and PYUSD
// 2026-11-19), but the card still showed 5% and 8% as their APY, with "Deposit
// XLM for a 5.00% reward rate…".

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

// No chain, no prices: each vault holds 1,000 of its token at $0.50. Both
// ways of reading a balance and the decimals are stubbed, the lenient and
// the strict.
const { xdr } = require("@stellar/stellar-sdk");
const rpc = require("../lib/soroban-rpc");
rpc.getTokenBalance = async () => 1000n * 10_000_000n;
rpc.getTokenBalanceStrict = async () => 1000n * 10_000_000n;
rpc.getTokenMetadata = async () => ({ decimals: 7, symbol: "T" });
rpc.simulateContractCall = async (_id, fn) => (fn === "decimals" ? xdr.ScVal.scvU32(7) : null);
const pricing = require("../lib/pricing-engine");
pricing.priceSorobanToken = async () => ({ usd: 0.5 });

const explorer = require("../lib/defi-explorer");

let now;
test.beforeEach((t) => {
  explorer._resetForTests();
  t.mock.method(Date, "now", () => now);
});

async function card(at) {
  now = Date.parse(at);
  await explorer.refreshOnce({ only: ["sentora"] });
  const c = explorer.getSnapshot({ full: true }).protocols.find((p) => p.id === "sentora");
  return { ...c, byName: Object.fromEntries(c.pools.map((p) => [p.name, p])) };
}

test("while a campaign runs, its rate is quoted, through its last day", async () => {
  for (const at of ["2026-11-01T12:00:00Z", "2026-11-09T23:59:00Z"]) {
    const c = await card(at);
    const xlm = c.byName["Sentora XLM Vault"];
    assert.equal(xlm.apy, 0.05, at);
    assert.ok(!xlm.campaignEndedOn);
    assert.match(xlm.note, /^Deposit XLM for a 5\.00% reward rate/);
    assert.equal(c.hasApyData, true);
    assert.match(c.apyNote, /published by Sentora/);
  }
});

test("the day after a campaign's last day, that vault has no rate and says the campaign ended", async () => {
  const c = await card("2026-11-10T00:00:00Z");
  const xlm = c.byName["Sentora XLM Vault"];
  assert.equal(xlm.apy, null);
  assert.equal(xlm.campaignEndedOn, "2026-11-09");
  assert.equal(xlm.note, "Campaign ended 2026-11-09: new XLM deposits don't earn the 5.00% reward. " +
    "Rewards earned in the campaign are claimable on the Stellar DeFi Hub.");
  // The other two run until 2026-11-19.
  assert.equal(c.byName["Sentora USDC Vault"].apy, 0.08);
  assert.equal(c.byName["Sentora PYUSD Vault"].apy, 0.08);
  assert.equal(c.hasApyData, true);
  assert.match(c.apyNote, /published by Sentora/);
});

test("with every campaign over, no rates, and the card says so; the money in the vaults still counts", async () => {
  const c = await card("2026-11-24T12:00:00Z");
  assert.deepEqual(c.pools.map((p) => p.apy), [null, null, null]);
  assert.deepEqual(c.pools.map((p) => p.campaignEndedOn).sort(), ["2026-11-09", "2026-11-19", "2026-11-19"]);
  assert.equal(c.hasApyData, false);
  assert.match(c.apyNote, /^Sentora's campaigns have ended, so new deposits earn no reward/);
  assert.equal(c.totalTvlUSD, 3 * 1000 * 0.5);
  assert.ok(c.pools.every((p) => p.tvlUSD === 500));
});

test("the card's description doesn't promise a rate", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/defi-explorer.js"), "utf8");
  assert.match(src, /each paying a reward rate published by Sentora for a fixed-term campaign, " \+\s*"claimable when the campaign ends\./);
});
