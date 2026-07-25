import assert from "node:assert/strict";
import test from "node:test";

import {
  PROFILE_LIMIT,
  PROFILE_STORAGE_KEY,
  TARGET_LIMIT,
  currentProfileFor,
  marketForProfileTarget,
  normalizeProfileTargetSymbol,
  profileRequestUrl,
  replaceProfile,
  resetProfileContext,
  resolveSelectedProfileId,
} from "../public/assets/workbench-profiles.mjs";

const profiles = [
  {
    id: "profile-a",
    name: "A 组",
    enabled: true,
    targets: [{ symbol: "NVDA" }, { symbol: "515880.SS" }],
  },
  {
    id: "profile-b",
    name: "B 组",
    enabled: false,
    targets: [{ symbol: "NVDA" }, { symbol: "TSM" }],
  },
];

test("profile limits and persisted selection use one stable contract", () => {
  assert.equal(PROFILE_LIMIT, 8);
  assert.equal(TARGET_LIMIT, 14);
  assert.equal(PROFILE_STORAGE_KEY, "ta.workbench.selected-profile.v1");
  assert.equal(resolveSelectedProfileId(profiles, "profile-b"), "profile-b");
  assert.equal(resolveSelectedProfileId(profiles, "missing"), "profile-a");
  assert.equal(currentProfileFor({ profiles }, "profile-b"), profiles[1]);
});

test("the same symbol produces distinct market URLs for distinct profiles", () => {
  assert.equal(
    profileRequestUrl("/api/market", "profile-a", {
      symbol: "NVDA",
      timeframe: "1d",
      limit: 240,
    }),
    "/api/market?profile=profile-a&symbol=NVDA&timeframe=1d&limit=240",
  );
  assert.equal(
    profileRequestUrl("/api/market", "profile-b", {
      symbol: "NVDA",
      timeframe: "1d",
      limit: 240,
    }),
    "/api/market?profile=profile-b&symbol=NVDA&timeframe=1d&limit=240",
  );
});

test("switching profiles clears scoped data while preserving VolGuard and temporary research", () => {
  const options = { status: "ok", quoteAsOf: "2026-07-26T01:00:00Z" };
  const pendingResearch = { requestId: "temporary-1" };
  const next = resetProfileContext({
    selectedSymbol: "515880.SS",
    market: { status: "ok", data: [{ close: 1 }] },
    quotes: new Map([["515880.SS", { close: 1 }]]),
    feeds: [{ id: "news-a" }],
    feedEnvelope: { status: "ok", data: [{ id: "news-a" }] },
    monitor: { status: "ok", data: [{ id: "slot-a" }] },
    latest: { results: [{ ticker: "515880.SS" }] },
    history: [{ id: "report-a" }],
    runs: [{ id: "run-a" }],
    reportAudit: { records: [] },
    archiveEntries: [{ report: "a.md" }],
    selectedReportPath: "a.md",
    selectedReportSection: "decision",
    selectedReportContent: "A",
    latestReport: "a.md",
    chart: {
      bars: [{ close: 1 }],
      symbol: "515880.SS",
      timeframe: "15m",
      hydrated: true,
      api: { id: "chart-api" },
      series: { id: "series" },
    },
    options,
    pendingResearch,
  }, profiles[1]);

  assert.equal(next.selectedSymbol, "NVDA");
  assert.deepEqual(next.market, {
    status: "unavailable",
    asOf: null,
    data: [],
    sources: [],
  });
  assert.equal(next.quotes.size, 0);
  assert.deepEqual(next.feeds, []);
  assert.deepEqual(next.monitor.data, []);
  assert.equal(next.latest, null);
  assert.deepEqual(next.history, []);
  assert.deepEqual(next.runs, []);
  assert.equal(next.selectedReportPath, null);
  assert.equal(next.selectedReportSection, null);
  assert.equal(next.selectedReportContent, "");
  assert.equal(next.latestReport, null);
  assert.deepEqual(next.chart.bars, []);
  assert.equal(next.chart.symbol, null);
  assert.equal(next.chart.hydrated, false);
  assert.equal(next.chart.api.id, "chart-api");
  assert.equal(next.options, options);
  assert.equal(next.pendingResearch, pendingResearch);
});

test("editing profile B replaces only B and leaves profile A untouched", () => {
  const settings = { version: 2, profiles };
  const revised = replaceProfile(settings, "profile-b", {
    ...profiles[1],
    name: "B 组已编辑",
    targets: [{ symbol: "ORCL" }],
  });

  assert.notEqual(revised, settings);
  assert.equal(revised.profiles[0], profiles[0]);
  assert.equal(revised.profiles[0].name, "A 组");
  assert.equal(revised.profiles[1].name, "B 组已编辑");
  assert.deepEqual(revised.profiles[1].targets, [{ symbol: "ORCL" }]);
});

test("profile target symbols accept Hong Kong aliases and preserve general HK tickers", () => {
  const cases = new Map([
    ["03887", "3887.HK"],
    ["3887", "3887.HK"],
    ["03887.HK", "3887.HK"],
    ["3887.HK", "3887.HK"],
    ["0700", "0700.HK"],
    ["0700.HK", "0700.HK"],
    ["09988.HK", "09988.HK"],
  ]);

  for (const [input, expected] of cases) {
    assert.equal(normalizeProfileTargetSymbol(input), expected);
  }

  assert.equal(marketForProfileTarget("3887.HK"), "HK");
  assert.equal(marketForProfileTarget("515880.SS"), "CN");
  assert.equal(marketForProfileTarget("NVDA"), "US");
});
