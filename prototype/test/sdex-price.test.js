// The pricing engine's order-book layer: when an asset's XLM book has no
// usable mid price, a tight and deep USDC book prices it, not a lone XLM bid.
//
// On 2026-11-04 Etherfuse's USTRY traded at 1.0790 / 1.0795 USDC, with about
// $275K of orders on each side, but its XLM book was 5.07 / 7.00 XLM. The XLM
// bid made USTRY $0.83, 23% short in every wallet and on the RWA tab.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Asset } = require("@stellar/stellar-sdk");

const { createSdexPricer, USDC_MIN_DEPTH_USD } = require("../lib/sdex-price");

const XLM_USD = 0.1632;
const ETHERFUSE = "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC";
const OTHER = "GA6U3A3WJREWMRNZX4XQBYV6U3QHWHGFM5ERYMQEB4EHFMAMBVVNCLZ7"; // SEAGLE's issuer

const o = (price, amount) => ({ price: String(price), amount: String(amount) });

// USTRY's books on 2026-11-04 (top levels). A bid's amount is in the
// counter asset (XLM or USDC); an ask's is in USTRY.
const USTRY_XLM = { bids: [o(5.07001, 24.0550123)], asks: [o(6.9999998, 1.6581273)] };
const USTRY_USDC = {
  bids: [o(1.0789552, 5507.9874770), o(1.0786195, 53063.4570771), o(1.0775945, 216666.9192328)],
  asks: [o(1.0794948, 5158.6061945), o(1.0796986, 51595.7037820), o(1.0807241, 196716.0741904)],
};

/** A fake Horizon whose order books are given per counter asset ("XLM" or "USDC"). */
function fakeHorizon(books) {
  const calls = [];
  return {
    calls,
    orderbook(selling, buying) {
      const counter = buying.isNative() ? "XLM" : buying.getCode();
      calls.push(counter);
      return {
        call: async () => {
          const b = books[counter];
          if (b instanceof Error) throw b;
          return b || { bids: [], asks: [] };
        },
      };
    },
  };
}

function pricer(books) {
  const horizon = fakeHorizon(books);
  const price = createSdexPricer({ horizon, getXLMPrice: async () => ({ usd: XLM_USD }) });
  return { price, calls: horizon.calls };
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

test("USTRY: a wide XLM book and a deep USDC book give the USDC mid", async () => {
  const { price } = pricer({ XLM: USTRY_XLM, USDC: USTRY_USDC });
  const p = await price("USTRY", ETHERFUSE);
  assert.ok(close(p.usd, (1.0789552 + 1.0794948) / 2), `got ${p.usd}`);
  assert.equal(p.pair, "USDC");
});

test("a tight XLM book prices the asset as before, without reading the USDC book", async () => {
  const { price, calls } = pricer({ XLM: { bids: [o(6.6, 100)], asks: [o(6.65, 100)] }, USDC: USTRY_USDC });
  const p = await price("USTRY", ETHERFUSE);
  assert.ok(close(p.usd, 6.625 * XLM_USD));
  assert.equal(p.pair, "XLM");
  assert.deepEqual(calls, ["XLM"]);
});

test("a thin USDC book doesn't set the price: the XLM bid is used, as before", async () => {
  // SEAGLE on 2026-11-04: $2.88 of USDC bids against a 0.1 XLM bid.
  const { price } = pricer({
    XLM: { bids: [o(0.1, 50)], asks: [] },
    USDC: { bids: [o(53.232, 2.88)], asks: [o(57.668, 1179.8)] },
  });
  const p = await price("SEAGLE", OTHER);
  assert.ok(close(p.usd, 0.1 * XLM_USD));
  assert.equal(p.pair, "XLM");
});

test("only orders within 10% of the mid count toward the depth", async () => {
  const { price } = pricer({
    XLM: { bids: [o(5, 10)], asks: [o(7, 10)] },
    // $10 of bids at the top, then $100,000 at 15% under the mid.
    USDC: { bids: [o(1.0, 10), o(0.86, 100000)], asks: [o(1.01, 5000)] },
  });
  assert.equal((await price("TOKEN", OTHER)).pair, "XLM");

  const deep = pricer({
    XLM: { bids: [o(5, 10)], asks: [o(7, 10)] },
    USDC: { bids: [o(1.0, 10), o(0.96, USDC_MIN_DEPTH_USD)], asks: [o(1.01, 5000)] },
  });
  assert.equal((await deep.price("TOKEN", OTHER)).pair, "USDC");
});

test("a wide USDC book doesn't set the price either", async () => {
  const { price } = pricer({
    XLM: { bids: [o(5, 10)], asks: [o(7, 10)] },
    USDC: { bids: [o(1.0, 50000)], asks: [o(1.2, 50000)] },
  });
  assert.ok(close((await price("TOKEN", OTHER)).usd, 5 * XLM_USD));
});

test("with no XLM bids, a deep USDC book prices the asset; with nothing, there's no price", async () => {
  const noXlm = pricer({ XLM: { bids: [], asks: [] }, USDC: USTRY_USDC });
  assert.equal((await noXlm.price("USTRY", ETHERFUSE)).pair, "USDC");

  const asksOnly = pricer({ XLM: { bids: [], asks: [o(7, 10)] } });
  assert.equal(await asksOnly.price("USTRY", ETHERFUSE), null);

  const nothing = pricer({});
  assert.equal(await nothing.price("USTRY", ETHERFUSE), null);
});

test("if the USDC book can't be read, the XLM bid is used as before", async () => {
  const { price } = pricer({ XLM: USTRY_XLM, USDC: new Error("Horizon 503") });
  const p = await price("USTRY", ETHERFUSE);
  assert.ok(close(p.usd, 5.07001 * XLM_USD));
});

test("USDC itself isn't checked against its own book", async () => {
  const { price, calls } = pricer({ XLM: { bids: [o(5, 10)], asks: [o(7, 10)] } });
  await price("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  assert.deepEqual(calls, ["XLM"]);
});

test("the pricing engine passes the USDC-book price on for a wallet's USTRY", async () => {
  const aggregator = require("../lib/soroswap-aggregator");
  aggregator.priceClassicAssetViaSACInUSD = async () => null;
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) }); // no CoinGecko
  try {
    const pricing = require("../lib/pricing-engine");
    const { price } = pricer({ XLM: USTRY_XLM, USDC: USTRY_USDC });
    const p = await pricing.priceClassicAsset({ priceViaSDEX: price }, "USTRY", ETHERFUSE);
    assert.equal(p.source, "sdex");
    assert.ok(close(p.usd, (1.0789552 + 1.0794948) / 2));
  } finally {
    global.fetch = realFetch;
  }
});
