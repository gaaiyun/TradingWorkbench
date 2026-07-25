import assert from "node:assert/strict";
import test from "node:test";

import {
  PROFILE_LIMIT,
  PROFILE_STORAGE_KEY,
  TARGET_LIMIT,
  createProfileRequestCoordinator,
  currentProfileFor,
  isSettingsRevisionConflict,
  marketForProfileTarget,
  normalizeProfileTargetSymbol,
  profileRequestUrl,
  replaceProfile,
  resetProfileContext,
  resolveSelectedProfileId,
  selectedProfileAfterMutation,
  settingsSnapshotFromPayload,
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

test("settings snapshots fail closed and keep static disaster recovery read-only", () => {
  const unavailable = settingsSnapshotFromPayload({
    status: "unavailable",
    error: "D1 unavailable",
    data: { version: 2, profiles },
  });
  assert.equal(unavailable.mode, "unavailable");
  assert.equal(unavailable.settings, null);
  assert.equal(unavailable.revision, null);
  assert.equal(unavailable.writable, false);

  const fallback = settingsSnapshotFromPayload(
    { version: 2, profiles },
    { source: "static" },
  );
  assert.equal(fallback.mode, "degraded");
  assert.equal(fallback.settings.profiles, profiles);
  assert.equal(fallback.revision, null);
  assert.equal(fallback.writable, false);

  const live = settingsSnapshotFromPayload({
    version: 2,
    profiles,
    updatedAt: "2026-07-26T01:02:03.000Z",
  });
  assert.equal(live.mode, "ready");
  assert.equal(live.revision, "2026-07-26T01:02:03.000Z");
  assert.equal(live.writable, true);

  const missingRevision = settingsSnapshotFromPayload({ version: 2, profiles });
  assert.equal(missingRevision.mode, "degraded");
  assert.equal(missingRevision.writable, false);
});

test("profile request generations reject A to B to A and superseded report responses", () => {
  const requests = createProfileRequestCoordinator();
  requests.activate("profile-a");
  const firstFeeds = requests.begin("feeds");
  const firstReport = requests.begin("report", "decision.md");

  requests.activate("profile-b");
  assert.equal(firstFeeds.signal.aborted, true);
  assert.equal(firstReport.signal.aborted, true);

  requests.activate("profile-a");
  const latestFeeds = requests.begin("feeds");
  const oldReport = requests.begin("report", "decision.md");
  const latestReport = requests.begin("report", "market.md");

  assert.equal(requests.isCurrent(firstFeeds), false);
  assert.equal(requests.isCurrent(latestFeeds), true);
  assert.equal(oldReport.signal.aborted, true);
  assert.equal(requests.isCurrent(oldReport), false);
  assert.equal(requests.isCurrent(latestReport), true);
});

test("CRUD selection resolution preserves a selection changed while the request was pending", () => {
  const withCreated = [...profiles, { id: "profile-new", name: "新组", targets: [] }];

  assert.equal(selectedProfileAfterMutation(withCreated, {
    selectedAtRequest: "profile-a",
    selectedAtResponse: "profile-a",
    selectionChanged: false,
    preferredProfileId: "profile-new",
  }), "profile-new");

  assert.equal(selectedProfileAfterMutation(withCreated, {
    selectedAtRequest: "profile-a",
    selectedAtResponse: "profile-b",
    selectionChanged: true,
    preferredProfileId: "profile-new",
  }), "profile-b");
});

test("only revision conflicts and precondition failures map to concurrent settings conflicts", () => {
  assert.equal(isSettingsRevisionConflict({
    status: 409,
    payload: { error_code: "SETTINGS_CONFLICT" },
  }), true);
  assert.equal(isSettingsRevisionConflict({
    status: 428,
    payload: { error_code: "SETTINGS_REVISION_REQUIRED" },
  }), true);
  assert.equal(isSettingsRevisionConflict({
    status: 409,
    payload: { error_code: "LAST_PROFILE_REQUIRED" },
  }), false);
  assert.equal(isSettingsRevisionConflict({ status: 503 }), false);
});
