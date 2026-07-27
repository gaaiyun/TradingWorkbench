CREATE TABLE IF NOT EXISTS deployment_metadata (
  service TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  branch TEXT NOT NULL,
  url TEXT,
  updated_at TEXT NOT NULL,
  CHECK (service IN ('pages-functions')),
  CHECK (length(commit_sha) BETWEEN 7 AND 64),
  CHECK (length(branch) BETWEEN 1 AND 128)
);
