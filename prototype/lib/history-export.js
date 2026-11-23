/**
 * A wallet's history, one row per balance change: the rows behind the
 * "Download full history (CSV)" buttons (public/history-csv.js builds the file).
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
 *
 * Each row also has the wallet's balance of that asset right after it
 * (balance_after), counted back from the wallet's balances read once the
 * history has been read, and the result has each asset's balance before the
 * file's first row (its opening balance for the period).
 */

const PAGE_SIZE = 200;
const MAX_ROWS = 10_000;
const MAX_PAGES = 100;
const TIME_LIMIT_MS = 100_000;

// Each row's fields, in the file's order (the file adds the wallet's label).
const COLUMNS = [
  "date_utc", "wallet", "type", "direction", "amount", "asset", "asset_id", "balance_after",
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

// ── Balances ────────────────────────────────────────────────────────────────
// Rows are counted back from the wallet's balances now: the balance after the
// newest row is today's, and each row before it is that less what came after.
// Read once the history has been, so a change landing in between is newer
// than every record read: its asset's running balance is then left out
// rather than wrong.

/** "-12.5" → -125000000n; anything else → null. */
function toStroops(amount) {
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(String(amount));
  if (!m) return null;
  const v = BigInt(m[2]) * STROOPS + BigInt((m[3] || "").padEnd(7, "0"));
  return m[1] ? -v : v;
}

const keyOf = (asset, assetId) => `${asset}\n${assetId}`;
const ledgerOf = (toid) => Number(BigInt(toid) >> 32n);

/** A Horizon account's balances: key → { asset, asset_id, stroops, ledger }. */
function balancesOf(account) {
  const out = new Map();
  for (const b of account.balances || []) {
    const id = b.asset_type === "native" ? { asset: "XLM", asset_id: "native" }
      : b.asset_type === "liquidity_pool_shares" ? poolShares(b.liquidity_pool_id)
        : { asset: b.asset_code, asset_id: b.asset_issuer };
    // XLM sits in the account entry; each trustline has its own.
    const ledger = Number(b.asset_type === "native" ? account.last_modified_ledger : b.last_modified_ledger) || 0;
    out.set(keyOf(id.asset, id.asset_id), { ...id, stroops: toStroops(b.balance), ledger });
  }
  return out;
}

/**
 * Sets each row's balance_after, newest first from `account`'s balances.
 * `newestLedger`: the newest ledger the history read reached. An asset whose
 * balance changed after it gets no running balance ("moved").
 * → { openingBalances: [{ asset, asset_id, balance }], moved: [{ asset, asset_id }] }
 */
function addBalances(rows, account, newestLedger) {
  const now = balancesOf(account);
  const running = new Map(); // key → stroops, or null: unknown
  const moved = new Map();
  const start = (key, id) => {
    const b = now.get(key);
    if (!b) { running.set(key, 0n); return; } // not held now: the trustline is gone
    if (newestLedger > 0 && b.ledger > newestLedger) { moved.set(key, id); running.set(key, null); return; }
    running.set(key, b.stroops);
  };
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const key = keyOf(r.asset, r.asset_id);
    if (!running.has(key)) start(key, { asset: r.asset, asset_id: r.asset_id });
    const bal = running.get(key);
    const amount = toStroops(r.amount);
    r.balance_after = bal === null ? "" : fromStroops(bal);
    running.set(key, bal === null || amount === null ? null : bal - amount);
  }
  // Assets held now with no rows in the file: unchanged over it.
  for (const [key, b] of now) if (!running.has(key)) start(key, { asset: b.asset, asset_id: b.asset_id });
  const openingBalances = [...running].map(([key, v]) => {
    const [asset, asset_id] = key.split("\n");
    return { asset, asset_id, balance: v === null ? "" : fromStroops(v) };
  });
  return { openingBalances, moved: [...moved.values()] };
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
  page, account, maxRows = MAX_ROWS, maxPages = MAX_PAGES, timeLimitMs = TIME_LIMIT_MS, now = Date.now, retryDelayMs = 1000,
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
  // Running balances, from the wallet's balances read now (`account()`:
  // its Horizon account). The newest ledger read is the older of the two
  // streams' newest records: both start at the same moment, but a
  // transaction landing between their first pages is in one only.
  const newest = [
    s.effects.records[0] && ledgerOf(opIdOf(s.effects.records[0])),
    s.transactions.records[0] && ledgerOf(s.transactions.records[0].paging_token),
  ].filter((n) => n > 0);
  let balances = { openingBalances: null, moved: [] };
  const acct = account && !s.effects.notFound ? await Promise.resolve().then(account).catch(() => null) : null;
  if (acct) balances = addBalances(rows, acct, newest.length ? Math.min(...newest) : 0);
  else for (const r of rows) r.balance_after = "";
  // From the account's creation every asset starts at 0: anything else means
  // a change the file doesn't have.
  const openingCheck = complete && s.effects.records.some((e) => e.type === "account_created") && balances.openingBalances
    ? balances.openingBalances.filter((b) => b.balance !== "" && toStroops(b.balance) !== 0n)
    : [];

  return {
    error: s.effects.error || s.transactions.error || null,
    notFound: !!s.effects.notFound,
    rows,
    openingBalances: balances.openingBalances,
    balancesMoved: balances.moved,
    openingCheck,
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

/** Rows as arrays in COLUMNS order, for JSON. */
const asArrays = (rows) => rows.map((r) => COLUMNS.map((c) => r[c]));

module.exports = {
  readHistory, exportHistory, buildRows, asArrays, addBalances, COLUMNS,
  PAGE_SIZE, MAX_ROWS, MAX_PAGES, TIME_LIMIT_MS, _resetForTests,
};
