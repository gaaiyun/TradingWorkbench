import { d1Binding } from "./_d1_repository.mjs";
import { json } from "./_util.js";

const SYMBOL = /^[A-Z0-9][A-Z0-9.^_-]{0,31}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TIMEFRAMES = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);
const IMPORTANCE = new Set(["low", "medium", "high", "critical"]);
const SOURCE_TIERS = new Set(["evidence", "discovery"]);
const MAX_LIMIT = 2000;

export class DynamicQueryError extends Error {}

function fail(message) {
  throw new DynamicQueryError(message);
}

function optionalPattern(params, name, pattern, { upper = false } = {}) {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  const normalized = upper ? value.toUpperCase() : value;
  if (!normalized || !pattern.test(normalized)) fail(`无效的 ${name} 参数`);
  return normalized;
}

function optionalDate(params, name) {
  const raw = params.get(name);
  if (raw === null) return null;
  const date = new Date(raw);
  if (!raw.trim() || Number.isNaN(date.valueOf())) fail(`无效的 ${name} 参数`);
  return date.toISOString();
}

function optionalCursor(params, name) {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  const legacy = new Date(value);
  if (value && !Number.isNaN(legacy.valueOf())) {
    return { timestamp: legacy.toISOString(), key: null };
  }
  try {
    const decoded = JSON.parse(value);
    if (
      Array.isArray(decoded)
      && decoded.length === 2
      && typeof decoded[0] === "string"
      && typeof decoded[1] === "string"
      && decoded[1].length > 0
      && decoded[1].length <= 256
    ) {
      const timestamp = new Date(decoded[0]);
      if (!Number.isNaN(timestamp.valueOf())) {
        return { timestamp: timestamp.toISOString(), key: decoded[1] };
      }
    }
  } catch {
    // Invalid cursors share the stable query validation error below.
  }
  fail(`无效的 ${name} 参数`);
}

function optionalText(params, name) {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (!value || value.length > 120) fail(`无效的 ${name} 参数`);
  return value;
}

function optionalEnum(params, name, allowed) {
  const raw = params.get(name);
  if (raw === null) return null;
  if (!allowed.has(raw)) fail(`无效的 ${name} 参数`);
  return raw;
}

function validateStrictParams(params, allowed) {
  for (const name of params.keys()) {
    if (!allowed.has(name) || params.getAll(name).length !== 1) {
      fail(`无效的 ${name} 参数`);
    }
  }
}

function limitValue(params) {
  const raw = params.get("limit");
  if (raw === null) return 100;
  if (!/^\d+$/.test(raw)) fail("无效的 limit 参数");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail("无效的 limit 参数");
  return Math.min(value, MAX_LIMIT);
}

export function parseDynamicQuery(request, capabilities = {}) {
  const params = new URL(request.url).searchParams;
  if (capabilities.strict) {
    const allowed = new Set(["from", "to", "limit"]);
    for (const name of [
      "symbol", "profile", "timeframe", "after", "importance", "topic",
      "source", "tier", "type", "period",
    ]) {
      if (capabilities[name]) allowed.add(name);
    }
    validateStrictParams(params, allowed);
  }
  const query = {
    symbol: capabilities.symbol ? optionalPattern(params, "symbol", SYMBOL, { upper: true }) : null,
    profile: capabilities.profile ? optionalPattern(params, "profile", PROFILE) : null,
    timeframe: null,
    from: optionalDate(params, "from"),
    to: optionalDate(params, "to"),
    after: capabilities.after ? optionalCursor(params, "after") : null,
    importance: null,
    topic: capabilities.topic ? optionalText(params, "topic") : null,
    source: capabilities.source ? optionalPattern(params, "source", SOURCE) : null,
    tier: capabilities.tier
      ? optionalEnum(params, "tier", SOURCE_TIERS)
      : null,
    limit: limitValue(params),
  };
  if (capabilities.type) query.type = optionalEnum(params, "type", capabilities.type);
  if (capabilities.period) query.period = optionalEnum(params, "period", capabilities.period);
  if (capabilities.timeframe) {
    query.timeframe = params.get("timeframe");
    if (query.timeframe !== null && !TIMEFRAMES.has(query.timeframe)) {
      fail("无效的 timeframe 参数");
    }
  }
  if (capabilities.importance) {
    query.importance = params.get("importance");
    if (query.importance !== null && !IMPORTANCE.has(query.importance)) {
      fail("无效的 importance 参数");
    }
  }
  if (query.from && query.to && query.from > query.to) fail("from 不能晚于 to");
  return query;
}

function sourceMetadata(row) {
  return {
    source: row.source ?? null,
    asOf: row.as_of ?? null,
    fetchedAt: row.fetched_at ?? null,
    freshness: row.freshness ?? null,
    adjustment: row.adjustment ?? null,
    quality: row.quality ?? null,
  };
}

function aggregateStatus(rows, health) {
  if (rows.length === 0) return "unavailable";
  if (health) {
    const allowed = new Set(["ok", "degraded", "stale", "unavailable"]);
    const statuses = rows.map((row) => allowed.has(row.status) ? row.status : "unavailable");
    const unavailableCount = statuses.filter((status) => status === "unavailable").length;
    if (unavailableCount === statuses.length) return "unavailable";
    if (unavailableCount > 0 || statuses.includes("degraded")) return "degraded";
    if (statuses.includes("stale")) return "stale";
  }
  if (rows.some((row) => (
    ["degraded", "poor", "error", "partial"].includes(row.quality)
    || /(^|_)partial($|_)/.test(String(row.quality || ""))
  ))) {
    return "degraded";
  }
  if (rows.some((row) => row.freshness === "stale")) return "stale";
  return "ok";
}

function latestRowsPerSeries(rows, columns) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(columns.map((column) => row?.[column] ?? null));
    const asOf = row?.as_of ?? null;
    const previous = groups.get(key);
    if (!previous || (asOf && (!previous.asOf || asOf > previous.asOf))) {
      groups.set(key, { asOf, rows: [row] });
    } else if (asOf === previous.asOf) {
      previous.rows.push(row);
    }
  }
  return [...groups.values()].flatMap(({ rows: groupRows }) => groupRows);
}

export function dynamicEnvelope(
  rows,
  {
    health = false,
    cursorColumn = null,
    cursorForward = false,
    statusScope = "all",
    statusGroupColumns = [],
    freshnessMaxAgeMs = null,
    freshnessNow = Date.now(),
  } = {},
) {
  const sources = [];
  const seen = new Set();
  for (const row of rows) {
    const metadata = sourceMetadata(row);
    const key = JSON.stringify(metadata);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(metadata);
  }
  const asOf = rows.reduce((latest, row) => {
    const value = row.as_of ?? null;
    return value && (!latest || value > latest) ? value : latest;
  }, null);
  const statusRows = statusScope === "latest-as-of" && asOf
    ? rows.filter((row) => row.as_of === asOf)
    : statusScope === "latest-per-series" && statusGroupColumns.length
      ? latestRowsPerSeries(rows, statusGroupColumns)
      : rows;
  const effectiveStatusRows = Number.isFinite(freshnessMaxAgeMs) && freshnessMaxAgeMs >= 0
    ? statusRows.map((row) => {
      const timestamp = Date.parse(row.as_of ?? row.ts ?? "");
      if (!Number.isFinite(timestamp) || freshnessNow - timestamp > freshnessMaxAgeMs || freshnessNow < timestamp) {
        return { ...row, freshness: "stale" };
      }
      return row;
    })
    : statusRows;
  const envelope = { status: aggregateStatus(effectiveStatusRows, health), asOf, data: rows, sources };
  if (cursorColumn) {
    const cursorRow = cursorForward ? rows.at(-1) : rows[0];
    const columns = Array.isArray(cursorColumn) ? cursorColumn : [cursorColumn];
    const values = columns.map((column) => cursorRow?.[column] ?? null);
    envelope.cursor = values.some((value) => value === null)
      ? null
      : columns.length === 1 ? values[0] : JSON.stringify(values);
  }
  return envelope;
}

export function unavailableEnvelope(error) {
  const envelope = { status: "unavailable", asOf: null, data: [], sources: [] };
  if (error) envelope.error = error;
  return envelope;
}

export async function serveDynamic(
  { request, env },
  {
    capabilities,
    query,
    health = false,
    cursorColumn = null,
    statusScope = "all",
    statusGroupColumns = [],
    freshnessMaxAgeMs = null,
    freshnessNow = Date.now(),
    envelopeExtras = {},
  },
) {
  let filters;
  try {
    filters = parseDynamicQuery(request, capabilities);
  } catch (error) {
    if (error instanceof DynamicQueryError) {
      return json({
        ...unavailableEnvelope(error.message),
        ...envelopeExtras,
        ...(cursorColumn ? { cursor: null } : {}),
      }, 400, { "cache-control": "no-store" });
    }
    throw error;
  }
  const db = d1Binding(env);
  if (!db) return json({
    ...unavailableEnvelope(),
    ...envelopeExtras,
    ...(cursorColumn ? { cursor: null } : {}),
  }, 200, { "cache-control": "no-store" });
  try {
    return json({
      ...dynamicEnvelope(await query(db, filters), {
        health,
        cursorColumn,
        cursorForward: Boolean(filters.after),
        statusScope,
        statusGroupColumns,
        freshnessMaxAgeMs,
        freshnessNow,
      }),
      ...envelopeExtras,
    }, 200, {
      "cache-control": "no-store",
    });
  } catch {
    return json({
      ...unavailableEnvelope(),
      ...envelopeExtras,
      ...(cursorColumn ? { cursor: null } : {}),
    }, 200, { "cache-control": "no-store" });
  }
}
