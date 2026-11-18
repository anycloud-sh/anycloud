-- migrations/0047_add_deployment_session.sql
-- Caller-supplied attribution: a free-form session id and an agent name,
-- auto-derived in the CLI from the calling process (Claude Code / Codex /
-- Cursor / Aider). Set at insert, never mutated. Anycloud does not interpret
-- these — caps and identity issuance live in a layer above (cooperative
-- model). Partial indexes so pre-migration rows cost nothing.

ALTER TABLE deployments ADD COLUMN session TEXT;
ALTER TABLE deployments ADD COLUMN agent TEXT;

CREATE INDEX idx_deployments_session ON deployments(session) WHERE session IS NOT NULL;
CREATE INDEX idx_deployments_agent ON deployments(agent) WHERE agent IS NOT NULL;
