const MAX_ATTEMPTS = 3;

function expiryFrom(date) {
  return new Date(date.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

export async function claimScheduledSlot(db, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  const timestamp = now.toISOString();
  const row = await db.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, claimed_at,
      expires_at, attempt_count, last_error_code, updated_at
    )
    VALUES (?, ?, ?, ?, 'claimed', ?, ?, 1, NULL, ?)
    ON CONFLICT
    DO UPDATE SET
      status = 'claimed',
      claimed_at = excluded.claimed_at,
      attempt_count = scheduled_slots.attempt_count + 1,
      last_error_code = NULL,
      updated_at = excluded.updated_at
    WHERE scheduled_slots.status = 'failed'
      AND scheduled_slots.attempt_count < ?
    RETURNING id, profile_id, slot_type, scheduled_for, status, attempt_count
  `).bind(
    input.id,
    input.profileId,
    input.slotType,
    input.scheduledFor,
    timestamp,
    expiryFrom(now),
    timestamp,
    MAX_ATTEMPTS,
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
  const result = await db.prepare(`
    UPDATE scheduled_slots
    SET status = ?,
        completed_at = ?,
        last_error_code = ?,
        updated_at = ?
    WHERE id = ? AND status = 'claimed'
  `).bind(
    input.status,
    input.status === "failed" ? null : timestamp,
    input.errorCode ?? null,
    timestamp,
    input.id,
  ).run();
  return { changed: Number(result?.meta?.changes ?? 0) };
}
