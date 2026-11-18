-- migrations/0031_add_max_price_multiplier.sql
-- Max price as multiple of cheapest catalog price (region filtering + cloud-level bid cap)

ALTER TABLE deployments ADD COLUMN max_price_multiplier REAL;
