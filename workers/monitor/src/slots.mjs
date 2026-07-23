const MAX_ATTEMPTS = 3;
const LEASE_MS = 4 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

function expiryFrom(date) {
  return new Date(date.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

export async function claimScheduledSlot(db, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  const timestamp = now.toISOString();
  const row = await db.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, claimed_at,
      expires_at, attempt_count, last_error_code, updated_at,
      lease_until, next_attempt_at
    )
    VALUES (?, ?, ?, ?, 'claimed', ?, ?, 1, NULL, ?, ?, NULL)
    ON CONFLICT
    DO UPDATE SET
      status = 'claimed',
      claimed_at = excluded.claimed_at,
      attempt_count = scheduled_slots.attempt_count + 1,
      last_error_code = NULL,
      updated_at = excluded.updated_at,
      lease_until = excluded.lease_until,
      next_attempt_at = NULL
    WHERE scheduled_slots.attempt_count < ?
      AND (
        (
          scheduled_slots.status = 'failed'
          AND scheduled_slots.next_attempt_at <= ?
        )
        OR (
          scheduled_slots.status = 'claimed'
          AND scheduled_slots.lease_until <= ?
        )
      )
    RETURNING id, profile_id, slot_type, scheduled_for, status, attempt_count
  `).bind(
    input.id,
    input.profileId,
    input.slotType,
    input.scheduledFor,
    timestamp,
    expiryFrom(now),
    timestamp,
    new Date(now.valueOf() + LEASE_MS).toISOString(),
    MAX_ATTEMPTS,
    timestamp,
    timestamp,
  ).first();
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    slotType: row.slot_type,
    scheduledFor: row.scheduled_for,
    status: row.status,
    attemptCount: row.attempt_count,
  };
}

export async function finishScheduledSlot(db, input) {
  const allowed = new Set(["completed", "failed", "deferred"]);
  if (!allowed.has(input.status)) {
    throw new Error("INVALID_SLOT_STATUS");
  }
  const now = input.now instanceof Date ? input.now : new Date(input.now);
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

export async function listRetryableSlots(db, now) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(`
    SELECT id, profile_id, slot_type, scheduled_for, status, attempt_count
    FROM scheduled_slots
    WHERE attempt_count < ?
      AND (
        (status = 'failed' AND next_attempt_at <= ?)
        OR (status = 'claimed' AND lease_until <= ?)
      )
    ORDER BY scheduled_for ASC
  `).bind(MAX_ATTEMPTS, timestamp, timestamp).all();
  return result?.results ?? [];
}
