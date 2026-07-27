import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FUND_FLOW_MIN_SAMPLE,
  FUND_FLOW_START_DATE,
  buildFundFlowView,
  computeHistoricalPercentile,
  formatFundFlowValue,
  fundFlowTradingDate,
  fundFlowRequestTypes,
  isFundFlowUiEnabled,
} from "../public/assets/workbench-fundflow.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/assets/workbench.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/assets/workbench.css", import.meta.url), "utf8");

function row(flowType, value, day, overrides = {}) {
  return {
    id: `${flowType}-${day}`,
    symbol: "515880.SS",
    flow_type: flowType,
    period: "1d",
    ts: `${day}T00:00:00.000Z`,
    value,
    unit: flowType.startsWith("shares_") ? "shares" : "CNY",
    source: "exchange-cn",
    method: "reported",
    as_of: `${day}T00:00:00.000Z`,
    fetched_at: `${day}T01:00:00.000Z`,
    freshness: "fresh",
    quality: "good",
    ...overrides,
  };
}

test("fund-flow rollout gate and request plan fail closed", () => {
  assert.equal(FUND_FLOW_START_DATE, "2024-01-01");
  assert.equal(FUND_FLOW_MIN_SAMPLE, 60);
  assert.equal(isFundFlowUiEnabled("true"), true);
  for (const value of [undefined, null, false, "false", "1", true]) {
    assert.equal(isFundFlowUiEnabled(value), false);
  }
  assert.deepEqual(fundFlowRequestTypes("SPY"), []);
  assert.deepEqual(fundFlowRequestTypes("515880.SS"), [
    "margin_balance",
    "margin_net_buy",
    "shares_outstanding_derived",
    "shares_outstanding_snapshot",
  ]);
  assert.deepEqual(fundFlowRequestTypes("159995.SZ"), [
    "margin_balance",
    "margin_net_buy",
    "shares_outstanding_snapshot",
  ]);
});

test("historical percentile excludes current value and uses mid-rank ties", () => {
  assert.deepEqual(
    computeHistoricalPercentile([10, 20, 20, 40, 30], { minSample: 1 }),
    { status: "ready", value: 75, sampleSize: 4 },
  );
  assert.deepEqual(
    computeHistoricalPercentile([10, 20, 20, 40, 20], { minSample: 1 }),
    { status: "ready", value: 50, sampleSize: 4 },
  );
});

test("historical percentile stays in accumulation state below sixty prior observations", () => {
  const values = Array.from({ length: 60 }, (_, index) => index + 1);
  assert.deepEqual(computeHistoricalPercentile(values), {
    status: "accumulating",
    value: null,
    sampleSize: 59,
  });
  assert.equal(computeHistoricalPercentile([...values, 61]).status, "ready");
});

test("fund-flow value formatting preserves missing values and explicit zero", () => {
  assert.equal(formatFundFlowValue(null, "CNY"), "—");
  assert.equal(formatFundFlowValue(undefined, "shares"), "—");
  assert.equal(formatFundFlowValue(0, "CNY"), "0.00");
  assert.equal(formatFundFlowValue(125_000_000, "CNY"), "1.25亿");
  assert.equal(formatFundFlowValue(50_000_000, "shares", { signed: true }), "+0.5亿份");
  assert.equal(formatFundFlowValue(12_345, "shares"), "1.2万份");
});

test("fund-flow trading dates use Asia Shanghai instead of UTC slicing", () => {
  assert.equal(fundFlowTradingDate("2023-12-31T15:59:59.000Z"), "2023-12-31");
  assert.equal(fundFlowTradingDate("2023-12-31T16:00:00.000Z"), "2024-01-01");
  assert.equal(fundFlowTradingDate(null), null);
  assert.equal(fundFlowTradingDate("invalid"), null);
});

test("view model exposes only financing balance, financing net buy, and ETF shares", () => {
  const data = [];
  for (let index = 0; index < 61; index += 1) {
    const day = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
    data.push(row("margin_balance", 100_000_000 + index, day));
    data.push(row("margin_net_buy", index - 30, day));
    data.push(row("shares_outstanding_derived", 500_000_000 + index, day));
  }
  const view = buildFundFlowView({
    status: "ok",
    asOf: data.at(-1).as_of,
    data,
    capabilities: {
      marketFlowV1: true,
      marginDaily: true,
      etfSharesDaily: true,
      historicalPercentile: true,
    },
  }, "515880.SS");

  assert.equal(view.enabled, true);
  assert.deepEqual(view.metrics.map(({ id }) => id), [
    "margin-balance",
    "margin-net-buy",
    "etf-shares",
  ]);
  assert.equal(view.metrics.some(({ label }) => label.includes("融券")), false);
  assert.equal(view.metrics[0].percentile.sampleSize, 60);
  assert.equal(view.metrics[1].signed, true);
  assert.match(view.metrics[0].tooltip, /2024-01-01/);
  assert.match(view.metrics[0].tooltip, /当前值不计入样本/);
  assert.match(view.metrics[0].tooltip, /mid-rank/);
});

test("a malformed latest null remains unavailable instead of falling back or becoming zero", () => {
  const view = buildFundFlowView({
    status: "degraded",
    asOf: "2026-07-27T00:00:00.000Z",
    capabilities: {
      marketFlowV1: true,
      marginDaily: true,
      etfSharesDaily: true,
      historicalPercentile: true,
    },
    data: [
      row("margin_balance", 123, "2026-07-26"),
      row("margin_balance", null, "2026-07-27"),
    ],
  }, "515880.SS");
  assert.equal(view.metrics[0].value, null);
  assert.equal(view.metrics[0].displayValue, "—");
  assert.equal(view.metrics[0].percentile.status, "unavailable");
});

test("Shanghai share rows prefer derived history and fall back to snapshot when derived is absent", () => {
  const capabilities = {
    marketFlowV1: true,
    marginDaily: true,
    etfSharesDaily: true,
    historicalPercentile: true,
  };
  const derived = row("shares_outstanding_derived", 510_000_000, "2026-07-26", {
    source: "sse-scale-eastmoney-close",
    method: "fund_scale_divided_by_unadjusted_close",
    quality: "derived",
    freshness: "stale",
    fetched_at: "2026-07-27T01:02:03.000Z",
  });
  const snapshot = row("shares_outstanding_snapshot", 620_000_000, "2026-07-27", {
    source: "eastmoney-share-snapshot",
    method: "observed_without_source_timestamp",
    quality: "snapshot_unstamped",
    fetched_at: "2026-07-27T02:03:04.000Z",
  });
  const preferred = buildFundFlowView({
    status: "ok",
    asOf: snapshot.as_of,
    data: [snapshot, derived],
    capabilities,
  }, "515880.SS");
  const preferredShares = preferred.metrics.find(({ id }) => id === "etf-shares");
  assert.equal(preferred.asOf, derived.as_of);
  assert.equal(preferredShares.value, 510_000_000);
  assert.equal(preferredShares.displayValue, "5.1亿份");
  assert.equal(preferredShares.tradingDate, "2026-07-26");
  assert.match(preferredShares.tooltip, /method fund_scale_divided_by_unadjusted_close/);
  assert.match(preferredShares.tooltip, /quality derived · freshness stale/);
  assert.match(preferredShares.tooltip, /抓取时间 2026-07-27 09:02:03/);
  assert.match(preferredShares.tooltip, /上交所规模÷东财同日未复权收盘价推导，非登记份额/);

  const fallback = buildFundFlowView({ status: "ok", data: [snapshot], capabilities }, "515880.SS");
  const fallbackShares = fallback.metrics.find(({ id }) => id === "etf-shares");
  assert.equal(fallbackShares.value, 620_000_000);
  assert.equal(fallbackShares.tradingDate, "2026-07-27");
  assert.match(fallbackShares.tooltip, /method observed_without_source_timestamp/);
  assert.match(fallbackShares.tooltip, /quality snapshot_unstamped · freshness fresh/);
  assert.match(fallbackShares.tooltip, /无来源时间戳/);
});

test("the 2024 cutoff follows the Shanghai trading day", () => {
  const capabilities = {
    marketFlowV1: true,
    marginDaily: true,
    etfSharesDaily: true,
    historicalPercentile: true,
  };
  const before = row("margin_balance", 10, "2023-12-31", {
    ts: "2023-12-31T15:59:59.000Z",
    as_of: "2023-12-31T15:59:59.000Z",
  });
  const first = row("margin_balance", 20, "2023-12-31", {
    ts: "2023-12-31T16:00:00.000Z",
    as_of: "2023-12-31T16:00:00.000Z",
  });
  const view = buildFundFlowView({ status: "ok", data: [before, first], capabilities }, "515880.SS");
  assert.equal(view.metrics[0].value, 20);
  assert.equal(view.metrics[0].tradingDate, "2024-01-01");
  assert.equal(view.metrics[0].percentile.sampleSize, 0);
  assert.match(view.metrics[0].tooltip, /数据日 2024-01-01/);
});

test("fund-flow panel stays inside monitor after the chart and is enabled after closed-state smoke", () => {
  assert.match(html, /<body[^>]*data-fund-flow-enabled="true"/);
  assert.match(html, /id="market-chart"[\s\S]*id="fund-flow-panel"[\s\S]*id="conclusion-title"/);
  const panel = /<section[^>]+id="fund-flow-panel"[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  assert.match(panel, /hidden/);
  assert.match(panel, /id="fund-flow-grid"/);
  assert.doesNotMatch(panel, /融券/);
  assert.match(script, /function loadFundFlow/);
  assert.match(script, /isFundFlowUiEnabled\(document\.body\.dataset\.fundFlowEnabled\)/);
  assert.match(script, /profileRequests\.begin\("fundflow"/);
  assert.match(script, /from:\s*FUND_FLOW_START_DATE[\s\S]*limit:\s*2000/);
  assert.match(script, /view\.status === "ok" \? "数据可用"/);
  assert.doesNotMatch(script, /view\.status === "ok" \? "已核验"/);
  assert.doesNotMatch(script, /pollWorkbenchData\(\)[\s\S]*loadFundFlow/);
});

test("fund-flow tooltip supports pointer, keyboard focus, touch, and neutral percentile tones", () => {
  assert.match(script, /function bindFundFlowTooltips/);
  assert.match(script, /pointerenter/);
  assert.match(script, /focus/);
  assert.match(script, /click/);
  assert.match(script, /aria-expanded/);
  assert.match(css, /\.fund-flow-tooltip/);
  assert.match(css, /\.fund-flow-percentile\.is-extreme[^}]*var\(--warning\)/);
  assert.doesNotMatch(css, /\.fund-flow-percentile[^}]*var\(--market-up\)/);
  assert.doesNotMatch(css, /\.fund-flow-percentile[^}]*var\(--market-down\)/);
});
