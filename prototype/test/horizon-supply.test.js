// A classic asset's supply is every unit issued, wherever it sits.
//
// The RWA tab counted Horizon's `balances.authorized` alone, which leaves out
// units in Soroban contracts (Blend pools, vaults), AMM pools, claimable
// balances and frozen trustlines. On 2026-11-04 it showed USDM1 at $103.3K:
// 102,853 counted of 1,107,379 issued, because 1,004,526 sat in contracts.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const { classicSupply } = require("../lib/horizon-supply");

// Horizon's /assets record for USDM1 on 2026-11-04 (fields the sum uses).
const USDM1_RECORD = {
  asset_code: "USDM1",
  asset_issuer: "GDM5QWWXCMDTQMZAKMYTCI52LA7FWBHAZMU5NJLMIFHDJISJRP2ZWPKC",
  balances: {
    authorized: "102852.5338720",
    authorized_to_maintain_liabilities: "0.0000000",
    unauthorized: "0.0000000",
  },
  claimable_balances_amount: "0.0000000",
  liquidity_pools_amount: "0.0000000",
  contracts_amount: "1004526.2002836",
};

/** A /assets record with every amount zero except the ones given. */
function record({ balances = {}, ...rest } = {}) {
  return {
    balances: { authorized: "0.0000000", authorized_to_maintain_liabilities: "0.0000000", unauthorized: "0.0000000", ...balances },
    claimable_balances_amount: "0.0000000",
    liquidity_pools_amount: "0.0000000",
    contracts_amount: "0.0000000",
    ...rest,
  };
}

test("USDM1's units in Soroban contracts count toward its supply", () => {
  assert.equal(classicSupply(USDM1_RECORD), 1107378.7341556);
});

test("each place a unit can sit is counted", () => {
  const cases = {
    "authorized trustlines": record({ balances: { authorized: "5.0000000" } }),
    "trustlines limited to existing offers": record({ balances: { authorized_to_maintain_liabilities: "5.0000000" } }),
    "frozen trustlines": record({ balances: { unauthorized: "5.0000000" } }),
    "claimable balances": record({ claimable_balances_amount: "5.0000000" }),
    "AMM pools": record({ liquidity_pools_amount: "5.0000000" }),
    "Soroban contracts": record({ contracts_amount: "5.0000000" }),
  };
  for (const [where, r] of Object.entries(cases)) assert.equal(classicSupply(r), 5, where);
});

test("the sum is exact to 7 decimals", () => {
  const r = record({ balances: { authorized: "0.1000000" }, contracts_amount: "0.2000000" });
  assert.equal(classicSupply(r), 0.3); // a float sum would give 0.30000000000000004
});

test("a Horizon release without the split falls back to its flat amount", () => {
  assert.equal(classicSupply({ amount: "1234.5000000" }), 1234.5);
});

test("a malformed or missing record gives no supply, not a wrong one", () => {
  assert.equal(classicSupply(null), null);
  assert.equal(classicSupply({}), null);
  assert.equal(classicSupply(record({ contracts_amount: "garbage" })), null);
  assert.equal(classicSupply(record({ balances: { authorized: "-5.0000000" } })), null);
});

test("/api/v1/rwa-stats values a classic RWA on its whole supply", async () => {
  // USDT0's /assets record on 2026-11-04: more than half sat in contracts.
  const USDT0 = "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q";
  const usdt0Record = {
    asset_code: "USDT0",
    asset_issuer: USDT0,
    balances: { authorized: "5287364.2560195", authorized_to_maintain_liabilities: "0.0000000", unauthorized: "0.0000000" },
    claimable_balances_amount: "10.3070000",
    liquidity_pools_amount: "445.9200000",
    contracts_amount: "5622620.4300000",
  };
  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, ...rest);
    if (u.includes("/assets?asset_code=")) {
      const q = new URL(u).searchParams;
      const records = q.get("asset_code") === "USDT0" && q.get("asset_issuer") === USDT0 ? [usdt0Record] : [];
      return { ok: true, status: 200, json: async () => ({ _embedded: { records } }) };
    }
    if (u.includes("/simple/price")) {
      return { ok: true, status: 200, json: async () => ({ usdt0: { usd: 1, usd_24h_change: 0 } }) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };
  const { app } = require("../server.js");
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/v1/rwa-stats`);
    assert.equal(res.status, 200);
    const entry = (await res.json()).stats["usdt0-gatisx"];
    assert.equal(entry.supplyTokens, 10910440.9130195);
    assert.equal(entry.marketCap, "$10.9M"); // was $5.3M on authorized trustlines alone
  } finally {
    server.close();
    global.fetch = realFetch;
  }
});
