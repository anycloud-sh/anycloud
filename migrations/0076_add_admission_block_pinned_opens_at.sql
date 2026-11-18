-- Pinned-region reads use a shorter reopen time for capacity blocks (the
-- one-minute pinned cooldown) than unpinned reads. Persist both times per row
-- so the reader picks by pin mode. Backfill existing rows to the standard time
ALTER TABLE admission_blocks ADD COLUMN pinned_opens_at INTEGER;

UPDATE admission_blocks SET pinned_opens_at = opens_at WHERE pinned_opens_at IS NULL;
