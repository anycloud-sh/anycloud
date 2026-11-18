-- RFC 0049 C15: why a workload ended, as a stable enum beside its terminal
-- state, and what ended the final attempt when the retry budget ran out.
ALTER TABLE workloads ADD COLUMN end_reason TEXT;
ALTER TABLE workloads ADD COLUMN last_attempt_end_reason TEXT;

