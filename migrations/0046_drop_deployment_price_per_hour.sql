-- price_per_hour moved from deployments to vms (see 0045). On `deployments`
-- the column was written at submit time, gated on region being known — so
-- for region-less submits (multi-region failover) it was always NULL and
-- broke `anycloud cost`. The vms column writes inside the existing addVM
-- INSERT, where the resolved region is in scope, so the column on
-- `deployments` is now dead. SQLite >= 3.35 supports DROP COLUMN.
ALTER TABLE deployments DROP COLUMN price_per_hour;
