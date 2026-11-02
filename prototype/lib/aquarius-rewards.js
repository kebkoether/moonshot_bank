/**
 * Unclaimed rewards on Aquarius LP positions.
 *
 * An Aquarius pool pays its liquidity providers AQUA, and some pools also
 * have "gauges" that pay an extra token (XLM, PYUSD, ...). Both pile up in the
 * pool until the wallet claims them, and neither shows in the LP's deposited
 * amounts. The portfolio showed neither: one wallet had 6.6M AQUA waiting in
 * its PYUSD/USDC pool, another 218k XLM in an XLM/SolvBTC gauge.
 *
 * Each pool answers for one user with two read-only calls:
 *   get_user_reward(user)        -> AQUA owed, in stroops (what claim() pays)
 *   gauges_get_reward_info(user) -> { <token contract>: { user_reward, ... } }
 *
 * Rewards are shown next to the position. They are not added to its value or
 * the portfolio total: they are not the wallet's until claimed (the same rule
 * as Blend's pending BLND).
 */
const { simulateContractCall, isTransientRpcError } = require("./soroban-rpc");
const pricingEngine = require("./pricing-engine");
const { Address, scValToNative } = require("@stellar/stellar-sdk");

// AQUA's Stellar Asset Contract (AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA).
const AQUA_SAC = "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const POOL_CONCURRENCY = 5;

// A pool built before rewards (or gauges) existed has no such function: the
// host reports MissingValue. That pool has nothing to claim of that kind.
const isMissingFunction = (e) => /MissingValue/.test(String(e?.message || ""));

/** Raw integer amount -> number, via its decimal string (exact to the last digit a double holds). */
function _toUnits(raw, decimals) {
  const s = BigInt(raw ?? 0).toString().padStart(decimals + 1, "0");
  return Number(decimals > 0 ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s);
}

// A gauge's reward token: symbol and decimals, read once. Throws if either
// can't be read, so a wrong decimals guess never scales an amount.
const _tokenCache = new Map();
async function _token(contractId) {
  if (contractId === XLM_SAC) return { symbol: "XLM", decimals: 7 };
  if (contractId === AQUA_SAC) return { symbol: "AQUA", decimals: 7 };
  if (_tokenCache.has(contractId)) return _tokenCache.get(contractId);
  const [sym, dec] = await Promise.all([
    simulateContractCall(contractId, "symbol"),
    simulateContractCall(contractId, "decimals"),
  ]);
  const symbol = String(scValToNative(sym));
  const t = { symbol: symbol.toLowerCase() === "native" ? "XLM" : symbol, decimals: Number(scValToNative(dec)) };
  _tokenCache.set(contractId, t);
  return t;
}

/** USD price of a reward token, or null. XLM uses the request's XLM price. */
async function _priceUSD(contractId, priceCtx) {
  if (contractId === XLM_SAC) return priceCtx?.xlmPrice?.usd || null;
  const p = await pricingEngine.priceSorobanToken(contractId).catch(() => null);
  return p && p.usd > 0 ? p.usd : null;
}

async function _reward(contractId, raw, priceCtx, source) {
  const { symbol, decimals } = await _token(contractId);
  const amount = _toUnits(raw, decimals);
  const price = await _priceUSD(contractId, priceCtx);
  return { asset: symbol, contractId, amount, valueUSD: price == null ? null : amount * price, source };
}

/**
 * What one pool owes a user.
 * @returns {Promise<Array<{asset, contractId, amount, valueUSD, source}>>}
 *   source is "aqua" (the pool's AQUA rewards) or "gauge". Throws if the
 *   pool can't be read.
 */
async function readPoolRewards(poolId, userAddress, priceCtx) {
  const user = new Address(userAddress).toScVal();
  const optional = (p) => p.catch((e) => { if (isMissingFunction(e)) return null; throw e; });
  const [aquaRes, gaugeRes] = await Promise.all([
    optional(simulateContractCall(poolId, "get_user_reward", [user])),
    optional(simulateContractCall(poolId, "gauges_get_reward_info", [user])),
  ]);

  const out = [];
  const aquaRaw = aquaRes ? BigInt(scValToNative(aquaRes)) : 0n;
  if (aquaRaw > 0n) out.push(await _reward(AQUA_SAC, aquaRaw, priceCtx, "aqua"));

  const gauges = gaugeRes ? scValToNative(gaugeRes) || {} : {};
  for (const [token, info] of Object.entries(gauges)) {
    const raw = BigInt(info?.user_reward ?? 0);
    if (raw > 0n) out.push(await _reward(token, raw, priceCtx, "gauge"));
  }
  return out;
}

/**
 * Adds unclaimedRewards to each Aquarius position (a few pools at a time).
 * A pool that can't be read gets null ("couldn't read this time"); it never
 * fails the positions themselves.
 */
async function attachAquariusRewards(positions, userAddress, priceCtx) {
  const pools = positions.filter((p) => p && p.protocol === "aquarius" && p.poolContractId);
  let next = 0;
  async function worker() {
    while (next < pools.length) {
      const pos = pools[next++];
      try {
        pos.unclaimedRewards = await readPoolRewards(pos.poolContractId, userAddress, priceCtx);
      } catch (e) {
        pos.unclaimedRewards = null;
        const kind = isTransientRpcError(e) ? "RPC busy" : "error";
        console.warn(`[aquarius-rewards] ${pos.poolContractId.slice(0, 8)}: ${kind}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL_CONCURRENCY, pools.length) }, worker));
  return positions;
}

function _resetForTests() { _tokenCache.clear(); }

module.exports = { attachAquariusRewards, readPoolRewards, AQUA_SAC, XLM_SAC, _resetForTests };
