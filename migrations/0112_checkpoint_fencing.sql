-- Provider fencing for checkpoint publication (slice 5). Numbered after ROOT's 0110 vms rebuild and the earlier 0111 installations migration.
--
-- grant_scope records how the operation's finalizer/verifier credentials were
-- scoped. Only 'prefix' (put-only, attempt-prefix-scoped, no DeleteObject)
-- lets a later cleanup retire this operation's generation: a bucket-wide or
-- unrecorded grant may still be held by a stale writer that can overwrite or
-- delete other generations.
ALTER TABLE checkpoint_operations ADD COLUMN grant_scope TEXT
  CHECK (grant_scope IS NULL OR grant_scope IN ('bucket', 'prefix'));

-- The provider observation that justified recording a writer as lost: exact
-- VM identity and the release status the resource-scoped gateway returned.
ALTER TABLE checkpoint_writers ADD COLUMN loss_evidence TEXT
  CHECK (loss_evidence IS NULL OR (json_valid(loss_evidence) AND json_type(loss_evidence) = 'object'));

-- The exact host the writer was admitted on (provider, cloud id, region,
-- zone, credential source). A loss observation must name this host; without
-- a recorded host the binding is the consumer's assertion and is marked so
-- in the evidence.
ALTER TABLE checkpoint_writers ADD COLUMN host_identity TEXT
  CHECK (host_identity IS NULL OR (json_valid(host_identity) AND json_type(host_identity) = 'object'));
