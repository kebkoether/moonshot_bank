// The NFTs tab reads an asset's supply and holders from Horizon's /assets.
//
// Horizon no longer sends the flat `amount` and `num_accounts` the resolver
// read, so both came out empty: any asset held as one stroop or one unit
// scored as a "Maybe" NFT (VELO, with a supply in the billions), and the
// reject for a large supply never ran. These run the resolver against a fake
// Horizon serving records in today's shape, and in the old one.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@stellar/stellar-sdk");

const { resolveNfts, _internal } = require("../lib/nft-resolver");

/** A fake Horizon: /assets records by code, and every issuer without a home domain. */
function fakeHorizon(records) {
  const calls = { assets: 0, accounts: 0 };
  return {
    calls,
    assets() {
      let code;
      const q = {
        forCode(c) { code = c; return q; },
        forIssuer() { return q; },
        limit() { return q; },
        async call() { calls.assets++; return { records: records[code] ? [records[code]] : [] }; },
      };
      return q;
    },
    async loadAccount() { calls.accounts++; return { home_domain: null }; },
  };
}

const holding = (code, balance) => ({
  asset_type: code.length > 4 ? "credit_alphanum12" : "credit_alphanum4",
  asset_code: code,
  asset_issuer: Keypair.random().publicKey(),
  balance,
});

// Horizon's /assets record today: supply split by where it sits, holders by authorization.
const record = ({ authorized = "0.0000000", contracts = "0.0000000", holders = 0 } = {}) => ({
  accounts: { authorized: holders, authorized_to_maintain_liabilities: 0, unauthorized: 0 },
  balances: { authorized, authorized_to_maintain_liabilities: "0.0000000", unauthorized: "0.0000000" },
  claimable_balances_amount: "0.0000000",
  liquidity_pools_amount: "0.0000000",
  contracts_amount: contracts,
  flags: {},
});

test("a stroop of a token with a supply in the billions isn't an NFT", async () => {
  const h = fakeHorizon({ VELO: record({ authorized: "29999999999.9999999", holders: 61_000 }) });
  const nfts = await resolveNfts(h, [holding("VELO", "0.0000001")]);
  assert.deepEqual(nfts, []);
  assert.equal(h.calls.accounts, 0, "rejected on supply, before looking up the issuer");
});

test("a one-of-one reads its supply and holders, and scores as likely", async () => {
  const h = fakeHorizon({ SKULL4639: record({ authorized: "0.0000001", holders: 1 }) });
  const [nft] = await resolveNfts(h, [holding("SKULL4639", "0.0000001")]);
  assert.equal(nft.supply, 0.0000001);
  assert.equal(nft.numAccounts, 1);
  assert.equal(nft.confidence, 0.8, "one stroop held, supply of one stroop, one holder");
});

test("units in contracts count toward the supply", async () => {
  // 10 on trustlines, 5,000 in a Soroban contract: not a small-supply asset.
  const h = fakeHorizon({ WRAP: record({ authorized: "10.0000000", contracts: "5000.0000000", holders: 3 }) });
  assert.deepEqual(await resolveNfts(h, [holding("WRAP", "1.0000000")]), []);
});

test("holders are counted across authorization states", () => {
  assert.equal(_internal.holdersOf({ accounts: { authorized: 4, authorized_to_maintain_liabilities: 2, unauthorized: 1 } }), 7);
  assert.equal(_internal.holdersOf({ accounts: { authorized: "4" } }), null, "a malformed count isn't a count");
  assert.equal(_internal.holdersOf({}), null);
});

test("a record in the old shape (flat amount and num_accounts) still reads", async () => {
  const h = fakeHorizon({ OLDNFT: { amount: "1.0000000", num_accounts: 1, flags: {} } });
  const [nft] = await resolveNfts(h, [holding("OLDNFT", "1.0000000")]);
  assert.equal(nft.supply, 1);
  assert.equal(nft.numAccounts, 1);
  assert.equal(nft.confidence, 0.8);
});

test("no record: supply and holders unknown, as before", async () => {
  const [nft] = await resolveNfts(fakeHorizon({}), [holding("GONE", "1.0000000")]);
  assert.equal(nft.supply, null);
  assert.equal(nft.numAccounts, null);
  assert.equal(nft.confidence, 0.35);
});

test("an empty trustline isn't an NFT, whatever the asset's supply", async () => {
  const h = fakeHorizon({ CITIZENCE: record({ authorized: "0.0000000", holders: 31 }) });
  assert.deepEqual(await resolveNfts(h, [holding("CITIZENCE", "0.0000000")]), []);
  assert.equal(h.calls.assets, 0, "no lookups for a holding of nothing");
});
