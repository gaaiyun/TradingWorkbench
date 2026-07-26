import assert from "node:assert/strict";
import test from "node:test";

import * as research from "../public/assets/workbench-research.mjs";
import {
  archiveChatContext,
  archivedResearchAfterRun,
  buildArchiveEntries,
  buildArchiveReportUrl,
  buildPipelineStages,
  filterAuditedResults,
  latestResearchRun,
} from "../public/assets/workbench-research.mjs";

test("research history becomes a stable newest-first archive index", () => {
  const entries = buildArchiveEntries([
    {
      trade_date: "2026-07-22",
      generated_at: "2026-07-23T06:34:48+08:00",
      provider: "openai_compatible",
      identity: { scope: "profile", kind: "manual", profileId: "profile-a", requestId: null },
      results: [
        { ticker: "NVDA", rating: "Overweight", report: "reports/NVDA/2026-07-22/complete_report.md" },
        { ticker: "SPY", rating: "Hold", report: "reports/SPY/2026-07-22/complete_report.md", error: true },
      ],
    },
    {
      trade_date: "2026-07-21",
      generated_at: "2026-07-22T06:28:17+08:00",
      provider: "openai_compatible",
      identity: { scope: "profile", kind: "manual", profileId: "profile-a", requestId: null },
      results: [
        { ticker: "NVDA", rating: "Hold", report: "reports/NVDA/2026-07-21/complete_report.md" },
      ],
    },
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].ticker, "NVDA");
  assert.equal(entries[0].tradeDate, "2026-07-22");
  assert.equal(entries[1].tradeDate, "2026-07-21");
});

test("invalidated and legacy reports stay confined to historical audit", () => {
  const history = [{
    trade_date: "2026-07-24",
    generated_at: "2026-07-24T15:21:07+08:00",
    identity: { scope: "legacy", kind: "legacy", profileId: null, requestId: null },
    results: [
      { ticker: "515880.SS", rating: "Sell", report: "reports/515880.SS/2026-07-24/complete_report.md" },
      { ticker: "ORCL", rating: "Hold", report: "reports/ORCL/2026-07-24/complete_report.md" },
    ],
  }];
  const audit = {
    reports: [
      {
        report: "reports/515880.SS/2026-07-24/complete_report.md",
        auditStatus: "invalidated",
        problemCodes: ["CORPORATE_ACTION_CONTAMINATION"],
        identity: { scope: "legacy", kind: "legacy", profileId: null, requestId: null },
      },
      {
        report: "reports/ORCL/2026-07-24/complete_report.md",
        auditStatus: "legacy_unverified",
        problemCodes: [],
        identity: { scope: "legacy", kind: "legacy", profileId: null, requestId: null },
      },
    ],
  };
  assert.deepEqual(buildArchiveEntries(history, audit), []);
  assert.deepEqual(buildArchiveEntries(history, audit, { includeInvalidated: true }).map(({ ticker }) => ticker), ["515880.SS", "ORCL"]);
  assert.equal(filterAuditedResults(history[0].results, audit).length, 1);
  assert.equal(
    filterAuditedResults(history[0].results, audit, { verifiedOnly: true }).length,
    0,
  );
});

test("legacy reports are confined to historical audit and audit identity cannot cross scopes", () => {
  const path = "reports/NVDA/2026-07-24/complete_report.md";
  const profileIdentity = {
    scope: "profile", kind: "manual", profileId: "profile-a", requestId: null,
  };
  const legacyIdentity = {
    scope: "legacy", kind: "legacy", profileId: null, requestId: null,
  };
  const history = [
    {
      identity: profileIdentity,
      results: [{ ticker: "NVDA", report: path }],
    },
    {
      identity: legacyIdentity,
      results: [{ ticker: "LEGACY", report: "reports/LEGACY/2026-07-24/complete_report.md" }],
    },
  ];
  const audit = {
    reports: [{
      report: path,
      auditStatus: "verified",
      identity: {
        scope: "adhoc", kind: "adhoc", profileId: null,
        requestId: "123e4567-e89b-42d3-a456-426614174006",
      },
    }],
  };

  const current = buildArchiveEntries(history, audit);
  assert.deepEqual(current.map(({ ticker }) => ticker), ["NVDA"]);
  assert.equal(current[0].auditStatus, "unverified");
  assert.deepEqual(
    buildArchiveEntries(history, audit, { includeInvalidated: true })
      .map(({ ticker }) => ticker),
    ["NVDA", "LEGACY"],
  );
});

test("workflow status maps honestly to the four visible research stages", () => {
  assert.deepEqual(
    buildPipelineStages({ status: "queued", conclusion: null }).map(({ status }) => status),
    ["queued", "pending", "pending", "pending"],
  );
  assert.deepEqual(
    buildPipelineStages({ status: "in_progress", conclusion: null }).map(({ status }) => status),
    ["running", "pending", "pending", "pending"],
  );
  assert.deepEqual(
    buildPipelineStages({ status: "completed", conclusion: "success" }).map(({ status }) => status),
    ["completed", "completed", "completed", "completed"],
  );
  assert.deepEqual(
    buildPipelineStages({ status: "completed", conclusion: "failure" }).map(({ status }) => status),
    ["failed", "unknown", "unknown", "unknown"],
  );
});

test("a persisted report distinguishes completed analysis from a later publish failure", () => {
  const failedRun = {
    status: "completed",
    conclusion: "failure",
    created_at: "2026-07-23T23:52:27Z",
  };
  assert.equal(archivedResearchAfterRun(failedRun, {
    generated_at: "2026-07-24T07:53:17+08:00",
    results: [{ ticker: "512480.SS", report: "reports/512480.SS/report.md" }],
  }), true);
  assert.equal(archivedResearchAfterRun(failedRun, {
    generated_at: "2026-07-23T07:53:17+08:00",
    results: [{ ticker: "512480.SS", report: "reports/512480.SS/report.md" }],
  }), false);
  assert.equal(archivedResearchAfterRun(failedRun, {
    generated_at: "2026-07-24T07:53:17+08:00",
    results: [],
  }), false);
});

test("latest run selection ignores malformed rows and keeps chronological truth", () => {
  const latest = latestResearchRun([
    { id: 1, created_at: "2026-07-23T00:00:00Z" },
    { id: 2, created_at: "2026-07-24T00:00:00Z" },
    { id: 3 },
  ]);
  assert.equal(latest.id, 2);
});

test("temporary research request is independent from monitor settings and carries an idempotency key", () => {
  const request = research.buildTemporaryResearchRequest({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    tickers: " 515880.ss, NVDA\n515880.SS ",
    analysts: ["market", "news", "fundamentals"],
    researchDepth: "standard",
  });

  assert.deepEqual(request, {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    tickers: ["515880.SS", "NVDA"],
    analysts: ["market", "news", "fundamentals"],
    researchDepth: "standard",
  });
  assert.equal("settings" in request, false);
});

test("temporary research enforces API workload limits for standard and deep requests", () => {
  assert.equal(research.researchTickerLimit("standard"), 6);
  assert.equal(research.researchTickerLimit("deep"), 3);
  assert.throws(
    () => research.buildTemporaryResearchRequest({
      requestId: "123e4567-e89b-42d3-a456-426614174001",
      tickers: ["AAPL", "MSFT", "NVDA", "GOOGL", "ORCL", "AMD", "TSM"],
      analysts: ["market", "news", "fundamentals"],
      researchDepth: "standard",
    }),
    /standard.*6/,
  );
  assert.throws(
    () => research.buildTemporaryResearchRequest({
      requestId: "123e4567-e89b-42d3-a456-426614174002",
      tickers: ["AAPL", "MSFT", "NVDA", "GOOGL"],
      analysts: ["market", "news", "fundamentals"],
      researchDepth: "deep",
    }),
    /deep.*3/,
  );
});

test("temporary research defaults to verified analysts and standard depth", () => {
  assert.deepEqual(
    research.buildTemporaryResearchRequest({
      requestId: "123e4567-e89b-42d3-a456-426614174003",
      tickers: ["NVDA"],
    }),
    {
      requestId: "123e4567-e89b-42d3-a456-426614174003",
      tickers: ["NVDA"],
      analysts: ["market", "news", "fundamentals"],
      researchDepth: "standard",
    },
  );
});

test("temporary research creates UUID request ids and rejects controls the API will refuse", () => {
  assert.match(
    research.createTemporaryResearchRequestId(),
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  );
  assert.throws(
    () => research.buildTemporaryResearchRequest({
      requestId: "not-a-uuid",
      tickers: ["NVDA"],
    }),
    /requestId.*UUID/,
  );
  assert.throws(
    () => research.buildTemporaryResearchRequest({
      requestId: "123e4567-e89b-42d3-a456-426614174004",
      tickers: ["NVDA"],
      analysts: [],
    }),
    /分析师/,
  );
  assert.throws(
    () => research.buildTemporaryResearchRequest({
      requestId: "123e4567-e89b-42d3-a456-426614174005",
      tickers: ["NVDA"],
      researchDepth: "extreme",
    }),
    /researchDepth/,
  );
});

test("archive entries retain report files and expose ordered available columns", () => {
  const [entry] = buildArchiveEntries([{
    trade_date: "2026-07-24",
    identity: {
      scope: "adhoc",
      kind: "adhoc",
      profileId: null,
      requestId: "123e4567-e89b-42d3-a456-426614174006",
      runId: "7788",
      slotId: null,
      scheduledFor: null,
    },
    request: {
      requestId: "123e4567-e89b-42d3-a456-426614174006",
      analysts: ["market", "news"],
      researchDepth: "standard",
      kind: "adhoc",
    },
    run: {
      id: "7788",
      workflow: "analysis-request",
    },
    results: [{
      ticker: "NVDA",
      rating: "Buy",
      report: "reports/NVDA/2026-07-24/complete_report.md",
      files: {
        complete_report: "reports/NVDA/2026-07-24/complete_report.md",
        conservative: "reports/NVDA/2026-07-24/4_risk/conservative.md",
        decision: "reports/NVDA/2026-07-24/5_portfolio/decision.md",
        market: "reports/NVDA/2026-07-24/1_analysts/market.md",
        fundamentals: "reports/NVDA/2026-07-24/1_analysts/fundamentals.md",
        bull: "reports/NVDA/2026-07-24/2_research/bull.md",
      },
    }],
  }]);

  assert.deepEqual(entry.files, {
    complete_report: "reports/NVDA/2026-07-24/complete_report.md",
    conservative: "reports/NVDA/2026-07-24/4_risk/conservative.md",
    decision: "reports/NVDA/2026-07-24/5_portfolio/decision.md",
    market: "reports/NVDA/2026-07-24/1_analysts/market.md",
    fundamentals: "reports/NVDA/2026-07-24/1_analysts/fundamentals.md",
    bull: "reports/NVDA/2026-07-24/2_research/bull.md",
  });
  assert.equal(entry.identity.scope, "adhoc");
  assert.equal(entry.identity.requestId, "123e4567-e89b-42d3-a456-426614174006");
  assert.deepEqual(entry.request.analysts, ["market", "news"]);
  assert.equal(entry.run.id, "7788");
  assert.deepEqual(
    research.buildArchiveFileTabs(entry).map(({ id }) => id),
    ["market", "fundamentals", "bull", "conservative", "decision", "complete_report"],
  );
});

test("report URLs select exactly one verified run identity", () => {
  const path = "reports/NVDA/2026-07-24/5_portfolio/decision.md";
  const profileEntry = {
    report: path,
    identity: {
      scope: "profile",
      kind: "manual",
      profileId: "profile-a",
      requestId: null,
    },
  };
  const adhocEntry = {
    report: path,
    identity: {
      scope: "adhoc",
      kind: "adhoc",
      profileId: null,
      requestId: "123e4567-e89b-42d3-a456-426614174006",
    },
  };
  const legacyEntry = {
    report: path,
    identity: {
      scope: "legacy",
      kind: "legacy",
      profileId: null,
      requestId: null,
    },
  };

  assert.equal(
    buildArchiveReportUrl(profileEntry, path),
    `/api/report?path=${encodeURIComponent(path)}&profile=profile-a`,
  );
  assert.equal(
    buildArchiveReportUrl(adhocEntry, path),
    `/api/report?path=${encodeURIComponent(path)}&requestId=123e4567-e89b-42d3-a456-426614174006`,
  );
  assert.equal(
    buildArchiveReportUrl(legacyEntry, path),
    `/api/report?path=${encodeURIComponent(path)}`,
  );
  assert.throws(
    () => buildArchiveReportUrl({
      ...adhocEntry,
      identity: {
        ...adhocEntry.identity,
        profileId: "profile-a",
      },
    }, path),
    /报告身份/,
  );
});

test("chat report context follows the selected report instead of the active profile", () => {
  assert.deepEqual(archiveChatContext({
    auditStatus: "verified",
    identity: {
      scope: "profile",
      kind: "manual",
      profileId: "profile-a",
      requestId: null,
    },
  }), {
    profileId: "profile-a",
  });
  assert.deepEqual(archiveChatContext({
    auditStatus: "verified",
    identity: {
      scope: "adhoc",
      kind: "adhoc",
      profileId: null,
      requestId: "123e4567-e89b-42d3-a456-426614174006",
    },
  }), {
    reportRequestId: "123e4567-e89b-42d3-a456-426614174006",
    reportScope: "adhoc",
  });
  for (const auditStatus of ["legacy_unverified", "unverified", "invalidated"]) {
    assert.equal(archiveChatContext({
      auditStatus,
      identity: {
        scope: "legacy",
        kind: "legacy",
        profileId: null,
        requestId: null,
      },
    }), null);
  }
});

test("archive opens decision by default and falls back in canonical order when it is absent", () => {
  const withDecision = research.buildArchiveFileTabs({
    report: "reports/NVDA/2026-07-24/complete_report.md",
    files: {
      market: "reports/NVDA/2026-07-24/1_analysts/market.md",
      decision: "reports/NVDA/2026-07-24/5_portfolio/decision.md",
      complete_report: "reports/NVDA/2026-07-24/complete_report.md",
    },
  });
  assert.equal(research.defaultArchiveFileTab(withDecision).id, "decision");

  const withoutDecision = research.buildArchiveFileTabs({
    report: "reports/NVDA/2026-07-24/complete_report.md",
    files: {
      market: "reports/NVDA/2026-07-24/1_analysts/market.md",
      complete_report: "reports/NVDA/2026-07-24/complete_report.md",
    },
  });
  assert.equal(research.defaultArchiveFileTab(withoutDecision).id, "market");
});

test("archive file tabs ignore allowlisted keys that escape the report version directory", () => {
  const tabs = research.buildArchiveFileTabs({
    report: "reports/NVDA/2026-07-24/complete_report.md",
    files: {
      market: "../data/latest.json",
      fundamentals: "/api/settings",
      decision: "reports/NVDA/other-version/5_portfolio/decision.md",
      complete_report: "reports/NVDA/2026-07-24/complete_report.md",
    },
  });

  assert.deepEqual(tabs, [{
    id: "complete_report",
    label: "完整报告",
    path: "reports/NVDA/2026-07-24/complete_report.md",
  }]);
});

test("temporary research status only matches its own request id", () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const matched = research.researchRunForRequest([
    {
      id: 2,
      requestId: "223e4567-e89b-42d3-a456-426614174000",
      status: "in_progress",
      created_at: "2026-07-25T10:01:00Z",
    },
    {
      id: 1,
      requestId,
      status: "queued",
      created_at: "2026-07-25T10:00:00Z",
    },
  ], requestId);
  assert.equal(matched.id, 1);
  assert.equal(
    research.researchRunForRequest([{ requestId: "other" }], requestId),
    null,
  );
  assert.equal(
    research.archivedResearchForRequest([{
      request: { requestId },
      results: [{ ticker: "NVDA" }],
    }], requestId).results[0].ticker,
    "NVDA",
  );
});
