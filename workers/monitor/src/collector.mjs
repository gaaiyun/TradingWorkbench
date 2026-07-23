function targetsForTask(profile, taskType) {
  if (taskType === "usCloseSnapshot") {
    return profile.targets.filter((target) =>
      target.market === "US" && target.role === "driver");
  }
  if (taskType === "intradayCollect") {
    return profile.targets.filter((target) =>
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
  profile,
  registry,
  writeBars,
  db,
  now,
}) {
  const timeframe = taskType === "usCloseSnapshot" ? "1d" : "5m";
  const targets = targetsForTask(profile, taskType);
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
        ...(taskType === "usCloseSnapshot" ? { limit: 1500 } : {}),
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
      await writeBars(db, {
        profileId: profile.id,
        bars: result.bars,
        now,
      });
      succeeded += 1;
      written += result.bars.length;
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
