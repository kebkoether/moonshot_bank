// Upshift APYs are the ones Upshift shows.
//
// The DeFi tab's Upshift card took reported_apy, which only the Gami vaults
// have: Sentora USDC (the largest, $61M) and Sentora XLM showed "—". A
// wallet's Upshift position took the 7-day historical APY, which leaves out
// the Gami campaign's top-up (3.01% for Gami earnUSDC, where Upshift shows
// 10.00%) and is the wrong window for Sentora USDC (6.95%, not 8.04%).

const test = require("node:test");
const assert = require("node:assert/strict");

const { upshiftApy } = require("../lib/upshift-apy");

// The Stellar vaults' entries in Upshift's list on 2026-11-24 (the fields
// the APY uses), and what app.upshift.finance showed for each that day.
const VAULTS = [
  {
    "address": "CAY66YC6UHJVYN2UZJSTT3N6EKAXEWGLUDRVFVCUDKXIIF62I4SZFFNJ",
    "vault_name": "Sentora XLM",
    "chain_type": "stellar",
    "status": "active",
    "is_visible": true,
    "tvl": 837160,
    "default_apy_horizon": 7,
    "apy_override": null,
    "campaign_apy": null,
    "historical_apy": {
      "1": 0.06326177217815511,
      "7": 0.04453857480898748,
      "30": 0.0211691956438989
    },
    "historical_compound_apy": {
      "1": 0.06529983052539312,
      "7": 0.04552543117010721,
      "30": 0.021376064023278962
    },
    "stellar_vault_metadata": {
      "deposit_token_symbol": "XLM",
      "deposit_token_decimals": 7
    }
  },
  {
    "address": "CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY",
    "vault_name": "Gami earnUSDC",
    "chain_type": "stellar",
    "status": "active",
    "is_visible": true,
    "tvl": 31561234,
    "default_apy_horizon": 30,
    "apy_override": {
      "hardcoded_apy": null,
      "is_show_target_apy": false,
      "is_show_compound_apy": false,
      "is_show_hardcoded_apy": false,
      "is_campaign_apy_target_top_up": true
    },
    "campaign_apy": 6.617455622313092,
    "historical_apy": {
      "1": 0.07680942178174223,
      "7": 0.030108319546118974,
      "30": 0.03382544377686907
    },
    "historical_compound_apy": {
      "1": 0.07982753778860796,
      "7": 0.030557203583434278,
      "30": 0.03435548241894493
    },
    "stellar_vault_metadata": {
      "deposit_token_symbol": "USDC",
      "deposit_token_decimals": 7
    }
  },
  {
    "address": "CC6TRAPQD3NK7THUKWPV5SL2JHKQGNXZVB6S6MVYFSLRWAKEFUWZKZ7J",
    "vault_name": "Gami earnXLM",
    "chain_type": "stellar",
    "status": "active",
    "is_visible": true,
    "tvl": 3054963,
    "default_apy_horizon": 7,
    "apy_override": {
      "hardcoded_apy": null,
      "is_show_target_apy": false,
      "is_show_compound_apy": false,
      "is_show_hardcoded_apy": false,
      "is_campaign_apy_target_top_up": true
    },
    "campaign_apy": 3.1491187247539396,
    "historical_apy": {
      "1": 0.08848732799037583,
      "7": 0.018508812752460607,
      "30": 0.02414588705180357
    },
    "historical_compound_apy": {
      "1": 0.09250869163538411,
      "7": 0.01867781696815296,
      "30": 0.02441524674746476
    },
    "stellar_vault_metadata": {
      "deposit_token_symbol": "XLM",
      "deposit_token_decimals": 7
    }
  },
  {
    "address": "CALFCZ4TY2CLHDHNJWCZX6JKYGUPV7P3GNQ3UVABXNE5JCV2E774APUM",
    "vault_name": "Sentora USDC",
    "chain_type": "stellar",
    "status": "active",
    "is_visible": true,
    "tvl": 60983502,
    "default_apy_horizon": 30,
    "apy_override": {
      "hardcoded_apy": null,
      "is_show_target_apy": false,
      "is_show_compound_apy": true,
      "is_show_hardcoded_apy": false,
      "is_campaign_apy_target_top_up": false
    },
    "campaign_apy": null,
    "historical_apy": {
      "1": 0.07489588183389155,
      "7": 0.06947851747134734,
      "30": 0.07755386542676299
    },
    "historical_compound_apy": {
      "1": 0.0777636488628648,
      "7": 0.07189945868760694,
      "30": 0.08037449470031666
    },
    "stellar_vault_metadata": {
      "deposit_token_symbol": "USDC",
      "deposit_token_decimals": 7
    }
  },
  {
    "address": "CDUUKPCCGY5NAGCYWEBXVAGVUEDGICB4QLBQMLJTOE4F62AKOEVQPQTH",
    "vault_name": "Sentora PYUSD",
    "chain_type": "stellar",
    "status": "active",
    "is_visible": false,
    "tvl": 409,
    "default_apy_horizon": 7,
    "apy_override": null,
    "campaign_apy": null,
    "historical_apy": {
      "1": 0.0,
      "7": 1477.4347342634476,
      "30": 344.73477408306974
    },
    "historical_compound_apy": {
      "1": 0.0,
      "7": 3.259965615300115e+76,
      "30": 7.129894088346843e+17
    },
    "stellar_vault_metadata": {
      "deposit_token_symbol": "PYUSD",
      "deposit_token_decimals": 7
    }
  }
];
const byName = Object.fromEntries(VAULTS.map((v) => [v.vault_name, v]));
const SHOWN = {
  "Sentora USDC": ["8.04%", 30],
  "Gami earnUSDC": ["10.00%", 30],
  "Gami earnXLM": ["5.00%", 7],
  "Sentora XLM": ["4.45%", 7],
};
const pct = (x) => `${(x * 100).toFixed(2)}%`;

test("each visible Stellar vault's APY and window are the ones Upshift showed", () => {
  for (const [name, [apy, days]] of Object.entries(SHOWN)) {
    const got = upshiftApy(byName[name]);
    assert.deepEqual([pct(got.apy), got.days], [apy, days], name);
  }
});

test("the parts: compound or simple, the vault's window, the campaign's top-up", () => {
  const usdc = byName["Sentora USDC"];
  assert.equal(upshiftApy(usdc).apy, usdc.historical_compound_apy["30"], "compound, 30 days");
  const gami = byName["Gami earnUSDC"];
  assert.equal(upshiftApy(gami).apy, gami.historical_apy["30"] + gami.campaign_apy / 100);
  // A campaign that doesn't top the vault up isn't added.
  const noTopUp = { ...gami, apy_override: { ...gami.apy_override, is_campaign_apy_target_top_up: false } };
  assert.equal(upshiftApy(noTopUp).apy, gami.historical_apy["30"]);
});

test("no window set: 7 days, as the wallet's positions used; a missing window falls back", () => {
  assert.deepEqual(upshiftApy({ historical_apy: { 1: 0.02, 7: 0.0799, 30: 0.03 } }), { apy: 0.0799, days: 7 });
  assert.deepEqual(upshiftApy({ default_apy_horizon: 30, historical_apy: { 7: 0.04 } }), { apy: 0.04, days: 7 });
});

test("no figure, or a broken one, is no APY", () => {
  assert.equal(upshiftApy(byName["Sentora PYUSD"]), null, "1477 (147,743%) is a broken metric");
  assert.equal(upshiftApy({ historical_apy: null }), null);
  assert.equal(upshiftApy({ historical_apy: {} }), null);
  assert.equal(upshiftApy(null), null);
});

// ── The DeFi tab's Upshift card ─────────────────────────────────────────────

test("the DeFi tab's Upshift card shows them, with the window", async () => {
  require("../lib/soroban-rpc").getTokenBalanceStrict = async () => "0";
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /tokenized_vaults/);
    return { ok: true, status: 200, json: async () => VAULTS };
  };
  try {
    const explorer = require("../lib/defi-explorer");
    await explorer.refreshOnce({ only: ["upshift"] });
    const card = explorer.getSnapshot({ full: true }).protocols.find((p) => p.id === "upshift");
    const pools = Object.fromEntries(card.pools.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(pools).sort(), Object.keys(SHOWN).sort(), "visible vaults only");
    for (const [name, [apy, days]] of Object.entries(SHOWN)) {
      assert.deepEqual([pct(pools[name].apy), pools[name].apyDays], [apy, days], name);
      assert.match(pools[name].note, new RegExp(`Upshift's Total APY over ${days} days\\.$`));
    }
  } finally {
    global.fetch = realFetch;
  }
});
