CREATE TABLE IF NOT EXISTS fund_flows (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  flow_type TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT '1d',
  ts TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  currency TEXT,
  source TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'reported',
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  freshness TEXT NOT NULL,
  adjustment TEXT NOT NULL DEFAULT 'none',
  quality TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (profile_id, symbol, flow_type, period, ts, source, adjustment)
);

CREATE INDEX IF NOT EXISTS idx_fund_flows_symbol_type_period_ts
  ON fund_flows (symbol, flow_type, period, ts DESC);

CREATE INDEX IF NOT EXISTS idx_fund_flows_profile_ts
  ON fund_flows (profile_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_fund_flows_expires_at
  ON fund_flows (expires_at);
