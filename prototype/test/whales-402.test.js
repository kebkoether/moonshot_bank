// The home page's two leaderboards say why they're empty.
//
// Both come from Stellar Expert's holder lists, and its API now answers
// HTTP 402 Payment Required for them (x402: 0.02 USDC a request). The
// endpoints returned an empty list and the page showed "No data available".
// The XLM list was also read afresh on every home page visit.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const StellarSdk = require("@stellar/stellar-sdk");

const W1 = "GAPRPZYCIV3QPMCTWSRDNY64EJMZNCJFUCTJHQDQNW6RJ66TEVEH5UDU";
const W2 = "GD4GKHIXTT435TQD6WGUXJQGYSZCI7G4WG2Y63JLPF7SCRC35OOM4AC7";

let seAnswer; // () => Response for any api.stellar.expert request
let seCalls;
const realFetch = global.fetch;
const P = StellarSdk.Horizon.Server.prototype;
const realLoad = P.loadAccount;

test.before(() => {
  global.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, ...rest);
    if (u.startsWith("https://api.stellar.expert/")) { seCalls.push(u); return seAnswer(u); }
    if (u.includes("api.coingecko.com")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 503 });
  };
  P.loadAccount = async (id) => ({ id, balances: [{ asset_type: "native", balance: "1.0" }, { asset_type: "native", balance: "1.0" }] });
});
test.after(() => { global.fetch = realFetch; P.loadAccount = realLoad; });

const paymentRequired = () => new Response(JSON.stringify({ error: "Payment Required. Payment required", status: 402 }), {
  status: 402, headers: { "content-type": "application/json", "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0=" },
});

const { app } = require("../server.js");

test("XLM leaderboard: a 402 from Stellar Expert says why it's empty, and isn't asked again for 10 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  seCalls = [];
  seAnswer = paymentRequired;
  const res = await request(app, "GET", "/api/v1/whales");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { whales: [], unavailable: "Stellar Expert, which supplies the holder lists, now charges for them." });
  await request(app, "GET", "/api/v1/whales");
  assert.equal(seCalls.length, 1, "kept, not asked on every visit");

  // Ten minutes on, it's asked again, and a list that comes back is kept.
  t.mock.timers.setTime(1_800_000_000_000 + 10 * 60_000 + 1);
  seAnswer = () => new Response(JSON.stringify({ _embedded: { records: [
    { address: W1, balance: String(2_000_000_000 * 1e7) },
    { address: W2, balance: String(500_000_000 * 1e7) },
  ] } }), { status: 200 });
  const ok = await request(app, "GET", "/api/v1/whales");
  assert.deepEqual(ok.body.whales.map((w) => [w.address, w.balance, w.assetCount]), [[W1, 2_000_000_000, 2], [W2, 500_000_000, 2]]);
  assert.equal(ok.body.unavailable, undefined);
  await request(app, "GET", "/api/v1/whales");
  assert.equal(seCalls.length, 2);
});

test("portfolio leaderboard: holder lists all refused with 402 say why it's empty", async () => {
  seCalls = [];
  seAnswer = paymentRequired;
  // refresh=1 starts the computation (at boot the server starts it itself).
  const res = await request(app, "GET", "/api/v1/portfolio-whales?refresh=1");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.whales, []);
  assert.equal(res.body.unavailable, "Stellar Expert, which supplies the holder lists, now charges for them.");
  assert.ok(seCalls.length > 0 && seCalls.every((u) => u.includes("/holders")));
});

test("the page shows the reason in place of 'No data available'", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const shown = html.match(/\$\{escapeHtml\(data\.unavailable \|\| "No data available"\)\}/g) || [];
  assert.equal(shown.length, 2, "both leaderboards");
  assert.doesNotMatch(html, />No data available</);
});
