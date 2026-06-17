/**
 * Blend Protocol Adapter for Stellar/Soroban
 *
 * Blend is a universal liquidity protocol primitive on Stellar that enables
 * permissionless lending pools. Users can supply collateral and borrow assets.
 *
 * This adapter tracks:
 * 1. Supply/Collateral positions (bTokens → underlying via b_rate)
 * 2. Borrow/Liability positions (dTokens → underlying via d_rate)
 * 3. BLND emissions (claimable rewards)
 *
 * Contract interface (from blend-contracts-v2):
 *   get_positions(address) → Positions { collateral, liabilities, supply }
 *   get_reserve(asset)     → Reserve { b_rate, d_rate, index, ... }
 *   get_reserve_list()     → Vec<Address>
 *   get_config()           → PoolConfig
 *
 * Reference: https://docs.blend.capital/tech-docs/integrations/integrate-pool
 */
const {
  simulateContractCall,
  getTokenMetadata,
  formatTokenAmount,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative, nativeToScVal } = StellarSdk;
const tokenUniverse = require("../token-universe");
const { priceSorobanToken } = require("../pricing-engine");

// ── Configuration ─────────────────────────────────────────────────────────────

// Known Blend pool contract IDs on mainnet
// Users can configure additional pools via env
const BLEND_CONFIG = {
  // Array of pool objects: { contractId, name, assets[] }
  // Primary pools on mainnet
  pools: JSON.parse(process.env.BLEND_POOLS || "[]"),
  // Example:
  // [
  //   {
  //     "contractId": "CABC...",
  //     "name": "USDC-XLM Pool"
  //   }
  // ]

  // Well-known mainnet pool contract IDs (always queried; users can add more
  // via the BLEND_POOLS env var). These are pools the blend-capital UI lists
  // at https://mainnet.blend.capital/ — the Fixed Pool V2 is the most active.
  // As Blend deploys new pools via its Pool Factory
  // (CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU), we'll add them
  // here. A future enhancement could query the factory for emitted
  // `pool_deployed` events instead of maintaining this list manually.
  knownPools: [
    { contractId: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD", name: "Fixed Pool V2" },
    { contractId: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS", name: "YieldBlox Pool V2" },
    { contractId: "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC", name: "Orbit Pool V2" },
    { contractId: "CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF", name: "Forex Pool V2" },
    { contractId: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI", name: "Etherfuse Pool V2" },
  ],
};

function getAllPools() {
  return [...BLEND_CONFIG.pools, ...BLEND_CONFIG.knownPools].filter(
    (p) => p.contractId
  );
}

// ── Contract Queries ─────────────────────────────────────────────────────────

/**
 * Get the list of reserve asset addresses for a pool.
 */
async function getReserveList(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "get_reserve_list");
    if (!result) return [];
    return scValToNative(result);
  } catch (e) {
    console.error(`[Blend] get_reserve_list error for ${poolContractId}:`, e.message);
    return [];
  }
}

/**
 * Get reserve data (including b_rate and d_rate for token conversion).
 */
async function getReserve(poolContractId, assetAddress) {
  try {
    const assetScVal = new Address(assetAddress).toScVal();
    const result = await simulateContractCall(poolContractId, "get_reserve", [assetScVal]);
    if (!result) return null;
    return scValToNative(result);
  } catch (e) {
    console.error(`[Blend] get_reserve error:`, e.message);
    return null;
  }
}

/**
 * Get user positions in a Blend pool.
 * Returns: { collateral: Map<reserveIndex, amount>, liabilities: Map, supply: Map }
 */
async function getPositions(poolContractId, userAddress) {
  try {
    const userScVal = new Address(userAddress).toScVal();
    const result = await simulateContractCall(poolContractId, "get_positions", [userScVal]);
    if (!result) return null;
    return scValToNative(result);
  } catch (e) {
    // User may have no positions — that's normal
    if (e.message?.includes("not found") || e.message?.includes("Simulation failed")) {
      return null;
    }
    console.error(`[Blend] get_positions error:`, e.message);
    return null;
  }
}

/**
 * Get pool configuration.
 */
async function getPoolConfig(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "get_config");
    if (!result) return null;
    return scValToNative(result);
  } catch (e) {
    console.error(`[Blend] get_config error:`, e.message);
    return null;
  }
}

// ── Position Resolution ──────────────────────────────────────────────────────

/**
 * Convert protocol token amount (bTokens/dTokens) to underlying asset amount.
 *
 * Two distinct decimal concepts are at play here:
 *
 *   1. The asset's own decimals — XLM=7, USDC=7, SolvBTC=8, Centrifuge=18, etc.
 *      This describes how the token represents 1 unit of itself on-chain
 *      and is per-token, not per-protocol. Comes in via the `decimals`
 *      argument and ultimately from the token universe / token contract.
 *
 *   2. Blend's internal rate scalar — a Blend V2 protocol invariant,
 *      fixed at 12 decimals. b_rate and d_rate are stored as fixed-point
 *      integers scaled by 10^12. This is *not* configurable per pool or
 *      per asset; it's a property of how Blend V2 tracks interest accrual,
 *      established at protocol design time.
 *
 * Don't confuse the two. Other protocols use entirely different internal
 * scalars (SushiSwap V3 uses sqrtPriceX96 / Q96 = 2^96, Aave-style protocols
 * commonly use 27-decimal "ray" math) — each adapter encodes its own
 * protocol's scalar without inheriting from a shared constant.
 *
 * Verified empirically: with this scalar, the test wallet's positions of
 * 8 XLM / 10 USDC supplied and 3 USDC borrowed are read correctly. With
 * a 10^9 scalar (a prior guess based on Blend V1 conventions) the numbers
 * came back exactly 1000× too high — the smoking gun that V2 uses 12, not 9.
 */
const BLEND_V2_RATE_SCALAR_DECIMALS = 12;

function protocolToUnderlying(protocolAmount, rate, decimals = 7) {
  if (!rate || !protocolAmount) return 0;
  // underlying_raw = protocolAmount × rate / 10^BLEND_V2_RATE_SCALAR_DECIMALS
  // underlying     = underlying_raw / 10^decimals
  try {
    const amount = BigInt(protocolAmount);
    const rateVal = BigInt(rate);
    const scaleFactor = 10n ** BigInt(BLEND_V2_RATE_SCALAR_DECIMALS);
    const underlying = (amount * rateVal) / scaleFactor;
    return Number(underlying) / (10 ** decimals);
  } catch (e) {
    // Fallback for non-BigInt values
    return (Number(protocolAmount) * Number(rate)) / (10 ** BLEND_V2_RATE_SCALAR_DECIMALS) / (10 ** decimals);
  }
}

/**
 * Resolve metadata (symbol + decimals) for an asset, with the same
 * universe-first / RPC-fallback pattern used elsewhere in the codebase
 * (see contract-discovery.js for prior art). Returns { symbol, decimals }.
 *
 * Why universe-first: Soroban RPC metadata calls can fail (rate-limit,
 * transient errors). For well-known assets we already know the decimals,
 * and using the wrong decimals corrupts the underlying-amount calculation
 * — which we learned the hard way with SolvBTC on the discovery side.
 */
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
        // Cache what we learned for next time
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

/**
 * Build a single position object and enrich it with the current USD price.
 * For borrow positions (subtype === "liability"), the returned valueUSD is
 * negative — this correctly represents debt against total net worth.
 */
async function _buildEnrichedPosition({
  pool,
  positionType,
  subtype,
  reserveIndex,
  assetAddress,
  protocolTokenAmount,
  reserveData,
}) {
  const { symbol, decimals } = await _resolveAssetMetadata(assetAddress);

  // Borrow uses d_rate; supply/collateral uses b_rate.
  // These live inside reserveData.data (a sub-struct) per Blend V2's
  // ReserveV2 layout — `reserveData.data.b_rate` not `reserveData.b_rate`.
  // The serde wrappers may also expose camelCase variants, so we tolerate both.
  const reserveDataInner = reserveData?.data || reserveData || {};
  const rate = subtype === "liability"
    ? (reserveDataInner.d_rate ?? reserveDataInner.dRate)
    : (reserveDataInner.b_rate ?? reserveDataInner.bRate);

  const underlyingAmount = protocolToUnderlying(protocolTokenAmount, rate, decimals);

  // Future canary: if Blend ever changes the reserve struct layout or
  // rate-scalar convention, this warning will surface in server logs
  // immediately rather than silently corrupting numbers.
  if (
    underlyingAmount === 0 &&
    protocolTokenAmount &&
    BigInt(protocolTokenAmount) > 0n
  ) {
    console.warn(
      `[Blend] underlyingAmount=0 from non-zero protocolTokens — possible struct/scalar change. ` +
        `pool=${pool.contractId.slice(0, 10)} asset=${assetAddress.slice(0, 10)} ` +
        `subtype=${subtype} protocolTokens=${protocolTokenAmount.toString()} ` +
        `rate=${rate ?? "(missing)"} decimals=${decimals} ` +
        `reserveDataKeys=${Object.keys(reserveData || {}).join(",")} ` +
        `dataKeys=${Object.keys((reserveData || {}).data || {}).join(",")}`
    );
  }

  // Price the underlying asset and compute USD value. For liabilities, the
  // value is the negative of the priced amount so that summing across all
  // positions yields the correct net-of-debt portfolio total.
  let valueUSD = 0;
  let price = null;
  try {
    price = await priceSorobanToken(assetAddress, { decimals });
    if (price && Number.isFinite(underlyingAmount)) {
      valueUSD = underlyingAmount * price.usd;
      if (subtype === "liability") valueUSD = -valueUSD;
    }
  } catch (_) {}

  return {
    protocol: "blend",
    type: positionType,
    subtype,
    poolContractId: pool.contractId,
    poolName: pool.name || "Blend Pool",
    assetAddress,
    asset: symbol,
    decimals,
    protocolTokens: protocolTokenAmount.toString(),
    underlyingAmount,
    reserveIndex: Number(reserveIndex),
    valueUSD,
    price: price ? { usd: price.usd, source: price.source } : null,
  };
}

/**
 * Resolve all positions for a user across all configured Blend pools.
 */
async function resolveUserPositions(userAddress) {
  const pools = getAllPools();
  const positions = [];

  for (const pool of pools) {
    try {
      const userPositions = await getPositions(pool.contractId, userAddress);
      if (!userPositions) continue;

      const reserveList = await getReserveList(pool.contractId);
      if (!reserveList || reserveList.length === 0) continue;

      // Position kinds we care about. Each entry is:
      // { mapKeys: [variants], positionType, subtype }
      const positionKinds = [
        { mapKeys: ["collateral", "Collateral"], positionType: "lending",   subtype: "collateral" },
        { mapKeys: ["supply",     "Supply"],     positionType: "lending",   subtype: "supply" },
        { mapKeys: ["liabilities","Liabilities"],positionType: "borrowing", subtype: "liability" },
      ];

      for (const kind of positionKinds) {
        const map = kind.mapKeys.reduce(
          (acc, k) => acc || userPositions[k],
          null
        ) || new Map();

        for (const [reserveIndex, protocolTokenAmount] of Object.entries(map)) {
          if (!protocolTokenAmount || BigInt(protocolTokenAmount) === 0n) continue;

          const assetAddress = reserveList[Number(reserveIndex)];
          if (!assetAddress) continue;

          const reserveData = await getReserve(pool.contractId, assetAddress);
          const position = await _buildEnrichedPosition({
            pool,
            positionType: kind.positionType,
            subtype: kind.subtype,
            reserveIndex,
            assetAddress,
            protocolTokenAmount,
            reserveData,
          });
          positions.push(position);
        }
      }
    } catch (e) {
      console.error(`[Blend] Error resolving positions for pool ${pool.contractId}:`, e.message);
    }
  }

  return positions;
}

// ── Adapter Interface ────────────────────────────────────────────────────────

const BlendAdapter = {
  protocolId: "blend",
  name: "Blend Protocol",
  type: "lending",

  isConfigured() {
    return getAllPools().length > 0;
  },

  /**
   * Get all Blend Protocol positions for a user.
   */
  async getPositions(userAddress) {
    if (!this.isConfigured()) return [];
    return resolveUserPositions(userAddress);
  },
};

module.exports = BlendAdapter;
