export const FUND_FLOW_START_DATE = "2024-01-01";
export const FUND_FLOW_MIN_SAMPLE = 60;
export const FUND_FLOW_CHART_POINTS = 60;
const SHARE_SPLIT_THRESHOLD = 0.35;

const SHARE_TYPES_BY_SYMBOL = Object.freeze({
  "515880.SS": Object.freeze([
    "shares_outstanding_derived",
    "shares_outstanding_snapshot",
  ]),
  "512480.SS": Object.freeze([
    "shares_outstanding_derived",
    "shares_outstanding_snapshot",
  ]),
  "159995.SZ": Object.freeze(["shares_outstanding_snapshot"]),
});

const SHANGHAI_DATE = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const SHANGHAI_DATE_TIME = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "margin-balance",
    label: "融资余额",
    flowType: "margin_balance",
    capability: "marginDaily",
    signed: false,
  }),
  Object.freeze({
    id: "margin-net-buy",
    label: "融资净买入",
    flowType: "margin_net_buy",
    capability: "marginDaily",
    signed: true,
  }),
  Object.freeze({
    id: "etf-shares",
    label: "ETF 份额",
    flowType: "shares",
    capability: "etfSharesDaily",
    signed: false,
  }),
]);

function finiteValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formattedParts(formatter, value, includeTime = false) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, part]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return includeTime ? `${day} ${parts.hour}:${parts.minute}:${parts.second}` : day;
}

export function fundFlowTradingDate(value) {
  return formattedParts(SHANGHAI_DATE, value);
}

function fundFlowFetchedAt(value) {
  return formattedParts(SHANGHAI_DATE_TIME, value, true) || "—";
}

export function isFundFlowUiEnabled(value) {
  return value === "true";
}

export function fundFlowRequestTypes(symbol) {
  const shareTypes = SHARE_TYPES_BY_SYMBOL[String(symbol || "").toUpperCase()];
  return shareTypes
    ? ["margin_balance", "margin_net_buy", ...shareTypes]
    : [];
}

export function computeHistoricalPercentile(values, { minSample = FUND_FLOW_MIN_SAMPLE } = {}) {
  const available = Array.isArray(values) ? values : [];
  if (available.length === 0) {
    return { status: "unavailable", value: null, sampleSize: 0 };
  }
  const current = finiteValue(available.at(-1));
  const history = available.slice(0, -1)
    .map(finiteValue)
    .filter((value) => value !== null);
  if (current === null) {
    return { status: "unavailable", value: null, sampleSize: history.length };
  }
  if (history.length < minSample) {
    return { status: "accumulating", value: null, sampleSize: history.length };
  }
  const less = history.filter((value) => value < current).length;
  const equal = history.filter((value) => value === current).length;
  return {
    status: "ready",
    value: Math.round(100 * (less + 0.5 * equal) / history.length),
    sampleSize: history.length,
  };
}

export function formatFundFlowValue(value, unit, { signed = false } = {}) {
  const number = finiteValue(value);
  if (number === null) return "—";
  const sign = signed && number > 0 ? "+" : "";
  const suffix = unit === "shares" ? "份" : "";
  const absolute = Math.abs(number);
  if (unit === "shares" && absolute >= 1e6) {
    return `${sign}${(number / 1e8).toFixed(1)}亿份`;
  }
  if (unit === "shares" && absolute >= 1e4) {
    return `${sign}${(number / 1e4).toFixed(1)}万份`;
  }
  if (unit === "shares") {
    return `${sign}${number.toFixed(1)}份`;
  }
  if (absolute >= 1e8) return `${sign}${(number / 1e8).toFixed(2)}亿${suffix}`;
  if (absolute >= 1e4) return `${sign}${(number / 1e4).toFixed(2)}万${suffix}`;
  return `${sign}${number.toFixed(2)}${suffix}`;
}

function metricRows(data, flowType, symbol) {
  const rows = (Array.isArray(data) ? data : [])
    .filter((row) => {
      const tradingDate = fundFlowTradingDate(row?.ts);
      return tradingDate !== null && tradingDate >= FUND_FLOW_START_DATE;
    });
  const sortRows = (items) => items.sort(
    (left, right) => new Date(left.ts).valueOf() - new Date(right.ts).valueOf(),
  );
  if (flowType !== "shares") {
    return sortRows(rows.filter((row) => row?.flow_type === flowType));
  }
  for (const requestedType of SHARE_TYPES_BY_SYMBOL[String(symbol || "").toUpperCase()] || []) {
    const matching = rows.filter((row) => row?.flow_type === requestedType);
    if (matching.length) return sortRows(matching);
  }
  return [];
}

function latestRowsByTradingDate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const date = fundFlowTradingDate(row?.ts);
    if (!date) continue;
    const previous = byDate.get(date);
    if (!previous || String(row?.fetched_at || "") >= String(previous?.fetched_at || "")) {
      byDate.set(date, row);
    }
  }
  return [...byDate.values()].sort(
    (left, right) => new Date(left.ts).valueOf() - new Date(right.ts).valueOf(),
  );
}

export function shareChangeRows(rows, { splitThreshold = SHARE_SPLIT_THRESHOLD } = {}) {
  const ordered = latestRowsByTradingDate(Array.isArray(rows) ? rows : []);
  const changes = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = finiteValue(ordered[index - 1]?.value);
    const current = finiteValue(ordered[index]?.value);
    if (previous === null || current === null || previous <= 0) {
      changes.push({
        ...ordered[index],
        value: null,
        excludedReason: "unavailable_observation",
      });
      continue;
    }
    const ratio = current / previous - 1;
    changes.push({
      ...ordered[index],
      value: Math.abs(ratio) > splitThreshold ? null : current - previous,
      excludedReason: Math.abs(ratio) > splitThreshold ? "possible_split_or_method_change" : null,
    });
  }
  return changes;
}

function seriesRows(definition, rows) {
  return definition.flowType === "shares" ? shareChangeRows(rows) : rows;
}

function percentileSeries(rows) {
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const percentile = computeHistoricalPercentile(
      rows.slice(0, index + 1).map(({ value }) => value),
    );
    if (percentile.status !== "ready") continue;
    result.push({
      date: fundFlowTradingDate(rows[index]?.ts),
      value: percentile.value,
    });
  }
  return result.filter(({ date }) => date).slice(-FUND_FLOW_CHART_POINTS);
}

function median(values) {
  const sorted = values.map(finiteValue).filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function comparisonText(definition, rows, currentValue) {
  if (currentValue === null) return "当期值不可用";
  if (definition.flowType === "shares") {
    return `较上一有效观测日 ${formatFundFlowValue(currentValue, "shares", { signed: true })}`;
  }
  const history = rows.slice(0, -1)
    .map(({ value }) => finiteValue(value))
    .filter((value) => value !== null)
    .slice(-20);
  if (history.length < 20) return `20日中位累积中 ${history.length}/20`;
  const baseline = median(history);
  if (baseline === null) return "20日中位不可用";
  if (definition.flowType === "margin_net_buy") {
    return `较20日中位 ${formatFundFlowValue(currentValue - baseline, "CNY", { signed: true })}`;
  }
  if (baseline === 0) return "20日中位为 0";
  const difference = (currentValue / baseline - 1) * 100;
  return `较20日中位 ${difference >= 0 ? "+" : ""}${difference.toFixed(1)}%`;
}

export function fundFlowBehavior(flowType, percentile, value) {
  const current = finiteValue(value);
  if (current === null) return "当期数据不可用";
  if (percentile?.status === "accumulating") return "历史样本累积中";
  if (percentile?.status !== "ready") return "历史分位不可用";
  const rank = percentile.value;
  if (flowType === "margin_balance") {
    if (rank >= 95) return "杠杆存量处于极高位";
    if (rank >= 85) return "杠杆存量处于高位";
    if (rank <= 5) return "杠杆存量处于极低位";
    if (rank <= 15) return "杠杆存量处于低位";
    return "杠杆存量处于常态区间";
  }
  const shareMetric = flowType === "shares";
  const subject = shareMetric ? "ETF份额" : "融资";
  if (current === 0) return `${subject}净变化持平`;
  if (current > 0) {
    const direction = shareMetric ? "净增加" : "净流入";
    if (rank >= 95) return `${subject}${direction}显著偏高`;
    if (rank >= 85) return `${subject}${direction}偏高`;
    if (rank <= 15) return `${subject}${direction}但处于低位`;
    return `${subject}${direction}处于常态区间`;
  }
  const direction = shareMetric ? "净减少" : "净流出";
  if (rank <= 5) return `${subject}${direction}显著偏低`;
  if (rank <= 15) return `${subject}${direction}偏低`;
  if (rank >= 85) return `${subject}${direction}但处于高位`;
  return `${subject}${direction}处于常态区间`;
}

function percentileLabel(percentile) {
  if (percentile.status === "ready") return `P${percentile.value}`;
  if (percentile.status === "accumulating") {
    return `累积中 ${percentile.sampleSize}/${FUND_FLOW_MIN_SAMPLE}`;
  }
  return "分位不可用";
}

function metricTooltip(definition, current, percentile, { percentileBasis = definition.label } = {}) {
  const sample = percentile.status === "ready"
    ? `历史分位 P${percentile.value}，有效样本 n=${percentile.sampleSize}`
    : percentile.status === "accumulating"
      ? `历史样本累积中 ${percentile.sampleSize}/${FUND_FLOW_MIN_SAMPLE}`
      : "历史分位不可用";
  return [
    definition.label,
    `数据日 ${fundFlowTradingDate(current?.as_of || current?.ts) || "—"}`,
    `来源 ${current?.source || "—"}`,
    `method ${current?.method || "—"}`,
    `quality ${current?.quality || "—"} · freshness ${current?.freshness || "—"}`,
    `抓取时间 ${fundFlowFetchedAt(current?.fetched_at)}`,
    current?.flow_type === "shares_outstanding_derived"
      ? "上交所规模÷东财同日未复权收盘价推导，非登记份额"
      : current?.flow_type === "shares_outstanding_snapshot"
        ? "无来源时间戳；快照仅记录抓取时间"
        : null,
    `${percentileBasis}：${sample}`,
    `口径自 ${FUND_FLOW_START_DATE} 起，当前值不计入样本，使用 mid-rank 处理并列值`,
  ].filter(Boolean).join(" · ");
}

function buildMetric(definition, data, capabilities, symbol) {
  const rows = metricRows(data, definition.flowType, symbol);
  const current = rows.at(-1) || null;
  const value = finiteValue(current?.value);
  const analysisRows = seriesRows(definition, rows);
  const analysisValue = finiteValue(analysisRows.at(-1)?.value);
  const percentile = capabilities?.historicalPercentile
    ? computeHistoricalPercentile(analysisRows.map((row) => row.value))
    : { status: "unavailable", value: null, sampleSize: 0 };
  const percentileBasis = definition.flowType === "shares" ? "日度份额变化" : definition.label;
  return {
    id: definition.id,
    label: definition.label,
    value,
    unit: current?.unit || (definition.flowType === "shares" ? "shares" : "CNY"),
    signed: definition.signed,
    analysisValue,
    behavior: fundFlowBehavior(definition.flowType, percentile, analysisValue),
    comparison: comparisonText(definition, analysisRows, analysisValue),
    series: analysisRows.slice(-FUND_FLOW_CHART_POINTS).map((row) => ({
      date: fundFlowTradingDate(row?.ts),
      value: finiteValue(row?.value),
    })),
    percentileSeries: percentileSeries(analysisRows),
    asOf: current?.as_of || current?.ts || null,
    tradingDate: fundFlowTradingDate(current?.as_of || current?.ts),
    source: current?.source || null,
    freshness: current?.freshness || null,
    displayValue: formatFundFlowValue(
      value,
      current?.unit || (definition.flowType === "shares" ? "shares" : "CNY"),
      { signed: definition.signed },
    ),
    percentile: {
      ...percentile,
      label: percentileLabel(percentile),
      tone: percentile.status === "ready" && (percentile.value <= 10 || percentile.value >= 90)
        ? "is-extreme"
        : "is-neutral",
    },
    tooltip: metricTooltip(definition, current, percentile, { percentileBasis }),
  };
}

function finiteChange(value) {
  const number = finiteValue(value);
  return number === null ? null : number;
}

function changePhrase(label, value) {
  const number = finiteChange(value);
  if (number === null) return `${label}涨跌暂缺`;
  if (number === 0) return `${label}持平`;
  return `${label}${number >= 0 ? "上涨" : "下跌"}${Math.abs(number).toFixed(2)}%`;
}

function flowDirection(metric) {
  if (!metric || metric.percentile?.status !== "ready" || metric.analysisValue === null) return "unknown";
  if (metric.analysisValue > 0) return "in";
  if (metric.analysisValue < 0) return "out";
  return "flat";
}

export function marketPercentageChange(currentValue, previousValue) {
  if (currentValue === null || currentValue === undefined || currentValue === ""
    || previousValue === null || previousValue === undefined || previousValue === "") return null;
  const current = Number(currentValue);
  const previous = Number(previousValue);
  return Number.isFinite(current) && Number.isFinite(previous) && previous !== 0
    ? (current / previous - 1) * 100
    : null;
}

export function selectFundFlowEventAnchors(feeds, symbol, dates, { limit = 3 } = {}) {
  const available = new Set((Array.isArray(dates) ? dates : []).filter(Boolean));
  if (!available.size) return [];
  return (Array.isArray(feeds) ? feeds : [])
    .filter((item) => {
      const symbols = new Set([item?.symbol, ...(item?.symbols || [])].filter(Boolean));
      const evidenceNews = item?.type === "news" && (item?.source_tier || item?.sourceTier) === "evidence";
      return symbols.has(symbol) && (item?.type === "event" || evidenceNews);
    })
    .map((item) => ({
      date: fundFlowTradingDate(item?.at || item?.event_at || item?.published_at || item?.as_of),
      title: String(item?.title || "事件时间锚").trim().slice(0, 80),
      type: item?.type === "event" ? "event" : "evidence",
    }))
    .filter(({ date }) => available.has(date))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, limit)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function buildFundFlowNarrative(view, {
  symbol = "ETF",
  etfChange = null,
  driverSymbol = "SOXX",
  driverChange = null,
  anchors = [],
} = {}) {
  if (!view?.enabled) return "资金行为数据暂不可用。";
  const margin = view.metrics.find(({ id }) => id === "margin-net-buy");
  const shares = view.metrics.find(({ id }) => id === "etf-shares");
  const marginDirection = flowDirection(margin);
  const shareDirection = flowDirection(shares);
  const bothComparable = marginDirection !== "unknown" && shareDirection !== "unknown";
  let conclusion = "两类资金数据尚不足以比较";
  if (bothComparable && marginDirection === shareDirection) {
    conclusion = marginDirection === "flat"
      ? "融资净买入与ETF份额增量同期持平"
      : "融资净买入与ETF份额增量同期同向";
  } else if (bothComparable && (marginDirection === "flat" || shareDirection === "flat")) {
    conclusion = "两类资金同期未形成一致方向";
  } else if (bothComparable) {
    conclusion = "融资净买入与ETF份额增量同期分化";
  } else if (marginDirection !== "unknown" || shareDirection !== "unknown") {
    conclusion = "仅一类资金具备可比分位";
  }
  const eventNote = anchors.length
    ? `；${anchors.at(-1).date}“${anchors.at(-1).title}”仅作时间锚，不代表因果`
    : "";
  return [
    `${changePhrase(driverSymbol, driverChange)}，${changePhrase(symbol, etfChange)}`,
    `${margin?.behavior || "杠杆资金样本暂缺"}（${margin?.percentile?.label || "分位不可用"}）`,
    `${shares?.behavior || "ETF份额样本暂缺"}（${shares?.percentile?.label || "分位不可用"}）`,
    `${conclusion}${eventNote}。`,
  ].join("；");
}

export function buildFundFlowView(envelope, symbol) {
  const capabilities = envelope?.capabilities || {};
  const supported = fundFlowRequestTypes(symbol).length > 0;
  if (!supported || capabilities.marketFlowV1 !== true) {
    return {
      enabled: false,
      status: "unavailable",
      asOf: null,
      metrics: [],
    };
  }
  const metrics = METRIC_DEFINITIONS
    .filter(({ capability }) => capabilities[capability] === true)
    .map((definition) => buildMetric(definition, envelope?.data, capabilities, symbol));
  return {
    enabled: metrics.length > 0,
    status: envelope?.status || "unavailable",
    asOf: metrics.map(({ asOf }) => asOf).filter(Boolean).sort().at(-1) || null,
    metrics,
    comparisonSeries: [
      {
        id: "leveraged",
        label: "杠杆资金",
        points: metrics.find(({ id }) => id === "margin-net-buy")?.percentileSeries || [],
      },
      {
        id: "allocation",
        label: "申赎资金（份额代理）",
        points: metrics.find(({ id }) => id === "etf-shares")?.percentileSeries || [],
      },
    ],
  };
}
