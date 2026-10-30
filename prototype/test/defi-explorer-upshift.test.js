// The DeFi tab downloads Upshift's vault list hourly, not every minute.
//
// Upshift's API has no filter: each call returns every vault on every chain
// (164 vaults, 13.1 MB, 12-20 s on 2026-10-30) for the 10 on Stellar, and
// Upshift recomputes TVL and APY once a day. The explorer fetched it on every
// one-minute tick, from server start, whether or not anyone opened the tab.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const explorer = require("../lib/defi-explorer");

const MIN = 60_000;
const UPSHIFT_URL = "https://api.upshift.finance/v1/tokenized_vaults";

// Two visible Stellar vaults, a hidden one, and one on another chain.
const LIST = [
  { chain_type: "stellar", is_visible: true, vault_name: "Sentora USDC", address: "CALF", tvl: 39691074, reported_apy: null, stellar_vault_metadata: { deposit_token_symbol: "USDC" } },
  { chain_type: "stellar", is_visible: true, vault_name: "Gami earnXLM", address: "CC6T", tvl: 3358080, reported_apy: { apy: 0.05 }, stellar_vault_metadata: { deposit_token_symbol: "XLM" } },
  { chain_type: "stellar", is_visible: false, vault_name: "Sentora PYUSD", address: "CDUU", tvl: 13, stellar_vault_metadata: { deposit_token_symbol: "PYUSD" } },
  { chain_type: "evm", is_visible: true, vault_name: "Some EVM vault", address: "0xabc", tvl: 5e6 },
];

const realFetch = global.fetch;
let calls; // [{ url, opts }]
let answer; // () => Response, or throws
let now;

test.beforeEach((t) => {
  explorer._resetForTests();
  calls = [];
  answer = () => new Response(JSON.stringify(LIST), { status: 200 });
  now = Date.UTC(2026, 9, 30, 12, 0, 0);
  t.mock.method(Date, "now", () => now);
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return answer();
  };
});
test.afterEach(() => { global.fetch = realFetch; });

const upshiftCalls = () => calls.filter((c) => c.url === UPSHIFT_URL).length;
const upshiftCard = () => explorer.getSnapshot({ full: true }).protocols.find((p) => p.id === "upshift");

// One tick of the refresh loop, as start() runs it every minute.
async function tickAfter(ms) {
  now += ms;
  await explorer.refreshOnce({ only: ["upshift"] });
}

test("the list is downloaded once an hour, not on every one-minute tick", async () => {
  await tickAfter(0);
  for (let i = 0; i < 59; i++) await tickAfter(MIN);
  assert.equal(upshiftCalls(), 1, "60 ticks in the first hour, one download");
  await tickAfter(MIN);
  assert.equal(upshiftCalls(), 2, "an hour after the first, the next one");
});

test("the card shows the visible Stellar vaults from that download", async () => {
  await tickAfter(0);
  const card = upshiftCard();
  assert.deepEqual(card.pools.map((p) => [p.name, p.tvlUSD]), [["Sentora USDC", 39691074], ["Gami earnXLM", 3358080]]);
  assert.equal(card.totalTvlUSD, 39691074 + 3358080);
  assert.equal(card.stale, false);
});

test("after a failure it tries again in 5 minutes, still showing the last good list", async () => {
  await tickAfter(0);
  answer = () => new Response("busy", { status: 503 });
  await tickAfter(60 * MIN);
  assert.equal(upshiftCalls(), 2);
  assert.equal(upshiftCard().stale, true, "marked stale");
  assert.equal(upshiftCard().pools.length, 2, "the last good list is still shown");

  for (let i = 0; i < 4; i++) await tickAfter(MIN);
  assert.equal(upshiftCalls(), 2, "not before 5 minutes");
  answer = () => new Response(JSON.stringify(LIST), { status: 200 });
  await tickAfter(MIN);
  assert.equal(upshiftCalls(), 3, "5 minutes after the failure");
  assert.equal(upshiftCard().stale, false);

  for (let i = 0; i < 5; i++) await tickAfter(MIN);
  assert.equal(upshiftCalls(), 3, "back to hourly once it works");
});

test("a failed first download is retried in 5 minutes, not an hour", async () => {
  answer = () => { throw new TypeError("fetch failed"); };
  await tickAfter(0);
  assert.equal(upshiftCard().pools.length, 0);
  assert.match(upshiftCard().error, /fetch failed/);
  answer = () => new Response(JSON.stringify(LIST), { status: 200 });
  await tickAfter(5 * MIN);
  assert.equal(upshiftCalls(), 2);
  assert.equal(upshiftCard().pools.length, 2);
});

test("the download has a timeout, so a stalled one can't hold up the other protocols", async () => {
  await tickAfter(0);
  const { signal } = calls.find((c) => c.url === UPSHIFT_URL).opts || {};
  assert.ok(signal instanceof AbortSignal, "fetch gets an AbortSignal");
  assert.equal(signal.aborted, false);
});
