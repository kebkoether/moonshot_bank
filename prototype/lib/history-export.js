/**
 * A wallet's history as a CSV file: one row per balance change.
 *
 * The rows come from Horizon:
 * - effects: every credit and debit of the wallet (payments, swaps, DEX
 *   trades, pool deposits and withdrawals, claimed balances, Stellar Asset
 *   Contract transfers from DeFi contracts, account creation and merges);
 * - transactions (failed ones too): the network fee, for each transaction the
 *   wallet paid the fee on;
 * - operations: the counterparty and transaction hash for each change.
 *
 * Summed per asset, the rows give the change in the wallet's balance over the
 * period. Not included: tokens that exist only as Soroban contracts (Horizon
 * doesn't track them, and neither do the wallet's Horizon balances), and
 * anything older than Horizon keeps (SDF's public Horizon keeps about a year).
 *
 * Newest first, until the start of the history or a limit: 10,000 rows, 100
 * pages of each kind, or 100 seconds. A limit cuts the file at a whole
 * transaction, and the result says so.
 */

const PAGE_SIZE = 200;
const MAX_ROWS = 10_000;
const MAX_PAGES = 100;
const TIME_LIMIT_MS = 100_000;

const COLUMNS = [
  "date_utc", "wallet", "type", "direction", "amount", "asset", "asset_id",
  "counterparty", "operation_type", "memo", "transaction_hash", "operation_id", "notes",
];

// ── Ids ─────────────────────────────────────────────────────────────────────
// Horizon ids are TOIDs: ledger << 32 | transaction order << 12 | operation
// index. A transaction's id has operation index 0; its operations count from 1.

const opIdOf = (effect) => String(effect.paging_token).split("-")[0];
const txIdOf = (opOrTxId) => BigInt(opOrTxId) & ~0xfffn;

// ── Amounts and assets ──────────────────────────────────────────────────────

const STROOPS = 10_000_000n;

/** 1234500n → "0.1234500" */
function fromStroops(n) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "-" : ""}${a / STROOPS}.${String(a % STROOPS).padStart(7, "0")}`;
}

/** "-" in front of a positive amount string; "0.0000000" stays as it is. */
const negate = (amount) => (/^0(\.0*)?$/.test(String(amount)) ? String(amount) : `-${amount}`);

/** From effect fields: native → XLM; otherwise code and issuer. `prefix` is "sold_" or "bought_" on trades. */
function assetOf(e, prefix = "") {
  if (e[`${prefix}asset_type`] === "native") return { asset: "XLM", asset_id: "native" };
  return { asset: e[`${prefix}asset_code`] || "", asset_id: e[`${prefix}asset_issuer`] || "" };
}

/** From a canonical asset string: "native" or "CODE:ISSUER". */
function assetFromCanonical(s) {
  if (!s || s === "native") return { asset: "XLM", asset_id: "native" };
  const [code, issuer] = String(s).split(":");
  return { asset: code, asset_id: issuer || "" };
}

const poolShares = (poolId) => ({ asset: "pool shares", asset_id: poolId || "" });

// ── Rows ────────────────────────────────────────────────────────────────────

const TYPES = {
  payment: "payment",
  create_account: "account funding",
  account_merge: "account merge",
  manage_sell_offer: "trade",
  manage_buy_offer: "trade",
  create_passive_sell_offer: "trade",
  liquidity_pool_deposit: "pool deposit",
  liquidity_pool_withdraw: "pool withdrawal",
  claim_claimable_balance: "claimable balance claimed",
  create_claimable_balance: "claimable balance created",
  clawback: "clawback",
  invoke_host_function: "contract call",
  inflation: "inflation",
  allow_trust: "pool shares revoked",
  set_trust_line_flags: "pool shares revoked",
};

function typeOf(op, effect) {
  if (op) {
    if (op.type.startsWith("path_payment")) return op.from === op.to ? "swap" : "path payment";
    return TYPES[op.type] || op.type.replace(/_/g, " ");
  }
  // No operation: another account's (an offer of this wallet's filled, most
  // often), or Horizon couldn't list the wallet's operations.
  return EFFECT_TYPES[effect.type] || effect.type.replace(/_/g, " ");
}

const NO_OPERATION_LISTED = "operation details unavailable from Horizon";

const EFFECT_TYPES = {
  trade: "trade",
  liquidity_pool_trade: "trade",
  account_credited: "transfer",
  account_debited: "transfer",
  account_created: "account funding",
  liquidity_pool_deposited: "pool deposit",
  liquidity_pool_withdrew: "pool withdrawal",
  liquidity_pool_revoked: "pool shares revoked",
};

/** The other side of a credit (`incoming`) or debit, from the operation. */
function counterpartyOf(op, effect, address, incoming, leg) {
  if (effect.type === "trade") return effect.seller || "";
  if (effect.liquidity_pool) return effect.liquidity_pool.id || "";
  if (!op) return "";
  switch (op.type) {
    case "payment":
      return incoming ? op.from : op.to;
    case "path_payment_strict_receive":
    case "path_payment_strict_send":
      return op.from === op.to ? "" : incoming ? op.from : op.to;
    case "create_account":
      return incoming ? op.funder : op.account;
    case "account_merge":
      return incoming ? op.account : op.into;
    case "invoke_host_function": {
      // The matching transfer in the contract call's balance changes.
      const amount = leg.amount.replace(/^-/, "");
      const change = (op.asset_balance_changes || []).find((c) =>
        (incoming ? c.to === address : c.from === address) && c.amount === amount &&
        assetOf(c).asset === leg.asset && assetOf(c).asset_id === leg.asset_id);
      return change ? (incoming ? change.from : change.to) || "" : "";
    }
    default:
      return op.source_account && op.source_account !== address ? op.source_account : "";
  }
}

/**
 * The balance changes in one effect: [{ amount (signed), asset, asset_id, notes }].
 * `insidePathPayment`: the wallet sent a path payment in this operation, so
 * its trade effects are the payment's own fills, already counted by its
 * debit and credit.
 */
function legsOf(e, insidePathPayment) {
  switch (e.type) {
    case "account_credited":
      return [{ amount: e.amount, ...assetOf(e) }];
    case "account_debited":
      return [{ amount: negate(e.amount), ...assetOf(e) }];
    case "account_created":
      return [{ amount: e.starting_balance, asset: "XLM", asset_id: "native" }];
    case "trade":
      if (insidePathPayment) return [];
      return [
        { amount: negate(e.sold_amount), ...assetOf(e, "sold_"), notes: e.offer_id ? `offer ${e.offer_id}` : "" },
        { amount: e.bought_amount, ...assetOf(e, "bought_"), notes: e.offer_id ? `offer ${e.offer_id}` : "" },
      ];
    case "liquidity_pool_trade":
      // sold and bought are the pool's: what it sold, the wallet received.
      if (insidePathPayment) return [];
      return [
        { amount: negate(e.bought.amount), ...assetFromCanonical(e.bought.asset), notes: "against a liquidity pool" },
        { amount: e.sold.amount, ...assetFromCanonical(e.sold.asset), notes: "against a liquidity pool" },
      ];
    case "liquidity_pool_deposited":
      return [
        ...(e.reserves_deposited || []).map((r) => ({ amount: negate(r.amount), ...assetFromCanonical(r.asset) })),
        { amount: e.shares_received, ...poolShares(e.liquidity_pool?.id) },
      ];
    case "liquidity_pool_withdrew":
      return [
        { amount: negate(e.shares_redeemed), ...poolShares(e.liquidity_pool?.id) },
        ...(e.reserves_received || []).map((r) => ({ amount: r.amount, ...assetFromCanonical(r.asset) })),
      ];
    case "liquidity_pool_revoked":
      return [{ amount: negate(e.shares_revoked), ...poolShares(e.liquidity_pool?.id), notes: "the pool's assets went to claimable balances" }];
    default:
      return []; // no balance change: trustlines, signers, offers, sponsorships…
  }
}

/** How many rows these effects make (for the row limit while reading). */
function rowCount(effects) {
  const debitedIn = new Set(effects.filter((e) => e.type === "account_debited").map(opIdOf));
  return effects.reduce((n, e) => n + legsOf(e, debitedIn.has(opIdOf(e))).length, 0);
}

function memoOf(tx) {
  if (!tx || !tx.memo_type || tx.memo_type === "none") return "";
  return tx.memo == null ? "" : String(tx.memo);
}

/**
 * Rows from what was read. `floor`: transactions with a lower id are left out
 * (the cut when a limit stopped the reading).
 */
function buildRows(address, { effects, operations, transactions }, floor = 0n, { opsComplete = true } = {}) {
  const noOp = opsComplete ? "another account's operation" : NO_OPERATION_LISTED;
  const ops = new Map(operations.map((o) => [String(o.id), o]));
  const txs = new Map(transactions.map((t) => [txIdOf(t.paging_token), t]));

  // Operations in which the wallet was debited: its trade effects there are a
  // path payment's fills. (A path payment can't cross its sender's own offers.)
  const debitedIn = new Set(effects.filter((e) => e.type === "account_debited").map(opIdOf));

  const rows = [];
  for (const e of effects) {
    const opId = opIdOf(e);
    const txId = txIdOf(opId);
    if (txId < floor) continue;
    const op = ops.get(opId);
    const tx = txs.get(txId);
    const index = Number(String(e.paging_token).split("-")[1] || 0);
    legsOf(e, debitedIn.has(opId)).forEach((leg, i) => {
      const incoming = !leg.amount.startsWith("-");
      rows.push({
        sort: [txId, BigInt(opId), index, i],
        date_utc: e.created_at,
        wallet: address,
        type: typeOf(op, e),
        direction: incoming ? "in" : "out",
        amount: leg.amount,
        asset: leg.asset,
        asset_id: leg.asset_id,
        counterparty: counterpartyOf(op, e, address, incoming, leg),
        operation_type: op ? op.type : "",
        memo: memoOf(tx),
        transaction_hash: (op && op.transaction_hash) || (tx && tx.hash) || "",
        operation_id: opId,
        notes: [leg.notes, op ? "" : noOp].filter(Boolean).join("; "),
      });
    });
  }

  // Network fees, on the transactions this wallet paid for (failed ones too).
  for (const [txId, tx] of txs) {
    if (txId < floor) continue;
    if ((tx.fee_account || tx.source_account) !== address) continue;
    const fee = BigInt(tx.fee_charged || 0);
    if (fee === 0n) continue;
    const notes = [];
    if (tx.successful === false) notes.push("failed transaction: only the fee was charged");
    if (tx.fee_account && tx.source_account && tx.source_account !== address) notes.push(`fee paid for ${tx.source_account}`);
    rows.push({
      sort: [txId, 0n, -1, 0], // charged before the transaction's operations run
      date_utc: tx.created_at,
      wallet: address,
      type: "network fee",
      direction: "out",
      amount: fromStroops(-fee),
      asset: "XLM",
      asset_id: "native",
      counterparty: "",
      operation_type: "",
      memo: memoOf(tx),
      transaction_hash: tx.hash || "",
      operation_id: "",
      notes: notes.join("; "),
    });
  }

  rows.sort((a, b) => {
    for (let i = 0; i < 4; i++) {
      if (a.sort[i] !== b.sort[i]) return a.sort[i] < b.sort[i] ? -1 : 1;
    }
    return 0;
  });
  return rows;
}

// ── Reading ─────────────────────────────────────────────────────────────────

const OUT_OF_TIME = Symbol("out of time");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNotFound = (e) => e?.response?.status === 404 || e?.status === 404 || e?.name === "NotFoundError";

function byDeadline(promise, deadline, now) {
  const ms = deadline - now();
  if (ms <= 0) { promise.catch(() => {}); return Promise.resolve(OUT_OF_TIME); }
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(OUT_OF_TIME), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Read the wallet's effects, operations and transactions, newest first.
 * `page(kind, cursor)` returns up to PAGE_SIZE records of "effects",
 * "operations" or "transactions", newest first (failed transactions too).
 *
 * → { rows, complete, limit, from, to, startsAtCreation, missingOperations, notFound, error }
 *   complete: everything Horizon has; otherwise `limit` says what stopped it
 *   ("row limit", "page limit", "time limit" or "Horizon error").
 *   startsAtCreation: the history goes back to the account's creation
 *   (false when Horizon's history starts later).
 *   notFound: Horizon doesn't know the account.
 */
async function readHistory(address, {
  page, maxRows = MAX_ROWS, maxPages = MAX_PAGES, timeLimitMs = TIME_LIMIT_MS, now = Date.now, retryDelayMs = 1000,
}) {
  const deadline = now() + timeLimitMs;
  const stream = () => ({ records: [], cursor: null, done: false, stopped: null, pages: 0, oldestTx: null, reachedFloor: false });
  const s = { effects: stream(), operations: stream(), transactions: stream() };
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
  const effectsProgress = () => new Promise((r) => waiters.push(r));

  async function readPage(kind) {
    const st = s[kind];
    if (st.pages >= maxPages) { st.stopped = "page limit"; return; }
    let got;
    for (let attempt = 0; ; attempt++) {
      try {
        got = await byDeadline(Promise.resolve().then(() => page(kind, st.cursor)), deadline, now);
        break;
      } catch (e) {
        // No such account: Horizon has no history for it.
        if (isNotFound(e)) { st.done = true; st.notFound = true; return; }
        // Horizon answers 503 or times out now and then: try twice more.
        if (attempt >= 2) { st.stopped = "Horizon error"; st.error = e; return; }
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
    if (got === OUT_OF_TIME) { st.stopped = "time limit"; return; }
    st.pages++;
    const records = got || [];
    st.records.push(...records);
    if (records.length) {
      const last = records[records.length - 1];
      st.cursor = last.paging_token;
      st.oldestTx = txIdOf(kind === "effects" ? opIdOf(last) : kind === "operations" ? last.id : last.paging_token);
    }
    if (records.length < PAGE_SIZE) st.done = true;
  }

  // The lowest transaction id fully read: everything from it on is complete.
  function floorOf(kind) {
    const st = s[kind];
    if (st.done || st.reachedFloor) return 0n;
    if (st.oldestTx === null) return null; // nothing read
    // A transaction's effects or operations can run across pages: leave out the oldest one.
    return kind === "transactions" ? st.oldestTx : st.oldestTx + 1n;
  }
  const effectsFinished = () => s.effects.done || s.effects.stopped;

  // Each kind stops at the row limit on its own rows: the effects' (an upper
  // bound as they come in, as a path payment's fills make no rows; counted
  // exactly at the limit) and the fees'. Together they're cut to the limit
  // at the end.
  let effectRows = 0;
  let feeRows = 0;
  const paysFee = (t) => (t.fee_account || t.source_account) === address && BigInt(t.fee_charged || 0) > 0n;

  async function readEffects() {
    try {
      while (!s.effects.done && !s.effects.stopped) {
        if (effectRows >= maxRows && (effectRows = rowCount(s.effects.records)) >= maxRows) { s.effects.stopped = "row limit"; break; }
        const before = s.effects.records.length;
        await readPage("effects");
        effectRows += s.effects.records.slice(before).reduce((n, e) => n + legsOf(e, false).length, 0);
        wake();
      }
    } finally {
      wake();
    }
  }

  async function follow(kind) {
    const st = s[kind];
    while (!st.done && !st.stopped) {
      // Don't read further back than the effects have got to.
      while (!effectsFinished() && st.oldestTx !== null && s.effects.oldestTx !== null && st.oldestTx < s.effects.oldestTx) {
        await effectsProgress();
      }
      if (effectsFinished()) {
        const floor = floorOf("effects");
        if (floor === null) break;
        if (st.oldestTx !== null && st.oldestTx < floor) { st.reachedFloor = true; break; }
      }
      // A bot's failed transactions are mostly fees: past the limit on those
      // alone, nothing older can be in the file, so the effects stop too.
      if (kind === "transactions" && feeRows >= maxRows) {
        st.stopped = "row limit";
        if (!effectsFinished()) s.effects.stopped = "row limit";
        break;
      }
      const before = st.records.length;
      await readPage(kind);
      if (kind === "transactions") feeRows += st.records.slice(before).filter(paysFee).length;
    }
  }

  await Promise.all([readEffects(), follow("operations"), follow("transactions")]);

  // Where the file starts: the effects' and the fees' reading both reached it.
  const effectsFloor = floorOf("effects");
  const txFloor = floorOf("transactions");
  const floor = effectsFloor === null || txFloor === null ? null : (effectsFloor > txFloor ? effectsFloor : txFloor);
  let rows = floor === null ? [] : buildRows(address, {
    effects: s.effects.records, operations: s.operations.records, transactions: s.transactions.records,
  }, floor, { opsComplete: !!(s.operations.done || s.operations.reachedFloor) });
  let complete = floor === 0n;
  let limit = complete ? null
    : s.effects.stopped || s.transactions.stopped || s.operations.stopped || "limit";
  // The newest MAX_ROWS or so, from the start of a transaction.
  if (rows.length > maxRows) {
    const cut = rows[rows.length - maxRows].sort[0];
    rows = rows.filter((r) => r.sort[0] >= cut);
    complete = false;
    limit = "row limit";
  }
  return {
    error: s.effects.error || s.transactions.error || null,
    notFound: !!s.effects.notFound,
    rows,
    complete,
    limit,
    from: rows.length ? rows[0].date_utc : null,
    to: rows.length ? rows[rows.length - 1].date_utc : null,
    startsAtCreation: complete && s.effects.records.some((e) => e.type === "account_created"),
    // Rows without their operation because Horizon couldn't list the
    // wallet's operations: no counterparty, a plainer type.
    missingOperations: rows.filter((r) => r.notes.includes(NO_OPERATION_LISTED)).length,
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** A text cell: never the start of a formula (=, +, -, @, tab, CR). Amounts are numbers, not text. */
function text(v) {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function quote(cell) {
  const s = String(cell);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const lines = [COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(COLUMNS.map((c) => quote(c === "amount" ? r.amount : text(r[c]))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function fileName(address, from, to) {
  const d = (iso) => (iso ? String(iso).slice(0, 10).replace(/-/g, "") : "none");
  return `stellarscope-history-${address.slice(0, 8)}-${d(from)}-${d(to)}.csv`;
}

// ── One export at a time per wallet, two at most, kept for 5 minutes ───────

const CACHE_MS = 5 * 60_000;
const MAX_RUNNING = 2;
const cache = new Map(); // address → { at, result }
const running = new Map(); // address → promise

/**
 * readHistory for the server: a second request for the same wallet shares the
 * first's reading, a recent result is reused, and at most MAX_RUNNING wallets
 * are read at once (more → an error with .busy set).
 */
function exportHistory(address, opts) {
  const now = opts.now || Date.now;
  const hit = cache.get(address);
  if (hit && now() - hit.at < CACHE_MS) return Promise.resolve(hit.result);
  if (running.has(address)) return running.get(address);
  if (running.size >= MAX_RUNNING) {
    const err = new Error("Other history exports are running. Try again in a minute.");
    err.busy = true;
    return Promise.reject(err);
  }
  const p = readHistory(address, opts)
    .then((result) => {
      cache.set(address, { at: now(), result });
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return result;
    })
    .finally(() => running.delete(address));
  running.set(address, p);
  return p;
}

function _resetForTests() {
  cache.clear();
  running.clear();
}

module.exports = {
  readHistory, exportHistory, buildRows, toCsv, fileName, COLUMNS,
  PAGE_SIZE, MAX_ROWS, MAX_PAGES, TIME_LIMIT_MS, _resetForTests,
};
