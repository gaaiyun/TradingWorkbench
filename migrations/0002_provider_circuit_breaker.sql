ALTER TABLE source_health
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE source_health
  ADD COLUMN paused_until TEXT;

ALTER TABLE source_health
  ADD COLUMN last_error_code TEXT;

ALTER TABLE source_health
  ADD COLUMN last_success_at TEXT;

CREATE INDEX IF NOT EXISTS idx_source_health_paused_until
  ON source_health (paused_until);
