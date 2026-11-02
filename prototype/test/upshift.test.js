// Upshift positions don't wait for Upshift's vault list, and a vault that
// could not be read fails the adapter instead of reading as "no position".
//
// The adapter fetched https://api.upshift.finance/v1/tokenized_vaults inline:
// about 13 MB (every chain's vaults, with their history), 9 to 16 seconds. So
// the first load after a restart, and the first after the list expired each
// hour, ran past the server's 8-second adapter budget, and Upshift showed as
// not responding. And a failed balance read counted as 0 shares, so a
// position could vanish from the total with no sign that it was missing.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { nativeToScVal, scValToNative, StrKey } = require("@stellar/stellar-sdk");

const SENT_USDC = "CALFCZ4TY2CLHDHNJWCZX6JKYGUPV7P3GNQ3UVABXNE5JCV2E774APUM"; // built in
const EARN_XLM = "CC6TRAPQD3NK7THUKWPV5SL2JHKQGNXZVB6S6MVYFSLRWAKEFUWZKZ7J"; // built in
const NEW_VAULT = StrKey.encodeContract(crypto.randomBytes(32)); // only the API lists it

// ── Fake RPC ────────────────────────────────────────────────────────────────
// The adapter destructures these at require time, so they go in first.

const SHARE = 10n ** 13n; // shares have 13 decimals
const STROOP = 10n ** 7n; // deposit tokens have 7
let shares; // contractId → user's share balance (whole shares)
let rateTenths; // contractId → deposit units per share × 10 (convert_to_assets)
let failing; // contractId → Error thrown by any read of it
let noConvert; // contractIds whose contract has no convert_to_assets
let convertFailing; // contractId → Error thrown by its convert_to_assets read only

const rpcLib = require("../lib/soroban-rpc");
const read = (contractId) => {
  if (failing.has(contractId)) throw failing.get(contractId);
};
// Same semantics as the real ones: Strict throws on transport errors; the
// lenient one (which the adapter used to call) turns every error into "0".
rpcLib.getTokenBalanceStrict = async (contractId) => {
  read(contractId);
  return String((shares.get(contractId) || 0n) * SHARE);
};
rpcLib.getTokenBalance = async (contractId, user) => {
  try {
    return await rpcLib.getTokenBalanceStrict(contractId, user);
  } catch (e) {
    return "0";
  }
};
rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  read(contractId);
  if (method !== "convert_to_assets") throw new Error(`unexpected ${method}`);
  if (convertFailing.has(contractId)) throw convertFailing.get(contractId);
  if (noConvert.has(contractId)) throw new Error("Simulation failed: HostError: Error(WasmVm, MissingValue)");
  const raw = BigInt(scValToNative(args[0]));
  return nativeToScVal((raw * BigInt(rateTenths.get(contractId) || 10)) / SHARE * STROOP / 10n, { type: "i128" });
};

// ── Fake Upshift API ────────────────────────────────────────────────────────

const apiVault = (address, symbol, receipt, apy7) => ({
  address,
  chain_type: "stellar",
  status: "active",
  vault_name: receipt,
  receipt_token_symbol: receipt,
  historical_apy: { 1: apy7, 7: apy7, 30: apy7 },
  stellar_vault_metadata: { deposit_token_symbol: symbol, deposit_token_decimals: 7 },
});
const API_LIST = [
  apiVault(SENT_USDC, "USDC", "sentUSDC", 0.0799),
  apiVault(EARN_XLM, "XLM", "earnXLM", 0.0208),
  apiVault(NEW_VAULT, "USDC", "newUSDC", 0.05),
  { address: "0xabc", chain_type: "evm", status: "active" },
];
let listFetches;
let respond; // (resolve) => void, called for each list fetch
const realFetch = global.fetch;
test.before(() => {
  global.fetch = (url) => {
    assert.match(String(url), /\/v1\/tokenized_vaults$/);
    listFetches++;
    return new Promise((resolve) => respond(resolve));
  };
});
test.after(() => {
  global.fetch = realFetch;
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const Upshift = require("../lib/adapters/upshift");
const ctx = { xlmPrice: { usd: 0.2 } };

/** getPositions, or "still waiting" if it hasn't settled within 300 ms. */
function within300ms(promise) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("still waiting"), 300))]);
}

test.beforeEach(() => {
  Upshift._resetForTests?.();
  shares = new Map();
  rateTenths = new Map();
  failing = new Map();
  noConvert = new Set();
  convertFailing = new Map();
  listFetches = 0;
  respond = (resolve) => resolve(ok(API_LIST));
});

// ── Not waiting for the list ────────────────────────────────────────────────

test("a position is read on a cold start without waiting for Upshift's vault list", async () => {
  let release;
  respond = (resolve) => { release = () => resolve(ok(API_LIST)); }; // the 13 MB, still downloading
  shares.set(SENT_USDC, 1_000n);
  rateTenths.set(SENT_USDC, 11); // 1.1 USDC per share
  const positions = await within300ms(Upshift.getPositions(wallet().publicKey(), ctx));
  assert.notEqual(positions, "still waiting");
  assert.equal(positions.length, 1);
  assert.equal(positions[0].receiptSymbol, "sentUSDC");
  assert.equal(positions[0].valueUSD, 1100);
  assert.equal(positions[0].yield.apy, null, "APY is unknown until the list arrives");
  release?.();
  await Upshift._vaultListSettled?.();
});

test("once the list has arrived, its APY is shown and a vault only it lists is read too", async () => {
  shares.set(SENT_USDC, 1_000n);
  shares.set(NEW_VAULT, 50n);
  const user = wallet().publicKey();
  await Upshift.getPositions(user, ctx); // starts the fetch
  await Upshift._vaultListSettled?.();
  const positions = await Upshift.getPositions(user, ctx);
  const sent = positions.find((p) => p.receiptSymbol === "sentUSDC");
  assert.ok(Math.abs(sent.yield.apy - 7.99) < 1e-9);
  assert.ok(positions.find((p) => p.receiptSymbol === "newUSDC"), "a vault launched after this release");
  assert.equal(listFetches, 1);
});

test("when the list is an hour old it is fetched again in the background, once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  shares.set(EARN_XLM, 100n);
  const user = wallet().publicKey();
  await Upshift.getPositions(user, ctx);
  await Upshift._vaultListSettled?.();
  assert.equal(listFetches, 1);

  t.mock.timers.setTime(1_800_000_000_000 + 61 * 60_000);
  respond = () => {}; // this fetch never finishes
  const loads = await Promise.all([1, 2, 3].map(() => within300ms(Upshift.getPositions(user, ctx))));
  for (const positions of loads) {
    assert.notEqual(positions, "still waiting");
    assert.equal(positions[0].valueUSD, 100 * 0.2);
    assert.ok(positions[0].yield.apy > 0, "the last list's APY is kept meanwhile");
  }
  assert.equal(listFetches, 2, "one fetch, shared");
});

test("a failed list fetch keeps the vaults, and isn't retried on every load", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  respond = (resolve) => resolve({ ok: false, status: 503, json: async () => ({}) });
  shares.set(SENT_USDC, 10n);
  const user = wallet().publicKey();
  await Upshift.getPositions(user, ctx);
  await Upshift._vaultListSettled?.();
  t.mock.timers.setTime(1_800_000_000_000 + 60_000);
  const positions = await Upshift.getPositions(user, ctx);
  assert.equal(positions.length, 1, "the built-in vault is still read");
  assert.equal(listFetches, 1, "not asked again a minute later");
  t.mock.timers.setTime(1_800_000_000_000 + 6 * 60_000);
  await Upshift.getPositions(user, ctx);
  assert.equal(listFetches, 2, "asked again after 5 minutes");
});

// ── A failed read is not "no position" ──────────────────────────────────────

test("a failed balance read fails the adapter instead of dropping the position", async () => {
  shares.set(SENT_USDC, 38_705_049n);
  shares.set(EARN_XLM, 100n);
  failing.set(SENT_USDC, new Error("Request failed with status code 429"));
  await assert.rejects(Upshift.getPositions(wallet().publicKey(), ctx), /429/);
});

test("a failed convert_to_assets read fails the adapter instead of valuing shares 1:1", async () => {
  shares.set(SENT_USDC, 1_000n);
  rateTenths.set(SENT_USDC, 11);
  convertFailing.set(SENT_USDC, new Error("timeout of 30000ms exceeded"));
  await assert.rejects(Upshift.getPositions(wallet().publicKey(), ctx), /timeout/);
});

test("a vault without convert_to_assets is still valued 1:1", async () => {
  shares.set(SENT_USDC, 1_000n);
  noConvert.add(SENT_USDC);
  const [p] = await Upshift.getPositions(wallet().publicKey(), ctx);
  assert.equal(p.valueUSD, 1000);
});
