-- Notification channel configuration and delivery receipts.
--
-- Both previously lived as files under the API process home directory, which
-- only survives on a local API because that directory is bind-mounted into the
-- container. A hosted API keeps its durable state in the checkpoint mount, so
-- the files landed on the ephemeral container layer and were destroyed by every
-- upgrade -- leaving notifications configured but permanently unable to send.
-- Storing both here puts them in the same database as every other durable
-- setting.
--
-- notification_channels is keyed by channel so a second channel is a row rather
-- than another migration. The config payload is encrypted at rest with the same
-- key as secrets and credentials, because a Slack webhook is a bearer token.
CREATE TABLE notification_channels (
  channel TEXT PRIMARY KEY,
  encrypted_config TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Dedup state for the notifications that fire on a schedule rather than on an
-- event. 'digest' holds the UTC date label of the last daily digest posted, and
-- 'release' holds the last release version announced. Both are last-write-wins
-- single rows, unlike spend_block_alerts, which is an append-only audit trail.
CREATE TABLE notification_receipts (
  kind TEXT NOT NULL PRIMARY KEY CHECK (kind IN ('digest', 'release')),
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
