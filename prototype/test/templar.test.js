// Templar positions come from the wallet's whole history since Templar
// launched, read once and then kept up to date.
//
// The adapter used to read the newest 20 pages of /operations on every load:
// a busy wallet either ran past the 8-second adapter budget on every load, or
// had its older deposits cut off. On mainnet one wallet showed 1,735,132 USDC
// in Templar instead of 3,111,132.02. These tests run it against a fake
// Horizon serving /accounts/{id}/payments (and /operations, the endpoint the
// old adapter read, with the same records).

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const templar = require("../lib/adapters/templar");

const G = "GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK";
const C = "CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG";
const CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const LAUNCH_LEDGER = 58879169n; // Templar's first operation
const ctx = { xlmPrice: { usd: 0.2 } };

// ── Fake Horizon ─────────────────────────────────────────────────────────────

let history; // records, oldest first
let requests;
let failOnRequest; // request number that answers 503, or null
let nextLedger;

function token() {
  return String((nextLedger++ << 32n) | 4096n);
}
const usdc = (amount) => ({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: CIRCLE, amount: amount.toFixed(7) });
const xlm = (amount) => ({ asset_type: "native", amount: amount.toFixed(7) });
const deposit = (user, asset) => history.push({ type: "payment", paging_token: token(), from: user, to: G, ...asset });
const withdrawal = (user, asset) => history.push({ type: "payment", paging_token: token(), from: G, to: user, ...asset });
const borrow = (user, asset) => history.push({
  type: "invoke_host_function", paging_token: token(),
  asset_balance_changes: [{ type: "transfer", from: C, to: user, ...asset }],
});
const noise = (user, n) => {
  for (let i = 0; i < n; i++) history.push({ type: "payment", paging_token: token(), from: Keypair.random().publicKey(), to: user, ...xlm(1) });
};

const realFetch = global.fetch;
test.before(() => {
  global.fetch = async (url) => {
    url = new URL(String(url));
    requests++;
    if (requests === failOnRequest) return { ok: false, status: 503, json: async () => ({}) };
    const user = url.pathname.split("/")[2];
    const order = url.searchParams.get("order");
    const limit = Number(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    let records = history.filter((r) => r.from === user || r.to === user ||
      (r.asset_balance_changes || []).some((c) => c.from === user || c.to === user));
    if (order === "desc") {
      records = records.slice().reverse();
      if (cursor) records = records.filter((r) => BigInt(r.paging_token) < BigInt(cursor));
    } else if (cursor) {
      records = records.filter((r) => BigInt(r.paging_token) > BigInt(cursor));
    }
    return { ok: true, status: 200, json: async () => ({ _embedded: { records: records.slice(0, limit) } }) };
  };
});
test.after(() => { global.fetch = realFetch; });

test.beforeEach(() => {
  history = [];
  requests = 0;
  failOnRequest = null;
  nextLedger = LAUNCH_LEDGER - 1000n;
  templar._resetForTests?.();
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("deposits, withdrawals and borrows are netted into one position", async () => {
  const user = Keypair.random().publicKey();
  nextLedger = LAUNCH_LEDGER + 10n;
  deposit(user, usdc(1000));
  borrow(user, xlm(500));
  withdrawal(user, usdc(200));
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited.amount, "800.00");
  assert.equal(p.deposited.asset, "USDC");
  assert.equal(p.borrow.amount, "500.00");
  assert.equal(p.borrow.asset, "XLM");
  assert.ok(Math.abs(p.valueUSD - (800 - 500 * 0.2)) < 1e-9);
  assert.equal(p.yield.accrued, null, "interest isn't visible on Stellar");
  assert.equal(p.incomplete, undefined);
});

test("an early deposit counts however much history came after it", async () => {
  // 6,000 records after the deposit: more than the old 20-page window.
  const user = Keypair.random().publicKey();
  nextLedger = LAUNCH_LEDGER + 5n;
  deposit(user, usdc(1_000_000));
  noise(user, 6000);
  deposit(user, usdc(500));
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited.amount, "1000500.00");
  assert.equal(p.incomplete, undefined);
});

test("history from before Templar launched is never read", async () => {
  const user = Keypair.random().publicKey();
  noise(user, 900); // all before the launch
  nextLedger = LAUNCH_LEDGER + 1n;
  deposit(user, xlm(100));
  noise(user, 250);
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited.amount, "100.00");
  // The newest page, then one page per ledger range (8). Reading on past the
  // launch would cost 5 more pages for the 900 older records.
  assert.ok(requests <= 9, `stopped at the launch (${requests} requests)`);
});

test("a later load only asks for what's new", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const user = Keypair.random().publicKey();
  nextLedger = LAUNCH_LEDGER + 1n;
  deposit(user, usdc(1000));
  noise(user, 3000);
  await templar.getPositions(user, ctx);

  deposit(user, usdc(250));
  t.mock.timers.setTime(1_800_000_000_000 + 60_000);
  requests = 0;
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited.amount, "1250.00");
  assert.equal(requests, 1);
});

test("a Horizon failure gives no position, and the next load resumes without double counting", async () => {
  const user = Keypair.random().publicKey();
  nextLedger = LAUNCH_LEDGER + 1n;
  deposit(user, usdc(700));
  noise(user, 4000);
  deposit(user, usdc(300));
  noise(user, 2000);
  failOnRequest = 4;
  await assert.rejects(templar.getPositions(user, ctx), /503/);
  failOnRequest = null;
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited.amount, "1000.00");
  assert.equal(p.incomplete, undefined);
});

test("a wallet with more history than it will read is marked incomplete", async () => {
  const user = Keypair.random().publicKey();
  nextLedger = LAUNCH_LEDGER + 1n;
  deposit(user, usdc(10));
  noise(user, 300 * 200 + 500);
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.incomplete, true);
});

test("a borrow-only position has no deposit", async () => {
  const user = Keypair.random().publicKey();
  nextLedger = LAUNCH_LEDGER + 1n;
  borrow(user, usdc(50));
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited, null);
  assert.equal(p.borrow.amount, "50.00");
  assert.ok(Math.abs(p.valueUSD + 50) < 1e-9);
});

test("every record is counted exactly once across the ledger ranges read in parallel", async () => {
  // Every ledger has a deposit, some also a second record, so a range that
  // overlapped or missed even one ledger would change the total.
  const user = Keypair.random().publicKey();
  for (let i = 0n; i < 1500n; i++) {
    const ledger = LAUNCH_LEDGER + 1n + i;
    history.push({ type: "payment", paging_token: String(ledger << 32n | 4096n), from: user, to: G, ...usdc(1) });
    if (i % 3n === 0n) {
      history.push({ type: "payment", paging_token: String(ledger << 32n | 8192n), from: Keypair.random().publicKey(), to: user, ...xlm(1) });
    }
  }
  const [p] = await templar.getPositions(user, ctx);
  assert.equal(p.deposited.amount, "1500.00");
});
