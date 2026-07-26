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

const Z90 = 1.2815515655446004;
const Z95 = 1.6448536269514722;
const Z99 = 2.3263478740408408;

function canonicalOptionType(value) {
  const type = String(value || "").toLowerCase();
  if (type === "put" || type.includes("认沽") || type.includes("看跌")) return "put";
  if (type === "call" || type.includes("认购") || type.includes("看涨")) return "call";
  return "";
}

function tradingDaysUntil(expiry, asOf) {
  if (!expiry) return null;
  const end = new Date(`${String(expiry).slice(0, 10)}T15:00:00+08:00`);
  const start = new Date(asOf || Date.now());
  if (!Number.isFinite(end.getTime()) || !Number.isFinite(start.getTime()) || end <= start) return null;
  const cursor = new Date(start);
  let days = 0;
  while (cursor < end && days < 1000) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return Math.max(1, days);
}

function oneDayTailQuantiles(risk) {
  const var95 = finite(risk?.var95);
  const var99 = finite(risk?.var99);
  const hv30 = finite(risk?.hv30);
  let q99 = var99 > 0 ? var99 : null;
  let q95 = var95 > 0 ? var95 : null;
  let source = "GARCH/历史 VaR";
  if (q99 === null && hv30 > 0) {
    const sigma = hv30 / Math.sqrt(252);
    q99 = sigma * Z99;
    source = "HV30 正态近似（估计）";
  }
  if (q95 === null && q99 !== null) q95 = q99 * Z95 / Z99;
  const q90 = q95 !== null
    ? q95 * Z90 / Z95
    : q99 !== null ? q99 * Z90 / Z99 : null;
  if (q90 === null || q99 === null || q90 <= 0 || q99 <= 0) return null;
  return { q90, q99, source, horizon: "1 trading day" };
}

function outOfMoneyPct(row, spot) {
  if (!Number.isFinite(spot) || !Number.isFinite(row?.strike)) return null;
  const type = canonicalOptionType(row.type);
  if (type === "put" && row.strike < spot) return ((spot - row.strike) / spot) * 100;
  if (type === "call" && row.strike > spot) return ((row.strike - spot) / spot) * 100;
  return 0;
}

function isLiquid(row) {
  return Number.isFinite(row?.openInterest)
    && Number.isFinite(row?.volume)
    && row.openInterest > 0
    && row.volume >= 0;
}

function selectQuantileCandidate(options, type, spot, thresholdPct, expiry) {
  const candidates = options
    .filter((row) =>
      canonicalOptionType(row.type) === type &&
      row.expiry === expiry &&
      isLiquid(row),
    )
    .map((row) => ({ ...row, otmPct: outOfMoneyPct(row, spot) }))
    .filter((row) => row.otmPct !== null && row.otmPct >= thresholdPct);
  return candidates.sort((left, right) =>
    Math.abs(left.otmPct - thresholdPct) - Math.abs(right.otmPct - thresholdPct)
    || (right.openInterest - left.openInterest)
    || (right.volume - left.volume),
  )[0] || null;
}

export function deriveSellerQuantiles({
  market = {},
  risk = {},
  options = [],
  asOf = null,
} = {}) {
  const base = oneDayTailQuantiles(risk);
  if (!base || !Number.isFinite(market?.spot)) {
    return { status: "insufficient_data", source: null, expiries: [], putTarget: null, callTarget: null };
  }
  const expiries = [...new Set(options.map((row) => row.expiry).filter(Boolean))]
    .sort()
    .map((expiry) => {
      const dte = tradingDaysUntil(expiry, asOf);
      if (!dte) return null;
      const scale = Math.sqrt(dte);
      const q90 = base.q90 * scale;
      const q99 = base.q99 * scale;
      return {
        expiry,
        tradingDays: dte,
        cautionPct: q90,
        targetPct: q99,
        putCautionStrike: market.spot * Math.exp(-q90 / 100),
        callCautionStrike: market.spot * Math.exp(q90 / 100),
        putTargetStrike: market.spot * Math.exp(-q99 / 100),
        callTargetStrike: market.spot * Math.exp(q99 / 100),
        putCaution: selectQuantileCandidate(options, "put", market.spot, q90, expiry),
        callCaution: selectQuantileCandidate(options, "call", market.spot, q90, expiry),
        putTarget: selectQuantileCandidate(options, "put", market.spot, q99, expiry),
        callTarget: selectQuantileCandidate(options, "call", market.spot, q99, expiry),
      };
    })
    .filter(Boolean);
  const front = expiries[0] || null;
  return {
    status: expiries.length ? "ok" : "insufficient_data",
    source: base.source,
    horizon: base.horizon,
    expiries,
    frontExpiry: front?.expiry || null,
    q90OneDayPct: base.q90,
    q99OneDayPct: base.q99,
    putCaution: front?.putCaution || null,
    callCaution: front?.callCaution || null,
    putTarget: front?.putTarget || null,
    callTarget: front?.callTarget || null,
  };
}

function sellerDesk({ market, risk, exposure, options, asOf = null }) {
  const ivHvGap = Number.isFinite(risk.ivAverage) && Number.isFinite(risk.hv30)
    ? risk.ivAverage - risk.hv30
    : null;
  const hasGreeks = options.some((row) =>
    Number.isFinite(row.delta) &&
    Number.isFinite(row.iv),
  );
  const liquid = isLiquid;
  const choose = (type, deltaMin, deltaMax) => options
    .filter((row) =>
      canonicalOptionType(row.type) === type &&
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
  const quantiles = deriveSellerQuantiles({
    market,
    risk,
    options,
    asOf,
  });
  const warnings = [];
  if (!hasGreeks) warnings.push("合约未提供 IV/Greeks，不能给出可执行的 Delta 档位");
  if (!Number.isFinite(ivHvGap)) warnings.push("IV-HV 差值不可用");
  if (quantiles.status !== "ok") warnings.push("90%/99% 尾部阈值不可用，不能生成分位数候选");
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
      recommendation = quantiles.status === "ok"
        ? "卖方优先观察：IV 高于 HV；低于 90% 尾部阈值认怂，99% 阈值才进入观察"
        : "卖方优先观察：IV 高于 HV，可评估定义风险的价外策略";
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
    quantiles,
    putTarget: quantiles.putTarget,
    callTarget: quantiles.callTarget,
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
  normalized.sellerDesk = sellerDesk({ ...normalized, asOf: normalized.optionsAsOf });
  return normalized;
}
