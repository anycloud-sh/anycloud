/** Encrypted credentials and named secrets, with their reference-guarded deletes. */
import type { CloudType } from '../../../shared/cloud.js';
import {
  CredentialChangedError,
  CredentialNameExistsError,
  CredentialsExistError,
} from '../../../shared/errors.js';
import { ACTIVE_STATES, WorkloadState } from '../../../shared/workload.js';
import { decryptSecret, encryptSecret } from '../secret-crypto.js';
import { secretRevision, type RuntimeSecret } from '../runtime-secrets.js';
import type { DB, DBTransaction } from './db.js';

// Row type for credentials table (snake_case matches database columns)
interface CredentialRow {
  id: string;
  encrypted_data: string;
  cloud_provider: CloudType;
  name: string | null;
  created_at: number;
  last_used_at: number;
  auth_failed_at?: number | null;
}

// Row type for secrets table (snake_case matches database columns)
interface SecretRow {
  name: string;
  encrypted_values: string;
  created_at: number;
  updated_at: number;
}

/**
 * Get or create credential (deduplication via hash)
 * Returns credential ID for use in workloads table. Admission-only, so it
 * stays off CredentialSecretStore and only the admission writer imports it.
 */
export async function upsertCredential(
  db: DB,
  credentialId: string,
  encryptedData: string,
  cloudProvider: CloudType,
): Promise<string> {
  const now = Date.now();
  await db.query(
    `INSERT INTO credentials (id, encrypted_data, cloud_provider, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_used_at = excluded.last_used_at`,
    [credentialId, encryptedData, cloudProvider, now, now],
  );

  return credentialId;
}

export class CredentialSecretStore {
  constructor(private readonly db: DB) {}

  /**
   * Get credential by ID
   */
  async getCredential(credentialId: string): Promise<string | null> {
    const rows = await this.db.query<CredentialRow>(
      `SELECT encrypted_data FROM credentials WHERE id = ?`,
      [credentialId],
    );
    return rows[0]?.encrypted_data ?? null;
  }

  async getCredentialWithCloudProvider(
    credentialId: string,
  ): Promise<{ encryptedData: string; cloudProvider: CloudType } | null> {
    const rows = await this.db.query<{
      encryptedData: string;
      cloudProvider: CloudType;
    }>(
      `SELECT encrypted_data AS encryptedData, cloud_provider AS cloudProvider
       FROM credentials WHERE id = ?`,
      [credentialId],
    );
    return rows[0] ?? null;
  }

  // ============================================================================
  // Credential health (auth_failed_at): durable signal that a stored credential
  // is failing authentication, so cleanup pauses until it is fixed. Read
  // directly so it survives an API restart.
  // ============================================================================

  /**
   * Mark a credential as failing authentication. Idempotent: keeps the first
   * failure timestamp (the "since" the operator sees) on repeated failures.
   */
  async markCredentialAuthFailed(credentialId: string): Promise<void> {
    await this.db.query(
      `UPDATE credentials SET auth_failed_at = ?
       WHERE id = ? AND auth_failed_at IS NULL`,
      [Date.now(), credentialId],
    );
  }

  /** Clear the auth-failed mark after a successful use or a credential re-save. */
  async clearCredentialAuthFailed(credentialId: string): Promise<void> {
    await this.db.query(
      `UPDATE credentials SET auth_failed_at = NULL
       WHERE id = ? AND auth_failed_at IS NOT NULL`,
      [credentialId],
    );
  }

  /** True iff the credential currently carries an auth-failed mark. */
  async isCredentialAuthFailed(credentialId: string): Promise<boolean> {
    const rows = await this.db.query<{ one: number }>(
      `SELECT 1 AS one FROM credentials
       WHERE id = ? AND auth_failed_at IS NOT NULL`,
      [credentialId],
    );
    return rows.length > 0;
  }

  // ============================================================================
  // Named Credentials (CLI/API-managed, stored with a user-chosen name)
  // ============================================================================

  /**
   * List all named credentials with their encrypted data. Callers must decrypt
   * and redact before sending over the wire.
   */
  async listNamedCredentials(): Promise<
    {
      id: string;
      name: string;
      cloudProvider: CloudType;
      encryptedData: string;
      authFailedAt: number | null;
    }[]
  > {
    return this.db.query<{
      id: string;
      name: string;
      cloudProvider: CloudType;
      encryptedData: string;
      authFailedAt: number | null;
    }>(
      `SELECT id, name, cloud_provider AS cloudProvider, encrypted_data AS encryptedData,
              auth_failed_at AS authFailedAt
       FROM credentials WHERE name IS NOT NULL`,
    );
  }

  /**
   * Get a named credential's encrypted data.
   */
  async getNamedCredential(name: string): Promise<{
    id: string;
    encryptedData: string;
    cloudProvider: CloudType;
    authFailedAt: number | null;
  } | null> {
    const rows = await this.db.query<{
      id: string;
      encryptedData: string;
      cloudProvider: CloudType;
      authFailedAt: number | null;
    }>(
      `SELECT id, encrypted_data AS encryptedData, cloud_provider AS cloudProvider,
              auth_failed_at AS authFailedAt
       FROM credentials WHERE name = ?`,
      [name],
    );
    return rows[0] ?? null;
  }

  /**
   * True if any durable resource references this credential row. Used to
   * decide whether a name-drop should hard-delete or just unname it. Historical
   * workload and VM pointers need the row for cleanup and accounting; node
   * pools and clusters also retain their compute credential.
   */
  private isCredentialReferenced(
    tx: DBTransaction,
    credentialId: string,
  ): boolean {
    // Any reference, active or terminal — terminal workloads still hold a
    // FK to credentials (RESTRICT), so a hard delete would fail. Soft-unname
    // those instead and preserve the row for the historical pointer.
    const rows = tx.query<{ one: number }>(
      `SELECT 1 AS one FROM workloads
       WHERE credential_id = ?
          OR input_storage_credential_id = ?
          OR output_storage_credential_id = ?
          OR checkpoint_storage_credential_id = ?
       LIMIT 1`,
      [credentialId, credentialId, credentialId, credentialId],
    );
    if (rows.length > 0) return true;
    const vmRows = tx.query<{ one: number }>(
      `SELECT 1 AS one FROM vms WHERE credential_id = ? LIMIT 1`,
      [credentialId],
    );
    if (vmRows.length > 0) return true;
    const installationRows = tx.query<{ one: number }>(
      `SELECT 1 AS one FROM clusters
       WHERE compute_credential_id = ?
       LIMIT 1`,
      [credentialId],
    );
    return installationRows.length > 0;
  }

  /** Live clusters keep their compute credential in use. */
  private activeClustersUsingCredentials(
    tx: DBTransaction,
    credentialIds: string[],
  ): string[] {
    const idPlaceholders = credentialIds.map(() => '?').join(', ');
    return tx
      .query<{ id: string }>(
        `SELECT id FROM clusters
         WHERE compute_credential_id IN (${idPlaceholders})
           AND state <> 'destroyed'
         ORDER BY id`,
        credentialIds,
      )
      .map((row) => row.id);
  }

  /**
   * Drop a credential row by id, or just clear its name if a durable
   * resource still references it. See isCredentialReferenced.
   */
  private dropOrUnnameCredential(
    tx: DBTransaction,
    credentialId: string,
  ): void {
    if (this.isCredentialReferenced(tx, credentialId)) {
      tx.query(`UPDATE credentials SET name = NULL WHERE id = ?`, [
        credentialId,
      ]);
    } else {
      tx.query(`DELETE FROM credentials WHERE id = ?`, [credentialId]);
    }
  }

  /**
   * Save a named credential with hash-based dedup.
   * - Same hash (same creds) already under another name → refuse.
   * - Same hash on an unnamed row → name that row.
   * - Same name with different hash → replace old row with new one.
   */
  async saveNamedCredential(
    name: string,
    credentialId: string,
    encryptedData: string,
    cloudProvider: CloudType,
    /** `expectedId`: replace only if the name still holds that row. */
    options: { overwrite?: boolean; expectedId?: string } = {},
  ): Promise<string> {
    const now = Date.now();
    if (options.overwrite === false) {
      return this.db.transaction((tx) => {
        const named = tx.query<{ id: string }>(
          `SELECT id FROM credentials WHERE name = ? LIMIT 1`,
          [name],
        );
        if (named.length > 0) {
          // A transport can replay a POST after the first request commits but
          // before its response arrives. The credential hash covers the full
          // secret payload, so an exact replay is safe and idempotent; a
          // different payload must still lose the create-only race.
          if (named[0].id === credentialId) return credentialId;
          throw new CredentialNameExistsError(name);
        }

        const existing = tx.query<CredentialRow>(
          `SELECT id, name FROM credentials WHERE id = ?`,
          [credentialId],
        );
        if (existing.length > 0) {
          // One row holds one name: moving it would break the old name's references.
          const saved = existing[0].name;
          if (saved != null && saved !== name)
            throw new CredentialsExistError(name, saved);
          tx.query(
            `UPDATE credentials SET name = ?, last_used_at = ? WHERE id = ?`,
            [name, now, credentialId],
          );
        } else {
          tx.query(
            `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [credentialId, encryptedData, cloudProvider, name, now, now],
          );
        }
        return credentialId;
      });
    }

    return this.db.transaction((tx) => {
      if (options.expectedId) {
        const [current] = tx.query<{ id: string }>(
          `SELECT id FROM credentials WHERE name = ?`,
          [name],
        );
        if (current?.id !== options.expectedId)
          throw new CredentialChangedError(name);
      }
      // Keep name removal and replacement atomic for readers and other rotations.
      const stale = tx.query<{ id: string }>(
        `SELECT id FROM credentials WHERE name = ? AND id != ?`,
        [name, credentialId],
      );
      for (const { id } of stale) {
        this.dropOrUnnameCredential(tx, id);
      }

      // Upsert: if same hash exists (with or without a name), set/update the name
      const existing = tx.query<CredentialRow>(
        `SELECT id, name FROM credentials WHERE id = ?`,
        [credentialId],
      );

      if (existing.length > 0) {
        // As above; stale rows dropped earlier roll back with the throw.
        const saved = existing[0].name;
        if (saved != null && saved !== name)
          throw new CredentialsExistError(name, saved);
        tx.query(
          `UPDATE credentials SET name = ?, last_used_at = ? WHERE id = ?`,
          [name, now, credentialId],
        );
      } else {
        tx.query(
          `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [credentialId, encryptedData, cloudProvider, name, now, now],
        );
      }

      return credentialId;
    });
  }

  /**
   * Delete a named credential, guarded by a reference check.
   *
   * Wraps the in-use lookup and the delete in a single synchronous
   * transaction so a workload cannot transition into ACTIVE_STATES between
   * the check and the delete. Returns `blocking` populated (and
   * `deleted` false) when the caller did not pass `force` and
   * non-terminal workloads reference the credential (compute, input
   * storage, or output storage). When `force` is true, the row is
   * soft-unnamed if still referenced so the in-flight workload's
   * completion monitor can keep decrypting creds.
   */
  async deleteNamedCredentialIfNotReferenced(
    name: string,
    force: boolean,
  ): Promise<{ deleted: boolean; blocking: string[] }> {
    return this.db.transaction((tx) => {
      const idRows = tx.query<{ id: string }>(
        `SELECT id FROM credentials WHERE name = ?`,
        [name],
      );
      if (idRows.length === 0) {
        return { deleted: false, blocking: [] };
      }

      if (!force) {
        const ids = idRows.map((r) => r.id);
        const idPlaceholders = ids.map(() => '?').join(', ');
        const statePlaceholders = ACTIVE_STATES.map(() => '?').join(', ');
        const blockingRows = tx.query<{ id: string }>(
          `SELECT DISTINCT id FROM workloads
           WHERE state IN (${statePlaceholders})
             AND (credential_id IN (${idPlaceholders})
                  OR input_storage_credential_id IN (${idPlaceholders})
                  OR output_storage_credential_id IN (${idPlaceholders})
                  OR checkpoint_storage_credential_id IN (${idPlaceholders}))
           ORDER BY id`,
          [...ACTIVE_STATES, ...ids, ...ids, ...ids, ...ids],
        );
        const blocking = [
          ...blockingRows.map((r) => r.id),
          ...this.activeClustersUsingCredentials(tx, ids),
        ];
        if (blocking.length > 0) {
          return { deleted: false, blocking };
        }
      }

      for (const { id } of idRows) {
        this.dropOrUnnameCredential(tx, id);
      }
      return { deleted: true, blocking: [] };
    });
  }

  // ============================================================================
  // Named Secrets (write-only values, referenced by name from workloads)
  // ============================================================================

  /**
   * Upsert a secret. Values are encrypted before storage.
   */
  async saveSecret(
    name: string,
    values: Record<string, string>,
  ): Promise<void> {
    const encrypted = await encryptSecret(JSON.stringify(values));
    const now = Math.floor(Date.now() / 1000);
    await this.db.query(
      `INSERT INTO secrets (name, encrypted_values, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         encrypted_values = excluded.encrypted_values,
         updated_at = excluded.updated_at`,
      [name, encrypted, now, now],
    );
  }

  /**
   * List all secrets with metadata only — never values.
   */
  async listSecrets(): Promise<
    { name: string; createdAt: number; updatedAt: number }[]
  > {
    return this.db.query<{
      name: string;
      createdAt: number;
      updatedAt: number;
    }>(
      `SELECT name, created_at AS createdAt, updated_at AS updatedAt
       FROM secrets ORDER BY name`,
    );
  }

  /**
   * Get decrypted values for a secret. Server-side only; never exposed via API.
   * Returns null if the secret does not exist.
   */
  async getSecretValues(name: string): Promise<Record<string, string> | null> {
    const rows = await this.db.query<SecretRow>(
      `SELECT name, encrypted_values, created_at, updated_at FROM secrets WHERE name = ?`,
      [name],
    );
    const row = rows[0];
    if (!row) return null;
    return JSON.parse(await decryptSecret(row.encrypted_values)) as Record<
      string,
      string
    >;
  }

  /** A Secret's values and revision, read from one row. */
  async getRuntimeSecret(name: string): Promise<RuntimeSecret | null> {
    const [row] = await this.db.query<SecretRow>(
      `SELECT name, encrypted_values, created_at, updated_at FROM secrets WHERE name = ?`,
      [name],
    );
    if (!row) return null;
    return {
      name,
      revision: secretRevision(row.encrypted_values),
      values: JSON.parse(await decryptSecret(row.encrypted_values)) as Record<
        string,
        string
      >,
    };
  }

  /** A Secret's current revision without decrypting it; null when absent. */
  async getSecretRevision(name: string): Promise<string | null> {
    const [row] = await this.db.query<Pick<SecretRow, 'encrypted_values'>>(
      `SELECT encrypted_values FROM secrets WHERE name = ?`,
      [name],
    );
    return row ? secretRevision(row.encrypted_values) : null;
  }

  /** Running VM-host Jobs, Services and VMs that reference a Secret. */
  async listRunningVmHostWorkloadIds(secretName: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT DISTINCT w.id FROM workloads w, json_each(w.secret_names)
       WHERE json_each.value = ? AND w.state = ?
       ORDER BY 1`,
      [secretName, WorkloadState.Running],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Delete a secret atomically, guarded by a reference check.
   *
   * Wraps the in-use lookup and the DELETE in a single synchronous
   * transaction so a workload cannot transition into ACTIVE_STATES between
   * the check and the delete. When `force` is true, skips the check.
   *
   * Returns `blocking` populated (and `deleted` false) when the caller
   * did not pass `force` and non-terminal workloads reference the secret.
   */
  async deleteSecretIfNotReferenced(
    name: string,
    force: boolean,
  ): Promise<{ deleted: boolean; blocking: string[] }> {
    return this.db.transaction((tx) => {
      if (!force) {
        const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
        const rows = tx.query<{ id: string }>(
          `SELECT d.id FROM workloads d, json_each(d.secret_names)
           WHERE json_each.value = ? AND d.state IN (${placeholders})
           ORDER BY 1`,
          [name, ...ACTIVE_STATES],
        );
        const blocking = rows.map((r) => r.id);
        if (blocking.length > 0) {
          return { deleted: false, blocking };
        }
      }
      const result = tx.query<{ rowsAffected: number }>(
        `DELETE FROM secrets WHERE name = ?`,
        [name],
      );
      return { deleted: (result[0]?.rowsAffected ?? 0) > 0, blocking: [] };
    });
  }
}
