-- Why a terminal workload's cleanup is still pending. The cleanup lane writes
-- the last failed attempt's reason here (bounded, secrets redacted) and clears
-- it when cleanup completes; `anycloud status` shows it as "Cleanup pending".
-- Until now only the API log knew (F run 6: NamespaceDeletionDiscoveryFailure).
ALTER TABLE workloads ADD COLUMN cleanup_error TEXT;
