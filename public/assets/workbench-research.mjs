const STAGE_IDS = Object.freeze(["analysts", "debate", "trader", "risk"]);

export function buildArchiveEntries(history) {
  if (!Array.isArray(history)) return [];
  return history
    .flatMap((batch) => (Array.isArray(batch?.results) ? batch.results : [])
      .filter((result) => result && result.error !== true && result.report)
      .map((result) => ({
        ticker: String(result.ticker || ""),
        rating: String(result.rating || ""),
        report: String(result.report),
        tradeDate: batch.trade_date || null,
        generatedAt: batch.generated_at || null,
        provider: batch.provider || null,
      })))
    .sort((left, right) => String(right.generatedAt || right.tradeDate || "")
      .localeCompare(String(left.generatedAt || left.tradeDate || "")));
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

export function latestResearchRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter((run) => run?.created_at && !Number.isNaN(new Date(run.created_at).valueOf()))
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0] || null;
}
