-- S12: a replica's claim capacity counts its own attempts, not every
-- Job of its Deployment.
CREATE INDEX idx_pod_attempts_pod_uid ON pod_attempts(pod_uid);
