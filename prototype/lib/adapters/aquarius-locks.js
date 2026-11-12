/**
 * AQUA locked for ICE (Aquarius).
 *
 * To get ICE, Aquarius's voting token, a wallet locks AQUA: it puts the AQUA
 * in a claimable balance that only it can claim, and only once the unlock
 * date has passed (the predicate is not(abs_before: unlock date)). The AQUA
 * stays there until the wallet claims it, after the unlock too. It's in no
 * trustline in the meantime, so the wallet's AQUA balance doesn't include it,
 * and neither did the wallet's value.
 *
 * This adapter reads the wallet's AQUA claimable balances from Horizon and
 * counts the wallet's own locks: balances it created (it is the sponsor) with
 * itself as the only claimant, claimable after a date or at any time. AQUA
 * that someone else sent it is left out: that's an airdrop or a payment, not
 * the wallet's own AQUA, and anyone can send one.
 *
 * All of a wallet's locks are one position, valued at the price the wallet's
 * own AQUA gets. ICE has no price on the site, so nothing is counted twice.
 */
const StellarSdk = require("@stellar/stellar-sdk");
// Called as pricing.priceClassicAsset (not destructured) so tests can stub it.
const pricing = require("../pricing-engine");
const { createSdexPricer } = require("../sdex-price");
const { getXLMPrice } = require("../xlm-price");
const { untilAborted } = require("../until-aborted");

const HORIZON = process.env.HORIZON_URL || "https://horizon.stellar.org";
const AQUA_CODE = "AQUA";
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const PAGE_SIZE = 200;
// 5,000 locks. The most seen on one wallet is in the dozens; past this, no
// position rather than a partial one.
const MAX_PAGES = 25;
const FETCH_TIMEOUT_MS = 8_000;

const STROOPS = 10_000_000n;

/** "850001000.0000000" → 8500010000000000n */
function toStroops(amount) {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(String(amount));
  if (!m) throw new Error(`unexpected amount ${amount}`);
  return BigInt(m[1]) * STROOPS + BigInt((m[2] || "").padEnd(7, "0"));
}

/** 8500010000000000n → "850001000.0000000" */
function fromStroops(n) {
  return `${n / STROOPS}.${String(n % STROOPS).padStart(7, "0")}`;
}

/**
 * When the claimant may claim: { at: ms } after a date, { at: 0 } at any time,
 * or null for a predicate that isn't a lock (a deadline, a relative time, and/or).
 */
function unlockOf(predicate) {
  if (!predicate || typeof predicate !== "object") return null;
  if (predicate.unconditional === true) return { at: 0 };
  const inner = predicate.not;
  if (Object.keys(predicate).length !== 1 || !inner || inner.abs_before == null) return null;
  const epoch = Number(inner.abs_before_epoch);
  const at = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.parse(inner.abs_before);
  return Number.isFinite(at) ? { at } : null;
}

/** The wallet's own lock, or null: it created the balance and is its only claimant. */
function ownLock(record, wallet) {
  const claimants = record?.claimants;
  if (record?.sponsor !== wallet || !Array.isArray(claimants) || claimants.length !== 1) return null;
  if (claimants[0].destination !== wallet) return null;
  const unlock = unlockOf(claimants[0].predicate);
  if (!unlock) return null;
  return { id: record.id, stroops: toStroops(record.amount), unlockAt: unlock.at };
}

async function _fetchJson(url) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
  return untilAborted(res.json(), signal);
}

/** Every AQUA claimable balance the wallet can claim, all pages. */
async function _aquaClaimables(wallet) {
  const records = [];
  let url = `${HORIZON}/claimable_balances?claimant=${wallet}` +
    `&asset=${AQUA_CODE}:${AQUA_ISSUER}&order=asc&limit=${PAGE_SIZE}`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await _fetchJson(url);
    const batch = body?._embedded?.records;
    if (!Array.isArray(batch)) throw new Error("Horizon: no records");
    records.push(...batch);
    if (batch.length < PAGE_SIZE) return records;
    url = body?._links?.next?.href;
    if (!url) return records;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} AQUA claimable balances`);
}

// The SDEX layer the wallet's own AQUA row uses (server.js builds the same
// one), so locked AQUA gets the same price as the AQUA in the trustline.
let _priceViaSDEX = null;
function _sdex() {
  if (!_priceViaSDEX) {
    _priceViaSDEX = createSdexPricer({ horizon: new StellarSdk.Horizon.Server(HORIZON), getXLMPrice });
  }
  return _priceViaSDEX;
}

async function _aquaUSD() {
  try {
    const p = await pricing.priceClassicAsset({ priceViaSDEX: _sdex() }, AQUA_CODE, AQUA_ISSUER);
    return p && Number.isFinite(p.usd) && p.usd > 0 ? p.usd : null;
  } catch (e) {
    return null;
  }
}

const AquariusLocksAdapter = {
  protocolId: "aquarius-locks",
  name: "Aquarius locks",
  type: "staking",

  // Horizon only: nothing to configure.
  isConfigured() {
    return true;
  },

  async getPositions(wallet) {
    const locks = (await _aquaClaimables(wallet)).map((r) => ownLock(r, wallet)).filter(Boolean);
    if (locks.length === 0) return [];

    const now = Date.now();
    let total = 0n;
    let unlocked = 0n;
    let nextUnlock = null;
    for (const l of locks) {
      total += l.stroops;
      if (l.unlockAt <= now) unlocked += l.stroops;
      else if (nextUnlock === null || l.unlockAt < nextUnlock) nextUnlock = l.unlockAt;
    }
    if (total === 0n) return [];

    const usd = await _aquaUSD();
    const position = {
      protocol: "aquarius",
      type: "locked",
      subtype: "ice_lock",
      poolName: "AQUA locked for ICE",
      staked: { amount: fromStroops(total), asset: AQUA_CODE },
      unlocked: fromStroops(unlocked),
      nextUnlock: nextUnlock === null ? null : new Date(nextUnlock).toISOString(),
      lockCount: locks.length,
      valueUSD: usd == null ? 0 : (Number(total) / 1e7) * usd,
    };
    if (usd == null) position.unpriced = true;
    return [position];
  },
};

module.exports = AquariusLocksAdapter;
module.exports._internals = { unlockOf, ownLock, toStroops, fromStroops, AQUA_ISSUER };
