const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_PAUSE_MS = 15 * 60 * 1000;
const HEALTH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function readSourceHealth(db, source) {
  if (!db) return null;
  return db.prepare(`
    SELECT source, status, consecutive_failures, paused_until, last_error_code,
           last_success_at
    FROM source_health
    WHERE source = ?
  `).bind(source).first();
}

export function circuitIsOpen(health, now = new Date()) {
  if (!health?.paused_until) return false;
  const pausedUntil = new Date(health.paused_until);
  return Number.isFinite(pausedUntil.valueOf()) && pausedUntil.valueOf() > now.valueOf();
}

export async function recordSourceFailure(
  db,
  source,
  errorCode,
  now = new Date(),
  options = {},
) {
  if (!db) return;
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const asOf = now.toISOString();
  const pausedUntil = new Date(now.valueOf() + pauseMs).toISOString();
  const expiresAt = new Date(now.valueOf() + HEALTH_RETENTION_MS).toISOString();
  await db.prepare(`
    INSERT INTO source_health (
      source, status, as_of, fetched_at, freshness, adjustment, quality, detail,
      expires_at, consecutive_failures, paused_until, last_error_code
    ) VALUES (?, 'degraded', ?, ?, 'stale', 'none', 'failed', NULL, ?, 1, NULL, ?)
    ON CONFLICT(source) DO UPDATE SET
      consecutive_failures = source_health.consecutive_failures + 1,
      paused_until = CASE
        WHEN source_health.consecutive_failures + 1 >= ? THEN ?
        ELSE NULL
      END,
      last_error_code = excluded.last_error_code,
      status = CASE
        WHEN source_health.consecutive_failures + 1 >= ? THEN 'unavailable'
        ELSE 'degraded'
      END,
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at,
      freshness = excluded.freshness,
      adjustment = excluded.adjustment,
      quality = excluded.quality,
      detail = NULL,
      expires_at = excluded.expires_at
  `).bind(
    source,
    asOf,
    asOf,
    expiresAt,
    errorCode,
    failureThreshold,
    pausedUntil,
    failureThreshold,
  ).run();
}

export async function recordSourceSuccess(db, source, now = new Date()) {
  if (!db) return;
  const asOf = now.toISOString();
  const expiresAt = new Date(now.valueOf() + HEALTH_RETENTION_MS).toISOString();
  await db.prepare(`
    INSERT INTO source_health (
      source, status, as_of, fetched_at, freshness, adjustment, quality, detail,
      expires_at, consecutive_failures, paused_until, last_error_code, last_success_at
    ) VALUES (?, 'ok', ?, ?, 'fresh', 'none', 'good', NULL, ?, 0, NULL, NULL, ?)
    ON CONFLICT(source) DO UPDATE SET
      status = 'ok',
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at,
      freshness = excluded.freshness,
      adjustment = excluded.adjustment,
      quality = excluded.quality,
      detail = NULL,
      expires_at = excluded.expires_at,
      consecutive_failures = 0,
      paused_until = NULL,
      last_error_code = NULL,
      last_success_at = excluded.last_success_at
  `).bind(source, asOf, asOf, expiresAt, asOf).run();
}
