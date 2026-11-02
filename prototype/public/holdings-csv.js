/**
 * Holdings CSV: every token balance and DeFi position on screen, one row each,
 * for a spreadsheet (the "Download CSV" button in index.html).
 *
 * - value_usd adds up to the portfolio total the page shows: wallet balances
 *   plus DeFi positions, borrowed amounts negative.
 * - A position's assets are in asset_N / amount_N / asset_N_id (up to three,
 *   for liquidity pools). Borrowed amounts are negative.
 * - Rewards waiting to be claimed (Blend's pending BLND, Aquarius rewards)
 *   get rows of their own with no value_usd: they aren't in the total until
 *   claimed. Their estimate, when there is one, is in notes.
 * - Token symbols, pool names and wallet labels come from chains and users,
 *   so a text cell can't start a spreadsheet formula.
 *
 * Plain script, no dependencies: the page loads it with <script src>, and the
 * tests require() it.
 */
(function (root) {
  const COLUMNS = [
    "as_of_utc", "wallet", "label", "venue", "position", "side", "value_usd",
    "asset_1", "amount_1", "asset_1_id", "asset_2", "amount_2", "asset_2_id",
    "asset_3", "amount_3", "asset_3_id", "notes",
  ];

  const VENUES = {
    blend: "Blend", k2: "K2 Lend", aquarius: "Aquarius", soroswap: "Soroswap",
    "sushiswap-v3": "SushiSwap V3", upshift: "Upshift", sentora: "Stellar DeFi Hub (Sentora)",
    templar: "Templar Finance", "solv-protocol": "Solv Protocol",
  };

  /** A text cell: never the start of a formula (=, +, -, @, tab, CR). */
  function text(v) {
    const s = v == null ? "" : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  /** A number cell: plain digits, no grouping or exponent; "" if not a number. */
  function num(v) {
    if (v == null || v === "") return "";
    if (typeof v === "string") {
      const s = v.replace(/,/g, "").trim();
      if (/^-?\d+(\.\d+)?$/.test(s)) return s; // an adapter's own decimal string, kept exactly
      v = Number(s);
    }
    if (typeof v !== "number" || !Number.isFinite(v)) return "";
    const s = String(v); // shortest form that reads back as the same number
    return /e/i.test(s) ? v.toFixed(20).replace(/\.?0+$/, "") : s;
  }
  const neg = (v) => { const s = num(v); return !s || /^-?0(\.0*)?$/.test(s) ? s : s.startsWith("-") ? s.slice(1) : "-" + s; };
  function usd(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "";
    const s = v.toFixed(2);
    return s === "-0.00" ? "0.00" : s;
  }

  function quote(cell) {
    const s = String(cell);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function balanceRow(b) {
    const a = b.asset || {};
    if (b.type === "lp_share") {
      return { venue: "Stellar AMM", side: "liquidity pool", value_usd: usd(b.valueUSD),
        legs: [{ asset: "pool shares", amount: num(b.shares), id: b.poolId }] };
    }
    const native = b.type === "native";
    return {
      venue: "Wallet", side: "balance", value_usd: usd(b.valueUSD),
      legs: [{ asset: native ? "XLM" : a.code, amount: num(b.balance), id: native ? "native" : (a.issuer || a.contractId || "") }],
      notes: b.price && b.price.usd > 0 ? "" : "no price",
    };
  }

  function legsOf(p) {
    if (p.type === "lending" || p.type === "borrowing") {
      const borrowed = p.type === "borrowing" || p.subtype === "liability";
      return [{ asset: p.asset, amount: borrowed ? neg(p.underlyingAmount) : num(p.underlyingAmount), id: p.assetAddress }];
    }
    if (p.token0 && p.token1 && p.amounts && !Array.isArray(p.amounts)) {
      const ids = (p.tokens || []).map((t) => t && t.contractId);
      return [
        { asset: p.token0.symbol, amount: num(p.amounts.token0), id: ids[0] },
        { asset: p.token1.symbol, amount: num(p.amounts.token1), id: ids[1] },
      ];
    }
    if (Array.isArray(p.amounts)) {
      return p.amounts.map((x, i) => ({ asset: x.symbol, amount: num(x.amount), id: (p.tokens || [])[i]?.contractId }));
    }
    const legs = [];
    if (p.deposited) {
      // A vault's deposit plus the yield it has earned is what it holds now.
      const y = p.yield && p.yield.asset === p.deposited.asset ? Number(p.yield.accrued) : 0;
      const held = Number(p.deposited.amount) + (Number.isFinite(y) ? y : 0);
      legs.push({ asset: p.deposited.asset, amount: y ? num(held) : num(p.deposited.amount) });
    }
    if (p.staked) legs.push({ asset: p.staked.asset, amount: num(p.staked.amount) });
    if (p.borrow) legs.push({ asset: p.borrow.asset, amount: neg(p.borrow.amount) });
    return legs;
  }

  function sideOf(p) {
    if (p.type === "borrowing" || p.subtype === "liability") return "borrowed";
    if (p.type === "lending") return "supplied";
    if (p.type === "lp" || p.type === "concentrated_lp") return "liquidity pool";
    return p.type || "";
  }

  function positionRows(p) {
    const venue = VENUES[p.protocol] || p.protocol || "";
    const pair = p.token0 && p.token1 ? `${p.token0.symbol}/${p.token1.symbol}` : "";
    const position = p.poolName || p.vaultName || pair;
    const notes = [];
    if (p.unpriced) notes.push("no price");
    if (p.deposited && p.yield && p.yield.asset === p.deposited.asset && Number(p.yield.accrued) > 0) {
      notes.push(`includes ${num(p.yield.accrued)} ${p.yield.asset} of yield on ${num(p.deposited.amount)} deposited`);
    }
    if (p.stale) notes.push("last good result: the protocol didn't answer this time");
    const rows = [{ venue, position, side: sideOf(p), value_usd: usd(p.valueUSD), legs: legsOf(p), notes: notes.join("; ") }];
    if (Array.isArray(p.unclaimedRewards)) {
      for (const r of p.unclaimedRewards) rows.push(rewardRow(venue, position, r.asset, r.amount, r.contractId, r.valueUSD));
    } else if (p.unclaimedRewards === null) {
      rows.push({ venue, position, side: "unclaimed reward", value_usd: "", legs: [], notes: "couldn't be read this time" });
    }
    return rows;
  }

  function rewardRow(venue, position, asset, amount, id, valueUSD) {
    const est = valueUSD == null ? "no price" : `about $${usd(valueUSD)} at the current price`;
    return { venue, position, side: "unclaimed reward", value_usd: "", legs: [{ asset, amount: num(amount), id }], notes: `${est}; not in the total until claimed` };
  }

  function walletRows(w) {
    const rows = [];
    for (const b of w.balances || []) rows.push(balanceRow(b));
    for (const p of w.defiPositions || []) rows.push(...positionRows(p));
    for (const g of w.defiByPool || []) {
      if (g.protocol && g.protocol !== "blend") continue;
      if (g.totalPendingBlnd > 0) rows.push(rewardRow("Blend", g.poolName, "BLND", g.totalPendingBlnd, null, null));
    }
    return rows;
  }

  /**
   * @param {Array<{address, label?, balances?, defiPositions?, defiByPool?}>} wallets
   * @param {{asOf: string}} opts  ISO time the data was read
   * @returns {string} CSV text, CRLF line endings, header row first
   */
  function build(wallets, { asOf }) {
    const lines = [COLUMNS.join(",")];
    for (const w of wallets) {
      for (const r of walletRows(w)) {
        const cells = {
          as_of_utc: asOf, wallet: w.address, label: text(w.label), venue: text(r.venue),
          position: text(r.position), side: r.side, value_usd: r.value_usd, notes: text(r.notes),
        };
        (r.legs || []).slice(0, 3).forEach((l, i) => {
          cells[`asset_${i + 1}`] = text(l.asset);
          cells[`amount_${i + 1}`] = l.amount;
          cells[`asset_${i + 1}_id`] = text(l.id);
        });
        lines.push(COLUMNS.map((c) => quote(cells[c] ?? "")).join(","));
      }
    }
    return lines.join("\r\n") + "\r\n";
  }

  /** stellarscope-GCTSFIIC-2026-11-02T1405Z.csv, or stellarscope-all-wallets-… */
  function fileName(address, asOf) {
    const t = String(asOf).replace(/:\d\d(\.\d+)?Z$/, "Z").replace(/:/g, "");
    return `stellarscope-${address ? address.slice(0, 8) : "all-wallets"}-${t}.csv`;
  }

  const HoldingsCsv = { build, fileName, COLUMNS };
  if (typeof module !== "undefined" && module.exports) module.exports = HoldingsCsv;
  else root.HoldingsCsv = HoldingsCsv;
})(typeof window !== "undefined" ? window : this);
