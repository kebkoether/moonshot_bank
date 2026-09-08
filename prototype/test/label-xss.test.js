const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@stellar/stellar-sdk");

const historyDb = require("../lib/history-db");
const profiles = require("../lib/public-profiles");
const { app, __setTestDeps } = require("../server.js");

__setTestDeps({
  getHorizon: () => ({
    loadAccount: async (address) => ({
      balances: [{ asset_type: "native", balance: "100.0000000" }],
      accountId: () => address,
    }),
  }),
  getXLMPrice: async () => ({ usd: 0.12, change24h: 0, source: "test", confidence: "high" }),
  collectDefiPositions: async () => ({ defiPositions: [], defiByPool: [], totalUSD: 0, degraded: [] }),
  resolveSorobanTokens: async () => [],
  discoverSorobanTokens: async () => [],
  primeKnownPrices: async () => {},
});

const PAYLOAD = '<img src=x onerror="document.title=\'XSS\'">';
const addr = () => Keypair.random().publicKey();
const labelOf = (a) =>
  historyDb.db.prepare("SELECT label FROM tracked_wallets WHERE address = ?").get(a)?.label;

test("VECTOR 1 (write): PATCH /wallets cannot store a payload label", async () => {
  const a = addr();
  historyDb.trackWallet(a);
  const res = await request(app, "PATCH", `/api/v1/wallets/${a}`, { body: { label: PAYLOAD } });
  assert.equal(res.status, 200, res.raw);
  const stored = labelOf(a);
  assert.ok(!stored.includes("<"), `stored: ${JSON.stringify(stored)}`);
  assert.ok(!stored.includes(">"), `stored: ${JSON.stringify(stored)}`);
});

test("VECTOR 1 (write): POST /wallets cannot store a payload label", async () => {
  const a = addr();
  const res = await request(app, "POST", "/api/v1/wallets", { body: { address: a, label: PAYLOAD } });
  assert.equal(res.status, 200, res.raw);
  const stored = labelOf(a);
  assert.ok(!stored.includes("<") && !stored.includes(">"), `stored: ${JSON.stringify(stored)}`);
});

test("VECTOR 1 (read-back): a label is never served to another caller", async () => {
  // tracked_wallets is global and was writable for any address, and
  // POST /api/v1/portfolio was the only place that read the column back out —
  // so one visitor's label reached every other visitor who queried that
  // address. The response no longer carries it at all.
  const a = addr();
  historyDb.trackWallet(a, "mainnet", "someone elses label");
  assert.equal(labelOf(a), "someone elses label");

  const res = await request(app, "POST", "/api/v1/portfolio", { body: { addresses: [a] } });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.wallets[0].label, null);
  assert.ok(
    !res.raw.includes("someone elses label"),
    "the label appeared somewhere in the response body"
  );
});

test("labels are length-capped at the write boundary", async () => {
  const a = addr();
  await request(app, "POST", "/api/v1/wallets", { body: { address: a, label: "x".repeat(5000) } });
  assert.equal(labelOf(a).length, 40);
});

test("an ordinary label survives the write path intact", async () => {
  const a = addr();
  const benign = "Mum's wallet — 50% & rising";
  await request(app, "POST", "/api/v1/wallets", { body: { address: a, label: benign } });
  assert.equal(labelOf(a), benign);
});

test("profile fields are filtered on create and on patch", async () => {
  const owner = Keypair.random();
  const profileAuth = require("../lib/profile-auth");
  const { signChallenge } = require("./helpers");
  const slug = `x${Date.now().toString(36)}`;
  const claim = signChallenge(profileAuth, { keypair: owner, action: "create-profile", slug });

  const created = await request(app, "POST", "/api/v1/profiles", {
    body: {
      slug,
      displayName: PAYLOAD,
      bio: `<script>alert(1)</script>`,
      avatarEmoji: "<b>",
      wallets: [{
        address: owner.publicKey(),
        challengeToken: claim.challengeToken,
        signature: claim.signature,
        label: PAYLOAD,
      }],
    },
  });
  assert.equal(created.status, 200, created.raw);
  const p = profiles.getProfile(slug);
  for (const field of [p.displayName, p.bio, p.avatarEmoji, p.wallets[0].label]) {
    assert.ok(field === null || (!String(field).includes("<") && !String(field).includes(">")),
      `unfiltered: ${JSON.stringify(field)}`);
  }

  const patchAuth = signChallenge(profileAuth, { keypair: owner, action: "modify-profile", slug });
  const patched = await request(app, "PATCH", `/api/v1/profiles/${slug}`, {
    body: { ...patchAuth, bio: PAYLOAD },
  });
  assert.equal(patched.status, 200, patched.raw);
  assert.ok(!profiles.getProfile(slug).bio.includes("<"));
});

test("the label backfill cleans stored payloads and leaves benign ones alone", () => {
  // Anything written before the filter existed is still in the database.
  const a = addr();
  const b = addr();
  historyDb.trackWallet(a);
  historyDb.trackWallet(b);
  historyDb.db.prepare("UPDATE tracked_wallets SET label = ? WHERE address = ?").run(PAYLOAD, a);
  historyDb.db.prepare("UPDATE tracked_wallets SET label = ? WHERE address = ?")
    .run("Mum's wallet — 50% & rising", b);

  // Clear the once-per-database marker so the backfill runs again here.
  historyDb.db.prepare("DELETE FROM schema_meta WHERE key = ?").run("tracked_wallet_labels_filtered");
  historyDb.runBackfills();

  assert.ok(!labelOf(a).includes("<"), `not cleaned: ${JSON.stringify(labelOf(a))}`);
  assert.equal(labelOf(b), "Mum's wallet — 50% & rising", "a benign label was modified");
});

// ── Render side ───────────────────────────────────────────────────────────
//
// There is no DOM harness here and adding one for this is not worth it, so
// these assert on the SOURCE of index.html. They are guardrails against the
// specific patterns that caused the bug, not a substitute for the manual
// browser sweep recorded in the PR description.

const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("no inline event handler is built by string interpolation", () => {
  // `onclick="fn('${addr}')"` is JavaScript source assembled from data, and
  // escapeHtml is the wrong escaper for it: the HTML parser decodes entities
  // before the JS parser sees them. These are data-* attributes plus one
  // delegated listener now.
  const offenders = INDEX.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\son[a-z]+="[^"]*\$\{/.test(line));
  assert.deepEqual(offenders, [], `interpolated inline handlers: ${JSON.stringify(offenders)}`);
});

test("index.html defines exactly one escaper and one URL guard", () => {
  // There used to be three: two identical `function escapeHtml` declarations in
  // the SAME scope (the later silently winning) plus escapeShareHtml.
  assert.equal((INDEX.match(/function escapeHtml\s*\(/g) || []).length, 1);
  assert.equal((INDEX.match(/function escapeShareHtml\s*\(/g) || []).length, 0);
  assert.equal((INDEX.match(/function safeUrl\s*\(/g) || []).length, 1);
});

test("every interpolated href/src goes through safeUrl", () => {
  const offenders = INDEX.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /(href|src)="\$\{/.test(line) && !/safeUrl\(/.test(line));
  assert.deepEqual(offenders, [], `unguarded URL interpolation: ${JSON.stringify(offenders)}`);
});

test("the wallet-label render sites all escape", () => {
  for (const pattern of [
    /<div class="wallet-item-label">\$\{label\}<\/div>/,
    /class="portfolio-address">\$\{d\.label \? escapeHtml\(d\.label\)/,
    /title="\$\{escapeHtml\(w\.label \|\| w\.address\)\}"/,
  ]) {
    assert.match(INDEX, pattern);
  }
  // `label` in the wallet list and the agg chips is escaped where it is built.
  assert.match(INDEX, /const label = escapeHtml\(w\.label \|\| shortenAddr\(w\.address\)\);/);
});

test("the ?import= share payload filters labels and caps the list", () => {
  assert.match(INDEX, /label: cleanLabel\(w\.l \?\? w\.label\)/);
  assert.match(INDEX, /\.slice\(0, 25\);/);
});

test("Soroban-derived DeFi names are escaped", () => {
  for (const pattern of [
    /escapeHtml\(group\.poolName\)/,
    /escapeHtml\(protocolLabel\)/,
    /escapeHtml\(row\.asset\)/,
  ]) {
    assert.match(INDEX, pattern);
  }
});
