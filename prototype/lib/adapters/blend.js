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

const BLEND_POOL_FACTORY = process.env.BLEND_POOL_FACTORY ||
  "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU";

const KNOWN_POOLS = [
  { contractId: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD", name: "Fixed Pool V2" },
  { contractId: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS", name: "YieldBlox Pool V2" },
  { contractId: "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC", name: "Orbit Pool V2" },
  { contractId: "CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF", name: "Forex Pool V2" },
  { contractId: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI", name: "Etherfuse Pool V2" },
];

const POOL_DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

const config = {
  pools: JSON.parse(process.env.BLEND_POOLS || "[]"),
};

let _factoryPoolsCache = { pools: [], lastFetchTs: 0 };

function getConfiguredPools() {
  const byId = new Map();
  for (const list of [config.pools, KNOWN_POOLS, _factoryPoolsCache.pools]) {
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
// Pool Factory event-scan discovery
// ─────────────────────────────────────────────────────────────────────────────

async function _refreshFactoryPools() {
  if (Date.now() - _factoryPoolsCache.lastFetchTs < POOL_DISCOVERY_CACHE_TTL_MS) {
    return _factoryPoolsCache.pools;
  }
  try {
    const rpc = require("../soroban-rpc");
    if (typeof rpc.getEventsForContract === "function") {
      const events = await rpc.getEventsForContract(BLEND_POOL_FACTORY, { limit: 200 });
      const found = new Map();
      for (const ev of events || []) {
        const candidates = [
          ...(ev.topic || []),
          ...(ev.value ? [ev.value] : []),
        ];
        for (const c of candidates) {
          const s = typeof c === "string" ? c : (c && c.toString ? c.toString() : "");
          if (s && s.startsWith("C") && s.length >= 56 && s !== BLEND_POOL_FACTORY) {
            if (!found.has(s)) {
              found.set(s, { contractId: s, name: null, source: "factory" });
            }
          }
        }
      }
      _factoryPoolsCache = { pools: Array.from(found.values()), lastFetchTs: Date.now() };
      if (found.size > 0) {
        console.log(`[Blend] Pool factory discovery found ${found.size} pools`);
      }
    }
  } catch (e) {
    console.warn(`[Blend] Pool factory discovery failed: ${e.message}`);
    _factoryPoolsCache.lastFetchTs = Date.now();
  }
  return _factoryPoolsCache.pools;
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

/**
 * Get pending BLND emissions for a user on a specific reserve/type combo.
 * reserve_token_index encoding (per Blend docs):
 *   index * 2     = bToken (suppliers) for that reserve
 *   index * 2 + 1 = dToken (borrowers) for that reserve
 */
async function getUserEmissions(poolContractId, userAddress, reserveTokenIndex) {
  try {
    const userScVal = new Address(userAddress).toScVal();
    const indexScVal = nativeToScVal(reserveTokenIndex, { type: "u32" });
    const result = await simulateContractCall(poolContractId, "get_user_emissions",
      [userScVal, indexScVal]);
    if (result == null) return 0n;
    if (typeof result === "bigint") return result;
    if (typeof result === "object" && result.accrued != null) return BigInt(result.accrued);
    if (typeof result === "object" && result.amount != null) return BigInt(result.amount);
    return 0n;
  } catch (e) { return 0n; }
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

  // Pending BLND emissions (best-effort)
  let pendingEmissions = 0n;
  try {
    if (totalSuppliedBToken > 0n) {
      pendingEmissions += await getUserEmissions(pool.contractId, userAddress, reserveIndex * 2);
    }
    if (liabBig > 0n) {
      pendingEmissions += await getUserEmissions(pool.contractId, userAddress, reserveIndex * 2 + 1);
    }
  } catch (_) {}
  const pendingBlnd = Number(pendingEmissions) / SCALAR_7;

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
  };
}

async function _resolveUserPositionsInPool(pool, userAddress) {
  const reserveList = await getReserveList(pool.contractId);
  if (!reserveList || reserveList.length === 0) return null;

  const userPositions = await getUserPositions(pool.contractId, userAddress);
  if (!userPositions) return null;

  const poolConfig = await getPoolConfig(pool.contractId);

  const rows = [];
  for (let i = 0; i < reserveList.length; i++) {
    const assetAddress = reserveList[i];
    const collat = (userPositions.collateral || userPositions.Collateral || {})[i] || 0n;
    const supply = (userPositions.supply || userPositions.Supply || {})[i] || 0n;
    const liab   = (userPositions.liabilities || userPositions.Liabilities || {})[i] || 0n;

    if (BigInt(collat) === 0n && BigInt(supply) === 0n && BigInt(liab) === 0n) continue;

    // The user HAS a position on this reserve — a failed reserve read here
    // must fail the pool (throw), not skip the row and undercount.
    const reserveData = await getReserve(pool.contractId, assetAddress);
    if (!reserveData) continue;

    const row = await _buildReserveRow({
      pool, reserveIndex: i, assetAddress, reserveData, poolConfig, userPositions, userAddress,
    });
    rows.push(row);
  }

  if (rows.length === 0) return null;

  const totalSuppliedUSD = rows.reduce((s, r) => s + r.suppliedUSD, 0);
  const totalBorrowedUSD = rows.reduce((s, r) => s + r.borrowedUSD, 0);

  return {
    poolContractId: pool.contractId,
    poolName: pool.name || `Blend Pool (${pool.contractId.slice(0, 6)}…)`,
    rows,
    totalSuppliedUSD,
    totalBorrowedUSD,
    netUSD: totalSuppliedUSD - totalBorrowedUSD,
    debtRatio: totalSuppliedUSD > 0 ? totalBorrowedUSD / totalSuppliedUSD : 0,
    totalPendingBlnd: rows.reduce((s, r) => s + r.pendingBlnd, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Flattening for legacy server.js compatibility
// ─────────────────────────────────────────────────────────────────────────────

function _flattenPoolGroup(group) {
  const flat = [];
  for (const r of group.rows) {
    if (r.suppliedUSD !== 0) {
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
        price: r.price,
      });
    }
    if (r.borrowedUSD !== 0) {
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
        valueUSD: -r.borrowedUSD,
        apy: r.borrowApy,
        price: r.price,
      });
    }
  }
  return flat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

async function getPositions(userAddress) {
  _refreshFactoryPools().catch(() => {});

  const pools = getConfiguredPools();
  if (pools.length === 0) return [];

  const groups = [];
  let failedPools = 0;
  for (const pool of pools) {
    try {
      const group = await _resolveUserPositionsInPool(pool, userAddress);
      if (group) groups.push(group);
    } catch (e) {
      failedPools++;
      console.error(`[Blend] Failed to resolve pool ${pool.contractId}: ${e.message}`);
    }
  }

  // A pool that errored may hold REAL positions. Returning the survivors
  // as a clean success meant the caller cached the shrunken result as
  // fresh and the portfolio total silently dropped by the missing pools'
  // value. Throw instead: collectDefiPositions then serves its stale
  // cached positions, or marks the protocol degraded so the UI can say
  // "temporarily unavailable" rather than show a smaller number.
  if (failedPools > 0) {
    throw new Error(`Blend: ${failedPools}/${pools.length} pools failed to resolve`);
  }

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
      out.push({ name: pool.name, contractId: pool.contractId, reserves });
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
};

module.exports = BlendAdapter;
