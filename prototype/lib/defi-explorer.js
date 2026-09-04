/**
 * DeFi Explorer — protocol & pool directory for the top-level "DeFi" tab.
 *
 * Answers "what DeFi exists on Stellar, how big is it, and what does it pay?"
 * for a newcomer. This is a DIRECTORY (protocol → pools ≥ TVL threshold),
 * not a portfolio tracker — no user addresses involved.
 *
 * Architecture mirrors rwa-yield-fetcher.js (the proven pattern in this repo):
 *   - One fetcher per protocol. Each returns a full protocol entry
 *     { ...meta, pools: [...] } or null on failure — never throws past
 *     its boundary.
 *   - Background refresh loop keeps a cache warm; the HTTP endpoint serves
 *     the cache instantly and never triggers network calls on the request
 *     path. Stale-grace: a failed refresh keeps the previous value up to
 *     24h so transient API outages don't blank the page.
 *   - Per-protocol refresh intervals reflect data-source cost:
 *       Aquarius / Upshift  (one HTTP call)      → every cycle (60s min gap)
 *       Blend               (~30 RPC calls)      → 5 min
 *       Sentora             (1 RPC call)         → 5 min
 *       SushiSwap           (universe 1h, data 5 min)
 *       Soroswap            (universe 1h, TVL 15 min — 214 pairs is heavy)
 *       Templar             (static card, refreshed daily for custody TVL)
 *
 * Data-source notes (validated live 2026-08-07, see PR description):
 *   - Aquarius API returns USD values in 7-DECIMAL FIXED POINT — divide by 1e7.
 *   - Sushi/Soroswap publish no APY on-chain (fee APR needs volume history
 *     behind gated APIs) → pools carry apy: null, UI renders "—".
 *   - Upshift API `tvl` field is USD (verified: on-chain vault buffer ≈ 5% of
 *     tvl, matching their reserve_target of 0.05).
 *   - Templar's lending logic lives on NEAR; Stellar custody ≈ $65K (below
 *     threshold) → card only, no pool rows.
 */

const { simulateContractCall, getTokenBalance, getTokenMetadata } = require("./soroban-rpc");
const pricingEngine = require("./pricing-engine");
const BlendAdapter = require("./adapters/blend");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, nativeToScVal, scValToNative } = StellarSdk;

// ── Config ──────────────────────────────────────────────────────────────────

const MIN_POOL_TVL_USD = Number(process.env.DEFI_EXPLORER_MIN_TVL_USD || 250_000);
const REFRESH_INTERVAL = 60_000;            // main loop tick
const STALE_GRACE = 24 * 60 * 60_000;       // serve stale values up to 24h on failure

const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const PYUSD_SAC = "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2";

// ── Protocol metadata (hand-written blurbs; pool notes are auto-generated) ──

const PROTOCOL_META = {
  blend: {
    id: "blend",
    name: "Blend",
    category: "Lending",
    url: "https://mainnet.blend.capital",
    blurb:
      "Stellar's main lending protocol. Supply assets to earn interest, or borrow against " +
      "your collateral. Each pool is isolated — problems in one pool can't spread to " +
      "others — and a shared \"backstop\" insurance layer absorbs bad debt first.",
  },
  aquarius: {
    id: "aquarius",
    name: "Aquarius",
    category: "AMM / DEX",
    url: "https://aqua.network",
    blurb:
      "Stellar's largest automated market maker (AMM). Deposit two tokens into a pool " +
      "and earn a share of every swap fee, plus AQUA token rewards on incentivized " +
      "pools. Pools come in three flavors: standard, stable (for pegged pairs), and " +
      "concentrated (higher capital efficiency, more active management).",
  },
  soroswap: {
    id: "soroswap",
    name: "Soroswap",
    category: "AMM / DEX",
    url: "https://soroswap.finance",
    blurb:
      "The first AMM built on Soroban, Stellar's smart contract platform. Classic " +
      "constant-product pools (like Uniswap V2): deposit a 50/50 pair, earn swap fees. " +
      "Also aggregates routes across other Stellar DEXes for best-price swaps.",
  },
  sushiswap: {
    id: "sushiswap",
    name: "SushiSwap V3",
    category: "AMM / DEX",
    url: "https://www.sushi.com/stellar/explore/pools",
    blurb:
      "The multichain DEX veteran, live on Stellar since early 2026 with V3 " +
      "concentrated liquidity: liquidity providers choose a price range for their " +
      "capital, earning more fees when trades happen inside it. More efficient than " +
      "classic pools, but needs more active management.",
  },
  upshift: {
    id: "upshift",
    name: "Upshift",
    category: "Yield Vaults",
    url: "https://app.upshift.finance",
    blurb:
      "Tokenized yield vaults. Deposit a single asset (USDC or XLM) and receive a " +
      "vault share token that grows in value as the vault's strategy earns yield. " +
      "The Gami vaults on Stellar route deposits to institutional strategies — " +
      "no pair management or lending decisions needed.",
  },
  sentora: {
    id: "sentora",
    name: "Sentora",
    category: "Yield Vaults",
    url: "https://stellardefihub.com/vaults",
    blurb:
      "Institutional DeFi infrastructure (part of the Stellar DeFi Hub initiative). " +
      "Three vaults take XLM, USDC or PYUSD deposits under a principal-escrow design, " +
      "each paying a reward rate published by Sentora and claimable at term end.",
  },
  templar: {
    id: "templar",
    name: "Templar",
    category: "Lending",
    url: "https://templarfi.org",
    blurb:
      "Cross-chain lending settled on NEAR: deposit USDC to earn yield, or borrow against collateral including Stellar assets (XLM, CETES, USTRY, deJAAA) bridged via HOT Omni. Rates float per market.",
  },
  k2: {
    id: "k2",
    name: "K2 Lend",
    category: "Lending",
    url: "https://app.k2lend.com",
    blurb:
      "Aave-V3-style lending on Soroban by Kinetic: supply USDC, XLM, PYUSD, or SolvBTC to earn interest, or borrow against your deposits. Isolated risk per reserve with RedStone oracles.",
  },
  etherfuse: {
    id: "etherfuse",
    name: "Etherfuse Stablebonds",
    category: "RWA Yield",
    url: "https://etherfuse.com",
    thresholdExempt: true,
    blurb:
      "Tokenized sovereign bonds (CETES, USTRY, EUROB, TESOURO, KTB) that accrue yield while you hold them. Below: every venue on Stellar where the bonds earn or trade — lending markets and AMM pools included regardless of size.",
  },
};

// ── Shared helpers ──────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _parallelMap(items, worker, concurrency = 5) {
  const out = new Array(items.length);
  let i = 0;
  async function pump() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (e) {
        if (/429|rate/i.test(e?.message || "")) {
          await _sleep(300 + Math.random() * 400);
          try { out[idx] = await worker(items[idx], idx); }
          catch { out[idx] = null; }
        } else { out[idx] = null; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pump));
  return out;
}

async function _priceToken(contractId) {
  try {
    const p = await pricingEngine.priceSorobanToken(contractId);
    return p && Number.isFinite(p.usd) ? p.usd : null;
  } catch { return null; }
}

async function _tokenSymbol(contractId) {
  try {
    if (contractId === XLM_SAC) return "XLM";
    const meta = await getTokenMetadata(contractId);
    return meta?.symbol || contractId.slice(0, 6) + "…";
  } catch { return contractId.slice(0, 6) + "…"; }
}

// Parse Aquarius "tokens_str" entries: "native" or "CODE:ISSUER".
function _aquaTokenCode(s) {
  if (!s || s === "native") return "XLM";
  return String(s).split(":")[0];
}

// ── Aquarius ────────────────────────────────────────────────────────────────

const AQUA_SCALE = 1e7; // ALL USD values in the Aquarius API are 7-dec fixed point

async function fetchAquarius() {
  const pools = [];
  let total = Infinity;
  let page = 1;
  let totalTvl = 0;
  let allCount = 0;

  while (pools.length + 0 < total && page <= 6) {
    const res = await fetch(`https://amm-api.aqua.network/pools/?page=${page}&size=100`, {
      headers: { "User-Agent": "StellarScope/1.0" },
    });
    if (!res.ok) throw new Error(`Aquarius HTTP ${res.status}`);
    const data = await res.json();
    total = data.total ?? 0;
    allCount = total;
    for (const p of data.items || []) {
      const tvl = Number(p.liquidity_usd || 0) / AQUA_SCALE;
      totalTvl += tvl;
        const codes = (p.tokens_str || []).map(_aquaTokenCode);
      const baseApy = Number(p.apy || 0);
      const rewardsApy = Number(p.rewards_apy || 0) + Number(p.incentive_apy || 0);
      const typeLabel = p.pool_type === "stable" ? "stable"
        : p.pool_type === "concentrated" ? "concentrated" : "standard";
      pools.push({
        assets: codes,
        name: codes.join(" / "),
        tvlUSD: tvl,
        apy: baseApy,                 // fraction (0.05 = 5%)
        rewardApy: rewardsApy || 0,   // fraction
        feePct: Number(p.fee || 0) * 100,
        poolType: typeLabel,
        address: p.address,
        url: `https://aqua.network/pools/${p.address}`,
        note: `${typeLabel === "stable" ? "Stable-pair" : typeLabel === "concentrated" ? "Concentrated-liquidity" : "Standard"} pool — ` +
          `provide ${codes.join(" + ")}, earn ${ (Number(p.fee || 0) * 100).toFixed(2) }% of each swap` +
          (rewardsApy > 0 ? " plus AQUA rewards." : "."),
      });
    }
    if ((data.items || []).length < 100) break;
    page += 1;
  }

  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.aquarius,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: allCount,
    hasApyData: true,
    pools,
  };
}

// ── Blend (delegates to the adapter's pool-overview export) ─────────────────

async function fetchBlend() {
  const overview = await BlendAdapter.getPoolsOverview();
  // overview: [{ name, contractId, reserves: [{symbol, suppliedUSD, borrowedUSD, supplyApy, borrowApy, utilization}] }]
  const pools = [];
  let totalTvl = 0;
  for (const p of overview) {
    const suppliedUSD = p.reserves.reduce((s, r) => s + (r.suppliedUSD || 0), 0);
    totalTvl += suppliedUSD;
    const assets = p.reserves.map((r) => r.symbol);
    pools.push({
      assets,
      name: p.name,
      tvlUSD: suppliedUSD,
      // A lending pool has per-reserve APYs, not one number; surface the range.
      apy: null,
      rewardApy: 0,
      reserves: p.reserves.map((r) => ({
        symbol: r.symbol,
        suppliedUSD: r.suppliedUSD,
        borrowedUSD: r.borrowedUSD,
        supplyApy: r.supplyApy,
        borrowApy: r.borrowApy,
        utilization: r.utilization,
      })),
      address: p.contractId,
      url: `https://mainnet.blend.capital/dashboard/?poolId=${p.contractId}`,
      note: `Lending market with ${assets.join(", ")} — supply any of these to earn ` +
        `interest, or borrow against your deposits. Rates float with utilization.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.blend,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: overview.length,
    hasApyData: true,
    apyStyle: "perReserve",
    pools,
  };
}

// ── SushiSwap V3 ────────────────────────────────────────────────────────────

const SUSHI_FACTORY = "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF";
// Token set from Sushi's own frontend bundle (validated live). Pools with
// tokens outside this set won't be discovered — acceptable v1 limitation,
// documented in the PR.
const SUSHI_TOKENS = {
  XLM: XLM_SAC,
  USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  EURC: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
  CETES: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV",
  USDY: "CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP",
  USTRY: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  SolvBTC: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN",
  xSolvBTC: "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J",
  PYUSD: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2",
};
const SUSHI_FEE_TIERS = [100, 500, 3000, 10000];
const SUSHI_UNIVERSE_TTL = 60 * 60_000; // pool set changes rarely

let _sushiUniverse = { pools: [], ts: 0 };

async function _sushiPoolUniverse() {
  const now = Date.now();
  if (_sushiUniverse.pools.length > 0 && now - _sushiUniverse.ts < SUSHI_UNIVERSE_TTL) {
    return _sushiUniverse.pools;
  }
  const names = Object.keys(SUSHI_TOKENS);
  const combos = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      for (const fee of SUSHI_FEE_TIERS) {
        combos.push({ a: names[i], b: names[j], fee });
      }
    }
  }
  const found = [];
  // Sequential with a small delay — 144 read-only simulations; keep RPC happy.
  for (const c of combos) {
    try {
      const raw = await simulateContractCall(SUSHI_FACTORY, "get_pool", [
        new Address(SUSHI_TOKENS[c.a]).toScVal(),
        new Address(SUSHI_TOKENS[c.b]).toScVal(),
        nativeToScVal(c.fee, { type: "u32" }),
      ]);
      const addr = scValToNative(raw);
      if (addr && String(addr).startsWith("C")) {
        found.push({ pair: [c.a, c.b], fee: c.fee, address: addr });
      }
    } catch { /* no pool at this combo */ }
    await _sleep(50);
  }
  if (found.length > 0) _sushiUniverse = { pools: found, ts: now };
  return _sushiUniverse.pools;
}

async function fetchSushi() {
  const universe = await _sushiPoolUniverse();
  const pools = [];
  let totalTvl = 0;

  const rows = await _parallelMap(universe, async (u) => {
    const [symA, symB] = u.pair;
    const [balARaw, balBRaw] = await Promise.all([
      getTokenBalance(SUSHI_TOKENS[symA], u.address),
      getTokenBalance(SUSHI_TOKENS[symB], u.address),
    ]);
    const [priceA, priceB] = await Promise.all([
      _priceToken(SUSHI_TOKENS[symA]),
      _priceToken(SUSHI_TOKENS[symB]),
    ]);
    // All Sushi-bundled tokens are 7-dec SACs except Solv (8) — read decimals
    // properly via metadata to stay correct.
    const [metaA, metaB] = await Promise.all([
      getTokenMetadata(SUSHI_TOKENS[symA]).catch(() => null),
      getTokenMetadata(SUSHI_TOKENS[symB]).catch(() => null),
    ]);
    const decA = metaA?.decimals ?? 7;
    const decB = metaB?.decimals ?? 7;
    const amtA = Number(balARaw || 0n) / 10 ** decA;
    const amtB = Number(balBRaw || 0n) / 10 ** decB;
    const tvl = (priceA ? amtA * priceA : 0) + (priceB ? amtB * priceB : 0);
    return { ...u, symA, symB, tvl };
  });

  for (const r of rows) {
    if (!r) continue;
    totalTvl += r.tvl;
    const feePct = r.fee / 10000;
    pools.push({
      assets: [r.symA, r.symB],
      name: `${r.symA} / ${r.symB} (${feePct}%)`,
      tvlUSD: r.tvl,
      apy: null, // fee APR needs volume history — not available on-chain
      rewardApy: 0,
      feePct,
      address: r.address,
      url: "https://www.sushi.com/stellar/explore/pools",
      note: `Concentrated-liquidity pool — provide ${r.symA} + ${r.symB} in a price ` +
        `range you choose; earn ${feePct}% of swaps that execute in range.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.sushiswap,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: universe.length,
    hasApyData: false,
    apyNote: "Fee APY requires trade-volume data SushiSwap doesn't publish on-chain.",
    pools,
  };
}

// ── Soroswap ────────────────────────────────────────────────────────────────

const SOROSWAP_FACTORY = "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2";
const SOROSWAP_UNIVERSE_TTL = 60 * 60_000;

let _soroswapUniverse = { pairs: [], ts: 0 };

async function _soroswapPairUniverse() {
  const now = Date.now();
  if (_soroswapUniverse.pairs.length > 0 && now - _soroswapUniverse.ts < SOROSWAP_UNIVERSE_TTL) {
    return _soroswapUniverse.pairs;
  }
  const lenRaw = await simulateContractCall(SOROSWAP_FACTORY, "all_pairs_length");
  const total = Number(scValToNative(lenRaw));
  if (!Number.isFinite(total) || total <= 0) return _soroswapUniverse.pairs;

  const idxs = Array.from({ length: total }, (_, i) => i);
  const addrs = await _parallelMap(idxs, async (i) => {
    const r = await simulateContractCall(SOROSWAP_FACTORY, "all_pairs", [
      nativeToScVal(i, { type: "u32" }),
    ]);
    return scValToNative(r);
  });

  // Resolve token ids per pair (cache these with the universe — they never change)
  const pairs = await _parallelMap(addrs.filter(Boolean), async (addr) => {
    const [t0raw, t1raw] = await Promise.all([
      simulateContractCall(addr, "token_0"),
      simulateContractCall(addr, "token_1"),
    ]);
    return { address: addr, token0: scValToNative(t0raw), token1: scValToNative(t1raw) };
  });

  const clean = pairs.filter(Boolean);
  if (clean.length > 0) _soroswapUniverse = { pairs: clean, ts: now };
  return _soroswapUniverse.pairs;
}

async function fetchSoroswap() {
  const universe = await _soroswapPairUniverse();
  const pools = [];
  let totalTvl = 0;

  const rows = await _parallelMap(universe, async (p) => {
    // Price first — most Soroswap pairs hold unpriceable junk tokens; skip
    // reserve reads for those to save RPC budget.
    const [price0, price1] = await Promise.all([
      _priceToken(p.token0),
      _priceToken(p.token1),
    ]);
    if (price0 == null && price1 == null) return null;

    const resRaw = await simulateContractCall(p.address, "get_reserves");
    const reserves = scValToNative(resRaw);
    const [meta0, meta1] = await Promise.all([
      getTokenMetadata(p.token0).catch(() => null),
      getTokenMetadata(p.token1).catch(() => null),
    ]);
    const dec0 = meta0?.decimals ?? 7;
    const dec1 = meta1?.decimals ?? 7;
    const amt0 = Number(reserves?.[0] ?? 0n) / 10 ** dec0;
    const amt1 = Number(reserves?.[1] ?? 0n) / 10 ** dec1;

    // If only one side has a price, double it (balanced constant-product pool)
    let tvl;
    if (price0 != null && price1 != null) tvl = amt0 * price0 + amt1 * price1;
    else if (price0 != null) tvl = amt0 * price0 * 2;
    else tvl = amt1 * price1 * 2;

    const normSym = (meta, tok) => {
      const s = meta?.symbol;
      if (!s || s === "native") return tok === XLM_SAC ? "XLM" : (s || tok.slice(0, 6) + "…");
      return s;
    };
    const sym0 = normSym(meta0, p.token0);
    const sym1 = normSym(meta1, p.token1);
    return { ...p, sym0, sym1, tvl };
  }, 4);

  for (const r of rows) {
    if (!r) continue;
    totalTvl += r.tvl;
    pools.push({
      assets: [r.sym0, r.sym1],
      name: `${r.sym0} / ${r.sym1}`,
      tvlUSD: r.tvl,
      apy: null, // volume-based fee APR not available on-chain
      rewardApy: 0,
      feePct: 0.3, // Soroswap standard pair fee
      address: r.address,
      url: "https://soroswap.finance",
      note: `Classic 50/50 pool — provide equal values of ${r.sym0} + ${r.sym1}, ` +
        `earn 0.3% of every swap.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.soroswap,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: universe.length,
    hasApyData: false,
    apyNote: "Fee APY requires trade-volume data Soroswap serves only via a gated API.",
    pools,
  };
}

// ── Upshift ─────────────────────────────────────────────────────────────────

async function fetchUpshift() {
  const res = await fetch("https://api.upshift.finance/v1/tokenized_vaults", {
    headers: { "User-Agent": "StellarScope/1.0" },
  });
  if (!res.ok) throw new Error(`Upshift HTTP ${res.status}`);
  const all = await res.json();
  const vaults = (Array.isArray(all) ? all : []).filter(
    (v) => v.chain_type === "stellar" && v.is_visible
  );
  const pools = [];
  let totalTvl = 0;
  for (const v of vaults) {
    const tvl = Number(v.tvl || v.latest_reported_tvl || 0); // USD (verified)
    totalTvl += tvl;
    const apy = Number(v.reported_apy?.apy ?? 0) || null;
    const meta = v.stellar_vault_metadata || {};
    const depositSym = meta.deposit_token_symbol || "?";
    pools.push({
      assets: [depositSym],
      name: v.vault_name,
      tvlUSD: tvl,
      apy,
      rewardApy: 0,
      address: v.address,
      url: "https://app.upshift.finance",
      note: `Single-asset vault — deposit ${depositSym}, receive shares that grow ` +
        `as the strategy earns. No pair management needed.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.upshift,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: vaults.length,
    hasApyData: true,
    pools,
  };
}

// ── Sentora ─────────────────────────────────────────────────────────────────

// Sentora runs three vaults on the Stellar DeFi Hub, all the same contract
// type (identical WASM ca6b85a1…, same deployer). Reward rates are the ones
// Sentora publishes on stellardefihub.com/vaults — they are set by the
// curator off-chain, so they are quoted, not derived.
const SENTORA_VAULTS = [
  { asset: "XLM",   token: XLM_SAC,   vault: "CA54LVHMAY7HGLMVPN4W72XJB4OGKVZBZX26FWN6JD4P3HJFWQUQEHJO", rewardRate: 0.05, endsOn: "2026-11-09" },
  { asset: "USDC",  token: USDC_SAC,  vault: "CAHEWHOPPDBQYFMAOLDOXXGUX2BCR7EXP4CWYCRY3NEAJB35YPZMMJFF", rewardRate: 0.08, endsOn: "2026-11-19" },
  { asset: "PYUSD", token: PYUSD_SAC, vault: "CAQRAXBU6G4AAX4BZ7R4WLB62TSVAQFS5ZXJDVXRLAU2NZ2ZTGU5QOYB", rewardRate: 0.08, endsOn: "2026-11-19" },
];
const SENTORA_URL = "https://stellardefihub.com/vaults";

async function fetchSentora() {
  const pools = [];
  let totalTvl = 0;
  for (const v of SENTORA_VAULTS) {
    let tvl = 0;
    try {
      const balRaw = await getTokenBalance(v.token, v.vault);
      const meta = await getTokenMetadata(v.token).catch(() => null);
      const dec = meta?.decimals ?? 7;
      const amt = Number(balRaw || 0n) / 10 ** dec;
      const price = (await _priceToken(v.token)) || 0;
      tvl = amt * price;
    } catch (e) {
      continue; // a vault we cannot read is omitted rather than shown as zero
    }
    totalTvl += tvl;
    pools.push({
      assets: [v.asset],
      name: `Sentora ${v.asset} Vault`,
      tvlUSD: tvl,
      // Sentora's published reward rate, not an on-chain derivation.
      apy: v.rewardRate,
      apySource: "quoted",
      rewardApy: 0,
      address: v.vault,
      url: SENTORA_URL,
      note: `Deposit ${v.asset} for a ${(v.rewardRate * 100).toFixed(2)}% reward rate ` +
        `published by Sentora, paid in ${v.asset} and claimable at term end ` +
        `(${v.endsOn}). Early withdrawal forfeits accrued rewards.`,
    });
  }
  pools.sort((a, b) => (b.tvlUSD || 0) - (a.tvlUSD || 0));
  return {
    ...PROTOCOL_META.sentora,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: SENTORA_VAULTS.length,
    hasApyData: true,
    apyNote: "Reward rates are published by Sentora (the curator) and quoted here as-is; they are not derived on-chain.",
    metricLabel: "Total TVL",
    pools,
  };
}

// ── Templar (markets + snapshots APIs; NEAR-settled, Stellar collateral) ────

// CoinGecko ids — every id below verified live against /simple/price on
// 2026-08-17. (The previous set used ticker-style ids like "ltc"/"ada"/"xrp"
// that CoinGecko doesn't recognize, and "doge" which resolves to an
// unrelated token — those collateral legs priced at $0 or garbage.)
const TEMPLAR_CG_IDS = {
  ibtc: "bitcoin", ixlm: "stellar", izec: "zcash", ixrp: "ripple",
  idoge: "dogecoin", iltc: "litecoin", iada: "cardano",
  iethhemibtc: "hemi-bitcoin",
  iethwbtc: "bitcoin",
  // FXRP is Flare's 1:1 XRP-backed wrapper — no CoinGecko listing; XRP ≈ fair
  iethfxrp: "ripple",
  stnear: "staked-near", // stNEAR trades ~1.5x NEAR — "near" underpriced it
  ixlmsolvbtc: "bitcoin", ixlmcetes: "cetes", ixlmustry: "etherfuse-ustry",
  // deJAAA / deJTRSY have no CoinGecko listing — priced via our own
  // pricing engine below using their Soroban contract ids.
  ixlmdejaaa: "soroban:dejaaa", ixlmdejtrsy: "soroban:dejtrsy",
};

// Soroban contract ids for collateral tokens CoinGecko doesn't list
// (sourced from rwa-catalog.json).
const TEMPLAR_SOROBAN_PRICE_IDS = {
  "soroban:dejaaa": "CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL",
  "soroban:dejtrsy": "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV",
};
const TEMPLAR_STABLE_BORROW = new Set(["usdc", "ixlmusdc", "iethusdc", "ixlmpyusd", "pyusd"]);

function templarSlugParts(deployment) {
  // e.g. "ixlm-ixlmusdc-1.v1.tmplr.near" -> { collat: "ixlm", borrow: "ixlmusdc" }
  const stem = deployment.split(".")[0].replace(/-\d+$/, "");
  const dash = stem.indexOf("-");
  return { collat: stem.slice(0, dash), borrow: stem.slice(dash + 1) };
}

function templarPretty(sym) {
  const map = {
    ibtc: "BTC", ixlm: "XLM", izec: "ZEC", ixrp: "XRP", idoge: "DOGE", iltc: "LTC",
    iada: "ADA", iethhemibtc: "hemiBTC", iethwbtc: "WBTC", iethfxrp: "FXRP",
    stnear: "stNEAR", ixlmusdc: "USDC", iethusdc: "USDC", ixlmpyusd: "PYUSD",
    ixlmsolvbtc: "SolvBTC", ixlmcetes: "CETES", ixlmustry: "USTRY",
    ixlmdejaaa: "deJAAA", ixlmdejtrsy: "deJTRSY",
  };
  return map[sym] || sym.toUpperCase();
}

async function fetchTemplar() {
  const [marketsRes, snapsRes] = await Promise.all([
    fetch("https://app.templarfi.org/api/markets", { signal: AbortSignal.timeout(15000) }),
    fetch("https://app.templarfi.org/api/snapshots?domain=app", { signal: AbortSignal.timeout(15000) }),
  ]);
  if (!marketsRes.ok || !snapsRes.ok) throw new Error("templar api unavailable");
  const marketsJson = await marketsRes.json();
  const snapsJson = await snapsRes.json();
  const configs = new Map();
  for (const m of marketsJson.markets || []) configs.set(m.deployment, m);

  // Price the collateral legs via CoinGecko (verified id set above)
  const cgIds = [
    ...new Set(Object.values(TEMPLAR_CG_IDS).filter((id) => !id.startsWith("soroban:"))),
  ].join("%2C");
  let prices = { ...(fetchTemplar._lastPrices || {}) };
  try {
    const pr = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (pr.ok) {
      const fresh = await pr.json();
      prices = { ...prices, ...fresh };
      fetchTemplar._lastPrices = prices;
    }
  } catch (_) {}
  // Belt-and-braces: XLM price from our own pricing engine if CG failed
  if (!prices.stellar?.usd) {
    try {
      const { priceSorobanToken } = require("./pricing-engine");
      const p = await priceSorobanToken("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA");
      if (p?.usd) prices.stellar = { usd: p.usd };
    } catch (_) {}
  }

  // Stellar-side collateral tokens CoinGecko doesn't list (deJAAA, deJTRSY):
  // price through our own engine (SDEX / Soroswap aggregator).
  for (const [key, contractId] of Object.entries(TEMPLAR_SOROBAN_PRICE_IDS)) {
    if (prices[key]?.usd) continue; // cached from a previous cycle
    try {
      const { priceSorobanToken } = require("./pricing-engine");
      const p = await priceSorobanToken(contractId);
      if (p?.usd) {
        prices[key] = { usd: p.usd };
        fetchTemplar._lastPrices = prices;
      }
    } catch (_) {}
  }

  const pools = [];
  let totalTvl = 0;
  for (const entry of snapsJson.marketSnapshots || []) {
    const dep = entry.deployment || "";
    if (dep.startsWith("liqtest")) continue;
    const { collat, borrow } = templarSlugParts(dep);
    const cfg = configs.get(dep);
    const snap = entry.snapshot || {};

    const borrowDepositsUSD = TEMPLAR_STABLE_BORROW.has(borrow)
      ? Number(entry.totalDepositsRaw || 0)
      : Number(entry.totalDepositsRaw || 0) *
        (prices[TEMPLAR_CG_IDS[borrow]]?.usd || 0);

    const collatDecimals =
      cfg?.configuration?.price_oracle_configuration?.collateral_asset_decimals ?? 8;
    const collatUnits = Number(snap.collateral_asset_deposited || 0) / 10 ** collatDecimals;
    const collatPrice = prices[TEMPLAR_CG_IDS[collat]]?.usd || 0;
    const collatUSD = collatUnits * collatPrice;

    const tvl = borrowDepositsUSD + collatUSD;
    if (!(tvl > 0)) continue;

    const supplyApy = Number(entry.yield || 0);
    const borrowApr = Number(snap.interest_rate || 0);
    const stellarSide = /xlm|cetes|ustry|dejaaa|dejtrsy/.test(collat + borrow);

    // Templar is cross-chain (NEAR-settled); this is a Stellar dashboard and
    // the card is labeled "TVL on Stellar" — only Stellar-side markets count
    // toward the headline number. Non-Stellar markets stay listed for
    // completeness but are excluded from the total.
    if (stellarSide) totalTvl += tvl;

    pools.push({
      assets: [templarPretty(borrow), templarPretty(collat)],
      name: `${templarPretty(borrow)} / ${templarPretty(collat)}`,
      tvlUSD: tvl,
      apy: supplyApy,
      rewardApy: 0,
      note:
        `Supply ${templarPretty(borrow)} to earn ${(supplyApy * 100).toFixed(2)}%; ` +
        `borrow against ${templarPretty(collat)} at ${(borrowApr * 100).toFixed(2)}% APR. ` +
        `$${Math.round(Number(entry.availableBalance || 0)).toLocaleString()} available to borrow.` +
        (stellarSide ? " Stellar-side assets." : " Non-Stellar deployment — excluded from Stellar TVL."),
      detail: {
        supplyApy, borrowApr,
        depositsUSD: borrowDepositsUSD,
        collateralUSD: collatUSD,
        availableUSD: Number(entry.availableBalance || 0),
      },
    });
  }
  pools.sort((a, b) => (b.tvlUSD || 0) - (a.tvlUSD || 0));

  return {
    ...PROTOCOL_META.templar,
    totalTvlUSD: totalTvl,
    poolsTotal: pools.length,
    hasApyData: true,
    pools,
  };
}
// ── Refresh orchestration ───────────────────────────────────────────────────

// protocolId -> { ts, value, error, lastAttempt }
const cache = new Map();

// ── K2 Lend (Aave-V3 port on Soroban by Kinetic) ────────────────────────────
// Rates and indexes are RAY-scaled (1e27) — verified live 2026-08-14 against
// app.k2lend.com (SolvBTC reserve: 0.10228 on-chain == 10.23% in their UI).

const K2_ROUTER =
  process.env.K2_ROUTER_CONTRACT ||
  "CCTUJZLYFAW7ZNQD2SXMUZIHBUUJJICYRKWLZJ6SK6TGNAWNXOJIV6J7";
const K2_RAY = 1e27;

async function k2View(contractId, method, args = []) {
  const rpc = require("./soroban-rpc");
  const { scValToNative } = require("@stellar/stellar-sdk");
  const r = await rpc.simulateContractCall(contractId, method, args);
  return r == null ? null : scValToNative(r);
}

async function fetchK2() {
  const { Address } = require("@stellar/stellar-sdk");
  const { priceSorobanToken } = require("./pricing-engine");
  const assets = await k2View(K2_ROUTER, "get_reserves_list");
  if (!Array.isArray(assets) || !assets.length) throw new Error("k2 reserves unavailable");

  const reserves = [];
  let supplied = 0, borrowed = 0;
  for (const asset of assets) {
    const d = await k2View(K2_ROUTER, "get_reserve_data", [new Address(asset).toScVal()]);
    if (!d) continue;
    let symbol = asset.slice(0, 4), decimals = 7;
    try { symbol = String(await k2View(asset, "symbol")).replace(/\0+$/, ""); } catch (_) {}
    if (symbol === "native") symbol = "XLM";
    try { decimals = Number(await k2View(asset, "decimals")); } catch (_) {}
    const denom = 10 ** decimals;
    const liqIdx = Number(d.liquidity_index) / K2_RAY;
    const borIdx = Number(d.variable_borrow_index) / K2_RAY;
    let aSupply = 0n, dSupply = 0n;
    try { aSupply = BigInt(await k2View(d.a_token_address, "total_supply")); } catch (_) {}
    try { dSupply = BigInt(await k2View(d.debt_token_address, "total_supply")); } catch (_) {}
    const suppliedUnits = (Number(aSupply) / denom) * liqIdx;
    const borrowedUnits = (Number(dSupply) / denom) * borIdx;
    let usd = null;
    // Second arg is an OPTIONS object ({ decimals }) — passing the symbol
    // string silently defaulted decimals to 7 on aggregator-fallback pricing.
    try { const p = await priceSorobanToken(asset, { decimals }); usd = p && p.usd != null ? p.usd : null; } catch (_) {}
    const suppliedUSD = usd != null ? suppliedUnits * usd : 0;
    const borrowedUSD = usd != null ? borrowedUnits * usd : 0;
    supplied += suppliedUSD;
    borrowed += borrowedUSD;
    reserves.push({
      symbol,
      suppliedUSD,
      borrowedUSD,
      supplyApy: Number(d.current_liquidity_rate) / K2_RAY,
      borrowApy: Number(d.current_variable_borrow_rate) / K2_RAY,
      utilization: suppliedUnits > 0 ? borrowedUnits / suppliedUnits : 0,
    });
  }

  return {
    ...PROTOCOL_META.k2,
    totalTvlUSD: supplied,
    poolsTotal: 1,
    hasApyData: true,
    pools: [{
      assets: reserves.map((r) => r.symbol),
      name: "Primary Market",
      tvlUSD: supplied,
      apy: null,
      rewardApy: 0,
      note: "Lending market — supply any listed asset to earn interest, or borrow against your deposits. Rates float with utilization.",
      reserves,
    }],
  };
}

// ── Etherfuse Stablebonds (aggregator: every Stellar venue holding the bonds) ─
// Reads the already-cached snapshots of other venues plus the RWA yield feed;
// registered last in FETCHERS so those caches are warm. Threshold-exempt.

const ETHERFUSE_SYMBOLS = ["CETES", "USTRY", "EUROB", "TESOURO", "KTB", "MXNE", "MXNe"];

function etherfuseMatch(name) {
  const up = String(name || "").toUpperCase();
  return ETHERFUSE_SYMBOLS.some((s) => up.includes(s.toUpperCase()));
}

async function fetchEtherfuse() {
  const pools = [];
  let totalTvl = 0;

  // 1) Bond yields from the RWA feed (issuance APY per bond).
  // rwa-yields.json nests entries under the top-level "stats" key, slugged
  // like "cetes-gcryug", with yield7d as a percent STRING ("4.88%") — there
  // is no numeric apy field. Read fresh from disk (the yield fetcher
  // rewrites the file at runtime; require() would serve a stale cache).
  let bondApy = {};
  try {
    const fs = require("fs");
    const path = require("path");
    const rwa = JSON.parse(
      fs.readFileSync(path.join(__dirname, "rwa-yields.json"), "utf8")
    );
    for (const [key, v] of Object.entries(rwa.stats || {})) {
      const up = key.toUpperCase();
      for (const s of ETHERFUSE_SYMBOLS) {
        if (!up.startsWith(s.toUpperCase() + "-")) continue;
        const raw = v && (v.apy ?? v.yield7d);
        const pct = typeof raw === "string" ? parseFloat(raw) : typeof raw === "number" ? raw : NaN;
        // fmtApy renders fractions (0.0488 → "4.88%")
        if (Number.isFinite(pct)) bondApy[s.toUpperCase()] = pct / 100;
      }
    }
  } catch (_) {}

  // 2) Cross-venue sweep of cached snapshots (blend reserves, AMM pairs)
  for (const venueId of ["blend", "aquarius", "soroswap"]) {
    const entry = cache.get(venueId);
    const venue = entry && entry.value;
    if (!venue || !Array.isArray(venue.pools)) continue;
    for (const pool of venue.pools) {
      const hitPool = etherfuseMatch(pool.name) || (pool.assets || []).some(etherfuseMatch);
      const hitReserves = (pool.reserves || []).some((r) => etherfuseMatch(r.symbol));
      if (!hitPool && !hitReserves) continue;
      const tvl = hitPool ? (pool.tvlUSD || 0)
        : (pool.reserves || []).filter((r) => etherfuseMatch(r.symbol))
            .reduce((s, r) => s + (r.suppliedUSD || 0), 0);
      totalTvl += tvl;
      pools.push({
        assets: pool.assets || [],
        name: `${pool.name} — via ${PROTOCOL_META[venueId].name}`,
        tvlUSD: tvl,
        apy: pool.apy ?? null,
        rewardApy: pool.rewardApy || 0,
        note: hitPool
          ? `Stablebond liquidity on ${PROTOCOL_META[venueId].name}. ${pool.note || ""}`.trim()
          : `Stablebond reserves inside this ${PROTOCOL_META[venueId].name} lending pool.`,
      });
    }
  }

  // 3) Standalone bond rows so every bond and its hold-to-earn APY is visible
  for (const s of ["CETES", "USTRY", "EUROB", "TESOURO", "KTB"]) {
    if (bondApy[s] == null) continue;
    pools.push({
      assets: [s],
      name: `${s} stablebond (hold to earn)`,
      tvlUSD: 0,
      apy: bondApy[s],
      rewardApy: 0,
      note: "Yield accrues to the token itself — no pool needed. Buy on the DEX or mint at etherfuse.com.",
    });
  }

  pools.sort((a, b) => (b.tvlUSD || 0) - (a.tvlUSD || 0));
  return {
    ...PROTOCOL_META.etherfuse,
    totalTvlUSD: totalTvl,
    poolsTotal: pools.length,
    hasApyData: true,
    pools,
  };
}

const FETCHERS = [
  { id: "blend", fn: fetchBlend, interval: 5 * 60_000 },
  { id: "aquarius", fn: fetchAquarius, interval: 60_000 },
  { id: "soroswap", fn: fetchSoroswap, interval: 15 * 60_000 },
  { id: "sushiswap", fn: fetchSushi, interval: 5 * 60_000 },
  { id: "upshift", fn: fetchUpshift, interval: 60_000 },
  { id: "sentora", fn: fetchSentora, interval: 5 * 60_000 },
  { id: "templar", fn: fetchTemplar, interval: 10 * 60_000 },
  { id: "k2", fn: fetchK2, interval: 5 * 60_000 },
  { id: "etherfuse", fn: fetchEtherfuse, interval: 5 * 60_000 },
];

let _refreshing = false;

async function refreshOnce() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    for (const f of FETCHERS) {
      const entry = cache.get(f.id);
      const due = !entry || Date.now() - (entry.lastAttempt || 0) >= f.interval;
      if (!due) continue;
      const prev = entry || {};
      cache.set(f.id, { ...prev, lastAttempt: Date.now() });
      try {
        const value = await f.fn();
        cache.set(f.id, { ts: Date.now(), value, error: null, lastAttempt: Date.now() });
      } catch (e) {
        const stale = prev.value && Date.now() - (prev.ts || 0) < STALE_GRACE;
        cache.set(f.id, {
          ts: prev.ts || 0,
          value: stale ? prev.value : null,
          error: e.message?.slice(0, 200) || "fetch failed",
          lastAttempt: Date.now(),
        });
        console.warn(`[defi-explorer] ${f.id} refresh failed: ${e.message?.slice(0, 120)}`);
      }
    }
  } finally {
    _refreshing = false;
  }
}

function start() {
  refreshOnce().catch(() => {});
  setInterval(() => refreshOnce().catch(() => {}), REFRESH_INTERVAL);
}

// ── Public read API (request path — cache only, never fetches) ──────────────


// ── Deep links to each pool on its own protocol's site ──────────────────
// VERIFIED patterns (read from each app's client-side router):
//   Blend    pathname "/dashboard", query { poolId }   -> /dashboard?poolId=<C…>
//   Aquarius route table amm.pool = ":poolAddress"     -> /pools/<C…>
// Everything else intentionally links to the protocol's pool/vault list:
// those apps are client-rendered and a wrong path returns HTTP 200 with an
// empty page, so a guessed deep link would fail silently. Better a correct
// list page than a broken direct link.
function poolDeepLink(protocolId, pool) {
  const addr = pool && (pool.address || pool.poolContractId);
  switch (protocolId) {
    case "blend":
      return addr ? `https://mainnet.blend.capital/dashboard?poolId=${addr}` : "https://mainnet.blend.capital";
    case "aquarius":
      return addr ? `https://aqua.network/pools/${addr}` : "https://aqua.network/pools";
    case "sentora":
      return "https://stellardefihub.com/vaults";
    case "templar":
      return "https://app.templarfi.org/markets";
    case "upshift":
      return "https://app.upshift.finance";
    case "k2":
      return "https://app.k2lend.com/#markets";
    case "sushiswap":
      return "https://www.sushi.com/stellar/explore/pools";
    case "soroswap":
      return "https://soroswap.finance";
    default:
      return null;
  }
}

function getSnapshot(opts = {}) {
  const includeAll = Boolean(opts.full);
  const protocols = [];
  for (const f of FETCHERS) {
    const entry = cache.get(f.id);
    if (entry?.value) {
      const v = entry.value;
      const exempt = Boolean(PROTOCOL_META[f.id]?.thresholdExempt);
      // Fetchers keep ALL pools (sorted desc); the threshold is applied here
      // so the summary stays clean while detail pages can show everything.
      const sorted = [...(v.pools || [])].sort((a, b) => (b.tvlUSD || 0) - (a.tvlUSD || 0));
      // The floor applies to EVERY non-exempt pool. (A blanket `|| p.reserves`
      // exemption let permissionless dust/spam Blend pools into the default
      // view — and into the index page's "Top APY" cell.)
      const visible = exempt ? sorted : sorted.filter((p) => (p.tvlUSD || 0) >= MIN_POOL_TVL_USD);
      // Attach a link to each pool on the protocol's own site. Pool-level
      // `url` set by a fetcher wins; otherwise derive it.
      const withLinks = (list) => list.map((p) => ({ ...p, url: p.url || poolDeepLink(f.id, p) }));
      protocols.push({
        ...v,
        pools: includeAll ? withLinks(sorted) : withLinks(visible),
        poolsShown: visible.length,
        poolsTotal: v.poolsTotal ?? sorted.length,
        lastUpdated: entry.ts ? new Date(entry.ts).toISOString() : null,
        stale: entry.error != null,
      });
    } else {
      // Not yet loaded (first boot) or hard-failed past grace — surface the
      // card with meta so the page structure is complete.
      protocols.push({
        ...PROTOCOL_META[f.id],
        totalTvlUSD: null,
        poolsShown: 0,
        poolsTotal: null,
        pools: [],
        loading: entry?.error == null,
        error: entry?.error || null,
        lastUpdated: null,
      });
    }
  }
  // Highest-TVL protocols first (nulls last)
  protocols.sort((a, b) => (b.totalTvlUSD || -1) - (a.totalTvlUSD || -1));
  return {
    thresholdUSD: MIN_POOL_TVL_USD,
    protocols,
    generatedAt: new Date().toISOString(),
  };
}

function getProtocolDetail(id) {
  const snap = getSnapshot({ full: true });
  return snap.protocols.find((p) => p.id === id) || null;
}

module.exports = { start, getSnapshot, getProtocolDetail, refreshOnce, MIN_POOL_TVL_USD };
