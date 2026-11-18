-- The checkpoint publication and writer-handoff protocol is removed by
-- owner decision D0 of 2026-09-25: Services on node pools get rclone bucket
-- sync parity with VM-host Services, and the API's own state is backed up by a
-- database-backup routine. No consumer ever created a root, so these tables
-- hold nothing in a released installation; a populated pre-release database
-- loses only the protocol's ledger. Migrations 0109, 0112 and 0114 stay as
-- history. Dependents first: cleanups, writers and generations reference
-- operations and roots; operations reference roots. Dropping a table drops its
-- indexes with it.

DROP TABLE IF EXISTS checkpoint_cleanups;
DROP TABLE IF EXISTS checkpoint_writers;
DROP TABLE IF EXISTS checkpoint_generations;
DROP TABLE IF EXISTS checkpoint_operations;
DROP TABLE IF EXISTS checkpoint_roots;
