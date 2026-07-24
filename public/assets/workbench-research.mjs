const STAGE_IDS = Object.freeze(["analysts", "debate", "trader", "risk"]);

function auditMap(auditIndex) {
  return new Map(
    (Array.isArray(auditIndex?.reports) ? auditIndex.reports : [])
      .filter((entry) => entry?.report)
      .map((entry) => [String(entry.report), entry]),
  );
}

export function buildArchiveEntries(history, auditIndex = null, { includeInvalidated = false } = {}) {
  if (!Array.isArray(history)) return [];
  const audits = auditMap(auditIndex);
  return history
    .flatMap((batch) => (Array.isArray(batch?.results) ? batch.results : [])
      .filter((result) => result && result.error !== true && result.report)
      .map((result) => {
        const report = String(result.report);
        const audit = audits.get(report) || null;
        return {
          ticker: String(result.ticker || ""),
          rating: String(result.rating || ""),
          report,
          tradeDate: batch.trade_date || null,
          generatedAt: batch.generated_at || null,
          provider: batch.provider || null,
          auditStatus: audit?.auditStatus || "unverified",
          problemCodes: Array.isArray(audit?.problemCodes) ? audit.problemCodes : [],
        };
      })
      .filter((entry) => includeInvalidated || !["invalidated", "invalid_record"].includes(entry.auditStatus)))
    .sort((left, right) => String(right.generatedAt || right.tradeDate || "")
      .localeCompare(String(left.generatedAt || left.tradeDate || "")));
}

export function filterAuditedResults(results, auditIndex, { includeInvalidated = false } = {}) {
  const audits = auditMap(auditIndex);
  return (Array.isArray(results) ? results : [])
    .filter((result) => result && result.error !== true && result.report)
    .map((result) => ({ ...result, audit: audits.get(String(result.report)) || null }))
    .filter(({ audit }) => includeInvalidated || !["invalidated", "invalid_record"].includes(audit?.auditStatus));
}

export function buildPipelineStages(run) {
  const stages = STAGE_IDS.map((id) => ({ id, status: "pending" }));
  if (!run) return stages;
  if (run.status === "queued") {
    stages[0].status = "queued";
    return stages;
  }
  if (run.status === "in_progress") {
    stages[0].status = "running";
    return stages;
  }
  if (run.status !== "completed") return stages;
  if (run.conclusion === "success") {
    return stages.map((stage) => ({ ...stage, status: "completed" }));
  }
  stages[0].status = "failed";
  for (let index = 1; index < stages.length; index += 1) stages[index].status = "unknown";
  return stages;
}

export function archivedResearchAfterRun(run, latest) {
  if (run?.status !== "completed" || run?.conclusion !== "failure") return false;
  const runAt = new Date(run.created_at).valueOf();
  const generatedAt = new Date(latest?.generated_at).valueOf();
  const hasReport = Array.isArray(latest?.results) && latest.results.some(
    (result) => result?.error !== true && result?.report,
  );
  return Number.isFinite(runAt) &&
    Number.isFinite(generatedAt) &&
    generatedAt >= runAt &&
    hasReport;
}

export function latestResearchRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter((run) => run?.created_at && !Number.isNaN(new Date(run.created_at).valueOf()))
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0] || null;
}
