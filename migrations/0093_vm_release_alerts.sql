-- One aggregate receipt debounces delayed-release alerts across every affected
-- deployment. Rebuild the constrained scheduled-receipt table to admit it while
-- preserving the two receipts written by older releases.
BEGIN TRANSACTION;

CREATE TABLE notification_receipts_new (
  kind TEXT NOT NULL PRIMARY KEY CHECK (
    kind IN ('digest', 'release', 'vm-release-alert')
  ),
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO notification_receipts_new (kind, value, updated_at)
SELECT kind, value, updated_at FROM notification_receipts;

DROP TABLE notification_receipts;
ALTER TABLE notification_receipts_new RENAME TO notification_receipts;

CREATE INDEX idx_vms_release_overdue
  ON vms(removal_requested_at, deployment_id, id)
  WHERE deployment_id IS NOT NULL
    AND ended_at IS NULL
    AND removal_requested_at IS NOT NULL;

COMMIT;
