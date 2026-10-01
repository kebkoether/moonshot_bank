/**
 * Soroban RPC Client
 *
 * Handles all Soroban smart contract queries against Stellar mainnet.
 * Uses @stellar/stellar-sdk's rpc module for contract state reads.
 */
const StellarSdk = require("@stellar/stellar-sdk");
const { Contract, rpc, xdr, Address, nativeToScVal, scValToNative } = StellarSdk;

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-rpc.mainnet.stellar.gateway.fm";
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC;

const server = new rpc.Server(SOROBAN_RPC_URL);

// Public Soroban RPC endpoints rate-limit aggressively (HTTP 429) once a
// portfolio load fans out a few hundred simulations. Without a retry here,
// every caller had to choose between swallowing the error (a $4 LP position
// reads as $0 and gets cached that way) or failing the whole adapter.
// Retry transport-level failures a few times with jittered backoff; contract
// reverts and simulation errors are NOT retried — they are real answers.
const RPC_RETRY_ATTEMPTS = parseInt(process.env.RPC_RETRY_ATTEMPTS || "4", 10);
const RPC_RETRY_BASE_MS = parseInt(process.env.RPC_RETRY_BASE_MS || "250", 10);

function isTransientRpcError(e) {
  const msg = String(e?.message || "");
  const status = e?.response?.status ?? e?.status;
  return status === 429 || (status >= 500 && status < 600)
    || /429|rate limit|too many requests|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timeout/i.test(msg);
}

async function withRpcRetry(fn, label = "rpc") {
  let lastErr;
  for (let attempt = 0; attempt < RPC_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientRpcError(e) || attempt === RPC_RETRY_ATTEMPTS - 1) throw e;
      const delay = RPC_RETRY_BASE_MS * 2 ** attempt + Math.random() * RPC_RETRY_BASE_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

/**
 * Simulate a contract call (read-only, no transaction needed)
 */
async function simulateContractCall(contractId, method, args = []) {
  const contract = new Contract(contractId);
  const sourceAccount = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"; // dummy source

  // Build a transaction just for simulation
  const account = new StellarSdk.Account(sourceAccount, "0");
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await withRpcRetry(() => server.simulateTransaction(tx), `${method}@${contractId.slice(0, 8)}`);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  if (simResult.result) {
    return simResult.result.retval;
  }

  return null;
}

/**
 * Read contract data directly from ledger
 */
async function getContractData(contractId, key, durability = "persistent") {
  try {
    const dur = durability === "temporary"
      ? rpc.Durability.Temporary
      : rpc.Durability.Persistent;
    const result = await withRpcRetry(() => server.getContractData(contractId, key, dur), `getContractData@${contractId.slice(0, 8)}`);
    return result;
  } catch (e) {
    if (e.code === 404 || e.message?.includes("not found")) return null;
    throw e;
  }
}

/**
 * Extract the stored ScVal from a getContractData() ledger entry.
 *
 * stellar-sdk 15 returned `val` as an xdr.LedgerEntryData union, read with
 * `entry.val.contractData().val()`. stellar-sdk 17 returns a plain-object
 * XDR (`entry.val.contractData.val`, properties not methods). The old idiom
 * now throws `contractData is not a function`, and an adapter that caught
 * that as "no record" made every Sentora deposit vanish for three weeks.
 * Handle both shapes here, and THROW on anything else — an undecodable
 * entry is a bug, not an empty position.
 */
function contractDataScVal(entry) {
  const val = entry?.val;
  if (!val) throw new Error("contractDataScVal: entry has no val");
  if (typeof val.contractData === "function") return val.contractData().val();
  if (val.contractData && val.contractData.val !== undefined) return val.contractData.val;
  if (val.val !== undefined) return val.val; // already the ContractDataEntry
  throw new Error(`contractDataScVal: unrecognized ledger entry shape (keys: ${Object.keys(val).join(",")})`);
}

// ── Token balance queries ─────────────────────────────────────────────────────

/**
 * Get a Soroban token balance for an address.
 * Works with both SAC (Stellar Asset Contracts) and custom SEP-41 tokens.
 */
async function getTokenBalance(contractId, userAddress) {
  try {
    const addressScVal = new Address(userAddress).toScVal();
    const result = await simulateContractCall(contractId, "balance", [addressScVal]);
    if (result) {
      return scValToNative(result).toString();
    }
    return "0";
  } catch (e) {
    console.error(`Token balance error for ${contractId}:`, e.message);
    return "0";
  }
}

/**
 * Like getTokenBalance, but only CONTRACT-level failures (e.g. a SAC's
 * "trustline entry is missing" revert) map to "0" — transport failures
 * (RPC 429s, network errors) THROW, so callers can tell "no balance" from
 * "could not ask". getTokenBalance's swallow-everything behavior fed false
 * zeros into the discovery cache, making real holdings blink out of
 * portfolio totals whenever the RPC rate-limited.
 */
async function getTokenBalanceStrict(contractId, userAddress) {
  const addressScVal = new Address(userAddress).toScVal();
  try {
    const result = await simulateContractCall(contractId, "balance", [addressScVal]);
    return result ? scValToNative(result).toString() : "0";
  } catch (e) {
    if (/Error\(Contract/.test(e.message || "")) return "0";
    throw e;
  }
}

/**
 * Get token metadata (name, symbol, decimals)
 */
async function getTokenMetadata(contractId) {
  try {
    const [nameResult, symbolResult, decimalsResult] = await Promise.allSettled([
      simulateContractCall(contractId, "name"),
      simulateContractCall(contractId, "symbol"),
      simulateContractCall(contractId, "decimals"),
    ]);

    return {
      name: nameResult.status === "fulfilled" && nameResult.value
        ? scValToNative(nameResult.value)
        : "Unknown",
      symbol: symbolResult.status === "fulfilled" && symbolResult.value
        ? scValToNative(symbolResult.value)
        : "???",
      decimals: decimalsResult.status === "fulfilled" && decimalsResult.value
        ? Number(scValToNative(decimalsResult.value))
        : 7,
    };
  } catch (e) {
    console.error(`Token metadata error for ${contractId}:`, e.message);
    return { name: "Unknown", symbol: "???", decimals: 7 };
  }
}

/**
 * Format a raw token amount using its decimals
 */
function formatTokenAmount(rawAmount, decimals) {
  const raw = BigInt(rawAmount);
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0");
  return `${whole}.${fractionStr}`;
}

// ── AMM / LP helpers ──────────────────────────────────────────────────────────

/**
 * Generic: get pool reserves from a Soroban AMM contract.
 * Most Soroban AMMs (Soroswap, Phoenix, Sushi) expose get_reserves().
 */
async function getPoolReserves(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "get_reserves");
    if (result) {
      const reserves = scValToNative(result);
      return reserves;
    }
    return null;
  } catch (e) {
    console.error(`Pool reserves error for ${poolContractId}:`, e.message);
    return null;
  }
}

/**
 * Get a user's LP token balance in a pool
 */
async function getLPBalance(poolContractId, userAddress) {
  return getTokenBalance(poolContractId, userAddress);
}

/**
 * Get total supply of LP tokens in a pool
 */
async function getLPTotalSupply(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "total_supply");
    if (result) {
      return scValToNative(result).toString();
    }
    return "0";
  } catch (e) {
    console.error(`LP total supply error for ${poolContractId}:`, e.message);
    return "0";
  }
}

/**
 * Get a SEP-41 token's total_supply, returned as a Number of whole tokens
 * (already divided by 10^decimals). Returns null on failure so callers can
 * fall back gracefully rather than treating 0 as authoritative.
 */
async function getTokenSupply(contractId, decimals = 7) {
  try {
    const result = await simulateContractCall(contractId, "total_supply");
    if (!result) return null;
    const raw = BigInt(scValToNative(result).toString());
    if (raw === 0n) return 0;
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = Number(raw % divisor) / Number(divisor);
    return Number(whole) + frac;
  } catch (e) {
    console.warn(`[soroban-rpc] getTokenSupply(${contractId}) failed:`, e.message);
    return null;
  }
}

module.exports = {
  server,
  SOROBAN_RPC_URL,
  NETWORK_PASSPHRASE,
  simulateContractCall,
  getContractData,
  contractDataScVal,
  withRpcRetry,
  isTransientRpcError,
  getTokenBalance,
  getTokenBalanceStrict,
  getTokenMetadata,
  formatTokenAmount,
  getPoolReserves,
  getLPBalance,
  getLPTotalSupply,
  getTokenSupply,
};
