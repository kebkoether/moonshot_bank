// K2 Lend positions: a read that fails fails K2's result, instead of dropping
// part of the wallet's position, and the reserves are read at the same time.
//
// The adapter read a balance it couldn't get as 0, and skipped a reserve whose
// data or decimals it couldn't read. A failed debt read dropped the wallet's
// borrow, so its net worth was overstated by the whole debt, with nothing to
// say so, and the server kept that as K2's last good result. Failing instead
// lets the server serve the last good result, marked stale, or show K2 as
// unavailable. And reading five reserves one after another (about 15 RPC
// calls in a row) ran past the 8-second adapter limit when several wallets
// loaded together.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Address, StrKey, nativeToScVal } = require("@stellar/stellar-sdk");

// ── A fake K2 on a fake RPC ─────────────────────────────────────────────────
// The adapter destructures these at require time: mocks first.

const C = (n) => StrKey.encodeContract(Buffer.alloc(32, n));
const ROUTER = "CCTUJZLYFAW7ZNQD2SXMUZIHBUUJJICYRKWLZJ6SK6TGNAWNXOJIV6J7";
const USDC = C(1), XLM = C(2), SOLV = C(3);
const RAY = 10n ** 27n;
const RESERVES = {
  [USDC]: { symbol: "USDC", decimals: 7, aToken: C(11), debtToken: C(21), liquidityIndex: (RAY * 105n) / 100n, borrowIndex: RAY },
  [XLM]: { symbol: "native", decimals: 7, aToken: C(12), debtToken: C(22), liquidityIndex: RAY, borrowIndex: (RAY * 110n) / 100n },
  [SOLV]: { symbol: "SolvBTC", decimals: 8, aToken: C(13), debtToken: C(23), liquidityIndex: RAY, borrowIndex: RAY },
};
const PRICES = { [USDC]: 1, [XLM]: 0.2, [SOLV]: 100000 };

let balances; // token contract → scaled balance (bigint)
let failing; // "contract:method" (or "contract:balance") → Error
let delayMs;
let inFlight, maxInFlight, calls;

async function rpcCall(key, fn) {
  calls++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failing.has(key)) throw failing.get(key);
    return fn();
  } finally {
    inFlight--;
  }
}

const rpcLib = require("../lib/soroban-rpc");
rpcLib.simulateContractCall = (contractId, method, args = []) => rpcCall(`${contractId}:${method}`, () => {
  if (method === "balance") return nativeToScVal(balances.get(contractId) || 0n, { type: "i128" });
  if (contractId === ROUTER && method === "get_reserves_list") return nativeToScVal(Object.keys(RESERVES).map((a) => new Address(a)));
  if (contractId === ROUTER && method === "get_reserve_data") {
    const asset = Address.fromScVal(args[0]).toString();
    const r = RESERVES[asset];
    return nativeToScVal({
      a_token_address: new Address(r.aToken), debt_token_address: new Address(r.debtToken),
      liquidity_index: r.liquidityIndex, variable_borrow_index: r.borrowIndex,
      current_liquidity_rate: RAY / 20n, current_variable_borrow_rate: RAY / 10n,
    });
  }
  const r = RESERVES[contractId];
  if (r && method === "decimals") return nativeToScVal(r.decimals, { type: "u32" });
  if (r && method === "symbol") return nativeToScVal(r.symbol, { type: "string" });
  throw new Error(`unexpected ${method}@${contractId}`);
});
// The same balances through the strict read (a transport failure throws).
rpcLib.getTokenBalanceStrict = (contractId) => rpcCall(`${contractId}:balance`, () => String(balances.get(contractId) || 0n));

const pricing = require("../lib/pricing-engine");
pricing.priceSorobanToken = async (asset) => (PRICES[asset] != null ? { usd: PRICES[asset], source: "test" } : null);

const K2 = require("../lib/adapters/k2");
const ME = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";

test.beforeEach(() => {
  // 1,000 USDC supplied (scaled) and 2,000 XLM borrowed (scaled).
  balances = new Map([[RESERVES[USDC].aToken, 1000n * 10n ** 7n], [RESERVES[XLM].debtToken, 2000n * 10n ** 7n]]);
  failing = new Map();
  delayMs = 0;
  inFlight = 0; maxInFlight = 0; calls = 0;
});

const brief = (ps) => ps.map((p) => [p.type, p.asset, Math.round(p.underlyingAmount * 1e4) / 1e4, Math.round(p.valueUSD * 1e4) / 1e4]);

test("a wallet's supply and borrow, at the reserves' indexes and prices", async () => {
  const ps = await K2.getPositions(ME);
  assert.deepEqual(brief(ps), [
    ["lending", "USDC", 1050, 1050], //       1,000 × 1.05
    ["borrowing", "XLM", 2200, -440], //      2,000 × 1.10, at $0.20
  ]);
  const [g] = ps.__blendPoolGroups;
  assert.equal(g.protocol, "k2");
  assert.equal(Math.round(g.netUSD), 610);
});

test("a debt balance that can't be read fails K2, instead of dropping the borrow", async () => {
  failing.set(`${RESERVES[XLM].debtToken}:balance`, new Error("Simulation failed: preflight queue full"));
  // Before: the supply alone, $1,050 instead of $610 net.
  await assert.rejects(K2.getPositions(ME), /preflight queue full/);
});

test("a reserve whose data can't be read fails K2, instead of leaving it out", async () => {
  failing.set(`${ROUTER}:get_reserve_data`, new Error("Simulation failed: 503"));
  await assert.rejects(K2.getPositions(ME), /503/);
});

test("decimals that can't be read fail K2 (never guessed, as before; no longer skipped)", async () => {
  // A fresh adapter: the decimals are cached once read.
  delete require.cache[require.resolve("../lib/adapters/k2")];
  const fresh = require("../lib/adapters/k2");
  failing.set(`${SOLV}:decimals`, new Error("Simulation failed: 429"));
  await assert.rejects(fresh.getPositions(ME), /could not read decimals/);
});

test("the reserves are read at the same time", async () => {
  delayMs = 40;
  const started = Date.now();
  const ps = await K2.getPositions(ME);
  const ms = Date.now() - started;
  assert.equal(ps.length, 2);
  // Three reserves: the list, then each reserve's data and its two balances
  // (decimals and symbols are cached by now): 3 calls deep, not 1 + 3 × 2.
  assert.ok(maxInFlight >= 6, `at most ${maxInFlight} calls at once`);
  assert.ok(ms < 40 * 5, `${ms} ms`);
});

test("a wallet with nothing in K2 has no positions; one with no price still shows its amounts", async () => {
  balances = new Map();
  assert.deepEqual(await K2.getPositions(ME), []);

  balances = new Map([[RESERVES[XLM].debtToken, 2000n * 10n ** 7n]]);
  const saved = PRICES[XLM];
  delete PRICES[XLM];
  try {
    const [p] = await K2.getPositions(ME);
    assert.deepEqual([p.type, p.asset, Math.round(p.underlyingAmount * 1e4) / 1e4, Math.abs(p.valueUSD), p.unpriced], ["borrowing", "XLM", 2200, 0, true]);
  } finally {
    PRICES[XLM] = saved;
  }
});
