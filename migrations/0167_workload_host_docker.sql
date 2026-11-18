-- A VM Job's `--host-docker`: the host's Docker socket and, with nesting,
-- `/dev/kvm`, instead of `--privileged`.
ALTER TABLE workloads ADD COLUMN host_docker INTEGER NOT NULL DEFAULT 0;
