import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReportAudit,
  INVALIDATED_REPORTS,
} from "../scripts/report-audit.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const EXPECTED_INVALIDATED_REPORTS = new Set([
  ...INVALIDATED_REPORTS,
  "reports/MSFT/2026-07-24/complete_report.md",
]);

test("audit index classifies every archived report and any retained ISSUE record", async () => {
  const history = JSON.parse(
    await fs.readFile(path.join(repoRoot, "public", "data", "history.json"), "utf8"),
  );
  const audit = await buildReportAudit({
    history,
    reportsRoot: path.join(repoRoot, "public", "reports"),
  });

  assert.equal(audit.version, 1);
  const allResults = history.flatMap((batch) => batch.results || []);
  const successful = allResults.filter((result) => !result.error && result.report);
  assert.equal(audit.summary.successfulReports, successful.length);
  // New daily reports may add another genuinely invalidated entry. The
  // invariant is that known invalidations remain classified, not that the
  // historical count stays frozen forever.
  assert.ok(audit.summary.invalidatedReports >= EXPECTED_INVALIDATED_REPORTS.size);
  assert.equal(
    audit.summary.verifiedReports
      + audit.summary.legacyUnverifiedReports
      + audit.summary.invalidatedReports,
    audit.summary.successfulReports,
  );
  assert.equal(audit.summary.invalidRecords, allResults.length - successful.length);
  assert.equal(
    audit.summary.invalidRecords,
    audit.summary.evidenceValidationFailures
      + audit.summary.analysisExecutionFailures
      + audit.summary.invalidInputs,
  );
  assert.equal(audit.reports.length, allResults.length);
  const invalidatedPaths = new Set(
    audit.reports.filter((entry) => entry.auditStatus === "invalidated")
      .map((entry) => entry.report),
  );
  for (const expectedPath of EXPECTED_INVALIDATED_REPORTS) {
    assert.equal(invalidatedPaths.has(expectedPath), true, expectedPath);
  }

  const issue = audit.reports.find((entry) => entry.ticker === "ISSUE");
  if (issue) {
    assert.equal(issue.auditStatus, "invalid_record");
    assert.equal(issue.failureClass, "invalid_input");
    assert.match(issue.problemCodes.join(","), /INVALID_TICKER_INPUT/);
  }
});

test("audit separates evidence validation failures from model or workflow failures", async () => {
  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [
        {
          ticker: "ORCL",
          report: null,
          error: true,
          analysis_status: "data_validation_failed",
        },
        {
          ticker: "GOOGL",
          report: null,
          error: true,
        },
      ],
    }],
    reportsRoot: path.join(repoRoot, "public", "reports"),
  });

  assert.equal(audit.summary.evidenceValidationFailures, 1);
  assert.equal(audit.summary.analysisExecutionFailures, 1);
  assert.equal(audit.summary.invalidInputs, 0);
  assert.equal(audit.reports[0].failureClass, "evidence_validation");
  assert.deepEqual(audit.reports[0].problemCodes, ["EVIDENCE_VALIDATION_FAILED"]);
  assert.equal(audit.reports[1].failureClass, "analysis_execution");
  assert.deepEqual(audit.reports[1].problemCodes, ["ANALYSIS_EXECUTION_FAILED"]);
});

test("audit entries preserve explicit run identity without guessing legacy profiles", async () => {
  const profileIdentity = {
    scope: "profile",
    kind: "manual",
    runId: null,
    profileId: "profile-a",
    requestId: null,
    slotId: null,
    scheduledFor: null,
  };
  const audit = await buildReportAudit({
    history: [
      {
        trade_date: "2026-07-24",
        generated_at: "2026-07-25T08:00:00Z",
        identity: profileIdentity,
        results: [{
          ticker: "ORCL",
          report: null,
          error: true,
        }],
      },
      {
        trade_date: "2026-07-23",
        generated_at: "2026-07-24T08:00:00Z",
        results: [{
          ticker: "ORCL",
          report: null,
          error: true,
        }],
      },
    ],
    reportsRoot: path.join(repoRoot, "public", "reports"),
  });

  assert.deepEqual(audit.reports[0].identity, profileIdentity);
  assert.deepEqual(audit.reports[1].identity, {
    scope: "legacy",
    kind: "legacy",
    runId: null,
    profileId: null,
    requestId: null,
    slotId: null,
    scheduledFor: null,
  });
});

test("a repaired versioned report is not invalidated only because it shares the legacy trade date", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tradingworkbench-audit-versioned-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportDir = path.join(root, "515880.SS", "2026-07-24-v2");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "complete_report.md"), "Not Rated.");
  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [{
        ticker: "515880.SS",
        rating: "Not Rated",
        report: "reports/515880.SS/2026-07-24-v2/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: root,
  });
  assert.equal(audit.reports[0].auditStatus, "legacy_unverified");
  assert.equal(
    audit.reports[0].problemCodes.includes("CORPORATE_ACTION_CONTAMINATION"),
    false,
  );
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
  const packetText = JSON.stringify({
    schemaVersion: "EvidencePacketV1",
    status: "ok",
    asOf: "2026-07-24T20:00:00Z",
    canRate: true,
    contentHash,
    instrument: { symbol: "GOOGL" },
    bars: [],
    corporateActions: [],
    news: [],
    sources: [],
    integrity: { errors: [], warnings: [] },
  });
  await fs.writeFile(path.join(reportDir, "evidence_packet.json"), packetText);
  const packetFileHash = createHash("sha256").update(packetText).digest("hex");
  const manifestPath = path.join(reportDir, "report_manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.evidence.packetFileHash = packetFileHash;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
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
  assert.equal(audit.reports[0].claimValidation.status, "passed");
  assert.equal(audit.reports[0].evidencePacket.contentHash, contentHash);
  assert.equal(audit.reports[0].problemCodes.includes("MISSING_CLAIM_EVIDENCE"), false);
});

test("audit invalidates a report whose manifest references an unreadable evidence packet", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tradingworkbench-audit-invalid-packet-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportDir = path.join(root, "MSFT", "2026-07-24");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "complete_report.md"), "Not Rated.");
  await fs.writeFile(path.join(reportDir, "report_manifest.json"), JSON.stringify({
    ticker: "MSFT",
    tradeDate: "2026-07-24",
    analysisStatus: "insufficient_evidence",
    auditStatus: "legacy_unverified",
    evidence: { status: "ok", contentHash: "a".repeat(64) },
  }));
  await fs.writeFile(
    path.join(reportDir, "evidence_packet.json"),
    "{\"bars\":[NaN]}",
  );

  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [{
        ticker: "MSFT",
        rating: "Not Rated",
        report: "reports/MSFT/2026-07-24/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: root,
  });

  assert.equal(audit.reports[0].auditStatus, "invalidated");
  assert.ok(audit.reports[0].problemCodes.includes("INVALID_EVIDENCE_PACKET"));
});

test("audit invalidates a parseable evidence packet that violates its manifest identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tradingworkbench-audit-wrong-packet-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportDir = path.join(root, "MSFT", "2026-07-24");
  await fs.mkdir(reportDir, { recursive: true });
  const contentHash = "a".repeat(64);
  await fs.writeFile(path.join(reportDir, "complete_report.md"), "Not Rated.");
  await fs.writeFile(path.join(reportDir, "report_manifest.json"), JSON.stringify({
    ticker: "MSFT",
    tradeDate: "2026-07-24",
    analysisStatus: "insufficient_evidence",
    auditStatus: "legacy_unverified",
    evidence: { status: "ok", contentHash },
  }));
  await fs.writeFile(path.join(reportDir, "evidence_packet.json"), JSON.stringify({
    schemaVersion: "WrongSchema",
    status: "ok",
    asOf: "2026-07-24T20:00:00Z",
    contentHash,
    instrument: { symbol: "MSFT" },
    bars: [],
    corporateActions: [],
    news: [],
    sources: [],
    integrity: { errors: [], warnings: [] },
  }));

  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [{
        ticker: "MSFT",
        rating: "Not Rated",
        report: "reports/MSFT/2026-07-24/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: root,
  });

  assert.equal(audit.reports[0].auditStatus, "invalidated");
  assert.ok(audit.reports[0].problemCodes.includes("INVALID_EVIDENCE_PACKET"));
});

test("audit invalidates a verified report when packet bytes no longer match the manifest hash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tradingworkbench-audit-tampered-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportDir = path.join(root, "MSFT", "2026-07-24");
  await fs.mkdir(reportDir, { recursive: true });
  const contentHash = "a".repeat(64);
  await fs.writeFile(path.join(reportDir, "complete_report.md"), "Close 192 [M1].");
  await fs.writeFile(path.join(reportDir, "report_manifest.json"), JSON.stringify({
    ticker: "MSFT",
    tradeDate: "2026-07-24",
    analysisStatus: "rated",
    auditStatus: "verified",
    claimValidation: { status: "passed", errorCodes: [] },
    evidence: {
      status: "ok",
      contentHash,
      packetFileHash: "b".repeat(64),
    },
  }));
  await fs.writeFile(path.join(reportDir, "evidence_packet.json"), JSON.stringify({
    schemaVersion: "EvidencePacketV1",
    status: "ok",
    asOf: "2026-07-24T20:00:00Z",
    canRate: true,
    contentHash,
    instrument: { symbol: "MSFT" },
    bars: [{ ts: "2026-07-24T20:00:00Z", close: 999 }],
    corporateActions: [],
    news: [],
    sources: [],
    integrity: { errors: [], warnings: [] },
  }));

  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [{
        ticker: "MSFT",
        rating: "Hold",
        report: "reports/MSFT/2026-07-24/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: root,
  });

  assert.equal(audit.reports[0].auditStatus, "invalidated");
  assert.ok(audit.reports[0].problemCodes.includes("INVALID_EVIDENCE_PACKET"));
});

test("audit never verifies a rated report that filtered unsafe public paragraphs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tradingworkbench-audit-filtered-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportDir = path.join(root, "MSFT", "2026-07-24");
  await fs.mkdir(reportDir, { recursive: true });
  const packet = {
    schemaVersion: "EvidencePacketV1",
    status: "ok",
    asOf: "2026-07-24T20:00:00Z",
    canRate: true,
    contentHash: "a".repeat(64),
    instrument: { symbol: "MSFT" },
    bars: [{ ts: "2026-07-24T20:00:00Z", close: 192 }],
    corporateActions: [],
    news: [],
    sources: [],
    integrity: { errors: [], warnings: [] },
  };
  const packetText = JSON.stringify(packet);
  const packetFileHash = createHash("sha256").update(packetText).digest("hex");
  await fs.writeFile(path.join(reportDir, "complete_report.md"), "Close 192 [M1].");
  await fs.writeFile(path.join(reportDir, "evidence_packet.json"), packetText);
  await fs.writeFile(path.join(reportDir, "report_manifest.json"), JSON.stringify({
    ticker: "MSFT",
    tradeDate: "2026-07-24",
    analysisStatus: "rated",
    auditStatus: "verified",
    claimValidation: {
      status: "passed",
      errorCodes: [],
      omittedUnsafeParagraphs: 1,
    },
    evidence: {
      status: "ok",
      contentHash: packet.contentHash,
      packetFileHash,
    },
  }));

  const audit = await buildReportAudit({
    history: [{
      trade_date: "2026-07-24",
      generated_at: "2026-07-25T08:00:00Z",
      results: [{
        ticker: "MSFT",
        rating: "Sell",
        report: "reports/MSFT/2026-07-24/complete_report.md",
        error: false,
      }],
    }],
    reportsRoot: root,
  });

  assert.equal(audit.summary.verifiedReports, 0);
  assert.equal(audit.reports[0].auditStatus, "invalidated");
  assert.ok(
    audit.reports[0].problemCodes.includes("FILTERED_UNSAFE_PUBLIC_CLAIM"),
  );
});

test("report persistence regenerates the audit index after merging history", async () => {
  const script = await fs.readFile(
    path.join(repoRoot, "scripts", "persist_reports.sh"),
    "utf8",
  );
  const historyUpdate = script.indexOf("update_history(Path(\"public/data\"), payload)");
  const auditUpdate = script.indexOf("node scripts/report-audit.mjs");
  const gitAdd = script.indexOf("git add public/data public/reports");
  assert.ok(historyUpdate >= 0);
  assert.ok(auditUpdate > historyUpdate);
  assert.ok(gitAdd > auditUpdate);
});
