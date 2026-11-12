/**
 * Phoenix DEX liquidity positions.
 *
 * Phoenix (https://www.phoenix-hub.io) runs constant-product pools on Soroban.
 * Its factory lists the pools; each pool has its own share token (the LP
 * token) and, for most pools, a stake contract where providers bond those
 * shares to earn PHO. A provider can hold shares in the wallet, have them
 * bonded in the stake contract, or both. Bonded shares sit in the stake
 * contract's balance, not the wallet's, so a wallet that staked everything
 * holds no share token at all.
 *
 * Neither LP discoverer saw Phoenix: lp-discovery reads Aquarius and
 * Soroswap, and lp-positions only reads pools listed by hand.
 *
 * One read per wallet. The factory's pool list (one call, cached) gives every
 * pool's reserves, share token, total shares and stake contract. The wallet's
 * share balance in every pool and its bonded shares in every stake contract
 * are then read straight from the ledger, in one getLedgerEntries request,
 * rather than with ~25 simulations per wallet. The storage keys are the ones
 * the Phoenix contracts themselves read:
 *   share token:    DataKey::Balance(user)  -> i128
 *     (contracts/token/src/storage_types.rs, balance.rs)
 *   stake contract: user                    -> BondingInfo { stakes, ... }
 *     (contracts/stake/src/storage.rs, get_stakes)
 * A missing entry is what the contracts read as nothing: 0 shares, no stakes.
 * An entry that is there but doesn't decode to that shape throws: the layout
 * changed and the reading is wrong, not empty.
 *
 * Unclaimed PHO on bonded shares (query_withdrawable_rewards) is shown next to
 * the position and not added to its value, like Aquarius's rewards and
 * Blend's pending BLND. A rewards read that fails sets unclaimedRewards to
 * null ("couldn't be read") and doesn't fail the position.
 */
const { xdr, Address, scValToNative } = require("@stellar/stellar-sdk");
// Called through the module object (not destructured) so tests can stub them.
const rpcLib = require("../soroban-rpc");
const lpPrice = require("../lp-token-price");

// Phoenix's factory on mainnet (Phoenix-Protocol-Group/phoenix-contracts).
const PHOENIX_FACTORY = "CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI";
const XLM_SAC = lpPrice.XLM_SAC;

// Reserves move with every swap: the pool list (with them) is kept a minute.
const POOL_LIST_TTL_MS = 60_000;
const REWARD_CONCURRENCY = 4;

let _pools = null; // { ts, pools }
let _poolsInFlight = null;
const _tokenCache = new Map(); // contractId -> { symbol, decimals }

/** Raw integer amount -> number, via its decimal string (exact to the last digit a double holds). */
function _toUnits(raw, decimals) {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const n = Number(decimals > 0 ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s);
  return neg ? -n : n;
}

/** Display string for an amount: at most 6 decimals, no trailing zeros. */
function _fmt(n) {
  return n.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function _bigint(v, what) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`Phoenix: unexpected ${what}: ${typeof v}`);
}

/**
 * The factory's pools, cached for POOL_LIST_TTL_MS. Throws if the factory
 * can't be read or answers in a shape this doesn't know.
 */
async function getPools() {
  if (_pools && Date.now() - _pools.ts < POOL_LIST_TTL_MS) return _pools.pools;
  if (_poolsInFlight) return _poolsInFlight;
  _poolsInFlight = (async () => {
    const res = await rpcLib.simulateContractCall(PHOENIX_FACTORY, "query_all_pools_details");
    const list = res ? scValToNative(res) : null;
    if (!Array.isArray(list)) throw new Error("Phoenix: factory's pool list isn't a list");
    const pools = list.map((p) => {
      const r = p && p.pool_response;
      if (!r || !r.asset_a || !r.asset_b || !r.asset_lp_share || !p.pool_address) {
        throw new Error("Phoenix: pool details in an unknown shape");
      }
      return {
        pool: p.pool_address,
        tokenA: r.asset_a.address,
        tokenB: r.asset_b.address,
        reserveA: _bigint(r.asset_a.amount, "reserve"),
        reserveB: _bigint(r.asset_b.amount, "reserve"),
        shareToken: r.asset_lp_share.address,
        totalShares: _bigint(r.asset_lp_share.amount, "total shares"),
        // One pool on mainnet (an XLM/USDC pool, CBENABXP…) reports itself
        // as its stake contract: it has none.
        stake: r.stake_address && r.stake_address !== p.pool_address ? r.stake_address : null,
      };
    });
    _pools = { ts: Date.now(), pools };
    return pools;
  })();
  try {
    return await _poolsInFlight;
  } finally {
    _poolsInFlight = null;
  }
}

function _key(contractId, keyScVal) {
  return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Address(contractId).toScAddress(),
    key: keyScVal,
    durability: xdr.ContractDataDurability.persistent,
  }));
}

function shareBalanceKey(shareToken, user) {
  return _key(shareToken, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(user).toScVal()]));
}

function stakeKey(stake, user) {
  return _key(stake, new Address(user).toScVal());
}

function _decodeShares(entry) {
  if (!entry) return 0n;
  return _bigint(scValToNative(rpcLib.contractDataScVal(entry)), "share balance entry");
}

function _decodeStaked(entry) {
  if (!entry) return 0n;
  const info = scValToNative(rpcLib.contractDataScVal(entry));
  if (!info || !Array.isArray(info.stakes)) throw new Error("Phoenix: unexpected stake entry");
  return info.stakes.reduce((sum, s) => sum + _bigint(s && s.stake, "stake"), 0n);
}

/** A token's symbol and decimals, read once. Throws if decimals can't be read: never guessed. */
async function _token(contractId) {
  if (contractId === XLM_SAC) return { symbol: "XLM", decimals: 7 };
  if (_tokenCache.has(contractId)) return _tokenCache.get(contractId);
  const [sym, dec] = await Promise.all([
    rpcLib.simulateContractCall(contractId, "symbol"),
    rpcLib.simulateContractCall(contractId, "decimals"),
  ]);
  const decimals = Number(scValToNative(dec));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Phoenix: implausible decimals for ${contractId}: ${decimals}`);
  }
  const symbol = String(scValToNative(sym)).replace(/\0+$/, "");
  const t = { symbol: symbol.toLowerCase() === "native" ? "XLM" : symbol, decimals };
  _tokenCache.set(contractId, t);
  return t;
}

async function _priceUSD(contractId, token, priceCtx) {
  const usd = await lpPrice.lpTokenUSD(contractId, { symbol: token.symbol, decimals: token.decimals, xlmPrice: priceCtx?.xlmPrice });
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** PHO (or other rewards) the wallet can withdraw from a stake contract. Throws if it can't be read. */
async function readStakeRewards(stake, user, priceCtx) {
  const res = await rpcLib.simulateContractCall(stake, "query_withdrawable_rewards", [new Address(user).toScVal()]);
  const rewards = (res ? scValToNative(res) : null)?.rewards;
  if (!Array.isArray(rewards)) throw new Error("Phoenix: unexpected rewards answer");
  const out = [];
  for (const r of rewards) {
    const raw = _bigint(r && r.reward_amount, "reward amount");
    if (raw <= 0n) continue;
    const token = await _token(r.reward_address);
    const amount = _toUnits(raw, token.decimals);
    const price = await _priceUSD(r.reward_address, token, priceCtx);
    out.push({ asset: token.symbol, contractId: r.reward_address, amount, valueUSD: price == null ? null : amount * price, source: "stake" });
  }
  return out;
}

async function _buildPosition(pool, held, staked, priceCtx) {
  const shares = held + staked;
  const [a, b] = await Promise.all([_token(pool.tokenA), _token(pool.tokenB)]);
  // What withdrawing the shares pays out (the pool's own query_share maths).
  const rawA = pool.totalShares > 0n ? (pool.reserveA * shares) / pool.totalShares : 0n;
  const rawB = pool.totalShares > 0n ? (pool.reserveB * shares) / pool.totalShares : 0n;
  const amountA = _toUnits(rawA, a.decimals);
  const amountB = _toUnits(rawB, b.decimals);
  const [priceA, priceB] = await Promise.all([
    _priceUSD(pool.tokenA, a, priceCtx),
    _priceUSD(pool.tokenB, b, priceCtx),
  ]);
  const unpricedTokens = [];
  if (priceA == null && rawA > 0n) unpricedTokens.push(a.symbol);
  if (priceB == null && rawB > 0n) unpricedTokens.push(b.symbol);

  const position = {
    protocol: "phoenix",
    type: "lp",
    subtype: "constant_product",
    poolContractId: pool.pool,
    shareToken: pool.shareToken,
    tokens: [
      { symbol: a.symbol, contractId: pool.tokenA, decimals: a.decimals },
      { symbol: b.symbol, contractId: pool.tokenB, decimals: b.decimals },
    ],
    token0: { symbol: a.symbol },
    token1: { symbol: b.symbol },
    amounts: { token0: _fmt(amountA), token1: _fmt(amountB) },
    // Pool shares, raw (the share token's own units): in the wallet and bonded.
    lpShares: { held: held.toString(), staked: staked.toString() },
    apy7d: null,
    valueUSD: amountA * (priceA || 0) + amountB * (priceB || 0),
  };
  if (unpricedTokens.length) {
    position.unpriced = true;
    position.unpricedTokens = unpricedTokens;
  }
  return position;
}

async function _attachRewards(positions, stakeByPool, user, priceCtx) {
  const todo = positions.filter((p) => BigInt(p.lpShares.staked) > 0n);
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const pos = todo[next++];
      try {
        pos.unclaimedRewards = await readStakeRewards(stakeByPool.get(pos.poolContractId), user, priceCtx);
      } catch (e) {
        pos.unclaimedRewards = null;
        const kind = rpcLib.isTransientRpcError(e) ? "RPC busy" : "error";
        console.warn(`[phoenix] rewards ${pos.poolContractId.slice(0, 8)}: ${kind}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REWARD_CONCURRENCY, todo.length) }, worker));
}

/**
 * The wallet's Phoenix positions: one per pool it has shares in, held or
 * bonded. [] when it has none. Throws if the pools, the wallet's entries,
 * or a token's decimals can't be read.
 */
async function getPositions(userAddress, priceCtx = {}) {
  const pools = await getPools();
  const keys = [];
  const slots = pools.map((p) => {
    const slot = { balance: shareBalanceKey(p.shareToken, userAddress), stake: p.stake ? stakeKey(p.stake, userAddress) : null };
    keys.push(slot.balance);
    if (slot.stake) keys.push(slot.stake);
    return slot;
  });
  const entries = await rpcLib.getLedgerEntries(keys);
  const entryFor = (k) => (k ? entries.get(k.toXDR("base64")) : undefined);

  const found = [];
  pools.forEach((p, i) => {
    const held = _decodeShares(entryFor(slots[i].balance));
    const staked = _decodeStaked(entryFor(slots[i].stake));
    if (held > 0n || staked > 0n) found.push({ pool: p, held, staked });
  });
  if (!found.length) return [];

  const positions = await Promise.all(found.map((f) => _buildPosition(f.pool, f.held, f.staked, priceCtx)));
  const stakeByPool = new Map(found.map((f) => [f.pool.pool, f.pool.stake]));
  await _attachRewards(positions, stakeByPool, userAddress, priceCtx);
  return positions;
}

function _resetForTests() {
  _pools = null;
  _poolsInFlight = null;
  _tokenCache.clear();
}

module.exports = {
  name: "Phoenix",
  protocolId: "phoenix",
  type: "amm",
  isConfigured: () => true,
  getPositions,
  getPools,
  readStakeRewards,
  shareBalanceKey,
  stakeKey,
  PHOENIX_FACTORY,
  _resetForTests,
};
