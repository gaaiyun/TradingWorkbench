import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INVALIDATED_REPORTS = new Set([
  "515880.SS|2026-07-24",
  "512480.SS|2026-07-23",
  "512480.SS|2026-07-24",
]);

const ETF_SYMBOLS = new Set(["510050.SS", "512480.SS", "515880.SS", "SPY"]);
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const CLAIM_CITATION_RE = /(?:\[(?:evidence|e)-?\d+\]|\b(?:evidence|e)-?\d+\b|证据(?:编号|ID)\s*[:：]?\s*\d+)/gi;
const TARGET_RE = /\*\*(?:Price Target|Target Price|目标价)\*\*\s*[:：]/gi;
const VALUATION_RE = /(?:DCF|discounted cash flow|估值方法|情景分析|valuation method|multiple|倍数|概率)/gi;
const FINAL_PROPOSAL_RE = /FINAL TRANSACTION PROPOSAL/gi;
const PUBLISHED_RE = /(?:published|发布时间|发布日期|published_at|发表时间)/gi;

function keyFor(ticker, tradeDate) {
  return `${ticker}|${tradeDate}`;
}

function problemCodesFor({ ticker, tradeDate, error, report, text, evidence }) {
  const codes = [];
  if (error || !report) codes.push("INVALID_TICKER_INPUT");
  if (!report) return codes;
  if (!text) codes.push("REPORT_MISSING");
  if (INVALIDATED_REPORTS.has(keyFor(ticker, tradeDate))) {
    codes.push("CORPORATE_ACTION_CONTAMINATION");
  }
  if (ETF_SYMBOLS.has(ticker)) codes.push("ETF_TEMPLATE_MISMATCH");
  if (evidence.claimCitationCount === 0 || evidence.urlCount === 0) {
    codes.push("MISSING_CLAIM_EVIDENCE");
  }
  if (evidence.finalProposalMarkers > 1) codes.push("DUPLICATE_FINAL_PROPOSAL");
  if (evidence.priceTargetCount > 0 && evidence.valuationMethodCount === 0) {
    codes.push("UNSUPPORTED_PRICE_TARGET");
  }
  if (evidence.publishedMarkerCount === 0) codes.push("MISSING_PUBLICATION_TIME");
  return [...new Set(codes)];
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

async function readReport(reportsRoot, report) {
  if (!report) return "";
  const relative = report.replace(/^reports[\\/]/, "").split(/[\\/]/g);
  try {
    return await fs.readFile(path.join(reportsRoot, ...relative), "utf8");
  } catch {
    return "";
  }
}

export async function buildReportAudit({ history, reportsRoot }) {
  const entries = [];
  for (const batch of Array.isArray(history) ? history : []) {
    for (const result of Array.isArray(batch?.results) ? batch.results : []) {
      const ticker = String(result?.ticker || "");
      const tradeDate = String(batch?.trade_date || "");
      const report = result?.report ? String(result.report) : null;
      const text = await readReport(reportsRoot, report);
      const evidence = parseEvidence(text);
      const error = result?.error === true;
      const problemCodes = problemCodesFor({
        ticker,
        tradeDate,
        error,
        report,
        text,
        evidence,
      });
      const auditStatus = error || !report
        ? "invalid_record"
        : INVALIDATED_REPORTS.has(keyFor(ticker, tradeDate))
          ? "invalidated"
          : "legacy_unverified";
      entries.push({
        ticker,
        tradeDate,
        generatedAt: batch?.generated_at || null,
        provider: batch?.provider || null,
        rating: result?.rating || null,
        report,
        auditStatus,
        problemCodes,
        evidence,
        supersededBy: null,
      });
    }
  }

  entries.sort((left, right) => String(right.generatedAt || right.tradeDate)
    .localeCompare(String(left.generatedAt || left.tradeDate)));
  const summary = {
    successfulReports: entries.filter((entry) => entry.auditStatus !== "invalid_record").length,
    invalidatedReports: entries.filter((entry) => entry.auditStatus === "invalidated").length,
    legacyUnverifiedReports: entries.filter((entry) => entry.auditStatus === "legacy_unverified").length,
    invalidRecords: entries.filter((entry) => entry.auditStatus === "invalid_record").length,
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
