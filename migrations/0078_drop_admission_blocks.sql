-- Provisioning failures are retried reactively and target rotation is scoped
-- to each deployment's event history. Shared time-based admission state is no
-- longer read or written.
DROP TABLE IF EXISTS admission_blocks;
