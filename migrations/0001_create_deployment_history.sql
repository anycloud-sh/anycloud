-- migrations/0001_create_deployment_history.sql
-- Deployment history tracking tables

-- Fast reads for listing/filtering
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  deployment_type TEXT NOT NULL,        -- 'job' | 'service'
  image TEXT NOT NULL,
  config_name TEXT,
  cloud_provider TEXT,                  -- 'aws' | 'azure' | 'gcp'
  region TEXT,
  vm_type TEXT,
  spot INTEGER DEFAULT 0,
  persist INTEGER DEFAULT 0,
  state TEXT NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_deployments_user ON deployments(user_id, started_at DESC);
CREATE INDEX idx_deployments_state ON deployments(user_id, state);

-- Append-only event log for debugging (replaces expiring deploy logs)
CREATE TABLE deployment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL,
  state TEXT NOT NULL,
  metadata TEXT,                        -- JSON for extra context
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);

CREATE INDEX idx_events_deployment ON deployment_events(deployment_id, created_at);
