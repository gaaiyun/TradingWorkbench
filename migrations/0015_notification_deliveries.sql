ALTER TABLE market_events
  ADD COLUMN provider TEXT;

ALTER TABLE market_events
  ADD COLUMN provider_as_of TEXT;

ALTER TABLE market_events
  ADD COLUMN provider_quality TEXT;

ALTER TABLE market_events
  ADD COLUMN rule_version TEXT;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'pushPlus')),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'deferred',
      'sending',
      'sent',
      'failed',
      'uncertain',
      'skipped'
    )
  ),
  policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json)),
  reason_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, channel),
  FOREIGN KEY (event_id) REFERENCES market_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_profile_updated
  ON notification_deliveries (profile_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_ready
  ON notification_deliveries (status, next_attempt_at, updated_at);
