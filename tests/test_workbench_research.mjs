import assert from "node:assert/strict";
import test from "node:test";

import {
  archivedResearchAfterRun,
  buildArchiveEntries,
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
      results: [
        { ticker: "NVDA", rating: "Overweight", report: "reports/NVDA/2026-07-22/complete_report.md" },
        { ticker: "SPY", rating: "Hold", report: "reports/SPY/2026-07-22/complete_report.md", error: true },
      ],
    },
    {
      trade_date: "2026-07-21",
      generated_at: "2026-07-22T06:28:17+08:00",
      provider: "openai_compatible",
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

test("invalidated reports stay available to audit but are hidden from the default archive", () => {
  const history = [{
    trade_date: "2026-07-24",
    generated_at: "2026-07-24T15:21:07+08:00",
    results: [
      { ticker: "515880.SS", rating: "Sell", report: "reports/515880.SS/2026-07-24/complete_report.md" },
      { ticker: "ORCL", rating: "Hold", report: "reports/ORCL/2026-07-24/complete_report.md" },
    ],
  }];
  const audit = {
    reports: [
      { report: "reports/515880.SS/2026-07-24/complete_report.md", auditStatus: "invalidated", problemCodes: ["CORPORATE_ACTION_CONTAMINATION"] },
      { report: "reports/ORCL/2026-07-24/complete_report.md", auditStatus: "legacy_unverified", problemCodes: [] },
    ],
  };
  assert.deepEqual(buildArchiveEntries(history, audit).map(({ ticker }) => ticker), ["ORCL"]);
  assert.deepEqual(buildArchiveEntries(history, audit, { includeInvalidated: true }).map(({ ticker }) => ticker), ["515880.SS", "ORCL"]);
  assert.equal(filterAuditedResults(history[0].results, audit).length, 1);
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
