/**
 * Application persistence composition root.
 *
 * Repository implementations receive the same DB instance here. Services
 * should obtain repositories from this module instead of constructing them or
 * importing the raw DB singleton.
 */

import {
  SpendControlsStore,
  type SpendControlsRepository,
} from './spend-controls-store.js';
import {
  ClusterRecordStore,
  NodePoolStore,
  NodePoolVmStore,
  type ClusterRecordRepository,
  type NodePoolRepository,
  type NodePoolVmRepository,
} from './cluster-store.js';
import {
  ClusterInstallerStore,
  type ClusterInstallerRepository,
} from './cluster-installer-store.js';
import {
  SystemReleaseIntentStore,
  type SystemReleaseIntentRepository,
} from './system-release-intent-store.js';
import {
  ApiOwnershipStore,
  type ApiOwnershipRepository,
} from './api-ownership-store.js';
import {
  NotificationsStore,
  type NotificationsRepository,
} from './notifications-store.js';
import { closeDB, getDB, resetDB, type DB } from './repositories/db.js';
import { bindDatabaseApiIdentity, getApiIdentity } from './api-identity.js';
import { log } from './logger.js';
import {
  DeploymentStore,
  type DeploymentRepository,
} from './deployment-store.js';
import { createJobChanges, type JobChanges } from './job-changes.js';
import { WorkloadLifecycleStore } from './repositories/workload-lifecycle.js';
import { WorkloadOutcomeStore } from './repositories/workload-outcomes.js';
import { ProvisioningAttemptStore } from './repositories/provisioning-attempts.js';
import { WorkloadEventStore } from './repositories/workload-events.js';
import { CredentialSecretStore } from './repositories/credential-secrets.js';
import { WorkloadQueryStore } from './repositories/workload-queries.js';
import { WorkloadSpendStore } from './repositories/workload-spend.js';
import { DeploymentExecutionStore } from './repositories/deployment-executions.js';
import { PoolJobStore } from './repositories/pool-job-store.js';
import { ReplicaDemandStore } from './repositories/replica-demand.js';
import { NodePoolServiceStore } from './repositories/node-pool-services.js';

export interface Persistence {
  readonly jobChanges: JobChanges;
  readonly workloadQueries: WorkloadQueryStore;
  readonly workloadSpend: WorkloadSpendStore;
  readonly workloadLifecycle: WorkloadLifecycleStore;
  readonly workloadOutcomes: WorkloadOutcomeStore;
  readonly provisioningAttempts: ProvisioningAttemptStore;
  readonly workloadEvents: WorkloadEventStore;
  readonly credentialSecrets: CredentialSecretStore;
  readonly deploymentExecutions: DeploymentExecutionStore;
  readonly poolJobs: PoolJobStore;
  readonly replicaDemand: ReplicaDemandStore;
  readonly nodePoolServices: NodePoolServiceStore;
  readonly spendControls: SpendControlsRepository;
  readonly clusterRecords: ClusterRecordRepository;
  readonly nodePools: NodePoolRepository;
  readonly nodePoolVms: NodePoolVmRepository;
  readonly clusters: ClusterInstallerRepository;
  readonly systemReleases: SystemReleaseIntentRepository;
  readonly deployments: DeploymentRepository;
  readonly apiOwnership: ApiOwnershipRepository;
  readonly notifications: NotificationsRepository;
}

interface PersistenceState {
  readonly db: DB;
  readonly repositories: Persistence;
}

function createPersistence(db: DB): Persistence {
  const jobChanges = createJobChanges();
  return {
    jobChanges,
    workloadQueries: new WorkloadQueryStore(db),
    workloadSpend: new WorkloadSpendStore(db),
    workloadLifecycle: new WorkloadLifecycleStore(db, jobChanges),
    workloadOutcomes: new WorkloadOutcomeStore(db, jobChanges),
    provisioningAttempts: new ProvisioningAttemptStore(db),
    workloadEvents: new WorkloadEventStore(db),
    credentialSecrets: new CredentialSecretStore(db),
    deploymentExecutions: new DeploymentExecutionStore(db, jobChanges),
    poolJobs: new PoolJobStore(db),
    replicaDemand: new ReplicaDemandStore(db),
    nodePoolServices: new NodePoolServiceStore(db),
    spendControls: new SpendControlsStore(db),
    clusterRecords: new ClusterRecordStore(db),
    nodePools: new NodePoolStore(db),
    nodePoolVms: new NodePoolVmStore(db),
    clusters: new ClusterInstallerStore(db),
    systemReleases: new SystemReleaseIntentStore(db),
    deployments: new DeploymentStore(db, jobChanges),
    apiOwnership: new ApiOwnershipStore(db),
    notifications: new NotificationsStore(db),
  };
}

let state: PersistenceState | null = null;

export function getPersistence(): Persistence {
  const db = getDB();
  // Raw resetDB() remains available to low-level repository tests. Comparing
  // identities prevents those resets from leaving cached repositories attached
  // to the previous connection.
  if (!state || state.db !== db) {
    state = { db, repositories: createPersistence(db) };
  }
  return state.repositories;
}

/** Online backup of the live database to `destinationPath` (see `DB.backup`). */
export function backupDatabase(destinationPath: string): Promise<void> {
  const db = getDB();
  if (!db.backup) {
    return Promise.reject(
      new Error('this database does not support online backup'),
    );
  }
  return db.backup(destinationPath);
}

/** The application version whose migrations this database last ran (RELEASE.md downgrade rule). */
export async function getSchemaAppVersion(): Promise<string | null> {
  const rows = await getDB().query<{ value: string }>(
    `SELECT value FROM _metadata WHERE key = 'schema_app_version'`,
  );
  return rows[0]?.value ?? null;
}

/**
 * Append to the api_versions timeline when the running version differs from
 * the newest row. Which API version performed any timestamped action is a
 * time-join against this table (RFC 0031), never a per-row stamp.
 */
export async function recordApiVersion(version: string): Promise<void> {
  const db = getDB();
  const latest = await db.query<{ version: string }>(
    `SELECT version FROM api_versions
     ORDER BY first_seen_at DESC, rowid DESC
     LIMIT 1`,
  );
  if (latest[0]?.version === version) return;
  await db.query(
    `INSERT INTO api_versions (version, first_seen_at) VALUES (?, ?)`,
    [version, Date.now()],
  );
}

export function getWorkloadQueryStore(): WorkloadQueryStore {
  return getPersistence().workloadQueries;
}

export function getWorkloadSpendStore(): WorkloadSpendStore {
  return getPersistence().workloadSpend;
}

export function getWorkloadLifecycle(): WorkloadLifecycleStore {
  return getPersistence().workloadLifecycle;
}

export function getWorkloadOutcomes(): WorkloadOutcomeStore {
  return getPersistence().workloadOutcomes;
}

export function getProvisioningAttemptStore(): ProvisioningAttemptStore {
  return getPersistence().provisioningAttempts;
}

export function getWorkloadEventStore(): WorkloadEventStore {
  return getPersistence().workloadEvents;
}

export function getCredentialSecretStore(): CredentialSecretStore {
  return getPersistence().credentialSecrets;
}

export function getDeploymentExecutionStore(): DeploymentExecutionStore {
  return getPersistence().deploymentExecutions;
}

export function getPoolJobStore(): PoolJobStore {
  return getPersistence().poolJobs;
}

export function getReplicaDemandStore(): ReplicaDemandStore {
  return getPersistence().replicaDemand;
}

export function getSpendControlsStore(): SpendControlsRepository {
  return getPersistence().spendControls;
}

export function getDeploymentStore(): DeploymentRepository {
  return getPersistence().deployments;
}

export function getApiOwnershipStore(): ApiOwnershipRepository {
  return getPersistence().apiOwnership;
}

export function getNotificationsStore(): NotificationsRepository {
  return getPersistence().notifications;
}

export async function initializePersistence(
  apiIdentity?: string,
): Promise<void> {
  const db = getDB();
  await db.init?.();
  const { newlyBound } = await bindDatabaseApiIdentity(db, apiIdentity);
  if (newlyBound) {
    // The one moment a database changes hands, so it belongs in the record
    // rather than being inferred later from what the resources are tagged with.
    log.info('Bound this database to an API identity', {
      id: 'system',
      apiIdentity: getApiIdentity(),
    });
  }
  await getApiOwnershipStore().seedLegacyTargets(getApiIdentity());
}

/** Checkpoint and close the shared DB connection; the last step of shutdown. */
export function closePersistence(): void {
  closeDB();
}

/** Reset every repository and the shared DB connection. */
export function resetPersistence(): void {
  state = null;
  resetDB();
}
