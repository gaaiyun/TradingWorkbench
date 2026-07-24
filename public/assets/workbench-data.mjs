export const DEFAULT_TARGETS = Object.freeze([
  { symbol: "515880.SS", name: "通信 ETF", market: "CN", role: "core", analysis: "full" },
  { symbol: "512480.SS", name: "半导体 ETF", market: "CN", role: "core", analysis: "full" },
  { symbol: "159995.SZ", name: "芯片 ETF", market: "CN", role: "comparison", analysis: "signal" },
  { symbol: "SOXX", name: "iShares 半导体", market: "US", role: "driver", analysis: "signal" },
  { symbol: "SMH", name: "VanEck 半导体", market: "US", role: "driver", analysis: "signal" },
  { symbol: "NVDA", name: "NVIDIA", market: "US", role: "driver", analysis: "signal" },
  { symbol: "TSM", name: "台积电 ADR", market: "US", role: "driver", analysis: "signal" },
  { symbol: "AVGO", name: "Broadcom", market: "US", role: "driver", analysis: "signal" },
  { symbol: "AMD", name: "AMD", market: "US", role: "driver", analysis: "signal" },
  { symbol: "ASML", name: "ASML", market: "US", role: "driver", analysis: "signal" },
  { symbol: "ORCL", name: "Oracle", market: "US", role: "driver", analysis: "signal" },
  { symbol: "GOOGL", name: "Alphabet", market: "US", role: "driver", analysis: "signal" },
  { symbol: "3887.HK", name: "比特小鹿", market: "HK", role: "driver", analysis: "signal" },
]);

const VALID_STATUSES = new Set(["ok", "degraded", "stale", "unavailable"]);
const IMPORTANCE_SCORE = { low: 0, medium: 1, high: 2, critical: 3 };
const DAILY_HISTORY_LIMITS = Object.freeze({
  "6m": 126,
  "1y": 252,
  "3y": 756,
  "5y": 1260,
});

export function dailyHistoryLimit(range) {
  return DAILY_HISTORY_LIMITS[range] || DAILY_HISTORY_LIMITS["5y"];
}

export function normalizeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "unavailable", asOf: null, data: [], sources: [] };
  }
  return {
    status: VALID_STATUSES.has(value.status) ? value.status : "unavailable",
    asOf: typeof value.asOf === "string" ? value.asOf : null,
    data: Array.isArray(value.data) ? value.data : [],
    sources: Array.isArray(value.sources) ? value.sources : [],
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function shallowEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Object.is(left[key], right[key]));
}

export function mergeIncrementalBatch(current, incoming) {
  const previous = Array.isArray(current) ? current : [];
  const updates = (Array.isArray(incoming) ? incoming : [])
    .filter((bar) => bar && typeof bar.ts === "string")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (!updates.length) return { bars: previous, changedFromIndex: null, strategy: "none" };
  const byTimestamp = new Map(previous.map((bar) => [bar.ts, bar]));
  for (const update of updates) {
    byTimestamp.set(update.ts, update);
  }
  const bars = [...byTimestamp.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  let changedFromIndex = null;
  const length = Math.max(previous.length, bars.length);
  for (let index = 0; index < length; index += 1) {
    if (!shallowEqual(previous[index], bars[index])) {
      changedFromIndex = index;
      break;
    }
  }
  if (changedFromIndex === null) return { bars: previous, changedFromIndex: null, strategy: "none" };
  const pureAppend = changedFromIndex === previous.length;
  const pureLastUpdate = bars.length === previous.length && changedFromIndex === previous.length - 1;
  return {
    bars,
    changedFromIndex,
    strategy: pureAppend || pureLastUpdate ? "update" : "setData",
  };
}

export function mergeIncrementalBars(current, incoming) {
  return mergeIncrementalBatch(current, incoming).bars;
}

export function applySeriesBatch(series, dataSets, { strategy, changedFromIndex = 0 }) {
  if (strategy === "none") return;
  const entries = Object.entries(series);
  if (strategy === "update") {
    const length = Math.max(0, ...Object.values(dataSets).map((points) => points.length));
    for (let index = changedFromIndex; index < length; index += 1) {
      entries.forEach(([key, item]) => item.update(dataSets[key][index]));
    }
    return;
  }
  entries.forEach(([key, item]) => item.setData(dataSets[key]));
}

export function createLatestRequestGate() {
  let latestId = 0;
  let controller = null;
  let activeRequest = null;
  return {
    begin(symbol, timeframe, kind = "full") {
      const sameContextFull = kind === "incremental"
        && activeRequest?.kind === "full"
        && activeRequest.symbol === symbol
        && activeRequest.timeframe === timeframe
        && !activeRequest.signal.aborted;
      if (sameContextFull) return null;
      controller?.abort();
      controller = new AbortController();
      activeRequest = { id: ++latestId, symbol, timeframe, kind, signal: controller.signal };
      return activeRequest;
    },
    isCurrent(request, symbol, timeframe) {
      return request?.id === latestId
        && request.symbol === symbol
        && request.timeframe === timeframe
        && !request.signal.aborted;
    },
    finish(request) {
      if (request?.id === latestId) {
        controller = null;
        activeRequest = null;
      }
    },
  };
}

const THREAD_LIMITS = Object.freeze({
  maxThreads: 30,
  maxMessagesPerThread: 80,
  maxCharsPerThread: 60000,
  maxMessagesTotal: 300,
  maxCharsTotal: 180000,
});

function positiveLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function takeRecentMessages(messages, maxMessages, maxChars) {
  const kept = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0 && kept.length < maxMessages && chars < maxChars; index -= 1) {
    const message = messages[index];
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    const remaining = maxChars - chars;
    const content = String(message.content || "").slice(0, remaining);
    if (!content) continue;
    kept.unshift({ ...message, content });
    chars += content.length;
  }
  return kept;
}

export function compactThreads(threads, options = {}) {
  const limits = {
    maxThreads: positiveLimit(options.maxThreads, THREAD_LIMITS.maxThreads),
    maxMessagesPerThread: positiveLimit(options.maxMessagesPerThread, THREAD_LIMITS.maxMessagesPerThread),
    maxCharsPerThread: positiveLimit(options.maxCharsPerThread, THREAD_LIMITS.maxCharsPerThread),
    maxMessagesTotal: positiveLimit(options.maxMessagesTotal, THREAD_LIMITS.maxMessagesTotal),
    maxCharsTotal: positiveLimit(options.maxCharsTotal, THREAD_LIMITS.maxCharsTotal),
  };
  let messagesRemaining = limits.maxMessagesTotal;
  let charsRemaining = limits.maxCharsTotal;
  return (Array.isArray(threads) ? threads : []).slice(0, limits.maxThreads).map((thread) => {
    const messages = takeRecentMessages(
      Array.isArray(thread?.messages) ? thread.messages : [],
      Math.min(limits.maxMessagesPerThread, messagesRemaining),
      Math.min(limits.maxCharsPerThread, charsRemaining),
    );
    messagesRemaining -= messages.length;
    charsRemaining -= messages.reduce((sum, message) => sum + message.content.length, 0);
    return { ...thread, messages };
  });
}

export function buildChatHistory(messages, options = {}) {
  const safe = (Array.isArray(messages) ? messages : [])
    .filter((message) => !message?.error && ["user", "assistant"].includes(message?.role))
    .map(({ role, content }) => ({ role, content: String(content || "") }))
    .filter(({ content }) => content.length > 0);
  return takeRecentMessages(
    safe,
    positiveLimit(options.maxMessages, 20),
    positiveLimit(options.maxChars, 12000),
  ).map(({ role, content }) => ({ role, content }));
}

export function filterFeedItems(items, filters = {}) {
  const minScore = IMPORTANCE_SCORE[filters.importance] ?? -1;
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (filters.symbol && filters.symbol !== "all" && item.symbol !== filters.symbol) return false;
    if (filters.source && filters.source !== "all" && item.source !== filters.source) return false;
    return (IMPORTANCE_SCORE[item.importance] ?? 0) >= minScore;
  });
}

export function buildTaskTimeline(profile) {
  const schedules = profile?.schedules || {};
  return [
    {
      time: schedules.usCloseSnapshot?.time || "05:35",
      label: "美股收盘快照",
      enabled: schedules.usCloseSnapshot?.enabled,
    },
    {
      time: schedules.preMarketBrief?.time || "08:25",
      label: "盘前传导简报",
      enabled: schedules.preMarketBrief?.enabled,
    },
    {
      time: schedules.cnIntraday?.windows?.[0]?.start || "09:30",
      label: "A 股盘中采集",
      enabled: schedules.cnIntraday?.enabled,
    },
    {
      time: schedules.closeDeepAnalysis?.time || "15:20",
      label: "收盘深度分析",
      enabled: schedules.closeDeepAnalysis?.enabled,
    },
  ].filter((item) => item.enabled).map((item) => ({
    ...item,
    status: "pending",
    detail: "任务结果接口未提供",
  }));
}

export function selectConclusion(latest, symbol) {
  return (latest?.results || []).find((item) => item.ticker === symbol) || null;
}

export function simpleMovingAverage(bars, period) {
  let sum = 0;
  return bars.map((bar, index) => {
    sum += Number(bar.close);
    if (index >= period) sum -= Number(bars[index - period].close);
    return index >= period - 1 ? sum / period : null;
  });
}

function exponentialMovingAverage(values, period) {
  const weight = 2 / (period + 1);
  let current = null;
  return values.map((value) => {
    const number = Number(value);
    current = current === null ? number : number * weight + current * (1 - weight);
    return current;
  });
}

export function computeIndicators(bars) {
  const closes = bars.map((bar) => Number(bar.close));
  const fast = exponentialMovingAverage(closes, 12);
  const slow = exponentialMovingAverage(closes, 26);
  const macd = fast.map((value, index) => value - slow[index]);
  const signal = exponentialMovingAverage(macd, 9);
  const histogram = macd.map((value, index) => value - signal[index]);
  const rsi = closes.map((value, index) => {
    if (index < 14) return null;
    let gains = 0;
    let losses = 0;
    for (let cursor = index - 13; cursor <= index; cursor += 1) {
      const change = closes[cursor] - closes[cursor - 1];
      if (change >= 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return 100;
    const relativeStrength = gains / losses;
    return 100 - 100 / (1 + relativeStrength);
  });
  return { ma20: simpleMovingAverage(bars, 20), ma60: simpleMovingAverage(bars, 60), macd, signal, histogram, rsi };
}

function zonedParts(date, timezone) {
  const values = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function wallClockToDate(parts, timezone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shown = zonedParts(new Date(guess), timezone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    guess += Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0) - shownUtc;
  }
  return new Date(guess);
}

export function computeNextRun(profile, now = new Date()) {
  if (!profile?.enabled) return null;
  const timezone = profile.timezone || "Asia/Shanghai";
  const labels = {
    usCloseSnapshot: "美股收盘快照",
    preMarketBrief: "盘前简报",
    closeDeepAnalysis: "收盘深度分析",
  };
  const local = zonedParts(now, timezone);
  const candidates = [];
  for (const [key, label] of Object.entries(labels)) {
    const schedule = profile.schedules?.[key];
    if (!schedule?.enabled || !/^\d{2}:\d{2}$/.test(schedule.time || "")) continue;
    const [hour, minute] = schedule.time.split(":").map(Number);
    let candidate = wallClockToDate({ ...local, hour, minute }, timezone);
    if (candidate <= now) {
      const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day) + 86400000);
      candidate = wallClockToDate({
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth() + 1,
        day: tomorrow.getUTCDate(),
        hour,
        minute,
      }, timezone);
    }
    candidates.push({ label, at: candidate.toISOString() });
  }
  return candidates.sort((a, b) => a.at.localeCompare(b.at))[0] || null;
}
