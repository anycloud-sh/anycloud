-- Normalize compute credentials to the pinned-or-unpinned shape.
--
-- deployments.credential_id is a nullable scalar:
--   NULL      => unpinned compute credential
--   scalar id => pinned compute credential
--
-- Legacy JSON-array credential ids represented ordered fallback lists. Those
-- lists no longer have fallback semantics, so preserve the deployment by
-- converting them to unpinned compute.

UPDATE deployments
SET credential_id = NULL
WHERE credential_id = ''
   OR CASE
     WHEN credential_id IS NOT NULL AND json_valid(credential_id)
       THEN json_type(credential_id) = 'array'
     ELSE 0
   END;
