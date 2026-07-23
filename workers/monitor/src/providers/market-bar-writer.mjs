import { normalizeMarketRequest } from "./contracts.mjs";

const FRESHNESS_VALUES = new Set(["fresh", "stale"]);

export class MarketBarWriteError extends Error {
  constructor(code) {
    super(code);
    this.name = "MarketBarWriteError";
    this.code = code;
  }
}

function invalidBar() {
  throw new MarketBarWriteError("INVALID_BAR");
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).valueOf());
}

function validFinite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateBar(bar) {
  if (!bar || typeof bar !== "object") invalidBar();
  let request;
  try {
    request = normalizeMarketRequest({
      symbol: bar.symbol,
      timeframe: bar.timeframe,
    });
  } catch {
    invalidBar();
  }
  if (
    request.symbol !== bar.symbol ||
    !validTimestamp(bar.timestamp) ||
    !validTimestamp(bar.asOf) ||
    !validTimestamp(bar.fetchedAt) ||
    bar.timestamp !== bar.asOf ||
    ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(validFinite) ||
    bar.open <= 0 ||
    bar.high <= 0 ||
    bar.low <= 0 ||
    bar.close <= 0 ||
    bar.volume < 0 ||
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high) ||
    typeof bar.source !== "string" ||
    !bar.source ||
    !FRESHNESS_VALUES.has(bar.freshness) ||
    bar.adjustment !== "none" ||
    typeof bar.quality !== "string" ||
    !bar.quality
  ) {
    invalidBar();
  }
}

export function retentionExpiry(timeframe, now = new Date()) {
  if (timeframe === "5m") {
    return new Date(now.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (timeframe === "1d") {
    const expiresAt = new Date(now);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 5);
    return expiresAt.toISOString();
  }
  invalidBar();
}

export async function writeMarketBars(db, { profileId, bars, now = new Date() }) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new MarketBarWriteError("DB_REQUIRED");
  }
  if (typeof profileId !== "string" || !profileId.trim() || !Array.isArray(bars)) {
    invalidBar();
  }
  for (const bar of bars) validateBar(bar);
  if (bars.length === 0) return { written: 0 };

  const statements = bars.map((bar) => db.prepare(`
    INSERT INTO market_bars (
      profile_id, symbol, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, symbol, timeframe, ts, source, adjustment)
    DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at,
      freshness = excluded.freshness,
      quality = excluded.quality,
      expires_at = excluded.expires_at
  `).bind(
    profileId.trim(),
    bar.symbol,
    bar.timeframe,
    bar.timestamp,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    bar.source,
    bar.asOf,
    bar.fetchedAt,
    bar.freshness,
    bar.adjustment,
    bar.quality,
    retentionExpiry(bar.timeframe, now),
  ));
  await db.batch(statements);
  return { written: bars.length };
}
