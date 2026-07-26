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

function sellerDesk({ market, risk, exposure, options }) {
  const ivHvGap = Number.isFinite(risk.ivAverage) && Number.isFinite(risk.hv30)
    ? risk.ivAverage - risk.hv30
    : null;
  const hasGreeks = options.some((row) =>
    Number.isFinite(row.delta) &&
    Number.isFinite(row.iv),
  );
  const liquid = (row) =>
    Number.isFinite(row.openInterest) &&
    Number.isFinite(row.volume) &&
    row.openInterest > 0 &&
    row.volume >= 0;
  const choose = (type, deltaMin, deltaMax) => options
    .filter((row) =>
      row.type === type &&
      liquid(row) &&
      row.strike !== null &&
      (hasGreeks
        ? Number.isFinite(row.delta) &&
          Math.abs(row.delta) >= deltaMin &&
          Math.abs(row.delta) <= deltaMax
        : true),
    )
    .sort((left, right) =>
      (right.openInterest - left.openInterest) ||
      (right.volume - left.volume),
    )[0] || null;
  const put = choose("put", 0.15, 0.3);
  const call = choose("call", 0.15, 0.3);
  const warnings = [];
  if (!hasGreeks) warnings.push("合约未提供 IV/Greeks，不能给出可执行的 Delta 档位");
  if (!Number.isFinite(ivHvGap)) warnings.push("IV-HV 差值不可用");
  if (Number.isFinite(exposure.spreadPct) && exposure.spreadPct > 3) {
    warnings.push("中位买卖价差偏宽，成交质量不足");
  }
  if (Number.isFinite(risk.var95) && risk.var95 >= 4) {
    warnings.push("VaR 较高，卖方尾部风险需要定义风险");
  }
  let status = "insufficient_data";
  let recommendation = "暂不生成卖方方向建议";
  if (Number.isFinite(ivHvGap)) {
    if (ivHvGap >= 3) {
      status = "premium_positive";
      recommendation = "卖方优先观察：IV 高于 HV，可评估定义风险的价外策略";
    } else if (ivHvGap <= -3) {
      status = "premium_negative";
      recommendation = "不宜裸卖：IV 低于 HV，波动率补偿不足";
    } else {
      status = "neutral";
      recommendation = "波动率中性：等待 IV-HV 优势或更清晰的方向信号";
    }
  }
  return {
    status,
    recommendation,
    ivHvGap,
    putCandidate: put,
    callCandidate: call,
    warnings,
    disclaimer: "研究提示，不是自动下单或无保护裸卖指令",
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

  const normalized = {
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
  normalized.sellerDesk = sellerDesk(normalized);
  return normalized;
}
