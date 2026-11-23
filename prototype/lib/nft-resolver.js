/**
 * NFT Resolver for Stellar
 *
 * Stellar has no formal NFT standard analogous to ERC-721. NFTs are most commonly
 * issued as classic Stellar assets with a small fixed supply (often 1), and rich
 * metadata published via SEP-1 (stellar.toml) — with SEP-39 extending the
 * [[CURRENCIES]] entry with NFT-specific fields like `nft_uri`, `nft_animation_url`,
 * `nft_metadata_url`, etc.
 *
 * This module:
 *   1. Classifies which of an account's classic-asset balances look like NFTs
 *      (heuristic, with a confidence score).
 *   2. Resolves the issuer's home_domain → stellar.toml → [[CURRENCIES]] entry
 *      for matching `code`, returning name/image/description if available.
 *   3. Falls back gracefully when the issuer publishes no toml or the entry
 *      isn't found — we still surface the holding so the user sees something.
 *
 * Detection signals (any one alone is weak; combined they're decent):
 *   - balance amount is exactly "1" or "0.0000001" (the stroop-NFT pattern)
 *   - Horizon `/assets` reports very low supply (1 — 100) and few holders
 *   - SDEX has no orderbook for the asset (NFTs aren't traded as fungibles)
 *   - issuer has a home_domain
 *   - stellar.toml CURRENCIES entry has `is_unlimited = false` and `fixed_number`
 *     is small, OR explicit nft_* fields (SEP-39)
 *
 * We are explicit about confidence so the UI can show a "Maybe NFT" label
 * for borderline cases.
 */

const { classicSupply } = require("./horizon-supply");

const SUPPLY_NFT_CUTOFF = 100;             // assets with total supply <= this are candidate NFTs
const HOLDERS_NFT_CUTOFF = 100;            // and few holders
const TOML_FETCH_TIMEOUT_MS = 4000;        // don't hang the request on slow issuer sites
const TOML_CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes — issuer tomls are stable

// In-memory cache of resolved tomls keyed by domain.
const tomlCache = new Map();

// Cache of asset stat lookups keyed by `${code}:${issuer}`.
const assetStatCache = new Map();
const ASSET_STAT_TTL_MS = 5 * 60 * 1000;

/**
 * Minimal TOML parser for the subset SEP-1 uses: top-level scalars and
 * [[array-of-tables]] sections with scalar fields. We deliberately do not pull
 * in a full TOML library to keep the dependency surface small. This handles the
 * common cases; anything we can't parse we skip silently.
 */
function parseStellarToml(text) {
  const out = { _top: {} };
  let currentSection = "_top";
  let currentIsArray = false;

  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim(); // strip comments
    if (!line) continue;

    // [[CURRENCIES]] or [DOCUMENTATION]
    const arrSection = line.match(/^\[\[([A-Za-z0-9_]+)\]\]$/);
    const objSection = line.match(/^\[([A-Za-z0-9_]+)\]$/);
    if (arrSection) {
      currentSection = arrSection[1];
      currentIsArray = true;
      if (!Array.isArray(out[currentSection])) out[currentSection] = [];
      out[currentSection].push({});
      continue;
    }
    if (objSection) {
      currentSection = objSection[1];
      currentIsArray = false;
      if (!out[currentSection] || Array.isArray(out[currentSection])) {
        out[currentSection] = {};
      }
      continue;
    }

    // key = value  (only scalars; ignore inline tables/arrays)
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2];

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value === "true" || value === "false") {
      value = value === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    // Anything else (arrays, inline tables) — leave as string; we don't need them.

    const target = currentIsArray
      ? out[currentSection][out[currentSection].length - 1]
      : (out[currentSection] ||= {});
    target[key] = value;
  }
  return out;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchToml(domain) {
  if (!domain) return null;
  const cached = tomlCache.get(domain);
  if (cached && Date.now() - cached.ts < TOML_CACHE_TTL_MS) return cached.toml;

  const url = `https://${domain}/.well-known/stellar.toml`;
  try {
    const res = await fetchWithTimeout(url, TOML_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      tomlCache.set(domain, { toml: null, ts: Date.now() });
      return null;
    }
    const text = await res.text();
    // Guard against issuers serving HTML 200s for missing files
    if (text.length > 256 * 1024 || /^\s*</.test(text)) {
      tomlCache.set(domain, { toml: null, ts: Date.now() });
      return null;
    }
    const toml = parseStellarToml(text);
    tomlCache.set(domain, { toml, ts: Date.now() });
    return toml;
  } catch (e) {
    // Network error, timeout, DNS — all silent; we keep going without metadata
    tomlCache.set(domain, { toml: null, ts: Date.now() });
    return null;
  }
}

/**
 * Accounts with a trustline to the asset. Horizon's /assets record counts them
 * by authorization state in `accounts`; releases before that split had a flat
 * `num_accounts`. Null when the record has neither.
 */
function holdersOf(rec) {
  const a = rec?.accounts;
  if (a && typeof a === "object") {
    const parts = [a.authorized, a.authorized_to_maintain_liabilities, a.unauthorized].filter((n) => n != null);
    if (parts.length > 0 && parts.every((n) => Number.isInteger(n) && n >= 0)) return parts.reduce((x, y) => x + y, 0);
    return null;
  }
  return Number.isInteger(rec?.num_accounts) ? rec.num_accounts : null;
}

/**
 * Fetch Horizon's /assets stats for one (code, issuer) so we can see
 * total supply and number of accounts holding the asset.
 *
 * Horizon no longer sends the flat `amount` and `num_accounts` this read: the
 * supply is split by where it sits and the holders by authorization. Reading
 * the old fields gave NaN and undefined, so supply and holders never counted:
 * any asset held as one stroop or one unit scored as a "Maybe" NFT (VELO, at
 * a supply of billions), and the large-supply reject never ran.
 */
async function getAssetStats(horizon, code, issuer) {
  const key = `${code}:${issuer}`;
  const cached = assetStatCache.get(key);
  if (cached && Date.now() - cached.ts < ASSET_STAT_TTL_MS) return cached.stats;

  try {
    const result = await horizon
      .assets()
      .forCode(code)
      .forIssuer(issuer)
      .limit(1)
      .call();
    const rec = result.records?.[0] ?? null;
    const stats = rec
      ? {
          amount: classicSupply(rec),         // total supply in display units, wherever it sits
          numAccounts: holdersOf(rec),
          flags: rec.flags,
          tomlLink: rec._links?.toml?.href ?? null,
        }
      : null;
    assetStatCache.set(key, { stats, ts: Date.now() });
    return stats;
  } catch (e) {
    assetStatCache.set(key, { stats: null, ts: Date.now() });
    return null;
  }
}

/**
 * Pull the issuer's home_domain from Horizon. Needed because not every classic
 * asset has the toml link populated on /assets.
 */
async function getIssuerHomeDomain(horizon, issuer) {
  try {
    const account = await horizon.loadAccount(issuer);
    return account.home_domain || null;
  } catch (e) {
    return null;
  }
}

/**
 * Score how likely a balance is to be an NFT. 0..1.
 */
function scoreNftLikeness({ balance, supply, numAccounts, tomlCurrency }) {
  let score = 0;

  // Balance shape: NFTs are typically held in tiny indivisible counts.
  if (balance === 1 || balance === 0.0000001) score += 0.35;
  else if (balance < 1) score += 0.15;
  else if (balance <= 10) score += 0.1;

  // Supply: low total supply is a strong signal.
  if (supply !== null && supply !== undefined) {
    if (supply <= 1) score += 0.35;
    else if (supply <= 10) score += 0.25;
    else if (supply <= SUPPLY_NFT_CUTOFF) score += 0.1;
  }

  // Few holders.
  if (numAccounts !== null && numAccounts !== undefined && numAccounts <= HOLDERS_NFT_CUTOFF) {
    score += 0.1;
  }

  // Explicit NFT metadata in stellar.toml is the strongest possible signal.
  if (tomlCurrency) {
    const hasNftField =
      tomlCurrency.nft_uri ||
      tomlCurrency.nft_metadata_url ||
      tomlCurrency.nft_animation_url ||
      (tomlCurrency.is_unlimited === false && tomlCurrency.fixed_number && tomlCurrency.fixed_number <= 100);
    if (hasNftField) score += 0.4;
    else if (tomlCurrency.image) score += 0.1; // weak signal — many fungibles have logos too
  }

  return Math.min(score, 1);
}

/**
 * Main entry point — given an array of Horizon balance objects and a Horizon
 * server instance, return entries that look like NFTs with resolved metadata.
 *
 * Returns: [
 *   {
 *     asset: { code, issuer, domain },
 *     balance: string,                    // raw Horizon balance
 *     supply: number | null,              // total supply observed via /assets
 *     numAccounts: number | null,
 *     confidence: number,                 // 0..1
 *     metadata: {                         // null if nothing resolved
 *       name, description, image, animationUrl, metadataUrl
 *     } | null,
 *     source: 'stellar.toml' | 'horizon-only',
 *   }, ...
 * ]
 */
async function resolveNfts(horizon, balances, { maxConcurrent = 5 } = {}) {
  const candidates = balances.filter(
    (b) => b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12"
  );

  // Process in small batches so we don't hammer Horizon or issuer toml hosts.
  const results = [];
  for (let i = 0; i < candidates.length; i += maxConcurrent) {
    const batch = candidates.slice(i, i + maxConcurrent);
    const settled = await Promise.allSettled(batch.map((b) => classifyOne(horizon, b)));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
  }

  // Only return entries that scored at least "maybe" — 0.35 is a reasonable cut.
  // The UI can decide whether to show borderline cases under a separate header.
  return results
    .filter((e) => e.confidence >= 0.35)
    .sort((a, b) => b.confidence - a.confidence);
}

async function classifyOne(horizon, bal) {
  const code = bal.asset_code;
  const issuer = bal.asset_issuer;
  const balance = parseFloat(bal.balance);

  // Skip clearly fungible holdings before doing any network work, and empty
  // trustlines: nothing is held. (Once supply could be read, an empty
  // trustline to an asset with no supply scored 0.6.)
  if (balance > 1000 || !(balance > 0)) return null;

  const stats = await getAssetStats(horizon, code, issuer);
  const supply = stats?.amount ?? null;
  const numAccounts = stats?.numAccounts ?? null;

  // Cheap reject: if total supply is large, it's not an NFT regardless of how
  // little the user holds.
  if (supply !== null && supply > SUPPLY_NFT_CUTOFF * 10) return null;

  // Resolve issuer home_domain → stellar.toml → CURRENCIES entry for this code
  const domain = await getIssuerHomeDomain(horizon, issuer);
  let toml = null;
  let tomlCurrency = null;
  if (domain) {
    toml = await fetchToml(domain);
    if (toml && Array.isArray(toml.CURRENCIES)) {
      tomlCurrency =
        toml.CURRENCIES.find((c) => c.code === code && c.issuer === issuer) ||
        toml.CURRENCIES.find((c) => c.code === code) ||
        null;
    }
  }

  const confidence = scoreNftLikeness({ balance, supply, numAccounts, tomlCurrency });
  if (confidence < 0.35) return null;

  const metadata = tomlCurrency
    ? {
        name: tomlCurrency.name || null,
        description: tomlCurrency.desc || null,
        image: tomlCurrency.image || tomlCurrency.nft_uri || null,
        animationUrl: tomlCurrency.nft_animation_url || null,
        metadataUrl: tomlCurrency.nft_metadata_url || null,
      }
    : null;

  return {
    asset: { code, issuer, domain },
    balance: bal.balance,
    supply,
    numAccounts,
    confidence: Math.round(confidence * 100) / 100,
    metadata,
    source: tomlCurrency ? "stellar.toml" : "horizon-only",
  };
}

module.exports = {
  resolveNfts,
  // Exported for tests
  _internal: { parseStellarToml, scoreNftLikeness, holdersOf },
};
