// A response body that never arrives can't hold up the XLM price, a wallet's
// Templar history, Upshift's vault list or the DeFi tab's refresh loop.
//
// Node's fetch can leave res.json() pending for good when the request's abort
// signal fires just as a gzip body is arriving. Each of these keeps one shared
// request in flight, so a read left pending held every later caller too, until
// the server restarted: every wallet lookup waits for the XLM price. Now each
// body read gives up when its request's timeout fires.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

// ── The timeouts, fired by the test ─────────────────────────────────────────
// The modules arm their own (new AbortController() + setTimeout, or
// AbortSignal.timeout) for 8 to 60 seconds. Every controller made from here on
// is recorded, so a test can make those timeouts fire without the wait.
const armed = [];
global.AbortController = class extends AbortController {
  constructor() { super(); armed.push(this); }
};
AbortSignal.timeout = () => new AbortController().signal;
function timeoutsFire() {
  for (const c of armed.splice(0)) c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
}

/** What `promise` settles to while the timeouts fire, or "STILL WAITING". */
async function whileTimeoutsFire(promise) {
  let out = "STILL WAITING";
  promise.then((value) => { out = { value }; }, (error) => { out = { error }; });
  for (let i = 0; i < 6 && out === "STILL WAITING"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    timeoutsFire();
  }
  await new Promise((r) => setTimeout(r, 20));
  return out;
}

const never = () => new Promise(() => {});
const stuck = () => ({ ok: true, status: 200, json: never, text: never }); // headers in, body never
const answer = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// ── A fake network ──────────────────────────────────────────────────────────
let route; // (url) => response
let seen;
const realFetch = global.fetch;
global.fetch = async (url) => { seen.push(String(url)); return route(String(url)); };
test.after(() => { global.fetch = realFetch; });

// Upshift's adapter destructures these at require time: mocks first.
const rpcLib = require("../lib/soroban-rpc");
rpcLib.getTokenBalanceStrict = async () => "0";
const pricing = require("../lib/pricing-engine");
pricing.priceSorobanToken = async () => ({ usd: 1, source: "test" });

const { untilAborted } = require("../lib/until-aborted");
const xlmPrice = require("../lib/xlm-price");
const templar = require("../lib/adapters/templar");
const upshift = require("../lib/adapters/upshift");
const explorer = require("../lib/defi-explorer");

const G = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";

test.beforeEach(() => {
  armed.splice(0);
  seen = [];
  route = () => stuck();
  xlmPrice._resetForTests();
  templar._resetForTests();
  upshift._resetForTests();
  explorer._resetForTests();
});

// ── The guard ───────────────────────────────────────────────────────────────

test("the body's own result comes through unchanged", async () => {
  const c = new AbortController();
  assert.deepEqual(await untilAborted(Promise.resolve({ a: 1 }), c.signal), { a: 1 });
  await assert.rejects(untilAborted(Promise.reject(new SyntaxError("bad json")), c.signal), SyntaxError);
  const p = Promise.resolve(1);
  assert.equal(untilAborted(p, undefined), p, "no signal: the read as it is");
});

test("a body that never settles gives up when the timeout fires", async () => {
  const c = new AbortController();
  const read = untilAborted(never(), c.signal);
  c.abort(new DOMException("timed out", "TimeoutError"));
  await assert.rejects(read, { name: "TimeoutError" });
});

test("a timeout that already fired fails at once, and a body that fails later isn't an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const c = new AbortController();
    c.abort();
    let fail;
    const body = new Promise((_, reject) => { fail = reject; });
    await assert.rejects(untilAborted(body, c.signal), { name: "AbortError" });
    fail(new Error("body failed after the abort"));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ── Where a read left pending held everyone after it ────────────────────────

test("XLM price: a body that never arrives fails that refresh, and the next one runs", async () => {
  const first = await whileTimeoutsFire(xlmPrice.getXLMPrice());
  assert.notEqual(first, "STILL WAITING", "every wallet lookup waits for this");
  assert.equal(first.value.source, "none", "no source answered");
  assert.ok(seen.some((u) => u.includes("/order_book")) && seen.some((u) => u.includes("coingecko")), "SDEX, then CoinGecko");

  route = (url) => url.includes("/order_book")
    ? answer({ bids: [{ price: "0.17" }], asks: [{ price: "0.1702" }] })
    : answer({ _embedded: { records: [] } });
  const next = await whileTimeoutsFire(xlmPrice.getXLMPrice());
  assert.equal(next.value.source, "sdex");
  assert.equal(next.value.usd, 0.1701);
});

test("Templar: a history page that never arrives fails that load, not every later load of the wallet", async () => {
  const first = await whileTimeoutsFire(templar.getPositions(G, { xlmPrice: { usd: 0.17 } }));
  assert.notEqual(first, "STILL WAITING");
  assert.equal(first.error?.name, "TimeoutError", "an error: the server then serves Templar's last good result, or marks it degraded");

  route = () => answer({ _embedded: { records: [] } });
  const next = await whileTimeoutsFire(templar.getPositions(G, { xlmPrice: { usd: 0.17 } }));
  assert.deepEqual(next, { value: [] }, "read again, not waiting on the first scan");
});

test("Upshift: a vault list that never arrives is given up, so the list can refresh again", async () => {
  await upshift.getPositions(G, { xlmPrice: { usd: 0.17 } }); // starts the list download, doesn't wait for it
  assert.equal(seen.filter((u) => u.includes("tokenized_vaults")).length, 1);
  const settled = await whileTimeoutsFire(upshift._vaultListSettled());
  assert.notEqual(settled, "STILL WAITING", "otherwise the list is never fetched again");
});

test("DeFi tab: a Templar or Upshift body that never arrives fails that protocol's refresh, not the loop", async () => {
  for (const id of ["templar", "upshift"]) {
    const done = await whileTimeoutsFire(explorer.refreshOnce({ only: [id] }));
    assert.notEqual(done, "STILL WAITING", `${id}: the loop refreshes every protocol, one after another`);
    const card = explorer.getSnapshot({ full: true }).protocols.find((p) => p.id === id);
    assert.match(card.error, /abort|timeout/i, `${id}: shown as failed`);
  }

  // Templar's price lookup too: the card still comes out, without fresh prices.
  explorer._resetForTests();
  route = (url) => url.includes("coingecko") ? stuck() : answer({ markets: [], deprecatedMarkets: [], marketSnapshots: [] });
  const priced = await whileTimeoutsFire(explorer.getSnapshot._fetchTemplar());
  assert.ok(priced.value, `fetchTemplar answered: ${priced.error?.message || priced}`);
});
