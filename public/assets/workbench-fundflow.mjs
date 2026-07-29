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

const DRIVER_BASKETS_BY_SYMBOL = Object.freeze({
  "515880.SS": Object.freeze({
    label: "AI通信驱动",
    symbols: Object.freeze(["NVDA", "AVGO"]),
  }),
  "512480.SS": Object.freeze({
    label: "美股半导体基准",
    symbols: Object.freeze(["SOXX", "SMH"]),
  }),
  "159995.SZ": Object.freeze({
    label: "美股半导体基准",
    symbols: Object.freeze(["SOXX", "SMH"]),
  }),
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value);
  return formattedParts(SHANGHAI_DATE, value);
}

function rowTradingDate(row) {
  return fundFlowTradingDate(row?.trade_date || row?.ts);
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
    ? ["margin_balance", "margin_net_buy", "constituent_margin_net_buy", ...shareTypes]
    : [];
}

export function fundFlowDriverBasket(symbol) {
  const basket = DRIVER_BASKETS_BY_SYMBOL[String(symbol || "").toUpperCase()];
  return basket
    ? { label: basket.label, symbols: [...basket.symbols] }
    : { label: "隔夜驱动", symbols: [] };
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
      const tradingDate = rowTradingDate(row);
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
    const date = rowTradingDate(row);
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
      date: rowTradingDate(rows[index]),
      value: percentile.value,
    });
  }
  return result.filter(({ date }) => date).slice(-FUND_FLOW_CHART_POINTS);
}

function rollingSumRows(rows, window = 5) {
  const ordered = latestRowsByTradingDate(Array.isArray(rows) ? rows : []);
  const result = [];
  for (let index = window - 1; index < ordered.length; index += 1) {
    const slice = ordered.slice(index - window + 1, index + 1);
    const values = slice.map(({ value }) => finiteValue(value));
    result.push({
      ...ordered[index],
      value: values.some((value) => value === null)
        ? null
        : values.reduce((total, value) => total + value, 0),
      observationCount: window,
    });
  }
  return result;
}

function constituentApproximation(row) {
  const match = /^latest_disclosed_top_(\d+)_holdings_sum@(\d{4}-\d{2}-\d{2});coverage=(\d+)\/(\d+)$/.exec(
    String(row?.method || ""),
  );
  if (!match) return null;
  return {
    topN: Number(match[1]),
    disclosedAt: match[2],
    covered: Number(match[3]),
    total: Number(match[4]),
    quality: row?.quality || null,
  };
}

function buildFinancingComparison(data, flowType) {
  const rows = latestRowsByTradingDate(metricRows(data, flowType));
  const rollingRows = rollingSumRows(rows, 5);
  const current = rollingRows.at(-1) || null;
  const value = finiteValue(current?.value);
  const percentile = computeHistoricalPercentile(rollingRows.map((row) => row.value));
  return {
    value,
    percentile,
    tradingDate: rowTradingDate(current),
    asOf: current?.as_of || current?.ts || null,
    sourceRow: rows.at(-1) || null,
    points: percentileSeries(rollingRows),
  };
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
  if (current === 0) return shareMetric ? "ETF份额单日净变化持平" : "单日融资净变化持平";
  if (current > 0) {
    if (rank >= 95) return shareMetric ? "ETF份额单日净增加显著" : "单日融资净流入显著";
    if (rank >= 85) return shareMetric ? "ETF份额单日净增加偏强" : "单日融资净流入偏强";
    if (rank <= 15) return shareMetric ? "ETF份额单日净增加但幅度偏小" : "单日融资净流入但幅度偏小";
    return shareMetric ? "ETF份额单日净增加处于常态区间" : "单日融资净流入处于常态区间";
  }
  if (rank <= 5) return shareMetric ? "ETF份额单日净减少显著" : "单日融资净流出显著";
  if (rank <= 15) return shareMetric ? "ETF份额单日净减少偏强" : "单日融资净流出偏强";
  if (rank >= 85) return shareMetric ? "ETF份额单日净减少但幅度偏小" : "单日融资净流出但幅度偏小";
  return shareMetric ? "ETF份额单日净减少处于常态区间" : "单日融资净流出处于常态区间";
}

function percentileLabel(percentile, context = "历史") {
  if (percentile.status === "ready") return `${context} P${percentile.value}`;
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
      `数据日 ${rowTradingDate(current) || "—"}`,
    `来源 ${current?.source || "—"}`,
    `method ${current?.method || "—"}`,
    `quality ${current?.quality || "—"} · freshness ${current?.freshness || "—"}`,
    `抓取时间 ${fundFlowFetchedAt(current?.fetched_at)}`,
    current?.flow_type === "shares_outstanding_derived"
      ? "上交所规模÷东财同日未复权收盘价推导，非登记份额"
      : current?.flow_type === "shares_outstanding_snapshot"
        ? "无来源时间戳；快照仅记录抓取时间；无日频历史时不计算份额变化分位"
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
  const snapshotOnlyShares = definition.flowType === "shares"
    && rows.length > 0
    && rows.every(({ flow_type: flowType }) => flowType === "shares_outstanding_snapshot");
  const percentile = capabilities?.historicalPercentile && !snapshotOnlyShares
    ? computeHistoricalPercentile(analysisRows.map((row) => row.value))
    : { status: "unavailable", value: null, sampleSize: 0 };
  const percentileBasis = definition.flowType === "shares" ? "日度份额变化" : definition.label;
  const percentileContext = definition.flowType === "margin_balance"
    ? "水平"
    : definition.flowType === "shares" ? "单日变化" : "单日";
  return {
    id: definition.id,
    label: snapshotOnlyShares ? `${definition.label}（仅快照）` : definition.label,
    value,
    unit: current?.unit || (definition.flowType === "shares" ? "shares" : "CNY"),
    signed: definition.signed,
    analysisValue,
    behavior: snapshotOnlyShares
      ? "历史份额不可用，仅显示快照"
      : fundFlowBehavior(definition.flowType, percentile, analysisValue),
    comparison: snapshotOnlyShares
      ? "无可比历史"
      : comparisonText(definition, analysisRows, analysisValue),
    series: analysisRows.slice(-FUND_FLOW_CHART_POINTS).map((row) => ({
      date: rowTradingDate(row),
      value: finiteValue(row?.value),
    })),
    percentileSeries: snapshotOnlyShares ? [] : percentileSeries(analysisRows),
    asOf: current?.as_of || current?.ts || null,
    tradingDate: rowTradingDate(current),
    source: current?.source || null,
    freshness: current?.freshness || null,
    displayValue: formatFundFlowValue(
      value,
      current?.unit || (definition.flowType === "shares" ? "shares" : "CNY"),
      { signed: definition.signed },
    ),
    percentile: {
      ...percentile,
      label: percentileLabel(percentile, percentileContext),
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

function changePhrase(label, value, date = null) {
  const number = finiteChange(value);
  const datedLabel = `${label}${date ? `（日线 ${date}）` : ""}`;
  if (number === null) return `${datedLabel}涨跌暂缺`;
  if (number === 0) return `${datedLabel}持平`;
  return `${datedLabel}${number >= 0 ? "上涨" : "下跌"}${Math.abs(number).toFixed(2)}%`;
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
  const unique = new Map();
  for (const anchor of (Array.isArray(feeds) ? feeds : [])
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
    .sort((left, right) => right.date.localeCompare(left.date))) {
    const key = `${anchor.date}\n${anchor.title.toLowerCase().replace(/\s+/g, "")}`;
    if (!unique.has(key)) unique.set(key, anchor);
  }
  return [...unique.values()]
    .slice(0, limit)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function financingComparisonConclusion(etf, constituent) {
  if (etf.value > 0 && constituent.value < 0) return "ETF端净流入、个股端净流出，方向分化";
  if (etf.value < 0 && constituent.value > 0) return "ETF端净流出、个股端净流入，方向分化";
  if (etf.value === 0 && constituent.value === 0) return "两端均持平";
  if (etf.value === 0) return constituent.value > 0
    ? "ETF端持平、个股端净流入"
    : "ETF端持平、个股端净流出";
  if (constituent.value === 0) return etf.value > 0
    ? "ETF端净流入、个股端持平"
    : "ETF端净流出、个股端持平";

  const etfRank = etf.percentile.value;
  const constituentRank = constituent.percentile.value;
  const rankGap = Math.abs(etfRank - constituentRank);
  if (etf.value < 0 && constituent.value < 0) {
    if (etfRank <= 15 && constituentRank <= 15) return "两端显著净流出";
    if (rankGap >= 20) return etfRank < constituentRank
      ? "两端均为净流出，ETF端撤出更明显"
      : "两端均为净流出，个股端撤出更明显";
    if (etfRank <= 40 && constituentRank <= 40) return "两端净流出，均处于历史偏弱区间";
    return "两端均为净流出，力度未达极端";
  }
  if (etfRank >= 85 && constituentRank >= 85) return "两端显著净流入";
  if (rankGap >= 20) return etfRank > constituentRank
    ? "两端均为净流入，ETF端流入更明显"
    : "两端均为净流入，个股端流入更明显";
  if (etfRank >= 60 && constituentRank >= 60) return "两端净流入，均处于历史偏强区间";
  return "两端均为净流入，力度未达极端";
}

export function buildFundFlowNarrative(view, {
  symbol = "ETF",
  etfChange = null,
  etfDate = null,
  driverLabel = "隔夜驱动",
  drivers = [],
  driverSymbol = "SOXX",
  driverChange = null,
  driverDate = null,
  anchors = [],
} = {}) {
  if (!view?.enabled) return "资金行为数据暂不可用。";
  const etf = view.financingComparison?.etf || null;
  const constituent = view.financingComparison?.constituent || null;
  const etfReady = etf?.value !== null && etf?.percentile?.status === "ready";
  const constituentReady = constituent?.value !== null && constituent?.percentile?.status === "ready";
  let conclusion = "ETF端与个股端数据尚不足以比较";
  if (etfReady && constituentReady) {
    conclusion = financingComparisonConclusion(etf, constituent);
  }
  const etfPhrase = etfReady
    ? `ETF自身融资净买入（近5个可用交易日累计）${formatFundFlowValue(etf.value, "CNY", { signed: true })}（P${etf.percentile.value}）`
    : "ETF自身融资净买入近5个可用交易日累计暂不可比";
  const constituentPhrase = constituentReady
    ? `前10大持仓股票融资净买入（近5个可用交易日累计）${formatFundFlowValue(constituent.value, "CNY", { signed: true })}（P${constituent.percentile.value}）`
    : "前10大持仓股票融资净买入近5个可用交易日累计暂不可比";
  const etfTradingDate = etfReady ? etf.tradingDate : null;
  const constituentTradingDate = constituentReady ? constituent.tradingDate : null;
  const datesMatch = etfTradingDate && constituentTradingDate && etfTradingDate === constituentTradingDate;
  const datesDiffer = etfReady && constituentReady && !datesMatch;
  if (datesDiffer) conclusion = "资金日期不一致，暂不可比";
  const dataDateNote = datesMatch
    ? `资金数据截至 ${etfTradingDate}：`
    : etfTradingDate || constituentTradingDate
      ? `资金日期${datesDiffer ? "不一致" : ""}：ETF端截至 ${etfTradingDate || "—"}，个股端截至 ${constituentTradingDate || "—"}：`
      : "";
  const approximation = view.financingComparison?.approximation;
  const approximationNote = approximation
    ? `口径：前${approximation.topN}大持仓近似（披露日 ${approximation.disclosedAt}，覆盖 ${approximation.covered}/${approximation.total}），股票融资净买入为简单合计，不按ETF权重；不代表身份与因果`
    : "口径：成分股篮子为最新披露持仓近似，股票融资净买入为简单合计，不按ETF权重；不代表身份与因果";
  const eventNote = anchors.length
    ? `；${anchors.at(-1).date}“${anchors.at(-1).title}”仅作时间锚，不代表因果`
    : "";
  const driverItems = Array.isArray(drivers) && drivers.length
    ? drivers
    : [{ symbol: driverSymbol, change: driverChange, date: driverDate }];
  const driverContext = driverItems
    .filter(({ symbol: itemSymbol }) => itemSymbol)
    .map(({ symbol: itemSymbol, change, date }) => changePhrase(itemSymbol, change, date));
  const hasMarketContext = driverItems.some(({ change }) => finiteChange(change) !== null)
    || finiteChange(etfChange) !== null;
  const marketContext = hasMarketContext
    ? `${driverLabel}：${driverContext.join("，")}；${changePhrase(symbol, etfChange, etfDate)}；`
    : "";
  return `${marketContext}${dataDateNote}${etfPhrase}；${constituentPhrase}——${conclusion}；${approximationNote}${eventNote}。`;
}

export function buildFundFlowThemeObservation(view, { symbol = "ETF" } = {}) {
  if (!view?.enabled) return null;
  const etf = view.financingComparison?.etf;
  const constituent = view.financingComparison?.constituent;
  const ready = etf?.value !== null
    && constituent?.value !== null
    && etf?.percentile?.status === "ready"
    && constituent?.percentile?.status === "ready"
    && etf.tradingDate
    && etf.tradingDate === constituent.tradingDate;
  if (!ready) return null;
  const conclusion = financingComparisonConclusion(etf, constituent);
  const bothNegative = etf.value < 0 && constituent.value < 0;
  const bothPositive = etf.value > 0 && constituent.value > 0;
  return {
    label: bothNegative ? "资金偏弱" : bothPositive ? "资金偏强" : "方向分化",
    tone: bothNegative ? "market-down" : bothPositive ? "market-up" : "neutral",
    asOf: etf.tradingDate,
    text: `${symbol} 近5个可用交易日：ETF端 ${formatFundFlowValue(etf.value, "CNY", { signed: true })}（P${etf.percentile.value}），前10大持仓端 ${formatFundFlowValue(constituent.value, "CNY", { signed: true })}（P${constituent.percentile.value}）；${conclusion}。这是可复核的资金规则观察，不替代通过 Evidence 门禁的研究报告，也不构成投资建议。`,
  };
}

export function buildFundFlowView(envelope, symbol) {
  const capabilities = envelope?.capabilities || {};
  const supported = fundFlowRequestTypes(symbol).length > 0;
  if (!supported || capabilities.marketFlowV1 !== true) {
    return {
      symbol: String(symbol || "").toUpperCase() || null,
      enabled: false,
      status: "unavailable",
      asOf: null,
      metrics: [],
    };
  }
  const metrics = METRIC_DEFINITIONS
    .filter(({ capability }) => capabilities[capability] === true)
    .map((definition) => buildMetric(definition, envelope?.data, capabilities, symbol));
  const etfComparison = buildFinancingComparison(envelope?.data, "margin_net_buy");
  const constituentComparison = capabilities.constituentMarginDaily === true
    ? buildFinancingComparison(envelope?.data, "constituent_margin_net_buy")
    : { value: null, percentile: { status: "unavailable", value: null, sampleSize: 0 }, points: [] };
  const approximation = constituentApproximation(constituentComparison.sourceRow);
  return {
    symbol: String(symbol || "").toUpperCase() || null,
    enabled: metrics.length > 0,
    status: envelope?.status || "unavailable",
    asOf: metrics.map(({ asOf }) => asOf).filter(Boolean).sort().at(-1) || null,
    metrics,
    comparisonSeries: [
      {
        id: "etf-margin",
        label: "ETF端",
        points: etfComparison.points,
      },
      {
        id: "constituent-margin",
        label: "前10大持仓端",
        points: constituentComparison.points,
      },
    ],
    financingComparison: {
      etf: etfComparison,
      constituent: constituentComparison,
      approximation,
    },
  };
}
