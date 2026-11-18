-- A VM Job's region allow-list (`--regions`): the regions it may launch in,
-- as a JSON string array, instead of one pinned region.
ALTER TABLE workloads ADD COLUMN regions TEXT;
