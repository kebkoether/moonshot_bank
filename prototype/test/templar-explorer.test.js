// The DeFi tab's Templar card read 18-decimal collateral as 8-decimal when a
// market had no config of its own: $3.98 quadrillion of deJAAA.
//
// Templar's snapshots API listed ixlmdejaaa-ixlmusdc-2, but its markets API
// had no config for it, and fetchTemplar fell back to 8 decimals. deJAAA has
// 18, so 378,557 deJAAA read as 3.8 quadrillion. Now the decimals come from
// another market with the same collateral (current or deprecated), and when
// none has them the collateral is left out instead of guessed.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const fetchTemplar = require("../lib/defi-explorer").getSnapshot._fetchTemplar;
const pricingEngine = require("../lib/pricing-engine");

// Trimmed from app.templarfi.org/api/markets and /api/snapshots, 2026-11-02.
const cfg = (deployment, decimals) => ({
  deployment,
  configuration: { price_oracle_configuration: { collateral_asset_decimals: decimals, borrow_asset_decimals: 7 } },
});
const MARKETS = {
  markets: [cfg("ixlmdejaaa-ixlmusdc-1.v1.tmplr.near", 18), cfg("ixlm-ixlmusdc-1.v1.tmplr.near", 7)],
  deprecatedMarkets: [cfg("ixlmdejtrsy-ixlmusdc.v1.tmplr.near", 18), cfg("stnear-usdc.v1.tmplr.near", 24)],
};
const snap = (deployment, collateral, deposits) => ({
  deployment, yield: "0.0256", availableBalance: 1000, totalDepositsRaw: deposits,
  snapshot: { collateral_asset_deposited: collateral, interest_rate: "0.05" },
});
const SNAPSHOTS = {
  marketSnapshots: [
    snap("ixlmdejaaa-ixlmusdc-1.v1.tmplr.near", "3597470802800465341538142", 3239143.5747347), // has a config
    snap("ixlmdejaaa-ixlmusdc-2.v1.tmplr.near", "378557633729420372709278", 397779.7800006), //  no config: deJAAA's 18 from -1
    snap("ixlmdejtrsy-ixlmusdc-1.v1.tmplr.near", "2000000000000000000000", 500), //              no config: 18 from a deprecated market
    snap("iethfxrp-ixlmusdc.v1.tmplr.near", "700000", 1001.2001373), //                           no decimals anywhere
    snap("ixlm-ixlmusdc-1.v1.tmplr.near", "100000000000", 25000), //                              10,000 XLM
  ],
};
const PRICES = { stellar: { usd: 0.1676 }, ripple: { usd: 2.5 } };
const DEJAAA = 1.05;
const DEJTRSY = 1.02;

test.beforeEach((t) => {
  fetchTemplar._lastPrices = undefined;
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (url) => {
    const u = String(url);
    const body = u.includes("/api/markets") ? MARKETS
      : u.includes("/api/snapshots") ? SNAPSHOTS
      : u.includes("coingecko") ? PRICES
      : null;
    if (!body) throw new Error(`unexpected fetch ${u}`);
    return { ok: true, status: 200, json: async () => body };
  };
  t.mock.method(pricingEngine, "priceSorobanToken", async (id) => (
    id.startsWith("CC64WBDG") ? { usd: DEJAAA } : id.startsWith("CBI7UCH5") ? { usd: DEJTRSY } : null
  ));
});

const byName = (card) => (name, nth = 0) => card.pools.filter((p) => p.name === name)[nth];

test("a market with no config of its own takes the decimals of another market with the same collateral", async () => {
  const card = await fetchTemplar();
  const pools = card.pools.filter((p) => p.name === "USDC / deJAAA").sort((a, b) => a.tvlUSD - b.tvlUSD);
  const expected2 = 397779.7800006 + 378557.633729420372709278 * DEJAAA;
  const expected1 = 3239143.5747347 + 3597470.802800465341538142 * DEJAAA;
  assert.ok(Math.abs(pools[0].tvlUSD - expected2) < 0.01, `deJAAA-2: ${pools[0].tvlUSD} vs ${expected2}`);
  assert.ok(Math.abs(pools[1].tvlUSD - expected1) < 0.01, `deJAAA-1 unchanged: ${pools[1].tvlUSD}`);
  // A deprecated market's config counts too.
  const trsy = byName(card)("USDC / deJTRSY");
  assert.ok(Math.abs(trsy.tvlUSD - (500 + 2000 * DEJTRSY)) < 0.01, `deJTRSY: ${trsy.tvlUSD}`);
});

test("collateral whose decimals aren't published anywhere is left out, not guessed", async () => {
  const card = await fetchTemplar();
  const fxrp = byName(card)("USDC / FXRP");
  assert.equal(fxrp.tvlUSD, 1001.2001373, "deposits only");
  assert.equal(fxrp.detail.collateralUSD, 0);
  assert.match(fxrp.note, /FXRP collateral not valued \(its decimals aren't published\)/);
});

test("a market with its own config is unchanged, and the card's total is the sum of its markets", async () => {
  const card = await fetchTemplar();
  const xlm = byName(card)("USDC / XLM");
  assert.ok(Math.abs(xlm.tvlUSD - (25000 + 10000 * 0.1676)) < 1e-6);
  const sum = card.pools.reduce((s, p) => s + p.tvlUSD, 0);
  assert.ok(Math.abs(card.totalTvlUSD - sum) < 0.01, "all of these are Stellar-side markets");
  assert.ok(card.totalTvlUSD < 20e6, `total ${card.totalTvlUSD}`);
});
