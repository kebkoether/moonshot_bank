// Phoenix LP positions (lib/adapters/phoenix.js).
//
// Phoenix pools weren't read at all: a wallet's Phoenix liquidity, held or
// staked, was missing from its DeFi positions and total. The adapter lists
// the pools from Phoenix's factory, reads the wallet's share balance and
// bonded shares for every pool in one getLedgerEntries request, and values
// the shares at what withdrawing them pays out.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Address, StrKey, nativeToScVal, scValToNative, xdr } = require("@stellar/stellar-sdk");

process.env.RPC_RETRY_BASE_MS = "1";
process.env.RPC_RETRY_ATTEMPTS = "2";

const C = (n) => StrKey.encodeContract(Buffer.alloc(32, n));
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC = C(1), PHO = C(2), SIX = C(3);
const TOKENS = { [USDC]: ["USDC", 7], [PHO]: ["PHO", 7], [SIX]: ["SIX", 6] };
const PRICES = { [XLM]: 0.2, [USDC]: 1, [SIX]: 2 }; // PHO has no price

// Three pools: XLM/USDC and PHO/USDC with stake contracts, and USDC/SIX
// whose stake address is the pool itself (one mainnet pool reports that).
const POOLS = [
  { pool: C(10), a: XLM, b: USDC, ra: 1000n * 10n ** 7n, rb: 200n * 10n ** 7n, share: C(11), total: 100n * 10n ** 7n, stake: C(12) },
  { pool: C(20), a: PHO, b: USDC, ra: 50000n * 10n ** 7n, rb: 500n * 10n ** 7n, share: C(21), total: 1000n * 10n ** 7n, stake: C(22) },
  { pool: C(30), a: USDC, b: SIX, ra: 300n * 10n ** 7n, rb: 150n * 10n ** 6n, share: C(31), total: 30n * 10n ** 7n, stake: C(30) },
];
const ME = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";

let ledger; // key XDR -> ScVal stored there
let failing; // "contract:method" | "getLedgerEntries" -> Error
let rewards; // stake contract -> [{ token, amount }]
let calls; // what was asked, in order

const rpcLib = require("../lib/soroban-rpc");

function poolDetailsScVal() {
  return nativeToScVal(POOLS.map((p) => ({
    pool_address: new Address(p.pool),
    pool_response: {
      asset_a: { address: new Address(p.a), amount: p.ra },
      asset_b: { address: new Address(p.b), amount: p.rb },
      asset_lp_share: { address: new Address(p.share), amount: p.total },
      stake_address: new Address(p.stake),
    },
    total_fee_bps: 50n,
  })), {
    type: {
      pool_address: ["symbol", "address"],
      pool_response: ["symbol", {
        asset_a: ["symbol", { address: ["symbol", "address"], amount: ["symbol", "i128"] }],
        asset_b: ["symbol", { address: ["symbol", "address"], amount: ["symbol", "i128"] }],
        asset_lp_share: ["symbol", { address: ["symbol", "address"], amount: ["symbol", "i128"] }],
        stake_address: ["symbol", "address"],
      }],
      total_fee_bps: ["symbol", "i64"],
    },
  });
}

rpcLib.simulateContractCall = async (contractId, method, args = []) => {
  calls.push(`${contractId}:${method}`);
  const k = `${contractId}:${method}`;
  if (failing.has(k)) throw failing.get(k);
  const Phoenix = require("../lib/adapters/phoenix");
  if (contractId === Phoenix.PHOENIX_FACTORY && method === "query_all_pools_details") return poolDetailsScVal();
  if (TOKENS[contractId] && method === "symbol") return nativeToScVal(TOKENS[contractId][0], { type: "string" });
  if (TOKENS[contractId] && method === "decimals") return nativeToScVal(TOKENS[contractId][1], { type: "u32" });
  if (method === "query_withdrawable_rewards") {
    assert.equal(Address.fromScVal(args[0]).toString(), ME);
    const list = (rewards.get(contractId) || []).map((r) => ({ reward_address: new Address(r.token), reward_amount: r.amount }));
    return nativeToScVal({ rewards: list }, { type: { rewards: ["symbol", null] } });
  }
  throw new Error(`unexpected ${method}@${contractId}`);
};

const realGetLedgerEntries = rpcLib.getLedgerEntries;
rpcLib.getLedgerEntries = async (keys) => {
  calls.push(`getLedgerEntries:${keys.length}`);
  if (failing.has("getLedgerEntries")) throw failing.get("getLedgerEntries");
  const out = new Map();
  for (const k of keys) {
    const x = k.toXDR("base64");
    // The plain-object shape stellar-sdk 17 returns (read by contractDataScVal).
    if (ledger.has(x)) out.set(x, { key: k, val: { contractData: { val: ledger.get(x) } } });
  }
  return out;
};

const pricing = require("../lib/pricing-engine");
pricing.priceSorobanToken = async (c) => (PRICES[c] != null ? { usd: PRICES[c], source: "test" } : null);

const Phoenix = require("../lib/adapters/phoenix");

function holdShares(shareToken, amount) {
  ledger.set(Phoenix.shareBalanceKey(shareToken, ME).toXDR("base64"), nativeToScVal(amount, { type: "i128" }));
}
function bond(stake, ...amounts) {
  ledger.set(Phoenix.stakeKey(stake, ME).toXDR("base64"), nativeToScVal({
    last_reward_time: 0n,
    reward_debt: 0n,
    stakes: amounts.map((a) => ({ stake: a, stake_timestamp: 1749140053n })),
    total_stake: amounts.reduce((s, a) => s + a, 0n),
  }, { type: { last_reward_time: ["symbol", "u64"], reward_debt: ["symbol", "u128"], stakes: ["symbol", null], total_stake: ["symbol", "i128"] } }));
}

test.beforeEach(() => {
  ledger = new Map();
  failing = new Map();
  rewards = new Map();
  calls = [];
  Phoenix._resetForTests();
});

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("held and staked shares: what withdrawing pays, valued, with the stake's rewards", async () => {
  // XLM/USDC: 5 shares held + 3 + 2 bonded = 10 of 100 shares -> 100 XLM and 20 USDC.
  holdShares(POOLS[0].share, 5n * 10n ** 7n);
  bond(POOLS[0].stake, 3n * 10n ** 7n, 2n * 10n ** 7n);
  rewards.set(POOLS[0].stake, [{ token: PHO, amount: 1556891809n }, { token: XLM, amount: 25n * 10n ** 7n }, { token: USDC, amount: 0n }]);
  // USDC/SIX: 3 of 30 shares held (no stake contract) -> 30 USDC and 15 SIX (6 decimals).
  holdShares(POOLS[2].share, 3n * 10n ** 7n);

  const out = await Phoenix.getPositions(ME, { xlmPrice: { usd: 0.2 } });
  assert.equal(out.length, 2);
  const [xlmUsdc, usdcSix] = out;

  assert.equal(xlmUsdc.protocol, "phoenix");
  assert.equal(xlmUsdc.type, "lp");
  assert.equal(xlmUsdc.poolContractId, POOLS[0].pool);
  assert.deepEqual([xlmUsdc.token0.symbol, xlmUsdc.token1.symbol], ["XLM", "USDC"]);
  assert.deepEqual(xlmUsdc.amounts, { token0: "100", token1: "20" });
  assert.deepEqual(xlmUsdc.lpShares, { held: "50000000", staked: "50000000" });
  near(xlmUsdc.valueUSD, 100 * 0.2 + 20);
  assert.equal(xlmUsdc.unpriced, undefined);
  assert.deepEqual(xlmUsdc.unclaimedRewards, [
    { asset: "PHO", contractId: PHO, amount: 155.6891809, valueUSD: null, source: "stake" },
    { asset: "XLM", contractId: XLM, amount: 25, valueUSD: 5, source: "stake" },
  ]);

  assert.deepEqual(usdcSix.tokens.map((t) => [t.symbol, t.decimals]), [["USDC", 7], ["SIX", 6]]);
  assert.deepEqual(usdcSix.amounts, { token0: "30", token1: "15" });
  near(usdcSix.valueUSD, 30 + 15 * 2);
  assert.equal(usdcSix.unclaimedRewards, undefined, "nothing staked: no rewards read");
});

test("one ledger request for every pool; the pool list is read once and shared", async () => {
  holdShares(POOLS[1].share, 10n * 10n ** 7n);
  await Promise.all([Phoenix.getPositions(ME), Phoenix.getPositions(ME)]);
  await Phoenix.getPositions(ME);
  const factory = calls.filter((c) => c.endsWith(":query_all_pools_details"));
  assert.equal(factory.length, 1, "pool list cached, and concurrent loads share one read");
  // Two keys per pool with a stake contract, one for the pool without.
  assert.deepEqual(calls.filter((c) => c.startsWith("getLedgerEntries")), ["getLedgerEntries:5", "getLedgerEntries:5", "getLedgerEntries:5"]);
  assert.ok(!calls.some((c) => c.endsWith(":balance") || c.endsWith(":query_staked")), "no per-pool simulations");
  assert.ok(!calls.some((c) => c.startsWith(POOLS[2].pool + ":")), "the pool without a stake contract isn't asked for stakes or rewards");
});

test("a wallet with nothing in Phoenix: [] and nothing else read", async () => {
  assert.deepEqual(await Phoenix.getPositions(ME), []);
  assert.deepEqual(calls, [`${Phoenix.PHOENIX_FACTORY}:query_all_pools_details`, "getLedgerEntries:5"]);
});

test("a side with no price is flagged and left out of the value", async () => {
  bond(POOLS[1].stake, 100n * 10n ** 7n); // 100 of 1,000 shares -> 5,000 PHO and 50 USDC
  const [pos] = await Phoenix.getPositions(ME);
  assert.deepEqual(pos.amounts, { token0: "5000", token1: "50" });
  near(pos.valueUSD, 50);
  assert.equal(pos.unpriced, true);
  assert.deepEqual(pos.unpricedTokens, ["PHO"]);
  assert.deepEqual(pos.lpShares, { held: "0", staked: "1000000000" });
  assert.deepEqual(pos.unclaimedRewards, []);
});

test("a read that fails fails Phoenix's result instead of dropping a position", async (t) => {
  const busy = Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });

  await t.test("the factory", async () => {
    holdShares(POOLS[0].share, 5n * 10n ** 7n);
    failing = new Map([[`${Phoenix.PHOENIX_FACTORY}:query_all_pools_details`, busy]]);
    await assert.rejects(Phoenix.getPositions(ME), /429/);
  });
  await t.test("the wallet's ledger entries", async () => {
    holdShares(POOLS[0].share, 5n * 10n ** 7n);
    failing = new Map([["getLedgerEntries", busy]]);
    await assert.rejects(Phoenix.getPositions(ME), /429/);
  });
  await t.test("a token's decimals (never guessed)", async () => {
    holdShares(POOLS[0].share, 5n * 10n ** 7n);
    failing = new Map([[`${USDC}:decimals`, busy]]);
    await assert.rejects(Phoenix.getPositions(ME), /429/);
  });
  await t.test("an entry in a shape the contracts don't write", async () => {
    ledger.set(Phoenix.stakeKey(POOLS[0].stake, ME).toXDR("base64"), nativeToScVal(5n, { type: "i128" }));
    await assert.rejects(Phoenix.getPositions(ME), /unexpected stake entry/);
  });
});

test("rewards that can't be read: the position stays, its rewards read as unknown", async () => {
  bond(POOLS[0].stake, 10n * 10n ** 7n);
  failing = new Map([[`${POOLS[0].stake}:query_withdrawable_rewards`, new Error("Simulation failed: HostError: Error(WasmVm, MissingValue)")]]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const [pos] = await Phoenix.getPositions(ME, { xlmPrice: { usd: 0.2 } });
    assert.deepEqual(pos.amounts, { token0: "100", token1: "20" });
    assert.equal(pos.unclaimedRewards, null);
  } finally {
    console.warn = warn;
  }
});

test("the ledger keys are the ones the Phoenix contracts read", () => {
  // stellar-sdk 17's XDR objects: plain properties, not methods.
  const bal = Phoenix.shareBalanceKey(POOLS[0].share, ME).contractData;
  assert.equal(Address.fromScAddress(bal.contract).toString(), POOLS[0].share);
  assert.deepEqual(scValToNative(bal.key), ["Balance", ME]); // token: DataKey::Balance(Address)
  assert.equal(bal.durability, xdr.ContractDataDurability.persistent);
  const st = Phoenix.stakeKey(POOLS[0].stake, ME).contractData;
  assert.equal(Address.fromScAddress(st.contract).toString(), POOLS[0].stake);
  assert.equal(scValToNative(st.key), ME); // stake: get_stakes(env, &address)
});

test("getLedgerEntries: at most 200 keys a request, a busy RPC retried, keys with no entry left out", async () => {
  const sizes = [];
  let busy = 1;
  rpcLib.server.getLedgerEntries = async (...keys) => {
    if (busy-- > 0) throw Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } });
    sizes.push(keys.length);
    const one = nativeToScVal(1n, { type: "i128" });
    return { entries: keys.filter((_, i) => i % 2 === 0).map((key) => ({ key, val: { contractData: { val: one } } })) };
  };
  try {
    const keys = Array.from({ length: 450 }, (_, i) => {
      const b = Buffer.alloc(32);
      b.writeUInt16BE(i);
      return Phoenix.shareBalanceKey(POOLS[0].share, StrKey.encodeEd25519PublicKey(b));
    });
    const out = await realGetLedgerEntries(keys);
    assert.deepEqual(sizes, [200, 200, 50]);
    assert.equal(out.size, 225);
    assert.ok(out.has(keys[0].toXDR("base64")));
    assert.ok(!out.has(keys[1].toXDR("base64")));
  } finally {
    delete rpcLib.server.getLedgerEntries; // back to the SDK's own method
  }
});

test("the page and the holdings CSV name Phoenix, its staked shares and its unpriced side", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /pos\.protocol === "phoenix" \? "Phoenix"/);
  assert.match(html, /phoenix: "Phoenix"/);
  assert.match(html, /<div class="defi-detail-label">Staked<\/div>/);

  const H = require("../public/holdings-csv.js");
  const wallet = {
    address: ME,
    balances: [],
    defiPositions: [{
      protocol: "phoenix", type: "lp", tokens: [{ symbol: "PHO", contractId: PHO }, { symbol: "USDC", contractId: USDC }],
      token0: { symbol: "PHO" }, token1: { symbol: "USDC" }, amounts: { token0: "5000", token1: "50" },
      lpShares: { held: "0", staked: "1000000000" }, valueUSD: 50, unpriced: true, unpricedTokens: ["PHO"],
      unclaimedRewards: [{ asset: "PHO", contractId: PHO, amount: 155.69, valueUSD: null, source: "stake" }],
    }],
  };
  const csv = H.build([wallet], { asOf: "2026-11-10T00:00:00.000Z" });
  const lines = csv.split("\r\n");
  const head = lines[0].split(",");
  const rows = lines.slice(1).filter(Boolean).map((l) => Object.fromEntries(head.map((h, i) => [h, l.split(",")[i]])));
  const lp = rows.find((r) => r.side === "liquidity pool");
  assert.equal(lp.venue, "Phoenix");
  assert.equal(lp.position, "PHO/USDC");
  assert.equal(lp.value_usd, "50.00");
  assert.match(csv, /no price for PHO: not in value_usd; the pool shares are staked/);
  const reward = rows.find((r) => r.side === "unclaimed reward");
  assert.equal(reward.venue, "Phoenix");
});
