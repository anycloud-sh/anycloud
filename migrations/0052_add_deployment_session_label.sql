-- migrations/0052_add_deployment_session_label.sql
-- Human-readable display label for an agent session (e.g. the Claude Code
-- session title). Captured in the CLI at insert, never mutated. Attribution,
-- scoping and spend caps all still key on `session` (migration 0047) — this is
-- never a scoping or cap key. It IS read for display filtering, though: the
-- typed `--session` label match and the `-f/--filter` substring search in
-- listDeployments match against it. No index by design — those filters only run
-- inside the per-user, LIMIT-bounded list scan, where a substring match on this
-- column adds no cost an index could remove.

ALTER TABLE deployments ADD COLUMN session_label TEXT;
