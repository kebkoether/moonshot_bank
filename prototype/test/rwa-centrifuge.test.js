// JQQQ, HYB and deHYB on the RWA tab, valued like Centrifuge's other funds.
//
// Janus Henderson's Nasdaq-100 fund (JQQQ) launched on Stellar on 2026-10-27,
// and the NYLIM US High Yield Bond Fund (HYB) with its deRWA wrapper (deHYB)
// in October. All three are Centrifuge tokens on Soroban, like JTRSY and JAAA.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// The fetcher destructures getTokenSupply at require time, so the fake goes in first.
const rpcLib = require("../lib/soroban-rpc");
let supply; // contractId → whole tokens on Stellar
rpcLib.getTokenSupply = async (contractId) => supply[contractId] ?? 0;

const fetcher = require("../lib/rwa-yield-fetcher");

const JQQQ = "CAQYPRTX2E6H6BM57QRBYZWP667FPDYDUHMOQXGXM2HA64KO6AISRFEK";
const HYB = "CBNT35PZXQBXKCNKPA6AL6TXHANGLAZMPE35TJUPI2BCO7OGHVKW3WYA";
const DEHYB = "CCRTH4IJKVIBU6VQLRHFKDQYWXBEBJJXKDFNWVETLKUJJ7U62HBAZOIH";
const NOV4 = Date.UTC(2026, 10, 4);

// Centrifuge's GraphQL API, trimmed to what the fetcher reads (values from 2026-11-04).
const ray = (pct) => (BigInt(Math.round(pct * 1e6)) * 10n ** 19n).toString(); // % → 1e27-scaled fraction
const wad = (usd) => (BigInt(Math.round(usd * 1e6)) * 10n ** 12n).toString(); // $ → 1e18-scaled
const SNAPSHOTS = {
  "0x01-hyb": { timestamp: String(NOV4), yield7d365: ray(11.792442), yield30dComp365: ray(14.176197), tokenPrice: wad(0.993723) },
  "0x01-jqqq": { timestamp: String(NOV4), yield7d365: ray(-314.203487), yield30dComp365: null, tokenPrice: wad(0.939742) },
};
let askedSymbols;
global.fetch = async (url, opts) => {
  assert.equal(url, "https://api.centrifuge.io/");
  const { query } = JSON.parse(opts.body);
  let data;
  if (query.includes("tokens(")) {
    askedSymbols = JSON.parse(query.match(/symbol_in: (\[[^\]]*\])/)[1]);
    data = { tokens: { items: [{ symbol: "HYB", id: "0x01-hyb" }, { symbol: "JQQQ", id: "0x01-jqqq" }].filter((t) => askedSymbols.includes(t.symbol)) } };
  } else {
    const id = query.match(/id: "([^"]+)"/)[1];
    data = { tokenSnapshots: { items: SNAPSHOTS[id] ? [SNAPSHOTS[id]] : [] } };
  }
  return { ok: true, json: async () => ({ data }) };
};

test.beforeEach(() => {
  supply = { [JQQQ]: 5000001.75, [HYB]: 0, [DEHYB]: 0 };
});

test("JQQQ: market cap is its Stellar supply at the fund's NAV, and no yield (it tracks the Nasdaq-100)", async () => {
  const out = await fetcher.fetchCentrifuge();
  assert.deepEqual(out["jqqq-caqypr"], {
    tvl: "$4.7M",
    supplyTokens: 5000001.75,
    tvlSource: "Centrifuge (Stellar supply × fund NAV)",
    asOf: "2026-11-04",
  });
});

test("HYB and deHYB both take the HYB fund's yield and NAV; deHYB's own Centrifuge token isn't used", async () => {
  supply[HYB] = 1000;
  supply[DEHYB] = 250;
  const out = await fetcher.fetchCentrifuge();
  for (const [slug, cap] of [["hyb-cbnt35", "$994"], ["dehyb-ccrth4", "$248"]]) { // 1,000 and 250 × $0.993723
    assert.equal(out[slug].yield7d, "11.79%", slug);
    assert.equal(out[slug].yield30d, "14.18%", slug);
    assert.equal(out[slug].source, "Centrifuge (fund APY)", slug);
    assert.equal(out[slug].tvl, cap, slug);
  }
  assert.ok(!askedSymbols.includes("deHYB"), `asked for ${askedSymbols}`);
});

test("nothing issued on Stellar yet: the yield is shown, the market cap isn't (never a guessed $0)", async () => {
  const out = await fetcher.fetchCentrifuge();
  assert.equal(out["hyb-cbnt35"].yield7d, "11.79%");
  assert.equal(out["hyb-cbnt35"].tvl, null);
  assert.equal(out["hyb-cbnt35"].supplyTokens, 0);
});

test("every Centrifuge token the fetcher values is in the RWA catalog, at the same contract", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "rwa-catalog.json"), "utf8"));
  const bySlug = new Map();
  for (const cat of catalog.categories) {
    for (const a of cat.assets) {
      const slug = `${a.code.toLowerCase()}-${(a.issuer || a.contractId).toLowerCase().slice(0, 6)}`;
      assert.ok(!bySlug.has(slug), `two catalog assets share the slug ${slug}`);
      assert.ok(!!a.issuer !== !!a.contractId, `${a.code}: set issuer or contractId, not both`);
      bySlug.set(slug, { ...a, category: cat.id });
    }
  }
  for (const wrappers of Object.values(fetcher.CENTRIFUGE_TOKENS)) {
    for (const w of wrappers) {
      assert.equal(bySlug.get(w.slug)?.contractId, w.stellarContractId, `${w.slug} missing from the catalog or at another contract`);
    }
  }
  assert.equal(bySlug.get("jqqq-caqypr").category, "tokenized-equities");
  assert.deepEqual(["hyb-cbnt35", "dehyb-ccrth4"].map((s) => bySlug.get(s).category), ["corporate-bonds", "corporate-bonds"]);
});
