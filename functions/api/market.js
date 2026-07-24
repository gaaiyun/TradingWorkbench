import {
  DynamicQueryError,
  dynamicEnvelope,
  parseDynamicQuery,
  unavailableEnvelope,
} from "./_dynamic_api.mjs";
import { d1Binding, queryMarketBars } from "./_d1_repository.mjs";
import { calculateTechnicalSnapshot } from "./_indicators.mjs";
import { json } from "./_util.js";

const PERIODS_PER_YEAR = {
  "1m": 240 * 252,
  "5m": 48 * 252,
  "15m": 16 * 252,
  "30m": 8 * 252,
  "1h": 4 * 252,
  "4h": 252,
  "1d": 252,
};

const DERIVED_TIMEFRAMES = {
  "15m": { source: "5m", milliseconds: 15 * 60 * 1000, factor: 3 },
  "30m": { source: "5m", milliseconds: 30 * 60 * 1000, factor: 6 },
  "1h": { source: "5m", milliseconds: 60 * 60 * 1000, factor: 12 },
  "4h": { source: "5m", milliseconds: 4 * 60 * 60 * 1000, factor: 48 },
};

const FRESHNESS_RANK = {
  fresh: 0,
  stale: 1,
  unknown: 2,
};

const SOURCE_OVERLAP_FACTOR = 6;
// 春节、国庆等合法休市可能超过一周；只有超过一个半月的断口才按旧种子处理。
const DAILY_MAX_CONTIGUOUS_GAP_MS = 45 * 24 * 60 * 60 * 1000;

function laterTimestamp(left, right) {
  return String(left || "") >= String(right || "") ? left : right;
}

function aggregateGroup(group, timeframe, bucketTimestamp) {
  const sorted = [...group].sort((left, right) => left.ts.localeCompare(right.ts));
  const first = sorted[0];
  const last = sorted.at(-1);
  const adjustments = new Set(sorted.map(({ adjustment }) => adjustment).filter(Boolean));
  const freshness = sorted.reduce((worst, row) => (
    (FRESHNESS_RANK[row.freshness] ?? FRESHNESS_RANK.unknown)
      > (FRESHNESS_RANK[worst] ?? FRESHNESS_RANK.unknown)
      ? row.freshness
      : worst
  ), "fresh");
  return {
    symbol: last.symbol,
    profile_id: last.profile_id,
    timeframe,
    ts: bucketTimestamp,
    open: Number(first.open),
    high: Math.max(...sorted.map(({ high }) => Number(high))),
    low: Math.min(...sorted.map(({ low }) => Number(low))),
    close: Number(last.close),
    volume: sorted.reduce((sum, { volume }) => sum + Number(volume || 0), 0),
    source: last.source,
    as_of: sorted.reduce((latest, row) => laterTimestamp(latest, row.as_of), null),
    fetched_at: sorted.reduce((latest, row) => laterTimestamp(latest, row.fetched_at), null),
    freshness,
    adjustment: adjustments.size === 1 ? [...adjustments][0] : "unknown",
    quality: sorted.every(({ quality }) => quality === "good") ? "good" : "partial",
  };
}

function distinctMarketBars(rows, limit, daily = false) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const key = daily && /^\d{4}-\d{2}-\d{2}/.test(row.ts)
      ? row.ts.slice(0, 10)
      : row.ts;
    const current = byTimestamp.get(key);
    if (!current || String(row.fetched_at || "") > String(current.fetched_at || "")) {
      byTimestamp.set(key, row);
    }
  }
  return [...byTimestamp.values()]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, limit);
}

function contiguousDailyBars(rows) {
  if (rows.length < 2) return rows;
  const kept = [rows[0]];
  for (let index = 1; index < rows.length; index += 1) {
    const newer = Date.parse(kept.at(-1).ts);
    const older = Date.parse(rows[index].ts);
    const gap = newer - older;
    if (!Number.isFinite(gap) || gap > DAILY_MAX_CONTIGUOUS_GAP_MS) break;
    kept.push(rows[index]);
  }
  return kept;
}

function marketEnvelope(rows) {
  const latest = rows.reduce(
    (current, row) => (!current || row.ts > current.ts ? row : current),
    null,
  );
  const envelope = dynamicEnvelope(latest ? [latest] : []);
  return { ...envelope, data: rows };
}

export function aggregateMarketBars(rows, timeframe, milliseconds, limit) {
  const groups = new Map();
  for (const row of [...rows].sort((left, right) => left.ts.localeCompare(right.ts))) {
    const parsed = Date.parse(row.ts);
    if (!Number.isFinite(parsed)) continue;
    const bucketTimestamp = new Date(Math.floor(parsed / milliseconds) * milliseconds).toISOString();
    const group = groups.get(bucketTimestamp) || [];
    group.push(row);
    groups.set(bucketTimestamp, group);
  }
  return [...groups.entries()]
    .map(([timestamp, group]) => aggregateGroup(group, timeframe, timestamp))
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, limit);
}

export async function onRequestGet({ request, env }) {
  let query;
  try {
    query = parseDynamicQuery(request, {
      symbol: true,
      profile: true,
      timeframe: true,
    });
  } catch (error) {
    if (error instanceof DynamicQueryError) {
      return json(unavailableEnvelope(error.message), 400, { "cache-control": "no-store" });
    }
    throw error;
  }
  const db = d1Binding(env);
  if (!db) return json(unavailableEnvelope(), 200, { "cache-control": "no-store" });
  try {
    const derived = DERIVED_TIMEFRAMES[query.timeframe];
    const storedQuery = derived
      ? {
        ...query,
        timeframe: derived.source,
        limit: query.limit * derived.factor * SOURCE_OVERLAP_FACTOR,
      }
      : {
        ...query,
        limit: query.limit * SOURCE_OVERLAP_FACTOR,
      };
    const queriedRows = await queryMarketBars(db, storedQuery);
    const sourceLimit = derived ? query.limit * derived.factor : query.limit;
    const distinctRows = distinctMarketBars(
      queriedRows,
      sourceLimit,
      query.timeframe === "1d",
    );
    const storedRows = query.timeframe === "1d"
      ? contiguousDailyBars(distinctRows)
      : distinctRows;
    const rows = derived
      ? aggregateMarketBars(storedRows, query.timeframe, derived.milliseconds, query.limit)
      : storedRows;
    const envelope = marketEnvelope(rows);
    return json({
      ...envelope,
      indicators: rows.length
        ? calculateTechnicalSnapshot(rows, {
          periodsPerYear: PERIODS_PER_YEAR[query.timeframe] || 252,
        })
        : null,
    }, 200, { "cache-control": "no-store" });
  } catch {
    return json(unavailableEnvelope(), 200, { "cache-control": "no-store" });
  }
}
