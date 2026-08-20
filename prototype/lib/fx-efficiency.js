/**
 * FX Efficiency — live swap-efficiency tables for FX-denominated tokens.
 *
 * Answers "how efficiently can I convert $X of USDC into this token (and
 * back) RIGHT NOW?" at ladder sizes $1 … $1M. Quotes come from Horizon's
 * strict-send path finding, so every number is an EXECUTABLE rate against
 * the live SDEX book + classic AMM pools — not an indicative price.
 * (Soroban AMMs — Aqua/Soroswap/Sushi — are not visible to Horizon paths;
 * where they hold FX depth this table understates efficiency. Labeled in
 * the UI; Soroban quoting is the planned fast-follow.)
 *
 * The headline metric is ROUND-TRIP COST: buy $X worth, immediately sell
 * what you received, and measure the loss in bps. It needs no external
 * reference price and captures spread + depth in one number.
 *
 * Architecture mirrors the other fetchers in this repo: a background
 * refresh loop keeps a cache warm; the HTTP endpoint serves the cache and
 * never quotes on the request path (except an explicit ?fresh=1). A failed
 * refresh keeps the previous snapshot up to STALE_GRACE.
 */

const HORIZON = process.env.HORIZON_URL || "https://horizon.stellar.org";

const USDC = {
  code: "USDC",
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

// Ladder of USD notional sizes. ($1M dropped: no listed token has that
// depth today — every row read "insufficient depth" and wasted 6 quotes.)
const SIZES_USD = [1, 100, 1_000, 10_000, 100_000];

const FX_TOKENS = [
  {
    symbol: "EURC",
    name: "EURC (Circle Euro)",
    code: "EURC",
    issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
    currency: "EUR",
  },
  {
    symbol: "CETES",
    name: "CETES (Etherfuse · MX bonds)",
    code: "CETES",
    issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
    currency: "MXN",
  },
  {
    symbol: "TESOURO",
    name: "TESOURO (Etherfuse · BR bonds)",
    code: "TESOURO",
    issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
    currency: "BRL",
  },
];

const REFRESH_INTERVAL = 120_000; // full ladder refresh cadence
const STALE_GRACE = 15 * 60_000;  // serve stale snapshot up to 15 min on failure

// ── Horizon path quoting ────────────────────────────────────────────────────

function assetParams(prefix, asset) {
  if (asset.code === "XLM" && !asset.issuer) return { [`${prefix}_asset_type`]: "native" };
  return {
    [`${prefix}_asset_type`]: asset.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    [`${prefix}_asset_code`]: asset.code,
    [`${prefix}_asset_issuer`]: asset.issuer,
  };
}

/** Best strict-send quote: send `amount` of `from`, receive ? of `to`.
 *  Returns { amount, route } for the best path, or null when no path.
 *  `route` names the hops so it's visible WHERE the quoted liquidity
 *  sits — "direct" means the from/to order book itself, "via XLM" means
 *  the path crosses the XLM books. */
async function pathQuote(from, to, amount) {
  const params = new URLSearchParams({
    ...assetParams("source", from),
    source_amount: amount.toFixed(7),
    destination_assets: `${to.code}:${to.issuer}`,
  });
  const res = await fetch(`${HORIZON}/paths/strict-send?${params}`);
  if (!res.ok) throw new Error(`Horizon paths ${res.status}`);
  const records = (await res.json())?._embedded?.records || [];
  let best = null;
  for (const r of records) {
    const amt = parseFloat(r.destination_amount);
    if (amt > 0 && (!best || amt > best.amount)) {
      const hops = (r.path || []).map((p) =>
        p.asset_type === "native" ? "XLM" : p.asset_code
      );
      best = { amount: amt, route: hops.length === 0 ? "direct" : `via ${hops.join(" → ")}` };
    }
  }
  return best;
}

// ── Ladder computation ──────────────────────────────────────────────────────

async function quoteToken(tokenCfg) {
  const token = { code: tokenCfg.code, issuer: tokenCfg.issuer };

  const rows = [];
  for (const size of SIZES_USD) {
    let row = { sizeUSD: size, noRoute: true };
    try {
      const buy = await pathQuote(USDC, token, size);
      if (buy) {
        const received = buy.amount;
        const buyRate = size / received; // USD paid per token
        const sell = await pathQuote(token, USDC, received);
        row = {
          sizeUSD: size,
          noRoute: false,
          tokensReceived: received,
          buyRate,
          route: buy.route,
          sellRate: sell ? sell.amount / received : null,
          roundTripBps: sell ? ((size - sell.amount) / size) * 10_000 : null,
        };
      }
    } catch (e) {
      row = { sizeUSD: size, noRoute: true, error: e.message };
    }
    rows.push(row);
  }

  // Depth-decay column: each size's buy rate vs the $1 rate. A "path"
  // whose rate is >10% above the small-size rate means the book is
  // effectively exhausted at that size — Horizon happily returns absurd
  // fills (e.g. 12 USD/EUR) instead of no-route. Mark those rows
  // exhausted so the UI reports "insufficient depth", never a joke rate.
  const EXHAUSTED_SLIPPAGE_BPS = 1_000;
  const base = rows.find((r) => !r.noRoute && r.buyRate);
  if (base) {
    for (const r of rows) {
      r.slippageBps = !r.noRoute && r.buyRate
        ? ((r.buyRate - base.buyRate) / base.buyRate) * 10_000
        : null;
      if (r.slippageBps !== null && r.slippageBps > EXHAUSTED_SLIPPAGE_BPS) {
        r.exhausted = true;
      }
    }
  }

  return {
    symbol: tokenCfg.symbol,
    name: tokenCfg.name,
    code: tokenCfg.code,
    issuer: tokenCfg.issuer,
    currency: tokenCfg.currency,
    spotBuyRate: base ? base.buyRate : null,
    rows,
    quotedAt: new Date().toISOString(),
  };
}

// ── Cache + refresh loop ────────────────────────────────────────────────────

let snapshot = { updatedAt: null, tokens: [] };
let refreshing = null;
let timer = null;

async function refreshAll() {
  if (refreshing) return refreshing; // coalesce concurrent refreshes
  refreshing = (async () => {
    const tokens = [];
    for (const cfg of FX_TOKENS) {
      try {
        tokens.push(await quoteToken(cfg));
      } catch (e) {
        console.warn(`[fx] ${cfg.symbol} quote failed:`, e.message);
        // keep the previous entry for this token if we had one
        const prev = snapshot.tokens.find((t) => t.symbol === cfg.symbol);
        if (prev) tokens.push(prev);
      }
    }
    if (tokens.length > 0) {
      snapshot = { updatedAt: new Date().toISOString(), tokens };
    }
    return snapshot;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function getSnapshot() {
  const stale =
    !snapshot.updatedAt ||
    Date.now() - new Date(snapshot.updatedAt).getTime() > STALE_GRACE;
  return { ...snapshot, stale };
}

function start() {
  refreshAll().catch(() => {});
  timer = setInterval(() => refreshAll().catch(() => {}), REFRESH_INTERVAL);
  if (timer.unref) timer.unref();
}

module.exports = { start, getSnapshot, refreshAll, FX_TOKENS, SIZES_USD };
