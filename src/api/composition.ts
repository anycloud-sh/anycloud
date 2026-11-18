import BetterSqlite3 from 'better-sqlite3';

import {
  extractCredentials,
  getRegionsForVMType,
} from '../shared/cloud-config.js';
import type { CloudConfig } from '../shared/cloud.js';
import { DeployError } from '../shared/errors.js';
import {
  getOwnApiChart,
  getOwnApiImage,
  getWorkloadApiUrl,
  isHelmManagedApi,
} from './config.js';
import {
  generateDeploymentId,
  generateClusterId,
  generateNodePoolId,
} from '../shared/id-generator.js';
import { sleep } from '../shared/utils.js';
import {
  createSelfDelete,
  SelfDeleteRefusedError,
  type SelfDelete,
} from './services/self-delete.js';
import {
  parseSelfDeleteTarget,
  removeInstallation,
} from './services/gateways/self-delete.js';
import config, {
  getApiBackupConfig,
  getSelfDeleteConfig,
  STATUS_HEALTH_CHECK_TIMEOUT_MS,
} from './config.js';
import type { ApiRpcDomains } from './rpc/context.js';
import {
  createApiAccessDomain,
  type ApiAccessDomainDependencies,
} from './services/api-access-domain.js';
import {
  createBucketMetadataDomain,
  type BucketMetadataDomainDependencies,
} from './services/bucket-metadata-domain.js';
import * as catalogReadiness from './services/catalog-readiness.js';
import {
  createComputeProvider,
  createStorageProvider,
  createSweeperProvider,
  decryptCredential,
  encryptCredential,
  hashCredential,
  loadWorkloadConfigs,
  resolveCredentialByName,
  validateComputeCandidateConfig,
} from './services/cloud-config.js';
import { validateTargetAvailability } from './services/compute-candidates.js';
import { cloudAccount } from './services/cloud-account.js';
import {
  assertNodePoolVmTypes,
  assertUserNamespaceVmTypes,
  nestedVirtualizationVmTypes,
} from './services/node-pool-admission.js';
import {
  createCredentialsDomain,
  type CredentialsDomainDependencies,
} from './services/credentials-domain.js';
import {
  createDatabaseDomain,
  type ReadOnlyDatabase,
} from './services/database-domain.js';
import {
  createWorkloadAdmissionDomain,
  type WorkloadAdmissionDomainDependencies,
} from './services/workload-admission-domain.js';
import {
  persistNodePoolServiceWorkload,
  persistWorkloadCreation,
  persistPoolJob,
  persistTargetedWorkload,
} from './services/workload-admission-persistence.js';
import { prepareWorkloadCreation } from './services/workload-admission-plan.js';
import { resolveWorkloadAdmission } from './services/workload-admission-resolution.js';
import {
  createWorkloadManagementDomain,
  WorkloadManagementError,
  type WorkloadManagementDomainDependencies,
} from './services/workload-management-domain.js';
import {
  preflightRuntimeSecrets,
  prepareStoredServiceCheckpoint,
} from './services/workload-operation-helpers.js';
import { toWorkloadEvent } from './services/repositories/workload-events.js';
import { DockerManager } from './services/docker.js';
import { validateId } from './services/workload-admission-checks.js';
import Github from './services/gateways/github.js';
import {
  canManageCloudResources,
  type CloudCompute,
} from './services/gateways/cloud.js';
import { inspectImage } from '../shared/image-registry.js';
import { resolveApiImage } from '../shared/api-image.js';
import { observeClusterIdentity } from './services/kubernetes/cluster-identity.js';
import {
  configureDefaultNodePoolRuntime,
  getDefaultNodePoolRuntime,
} from './services/node-pool-runtime-default.js';
import {
  createClustersDomain,
  type ClusterDomainDependencies,
  type NamedCredential,
} from './services/clusters-domain.js';
import { ClusterReleaseConflictError } from './services/cluster-errors.js';
import {
  createManagementHostAccess,
  createClusterInfrastructure,
  createClusterReleaseClient,
} from './services/cluster-installer-runtime.js';
import { isKubernetesNotFoundError } from './services/kubernetes/managed-resources.js';
import { observeHookJob } from './services/system-release/ready-job.js';
import {
  createHostStepExecutor,
  type HostStepExecutor,
} from './services/system-release/host-step.js';
import { SSHManager } from './services/gateways/ssh.js';
import { randomBytes } from 'node:crypto';
import {
  createNodePoolsDomain,
  type NodePoolDomainDependencies,
} from './services/node-pools-domain.js';
import { getDefaultWorkloadOperations } from './services/job/default-operations.js';
import { vmSshHost } from './services/job/vm-host-operations.js';
import { log } from './services/logger.js';
import { isApiBackupBucket } from './services/bucket-storage-operation.js';
import {
  activateApiTls,
  deleteDNSRecordBySubdomain,
  issueOriginCertificate,
  publicARecordExists,
  removeApiTls,
  upsertDNSRecord,
} from '../shared/dns-worker.js';
import { readApiBackupManifest } from './services/api-backup-manifest.js';
import {
  getDefaultApiDatabaseBackup,
  getDefaultFirstBackupCheck,
  requestApiDatabaseBackup,
} from './services/api-database-backup-default.js';
import { createHostedNodePoolInventory } from './services/cluster-hosted-pools.js';
import {
  createSystemReleaseDomain,
  type HostedSystemReleaseIdentity,
  type SystemReleaseDomain,
  type SystemReleaseDomainDependencies,
} from './services/system-release-domain.js';
import { parseClusterConnection } from './services/kubernetes/cluster-connection.js';
import {
  apiServiceAccountToken,
  trustProbeServiceAccountToken,
} from './services/kubernetes/service-account-token.js';
import { createRoleConnectionCheck } from './services/role-connection-check.js';
import {
  MANAGEMENT_MEMBER_LABEL,
  MANAGEMENT_NODE_NAME,
  SYSTEM_RELEASE_HELM_CHART_NAME,
  SYSTEM_RELEASE_NAMESPACE,
} from '../shared/system-release.js';
import { errorMessage } from '../shared/log-diagnostics.js';
import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
} from '@kubernetes/client-node';
import {
  requestWorkloadCleanup,
  requestWorkloadPoll,
} from './services/monitor.js';
import {
  getPersistence,
  getSchemaAppVersion,
  type Persistence,
} from './services/persistence.js';
import { submitTargetedJob } from './services/targeted-job-admission.js';
import { submitNodePoolService } from './services/node-pool-service-admission.js';
import { submitPoolJob } from './services/pool-job-admission.js';
import { getDefaultNodePoolServiceRuntime } from './services/node-pool-service-runtime-default.js';
import { createDeploymentsDomain } from './services/deployments-domain.js';
import { getDefaultDeploymentControl } from './services/deployment-controller.js';
import { poolJobWait } from './services/deployment-status.js';
import { observePoolRunners } from './services/pool-runners.js';
import { drainPoolJobs } from './services/pool-job-drain.js';
import { createDeploymentWorkloadDomain } from './services/deployment-workload-domain.js';
import { getDefaultDeploymentRuntimeResolver } from './services/kubernetes/default-runtime.js';
import {
  createQuotaDomain,
  type QuotaDomainDependencies,
} from './services/quota-domain.js';
import {
  handleCanceledQuotaStatus,
  handleQuotaStatus,
} from './services/quota/handler.js';
import {
  getApiAccessPolicy,
  listApiAccessUsers,
  registerApiServiceAccount,
  removeApiAccessUser,
  resolveOwnershipScope,
  upsertApiAccessUser,
} from './services/repositories/api-access-policy.js';
import {
  exchangeApiToken,
  rotateApiToken,
} from './services/repositories/api-tokens.js';
import {
  createNotificationsDomain,
  type NotificationsDomainDependencies,
} from './services/notifications-domain.js';
import {
  createSecretsDomain,
  type SecretsDomainDependencies,
} from './services/secrets-domain.js';
import { getDefaultServeRuntime } from './services/serve/default-runtime.js';
import {
  createServiceUpgradeDomain,
  type ServiceUpgradeDomainDependencies,
} from './services/service-upgrade-domain.js';
import {
  calendarWindowEndMs,
  calendarWindowStartMs,
  claimSpendBlock,
  findReplicaCapBlock,
} from './services/spend-controls.js';
import { PERIODS } from './services/spend-controls-store.js';
import {
  createSpendControlsDomain,
  type SpendControlsDomainDependencies,
} from './services/spend-controls-domain.js';
import { fireAndForget } from './services/task.js';
import { readWorkloadCheckpointHealth } from './services/workload-storage.js';
import {
  admitPoolJobStorage,
  loadPoolJobConfigs,
  managesPoolCheckpoint,
  mintPoolJobStorage,
} from './services/pool-job-storage.js';
import { recordEvent, recordStatusEvent } from './services/telemetry.js';

export interface ApiCompositionOptions {
  overrides?: Partial<ApiRpcDomains>;
  /** Present on a Helm-managed API: enables the system release surface. */
  hostedSystemRelease?: HostedSystemReleaseIdentity;
  /** Narrow qualification seam for node pool VM compute; production omits it. */
  nodePoolCapacity?: NodePoolCapacityComposition;
  /** Images a Deployment or a pool Job runs; the local e2e cluster's aren't in a registry. */
  inspectDeploymentImage?: typeof inspectImage;
}

export interface NodePoolCapacityComposition {
  createCompute(config: CloudConfig): CloudCompute;
  validateTarget: NodePoolDomainDependencies['validateTarget'];
}

let readOnlyDatabasePromise: Promise<ReadOnlyDatabase> | undefined;

function getReadOnlyDatabase(): Promise<ReadOnlyDatabase> {
  readOnlyDatabasePromise ??= (async () => {
    const path = process.env.SQLITE_PATH;
    if (!path) throw new Error('SQLITE_PATH is not set');
    const database = new BetterSqlite3(path, {
      readonly: true,
      fileMustExist: true,
    });
    return {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          reader: statement.reader,
          iterate: () => statement.iterate(),
          all: () => statement.all(),
        };
      },
    };
  })();
  return readOnlyDatabasePromise;
}

function apiAccessDependencies(): ApiAccessDomainDependencies {
  return {
    policy: {
      get: getApiAccessPolicy,
      listUsers: listApiAccessUsers,
      upsertUser: upsertApiAccessUser,
      registerServiceAccount: registerApiServiceAccount,
      removeUser: removeApiAccessUser,
    },
    reconcileDeployment: (id) => getDefaultDeploymentControl().schedule(id),
    resolveGithubUser: Github.resolveUser,
    authenticateGithub: Github.authenticate,
    tokens: { exchange: exchangeApiToken, rotate: rotateApiToken },
  };
}

function bucketMetadataDependencies(): BucketMetadataDomainDependencies {
  return {
    resolveCredential: resolveCredentialByName,
    createStorage: createStorageProvider,
    now: Date.now,
    isApiBackupBucket,
    audit: (line) =>
      log.info('Storage token request', { id: 'system', ...line }),
  };
}

interface CapacityTargetRequest {
  region?: string;
  vmType: string;
  spot?: boolean;
}

/**
 * Capacity VM admission shared by node pools and clusters: the
 * catalog must know the target, the provider must isolate capacity
 * networking, and the saved credential must authenticate before durable
 * intent is stored.
 */
async function validateCapacityTarget(
  input: CapacityTargetRequest,
  credential: NamedCredential,
): Promise<void> {
  await catalogReadiness.ensureCatalogReady(credential.cloudProvider);
  const decrypted = await decryptCredential(credential.encryptedData);
  const cloudConfig: CloudConfig = {
    cloudProvider: credential.cloudProvider,
    credentials: extractCredentials(decrypted),
    // An unpinned node pool is checked in its first catalog region.
    region:
      input.region ??
      getRegionsForVMType(input.vmType, credential.cloudProvider)[0],
    vmType: input.vmType,
    spot: input.spot ?? false,
  };
  validateTargetAvailability(cloudConfig, {
    gpuTypes: [],
    vmTypes: [input.vmType],
  });
  const compute = createComputeProvider(cloudConfig);
  if (!canManageCloudResources(compute)) {
    throw new DeployError(
      `${credential.cloudProvider} does not support isolated capacity VM networking`,
      400,
    );
  }
  validateComputeCandidateConfig(cloudConfig, compute);
  await compute.validateCredentials();
}

const validateNodePoolTarget: NodePoolDomainDependencies['validateTarget'] =
  async (input, credential) => {
    await validateCapacityTarget(
      { region: input.region, vmType: input.vmTypes[0]!, spot: input.spot },
      credential,
    );
    const vmTypes = input.requireNestedVirtualization
      ? nestedVirtualizationVmTypes(
          credential.cloudProvider,
          input.vmTypes,
          input.region,
          input.zone,
        )
      : input.vmTypes;
    assertNodePoolVmTypes(
      credential.cloudProvider,
      vmTypes,
      input.region,
      input.osDiskTier,
      input.osDiskSizeGb,
    );
    if (input.userNamespaceJobs) {
      assertUserNamespaceVmTypes(credential.cloudProvider, vmTypes);
    }
    return {
      region: input.region ?? null,
      zone: input.zone ?? null,
      vmTypes,
      minVmCount: input.minVmCount,
      maxVmCount: input.maxVmCount,
      osDiskSizeGb: input.osDiskSizeGb,
      osDiskTier: input.osDiskTier,
      spot: input.spot,
    };
  };

/**
 * Cluster creation runs on the API that holds the saved cloud credential. A
 * hosted API has no installer role, so its infrastructure port is null and
 * bootstrap is refused before any durable intent.
 */
function clusterDependencies(
  persistence: Persistence,
  hosted: boolean,
): ClusterDomainDependencies {
  return {
    installations: persistence.clusters,
    clusterRecords: persistence.clusterRecords,
    credentials: persistence.credentialSecrets,
    storageCredential: async (credentialId) => {
      const saved =
        await persistence.credentialSecrets.getCredentialWithCloudProvider(
          credentialId,
        );
      if (!saved)
        throw new Error(`Credential ${credentialId} is no longer saved`);
      return {
        cloudProvider: saved.cloudProvider,
        credentials: await decryptCredential(saved.encryptedData),
      };
    },
    cloudAccount: (credentials) => cloudAccount(credentials),
    checkpointBucket: async (credential, bucket, region) => {
      const storage = createStorageProvider({
        cloudProvider: credential.cloudProvider,
        credentials: credential.credentials,
        region,
      });
      const exists = await storage.hasBucket(bucket);
      return {
        exists,
        region: exists
          ? ((await storage.getBucketRegion?.(bucket)) ?? region)
          : region,
      };
    },
    backupManifest: async (credential, bucket, region) => {
      const storage = createStorageProvider({
        cloudProvider: credential.cloudProvider,
        credentials: credential.credentials,
        region,
      });
      return readApiBackupManifest(storage, bucket);
    },
    validateTarget: async (input, credential) => {
      await validateCapacityTarget(input, credential);
      return {
        region: input.region,
        zone: input.zone ?? null,
        vmType: input.vmType,
      };
    },
    infrastructure: hosted
      ? null
      : createClusterInfrastructure(config.currVersion),
    host: createManagementHostAccess(),
    releases: createClusterReleaseClient(),
    // No held record id: the cluster record is removed by subdomain, so a
    // fresh record on each publish is harmless.
    dns: {
      publish: async (subdomain, ip, token) => {
        log.info('Publishing DNS record', { subdomain, ip });
        await upsertDNSRecord(subdomain, ip, token, { proxied: true });
      },
      publicARecordExists,
      remove: (subdomain, token) =>
        deleteDNSRecordBySubdomain(subdomain, token),
      issueCertificate: issueOriginCertificate,
      activateTls: activateApiTls,
      removeTls: removeApiTls,
    },
    // Node pools live in the hosted API: destroy asks it at the
    // installation's hostname with the caller's own bearer.
    hostedPools: createHostedNodePoolInventory({
      clientVersion: config.currVersion,
    }),
    resolveApiImage,
    observeKubernetesIdentity: observeClusterIdentity,
    generateId: generateClusterId,
    generateOperationId: () =>
      `op-${Date.now()}-${randomBytes(4).toString('hex')}`,
    generateServerToken: () => randomBytes(32).toString('hex'),
    generateSshKeypair: () => SSHManager.generateKeypair(),
    resolveScope: resolveOwnershipScope,
    apiVersion: config.currVersion,
    ownApiImage: getOwnApiImage(),
    schedule: (task) => fireAndForget(task()),
    sleep,
    now: () => Date.now(),
    log: {
      info: (message, metadata) => log.info(message, metadata),
      warn: (message, metadata) => log.warn(message, metadata),
    },
  };
}

/** Host steps through the API's in-cluster identity, loaded when first used. */
function inClusterHostSteps(): HostStepExecutor {
  let executor: HostStepExecutor | undefined;
  const loaded = () => {
    if (!executor) {
      const kubeConfig = new KubeConfig();
      kubeConfig.loadFromCluster();
      executor = createHostStepExecutor({
        batch: kubeConfig.makeApiClient(BatchV1Api),
        core: kubeConfig.makeApiClient(CoreV1Api),
      });
    }
    return executor;
  };
  return {
    run: (request) => loaded().run(request),
    get: (kind, id) => loaded().get(kind, id),
    latest: (kind) => loaded().latest(kind),
  };
}

/** Service Workloads and Deployment records holding a node pool in use. */
async function countLiveNodePoolReferences(
  persistence: Persistence,
  nodePoolId: string,
): Promise<number> {
  return (
    (await persistence.nodePoolServices.countLiveNodePoolReferences(
      nodePoolId,
    )) + (await persistence.deployments.countHoldingNodePool(nodePoolId))
  );
}

/**
 * The hosted API's own delete (RFC 0049 C26, seed design): its account through
 * the VM's identity, its installation from the release values' `selfDelete`.
 * Null on an API the seed didn't install.
 */
function hostedSelfDelete(
  persistence: Persistence,
  identity: HostedSystemReleaseIdentity,
): SelfDelete | null {
  const target = parseSelfDeleteTarget(getSelfDeleteConfig());
  const own = getApiBackupConfig();
  if (!target || !own) return null;
  const cloud = target.cloud;
  return createSelfDelete({
    clusterId: identity.installationId,
    installation: {
      clusterId: identity.installationId,
      cloud,
      region: own.region,
      bucket: {
        name: own.bucket,
        managed: own.bucket === identity.installationId,
      },
    },
    requireOwner: async (actorId) => {
      const policy = await getApiAccessPolicy();
      if (!policy?.ownerUserId || policy.ownerUserId !== actorId) {
        throw new SelfDeleteRefusedError(
          "Only the hosted API's owner may delete its installation",
        );
      }
    },
    liveDependents: async () => ({
      pools: await Promise.all(
        (await persistence.nodePools.listForReconciliation()).map(
          async (pool) => ({
            name: pool.name,
            liveReferences: await countLiveNodePoolReferences(
              persistence,
              pool.id,
            ),
          }),
        ),
      ),
      workloads: await persistence.workloadQueries.listLiveVmHostWorkloadIds(),
    }),
    backup: getDefaultApiDatabaseBackup(identity.installationId),
    cleanupPending: () => persistence.workloadOutcomes.listCleanupNeeded(),
    // Only AWS's instance role may list and delete EC2 by the cluster's tags;
    // on GCP and Azure the Workloads' own cleanups are the whole sweep.
    sweeperFor:
      cloud === 'aws'
        ? (location) => {
            const sweeper = createSweeperProvider({
              cloudProvider: own.cloudProvider,
              credentials: own.credentials as never,
              region: location ?? own.region,
            });
            if (!sweeper)
              throw new Error(`${own.cloudProvider} has no sweeper`);
            return sweeper;
          }
        : null,
    removeSelf: () => removeInstallation(target),
    now: () => Date.now(),
    sleep,
    log,
  });
}

/**
 * The Helm-managed API updates itself through the cluster connection registered
 * with it and reads its own Deployment with its in-cluster identity.
 */
function systemReleaseDependencies(
  persistence: Persistence,
  identity: HostedSystemReleaseIdentity | undefined,
): SystemReleaseDomainDependencies {
  return {
    identity: identity ?? null,
    intents: persistence.systemReleases,
    clusterRecords: persistence.clusterRecords,
    parseConnection: parseClusterConnection,
    releases: createClusterReleaseClient(),
    isConflict: (error): error is ClusterReleaseConflictError =>
      error instanceof ClusterReleaseConflictError,
    servedVersion: config.currVersion,
    drainPoolJobs: async (force, keep) =>
      (await drainPoolJobs(force, keep)).map(
        ({ id, state, nodePool, runnerRelease }) => ({
          id,
          state,
          nodePool,
          runnerRelease,
        }),
      ),
    schemaVersion: getSchemaAppVersion,
    hostSteps: inClusterHostSteps(),
    backup: identity
      ? getDefaultApiDatabaseBackup(identity.installationId)
      : null,
    selfDelete: identity ? hostedSelfDelete(persistence, identity) : null,
    firstBackup: () =>
      identity
        ? (getDefaultFirstBackupCheck(identity.installationId)?.status() ??
          null)
        : null,
    resolveApiImage,
    ownChart: getOwnApiChart(),
    observeRollout: async () => {
      if (!identity) return null;
      try {
        const kubeConfig = new KubeConfig();
        kubeConfig.loadFromCluster();
        const deployment = await kubeConfig
          .makeApiClient(AppsV1Api)
          .readNamespacedDeployment({
            name: SYSTEM_RELEASE_HELM_CHART_NAME,
            namespace: SYSTEM_RELEASE_NAMESPACE,
          });
        return {
          observedGeneration: deployment.status?.observedGeneration ?? null,
          replicas: deployment.status?.replicas ?? 0,
          updatedReplicas: deployment.status?.updatedReplicas ?? 0,
          readyReplicas: deployment.status?.readyReplicas ?? 0,
          conditions: (deployment.status?.conditions ?? []).map(
            (condition) => ({
              type: condition.type,
              status: condition.status,
              reason: condition.reason ?? null,
              message: condition.message ?? null,
            }),
          ),
        };
      } catch (error) {
        log.warn('Could not read the API Deployment rollout', {
          id: 'system',
          error: errorMessage(error),
        });
        return null;
      }
    },
    observeManagementLabel: async () => {
      if (!identity) return null;
      try {
        const kubeConfig = new KubeConfig();
        kubeConfig.loadFromCluster();
        const node = await kubeConfig
          .makeApiClient(CoreV1Api)
          .readNode({ name: MANAGEMENT_NODE_NAME });
        return node.metadata?.labels?.[MANAGEMENT_MEMBER_LABEL] === 'true';
      } catch (error) {
        log.warn('Could not read the management Node', {
          id: 'system',
          error: errorMessage(error),
        });
        return null;
      }
    },
    observeHookJob: async (name) => {
      if (!identity) return null;
      try {
        const kubeConfig = new KubeConfig();
        kubeConfig.loadFromCluster();
        return observeHookJob(
          await kubeConfig.makeApiClient(BatchV1Api).readNamespacedJob({
            name,
            namespace: SYSTEM_RELEASE_NAMESPACE,
          }),
        );
      } catch (error) {
        if (isKubernetesNotFoundError(error)) return { outcome: 'absent' };
        log.warn('Could not read an API release hook Job', {
          id: 'system',
          job: name,
          error: errorMessage(error),
        });
        return null;
      }
    },
    generateOperationId: () =>
      `rel-${Date.now()}-${randomBytes(4).toString('hex')}`,
    log: {
      info: (message, metadata) => log.info(message, metadata),
      warn: (message, metadata) => log.warn(message, metadata),
    },
  };
}

function nodePoolDependencies(
  persistence: Persistence,
  capacity?: NodePoolCapacityComposition,
): NodePoolDomainDependencies {
  if (capacity) {
    configureDefaultNodePoolRuntime({ createCompute: capacity.createCompute });
  }
  const validateTarget = capacity?.validateTarget ?? validateNodePoolTarget;
  return {
    requestBackup: requestApiDatabaseBackup,
    nodePools: persistence.nodePools,
    clusterRecords: persistence.clusterRecords,
    credentials: persistence.credentialSecrets,
    // Durable records that hold a node pool in use: Service Workloads until
    // their cleanup confirms native removal, user Deployment records until
    // deleted, and managed Deployments' live or uncleaned pool Jobs. The
    // deletion request re-evaluates the same set in its own transaction;
    // this is the early diagnostic.
    references: {
      hasLiveReferences: async (nodePoolId) =>
        (await persistence.nodePoolServices.hasLiveNodePoolReferences(
          nodePoolId,
        )) ||
        (await persistence.deployments.countHoldingNodePool(nodePoolId)) > 0,
      countLiveReferences: (nodePoolId) =>
        countLiveNodePoolReferences(persistence, nodePoolId),
    },
    generateId: generateNodePoolId,
    resolveScope: resolveOwnershipScope,
    runtime: {
      // A pool's deletion request also marks its managed Deployments; wake
      // their owner now rather than at the next resync, best effort: the
      // pool's own wake never waits on it.
      schedule: async (nodePoolId) => {
        const pool =
          getDefaultNodePoolRuntime().reconciler.schedule(nodePoolId);
        await persistence.deployments
          .listDeletingManaged(nodePoolId)
          .then((ids) => {
            for (const id of ids) getDefaultDeploymentControl().schedule(id);
          })
          .catch((error: unknown) =>
            log.warn('Managed Deployment wake failed; the resync will run it', {
              nodePoolId,
              error: errorMessage(error),
            }),
          );
        await pool;
      },
      observeCapacity: (nodePoolId) =>
        getDefaultNodePoolRuntime().controller.observeCapacity(nodePoolId),
      runners: (nodePoolId) =>
        observePoolRunners(
          {
            rows: (id) => persistence.poolJobs.runnerRows(id),
            runtimes: getDefaultDeploymentRuntimeResolver(),
            capBlock: () => findReplicaCapBlock(nodePoolId),
          },
          nodePoolId,
        ).catch((error: unknown) => {
          log.warn('Node pool runners could not be read', {
            nodePoolId,
            error: errorMessage(error),
          });
          return null;
        }),
      assertClusterCompatible: (clusterId, signal) =>
        getDefaultNodePoolRuntime().controller.assertClusterCompatible(
          clusterId,
          signal,
        ),
      ingress: (nodePoolId) =>
        getDefaultNodePoolRuntime().controller.ingress(nodePoolId),
    },
    validateTarget,
  };
}

function credentialsDependencies(
  persistence: Persistence,
): CredentialsDomainDependencies {
  return {
    requestBackup: requestApiDatabaseBackup,
    store: persistence.credentialSecrets,
    decrypt: decryptCredential,
    encrypt: encryptCredential,
    hash: hashCredential,
    checkRoleConnection: isHelmManagedApi()
      ? createRoleConnectionCheck({
          tokens: apiServiceAccountToken,
          probeTokens: trustProbeServiceAccountToken,
        })
      : null,
  };
}

function admissionDependencies(
  persistence: Persistence,
  inspectPoolImage: typeof inspectImage,
): WorkloadAdmissionDomainDependencies {
  return {
    resolve: resolveWorkloadAdmission,
    prepare: prepareWorkloadCreation,
    persist: persistWorkloadCreation,
    submitTargeted: (actor, input, signal) =>
      submitTargetedJob(
        {
          deployments: persistence.deployments,
          persist: persistTargetedWorkload,
          resolveScope: resolveOwnershipScope,
          validateId,
          now: Date.now,
        },
        actor,
        input,
        signal,
      ),
    submitNodePoolService: (actor, input, signal) =>
      submitNodePoolService(
        {
          nodePools: persistence.nodePools,
          resolveScope: resolveOwnershipScope,
          observeCapacity: (nodePoolId) =>
            getDefaultNodePoolRuntime().controller.observeCapacity(nodePoolId),
          assertClusterCompatible: (clusterId, requestSignal) =>
            getDefaultNodePoolRuntime().controller.assertClusterCompatible(
              clusterId,
              requestSignal,
            ),
          inspectImage,
          preflightSecrets: preflightRuntimeSecrets,
          validateId,
          persist: async (workload) => {
            await persistNodePoolServiceWorkload(workload);
            void getDefaultNodePoolServiceRuntime().reconciler.schedule(
              workload.id,
            );
          },
        },
        actor,
        input,
        signal,
      ),
    submitPoolJob: (actor, input, signal) =>
      submitPoolJob(
        {
          nodePools: persistence.nodePools,
          resolveScope: resolveOwnershipScope,
          inspectImage: inspectPoolImage,
          preflightSecrets: preflightRuntimeSecrets,
          validateId,
          admitStorage: admitPoolJobStorage,
          persist: persistPoolJob,
          schedule: (id) => getDefaultDeploymentControl().schedule(id),
        },
        actor,
        input,
        signal,
      ),
    recordEvent,
    now: Date.now,
    workloadApiUrl: getWorkloadApiUrl,
  };
}

function managementDependencies(
  persistence: Persistence,
): WorkloadManagementDomainDependencies {
  return {
    jobChanges: persistence.jobChanges,
    store: persistence.workloadQueries,
    spend: persistence.workloadSpend,
    submissions: persistence.deploymentExecutions,
    outcomes: persistence.workloadOutcomes,
    credentials: persistence.credentialSecrets,
    resolveScope: resolveOwnershipScope,
    validateTargetDeployment: async (deploymentId, scope) => {
      const target = await persistence.deployments.getForScope(
        deploymentId,
        scope,
      );
      if (!target || target.deletionRequestedAt !== null) {
        throw new WorkloadManagementError(
          target
            ? 'The target Deployment is draining and cannot accept a resubmission.'
            : 'The target Deployment no longer exists.',
          target ? 409 : 404,
        );
      }
    },
    prepareCheckpoint: prepareStoredServiceCheckpoint,
    preflightSecrets: preflightRuntimeSecrets,
    requestCleanup: async (workloadId) => {
      await requestWorkloadCleanup(workloadId);
    },
    getWorkloadOperations: getDefaultWorkloadOperations,
    poolJobWait: async (workload, latestMessage) => {
      // The claim names a session cap that skips the Job (SLOT).
      if (latestMessage?.startsWith('blocked by')) return latestMessage;
      const deployment = await persistence.deployments.getById(
        workload.deploymentId!,
      );
      if (!deployment?.managed) return null;
      const [runtime, block] = await Promise.all([
        getDefaultDeploymentControl().observe(deployment),
        findReplicaCapBlock(deployment.nodePoolId),
      ]);
      return poolJobWait(runtime, block);
    },
    poolJobSpot: async (workload) => managesPoolCheckpoint(workload),
    workloadApiUrl: getWorkloadApiUrl,
    inspectContainerState: async (workload, vm) =>
      (
        await new DockerManager(
          vmSshHost(vm),
          workload.sshPrivateKey,
          vm.sshPort,
          vm.sshUsername,
        ).getContainerStatus(workload.id)
      ).state,
    toWorkloadEvent,
    recordEvent,
    recordStatusEvent,
    logDebug: (message, metadata) => log.debug(message, metadata),
    logWarn: (message, metadata) => log.warn(message, metadata),
    statusHealthCheckTimeoutMs: STATUS_HEALTH_CHECK_TIMEOUT_MS,
    readCheckpointHealth: async (workload) => {
      // A pool Job's checkpoint is its own prefix of the bucket, or the
      // whole managed bucket of a spot pool's Job (RFC 0043).
      const pool = workload.deploymentId !== null;
      const cloudConfig = await (
        pool ? loadPoolJobConfigs : loadWorkloadConfigs
      )(workload);
      if (!cloudConfig) throw new Error('Workload credentials are missing');
      return readWorkloadCheckpointHealth(
        cloudConfig,
        workload.id,
        pool && workload.checkpointBucket ? `${workload.id}/` : '',
      );
    },
    now: Date.now,
  };
}

function quotaDependencies(): QuotaDomainDependencies {
  return {
    getCanceledStatus: handleCanceledQuotaStatus,
    getStatus: handleQuotaStatus,
    recordEvent,
    now: Date.now,
  };
}

function secretsDependencies(
  persistence: Persistence,
): SecretsDomainDependencies {
  return {
    store: persistence.credentialSecrets,
    requestPoll: requestWorkloadPoll,
  };
}

function notificationsDependencies(
  persistence: Persistence,
): NotificationsDomainDependencies {
  return { store: persistence.notifications };
}

function serviceUpgradeDependencies(
  persistence: Persistence,
): ServiceUpgradeDomainDependencies {
  return {
    store: persistence.workloadQueries,
    resolveScope: resolveOwnershipScope,
    prepareCheckpoint: prepareStoredServiceCheckpoint,
    preflightSecrets: preflightRuntimeSecrets,
    inspectImage,
    buildDockerCommand: ({
      workload,
      image,
      command,
      env,
      checkpointHostPath,
    }) =>
      DockerManager.getCommand(
        { ...workload, image, command, env },
        { checkpoint: checkpointHostPath },
        true,
      ),
    updateService: (request) => getDefaultServeRuntime().update(request),
    recordEvent,
    now: Date.now,
  };
}

function spendControlsDependencies(
  persistence: Persistence,
): SpendControlsDomainDependencies {
  return {
    store: persistence.spendControls,
    periods: PERIODS,
    now: () => new Date(),
    calendarWindowStartMs,
    calendarWindowEndMs,
  };
}

/** The Helm-managed API's release surface outside a request (start-up repair). */
export function createHostedSystemRelease(
  identity: HostedSystemReleaseIdentity,
): SystemReleaseDomain {
  return createSystemReleaseDomain(
    systemReleaseDependencies(getPersistence(), identity),
  );
}

/**
 * Production composition root for contract-backed API domains. Concrete
 * persistence, gateways, runtimes, environment values, and telemetry enter the
 * application here; domain factories receive only their declared ports.
 */
export function createApiRpcDomains(
  options: ApiCompositionOptions = {},
): ApiRpcDomains {
  const persistence = getPersistence();
  const overrides = options.overrides ?? {};
  return {
    spendControls:
      overrides.spendControls ??
      createSpendControlsDomain(spendControlsDependencies(persistence)),
    secrets:
      overrides.secrets ??
      createSecretsDomain(secretsDependencies(persistence)),
    notifications:
      overrides.notifications ??
      createNotificationsDomain(notificationsDependencies(persistence)),
    credentials:
      overrides.credentials ??
      createCredentialsDomain(credentialsDependencies(persistence)),
    clusters:
      overrides.clusters ??
      createClustersDomain(
        clusterDependencies(persistence, isHelmManagedApi()),
      ),
    nodePools:
      overrides.nodePools ??
      createNodePoolsDomain(
        nodePoolDependencies(persistence, options.nodePoolCapacity),
      ),
    deployments:
      overrides.deployments ??
      createDeploymentsDomain({
        deployments: persistence.deployments,
        nodePools: persistence.nodePools,
        observeNodePoolCapacity: (nodePoolId) =>
          getDefaultNodePoolRuntime().controller.observeCapacity(nodePoolId, {
            requireObservation: true,
          }),
        jobs: {
          counts: (id) =>
            persistence.deploymentExecutions.countTargetedJobs(id),
          statusSnapshot: (id) =>
            persistence.deploymentExecutions.targetedJobStatusSnapshot(id),
          terminateUnassigned: (id) =>
            persistence.deploymentExecutions.terminateUnassignedTargetedJobs(
              id,
            ),
        },
        runtime: getDefaultDeploymentControl(),
        resolveScope: resolveOwnershipScope,
        generateId: generateDeploymentId,
        inspectImage: options.inspectDeploymentImage ?? inspectImage,
        preflightSecrets: preflightRuntimeSecrets,
        workloadApiUrl: getWorkloadApiUrl,
      }),
    deploymentWorkload:
      overrides.deploymentWorkload ??
      createDeploymentWorkloadDomain({
        jobChanges: persistence.jobChanges,
        deployments: persistence.deployments,
        jobs: persistence.deploymentExecutions,
        claimSpendBlock,
        mintStorage: mintPoolJobStorage,
        runtimes: getDefaultDeploymentRuntimeResolver(),
        reconcile: (id) => getDefaultDeploymentControl().schedule(id),
      }),
    apiAccess:
      overrides.apiAccess ?? createApiAccessDomain(apiAccessDependencies()),
    database:
      overrides.database ??
      createDatabaseDomain({
        getDatabase: getReadOnlyDatabase,
        recordEvent,
        now: Date.now,
      }),
    workloadManagement:
      overrides.workloadManagement ??
      createWorkloadManagementDomain(managementDependencies(persistence)),
    workloadAdmission:
      overrides.workloadAdmission ??
      createWorkloadAdmissionDomain(
        admissionDependencies(
          persistence,
          options.inspectDeploymentImage ?? inspectImage,
        ),
      ),
    bucketMetadata:
      overrides.bucketMetadata ??
      createBucketMetadataDomain(bucketMetadataDependencies()),
    quota: overrides.quota ?? createQuotaDomain(quotaDependencies()),
    serviceUpgrade:
      overrides.serviceUpgrade ??
      createServiceUpgradeDomain(serviceUpgradeDependencies(persistence)),
    systemRelease:
      overrides.systemRelease ??
      createSystemReleaseDomain(
        systemReleaseDependencies(persistence, options.hostedSystemRelease),
      ),
  };
}
