ALTER TABLE evidence_packets
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy'
  CHECK (scope IN ('legacy', 'profile', 'adhoc', 'global'));
ALTER TABLE evidence_packets ADD COLUMN profile_id TEXT;
ALTER TABLE evidence_packets ADD COLUMN request_id TEXT;
ALTER TABLE evidence_packets ADD COLUMN slot_id TEXT;
ALTER TABLE evidence_packets ADD COLUMN run_id TEXT;

UPDATE evidence_packets
SET scope = 'legacy'
WHERE scope IS NULL OR scope = '';

CREATE INDEX IF NOT EXISTS idx_evidence_packets_scope_profile_symbol_as_of
  ON evidence_packets (scope, profile_id, symbol, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_packets_scope_request_symbol_as_of
  ON evidence_packets (scope, request_id, symbol, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_packets_slot_run
  ON evidence_packets (slot_id, run_id);

ALTER TABLE report_manifests
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy'
  CHECK (scope IN ('legacy', 'profile', 'adhoc', 'global'));
ALTER TABLE report_manifests ADD COLUMN profile_id TEXT;
ALTER TABLE report_manifests ADD COLUMN request_id TEXT;
ALTER TABLE report_manifests ADD COLUMN slot_id TEXT;
ALTER TABLE report_manifests ADD COLUMN run_id TEXT;

UPDATE report_manifests
SET scope = 'legacy'
WHERE scope IS NULL OR scope = '';

CREATE INDEX IF NOT EXISTS idx_report_manifests_scope_profile_report
  ON report_manifests (scope, profile_id, report);
CREATE INDEX IF NOT EXISTS idx_report_manifests_scope_request_report
  ON report_manifests (scope, request_id, report);
CREATE INDEX IF NOT EXISTS idx_report_manifests_slot_run
  ON report_manifests (slot_id, run_id);
