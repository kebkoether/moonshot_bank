/**
 * Stellar AMM (classic) liquidity pool positions.
 *
 * Stellar's built-in AMM pools (protocol 18, no contract) hand out pool
 * shares as a trustline of their own (asset_type "liquidity_pool_shares").
 * The wallet routes listed those trustlines with valueUSD 0 ("will be
 * enriched", never done), so a wallet's share of a pool counted for nothing:
 * not in its total, not on its DeFi tab, not in All Wallets or snapshots.
 * On 2026-11-24 the classic XLM/USDC pool held 12.3M XLM and 1.54M USDC
 * (about $3.2M); one wallet held 93.6% of its shares.
 *
 * A pool share is a claim on the pool's reserves pro rata: withdrawing
 * `shares` gives reserve × shares / total_shares of each asset, with no fee.
 * So the position is those two amounts, each priced like the same asset held
 * in the wallet (the pricing engine, with the SDEX layer). A side with no
 * price isn't in the value, and the position says so.
 *
 * Horizon requests per wallet: one (/liquidity_pools?account=), plus the
 * account's own entry when it has pool shares.
 */
const { Asset, Networks } = require("@stellar/stellar-sdk");
const StellarSdk = require("@stellar/stellar-sdk");
// Called as pricing.priceClassicAsset (not destructured) so tests can stub it.
const pricing = require("../pricing-engine");
const { createSdexPricer } = require("../sdex-price");
const { getXLMPrice } = require("../xlm-price");
const { untilAborted } = require("../until-aborted");

const HORIZON = "https://horizon.stellar.org";
const REQUEST_TIMEOUT_MS = 7_000; // inside the server's 8-second adapter budget
const PAGE = 200;
const MAX_PAGES = 5;
const STROOPS = 10_000_000n;

let _priceViaSDEX = null;
function _sdex() {
  if (!_priceViaSDEX) {
    _priceViaSDEX = createSdexPricer({ horizon: new StellarSdk.Horizon.Server(HORIZON), getXLMPrice });
  }
  return _priceViaSDEX;
}

async function _getJson(url) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
  return untilAborted(res.json(), signal);
}

/** "123.4567890" → 1234567890n (stroops). */
function toStroops(s) {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`not an amount: ${s}`);
  return BigInt(m[1]) * STROOPS + BigInt((m[2] || "").padEnd(7, "0"));
}

/** 1234567890n → "123.4567890". */
function fromStroops(n) {
  const whole = n / STROOPS;
  const frac = String(n % STROOPS).padStart(7, "0");
  return `${whole}.${frac}`;
}

/** A pool reserve's asset: { symbol, code, issuer, contractId } (contractId: its Stellar Asset Contract). */
function _asset(name) {
  const asset = name === "native" ? Asset.native() : new Asset(...name.split(":"));
  return {
    symbol: asset.isNative() ? "XLM" : asset.getCode(),
    code: asset.isNative() ? "XLM" : asset.getCode(),
    issuer: asset.isNative() ? null : asset.getIssuer(),
    contractId: asset.contractId(Networks.PUBLIC),
  };
}

/** The pools `address` holds a share trustline in, every page. */
async function _poolsOf(address) {
  const pools = [];
  let url = `${HORIZON}/liquidity_pools?account=${address}&limit=${PAGE}`;
  for (let i = 0; i < MAX_PAGES && url; i++) {
    const page = await _getJson(url);
    const records = page?._embedded?.records || [];
    pools.push(...records);
    url = records.length === PAGE ? page?._links?.next?.href : null;
  }
  return pools;
}

/**
 * The position `shares` (a decimal string) give in `pool` (a Horizon
 * liquidity pool record), priced. Null for no shares.
 */
async function positionFor(pool, shares, priceCtx = {}) {
  const userShares = toStroops(shares);
  const totalShares = toStroops(pool.total_shares);
  if (userShares === 0n || totalShares === 0n) return null;
  const legs = pool.reserves.map((r) => {
    const amount = (toStroops(r.amount) * userShares) / totalShares; // what withdrawing them gives
    return { ..._asset(r.asset), amount };
  });

  const xlm = priceCtx.xlmPrice || (await getXLMPrice());
  const prices = await Promise.all(legs.map((l) => (l.issuer
    ? pricing.priceClassicAsset({ priceViaSDEX: _sdex() }, l.code, l.issuer)
    : Promise.resolve(xlm))));
  let valueUSD = 0;
  const unpricedTokens = [];
  legs.forEach((l, i) => {
    const usd = prices[i] && prices[i].usd;
    if (usd > 0) valueUSD += (Number(l.amount) / 1e7) * usd;
    else unpricedTokens.push(l.symbol);
  });

  const [a, b] = legs;
  const token = ({ symbol, code, issuer, contractId }) => ({ symbol, code, issuer, contractId });
  const pos = {
    protocol: "stellar-amm",
    type: "lp",
    subtype: "constant_product",
    poolId: pool.id,
    poolName: `Stellar AMM ${a.symbol}/${b.symbol}`,
    token0: token(a),
    token1: token(b),
    tokens: legs.map(token),
    amounts: { token0: fromStroops(a.amount), token1: fromStroops(b.amount) },
    feeTier: Number(pool.fee_bp) * 100, // in millionths, like SushiSwap's (30 bp → 3000 → "0.3%")
    shares: fromStroops(userShares),
    totalShares: fromStroops(totalShares),
    poolShare: Number(userShares) / Number(totalShares),
    apy7d: null,
    valueUSD,
  };
  if (unpricedTokens.length > 0) {
    pos.unpriced = true;
    pos.unpricedTokens = unpricedTokens;
  }
  return pos;
}

const ClassicPoolsAdapter = {
  protocolId: "stellar-amm",
  name: "Stellar AMM",
  type: "amm",

  isConfigured() {
    return true;
  },

  async getPositions(address, priceCtx) {
    const pools = await _poolsOf(address);
    if (pools.length === 0) return [];
    const account = await _getJson(`${HORIZON}/accounts/${address}`);
    if (!account) return [];
    const sharesOf = new Map((account.balances || [])
      .filter((b) => b.asset_type === "liquidity_pool_shares")
      .map((b) => [b.liquidity_pool_id, b.balance]));
    const positions = await Promise.all(pools
      .filter((p) => sharesOf.has(p.id))
      .map((p) => positionFor(p, sharesOf.get(p.id), priceCtx)));
    return positions.filter(Boolean);
  },
};

module.exports = ClassicPoolsAdapter;
module.exports.positionFor = positionFor;
module.exports.toStroops = toStroops;
module.exports.fromStroops = fromStroops;
