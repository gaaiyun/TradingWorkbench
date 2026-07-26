import { json, proxyRaw } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
} from "./_run_identity.mjs";

function summarize(reports) {
  return {
    successfulReports: reports.filter((entry) => entry.auditStatus !== "invalid_record").length,
    verifiedReports: reports.filter((entry) => entry.auditStatus === "verified").length,
    invalidatedReports: reports.filter((entry) => entry.auditStatus === "invalidated").length,
    legacyUnverifiedReports: reports.filter((entry) => entry.auditStatus === "legacy_unverified").length,
    invalidRecords: reports.filter((entry) => entry.auditStatus === "invalid_record").length,
    evidenceValidationFailures: reports.filter(
      (entry) => entry.failureClass === "evidence_validation",
    ).length,
    analysisExecutionFailures: reports.filter(
      (entry) => entry.failureClass === "analysis_execution",
    ).length,
    invalidInputs: reports.filter((entry) => entry.failureClass === "invalid_input").length,
  };
}

// GET /api/report-audit → 报告审计索引
// 审计索引是公开的结构化元数据，不包含报告正文或任何密钥。
export async function onRequestGet({ request } = {}) {
  let selectors;
  try {
    selectors = parseRunSelectors(request);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!selectors.hasSelector) {
    return proxyRaw("data/report-audit.json", { cacheSeconds: 60 });
  }
  const response = await proxyRaw("data/report-audit.json", { cacheSeconds: 60 });
  if (!response.ok) return response;
  let audit;
  try {
    audit = await response.json();
  } catch {
    return json({ error: "报告审计索引无效" }, 502);
  }
  if (!audit || !Array.isArray(audit.reports)) {
    return json({ error: "报告审计索引无效" }, 502);
  }
  const reports = audit.reports.filter(
    (entry) => identityMatches(entry?.identity, selectors),
  );
  return json(
    { ...audit, summary: summarize(reports), reports },
    200,
    { "cache-control": "public, max-age=60" },
  );
}
