/**
 * History CSV: a wallet's balance changes, or every saved wallet's, as one
 * file (the "Download full history" buttons in index.html). The server reads
 * the rows from Horizon (lib/history-export.js, GET
 * /api/v1/account/:address/history/export); this builds the file from them.
 *
 * - One row per balance change, oldest first: amount signed (+ in, − out).
 * - wallet and label on every row, so files from several wallets combine.
 *   Labels are the browser's own (the saved wallet list).
 * - Labels, memos and token codes come from users and chains, so a text cell
 *   can't start a spreadsheet formula.
 *
 * Plain script, no dependencies: the page loads it with <script src>, and the
 * tests require() it.
 */
(function (root) {
  // The server's columns, with label after wallet.
  const COLUMNS = [
    "date_utc", "wallet", "label", "type", "direction", "amount", "asset", "asset_id",
    "counterparty", "operation_type", "memo", "transaction_hash", "operation_id", "notes",
  ];

  /** A text cell: never the start of a formula (=, +, -, @, tab, CR). */
  function text(v) {
    const s = v == null ? "" : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function quote(cell) {
    const s = String(cell);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * One wallet's export from the server ({ columns, rows: [[...]] }) as row
   * objects, with its label.
   */
  function rowsOf(wallet) {
    const cols = wallet.columns || [];
    return (wallet.rows || []).map((r) => {
      const o = { label: wallet.label || "" };
      cols.forEach((c, i) => { o[c] = r[i]; });
      return o;
    });
  }

  /**
   * The CSV for one or more wallets' exports: [{ label?, columns, rows }].
   * Oldest first across wallets; each wallet's rows keep their order.
   */
  function build(wallets) {
    const rows = [];
    for (const w of wallets) if (w && w.rows) rows.push(...rowsOf(w));
    // Stable: rows of one wallet at the same second stay in order.
    rows.sort((a, b) => (a.date_utc < b.date_utc ? -1 : a.date_utc > b.date_utc ? 1 : 0));
    const lines = [COLUMNS.join(",")];
    for (const r of rows) {
      lines.push(COLUMNS.map((c) => quote(c === "amount" ? (r.amount == null ? "" : r.amount) : text(r[c]))).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  function fileName(address, from, to) {
    const d = (iso) => (iso ? String(iso).slice(0, 10).replace(/-/g, "") : "none");
    return `stellarscope-history-${address ? address.slice(0, 8) : "all-wallets"}-${d(from)}-${d(to)}.csv`;
  }

  const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
  const nameOf = (w) => w.label || `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
  const n = (x) => Number(x).toLocaleString("en-US");

  /**
   * What the page says after a download. `results`: one per wallet, either
   * the server's export ({ address, label, rows, complete, limit, from, to,
   * startsAtCreation, missingOperations }) or { address, label, error }.
   */
  function summary(results) {
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const rows = ok.reduce((t, r) => t + (r.rows ? r.rows.length : 0), 0);
    const froms = ok.map((r) => r.from).filter(Boolean).sort();
    const tos = ok.map((r) => r.to).filter(Boolean).sort();
    const range = rows ? `, ${day(froms[0])} to ${day(tos[tos.length - 1])}` : "";
    const single = results.length === 1;
    const parts = [`Downloaded ${n(rows)} row${rows === 1 ? "" : "s"}${single ? "" : ` from ${n(ok.length)} wallet${ok.length === 1 ? "" : "s"}`}${range}.`];

    const cut = ok.filter((r) => !r.complete && r.rows && r.rows.length);
    const why = (r) => (r.limit === "row limit" ? "the newest 10,000 rows or so"
      : r.limit === "Horizon error" ? "Horizon stopped answering partway"
        : "as far back as it could read in time");
    if (single && cut.length) {
      parts.push(`That's ${why(cut[0])}: older history isn't in the file.`);
    } else if (cut.length) {
      parts.push(`Not the whole history for ${cut.map((r) => `${nameOf(r)} (${why(r)}, from ${day(r.from)})`).join("; ")}.`);
    }

    const late = ok.filter((r) => r.complete && !r.startsAtCreation && r.rows && r.rows.length);
    if (single && ok.length && ok[0].complete && ok[0].rows && ok[0].rows.length) {
      parts.push(ok[0].startsAtCreation ? "The whole history, from the account's creation."
        : `Horizon doesn't keep this wallet's history before ${day(ok[0].from)}.`);
    } else if (late.length) {
      const starts = [...new Set(late.map((r) => day(r.from)))];
      parts.push(late.length === ok.length && starts.length === 1
        ? `Horizon doesn't keep their history before ${starts[0]}.`
        : `Horizon doesn't keep older history for ${late.map((r) => `${nameOf(r)} (from ${day(r.from)})`).join(", ")}.`);
    }

    const missing = ok.filter((r) => r.missingOperations > 0);
    for (const r of missing) {
      const m = r.missingOperations;
      parts.push(`Horizon couldn't list ${single ? "the wallet's" : `${nameOf(r)}'s`} operations, so ${n(m)} of ${single ? "the" : "its"} rows ${m === 1 ? "has" : "have"} no counterparty.`);
    }
    if (failed.length) {
      for (const r of failed) parts.push(`Not in the file: ${nameOf(r)}. ${r.error}`);
    }
    return parts.join(" ");
  }

  const HistoryCsv = { build, fileName, summary, COLUMNS };
  if (typeof module !== "undefined" && module.exports) module.exports = HistoryCsv;
  else root.HistoryCsv = HistoryCsv;
})(typeof window !== "undefined" ? window : this);
