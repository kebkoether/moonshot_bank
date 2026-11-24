// A wallet's shares in Stellar's built-in (classic) AMM pools are valued.
//
// The wallet routes listed a pool-share trustline with valueUSD 0 and never
// filled it in, so the pool's assets were in no total: on 2026-11-24 one
// wallet's 93.6% of the classic XLM/USDC pool (11.52M XLM and 1.44M USDC,
// about $2.9M) counted for nothing.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair, Asset, Networks } = require("@stellar/stellar-sdk");

const pricing = require("../lib/pricing-engine");
const ClassicPools = require("../lib/adapters/classic-pools");
const { positionFor, toStroops, fromStroops } = ClassicPools;
const HoldingsCsv = require("../public/holdings-csv");
const { summarizeDefiPosition } = require("../lib/defi-snapshot");

const USDC = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SPAM = Keypair.random().publicKey();
const XLM_USD = 0.125;
const priceCtx = { xlmPrice: { usd: XLM_USD, source: "test" } };

// The XLM/USDC pool on 2026-11-23, and its largest holder's shares.
const XLM_USDC = {
  id: "a468d41d8e9b8f3c7209651608b74b7db7ac9952dcae0cdf24871d1d9c7b0088",
  fee_bp: 30,
  total_shares: "3204741.0203315",
  reserves: [
    { asset: "native", amount: "12305338.0715694" },
    { asset: `USDC:${USDC}`, amount: "1535117.4333458" },
  ],
};
const SHARES = "3000859.7864408";
const POOL_USD = 11522489.3191874 * XLM_USD + 1437455.3650251;
// A pool with an asset nobody prices.
const XLM_SPAM = {
  id: "b".repeat(64), fee_bp: 30, total_shares: "100.0000000",
  reserves: [{ asset: "native", amount: "400.0000000" }, { asset: `JUNK:${SPAM}`, amount: "1000000.0000000" }],
};

test.beforeEach(() => {
  pricing.priceClassicAsset = async (_ctx, code, issuer) =>
    (code === "USDC" && issuer === USDC ? { usd: 1, source: "stablecoin" } : null);
});

// ── The position a pool's shares give ───────────────────────────────────────

test("shares give the pool's reserves pro rata, to the stroop, valued at each asset's price", async () => {
  const pos = await positionFor(XLM_USDC, SHARES, priceCtx);
  const share = (r) => fromStroops((toStroops(r) * toStroops(SHARES)) / toStroops(XLM_USDC.total_shares));
  assert.equal(pos.amounts.token0, share("12305338.0715694"));
  assert.equal(pos.amounts.token1, share("1535117.4333458"));
  // Worked out apart, in Python's Decimal: floor(reserve × shares / total).
  assert.equal(pos.amounts.token0, "11522489.3191874");
  assert.equal(pos.amounts.token1, "1437455.3650251");
  assert.ok(Math.abs(pos.valueUSD - POOL_USD) < 1e-6);
  assert.ok(Math.abs(pos.poolShare - 0.9363814) < 1e-7);
  assert.equal(pos.protocol, "stellar-amm");
  assert.equal(pos.type, "lp");
  assert.equal(pos.poolId, XLM_USDC.id);
  assert.equal(pos.poolName, "Stellar AMM XLM/USDC");
  assert.equal(pos.feeTier, 3000, "0.3%, in the units the card shows");
  assert.equal(pos.unpriced, undefined);
  // Each side's id is its asset's Stellar Asset Contract, as on Aquarius and Soroswap rows.
  assert.equal(pos.tokens[0].contractId, Asset.native().contractId(Networks.PUBLIC));
  assert.equal(pos.tokens[1].contractId, new Asset("USDC", USDC).contractId(Networks.PUBLIC));
  assert.deepEqual([pos.token1.code, pos.token1.issuer], ["USDC", USDC]);
});

test("a side with no price isn't in the value, and the position says which", async () => {
  const pos = await positionFor(XLM_SPAM, "10.0000000", priceCtx);
  assert.equal(pos.amounts.token0, "40.0000000");
  assert.equal(pos.amounts.token1, "100000.0000000");
  assert.equal(pos.valueUSD, 40 * XLM_USD);
  assert.equal(pos.unpriced, true);
  assert.deepEqual(pos.unpricedTokens, ["JUNK"]);
});

test("no shares, no position", async () => {
  assert.equal(await positionFor(XLM_USDC, "0.0000000", priceCtx), null);
});

// ── The adapter, against a fake Horizon ─────────────────────────────────────

const realFetch = global.fetch;
let horizon; // url → body; "fail" for an HTTP 503
let asked;
test.before(() => {
  global.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, ...rest);
    asked.push(u);
    const body = horizon[u];
    if (body === "fail") return { ok: false, status: 503, json: async () => ({}) };
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
});
test.after(() => { global.fetch = realFetch; });

const H = "https://horizon.stellar.org";
const poolsUrl = (a) => `${H}/liquidity_pools?account=${a}&limit=200`;
const page = (records, next) => ({ _embedded: { records }, _links: { next: { href: next } } });
const account = (balances) => ({ balances: [{ asset_type: "native", balance: "5.0000000" }, ...balances] });
const shareLine = (poolId, balance) => ({ asset_type: "liquidity_pool_shares", liquidity_pool_id: poolId, balance });

function holder() {
  const a = Keypair.random().publicKey();
  horizon[poolsUrl(a)] = page([XLM_USDC, XLM_SPAM]);
  horizon[`${H}/accounts/${a}`] = account([shareLine(XLM_USDC.id, SHARES), shareLine(XLM_SPAM.id, "0.0000000")]);
  return a;
}

test.beforeEach(() => { horizon = {}; asked = []; });

test("the adapter returns a position for each pool the wallet has shares in", async () => {
  const positions = await ClassicPools.getPositions(holder(), priceCtx);
  assert.equal(positions.length, 1, "an emptied share trustline gives none");
  assert.equal(positions[0].poolName, "Stellar AMM XLM/USDC");
  assert.equal(positions[0].shares, SHARES);
});

test("a wallet with no pool shares costs one Horizon request", async () => {
  const a = Keypair.random().publicKey();
  horizon[poolsUrl(a)] = page([]);
  assert.deepEqual(await ClassicPools.getPositions(a, priceCtx), []);
  assert.equal(asked.length, 1);
});

test("every page of pools is read", async () => {
  const a = Keypair.random().publicKey();
  const filler = Array.from({ length: 199 }, (_, i) => ({ ...XLM_SPAM, id: String(i).padStart(64, "0") }));
  horizon[poolsUrl(a)] = page([...filler, XLM_SPAM], `${H}/liquidity_pools?account=${a}&cursor=x&limit=200`);
  horizon[`${H}/liquidity_pools?account=${a}&cursor=x&limit=200`] = page([XLM_USDC]);
  horizon[`${H}/accounts/${a}`] = account([shareLine(XLM_USDC.id, SHARES)]);
  const positions = await ClassicPools.getPositions(a, priceCtx);
  assert.deepEqual(positions.map((p) => p.poolId), [XLM_USDC.id]);
});

test("a Horizon failure fails the adapter, so the wallet says Stellar AMM is unavailable", async () => {
  const a = Keypair.random().publicKey();
  horizon[poolsUrl(a)] = "fail";
  await assert.rejects(ClassicPools.getPositions(a, priceCtx), /Horizon HTTP 503/);
});

// ── In the wallet's total ───────────────────────────────────────────────────

test("the pool is in the wallet's DeFi positions and total (All Wallets)", async () => {
  const server = require("../server.js");
  const { app, __setTestDeps, PROTOCOL_ADAPTERS } = server;
  assert.ok(PROTOCOL_ADAPTERS.includes(ClassicPools), "registered");
  __setTestDeps({
    getHorizon: () => ({ loadAccount: async () => account([shareLine(XLM_USDC.id, SHARES)]) }),
    getXLMPrice: async () => priceCtx.xlmPrice,
    resolveSorobanTokens: async () => [],
    discoverSorobanTokens: async () => [],
    primeKnownPrices: async () => {},
  });
  const real = PROTOCOL_ADAPTERS.splice(0, PROTOCOL_ADAPTERS.length, ClassicPools);
  try {
    const a = holder();
    const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
    assert.equal(res.status, 200, res.raw);
    const w = res.body.wallets[0];
    assert.ok(Math.abs(w.totalValueUSD - (5 * XLM_USD + POOL_USD)) < 1e-6, `${w.totalValueUSD}`);
    assert.deepEqual(w.defiPositions.map((p) => p.poolName), ["Stellar AMM XLM/USDC"]);
  } finally {
    PROTOCOL_ADAPTERS.splice(0, PROTOCOL_ADAPTERS.length, ...real);
  }
});

// ── The CSV, snapshots and the page ─────────────────────────────────────────

test("the CSV gives the shares and the pool's assets, and value_usd still adds up", async () => {
  const pos = await positionFor(XLM_USDC, SHARES, priceCtx);
  const shares = { type: "lp_share", poolId: XLM_USDC.id, shares: SHARES, valueUSD: 0 };
  const xlm = { type: "native", balance: "5.0000000", valueUSD: 5 * XLM_USD };
  const csv = HoldingsCsv.build([{ address: "G".padEnd(56, "A"), balances: [xlm, shares], defiPositions: [pos] }], { asOf: "2026-11-24T12:00:00Z" });
  const [header, ...rows] = csv.trim().split("\r\n").map((l) => l.split(","));
  const col = (r, name) => r[header.indexOf(name)];
  const shareRow = rows.find((r) => col(r, "side") === "pool shares");
  assert.equal(col(shareRow, "value_usd"), "", "its value is the pool row's");
  assert.equal(col(shareRow, "amount_1"), SHARES);
  assert.equal(col(shareRow, "position"), "Stellar AMM XLM/USDC");
  const poolRow = rows.find((r) => col(r, "side") === "liquidity pool");
  assert.equal(col(poolRow, "venue"), "Stellar AMM");
  assert.deepEqual([col(poolRow, "asset_1"), col(poolRow, "amount_1"), col(poolRow, "asset_2"), col(poolRow, "amount_2")],
    ["XLM", "11522489.3191874", "USDC", "1437455.3650251"]);
  const sum = rows.reduce((s, r) => s + (Number(col(r, "value_usd")) || 0), 0);
  assert.ok(Math.abs(sum - (5 * XLM_USD + pos.valueUSD)) < 0.01);

  // A pool that couldn't be read keeps its 0 and says so.
  const unread = HoldingsCsv.build([{ address: "G".padEnd(56, "A"), balances: [shares], defiPositions: [] }], { asOf: "2026-11-24T12:00:00Z" });
  assert.match(unread, /pool shares,0\.00,.*not valued: the pool couldn't be read/);
});

test("a snapshot keeps the pool's two assets", async () => {
  const s = summarizeDefiPosition(await positionFor(XLM_USDC, SHARES, priceCtx));
  assert.equal(s.protocol, "stellar-amm");
  assert.equal(s.name, "Stellar AMM XLM/USDC");
  assert.deepEqual(s.legs.map((l) => [l.asset, l.side]), [["XLM", "pooled"], ["USDC", "pooled"]]);
});

test("the page names the pool and counts it once in LP / DeFi", () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "../public/index.html"), "utf8");
  assert.match(html, /pos\.protocol === "stellar-amm" \? \(pos\.poolName \|\| "Stellar AMM"\)/);
  assert.match(html, /"stellar-amm": "Stellar AMM"/, "past dates name it too");
  assert.match(html, /const sorobanDefi = defiPositions\.filter\(\(p\) => p\.protocol !== "stellar-amm"\);/);
  assert.match(html, /\$\{lpShares\.length \+ sorobanDefi\.length\}/);
});
