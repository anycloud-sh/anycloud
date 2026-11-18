-- Drop both unguarded definitions before repairing malformed legacy metadata;
-- either old index would evaluate json_extract while the row is updated.
DROP INDEX IF EXISTS idx_events_resubmit;
DROP INDEX IF EXISTS idx_events_resubmit_created_at;

-- Unreadable metadata cannot be exposed or queried safely. Treat it as absent
-- so ordinary event readers remain usable after upgrading a legacy database.
UPDATE deployment_events
SET metadata = NULL
WHERE metadata IS NOT NULL
  AND NOT json_valid(metadata);

CREATE INDEX IF NOT EXISTS idx_events_resubmit
  ON deployment_events(deployment_id)
  WHERE json_valid(metadata)
    AND json_extract(metadata, '$.reason') = 'resubmitted';

CREATE INDEX IF NOT EXISTS idx_events_resubmit_created_at
  ON deployment_events(created_at, deployment_id)
  WHERE json_valid(metadata)
    AND json_extract(metadata, '$.reason') = 'resubmitted';
