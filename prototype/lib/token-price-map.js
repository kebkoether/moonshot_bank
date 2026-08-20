/**
 * Token Price Map
 *
 * Maintains a contract-id / classic-asset → CoinGecko-id mapping for Stellar tokens.
 *
 * Seeded statically from CoinGecko's coins-list (filtered to platforms.stellar)
 * as of build time, and refreshed dynamically every REFRESH_INTERVAL_MS so newly-
 * listed tokens flow in automatically without code changes.
 *
 * Used by pricing-engine.js as the highest-priority price source.
 */

const REFRESH_INTERVAL_MS = parseInt(process.env.PRICE_MAP_REFRESH_MS || "21600000", 10); // 6h
const COINGECKO_API = "https://api.coingecko.com/api/v3";

// ── Static seed (snapshot of CoinGecko's Stellar-platform coins) ─────────────
// Each entry: { coingeckoId, symbol, kind: 'soroban'|'classic', contractId?, code?, issuer? }
// This is the starting map; the dynamic refresh extends/updates it.

const SEED = [
  // Soroban-native contracts (16)
  { coingeckoId: "allunity-eur", symbol: "EURAU", kind: "soroban", contractId: "CB44W727WSLHPXJ47A6DHF5D34RKWSOZAMEDXO3CF5TEEEQ2ZX4V3VRI" },
  { coingeckoId: "eutbl", symbol: "EUTBL", kind: "soroban", contractId: "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF" },
  { coingeckoId: "paypal-usd", symbol: "PYUSD", kind: "soroban", contractId: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2" },
  // PYUSD also exists as a classic trustline issued by PayPal (CoinGecko only lists the Soroban side).
  { coingeckoId: "paypal-usd", symbol: "PYUSD", kind: "classic", code: "PYUSD", issuer: "GDQE7IGFAOX4PJBPGRTSGE3T5LE7HXNUDA52KNVGMTXVR75DXY67U2V5" },
  // USDT0 — Tether's omnichain USDT (LayerZero OFT, Everdawn Labs). Stellar launch Aug 2026.
  { coingeckoId: "usdt0", symbol: "USDT0", kind: "soroban", contractId: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF" },
  { coingeckoId: "usdt0", symbol: "USDT0", kind: "classic", code: "USDT0", issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q" },
  { coingeckoId: "safo", symbol: "SAFO", kind: "soroban", contractId: "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX" },
  { coingeckoId: "societe-generale-forge-eurcv", symbol: "EURCV", kind: "soroban", contractId: "CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH" },
  { coingeckoId: "solv-btc", symbol: "SOLVBTC", kind: "soroban", contractId: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN" },
  { coingeckoId: "solv-protocol-solvbtc-bbn", symbol: "XSOLVBTC", kind: "soroban", contractId: "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J" },
  { coingeckoId: "spiko-amundi-overnight-swap-fund-chf", symbol: "CHFSAFO", kind: "soroban", contractId: "CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4" },
  { coingeckoId: "spiko-amundi-overnight-swap-fund-eur", symbol: "EURSAFO", kind: "soroban", contractId: "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP" },
  { coingeckoId: "spiko-amundi-overnight-swap-fund-gbp", symbol: "GBPSAFO", kind: "soroban", contractId: "CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP" },
  { coingeckoId: "spiko-uk-t-bills-money-market-fund", symbol: "UKTBL", kind: "soroban", contractId: "CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR" },
  { coingeckoId: "stellar", symbol: "XLM", kind: "soroban", contractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" },
  { coingeckoId: "usd-coin", symbol: "USDC", kind: "soroban", contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
  { coingeckoId: "usdm1", symbol: "USDM1", kind: "soroban", contractId: "CAC743NYRBMS76L2DCPAXZTOEF6EJPKPVEC5OX2SXY7HOWNXISSLUE2C" },
  // Classic CODE-ISSUER format detected from CoinGecko but with their Soroban contract addresses listed:
  { coingeckoId: "c1usd", symbol: "C1USD", kind: "classic", code: "C1USD", issuer: "GDCDFF6ZZP3HVODSVJYAN6IRNGWGPLVFKH23RY2OFHFGGVCGBXSDPKTU" },
  { coingeckoId: "cetes", symbol: "CETES", kind: "classic", code: "CETES", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },

  // Classic assets with full issuer (42)
  { coingeckoId: "afreum", symbol: "AFR", kind: "classic", code: "AFR", issuer: "GBX6YI45VU7WNAAKA3RBFDR3I3UKNF" },
  { coingeckoId: "aquarius", symbol: "AQUA", kind: "classic", code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QO" },
  { coingeckoId: "blend", symbol: "BLND", kind: "classic", code: "BLND", issuer: "GDJEHTBE6ZHUXSWFI642DCGLUOECLH" },
  { coingeckoId: "brz", symbol: "BRZ", kind: "classic", code: "BRZ", issuer: "GABMA6FPH3OJXNTGWO7PROF7I5WPQU" },
  { coingeckoId: "doge-token", symbol: "DOGET", kind: "classic", code: "DOGET", issuer: "GDOEVDDBU6OBWKL7VHDAOKD77UP4DK" },
  { coingeckoId: "ethereumx", symbol: "ETX", kind: "classic", code: "ETX", issuer: "GCEFMSNWXTALXQPRQFIXOMWJHZFDEQ" },
  { coingeckoId: "etherfuse-ktb", symbol: "KTB", kind: "classic", code: "KTB", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETY" },
  { coingeckoId: "euro-coin", symbol: "EURC", kind: "classic", code: "EURC", issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
  { coingeckoId: "franklin-templeton-benji", symbol: "BENJI", kind: "classic", code: "BENJI", issuer: "GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7" },
  { coingeckoId: "fredenergy", symbol: "FRED", kind: "classic", code: "FRED", issuer: "GCA73U2PZFWAXJSNVMEVPNPPJCZGET" },
  { coingeckoId: "glitzkoin", symbol: "GTN", kind: "classic", code: "GTN", issuer: "GARFMAHQM4JDI55SK2FGEPLOZU7BTE" },
  { coingeckoId: "glo-dollar", symbol: "USDGLO", kind: "classic", code: "USDGLO", issuer: "GBBS25EGYQPGEZCGCFBKG4OAGFXU6D" },
  { coingeckoId: "gyen", symbol: "GYEN", kind: "classic", code: "GYEN", issuer: "GDF6VOEGRWLOZ64PQQGKD2IYWA22RL" },
  { coingeckoId: "hodlassets", symbol: "HODL", kind: "classic", code: "HODL", issuer: "GAQEDFS2JK6JSQO53DWT23TGOLH5ZU" },
  { coingeckoId: "kinesis-velocity-token", symbol: "KVT", kind: "classic", code: "KVT", issuer: "GCHDQROCJXS4TPR5YKVT2EMFZKF6LA" },
  { coingeckoId: "lumenswap", symbol: "LSP", kind: "classic", code: "LSP", issuer: "GAB7STHVD5BDH3EEYXPI3OM7PCS4V4" },
  { coingeckoId: "mobius", symbol: "MOBI", kind: "classic", code: "MOBI", issuer: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAF" },
  { coingeckoId: "newscrypto-coin", symbol: "NWC", kind: "classic", code: "NWC", issuer: "GAAPUOQWOZAG3PENRN7FEPYWXVGJBJ" },
  { coingeckoId: "novatti-australian-digital-dollar", symbol: "AUDD", kind: "classic", code: "AUDD", issuer: "GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GX" },
  { coingeckoId: "nuna", symbol: "NUNA", kind: "classic", code: "NUNA", issuer: "GCX2ENOVSSOOH6G4HIOBMPCBFXHDVD" },
  { coingeckoId: "ondo-us-dollar-yield", symbol: "USDY", kind: "classic", code: "USDY", issuer: "GAJMPX5NBOG6TQFPQGRABJEEB2YE7R" },
  { coingeckoId: "paybandcoin", symbol: "PYBC", kind: "classic", code: "PYBC", issuer: "GBVB43NLVIP2USHXSKI7QQCZKZU2Z6" },
  { coingeckoId: "realio-network", symbol: "RIO", kind: "classic", code: "RIO", issuer: "GBNLJIYH34UWO5YZFA3A3HD3N76R6D" },
  { coingeckoId: "real-mxn", symbol: "MXNE", kind: "classic", code: "MXNE", issuer: "GCQCNWT22JDLENQAVIE6DRJGHWAQ6E" },
  { coingeckoId: "scopuly-token", symbol: "SCOP", kind: "classic", code: "SCOP", issuer: "GC6OYQJIZF3HFXCYPFCBXYXNGIBQ4T" },
  { coingeckoId: "six-network", symbol: "SIX", kind: "classic", code: "SIX", issuer: "GDMS6EECOH6MBMCP3FYRYEVRBIV3TQ" },
  { coingeckoId: "starslax", symbol: "SSLX", kind: "classic", code: "SSLX", issuer: "GBHFGY3ZNEJWLNO4LBUKLYOCEK4V7E" },
  { coingeckoId: "stellar-synthetic-usd", symbol: "SUSD", kind: "classic", code: "sUSD", issuer: "GCHW7CWI7GMIYQYFXMFJNJX5645XGW" },
  { coingeckoId: "stellar-yusdc", symbol: "YUSDC", kind: "classic", code: "yUSDC", issuer: "GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6R" },
  { coingeckoId: "stronghold-token", symbol: "SHX", kind: "classic", code: "SHX", issuer: "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCU" },
  { coingeckoId: "sureremit", symbol: "RMT", kind: "classic", code: "RMT", issuer: "GCVWTTPADC5YB5AYDKJCTUYSCJ7RKP" },
  { coingeckoId: "ternio", symbol: "TERN", kind: "classic", code: "ERN", issuer: "GDGQDVO6XPFSY4NMX75A7AOVYCF5JY" },
  { coingeckoId: "threefold-token", symbol: "TFT", kind: "classic", code: "TFT", issuer: "GBOVQKJYHXRR3DX6NOX2RRYFRCUMSA" },
  { coingeckoId: "ultracapital-yeth", symbol: "YETH", kind: "classic", code: "yETH", issuer: "GDYQNEF2UWTK4L6HITMT53MZ6F5QWO" },
  { coingeckoId: "unbanked", symbol: "UNBNK", kind: "classic", code: "UNBNK", issuer: "GDJVTMIPLJXBBWXOC2KN6DSEBROPUQ" },
  { coingeckoId: "unitedcoin", symbol: "UNITS", kind: "classic", code: "UNITS", issuer: "GAB3EDZFT2MBSDPZ5LMB6RSHQ5FMZG" },
  { coingeckoId: "velo", symbol: "VELO", kind: "classic", code: "VELO", issuer: "GDM4RQUQQUVSKQA7S6EM7XBZP3FCGH" },
  { coingeckoId: "vnx-euro", symbol: "VEUR", kind: "classic", code: "VEUR", issuer: "GDXLSLCOPPHTWOQXLLKSVN4VN3G67W" },
  { coingeckoId: "vnx-swiss-franc", symbol: "VCHF", kind: "classic", code: "VCHF", issuer: "GDXLSLCOPPHTWOQXLLKSVN4VN3G67W" },
  { coingeckoId: "wirex", symbol: "WXT", kind: "classic", code: "WXT", issuer: "GASBLVHS5FOABSDNW5SPPH3QRJYXY5" },
  { coingeckoId: "wisdomtree-treasury-money-market-digital-fund", symbol: "WTGXX", kind: "classic", code: "WTGX", issuer: "GDMBNMFJ3TRFLASJ6UGETFME3PJPNK" },
  { coingeckoId: "yieldblox", symbol: "YBX", kind: "classic", code: "YBX", issuer: "GBUYYBXWCLT2MOSSHRFCKMEDFOVSCA" },
];

// ── In-memory map ────────────────────────────────────────────────────────────

// Soroban: contractId → coingeckoId
const sorobanMap = new Map();
// Classic: `${code}:${issuerPrefix}` → coingeckoId. We use a prefix because seed
// data uses truncated issuers; full issuers from Horizon are matched by prefix.
const classicMap = new Map();
// Classic by code only (fallback if issuer doesn't match exactly)
const classicByCodeOnly = new Map();

function _seedFromList(list) {
  for (const entry of list) {
    if (entry.kind === "soroban" && entry.contractId) {
      sorobanMap.set(entry.contractId, entry.coingeckoId);
    } else if (entry.kind === "classic" && entry.code && entry.issuer) {
      // Index by code:issuer-prefix (issuer can be partial)
      const issuerPrefix = entry.issuer.slice(0, 12);
      classicMap.set(`${entry.code}:${issuerPrefix}`, entry.coingeckoId);
      if (!classicByCodeOnly.has(entry.code)) {
        classicByCodeOnly.set(entry.code, entry.coingeckoId);
      }
    }
  }
}

_seedFromList(SEED);

let lastRefreshTs = 0;
let refreshInFlight = null;

// ── Lookup API ───────────────────────────────────────────────────────────────

/**
 * Look up a CoinGecko id for a Soroban contract.
 * @param {string} contractId C-strkey
 * @returns {string|null}
 */
function lookupSoroban(contractId) {
  return sorobanMap.get(contractId) || null;
}

/**
 * Look up a CoinGecko id for a classic Stellar asset.
 * @param {string} code Asset code
 * @param {string} issuer Full G... issuer address
 * @returns {string|null}
 */
function lookupClassic(code, issuer) {
  // Try exact code:issuer-prefix
  if (issuer) {
    const prefix = issuer.slice(0, 12);
    const hit = classicMap.get(`${code}:${prefix}`);
    if (hit) return hit;
  }
  // Fall back to code-only (less precise but catches assets where the seed
  // only has a truncated issuer)
  return classicByCodeOnly.get(code) || null;
}

// ── Dynamic refresh ──────────────────────────────────────────────────────────

/**
 * Pull CoinGecko's coins-list with platforms, filter to Stellar entries, and
 * merge into the in-memory map. Idempotent; safe to call repeatedly.
 *
 * Triggered automatically when lookups occur and the cache is stale.
 */
async function refreshFromCoinGecko() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${COINGECKO_API}/coins/list?include_platform=true`);
      if (!res.ok) {
        console.error(`[token-price-map] CoinGecko refresh HTTP ${res.status}`);
        return;
      }
      const all = await res.json();
      const stellar = all.filter((c) => c.platforms && c.platforms.stellar);
      let added = 0;
      for (const c of stellar) {
        const addr = c.platforms.stellar;
        if (addr.startsWith("C") && addr.length >= 56) {
          if (!sorobanMap.has(addr)) {
            sorobanMap.set(addr, c.id);
            added++;
          }
        } else if (addr.includes("-")) {
          const [code, issuer] = addr.split("-", 2);
          if (code && issuer) {
            const prefix = issuer.slice(0, 12);
            const key = `${code}:${prefix}`;
            if (!classicMap.has(key)) {
              classicMap.set(key, c.id);
              added++;
            }
            if (!classicByCodeOnly.has(code)) {
              classicByCodeOnly.set(code, c.id);
            }
          }
        }
      }
      lastRefreshTs = Date.now();
      console.log(`[token-price-map] refreshed: +${added} new entries (total: ${sorobanMap.size} soroban + ${classicMap.size} classic)`);
    } catch (e) {
      console.error("[token-price-map] refresh error:", e.message);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function _maybeRefresh() {
  if (Date.now() - lastRefreshTs > REFRESH_INTERVAL_MS) {
    refreshFromCoinGecko().catch(() => {}); // fire and forget
  }
}

// Kick off a refresh shortly after startup so we don't ship with strictly
// stale seed data — but don't block startup waiting for it.
setTimeout(() => refreshFromCoinGecko().catch(() => {}), 5000).unref?.();

// ── Stats / debugging ────────────────────────────────────────────────────────

function stats() {
  return {
    soroban: sorobanMap.size,
    classic: classicMap.size,
    classicByCodeOnly: classicByCodeOnly.size,
    lastRefreshTs,
    lastRefreshAgoMs: lastRefreshTs ? Date.now() - lastRefreshTs : null,
  };
}

/**
 * Enumerate all currently-known Soroban contract IDs. Used by token-universe
 * to assemble its candidate set without re-encoding the seed list.
 */
function knownSorobanContracts() {
  return Array.from(sorobanMap.keys());
}

module.exports = {
  lookupSoroban,
  lookupClassic,
  refreshFromCoinGecko,
  _maybeRefresh,
  knownSorobanContracts,
  stats,
};
