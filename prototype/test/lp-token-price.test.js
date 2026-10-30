// Liquidity-pool tokens are priced by contract, through the pricing engine.
//
// lp-discovery.js and lp-positions.js priced pool tokens by symbol alone:
// USDC, USDY, PYUSD, EURC and a few more at $1, XLM at the XLM price, and
// anything else at $0. USDY (~$1.15) and EURC (~$1.12) were undervalued, and
// one side of every AQUA, SHX, BLND or sUSD pool was dropped. Each token now
// goes through the pricing engine by contract (lib/lp-token-price.js), as
// Blend's and K2's already do; the old rule remains for a token the engine
// can't price, so no pool is valued lower than before.

const { wallet } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Address, Asset, Networks, StrKey, nativeToScVal } = require("@stellar/stellar-sdk");

const sac = (code, issuer) => new Asset(code, issuer).contractId(Networks.PUBLIC);
const XLM_SAC = Asset.native().contractId(Networks.PUBLIC);
const USDC_SAC = sac("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
const AQUA_SAC = sac("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA");
const EURC_SAC = sac("EURC", "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2");
const USDY_SAC = "CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP";
const USDX = "CDIKURWHYS4FFTR5KOQK6MBFZA2K3E26WGBQI6PXBYWZ4XIOPJHDFJKP"; // FxDAO's USDx: no price source
const contract = () => StrKey.encodeContract(crypto.randomBytes(32));
const SOROSWAP_PAIR = contract();
const DIRECT_POOL = contract(); // a pool lp-positions finds in the wallet's own calls
const SYMBOLS = { [XLM_SAC]: "native", [USDC_SAC]: "USDC", [AQUA_SAC]: "AQUA", [EURC_SAC]: "EURC", [USDY_SAC]: "USDY", [USDX]: "USDx" };

// The pricing engine's answers, by contract (steered per test).
const MARKET = { [USDC_SAC]: 1, [AQUA_SAC]: 0.0003, [EURC_SAC]: 1.12, [USDY_SAC]: 1.15 };
let prices;
const pricing = require("../lib/pricing-engine");
const priced = [];
pricing.priceSorobanToken = async (c) => {
  priced.push(c);
  return prices[c] != null ? { usd: prices[c], source: "test" } : null;
};

// ── Fake RPC (the adapters destructure it at require time) ──────────────────

const rpcLib = require("../lib/soroban-rpc");
let pairBalance = "0";
rpcLib.getTokenBalanceStrict = async (c) => (c === SOROSWAP_PAIR ? pairBalance : "0");
rpcLib.getTokenBalance = async (c) => (c === DIRECT_POOL ? "1000" : "0");
rpcLib.getTokenMetadata = async (c) => ({ name: SYMBOLS[c] || "?", symbol: SYMBOLS[c] || "?", decimals: 7 });
rpcLib.simulateContractCall = async (c, method) => {
  const v = (x, type) => nativeToScVal(x, type ? { type } : undefined);
  if (method === "all_pairs_length") return v(1, "u32");
  if (method === "all_pairs") return v(SOROSWAP_PAIR, "string");
  if (method === "get_user_positions_with_fees") return v([]); // no SushiSwap positions
  if (c === SOROSWAP_PAIR) {
    if (method === "total_supply") return v(1000n, "i128");
    if (method === "get_reserves") return v([1000n * 10n ** 7n, 100n * 10n ** 7n], "i128"); // 1000 XLM, 100 EURC
    if (method === "token_0") return v(XLM_SAC, "string");
    if (method === "token_1") return v(EURC_SAC, "string");
  }
  if (c === DIRECT_POOL) {
    if (method === "get_reserves") return v([200n * 10n ** 7n, 100n * 10n ** 7n], "i128"); // 200 USDY, 100 USDC
    if (method === "get_tokens") return v([USDY_SAC, USDC_SAC].map((t) => new Address(t)));
    if (method === "total_supply") return v(10_000n, "i128");
    if (method === "share_id") throw new Error("Simulation failed: no share_id");
  }
  throw new Error(`unexpected ${method} on ${c.slice(0, 6)}`);
};

const LPDiscovery = require("../lib/adapters/lp-discovery");
const LPPositions = require("../lib/adapters/lp-positions");
const { lpTokenUSD } = require("../lib/lp-token-price");

// ── Fake HTTP: the Aquarius API, and Horizon for lp-positions' walk ─────────

let aquaRows = [];
const realFetch = global.fetch;
test.before(() => {
  global.fetch = async (url) => {
    url = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes("amm-api.aqua.network")) return json({ count: aquaRows.length, results: aquaRows });
    if (url.includes("/operations")) {
      return json({ _embedded: { records: [{
        type: "invoke_host_function",
        parameters: [{ type: "Address", value: new Address(DIRECT_POOL).toScVal().toXDR("base64") }],
      }] } });
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
});
test.after(() => { global.fetch = realFetch; });

const ctx = { xlmPrice: { usd: 0.17 } };
const key = (t) => `${SYMBOLS[t]}:GISSUER`;
const aquaRow = (tokens, amounts) => ({
  address: contract(),
  pool_type: "constant_product",
  tokens_addresses: tokens,
  tokens_str: tokens.map(key),
  deposited_tokens: Object.fromEntries(tokens.map((t, i) => [key(t), String(amounts[i])])),
});
const close = (a, b) => Math.abs(a - b) < 1e-6;

test.beforeEach(() => {
  prices = { ...MARKET };
  aquaRows = [];
  pairBalance = "0";
  priced.length = 0;
});

// ── The helper ──────────────────────────────────────────────────────────────

test("lpTokenUSD: XLM at the request's XLM price, other tokens by contract", async () => {
  assert.equal(await lpTokenUSD(XLM_SAC, { symbol: "XLM", xlmPrice: { usd: 0.17 } }), 0.17);
  assert.equal(await lpTokenUSD(USDY_SAC, { symbol: "USDY" }), 1.15);
  assert.equal(await lpTokenUSD(AQUA_SAC, { symbol: "AQUA" }), 0.0003);
  assert.ok(!priced.includes(XLM_SAC), "XLM doesn't need the engine when the request has a price");
});

test("lpTokenUSD: with no price from the engine, the old symbol rule applies", async () => {
  prices = {}; // CoinGecko rate-limited, say
  assert.equal(await lpTokenUSD(USDY_SAC, { symbol: "USDY" }), 1);
  assert.equal(await lpTokenUSD(USDX, { symbol: "USDx" }), 1);
  assert.equal(await lpTokenUSD(AQUA_SAC, { symbol: "AQUA" }), 0);
  assert.equal(await lpTokenUSD(null, { symbol: "native", xlmPrice: { usd: 0.17 } }), 0.17);
});

// ── Aquarius (lp-discovery) ─────────────────────────────────────────────────

test("Aquarius: both sides of an XLM/AQUA pool count", async () => {
  aquaRows = [aquaRow([XLM_SAC, AQUA_SAC], [1000, 2_000_000])];
  const [p] = await LPDiscovery.getPositions(wallet().publicKey(), ctx);
  assert.ok(close(p.valueUSD, 1000 * 0.17 + 2_000_000 * 0.0003), `valueUSD ${p.valueUSD}`);
});

test("Aquarius: EURC and USDY at their prices, not $1", async () => {
  aquaRows = [aquaRow([EURC_SAC, USDC_SAC], [100, 100]), aquaRow([USDY_SAC, USDC_SAC], [100, 100])];
  const positions = await LPDiscovery.getPositions(wallet().publicKey(), ctx);
  assert.ok(close(positions[0].valueUSD, 100 * 1.12 + 100), `EURC/USDC ${positions[0].valueUSD}`);
  assert.ok(close(positions[1].valueUSD, 100 * 1.15 + 100), `USDY/USDC ${positions[1].valueUSD}`);
});

test("Aquarius: with no prices from the engine, a pool is valued as before, not lower", async () => {
  prices = { [USDC_SAC]: 1 };
  aquaRows = [aquaRow([USDY_SAC, USDC_SAC], [100, 100]), aquaRow([USDX, USDC_SAC], [50, 50])];
  const positions = await LPDiscovery.getPositions(wallet().publicKey(), ctx);
  assert.deepEqual(positions.map((p) => p.valueUSD), [200, 100]);
});

// ── Soroswap (lp-discovery) ─────────────────────────────────────────────────

test("Soroswap: EURC in an XLM/EURC pair at its price, not $1", async () => {
  pairBalance = "500"; // half the pair: 500 XLM, 50 EURC
  const positions = await LPDiscovery.getPositions(wallet().publicKey(), ctx);
  const p = positions.find((x) => x.protocol === "soroswap");
  assert.ok(close(p.valueUSD, 500 * 0.17 + 50 * 1.12), `valueUSD ${p.valueUSD}`);
});

// ── A pool from the wallet's own calls (lp-positions) ───────────────────────

test("lp-positions: USDY in a pool the wallet called directly is at its price, not $1", async () => {
  const positions = await LPPositions.getPositions(wallet().publicKey(), ctx);
  const p = positions.find((x) => x.contractId === DIRECT_POOL);
  assert.ok(p, "the pool is found");
  // 1000 of 10,000 shares: 20 USDY + 10 USDC
  assert.ok(close(p.valueUSD, 20 * 1.15 + 10), `valueUSD ${p.valueUSD}`);
});
