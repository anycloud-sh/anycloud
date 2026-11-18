-- A cluster created from a bucket that already holds a hosted API backup.
-- Bootstrap renders the chart's restore initContainer from this, which fills
-- the new API's state volume before its first start; it is recorded once so a
-- resumed bootstrap does not re-read a bucket the new API has since written.
ALTER TABLE clusters ADD COLUMN restore_from_backup INTEGER NOT NULL DEFAULT 0
  CHECK (restore_from_backup IN (0, 1));
