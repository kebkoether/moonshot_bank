// "Download full history" on a wallet's History tab: the wallet's history from
// Horizon as a CSV file, one row per balance change.
//
// The tab shows the latest 30 operations, with no way to get the rest. The
// export reads Horizon's effects (every credit and debit), the wallet's
// transactions (the network fee on each one it paid for, failed ones too) and
// its operations (counterparty, transaction hash), as far back as Horizon
// keeps them. Summed per asset, the rows are the change in the wallet's
// balances. On mainnet the sums matched the balances to the stroop for seven
// wallets whose whole history Horizon has.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const StellarSdk = require("@stellar/stellar-sdk");

const H = require("../lib/history-export");

const ME = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";
const BOB = "GDQCD6CECHJZRSX5LYRM4LAQ3HVK7WOPV2NO5KC7NFJTXB5CF3BIWMOG";
const FEE_PAYER = "GDBTWTVBNYU4SPELTPWQ6654FES4YFI5GMSSPUSZL4WZADI4I6D4ZPTP";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER };
const XLM = { asset_type: "native" };
const POOL = "a468d41d8e9b8f3c7209651608b74b7db7ac9952dcae0cdf24871d1d9c7b0088";
const CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

// ── A fake account history, built transaction by transaction ───────────────
// Ids as Horizon makes them: ledger << 32 | transaction order << 12 | op index.

function history() {
  let ledger = 60_000_000n;
  const h = { effects: [], operations: [], transactions: [] };
  /** One transaction: ops = [{ op, effects: [...] }]. */
  h.tx = ({ feeAccount = ME, source = ME, fee = 100, successful = true, memo, ops = [], listed = true } = {}) => {
    ledger++;
    const txId = ledger << 32n | 1n << 12n;
    const created_at = new Date(Date.UTC(2026, 0, 1) + Number(ledger - 60_000_000n) * 60_000).toISOString().replace(".000", "");
    const hash = `${txId.toString(16).padStart(64, "0")}`;
    // listed: false — the wallet took no part in it (another account's
    // operation filled its offer), so it's not among the wallet's transactions.
    if (listed) h.transactions.push({
      id: hash, hash, paging_token: String(txId), created_at, source_account: source, fee_account: feeAccount,
      fee_charged: String(fee), successful, memo_type: memo ? "text" : "none", ...(memo ? { memo } : {}),
    });
    ops.forEach(({ op, effects = [], mine = true }, i) => {
      const opId = String(txId + BigInt(i + 1));
      if (op && mine) h.operations.push({ id: opId, paging_token: opId, transaction_hash: hash, created_at, source_account: source, ...op });
      effects.forEach((e, j) => h.effects.push({ paging_token: `${opId}-${j + 1}`, account: ME, created_at, ...e }));
    });
    return hash;
  };
  /** Horizon's pages: newest first, PAGE_SIZE at a time, after the cursor. */
  h.page = (kind, cursor) => {
    const key = (r) => (kind === "effects" ? r.paging_token.split("-").map(BigInt) : [BigInt(r.paging_token), 0n]);
    const all = [...h[kind]].sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] !== y[0] ? (x[0] > y[0] ? -1 : 1) : x[1] > y[1] ? -1 : x[1] < y[1] ? 1 : 0;
    });
    const start = cursor ? all.findIndex((r) => r.paging_token === cursor) + 1 : 0;
    return all.slice(start, start + H.PAGE_SIZE);
  };
  return h;
}

const credited = (amount, asset) => ({ type: "account_credited", amount, ...asset });
const debited = (amount, asset) => ({ type: "account_debited", amount, ...asset });

/** Every kind of balance change, in one wallet. */
function richHistory() {
  const h = history();
  h.tx({ feeAccount: BOB, source: BOB, ops: [{ op: { type: "create_account", funder: BOB, account: ME, starting_balance: "100.0000000" },
    effects: [{ type: "account_created", starting_balance: "100.0000000" }] }] });
  h.tx({ feeAccount: BOB, source: BOB, memo: "invoice 7", ops: [{ op: { type: "payment", from: BOB, to: ME, amount: "250.0000000", ...USDC },
    effects: [credited("250.0000000", USDC)] }] });
  // A swap: XLM → USDC through the order book and a pool. The fills (trade,
  // liquidity_pool_trade) are inside the payment's own debit and credit.
  h.tx({ ops: [{ op: { type: "path_payment_strict_send", from: ME, to: ME, amount: "1.5000000", source_amount: "10.0000000", ...USDC },
    effects: [
      credited("1.5000000", USDC), debited("10.0000000", XLM),
      { type: "trade", seller: BOB, offer_id: "77", sold_amount: "6.0000000", sold_asset_type: "native", bought_amount: "0.9000000", bought_asset_type: "credit_alphanum4", bought_asset_code: "USDC", bought_asset_issuer: USDC_ISSUER },
      { type: "liquidity_pool_trade", liquidity_pool: { id: POOL }, sold: { asset: `USDC:${USDC_ISSUER}`, amount: "0.6000000" }, bought: { asset: "native", amount: "4.0000000" } },
    ] }] });
  // An offer of this wallet's, filled at once: only trade effects.
  h.tx({ ops: [{ op: { type: "manage_sell_offer", amount: "20.0000000", price: "0.15" },
    effects: [{ type: "trade", seller: BOB, offer_id: "88", sold_amount: "20.0000000", sold_asset_type: "native", bought_amount: "3.0000000", bought_asset_type: "credit_alphanum4", bought_asset_code: "USDC", bought_asset_issuer: USDC_ISSUER }] }] });
  // The same kind of offer, filled against a pool.
  h.tx({ ops: [{ op: { type: "manage_buy_offer" },
    effects: [{ type: "liquidity_pool_trade", liquidity_pool: { id: POOL }, sold: { asset: `USDC:${USDC_ISSUER}`, amount: "1.0000000" }, bought: { asset: "native", amount: "6.6000000" } }] }] });
  // Its standing offer, filled by another account's operation (not in its list).
  h.tx({ feeAccount: BOB, source: BOB, listed: false, ops: [{ mine: false, op: { type: "path_payment_strict_receive" },
    effects: [{ type: "trade", seller: BOB, offer_id: "99", sold_amount: "2.0000000", sold_asset_type: "credit_alphanum4", sold_asset_code: "USDC", sold_asset_issuer: USDC_ISSUER, bought_amount: "13.0000000", bought_asset_type: "native" }] }] });
  h.tx({ ops: [{ op: { type: "liquidity_pool_deposit" },
    effects: [{ type: "liquidity_pool_deposited", liquidity_pool: { id: POOL }, reserves_deposited: [{ asset: "native", amount: "30.0000000" }, { asset: `USDC:${USDC_ISSUER}`, amount: "4.5000000" }], shares_received: "11.6000000" }] }] });
  h.tx({ ops: [{ op: { type: "liquidity_pool_withdraw" },
    effects: [{ type: "liquidity_pool_withdrew", liquidity_pool: { id: POOL }, reserves_received: [{ asset: "native", amount: "15.0000000" }, { asset: `USDC:${USDC_ISSUER}`, amount: "2.2000000" }], shares_redeemed: "5.8000000" }] }] });
  // A DeFi deposit: the contract pulls USDC through its Stellar Asset Contract.
  h.tx({ fee: 52_345, ops: [{ op: { type: "invoke_host_function", asset_balance_changes: [{ type: "transfer", from: ME, to: CONTRACT, amount: "100.0000000", ...USDC }] },
    effects: [debited("100.0000000", USDC)] }] });
  // A failed transaction: only its fee.
  h.tx({ successful: false, fee: 200, ops: [{ op: { type: "payment", from: ME, to: BOB, amount: "1.0000000", ...XLM } }] });
  // A fee bump this wallet paid for another account's transaction.
  h.tx({ feeAccount: ME, source: FEE_PAYER, fee: 300, ops: [{ mine: false, op: { type: "bump_sequence" } }] });
  h.tx({ memo: "rent", ops: [{ op: { type: "payment", from: ME, to: BOB, amount: "5.0000000", ...XLM }, effects: [debited("5.0000000", XLM)] }] });
  return h;
}

const toStroops = (s) => { const n = s.startsWith("-"); const [w, f = ""] = s.replace("-", "").split("."); const v = BigInt(w) * 10_000_000n + BigInt((f + "0000000").slice(0, 7)); return n ? -v : v; };
function sums(rows) {
  const m = {};
  for (const r of rows) m[r.asset] = (m[r.asset] || 0n) + toStroops(r.amount);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, (Number(v) / 1e7).toFixed(7)]));
}

// ── The rows ────────────────────────────────────────────────────────────────

test("each balance change is a row: what moved, which way, with whom, in which transaction", async () => {
  const h = richHistory();
  const r = await H.readHistory(ME, { page: h.page });
  assert.equal(r.complete, true);
  assert.equal(r.startsAtCreation, true);
  const brief = r.rows.map((x) => [x.type, x.amount, x.asset, x.counterparty, x.memo, x.notes]);
  assert.deepEqual(brief, [
    ["account funding", "100.0000000", "XLM", BOB, "", ""],
    ["payment", "250.0000000", "USDC", BOB, "invoice 7", ""],
    ["network fee", "-0.0000100", "XLM", "", "", ""],
    ["swap", "1.5000000", "USDC", "", "", ""], //                   the fills aren't counted twice
    ["swap", "-10.0000000", "XLM", "", "", ""],
    ["network fee", "-0.0000100", "XLM", "", "", ""],
    ["trade", "-20.0000000", "XLM", BOB, "", "offer 88"],
    ["trade", "3.0000000", "USDC", BOB, "", "offer 88"],
    ["network fee", "-0.0000100", "XLM", "", "", ""],
    ["trade", "-6.6000000", "XLM", POOL, "", "against a liquidity pool"], // the pool bought XLM, sold USDC
    ["trade", "1.0000000", "USDC", POOL, "", "against a liquidity pool"],
    ["trade", "-2.0000000", "USDC", BOB, "", "offer 99; another account's operation"],
    ["trade", "13.0000000", "XLM", BOB, "", "offer 99; another account's operation"],
    ["network fee", "-0.0000100", "XLM", "", "", ""],
    ["pool deposit", "-30.0000000", "XLM", POOL, "", ""],
    ["pool deposit", "-4.5000000", "USDC", POOL, "", ""],
    ["pool deposit", "11.6000000", "pool shares", POOL, "", ""],
    ["network fee", "-0.0000100", "XLM", "", "", ""],
    ["pool withdrawal", "-5.8000000", "pool shares", POOL, "", ""],
    ["pool withdrawal", "15.0000000", "XLM", POOL, "", ""],
    ["pool withdrawal", "2.2000000", "USDC", POOL, "", ""],
    ["network fee", "-0.0052345", "XLM", "", "", ""],
    ["contract call", "-100.0000000", "USDC", CONTRACT, "", ""],
    ["network fee", "-0.0000200", "XLM", "", "", "failed transaction: only the fee was charged"],
    ["network fee", "-0.0000300", "XLM", "", "", `fee paid for ${FEE_PAYER}`],
    ["network fee", "-0.0000100", "XLM", "", "rent", ""],
    ["payment", "-5.0000000", "XLM", BOB, "rent", ""],
  ]);

  // Ids, dates and hashes for every row; asset ids as in the holdings CSV.
  for (const row of r.rows) {
    assert.equal(row.wallet, ME);
    assert.match(row.date_utc, /^2026-01-01T\d\d:\d\d:\d\dZ$/);
    if (!row.notes.includes("another account's operation")) assert.match(row.transaction_hash, /^[0-9a-f]{64}$/, `${row.type} has its transaction hash`);
    assert.equal(row.direction, row.amount.startsWith("-") ? "out" : "in");
    if (row.type !== "network fee") assert.match(row.operation_id, /^\d+$/);
  }
  assert.deepEqual([...new Set(r.rows.map((x) => `${x.asset} ${x.asset_id}`))].sort(),
    [`USDC ${USDC_ISSUER}`, "XLM native", `pool shares ${POOL}`]);

  // Summed per asset: the balances now.
  // XLM: 100 − 10 − 20 − 6.6 + 13 − 30 + 15 − 5, less 0.0053445 in fees.
  assert.deepEqual(sums(r.rows), { XLM: "56.3946555", USDC: "151.2000000", "pool shares": "5.8000000" });
});

// ── Reading ─────────────────────────────────────────────────────────────────

/** A long history: n transactions of three payments in, each with a fee. */
function longHistory(n) {
  const h = history();
  h.tx({ feeAccount: BOB, source: BOB, ops: [{ op: { type: "create_account", funder: BOB, account: ME }, effects: [{ type: "account_created", starting_balance: "10.0000000" }] }] });
  for (let i = 0; i < n; i++) {
    // Three payments per transaction, so pages of 200 end in the middle of one.
    h.tx({ ops: [0, 1, 2].map(() => ({ op: { type: "payment", from: BOB, to: ME, amount: "1.0000000", ...USDC }, effects: [credited("1.0000000", USDC)] })) });
  }
  return h;
}

test("a long history is read page by page, back to the account's creation", async () => {
  const h = longHistory(450); // 1,351 effects: seven pages
  const calls = [];
  const r = await H.readHistory(ME, { page: (k, c) => { calls.push(k); return h.page(k, c); } });
  assert.equal(r.complete, true);
  assert.equal(r.rows.length, 1 + 1350 + 450);
  assert.deepEqual(sums(r.rows), { XLM: "9.9955000", USDC: "1350.0000000" });
  assert.equal(calls.filter((k) => k === "effects").length, 7);
});

test("at the row limit the file stops at a whole transaction, with the fees of the same transactions", async () => {
  const h = longHistory(450);
  const calls = [];
  const r = await H.readHistory(ME, { page: (k, c) => { calls.push(k); return h.page(k, c); }, maxRows: 300 });
  assert.equal(r.complete, false);
  assert.equal(r.limit, "row limit");
  assert.ok(r.rows.length >= 300 && r.rows.length < 700, `${r.rows.length} rows`);
  // Every transaction in the file is whole, though the pages ended mid-transaction.
  const byTx = {};
  for (const row of r.rows) byTx[row.transaction_hash] = (byTx[row.transaction_hash] || 0) + 1;
  assert.deepEqual([...new Set(Object.values(byTx))], [4], "fee + 3 payments in each transaction");
  assert.equal(r.to, h.transactions.at(-1).created_at, "the newest transaction is in");
  assert.ok(calls.filter((k) => k === "effects").length <= 3, "stopped reading");
  assert.ok(calls.filter((k) => k === "transactions").length <= 3, "the fees weren't read further back than needed");
});

test("network fees count toward the row limit: a bot's failed transactions are mostly fees", async () => {
  const h = longHistory(2);
  for (let i = 0; i < 900; i++) h.tx({ successful: false, ops: [{ op: { type: "manage_sell_offer" } }] });
  const r = await H.readHistory(ME, { page: h.page, maxRows: 300 });
  assert.equal(r.complete, false);
  assert.equal(r.limit, "row limit");
  assert.ok(r.rows.length >= 300 && r.rows.length <= 600, `${r.rows.length} rows`);
  assert.ok(r.rows.every((x) => x.type === "network fee" && x.notes.startsWith("failed transaction")));
});

test("a Horizon that stops answering ends the reading in time, and says so", async () => {
  const h = longHistory(450);
  let n = 0;
  const page = (k, c) => (k === "effects" && ++n === 3 ? new Promise(() => {}) : h.page(k, c));
  const started = Date.now();
  const r = await H.readHistory(ME, { page, timeLimitMs: 300 });
  assert.ok(Date.now() - started < 1000, "answers by its time limit");
  assert.equal(r.complete, false);
  assert.equal(r.limit, "time limit");
  assert.ok(r.rows.length > 0 && r.rows.length < 1801, "the newest part");
});

test("Horizon errors: retried twice, then the part read so far, marked; no such account: notFound", async () => {
  const h = longHistory(10);
  let fails = 1;
  const flaky = (k, c) => { if (k === "effects" && fails-- > 0) throw Object.assign(new Error("503"), { status: 503 }); return h.page(k, c); };
  const ok = await H.readHistory(ME, { page: flaky, retryDelayMs: 1 });
  assert.equal(ok.complete, true, "one 503, then fine");

  const down = await H.readHistory(ME, { page: () => { throw new Error("socket hang up"); }, retryDelayMs: 1 });
  assert.equal(down.complete, false);
  assert.equal(down.limit, "Horizon error");
  assert.deepEqual(down.rows, []);

  const missing = await H.readHistory(ME, { page: () => { throw Object.assign(new Error("Not Found"), { response: { status: 404 } }); }, retryDelayMs: 1 });
  assert.equal(missing.notFound, true);

  // Horizon answers 503 for a busy bot's operations: the rows are all there,
  // without counterparties, and say why.
  const noOps = await H.readHistory(ME, { page: (k, c) => { if (k === "operations") throw new Error("503"); return h.page(k, c); }, retryDelayMs: 1 });
  assert.equal(noOps.complete, true);
  assert.equal(noOps.missingOperations, 31, "the funding and the 30 payments; fees don't need one");
  const pay = noOps.rows.find((x) => x.asset === "USDC");
  assert.deepEqual([pay.type, pay.counterparty, pay.notes], ["transfer", "", "operation details unavailable from Horizon"]);
});

test("history older than Horizon keeps: complete, but not from the account's creation", async () => {
  const h = longHistory(3);
  h.effects.splice(0, 1); // the account_created effect, before Horizon's history begins
  const r = await H.readHistory(ME, { page: h.page });
  assert.equal(r.complete, true);
  assert.equal(r.startsAtCreation, false);
});

test("two requests for one wallet share one reading; a third wallet waits its turn; a result is kept 5 minutes", async () => {
  H._resetForTests();
  const h = longHistory(3);
  let release;
  const gate = new Promise((r) => { release = r; });
  let reads = 0;
  const slow = async (k, c) => { if (k === "effects" && c == null) reads++; await gate; return h.page(k, c); };
  const a1 = H.exportHistory(ME, { page: slow });
  const a2 = H.exportHistory(ME, { page: slow });
  const b = H.exportHistory(BOB, { page: slow });
  await assert.rejects(H.exportHistory(FEE_PAYER, { page: slow }), (e) => e.busy === true);
  release();
  const [r1, r2] = await Promise.all([a1, a2, b]);
  assert.equal(r1, r2);
  assert.equal(reads, 2, "ME once, BOB once");
  await H.exportHistory(ME, { page: slow });
  assert.equal(reads, 2, "kept");
  let t = Date.now() + 6 * 60_000;
  await H.exportHistory(ME, { page: slow, now: () => t });
  assert.equal(reads, 3, "read again after 5 minutes");
  H._resetForTests();
});

// ── The endpoint and the button ─────────────────────────────────────────────

test("GET /api/v1/account/:address/history/export sends the rows, for the page to build the file", async () => {
  H._resetForTests();
  const h = richHistory();
  const asked = [];
  const builder = (kind) => {
    const b = { q: { kind } };
    for (const m of ["forAccount", "order", "limit", "cursor", "includeFailed"]) b[m] = (v) => { b.q[m] = v; return b; };
    b.call = async () => { asked.push(b.q); return { records: h.page(kind, b.q.cursor) }; };
    return b;
  };
  const P = StellarSdk.Horizon.Server.prototype;
  const real = { effects: P.effects, operations: P.operations, transactions: P.transactions };
  P.effects = () => builder("effects");
  P.operations = () => builder("operations");
  P.transactions = () => builder("transactions");
  try {
    const { app } = require("../server.js");
    const res = await request(app, "GET", `/api/v1/account/${ME}/history/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    const { rows, columns, ...meta } = res.body;
    assert.deepEqual(meta, {
      address: ME, complete: true, limit: null, from: "2026-01-01T00:01:00Z", to: "2026-01-01T00:12:00Z",
      startsAtCreation: true, missingOperations: 0,
    });
    assert.deepEqual(columns, H.COLUMNS);
    assert.equal(rows.length, 27);
    const last = Object.fromEntries(columns.map((c, i) => [c, rows[26][i]]));
    assert.deepEqual([last.type, last.amount, last.asset, last.counterparty, last.memo], ["payment", "-5.0000000", "XLM", BOB, "rent"]);
    assert.deepEqual(asked.map((q) => q.forAccount), Array(asked.length).fill(ME));
    assert.ok(asked.every((q) => q.order === "desc" && q.limit === 200));
    assert.ok(asked.filter((q) => q.kind === "transactions").every((q) => q.includeFailed === true), "failed transactions' fees too");

    assert.equal((await request(app, "GET", "/api/v1/account/not-an-address/history/export")).status, 400);
    const foreign = await request(app, "GET", `/api/v1/account/${ME}/history/export`, { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403, "only from the site's own pages");
  } finally {
    Object.assign(P, real);
    H._resetForTests();
  }
});

test("the buttons: a wallet's History tab, and All Wallets' History tab; the page loads the file builder", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /let html = historyExportBar\(currentData\.address\) \+ '<div class="tx-list">';/);
  assert.match(html, /currentAggTab === "history" \? historyExportBar\("all", \(d\.wallets \|\| \[\]\)\.length\)/);
  assert.match(html, /case "download-history-csv":\s*downloadHistoryCsv\(\);/);
  assert.match(html, /case "download-all-history-csv":\s*downloadAllHistoryCsv\(\);/);
  assert.match(html, /\/api\/v1\/account\/\$\{address\}\/history\/export/);
  const tag = html.indexOf('<script src="history-csv.js"></script>');
  assert.ok(tag > 0 && tag < html.indexOf("function downloadHistoryCsv()"), "loaded before the page script");
  const { app } = require("../server.js");
  const res = await request(app, "GET", "/history-csv.js");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /javascript/);
});
