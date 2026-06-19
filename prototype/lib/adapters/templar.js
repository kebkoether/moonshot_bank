/**
 * Templar Finance Adapter for Stellar
 *
 * Templar's Stellar deployment doesn't use Soroban smart contracts for
 * custody — instead users send classic Stellar payments to a Templar-
 * controlled G-address, and the actual lending logic runs on NEAR (via
 * Chain Signatures / MPC). So position state lives off-Stellar.
 *
 * This adapter detects the on-chain side of that flow: scan the user's
 * payment history for transfers TO known Templar deposit addresses,
 * subtract any payments back FROM those addresses (withdrawals), and
 * report the net deposit as a "vault" position.
 *
 * Limitations to be honest about:
 *   - Doesn't include accrued yield (that's tracked off-chain on NEAR)
 *   - Doesn't surface borrow amounts
 *   - Net-deposit value ≈ initial principal, not current account equity
 *   - Link to app.templarfi.org for the authoritative numbers
 *
 * Adding new custody addresses: append to TEMPLAR_DEPOSIT_ADDRESSES.
 */

// Known Templar custody addresses on Stellar mainnet. Add more as they
// become known (e.g., a per-market deposit address pattern).
const TEMPLAR_DEPOSIT_ADDRESSES = new Set([
  "GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK",
]);

const HORIZON_BASE = "https://horizon.stellar.org";

// Cache payments per user for 60s — the Horizon query is paginated and
// each page is ~50 records, so a hot wallet with months of history might
// trigger 5-10 pages per scan.
const CACHE_TTL = 60_000;
const cache = new Map(); // userAddress -> { ts, positions }

async function _scanPayments(userAddress) {
  // Aggregate per asset: { [assetKey]: { code, issuer|null, sent, received } }
  const perAsset = new Map();
  let cursor = "";
  let pages = 0;
  const MAX_PAGES = 20; // safety cap (~1000 ops)

  while (pages < MAX_PAGES) {
    const url = `${HORIZON_BASE}/accounts/${userAddress}/payments?order=desc&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      data = await res.json();
    } catch (e) {
      break;
    }

    const records = data?._embedded?.records || [];
    if (records.length === 0) break;

    for (const r of records) {
      if (r.type !== "payment") continue;
      const isToTemplar = TEMPLAR_DEPOSIT_ADDRESSES.has(r.to);
      const isFromTemplar = TEMPLAR_DEPOSIT_ADDRESSES.has(r.from);
      if (!isToTemplar && !isFromTemplar) continue;

      // Skip if user isn't on either side
      if (r.from !== userAddress && r.to !== userAddress) continue;

      const code = r.asset_type === "native" ? "XLM" : r.asset_code;
      const issuer = r.asset_type === "native" ? null : r.asset_issuer;
      const key = `${code}:${issuer || "native"}`;
      const amount = parseFloat(r.amount || "0");
      if (!Number.isFinite(amount) || amount <= 0) continue;

      if (!perAsset.has(key)) {
        perAsset.set(key, { code, issuer, sent: 0, received: 0 });
      }
      const agg = perAsset.get(key);
      if (isToTemplar && r.from === userAddress) {
        // user → Templar (a deposit)
        agg.sent += amount;
      } else if (isFromTemplar && r.to === userAddress) {
        // Templar → user (a withdrawal)
        agg.received += amount;
      }
    }

    cursor = records[records.length - 1].paging_token;
    pages++;
    if (records.length < 200) break;
  }

  return perAsset;
}

function _priceFor(code, priceCtx) {
  if (code === "XLM") return priceCtx?.xlmPrice?.usd || 0;
  if (code === "USDC" || code === "USDx" || code === "PYUSD") return 1; // stable
  return 0; // unknown — will display valueUSD as 0
}

const TemplarAdapter = {
  protocolId: "templar",
  name: "Templar Finance",
  type: "lending",

  isConfigured() {
    return TEMPLAR_DEPOSIT_ADDRESSES.size > 0;
  },

  async getPositions(userAddress, priceCtx) {
    if (!this.isConfigured()) return [];

    const cached = cache.get(userAddress);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.positions;
    }

    let perAsset;
    try {
      perAsset = await _scanPayments(userAddress);
    } catch (e) {
      console.warn(`Templar scan failed for ${userAddress}:`, e.message);
      return [];
    }

    const positions = [];
    for (const [, agg] of perAsset) {
      const net = agg.sent - agg.received;
      if (net <= 0) continue; // fully withdrawn or no deposit
      const priceUSD = _priceFor(agg.code, priceCtx);
      positions.push({
        protocol: "templar",
        type: "vault",
        contractId: null, // Templar doesn't use Soroban for custody
        vaultName: `Templar ${agg.code} deposit`,
        receiptSymbol: agg.code,
        deposited: {
          amount: net.toFixed(net < 1 ? 6 : 2),
          asset: agg.code,
        },
        yield: {
          // Yield accrues off-chain on NEAR — we can't read it here.
          accrued: "0",
          asset: agg.code,
          apy: null,
        },
        valueUSD: net * priceUSD,
      });
    }

    cache.set(userAddress, { ts: Date.now(), positions });
    return positions;
  },
};

module.exports = TemplarAdapter;
