const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLatestRateCsv, usdm1RateFromBenchmark } = require("../lib/rwa-yield-fetcher");

test("parseLatestRateCsv: Fed H.15 layout, skips metadata rows and ND days", () => {
  const csv = [
    '"Series Description","Market yield on U.S. Treasury securities at 1-month   constant maturity, quoted on investment basis"',
    '"Unit:","Percent:_Per_Year"',
    '"Time Period","RIFLGFCM01_N.B","RIFLGFCM03_N.B"',
    "2026-09-23,3.99,4.19",
    "2026-09-24,4.01,4.24",
    "2026-09-25,ND,ND",
    "",
  ].join("\r\n");
  assert.deepEqual(parseLatestRateCsv(csv), { date: "2026-09-24", rate: 4.01 });
});

test("parseLatestRateCsv: FRED layout, skips '.' no-data rows", () => {
  const csv = "observation_date,DGS1MO\n2026-09-24,4.01\n2026-09-25,.\n";
  assert.deepEqual(parseLatestRateCsv(csv), { date: "2026-09-24", rate: 4.01 });
});

test("parseLatestRateCsv: no numeric rows → null", () => {
  assert.equal(parseLatestRateCsv("observation_date,DGS1MO\n2026-09-25,.\n"), null);
  assert.equal(parseLatestRateCsv(""), null);
  assert.equal(parseLatestRateCsv("<html>blocked</html>"), null);
});

test("usdm1RateFromBenchmark: 1-mo UST minus 200 bps, floored at zero", () => {
  assert.equal(usdm1RateFromBenchmark(4.01).toFixed(2), "2.01");
  assert.equal(usdm1RateFromBenchmark(2.0), 0);
  assert.equal(usdm1RateFromBenchmark(1.5), 0);
  assert.equal(usdm1RateFromBenchmark(NaN), null);
});
