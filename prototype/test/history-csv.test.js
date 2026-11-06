// The "Download full history" file, built in the page from the server's rows
// (public/history-csv.js): one wallet's, or every saved wallet's in one file
// from All Wallets, with each wallet's label on its rows.

const test = require("node:test");
const assert = require("node:assert/strict");

const C = require("../public/history-csv.js");
const { COLUMNS: SERVER_COLUMNS } = require("../lib/history-export.js");

const A = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";
const B = "GDQCD6CECHJZRSX5LYRM4LAQ3HVK7WOPV2NO5KC7NFJTXB5CF3BIWMOG";

/** A wallet's export as the server sends it: rows as arrays in `columns` order. */
function exported(address, rows, meta = {}) {
  const columns = SERVER_COLUMNS;
  const full = rows.map((r) => ({
    wallet: address, direction: String(r.amount).startsWith("-") ? "out" : "in", asset: "XLM", asset_id: "native",
    counterparty: "", operation_type: "payment", memo: "", transaction_hash: "", operation_id: "", notes: "", type: "payment", ...r,
  }));
  return {
    address, columns, rows: full.map((r) => columns.map((c) => r[c])),
    complete: true, limit: null, startsAtCreation: true, missingOperations: 0,
    from: full.length ? full[0].date_utc : null, to: full.length ? full[full.length - 1].date_utc : null, ...meta,
  };
}

const parse = (csv) => csv.trimEnd().split("\r\n");

test("the file has the server's columns, with the wallet's label after the wallet", () => {
  assert.deepEqual(C.COLUMNS.filter((c) => c !== "label"), SERVER_COLUMNS);
  assert.equal(C.COLUMNS.indexOf("label"), C.COLUMNS.indexOf("wallet") + 1);
});

test("several wallets in one file, oldest first; each keeps its own order within a second", () => {
  const a = { ...exported(A, [
    { date_utc: "2026-01-01T00:00:05Z", amount: "-0.0000100", type: "network fee" },
    { date_utc: "2026-01-01T00:00:05Z", amount: "-5.0000000" },
    { date_utc: "2026-01-03T00:00:00Z", amount: "1.0000000" },
  ]), label: "Wave ops" };
  const b = { ...exported(B, [{ date_utc: "2026-01-02T00:00:00Z", amount: "5.0000000", counterparty: A }]), label: "" };
  const lines = parse(C.build([a, b]));
  assert.equal(lines[0], C.COLUMNS.join(","));
  assert.deepEqual(lines.slice(1).map((l) => l.split(",").slice(0, 6).join(" ")), [
    `2026-01-01T00:00:05Z ${A} Wave ops network fee out -0.0000100`,
    `2026-01-01T00:00:05Z ${A} Wave ops payment out -5.0000000`,
    `2026-01-02T00:00:00Z ${B}  payment in 5.0000000`,
    `2026-01-03T00:00:00Z ${A} Wave ops payment in 1.0000000`,
  ]);
});

test("no cell a spreadsheet would run as a formula; amounts stay numbers", () => {
  const w = { ...exported(A, [{ date_utc: "2026-01-01T00:00:00Z", amount: "-1.0000000", memo: '=HYPERLINK("http://x","y"), ok' }]), label: "+1 cash" };
  const line = parse(C.build([w]))[1];
  assert.ok(line.includes(",-1.0000000,"), "an amount stays a number");
  assert.ok(line.includes(`"'=HYPERLINK(""http://x"",""y""), ok"`), "a memo can't be a formula");
  assert.ok(line.includes(",'+1 cash,"), "nor a label");
});

test("file names: one wallet, or all wallets, with the dates covered", () => {
  assert.equal(C.fileName(A, "2025-09-21T22:06:11Z", "2026-11-05T23:14:01Z"), "stellarscope-history-GCTSFIIC-20250921-20261105.csv");
  assert.equal(C.fileName(null, "2025-09-21T00:00:00Z", "2026-11-06T00:00:00Z"), "stellarscope-history-all-wallets-20250921-20261106.csv");
});

// ── What the page says after a download ─────────────────────────────────────

const day = (d) => ({ date_utc: `${d}T00:00:00Z`, amount: "1.0000000" });

test("one wallet: whole history, history older than Horizon keeps, or cut at a limit", () => {
  assert.equal(C.summary([exported(A, [day("2026-07-08"), day("2026-11-06")])]),
    "Downloaded 2 rows, 2026-07-08 to 2026-11-06. The whole history, from the account's creation.");
  assert.equal(C.summary([exported(A, [day("2025-09-21"), day("2026-11-05")], { startsAtCreation: false })]),
    "Downloaded 2 rows, 2025-09-21 to 2026-11-05. Horizon doesn't keep this wallet's history before 2025-09-21.");
  assert.equal(C.summary([exported(A, [day("2026-11-05")], { complete: false, limit: "row limit", startsAtCreation: false, missingOperations: 1 })]),
    "Downloaded 1 row, 2026-11-05 to 2026-11-05. That's the newest 10,000 rows or so: older history isn't in the file. " +
    "Horizon couldn't list the wallet's operations, so 1 of the rows has no counterparty.");
});

test("all wallets: the rows and dates overall, then each wallet that isn't whole, and any that couldn't be read", () => {
  const results = [
    { ...exported(A, [day("2025-09-21"), day("2026-11-01")], { startsAtCreation: false }), label: "Wave ops" },
    { ...exported(B, [day("2026-10-01"), day("2026-11-06")], { complete: false, limit: "time limit", startsAtCreation: false }), label: "JST" },
    { address: "GBOGVS7QHKU2HJUWIEKFOXJD5ZHXHI5OZJWX2Y4YKOK7PZ6NLBL3RO2G", label: "", error: "Couldn't read the history from Horizon. Try again in a minute." },
  ];
  assert.equal(C.summary(results),
    "Downloaded 4 rows from 2 wallets, 2025-09-21 to 2026-11-06. " +
    "Not the whole history for JST (as far back as it could read in time, from 2026-10-01). " +
    "Horizon doesn't keep older history for Wave ops (from 2025-09-21). " +
    "Not in the file: GBOG…RO2G. Couldn't read the history from Horizon. Try again in a minute.");

  // Every wallet older than Horizon's history: said once.
  assert.equal(C.summary([
    { ...exported(A, [day("2025-09-21")], { startsAtCreation: false }), label: "a" },
    { ...exported(B, [day("2025-09-21")], { startsAtCreation: false }), label: "b" },
  ]), "Downloaded 2 rows from 2 wallets, 2025-09-21 to 2025-09-21. Horizon doesn't keep their history before 2025-09-21.");
});
