import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArchiveEntries,
  buildPipelineStages,
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

test("latest run selection ignores malformed rows and keeps chronological truth", () => {
  const latest = latestResearchRun([
    { id: 1, created_at: "2026-07-23T00:00:00Z" },
    { id: 2, created_at: "2026-07-24T00:00:00Z" },
    { id: 3 },
  ]);
  assert.equal(latest.id, 2);
});
