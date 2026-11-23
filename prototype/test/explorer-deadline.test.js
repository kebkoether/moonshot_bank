// One DeFi tab fetcher that never finishes can't stop the others refreshing.
//
// The refresh loop runs the fetchers one after another and skips a tick
// while the last one is still going. Aquarius's pool list was fetched with no
// time limit, so a request that never answered held the loop, and every
// protocol stayed at its last value until the server restarted. Each fetcher
// now has a deadline, and Aquarius's requests a timeout.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const explorer = require("../lib/defi-explorer");

const AQUA_URL = "https://amm-api.aqua.network/pools/";
const UPSHIFT_URL = "https://api.upshift.finance/v1/tokenized_vaults";
const UPSHIFT_LIST = [
  { chain_type: "stellar", is_visible: true, vault_name: "Gami earnXLM", address: "CC6T", tvl: 3358080, reported_apy: { apy: 0.05 }, stellar_vault_metadata: { deposit_token_symbol: "XLM" } },
];
const AQUA_PAGE = { total: 1, items: [{ address: "CAQUA", liquidity_usd: "12000000000", tokens_str: ["native"], apy: "0.1" }] };

const realFetch = global.fetch;
let aquarius; // (opts) => Promise<Response>
let aquaCalls;
let now;

test.beforeEach((t) => {
  explorer._resetForTests();
  explorer._setDeadlineForTests?.(100);
  aquaCalls = [];
  now = Date.UTC(2026, 10, 23, 12, 0, 0);
  t.mock.method(Date, "now", () => now);
  global.fetch = async (url, opts) => {
    url = String(url);
    if (url.startsWith(AQUA_URL)) { aquaCalls.push(opts); return aquarius(opts); }
    if (url === UPSHIFT_URL) return new Response(JSON.stringify(UPSHIFT_LIST), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
});
test.afterEach(() => {
  global.fetch = realFetch;
  explorer._setDeadlineForTests?.(null);
});

const card = (id) => explorer.getSnapshot({ full: true }).protocols.find((p) => p.id === id);
const never = () => new Promise(() => {}); // ignores its abort signal: the worst case

/** refreshOnce, or "STILL WAITING" if it hasn't finished within 2 s. */
async function tick(afterMs = 0) {
  now += afterMs;
  let timer;
  const out = await Promise.race([
    explorer.refreshOnce({ only: ["aquarius", "upshift"] }).then(() => "done"),
    new Promise((r) => { timer = setTimeout(() => r("STILL WAITING"), 2000); }),
  ]);
  clearTimeout(timer);
  return out;
}

test("a fetcher that never answers doesn't hold up the others", async () => {
  aquarius = never;
  assert.equal(await tick(), "done");
  assert.match(card("aquarius").error, /no answer within/);
  assert.equal(card("upshift").pools.length, 1, "Upshift, after Aquarius in the loop, still refreshed");
});

test("the loop keeps running after it", async () => {
  aquarius = never;
  await tick();
  // An hour on, Upshift is due again; before, every later tick did nothing.
  assert.equal(await tick(60 * 60_000), "done");
  assert.match(card("upshift").lastUpdated, /T13:00:00/);
});

test("a stuck run isn't started again until it has finished", async () => {
  let finish;
  aquarius = () => new Promise((resolve) => { finish = resolve; });
  await tick();
  await tick(60_000);
  await tick(60_000);
  assert.equal(aquaCalls.length, 1, "one stuck request, not one a minute");
  assert.match(card("aquarius").error, /no answer|still waiting/);

  // Once it ends, the next tick asks again, and a good answer clears the error.
  finish(new Response(JSON.stringify(AQUA_PAGE), { status: 200 }));
  await new Promise((r) => setImmediate(r));
  aquarius = async () => new Response(JSON.stringify(AQUA_PAGE), { status: 200 });
  await tick(60_000);
  assert.equal(aquaCalls.length, 2);
  assert.equal(card("aquarius").error, undefined);
  assert.ok(card("aquarius").totalTvlUSD > 0);
});

test("the last good value stays while it's stuck", async () => {
  aquarius = async () => new Response(JSON.stringify(AQUA_PAGE), { status: 200 });
  await tick();
  const good = card("aquarius").totalTvlUSD;
  assert.ok(good > 0);
  aquarius = never;
  for (let i = 0; i < 3; i++) {
    // The tick that gives up on it, then ticks while it's still running.
    await tick(60_000);
    assert.equal(card("aquarius").totalTvlUSD, good);
    assert.equal(card("aquarius").stale, true);
  }
});

test("a fetcher inside its deadline is unaffected", async () => {
  aquarius = () => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(AQUA_PAGE), { status: 200 })), 20));
  await tick();
  assert.equal(card("aquarius").stale, false);
  assert.ok(card("aquarius").totalTvlUSD > 0);
});

test("Aquarius's requests carry a time limit", async () => {
  aquarius = async () => new Response(JSON.stringify(AQUA_PAGE), { status: 200 });
  await tick();
  assert.ok(aquaCalls[0]?.signal instanceof AbortSignal, "fetch is given an abort signal");
});
