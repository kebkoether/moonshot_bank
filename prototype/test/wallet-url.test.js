// A looked-up wallet lives in the page address (#/account/G…), so a refresh
// keeps it, its link can be shared, and Back returns to it.
// public/wallet-url.js holds the rules; index.html follows them.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const U = require("../public/wallet-url.js");
const { app } = require("../server.js");

const A = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";

test("a well-formed G… address in #/account/ is the wallet to load", () => {
  assert.equal(U.accountFromHash(`#/account/${A}`), A);
});

test("anything else in the hash isn't", () => {
  for (const h of [
    "", "#", "#/", "#/rwas", "#/defi/blend", `#/account/`, `#/account/${A.toLowerCase()}`,
    `#/account/${A.slice(0, -1)}`, `#/account/${A}X`, `#/account/${A}/extra`,
    "#/account/CDK2LDSYUKPEFN3HNE7K7ETUT3VIOBHSOXAK5CTO4A4RKKZQUCAIWCJA", // a contract, not a wallet
    `#/account/<img src=x onerror=alert(1)>`, `#account/${A}`, `#/Account/${A}`,
  ]) assert.equal(U.accountFromHash(h), null, h);
  assert.equal(U.accountFromHash(undefined), null);
});

test("a lookup's address becomes its hash; something that isn't an address doesn't", () => {
  assert.equal(U.hashForAccount(A), `#/account/${A}`);
  assert.equal(U.hashForAccount(`  ${A} `), `#/account/${A}`, "the search box is trimmed the same way");
  for (const x of ["", "  ", "alice*lobstr.co", A.slice(1), null, undefined]) assert.equal(U.hashForAccount(x), null, String(x));
});

test("leaving a wallet adds a history entry, so Back returns to it; other tab switches don't", () => {
  assert.equal(U.historyAction(`#/account/${A}`, "#/rwas"), "push");
  assert.equal(U.historyAction(`#/account/${A}`, ""), "push");
  assert.equal(U.historyAction("", "#/rwas"), "replace");
  assert.equal(U.historyAction("#/defi", "#/rwas"), "replace");
  assert.equal(U.historyAction("#/rwas", ""), "replace");
  assert.equal(U.historyAction("#/rwas", "#/rwas"), "none");
  assert.equal(U.historyAction("", undefined), "none");
});

test("the page loads the rules before its own script and uses them", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const tag = html.indexOf('<script src="wallet-url.js"></script>');
  assert.ok(tag > 0, "script tag");
  assert.ok(tag < html.indexOf("function pageFromHash()"), "loaded before the page script");
  assert.match(html, /const account = WalletUrl\.accountFromHash\(h\);/, "pageFromHash reads it");
  assert.match(html, /WalletUrl\.hashForAccount\(address\)/, "loadPortfolio writes it");
  assert.match(html, /WalletUrl\.historyAction\(location\.hash, newHash\)/, "switchPage keeps Back working");
  const res = await request(app, "GET", "/wallet-url.js");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /javascript/);
});
