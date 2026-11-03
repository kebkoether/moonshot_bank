// Each "pick a wallet" button names a wallet the vendored kit actually has.
//
// The buttons call StellarWalletsKit.setWallet(<data-wallet-id>), which throws
// unless one of the page's modules has that productId. Kit 2.8.0 renamed
// Freighter to Varial and its id from "freighter" to "varial": rebuilding the
// bundle alone would have left the Freighter button failing with
// 'Wallet id "freighter" is not and existing module'.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const bundleFile = path.join(__dirname, "..", "public", "vendor", "stellar-wallets-kit-2.3.0.js");

// The bundle is a self-contained ES module (no imports of its own).
const loadKit = () => import("data:text/javascript;base64," + fs.readFileSync(bundleFile).toString("base64"));

test("every name the page imports from the bundle is exported by it", async () => {
  const kit = await loadKit();
  const block = html.match(/import\s*\{([^}]+)\}\s*from\s*"\/vendor\/stellar-wallets-kit-2\.3\.0\.js"/);
  assert.ok(block, "the page's import from the vendored kit");
  const names = block[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(names.length >= 10);
  for (const name of names) assert.ok(name in kit, `the bundle doesn't export ${name}`);
});

test("every wallet button's id is the id of a wallet module the page loads", async () => {
  const kit = await loadKit();
  const modules = [...html.matchAll(/new (\w+Module)\(\)/g)].map((m) => m[1]);
  assert.ok(modules.length >= 5);
  const ids = modules.map((name) => new kit[name]().productId);
  const buttons = [...html.matchAll(/data-action="connect-wallet" data-wallet-id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(buttons.length, 5);
  for (const id of buttons) {
    assert.ok(ids.includes(id), `the "${id}" button would fail: the page's wallets are ${ids.join(", ")}`);
  }
});

test("Freighter is offered under its new name, Varial", async () => {
  const kit = await loadKit();
  const v = new kit.VarialModule();
  assert.deepEqual([v.productId, v.productName, v.productUrl], ["varial", "Varial", "https://varialwallet.com"]);
  assert.match(html, /data-wallet-id="varial" data-wallet-label="Varial" title="Connect Varial \(formerly Freighter\)"/);
});
