ALTER TABLE scheduled_slots
  ADD COLUMN lease_until TEXT;

ALTER TABLE scheduled_slots
  ADD COLUMN next_attempt_at TEXT;

UPDATE scheduled_slots
SET next_attempt_at = COALESCE(updated_at, scheduled_for)
WHERE status = 'failed' AND next_attempt_at IS NULL;

UPDATE scheduled_slots
SET lease_until = COALESCE(updated_at, claimed_at, scheduled_for, '1970-01-01T00:00:00.000Z')
WHERE status = 'claimed' AND lease_until IS NULL;
