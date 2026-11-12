// Templar positions come from Templar's own API, for the NEAR account Templar
// keeps the wallet's positions under.
//
// The adapter used to net the wallet's Stellar payments to and from Templar's
// custody addresses. On mainnet (2026-11-11) that showed $2.6M in Templar for a
// wallet Templar has no position for, -$94,470 (a USDC loan, no collateral) for
// a wallet with 1.59 SolvBTC of collateral against 78,805 USDC of debt, no
// interest on any loan or supply, and failed outright (Horizon 410) for wallets
// whose history reached back past Horizon's moving start. These tests run it
// against a fake Templar API.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const pricing = require("../lib/pricing-engine");
const templar = require("../lib/adapters/templar");

const ME = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";
const ctx = { xlmPrice: { usd: 0.2 } };

// Templar's ids for Stellar USDC and XLM (HOT bridge, chain 1100), and BTC.
const USDC = "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";
const XLM = "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";
const BTC = "nep141:btc.omft.near";
const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

const ASSETS = [
  { assetId: USDC, symbol: "USDC", name: "USDC", decimals: 7, network: "stellar:mainnet" },
  { assetId: XLM, symbol: "XLM", name: "XLM", decimals: 7, network: "stellar:mainnet" },
  { assetId: BTC, symbol: "BTC", name: "Bitcoin", decimals: 8, network: "btc:mainnet" },
];
const MARKETS = [
  { marketId: "ixlm-ixlmusdc-1.v1.tmplr.near", name: "XLM/USDC" },
  { marketId: "ibtc-ixlmusdc.v1.tmplr.near", name: "BTC/USDC" },
];

const supply = (o) => ({
  marketId: "ibtc-ixlmusdc.v1.tmplr.near", assetId: USDC, balance: "0", balanceUsd: 0,
  pendingDeposits: [], pendingDepositsTotal: "0", outgoing: "0", apy: 0.0445,
  interestEarned: "0", interestEarnedUsd: 0, withdrawalRequest: null, timestamp: 1785350320, ...o,
});
const loan = (o) => ({
  marketId: "ixlm-ixlmusdc-1.v1.tmplr.near", assetId: USDC, balance: "0", balanceUsd: 0, fees: "0",
  interestAccrued: "0", interestAccruedUsd: 0, debt: "0", debtUsd: 0, collateralAssetId: XLM,
  collateral: "0", collateralUsd: 0, collateralInFlight: "0", apy: 0.0794, timestamp: 1784286173,
  pendingInterest: "0", lastFinalizedSnapshotEnd: 1794371998199, ...o,
});

// ── Fake Templar API ─────────────────────────────────────────────────────────

let accounts; // account -> positions data
let requests; // paths asked
let reply; // (path) => { status, body } | undefined to use the default
let inFlight;
let maxInFlight;
let times; // when each request was made (ms)

const realFetch = global.fetch;
global.fetch = async (url) => {
  const path = String(url).replace("https://api.templarfi.org/v1", "");
  requests.push(path);
  times.push(Date.now());
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, 5));
    const custom = reply(path);
    const { status, body } = custom || defaultReply(path);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  } finally {
    inFlight--;
  }
};
test.after(() => { global.fetch = realFetch; });

function defaultReply(path) {
  if (path === "/assets") return { status: 200, body: { data: ASSETS, meta: {} } };
  if (path.startsWith("/markets")) return { status: 200, body: { data: MARKETS, meta: {} } };
  const m = /^\/accounts\/([^/]+)\/positions$/.exec(path);
  if (m) {
    const d = accounts.get(decodeURIComponent(m[1])) || {};
    return {
      status: 200,
      body: {
        data: {
          account: m[1], supplyPositions: d.supply || [], borrowPositions: d.borrow || [],
          unavailable: d.unavailable || [], totalSupplyUsd: 0, totalBorrowUsd: 0, health: {},
        },
        meta: {},
      },
    };
  }
  return { status: 404, body: {} };
}

pricing.priceSorobanToken = async (contract) => (contract === USDC_SAC ? { usd: 1, source: "stablecoin" } : null);

const positionsAsked = () => requests.filter((p) => p.endsWith("/positions")).length;

test.beforeEach(() => {
  templar._resetForTests();
  // Unthrottled unless a test is about the rate limit.
  templar._setLimitsForTests({ bucketSize: 1000, refillPerSec: 1000, maxWaitMs: 5000 });
  accounts = new Map();
  requests = [];
  times = [];
  reply = () => undefined;
  inFlight = 0;
  maxInFlight = 0;
});

// ── Finding the wallet's Templar account ─────────────────────────────────────

test("a Stellar wallet's Templar account is derived from its address, as Templar's relayer does", () => {
  // Matches accounts Templar's GET /accounts lists for wallets that use it
  // (checked on mainnet against 17 Stellar wallets).
  assert.equal(templar.templarAccount("GACDE4YE7HIVANFO3474JH6JISF6S3WZRC2IXG3RHGRIYWZ5DDVTTQLC"), "2477e166e7d0.user0.tmplr.near");
  assert.equal(templar.templarAccount("GAPUSI7E" + "x".repeat(48)), null, "not a valid G address");
  assert.equal(templar.templarAccount("CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG"), null, "a contract has none");
});

test("Templar's Stellar asset ids carry the token's contract", () => {
  assert.equal(templar.stellarContractOf(USDC), USDC_SAC);
  assert.equal(templar.stellarContractOf(XLM), XLM_SAC);
  assert.equal(templar.stellarContractOf(BTC), null);
  assert.equal(templar.stellarContractOf("nep245:v2_1.omni.hot.tg:56_11111"), null, "another chain");
});

test("a contract address or a wallet with no Templar position: nothing, and nothing asked for a contract", async () => {
  assert.deepEqual(await templar.getPositions("CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG", ctx), []);
  assert.deepEqual(requests, []);
  assert.deepEqual(await templar.getPositions(ME, ctx), []);
  assert.deepEqual(requests.filter((p) => p.endsWith("/positions")), [`/accounts/${templar.templarAccount(ME)}/positions`]);
});

// ── What each position shows ─────────────────────────────────────────────────

test("a supply: active and pending deposits and any payout in transit, plus the yield not yet harvested", async () => {
  accounts.set(templar.templarAccount(ME), {
    supply: [supply({
      balance: "65413006614537", balanceUsd: 6539735.13, // 6,541,300.6614537 active
      pendingDepositsTotal: "611120000000", pendingDeposits: [{ amount: "611120000000", activatesAtSnapshot: 223 }], // 61,112
      outgoing: "10000000", // 1
      interestEarned: "644822156734", interestEarnedUsd: 64466.78, // 64,482.2156734
    })],
  });
  const [p] = await templar.getPositions(ME, ctx);
  assert.equal(p.protocol, "templar");
  assert.equal(p.type, "vault");
  assert.equal(p.subtype, "supply");
  assert.equal(p.vaultName, "Templar · USDC supplied to BTC/USDC");
  assert.deepEqual(p.deposited, { amount: "6602413.66", asset: "USDC" });
  assert.deepEqual({ ...p.yield, apy: Math.round(p.yield.apy * 100) / 100 }, { accrued: "64482.22", asset: "USDC", apy: 4.45 });
  assert.ok(Math.abs(p.valueUSD - (6602413.6614537 + 64482.2156734)) < 1e-6, String(p.valueUSD)); // USDC at the site's $1
  assert.equal(p.borrow, undefined);
  assert.equal(p.templarAccount, templar.templarAccount(ME));
});

test("a loan: collateral less the debt, interest and fees included, XLM at the request's price", async () => {
  accounts.set(templar.templarAccount(ME), {
    borrow: [loan({
      collateral: "190000000010000", collateralUsd: 2835371.33, // 19,000,000.001 XLM
      balance: "11638411961988", fees: "0", interestAccrued: "183383231298",
      debt: "11821795193286", debtUsd: 1181884.52, // 1,182,179.5193286 USDC
    })],
  });
  const [p] = await templar.getPositions(ME, ctx);
  assert.equal(p.subtype, "borrow");
  assert.equal(p.vaultName, "Templar · XLM/USDC loan");
  assert.deepEqual(p.deposited, { amount: "19000000.00", asset: "XLM" });
  assert.equal(p.borrow.amount, "1182179.52");
  assert.equal(p.borrow.asset, "USDC");
  assert.ok(Math.abs(p.borrow.valueUSD - 1182179.5193286) < 1e-6);
  assert.ok(Math.abs(p.valueUSD - (19000000.001 * 0.2 - 1182179.5193286)) < 1e-6, String(p.valueUSD));
  assert.equal(p.yield.accrued, null);
});

test("collateral the site has no price for (BTC from another chain) takes Templar's own USD figure", async () => {
  accounts.set(templar.templarAccount(ME), {
    borrow: [loan({
      marketId: "ibtc-ixlmusdc.v1.tmplr.near", collateralAssetId: BTC,
      collateral: "50000000", collateralUsd: 52000, // 0.5 BTC at Templar's $104,000
      debt: "300000000000", debtUsd: 29990, // 30,000 USDC, at the site's $1
    })],
  });
  const [p] = await templar.getPositions(ME, ctx);
  assert.deepEqual(p.deposited, { amount: "0.500000", asset: "BTC" });
  assert.ok(Math.abs(p.valueUSD - (52000 - 30000)) < 1e-6, String(p.valueUSD));
  assert.equal(p.unpriced, undefined);
});

test("every position is listed, and leftovers that would show as 0 are not", async () => {
  accounts.set(templar.templarAccount(ME), {
    supply: [
      supply({ marketId: "ixlmdejaaa-ixlmusdc.v1.tmplr.near", balance: "1", balanceUsd: 1e-7 }), // 0.0000001 USDC
      supply({ balance: "1000000000", balanceUsd: 100 }),
    ],
    borrow: [loan({ collateral: "1000000000", collateralUsd: 20, debt: "50000000", debtUsd: 5 })],
  });
  const out = await templar.getPositions(ME, ctx);
  assert.deepEqual(out.map((p) => [p.subtype, p.contractId]), [
    ["supply", "ibtc-ixlmusdc.v1.tmplr.near"],
    ["borrow", "ixlm-ixlmusdc-1.v1.tmplr.near"],
  ]);
  assert.ok(Math.abs(out.reduce((s, p) => s + p.valueUSD, 0) - (100 + (100 * 0.2 - 5))) < 1e-9);
});

// ── Failures throw (the server then shows the last good result or "unavailable") ──

test("a market Templar couldn't read for this account fails the read instead of leaving it out", async () => {
  accounts.set(templar.templarAccount(ME), {
    supply: [supply({ balance: "1000000000", balanceUsd: 100 })],
    unavailable: [{ marketId: "ixlm-ixlmusdc-1.v1.tmplr.near", side: "borrow" }],
  });
  await assert.rejects(templar.getPositions(ME, ctx), /couldn't read this account's position in ixlm-ixlmusdc-1\.v1\.tmplr\.near \(borrow\)/);
});

test("the API refusing fails the read; a 429 or 5xx is asked once more first", async () => {
  let n = 0;
  reply = (p) => (p.endsWith("/positions") && n++ === 0 ? { status: 429, body: {} } : undefined);
  assert.deepEqual(await templar.getPositions(ME, ctx), []);
  assert.equal(positionsAsked(), 2, "asked again after the 429");

  templar._resetForTests();
  requests = [];
  reply = (p) => (p.endsWith("/positions") ? { status: 502, body: {} } : undefined);
  await assert.rejects(templar.getPositions(ME, ctx), /Templar API HTTP 502/);
  assert.equal(positionsAsked(), 2);

  templar._resetForTests();
  requests = [];
  reply = (p) => (p.endsWith("/positions") ? { status: 400, body: {} } : undefined);
  await assert.rejects(templar.getPositions(ME, ctx), /HTTP 400/);
  assert.equal(positionsAsked(), 1, "a 400 isn't asked again");
});

test("a token with no listed decimals fails the read; the asset list is reloaded once first", async () => {
  accounts.set(templar.templarAccount(ME), { supply: [supply({ assetId: "nep141:new.omft.near", balance: "100", balanceUsd: 1 })] });
  await assert.rejects(templar.getPositions(ME, ctx), /no decimals for nep141:new\.omft\.near/);
  assert.equal(requests.filter((p) => p === "/assets").length, 2);
});

test("market names are only labels: if they can't be read the market id stands in", async () => {
  reply = (p) => (p.startsWith("/markets") ? { status: 500, body: {} } : undefined);
  accounts.set(templar.templarAccount(ME), { supply: [supply({ balance: "1000000000", balanceUsd: 100 })] });
  const [p] = await templar.getPositions(ME, ctx);
  assert.equal(p.vaultName, "Templar · USDC supplied to ibtc-ixlmusdc.v1.tmplr.near");
});

// ── Load on Templar's API ────────────────────────────────────────────────────

test("one read per wallet a minute, shared by loads at the same time; the lists are read once", async () => {
  accounts.set(templar.templarAccount(ME), { supply: [supply({ balance: "1000000000", balanceUsd: 100 })] });
  await Promise.all([templar.getPositions(ME, ctx), templar.getPositions(ME, ctx)]);
  await templar.getPositions(ME, ctx);
  assert.equal(positionsAsked(), 1);
  assert.equal(requests.filter((p) => p === "/assets").length, 1);
  assert.equal(requests.filter((p) => p.startsWith("/markets")).length, 1);
});

test("at most four requests at once, however many wallets load together (Templar answers 429 to bursts)", async () => {
  const wallets = Array.from({ length: 8 }, () => Keypair.random().publicKey());
  await Promise.all(wallets.map((w) => templar.getPositions(w, ctx)));
  assert.equal(positionsAsked(), 8);
  assert.ok(maxInFlight <= 4, `max in flight: ${maxInFlight}`);
});

test("when the rate limit's next turn is more than 5 s away, a read fails at once instead of waiting", async () => {
  templar._setLimitsForTests({ bucketSize: 2, refillPerSec: 0.01, maxWaitMs: 50 });
  accounts.set(templar.templarAccount(ME), { supply: [supply({ balance: "1000000000", balanceUsd: 100 })] });
  // The first load takes both turns (positions, asset list); market names wait for none and stand in as ids.
  const [p] = await templar.getPositions(ME, ctx);
  assert.equal(p.vaultName, "Templar · USDC supplied to ibtc-ixlmusdc.v1.tmplr.near");
  const t = Date.now();
  await assert.rejects(templar.getPositions(Keypair.random().publicKey(), ctx), /Templar API busy/);
  assert.ok(Date.now() - t < 500, "failed at once");
  assert.equal(positionsAsked(), 1);
});

test("a 429 empties the bucket, so the retry and the requests after it wait for the refill", async () => {
  templar._setLimitsForTests({ bucketSize: 10, refillPerSec: 20, maxWaitMs: 5000 });
  let n = 0;
  reply = (p) => (p.endsWith("/positions") && n++ === 0 ? { status: 429, body: {} } : undefined);
  assert.deepEqual(await templar.getPositions(ME, ctx), []);
  const asked = requests.map((r, i) => [r, times[i]]).filter(([r]) => r.endsWith("/positions"));
  assert.equal(asked.length, 2);
  assert.ok(asked[1][1] - asked[0][1] >= 40, `retried after ${asked[1][1] - asked[0][1]} ms`);
});
