ALTER TABLE scheduled_slots
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduled_slots
  ADD COLUMN last_error_code TEXT;

ALTER TABLE scheduled_slots
  ADD COLUMN updated_at TEXT;
