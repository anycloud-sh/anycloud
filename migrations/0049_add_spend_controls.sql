-- migrations/0049_add_spend_controls.sql
-- Spend controls: throttle (sliding 1h rate cap) and budget (calendar-window
-- cap, day/week/month). Both enforced at the provisioning scheduler. Over-cap
-- queued deployments stay Queued with a block reason in metadata.message
-- until the cap clears (window slides, calendar rolls, user raises, or spend
-- drops as running jobs finish).
--
-- scope is stored as a string ('account' or 'agent-session') so new scope
-- types can be added without a schema migration. Budgets key by
-- (period, scope) so one day + one week + one month cap can coexist per
-- scope.

CREATE TABLE throttles (
  scope TEXT NOT NULL,
  cap_usd INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope)
);

CREATE TABLE budgets (
  period TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'account',
  cap_usd INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (period, scope)
);
