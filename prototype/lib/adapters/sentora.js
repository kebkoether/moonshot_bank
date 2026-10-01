/**
 * Sentora Vaults Adapter (Stellar DeFi Hub)
 *
 * Source: https://github.com/Into-The-Block-Corp/StellarVaults
 * Verified WASM per stellar.expert; commit c29a8bf9398dfd5817b43db5e474543efc9932ff.
 *
 * Contract shape — principal-only escrow, no on-chain yield accrual:
 *   - Write:  deposit(from, amount, referral_id) → u64 deposit_id
 *   - Write:  withdraw(from, amount)
 *   - Read:   *no public read method exposed*
 *   - Storage: persistent enum key `DepositStorageKey::Deposit(Address)`
 *              → struct DepositRecord { owner: Address, amount: u128 }
 *
 * Since the contract has no `balance(user)` accessor, we read the storage
 * entry directly via getContractData with the reconstructed enum key.
 * Soroban enum variants serialize as Vec[Symbol(variantName), args...].
 *
 * Yield is not accrued on-chain — the DepositRecord only tracks principal.
 * Any yield distribution happens off-chain (or via a separate contract),
 * so we can't report accrued yield or APY from on-chain data alone.
 */
const rpcLib = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, xdr, nativeToScVal, scValToNative } = StellarSdk;

// Vault registry — add new Sentora vaults here as they launch.
// underlyingSymbol / underlyingDecimals: for the token users deposited.
// name: display label for the vault card.
// externalUrl: click-through for manage / more info.
// All three vaults share the same WASM (ca6b85a1…) and deployer; the list
// must match SENTORA_VAULTS in lib/defi-explorer.js.
const SENTORA_URL = "https://stellardefihub.com/vaults";
const VAULTS = [
  {
    vaultContractId:      "CA54LVHMAY7HGLMVPN4W72XJB4OGKVZBZX26FWN6JD4P3HJFWQUQEHJO",
    name:                 "Sentora XLM Vault",
    underlyingContractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    underlyingSymbol:     "XLM",
    underlyingDecimals:   7,
    externalUrl:          SENTORA_URL,
  },
  {
    vaultContractId:      "CAHEWHOPPDBQYFMAOLDOXXGUX2BCR7EXP4CWYCRY3NEAJB35YPZMMJFF",
    name:                 "Sentora USDC Vault",
    underlyingContractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    underlyingSymbol:     "USDC",
    underlyingDecimals:   7,
    externalUrl:          SENTORA_URL,
  },
  {
    vaultContractId:      "CAQRAXBU6G4AAX4BZ7R4WLB62TSVAQFS5ZXJDVXRLAU2NZ2ZTGU5QOYB",
    name:                 "Sentora PYUSD Vault",
    underlyingContractId: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2",
    underlyingSymbol:     "PYUSD",
    underlyingDecimals:   7,
    externalUrl:          SENTORA_URL,
  },
];

// Cache per user for 60s — matches other lending/vault adapters.
const CACHE_TTL = 60_000;
const _cache = new Map();

// Returns the DepositRecord, null when the wallet has no entry in this
// vault, and THROWS on transport or decode failure. The previous version
// swallowed both into null, so an RPC 429 — or the stellar-sdk 17 ledger
// entry shape change — read as "no deposit" and silently emptied the card.
async function _readDepositRecord(vaultId, userAddress) {
  // Reconstruct DepositStorageKey::Deposit(address) enum key.
  const key = xdr.ScVal.scvVec([
    nativeToScVal("Deposit", { type: "symbol" }),
    new Address(userAddress).toScVal(),
  ]);
  const entry = await rpcLib.getContractData(vaultId, key, "persistent");
  if (!entry) return null;
  const record = scValToNative(rpcLib.contractDataScVal(entry));
  if (!record || typeof record !== "object" || record.amount === undefined) {
    throw new Error(`Sentora vault ${vaultId.slice(0, 8)}: unexpected DepositRecord shape`);
  }
  return record;
}

function _priceFor(sym, priceCtx) {
  const s = (sym || "").toUpperCase();
  if (s === "XLM") return priceCtx?.xlmPrice?.usd || 0;
  if (["USDC","USDY","PYUSD","EURC","MGUSD","USST","YLDS","USTBL"].includes(s)) return 1;
  return 0;
}

const SentoraAdapter = {
  protocolId: "sentora",
  name: "Sentora Vaults",
  type: "vault",

  isConfigured() { return VAULTS.length > 0; },

  async getPositions(userAddress, priceCtx) {
    if (!userAddress || !userAddress.startsWith("G")) return [];
    const cached = _cache.get(userAddress);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.positions;

    // Read all vaults in parallel; any failure rejects the whole adapter so
    // collectDefiPositions can serve its last-known-good result or flag the
    // protocol as degraded, instead of showing a wallet with "no deposits".
    const records = await Promise.all(
      VAULTS.map((v) => _readDepositRecord(v.vaultContractId, userAddress))
    );
    const positions = [];
    VAULTS.forEach((v, i) => {
      const record = records[i];
      if (!record) return;
      const rawAmount = BigInt(record.amount || "0");
      if (rawAmount === 0n) return;

      const divisor = 10 ** v.underlyingDecimals;
      const amountNum = Number(rawAmount) / divisor;
      const priceUSD = _priceFor(v.underlyingSymbol, priceCtx);

      positions.push({
        protocol: "sentora",
        type: "vault",
        contractId: v.vaultContractId,
        vaultName: v.name,
        receiptSymbol: v.underlyingSymbol,
        deposited: {
          amount: amountNum.toFixed(amountNum < 1 ? 6 : 2),
          asset: v.underlyingSymbol,
        },
        yield: {
          // The vault contract only tracks principal; any yield distribution
          // happens off-chain. We can't report accrued yield from on-chain.
          accrued: "0",
          asset: v.underlyingSymbol,
          apy: null,
        },
        valueUSD: amountNum * priceUSD,
        externalUrl: v.externalUrl,
      });
    });

    _cache.set(userAddress, { ts: Date.now(), positions });
    return positions;
  },
};

module.exports = SentoraAdapter;
