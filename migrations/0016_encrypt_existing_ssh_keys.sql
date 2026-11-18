-- migrations/0016_encrypt_existing_ssh_keys.sql
-- Data migration: Encrypt any existing plaintext SSH keys
-- This is a safety migration in case any deployments have unencrypted keys

-- NOTE: This migration is handled in code, not SQL, because encryption requires
-- the cipher key which is not available in SQL context.
-- See scripts/migrate-encrypt-ssh-keys.ts for the implementation.

-- This file serves as documentation that the migration step exists.
