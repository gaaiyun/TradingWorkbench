import { US_INTRADAY_SYMBOLS } from "./scheduler.mjs";

const US_INTRADAY_SET = new Set(US_INTRADAY_SYMBOLS);
const INTRADAY_BAR_LIMIT = 96;
const DAILY_BACKFILL_BAR_LIMIT = 1500;
// A scheduled close snapshot only needs a small overlap to refresh the latest
// bars. Full history is reserved for bootstrap/recovery backfills; rewriting
// hundreds of rows on every 5-minute Worker tick needlessly burns CPU.
const DAILY_INCREMENTAL_BAR_LIMIT = 40;

function targetsForTask(profile, taskType, targetSymbols = null) {
  const selected = Array.isArray(targetSymbols)
    ? new Set(targetSymbols)
    : null;
  const eligible = (target) => !selected || selected.has(target.symbol);
  if (taskType === "usCloseSnapshot") {
    return profile.targets.filter((target) =>
      eligible(target) &&
      ["US", "HK"].includes(target.market) &&
      target.role === "driver");
  }
  if (taskType === "usIntradayCollect") {
    return profile.targets.filter((target) =>
      eligible(target) &&
      target.market === "US" &&
      target.role === "driver" &&
      US_INTRADAY_SET.has(target.symbol));
  }
  if (taskType === "intradayCollect" || taskType === "cnDailySnapshot") {
    return profile.targets.filter((target) =>
      eligible(target) &&
      target.market === "CN" &&
      (target.role === "core" || target.role === "comparison"));
  }
  return [];
}

function sourceTrail(result) {
  if (Array.isArray(result?.sources)) return result.sources;
  return [];
}

export async function collectForTask({
  taskType,
  task,
  profile,
  registry,
  writeBars,
  db,
  now,
}) {
  const timeframe = taskType === "usCloseSnapshot" || taskType === "cnDailySnapshot"
    ? "1d"
    : "5m";
  const isDailyBackfill = timeframe === "1d" &&
    (Boolean(task?.bootstrapRequirements?.length)
      || String(task?.schedule || "").startsWith("manual/"));
  const limit = timeframe === "1d"
    ? (isDailyBackfill ? DAILY_BACKFILL_BAR_LIMIT : DAILY_INCREMENTAL_BAR_LIMIT)
    : INTRADAY_BAR_LIMIT;
  const targets = targetsForTask(profile, taskType, task?.targetSymbols);
  if (targets.length === 0) {
    return {
      status: "deferred",
      errorCode: "NO_ELIGIBLE_TARGETS",
      written: 0,
      counts: { targets: 0, succeeded: 0, failed: 0 },
      sources: [],
    };
  }

  let succeeded = 0;
  let failed = 0;
  let written = 0;
  const sources = [];
  for (const target of targets) {
    try {
      const result = await registry.fetchMarketData({
        symbol: target.symbol,
        market: target.market,
        timeframe,
        limit,
      });
      sources.push(...sourceTrail(result));
      if (
        result.status === "unavailable" ||
        !Array.isArray(result.bars) ||
        result.bars.length === 0
      ) {
        failed += 1;
        continue;
      }
      const bars = result.bars.slice(-limit);
      await writeBars(db, {
        profileId: profile.id,
        bars,
        now,
      });
      succeeded += 1;
      written += bars.length;
    } catch {
      failed += 1;
      sources.push({
        source: "registry",
        status: "failed",
        reason: "COLLECTION_ERROR",
      });
    }
  }

  const counts = { targets: targets.length, succeeded, failed };
  if (succeeded === 0) {
    return {
      status: "failed",
      errorCode: "COLLECTION_UNAVAILABLE",
      written,
      counts,
      sources,
    };
  }
  return {
    status: failed === 0 ? "completed" : "degraded",
    ...(failed === 0 ? {} : { errorCode: "COLLECTION_PARTIAL" }),
    written,
    counts,
    sources,
  };
}
