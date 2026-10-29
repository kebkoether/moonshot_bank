/**
 * Background Snapshot Scheduler
 *
 * Periodically polls all tracked wallets and records portfolio snapshots.
 * This is the engine behind historical portfolio tracking — it runs even
 * when no one is viewing the dashboard.
 *
 * Tier-aware: premium wallets get more frequent snapshots.
 */
const historyDb = require("./history-db");

// Horizon + pricing functions are injected from server.js to avoid circular deps
let _fetchPortfolio = null;

/**
 * Initialize the scheduler with a portfolio-fetching function.
 * @param {Function} fetchPortfolioFn - async (address, network) => portfolioData
 */
function init(fetchPortfolioFn) {
  _fetchPortfolio = fetchPortfolioFn;
}

// ── Tier-based intervals ────────────────────────────────────────────────────

const TIER_INTERVALS = {
  free:    60 * 60 * 1000,   // 1 hour
  basic:   30 * 60 * 1000,   // 30 minutes
  pro:     15 * 60 * 1000,   // 15 minutes
  premium:  5 * 60 * 1000,   //  5 minutes
};

const DEFAULT_TICK_INTERVAL = 60 * 1000; // Check every 60 seconds which wallets need a snapshot

// A wallet whose snapshot failed, or was not recorded because a protocol
// failed, is tried again after this long rather than on every tick.
const RETRY_AFTER_MS = 5 * 60 * 1000;

// ── Scheduler state ─────────────────────────────────────────────────────────

let _interval = null;
let _running = false;
const _retryAt = new Map(); // address → earliest time to try again
let _stats = {
  lastTick: null,
  totalSnapshotsTaken: 0,
  errors: 0,
  lastError: null,
  // Snapshots not recorded because a protocol's positions could not be read.
  incompleteSkipped: 0,
  lastIncomplete: null, // { protocols, at }
  walletsProcessedLastTick: 0,
};

/**
 * Determine if a wallet is due for a snapshot based on its tier.
 */
function isDue(wallet) {
  if (!wallet.tracking_enabled) return false;

  const tier = wallet.tier || "free";
  const interval = TIER_INTERVALS[tier] || TIER_INTERVALS.free;
  const lastSnapshot = wallet.last_snapshot_at
    ? new Date(wallet.last_snapshot_at + "Z").getTime()
    : 0;

  return Date.now() - lastSnapshot >= interval;
}

/**
 * Run one tick of the scheduler: check all tracked wallets and snapshot any that are due.
 */
async function tick() {
  if (!_fetchPortfolio) {
    console.warn("[Scheduler] Not initialized — call init() first");
    return;
  }

  if (_running) {
    console.log("[Scheduler] Previous tick still running, skipping");
    return;
  }

  _running = true;
  _stats.lastTick = new Date().toISOString();
  let processed = 0;

  try {
    const wallets = historyDb.getTrackedWallets();

    for (const wallet of wallets) {
      if (!isDue(wallet)) continue;
      if ((_retryAt.get(wallet.address) || 0) > Date.now()) continue;

      try {
        console.log(`[Scheduler] Snapshotting ${wallet.address} (${wallet.network}, tier: ${wallet.tier || "free"})`);
        const portfolioData = await _fetchPortfolio(wallet.address, wallet.network || "mainnet");

        // A protocol whose positions could not be read (it failed or timed
        // out) would be missing from the snapshot's total, and the history
        // chart and the value for a past date would show the wallet as worth
        // that much less (a $39.7M position, for one). No snapshot is better
        // than a wrong one: the wallet stays due and is tried again.
        const missing = portfolioData?.defiDegraded || [];
        if (missing.length > 0) {
          console.warn(`[Scheduler] Not snapshotting ${wallet.address}: ${missing.join(", ")} could not be read; retrying in ${RETRY_AFTER_MS / 60000} min`);
          _stats.incompleteSkipped++;
          _stats.lastIncomplete = { protocols: missing, at: new Date().toISOString() };
          _retryAt.set(wallet.address, Date.now() + RETRY_AFTER_MS);
        } else if (portfolioData) {
          // autoTrack: the scheduler only ever iterates wallets that are
          // already tracked, so this is a no-op in practice — but it is the
          // caller that legitimately owns the enrolment decision, so it opts in
          // explicitly rather than relying on recordSnapshot's default.
          historyDb.recordSnapshot(portfolioData, wallet.network || "mainnet", { autoTrack: true });
          _retryAt.delete(wallet.address);
          _stats.totalSnapshotsTaken++;
          processed++;
        }
      } catch (e) {
        console.error(`[Scheduler] Error snapshotting ${wallet.address}:`, e.message);
        _stats.errors++;
        _stats.lastError = { address: wallet.address, message: e.message, at: new Date().toISOString() };
        _retryAt.set(wallet.address, Date.now() + RETRY_AFTER_MS);
      }

      // Small delay between wallets to avoid hammering Horizon
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    _running = false;
    _stats.walletsProcessedLastTick = processed;
  }

  if (processed > 0) {
    console.log(`[Scheduler] Tick complete: ${processed} wallet(s) snapshotted`);
  }
}

// tick()'s getTrackedWallets() sits inside a try/finally with no catch, and
// both call sites below used to discard the returned promise — so a SQLITE_BUSY
// there became an unhandled rejection that killed the process.
function _onTickError(e) {
  console.error("[Scheduler] Tick failed:", e && e.message ? e.message : e);
  _stats.errors++;
  _stats.lastError = { message: e && e.message ? e.message : String(e), at: new Date().toISOString() };
}

/**
 * Start the background scheduler.
 * @param {number} tickIntervalMs - How often to check for due wallets (default: 60s)
 */
function start(tickIntervalMs = DEFAULT_TICK_INTERVAL) {
  if (_interval) {
    console.log("[Scheduler] Already running");
    return;
  }

  console.log(`[Scheduler] Starting background snapshot scheduler (tick every ${tickIntervalMs / 1000}s)`);
  console.log(`[Scheduler] Tier intervals — free: 1h, basic: 30m, pro: 15m, premium: 5m`);

  // Run first tick after a short delay (let server finish starting)
  setTimeout(() => tick().catch(_onTickError), 10_000);

  _interval = setInterval(() => tick().catch(_onTickError), tickIntervalMs);
}

/**
 * Stop the scheduler.
 */
function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log("[Scheduler] Stopped");
  }
}

/**
 * Get scheduler stats.
 */
function getStats() {
  // lastError used to carry the wallet address it failed on. This is served
  // unauthenticated from /api/v1/scheduler/stats, so it handed out another
  // user's tracked address — the same class of cross-user leak the wallet-list
  // and portfolio routes were already fixed for. Message and timestamp only.
  const { lastError, ...rest } = _stats;
  return {
    running: !!_interval,
    ...rest,
    lastError: lastError
      ? { message: lastError.message, at: lastError.at }
      : null,
    tierIntervals: Object.fromEntries(
      Object.entries(TIER_INTERVALS).map(([k, v]) => [k, `${v / 60000} min`])
    ),
  };
}

module.exports = { init, start, stop, tick, getStats, TIER_INTERVALS };
