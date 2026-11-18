ALTER TABLE deployments ADD COLUMN readiness_probe TEXT
  CHECK (readiness_probe IS NULL OR (json_valid(readiness_probe) AND json_type(readiness_probe) = 'object'));
