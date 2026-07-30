const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

const MARKETS = {
  cn: {
    timeZone: "Asia/Shanghai",
    sessions: [
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ],
  },
  us: {
    timeZone: "America/New_York",
    sessions: [[9 * 60 + 30, 16 * 60]],
  },
};

const FORMATTERS = new Map();

function formatter(timeZone) {
  if (!FORMATTERS.has(timeZone)) {
    FORMATTERS.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }));
  }
  return FORMATTERS.get(timeZone);
}

function dateParts(timestamp, timeZone) {
  return Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(timestamp))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
}

function zonedTimestamp({ year, month, day, hour, minute }, timeZone) {
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desiredWallTime;
  for (let index = 0; index < 3; index += 1) {
    const actual = dateParts(timestamp, timeZone);
    const actualWallTime = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const difference = desiredWallTime - actualWallTime;
    timestamp += difference;
    if (difference === 0) break;
  }
  return timestamp;
}

function previousCalendarDate(localDate, daysBack) {
  const timestamp = Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day - daysBack,
  );
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function latestCompletedEndpoint(now, market) {
  const definition = MARKETS[market];
  if (!definition) return null;
  const localDate = dateParts(now, definition.timeZone);
  let latest = null;

  for (let daysBack = 0; daysBack < 8; daysBack += 1) {
    const date = previousCalendarDate(localDate, daysBack);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const [openMinute, closeMinute] of definition.sessions) {
      for (
        let endpointMinute = openMinute + 5;
        endpointMinute <= closeMinute;
        endpointMinute += 5
      ) {
        const endpoint = zonedTimestamp({
          ...date,
          hour: Math.floor(endpointMinute / 60),
          minute: endpointMinute % 60,
        }, definition.timeZone);
        if (endpoint <= now && (latest === null || endpoint > latest)) latest = endpoint;
      }
    }
    if (latest !== null) break;
  }
  return latest;
}

function isRegularFiveMinuteEndpoint(asOf, market) {
  const timestamp = Date.parse(asOf || "");
  const definition = MARKETS[market];
  if (!Number.isFinite(timestamp) || !definition) return false;
  const local = dateParts(timestamp, definition.timeZone);
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  if (weekday === 0 || weekday === 6 || local.second !== 0) return false;
  const minute = local.hour * 60 + local.minute;
  return definition.sessions.some(([openMinute, closeMinute]) => (
    minute > openMinute
    && minute <= closeMinute
    && (minute - openMinute) % 5 === 0
  ));
}

export function marketForSeries({ symbol, source } = {}) {
  const normalizedSymbol = String(symbol || "").toUpperCase();
  const normalizedSource = String(source || "").toLowerCase();
  if (
    normalizedSymbol.endsWith(".SS")
    || normalizedSymbol.endsWith(".SZ")
    || normalizedSource === "tencent"
    || normalizedSource === "tencent-cn"
  ) {
    return "cn";
  }
  if (
    normalizedSource === "yahoo-us-intraday"
    || normalizedSource === "tencent-us"
    || normalizedSource === "eastmoney-us"
  ) {
    return "us";
  }
  return null;
}

export function sessionAwareFreshness({
  asOf,
  market,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const timestamp = Date.parse(asOf || "");
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "stale";
  const endpoint = latestCompletedEndpoint(now, market);
  if (!Number.isFinite(endpoint)) return "stale";
  return endpoint - timestamp > maxAgeMs || timestamp - endpoint > FIVE_MINUTES_MS
    ? "stale"
    : "fresh";
}

export function effectiveIntradayHealth(rows, now = Date.now()) {
  return rows.map((row) => {
    const market = marketForSeries(row);
    if (
      !market
      || !isRegularFiveMinuteEndpoint(row.as_of, market)
      || row.quality !== "good"
      || row.last_error_code
      || Number(row.consecutive_failures || 0) > 0
      || !["ok", "stale"].includes(row.status)
    ) {
      return row;
    }
    const freshness = sessionAwareFreshness({
      asOf: row.as_of,
      market,
      now,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
    });
    return {
      ...row,
      status: freshness === "fresh" ? "ok" : "stale",
      freshness,
    };
  });
}

export { DEFAULT_MAX_AGE_MS };
