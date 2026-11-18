import type { ClusterReleaseState } from '../../shared/clusters.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { DB } from './repositories/db.js';

export interface RecordSystemReleaseIntentInput {
  revision: number;
  operationId: string;
  apiVersion: string;
  apiImage: string;
  requestedByUserId: string;
}

/** One row of the release ledger; revision 1 is the bootstrap release. */
export interface SystemReleaseIntent {
  revision: number;
  operationId: string;
  apiVersion: string;
  apiImage: string;
  requestedByUserId: string;
  state: ClusterReleaseState;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SystemReleaseIntentRecordResult =
  | 'recorded'
  | 'operation-exists'
  | 'revision-not-newer';

/** The hosted API's own rows in the one release ledger (`cluster_releases`, 0126). */
export interface SystemReleaseIntentRepository {
  record(
    input: RecordSystemReleaseIntentInput,
  ): Promise<SystemReleaseIntentRecordResult>;
  get(operationId: string): Promise<SystemReleaseIntent | null>;
  latest(): Promise<SystemReleaseIntent | null>;
  setState(
    operationId: string,
    state: ClusterReleaseState,
    lastError?: string,
  ): Promise<void>;
}

interface Row {
  revision: number;
  operation_id: string;
  api_version: string;
  api_image: string;
  requested_by_user_id: string;
  state: ClusterReleaseState;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function toIntent(row: Row): SystemReleaseIntent {
  return {
    revision: row.revision,
    operationId: row.operation_id,
    apiVersion: row.api_version,
    apiImage: row.api_image,
    requestedByUserId: row.requested_by_user_id,
    state: row.state,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SystemReleaseIntentStore implements SystemReleaseIntentRepository {
  constructor(private readonly db: DB) {}

  async record(
    input: RecordSystemReleaseIntentInput,
  ): Promise<SystemReleaseIntentRecordResult> {
    const now = Date.now();
    try {
      await this.db.query(
        `INSERT INTO cluster_releases (
           cluster_id, revision, operation_id, api_version, api_image,
           requested_by_user_id, state, created_at, updated_at
         )
         SELECT c.id, ?, ?, ?, ?, ?, 'seeded', ?, ?
         FROM clusters c WHERE c.state <> 'destroyed'`,
        [
          input.revision,
          input.operationId,
          input.apiVersion,
          input.apiImage,
          input.requestedByUserId,
          now,
          now,
        ],
      );
      if ((await this.get(input.operationId)) === null) {
        throw new Error('this API has not recorded the cluster it runs in');
      }
      return 'recorded';
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('revision must increase'))
        return 'revision-not-newer';
      if (message.includes('UNIQUE') || message.includes('PRIMARY KEY')) {
        return 'operation-exists';
      }
      throw error;
    }
  }

  async get(operationId: string): Promise<SystemReleaseIntent | null> {
    const rows = await this.db.query<Row>(
      `SELECT * FROM cluster_releases WHERE operation_id = ?`,
      [operationId],
    );
    return rows[0] ? toIntent(rows[0]) : null;
  }

  async latest(): Promise<SystemReleaseIntent | null> {
    const rows = await this.db.query<Row>(
      `SELECT * FROM cluster_releases ORDER BY revision DESC LIMIT 1`,
    );
    return rows[0] ? toIntent(rows[0]) : null;
  }

  async setState(
    operationId: string,
    state: ClusterReleaseState,
    lastError?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE cluster_releases
       SET state = ?, last_error = ?, updated_at = ?
       WHERE operation_id = ?`,
      [state, lastError ?? null, Date.now(), operationId],
    );
  }
}
