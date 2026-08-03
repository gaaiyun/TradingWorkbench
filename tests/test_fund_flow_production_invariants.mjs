import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyProduction,
  verifyTradeDates,
} from "../scripts/verify-fund-flow-production.mjs";

function weekdays(start, count) {
  const rows = [];
  for (let cursor = new Date(`${start}T00:00:00Z`); rows.length < count; cursor = new Date(cursor.valueOf() + 86_400_000)) {
    if (![0, 6].includes(cursor.getUTCDay())) rows.push(cursor.toISOString().slice(0, 10));
  }
  return rows;
}

test("production fund-flow invariant requires explicit weekdays and market-bar membership", () => {
  const dates = weekdays("2026-01-01", 80);
  const result = verifyTradeDates(
    dates.map((trade_date) => ({ trade_date })),
    dates.map((date) => ({ ts: `${date}T00:00:00Z` })),
  );
  assert.equal(result.weekendCount, 0);
  assert.equal(result.missingMarketDays, 0);
  assert.ok(result.fridayCount > 0);
});

test("production fund-flow invariant rejects UTC-sliced weekend ghosts and off-calendar rows", () => {
  const dates = weekdays("2026-01-01", 80);
  const marketRows = dates.map((date) => ({ ts: `${date}T00:00:00Z` }));
  assert.throws(
    () => verifyTradeDates([
      ...dates.slice(0, 79).map((trade_date) => ({ trade_date })),
      { trade_date: "2026-04-19" },
    ], marketRows),
    /FUND_FLOW_WEEKEND_DATE/,
  );
  assert.throws(
    () => verifyTradeDates([
      ...dates.slice(0, 79).map((trade_date) => ({ trade_date })),
      { trade_date: "2026-04-20" },
    ], marketRows.filter(({ ts }) => !ts.startsWith("2026-04-20"))),
    /FUND_FLOW_NOT_MARKET_DAY/,
  );
});

test("production verification accepts weekend-stale flows after business-day invariants pass", async () => {
  const dates = weekdays("2026-01-01", 80);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    const payload = url.pathname === "/api/flows"
      ? {
        status: "stale",
        data: dates.map((trade_date) => ({ trade_date })),
      }
      : {
        status: "ok",
        data: dates.map((date) => ({ ts: `${date}T00:00:00Z` })),
      };
    return Response.json(payload);
  };
  try {
    const result = await verifyProduction("https://workbench.test");
    assert.equal(result.length, 3);
    assert.equal(result.every(({ missingMarketDays }) => missingMarketDays === 0), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
