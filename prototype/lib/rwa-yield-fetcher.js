/**
 * RWA Yield & TVL Fetcher
 *
 * Periodically pulls live yield and Stellar-only TVL values from each issuer's
 * API and overlays them on the curated rwa-yields.json (which remains the
 * durable fallback).
 *
 * Design:
 *   - One fetcher function per issuer. Each may return values for multiple
 *     slugs in a single network call.
 *   - Each returned entry can carry any subset of: yield7d, tvl, supplyTokens,
 *     asOf, source, tvlSource. Multiple fetchers writing to the same slug are
 *     merged (last-write-wins per field).
 *   - Additional non-issuer pass: `fetchSorobanSupplies` queries each Soroban
 *     token's on-chain total_supply and prices it via a per-token price hint
 *     (USD peg, BTC, gold, EUR, etc.). Covers tokens whose issuer doesn't
 *     surface a public supply API.
 *   - Hourly background refresh. Per-slug 24h grace window keeps stale
 *     fetched values alive across short outages; beyond that, server.js falls
 *     back to the curated JSON.
 *
 * Adding an issuer:
 *   1. Write an async function returning { "<slug>": { yield7d?, tvl?, asOf, source } }
 *      (or {} on failure — never throw past the boundary).
 *   2. Add it to REFRESHERS.
 */

const { getTokenSupply } = require("./soroban-rpc");

const REFRESH_INTERVAL = 60 * 60_000; // 1 hour
const STALE_GRACE = 24 * 60 * 60_000; // serve fetched values up to 24h if refresh fails

let cache = new Map(); // slug -> { ts, value: { yield7d?, tvl?, supplyTokens?, asOf, source? } }
let lastRefreshTs = 0;
let lastRefreshSummary = null;

// ── Format helper ───────────────────────────────────────────────────────────

function formatBigUSD(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ── Price feeds (BTC, gold, EUR, GBP) ───────────────────────────────────────
// Cached alongside the hourly refresh so all TVL numbers in a given cycle use
// the same prices. Fall back to `null` on failure; per-slug pricing then skips
// that slug rather than emit a wrong number.

const _priceCache = { btcUsd: null, goldUsdPerOz: null, eurUsd: null, gbpUsd: null, ts: 0 };

async function refreshPrices() {
  const [cgRes, fxRes] = await Promise.allSettled([
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,pax-gold&vs_currencies=usd"),
    fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP"),
  ]);
  if (cgRes.status === "fulfilled" && cgRes.value.ok) {
    try {
      const j = await cgRes.value.json();
      if (Number.isFinite(j?.bitcoin?.usd)) _priceCache.btcUsd = j.bitcoin.usd;
      // PAXG is 1 troy oz LBMA-backed — the token price is spot gold per oz.
      if (Number.isFinite(j?.["pax-gold"]?.usd)) _priceCache.goldUsdPerOz = j["pax-gold"].usd;
    } catch (e) {
      console.warn("[rwa-yield-fetcher] CoinGecko parse failed:", e.message);
    }
  }
  if (fxRes.status === "fulfilled" && fxRes.value.ok) {
    try {
      const j = await fxRes.value.json();
      // Frankfurter returns rates as "1 USD = N X", so USD/X = 1 / (1 X per USD).
      if (Number.isFinite(j?.rates?.EUR) && j.rates.EUR > 0) _priceCache.eurUsd = 1 / j.rates.EUR;
      if (Number.isFinite(j?.rates?.GBP) && j.rates.GBP > 0) _priceCache.gbpUsd = 1 / j.rates.GBP;
    } catch (e) {
      console.warn("[rwa-yield-fetcher] Frankfurter parse failed:", e.message);
    }
  }
  _priceCache.ts = Date.now();
}

// ── Centrifuge (yield + tvl) ────────────────────────────────────────────────
// Public read-only GraphQL endpoint. `yield7d365` is a fixed-point BigInt
// scaled by 1e27 (ray precision). `tokenPrice` is a BigInt scaled by 1e18.
// For Stellar-only TVL we query the Stellar Soroban contract's total_supply
// (Centrifuge's tokens are chain-specific wrappers of the same fund).

const CENTRIFUGE_API = "https://api.centrifuge.io/";
const CENTRIFUGE_YIELD_SCALE = 1e27;
const CENTRIFUGE_PRICE_SCALE = 1e18;

// Map Centrifuge symbol → array of { slug, stellarContractId, decimals } for
// each on-Stellar wrapper of that fund.
const CENTRIFUGE_TOKENS = {
  JAAA: [
    { slug: "jaaa-cdv6u7",   stellarContractId: "CDV6U7OEVY6KUEJ4WNS63AYB6RFU3BAE7AZJOQ7LPH447C6NWUXEZZSO", decimals: 18 },
    { slug: "dejaaa-cc64wb", stellarContractId: "CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL", decimals: 18 },
  ],
  JTRSY: [
    { slug: "jtrsy-cbhoek",   stellarContractId: "CBHOEKLWTB6HR2A3IXHIIMQG5FOXWXS6EG4Q5YJDRPMXPCX7M24CYR2O", decimals: 18 },
    { slug: "dejtrsy-cbi7uc", stellarContractId: "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV", decimals: 18 },
  ],
};

async function fetchCentrifuge() {
  const query = `{
    tokens(where: { symbol_in: ${JSON.stringify(Object.keys(CENTRIFUGE_TOKENS))} }) {
      items { symbol id }
    }
  }`;
  const tokens = await centrifugeQuery(query).then(d => d?.tokens?.items || []);
  if (tokens.length === 0) return {};

  const out = {};
  await Promise.all(tokens.map(async (t) => {
    const wrappers = CENTRIFUGE_TOKENS[t.symbol];
    if (!wrappers) return;
    const snap = await fetchLatestSnapshot(t.id);
    if (!snap) return;
    // Per-share USD price (BigInt / 1e18). Fund-wide, applies to all wrappers.
    let pricePerShare = null;
    try {
      pricePerShare = Number(BigInt(snap.tokenPrice)) / CENTRIFUGE_PRICE_SCALE;
    } catch { /* leave null */ }
    const yieldEntry = formatCentrifugeYield(snap);

    // Query on-chain supply for each Stellar wrapper independently.
    await Promise.all(wrappers.map(async ({ slug, stellarContractId, decimals }) => {
      const supply = await getTokenSupply(stellarContractId, decimals);
      const entry = { ...(yieldEntry || {}) };
      if (Number.isFinite(supply) && Number.isFinite(pricePerShare)) {
        const usd = supply * pricePerShare;
        entry.tvl = formatBigUSD(usd);
        entry.supplyTokens = supply;
        entry.tvlSource = "Centrifuge (Stellar supply × fund NAV)";
      }
      if (Object.keys(entry).length > 0) out[slug] = entry;
    }));
  }));
  return out;
}

async function fetchLatestSnapshot(tokenId) {
  const q = `{
    tokenSnapshots(
      where: { id: "${tokenId}" },
      orderBy: "timestamp",
      orderDirection: "desc",
      limit: 1
    ) { items { timestamp yield7d365 yield30dComp365 tokenPrice } }
  }`;
  const items = await centrifugeQuery(q).then(d => d?.tokenSnapshots?.items || []);
  return items[0] || null;
}

function _centrifugePct(raw) {
  if (raw == null) return null;
  try {
    const pct = Number(BigInt(raw)) / CENTRIFUGE_YIELD_SCALE * 100;
    return Number.isFinite(pct) ? pct : null;
  } catch { return null; }
}

function formatCentrifugeYield(snap) {
  const pct7 = _centrifugePct(snap?.yield7d365);
  const pct30 = _centrifugePct(snap?.yield30dComp365);
  if (pct7 == null && pct30 == null) return null;
  const ts = parseInt(snap.timestamp, 10);
  const asOf = Number.isFinite(ts)
    ? new Date(ts).toISOString().slice(0, 10)
    : todayISO();
  const out = {
    asOf,
    source: "Centrifuge (fund APY)",
  };
  if (pct7 != null) out.yield7d = `${pct7.toFixed(2)}%`;
  if (pct30 != null) out.yield30d = `${pct30.toFixed(2)}%`;
  return out;
}

async function centrifugeQuery(query) {
  const res = await fetch(CENTRIFUGE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Centrifuge HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Centrifuge GraphQL: ${json.errors[0]?.message}`);
  return json.data;
}

// ── Spiko (yield + tvl) ─────────────────────────────────────────────────────
// Public REST API, no auth. Yield endpoint returns weeklyYield as a fractional
// decimal. Totals endpoint returns NAV per share in the fund's currency (USD
// for USTBL, EUR for EUTBL/SAFO, GBP for UKTBL). Stellar-only TVL = on-chain
// Stellar supply × per-share NAV × FX-to-USD.

const SPIKO_API = "https://public-api.spiko.io/v0";

// NOTE: no per-token `fx` hint — the FX currency is read from the /totals
// response ("netAssetValue.amount.currency") so the fetcher can't drift from
// Spiko's own denomination. (SAFO is a USD-denominated money-market fund
// even though Amundi is a European asset manager — a hard-coded EUR hint
// previously inflated its Stellar TVL by ~15%.)
// Spiko exposes each share class as its own record. SAFO (Amundi Overnight)
// has two classes on Stellar — USD (SAFO / "Spiko Dollar") and EUR (eurSAFO /
// "Spiko Euro"). Same fund, different denominations. DefiLlama tracks the EUR
// class under a lowercased "safo" alias which is confusing; here we use the
// Spiko-canonical symbols verbatim.
const SPIKO_TOKENS = {
  USTBL:   { slug: "ustbl-caruux",   stellarContractId: "CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO", decimals: 5 },
  EUTBL:   { slug: "eutbl-cbgv2q",   stellarContractId: "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF", decimals: 5 },
  UKTBL:   { slug: "uktbl-cdt3ku",   stellarContractId: "CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR", decimals: 5 },
  SAFO:    { slug: "safo-cdgsc6",    stellarContractId: "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX", decimals: 5 },
  eurSAFO: { slug: "eursafo-cboocg", stellarContractId: "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP", decimals: 5 },
};

function _spikoFxToUsd(fx) {
  if (fx === "USD") return 1;
  if (fx === "EUR") return _priceCache.eurUsd;
  if (fx === "GBP") return _priceCache.gbpUsd;
  return null;
}

async function fetchSpiko() {
  const out = {};
  await Promise.all(Object.entries(SPIKO_TOKENS).map(async ([symbol, cfg]) => {
    const entry = {};
    // Yield
    try {
      const res = await fetch(`${SPIKO_API}/share-classes/${symbol}/yield`);
      if (res.ok) {
        const data = await res.json();
        const wy = parseFloat(data?.weeklyYield);
        const my = parseFloat(data?.monthlyYield);
        if (Number.isFinite(wy)) {
          entry.yield7d = `${(wy * 100).toFixed(2)}%`;
        }
        if (Number.isFinite(my)) {
          entry.yield30d = `${(my * 100).toFixed(2)}%`;
        }
        if (Number.isFinite(wy) || Number.isFinite(my)) {
          entry.asOf = data?.updatedAt ? data.updatedAt.slice(0, 10) : todayISO();
          entry.source = "Spiko (annualized yield)";
        }
      }
    } catch (e) {
      console.warn(`[rwa-yield-fetcher] Spiko ${symbol} yield failed: ${e.message}`);
    }
    // TVL: Stellar supply × NAV × FX(if NAV isn't already USD).
    // Currency comes from the /totals response — never hard-coded — so a
    // share class that switches or is misclassified in our config can't
    // silently inflate/deflate the reported TVL.
    try {
      const [totalsRes, supply] = await Promise.all([
        fetch(`${SPIKO_API}/share-classes/${symbol}/totals`),
        getTokenSupply(cfg.stellarContractId, cfg.decimals),
      ]);
      if (totalsRes.ok && Number.isFinite(supply)) {
        const totals = await totalsRes.json();
        const nav = parseFloat(totals?.netAssetValue?.amount?.value);
        const navCurrency = totals?.netAssetValue?.amount?.currency;
        const fx = _spikoFxToUsd(navCurrency);
        if (Number.isFinite(nav) && Number.isFinite(fx)) {
          const usd = supply * nav * fx;
          entry.tvl = formatBigUSD(usd);
          entry.supplyTokens = supply;
          entry.tvlSource = navCurrency === "USD"
            ? "Spiko (Stellar supply × NAV)"
            : `Spiko (Stellar supply × NAV × ${navCurrency}/USD)`;
          if (!entry.asOf) entry.asOf = todayISO();
        } else if (Number.isFinite(nav) && !Number.isFinite(fx)) {
          console.warn(`[rwa-yield-fetcher] Spiko ${symbol}: unknown NAV currency ${navCurrency} — skipping TVL`);
        }
      }
    } catch (e) {
      console.warn(`[rwa-yield-fetcher] Spiko ${symbol} tvl failed: ${e.message}`);
    }
    if (Object.keys(entry).length > 0) out[cfg.slug] = entry;
  }));
  return out;
}

// ── Etherfuse (yield + tvl) ─────────────────────────────────────────────────
// Public REST API, no auth. Per-bond endpoint returns `current_basis_points`
// (bps of APY) and `bond_cost_in_usd`. The stablebonds list returns per-chain
// `totalSupply` — we filter to the Stellar entry and multiply.

const ETHERFUSE_API = "https://api.etherfuse.com";

const ETHERFUSE_SYMBOLS = {
  USTRY:   "ustry-gcryug",
  CETES:   "cetes-gcryug",
  TESOURO: "tesouro-gcryug",
};

async function fetchEtherfuse() {
  const out = {};
  // Grab the full bond list once (has per-chain supply). Then hit /cost/{sym}
  // in parallel for APY + USD price per bond.
  let stablebondsBySymbol = {};
  try {
    const res = await fetch(`${ETHERFUSE_API}/lookup/stablebonds`);
    if (res.ok) {
      const data = await res.json();
      for (const b of data?.stablebonds || []) stablebondsBySymbol[b.symbol] = b;
    }
  } catch (e) {
    console.warn(`[rwa-yield-fetcher] Etherfuse list-stablebonds failed: ${e.message}`);
  }

  await Promise.all(Object.entries(ETHERFUSE_SYMBOLS).map(async ([symbol, slug]) => {
    const entry = {};
    try {
      const res = await fetch(`${ETHERFUSE_API}/lookup/bonds/cost/${symbol}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const bps = Number(data?.current_basis_points);
      if (Number.isFinite(bps)) {
        const pct = `${(bps / 100).toFixed(2)}%`;
        entry.yield7d = pct;
        // Etherfuse issues bonds with a set coupon rate; current_basis_points
        // is that rate, not a rolling window. It's already stable within the
        // bond term, so the 30-day figure is the same value.
        entry.yield30d = pct;
        entry.source = "Etherfuse (current bond APY)";
      }
      entry.asOf = data?.current_time ? data.current_time.slice(0, 10) : todayISO();

      const usdPerToken = parseFloat(data?.bond_cost_in_usd);
      const bond = stablebondsBySymbol[symbol];
      const stellarLeg = (bond?.blockchains || []).find(b => b.blockchain === "stellar");
      const stellarSupply = parseFloat(stellarLeg?.totalSupply);
      if (Number.isFinite(usdPerToken) && Number.isFinite(stellarSupply)) {
        const usd = stellarSupply * usdPerToken;
        entry.tvl = formatBigUSD(usd);
        entry.supplyTokens = stellarSupply;
        entry.tvlSource = "Etherfuse (Stellar supply × USD price)";
      }
    } catch (e) {
      console.warn(`[rwa-yield-fetcher] Etherfuse ${symbol} failed: ${e.message}`);
    }
    if (Object.keys(entry).length > 0) out[slug] = entry;
  }));
  return out;
}

// ── Ondo (yield only) ───────────────────────────────────────────────────────
// Ondo's authenticated API requires an API key we don't have. Parse the public
// marketing page for APY. No supply endpoint — TVL for USDY comes from the
// classic-asset Horizon path in server.js (USDY is a classic Stellar asset).

const ONDO_USDY_URL = "https://ondo.finance/usdy";

async function fetchOndo() {
  try {
    const res = await fetch(ONDO_USDY_URL, {
      headers: { "User-Agent": "stellar-scope-rwa-fetcher/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let html = await res.text();
    html = html.replace(/\\"/g, '"');
    const m = html.match(/"name":"Ondo US Dollar Yield"[^}]{0,200}?"apy":\s*([\d.]+)/);
    if (!m) throw new Error("apy field not found in HTML");
    const pct = parseFloat(m[1]);
    if (!Number.isFinite(pct)) throw new Error("apy not numeric");
    // Ondo's published APY is computed from 30-day NAV growth per their own
    // formula (APY = e^((End_NAV - Start_NAV) / (30/365)) - 1). So the
    // number is already effectively a 30-day figure; show it in both columns.
    const yieldStr = `${pct.toFixed(2)}%`;
    return {
      "usdy-gajmpx": {
        yield7d: yieldStr,
        yield30d: yieldStr,
        asOf: todayISO(),
        source: "Ondo USDY (live APY from ondo.finance; 30-day NAV growth)",
      },
    };
  } catch (e) {
    console.warn(`[rwa-yield-fetcher] Ondo failed: ${e.message}`);
    return {};
  }
}

// ── Babylon (xSolvBTC underlying yield reference) ──────────────────────────
// Solv doesn't expose a public API. xSolvBTC (aka SolvBTC.BBN) accrues yield
// from Babylon Bitcoin staking, so we show Babylon's own displayed range
// (base APR – max APR) as the reference rate — matching what users see on
// staking.babylonlabs.io/btc.
//
// Important nuance: yield distribution to Stellar xSolvBTC holders is
// paused pending LayerZero, so the number shown here is the underlying
// protocol rate, NOT what a Stellar holder currently earns. The source
// label carries that caveat.

const BABYLON_STATS_URL = "https://staking-api.babylonlabs.io/v2/stats";
const BABYLON_STAKING_URL = "https://staking.babylonlabs.io/btc";

async function fetchBabylon() {
  try {
    const res = await fetch(BABYLON_STATS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data;
    const baseApr = Number(d?.btc_staking_apr);
    const maxApr = Number(d?.max_staking_apr);
    if (!Number.isFinite(baseApr) || !Number.isFinite(maxApr)) {
      throw new Error("apr fields missing from response");
    }
    // Babylon returns fractional APR (0.0005 = 0.05%). Multiply for display.
    const basePct = (baseApr * 100).toFixed(2);
    const maxPct = (maxApr * 100).toFixed(2);
    return {
      "xsolvbtc-caup7n": {
        // Range with an asterisk pointing to the source URL. Rendered as text
        // in the list view; the detail page renders a clickable link via
        // sourceUrl below.
        yield7d: `${basePct}% – ${maxPct}%*`,
        asOf: todayISO(),
        source: "Babylon BTC staking APR — base is BTC-only; max requires co-staking BABY. Whether xSolvBTC holders receive base or max depends on Solv's staking strategy. Stellar distribution paused pending LayerZero.",
        sourceUrl: BABYLON_STAKING_URL,
      },
    };
  } catch (e) {
    console.warn(`[rwa-yield-fetcher] Babylon failed: ${e.message}`);
    return {};
  }
}

// ── Soroban RPC supply pass (tvl only) ──────────────────────────────────────
// For Soroban-native tokens whose issuers don't expose a supply API, we query
// total_supply directly and price the result via a per-token hint.

const SOROBAN_TVL_TOKENS = [
  {
    slug: "usst-cbz4dc",     contractId: "CBZ4DCE7PYMUTOAKKUTRSUPT3FJFVOWCSKWUM5A72D6SAVMUJE5JN2PJ",
    decimals: 18, priceLabel: "USD peg",  priceFn: () => 1.0,
  },
  {
    slug: "xaum-cc2rbg",     contractId: "CC2RBGYNCFBCVENIDL5BFBWPH4OUZM2UA3OD2K2N54GLMWCC4KWPVAGO",
    decimals: 9,  priceLabel: "PAXG spot", priceFn: () => _priceCache.goldUsdPerOz,
  },
  {
    slug: "solvbtc-cbijbd",  contractId: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN",
    decimals: 8,  priceLabel: "BTC spot",  priceFn: () => _priceCache.btcUsd,
  },
  {
    slug: "xsolvbtc-caup7n", contractId: "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J",
    decimals: 8,  priceLabel: "BTC spot",  priceFn: () => _priceCache.btcUsd,
  },
  {
    slug: "euraud-cb44w7",   contractId: "CB44W727WSLHPXJ47A6DHF5D34RKWSOZAMEDXO3CF5TEEEQ2ZX4V3VRI",
    decimals: 6,  priceLabel: "EUR/USD",   priceFn: () => _priceCache.eurUsd,
  },
];

async function fetchSorobanSupplies() {
  const out = {};
  await Promise.all(SOROBAN_TVL_TOKENS.map(async (t) => {
    try {
      const supply = await getTokenSupply(t.contractId, t.decimals);
      if (!Number.isFinite(supply)) return;
      const price = t.priceFn();
      if (!Number.isFinite(price)) return;
      const usd = supply * price;
      out[t.slug] = {
        tvl: formatBigUSD(usd),
        supplyTokens: supply,
        tvlSource: `Soroban total_supply × ${t.priceLabel}`,
        asOf: todayISO(),
      };
    } catch (e) {
      console.warn(`[rwa-yield-fetcher] Soroban ${t.slug} failed: ${e.message}`);
    }
  }));
  return out;
}

// ── USDM1 (Republic of the Marshall Islands sovereign bond) ─────────────────
// No issuer API. The bond's published terms: interest rate = 1-month U.S.
// Treasury rate (Fed H.15) minus a 200 bps spread. Yield accrues via NAV
// growth (rwa.xyz showed NAV $1.02 in Sep 2026) and rwa.xyz publishes no APY
// for it, so we compute the rate from the benchmark directly.
//
// Primary source is the Fed's own H.15 data-download CSV (1-month constant
// maturity, series RIFLGFCM01_N.B); fallback is FRED DGS1MO, which is the
// same series. Both are sent a non-default User-Agent: FRED tarpits Node's
// default UA indefinitely rather than returning an error.
//
// Market cap is NOT set here. USDM1 is a classic asset, so server.js Layer 2
// (Horizon supply × price) handles it.

const USDM1_SLUG = "usdm1-gdm5qw";
const USDM1_SPREAD_BPS = 200;
const RATE_FETCH_HEADERS = { "User-Agent": "stellar-scope-rwa-fetcher/1.0" };
const H15_1MO_CSV_URL =
  "https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=bf17364827e38702b42a58cf8eaa3f78&lastobs=10&from=&to=&filetype=csv&label=include&layout=seriescolumn";
const FRED_DGS1MO_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS1MO";

/**
 * Parse a CSV whose data rows look like "YYYY-MM-DD,<value>,..." and return
 * the most recent row whose first value column is numeric. Skips header /
 * metadata rows and no-data markers ("ND" on H.15, "." on FRED), which occur
 * on holidays. Returns { date, rate } or null.
 */
function parseLatestRateCsv(csv) {
  const rows = String(csv || "").split(/\r?\n/);
  for (let i = rows.length - 1; i >= 0; i--) {
    const cols = rows[i].split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cols[0])) continue;
    const rate = parseFloat(cols[1]);
    if (Number.isFinite(rate)) return { date: cols[0], rate };
  }
  return null;
}

async function fetchTreasury1MoRate() {
  const sources = [
    { name: "Fed H.15", url: H15_1MO_CSV_URL },
    { name: "FRED DGS1MO", url: FRED_DGS1MO_CSV_URL },
  ];
  let lastErr = null;
  for (const src of sources) {
    try {
      const res = await fetch(src.url, {
        headers: RATE_FETCH_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseLatestRateCsv(await res.text());
      if (!parsed) throw new Error("no numeric observation in CSV");
      return { ...parsed, sourceName: src.name };
    } catch (e) {
      lastErr = e;
      console.warn(`[rwa-yield-fetcher] ${src.name} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error("no 1-month Treasury source succeeded");
}

/** Pure: apply USDM1's terms to a benchmark rate. Exported for tests. */
function usdm1RateFromBenchmark(benchmarkPct) {
  if (!Number.isFinite(benchmarkPct)) return null;
  // Terms don't publish a floor; a coupon can't go negative, so clamp at 0.
  return Math.max(0, benchmarkPct - USDM1_SPREAD_BPS / 100);
}

async function fetchUsdm1() {
  try {
    const t = await fetchTreasury1MoRate();
    const pct = usdm1RateFromBenchmark(t.rate);
    if (pct == null) throw new Error("benchmark not numeric");
    return {
      [USDM1_SLUG]: {
        yield7d: `${pct.toFixed(2)}%`,
        asOf: todayISO(),
        source: `Issuer terms: 1-mo U.S. Treasury (${t.sourceName} ${t.rate.toFixed(2)}% on ${t.date}) minus ${USDM1_SPREAD_BPS} bps spread`,
      },
    };
  } catch (e) {
    console.warn(`[rwa-yield-fetcher] USDM1 failed: ${e.message}`);
    return {};
  }
}

// ── Refresh orchestration ───────────────────────────────────────────────────

const REFRESHERS = [
  { name: "centrifuge", fn: fetchCentrifuge },       // JAAA, deJAAA, JTRSY, deJTRSY (yield + tvl)
  { name: "spiko",      fn: fetchSpiko },            // USTBL, EUTBL, UKTBL, SAFO (yield + tvl)
  { name: "etherfuse",  fn: fetchEtherfuse },        // USTRY, CETES, TESOURO (yield + tvl)
  { name: "ondo",       fn: fetchOndo },             // USDY (yield only)
  { name: "babylon",    fn: fetchBabylon },          // xSolvBTC (yield reference only — actual distribution paused)
  { name: "soroban",    fn: fetchSorobanSupplies }, // USST, XAUM, SOLVBTC, XSOLVBTC, EURAU (tvl only)
  { name: "usdm1",      fn: fetchUsdm1 },            // USDM1 (yield only — 1-mo UST minus 200 bps)
];

async function refreshAll() {
  await refreshPrices();

  const next = new Map();
  const summary = { ok: 0, failed: 0, byIssuer: {} };

  await Promise.all(REFRESHERS.map(async ({ name, fn }) => {
    try {
      const values = await fn();
      const count = Object.keys(values).length;
      summary.byIssuer[name] = { count, error: null };
      for (const [slug, value] of Object.entries(values)) {
        // Merge: an earlier fetcher may have written yield7d; this one may add tvl (or vice versa).
        const prev = next.get(slug)?.value || {};
        next.set(slug, { ts: Date.now(), value: { ...prev, ...value } });
      }
      summary.ok += count;
    } catch (e) {
      summary.byIssuer[name] = { count: 0, error: e.message };
      summary.failed += 1;
      console.warn(`[rwa-yield-fetcher] ${name} failed: ${e.message}`);
    }
  }));

  // Preserve stale-but-still-recent entries for slugs this round didn't refresh.
  for (const [slug, entry] of cache.entries()) {
    if (!next.has(slug) && Date.now() - entry.ts < STALE_GRACE) {
      next.set(slug, entry);
    }
  }

  cache = next;
  lastRefreshTs = Date.now();
  lastRefreshSummary = summary;
  console.log(`[rwa-yield-fetcher] refreshed ${summary.ok} slug(s) across ${REFRESHERS.length} sources; failures: ${summary.failed}`);
}

let _interval = null;
function start() {
  if (_interval) return;
  refreshAll().catch(e => console.warn("[rwa-yield-fetcher] initial refresh failed:", e.message));
  _interval = setInterval(
    () => refreshAll().catch(e => console.warn("[rwa-yield-fetcher] refresh failed:", e.message)),
    REFRESH_INTERVAL,
  );
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

function getFreshYield(slug) {
  const entry = cache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.ts > STALE_GRACE) return null;
  return entry.value;
}

function getStatus() {
  return {
    lastRefreshAt: lastRefreshTs ? new Date(lastRefreshTs).toISOString() : null,
    cachedSlugs: cache.size,
    prices: { ..._priceCache },
    summary: lastRefreshSummary,
  };
}

module.exports = {
  start, stop, refreshAll, getFreshYield, getStatus,
  // exported for tests
  parseLatestRateCsv, usdm1RateFromBenchmark,
};
