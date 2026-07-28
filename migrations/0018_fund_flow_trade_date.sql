ALTER TABLE fund_flows ADD COLUMN trade_date TEXT;

UPDATE fund_flows
SET trade_date = date(datetime(ts, '+8 hours'))
WHERE period = '1d'
  AND trade_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_fund_flows_symbol_type_period_trade_date
  ON fund_flows (symbol, flow_type, period, trade_date DESC);
