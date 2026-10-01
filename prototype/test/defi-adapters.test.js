require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("@stellar/stellar-sdk");

/**
 * DeFi adapter failure semantics.
 *
 * Background: on 2026-09-30 four of Klint's positions (Sentora x3, Soroswap,
 * SushiSwap) were missing from stellarscope.xyz while on-chain. Two causes:
 *
 *   1. stellar-sdk 17 changed the getContractData() ledger-entry shape and the
 *      Sentora adapter caught the resulting TypeError as "no deposit".
 *   2. The LP adapters swallowed RPC 429s into "0" / [] and cached that.
 *
 * These tests pin the contract that fixes both: an adapter returns [] only
 * when the chain says there is nothing, and THROWS when it could not ask.
 * collectDefiPositions (server.js) turns a throw into last-known-good or a
 * `degraded` flag — never into a silently smaller portfolio.
 *
 * Mocks are installed on lib/soroban-rpc's export object BEFORE the adapters
 * are required, because most adapters destructure at require time.
 */
process.env.RPC_RETRY_BASE_MS = "1";
process.env.RPC_RETRY_ATTEMPTS = "3";

const rpcLib = require("../lib/soroban-rpc");

const USER = "GA7UQ5XCAELHS5UOSW7UEEJVS36FJ6I47YTKENYJKRTBW7YRKYK2NNL6";
const PAIR_A = "CAM7DY53G63XA4AJRS24Z6VFYAFSSF76C3RZ45BE5YU3FQS5255OOABP";
const PAIR_B = "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

function rateLimit() {
  const e = new Error("Request failed with status code 429");
  e.response = { status: 429 };
  return e;
}

function depositRecord(amount) {
  return S.nativeToScVal(
    { owner: new S.Address(USER), amount: BigInt(amount) },
    { type: { owner: ["symbol", "address"], amount: ["symbol", "u128"] } }
  );
}

// Keep the originals so each test can restore them.
const ORIGINAL = { ...rpcLib };
function restore() {
  for (const k of Object.keys(ORIGINAL)) rpcLib[k] = ORIGINAL[k];
}

// ── withRpcRetry ────────────────────────────────────────────────────────────

test("withRpcRetry retries transient failures and then succeeds", async () => {
  let calls = 0;
  const out = await rpcLib.withRpcRetry(async () => {
    calls++;
    if (calls < 3) throw rateLimit();
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("withRpcRetry gives up after RPC_RETRY_ATTEMPTS and rethrows", async () => {
  let calls = 0;
  await assert.rejects(
    rpcLib.withRpcRetry(async () => { calls++; throw rateLimit(); }),
    /429/
  );
  assert.equal(calls, 3);
});

test("withRpcRetry does NOT retry contract-level errors", async () => {
  let calls = 0;
  await assert.rejects(
    rpcLib.withRpcRetry(async () => { calls++; throw new Error("Simulation failed: HostError: Error(Contract, #6)"); }),
    /Contract/
  );
  assert.equal(calls, 1, "a revert is a real answer, retrying it is just slower");
});

// ── contractDataScVal ───────────────────────────────────────────────────────

test("contractDataScVal decodes the stellar-sdk 15 union shape", () => {
  const scv = depositRecord("150000000");
  const entry = { val: { contractData: () => ({ val: () => scv }) } };
  const rec = S.scValToNative(rpcLib.contractDataScVal(entry));
  assert.equal(rec.amount.toString(), "150000000");
});

test("contractDataScVal decodes the stellar-sdk 17 plain-object shape", () => {
  // Real shape observed against mainnet with sdk 17.1.0: own keys
  // ["type","contractData"], contractData has {ext,contract,key,durability,val}.
  const scv = depositRecord("100000000");
  const entry = { val: { type: "contractData", contractData: { ext: null, contract: "C...", key: null, durability: 1, val: scv } } };
  const rec = S.scValToNative(rpcLib.contractDataScVal(entry));
  assert.equal(rec.amount.toString(), "100000000");
});

test("contractDataScVal throws on an unrecognized shape instead of returning nothing", () => {
  assert.throws(() => rpcLib.contractDataScVal({ val: { something: 1 } }), /unrecognized ledger entry shape/);
  assert.throws(() => rpcLib.contractDataScVal(null), /no val/);
});

// ── Sentora ─────────────────────────────────────────────────────────────────

test("Sentora: reports deposits in all three vaults using the sdk-17 entry shape", async (t) => {
  t.after(restore);
  const byVault = {
    CA54LVHMAY7HGLMVPN4W72XJB4OGKVZBZX26FWN6JD4P3HJFWQUQEHJO: "150000000", // 15 XLM
    CAHEWHOPPDBQYFMAOLDOXXGUX2BCR7EXP4CWYCRY3NEAJB35YPZMMJFF: "100000000", // 10 USDC
    CAQRAXBU6G4AAX4BZ7R4WLB62TSVAQFS5ZXJDVXRLAU2NZ2ZTGU5QOYB: "110000000", // 11 PYUSD
  };
  rpcLib.getContractData = async (vault) => ({
    val: { type: "contractData", contractData: { val: depositRecord(byVault[vault]) } },
  });
  const Sentora = require("../lib/adapters/sentora");
  const positions = await Sentora.getPositions(USER + "", { xlmPrice: { usd: 0.3 } });
  const bySymbol = Object.fromEntries(positions.map((p) => [p.deposited.asset, p]));
  assert.deepEqual(Object.keys(bySymbol).sort(), ["PYUSD", "USDC", "XLM"]);
  assert.equal(bySymbol.XLM.deposited.amount, "15.00");
  assert.equal(bySymbol.USDC.valueUSD, 10);
  assert.equal(bySymbol.PYUSD.valueUSD, 11);
  assert.ok(Math.abs(bySymbol.XLM.valueUSD - 4.5) < 1e-9);
  for (const p of positions) assert.equal(p.protocol, "sentora");
});

test("Sentora: a wallet with no record in a vault is simply absent from that vault", async (t) => {
  t.after(restore);
  rpcLib.getContractData = async (vault) =>
    vault.startsWith("CA54") ? { val: { contractData: { val: depositRecord("70000000") } } } : null;
  const Sentora = require("../lib/adapters/sentora");
  const positions = await Sentora.getPositions("GB3BIN23PHTOPHTEGTC4VCY2HVSY6HDYG3C6QXQQ3TCEJR74K6DWGMQT", { xlmPrice: { usd: 0.3 } });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].deposited.asset, "XLM");
});

test("Sentora: an RPC failure REJECTS instead of reading as 'no deposits'", async (t) => {
  t.after(restore);
  rpcLib.getContractData = async () => { throw rateLimit(); };
  const Sentora = require("../lib/adapters/sentora");
  await assert.rejects(
    Sentora.getPositions("GAX2VVWVHU5YQY5J3NJBXKHI3FFKZN54BE6GRJCWSIKSBZTQWJJNJMPC", { xlmPrice: { usd: 0.3 } }),
    /429/
  );
});

test("Sentora: an undecodable ledger entry REJECTS (the sdk-17 regression, had it recurred)", async (t) => {
  t.after(restore);
  rpcLib.getContractData = async () => ({ val: { brandNewShape: true } });
  const Sentora = require("../lib/adapters/sentora");
  await assert.rejects(
    Sentora.getPositions("GAV5FBMKD2ZF4X2MGWDNQYUP7KFL7MRM6HZBY7HKQLB4BRHSCCX5J6VS", { xlmPrice: { usd: 0.3 } }),
    /unrecognized ledger entry shape/
  );
});

// ── LP discovery (Aquarius + Soroswap) ─────────────────────────────────────
//
// lp-discovery destructures simulateContractCall / getTokenBalanceStrict at
// require time, so the mocks below are installed as indirection BEFORE the
// first require and then steered per test.

const lpMock = {
  simulate: async () => { throw new Error("simulate mock not set"); },
  balance: async () => { throw new Error("balance mock not set"); },
  fetch: async () => { throw new Error("fetch mock not set"); },
};
rpcLib.simulateContractCall = (...a) => lpMock.simulate(...a);
rpcLib.getTokenBalanceStrict = (...a) => lpMock.balance(...a);
rpcLib.getTokenMetadata = async (id) => (id === XLM_SAC
  ? { name: "XLM", symbol: "XLM", decimals: 7 }
  : { name: "USDC", symbol: "USDC", decimals: 7 });
const LPDiscovery = require("../lib/adapters/lp-discovery");
restore(); // the adapter holds its own references now; put the module back for everyone else

function soroswapUniverseSimulate(extra = {}) {
  return async (contract, method, args) => {
    if (method === "all_pairs_length") return S.nativeToScVal(2, { type: "u32" });
    if (method === "all_pairs") {
      const i = Number(S.scValToNative(args[0]));
      return S.nativeToScVal([PAIR_A, PAIR_B][i], { type: "string" });
    }
    if (method === "total_supply") return S.nativeToScVal(1000000n, { type: "i128" });
    if (method === "get_reserves") return S.nativeToScVal([5000000000n, 1500000000n], { type: "i128" });
    if (method === "token_0") return S.nativeToScVal(XLM_SAC, { type: "string" });
    if (method === "token_1") return S.nativeToScVal(USDC_SAC, { type: "string" });
    if (extra[method]) return extra[method](contract, args);
    throw new Error(`unexpected simulate ${method}`);
  };
}

function aquaFetchEmpty() {
  return async () => ({ ok: true, status: 200, json: async () => ({ count: 0, results: [] }) });
}

test("Soroswap: a pair whose balance read fails once is retried and still found", async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = aquaFetchEmpty();
  lpMock.simulate = soroswapUniverseSimulate();
  let failedOnce = false;
  lpMock.balance = async (pair) => {
    if (pair === PAIR_A && !failedOnce) { failedOnce = true; throw rateLimit(); }
    return pair === PAIR_A ? "1000" : "0";
  };
  const positions = await LPDiscovery.getPositions("GB3BIN23PHTOPHTEGTC4VCY2HVSY6HDYG3C6QXQQ3TCEJR74K6DWGMQT", { xlmPrice: { usd: 0.3 } });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].protocol, "soroswap");
  assert.equal(positions[0].poolContractId, PAIR_A);
  assert.equal(positions[0].token0.symbol, "XLM");
  // 1000/1000000 of 500 XLM = 0.5 XLM at $0.30 + 0.15 USDC
  assert.ok(Math.abs(positions[0].valueUSD - 0.3) < 1e-9, `valueUSD ${positions[0].valueUSD}`);
});

test("Soroswap: persistent rate-limiting REJECTS instead of caching 'no positions'", async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = aquaFetchEmpty();
  lpMock.simulate = soroswapUniverseSimulate();
  lpMock.balance = async (pair) => { if (pair === PAIR_A) throw rateLimit(); return "0"; };
  const wallet = "GAX2VVWVHU5YQY5J3NJBXKHI3FFKZN54BE6GRJCWSIKSBZTQWJJNJMPC";
  await assert.rejects(LPDiscovery.getPositions(wallet, { xlmPrice: { usd: 0.3 } }), /pair balance reads failed/);

  // And the failure must not have been cached: once the RPC recovers the
  // very next call finds the position.
  lpMock.balance = async (pair) => (pair === PAIR_A ? "1000" : "0");
  const positions = await LPDiscovery.getPositions(wallet, { xlmPrice: { usd: 0.3 } });
  assert.equal(positions.length, 1);
});

test("Aquarius: a non-OK API response REJECTS instead of reading as 'no pools'", async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  lpMock.simulate = soroswapUniverseSimulate();
  lpMock.balance = async () => "0";
  await assert.rejects(
    LPDiscovery.getPositions("GAV5FBMKD2ZF4X2MGWDNQYUP7KFL7MRM6HZBY7HKQLB4BRHSCCX5J6VS", { xlmPrice: { usd: 0.3 } }),
    /Aquarius API 502/
  );
});

test("Aquarius: parses the (absurdly long-precision) deposited_tokens the API returns", async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ count: 1, results: [{
      address: "CAFHLHGZXOVNCGFJ7DOXL7JDNMBCEZKDI3LS5NRQH3GXC7CSIMQZHUSM",
      tokens_addresses: ["CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP", USDC_SAC],
      tokens_str: ["USDY:GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
      pool_type: "constant_product",
      balance: "21211481.000000000000000000",
      deposited_tokens: {
        "USDY:GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6": "1.9926148269805238470681295785726699924207568992708705962770737194121767752900101780945798197467243219344322179763474500713440180535730885033521204743404636166350945260338836822301197622431938552133865377621052182723717568392497004210490856684196013617381462911267101615119253178191782611684342733289163842382482538632047846475377723137059045215193871906589860172468601113412293523887912447511263746375448839752309296890856770063670495973238842888507545838522519404464442716923130828460371942024907760849646542853614676548904772197041700459841667084327884135165598356802843531461937216376793237203517623202183478903989668359822454331369426969899339372144750685802184354448062109559163309298208619998372768949385242730549909575947133397544785300060290241640711788423222589998560929530492955906796572071481202768130697771039848686657809267336851263389886315344826678621611150781060813169811374964441860582624640191987478502765372512775835984692537175683666801578611003563779693951798632081621582915824475897578338977624242058752448734373927690388773603879665285436408057243099800200624035357622872273802212199914505777872145631451173918601000390340211745272509786696943347521304604433007543133097074763054816364430986567481734447528734843884363417406150298129898141410928001601320326314306771298873842304596780451167256640244863652405024860303025907815292900916942177153674179993335085250420104677062897306979118501763188185161742394427249510493761570980139361961934743945208260913525443867343329264241248728092043221424648849497314859219679395321557141502514831593506029840187677041387861110190843711686439931445045034174373196327353798804272710436625686824366666691312362623839161104537382568384533906763270389360418166010112798864222339712752956350700166568086923595015440746350903341369166923598365059134461680665402033186741836138779955574682577507633791177184167493715327830982833822052841023144657355225955305273991653304692227598358591063801929955902559893925126357510947860313231566091730979275004648771969507058577337943876100129237364840251407111891847336682756443920952278870221922400518816090802250119045568268444021350591236242363793974257074465745214501716980999589868159657078067036695095733451673910913352532525779497391034637271273301012753970755013628320443196868876666588398858949",
        "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": "2.2584874"
      },
    }] }),
  });
  lpMock.simulate = soroswapUniverseSimulate();
  lpMock.balance = async () => "0";
  const positions = await LPDiscovery.getPositions("GCFX65SFE7AY7XT5FOUQUVROYST5J2VZPA4ZBYFCOWBS6IHLTSI5NDO6", { xlmPrice: { usd: 0.3 } });
  const aqua = positions.find((p) => p.protocol === "aquarius");
  assert.ok(aqua, "aquarius position present");
  assert.equal(aqua.token0.symbol, "USDY");
  assert.equal(aqua.amounts.token0, "1.992615");
  assert.ok(Math.abs(aqua.valueUSD - 4.2511) < 0.001, `valueUSD ${aqua.valueUSD}`);
});

// ── SushiSwap V3 (lp-positions) ─────────────────────────────────────────────

test("SushiSwap V3: a failed position-manager read REJECTS instead of returning []", async (t) => {
  // lp-positions destructures simulateContractCall at require time too.
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; restore(); });
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) }); // Horizon walk in _discoverPools
  rpcLib.simulateContractCall = async () => { throw rateLimit(); };
  rpcLib.getTokenBalance = async () => "0";
  const LPPositions = require("../lib/adapters/lp-positions");
  await assert.rejects(
    LPPositions.getPositions(S.Keypair.random().publicKey(), { xlmPrice: { usd: 0.3 } }),
    /SushiSwap V3: .*429/
  );
});
