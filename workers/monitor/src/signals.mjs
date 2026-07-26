import { notificationPoliciesForEvent } from "./notifications.mjs";

const SIGNAL_RULE_VERSION = "intraday-signal-v1";

function eligibleTargets(profile) {
  return profile.targets.filter((target) =>
    target.market === "CN" &&
    (target.role === "core" || target.role === "comparison"));
}

function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function zScore(value, history) {
  if (!Number.isFinite(value) || history.length < 10) return null;
  const average = mean(history);
  const variance = history.reduce((sum, item) => sum + (item - average) ** 2, 0)
    / Math.max(1, history.length - 1);
  const deviation = Math.sqrt(variance);
  return deviation > 0 ? (value - average) / deviation : null;
}

async function eventId(profileId, symbol, scheduledFor) {
  const material = `${profileId}\n${symbol}\nintraday-signal\n${scheduledFor}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `event-${hex}`;
}

async function recentBars(db, profileId, symbol, scheduledFor, now) {
  const result = await db.prepare(
    `SELECT symbol, timeframe, ts, open, high, low, close, volume,
            source, as_of, fetched_at, freshness, adjustment, quality
     FROM market_bars
     WHERE profile_id = ? AND symbol = ? AND timeframe = '5m'
       AND ts <= ? AND expires_at > ?
     ORDER BY ts DESC, fetched_at DESC, source ASC LIMIT 240`,
  ).bind(profileId, symbol, scheduledFor, now.toISOString()).all();
  return canonicalBars(result?.results || [])
    .filter((bar) => Number.isFinite(Number(bar.close)))
    .slice(-80);
}

function provenanceRank(bar) {
  const freshness = new Map([
    ["fresh", 4],
    ["current", 4],
    ["delayed", 2],
    ["unknown", 1],
    ["stale", 0],
  ]).get(String(bar.freshness || "").toLowerCase()) ?? 1;
  const quality = new Map([
    ["verified", 5],
    ["evidence", 5],
    ["excellent", 5],
    ["good", 4],
    ["unknown", 2],
    ["partial", 1],
    ["degraded", 1],
    ["poor", 0],
    ["error", 0],
  ]).get(String(bar.quality || "").toLowerCase()) ?? 2;
  const fetchedAt = Date.parse(bar.fetched_at);
  return {
    freshness,
    quality,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : -Infinity,
    source: String(bar.source || ""),
  };
}

function preferredBar(left, right) {
  const leftRank = provenanceRank(left);
  const rightRank = provenanceRank(right);
  if (leftRank.freshness !== rightRank.freshness) {
    return leftRank.freshness > rightRank.freshness ? left : right;
  }
  if (leftRank.quality !== rightRank.quality) {
    return leftRank.quality > rightRank.quality ? left : right;
  }
  if (leftRank.fetchedAt !== rightRank.fetchedAt) {
    return leftRank.fetchedAt > rightRank.fetchedAt ? left : right;
  }
  return leftRank.source.localeCompare(rightRank.source) <= 0 ? left : right;
}

function usableProvenance(bar) {
  const freshness = String(bar.freshness || "").toLowerCase();
  const quality = String(bar.quality || "").toLowerCase();
  return !["stale", "unavailable", "error"].includes(freshness)
    && !["poor", "error", "degraded", "partial"].includes(quality);
}

export function canonicalBars(rows) {
  const byTimestamp = new Map();
  for (const row of rows) {
    if (!row?.ts) continue;
    const current = byTimestamp.get(row.ts);
    byTimestamp.set(row.ts, current ? preferredBar(current, row) : row);
  }
  return [...byTimestamp.values()]
    .filter(usableProvenance)
    .sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
}

function priceMove15m(bars) {
  const latest = bars.at(-1);
  if (!latest || bars.length < 4) return null;
  const targetTime = Date.parse(latest.ts) - 15 * 60_000;
  let baseline = null;
  let closestDistance = Infinity;
  for (const candidate of bars.slice(0, -1)) {
    const timestamp = Date.parse(candidate.ts);
    const distance = Math.abs(timestamp - targetTime);
    if (distance <= 5 * 60_000 && distance < closestDistance) {
      baseline = candidate;
      closestDistance = distance;
    }
  }
  const before = Number(baseline?.close);
  const current = Number(latest.close);
  if (!Number.isFinite(before) || before === 0 || !Number.isFinite(current)) return null;
  return (current / before - 1) * 100;
}

function volumeAnomaly(bars) {
  const latest = bars.at(-1);
  const current = Number(latest?.volume);
  const history = bars
    .slice(-21, -1)
    .map(({ volume }) => Number(volume))
    .filter(Number.isFinite);
  return zScore(current, history);
}

function continuousTail(bars) {
  if (bars.length === 0) return [];
  let start = bars.length - 1;
  for (let index = bars.length - 1; index > 0; index -= 1) {
    const newer = Date.parse(bars[index].ts);
    const older = Date.parse(bars[index - 1].ts);
    const gap = newer - older;
    if (!Number.isFinite(gap) || gap <= 0 || gap > 10 * 60_000) break;
    start = index - 1;
  }
  return bars.slice(start);
}

function importanceFor(priceMove, volumeZ) {
  const absoluteMove = Math.abs(priceMove ?? 0);
  if (absoluteMove >= 2 || (volumeZ ?? -Infinity) >= 3) return "high";
  if (absoluteMove >= 1 || (volumeZ ?? -Infinity) >= 2) return "medium";
  return null;
}

function description(priceMove, volumeZ, latest) {
  const parts = [];
  if (priceMove !== null) parts.push(`15分钟涨跌 ${priceMove.toFixed(2)}%`);
  if (volumeZ !== null) parts.push(`成交量 z-score ${volumeZ.toFixed(2)}`);
  parts.push(`收盘 ${Number(latest.close)}`);
  parts.push(`行情来源 ${latest.source}`);
  return parts.join("；");
}

async function insertEvent(db, {
  id,
  profileId,
  symbol,
  importance,
  latest,
  priceMove,
  volumeZ,
  now,
  profile,
}) {
  const expiresAt = new Date(now.valueOf() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const title = `${symbol} 15分钟价格异动`;
  const event = {
    id,
    profileId,
    importance,
    eventAt: latest.ts,
    title,
  };
  const eventStatement = db.prepare(
    `INSERT INTO market_events (
       id, symbol, profile_id, topic, importance, event_at, title, description,
       source, as_of, fetched_at, freshness, adjustment, quality, expires_at,
       provider, provider_as_of, provider_quality, rule_version
     ) VALUES (
       ?, ?, ?, 'market_move', ?, ?, ?, ?, 'signal-engine', ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?
     )
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    id,
    symbol,
    profileId,
    importance,
    latest.ts,
    title,
    description(priceMove, volumeZ, latest),
    latest.as_of || latest.ts,
    now.toISOString(),
    latest.freshness || "unknown",
    latest.adjustment || "none",
    latest.quality || "unknown",
    expiresAt,
    latest.source || "unknown",
    latest.as_of || latest.ts,
    latest.quality || "unknown",
    SIGNAL_RULE_VERSION,
  );
  const deliveries = notificationPoliciesForEvent({
    profile,
    event,
    mode: "shadow",
    hasPushPlusToken: false,
    now,
  });
  const deliveryStatements = deliveries.map((delivery) => db.prepare(`
    INSERT INTO notification_deliveries (
      id, event_id, profile_id, channel, status, policy_snapshot_json,
      reason_code, attempt_count, next_attempt_at, sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(event_id, channel) DO NOTHING
  `).bind(
    `delivery:${id}:${delivery.channel}`,
    id,
    profileId,
    delivery.channel,
    delivery.status,
    delivery.policySnapshotJson,
    delivery.reasonCode,
    delivery.nextAttemptAt,
    delivery.sentAt,
    now.toISOString(),
    now.toISOString(),
  ));
  const results = await db.batch([eventStatement, ...deliveryStatements]);
  return changes(results[0]);
}

export async function evaluateIntradaySignals({
  db,
  profile,
  scheduledFor,
  now = new Date(),
}) {
  const counts = {
    targets: 0,
    evaluated: 0,
    medium: 0,
    high: 0,
    inserted: 0,
    unavailable: 0,
  };
  const sources = [];
  const targets = eligibleTargets(profile);
  counts.targets = targets.length;

  for (const target of targets) {
    let bars;
    try {
      bars = await recentBars(db, profile.id, target.symbol, scheduledFor, now);
    } catch {
      counts.unavailable += 1;
      continue;
    }
    const latest = bars.at(-1);
    const latestTime = Date.parse(latest?.ts);
    const signalBars = continuousTail(bars);
    if (
      signalBars.length < 4 ||
      !Number.isFinite(latestTime) ||
      now.valueOf() - latestTime > 10 * 60_000
    ) {
      counts.unavailable += 1;
      continue;
    }
    counts.evaluated += 1;
    const priceMove = priceMove15m(signalBars);
    const volumeZ = volumeAnomaly(signalBars);
    const importance = importanceFor(priceMove, volumeZ);
    sources.push({
      source: latest.source,
      status: latest.freshness === "stale" ? "stale" : "ok",
      symbol: target.symbol,
      asOf: latest.as_of || latest.ts,
    });
    if (!importance) continue;
    counts[importance] += 1;
    counts.inserted += await insertEvent(db, {
      id: await eventId(profile.id, target.symbol, scheduledFor),
      profileId: profile.id,
      symbol: target.symbol,
      importance,
      latest,
      priceMove,
      volumeZ,
      now,
      profile,
    });
  }

  if (counts.evaluated === 0) {
    return {
      status: "deferred",
      errorCode: "SIGNAL_INPUT_UNAVAILABLE",
      counts,
      sources,
    };
  }
  return {
    status: counts.unavailable > 0 ? "degraded" : "completed",
    ...(counts.unavailable > 0 ? { errorCode: "SIGNAL_INPUT_PARTIAL" } : {}),
    counts,
    sources,
  };
}
