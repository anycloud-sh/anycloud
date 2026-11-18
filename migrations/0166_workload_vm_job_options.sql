-- A VM Job's `--no-checkpoint`: a Spot Job gets no managed checkpoint bucket.
ALTER TABLE workloads ADD COLUMN no_checkpoint INTEGER NOT NULL DEFAULT 0;
-- A VM Job's `--require-nested-virtualization`: GCP launches it with KVM on.
ALTER TABLE workloads ADD COLUMN require_nested_virtualization INTEGER NOT NULL DEFAULT 0;
