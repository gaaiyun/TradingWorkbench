ALTER TABLE scheduled_slots
  ADD COLUMN profile_revision TEXT NOT NULL DEFAULT '';

ALTER TABLE scheduled_slots
  ADD COLUMN payload_json TEXT NOT NULL DEFAULT '';

ALTER TABLE scheduled_slots
  ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE scheduled_slots
  ADD COLUMN local_date TEXT NOT NULL DEFAULT '';

UPDATE scheduled_slots
SET profile_revision = 'legacy-cancelled',
    payload_json = '{"version":1,"migration":"legacy-slot-unavailable"}',
    payload_hash = 'legacy:' || id,
    local_date = substr(scheduled_for, 1, 10)
WHERE profile_revision = ''
   OR payload_json = ''
   OR payload_hash = ''
   OR local_date = '';

UPDATE scheduled_slots
SET status = 'cancelled',
    completed_at = COALESCE(
      completed_at,
      updated_at,
      claimed_at,
      scheduled_for
    ),
    last_error_code = 'LEGACY_SLOT_PAYLOAD_UNAVAILABLE',
    updated_at = COALESCE(updated_at, claimed_at, scheduled_for),
    lease_until = NULL,
    next_attempt_at = NULL
WHERE status IN ('pending', 'queued', 'failed', 'claimed');

CREATE TRIGGER IF NOT EXISTS scheduled_slots_immutable_payload
BEFORE UPDATE OF profile_revision, payload_json, payload_hash ON scheduled_slots
WHEN OLD.profile_revision <> NEW.profile_revision
  OR OLD.payload_json <> NEW.payload_json
  OR OLD.payload_hash <> NEW.payload_hash
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_SLOT_PAYLOAD');
END;

CREATE INDEX IF NOT EXISTS idx_scheduled_slots_ready
  ON scheduled_slots (status, next_attempt_at, scheduled_for);

CREATE TABLE IF NOT EXISTS full_analysis_reservations (
  slot_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  UNIQUE (profile_id, local_date, slot_id),
  FOREIGN KEY (slot_id) REFERENCES scheduled_slots(id)
);

CREATE INDEX IF NOT EXISTS idx_full_analysis_daily
  ON full_analysis_reservations (profile_id, local_date);

CREATE TABLE IF NOT EXISTS github_dispatch_outbox (
  slot_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  post_attempt_count INTEGER NOT NULL DEFAULT 0,
  lookup_attempt_count INTEGER NOT NULL DEFAULT 0,
  external_run_id INTEGER,
  external_run_url TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES scheduled_slots(id)
);

CREATE INDEX IF NOT EXISTS idx_github_dispatch_outbox_status
  ON github_dispatch_outbox (status, updated_at);

CREATE TABLE IF NOT EXISTS github_dispatch_receipts (
  slot_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  external_run_id INTEGER,
  external_run_url TEXT,
  accepted_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES scheduled_slots(id)
);

CREATE TABLE IF NOT EXISTS monitor_bootstrap_targets (
  profile_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (
    profile_id, symbol, timeframe, schema_version, target_hash
  )
);

CREATE TABLE IF NOT EXISTS monitor_scheduler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rotation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_news_provider_health (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('ok', 'degraded', 'unavailable')
  ),
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monitor_news_provider_health_updated
  ON monitor_news_provider_health (updated_at DESC);
