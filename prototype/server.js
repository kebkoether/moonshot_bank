require("dotenv").config();
const express = require("express");
const cors = require("cors");
const StellarSdk = require("@stellar/stellar-sdk");
const path = require("path");

// Soroban integration modules
const historyDb = require("./lib/history-db");
const { resolveSorobanTokens, resolveCustomToken, getRegistry } = require("./lib/token-resolver");
const { discoverSorobanTokens } = require("./lib/contract-discovery");
const { isKnownSAC, classicForSAC, classicMatches } = require("./lib/sac-mapping");
const pricingEngine = require("./lib/pricing-engine");
const SolvProtocolAdapter = require("./lib/adapters/solv-protocol");
const BlendAdapter = require("./lib/adapters/blend");
const AquariusAdapter = require("./lib/adapters/aquarius");
const TemplarAdapter = require("./lib/adapters/templar");
const UpshiftAdapter = require("./lib/adapters/upshift");
const LPPositionsAdapter = require("./lib/adapters/lp-positions");
const LPDiscoveryAdapter = require("./lib/adapters/lp-discovery");
const SentoraAdapter = require("./lib/adapters/sentora");
const snapshotScheduler = require("./lib/snapshot-scheduler");
const rwaYieldFetcher = require("./lib/rwa-yield-fetcher");
const K2Adapter = require("./lib/adapters/k2");
const defiExplorer = require("./lib/defi-explorer");
const createPublicApiRoutes = require("./lib/public-api-routes");
const { resolveNfts } = require("./lib/nft-resolver");
const { resolveSorobanCollectibles } = require("./lib/collectibles-resolver");
const { getTickerPrices } = require("./lib/price-ticker");

const app = express();
// Railway/Cloudflare terminate TLS one hop in front of us. Without this,
// req.ip resolves to the proxy's IP and rate-limiting buckets every user
// into one shared quota.
app.set("trust proxy", 1);
app.use(cors());
// Cap request body size so a rogue POST can't exhaust memory.
app.use(express.json({ limit: "50kb" }));
// Static assets. HTML files are told not to cache so that after a deploy
// (Railway push), users don't stay on an old bundle until they hard-refresh.
// Everything else (images, css, static json, etc.) uses default caching.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// Per-IP rate limit applied to the entire API surface. Public routes previously
// used this only selectively; internal routes had no limit. Apply globally.
const { rateLimitMiddleware } = require("./lib/api-keys");
app.use("/api/v1", rateLimitMiddleware);

// Same-origin gate for endpoints we don't want casually integrated by external
// callers (leaderboards + wallet-tracking POST). The SPA hits these from the
// same origin so it works transparently; external scrapers/apps get 403.
// Not a hard defense — Origin/Referer can be spoofed — but a real speedbump
// against accidental integration.
const ALLOWED_ORIGINS = new Set([
  "https://stellarscope.xyz",
  "https://www.stellarscope.xyz",
  "https://stellarscope-production.up.railway.app",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
]);
function sameOriginOnly(req, res, next) {
  const origin = req.get("Origin");
  const referer = req.get("Referer");
  const refererOrigin = referer ? referer.split("/").slice(0, 3).join("/") : null;
  const ok = (origin && ALLOWED_ORIGINS.has(origin))
          || (refererOrigin && ALLOWED_ORIGINS.has(refererOrigin));
  if (ok) return next();
  return res.status(403).json({
    error: "This endpoint is only reachable from the Stellar Scope UI.",
  });
}

// Mainnet only — read-only portfolio tracker
const HORIZON_URL = "https://horizon.stellar.org";

function getHorizon() {
  return new StellarSdk.Horizon.Server(HORIZON_URL);
}

const horizon = getHorizon();

// Protocol adapter registry — add new adapters here.
// LPDiscoveryAdapter auto-discovers positions in Aquarius (HTTP API) and
// Soroswap (factory enumeration). LPPositionsAdapter reads SushiSwap V3
// positions from the position-manager contract and keeps a hardcoded-pool
// fallback for anything discovery misses (e.g. nascent protocols).
const PROTOCOL_ADAPTERS = [
  BlendAdapter,
  K2Adapter,
  AquariusAdapter,
  TemplarAdapter,
  SolvProtocolAdapter,
  UpshiftAdapter,
  SentoraAdapter,
  LPDiscoveryAdapter,
  LPPositionsAdapter,
];

// Query every configured protocol adapter for a wallet's DeFi positions —
// IN PARALLEL, each capped at ADAPTER_TIMEOUT_MS so one slow protocol API
// can't stall the whole response. (Sequential adapter calls were the main
// reason wallet loads took tens of seconds: 9 adapters × N wallets ×
// network latency, all serial.)
const ADAPTER_TIMEOUT_MS = parseInt(process.env.ADAPTER_TIMEOUT_MS || "8000", 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Keep the Soroswap pair universe warm so LP discovery never pays the
// multi-second factory enumeration on a user's request. Refresh slightly
// inside the adapter's 1h cache TTL.
const { warmSoroswapUniverse } = require("./lib/adapters/lp-discovery");
warmSoroswapUniverse().catch(() => {});
setInterval(() => warmSoroswapUniverse().catch(() => {}), 50 * 60_000);

async function collectDefiPositions(address, xlmPrice) {
  const defiPositions = [];
  const defiByPool = []; // grouped data, currently from Blend
  let totalUSD = 0;

  const configured = PROTOCOL_ADAPTERS.filter((a) => a.isConfigured());
  const results = await Promise.allSettled(
    configured.map((a) =>
      withTimeout(a.getPositions(address, { xlmPrice }), ADAPTER_TIMEOUT_MS, a.name || "adapter")
    )
  );

  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.error(`${configured[i].name || "adapter"} adapter error:`, r.reason?.message);
      return;
    }
    const positions = r.value || [];
    for (const pos of positions) {
      totalUSD += pos.valueUSD || 0;
      defiPositions.push(pos);
    }
    // Blend (and any future adapter) may attach grouped pool data via the
    // __blendPoolGroups property — pass through for the per-pool table.
    if (Array.isArray(positions.__blendPoolGroups)) {
      for (const g of positions.__blendPoolGroups) {
        defiByPool.push({ protocol: "blend", ...g });
      }
    }
  });

  return { defiPositions, defiByPool, totalUSD };
}

// ── Price Engine ──────────────────────────────────────────────────────────────

const priceCache = new Map();
const PRICE_TTL = 60_000; // 60 seconds

async function getXLMPrice() {
  const cached = priceCache.get("XLM");
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;

  // Primary: Freighter's token-prices endpoint (purpose-built for Stellar
  // assets; doesn't rate-limit our Railway IP). Fallback: CoinGecko.
  try {
    const res = await fetch("https://freighter-backend-prd.stellar.org/api/v1/token-prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: ["XLM"] }),
    });
    if (res.ok) {
      const body = await res.json();
      const v = body?.data?.XLM;
      const usd = parseFloat(v?.currentPrice);
      if (Number.isFinite(usd) && usd > 0) {
        const change = parseFloat(v?.percentagePriceChange24h);
        const price = {
          usd,
          change24h: Number.isFinite(change) ? change : 0,
        };
        priceCache.set("XLM", { price, ts: Date.now() });
        return price;
      }
    }
  } catch (e) {
    console.warn("Freighter XLM price failed, falling back to CoinGecko:", e.message);
  }

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd&include_24hr_change=true"
    );
    const data = await res.json();
    if (data?.stellar?.usd && data.stellar.usd > 0) {
      const price = {
        usd: data.stellar.usd,
        change24h: data.stellar.usd_24h_change || 0,
      };
      priceCache.set("XLM", { price, ts: Date.now() });
      return price;
    }
  } catch (e) {
    console.error("Failed to fetch XLM price (CoinGecko fallback also failed):", e.message);
  }

  // Both sources failed. Return the last cached value if we have one,
  // even if stale — preferable to zero, which cascades into bogus
  // portfolio totals across every Stellar holding.
  if (cached) {
    console.warn("XLM price sources all failed; returning stale cache");
    return cached.price;
  }
  return { usd: 0, change24h: 0 };
}

async function getAssetPriceViaSDEX(assetCode, assetIssuer) {
  const cacheKey = `${assetCode}:${assetIssuer}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;

  try {
    const asset = new StellarSdk.Asset(assetCode, assetIssuer);
    const xlmAsset = StellarSdk.Asset.native();

    // Get orderbook: asset vs XLM
    const orderbook = await horizon.orderbook(asset, xlmAsset).call();

    if (orderbook.bids.length === 0 && orderbook.asks.length === 0) {
      return null; // No market
    }

    let priceInXLM = null;

    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestAsk = parseFloat(orderbook.asks[0].price);
      const spread = (bestAsk - bestBid) / bestBid;

      if (spread < 0.1) {
        // Use mid-price if spread < 10%
        priceInXLM = (bestBid + bestAsk) / 2;
      } else {
        priceInXLM = bestBid; // Conservative: use bid
      }
    } else if (orderbook.bids.length > 0) {
      priceInXLM = parseFloat(orderbook.bids[0].price);
    } else {
      priceInXLM = parseFloat(orderbook.asks[0].price);
    }

    const xlmPrice = await getXLMPrice();

    // Seed XLM SAC price so Blend adapter avoids redundant CoinGecko call
    pricingEngine.seedSorobanPrice("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", {
      usd: xlmPrice.usd, change24h: xlmPrice.change24h, source: "coingecko", confidence: "high",
    });
    const priceUSD = priceInXLM * xlmPrice.usd;

    const price = { usd: priceUSD, xlm: priceInXLM, change24h: 0 };
    priceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  } catch (e) {
    console.error(`Failed to price ${assetCode}:`, e.message);
    return null;
  }
}

// ── Known stablecoins (shortcut pricing) ─────────────────────────────────────

const STABLECOINS = {
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": 1.0,
  "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP": 1.0,
  "yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6FDFDZQI3D2URRQMHI4BSFS7SN2F": 1.0,
};

function isStablecoin(code, issuer) {
  return STABLECOINS[`${code}:${issuer}`] !== undefined;
}

/**
 * Filter Soroban-discovered tokens to remove SAC entries that double-count a
 * classic asset already present in `balances`. Returns the filtered array.
 *
 * Why: well-known SAC contracts (XLM SAC, USDC SAC) wrap the same underlying
 * economic asset as their classic counterpart. Probe-based discovery finds
 * them; the classic-side fetch already finds the underlying. Without filtering,
 * a wallet with 100 native XLM appears as 200 XLM (100 native + 100 SAC).
 *
 * For each discovered token whose contract is a known SAC, we check whether
 * the underlying classic asset is already represented in `balances`. If so,
 * we drop the SAC entry. If the wallet truly holds the SAC version with no
 * classic counterpart (rare but valid), the SAC entry remains.
 */
function dedupSACsAgainstClassicBalances(discoveredTokens, classicBalances) {
  if (!Array.isArray(discoveredTokens) || discoveredTokens.length === 0) {
    return discoveredTokens || [];
  }
  return discoveredTokens.filter((tok) => {
    const cid = tok && tok.asset && tok.asset.contractId;
    if (!cid || !isKnownSAC(cid)) return true;
    const underlying = classicForSAC(cid);
    const matchedClassic = (classicBalances || []).find((b) => classicMatches(b, underlying));
    // Drop the SAC entry only if the classic balance exists AND is non-zero
    // (a wallet holding the SAC-only is preserved).
    if (matchedClassic && parseFloat(matchedClassic.balance) > 0) {
      return false;
    }
    return true;
  });
}

// ── API Routes ────────────────────────────────────────────────────────────────

// Full portfolio summary
app.get("/api/v1/account/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();

    // Validate Stellar address
    if (!address.startsWith("G") || address.length !== 56) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    const account = await h.loadAccount(address);
    const xlmPrice = await getXLMPrice();

    // Process balances
    const balances = [];
    let totalValueUSD = 0;

    for (const bal of account.balances) {
      const amount = parseFloat(bal.balance);

      if (bal.asset_type === "native") {
        const reserved =
          (2 + account.subentry_count * 0.5 + account.num_sponsoring * 0.5 - account.num_sponsored * 0.5);
        const available = Math.max(0, amount - reserved);
        const valueUSD = amount * xlmPrice.usd;
        totalValueUSD += valueUSD;

        balances.push({
          type: "native",
          asset: { code: "XLM", issuer: null, domain: "stellar.org", logo: null },
          balance: bal.balance,
          available: available.toFixed(7),
          reserved: reserved.toFixed(7),
          valueUSD: valueUSD,
          price: xlmPrice,
        });
      } else if (bal.asset_type === "liquidity_pool_shares") {
        // LP position — we'll resolve this separately
        balances.push({
          type: "lp_share",
          poolId: bal.liquidity_pool_id,
          shares: bal.balance,
          valueUSD: 0, // Will be enriched
        });
      } else {
        // Standard trustline token. Skip empty trustlines (drained tokens
        // like USDx) so they don't clutter the wallet view.
        if (amount === 0) continue;

        const code = bal.asset_code;
        const issuer = bal.asset_issuer;
        let price = null;
        let valueUSD = 0;

        price = await pricingEngine.priceClassicAsset(
          { priceViaSDEX: getAssetPriceViaSDEX },
          code,
          issuer
        );
        if (price) valueUSD = amount * price.usd;

        totalValueUSD += valueUSD;

        balances.push({
          type: "token",
          asset: {
            code,
            issuer,
            domain: null,
            logo: null,
          },
          balance: bal.balance,
          valueUSD,
          price,
          trustline: {
            limit: bal.limit,
            authorized: bal.is_authorized,
          },
        });
      }
    }

    // ── Soroban token balances (SolvBTC, etc.) ──────────────────────────────
    let sorobanTokens = [];
    try {
      sorobanTokens = await resolveSorobanTokens(address);
      for (const st of sorobanTokens) {
        totalValueUSD += st.valueUSD || 0;
        balances.push(st);
      }
    } catch (e) {
      console.error("Soroban token resolution error:", e.message);
    }

    // ── Auto-discovered Soroban tokens (not in the static registry) ─────────
    // Scans the wallet's invoke_host_function history for SEP-41 token
    // contracts and queries balances. Cached per address (5 min default).
    let discoveredTokens = [];
    try {
      const rawDiscovered = await discoverSorobanTokens(address);
      // Deduplicate well-known SAC contracts (XLM SAC, USDC SAC) against the
      // classic balances already in `balances` to avoid showing the same
      // economic asset twice.
      discoveredTokens = dedupSACsAgainstClassicBalances(rawDiscovered, balances);
      for (const dt of discoveredTokens) {
        totalValueUSD += dt.valueUSD || 0;
        balances.push(dt);
      }
    } catch (e) {
      console.error("Soroban token discovery error:", e.message);
    }

    // ── DeFi positions (SushiSwap V3, Solv vaults, etc.) ─────────────────
    // All protocol adapters queried in parallel with a per-adapter timeout.
    const { defiPositions, defiByPool, totalUSD: defiTotalUSD } =
      await collectDefiPositions(address, xlmPrice);
    totalValueUSD += defiTotalUSD;

    // Sort by value descending
    balances.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));

    const responseData = {
      address,
      network: "mainnet",
      totalValueUSD,
      xlmPrice,
      balanceCount: balances.length,
      balances,
      defiPositions,
      defiByPool,
      defiProtocols: PROTOCOL_ADAPTERS.filter((a) => a.isConfigured()).map((a) => ({
        id: a.protocolId,
        name: a.name,
        type: a.type,
      })),
      sorobanTokenCount: sorobanTokens.length + discoveredTokens.length,
      subentryCount: account.subentry_count,
      lastModifiedLedger: account.last_modified_ledger,
      lastUpdated: new Date().toISOString(),
    };

    res.json(responseData);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return res.status(404).json({ error: "Account not found on Stellar network" });
    }
    console.error("Account fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch account data" });
  }
});

// Transaction history
app.get("/api/v1/account/:address/history", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const cursor = req.query.cursor || undefined;

    let query = h.operations().forAccount(address).order("desc").limit(limit);
    if (cursor) query = query.cursor(cursor);

    const operations = await query.call();

    const history = operations.records.map((op) => ({
      id: op.id,
      type: op.type,
      createdAt: op.created_at,
      transactionHash: op.transaction_hash,
      ...(op.type === "payment" && {
        from: op.from,
        to: op.to,
        amount: op.amount,
        assetCode: op.asset_code || "XLM",
        assetIssuer: op.asset_issuer || null,
      }),
      ...(op.type === "path_payment_strict_receive" && {
        from: op.from,
        to: op.to,
        amount: op.amount,
        sourceAmount: op.source_amount,
        assetCode: op.asset_code || "XLM",
        sourceAssetCode: op.source_asset_code || "XLM",
      }),
      ...(op.type === "manage_sell_offer" && {
        offerId: op.offer_id,
        amount: op.amount,
        price: op.price,
        buyingAsset: op.buying_asset_code || "XLM",
        sellingAsset: op.selling_asset_code || "XLM",
      }),
      ...(op.type === "create_account" && {
        account: op.account,
        startingBalance: op.starting_balance,
        funder: op.funder,
      }),
      ...(op.type === "change_trust" && {
        assetCode: op.asset_code,
        assetIssuer: op.asset_issuer,
        limit: op.limit,
      }),
    }));

    res.json({
      address,
      count: history.length,
      cursor: operations.records.length > 0
        ? operations.records[operations.records.length - 1].paging_token
        : null,
      history,
    });
  } catch (e) {
    console.error("History fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch transaction history" });
  }
});

// Claimable balances
app.get("/api/v1/account/:address/claimable", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();
    const claimable = await h.claimableBalances().claimant(address).limit(50).call();

    const balances = claimable.records.map((cb) => ({
      id: cb.id,
      amount: cb.amount,
      asset: cb.asset === "native"
        ? { code: "XLM", issuer: null }
        : {
            code: cb.asset.split(":")[0],
            issuer: cb.asset.split(":")[1],
          },
      sponsor: cb.sponsor,
      claimants: cb.claimants.map((c) => ({
        destination: c.destination,
        predicate: c.predicate,
      })),
      lastModifiedLedger: cb.last_modified_ledger,
    }));

    res.json({ address, count: balances.length, claimableBalances: balances });
  } catch (e) {
    console.error("Claimable balance error:", e.message);
    res.status(500).json({ error: "Failed to fetch claimable balances" });
  }
});

// NFT holdings — classic Stellar assets that look like NFTs, with SEP-1/SEP-39
// metadata resolved from the issuer's stellar.toml where available.
app.get("/api/v1/account/:address/nfts", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();
    const account = await h.loadAccount(address);

    const nfts = await resolveNfts(h, account.balances);
    res.json({
      address,
      count: nfts.length,
      nfts,
      // Surface the threshold so a future UI toggle can show "maybe" entries
      confidenceCutoff: 0.35,
    });
  } catch (e) {
    console.error("NFT fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// Soroban contract NFTs (SEP-50, including Meridian Pay collections).
// Proxies SDF's official Freighter backend rather than reimplementing Soroban
// RPC token enumeration. See lib/collectibles-resolver.js for the full
// rationale and source-code references.
app.get("/api/v1/account/:address/collectibles", async (req, res) => {
  try {
    const { address } = req.params;
    const result = await resolveSorobanCollectibles(address);
    res.json({ address, ...result });
  } catch (e) {
    console.error("Collectibles fetch error:", e.message);
    res.status(502).json({ error: "Failed to fetch collectibles", detail: e.message });
  }
});

// Live price ticker — feeds the marquee banner. 30s server-side cache.
app.get("/api/v1/prices/ticker", async (_req, res) => {
  try {
    const result = await getTickerPrices();
    res.json(result);
  } catch (e) {
    console.error("Ticker prices fetch error:", e.message);
    res.status(502).json({ error: "Failed to fetch prices", detail: e.message });
  }
});

// Liquidity pool details
app.get("/api/v1/pool/:poolId", async (req, res) => {
  try {
    const pool = await horizon.liquidityPools().liquidityPoolId(req.params.poolId).call();
    const xlmPrice = await getXLMPrice();

    const reserves = pool.reserves.map((r) => ({
      asset: r.asset === "native"
        ? { code: "XLM", issuer: null }
        : { code: r.asset.split(":")[0], issuer: r.asset.split(":")[1] },
      amount: r.amount,
    }));

    res.json({
      id: pool.id,
      fee: pool.fee_bp,
      totalShares: pool.total_shares,
      totalTrustlines: pool.total_trustlines,
      reserves,
    });
  } catch (e) {
    console.error("Pool fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch pool data" });
  }
});

// Asset search
app.get("/api/v1/assets/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Query parameter 'q' is required" });

    const assets = await horizon.assets().forCode(q).limit(20).call();

    const results = assets.records.map((a) => ({
      code: a.asset_code,
      issuer: a.asset_issuer,
      type: a.asset_type,
      accounts: a.accounts,
      balances: a.balances,
      flags: a.flags,
    }));

    res.json({ query: q, count: results.length, assets: results });
  } catch (e) {
    console.error("Asset search error:", e.message);
    res.status(500).json({ error: "Failed to search assets" });
  }
});

// DeFi positions (dedicated endpoint)
app.get("/api/v1/account/:address/defi", async (req, res) => {
  try {
    const { address } = req.params;
    const allPositions = [];
    const xlmPrice = await getXLMPrice();

    for (const adapter of PROTOCOL_ADAPTERS) {
      if (!adapter.isConfigured()) continue;
      try {
        const positions = await adapter.getPositions(address, { xlmPrice });
        allPositions.push(...positions);
      } catch (e) {
        console.error(`${adapter.name} error:`, e.message);
      }
    }

    res.json({
      address,
      count: allPositions.length,
      protocols: PROTOCOL_ADAPTERS.filter((a) => a.isConfigured()).map((a) => ({
        id: a.protocolId,
        name: a.name,
        type: a.type,
      })),
      positions: allPositions,
    });
  } catch (e) {
    console.error("DeFi positions error:", e.message);
    res.status(500).json({ error: "Failed to fetch DeFi positions" });
  }
});

// Soroban token balance for a specific contract
app.get("/api/v1/account/:address/soroban/:contractId", async (req, res) => {
  try {
    const { address, contractId } = req.params;
    const token = await resolveCustomToken(contractId, address);
    if (!token) {
      return res.json({ address, contractId, balance: "0", found: false });
    }
    res.json({ address, contractId, found: true, ...token });
  } catch (e) {
    console.error("Soroban token error:", e.message);
    res.status(500).json({ error: "Failed to query Soroban token" });
  }
});

// Soroban token registry
app.get("/api/v1/soroban/registry", (req, res) => {
  res.json({
    tokens: getRegistry(),
    protocols: PROTOCOL_ADAPTERS.map((a) => ({
      id: a.protocolId,
      name: a.name,
      type: a.type,
      configured: a.isConfigured(),
    })),
  });
});

// ── Portfolio History API ─────────────────────────────────────────────────────

// Get portfolio value history (chart data)
app.get("/api/v1/account/:address/portfolio-history", (req, res) => {
  try {
    const { address } = req.params;
    const range = req.query.range || "30d";

    const validRanges = ["24h", "7d", "30d", "90d", "1y", "all"];
    if (!validRanges.includes(range)) {
      return res.status(400).json({ error: `Invalid range. Use: ${validRanges.join(", ")}` });
    }

    const snapshots = historyDb.getHistory(address, "mainnet", range);
    const latest = historyDb.getLatestSnapshot(address, "mainnet");

    // Calculate change stats
    let changeUSD = 0;
    let changePercent = 0;
    if (snapshots.length >= 2) {
      const first = snapshots[0].total_value_usd;
      const last = snapshots[snapshots.length - 1].total_value_usd;
      changeUSD = last - first;
      changePercent = first > 0 ? ((last - first) / first) * 100 : 0;
    }

    res.json({
      address,
      network: "mainnet",
      range,
      dataPoints: snapshots.length,
      change: {
        usd: changeUSD,
        percent: changePercent,
      },
      latest: latest || null,
      snapshots: snapshots.map((s) => ({
        timestamp: s.snapshot_at,
        totalValueUSD: s.total_value_usd,
        xlmBalance: s.xlm_balance,
        xlmPriceUSD: s.xlm_price_usd,
        tokenCount: s.token_count,
        defiPositionCount: s.defi_position_count,
      })),
    });
  } catch (e) {
    console.error("Portfolio history error:", e.message);
    res.status(500).json({ error: "Failed to fetch portfolio history" });
  }
});

// Get token-specific price/balance history
app.get("/api/v1/account/:address/token-history/:assetCode", (req, res) => {
  try {
    const { address, assetCode } = req.params;
    const range = req.query.range || "30d";

    const history = historyDb.getTokenHistory(address, "mainnet", assetCode, range);

    res.json({
      address,
      network: "mainnet",
      assetCode,
      range,
      dataPoints: history.length,
      history: history.map((h) => ({
        timestamp: h.snapshot_at,
        balance: h.balance,
        valueUSD: h.value_usd,
        priceUSD: h.price_usd,
      })),
    });
  } catch (e) {
    console.error("Token history error:", e.message);
    res.status(500).json({ error: "Failed to fetch token history" });
  }
});// Get snapshot closest to a specific date/time
app.get("/api/v1/account/:address/snapshot-at", (req, res) => {
  try {
    const { address } = req.params;
    const { date } = req.query; // ISO string, e.g. "2026-05-10T14:00:00"

    if (!date) {
      return res.status(400).json({ error: "Missing ?date= parameter (ISO timestamp)" });
    }

    const snapshot = historyDb.getSnapshotAtDate(address, date, "mainnet");

    if (!snapshot) {
      return res.json({
        address,
        requestedDate: date,
        found: false,
        message: "No snapshots found for this wallet. Snapshots are recorded after you add the wallet.",
      });
    }

    res.json({
      address,
      requestedDate: date,
      found: true,
      snapshotDate: snapshot.snapshot_at,
      totalValueUSD: snapshot.total_value_usd,
      xlmBalance: snapshot.xlm_balance,
      xlmPriceUSD: snapshot.xlm_price_usd,
      tokenCount: snapshot.token_count,
      defiPositionCount: snapshot.defi_position_count,
      tokens: snapshot.tokens.map((t) => ({
        asset: t.asset_code,
        issuer: t.asset_issuer,
        contractId: t.contract_id,
        balance: t.balance,
        valueUSD: t.value_usd,
        priceUSD: t.price_usd,
      })),
    });
  } catch (e) {
    console.error("Snapshot-at error:", e.message);
    res.status(500).json({ error: "Failed to fetch snapshot" });
  }
});

// Enable/disable tracking for a wallet
app.post("/api/v1/account/:address/track", sameOriginOnly, (req, res) => {
  try {
    const { address } = req.params;
    const { label, tier } = req.body || {};
    historyDb.trackWallet(address, "mainnet", label || null, tier || "free");
    res.json({ success: true, address, tracked: true, tier: tier || "free" });
  } catch (e) {
    console.error("Track wallet error:", e.message);
    res.status(500).json({ error: "Failed to enable tracking" });
  }
});

app.delete("/api/v1/account/:address/track", sameOriginOnly, (req, res) => {
  try {
    const { address } = req.params;
    historyDb.untrackWallet(address);
    res.json({ success: true, address, tracked: false });
  } catch (e) {
    console.error("Untrack wallet error:", e.message);
    res.status(500).json({ error: "Failed to disable tracking" });
  }
});

// History DB stats
app.get("/api/v1/history/stats", (req, res) => {
  try {
    const stats = historyDb.getStats();
    res.json(stats);
  } catch (e) {
    console.error("History stats error:", e.message);
    res.status(500).json({ error: "Failed to fetch history stats" });
  }
});

// ── RWA Catalog Stats ────────────────────────────────────────────────────────
// Computes live market caps from Horizon for classic assets in the RWA
// catalog, and overlays hand-curated yield values from lib/rwa-yields.json.
// Frontend calls this once on RWA tab render. Soroban tokens have null market
// cap (would require Soroban contract introspection — future work).

const fs = require("fs");
const RWA_CATALOG_PATH = path.join(__dirname, "public", "rwa-catalog.json");
const RWA_YIELDS_PATH = path.join(__dirname, "lib", "rwa-yields.json");
const RWA_STATS_TTL = 5 * 60_000; // 5 min; Horizon supply moves slowly
let rwaStatsCache = { ts: 0, payload: null };

// SOFR is published by the NY Fed once per business day, so caching for
// 1 hour is plenty. Used to compute YLDS yield (SOFR - 35 bps per Figure).
// getSofrRate() returns today's overnight SOFR; getSofr30Avg() returns the
// 30-day compounded average (SOFR Averages Index) — a stable window-based
// figure for our 30d yield column.
const SOFR_TTL = 60 * 60_000;
let sofrCache = { ts: 0, rate: null, asOf: null };
let sofr30Cache = { ts: 0, rate: null, asOf: null };

async function getSofrRate() {
  if (sofrCache.rate != null && Date.now() - sofrCache.ts < SOFR_TTL) {
    return { rate: sofrCache.rate, asOf: sofrCache.asOf };
  }
  try {
    const res = await fetch("https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const rec = (data?.refRates || [])[0];
    if (!rec || typeof rec.percentRate !== "number") throw new Error("no SOFR record");
    sofrCache = { ts: Date.now(), rate: rec.percentRate, asOf: rec.effectiveDate };
    return { rate: rec.percentRate, asOf: rec.effectiveDate };
  } catch (e) {
    console.warn("SOFR fetch failed:", e.message);
    return sofrCache.rate != null
      ? { rate: sofrCache.rate, asOf: sofrCache.asOf } // stale ok
      : null;
  }
}

async function getSofr30Avg() {
  if (sofr30Cache.rate != null && Date.now() - sofr30Cache.ts < SOFR_TTL) {
    return { rate: sofr30Cache.rate, asOf: sofr30Cache.asOf };
  }
  try {
    const res = await fetch("https://markets.newyorkfed.org/api/rates/secured/sofrai/last/1.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const rec = (data?.refRates || [])[0];
    if (!rec || typeof rec.average30day !== "number") throw new Error("no SOFR30 record");
    sofr30Cache = { ts: Date.now(), rate: rec.average30day, asOf: rec.effectiveDate };
    return { rate: rec.average30day, asOf: rec.effectiveDate };
  } catch (e) {
    console.warn("SOFR30 fetch failed:", e.message);
    return sofr30Cache.rate != null
      ? { rate: sofr30Cache.rate, asOf: sofr30Cache.asOf }
      : null;
  }
}

function rwaSlugServer(a) {
  const id = (a.issuer || a.contractId || "").toLowerCase().slice(0, 6);
  return `${(a.code || "").toLowerCase()}-${id}`;
}

function formatBigUSD(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function fetchClassicMarketCap(code, issuer, xlmPrice) {
  // Horizon /assets returns total issued amount for the asset.
  try {
    const url = `${HORIZON_URL}/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${encodeURIComponent(issuer)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`RWA market cap: Horizon ${res.status} for ${code}`);
      return null;
    }
    const data = await res.json();
    const records = data?._embedded?.records || [];
    if (records.length === 0) return null;
    // Horizon dropped the flat `amount` field — current responses report
    // supply as balances.authorized. Keep `amount` as a fallback for older
    // Horizon deployments.
    const supply = parseFloat(
      records[0].balances?.authorized ?? records[0].amount ?? "0"
    );
    if (!Number.isFinite(supply) || supply <= 0) return null;
    const price = await pricingEngine.priceClassicAsset(
      { priceViaSDEX: getAssetPriceViaSDEX },
      code,
      issuer
    );
    if (!price || !price.usd) return { supply, marketCapUSD: null };
    return { supply, marketCapUSD: supply * price.usd, price };
  } catch (e) {
    console.warn(`RWA market cap fetch failed for ${code}/${issuer}:`, e.message);
    return null;
  }
}

// ── DeFi Explorer (top-level DeFi tab: protocol & pool directory) ──────────
// Serves the background-refreshed cache instantly; never fetches on the
// request path. First boot may return protocols with loading:true until the
// initial refresh cycle completes (~2 min; Soroswap is the long pole).
app.get("/api/v1/defi-explorer", (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json(defiExplorer.getSnapshot({ full: req.query.full === "1" }));
});

// Per-protocol detail: every pool, no TVL threshold (drill-down pages).
// The frontend's #/defi/{id} route depends on this; without it every
// protocol detail page 404s.
app.get("/api/v1/defi-explorer/:id", (req, res) => {
  const detail = defiExplorer.getProtocolDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "unknown protocol" });
  res.set("Cache-Control", "public, max-age=60");
  res.json(detail);
});

app.get("/api/v1/rwa-stats", async (req, res) => {
  // Match the server-side TTL so downstream callers can cache too.
  res.set("Cache-Control", `public, max-age=${RWA_STATS_TTL / 1000}`);
  if (rwaStatsCache.payload && Date.now() - rwaStatsCache.ts < RWA_STATS_TTL) {
    return res.json(rwaStatsCache.payload);
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(RWA_CATALOG_PATH, "utf8"));
    const yieldsFile = JSON.parse(fs.readFileSync(RWA_YIELDS_PATH, "utf8"));
    const curated = yieldsFile.stats || {};
    const xlmPrice = await getXLMPrice();

    const stats = {};
    for (const cat of (catalog.categories || [])) {
      for (const a of (cat.assets || [])) {
        const slug = rwaSlugServer(a);
        const entry = {
          yield7d: null,
          yield30d: null,
          marketCap: null,
          supplyTokens: null,
          asOf: null,
          source: null,
        };
        // Layer 1: curated values
        const c = curated[slug];
        if (c) {
          entry.yield7d = c.yield7d || null;
          entry.yield30d = c.yield30d || null;
          entry.marketCap = c.marketCap || null;
          entry.asOf = c.asOf || null;
          entry.source = c.source || null;
        }
        // Layer 1.5: live issuer-API yield + Stellar TVL (rwa-yield-fetcher)
        // overrides curated values. tvl and yield7d may come from the same or
        // different fetchers; both share the fetcher's asOf.
        const fresh = rwaYieldFetcher.getFreshYield(slug);
        if (fresh) {
          if (fresh.yield7d) {
            entry.yield7d = fresh.yield7d;
            entry.source = fresh.source || entry.source;
            // Optional: some fetchers (e.g. Babylon → xSolvBTC) attach a
            // reference URL so the UI can render a clickable footnote.
            if (fresh.sourceUrl) entry.sourceUrl = fresh.sourceUrl;
          }
          if (fresh.yield30d) {
            entry.yield30d = fresh.yield30d;
          }
          if (fresh.tvl) {
            entry.marketCap = fresh.tvl;
            entry.supplyTokens = fresh.supplyTokens ?? entry.supplyTokens;
            entry.tvlSource = fresh.tvlSource || null;
          }
          if (fresh.asOf) entry.asOf = fresh.asOf;
        }
        // Layer 2: live Horizon market cap (classic assets only) — overrides curated
        if (a.issuer && a.code) {
          const live = await fetchClassicMarketCap(a.code, a.issuer, xlmPrice);
          if (live) {
            entry.supplyTokens = live.supply;
            if (live.marketCapUSD) {
              entry.marketCap = formatBigUSD(live.marketCapUSD);
              entry.source = entry.source ? `${entry.source} + Horizon` : "Horizon";
              entry.asOf = new Date().toISOString().slice(0, 10);
            }
          }
        }
        // Layer 3: per-asset live yield overrides.
        // YLDS pays SOFR - 35 bps (per ylds.com); rwa.xyz doesn't track it
        // because yield accrues via daily distributions, not token price.
        // We use today's overnight SOFR for the 7d column and the NY Fed's
        // 30-day-average SOFR (SOFR Averages Index) for the 30d column.
        if (a.code === "YLDS") {
          const [sofr, sofr30] = await Promise.all([getSofrRate(), getSofr30Avg()]);
          if (sofr) {
            const yieldPct = sofr.rate - 0.35;
            entry.yield7d = `${yieldPct.toFixed(2)}%`;
            entry.asOf = sofr.asOf;
            entry.source = `NY Fed SOFR ${sofr.rate.toFixed(2)}% − 35 bps`;
          }
          if (sofr30) {
            const yield30Pct = sofr30.rate - 0.35;
            entry.yield30d = `${yield30Pct.toFixed(2)}%`;
          }
        }
        stats[slug] = entry;
      }
    }

    const payload = { stats, asOf: new Date().toISOString() };
    rwaStatsCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    console.error("RWA stats error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/v1/rwa-stats/fetcher-status", (_req, res) => {
  res.json(rwaYieldFetcher.getStatus());
});

// ── Multi-Wallet Portfolio API ───────────────────────────────────────────────

// List tracked wallets. DEPRECATED — the server-side table was originally
// a globally-shared list, which meant one user's tracked wallets showed up
// in every other visitor's "My Portfolio" view. That's a privacy leak: a
// friend visiting stellarscope.xyz for the first time could see anyone
// else's connected wallet.
//
// Wallet lists are now per-browser (localStorage in the SPA). The server
// still receives POSTs so scheduled snapshots continue to work, but this
// endpoint returns an empty list — nothing to leak.
app.get("/api/v1/wallets", (req, res) => {
  res.json({ count: 0, wallets: [] });
});

// Add a wallet to the portfolio. Response only echoes the wallet that was
// added — NOT the full tracked_wallets list (that used to leak everyone's
// tracked wallets to any caller who POSTed).
app.post("/api/v1/wallets", sameOriginOnly, (req, res) => {
  try {
    const { address, label, tier } = req.body || {};
    if (!address || !address.startsWith("G") || address.length !== 56) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    historyDb.trackWallet(address, "mainnet", label || null, tier || "free");
    res.json({ success: true, address });
  } catch (e) {
    console.error("Add wallet error:", e.message);
    res.status(500).json({ error: "Failed to add wallet" });
  }
});

// Update a wallet label
app.patch("/api/v1/wallets/:address", sameOriginOnly, (req, res) => {
  try {
    const { address } = req.params;
    const { label } = req.body || {};
    historyDb.db.prepare("UPDATE tracked_wallets SET label = ? WHERE address = ?").run(label, address);
    res.json({ success: true, address, label });
  } catch (e) {
    console.error("Update wallet error:", e.message);
    res.status(500).json({ error: "Failed to update wallet" });
  }
});

// Remove a wallet from the portfolio. Same as POST — response echoes only
// what was removed, never the full list.
app.delete("/api/v1/wallets/:address", sameOriginOnly, (req, res) => {
  try {
    const { address } = req.params;
    historyDb.untrackWallet(address);
    res.json({ success: true, address });
  } catch (e) {
    console.error("Remove wallet error:", e.message);
    res.status(500).json({ error: "Failed to remove wallet" });
  }
});

// Aggregated multi-wallet portfolio
app.post("/api/v1/portfolio", async (req, res) => {
  try {
    const { addresses } = req.body || {};

    // Callers must supply addresses. Previously we defaulted to the global
    // tracked_wallets list when addresses were empty — that leaked every
    // tracked wallet's balances to any caller.
    const walletAddresses = Array.isArray(addresses) ? addresses : [];

    if (walletAddresses.length === 0) {
      return res.json({
        network: "mainnet",
        walletCount: 0,
        totalValueUSD: 0,
        wallets: [],
        aggregatedBalances: [],
      });
    }

    const h = getHorizon();
    const xlmPrice = await getXLMPrice();

    // Seed XLM SAC price so Blend adapter avoids redundant CoinGecko call
    pricingEngine.seedSorobanPrice("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", {
      usd: xlmPrice.usd, change24h: xlmPrice.change24h, source: "coingecko", confidence: "high",
    });
    const walletResults = [];
    let grandTotalUSD = 0;

    // Aggregate balances across wallets by asset key
    const assetAgg = new Map(); // key → { code, issuer, totalBalance, totalValueUSD, price }

    // Wallets load in parallel — each is independent (Horizon account +
    // pricing + DeFi adapters). Shared aggregation (assetAgg, grand total)
    // is safe: mutations happen in synchronous blocks between awaits.
    await Promise.all(walletAddresses.map(async (address) => {
      try {
        const account = await h.loadAccount(address);
        const balances = [];
        let walletTotalUSD = 0;

        for (const bal of account.balances) {
          const amount = parseFloat(bal.balance);

          if (bal.asset_type === "native") {
            const valueUSD = amount * xlmPrice.usd;
            walletTotalUSD += valueUSD;
            balances.push({
              type: "native",
              asset: { code: "XLM", issuer: null },
              balance: bal.balance,
              valueUSD,
              price: xlmPrice,
            });

            const key = "XLM:native";
            const existing = assetAgg.get(key) || { code: "XLM", issuer: null, totalBalance: 0, totalValueUSD: 0, price: xlmPrice, wallets: [] };
            existing.totalBalance += amount;
            existing.totalValueUSD += valueUSD;
            existing.wallets.push({ address, balance: amount, valueUSD });
            assetAgg.set(key, existing);
          } else if (bal.asset_type !== "liquidity_pool_shares") {
            // Skip empty trustlines (drained tokens like USDx).
            if (amount === 0) continue;

            const code = bal.asset_code;
            const issuer = bal.asset_issuer;
            let price = null;
            let valueUSD = 0;

            price = await pricingEngine.priceClassicAsset(
              { priceViaSDEX: getAssetPriceViaSDEX },
              code,
              issuer
            );
            if (price) valueUSD = amount * price.usd;

            walletTotalUSD += valueUSD;
            balances.push({
              type: "token",
              asset: { code, issuer },
              balance: bal.balance,
              valueUSD,
              price,
            });

            const key = `${code}:${issuer}`;
            const existing = assetAgg.get(key) || { code, issuer, totalBalance: 0, totalValueUSD: 0, price, wallets: [] };
            existing.totalBalance += amount;
            existing.totalValueUSD += valueUSD;
            if (price) existing.price = price;
            existing.wallets.push({ address, balance: amount, valueUSD });
            assetAgg.set(key, existing);
          }
        }

        // DeFi positions — all protocol adapters in parallel with timeouts
        const { defiPositions, defiByPool, totalUSD: defiTotalUSD } =
          await collectDefiPositions(address, xlmPrice);
        walletTotalUSD += defiTotalUSD;

        grandTotalUSD += walletTotalUSD;

        // Get label from DB
        const tracked = historyDb.db
          .prepare("SELECT label FROM tracked_wallets WHERE address = ?")
          .get(address);

        walletResults.push({
          address,
          label: tracked?.label || null,
          totalValueUSD: walletTotalUSD,
          balanceCount: balances.length,
          balances,
          defiPositions,
          defiByPool,
        });

        // Auto-snapshot
        try {
          const latest = historyDb.getLatestSnapshot(address, "mainnet");
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          if (!latest || latest.snapshot_at < fiveMinAgo) {
            historyDb.recordSnapshot({
              address,
              network: "mainnet",
              totalValueUSD: walletTotalUSD,
              xlmPrice,
              balanceCount: balances.length,
              balances,
              defiPositions,
            }, "mainnet");
          }
        } catch (e) {}
      } catch (e) {
        walletResults.push({
          address,
          error: e.response?.status === 404 ? "Account not found" : e.message,
          totalValueUSD: 0,
          balances: [],
          defiPositions: [],
          defiByPool: [],
        });
      }
    }));

    // Sort aggregated balances by value
    const aggregatedBalances = Array.from(assetAgg.values())
      .sort((a, b) => b.totalValueUSD - a.totalValueUSD);

    res.json({
      network: "mainnet",
      walletCount: walletResults.length,
      totalValueUSD: grandTotalUSD,
      xlmPrice,
      wallets: walletResults.sort((a, b) => b.totalValueUSD - a.totalValueUSD),
      aggregatedBalances,
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Portfolio aggregation error:", e.message);
    res.status(500).json({ error: "Failed to aggregate portfolio" });
  }
});

// Aggregated portfolio history across all wallets
app.post("/api/v1/portfolio/history", (req, res) => {
  try {
    const { addresses } = req.body || {};
    const range = req.query.range || "30d";

    // Callers must supply addresses. Previously we defaulted to the global
    // tracked_wallets list when addresses were empty — a privacy leak.
    const walletAddresses = Array.isArray(addresses) ? addresses : [];

    // Get history for each wallet and merge by timestamp
    const timeMap = new Map(); // timestamp → { totalValueUSD, perWallet }

    for (const address of walletAddresses) {
      const snapshots = historyDb.getHistory(address, "mainnet", range);
      for (const snap of snapshots) {
        const ts = snap.snapshot_at;
        const existing = timeMap.get(ts) || { totalValueUSD: 0, walletCount: 0 };
        existing.totalValueUSD += snap.total_value_usd;
        existing.walletCount++;
        timeMap.set(ts, existing);
      }
    }

    // Sort by time and return
    const snapshots = Array.from(timeMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, data]) => ({
        timestamp: ts,
        totalValueUSD: data.totalValueUSD,
        walletCount: data.walletCount,
      }));

    let changeUSD = 0;
    let changePercent = 0;
    if (snapshots.length >= 2) {
      const first = snapshots[0].totalValueUSD;
      const last = snapshots[snapshots.length - 1].totalValueUSD;
      changeUSD = last - first;
      changePercent = first > 0 ? ((last - first) / first) * 100 : 0;
    }

    res.json({
      network: "mainnet",
      range,
      walletCount: walletAddresses.length,
      dataPoints: snapshots.length,
      change: { usd: changeUSD, percent: changePercent },
      snapshots,
    });
  } catch (e) {
    console.error("Portfolio history error:", e.message);
    res.status(500).json({ error: "Failed to fetch portfolio history" });
  }
});

// Set tracking tier (premium feature hook)
app.post("/api/v1/account/:address/tier", (req, res) => {
  try {
    const { address } = req.params;
    const { tier } = req.body || {};
    if (!tier) return res.status(400).json({ error: "tier is required (free, basic, pro, premium)" });
    historyDb.setTier(address, tier);
    res.json({ success: true, address, tier });
  } catch (e) {
    console.error("Set tier error:", e.message);
    res.status(400).json({ error: e.message });
  }
});

// Scheduler stats
app.get("/api/v1/scheduler/stats", (req, res) => {
  res.json(snapshotScheduler.getStats());
});

// Manual downsample trigger (admin)
app.post("/api/v1/history/downsample", (req, res) => {
  try {
    const result = historyDb.downsampleAll(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    console.error("Downsample error:", e.message);
    res.status(500).json({ error: "Failed to downsample" });
  }
});

// Top XLM whales leaderboard
const EXCLUDED_WHALES = new Set([
  "GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO", // burned
  // SDF mandate addresses
  "GB6NVEN5HSUBKMYCE5ZOWSK5K23TBWRUQLZY3KNMXUZ3AQ2ESC4MY4AQ",
  "GATL3ETTZ3XDGFXX2ELPIKCZL7S5D2HY3VK4T7LRPD6DW5JOLAEZSZBA",
  "GAKGC35HMNB7A3Q2V5SQU6VJC2JFTZB6I7ZW77SJSMRCOX2ZFBGJOCHH",
  "GAPV2C4BTHXPL2IVYDXJ5PUU7Q3LAXU7OAQDP7KVYHLCNM2JTAJNOQQI",
  "GCVJDBALC2RQFLD2HYGQGWNFZBCOD2CPOTN3LE7FWRZ44H2WRAVZLFCU",
  "GC3ITNZSVVPOWZ5BU7S64XKNI5VPTRSBEXXLS67V4K6LEUETWBMTE7IH",
  "GBEVKAYIPWC5AQT6D4N7FC3XGKRRBMPCAMTO3QZWMHHACLHTMAHAM2TP",
  "GDUY7J7A33TQWOSOQGDO776GGLM3UQERL4J3SPT56F6YS4ID7MLDERI4",
  "GCPWKVQNLDPD4RNP5CAXME4BEDTKSSYRR4MMEL4KG65NEGCOGNJW7QI2",
  "GDKIJJIKXLOM2NRMPNQZUUYK24ZPVFC6426GZAEP3KUK6KEJLACCWNMX",
  "GDWXQOTIIDO2EUK4DIGIBLEHLME2IAJRNU6JDFS5B2ZTND65P7J36WQZ",
  "GAMGGUQKKJ637ILVDOSCT5X7HYSZDUPGXSUW67B2UKMG2HEN5TPWN3LQ",
  "GANII5Y2LABEBK74NWNKS4NREX2T52YTBGQDRVKVBFRIIF5VE4ORYOVY",
  "GBFZPAHO24P7ZVZCMI5SXZR53UYD325OWSSWWHHVLBNN56LU5YZJJFNP",
]);

app.get("/api/v1/whales", sameOriginOnly, async (req, res) => {
  try {
    // Fetch extra to have enough after filtering
    const response = await fetch("https://api.stellar.expert/explorer/public/asset/XLM/holders?order=desc&limit=40");
    const data = await response.json();
    const records = data._embedded?.records || [];

    const filtered = records
      .filter(a => !EXCLUDED_WHALES.has(a.address))
      .slice(0, 10);

    const h = getHorizon();
    const whales = await Promise.all(filtered.map(async (a) => {
      const xlmBalance = Math.round(parseInt(a.balance) / 10_000_000);
      let assetCount = null;
      try {
        const account = await h.loadAccount(a.address);
        assetCount = account.balances.length; // includes native XLM + all trustlines
      } catch (e) { /* leave null if account can't be loaded */ }
      return { address: a.address, balance: xlmBalance, assetCount };
    }));

    res.json({ whales });
  } catch (e) {
    console.error("Whales error:", e.message);
    res.status(500).json({ error: "Failed to fetch whales" });
  }
});

// ── Portfolio Whale Scorer ────────────────────────────────────────────────────
// Strategy:
//  1. Fetch top holders of each of the 15 tracked assets from Stellar Expert.
//  2. Union those G... addresses (ignoring dust and contract addresses).
//  3. Score each candidate: classic assets via Horizon + Soroban balances from
//     the SE holder data (no extra RPC needed — SE already provides balances).
//  4. Rank by total non-XLM USD value across ALL assets, return top 10.
//  Results are cached 30 minutes and refreshed in the background.

const TRACKED_ASSETS = require("./lib/tracked-assets");
const PORTFOLIO_WHALE_TTL = 30 * 60 * 1000; // 30 minutes

let portfolioWhaleCache = null;
let portfolioWhaleComputing = false;
let btcPriceUSD = 80000; // updated live before each compute run

async function refreshBTCPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const data = await res.json();
    if (data?.bitcoin?.usd) btcPriceUSD = data.bitcoin.usd;
  } catch (e) { /* keep last known price */ }
}

// Fetch top holders for one asset from Stellar Expert.
// Returns array of { address, rawBalance } for G... addresses above the dust threshold.
async function fetchAssetHolders(asset) {
  const id = asset.kind === "soroban"
    ? asset.contractId
    : `${asset.code}-${asset.issuer}`;
  try {
    const res = await fetch(
      `https://api.stellar.expert/explorer/public/asset/${id}/holders?order=desc&limit=200`
    );
    if (!res.ok) return [];
    const data = await res.json();
    const records = data._embedded?.records || [];
    const decPow = Math.pow(10, asset.decimals || 7);
    return records
      .filter(r => (r.address || r.account || "").startsWith("G"))
      .filter(r => parseInt(r.balance || 0) / decPow >= (asset.minTokenBalance || 0))
      .map(r => ({ address: r.address || r.account, rawBalance: parseInt(r.balance || 0) }));
  } catch (e) {
    return [];
  }
}

// Score one candidate wallet across only the 15 tracked assets.
// Scoring against a fixed universe prevents junk/illiquid tokens from
// inflating values via thin SDEX orderbooks.
// sorobanBalances: Map<contractId, rawBalance> from SE holder data.
async function scoreWallet(h, address, sorobanBalances, classicPrices) {
  let totalUSD = 0;
  let assetCount = 0;

  // Classic tracked assets — look up Horizon balance, price from pre-fetched map
  const trackedClassic = TRACKED_ASSETS.filter(a => a.kind === "classic");
  try {
    const account = await h.loadAccount(address);
    for (const asset of trackedClassic) {
      const bal = account.balances.find(b =>
        b.asset_code === asset.code && b.asset_issuer === asset.issuer
      );
      if (!bal) continue;
      const amount = parseFloat(bal.balance);
      if (amount <= 0) continue;
      const priceUSD = classicPrices.get(`${asset.code}:${asset.issuer}`);
      if (!priceUSD) continue;
      totalUSD += amount * priceUSD;
      assetCount++;
    }
  } catch (e) { /* account may not load */ }

  // Soroban tracked assets — use balances already fetched from SE
  for (const asset of TRACKED_ASSETS.filter(a => a.kind === "soroban")) {
    const rawBal = sorobanBalances.get(asset.contractId);
    if (!rawBal || rawBal <= 0) continue;
    const amount = rawBal / Math.pow(10, asset.decimals || 7);
    if (amount <= 0) continue;
    const priceUSD = asset.priceHintUSD === "btc" ? btcPriceUSD : asset.priceHintUSD;
    if (priceUSD) {
      totalUSD += amount * priceUSD;
      assetCount++;
    }
  }

  return totalUSD > 0 ? { address, totalUSD, assetCount } : null;
}

// Fetch USD prices for all classic tracked assets in one CoinGecko batch call.
// Falls back to priceHintUSD when CoinGecko doesn't have a price.
async function fetchClassicTrackedPrices() {
  const classics = TRACKED_ASSETS.filter(a => a.kind === "classic" && a.coingeckoId);
  const ids = classics.map(a => a.coingeckoId).join(",");
  const prices = new Map(); // `${code}:${issuer}` → priceUSD
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    const data = await res.json();
    for (const asset of classics) {
      const usd = data[asset.coingeckoId]?.usd ?? asset.priceHintUSD;
      if (usd) prices.set(`${asset.code}:${asset.issuer}`, usd);
    }
  } catch (e) {
    // CoinGecko failed — fall back to hints only
    for (const asset of classics) {
      if (asset.priceHintUSD) prices.set(`${asset.code}:${asset.issuer}`, asset.priceHintUSD);
    }
  }
  return prices;
}

async function computePortfolioWhales() {
  if (portfolioWhaleComputing) return;
  portfolioWhaleComputing = true;
  try {
    await refreshBTCPrice();

    // Step 1: fetch holders + prices in parallel
    console.log("[portfolio-whales] Fetching holders for all tracked assets...");
    const [holderLists, classicPrices] = await Promise.all([
      Promise.all(TRACKED_ASSETS.map(fetchAssetHolders)),
      fetchClassicTrackedPrices(),
    ]);
    console.log(`[portfolio-whales] Classic prices fetched: ${classicPrices.size} assets`);

    // Step 2: build candidate map — address → soroban balances
    // Also union all G... addresses into a candidate set
    const sorobanBalanceMap = new Map(); // address → Map<contractId, rawBalance>
    const candidateSet = new Set();

    TRACKED_ASSETS.forEach((asset, idx) => {
      for (const { address, rawBalance } of holderLists[idx]) {
        if (EXCLUDED_WHALES.has(address)) continue;
        candidateSet.add(address);
        if (asset.kind === "soroban") {
          if (!sorobanBalanceMap.has(address)) sorobanBalanceMap.set(address, new Map());
          sorobanBalanceMap.get(address).set(asset.contractId, rawBalance);
        }
      }
    });

    const candidates = [...candidateSet];
    console.log(`[portfolio-whales] ${candidates.length} unique candidates across all assets`);

    // Step 3: score each candidate in batches to stay under Horizon rate limits
    const h = getHorizon();
    const all = [];
    const BATCH = 20;

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(addr =>
        scoreWallet(h, addr, sorobanBalanceMap.get(addr) || new Map(), classicPrices)
      ));
      for (const r of results) { if (r) all.push(r); }
    }

    const whales = all.sort((a, b) => b.totalUSD - a.totalUSD).slice(0, 10);
    portfolioWhaleCache = { whales, computedAt: new Date().toISOString() };
    console.log(`[portfolio-whales] Done. ${whales.length} results, top: $${Math.round(whales[0]?.totalUSD || 0).toLocaleString()}`);
  } catch (e) {
    console.error("[portfolio-whales] Compute error:", e.message);
  } finally {
    portfolioWhaleComputing = false;
  }
}

// Kick off on startup, refresh every 30 minutes
computePortfolioWhales();
setInterval(computePortfolioWhales, PORTFOLIO_WHALE_TTL);

app.get("/api/v1/portfolio-whales", sameOriginOnly, async (req, res) => {
  if (req.query.refresh === "1" && !portfolioWhaleComputing) {
    computePortfolioWhales();
  }

  if (!portfolioWhaleCache) {
    const deadline = Date.now() + 180_000; // wait up to 3 min on first run
    while (!portfolioWhaleCache && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (!portfolioWhaleCache) {
    return res.status(503).json({ error: "Still computing — try again in a moment" });
  }

  const stale = Date.now() - new Date(portfolioWhaleCache.computedAt).getTime() > PORTFOLIO_WHALE_TTL;
  if (stale && !portfolioWhaleComputing) computePortfolioWhales();

  res.json({
    whales: portfolioWhaleCache.whales,
    computedAt: portfolioWhaleCache.computedAt,
    refreshing: portfolioWhaleComputing,
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    network: "mainnet",
    sorobanRpc: require("./lib/soroban-rpc").SOROBAN_RPC_URL,
    configuredProtocols: PROTOCOL_ADAPTERS.filter((a) => a.isConfigured()).map((a) => a.protocolId),
    registeredSorobanTokens: getRegistry().filter((t) => t.enabled).length,
    historyDb: historyDb.getStats(),
    scheduler: snapshotScheduler.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// Serve frontend
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Background Snapshot Scheduler ────────────────────────────────────────────

/**
 * Fetch a full portfolio for a given address/network.
 * Used by the scheduler to take snapshots without an HTTP request.
 */
async function fetchPortfolioForScheduler(address) {
  const h = getHorizon();
  const account = await h.loadAccount(address);
  const xlmPrice = await getXLMPrice();

  const balances = [];
  let totalValueUSD = 0;

  for (const bal of account.balances) {
    const amount = parseFloat(bal.balance);

    if (bal.asset_type === "native") {
      const reserved =
        (2 + account.subentry_count * 0.5 + account.num_sponsoring * 0.5 - account.num_sponsored * 0.5);
      const valueUSD = amount * xlmPrice.usd;
      totalValueUSD += valueUSD;
      balances.push({
        type: "native",
        asset: { code: "XLM", issuer: null },
        balance: bal.balance,
        valueUSD,
        price: xlmPrice,
      });
    } else if (bal.asset_type === "liquidity_pool_shares") {
      balances.push({ type: "lp_share", poolId: bal.liquidity_pool_id, shares: bal.balance, valueUSD: 0 });
    } else {
      // Skip empty trustlines (drained tokens).
      if (amount === 0) continue;

      const code = bal.asset_code;
      const issuer = bal.asset_issuer;
      let price = null;
      let valueUSD = 0;

      price = await pricingEngine.priceClassicAsset(
        { priceViaSDEX: getAssetPriceViaSDEX },
        code,
        issuer
      );
      if (price) valueUSD = amount * price.usd;

      totalValueUSD += valueUSD;
      balances.push({
        type: "token",
        asset: { code, issuer },
        balance: bal.balance,
        valueUSD,
        price,
      });
    }
  }

  // Soroban tokens
  try {
    const sorobanTokens = await resolveSorobanTokens(address);
    for (const st of sorobanTokens) {
      totalValueUSD += st.valueUSD || 0;
      balances.push(st);
    }
  } catch (e) { /* ignore for scheduler */ }

  // Auto-discovered Soroban tokens (cached, so usually a no-op in the scheduler loop)
  try {
    const rawDiscovered = await discoverSorobanTokens(address);
    const discoveredTokens = dedupSACsAgainstClassicBalances(rawDiscovered, balances);
    for (const dt of discoveredTokens) {
      totalValueUSD += dt.valueUSD || 0;
      balances.push(dt);
    }
  } catch (e) { /* ignore for scheduler */ }

  // DeFi positions
  const defiPositions = [];
  for (const adapter of PROTOCOL_ADAPTERS) {
    if (!adapter.isConfigured()) continue;
    try {
      const positions = await adapter.getPositions(address, { xlmPrice });
      for (const pos of positions) {
        totalValueUSD += pos.valueUSD || 0;
        defiPositions.push(pos);
      }
    } catch (e) { /* ignore for scheduler */ }
  }

  return {
    address,
    network: "mainnet",
    totalValueUSD,
    xlmPrice,
    balanceCount: balances.length,
    balances,
    defiPositions,
  };
}

// Initialize scheduler with the portfolio fetch function
snapshotScheduler.init(fetchPortfolioForScheduler);

const PORT = process.env.PORT || 4000;
// Public API + portfolio profiles
app.use(createPublicApiRoutes(fetchPortfolioForScheduler));

app.listen(PORT, () => {
  console.log(`Stellar Moonshot Bank API running on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  // Start background snapshot scheduler
  snapshotScheduler.start();

  // Start hourly RWA yield refresh (Centrifuge today; more issuers to come)
  rwaYieldFetcher.start();

  // Start DeFi Explorer background refresh (protocol & pool directory)
  defiExplorer.start();

  // Run daily downsampling at startup (and it could be scheduled via cron too)
  setTimeout(() => {
    try {
      const result = historyDb.downsampleAll();
      if (result.totalDeletedRows > 0) {
        console.log(`[Cleanup] Downsampled ${result.totalDeletedRows} old snapshots across ${result.walletsProcessed} wallets`);
      }
    } catch (e) {
      console.error("[Cleanup] Downsample error:", e.message);
    }
  }, 30_000);
});
