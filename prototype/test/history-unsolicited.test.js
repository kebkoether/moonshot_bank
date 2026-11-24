// The Transactions tab leaves out what other accounts send a wallet unasked.
//
// Tiny incoming XLM payments (address poisoning, often from look-alike
// addresses) and claimable balances other accounts create for the wallet
// filled it: on 2026-11-24 one wallet's 30 latest operations were all
// 0.0001 XLM payments, and its latest 290 operations held two real ones.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@stellar/stellar-sdk");

const { app, __setTestDeps } = require("../server.js");

const WALLET = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const USDC = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ── A fake Horizon: the wallet's operations, newest first ───────────────────

let ops; // newest first
let pagesRead;
function op(fields) {
  const id = String(1_000_000 - ops.length);
  ops.push({ id, paging_token: id, created_at: "2026-11-24T00:00:00Z", transaction_hash: "ab".repeat(32), source_account: WALLET, ...fields });
}
const dust = (amount = "0.0001000") => op({ type: "payment", from: OTHER, to: WALLET, asset_type: "native", amount });
const theirClaimable = () => op({ type: "create_claimable_balance", source_account: OTHER, asset: `AVLX:${OTHER}`, amount: "0.0091000" });
const real = (amount = "250.0000000") => op({ type: "payment", from: OTHER, to: WALLET, asset_type: "native", amount });

__setTestDeps({
  getHorizon: () => ({
    operations: () => ({
      forAccount: (a) => {
        assert.equal(a, WALLET);
        const q = { cursor: null, limit: 10 };
        const builder = {
          order: (o) => { assert.equal(o, "desc"); return builder; },
          limit: (n) => { q.limit = n; return builder; },
          cursor: (c) => { q.cursor = c; return builder; },
          call: async () => {
            pagesRead++;
            const start = q.cursor ? ops.findIndex((o) => o.paging_token === q.cursor) + 1 : 0;
            return { records: ops.slice(start, start + q.limit) };
          },
        };
        return builder;
      },
    }),
  }),
});

test.beforeEach(() => { ops = []; pagesRead = 0; });

async function history(query = "") {
  const res = await request(app, "GET", `/api/v1/account/${WALLET}/history?limit=30${query}`);
  assert.equal(res.status, 200, res.raw);
  return res.body;
}

// ── What's left out, and what isn't ─────────────────────────────────────────

test("tiny incoming XLM payments and others' claimable balances are left out, and counted", async () => {
  for (let i = 0; i < 250; i++) dust(i % 2 ? "0.0001000" : "0.0000001");
  for (let i = 0; i < 30; i++) theirClaimable();
  real("1767.4380170");
  real("3545.3442330");
  const h = await history();
  assert.deepEqual(h.history.map((x) => x.amount), ["1767.4380170", "3545.3442330"]);
  assert.deepEqual(h.hidden, { dust: 250, claimable: 30 });
  assert.equal(h.dustBelowXLM, 0.01);
  assert.equal(pagesRead, 2, "read on past the first page of 200");
});

test("what the wallet did, real payments, and anything not XLM stay", async () => {
  op({ type: "payment", from: WALLET, to: OTHER, asset_type: "native", amount: "0.0000001" }); // sent by the wallet
  dust("0.0100000"); // 0.01 XLM is not under 0.01
  op({ type: "payment", from: OTHER, to: WALLET, asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC, amount: "0.0000001" });
  op({ type: "create_claimable_balance", source_account: WALLET, asset: "native", amount: "5.0000000" }); // the wallet's own
  op({ type: "claim_claimable_balance", balance_id: "00" });
  op({ type: "payment", from: WALLET, to: WALLET, asset_type: "native", amount: "0.0000001" }); // to itself
  // Between two other accounts, in a transaction the wallet sent.
  op({ type: "payment", from: OTHER, to: Keypair.random().publicKey(), asset_type: "native", amount: "0.0000001" });
  const h = await history();
  assert.equal(h.history.length, 7);
  assert.deepEqual(h.hidden, { dust: 0, claimable: 0 });
});

test("the page is filled from further back, and the cursor continues right after the last operation looked at", async () => {
  for (let i = 0; i < 40; i++) { real(String(i + 1) + ".0000000"); dust(); dust(); }
  const first = await history();
  assert.equal(first.history.length, 30);
  assert.equal(first.history[29].amount, "30.0000000");
  assert.equal(first.cursor, first.history[29].id, "the 30th real one: the dust after it isn't skipped yet");
  assert.equal(first.hidden.dust, 58);
  const next = await history(`&cursor=${first.cursor}`);
  assert.deepEqual(next.history.map((x) => x.amount), Array.from({ length: 10 }, (_, i) => `${i + 31}.0000000`));
  assert.equal(next.hidden.dust, 22);
});

test("at most 1,000 operations are read for one page; the cursor picks up after them", async () => {
  for (let i = 0; i < 1200; i++) dust();
  real();
  const h = await history();
  assert.deepEqual(h.history, []);
  assert.equal(h.hidden.dust, 1000);
  assert.equal(pagesRead, 5);
  assert.equal(h.cursor, ops[999].paging_token);
  const rest = await history(`&cursor=${h.cursor}`);
  assert.equal(rest.history.length, 1);
  assert.equal(rest.hidden.dust, 200);
});

test("?all=1 gives every operation, as before", async () => {
  for (let i = 0; i < 40; i++) dust();
  real();
  const h = await history("&all=1");
  assert.equal(h.history.length, 30);
  assert.ok(h.history.every((x) => x.amount === "0.0001000"));
  assert.deepEqual(h.hidden, { dust: 0, claimable: 0 });
  assert.equal(h.cursor, ops[29].paging_token);
  assert.equal(pagesRead, 1);
});

test("a wallet with no operations has none, and no cursor", async () => {
  const h = await history();
  assert.deepEqual([h.history, h.cursor, h.hidden], [[], null, { dust: 0, claimable: 0 }]);
});

// ── The page ────────────────────────────────────────────────────────────────

test("the tab says what it left out, and can show it", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  assert.match(html, /history\?limit=30\$\{historyShowAll \? "&all=1" : ""\}/);
  assert.match(html, /case "toggle-history-dust":\s*historyShowAll = !historyShowAll;\s*historyData = null;/);
  assert.match(html, /let html = historyExportBar\(currentData\.address\) \+ '<div class="tx-list">';\s*html \+= historyHiddenNote\(historyData\);/);
  // Everything hidden is not "No transaction history".
  assert.match(html, /length === 0\) && !\(hidden\.dust > 0 \|\| hidden\.claimable > 0\)\)/);
});

test("the note counts each kind", () => {
  // historyHiddenNote, run as the page would.
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const src = html.slice(html.indexOf("    function historyHiddenNote(data) {"), html.indexOf("    /** key: a wallet's address"));
  const note = (data, showAll = false) => new Function("historyShowAll", `${src}; return historyHiddenNote;`)(showAll)(data);
  assert.equal(note({ hidden: { dust: 0, claimable: 0 }, history: [{}] }), "");
  assert.match(note({ hidden: { dust: 255, claimable: 35 }, dustBelowXLM: 0.01, history: [{}] }),
    /Hiding 255 incoming payments under 0\.01 XLM and 35 claimable balances other accounts created \(see Claimable\)/);
  assert.match(note({ hidden: { dust: 1, claimable: 0 }, dustBelowXLM: 0.01, history: [] }), /Hiding 1 incoming payment under 0\.01 XLM: .* Nothing else in the latest operations\./);
  assert.match(note({ hidden: { dust: 3 } }, true), /Showing everything/);
});
