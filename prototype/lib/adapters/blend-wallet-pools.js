/**
 * The Blend pools a wallet has used, found from its own history.
 *
 * The Blend adapter read five built-in pools. Its pool-factory discovery
 * called rpc.getEventsForContract, which doesn't exist, so it never found any
 * (and RPC event history only reaches back days anyway). A position in any
 * other pool was never read: one wallet's 900 XLM in "Fixed v2.1"
 * (CBAKAZUE…, deployed 2026-09-30) didn't show.
 *
 * Every Blend deposit or borrow is the wallet calling the pool, so its pools
 * are in its operation history. This reads that history from Horizon, newest
 * first (new pools are recent), a few seconds at a time: a long history is
 * finished over the next loads, and later loads only read what's new. Each
 * contract the wallet called is kept as a pool if it runs Blend's v2 pool
 * code, the same code as every pool Blend's factory has deployed. A pool the
 * factory didn't deploy is still read (the money in it is real) and labelled.
 */
const StellarSdk = require("@stellar/stellar-sdk");
const { simulateContractCall, getContractData, contractDataScVal, isTransientRpcError } = require("../soroban-rpc");

const { Address, xdr, scValToNative } = StellarSdk;

const HORIZON = "https://horizon.stellar.org";
// Blend v2's pool contract (blend-contracts-v2, pool/). Fixed, YieldBlox,
// Orbit, Forex and Etherfuse V2 all run it.
const BLEND_V2_POOL_WASM = "a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e";
const PAGE = 200;
const NEW_ACTIVITY_EVERY_MS = 60_000; // how often to look for operations newer than the last read
const CLASSIFY_CONCURRENCY = 4;
// The last second of the budget is kept for checking the contracts found.
const CLASSIFY_RESERVE_MS = 1000;

const _deps = { fetch: (...a) => fetch(...a) }; // tests replace this

// address -> { newest, oldest, historyDone, newestCheckedAt, contracts: Set }
const _wallets = new Map();
// contractId -> { pool: false } | { pool: true, contractId, name, factory }
const _contracts = new Map();

/** The contract a Soroban operation called: its first Address parameter. */
function _calledContract(op) {
  if (op.type !== "invoke_host_function") return null;
  const p = (op.parameters || []).find((x) => x.type === "Address");
  if (!p) return null;
  try {
    const c = scValToNative(xdr.ScVal.fromXDR(p.value, "base64"));
    return typeof c === "string" && c.startsWith("C") ? c : null;
  } catch (_) {
    return null;
  }
}

const OUT_OF_TIME = Symbol("out of time");

/**
 * `promise`'s result, or OUT_OF_TIME once the deadline passes, whichever comes
 * first. The promise itself carries on; nothing waits for it any more.
 */
function _byDeadline(promise, deadline) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(OUT_OF_TIME), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function _page(address, order, cursor, deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) return null;
  const q = `order=${order}&limit=${PAGE}${cursor ? `&cursor=${cursor}` : ""}`;
  try {
    const request = _deps.fetch(`${HORIZON}/accounts/${address}/operations?${q}`, { signal: AbortSignal.timeout(ms) });
    request.catch(() => {}); // settled late, after the race below: nobody is listening
    const res = await _byDeadline(request, deadline);
    if (res === OUT_OF_TIME) return null;
    if (res.status === 404) return []; // no such account yet: no history
    if (!res.ok) throw new Error(`Horizon ${res.status}`);
    // The body is read against the deadline too. If the abort signal fires
    // while a gzip body (as Horizon sends) is still arriving, Node's fetch
    // can leave res.json() pending for good. On 2026-11-04 that held up the
    // whole Blend read, which timed out at 8 s and showed Blend as
    // unavailable: 5 times in 4 cold loads of six wallets.
    const body = res.json();
    body.catch(() => {});
    const data = await _byDeadline(body, deadline);
    if (data === OUT_OF_TIME) return null;
    return data?._embedded?.records || [];
  } catch (e) {
    // Out of time for this load (while waiting or reading the body): carry on next time.
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return null;
    throw e;
  }
}

/** Read as much of the wallet's history as the deadline allows. */
async function _scan(address, deadline) {
  const w = _wallets.get(address) || { newest: null, oldest: null, historyDone: false, newestCheckedAt: 0, contracts: new Set() };
  _wallets.set(address, w);
  const keep = (ops) => { for (const op of ops) { const c = _calledContract(op); if (c) w.contracts.add(c); } };

  // Operations since the last read (once the first page has been read).
  if (w.newest && Date.now() - w.newestCheckedAt >= NEW_ACTIVITY_EVERY_MS) {
    for (;;) {
      const ops = await _page(address, "asc", w.newest, deadline);
      if (ops == null) break;
      keep(ops);
      if (ops.length) w.newest = ops[ops.length - 1].paging_token;
      if (ops.length < PAGE) { w.newestCheckedAt = Date.now(); break; }
    }
  }
  // Then further back, newest first, until the start of the history.
  while (!w.historyDone) {
    const ops = await _page(address, "desc", w.oldest, deadline);
    if (ops == null) break;
    keep(ops);
    if (ops.length) {
      if (!w.newest) { w.newest = ops[0].paging_token; w.newestCheckedAt = Date.now(); }
      w.oldest = ops[ops.length - 1].paging_token;
    }
    if (ops.length < PAGE) w.historyDone = true;
  }
  return w;
}

/** Whether a contract is a Blend v2 pool, and its name. Throws if it can't tell. */
async function _classify(contractId, factoryId) {
  const entry = await getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), "persistent");
  const instance = entry ? contractDataScVal(entry)?.instance : null;
  const hash = instance?.executable?.wasmHash; // absent for a Stellar Asset Contract
  if (!hash || hash.toString("hex") !== BLEND_V2_POOL_WASM) return { pool: false };

  let name = null;
  for (const e of instance.storage || []) {
    try { if (scValToNative(e.key) === "Name") name = String(scValToNative(e.val)); } catch (_) { /* other keys */ }
  }
  const isPool = await simulateContractCall(factoryId, "is_pool", [new Address(contractId).toScVal()]);
  return { pool: true, contractId, name, factory: scValToNative(isPool) === true };
}

/**
 * Blend v2 pools this wallet has called, as { contractId, name, factory }.
 * Never throws, and answers by the deadline: on a Horizon or RPC failure, or
 * when time runs out, it returns what it has found so far, and tries the rest
 * on the next call.
 */
async function walletBlendPools(address, { deadline, factoryId }) {
  if (!address || !address.startsWith("G")) return [];
  let w;
  try {
    w = await _scan(address, deadline - CLASSIFY_RESERVE_MS);
  } catch (e) {
    w = _wallets.get(address);
    console.warn(`[Blend] history read for ${address.slice(0, 8)} stopped: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!w) return [];

  const todo = [...w.contracts].filter((c) => !_contracts.has(c));
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const c = todo[next++];
      const check = _classify(c, factoryId).then(
        (result) => { _contracts.set(c, result); },
        (e) => {
          // Not cached: asked again next time.
          if (!isTransientRpcError(e)) console.warn(`[Blend] couldn't check ${c.slice(0, 8)}: ${String(e?.message || e).slice(0, 120)}`);
        },
      );
      // Not past the deadline: a check still running finishes in the
      // background, and its answer is used from the next load on.
      await _byDeadline(check, deadline);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, todo.length) }, worker));

  return [...w.contracts].map((c) => _contracts.get(c)).filter((x) => x && x.pool);
}

function _resetForTests() { _wallets.clear(); _contracts.clear(); }

module.exports = { walletBlendPools, BLEND_V2_POOL_WASM, _deps, _resetForTests };
