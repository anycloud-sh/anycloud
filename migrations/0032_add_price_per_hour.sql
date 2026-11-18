-- Store hourly price at deploy time for cost estimation
ALTER TABLE deployments ADD COLUMN price_per_hour REAL;
