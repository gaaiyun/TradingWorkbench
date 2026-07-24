CREATE TABLE IF NOT EXISTS corporate_actions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  action_type TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  ratio REAL,
  source TEXT NOT NULL,
  as_of TEXT,
  fetched_at TEXT,
  quality TEXT NOT NULL DEFAULT 'good',
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_corporate_actions_symbol_ex_date
  ON corporate_actions (symbol, ex_date DESC);

CREATE TABLE IF NOT EXISTS evidence_packets (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  as_of TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_packets_symbol_as_of
  ON evidence_packets (symbol, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_packets_expires_at
  ON evidence_packets (expires_at);

CREATE TABLE IF NOT EXISTS report_manifests (
  report TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  trade_date TEXT,
  analysis_status TEXT NOT NULL,
  audit_status TEXT NOT NULL,
  evidence_hash TEXT,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_manifests_symbol_trade_date
  ON report_manifests (symbol, trade_date DESC);
