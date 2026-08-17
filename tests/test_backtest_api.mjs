import assert from "node:assert/strict";
import test from "node:test";

import { runBacktest } from "../functions/api/_backtest.mjs";

function bars(count = 40) {
  return Array.from({ length: count }, (_, index) => {
    const close = 1 + index * 0.01;
    return {
      symbol: "512480.SS",
      timeframe: "1d",
      ts: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      open: close - 0.002,
      high: close + 0.005,
      low: close - 0.005,
      close,
      volume: 1000000,
      source: "tencent",
      adjustment: "qfq",
      quality: "good",
    };
  });
}

test("backtest executes only after the signal date and deducts explicit costs", () => {
  const result = runBacktest(bars(), {
    strategy: "momentum20",
    holdingDays: 3,
    costBps: 3,
    slippageBps: 5,
  });

  assert.equal(result.status, "ok");
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.every((trade) => trade.entryDate > trade.signalDate));
  assert.ok(result.trades.every((trade) => trade.exitDate > trade.entryDate));
  assert.ok(result.trades.every((trade) => {
    const dates = [trade.signalDate, trade.entryDate, trade.exitDate];
    return dates.every((date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()));
  }));
  assert.ok(result.trades.every((trade) => trade.netReturn < trade.grossReturn));
  assert.equal(result.audit.execution, "next_trading_day_open");
  assert.equal(result.audit.adjustment, "qfq");
});

test("backtest fails closed for unadjusted or insufficient daily history", () => {
  const unadjusted = bars().map((row) => ({ ...row, adjustment: "none" }));
  assert.equal(runBacktest(unadjusted, { strategy: "momentum20" }).status, "unavailable");
  assert.equal(runBacktest(bars(10), { strategy: "momentum20" }).status, "unavailable");
});

test("backtest preserves an explicit zero-friction request", () => {
  const result = runBacktest(bars(), {
    strategy: "momentum20",
    holdingDays: 3,
    costBps: 0,
    slippageBps: 0,
  });

  assert.equal(result.audit.costBpsPerSide, 0);
  assert.equal(result.audit.slippageBpsPerSide, 0);
  assert.ok(result.trades.every((trade) => trade.netReturn === trade.grossReturn));
});
