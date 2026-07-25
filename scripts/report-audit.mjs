import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INVALIDATED_REPORTS = new Set([
  "reports/515880.SS/2026-07-24/complete_report.md",
  "reports/512480.SS/2026-07-23/complete_report.md",
  "reports/512480.SS/2026-07-24/complete_report.md",
]);

const ETF_SYMBOLS = new Set(["510050.SS", "512480.SS", "515880.SS", "SPY"]);
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const CLAIM_CITATION_RE = /(?:\[(?:evidence|e)-?\d+\]|\b(?:evidence|e)-?\d+\b|证据(?:编号|ID)\s*[:：]?\s*\d+)/gi;
const TARGET_RE = /\*\*(?:Price Target|Target Price|目标价)\*\*\s*[:：]/gi;
const VALUATION_RE = /(?:DCF|discounted cash flow|估值方法|情景分析|valuation method|multiple|倍数|概率)/gi;
const FINAL_PROPOSAL_RE = /FINAL TRANSACTION PROPOSAL/gi;
const PUBLISHED_RE = /(?:published|发布时间|发布日期|published_at|发表时间)/gi;

function normalizedReportPath(report) {
  return String(report || "").replaceAll("\\", "/");
}

function isInvalidatedReport(report) {
  return INVALIDATED_REPORTS.has(normalizedReportPath(report));
}

function problemCodesFor({
  ticker,
  analysisStatus,
  error,
  report,
  text,
  evidence,
  verifiedEvidence = false,
}) {
  const codes = [];
  if (error || !report) {
    if (ticker === "ISSUE") codes.push("INVALID_TICKER_INPUT");
    else if (analysisStatus === "data_validation_failed") {
      codes.push("EVIDENCE_VALIDATION_FAILED");
    } else {
      codes.push("ANALYSIS_EXECUTION_FAILED");
    }
  }
  if (!report) return codes;
  if (!text) codes.push("REPORT_MISSING");
  if (isInvalidatedReport(report)) {
    codes.push("CORPORATE_ACTION_CONTAMINATION");
  }
  if (ETF_SYMBOLS.has(ticker)) codes.push("ETF_TEMPLATE_MISMATCH");
  if (!verifiedEvidence && (evidence.claimCitationCount === 0 || evidence.urlCount === 0)) {
    codes.push("MISSING_CLAIM_EVIDENCE");
  }
  if (evidence.finalProposalMarkers > 1) codes.push("DUPLICATE_FINAL_PROPOSAL");
  if (evidence.priceTargetCount > 0 && evidence.valuationMethodCount === 0) {
    codes.push("UNSUPPORTED_PRICE_TARGET");
  }
  if (evidence.publishedMarkerCount === 0) codes.push("MISSING_PUBLICATION_TIME");
  return [...new Set(codes)];
}

function failureClassFor({ ticker, analysisStatus, report }) {
  if (report) return null;
  if (ticker === "ISSUE") return "invalid_input";
  if (analysisStatus === "data_validation_failed") return "evidence_validation";
  return "analysis_execution";
}

function parseEvidence(text) {
  const safeText = typeof text === "string" ? text : "";
  const urls = safeText.match(URL_RE) || [];
  const evidence = {
    urlCount: new Set(urls).size,
    claimCitationCount: (safeText.match(CLAIM_CITATION_RE) || []).length,
    finalProposalMarkers: (safeText.match(FINAL_PROPOSAL_RE) || []).length,
    priceTargetCount: (safeText.match(TARGET_RE) || []).length,
    valuationMethodCount: (safeText.match(VALUATION_RE) || []).length,
    publishedMarkerCount: (safeText.match(PUBLISHED_RE) || []).length,
  };
  return evidence;
}

function reportParts(report) {
  if (!report) return null;
  const relative = report.replace(/^reports[\\/]/, "").split(/[\\/]/g);
  if (relative.some((part) => !part || part === "." || part === "..")) return null;
  return relative;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readReportBundle(reportsRoot, report) {
  const relative = reportParts(report);
  if (!relative) return { text: "", manifest: null, packet: null };
  const reportPath = path.join(reportsRoot, ...relative);
  try {
    const text = await fs.readFile(reportPath, "utf8");
    const directory = path.dirname(reportPath);
    return {
      text,
      manifest: await readJson(path.join(directory, "report_manifest.json")),
      packet: await readJson(path.join(directory, "evidence_packet.json")),
    };
  } catch {
    return { text: "", manifest: null, packet: null };
  }
}

function hasVerifiedBundle({ manifest, packet, ticker, tradeDate }) {
  const hash = manifest?.evidence?.contentHash;
  return (
    manifest?.ticker === ticker
    && manifest?.tradeDate === tradeDate
    && manifest?.analysisStatus === "rated"
    && manifest?.auditStatus === "verified"
    && manifest?.claimValidation?.status === "passed"
    && manifest?.evidence?.status === "ok"
    && typeof hash === "string"
    && /^[a-f0-9]{64}$/i.test(hash)
    && packet?.schemaVersion === "EvidencePacketV1"
    && packet?.status === "ok"
    && packet?.contentHash === hash
    && packet?.instrument?.symbol === ticker
  );
}

export async function buildReportAudit({ history, reportsRoot }) {
  const entries = [];
  for (const batch of Array.isArray(history) ? history : []) {
    for (const result of Array.isArray(batch?.results) ? batch.results : []) {
      const ticker = String(result?.ticker || "");
      const tradeDate = String(batch?.trade_date || "");
      const report = result?.report ? String(result.report) : null;
      const bundle = await readReportBundle(reportsRoot, report);
      const text = bundle.text;
      const evidence = parseEvidence(text);
      const error = result?.error === true;
      const analysisStatus = bundle.manifest?.analysisStatus
        || result?.analysis_status
        || null;
      const verifiedEvidence = hasVerifiedBundle({
        ...bundle,
        ticker,
        tradeDate,
      });
      const problemCodes = problemCodesFor({
        ticker,
        analysisStatus,
        error,
        report,
        text,
        evidence,
        verifiedEvidence,
      });
      const auditStatus = error || !report
        ? "invalid_record"
        : isInvalidatedReport(report)
          ? "invalidated"
          : verifiedEvidence
            ? "verified"
            : "legacy_unverified";
      entries.push({
        ticker,
        tradeDate,
        generatedAt: batch?.generated_at || null,
        provider: batch?.provider || null,
        rating: result?.rating || null,
        analysisStatus,
        report,
        auditStatus,
        failureClass: failureClassFor({ ticker, analysisStatus, report }),
        problemCodes,
        evidence,
        claimValidation: bundle.manifest?.claimValidation || null,
        evidencePacket: bundle.packet
          ? {
              status: bundle.packet.status || null,
              asOf: bundle.packet.asOf || null,
              contentHash: bundle.packet.contentHash || null,
            }
          : null,
        evidencePublish: result?.evidence_publish || null,
        supersededBy: null,
      });
    }
  }

  entries.sort((left, right) => String(right.generatedAt || right.tradeDate)
    .localeCompare(String(left.generatedAt || left.tradeDate)));
  for (const entry of entries) {
    if (entry.auditStatus !== "invalidated") continue;
    entry.supersededBy = entries.find((candidate) =>
      candidate.ticker === entry.ticker
      && candidate.auditStatus === "verified"
      && candidate.report !== entry.report)?.report || null;
  }
  const summary = {
    successfulReports: entries.filter((entry) => entry.auditStatus !== "invalid_record").length,
    verifiedReports: entries.filter((entry) => entry.auditStatus === "verified").length,
    invalidatedReports: entries.filter((entry) => entry.auditStatus === "invalidated").length,
    legacyUnverifiedReports: entries.filter((entry) => entry.auditStatus === "legacy_unverified").length,
    invalidRecords: entries.filter((entry) => entry.auditStatus === "invalid_record").length,
    evidenceValidationFailures: entries.filter(
      (entry) => entry.failureClass === "evidence_validation",
    ).length,
    analysisExecutionFailures: entries.filter(
      (entry) => entry.failureClass === "analysis_execution",
    ).length,
    invalidInputs: entries.filter((entry) => entry.failureClass === "invalid_input").length,
  };
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    summary,
    reports: entries,
  };
}

export async function writeReportAudit({ historyPath, reportsRoot, outputPath }) {
  const history = JSON.parse(await fs.readFile(historyPath, "utf8"));
  const audit = await buildReportAudit({ history, reportsRoot });
  await fs.writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  return audit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  await writeReportAudit({
    historyPath: path.join(repoRoot, "public", "data", "history.json"),
    reportsRoot: path.join(repoRoot, "public", "reports"),
    outputPath: path.join(repoRoot, "public", "data", "report-audit.json"),
  });
}
