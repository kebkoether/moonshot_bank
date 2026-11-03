// Pending BLND emissions on Blend positions.
//
// Before this, the DeFi tab's "Pending BLND" could never appear: the result of
// get_user_emissions was never decoded (always 0), the reserve token ids for
// supply and borrow were swapped, and `accrued` alone left out everything
// earned since the user's last checkpoint. These tests pin the maths to Blend's
// own contract tests and to real claim() results, then drive the real adapter
// against a mocked RPC.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { nativeToScVal, scValToNative, xdr, StrKey } = require("@stellar/stellar-sdk");

// A smaller adapter budget than production's 8 s keeps the timing tests short.
process.env.ADAPTER_TIMEOUT_MS = "2500";

// The adapter destructures these at require time, so the mocks go in first.
const rpcLib = require("../lib/soroban-rpc");
const pricing = require("../lib/pricing-engine");

const POOL = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS"; // a built-in Blend pool
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const LEFT = StrKey.encodeContract(crypto.randomBytes(32)); // a reserve the user has left
const USER = wallet().publicKey(); // a fresh address, not a real holder

// ── Recorded from mainnet ───────────────────────────────────────────────────
// One YieldBlox Pool V2 position, read at ledger 65168746 (close time
// 1793129508). claim() was simulated per reserve token id at the same ledger;
// these are its return values. Ids 0 and 2 are borrows that were repaid in
// full: zero balance, but BLND still owed, about a fifth of the total.

const RECORDED = [
  { id: 0, balance: 0n, supply: 500339966598n,
    re: { eps: 388433108878n, expiration: 1788406189n, index: 31583536587368n, last_time: 1788406189n },
    ue: { accrued: 8948271n, index: 24977186839254n }, claim: 8948271n },
  { id: 1, balance: 1451154144n, supply: 13742689794485n,
    re: { eps: 258955405919n, expiration: 1788406189n, index: 2465213751752n, last_time: 1788406189n },
    ue: { accrued: 0n, index: 2160431186470n }, claim: 4422864n },
  { id: 2, balance: 0n, supply: 280159464706n,
    re: { eps: 1294777021957n, expiration: 1788406189n, index: 373066593544244n, last_time: 1788406189n },
    ue: { accrued: 65727717n, index: 346866819629971n }, claim: 65727717n },
  { id: 3, balance: 10350055n, supply: 416582698678n,
    re: { eps: 647388514864n, expiration: 1788406189n, index: 69916908984316n, last_time: 1788406189n },
    ue: { accrued: 263538172n, index: 61298528600487n }, claim: 264430179n },
];
const RECORDED_TOTAL = 343529031n; // claim() over all four ids: 34.3529031 BLND

// ── A mocked pool ───────────────────────────────────────────────────────────
// The mock answers from `scenario`, so each test can describe its own pool.

const decodeU32 = (v) => scValToNative(v);
const calls = [];
let scenario;
let failUserEmissionsFor = null;
let failReserveEmissionsOnce = null;
let slowUserEmissionsMs = 0;
let slowReserveMs = 0;
let inFlight = 0;
let maxInFlight = 0;

rpcLib.getTokenMetadata = async () => ({ symbol: "TKN", decimals: 7 });
pricing.priceSorobanToken = async () => ({ usd: 1, source: "test" });
rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  if (contractId !== POOL) {
    // The other built-in pools: the wallet holds nothing there.
    if (method === "get_positions") return nativeToScVal({ collateral: {}, liabilities: {}, supply: {} });
    if (method === "get_reserve_list") return nativeToScVal([]);
    throw new Error("unexpected pool");
  }
  calls.push({ method, id: method.endsWith("_emissions") ? decodeU32(args[args.length - 1]) : undefined });
  const s = scenario;
  if (method === "get_reserve_list") return nativeToScVal(s.reserves.map((r) => r.asset));
  if (method === "get_positions") return nativeToScVal(s.positions);
  if (method === "get_config") return nativeToScVal({ bstop_rate: 0n });
  if (method === "get_reserve") {
    if (slowReserveMs) await new Promise((r) => setTimeout(r, slowReserveMs));
    const asset = scValToNative(args[0]);
    const r = s.reserves.find((x) => x.asset === asset);
    return nativeToScVal({
      asset,
      config: { decimals: r.decimals },
      data: { b_rate: 10n ** 12n, d_rate: 10n ** 12n, ir_mod: 10_000_000n, b_supply: r.bSupply, d_supply: r.dSupply },
      scalar: 10n ** BigInt(r.decimals),
    });
  }
  if (method === "get_reserve_emissions") {
    const id = decodeU32(args[0]);
    if (id === failReserveEmissionsOnce) {
      failReserveEmissionsOnce = null;
      throw new Error("Simulation failed: 429");
    }
    const e = s.emissions[id];
    return e ? nativeToScVal(e.re) : xdr.ScVal.scvVoid();
  }
  if (method === "get_user_emissions") {
    const id = decodeU32(args[1]);
    if (id === failUserEmissionsFor) throw new Error("Simulation failed: 429");
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, slowUserEmissionsMs || 5));
    } finally {
      inFlight--;
    }
    const e = s.emissions[id];
    return e?.ue ? nativeToScVal(e.ue) : xdr.ScVal.scvVoid();
  }
  throw new Error(`unmocked ${method}`);
};

// No Horizon here: the wallet has no history, so only the built-in pools are read.
require("../lib/adapters/blend-wallet-pools")._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) });
const Blend = require("../lib/adapters/blend");
const { claimableEmissions, currentEmissionIndex } = Blend;

// The recorded position: the user supplies XLM and USDC and has repaid both
// borrows; they have also fully left a third reserve, which still owes them
// 1.3127807 BLND on a repaid borrow (reserve token id 4).
const LEFT_ACCRUED = 13127807n;
function recordedScenario() {
  const emissions = Object.fromEntries(RECORDED.map((r) => [r.id, { re: r.re, ue: r.ue }]));
  emissions[4] = { re: RECORDED[0].re, ue: { accrued: LEFT_ACCRUED, index: RECORDED[0].re.index } };
  return {
    reserves: [
      { asset: XLM, decimals: 7, bSupply: RECORDED[1].supply, dSupply: RECORDED[0].supply },
      { asset: USDC, decimals: 7, bSupply: RECORDED[3].supply, dSupply: RECORDED[2].supply },
      { asset: LEFT, decimals: 7, bSupply: 10n ** 12n, dSupply: 10n ** 11n },
    ],
    positions: { collateral: { 0: RECORDED[1].balance, 1: RECORDED[3].balance }, liabilities: {}, supply: {} },
    emissions,
  };
}

async function load() {
  calls.length = 0;
  const positions = await Blend.getPositions(USER);
  return { positions, group: positions.__blendPoolGroups[0] };
}
const blnd = (stroops) => Number(stroops) / 1e7;
const asked = (method) => calls.filter((c) => c.method === method).map((c) => c.id).sort((a, b) => a - b);

test.beforeEach(() => {
  Blend._clearEmissionsCache();
  scenario = recordedScenario();
  failUserEmissionsFor = null;
  failReserveEmissionsOnce = null;
  slowUserEmissionsMs = 0;
  slowReserveMs = 0;
  maxInFlight = 0;
});

// ── The maths, against blend-contracts-v2's own unit tests ──────────────────
// pool/src/emissions/distributor.rs, test names in the comments.

const EPS = 1_000_000_000_000n; // Rust test value 0_01000000000000

test("index: brought forward, and floored (test_update_emission_data_rounds_down)", () => {
  const re = { expiration: 1600000000n, eps: EPS, index: 1234567890000000n, last_time: 1500000000n };
  assert.equal(currentEmissionIndex(re, 100_0001111n, 1_0000000n, 1500000005), 1234617889944450n);
});

test("index: stops at expiration (test_update_emission_data_past_exp)", () => {
  const re = { expiration: 1600000001n, eps: EPS, index: 1234567890000000n, last_time: 1500000000n };
  assert.equal(currentEmissionIndex(re, 100_0000000n, 1_0000000n, 1700000000), 1001234577890000000n);
});

test("index: unchanged when expired, no eps, no supply, or our clock is behind", () => {
  const re = { expiration: 1600000000n, eps: EPS, index: 42n, last_time: 1500000000n };
  assert.equal(currentEmissionIndex({ ...re, last_time: 1600000000n }, 1n, 1n, 1700000000), 42n);
  assert.equal(currentEmissionIndex({ ...re, eps: 0n }, 1n, 1n, 1550000000), 42n);
  assert.equal(currentEmissionIndex(re, 0n, 1n, 1550000000), 42n);
  assert.equal(currentEmissionIndex(re, 1n, 1n, 1499999990), 42n);
});

test("claim: accrued plus everything since the user's checkpoint (test_claim_emissions)", () => {
  const got = claimableEmissions({
    reserveEmissions: { expiration: 1600000000n, eps: EPS, index: 23456780000000n, last_time: 1500000000n },
    userEmissions: { index: 12345670000000n, accrued: 1_000_000n /* 0.1 */ },
    balance: 2_0000000n, supply: 50_0000000n, supplyScalar: 1_0000000n, nowSec: 1501000000,
  });
  assert.equal(got, 400_3222222n);
});

test("claim: a balance from before emissions began is due the whole index (..._first_time_claims_tokens)", () => {
  const got = claimableEmissions({
    reserveEmissions: { expiration: 1600000000n, eps: EPS, index: 1234567890000000n, last_time: 1500000000n },
    userEmissions: null,
    balance: 5_000_000n /* 0.5 */, supply: 1n, supplyScalar: 1_0000000n, nowSec: 1500000000,
  });
  assert.equal(got, 6_1728394n);
});

test("claim: zero balance keeps what was accrued, adds nothing (test_update_user_emissions_no_bal_no_accrual)", () => {
  const got = claimableEmissions({
    reserveEmissions: { expiration: 1600000000n, eps: EPS, index: 123456789n, last_time: 1500000000n },
    userEmissions: { index: 56789n, accrued: 1_000_000n /* 0.1 */ },
    balance: 0n, supply: 1n, supplyScalar: 1_0000000n, nowSec: 1500000000,
  });
  assert.equal(got, 1_000_000n /* 0.1 */);
});

test("claim: nothing when the side never had emissions, or the user never held it", () => {
  const re = { expiration: 1600000000n, eps: EPS, index: 1234567890000000n, last_time: 1500000000n };
  const base = { balance: 5n, supply: 1n, supplyScalar: 1_0000000n, nowSec: 1500000000 };
  assert.equal(claimableEmissions({ ...base, reserveEmissions: null, userEmissions: null }), 0n);
  assert.equal(claimableEmissions({ ...base, balance: 0n, reserveEmissions: re, userEmissions: null }), 0n);
});

test("claim: a user checkpoint ahead of the reserve data adds nothing, and takes nothing away", () => {
  const got = claimableEmissions({
    reserveEmissions: { expiration: 1600000000n, eps: EPS, index: 1000n, last_time: 1600000000n },
    userEmissions: { index: 2000n, accrued: 777n },
    balance: 10n ** 12n, supply: 1n, supplyScalar: 1_0000000n, nowSec: 1700000000,
  });
  assert.equal(got, 777n);
});

test("matches what claim() returned on mainnet, per reserve token", () => {
  let total = 0n;
  for (const r of RECORDED) {
    const got = claimableEmissions({
      reserveEmissions: r.re, userEmissions: r.ue, balance: r.balance, supply: r.supply,
      supplyScalar: 10_000_000n, nowSec: 1793129508,
    });
    assert.equal(got, r.claim, `reserve token ${r.id}`);
    total += got;
  }
  assert.equal(total, RECORDED_TOTAL);
});

// ── The adapter, end to end ─────────────────────────────────────────────────

test("pending BLND per side, including repaid borrows and reserves the user has left", async () => {
  const { positions, group } = await load();
  const [xlm, usdc] = group.rows;
  assert.equal(group.rows.length, 2, "the reserve the user left has no row");

  // Supply reads 2i+1, borrow reads 2i.
  assert.equal(xlm.pendingBlndSupply, blnd(RECORDED[1].claim));
  assert.equal(xlm.pendingBlndBorrow, blnd(RECORDED[0].claim));
  assert.equal(usdc.pendingBlndSupply, blnd(RECORDED[3].claim));
  assert.equal(usdc.pendingBlndBorrow, blnd(RECORDED[2].claim));
  assert.equal(usdc.pendingBlnd, blnd(RECORDED[2].claim + RECORDED[3].claim));
  // The pool total also counts the reserve the user has left.
  assert.equal(group.totalPendingBlnd, blnd(RECORDED_TOTAL + LEFT_ACCRUED));

  assert.deepEqual(asked("get_user_emissions"), [0, 1, 2, 3, 4], "every id with emissions, held or not");
  assert.doesNotThrow(() => JSON.stringify(positions.__blendPoolGroups), "no BigInt may reach the API");
});

test("Blend's own claim test, end to end: decimals 5 and 9, collateral + supply, emissions still running", async (t) => {
  // test_execute_claim in distributor.rs: claim() at 1501000000 pays
  // 400_3222222 (dTokens, reserve 0) + 301_0222222 (bTokens, reserve 1).
  t.mock.timers.enable({ apis: ["Date"], now: 1501000000 * 1000 });
  scenario = {
    reserves: [
      { asset: XLM, decimals: 5, bSupply: 100_00000n, dSupply: 50_00000n },
      { asset: USDC, decimals: 9, bSupply: 100_000_000_000n, dSupply: 50_000_000_000n },
    ],
    positions: { liabilities: { 0: 2_00000n }, collateral: { 1: 1_000_000_000n }, supply: { 1: 1_000_000_000n } },
    emissions: {
      0: { re: { expiration: 1600000000n, eps: EPS, index: 23456780000000n, last_time: 1500000000n },
        ue: { index: 12345670000000n, accrued: 1_000_000n } },
      3: { re: { expiration: 1600000000n, eps: 1_500_000_000_000n, index: 13456780000000n, last_time: 1500000000n },
        ue: { index: 12345670000000n, accrued: 1_0000000n } },
    },
  };
  const { group } = await load();
  assert.equal(group.rows[0].pendingBlndBorrow, 400.3222222);
  assert.equal(group.rows[1].pendingBlndSupply, 301.0222222);
  assert.equal(group.totalPendingBlnd, blnd(400_3222222n + 301_0222222n));
});

test("reserve emission data is shared across wallets; a newer user checkpoint forces a fresh read", async () => {
  await load();
  const second = await load();
  assert.deepEqual(asked("get_reserve_emissions"), [], "second wallet reads no reserve emission data");
  assert.equal(second.group.totalPendingBlnd, blnd(RECORDED_TOTAL + LEFT_ACCRUED));

  // The user acted on id 3 since the cache was filled: their checkpoint is now
  // ahead of the cached reserve index, so that id must be read again.
  const moved = { ...scenario.emissions[3].re, index: scenario.emissions[3].re.index + 10n ** 12n };
  scenario.emissions[3] = { re: moved, ue: { accrued: 5n, index: moved.index } };
  const third = await load();
  assert.deepEqual(asked("get_reserve_emissions"), [3]);
  assert.equal(third.group.rows[1].pendingBlndSupply, blnd(5n));
});

test("a failed reserve read is not cached: the next wallet reads it again", async () => {
  failReserveEmissionsOnce = 3;
  const first = await load();
  assert.equal(first.group.totalPendingBlnd, null);
  const second = await load();
  assert.deepEqual(asked("get_reserve_emissions"), [3], "only the failed id is read again");
  assert.equal(second.group.totalPendingBlnd, blnd(RECORDED_TOTAL + LEFT_ACCRUED));
});

test("cached reserve emission data expires after 5 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await load();
  t.mock.timers.setTime(1_800_000_000_000 + 4 * 60_000);
  await load();
  assert.deepEqual(asked("get_reserve_emissions"), [], "still cached after 4 minutes");
  t.mock.timers.setTime(1_800_000_000_000 + 5 * 60_000 + 1);
  await load();
  assert.deepEqual(asked("get_reserve_emissions"), [0, 1, 2, 3, 4, 5], "read again after 5");
});

test("at most 4 lookups per pool are in flight at once", async () => {
  slowUserEmissionsMs = 50;
  const { group } = await load();
  assert.equal(maxInFlight, 4);
  assert.equal(group.totalPendingBlnd, blnd(RECORDED_TOTAL + LEFT_ACCRUED));
});

test("a side with no emissions is 0 without asking for the user's data", async () => {
  delete scenario.emissions[0];
  const { group } = await load();
  assert.equal(group.rows[0].pendingBlndBorrow, 0);
  assert.ok(!asked("get_user_emissions").includes(0));
});

test("a failed lookup is unknown (null), never a smaller total, and the positions are unaffected", async () => {
  failUserEmissionsFor = 3; // USDC supply side
  const { positions, group } = await load();
  const usdc = group.rows[1];
  assert.equal(usdc.pendingBlndSupply, null);
  assert.equal(usdc.pendingBlnd, null);
  assert.equal(usdc.pendingBlndBorrow, blnd(RECORDED[2].claim), "the other side still reads");
  assert.equal(group.totalPendingBlnd, null);
  assert.equal(positions.filter((p) => p.subtype === "collateral").length, 2);
});

test("a slow lookup does not hold up the positions, and is stopped once given up on", async () => {
  slowUserEmissionsMs = 2000;
  const t0 = Date.now();
  const { positions, group } = await load();
  const ms = Date.now() - t0;
  assert.ok(ms >= 1400 && ms < 1900, `getPositions took ${ms}ms; the grace period is 1.5 s`);
  assert.equal(group.totalPendingBlnd, null);
  assert.equal(group.rows[0].pendingBlndSupply, null);
  assert.equal(positions.filter((p) => p.subtype === "collateral").length, 2);

  // The first four lookups were already in flight; the fifth must not start
  // when they finish (at 2 s).
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(asked("get_user_emissions").length, 4);
});

test("the wait never runs past the adapter's own budget", async () => {
  // Positions take ~1.4 s (two slow reserve reads); the budget here is 2.5 s
  // with 0.75 s kept back, so pending BLND gets ~0.35 s, not the full 1.5 s.
  slowReserveMs = 700;
  slowUserEmissionsMs = 1500;
  const t0 = Date.now();
  const { group } = await load();
  const ms = Date.now() - t0;
  assert.ok(ms >= 1600 && ms < 2400, `getPositions took ${ms}ms; without the budget it would be ~2.9 s`);
  assert.equal(group.totalPendingBlnd, null);
});
