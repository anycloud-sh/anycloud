-- Add last_checked timestamp to track preemption monitor health
-- Updated every time the monitor checks a deployment (even if no preemption found)
-- NULL = never checked, stale timestamp = monitor may be dead

ALTER TABLE deployments ADD COLUMN last_checked INTEGER;
