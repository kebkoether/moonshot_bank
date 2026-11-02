// "Download CSV": every balance and DeFi position on screen as a spreadsheet
// file (public/holdings-csv.js builds it, index.html's button downloads it).
//
// Closing a period starts from what each wallet holds at period end, by
// venue. The page showed it but there was no way to take it away: copying a
// $131M portfolio out of the page by hand was the only option.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const H = require("../public/holdings-csv.js");
const { app } = require("../server.js");

const A = "GCTSFIICPYZW2R6HWA25IWDHQYSFBJJUAXVYHGUQ7K64G54ZQ6OOJUF6";
const B = "GDLVR5MPWXWQNN5TSHIYZ3EVI47YVJ7JOEGODGU54USF24VNBNJ32XJQ";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const AS_OF = "2026-11-02T14:05:23.123Z";

// One of each shape the API returns (trimmed to what the file uses).
const WALLET_A = {
  address: A,
  balances: [
    { type: "native", balance: "1000.5", valueUSD: 167.08, price: { usd: 0.167 } },
    { type: "token", asset: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }, balance: "250", valueUSD: 250, price: { usd: 1 } },
    { type: "soroban_token", asset: { code: "SOLVBTC", contractId: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN" }, balance: "1.41641108", valueUSD: 108546.66, price: { usd: 76635 } },
    { type: "token", asset: { code: "SPAM", issuer: "GB2LKTNIJQ2X5NHSVFNFYYYCYBPZRDXL6PGMVOWLBZ7Q4UWXKHFCDNPO" }, balance: "5000", valueUSD: 0, price: null },
    { type: "lp_share", poolId: "a468d41d8e9b8f3c7209651608b74b7db7ac9952dcae0cdf24871d1d9c7b0088", shares: "0.4351714", valueUSD: 0 },
  ],
  defiPositions: [
    { protocol: "blend", type: "lending", subtype: "collateral", poolName: "Fixed Pool V2", asset: "XLM", assetAddress: XLM_SAC, underlyingAmount: 698040241.6867, valueUSD: 116573720.36 },
    { protocol: "blend", type: "borrowing", subtype: "liability", poolName: "Fixed Pool V2", asset: "USDC", assetAddress: USDC, underlyingAmount: 39285772.8892, valueUSD: -39285772.8892 },
    { protocol: "blend", type: "lending", subtype: "collateral", poolName: "Forex Pool V2", asset: "CETES", underlyingAmount: 100, valueUSD: 0, unpriced: true },
    { protocol: "aquarius", type: "lp", tokens: [{ symbol: "PYUSD", contractId: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2" }, { symbol: "USDC", contractId: USDC }],
      token0: { symbol: "PYUSD" }, token1: { symbol: "USDC" }, amounts: { token0: "4446868.58599", token1: "3554526.531553" }, valueUSD: 8001395.12 },
    { protocol: "aquarius", type: "lp", tokens: [{ symbol: "USDC" }, { symbol: "USDx" }, { symbol: "yUSDC" }],
      amounts: [{ symbol: "USDC", amount: "10" }, { symbol: "USDx", amount: "20" }, { symbol: "yUSDC", amount: "30" }], valueUSD: 60, stale: true },
    { protocol: "templar", type: "vault", vaultName: "Templar lending position", deposited: { amount: "1000.00", asset: "USDC" }, borrow: { amount: "500.00", asset: "XLM" }, valueUSD: 916.5 },
    { protocol: "solv-protocol", type: "staking", staked: { amount: "1.5", asset: "SolvBTC" }, valueUSD: 0, unpriced: true },
  ],
  defiByPool: [
    { protocol: "blend", poolName: "Fixed Pool V2", totalPendingBlnd: 119 },
    { protocol: "blend", poolName: "Forex Pool V2", totalPendingBlnd: 0 },
  ],
};
WALLET_A.totalValueUSD = [...WALLET_A.balances, ...WALLET_A.defiPositions].reduce((s, x) => s + (x.valueUSD || 0), 0);

const WALLET_B = {
  address: B,
  label: "Sentora vault",
  balances: [{ type: "native", balance: "29", valueUSD: 4.84, price: { usd: 0.167 } }],
  defiPositions: [
    { protocol: "upshift", type: "vault", vaultName: "Sentora USDC", deposited: { amount: "28555049", asset: "USDC" }, yield: { accrued: "743644", asset: "USDC", apy: 7.9 }, valueUSD: 29298693.45 },
  ],
};

// A small RFC 4180 reader, so the tests read the file the way a spreadsheet does.
function parse(csv) {
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) { if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && csv[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += c;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const total = (rows) => rows.reduce((s, r) => s + (r.value_usd === "" ? 0 : Number(r.value_usd)), 0);

test("one row per balance and position, and value_usd adds up to the portfolio total", () => {
  const rows = parse(H.build([WALLET_A], { asOf: AS_OF }));
  assert.equal(rows.filter((r) => r.side !== "unclaimed reward").length, WALLET_A.balances.length + WALLET_A.defiPositions.length);
  assert.ok(Math.abs(total(rows) - WALLET_A.totalValueUSD) < 0.05, `${total(rows)} vs ${WALLET_A.totalValueUSD}`);
  assert.ok(rows.every((r) => r.as_of_utc === AS_OF && r.wallet === A));
});

test("balances: the asset's issuer or contract, the amount as given, and 'no price' when there isn't one", () => {
  const rows = parse(H.build([WALLET_A], { asOf: AS_OF })).filter((r) => r.venue === "Wallet");
  assert.deepEqual(rows.map((r) => [r.asset_1, r.amount_1, r.asset_1_id, r.value_usd, r.notes]), [
    ["XLM", "1000.5", "native", "167.08", ""],
    ["USDC", "250", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "250.00", ""],
    ["SOLVBTC", "1.41641108", "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN", "108546.66", ""],
    ["SPAM", "5000", "GB2LKTNIJQ2X5NHSVFNFYYYCYBPZRDXL6PGMVOWLBZ7Q4UWXKHFCDNPO", "0.00", "no price"],
  ]);
  const lp = parse(H.build([WALLET_A], { asOf: AS_OF })).find((r) => r.venue === "Stellar AMM");
  assert.deepEqual([lp.side, lp.asset_1, lp.amount_1, lp.asset_1_id], ["liquidity pool", "pool shares", "0.4351714", WALLET_A.balances[4].poolId]);
});

test("DeFi: venue, pool or vault, each asset (borrowed negative), and the position's value", () => {
  const rows = parse(H.build([WALLET_A], { asOf: AS_OF })).filter((r) => r.venue !== "Wallet" && r.venue !== "Stellar AMM" && r.side !== "unclaimed reward");
  const pick = (r) => [r.venue, r.position, r.side, r.value_usd, r.asset_1, r.amount_1, r.asset_1_id, r.asset_2, r.amount_2, r.asset_3, r.amount_3, r.notes];
  assert.deepEqual(rows.map(pick), [
    ["Blend", "Fixed Pool V2", "supplied", "116573720.36", "XLM", "698040241.6867", XLM_SAC, "", "", "", "", ""],
    ["Blend", "Fixed Pool V2", "borrowed", "-39285772.89", "USDC", "-39285772.8892", USDC, "", "", "", "", ""],
    ["Blend", "Forex Pool V2", "supplied", "0.00", "CETES", "100", "", "", "", "", "", "no price"],
    ["Aquarius", "PYUSD/USDC", "liquidity pool", "8001395.12", "PYUSD", "4446868.58599", "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2", "USDC", "3554526.531553", "", "", ""],
    ["Aquarius", "", "liquidity pool", "60.00", "USDC", "10", "", "USDx", "20", "yUSDC", "30", "last good result: the protocol didn't answer this time"],
    ["Templar Finance", "Templar lending position", "vault", "916.50", "USDC", "1000.00", "", "XLM", "-500.00", "", "", ""],
    ["Solv Protocol", "", "staking", "0.00", "SolvBTC", "1.5", "", "", "", "", "", "no price"],
  ]);
});

test("a vault's amount is its deposit plus the yield it has earned", () => {
  const [, vault] = parse(H.build([WALLET_B], { asOf: AS_OF }));
  assert.deepEqual([vault.venue, vault.position, vault.asset_1, vault.amount_1, vault.value_usd], ["Upshift", "Sentora USDC", "USDC", "29298693", "29298693.45"]);
  assert.equal(vault.notes, "includes 743644 USDC of yield on 28555049 deposited");
});

test("unclaimed rewards get their own rows, with no value_usd, so the total is unchanged", () => {
  const withRewards = {
    ...WALLET_A,
    defiPositions: WALLET_A.defiPositions.map((p, i) => (i === 3
      ? { ...p, unclaimedRewards: [{ asset: "AQUA", contractId: "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK", amount: 6633529.54, valueUSD: 1865.41 }] }
      : i === 4 ? { ...p, unclaimedRewards: null } : p)),
  };
  const rows = parse(H.build([withRewards], { asOf: AS_OF }));
  const rewards = rows.filter((r) => r.side === "unclaimed reward");
  assert.deepEqual(rewards.map((r) => [r.venue, r.position, r.asset_1, r.amount_1, r.value_usd, r.notes]), [
    ["Aquarius", "PYUSD/USDC", "AQUA", "6633529.54", "", "about $1865.41 at the current price; not in the total until claimed"],
    ["Aquarius", "", "", "", "", "couldn't be read this time"],
    ["Blend", "Fixed Pool V2", "BLND", "119", "", "no price; not in the total until claimed"],
  ]);
  assert.ok(Math.abs(total(rows) - WALLET_A.totalValueUSD) < 0.05);
});

test("all wallets: each wallet's rows, with its label", () => {
  const rows = parse(H.build([WALLET_A, WALLET_B], { asOf: AS_OF }));
  assert.deepEqual([...new Set(rows.map((r) => r.wallet))], [A, B]);
  assert.ok(rows.filter((r) => r.wallet === B).every((r) => r.label === "Sentora vault"));
  assert.ok(Math.abs(total(rows) - WALLET_A.totalValueUSD - 4.84 - 29298693.45) < 0.05);
});

test("text from a chain or a user can't start a formula, and commas, quotes and line breaks survive", () => {
  const evil = {
    address: A,
    label: '=HYPERLINK("http://x","click")',
    balances: [{ type: "token", asset: { code: "+SUM(A1)", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }, balance: "1", valueUSD: 1, price: { usd: 1 } }],
    defiPositions: [{ protocol: "aquarius", type: "lp", poolName: '@cmd, "quoted"\nname', token0: { symbol: "-1+1" }, token1: { symbol: "USDC" }, amounts: { token0: "2", token1: "3" }, valueUSD: -5 }],
  };
  const csv = H.build([evil], { asOf: AS_OF });
  const [bal, lp] = parse(csv);
  assert.equal(bal.label, `'=HYPERLINK("http://x","click")`);
  assert.equal(bal.asset_1, "'+SUM(A1)");
  assert.equal(lp.position, `'@cmd, "quoted"\nname`);
  assert.equal(lp.asset_1, "'-1+1");
  assert.equal(lp.value_usd, "-5.00", "a number stays a number");
  assert.ok(csv.endsWith("\r\n") && csv.startsWith(H.COLUMNS.join(",") + "\r\n"));
});

test("the file name says whose holdings and when", () => {
  assert.equal(H.fileName(A, AS_OF), "stellarscope-GCTSFIIC-2026-11-02T1405Z.csv");
  assert.equal(H.fileName(null, AS_OF), "stellarscope-all-wallets-2026-11-02T1405Z.csv");
});

test("the page loads the builder and has the button in each portfolio view", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<script src="holdings-csv\.js"><\/script>/);
  assert.equal((html.match(/data-action="download-csv"/g) || []).length, 3, "single wallet, wallet in the panel, all wallets");
  assert.match(html, /case "download-csv":\s*downloadHoldingsCsv\(\);/);
  const res = await request(app, "GET", "/holdings-csv.js");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /javascript/);
});
