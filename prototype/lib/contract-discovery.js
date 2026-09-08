/**
 * Soroban Token Auto-Discovery (probe-based)
 *
 * For any given wallet address, find every Soroban SEP-41 token the wallet
 * holds, regardless of when (or whether) the wallet last interacted with the
 * contract.
 *
 * Algorithm:
 *   1. Build the candidate set:
 *        universe = (active token universe) ∪ (wallet's historical hits from cache)
 *      The universe contains every Soroban token we know about from CoinGecko,
 *      Soroswap's curated list, and stellar.expert's top contracts.
 *      The historical hits are contracts we've previously seen this wallet
 *      hold, even if they've since left the active universe.
 *   2. Probe `balance(wallet)` on each candidate in parallel (bounded
 *      concurrency to avoid hammering Soroban RPC).
 *   3. Cache every probe in discovered_balances so:
 *        - Subsequent lookups skip already-seen-zero contracts inside the cache
 *          window (configurable).
 *        - Once-seen-non-zero contracts are forever-sticky to that wallet.
 *   4. For non-zero results, resolve metadata + price via the pricing engine.
 *
 * This replaces the previous operation-history-based discovery (PR #1), which
 * had a fundamental aging-out problem: after a wallet accumulated ~200 ops of
 * any kind, its earlier Soroban interactions were no longer visible. Passive
 * holders simply disappeared from discovery. The probe approach has no such
 * limit — if the balance exists on-chain, it's found.
 */

const {
  getTokenBalanceStrict,
  getTokenMetadata,
  formatTokenAmount,
} = require("./soroban-rpc");
const { SOROBAN_TOKEN_REGISTRY } = require("./token-resolver");
const { enrichSorobanTokenWithPrice } = require("./pricing-engine");
const tokenUniverse = require("./token-universe");
const historyDb = require("./history-db");

// Max parallel balance probes. Soroban RPC public endpoints can handle bursts
// but we don't want to be antisocial. 20 is fast enough for ~150-contract
// universes (~1-3 seconds total) while staying friendly.
const PROBE_CONCURRENCY = parseInt(process.env.DISCOVERY_PROBE_CONCURRENCY || "20", 10);

// Cache TTL for zero-balance results. Within this window, we skip re-probing
// a wallet/contract pair we've recently seen at zero. Default 5 min.
const ZERO_BALANCE_CACHE_TTL_MS = parseInt(
  process.env.DISCOVERY_ZERO_CACHE_TTL_MS || "300000",
  10
);

// Cache TTL for non-zero balance results. Within this window we trust the
// cached balance without re-probing. Default 60s (matches pricing TTL).
const NONZERO_BALANCE_CACHE_TTL_MS = parseInt(
  process.env.DISCOVERY_NONZERO_CACHE_TTL_MS || "60000",
  10
);

// ── Concurrency helper ───────────────────────────────────────────────────────

async function _parallelMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Cache check ──────────────────────────────────────────────────────────────

function _isCacheFresh(cachedRow, ttlMs) {
  if (!cachedRow || !cachedRow.last_checked_at) return false;
  const lastChecked = new Date(cachedRow.last_checked_at + "Z").getTime();
  if (!Number.isFinite(lastChecked)) return false;
  return Date.now() - lastChecked < ttlMs;
}

// ── Candidate set construction ───────────────────────────────────────────────

/**
 * Build the candidate set of contract IDs to probe for this wallet.
 * Union of (active universe) and (historical hits for this wallet).
 */
function _candidateSet(walletAddress) {
  const universeIds = new Set(tokenUniverse.getContractIds());
  const historical = historyDb.getHistoricalContractsForWallet(walletAddress);
  for (const h of historical) {
    universeIds.add(h.contract_id);
  }
  return Array.from(universeIds);
}

// ── Single-contract probe ────────────────────────────────────────────────────

/**
 * Probe one contract for a wallet's balance, with cache awareness.
 * Always records the result back into the discovery cache.
 *
 * Returns: { contractId, rawBalance: BigInt, isCacheHit: boolean } | null
 *   (returns null if balance is zero — caller filters these out)
 */
async function _probeContract(walletAddress, contractId) {
  // Cache check
  const cached = historyDb.getDiscoveredBalance(walletAddress, contractId);
  if (cached) {
    const isZero = !cached.balance_raw || cached.balance_raw === "0";
    const ttl = isZero ? ZERO_BALANCE_CACHE_TTL_MS : NONZERO_BALANCE_CACHE_TTL_MS;
    if (_isCacheFresh(cached, ttl)) {
      if (isZero) return null;
      return {
        contractId,
        rawBalance: BigInt(cached.balance_raw),
        decimals: cached.decimals,
        symbol: cached.symbol,
        isCacheHit: true,
      };
    }
  }

  // Cache miss or stale — probe on-chain
  let rawBalanceStr;
  try {
    rawBalanceStr = await getTokenBalanceStrict(contractId, walletAddress);
  } catch (e) {
    // Probe failure. Don't poison the cache with a false zero — and if we
    // KNEW a non-zero balance before, serve that stale value rather than
    // dropping the token: a transient RPC 429 was making real holdings
    // (deJTRSY, deJAAA) blink in and out of portfolio totals run to run.
    if (cached && cached.balance_raw && cached.balance_raw !== "0") {
      return {
        contractId,
        rawBalance: BigInt(cached.balance_raw),
        decimals: cached.decimals,
        symbol: cached.symbol,
        isCacheHit: true,
        stale: true,
      };
    }
    return null;
  }

  // Strict variant: "0" here really means zero (contract-level reverts like
  // a missing trustline included); transport failures threw above and were
  // handled by the stale-cache fallback — they never reach the cache write.
  const rawBalance = BigInt(rawBalanceStr || "0");

  // Update cache (always — including zero results, to short-circuit future probes)
  try {
    historyDb.upsertDiscoveredBalance(walletAddress, contractId, {
      balanceRaw: rawBalance.toString(),
      decimals: cached?.decimals || null,
      symbol: cached?.symbol || null,
    });
  } catch (e) {
    // Cache write failure is non-fatal
  }

  if (rawBalance === 0n) return null;

  return {
    contractId,
    rawBalance,
    decimals: cached?.decimals || null,
    symbol: cached?.symbol || null,
    isCacheHit: false,
  };
}

// ── Resolve non-zero hit into the full token shape ───────────────────────────

/**
 * Given a non-zero balance hit, build the full token shape expected by the
 * frontend. Fetches metadata (if not already cached) and enriches with price.
 */
async function _resolveHit(walletAddress, hit) {
  let { contractId, rawBalance, decimals, symbol } = hit;

  // Highest-trust fallback: the token universe. For statically-seeded contracts
  // (SolvBTC, USDC, etc.) and Soroswap-listed contracts, decimals + symbol are
  // already known and don't require a Soroban RPC call. This protects against
  // metadata-fetch failures (rate limits, transient errors) that would
  // otherwise produce wrong decimals and a misreported balance.
  if (decimals == null || !symbol) {
    const universeEntry = tokenUniverse.get(contractId);
    if (universeEntry) {
      if (decimals == null && universeEntry.decimals != null) {
        decimals = universeEntry.decimals;
      }
      if (!symbol && universeEntry.symbol) {
        symbol = universeEntry.symbol;
      }
    }
  }

  // Last-resort: live metadata fetch (slow path; only for contracts we don't
  // know about statically).
  if (decimals == null || !symbol) {
    try {
      const meta = await getTokenMetadata(contractId);
      if (meta) {
        if (decimals == null) decimals = meta.decimals;
        if (!symbol) symbol = meta.symbol;
        // Update cache + universe with anything we learned
        try {
          historyDb.upsertDiscoveredBalance(walletAddress, contractId, {
            balanceRaw: rawBalance.toString(),
            decimals,
            symbol,
          });
          tokenUniverse.add(contractId, { symbol, decimals, source: "discovered" });
        } catch (e) { /* non-fatal */ }
      }
    } catch (e) {
      // metadata fetch failure — leave defaults
    }
  }

  if (decimals == null) decimals = 7;  // Stellar default
  if (!symbol) symbol = "???";

  const balance = formatTokenAmount(rawBalance, decimals);

  const token = {
    type: "soroban_token",
    asset: {
      code: symbol,
      issuer: null,
      contractId,
      domain: null,
      logo: null,
      category: "discovered",
    },
    balance,
    rawBalance: rawBalance.toString(),
    decimals,
    valueUSD: 0,
    price: null,
    source: "soroban_discovery_probe",
  };

  // Enrich with price (best-effort; failures leave token visible but unpriced)
  try {
    await enrichSorobanTokenWithPrice(token);
  } catch (e) {
    // swallow
  }

  return token;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Discover all Soroban SEP-41 tokens a wallet holds (non-zero balance).
 *
 * Same interface as the original PR #1 function, drop-in replacement.
 * Internally uses probe-against-universe rather than operation-history scan.
 *
 * @param {string} accountId G-strkey
 * @returns {Promise<object[]>} array of token results, ready for the frontend
 */
async function discoverSorobanTokens(accountId) {
  if (
    !accountId ||
    typeof accountId !== "string" ||
    !accountId.startsWith("G") ||
    accountId.length !== 56
  ) {
    return [];
  }

  // Exclude contracts already covered by the static registry (token-resolver.js
  // handles them via its own path).
  const registryIds = new Set(SOROBAN_TOKEN_REGISTRY.map((t) => t.contractId));

  const candidates = _candidateSet(accountId).filter((c) => !registryIds.has(c));

  if (candidates.length === 0) return [];

  // Probe all candidates in parallel
  const results = await _parallelMap(candidates, PROBE_CONCURRENCY, (contractId) =>
    _probeContract(accountId, contractId)
  );

  // Filter to actual hits (non-null, non-error)
  const hits = results.filter((r) => r && !r.__error);

  if (hits.length === 0) return [];

  // Resolve each hit into the full token shape (parallel; metadata + price)
  const tokens = await Promise.all(hits.map((h) => _resolveHit(accountId, h)));

  return tokens.filter((t) => t != null);
}

// ── Stats / debugging ────────────────────────────────────────────────────────

function stats() {
  return {
    universe: tokenUniverse.stats(),
    cache: historyDb.getDiscoveryStats(),
    concurrency: PROBE_CONCURRENCY,
    zeroCacheTtlMs: ZERO_BALANCE_CACHE_TTL_MS,
    nonzeroCacheTtlMs: NONZERO_BALANCE_CACHE_TTL_MS,
  };
}

module.exports = {
  discoverSorobanTokens,
  stats,
};
