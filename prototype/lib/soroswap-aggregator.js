/**
 * AMM price layer: values a Soroban token from the deepest Aquarius or
 * Soroswap pool that pairs it with USDC or XLM.
 *
 * This used to ask the Soroswap Aggregator contract (CAYP3UWL…TXTO) for a
 * quote, trying the method names get_best_path, swap_quote, get_quote and
 * quote. The aggregator has none of them (it only executes swaps; routes are
 * found off-chain), so every call failed with Error(WasmVm, MissingValue):
 * the layer never priced anything, not even XLM, and cost four failing RPC
 * simulations per token that reached it.
 *
 * Now it reads the pools directly:
 *   - Aquarius: router.get_pools([token, quote]) → pools; pool.get_tokens(),
 *     pool.get_reserves(), pool.estimate_swap(in_idx, out_idx, amount).
 *   - Soroswap: factory.get_pair(token, quote) → pair; pair.token_0(),
 *     pair.get_reserves(), router.router_get_amounts_out(amount, path).
 * Quote tokens are USDC (taken as $1, as everywhere else in the app) and XLM
 * (lib/xlm-price.js).
 *
 * Depth gate: only a pool whose USDC or XLM side holds at least
 * AMM_MIN_DEPTH_USD (default $10,000) is used. Thin pools are where AMM
 * prices go wrong: on mainnet in October 2026 the Soroswap pools quoted EURx
 * at $0.0001, USDGLO at $0.0001 and oUSD at $0.09, each with a few dollars on
 * the USDC side. Of the pools that pass, the deepest one sets the price.
 *
 * Price: the geometric mean of a small sell quote and the matching buy quote,
 * which cancels the pool's fee on both sides. The probe is one whole token or
 * 0.1% of the pool's token reserve, whichever is smaller, so price impact is
 * negligible in any pool that passes the depth gate.
 *
 * Which pools exist for a token rarely changes, so that is looked up once an
 * hour (an empty answer included: most tokens have no pool at all, and they
 * then cost no RPC calls until the next lookup). Reserves and quotes are read
 * fresh each time; the pricing engine caches the resulting price.
 *
 * Not covered yet: Phoenix pools, and routes through a third token.
 */

const StellarSdk = require("@stellar/stellar-sdk");
const { Address, nativeToScVal, scValToNative, xdr } = StellarSdk;
const rpc = require("./soroban-rpc");
const xlmPrice = require("./xlm-price");

// USDC SAC on Stellar mainnet: the dollar-denominated quote token.
const USDC_SAC_CONTRACT =
  process.env.USDC_SAC_CONTRACT ||
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

// XLM SAC: the other quote token (many pools pair against XLM only).
const XLM_SAC_CONTRACT =
  process.env.XLM_SAC_CONTRACT ||
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

const AQUARIUS_ROUTER =
  process.env.AQUA_ROUTER_CONTRACT_ID ||
  "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";

const SOROSWAP_FACTORY =
  process.env.SOROSWAP_FACTORY_CONTRACT_ID ||
  "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2";

const SOROSWAP_ROUTER =
  process.env.SOROSWAP_ROUTER_CONTRACT_ID ||
  "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";

const MIN_DEPTH_USD = parseFloat(process.env.AMM_MIN_DEPTH_USD || "10000");
const POOL_DISCOVERY_TTL_MS = 60 * 60 * 1000;
const QUOTE_DECIMALS = 7; // USDC and XLM

// token contract → { ts, candidates: [{ dex, pool, quote, tokens }] }
const _discovery = new Map();

async function _view(contractId, method, args = []) {
  const r = await rpc.simulateContractCall(contractId, method, args);
  return r == null ? null : scValToNative(r);
}

const _addr = (c) => new Address(c).toScVal();
const _u32 = (n) => nativeToScVal(n, { type: "u32" });
const _isContractError = (e) => /HostError/.test(String(e && e.message));

/** Soroban's ordering of addresses (Aquarius keys its pools by the sorted pair). */
function _sortAddresses(list) {
  return list.slice().sort((a, b) =>
    Buffer.compare(new Address(a).toScAddress().toXDR(), new Address(b).toScAddress().toXDR())
  );
}

async function _aquariusPools(token, quote) {
  const pair = _sortAddresses([token, quote]);
  const pools = await _view(AQUARIUS_ROUTER, "get_pools", [xdr.ScVal.scvVec(pair.map(_addr))]);
  const addresses = pools instanceof Map ? [...pools.values()] : Object.values(pools || {});
  return Promise.all(addresses.map(async (pool) => ({
    dex: "aquarius", pool, quote, tokens: await _view(pool, "get_tokens"),
  })));
}

async function _soroswapPair(token, quote) {
  let pair;
  try {
    pair = await _view(SOROSWAP_FACTORY, "get_pair", [_addr(token), _addr(quote)]);
  } catch (e) {
    if (_isContractError(e)) return []; // no such pair
    throw e;
  }
  if (!pair) return [];
  const token0 = await _view(pair, "token_0");
  return [{ dex: "soroswap", pool: pair, quote, tokens: token0 === token ? [token, quote] : [quote, token] }];
}

/** Every pool pairing `token` with USDC or XLM. Cached for an hour. */
async function _candidatePools(token) {
  const hit = _discovery.get(token);
  if (hit && Date.now() - hit.ts < POOL_DISCOVERY_TTL_MS) return hit.candidates;

  const lookups = [];
  for (const quote of [USDC_SAC_CONTRACT, XLM_SAC_CONTRACT]) {
    if (quote === token) continue;
    lookups.push(_aquariusPools(token, quote), _soroswapPair(token, quote));
  }
  const results = await Promise.allSettled(lookups);
  const candidates = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  // Only remember the answer if every lookup actually answered: an RPC
  // failure must not hide a token's pools for an hour.
  if (results.every((r) => r.status === "fulfilled")) {
    _discovery.set(token, { ts: Date.now(), candidates });
  }
  return candidates;
}

async function _reserves(c) {
  const raw = await _view(c.pool, "get_reserves");
  const iToken = c.tokens.indexOf(c.quote) === 0 ? 1 : 0;
  return { token: BigInt(raw[iToken]), quote: BigInt(raw[1 - iToken]), iToken };
}

/** Raw amount of `tokenOut` for `amountIn` of `tokenIn` through this pool. */
async function _quote(c, iToken, sellToken, amountIn) {
  if (c.dex === "aquarius") {
    const [iIn, iOut] = sellToken ? [iToken, 1 - iToken] : [1 - iToken, iToken];
    return BigInt(await _view(c.pool, "estimate_swap", [
      _u32(iIn), _u32(iOut), nativeToScVal(amountIn, { type: "u128" }),
    ]));
  }
  const token = c.tokens[iToken];
  const path = sellToken ? [token, c.quote] : [c.quote, token];
  const amounts = await _view(SOROSWAP_ROUTER, "router_get_amounts_out", [
    nativeToScVal(amountIn, { type: "i128" }), xdr.ScVal.scvVec(path.map(_addr)),
  ]);
  return BigInt(amounts[amounts.length - 1]);
}

async function _quoteUSD(quote) {
  if (quote === USDC_SAC_CONTRACT) return 1;
  const p = await xlmPrice.getXLMPrice();
  return p && p.usd > 0 ? p.usd : null;
}

/**
 * USD price of a Soroban token from its deepest Aquarius/Soroswap pool.
 *
 * Returns { usd, change24h: 0, source: "aquarius"|"soroswap", confidence:
 * "high", depthUSD, pool } or null (no pool deep enough, or the RPC failed).
 *
 * @param {string} contractId C-strkey of the token
 * @param {number} decimals the token's decimals
 */
async function priceSorobanTokenInUSD(contractId, decimals = 7) {
  if (!contractId) return null;
  if (contractId === USDC_SAC_CONTRACT) {
    return { usd: 1, change24h: 0, source: "usdc", confidence: "high" };
  }
  try {
    const candidates = await _candidatePools(contractId);
    if (candidates.length === 0) return null;

    const quoteUSD = new Map();
    for (const q of new Set(candidates.map((c) => c.quote))) quoteUSD.set(q, await _quoteUSD(q));

    const measured = await Promise.all(candidates.map(async (c) => {
      try {
        const r = await _reserves(c);
        const usd = quoteUSD.get(c.quote);
        const depthUSD = usd == null ? 0 : (Number(r.quote) / 10 ** QUOTE_DECIMALS) * usd;
        return { c, r, depthUSD };
      } catch (_) {
        return null;
      }
    }));
    const deep = measured.filter((m) => m && m.depthUSD >= MIN_DEPTH_USD && m.r.token > 0n);
    if (deep.length === 0) return null;
    const { c, r, depthUSD } = deep.sort((a, b) => b.depthUSD - a.depthUSD)[0];

    const oneToken = 10n ** BigInt(decimals);
    const probe = r.token / 1000n < oneToken ? r.token / 1000n : oneToken;
    if (probe <= 0n) return null;
    const quoteOut = await _quote(c, r.iToken, true, probe); // sell the token
    if (quoteOut <= 0n) return null;
    const tokenBack = await _quote(c, r.iToken, false, quoteOut); // buy it back
    if (tokenBack <= 0n) return null;

    const tokens = (n) => Number(n) / 10 ** decimals;
    const quotes = (n) => Number(n) / 10 ** QUOTE_DECIMALS;
    const bid = quotes(quoteOut) / tokens(probe); // quote units per token, selling
    const ask = quotes(quoteOut) / tokens(tokenBack); // quote units per token, buying
    const usd = Math.sqrt(bid * ask) * quoteUSD.get(c.quote);
    if (!Number.isFinite(usd) || usd <= 0) return null;

    return { usd, change24h: 0, source: c.dex, confidence: "high", depthUSD, pool: c.pool };
  } catch (e) {
    return null;
  }
}

/**
 * For classic Stellar assets: price the asset's Stellar Asset Contract.
 * (Pools on Aquarius and Soroswap hold the SAC.)
 */
async function priceClassicAssetViaSACInUSD(code, issuer) {
  try {
    const asset = new StellarSdk.Asset(code, issuer);
    return await priceSorobanTokenInUSD(asset.contractId(StellarSdk.Networks.PUBLIC), 7);
  } catch (e) {
    return null;
  }
}

function _resetForTests() {
  _discovery.clear();
}

module.exports = {
  priceSorobanTokenInUSD,
  priceClassicAssetViaSACInUSD,
  USDC_SAC_CONTRACT,
  XLM_SAC_CONTRACT,
  MIN_DEPTH_USD,
  _resetForTests,
};
