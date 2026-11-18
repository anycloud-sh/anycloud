-- A node pool Service's public endpoint: the entry IP its DNS record was last
-- published at, whether that record is current, and why it is not. The record
-- id itself stays in dns_record_id (the cleanup key shared with VM-host
-- Services); these columns let the controller re-point the record when the
-- pool's ingress entry changes and let status say `stale` when it could not.

ALTER TABLE workloads ADD COLUMN public_endpoint_ip TEXT;
ALTER TABLE workloads ADD COLUMN public_endpoint_state TEXT
  CHECK (public_endpoint_state IN ('published', 'repointing', 'stale'));
ALTER TABLE workloads ADD COLUMN public_endpoint_error TEXT;
