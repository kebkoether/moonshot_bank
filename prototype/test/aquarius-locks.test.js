// AQUA a wallet locked for ICE counts in its value.
//
// The lock is a claimable balance only the wallet can claim, after the unlock
// date. Until it's claimed, the AQUA is in no trustline, so neither the AQUA
// balance nor the wallet's value included it. These tests run the adapter
// against a fake Horizon serving /claimable_balances.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const pricing = require("../lib/pricing-engine");
const locks = require("../lib/adapters/aquarius-locks");
const { summarizeDefiPosition } = require("../lib/defi-snapshot");
const H = require("../public/holdings-csv.js");

const AQUA = `AQUA:${locks._internals.AQUA_ISSUER}`;
const DAY = 86_400_000;
const NOW = Date.now();

// ── Fake Horizon ─────────────────────────────────────────────────────────────

let balances; // every claimable balance on the "network"
let requests;
let failOnRequest; // request number that answers 503, or null

const at = (ms) => ({ abs_before: new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"), abs_before_epoch: String(Math.floor(ms / 1000)) });
const lockedUntil = (ms) => ({ not: at(ms) });
let nextId = 0;
function claimable({ amount, sponsor, claimants, asset = AQUA }) {
  balances.push({ id: `00000000${String(nextId++).padStart(56, "0")}`, asset, amount, sponsor, claimants });
}
/** The wallet's own lock: it sponsors it and is the only claimant, after `until`. */
const lock = (wallet, amount, until) =>
  claimable({ amount, sponsor: wallet, claimants: [{ destination: wallet, predicate: lockedUntil(until) }] });

let priceCalls;
const realFetch = global.fetch;
const realPrice = pricing.priceClassicAsset;
test.before(() => {
  global.fetch = async (url) => {
    url = new URL(String(url));
    requests++;
    if (requests === failOnRequest) return { ok: false, status: 503, json: async () => ({}) };
    assert.equal(url.pathname, "/claimable_balances");
    const claimant = url.searchParams.get("claimant");
    const asset = url.searchParams.get("asset");
    const limit = Number(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    let records = balances.filter((b) => b.asset === asset && b.claimants.some((c) => c.destination === claimant));
    if (cursor) records = records.filter((b) => b.id > cursor);
    records = records.slice(0, limit);
    const next = new URL(url);
    if (records.length) next.searchParams.set("cursor", records[records.length - 1].id);
    return { ok: true, status: 200, json: async () => ({ _links: { next: { href: next.href } }, _embedded: { records } }) };
  };
  pricing.priceClassicAsset = async (ctx, code, issuer) => {
    priceCalls.push({ ctx, code, issuer });
    return { usd: 0.0002, source: "test" };
  };
});
test.after(() => {
  global.fetch = realFetch;
  pricing.priceClassicAsset = realPrice;
});
test.beforeEach(() => {
  balances = [];
  requests = 0;
  failOnRequest = null;
  priceCalls = [];
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("a wallet's locks are one position, valued at AQUA's price", async () => {
  const w = Keypair.random().publicKey();
  lock(w, "850001000.0000000", NOW - 120 * DAY);
  lock(w, "8860338.4756574", NOW - 10 * DAY);
  lock(w, "9171659.6312211", NOW + 30 * DAY);
  lock(w, "6453590.9586519", NOW + 5 * DAY);

  const [p, ...rest] = await locks.getPositions(w);
  assert.equal(rest.length, 0);
  assert.equal(p.protocol, "aquarius");
  assert.equal(p.type, "locked");
  assert.equal(p.poolName, "AQUA locked for ICE");
  assert.deepEqual(p.staked, { amount: "874486589.0655304", asset: "AQUA" });
  assert.equal(p.unlocked, "858861338.4756574");
  assert.equal(Date.parse(p.nextUnlock), Math.floor((NOW + 5 * DAY) / 1000) * 1000);
  assert.equal(p.lockCount, 4);
  assert.ok(Math.abs(p.valueUSD - 874486589.0655304 * 0.0002) < 1e-6);
  assert.equal(p.unpriced, undefined);
});

test("it asks for the price the wallet's own AQUA gets", async () => {
  const w = Keypair.random().publicKey();
  lock(w, "100.0000000", NOW + DAY);
  await locks.getPositions(w);
  assert.equal(priceCalls.length, 1);
  assert.equal(priceCalls[0].code, "AQUA");
  assert.equal(priceCalls[0].issuer, locks._internals.AQUA_ISSUER);
  assert.equal(typeof priceCalls[0].ctx.priceViaSDEX, "function", "with the order-book layer, like the AQUA row");
});

test("AQUA someone else sent isn't counted", async () => {
  const w = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();
  lock(w, "10.0000000", NOW + DAY);
  // A time-locked gift: the sender sponsors it.
  claimable({ amount: "5000.0000000", sponsor: other, claimants: [{ destination: w, predicate: lockedUntil(NOW + DAY) }] });
  // A payment the sender can take back: two claimants.
  claimable({ amount: "7000.0000000", sponsor: other, claimants: [
    { destination: w, predicate: { unconditional: true } },
    { destination: other, predicate: { unconditional: true } },
  ] });
  // The wallet's own balance, but claimable by someone else too.
  claimable({ amount: "9000.0000000", sponsor: w, claimants: [
    { destination: w, predicate: lockedUntil(NOW + DAY) },
    { destination: other, predicate: { unconditional: true } },
  ] });
  // Not AQUA.
  claimable({ amount: "1.0000000", sponsor: w, asset: `ICE:${other}`, claimants: [{ destination: w, predicate: lockedUntil(NOW + DAY) }] });

  const [p] = await locks.getPositions(w);
  assert.equal(p.staked.amount, "10.0000000");
  assert.equal(p.lockCount, 1);
});

test("only a claim-after-a-date or claim-any-time predicate is a lock", async () => {
  const w = Keypair.random().publicKey();
  const own = (amount, predicate) => claimable({ amount, sponsor: w, claimants: [{ destination: w, predicate }] });
  own("1.0000000", lockedUntil(NOW + DAY)); // counted, locked
  own("2.0000000", { unconditional: true }); // counted, claimable now
  own("40.0000000", at(NOW + DAY)); // claimable only BEFORE a date
  own("80.0000000", { rel_before: "3600" });
  own("160.0000000", { and: [{ unconditional: true }, { not: at(NOW + DAY) }] });
  own("320.0000000", { not: { rel_before: "3600" } });

  const [p] = await locks.getPositions(w);
  assert.equal(p.staked.amount, "3.0000000");
  assert.equal(p.unlocked, "2.0000000");
  assert.equal(p.lockCount, 2);
});

test("no locks, no position", async () => {
  const w = Keypair.random().publicKey();
  assert.deepEqual(await locks.getPositions(w), []);
  claimable({ amount: "5.0000000", sponsor: Keypair.random().publicKey(), claimants: [{ destination: w, predicate: { unconditional: true } }] });
  assert.deepEqual(await locks.getPositions(w), []);
  assert.equal(priceCalls.length, 0, "no price asked for nothing");
});

test("all locks unlocked: nothing next", async () => {
  const w = Keypair.random().publicKey();
  lock(w, "1.0000000", NOW - DAY);
  const [p] = await locks.getPositions(w);
  assert.equal(p.unlocked, "1.0000000");
  assert.equal(p.nextUnlock, null);
});

test("amounts add up to the stroop", async () => {
  const w = Keypair.random().publicKey();
  for (let i = 0; i < 10; i++) lock(w, "0.1000001", NOW + DAY); // 0.1 + 0.1 + … in floats is 0.9999999999999999
  lock(w, "9007199254.7409910", NOW + DAY); // past 2^53 stroops
  const [p] = await locks.getPositions(w);
  assert.equal(p.staked.amount, "9007199255.7409920");
});

test("every page is read", async () => {
  const w = Keypair.random().publicKey();
  for (let i = 0; i < 450; i++) lock(w, "1.0000000", NOW + DAY);
  const [p] = await locks.getPositions(w);
  assert.equal(p.lockCount, 450);
  assert.equal(p.staked.amount, "450.0000000");
  assert.equal(requests, 3);
});

test("a Horizon failure gives no position, not part of one", async () => {
  const w = Keypair.random().publicKey();
  for (let i = 0; i < 450; i++) lock(w, "1.0000000", NOW + DAY);
  failOnRequest = 2;
  await assert.rejects(locks.getPositions(w), /503/);
});

test("more locks than it will read gives no position, not part of one", async () => {
  const w = Keypair.random().publicKey();
  for (let i = 0; i < 25 * 200 + 1; i++) lock(w, "1.0000000", NOW + DAY);
  await assert.rejects(locks.getPositions(w), /more than 5000/);
});

test("no AQUA price: the amount is still shown, marked unpriced", async () => {
  const w = Keypair.random().publicKey();
  lock(w, "100.0000000", NOW + DAY);
  pricing.priceClassicAsset = async () => null;
  try {
    const [p] = await locks.getPositions(w);
    assert.equal(p.staked.amount, "100.0000000");
    assert.equal(p.valueUSD, 0);
    assert.equal(p.unpriced, true);
  } finally {
    pricing.priceClassicAsset = async (ctx, code, issuer) => {
      priceCalls.push({ ctx, code, issuer });
      return { usd: 0.0002, source: "test" };
    };
  }
});

test("the position reaches the snapshot and the CSV as AQUA", async () => {
  const w = Keypair.random().publicKey();
  lock(w, "1000.0000000", NOW + DAY);
  const [p] = await locks.getPositions(w);

  assert.deepEqual(summarizeDefiPosition(p), {
    protocol: "aquarius", name: "AQUA locked for ICE",
    legs: [{ amount: 1000, asset: "AQUA", side: "staked" }], valueUSD: 0.2, stale: false,
  });

  const csv = H.build([{ address: w, balances: [], defiPositions: [p] }], { asOf: "2026-11-12T00:00:00Z" }).trim().split("\r\n");
  assert.equal(csv.length, 2);
  const row = Object.fromEntries(H.COLUMNS.map((c, i) => [c, csv[1].split(",")[i]]));
  assert.equal(row.venue, "Aquarius");
  assert.equal(row.position, "AQUA locked for ICE");
  assert.equal(row.side, "locked");
  assert.equal(row.asset_1, "AQUA");
  assert.equal(row.amount_1, "1000.0000000", "to the stroop");
  assert.equal(row.value_usd, "0.20");
});

test("the server runs it with the other adapters", () => {
  const { PROTOCOL_ADAPTERS } = require("../server.js");
  assert.ok(PROTOCOL_ADAPTERS.includes(locks));
  assert.equal(locks.isConfigured(), true);
});

test("the DeFi tab has a card for it", () => {
  // Without its own branch, a "locked" position would show only its value.
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "index.html"), "utf8");
  const start = html.indexOf('} else if (pos.type === "locked") {');
  assert.ok(start > 0, "no card branch for type locked");
  const branch = html.slice(start, html.indexOf("} else if (pos.type ===", start + 10));
  for (const field of ["pos.staked.amount", "pos.staked.asset", "pos.unlocked", "pos.nextUnlock", "pos.lockCount", "pos.unpriced"]) {
    assert.ok(branch.includes(field), `the card doesn't show ${field}`);
  }
  assert.match(html, /\.defi-type-badge\.locked \{/);
});
