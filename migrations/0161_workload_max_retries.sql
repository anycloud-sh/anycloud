-- RFC 0049 C3: a Job's own cap on automatic retries after a disruption or a
-- runner exit (`--max-retries`). NULL keeps the system's budgets alone.
ALTER TABLE workloads ADD COLUMN max_retries INTEGER;
