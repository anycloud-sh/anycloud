-- migrations/0050_add_spend_block_alerts.sql
-- Append-only log of spend-cap block notifications the provisioning scheduler
-- has already sent, so it can debounce: at most one notification per cap per
-- cooldown window while a throttle/budget keeps blocking dispatch.
--
-- Keyed by cap, not deployment — many queued jobs trip the same cap in one
-- scheduler tick, but the user should get a single "deployments paused"
-- message. Budget rows include the calendar reset boundary so each new
-- day/week/month window gets its own first alert. Insert-only: the cooldown is
-- a latest-sent lookup, and the table doubles as an audit trail of when caps
-- started biting.

CREATE TABLE spend_block_alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('throttle', 'budget')),
  scope TEXT NOT NULL CHECK (scope IN ('account', 'agent-session')),
  session_id TEXT,
  period TEXT CHECK (period IN ('day', 'week', 'month') OR period IS NULL),
  window_reset_at INTEGER,
  sent_at INTEGER NOT NULL,
  CHECK (
    (scope = 'agent-session' AND session_id IS NOT NULL)
    OR (scope = 'account' AND session_id IS NULL)
  ),
  CHECK (
    (kind = 'budget' AND period IS NOT NULL AND window_reset_at IS NOT NULL)
    OR (kind = 'throttle' AND period IS NULL AND window_reset_at IS NULL)
  )
);

CREATE INDEX idx_spend_block_alerts_lookup ON spend_block_alerts (
  kind,
  scope,
  session_id,
  period,
  window_reset_at,
  sent_at DESC
);
