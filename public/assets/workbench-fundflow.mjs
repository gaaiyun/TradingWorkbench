export const FUND_FLOW_START_DATE = "2024-01-01";
export const FUND_FLOW_MIN_SAMPLE = 60;

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

function percentileLabel(percentile) {
  if (percentile.status === "ready") return `P${percentile.value}`;
  if (percentile.status === "accumulating") {
    return `累积中 ${percentile.sampleSize}/${FUND_FLOW_MIN_SAMPLE}`;
  }
  return "分位不可用";
}

function metricTooltip(definition, current, percentile) {
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
    `${sample}`,
    `口径自 ${FUND_FLOW_START_DATE} 起，当前值不计入样本，使用 mid-rank 处理并列值`,
  ].filter(Boolean).join(" · ");
}

function buildMetric(definition, data, capabilities, symbol) {
  const rows = metricRows(data, definition.flowType, symbol);
  const current = rows.at(-1) || null;
  const value = finiteValue(current?.value);
  const percentile = capabilities?.historicalPercentile
    ? computeHistoricalPercentile(rows.map((row) => row.value))
    : { status: "unavailable", value: null, sampleSize: 0 };
  return {
    id: definition.id,
    label: definition.label,
    value,
    unit: current?.unit || (definition.flowType === "shares" ? "shares" : "CNY"),
    signed: definition.signed,
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
    tooltip: metricTooltip(definition, current, percentile),
  };
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
  };
}
