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
]);

const VALID_STATUSES = new Set(["ok", "degraded", "stale", "unavailable"]);
const IMPORTANCE_SCORE = { low: 0, medium: 1, high: 2, critical: 3 };

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

export function mergeIncrementalBars(current, incoming) {
  const previous = Array.isArray(current) ? current : [];
  const updates = (Array.isArray(incoming) ? incoming : [])
    .filter((bar) => bar && typeof bar.ts === "string")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (!updates.length) return previous;
  const result = previous.slice();
  for (const update of updates) {
    const last = result.at(-1);
    if (!last || update.ts > last.ts) {
      result.push(update);
    } else if (update.ts === last.ts) {
      result[result.length - 1] = update;
    }
  }
  return result;
}

export function filterFeedItems(items, filters = {}) {
  const minScore = IMPORTANCE_SCORE[filters.importance] ?? -1;
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (filters.symbol && filters.symbol !== "all" && item.symbol !== filters.symbol) return false;
    if (filters.source && filters.source !== "all" && item.source !== filters.source) return false;
    return (IMPORTANCE_SCORE[item.importance] ?? 0) >= minScore;
  });
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
