// Text the page didn't write itself must be escaped before it goes into HTML.
//
// A Soroban token's symbol and name come from its contract, and anyone can
// deploy a contract. The DeFi cards, the All Wallets token legend, the
// staking cards and the history rows put such text into innerHTML as it came.
// The CSP stops an injected <script> or onerror= from running, but injected
// markup still renders: a fake link, a form, an image, or text laid over the
// real figures.
//
// Like label-xss.test.js, these check the SOURCE of index.html (there is no
// DOM harness). The browser sweep that found the spots is in the PR.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// Fields that carry text from a contract, an API or Horizon.
const FIELD = /\.(symbol|code|assetCode|sourceAssetCode|asset|sellingAsset|buyingAsset|apy7d|name|poolName|vaultName|memo)\b|\.(amounts|unclaimedFees|staked|rewards)\./;
// Amounts and prices as they came, not through fmt().
const RAW_NUMBER = /^[\w.]+\.(amount|startingBalance|price)$/;

// Interpolations `${…}` of those fields that don't start with an escaper.
function unescaped(source) {
  const out = [];
  source.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\$\{([^{}]*)\}/g)) {
      const e = m[1].trim();
      if ((FIELD.test(e) || RAW_NUMBER.test(e)) && !/^(escapeHtml|encodeURIComponent)\(/.test(e)) out.push({ line: i + 1, expr: e });
    }
  });
  return out;
}

// Each is escaped where the string it builds is written into HTML.
const ALLOWED = new Map([
  ['(a.code || "").toLowerCase()', "rwaSlug(): the href is escaped and checked with safeUrl"],
  ["a.code", "stellarExpertUrl(): escaped and checked with safeUrl where used"],
  ["pos.vaultName", "builds protocolLabel, which is escaped where it's written"],
  ['n.asset.domain ? escapeHtml(n.asset.domain) : "no domain"', "escaped inside the condition"],
]);

test("the scan flags a raw field and passes an escaped one", () => {
  const sample = [
    "html += `<div>${pos.token0.symbol} / ${escapeHtml(pos.token1.symbol)}</div>`;",
    "amount = `${tx.amount} ${tx.assetCode}`;",
    "x = `${pos.staked.amount} ${escapeHtml(pos.rewards.asset)}`;",
    "y = `${escapeHtml(pos.amounts.token0)} ${fmt(pct)}% ${fmt(parseFloat(cb.amount))}`;",
  ].join("\n");
  assert.deepEqual(unescaped(sample).map((o) => o.expr), ["pos.token0.symbol", "tx.amount", "tx.assetCode", "pos.staked.amount"]);
});

test("no contract or API text is interpolated into the page unescaped", () => {
  const offenders = unescaped(INDEX).filter((o) => !ALLOWED.has(o.expr));
  assert.deepEqual(offenders, [], `unescaped: ${offenders.map((o) => `${o.line}: \${${o.expr}}`).join(", ")}`);
});

test("every allowed exception is still in the page", () => {
  // A stale entry would let a new raw interpolation of the same text through.
  const found = new Set(unescaped(INDEX).map((o) => o.expr));
  for (const expr of ALLOWED.keys()) assert.ok(found.has(expr), `no longer in index.html: ${expr}`);
});

test("text kept in a local variable is escaped where the variable is set", () => {
  // The scan above can't follow a local variable into the HTML.
  // The token legends, a wallet's and All Wallets':
  const legend = /const label = escapeHtml\((b\.code|b\.asset\.code)\);\n\s*breakdownHTML \+= `[^`\n]*title="\$\{label\}: \$\{fmt\(pct\)\}%"><\/div>`;\n\s*legendHTML \+= `[^`\n]*<\/div>\$\{label\} \$\{fmt\(pct\)\}%<\/div>`;/g;
  assert.deepEqual([...INDEX.matchAll(legend)].map((m) => m[1]).sort(), ["b.asset.code", "b.code"]);
  assert.equal((INDEX.match(/legendHTML \+= `<div class="legend-item">/g) || []).length, 2, "a new legend to check");
  // Claimable balances:
  assert.match(INDEX, /const code = escapeHtml\(cb\.asset\.code\);/);
  // The All Wallets pie legend's wallet labels (filtered when set, escaped here too):
  assert.match(INDEX, /<span class="pie-legend-label" title="\$\{escapeHtml\(w\.label \|\| w\.address\)\}">\$\{escapeHtml\(label\)\}<\/span>/);
});
