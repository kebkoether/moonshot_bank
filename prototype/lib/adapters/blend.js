/**
 * Blend Capital — Stellar lending protocol adapter (V2).
 *
 * Responsibilities:
 *   1. Discover Blend pools (Pool Factory event scan + hardcoded fallback)
 *   2. For each pool: fetch user positions, reserve data, reserve config,
 *      pending BLND emissions
 *   3. Compute supply/borrow APR/APY from on-chain interest rate parameters
 *   4. Resolve token metadata (decimals/symbol) from token universe with
 *      RPC fallback (same self-healing pattern as PR #4 / SolvBTC fix)
 *   5. Group output per pool so the frontend can render a DeBank-style
 *      Supply/Borrow/Debt-Ratio/Value table per pool
 *
 * Key invariants (verified across PRs #18 / #19 / #20 fixes):
 *   - r_base/r_one/r_two/r_three/util/c_factor/l_factor: 7-decimal fixed point
 *   - b_rate / d_rate / ir_mod: live in reserveData.data
 *     - b_rate / d_rate are 12-decimal scale (V2)
 *     - ir_mod is 9-decimal scale (V1 convention, unchanged in V2 per docs)
 *   - Position amounts: in protocol-token (bToken/dToken) units;
 *     convert to underlying via amount * rate / 10^12
 *   - Asset decimals: per-token (XLM/USDC=7, SolvBTC=8) — never assume 7
 */

const {
  simulateContractCall,
  getTokenMetadata,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, nativeToScVal, scValToNative } = StellarSdk;
const tokenUniverse = require("../token-universe");
const { priceSorobanToken } = require("../pricing-engine");
const { walletBlendPools } = require("./blend-wallet-pools");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BLEND_V2_RATE_SCALAR_DECIMALS = 12;
// Blend V2 stores ir_mod as 7-decimal fixed point (like r_base/r_one/etc),
// NOT 9-decimal as V1 did. On-chain evidence (Fixed Pool V2 USDC reserve,
// Aug 2026): raw ir_mod = 15_800_818. Read as 9-dec → 0.0158, which violates
// the whitepaper's ir_mod clamp of [0.1, 100]; read as 7-dec → 1.58, valid,
// and reproduces borrow/supply rates consistent with Blend's own dashboard
// (~11% borrow at 78% utilization vs the ~0.11% the 9-dec reading yields).
// The 1e9 value here previously understated every Blend APY by ~100×.
const BLEND_IR_MOD_SCALAR = 1e7;
const SCALAR_7 = 1e7;

// Blend v2's pool factory: asked whether it deployed a pool found in a
// wallet's history (lib/adapters/blend-wallet-pools.js).
const BLEND_POOL_FACTORY = process.env.BLEND_POOL_FACTORY ||
  "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU";

const KNOWN_POOLS = [
  { contractId: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD", name: "Fixed Pool V2" },
  { contractId: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS", name: "YieldBlox Pool V2" },
  { contractId: "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC", name: "Orbit Pool V2" },
  { contractId: "CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF", name: "Forex Pool V2" },
  { contractId: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI", name: "Etherfuse Pool V2" },
];

// Blend pool status (docs.blend.capital → Lending Pool → Pool Management):
//   0 Admin_Active / 1 Active   — functioning normally
//   2 Admin_On_Ice / 3 On_Ice   — borrowing + auction cancellations disabled
//   4 Admin_Frozen / 5 Frozen   — borrowing AND depositing disabled
//   6 Setup                     — initial state, borrowing + depositing disabled
// Corroborated by the request rules: deposits fail when status > 3, borrows
// fail when status > 1. So "usable for both supply and borrow" is status <= 1,
// and an On Ice pool (2, 3) still takes deposits.
//
// Status is NOT static: a pool flips to On Ice automatically when >=25% of
// backstop deposits are queued for withdrawal, and to Frozen at >=50%. That is
// why this is read live on every refresh rather than kept as a hardcoded list.
const BLEND_POOL_STATUS_LABELS = {
  0: "Active", 1: "Active", 2: "On Ice", 3: "On Ice",
  4: "Frozen", 5: "Frozen", 6: "Setup",
};

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

const config = {
  pools: JSON.parse(process.env.BLEND_POOLS || "[]"),
};

// The built-in pools and BLEND_POOLS. getPositions also reads the pools each
// wallet has used (walletBlendPools).
function getConfiguredPools() {
  const byId = new Map();
  for (const list of [config.pools, KNOWN_POOLS]) {
    for (const p of list || []) {
      if (!p || !p.contractId) continue;
      const existing = byId.get(p.contractId);
      if (!existing || (!existing.name && p.name)) {
        byId.set(p.contractId, p);
      }
    }
  }
  return Array.from(byId.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract call wrappers
// ─────────────────────────────────────────────────────────────────────────────

// These wrappers THROW on RPC/simulation failure — null is reserved for
// "the call succeeded and there was nothing there". Swallowing errors into
// null made the two cases indistinguishable, so a rate-limited RPC (429
// bursts on cold caches) read as "user has no Blend positions" and a real
// ~$200 deposit silently vanished from portfolio totals.
async function getReserveList(poolContractId) {
  const r = await simulateContractCall(poolContractId, "get_reserve_list");
  return r ? scValToNative(r) : null;
}

async function getReserve(poolContractId, assetAddress) {
  const assetScVal = new Address(assetAddress).toScVal();
  const r = await simulateContractCall(poolContractId, "get_reserve", [assetScVal]);
  return r ? scValToNative(r) : null;
}

async function getPoolConfig(poolContractId) {
  try { const r = await simulateContractCall(poolContractId, "get_config"); return r ? scValToNative(r) : null; }
  catch (e) { return null; }
}

async function getUserPositions(poolContractId, userAddress) {
  const userScVal = new Address(userAddress).toScVal();
  const r = await simulateContractCall(poolContractId, "get_positions", [userScVal]);
  return r ? scValToNative(r) : null;
}

// BLND emissions are tracked per "reserve token id", one per side of each
// reserve (blend-contracts-v2, pool/src/contract.rs):
//   reserve_index * 2     → dTokens (liabilities / borrows)
//   reserve_index * 2 + 1 → bTokens (supply + collateral)
// This was previously documented and used the other way round, so a supplier
// was asked about the borrow side's emissions and vice versa.
const emissionTokenId = {
  borrow: (reserveIndex) => reserveIndex * 2,
  supply: (reserveIndex) => reserveIndex * 2 + 1,
};

/** ReserveEmissionData { expiration, eps, index, last_time }, or null if this side never had emissions. */
async function getReserveEmissions(poolContractId, reserveTokenId) {
  const idScVal = nativeToScVal(reserveTokenId, { type: "u32" });
  const r = await simulateContractCall(poolContractId, "get_reserve_emissions", [idScVal]);
  return r ? scValToNative(r) : null;
}

/** UserEmissionData { index, accrued }, or null if the user has no entry for this side. */
async function getUserEmissions(poolContractId, userAddress, reserveTokenId) {
  const userScVal = new Address(userAddress).toScVal();
  const idScVal = nativeToScVal(reserveTokenId, { type: "u32" });
  const r = await simulateContractCall(poolContractId, "get_user_emissions", [userScVal, idScVal]);
  // simulateContractCall returns an xdr.ScVal. This used to be checked for
  // `typeof === "bigint"` / `.accrued` without decoding, which never matched,
  // so pending BLND was always 0.
  return r ? scValToNative(r) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversions
// ─────────────────────────────────────────────────────────────────────────────

function fromScalar7(raw) {
  if (raw == null) return 0;
  try { return Number(BigInt(raw)) / SCALAR_7; }
  catch (e) { return Number(raw) / SCALAR_7; }
}

function protocolToUnderlying(protocolAmount, rate, decimals = 7) {
  if (!rate || !protocolAmount) return 0;
  try {
    const amount = BigInt(protocolAmount);
    const rateVal = BigInt(rate);
    const scaleFactor = 10n ** BigInt(BLEND_V2_RATE_SCALAR_DECIMALS);
    const underlying = (amount * rateVal) / scaleFactor;
    return Number(underlying) / (10 ** decimals);
  } catch (e) {
    return (Number(protocolAmount) * Number(rate)) /
      (10 ** BLEND_V2_RATE_SCALAR_DECIMALS) / (10 ** decimals);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BLND emissions math
// ─────────────────────────────────────────────────────────────────────────────
//
// A port of blend-contracts-v2 pool/src/emissions/distributor.rs
// (update_emission_data + update_user_emissions, as run by `claim`), integer
// for integer: given the same state and time, it returns what `claim` would.
// (The time used is the server clock, within seconds of ledger time.) Inputs
// are i128/u64 values as returned by scValToNative; all maths is BigInt and
// every division floors, as the contract's fixed_mul_floor / fixed_div_floor do.
//
// Why not simulate `claim` instead? Its answer depends on the backstop, not on
// what the user is owed: claim pays out of a BLND allowance the backstop gives
// each pool, which runs down as users claim and expires ~120 days after the
// last emissions top-up (on mainnet, around ledger 66.2M: early January 2027).
// Past that, every simulated claim fails while the BLND is still owed.

/**
 * The reserve token's emission index brought forward to `nowSec`.
 * `supply` is the reserve's d_supply (borrow side) or b_supply (supply side).
 */
function currentEmissionIndex(reserveEmissions, supply, supplyScalar, nowSec) {
  let index = BigInt(reserveEmissions.index);
  const lastTime = BigInt(reserveEmissions.last_time);
  const expiration = BigInt(reserveEmissions.expiration);
  const eps = BigInt(reserveEmissions.eps);
  const now = BigInt(nowSec);
  supply = BigInt(supply);
  // The contract's own "nothing to add" cases, plus now < last_time, which
  // can only happen here (our clock vs the ledger's) and must not go negative.
  if (lastTime >= expiration || now <= lastTime || eps === 0n || supply === 0n) return index;
  const until = now > expiration ? expiration : now;
  index += ((until - lastTime) * eps * BigInt(supplyScalar)) / supply;
  return index;
}

/**
 * BLND (in stroops, 7 decimals) the user is owed on one reserve token: what
 * `claim` would pay, as long as the pool's BLND allowance covers it.
 * `reserveEmissions` null → that side never had emissions → 0.
 * `userEmissions` null → the user has never been checkpointed on that side,
 * so a non-zero balance is due the whole index (it predates emissions).
 */
function claimableEmissions({ reserveEmissions, userEmissions, balance, supply, supplyScalar, nowSec }) {
  if (!reserveEmissions) return 0n;
  balance = BigInt(balance);
  const scalar = BigInt(supplyScalar);
  const index = currentEmissionIndex(reserveEmissions, supply, scalar, nowSec);
  const denominator = scalar * BigInt(SCALAR_7);
  if (userEmissions) {
    let accrued = BigInt(userEmissions.accrued);
    const delta = index - BigInt(userEmissions.index);
    // delta < 0 only if the two reads straddled a ledger in which the user
    // acted; the contract would never see that, so count nothing extra.
    if (balance !== 0n && delta > 0n) accrued += (balance * delta) / denominator;
    return accrued;
  }
  return balance > 0n ? (balance * index) / denominator : 0n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interest rate / APY math
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute current borrow APR using Blend's three-slope piecewise-linear model
 * (whitepaper section "Interest Rate Model"):
 *
 *   IR(U) = RM * (R_base + (U/U_t) * R_1)                          if U ≤ U_t
 *           RM * (R_base + R_1 + ((U-U_t)/(0.95-U_t)) * R_2)       if U_t < U ≤ 0.95
 *           (R_base + R_1 + R_2) + ((U-0.95)/0.05) * R_3           if U > 0.95
 *
 * Inputs are plain JS numbers (post-scaling). Returns APR as fraction.
 */
function computeBorrowApr({ r_base, r_one, r_two, r_three, util_target, ir_mod, utilization }) {
  if (!Number.isFinite(utilization)) return 0;
  const U = Math.max(0, Math.min(1, utilization));
  const U_t = Math.max(0.0001, Math.min(0.9499, util_target));
  const RM = ir_mod > 0 ? ir_mod : 1;

  if (U <= U_t) {
    return RM * (r_base + (U / U_t) * r_one);
  } else if (U <= 0.95) {
    return RM * (r_base + r_one + ((U - U_t) / (0.95 - U_t)) * r_two);
  } else {
    return (r_base + r_one + r_two) + ((U - 0.95) / 0.05) * r_three;
  }
}

function computeSupplyApr({ borrowApr, utilization, backstopTakeRate }) {
  return borrowApr * utilization * (1 - (backstopTakeRate || 0));
}

function aprToApy(apr) {
  if (!Number.isFinite(apr) || apr === 0) return 0;
  return Math.pow(1 + apr / 365, 365) - 1;
}

function _extractReserveRateParams(reserveData) {
  const inner = reserveData?.data || reserveData || {};
  const cfg = reserveData?.config || reserveData?.Config || inner.config || {};

  return {
    r_base:      fromScalar7(cfg.r_base      ?? cfg.rBase      ?? 0),
    r_one:       fromScalar7(cfg.r_one       ?? cfg.rOne       ?? 0),
    r_two:       fromScalar7(cfg.r_two       ?? cfg.rTwo       ?? 0),
    r_three:     fromScalar7(cfg.r_three     ?? cfg.rThree     ?? 0),
    util_target: fromScalar7(cfg.util        ?? cfg.targetUtil ?? 0),
    ir_mod: Number(BigInt(inner.ir_mod ?? inner.irMod ?? 1000000000n)) / BLEND_IR_MOD_SCALAR,
  };
}

/**
 * Compute current pool utilization for a single reserve.
 * U = total borrowed / total supplied
 *   = (d_supply * d_rate) / (b_supply * b_rate)
 * Both rates are in the same 12-decimal scale, so they don't cancel — the
 * d_rate may be slightly higher than b_rate (debt grows faster) but both
 * scale factors do divide cleanly when computed as a Number ratio.
 */
function _computeUtilization(reserveData) {
  const inner = reserveData?.data || reserveData || {};
  try {
    const bSupply = BigInt(inner.b_supply ?? inner.bSupply ?? 0);
    const dSupply = BigInt(inner.d_supply ?? inner.dSupply ?? 0);
    const bRate = BigInt(inner.b_rate ?? inner.bRate ?? 0);
    const dRate = BigInt(inner.d_rate ?? inner.dRate ?? 0);

    if (bSupply === 0n || bRate === 0n) return 0;
    const supplied = bSupply * bRate;
    const borrowed = dSupply * dRate;
    if (supplied === 0n) return 0;
    const ratio = Number((borrowed * 1000000n) / supplied) / 1000000;
    return Math.max(0, Math.min(1, ratio));
  } catch (e) {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata resolution
// ─────────────────────────────────────────────────────────────────────────────

async function _resolveAssetMetadata(assetAddress) {
  let symbol = null;
  let decimals = null;

  const universeEntry = tokenUniverse.get(assetAddress);
  if (universeEntry) {
    if (universeEntry.symbol) symbol = universeEntry.symbol;
    if (universeEntry.decimals != null) decimals = universeEntry.decimals;
  }

  if (decimals == null || !symbol) {
    try {
      const meta = await getTokenMetadata(assetAddress);
      if (meta) {
        if (decimals == null) decimals = meta.decimals;
        if (!symbol) symbol = meta.symbol;
        try {
          tokenUniverse.add(assetAddress, { symbol, decimals, source: "blend-discovered" });
        } catch (_) {}
      }
    } catch (_) {}
  }

  if (decimals == null) decimals = 7;
  if (!symbol) symbol = "???";
  return { symbol, decimals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending BLND
// ─────────────────────────────────────────────────────────────────────────────
//
// Pending BLND is a side figure, so it is looked up per pool in the background
// while the positions are built, and must never cost the adapter its timeout
// (server.js gives every adapter ADAPTER_TIMEOUT_MS). Once the positions are
// ready, getPositions waits at most PENDING_BLND_GRACE_MS for it, and never
// past ADAPTER_TIMEOUT_MS - PENDING_BLND_MARGIN_MS from its start; whatever
// has not arrived by then is reported as unknown, and the lookup is stopped.

// Reserve emission data is pool-wide, so wallets share it for a few minutes.
// (A user checkpoint newer than the cached copy forces a fresh read.)
const RESERVE_EMISSIONS_TTL_MS = 5 * 60 * 1000;
const EMISSIONS_LOOKUP_CONCURRENCY = 4; // per pool
const PENDING_BLND_GRACE_MS = 1500;
const PENDING_BLND_MARGIN_MS = 750;
// server.js applies the same variable, with the same default, to every adapter.
const ADAPTER_TIMEOUT_MS = parseInt(process.env.ADAPTER_TIMEOUT_MS || "8000", 10);
// A shared read that never settles must not leave a pool unknown for every
// wallet until the TTL runs out: give up on it (and evict it) after this.
const RESERVE_EMISSIONS_READ_TIMEOUT_MS = 5000;
const _reserveEmissionsCache = new Map(); // `${pool}:${reserveTokenId}` → { ts, value: Promise }
const _pendingLookups = new WeakMap(); // pool group → Promise<Array<bigint|null>>

function _reserveEmissionsCached(poolContractId, reserveTokenId, { fresh = false } = {}) {
  const key = `${poolContractId}:${reserveTokenId}`;
  const hit = _reserveEmissionsCache.get(key);
  if (!fresh && hit && Date.now() - hit.ts < RESERVE_EMISSIONS_TTL_MS) return hit.value;
  // The promise is cached, so wallets loading at the same time share one read.
  let timer;
  const value = Promise.race([
    getReserveEmissions(poolContractId, reserveTokenId),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("get_reserve_emissions timed out")), RESERVE_EMISSIONS_READ_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  _reserveEmissionsCache.set(key, { ts: Date.now(), value });
  value.catch(() => {
    if (_reserveEmissionsCache.get(key)?.value === value) _reserveEmissionsCache.delete(key);
  });
  return value;
}

async function _mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A user's bToken (collateral + supply) and dToken units on one reserve. */
function _positionUnits(userPositions, reserveIndex) {
  const at = (a, b) => BigInt((userPositions[a] || userPositions[b] || {})[reserveIndex] || 0n);
  return {
    supply: at("collateral", "Collateral") + at("supply", "Supply"),
    borrow: at("liabilities", "Liabilities"),
  };
}

/**
 * Claimable BLND for every reserve token id in a pool, as an array indexed
 * by id: stroops (BigInt), or null where it could not be read. Never rejects.
 *
 * Every id is asked, not only the reserves the user holds now: BLND earned
 * before a borrow was repaid or a supply withdrawn stays claimable until it
 * is claimed. reserveDataFor(i) is the pool's shared get_reserve read; it is
 * only needed where the user still has a balance.
 */
function _lookupPendingBlnd({ pool, userAddress, reserveCount, userPositions, reserveDataFor, run }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ids = Array.from({ length: reserveCount * 2 }, (_, id) => id);
  return _mapLimit(ids, EMISSIONS_LOOKUP_CONCURRENCY, async (id) => {
    try {
      // getPositions stopped waiting (deadline, or a pool failed): stop here.
      if (run.cancelled) return null;
      let reserveEmissions = await _reserveEmissionsCached(pool.contractId, id);
      if (!reserveEmissions) return 0n; // this side never had emissions
      if (run.cancelled) return null;
      const userEmissions = await getUserEmissions(pool.contractId, userAddress, id);
      const reserveIndex = Math.floor(id / 2);
      const isSupply = id === emissionTokenId.supply(reserveIndex);
      const units = _positionUnits(userPositions, reserveIndex);
      const balance = isSupply ? units.supply : units.borrow;
      if (!userEmissions && balance === 0n) return 0n; // never held this side
      // A checkpoint newer than our cached reserve data (the user acted since
      // it was read): read it again. At a zero balance the index is unused.
      if (balance > 0n && userEmissions && BigInt(userEmissions.index) > BigInt(reserveEmissions.index)) {
        reserveEmissions = await _reserveEmissionsCached(pool.contractId, id, { fresh: true });
      }
      let supply = 0n;
      let supplyScalar = 1n; // unused at a zero balance
      if (balance > 0n) {
        const reserve = await reserveDataFor(reserveIndex);
        const data = reserve?.data || {};
        supply = isSupply ? (data.b_supply ?? data.bSupply) : (data.d_supply ?? data.dSupply);
        // 10^decimals of the reserve asset, as the contract uses it.
        supplyScalar = reserve?.scalar ??
          (reserve?.config?.decimals != null ? 10n ** BigInt(reserve.config.decimals) : null);
        if (supply == null || supplyScalar == null) throw new Error("reserve has no supply/decimals");
      }
      return claimableEmissions({ reserveEmissions, userEmissions, balance, supply, supplyScalar, nowSec });
    } catch (e) {
      console.warn(
        `[Blend] pending BLND unavailable pool=${pool.contractId.slice(0, 10)} ` +
          `reserveTokenId=${id}: ${String(e?.message || e).slice(0, 80)}`
      );
      return null;
    }
  });
}

/**
 * Wait for each group's lookup (until PENDING_BLND_GRACE_MS from now or
 * `deadlineAt`, whichever is sooner, shared by all pools), then fill in
 * pendingBlndSupply / pendingBlndBorrow / pendingBlnd on its rows and
 * totalPendingBlnd on the group, in BLND. null means unknown: never a smaller
 * number. The pool total includes reserves the user has left.
 */
async function _attachPendingBlnd(groups, deadlineAt) {
  let timer;
  const waitMs = Math.max(0, Math.min(PENDING_BLND_GRACE_MS, deadlineAt - Date.now()));
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, waitMs); });
  const toBlnd = (v) => (v == null ? null : Number(v) / SCALAR_7);
  try {
    await Promise.all(groups.map(async (group) => {
      const byId = (await Promise.race([_pendingLookups.get(group), deadline])) || null;
      const at = (id) => (byId ? byId[id] ?? null : null);
      for (const r of group.rows) {
        const s = at(emissionTokenId.supply(r.reserveIndex));
        const b = at(emissionTokenId.borrow(r.reserveIndex));
        r.pendingBlndSupply = toBlnd(s);
        r.pendingBlndBorrow = toBlnd(b);
        r.pendingBlnd = s == null || b == null ? null : toBlnd(s + b);
      }
      group.totalPendingBlnd = !byId || byId.some((v) => v == null)
        ? null
        : toBlnd(byId.reduce((sum, v) => sum + v, 0n));
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Position row building
// ─────────────────────────────────────────────────────────────────────────────

async function _buildReserveRow({
  pool, reserveIndex, assetAddress, reserveData, poolConfig, userPositions, userAddress,
}) {
  const { symbol, decimals } = await _resolveAssetMetadata(assetAddress);

  const inner = reserveData?.data || reserveData || {};
  const bRate = inner.b_rate ?? inner.bRate;
  const dRate = inner.d_rate ?? inner.dRate;

  const collat = (userPositions.collateral || userPositions.Collateral || {})[reserveIndex] || 0n;
  const supply = (userPositions.supply || userPositions.Supply || {})[reserveIndex] || 0n;
  const liab   = (userPositions.liabilities || userPositions.Liabilities || {})[reserveIndex] || 0n;

  const collatBig = BigInt(collat);
  const supplyBig = BigInt(supply);
  const liabBig = BigInt(liab);

  const totalSuppliedBToken = collatBig + supplyBig;
  const suppliedUnderlying = protocolToUnderlying(totalSuppliedBToken, bRate, decimals);
  const borrowedUnderlying = protocolToUnderlying(liabBig, dRate, decimals);

  if ((totalSuppliedBToken > 0n && suppliedUnderlying === 0) ||
      (liabBig > 0n && borrowedUnderlying === 0)) {
    console.warn(
      `[Blend] underlying=0 from non-zero protocolTokens — possible struct/scalar change. ` +
        `pool=${pool.contractId.slice(0, 10)} asset=${assetAddress.slice(0, 10)} ` +
        `bSupplied=${totalSuppliedBToken} bRate=${bRate} dLiab=${liabBig} dRate=${dRate}`
    );
  }

  // Reserve-level metrics
  const rateParams = _extractReserveRateParams(reserveData);
  const utilization = _computeUtilization(reserveData);
  const backstopTakeRate = fromScalar7(
    poolConfig?.bstop_rate ?? poolConfig?.backstopRate ?? poolConfig?.bstopRate ?? 0
  );

  const borrowApr = computeBorrowApr({ ...rateParams, utilization });
  const supplyApr = computeSupplyApr({ borrowApr, utilization, backstopTakeRate });
  const borrowApy = aprToApy(borrowApr);
  const supplyApy = aprToApy(supplyApr);

  if (Math.abs(borrowApy) > 10 || Math.abs(supplyApy) > 10) {
    console.warn(
      `[Blend] suspicious APY: borrow=${borrowApy} supply=${supplyApy} ` +
        `pool=${pool.contractId.slice(0, 10)} asset=${assetAddress.slice(0, 10)} ` +
        `util=${utilization} params=${JSON.stringify(rateParams)} ` +
        `backstopTakeRate=${backstopTakeRate}`
    );
  }

  // Price
  let price = null;
  try { price = await priceSorobanToken(assetAddress, { decimals }); } catch (_) {}
  const priceUsd = price?.usd || 0;
  const suppliedUSD = suppliedUnderlying * priceUsd;
  const borrowedUSD = borrowedUnderlying * priceUsd;

  // Pending BLND is looked up per pool; _attachPendingBlnd fills it in.
  const pendingBlnd = null;

  // What interest accrual needs, in Blend's own units: the position's
  // bTokens/dTokens and the reserve's b_rate/d_rate at this moment.
  // underlying = units × rate / 10^12 / 10^decimals, so between two snapshots
  // with unchanged units, interest = units × (rate₂ − rate₁) exactly. Kept as
  // integer strings: i128 values overflow a JS number, and BigInt does not
  // survive JSON. (Pending BLND is deliberately not included yet: see the
  // PR description; getUserEmissions does not decode its result.)
  const accrual = (side, units, rate) => {
    if (units <= 0n || rate == null) return null;
    try {
      return { side, units: units.toString(), rate: BigInt(rate).toString(), rateDecimals: BLEND_V2_RATE_SCALAR_DECIMALS };
    } catch (_) {
      return null; // an unexpected rate shape must not take the whole adapter down
    }
  };

  return {
    reserveIndex, asset: symbol, assetAddress, decimals,
    supplied: suppliedUnderlying,
    suppliedUSD,
    supplyApy,
    borrowed: borrowedUnderlying,
    borrowedUSD,
    borrowApy,
    netUSD: suppliedUSD - borrowedUSD,
    price: price ? { usd: price.usd, source: price.source } : null,
    utilization,
    pendingBlnd,
    supplyAccrual: accrual("supply", totalSuppliedBToken, bRate),
    borrowAccrual: accrual("borrow", liabBig, dRate),
  };
}

async function _resolveUserPositionsInPool(pool, userAddress, run) {
  const reserveList = await getReserveList(pool.contractId);
  if (!reserveList || reserveList.length === 0) return null;

  const userPositions = await getUserPositions(pool.contractId, userAddress);
  if (!userPositions) return null;

  const poolConfig = await getPoolConfig(pool.contractId);

  // One get_reserve per reserve, shared by the rows and the pending-BLND lookup.
  const reserveReads = new Map();
  const reserveDataFor = (i) => {
    if (!reserveReads.has(i)) reserveReads.set(i, getReserve(pool.contractId, reserveList[i]));
    return reserveReads.get(i);
  };
  const holdsAny = reserveList.some((_, i) => {
    const u = _positionUnits(userPositions, i);
    return u.supply !== 0n || u.borrow !== 0n;
  });
  const pendingLookup = holdsAny
    ? _lookupPendingBlnd({ pool, userAddress, reserveCount: reserveList.length, userPositions, reserveDataFor, run })
    : null;

  const rows = [];
  for (let i = 0; i < reserveList.length; i++) {
    const assetAddress = reserveList[i];
    const collat = (userPositions.collateral || userPositions.Collateral || {})[i] || 0n;
    const supply = (userPositions.supply || userPositions.Supply || {})[i] || 0n;
    const liab   = (userPositions.liabilities || userPositions.Liabilities || {})[i] || 0n;

    if (BigInt(collat) === 0n && BigInt(supply) === 0n && BigInt(liab) === 0n) continue;

    // The user HAS a position on this reserve — a failed reserve read here
    // must fail the pool (throw), not skip the row and undercount.
    const reserveData = await reserveDataFor(i);
    if (!reserveData) continue;

    const row = await _buildReserveRow({
      pool, reserveIndex: i, assetAddress, reserveData, poolConfig, userPositions, userAddress,
    });
    rows.push(row);
  }

  if (rows.length === 0) return null;

  const totalSuppliedUSD = rows.reduce((s, r) => s + r.suppliedUSD, 0);
  const totalBorrowedUSD = rows.reduce((s, r) => s + r.borrowedUSD, 0);

  const group = {
    poolContractId: pool.contractId,
    poolName: pool.name || `Blend Pool (${pool.contractId.slice(0, 6)}…)`,
    rows,
    totalSuppliedUSD,
    totalBorrowedUSD,
    netUSD: totalSuppliedUSD - totalBorrowedUSD,
    debtRatio: totalSuppliedUSD > 0 ? totalBorrowedUSD / totalSuppliedUSD : 0,
    totalPendingBlnd: null, // filled in by _attachPendingBlnd; null = unknown
  };
  if (pendingLookup) _pendingLookups.set(group, pendingLookup);
  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flattening for legacy server.js compatibility
// ─────────────────────────────────────────────────────────────────────────────

function _flattenPoolGroup(group) {
  const flat = [];
  for (const r of group.rows) {
    // Gate on token amounts, not USD value (as k2.js does). When an asset has
    // no price (USTRY, oUSD and the Forex coins, for example), its USD value is 0 but
    // the position — a borrow especially — still exists. Gating on USD made
    // such positions vanish from the API, the position count and snapshots.
    // They carry valueUSD 0 and unpriced: true.
    const unpriced = r.price == null;
    if (r.supplied > 0) {
      flat.push({
        protocol: "blend",
        type: "lending",
        subtype: "collateral",
        poolContractId: group.poolContractId,
        poolName: group.poolName,
        asset: r.asset,
        assetAddress: r.assetAddress,
        decimals: r.decimals,
        underlyingAmount: r.supplied,
        valueUSD: r.suppliedUSD,
        apy: r.supplyApy,
        unpriced,
        price: r.price,
        accrual: r.supplyAccrual || null,
      });
    }
    if (r.borrowed > 0) {
      flat.push({
        protocol: "blend",
        type: "borrowing",
        subtype: "liability",
        poolContractId: group.poolContractId,
        poolName: group.poolName,
        asset: r.asset,
        assetAddress: r.assetAddress,
        decimals: r.decimals,
        underlyingAmount: r.borrowed,
        valueUSD: r.borrowedUSD ? -r.borrowedUSD : 0, // not -0 when unpriced
        apy: r.borrowApy,
        unpriced,
        price: r.price,
        accrual: r.borrowAccrual || null,
      });
    }
  }
  return flat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

// How long a load may spend looking for the wallet's other pools. It runs
// while the built-in pools are read (about 3 s for a big wallet); a long
// history is finished over the next loads.
const WALLET_POOLS_BUDGET_MS = 3000;

async function getPositions(userAddress) {
  const startedAt = Date.now();
  const run = { cancelled: false }; // stops this call's pending-BLND lookups
  const discovery = walletBlendPools(userAddress, {
    deadline: startedAt + WALLET_POOLS_BUDGET_MS,
    factoryId: BLEND_POOL_FACTORY,
  });

  const groups = [];
  let failedPools = 0;
  const readPools = async (list) => {
    for (const pool of list) {
      try {
        const group = await _resolveUserPositionsInPool(pool, userAddress, run);
        if (group) groups.push(group);
      } catch (e) {
        failedPools++;
        run.cancelled = true; // this call will throw: its pending-BLND lookups are moot
        console.error(`[Blend] Failed to resolve pool ${pool.contractId}: ${e.message}`);
      }
    }
  };

  const pools = getConfiguredPools();
  await readPools(pools);

  // Pools from the wallet's own history that aren't built in. A pool Blend's
  // factory didn't deploy is read the same way, and its name says so.
  const known = new Set(pools.map((p) => p.contractId));
  const found = (await discovery)
    .filter((p) => !known.has(p.contractId))
    .map((p) => ({
      contractId: p.contractId,
      name: p.factory ? p.name : `${p.name || "Blend pool"} (not deployed by Blend's factory)`,
    }));
  await readPools(found);
  pools.push(...found);
  if (pools.length === 0) return [];

  // A pool that errored may hold REAL positions. Returning the survivors
  // as a clean success meant the caller cached the shrunken result as
  // fresh and the portfolio total silently dropped by the missing pools'
  // value. Throw instead: collectDefiPositions then serves its stale
  // cached positions, or marks the protocol degraded so the UI can say
  // "temporarily unavailable" rather than show a smaller number.
  if (failedPools > 0) {
    throw new Error(`Blend: ${failedPools}/${pools.length} pools failed to resolve`);
  }

  await _attachPendingBlnd(groups, startedAt + ADAPTER_TIMEOUT_MS - PENDING_BLND_MARGIN_MS);
  run.cancelled = true; // anything still running has missed its chance

  const flat = [];
  for (const g of groups) flat.push(..._flattenPoolGroup(g));
  // Attach grouped data alongside the flat array for frontend table rendering
  flat.__blendPoolGroups = groups;
  return flat;
}

function isConfigured() {
  return getConfiguredPools().length > 0;
}

/**
 * Pool-level overview for the DeFi Explorer tab (no user address involved).
 * For each configured pool: per-reserve totals (supplied/borrowed USD via
 * b_supply×b_rate / d_supply×d_rate) and current supply/borrow APY from the
 * same kinked-interest-rate math the positions path uses.
 *
 * Additive export — does not touch the getPositions() user path.
 */
async function getPoolsOverview() {
  const pools = getConfiguredPools();
  const out = [];
  for (const pool of pools) {
    try {
      const [reserveList, poolConfig] = await Promise.all([
        getReserveList(pool.contractId),
        getPoolConfig(pool.contractId),
      ]);
      if (!Array.isArray(reserveList) || reserveList.length === 0) continue;

      // Every pool is returned with its status; the DeFi tab decides what to
      // list. Skipping all but Active pools here hid On Ice pools, which still
      // take deposits, and once every built-in pool was On Ice or Frozen
      // (Oct 2026) the tab showed Blend at $0 with no pools.
      const rawStatus = Number(
        poolConfig?.status ?? poolConfig?.pool_status ?? poolConfig?.poolStatus ?? 0
      );
      const status = Number.isFinite(rawStatus) ? rawStatus : null;

      const backstopTakeRate = fromScalar7(
        poolConfig?.bstop_rate ?? poolConfig?.backstopRate ?? poolConfig?.bstopRate ?? 0
      );

      const reserves = [];
      for (const assetAddress of reserveList) {
        try {
          const reserveData = await getReserve(pool.contractId, assetAddress);
          if (!reserveData) continue;
          const inner = reserveData?.data || reserveData || {};
          const bRate = inner.b_rate ?? inner.bRate;
          const dRate = inner.d_rate ?? inner.dRate;
          const bSupply = BigInt(inner.b_supply ?? inner.bSupply ?? 0);
          const dSupply = BigInt(inner.d_supply ?? inner.dSupply ?? 0);

          const { symbol, decimals } = await _resolveAssetMetadata(assetAddress);
          const suppliedUnderlying = protocolToUnderlying(bSupply, bRate, decimals);
          const borrowedUnderlying = protocolToUnderlying(dSupply, dRate, decimals);

          let priceUsd = 0;
          try {
            const price = await priceSorobanToken(assetAddress, { decimals });
            priceUsd = price?.usd || 0;
          } catch (_) {}

          const rateParams = _extractReserveRateParams(reserveData);
          const utilization = _computeUtilization(reserveData);
          const borrowApr = computeBorrowApr({ ...rateParams, utilization });
          const supplyApr = computeSupplyApr({ borrowApr, utilization, backstopTakeRate });

          reserves.push({
            assetAddress,
            symbol,
            decimals,
            suppliedUSD: suppliedUnderlying * priceUsd,
            borrowedUSD: borrowedUnderlying * priceUsd,
            supplyApy: aprToApy(supplyApr),
            borrowApy: aprToApy(borrowApr),
            utilization,
          });
        } catch (e) {
          console.warn(`[Blend] overview reserve failed ${assetAddress.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
        }
      }
      out.push({
        name: pool.name, contractId: pool.contractId, reserves,
        status, statusLabel: BLEND_POOL_STATUS_LABELS[status] || null,
      });
    } catch (e) {
      console.warn(`[Blend] overview pool failed ${pool.contractId.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
    }
  }
  return out;
}

const BlendAdapter = {
  name: "Blend Protocol",
  protocol: "blend",
  // Every other adapter exposes `protocolId`; Blend only had `protocol`, so
  // /api/health's configuredProtocols listed it as `null` in production.
  protocolId: "blend",
  isConfigured,
  getPositions,
  getPoolsOverview,
  // Pure emissions maths, exported for tests.
  claimableEmissions,
  currentEmissionIndex,
  _clearEmissionsCache: () => _reserveEmissionsCache.clear(), // tests only
};

module.exports = BlendAdapter;
