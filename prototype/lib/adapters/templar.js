/**
 * Templar Finance positions, read from Templar's own API.
 *
 * Templar's lending runs on NEAR. A Stellar wallet signs in to Templar's app
 * with a SEP-53 signed message, and its supplies and loans are held by a NEAR
 * "universal account" whose name is derived from the wallet's address:
 *
 *   hex(sha256("G…"))[0..12] + ".user0.tmplr.near"
 *
 * (Templar's relayer, `public_key_to_account_id_slug`: the first 6 bytes of
 * the SHA-256 of the key's display form, under the `user0.tmplr.near`
 * registry.) Templar's public API answers, for that account, every supply and
 * borrow position in every market, retired ones included:
 *
 *   GET https://api.templarfi.org/v1/accounts/{account}/positions
 *
 * with each loan's collateral and its debt (principal, fees and interest to
 * date), and each supply's deposit, pending deposits and yield.
 *
 * This replaces netting the wallet's Stellar payments to and from Templar's
 * custody addresses, which went wrong three ways:
 *   - Templar's Stellar custody address also carries bridge transfers that are
 *     not Templar positions: wallets with no Templar position showed one (one
 *     at $2.6M), and real loans showed without their collateral.
 *   - SDF's Horizon keeps about a year of history, and its start moves forward
 *     every day. Deposits older than that dropped out of the sum, and a wallet
 *     whose history reached below it failed outright (HTTP 410).
 *   - Payments carry no interest: loans showed without the interest owed and
 *     supplies without the yield earned.
 *
 * Each Templar position becomes one "vault" position:
 *   - a supply: deposited = active deposit + pending deposits + any payout in
 *     transit; yield = interest earned and not yet harvested; value = both.
 *   - a loan: deposited = the collateral (and any collateral in transit);
 *     borrow = the debt (principal + fees + interest), what a full repay needs;
 *     value = collateral − debt.
 * Amounts that would show as 0 at six decimals (a 1-unit leftover) are left
 * out.
 *
 * Prices: a Stellar asset (Templar's id carries its Stellar contract) is priced
 * like everywhere else on the site, XLM at the request's XLM price. An asset
 * the site has no price for (BTC, ZEC, XRP… bridged from other chains) takes
 * the USD value Templar's API gives for that leg (its oracle price).
 *
 * Failures: the API refusing, a market Templar couldn't read for this account
 * (`unavailable`), a token whose decimals aren't listed, or more requests than
 * Templar's rate limit allows just now all throw, so the server serves
 * Templar's last good result or shows Templar as unavailable, never a smaller
 * position.
 */
const { StrKey } = require("@stellar/stellar-sdk");
const crypto = require("crypto");
const pricing = require("../pricing-engine");
const { untilAborted } = require("../until-aborted");

const TEMPLAR_API = "https://api.templarfi.org/v1";
const UA_REGISTRY = "user0.tmplr.near";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

const FETCH_TIMEOUT_MS = 7_000; // inside the server's 8 s adapter budget
const POSITIONS_TTL_MS = 5 * 60_000; // one wallet's positions
const META_TTL_MS = 60 * 60_000; // assets and market names

// Templar's API allows a burst of about 40 requests, then about one a second
// (measured 2026-11-11: at 3 a second the 43rd got 429, then 2 in 3 did), and
// answers 429 with Retry-After: 60. So: at most 4 requests at once, and a
// bucket of 20 refilled at one a second. A read that would wait more than 5 s
// for its turn fails instead (the server then serves Templar's last good
// result), and a 429 empties the bucket.
const MAX_IN_FLIGHT = 4;
let BUCKET_SIZE = 20;
let REFILL_PER_SEC = 1;
let MAX_WAIT_MS = 5_000;

let _inFlight = 0;
const _queue = [];
let _tokens = BUCKET_SIZE;
let _refilledAt = Date.now();
const _positions = new Map(); // account -> { at, data } | { pending }
let _assets = null; // { at, byId: Map }
let _markets = null; // { at, byId: Map }
let _assetsLoad = null;
let _marketsLoad = null;

/** The NEAR account Templar keeps a Stellar wallet's positions under, or null for a non-G address. */
function templarAccount(address) {
  if (!StrKey.isValidEd25519PublicKey(String(address || ""))) return null;
  return crypto.createHash("sha256").update(address).digest("hex").slice(0, 12) + "." + UA_REGISTRY;
}

/**
 * The Stellar contract behind one of Templar's HOT-bridge asset ids, or null.
 * `nep245:v2_1.omni.hot.tg:1100_<base58>`: 1100 is Stellar's chain number and
 * the base58 is an XDR ScVal address (0x12, then 0x01 for a contract) + 32 bytes.
 */
function stellarContractOf(assetId) {
  const m = /^nep245:[^:]+:1100_([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(assetId || ""));
  if (!m) return null;
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of m[1]) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const hex = n.toString(16).padStart(80, "0");
  if (hex.length !== 80 || !hex.startsWith("0000001200000001")) return null;
  return StrKey.encodeContract(Buffer.from(hex.slice(16), "hex"));
}

/** Wait for the rate limit's next turn; throws if that's more than MAX_WAIT_MS away. */
async function _turn() {
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    _tokens = Math.min(BUCKET_SIZE, _tokens + ((now - _refilledAt) / 1000) * REFILL_PER_SEC);
    _refilledAt = now;
    if (_tokens >= 1) { _tokens -= 1; return; }
    const wait = Math.ceil(((1 - _tokens) / REFILL_PER_SEC) * 1000);
    if (now - start + wait > MAX_WAIT_MS) throw new Error("Templar API busy: too many requests for now");
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function _slot() {
  if (_inFlight < MAX_IN_FLIGHT) { _inFlight++; return; }
  await new Promise((resolve) => _queue.push(resolve));
}
function _release() {
  const next = _queue.shift();
  if (next) next(); else _inFlight--;
}

async function _getOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException("Templar API timed out", "TimeoutError")), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      const e = new Error(`Templar API HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    // A body that never settled would hold this wallet's read, which every
    // later load of the wallet waits on, for good.
    return await untilAborted(res.json(), ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** GET a Templar API path within the rate limit; a 429 or 5xx is asked once more. */
async function _get(path) {
  await _turn();
  await _slot();
  try {
    try {
      return await _getOnce(TEMPLAR_API + path);
    } catch (e) {
      if (!(e.status === 429 || e.status >= 500)) throw e;
      if (e.status === 429) _tokens = 0;
      await _turn();
      return await _getOnce(TEMPLAR_API + path);
    }
  } finally {
    _release();
  }
}

/** Templar's assets by id (symbol, decimals). Kept an hour; `fresh` reloads them. */
async function _assetsById(fresh = false) {
  if (!fresh && _assets && Date.now() - _assets.at < META_TTL_MS) return _assets.byId;
  if (!_assetsLoad) {
    _assetsLoad = _get("/assets")
      .then((body) => {
        const list = body?.data;
        if (!Array.isArray(list)) throw new Error("Templar API: unexpected /assets answer");
        _assets = { at: Date.now(), byId: new Map(list.map((a) => [a.assetId, a])) };
        return _assets.byId;
      })
      .finally(() => { _assetsLoad = null; });
  }
  return _assetsLoad;
}

/** Market names ("XLM/USDC") by market id. Only for labels: a failure leaves the id. */
async function _marketNames() {
  if (_markets && Date.now() - _markets.at < META_TTL_MS) return _markets.byId;
  if (!_marketsLoad) {
    _marketsLoad = _get("/markets?status=all&limit=100")
      .then((body) => {
        const list = Array.isArray(body?.data) ? body.data : [];
        _markets = { at: Date.now(), byId: new Map(list.map((m) => [m.marketId, m.name])) };
        return _markets.byId;
      })
      .catch(() => (_markets ? _markets.byId : new Map()))
      .finally(() => { _marketsLoad = null; });
  }
  return _marketsLoad;
}

/** The account's positions, kept a minute; loads of one wallet at the same time share one read. */
async function _accountPositions(account) {
  const hit = _positions.get(account);
  if (hit?.data && Date.now() - hit.at < POSITIONS_TTL_MS) return hit.data;
  if (hit?.pending) return hit.pending;
  const pending = _get(`/accounts/${encodeURIComponent(account)}/positions`)
    .then((body) => {
      const d = body?.data;
      if (!d || !Array.isArray(d.supplyPositions) || !Array.isArray(d.borrowPositions)) {
        throw new Error("Templar API: unexpected positions answer");
      }
      if (Array.isArray(d.unavailable) && d.unavailable.length) {
        const which = d.unavailable.map((u) => `${u.marketId} (${u.side})`).join(", ");
        throw new Error(`Templar couldn't read this account's position in ${which}`);
      }
      _positions.set(account, { at: Date.now(), data: d });
      return d;
    })
    .catch((e) => { _positions.delete(account); throw e; });
  _positions.set(account, { pending });
  while (_positions.size > 2000) _positions.delete(_positions.keys().next().value);
  return pending;
}

/** Raw integer string -> number of tokens. */
function _units(raw, decimals) {
  const s = BigInt(raw || 0).toString().padStart(decimals + 1, "0");
  return Number(decimals > 0 ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s);
}

function _fmt(amount) {
  return amount.toFixed(amount < 1 ? 6 : 2);
}

/**
 * USD per token: the site's price for a Stellar asset, else the one implied by
 * Templar's own USD figure for this leg (usd / amount), else null.
 */
async function _unitPrice(asset, amount, templarUsd, priceCtx) {
  const contract = stellarContractOf(asset.assetId);
  if (contract === XLM_SAC && priceCtx?.xlmPrice?.usd > 0) return priceCtx.xlmPrice.usd;
  if (contract) {
    const p = await pricing.priceSorobanToken(contract, { decimals: asset.decimals }).catch(() => null);
    if (p && p.usd > 0) return p.usd;
  }
  if (amount > 0 && Number.isFinite(templarUsd) && templarUsd > 0) return templarUsd / amount;
  return null;
}

async function _asset(byId, assetId) {
  let a = byId.get(assetId);
  if (!a) a = (await _assetsById(true)).get(assetId); // a token listed since the last load
  const decimals = Number(a?.decimals);
  if (!a || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`Templar API: no decimals for ${assetId}`);
  }
  return { assetId, symbol: String(a.symbol || "?"), decimals };
}

const _tiny = (n) => n < 5e-7; // shows as 0.000000

async function _supplyPosition(p, byId, names, priceCtx) {
  const asset = await _asset(byId, p.assetId);
  const deposited = _units(BigInt(p.balance || 0) + BigInt(p.pendingDepositsTotal || 0) + BigInt(p.outgoing || 0), asset.decimals);
  const earned = _units(p.interestEarned, asset.decimals);
  if (_tiny(deposited) && _tiny(earned)) return null;
  const active = _units(p.balance, asset.decimals);
  const price = await _unitPrice(asset, active, p.balanceUsd, priceCtx)
    ?? await _unitPrice(asset, earned, p.interestEarnedUsd, priceCtx);
  const market = names.get(p.marketId) || p.marketId;
  const pos = {
    protocol: "templar",
    type: "vault",
    subtype: "supply",
    contractId: p.marketId,
    vaultName: `Templar · ${asset.symbol} supplied to ${market}`,
    receiptSymbol: asset.symbol,
    deposited: { amount: _fmt(deposited), asset: asset.symbol },
    yield: { accrued: _fmt(earned), asset: asset.symbol, apy: Number.isFinite(p.apy) ? p.apy * 100 : null },
    valueUSD: price == null ? 0 : (deposited + earned) * price,
  };
  if (price == null) pos.unpriced = true;
  return pos;
}

async function _borrowPosition(p, byId, names, priceCtx) {
  const [coll, bor] = await Promise.all([_asset(byId, p.collateralAssetId), _asset(byId, p.assetId)]);
  const collateral = _units(BigInt(p.collateral || 0) + BigInt(p.collateralInFlight || 0), coll.decimals);
  const debt = _units(p.debt, bor.decimals);
  if (_tiny(collateral) && _tiny(debt)) return null;
  const [pc, pb] = await Promise.all([
    _unitPrice(coll, _units(p.collateral, coll.decimals), p.collateralUsd, priceCtx),
    _unitPrice(bor, debt, p.debtUsd, priceCtx),
  ]);
  const debtUSD = pb == null ? 0 : debt * pb;
  const pos = {
    protocol: "templar",
    type: "vault",
    subtype: "borrow",
    contractId: p.marketId,
    vaultName: `Templar · ${names.get(p.marketId) || `${coll.symbol}/${bor.symbol}`} loan`,
    receiptSymbol: coll.symbol,
    deposited: { amount: _fmt(collateral), asset: coll.symbol },
    borrow: { amount: _fmt(debt), asset: bor.symbol, valueUSD: debtUSD, apy: Number.isFinite(p.apy) ? p.apy * 100 : null },
    yield: { accrued: null, asset: bor.symbol, apy: null },
    valueUSD: (pc == null ? 0 : collateral * pc) - debtUSD,
  };
  if (pc == null || pb == null) pos.unpriced = true;
  return pos;
}

const TemplarAdapter = {
  protocolId: "templar",
  name: "Templar Finance",
  type: "lending",

  isConfigured() {
    return true;
  },

  async getPositions(userAddress, priceCtx) {
    const account = templarAccount(userAddress);
    if (!account) return [];
    // Positions, asset list and market names at the same time; only the
    // first two can fail the read.
    const [data, byId, names] = await Promise.all([_accountPositions(account), _assetsById(), _marketNames()]);
    const built = await Promise.all([
      ...data.supplyPositions.map((p) => _supplyPosition(p, byId, names, priceCtx)),
      ...data.borrowPositions.map((p) => _borrowPosition(p, byId, names, priceCtx)),
    ]);
    const positions = built.filter(Boolean);
    for (const p of positions) p.templarAccount = account;
    return positions;
  },
};

function _resetForTests() {
  _positions.clear();
  _assets = null;
  _markets = null;
  _assetsLoad = null;
  _marketsLoad = null;
  _inFlight = 0;
  _queue.length = 0;
  _tokens = BUCKET_SIZE;
  _refilledAt = Date.now();
}

function _setLimitsForTests({ bucketSize, refillPerSec, maxWaitMs }) {
  BUCKET_SIZE = bucketSize;
  REFILL_PER_SEC = refillPerSec;
  MAX_WAIT_MS = maxWaitMs;
  _tokens = BUCKET_SIZE;
  _refilledAt = Date.now();
}

module.exports = TemplarAdapter;
module.exports.templarAccount = templarAccount;
module.exports.stellarContractOf = stellarContractOf;
module.exports._resetForTests = _resetForTests;
module.exports._setLimitsForTests = _setLimitsForTests;
