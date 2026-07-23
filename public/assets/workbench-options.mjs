export const OPTIONS_FAST_REFRESH_MS = 30_000;
export const OPTIONS_SLOW_REFRESH_MS = 5 * 60_000;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function first(source, ...keys) {
  for (const key of keys) {
    if (source?.[key] !== null && source?.[key] !== undefined && source?.[key] !== "") {
      return source[key];
    }
  }
  return null;
}

function normalizeOption(row = {}) {
  return {
    code: String(first(row, "代码", "code", "symbol") || ""),
    name: String(first(row, "名称", "name") || ""),
    type: String(first(row, "类型", "type", "option_type") || ""),
    expiry: first(row, "到期日", "expiry", "expiration"),
    strike: finite(first(row, "行权价", "strike")),
    last: finite(first(row, "最新价", "last", "price")),
    iv: finite(first(row, "隐含波动率", "iv", "implied_volatility")),
    delta: finite(first(row, "Delta", "delta")),
    gamma: finite(first(row, "Gamma", "gamma")),
    vega: finite(first(row, "Vega", "vega")),
    theta: finite(first(row, "Theta", "theta")),
    volume: finite(first(row, "成交量", "volume")),
    openInterest: finite(first(row, "持仓量", "open_interest", "openInterest")),
    bid: finite(first(row, "买入价", "bid")),
    ask: finite(first(row, "卖出价", "ask")),
  };
}

export function normalizeVolguardPayload(payload, {
  mode = "unavailable",
  fallbackReason = "",
} = {}) {
  const edgeLive = Boolean(payload?.source_status && payload?.quick_metrics);
  const sourceState = edgeLive ? String(payload.source_status.overall || "unknown") : mode;
  const sourceAsOf = edgeLive ? payload.source_asof || {} : {};
  const market = edgeLive
    ? {
      symbol: payload?.underlying?.symbol,
      spot: payload?.underlying?.last,
      change_pct: payload?.underlying?.change_pct,
      data_asof: sourceAsOf.underlying,
      options_data_asof: sourceAsOf.options_latest,
      data_status: payload.source_status,
      options_quality: payload.source_status?.options,
    }
    : payload?.market || {};
  const risk = edgeLive ? payload?.slow_metrics?.risk || {} : payload?.risk || {};
  const slowExposure = edgeLive
    ? payload?.slow_metrics?.exposure || {}
    : payload?.exposure || {};
  const quick = edgeLive ? payload?.quick_metrics || {} : {};
  const exposure = edgeLive
    ? {
      ...slowExposure,
      pcr_oi: quick.put_call_oi_ratio,
      pcr_volume: quick.put_call_volume_ratio,
      max_pain: quick.front_max_pain,
      near_expiry: quick.front_expiry,
      median_relative_spread_pct: quick.median_relative_spread_pct,
      active_contract_count: quick.contract_count,
    }
    : slowExposure;
  const rawOptions = edgeLive ? payload?.contracts : payload?.options;
  const options = Array.isArray(rawOptions) ? rawOptions.map(normalizeOption) : [];
  const quality = market.options_quality || {};
  const liveQuality = String(quality.status || quality.freshness || "").toLowerCase();
  const edgeStatus = sourceState === "unavailable"
    ? "unavailable"
    : ["static_only", "delayed"].includes(sourceState)
      ? "stale"
      : ["partial"].includes(sourceState) ? "degraded" : "ok";
  const status = edgeLive
    ? edgeStatus
    : mode === "live"
      ? (["stale", "degraded", "unavailable"].includes(liveQuality) ? liveQuality : "ok")
    : mode === "snapshot" ? "stale" : "unavailable";

  return {
    schemaVersion: finite(payload?.schema_version),
    status,
    mode,
    sourceState,
    marketPhase: edgeLive ? payload.source_status?.market_phase || null : null,
    fallbackReason,
    generatedAt: payload?.quote_generated_at || payload?.generated_at || null,
    quoteAsOf: market.data_asof || payload?.quote_generated_at || payload?.generated_at || null,
    optionsAsOf: market.options_data_asof || market.data_asof || payload?.quote_generated_at || payload?.generated_at || null,
    modelAsOf: sourceAsOf.slow_snapshot || payload?.generated_at || null,
    market: {
      symbol: market.symbol || "510050.SS",
      spot: finite(market.spot),
      changePct: finite(market.change_pct),
      dataStatus: market.data_status || {},
      optionsQuality: quality,
    },
    risk: {
      signal: risk.signal || "",
      action: risk.action || "",
      hv30: finite(risk.hv30),
      ivAverage: finite(risk.iv_avg),
      ivMedian: finite(risk.iv_median),
      ivCoveragePct: finite(risk.iv_coverage_pct),
      var95: finite(risk.var_95),
      var95Call: finite(risk.var_95_call),
      var95Put: finite(risk.var_95_put),
      var99: finite(risk.var_99),
      varMethod: risk.var_method || "",
      varQuality: risk.var_quality || "",
      bsadfStat: finite(risk.bsadf_stat),
      bsadfCritical: finite(risk.bsadf_cv),
      bsadfTriggered: Boolean(risk.bsadf_triggered),
    },
    exposure: {
      gex: finite(exposure.gex_net),
      dex: finite(exposure.dex_net),
      pcr: finite(exposure.pcr_oi ?? exposure.pcr_volume),
      pcrOi: finite(exposure.pcr_oi),
      pcrVolume: finite(exposure.pcr_volume),
      maxPain: finite(exposure.max_pain),
      skew25d: finite(exposure.iv_skew_25d_pp),
      nearExpiry: exposure.near_expiry || null,
      nearDteDays: finite(exposure.near_dte_days),
      spreadPct: finite(exposure.median_relative_spread_pct),
      coveragePct: finite(exposure.two_sided_coverage_pct),
    },
    contractCount: finite(exposure.active_contract_count) ?? options.length,
    options,
  };
}
