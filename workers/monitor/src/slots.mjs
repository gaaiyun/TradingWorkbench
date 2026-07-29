const MAX_ATTEMPTS = 3;
const LEASE_MS = 4 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function expiryFrom(date) {
  return new Date(date.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

function legacySnapshot(input) {
  return {
    profileRevision: input.profileRevision ?? "legacy",
    payloadJson: input.payloadJson ?? JSON.stringify({
      version: 1,
      profile: { id: input.profileId },
      task: {
        type: input.slotType,
        scheduledFor: input.scheduledFor,
      },
    }),
    payloadHash: input.payloadHash ?? `legacy:${input.id}`,
    localDate: input.localDate ?? String(input.scheduledFor || "").slice(0, 10),
  };
}

function claimedSlot(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!payload?.profile || !payload?.task) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    slotType: row.slot_type,
    scheduledFor: row.scheduled_for,
    status: row.status,
    attemptCount: row.attempt_count,
    profileRevision: row.profile_revision,
    payloadHash: row.payload_hash,
    localDate: row.local_date,
    profile: payload.profile,
    task: payload.task,
  };
}

export async function stageScheduledSlot(db, input) {
  const now = asDate(input.now);
  const timestamp = now.toISOString();
  const snapshot = legacySnapshot(input);
  const row = await db.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, claimed_at,
      expires_at, attempt_count, last_error_code, updated_at,
      lease_until, next_attempt_at, profile_revision, payload_json,
      payload_hash, local_date
    )
    VALUES (
      ?, ?, ?, ?, 'pending', NULL, ?, 0, NULL, ?, NULL, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT DO NOTHING
    RETURNING id, profile_id, slot_type, scheduled_for, status,
      attempt_count, profile_revision, payload_json, payload_hash, local_date
  `).bind(
    input.id,
    input.profileId,
    input.slotType,
    input.scheduledFor,
    expiryFrom(now),
    timestamp,
    timestamp,
    snapshot.profileRevision,
    snapshot.payloadJson,
    snapshot.payloadHash,
    snapshot.localDate,
  ).first();
  return row ? claimedSlot(row) : null;
}

export async function stageScheduledSlots(db, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return { staged: 0 };
  if (typeof db.batch !== "function") {
    let staged = 0;
    for (const input of inputs) {
      if (await stageScheduledSlot(db, input)) staged += 1;
    }
    return { staged };
  }
  const statements = inputs.map((input) => {
    const now = asDate(input.now);
    const timestamp = now.toISOString();
    const snapshot = legacySnapshot(input);
    return db.prepare(`
      INSERT INTO scheduled_slots (
        id, profile_id, slot_type, scheduled_for, status, claimed_at,
        expires_at, attempt_count, last_error_code, updated_at,
        lease_until, next_attempt_at, profile_revision, payload_json,
        payload_hash, local_date
      )
      VALUES (
        ?, ?, ?, ?, 'pending', NULL, ?, 0, NULL, ?, NULL, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT DO NOTHING
    `).bind(
      input.id,
      input.profileId,
      input.slotType,
      input.scheduledFor,
      expiryFrom(now),
      timestamp,
      timestamp,
      snapshot.profileRevision,
      snapshot.payloadJson,
      snapshot.payloadHash,
      snapshot.localDate,
    );
  });
  const results = await db.batch(statements);
  return {
    staged: results.reduce(
      (count, result) => count + Number(result?.meta?.changes ?? 0),
      0,
    ),
  };
}

export async function claimScheduledSlot(db, input) {
  const now = asDate(input.now);
  const timestamp = now.toISOString();
  const snapshot = legacySnapshot(input);
  if (input.profileId) {
    await stageScheduledSlot(db, {
      ...input,
      ...snapshot,
      now,
    });
  }
  const row = await db.prepare(`
    UPDATE scheduled_slots
    SET status = 'claimed',
        claimed_at = ?,
        attempt_count = attempt_count + 1,
        last_error_code = NULL,
        updated_at = ?,
        lease_until = ?,
        next_attempt_at = NULL
    WHERE id = ?
      AND payload_hash = ?
      AND attempt_count < ?
      AND (
        status = 'pending'
        OR status = 'queued'
        OR (
          status = 'failed'
          AND next_attempt_at <= ?
        )
        OR (
          status = 'claimed'
          AND lease_until <= ?
        )
      )
    RETURNING id, profile_id, slot_type, scheduled_for, status,
      attempt_count, profile_revision, payload_json, payload_hash, local_date
  `).bind(
    timestamp,
    timestamp,
    new Date(now.valueOf() + LEASE_MS).toISOString(),
    input.id,
    snapshot.payloadHash,
    MAX_ATTEMPTS,
    timestamp,
    timestamp,
  ).first();
  return row ? claimedSlot(row) : null;
}

export async function finishScheduledSlot(db, input) {
  const allowed = new Set(["completed", "failed", "deferred"]);
  if (!allowed.has(input.status)) {
    throw new Error("INVALID_SLOT_STATUS");
  }
  const now = asDate(input.now);
  const timestamp = now.toISOString();
  const nextAttemptAt = input.status === "failed"
    ? new Date(now.valueOf() + RETRY_DELAY_MS).toISOString()
    : null;
  const result = await db.prepare(`
    UPDATE scheduled_slots
    SET status = ?,
        completed_at = ?,
        last_error_code = ?,
        updated_at = ?,
        lease_until = NULL,
        next_attempt_at = ?
    WHERE id = ?
      AND status = 'claimed'
      AND attempt_count = ?
  `).bind(
    input.status,
    input.status === "failed" ? null : timestamp,
    input.errorCode ?? null,
    timestamp,
    nextAttemptAt,
    input.id,
    input.attemptCount,
  ).run();
  return { changed: Number(result?.meta?.changes ?? 0) };
}

export async function listRetryableSlots(db, now, limit = 100) {
  const timestamp = asDate(now).toISOString();
  const result = await db.prepare(`
    WITH ready AS (
      SELECT id, profile_id, slot_type, scheduled_for, status, attempt_count,
        profile_revision, payload_json, payload_hash, local_date,
        CASE
          WHEN slot_type IN (
            'intradayCollect', 'usIntradayCollect',
            'cnDailySnapshot', 'usCloseSnapshot'
          ) THEN 0
          WHEN slot_type = 'intradaySignal' THEN 1
          WHEN slot_type IN ('closeFullAnalysis', 'premarketBrief') THEN 2
          WHEN slot_type = 'newsCollect' THEN 3
          ELSE 4
        END AS task_priority
      FROM scheduled_slots
      WHERE attempt_count < ?
        AND (
          (
            status IN ('pending', 'queued', 'failed')
            AND next_attempt_at <= ?
          )
          OR (
            status = 'claimed'
            AND lease_until <= ?
          )
        )
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY profile_id
          ORDER BY task_priority ASC, scheduled_for ASC, id ASC
        ) AS profile_rank
      FROM ready
    )
    SELECT id, profile_id, slot_type, scheduled_for, status, attempt_count,
      profile_revision, payload_json, payload_hash, local_date
    FROM ranked
    ORDER BY profile_rank ASC, task_priority ASC, scheduled_for ASC,
      profile_id ASC, id ASC
    LIMIT ?
  `).bind(MAX_ATTEMPTS, timestamp, timestamp, Math.max(1, Number(limit))).all();
  return result?.results ?? [];
}

export async function cancelSupersededScheduledSlots(db, now) {
  const timestamp = asDate(now).toISOString();
  const result = await db.prepare(`
    UPDATE scheduled_slots AS current
    SET status = 'cancelled',
        completed_at = ?,
        last_error_code = 'SUPERSEDED_BY_NEWER_SLOT',
        updated_at = ?,
        lease_until = NULL,
        next_attempt_at = NULL
    WHERE current.slot_type IN (
        'intradayCollect', 'intradaySignal', 'newsCollect', 'usIntradayCollect'
      )
      AND (
        current.status IN ('pending', 'queued', 'failed')
        OR (
          current.status = 'claimed'
          AND current.lease_until <= ?
        )
      )
      AND EXISTS (
        SELECT 1
        FROM scheduled_slots AS newer
        WHERE newer.profile_id = current.profile_id
          AND newer.slot_type = current.slot_type
          AND newer.scheduled_for > current.scheduled_for
          AND (
            julianday(newer.scheduled_for)
            - julianday(current.scheduled_for)
          ) * 1440 >= 15
          AND newer.status != 'cancelled'
      )
  `).bind(timestamp, timestamp, timestamp).run();
  return { changed: Number(result?.meta?.changes ?? 0) };
}

export async function finalizeExhaustedScheduledSlots(db, now) {
  const timestamp = asDate(now).toISOString();
  const result = await db.prepare(`
    UPDATE scheduled_slots
    SET status = 'cancelled',
        completed_at = ?,
        last_error_code = 'RETRY_EXHAUSTED',
        updated_at = ?,
        lease_until = NULL,
        next_attempt_at = NULL
    WHERE attempt_count >= ?
      AND (
        status = 'failed'
        OR (
          status = 'claimed'
          AND lease_until <= ?
        )
      )
  `).bind(timestamp, timestamp, MAX_ATTEMPTS, timestamp).run();
  return { changed: Number(result?.meta?.changes ?? 0) };
}

export async function countScheduledBacklog(db, now) {
  const timestamp = asDate(now).toISOString();
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM scheduled_slots
    WHERE attempt_count < ?
      AND (
        (
          status IN ('pending', 'queued', 'failed')
          AND next_attempt_at <= ?
        )
        OR (
          status = 'claimed'
          AND lease_until <= ?
        )
      )
  `).bind(MAX_ATTEMPTS, timestamp, timestamp).first();
  return Number(row?.count ?? 0);
}

export async function markScheduledSlotsQueued(db, slots, now) {
  if (!Array.isArray(slots) || slots.length === 0) return { changed: 0 };
  const timestamp = asDate(now).toISOString();
  const nextAttemptAt = new Date(
    asDate(now).valueOf() + RETRY_DELAY_MS,
  ).toISOString();
  let changed = 0;
  for (const slot of slots) {
    const result = await db.prepare(`
      UPDATE scheduled_slots
      SET status = 'queued',
          updated_at = ?,
          next_attempt_at = ?
      WHERE id = ?
        AND payload_hash = ?
        AND status IN ('pending', 'queued', 'failed')
    `).bind(timestamp, nextAttemptAt, slot.id, slot.payload_hash).run();
    changed += Number(result?.meta?.changes ?? 0);
  }
  return { changed };
}

export async function cancelStaleScheduledSlots(db, profiles, now) {
  const timestamp = asDate(now).toISOString();
  const rows = await db.prepare(`
    SELECT id, profile_id, profile_revision
    FROM scheduled_slots
    WHERE status IN ('pending', 'queued', 'failed')
      OR (status = 'claimed' AND lease_until <= ?)
  `).bind(timestamp).all();
  let changed = 0;
  for (const row of rows?.results ?? []) {
    const current = profiles.get(row.profile_id);
    const errorCode = !current
      ? "PROFILE_DELETED"
      : !current.enabled
        ? "PROFILE_DISABLED"
        : current.revision !== row.profile_revision
          ? "PROFILE_REVISED"
          : null;
    if (!errorCode) continue;
    const result = await db.prepare(`
      UPDATE scheduled_slots
      SET status = 'cancelled',
          completed_at = ?,
          last_error_code = ?,
          updated_at = ?,
          lease_until = NULL,
          next_attempt_at = NULL
      WHERE id = ?
        AND (
          status IN ('pending', 'queued', 'failed')
          OR (status = 'claimed' AND lease_until <= ?)
        )
    `).bind(timestamp, errorCode, timestamp, row.id, timestamp).run();
    changed += Number(result?.meta?.changes ?? 0);
  }
  return { changed };
}

export async function reserveFullAnalysisBudget(db, input) {
  const existing = await db.prepare(`
    SELECT slot_id
    FROM full_analysis_reservations
    WHERE slot_id = ?
      AND profile_id = ?
      AND local_date = ?
  `).bind(input.slotId, input.profileId, input.localDate).first();
  if (existing) {
    return { reserved: true, slotId: existing.slot_id, reused: true };
  }
  const limit = Math.max(0, Math.floor(Number(input.limit) || 0));
  if (limit === 0) {
    return { reserved: false, slotId: input.slotId, reused: false };
  }
  const row = await db.prepare(`
    INSERT INTO full_analysis_reservations (
      slot_id, profile_id, local_date, reserved_at
    )
    SELECT ?, ?, ?, ?
    WHERE (
      SELECT COUNT(*)
      FROM full_analysis_reservations
      WHERE profile_id = ?
        AND local_date = ?
    ) < ?
    ON CONFLICT(slot_id) DO NOTHING
    RETURNING slot_id
  `).bind(
    input.slotId,
    input.profileId,
    input.localDate,
    asDate(input.now).toISOString(),
    input.profileId,
    input.localDate,
    limit,
  ).first();
  return {
    reserved: Boolean(row),
    slotId: input.slotId,
    reused: false,
  };
}
