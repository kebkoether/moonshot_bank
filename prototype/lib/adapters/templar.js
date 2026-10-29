/**
 * Templar Finance Adapter for Stellar
 *
 * Templar's Stellar deployment uses TWO custody surfaces:
 *   - GDJ4...QBJK (classic G-address): receives collateral deposits as classic
 *     Stellar payments (e.g. 100 XLM deposit shows up as a `payment` op).
 *   - CCLW...UVAG (Soroban contract):  disburses borrowed assets as SAC token
 *     transfers (e.g. 2 USDC borrow arrives via `invoke_host_function`).
 *
 * The actual lending logic — interest accrual, health factor, liquidation —
 * runs off-Stellar on NEAR via Chain Signatures / MPC. So this adapter only
 * sees the on-chain principal of each leg, not live debt or accrued yield.
 *
 * It reads the wallet's /payments history (payments, plus the
 * invoke_host_function ops whose asset_balance_changes carry SAC transfers)
 * and nets every flow between the wallet and either custody address:
 *   - classic `payment` ops to/from the G-address  → collateral transfers
 *   - SAC transfers to/from the contract or G-address → borrow / repay
 *
 * Reading the history:
 *   - Only back to Templar's launch: no record older than the G-address's
 *     first operation (11 Sep 2025) can involve Templar.
 *   - /payments, not /operations: it skips offers, trustlines and the rest,
 *     and Horizon answers it several times faster (60 pages of a busy wallet:
 *     3.8 s vs 23.7 s).
 *   - In parallel: after the first page, the rest of the history back to the
 *     launch is split into SEGMENTS ledger ranges read side by side, so a
 *     busy wallet's history takes a fraction of the time.
 *   - Incrementally: what has been read is kept per wallet (the netted flows,
 *     the newest record seen, and where each segment got to), so a later load
 *     only asks Horizon for records newer than the last one. A scan the server
 *     stops waiting for (its 8 s adapter budget) carries on in the background
 *     and the next load picks it up, instead of starting over and timing out
 *     again.
 *   - At most MAX_PAGES pages per wallet. A wallet with more history than that
 *     gets its position marked `incomplete` rather than silently netting only
 *     the recent part (the old scan stopped after 20 pages of /operations and
 *     presented whatever it had as the position).
 *
 * Output: ONE position per active Templar account. When both a collateral
 * deposit and a borrow disbursement are detected, the position renders as a
 * lending position with both legs visible.
 *
 * Honest limitations (all need a NEAR-side query to fix):
 *   - Principal only — no accrued interest on either leg (yield.accrued null)
 *   - No health factor / liquidation buffer
 *   - No borrow APR
 *   - Multi-collateral / multi-borrow positions show only the primary
 *     (largest-USD) asset of each side; the rest are summed into its USD total
 *
 * Adding new custody addresses: append to TEMPLAR_G_ADDRESSES (classic) or
 * TEMPLAR_C_ADDRESSES (Soroban contract).
 */

const pricing = require("../pricing-engine");

const TEMPLAR_G_ADDRESSES = new Set([
  "GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK",
]);

const TEMPLAR_C_ADDRESSES = new Set([
  "CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG",
]);

const HORIZON_BASE = process.env.HORIZON_URL || "https://horizon.stellar.org";

// The id of the G-address's first operation (ledger 58879169, 11 Sep 2025).
// History older than this cannot involve Templar.
const TEMPLAR_FIRST_OP = 252884105270833153n;

const PAGE_SIZE = 200;
// Most pages of history read for one wallet (60,000 records). The busiest
// Templar depositor seen had 15,915 since launch (80 pages).
const MAX_PAGES = 300;
const SEGMENTS = 8;
// A wallet's history is re-checked for new records at most this often.
const REFRESH_MS = 30_000;
const MAX_WALLETS = 2000;
const FETCH_TIMEOUT_MS = 10_000;

// wallet → { flows, newest, segments, complete, pages, refreshedAt, inFlight }
const _wallets = new Map();

async function _fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function _page(user, order, cursor) {
  const url = `${HORIZON_BASE}/accounts/${user}/payments?order=${order}&limit=${PAGE_SIZE}` +
    `&include_failed=false${cursor ? `&cursor=${cursor}` : ""}`;
  const data = await _fetchJson(url);
  return data?._embedded?.records || [];
}

/** "123.4500000" → 1234500000n (stroops), so sums are exact. */
function _stroops(amount) {
  const [whole, frac = ""] = String(amount || "0").split(".");
  return BigInt(whole || "0") * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
}

function _flow(flows, code, issuer) {
  const key = `${code}:${issuer || "native"}`;
  if (!flows.has(key)) flows.set(key, { code, issuer, sent: 0n, received: 0n });
  return flows.get(key);
}

/** Add one /payments record's flows between `user` and Templar. */
function _apply(flows, user, op) {
  if (op.type === "payment") {
    const isToTemplar = TEMPLAR_G_ADDRESSES.has(op.to);
    const isFromTemplar = TEMPLAR_G_ADDRESSES.has(op.from);
    if (!isToTemplar && !isFromTemplar) return;
    const amount = _stroops(op.amount);
    if (amount <= 0n) return;
    const native = op.asset_type === "native";
    const f = _flow(flows, native ? "XLM" : op.asset_code, native ? null : op.asset_issuer);
    if (isToTemplar && op.from === user) f.sent += amount;
    else if (isFromTemplar && op.to === user) f.received += amount;
  } else if (op.type === "invoke_host_function") {
    for (const change of op.asset_balance_changes || []) {
      if (change.type !== "transfer") continue;
      const { from, to } = change;
      const isToTemplar = TEMPLAR_C_ADDRESSES.has(to) || TEMPLAR_G_ADDRESSES.has(to);
      const isFromTemplar = TEMPLAR_C_ADDRESSES.has(from) || TEMPLAR_G_ADDRESSES.has(from);
      if (!isToTemplar && !isFromTemplar) continue;
      if (from !== user && to !== user) continue;
      const amount = _stroops(change.amount);
      if (amount <= 0n) continue;
      const native = change.asset_type === "native";
      const f = _flow(flows, native ? "XLM" : change.asset_code, native ? null : change.asset_issuer);
      if (isToTemplar && from === user) f.sent += amount;
      else if (isFromTemplar && to === user) f.received += amount;
    }
  }
}

/**
 * Read one stretch of history, newest first: records below `seg.next` down to
 * (and including) `seg.lower`. Progress is kept in `seg`, so an interrupted
 * stretch resumes where it stopped.
 */
async function _readSegment(user, w, seg) {
  while (!seg.done && w.pages < MAX_PAGES) {
    w.pages++;
    const records = await _page(user, "desc", seg.next);
    for (const op of records) {
      if (BigInt(op.paging_token) < seg.lower) { seg.done = true; break; }
      _apply(w.flows, user, op);
      seg.next = op.paging_token;
    }
    if (records.length < PAGE_SIZE) seg.done = true;
  }
}

async function _scan(user, w) {
  // 1. Records newer than the newest one already read.
  if (w.newest) {
    for (let i = 0; i < MAX_PAGES; i++) {
      const records = await _page(user, "asc", w.newest);
      for (const op of records) _apply(w.flows, user, op);
      if (records.length) w.newest = records[records.length - 1].paging_token;
      if (records.length < PAGE_SIZE) break;
    }
  }

  // 2. First load: the newest page tells whether there is more history.
  if (!w.segments) {
    const top = { next: null, lower: TEMPLAR_FIRST_OP, done: false };
    w.pages++;
    const records = await _page(user, "desc", null);
    if (records.length) w.newest = records[0].paging_token;
    for (const op of records) {
      if (BigInt(op.paging_token) < top.lower) { top.done = true; break; }
      _apply(w.flows, user, op);
      top.next = op.paging_token;
    }
    if (records.length < PAGE_SIZE) top.done = true;
    w.segments = [];
    if (!top.done) {
      // Split what's left, back to the launch, into ledger ranges. An
      // operation id is (ledger << 32) | ..., so ledger L starts at L << 32.
      const low = TEMPLAR_FIRST_OP >> 32n;
      const high = BigInt(top.next) >> 32n;
      const n = BigInt(SEGMENTS);
      for (let i = 0n; i < n; i++) {
        const lower = i === 0n ? TEMPLAR_FIRST_OP : (low + ((high - low) * i) / n) << 32n;
        const next = i === n - 1n ? top.next : String((low + ((high - low) * (i + 1n)) / n) << 32n);
        if (BigInt(next) > lower) w.segments.push({ next, lower, done: false });
      }
    }
  }

  // A wallet with no records yet: look again next time.
  if (!w.newest) w.segments = null;

  // 3. Older history, the segments side by side.
  const segments = w.segments || [];
  const results = await Promise.allSettled(
    segments.filter((seg) => !seg.done).map((seg) => _readSegment(user, w, seg))
  );
  w.complete = segments.every((seg) => seg.done);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  w.refreshedAt = Date.now();
}

/** The wallet's netted Templar flows, read or brought up to date. */
async function _walletFlows(user) {
  let w = _wallets.get(user);
  if (w) {
    _wallets.delete(user); // most recently used goes last
  } else {
    w = { flows: new Map(), newest: null, segments: null, complete: false, pages: 0, refreshedAt: 0, inFlight: null };
  }
  _wallets.set(user, w);
  while (_wallets.size > MAX_WALLETS) _wallets.delete(_wallets.keys().next().value);

  const olderPending = !w.complete && w.pages < MAX_PAGES;
  const fresh = !olderPending && Date.now() - w.refreshedAt < REFRESH_MS;
  if (!fresh && !w.inFlight) {
    w.inFlight = _scan(user, w).finally(() => { w.inFlight = null; });
  }
  if (w.inFlight) await w.inFlight;
  return w;
}

async function _priceUSD(code, issuer, priceCtx) {
  if (code === "XLM" && !issuer) return priceCtx?.xlmPrice?.usd || 0;
  const p = await pricing.priceClassicAsset(null, code, issuer);
  return p && p.usd > 0 ? p.usd : 0;
}

function _fmt(amount) {
  return amount.toFixed(amount < 1 ? 6 : 2);
}

const TemplarAdapter = {
  protocolId: "templar",
  name: "Templar Finance",
  type: "lending",

  isConfigured() {
    return TEMPLAR_G_ADDRESSES.size > 0 || TEMPLAR_C_ADDRESSES.size > 0;
  },

  async getPositions(userAddress, priceCtx) {
    if (!this.isConfigured()) return [];

    // Horizon errors propagate: the server then serves this adapter's last
    // good result (or marks it degraded) instead of a half-read position.
    const w = await _walletFlows(userAddress);

    // Split per-asset nets into collateral (net flow into Templar) and
    // borrows (net flow out to user without prior matching deposit).
    const collateral = [];
    const borrows = [];
    for (const [, f] of w.flows) {
      const net = f.sent - f.received;
      if (net === 0n) continue;
      const amount = Number(net < 0n ? -net : net) / 1e7;
      const usd = amount * await _priceUSD(f.code, f.issuer, priceCtx);
      (net > 0n ? collateral : borrows).push({ code: f.code, amount, usd });
    }

    if (collateral.length === 0 && borrows.length === 0) return [];

    // Sort by USD so the primary asset of each side is well-defined; the
    // remaining same-side assets are summed into the totals but only the
    // primary asset is rendered as the label (UI limitation we accept).
    collateral.sort((a, b) => b.usd - a.usd);
    borrows.sort((a, b) => b.usd - a.usd);
    const primaryCol = collateral[0] || null;
    const primaryBor = borrows[0] || null;
    const collateralUSD = collateral.reduce((s, c) => s + c.usd, 0);
    const borrowUSD = borrows.reduce((s, b) => s + b.usd, 0);

    const position = {
      protocol: "templar",
      type: "vault",
      contractId: null,
      vaultName: primaryBor && primaryCol
        ? "Templar lending position"
        : `Templar ${(primaryCol || primaryBor).code} deposit`,
      receiptSymbol: (primaryCol || primaryBor).code,
      deposited: primaryCol ? {
        amount: _fmt(primaryCol.amount),
        asset: primaryCol.code,
      } : null,
      yield: {
        accrued: null, // principal only: interest lives on NEAR
        asset: (primaryCol || primaryBor).code,
        apy: null,
      },
      valueUSD: collateralUSD - borrowUSD,
    };

    if (primaryBor) {
      position.borrow = {
        amount: _fmt(primaryBor.amount),
        asset: primaryBor.code,
        valueUSD: borrowUSD,
      };
    }
    if (!w.complete) position.incomplete = true;

    return [position];
  },
};

function _resetForTests() {
  _wallets.clear();
}

module.exports = TemplarAdapter;
module.exports._resetForTests = _resetForTests;
