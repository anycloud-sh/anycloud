import BetterSqlite3 from 'better-sqlite3';

import {
  extractCredentials,
  getRegionsForVMType,
} from '../shared/cloud-config.js';
import type { CloudConfig } from '../shared/cloud.js';
import { DeployError } from '../shared/errors.js';
import { getOwnApiChart, getOwnApiImage, isHelmManagedApi } from './config.js';
import { generateClusterId } from '../shared/id-generator.js';
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
import { persistWorkloadCreation } from './services/workload-admission-persistence.js';
import { prepareWorkloadCreation } from './services/workload-admission-plan.js';
import { resolveWorkloadAdmission } from './services/workload-admission-resolution.js';
import {
  createWorkloadManagementDomain,
  type WorkloadManagementDomainDependencies,
} from './services/workload-management-domain.js';
import {
  preflightRuntimeSecrets,
  prepareStoredServiceCheckpoint,
} from './services/workload-operation-helpers.js';
import { toWorkloadEvent } from './services/repositories/workload-events.js';
import { DockerManager } from './services/docker.js';
import Github from './services/gateways/github.js';
import { canManageCloudResources } from './services/gateways/cloud.js';
import { inspectImage } from '../shared/image-registry.js';
import { resolveApiImage } from '../shared/api-image.js';
import { observeClusterIdentity } from './services/kubernetes/cluster-identity.js';
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
import { isKubernetesNotFoundError } from './services/kubernetes/errors.js';
import { observeHookJob } from './services/system-release/ready-job.js';
import {
  createHostStepExecutor,
  type HostStepExecutor,
} from './services/system-release/host-step.js';
import { SSHManager } from './services/gateways/ssh.js';
import { randomBytes } from 'node:crypto';
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
  issueServiceToken,
  removeApiAccessUser,
  resolveOwnershipScope,
  rotateServiceToken,
  setApiGithubApps,
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
} from './services/spend-controls.js';
import { PERIODS } from './services/spend-controls-store.js';
import {
  createSpendControlsDomain,
  type SpendControlsDomainDependencies,
} from './services/spend-controls-domain.js';
import { fireAndForget } from './services/task.js';
import { readWorkloadCheckpointHealth } from './services/workload-storage.js';
import { recordEvent, recordStatusEvent } from './services/telemetry.js';

export interface ApiCompositionOptions {
  overrides?: Partial<ApiRpcDomains>;
  /** Present on a Helm-managed API: enables the system release surface. */
  hostedSystemRelease?: HostedSystemReleaseIdentity;
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
      removeUser: removeApiAccessUser,
      issueServiceToken,
      rotateServiceToken,
      setGithubApps: setApiGithubApps,
    },
    resolveGithubUser: Github.resolveUser,
    authenticateGithub: Github.authenticate,
    githubIssuingApp: Github.issuingApp,
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
 * Management VM admission for clusters: the catalog must know the target,
 * the provider must isolate capacity networking, and the saved credential
 * must authenticate before durable intent is stored.
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

function admissionDependencies(): WorkloadAdmissionDomainDependencies {
  return {
    resolve: resolveWorkloadAdmission,
    prepare: prepareWorkloadCreation,
    persist: persistWorkloadCreation,
    recordEvent,
    now: Date.now,
  };
}

function managementDependencies(
  persistence: Persistence,
): WorkloadManagementDomainDependencies {
  return {
    store: persistence.workloadQueries,
    spend: persistence.workloadSpend,
    outcomes: persistence.workloadOutcomes,
    credentials: persistence.credentialSecrets,
    resolveScope: resolveOwnershipScope,
    prepareCheckpoint: prepareStoredServiceCheckpoint,
    preflightSecrets: preflightRuntimeSecrets,
    requestCleanup: async (workloadId) => {
      await requestWorkloadCleanup(workloadId);
    },
    getWorkloadOperations: getDefaultWorkloadOperations,
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
      const cloudConfig = await loadWorkloadConfigs(workload);
      if (!cloudConfig) throw new Error('Workload credentials are missing');
      return readWorkloadCheckpointHealth(cloudConfig, workload.id, '');
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
      createWorkloadAdmissionDomain(admissionDependencies()),
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
