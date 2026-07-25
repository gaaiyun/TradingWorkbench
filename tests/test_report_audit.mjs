import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReportAudit,
  INVALIDATED_REPORTS,
} from "../scripts/report-audit.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("audit index classifies every successful archived report and the malformed ISSUE record", async () => {
  const history = JSON.parse(
    await fs.readFile(path.join(repoRoot, "public", "data", "history.json"), "utf8"),
  );
  const audit = await buildReportAudit({
    history,
    reportsRoot: path.join(repoRoot, "public", "reports"),
  });

  assert.equal(audit.version, 1);
  assert.equal(audit.summary.successfulReports, 33);
  assert.equal(audit.summary.invalidatedReports, 3);
  assert.equal(audit.summary.legacyUnverifiedReports, 30);
  assert.equal(audit.summary.invalidRecords, 1);
  assert.equal(audit.reports.length, 34);
  assert.deepEqual(
    audit.reports.filter((entry) => entry.auditStatus === "invalidated")
      .map((entry) => `${entry.ticker}|${entry.tradeDate}`).sort(),
    [...INVALIDATED_REPORTS].sort(),
  );

  const issue = audit.reports.find((entry) => entry.ticker === "ISSUE");
  assert.equal(issue.auditStatus, "invalid_record");
  assert.match(issue.problemCodes.join(","), /INVALID_TICKER_INPUT/);
});

test("audit parser records missing claim citations and forced final markers", async () => {
  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-24T15:21:07+08:00",
      results: [{
        ticker: "515880.SS",
        rating: "Sell",
        report: "reports/515880.SS/2026-07-24/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: path.join(repoRoot, "public", "reports"),
  });
  const entry = audit.reports[0];
  assert.equal(entry.evidence.claimCitationCount, 0);
  assert.ok(entry.evidence.urlCount >= 0);
  assert.ok(entry.evidence.finalProposalMarkers >= 1);
  assert.ok(entry.problemCodes.includes("CORPORATE_ACTION_CONTAMINATION"));
  assert.ok(entry.problemCodes.includes("MISSING_CLAIM_EVIDENCE"));
});

test("audit index accepts only a matching claim-validated report bundle as verified", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tradingworkbench-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportDir = path.join(root, "GOOGL", "2026-07-24");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, "complete_report.md"),
    "Alphabet closed at 180 [M1].",
  );
  const contentHash = "a".repeat(64);
  await fs.writeFile(path.join(reportDir, "report_manifest.json"), JSON.stringify({
    ticker: "GOOGL",
    tradeDate: "2026-07-24",
    analysisStatus: "rated",
    auditStatus: "verified",
    claimValidation: { status: "passed", errorCodes: [] },
    evidence: { status: "ok", contentHash },
  }));
  await fs.writeFile(path.join(reportDir, "evidence_packet.json"), JSON.stringify({
    schemaVersion: "EvidencePacketV1",
    status: "ok",
    contentHash,
    instrument: { symbol: "GOOGL" },
  }));
  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [{
        ticker: "GOOGL",
        rating: "Hold",
        report: "reports/GOOGL/2026-07-24/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: root,
  });
  assert.equal(audit.summary.verifiedReports, 1);
  assert.equal(audit.reports[0].auditStatus, "verified");
  assert.equal(audit.reports[0].problemCodes.includes("MISSING_CLAIM_EVIDENCE"), false);
});
