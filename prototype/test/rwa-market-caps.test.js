// Every stablecoin on the RWA tab gets a market cap.
//
// On 2026-11-23 four had none ("—"):
// - USDC, PYUSD and EURCV are listed by contract id, and each contract is the
//   Stellar Asset Contract (SAC) of a classic asset. Only assets listed by
//   issuer got a Horizon market cap, and nothing tied the contract to its
//   issuer. Live, USDC alone is $314.7M.
// - EURAU's supply was read every hour, then filed under "euraud-cb44w7",
//   which is no asset's slug, so the page never saw it.
// And a wallet's classic EURCV was unpriced: CoinGecko's EURCV was mapped to
// the contract only, as PYUSD's had been before its classic issuer was added.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Asset, Networks } = require("@stellar/stellar-sdk");

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rwa-catalog.json"), "utf8"));
const assets = catalog.categories.flatMap((c) => c.assets);
const slugOf = (a) => `${a.code.toLowerCase()}-${(a.issuer || a.contractId || "").toLowerCase().slice(0, 6)}`;
const catalogSlugs = new Set(assets.map(slugOf));
const byCode = Object.fromEntries(assets.map((a) => [a.code, a]));

const ISSUER = {
  USDC: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  PYUSD: "GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5",
  EURCV: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
};
const EURAU = "CB44W727WSLHPXJ47A6DHF5D34RKWSOZAMEDXO3CF5TEEEQ2ZX4V3VRI";

// ── The catalog ─────────────────────────────────────────────────────────────

test("USDC, PYUSD and EURCV name the classic asset their contract is the SAC of", () => {
  for (const code of Object.keys(ISSUER)) assert.equal(byCode[code].classicIssuer, ISSUER[code], code);
  const withIssuer = assets.filter((a) => a.classicIssuer);
  assert.ok(withIssuer.length >= 3);
  for (const a of withIssuer) {
    assert.ok(a.contractId && !a.issuer, `${a.code}: classicIssuer goes with a contractId`);
    // A SAC's id is derived from its asset, so a wrong issuer can't match.
    assert.equal(new Asset(a.code, a.classicIssuer).contractId(Networks.PUBLIC), a.contractId, a.code);
  }
});

test("every slug the yield fetcher and the curated yields write is an asset on the tab", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/rwa-yield-fetcher.js"), "utf8");
  const written = [...src.matchAll(/"([a-z0-9]+-[a-z0-9]{6})"/g)].map((m) => m[1]);
  assert.ok(written.length >= 20, `found ${written.length}`);
  assert.ok(written.includes("eurau-cb44w7"));
  assert.deepEqual(written.filter((s) => !catalogSlugs.has(s)), []);
  const curated = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, "../lib/rwa-yields.json"), "utf8")).stats);
  assert.deepEqual(curated.filter((s) => !catalogSlugs.has(s)), []);
});

// ── The route ───────────────────────────────────────────────────────────────

// Horizon's /assets records (amounts rounded from 2026-11-23).
const record = (code, authorized, contracts) => ({
  asset_code: code,
  asset_issuer: ISSUER[code],
  balances: { authorized, authorized_to_maintain_liabilities: "0.0000000", unauthorized: "0.0000000" },
  claimable_balances_amount: "0.0000000",
  liquidity_pools_amount: "0.0000000",
  contracts_amount: contracts,
});
const RECORDS = {
  USDC: record("USDC", "250000000.0000000", "64700000.0000000"),
  PYUSD: record("PYUSD", "10000000.0000000", "7900000.0000000"),
  EURCV: record("EURCV", "15030600.0000000", "0.0000000"),
};
const CG = {
  "paypal-usd": { usd: 1, usd_24h_change: 0 },
  "societe-generale-forge-eurcv": { usd: 1.09, usd_24h_change: 0 },
};
const EUR_PER_USD = 0.92;

// No real network: Soroban supplies, the AMM layer, Horizon, CoinGecko and
// the FX rate are fakes. The fetcher takes getTokenSupply at require time.
const rpc = require("../lib/soroban-rpc");
rpc.getTokenSupply = async (contractId) => (contractId === EURAU ? 17200 : NaN);
const aggregator = require("../lib/soroswap-aggregator");
aggregator.priceClassicAssetViaSACInUSD = async () => null;
aggregator.priceSorobanTokenInUSD = async () => null;

const realFetch = global.fetch;
let horizonAsked; // "CODE:ISSUER" for each /assets request
let keepAlive;
test.before(() => {
  keepAlive = setInterval(() => {}, 1000); // the CoinGecko micro-batch timer is unref()'d
  horizonAsked = [];
  global.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, ...rest);
    if (u.includes("/assets?asset_code=")) {
      const q = new URL(u).searchParams;
      const code = q.get("asset_code");
      horizonAsked.push(`${code}:${q.get("asset_issuer")}`);
      const records = RECORDS[code] && q.get("asset_issuer") === ISSUER[code] ? [RECORDS[code]] : [];
      return { ok: true, status: 200, json: async () => ({ _embedded: { records } }) };
    }
    if (u.includes("/simple/price")) {
      const ids = decodeURIComponent(new URL(u).searchParams.get("ids") || "").split(",");
      const body = Object.fromEntries(ids.filter((id) => CG[id]).map((id) => [id, CG[id]]));
      return { ok: true, status: 200, json: async () => body };
    }
    if (u.includes("frankfurter")) {
      return { ok: true, status: 200, json: async () => ({ rates: { EUR: EUR_PER_USD, GBP: 0.79 } }) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

async function rwaStats() {
  await require("../lib/rwa-yield-fetcher").refreshAll();
  const { app } = require("../server.js");
  const server = app.listen(0);
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/v1/rwa-stats`);
    assert.equal(res.status, 200);
    return (await res.json()).stats;
  } finally {
    server.close();
  }
}

test("the RWA tab shows USDC, PYUSD, EURCV and EURAU with a market cap", async () => {
  const stats = await rwaStats();

  // The SACs: Horizon supply of their classic asset × its price. Their slugs
  // (and so their pages) are still the contract's.
  const usdc = stats["usdc-ccw67t"];
  assert.equal(usdc.supplyTokens, 314700000);
  assert.equal(usdc.marketCap, "$314.7M");
  assert.equal(usdc.source, "Horizon");
  assert.equal(stats["pyusd-cccrwh"].marketCap, "$17.9M");
  assert.equal(stats["eurcv-cankby"].supplyTokens, 15030600);
  assert.equal(stats["eurcv-cankby"].marketCap, "$16.4M"); // at CoinGecko's EURCV price
  for (const code of Object.keys(ISSUER)) {
    assert.ok(horizonAsked.includes(`${code}:${ISSUER[code]}`), `asked Horizon for ${code} by its issuer`);
  }

  // EURAU: Soroban total_supply × EUR/USD, now under its own slug.
  const eurau = stats["eurau-cb44w7"];
  assert.equal(eurau.supplyTokens, 17200);
  assert.equal(eurau.marketCap, "$18.7K"); // 17,200 / 0.92
  assert.equal(eurau.tvlSource, "Soroban total_supply × EUR/USD");
  assert.equal(stats["euraud-cb44w7"], undefined);
});

test("a wallet's classic EURCV is priced like the contract (CoinGecko)", async () => {
  const pricing = require("../lib/pricing-engine");
  const noMarket = { priceViaSDEX: async () => null };
  const p = await pricing.priceClassicAsset(noMarket, "EURCV", ISSUER.EURCV);
  assert.equal(p?.usd, 1.09);
  assert.equal(p.source, "coingecko");
});
