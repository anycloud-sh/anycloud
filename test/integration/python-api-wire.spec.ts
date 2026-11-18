import { claimSpendBlock } from '../../src/api/services/spend-controls.js';
import {
  getPersistence,
  getWorkloadLifecycle,
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore,
} from '../../src/api/services/persistence.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { getTestApiUrl } from '../unit/helpers/api-test-helper.js';
import { TEST_USER_ID } from '../../src/api/services/test-identity.js';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import packageJson from '../../package.json' with { type: 'json' };
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { createApiRpcMiddleware } from '../../src/api/rpc/express.js';
import { createApiRpcDomains } from '../../src/api/composition.js';
import type { AuthenticateApiRequest } from '../../src/api/services/api-authentication.js';
import type { BucketMetadataDomain } from '../../src/api/services/bucket-metadata-domain.js';
import type { CredentialsDomain } from '../../src/api/services/credentials-domain.js';
import { CredentialNotFoundError } from '../../src/api/services/credentials-domain.js';
import type { WorkloadAdmissionDomain } from '../../src/api/services/workload-admission-domain.js';
import type { WorkloadManagementDomain } from '../../src/api/services/workload-management-domain.js';
import type { DeploymentsDomain } from '../../src/api/services/deployments-domain.js';
import type { User } from '../../src/api/services/entities.js';
import type { SecretsDomain } from '../../src/api/services/secrets-domain.js';
import type { WorkloadListResponse } from '../../src/shared/api-contract/workload-management-schemas.js';
import type {
  RedactedCredential,
  SaveCredentialInput,
} from '../../src/shared/api-contract/credentials-schemas.js';
import type { SecretSummary } from '../../src/shared/api-contract/secrets-schemas.js';
import type { DeploymentSummary } from '../../src/shared/api-contract/deployments-schemas.js';
import { SecretInUseError } from '../../src/shared/errors.js';
import { type StoredWorkload } from '../../src/api/services/workload-record.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { ImageRuntime } from '../../src/shared/image.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';

import {
  createDeploymentWorkloadDomain,
  type DeploymentWorkloadDomain,
} from '../../src/api/services/deployment-workload-domain.js';
import {
  getDeploymentStore,
  resetPersistence,
} from '../../src/api/services/persistence.js';
import { getDB } from '../../src/api/services/repositories/db.js';
import { ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE } from '../../src/api/services/kubernetes/pool-objects.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../src/api/services/kubernetes/identity.js';
import {
  makeContainerSpec,
  makeClusterKubernetesClientFixture,
} from '../unit/helpers/fixtures.js';
import { getWorkloadAdmissionWriter } from '../../src/api/services/workload-admission-writer.js';
import { writeLocalApiToken } from './helpers/local-api-token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../..');
const GITHUB_SIGN_IN = 'gho-python-wire-sign-in';
const PYTHON_PROBE = join(HERE, 'fixtures/generated-python-api-wire-client.py');
const ACTOR = {
  id: 'user-1',
  username: 'octocat',
  token: 'valid-token',
} satisfies User;

interface SecretsFixture {
  domain: SecretsDomain;
  deleteSecret: Mock<SecretsDomain['delete']>;
}

function createSecretsFixture(): SecretsFixture {
  let secret: SecretSummary | undefined;
  const deleteSecret = vi.fn<SecretsDomain['delete']>((name, force) => {
    if (name === 'locked' && !force) {
      throw new SecretInUseError(name, ['workload-1']);
    }
    secret = undefined;
    return Promise.resolve();
  });
  return {
    deleteSecret,
    domain: {
      list: vi.fn<SecretsDomain['list']>(() =>
        Promise.resolve(secret ? [secret] : []),
      ),
      save: vi.fn<SecretsDomain['save']>((input) => {
        secret = {
          name: input.name,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        };
        return Promise.resolve();
      }),
      delete: deleteSecret,
    },
  };
}

interface CredentialsFixture {
  domain: CredentialsDomain;
  saveCredential: Mock<CredentialsDomain['save']>;
  deleteCredential: Mock<CredentialsDomain['delete']>;
}

function createCredentialsFixture(): CredentialsFixture {
  let full: SaveCredentialInput | undefined;

  function redacted(): RedactedCredential {
    if (!full) throw new CredentialNotFoundError('prod aws');
    if (full.cloudProvider !== CloudType.AWS || 'kind' in full) {
      throw new Error('The compatibility fixture only accepts AWS keys');
    }
    return {
      name: full.name,
      cloudProvider: full.cloudProvider,
      accessKeyId: full.accessKeyId,
    };
  }

  const saveCredential = vi.fn<CredentialsDomain['save']>((input) => {
    full = input;
    return Promise.resolve();
  });
  const deleteCredential = vi.fn<CredentialsDomain['delete']>((name) => {
    if (full?.name === name) full = undefined;
    return Promise.resolve();
  });
  return {
    saveCredential,
    deleteCredential,
    domain: {
      list: vi.fn<CredentialsDomain['list']>(() =>
        Promise.resolve(full ? [redacted()] : []),
      ),
      get: vi.fn<CredentialsDomain['get']>((name) => {
        if (!full || full.name !== name) {
          throw new CredentialNotFoundError(name);
        }
        return Promise.resolve(redacted());
      }),
      save: saveCredential,
      update: vi.fn<CredentialsDomain['update']>(),
      delete: deleteCredential,
    },
  };
}

interface WorkloadFixture {
  admission: WorkloadAdmissionDomain;
  management: WorkloadManagementDomain;
  submit: Mock<WorkloadAdmissionDomain['submit']>;
  list: Mock<WorkloadManagementDomain['list']>;
  status: Mock<WorkloadManagementDomain['status']>;
  terminate: Mock<WorkloadManagementDomain['terminate']>;
  resubmit: Mock<WorkloadManagementDomain['resubmit']>;
}

interface DeploymentFixture {
  domain: DeploymentsDomain;
  create: Mock<DeploymentsDomain['create']>;
  list: Mock<DeploymentsDomain['list']>;
  get: Mock<DeploymentsDomain['get']>;
  update: Mock<DeploymentsDomain['update']>;
  remove: Mock<DeploymentsDomain['delete']>;
}

function createDeploymentFixture(): DeploymentFixture {
  let deployment: DeploymentSummary = {
    id: 'persistent-model-deployments',
    name: 'model-deployments',
    managed: false,
    privileged: false,
    nodePoolId: 'node-pool-1',
    target: { kind: 'nodePool', nodePoolId: 'node-pool-1' },
    image: 'python-deployment:latest',
    command: ['python', 'deployment.py'],
    readinessProbe: null,
    gracePeriodSeconds: 30,
    usage: null,
    status: null,
    gpuCount: 1,
    envKeys: ['MODEL'],
    secretNames: [],
    minReplicas: 1,
    maxReplicas: 1,
    maxConcurrentJobsPerReplica: 2,
    generation: 1,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    jobs: {
      queued: 0,
      running: 0,
      retrying: 0,
      terminal: 0,
      unreleased: 0,
    },
    workload: null,
  };
  const create = vi.fn<DeploymentsDomain['create']>((_actor, input) => {
    deployment = {
      ...deployment,
      name: input.name,
      nodePoolId: input.nodePool,
      target: { kind: 'nodePool', nodePoolId: input.nodePool },
      image: input.image,
      command: input.command ?? null,
      readinessProbe: input.readinessProbe ?? null,
      envKeys: Object.keys(input.env ?? {}),
      secretNames: input.secrets ?? [],
      maxConcurrentJobsPerReplica: input.maxConcurrentJobsPerReplica,
    };
    return Promise.resolve({ deployment });
  });
  const list = vi.fn<DeploymentsDomain['list']>(() =>
    Promise.resolve({ deployments: [deployment] }),
  );
  const get = vi.fn<DeploymentsDomain['get']>(() =>
    Promise.resolve({
      deployment: {
        ...deployment,
        status: {
          state: 'unknown',
          releasing: false,
          ready: false,
          upgrade: null,
          reason: 'Kubernetes unavailable',
          requestedGeneration: deployment.generation,
          appliedGeneration: null,
          podGeneration: null,
          podName: null,
          podUid: null,
          containerId: null,
          containerReady: null,
          readyReplicas: null,
          applicationReady: null,
          probeConfigured: null,
          observation: 'unavailable',
          observedAt: null,
          observationError: 'connection refused',
          blockingJobs: { total: 0, jobs: [] },
        },
      },
    }),
  );
  const update = vi.fn<DeploymentsDomain['update']>(
    (_actor, _identifier, input) => {
      deployment = {
        ...deployment,
        image: input.image ?? deployment.image,
        readinessProbe:
          input.readinessProbe === undefined
            ? deployment.readinessProbe
            : input.readinessProbe,
        command:
          input.command === undefined ? deployment.command : input.command,
        envKeys:
          input.env === undefined
            ? deployment.envKeys
            : Object.keys(input.env ?? {}),
        secretNames:
          input.secrets === undefined
            ? deployment.secretNames
            : (input.secrets ?? []),
        generation: deployment.generation + 1,
        updatedAt: deployment.updatedAt + 1,
      };
      return Promise.resolve({ deployment });
    },
  );
  const remove = vi.fn<DeploymentsDomain['delete']>(() => {
    deployment = {
      ...deployment,
      deletionRequestedAt: deployment.updatedAt + 1,
      updatedAt: deployment.updatedAt + 1,
    };
    return Promise.resolve({ deployment });
  });
  return {
    create,
    list,
    get,
    update,
    remove,
    domain: { create, list, get, update, delete: remove },
  };
}

function createWorkloadFixture(): WorkloadFixture {
  const workload: StoredWorkload = {
    id: 'python-job',
    userId: ACTOR.username,
    registryUsername: ACTOR.username,
    deploymentId: null,
    nodePoolId: null,
    nodePoolName: null,
    currentExecutionId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    firstClaimedAt: null,
    workloadType: 'job',
    image: 'python-wire:latest',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.micro',
    gpuType: null,
    spot: false,
    state: WorkloadState.Queued,
    startedAt: 1_700_000_000_000,
    completedAt: null,
    cleanedAt: null,
    endReason: null,
    lastAttemptEndReason: null,
    maxRetries: null,
    noCheckpoint: false,
    requireNestedVirtualization: false,
    hostDocker: false,
    dockerCommand: 'docker run python-wire:latest',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: null,
    diskTier: null,
    diskIops: null,
    diskThroughputMibps: null,
    regions: null,
    dockerOptions: null,
    availabilityZone: null,
    env: null,
    githubToken: null,
    vmCount: 0,
    sshPrivateKey: '',
    credentialId: 'credential-1',
    inputStorageCredentialId: null,
    inputStorageRegion: null,
    outputStorageCredentialId: null,
    outputStorageRegion: null,
    checkpointStorageCredentialId: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    imageRuntime: ImageRuntime.Unknown,
    vmDurationMs: null,
    awaitingReleaseMs: null,
    totalCost: null,
    costSource: null,
    dnsRecordId: null,
    publicEndpoint: null,
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
    latestMessage: null,
  };
  const {
    currentExecutionId: _currentExecutionId,
    registryUsername: _registryUsername,
    firstClaimedAt: _firstClaimedAt,
    env: _env,
    githubToken: _githubToken,
    sshPrivateKey: _sshPrivateKey,
    maxRetries: _maxRetries,
    noCheckpoint: _noCheckpoint,
    requireNestedVirtualization: _requireNestedVirtualization,
    hostDocker: _hostDocker,
    ...publicWorkload
  } = workload;
  const listedWorkload: WorkloadListResponse[number] = {
    ...publicWorkload,
    claimed: false,
    version: null,
    isOwnedByCaller: true,
  };
  const listedDeploymentJob: WorkloadListResponse[number] = {
    ...listedWorkload,
    id: 'python-targeted-job',
    deploymentId: 'persistent-model-deployments',
    image: null,
    imageDigest: null,
    command: null,
    dockerOptions: null,
    cloudProvider: null,
    region: null,
    vmType: null,
    credentialId: null,
    dockerCommand: '',
  };
  const {
    credentialId: _credentialId,
    inputStorageCredentialId: _inputStorageCredentialId,
    outputStorageCredentialId: _outputStorageCredentialId,
    checkpointStorageCredentialId: _checkpointStorageCredentialId,
    imageRuntime: _imageRuntime,
    latestMessage: _latestMessage,
    ...statusWorkload
  } = publicWorkload;

  const submit = vi.fn<WorkloadAdmissionDomain['submit']>((_actor, input) =>
    Promise.resolve({
      id: input.id ?? workload.id,
      submissionRevision: 0,
      claimDeadlineAt: null,
    }),
  );
  const list = vi.fn<WorkloadManagementDomain['list']>(() =>
    Promise.resolve([listedWorkload, listedDeploymentJob]),
  );
  let targetedStatusReads = 0;
  const status = vi.fn<WorkloadManagementDomain['status']>((_actor, input) => {
    const targeted = input.id === 'python-targeted-job';
    const state =
      targeted && targetedStatusReads++ > 0
        ? WorkloadState.Errored
        : WorkloadState.Queued;
    return Promise.resolve({
      workload: {
        ...statusWorkload,
        claimed: false,
        id: input.id,
        deploymentId: targeted ? 'persistent-model-deployments' : null,
        state,
        version: null,
        ...(input.id === 'python-targeted-job'
          ? {
              deploymentId: 'persistent-model-deployments',
              image: null,
              imageDigest: null,
              command: null,
              dockerOptions: null,
              cloudProvider: null,
              region: null,
              vmType: null,
              dockerCommand: '',
            }
          : {}),
      },
      events: [
        {
          id: 1,
          workloadId: input.id,
          state,
          metadata:
            state === WorkloadState.Errored
              ? { message: 'application failed' }
              : null,
          createdAt: workload.startedAt,
        },
      ],
      status: WorkloadHealthStatus.Unknown,
      jobsAhead: targeted && state === WorkloadState.Queued ? 2 : null,
    });
  });
  const terminate = vi.fn<WorkloadManagementDomain['terminate']>(() =>
    Promise.resolve({ message: 'Workload termination scheduled' }),
  );
  const resubmit = vi.fn<WorkloadManagementDomain['resubmit']>(() =>
    Promise.resolve({
      message: 'Workload resubmitted',
      submissionRevision: 1,
      claimDeadlineAt: null,
    }),
  );

  return {
    submit,
    list,
    status,
    terminate,
    resubmit,
    admission: { submit },
    management: {
      observeSubmission: vi.fn().mockResolvedValue({
        submissionRevision: 0,
        claimDeadlineAt: null,
        claimed: false,
        outcome: 'pending',
      }),
      costForWorkload: vi.fn<WorkloadManagementDomain['costForWorkload']>(() =>
        Promise.resolve([]),
      ),
      costWindow: vi.fn<WorkloadManagementDomain['costWindow']>(() =>
        Promise.resolve({
          periodMs: 0,
          totalCost: 0,
          totalDurationMs: 0,
          totalJobs: 0,
          totalServices: 0,
          totalVms: 0,
          workloadsWithoutPrice: 0,
          byProvider: {},
          byAgent: {},
          byUser: {},
          includesOtherUsers: false,
        }),
      ),
      list,
      terminate,
      status,
      sshAccess: vi.fn<WorkloadManagementDomain['sshAccess']>(() =>
        Promise.resolve({
          workloadId: workload.id,
          vmIp: '127.0.0.1',
          sshPrivateKey: 'unused',
        }),
      ),
      resubmit,
    },
  };
}

interface BucketFixture {
  domain: BucketMetadataDomain;
  list: Mock<BucketMetadataDomain['list']>;
  objects: Mock<BucketMetadataDomain['objects']>;
  deleteObject: Mock<BucketMetadataDomain['deleteObject']>;
}

function createBucketFixture(): BucketFixture {
  const list = vi.fn<BucketMetadataDomain['list']>(() =>
    Promise.resolve({
      buckets: [
        {
          name: 'training data',
          region: 'us-east-1',
          createdAt: 1_700_000_000_000,
        },
      ],
      nextCursor: null,
    }),
  );
  const objects = vi.fn<BucketMetadataDomain['objects']>(() =>
    Promise.resolve({
      entries: [
        {
          kind: 'object',
          key: 'models/final.bin',
          sizeBytes: 42,
          lastModifiedAt: 1_700_000_000_001,
        },
      ],
      nextCursor: null,
    }),
  );
  const deleteObject = vi.fn<BucketMetadataDomain['deleteObject']>(() =>
    Promise.resolve(),
  );

  return {
    list,
    objects,
    deleteObject,
    domain: {
      list,
      objects,
      create: vi.fn<BucketMetadataDomain['create']>(() => Promise.resolve()),
      delete: vi.fn<BucketMetadataDomain['delete']>(() => Promise.resolve()),
      exists: vi.fn<BucketMetadataDomain['exists']>(() =>
        Promise.resolve({ exists: true }),
      ),
      deleteObject,
      storageTokens: vi.fn<BucketMetadataDomain['storageTokens']>(() =>
        Promise.reject(new Error('not used by the wire tests')),
      ),
    },
  };
}

async function seedWireNodePool(): Promise<void> {
  const persistence = getPersistence();
  await getDB().query(
    `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES ('wire-cred', 'x', ?)`,
    [CloudType.AWS],
  );
  await persistence.clusters.recordSelf({
    id: 'wire-root',
    ownerUserId: TEST_USER_ID,
    name: 'wire-root',
    kubernetesIdentity: 'uid-wire-root',
    connection: '{"stored":true}',
  });
  await persistence.nodePools.create({
    id: 'wire-pool',
    clusterId: 'wire-root',
    ownerUserId: TEST_USER_ID,
    name: 'wire-pool',
    computeCredentialId: 'wire-cred',
    region: 'us-east-1',
    zone: null,
    vmTypes: ['t3.small'],
    minVmCount: 1,
    maxVmCount: 1,
  });
  await persistence.nodePools.markReady('wire-pool');
}

async function createDeploymentExecutionFixture(): Promise<DeploymentWorkloadDomain> {
  resetPersistence();
  await seedWireNodePool();
  const deployments = getDeploymentStore();
  await deployments.create(
    {
      id: 'wire-deployment',
      ownerUserId: ACTOR.id,
      name: 'wire-deployment',
      nodePoolId: 'wire-pool',
      config: makeContainerSpec(),
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
    },
    { kind: 'api' },
  );
  const jobs = getDeploymentExecutionStore();
  for (const id of ['wire-first', 'wire-second', 'wire-third']) {
    await getWorkloadAdmissionWriter().createTargetedWorkload({
      id,
      deploymentId: 'wire-deployment',
      userId: ACTOR.username,
      ownerUserId: ACTOR.id,
    });
  }
  // UUID parsing normalizes uppercase input. Exercise a real claim and retry
  // before the generated client decodes that prior execution identity.
  const previousExecution = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
  const runtime = {
    deploymentId: 'wire-deployment',
    generation: 1,
    podUid: 'wire-pod',
    containerId: 'wire-container',
  };
  const candidate = await jobs.discoverTargetedJob(runtime);
  if (candidate.kind !== 'candidate') {
    throw new Error('Deployment retry fixture had no claim candidate');
  }
  await jobs.claimTargetedJob({
    ...runtime,
    ...candidate.candidate,
    executionId: previousExecution,
  });
  await jobs.reportTargetedJobExecution('wire-first', previousExecution, {
    state: WorkloadState.Retrying,
    reason: 'retry fixture',
  });
  const retry = await queries().getWorkloadReconcileCandidate('wire-first');
  if (
    !retry ||
    (await getWorkloadLifecycle().queueRetryCandidate(
      'wire-first',
      retry.revision,
    )) !== 'queued'
  ) {
    throw new Error('Deployment retry fixture was not queued');
  }
  const pod = {
    metadata: {
      name: 'wire-pod',
      uid: 'wire-pod',
      labels: Object.fromEntries([
        kubernetesWorkloadPodSelector('wire-deployment').split('='),
      ]) as Record<string, string>,
      annotations: { 'anycloud.sh/generation': '1' },
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'workload',
          ready: true,
          containerID: 'wire-container',
          image: 'image',
          imageID: 'image-id',
          restartCount: 0,
        },
      ],
    },
  };
  return createDeploymentWorkloadDomain({
    reconcile: () => undefined,
    jobChanges: getPersistence().jobChanges,
    claimSpendBlock,
    mintStorage: () => Promise.resolve({}),
    deployments,
    jobs,
    runtimes: {
      resolve: vi.fn().mockResolvedValue({
        config: { namespace: 'wire' },
        nodePool: {
          clusterId: 'wire-root',
          nodePoolId: 'wire-pool',
          nvidiaGpusPerNode: 0,
        },
        cluster: makeClusterKubernetesClientFixture({
          authentication: {
            createTokenReview: vi.fn().mockResolvedValue({
              status: {
                authenticated: true,
                audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
                user: {
                  username: `system:serviceaccount:wire:${kubernetesWorkloadResourceName('deployment', 'wire-deployment')}`,
                  extra: {
                    'authentication.kubernetes.io/pod-uid': ['wire-pod'],
                    'authentication.kubernetes.io/pod-name': ['wire-pod'],
                  },
                },
              },
            }),
          },
          core: { readNamespacedPod: vi.fn().mockResolvedValue(pod) },
        }),
      }),
    },
  });
}

function runPythonProbe(
  environment: NodeJS.ProcessEnv,
  probe = PYTHON_PROBE,
): Promise<string> {
  return new Promise((resolveProbe, reject) => {
    execFile(
      process.env.PYTHON_BIN ?? 'python3',
      [probe],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: environment,
        // The probe qualifies both management and workload operations in one
        // process; allow slow SDK imports without changing HTTP budgets.
        timeout: 60_000,
      },
      (error, stdout) =>
        error
          ? reject(
              new Error('Python API compatibility probe failed', {
                cause: error,
              }),
            )
          : resolveProbe(stdout),
    );
  });
}

describe('Generated Python client against production oRPC middleware', () => {
  let server: Server;
  let apiUrl: string;
  let anycloudDir: string;
  let secrets: SecretsDomain;
  let credentials: CredentialsDomain;
  let workloadAdmission: WorkloadAdmissionDomain;
  let workloadManagement: WorkloadManagementDomain;
  let deployments: DeploymentsDomain;
  let bucketMetadata: BucketMetadataDomain;
  let deleteSecret: Mock<SecretsDomain['delete']>;
  let saveCredential: Mock<CredentialsDomain['save']>;
  let deleteCredential: Mock<CredentialsDomain['delete']>;
  let submitWorkload: Mock<WorkloadAdmissionDomain['submit']>;
  let listWorkloads: Mock<WorkloadManagementDomain['list']>;
  let getWorkloadStatus: Mock<WorkloadManagementDomain['status']>;
  let terminateWorkload: Mock<WorkloadManagementDomain['terminate']>;
  let resubmitWorkload: Mock<WorkloadManagementDomain['resubmit']>;
  let createDeployment: Mock<DeploymentsDomain['create']>;
  let listDeployments: Mock<DeploymentsDomain['list']>;
  let getDeployment: Mock<DeploymentsDomain['get']>;
  let updateDeployment: Mock<DeploymentsDomain['update']>;
  let deleteDeployment: Mock<DeploymentsDomain['delete']>;
  let listBuckets: Mock<BucketMetadataDomain['list']>;
  let listBucketObjects: Mock<BucketMetadataDomain['objects']>;
  let deleteBucketObject: Mock<BucketMetadataDomain['deleteObject']>;
  let authenticate: AuthenticateApiRequest;

  beforeEach(async () => {
    const secretsFixture = createSecretsFixture();
    secrets = secretsFixture.domain;
    deleteSecret = secretsFixture.deleteSecret;
    const credentialsFixture = createCredentialsFixture();
    credentials = credentialsFixture.domain;
    saveCredential = credentialsFixture.saveCredential;
    deleteCredential = credentialsFixture.deleteCredential;
    const workloadFixture = createWorkloadFixture();
    workloadAdmission = workloadFixture.admission;
    workloadManagement = workloadFixture.management;
    submitWorkload = workloadFixture.submit;
    listWorkloads = workloadFixture.list;
    getWorkloadStatus = workloadFixture.status;
    terminateWorkload = workloadFixture.terminate;
    resubmitWorkload = workloadFixture.resubmit;
    const deploymentFixture = createDeploymentFixture();
    deployments = deploymentFixture.domain;
    createDeployment = deploymentFixture.create;
    listDeployments = deploymentFixture.list;
    getDeployment = deploymentFixture.get;
    updateDeployment = deploymentFixture.update;
    deleteDeployment = deploymentFixture.remove;
    const bucketFixture = createBucketFixture();
    bucketMetadata = bucketFixture.domain;
    listBuckets = bucketFixture.list;
    listBucketObjects = bucketFixture.objects;
    deleteBucketObject = bucketFixture.deleteObject;
    authenticate = vi.fn<AuthenticateApiRequest>((token) => {
      if (token !== ACTOR.token) throw new Error('Invalid access token');
      return Promise.resolve(ACTOR);
    });

    const deploymentWorkload = await createDeploymentExecutionFixture();
    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate,
        domains: createApiRpcDomains({
          overrides: {
            bucketMetadata,
            deploymentWorkload,
            deployments,
            credentials,
            workloadAdmission,
            workloadManagement,
            secrets,
          },
        }),
      }),
    );

    server = await new Promise<Server>((resolveServer) => {
      const listening = app.listen(0, '127.0.0.1', () =>
        resolveServer(listening),
      );
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address');
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
    anycloudDir = await mkdtemp(join(tmpdir(), 'anycloud-python-wire-'));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveServer, reject) => {
      server.close((error) => (error ? reject(error) : resolveServer()));
    });
    await rm(anycloudDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('preserves request shapes, query coercion, responses, and error messages', async () => {
    const pythonPath = process.env.ANYCLOUD_WHEEL_TEST
      ? ''
      : [join(REPOSITORY_ROOT, 'python/generated'), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(delimiter);
    const stdout = await runPythonProbe({
      ...process.env,
      ANYCLOUD_DIR: anycloudDir,
      API_URL: apiUrl,
      API_VERSION: packageJson.version,
      GITHUB_TOKEN: ACTOR.token,
      PYTHONPATH: pythonPath,
    });

    const output: unknown = JSON.parse(stdout);
    expect(output).toEqual({
      credential: {
        name: 'prod aws',
        cloudProvider: 'AWS',
        accessKeyId: 'AKIAEXAMPLE',
      },
      bucket: {
        name: 'training data',
        object: 'models/final.bin',
      },
      workload: {
        id: 'python-job',
        listed: ['python-job', 'python-targeted-job'],
        state: 'queued',
      },
      deployment: {
        id: 'persistent-model-deployments',
        listed: ['persistent-model-deployments'],
        filtered: ['persistent-model-deployments'],
        generation: 2,
        targetedJobId: 'python-targeted-job',
        targetedJobsAhead: 2,
        targetedState: 'errored',
        draining: true,
      },
      deploymentExecution: {
        claimed: ['wire-first', 'wire-second'],
        replayed: true,
        explicitNull: true,
      },
      conflict: 'SecretInUseApiError',
      workloads: ['workload-1'],
      notFound: 'CredentialNotFoundApiError',
      mismatch: 'ClientVersionMismatchApiError',
      unauthorized: 'UnauthorizedApiError',
      async: {
        secrets: [],
        deployments: ['persistent-model-deployments'],
        claimed: 'wire-third',
        empty: true,
      },
    });
    expect(deleteSecret).toHaveBeenNthCalledWith(
      1,
      'locked',
      false,
      expect.any(AbortSignal),
    );
    expect(deleteSecret).toHaveBeenNthCalledWith(
      2,
      'locked',
      true,
      expect.any(AbortSignal),
    );
    expect(saveCredential).toHaveBeenCalledWith(
      {
        name: 'prod aws',
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret-value',
        overwrite: true,
      },
      expect.any(AbortSignal),
    );
    expect(deleteCredential).toHaveBeenCalledTimes(2);
    expect(submitWorkload).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        id: 'python-job',
        image: 'python-wire:latest',
        credentialName: 'prod aws',
      }),
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(listWorkloads).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ limit: 5 }),
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(getWorkloadStatus).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ id: 'python-job' }),
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(getWorkloadStatus).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ id: 'python-targeted-job' }),
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(terminateWorkload).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ id: 'python-job' }),
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(resubmitWorkload).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ id: 'python-job' }),
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(createDeployment).toHaveBeenCalledWith(
      ACTOR,
      {
        name: 'model-deployments',
        nodePool: 'node-pool-1',
        image: 'python-deployment:latest',
        command: ['python', 'deployment.py'],
        env: { MODEL: 'example' },
        secrets: ['model-db'],
        dockerOptions: { gpus: 'all', runtime: 'nvidia' },
        maxConcurrentJobsPerReplica: 2,
      },
      expect.any(AbortSignal),
    );
    expect(listDeployments.mock.calls).toEqual([
      [ACTOR, undefined, expect.any(AbortSignal)],
      [ACTOR, { nodePool: 'training pool' }, expect.any(AbortSignal)],
      [ACTOR, { nodePool: 'node-pool-1' }, expect.any(AbortSignal)],
    ]);
    expect(updateDeployment.mock.calls.map(([, , body]) => body)).toEqual([
      { command: null, secrets: null, dockerOptions: { gpus: '1' } },
      { dockerOptions: { cpus: '6' } },
      { dockerOptions: { memory: null, privileged: false, binds: [] } },
    ]);
    expect(getDeployment).toHaveBeenCalledWith(
      ACTOR,
      'persistent-model-deployments',
      expect.any(AbortSignal),
    );
    expect(updateDeployment).toHaveBeenCalledWith(
      ACTOR,
      'persistent-model-deployments',
      { command: null, secrets: null, dockerOptions: { gpus: '1' } },
      expect.any(AbortSignal),
    );
    expect(deleteDeployment).toHaveBeenCalledWith(
      ACTOR,
      'persistent-model-deployments',
      expect.any(AbortSignal),
    );
    expect(submitWorkload).toHaveBeenCalledWith(
      ACTOR,
      {
        deployment: 'persistent-model-deployments',
        workloadType: 'job',
        id: 'python-targeted-job',
      },
      packageJson.version,
      expect.any(AbortSignal),
    );
    expect(listBuckets).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialName: 'prod aws',
        pageSize: 5,
      }),
      expect.any(AbortSignal),
    );
    expect(listBucketObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: 'training data',
        credentialName: 'prod aws',
        pageSize: 5,
        recursive: true,
      }),
      expect.any(AbortSignal),
    );
    expect(deleteBucketObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: 'training data',
        credentialName: 'prod aws',
        remotePath: 'models/final.bin',
      }),
      expect.any(AbortSignal),
    );
    expect(authenticate).toHaveBeenCalled();
    expect(
      vi
        .mocked(authenticate)
        .mock.calls.every(([token]) => token === ACTOR.token),
    ).toBe(true);
  }, 75_000);

  it.each(['sync', 'async'])(
    'qualifies the generated Python client convenience workflows (%s)',
    async (mode) => {
      const originalStatus = getWorkloadStatus.getMockImplementation();
      if (!originalStatus)
        throw new Error('Expected a workload status fixture');
      let imageStatusReads = 0;
      getWorkloadStatus.mockImplementation(async (...args) => {
        const response = await originalStatus(...args);
        if (args[1].id === 'parity-image') {
          response.workload.state =
            imageStatusReads++ === 0
              ? WorkloadState.Running
              : WorkloadState.Completed;
        }
        return response;
      });
      submitWorkload.mockImplementation((_actor, input) =>
        Promise.resolve({
          id: input.id ?? 'python-job',
          ...('deployment' in input
            ? { submissionRevision: 0, claimDeadlineAt: null }
            : {}),
        }),
      );
      resubmitWorkload.mockResolvedValue({
        message: 'Workload resubmitted',
      });
      // The loopback API gets its per-install token, with GitHub beside it.
      writeLocalApiToken(anycloudDir, ACTOR.token);
      const stdout = await runPythonProbe(
        {
          ...process.env,
          ANYCLOUD_DIR: anycloudDir,
          API_URL: apiUrl,
          GITHUB_TOKEN: GITHUB_SIGN_IN,
          ANYCLOUD_CLIENT_MODE: mode,
          PYTHONPATH: process.env.ANYCLOUD_WHEEL_TEST
            ? ''
            : [
                join(REPOSITORY_ROOT, 'python/generated'),
                join(REPOSITORY_ROOT, 'python/extensions'),
              ].join(delimiter),
          PYTHONDONTWRITEBYTECODE: '1',
        },
        join(HERE, 'fixtures/python-client-parity-wire.py'),
      );
      expect(JSON.parse(stdout)).toEqual({
        image: 'parity-image',
        deployment: 'persistent-model-deployments',
        targeted: 'python-targeted-job',
      });
      expect(submitWorkload).toHaveBeenCalledTimes(2);
      expect(submitWorkload).toHaveBeenNthCalledWith(
        1,
        ACTOR,
        {
          image: 'trainer:v1',
          credentialName: 'prod aws',
          cloudConfig: {},
          workloadType: 'job',
          id: 'parity-image',
        },
        packageJson.version,
        expect.any(AbortSignal),
      );
      expect(imageStatusReads).toBe(3);
      expect(terminateWorkload).toHaveBeenCalledTimes(1);
      expect(resubmitWorkload).toHaveBeenCalledTimes(1);
      expect(createDeployment).toHaveBeenCalledWith(
        ACTOR,
        {
          name: 'parity deployments',
          image: 'deployment:v1',
          nodePool: 'node-pool-1',
          command: ['python', 'deployment.py'],
          env: { MODEL: 'v1' },
          dockerOptions: { shmSize: '8g' },
          maxConcurrentJobsPerReplica: 2,
        },
        expect.any(AbortSignal),
      );
      expect(listDeployments.mock.calls).toEqual([
        [ACTOR, undefined, expect.any(AbortSignal)],
        [ACTOR, { nodePool: 'training pool' }, expect.any(AbortSignal)],
      ]);
      expect(getDeployment).toHaveBeenCalledWith(
        ACTOR,
        'parity deployments',
        expect.any(AbortSignal),
      );
      expect(updateDeployment).toHaveBeenCalledWith(
        ACTOR,
        'persistent-model-deployments',
        {
          command: null,
          env: null,
          dockerOptions: { memory: null, cpus: '2', binds: [] },
        },
        expect.any(AbortSignal),
      );
      expect(deleteDeployment).toHaveBeenCalledTimes(1);
      expect(authenticate).toHaveBeenCalled();
      expect(
        vi
          .mocked(authenticate)
          .mock.calls.every(
            ([token, , origin]) =>
              token === ACTOR.token && origin?.githubToken === GITHUB_SIGN_IN,
          ),
      ).toBe(true);
    },
    75_000,
  );

  it('qualifies the generated Python client over sync and async HTTP', async () => {
    const pythonPath = process.env.ANYCLOUD_WHEEL_TEST
      ? ''
      : join(REPOSITORY_ROOT, 'python/generated');
    const stdout = await runPythonProbe(
      {
        ...process.env,
        API_URL: apiUrl,
        API_VERSION: packageJson.version,
        GITHUB_TOKEN: ACTOR.token,
        PYTHONPATH: pythonPath,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      PYTHON_PROBE,
    );

    expect(JSON.parse(stdout)).toMatchObject({
      conflict: 'SecretInUseApiError',
      workloads: ['workload-1'],
      mismatch: 'ClientVersionMismatchApiError',
      unauthorized: 'UnauthorizedApiError',
      deployment: {
        listed: ['persistent-model-deployments'],
        filtered: ['persistent-model-deployments'],
      },
      async: {
        secrets: [],
        deployments: ['persistent-model-deployments'],
        claimed: 'wire-third',
        empty: true,
      },
    });
    expect(listDeployments.mock.calls).toEqual([
      [ACTOR, undefined, expect.any(AbortSignal)],
      [ACTOR, { nodePool: 'training pool' }, expect.any(AbortSignal)],
      [ACTOR, { nodePool: 'node-pool-1' }, expect.any(AbortSignal)],
    ]);
    expect(updateDeployment.mock.calls.map(([, , body]) => body)).toEqual([
      { command: null, secrets: null, dockerOptions: { gpus: '1' } },
      { dockerOptions: { cpus: '6' } },
      { dockerOptions: { memory: null, privileged: false, binds: [] } },
    ]);
    expect(deleteSecret).toHaveBeenNthCalledWith(
      1,
      'locked',
      false,
      expect.any(AbortSignal),
    );
    expect(deleteSecret).toHaveBeenNthCalledWith(
      2,
      'locked',
      true,
      expect.any(AbortSignal),
    );
    expect(authenticate).toHaveBeenCalled();
    expect(
      vi
        .mocked(authenticate)
        .mock.calls.some(([token]) => token === ACTOR.token),
    ).toBe(true);
  }, 75_000);
});

describe('installed Python Deployment submissions against production API', () => {
  beforeEach(async () => {
    // Replicas claim from this origin; a loopback one refuses targeted Jobs.
    vi.stubEnv('ANYCLOUD_WORKLOAD_API_URL', 'https://api.example.com');
    resetPersistence();
    await seedWireNodePool();
    await getDeploymentStore().create(
      {
        id: 'wire-deployment',
        name: 'wire-deployment',
        nodePoolId: 'wire-pool',
        ownerUserId: TEST_USER_ID,
        config: makeContainerSpec(),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 2,
      },
      { kind: 'api' },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['sync', 'async'])(
    'qualifies the generated Python client with default IDs, blocking receipts, resubmission, and exact versions (%s)',
    async (mode) => {
      const store = getDeploymentExecutionStore();
      const runtime = {
        deploymentId: 'wire-deployment',
        generation: 1,
        podUid: 'wire-pod',
        containerId: 'wire-container',
      };
      let claiming = false;
      let claimFailure: unknown;
      const timer = setInterval(() => {
        if (claiming) return;
        claiming = true;
        void store
          .discoverTargetedJob(runtime)
          .then((candidate) => {
            if (candidate.kind === 'candidate') {
              return store.claimTargetedJob({
                ...runtime,
                ...candidate.candidate,
                executionId: randomUUID(),
              });
            }
          })
          .catch((error: unknown) => {
            claimFailure = error;
          })
          .finally(() => {
            claiming = false;
          });
      }, 25);
      try {
        const { stdout } = await promisify(execFile)(
          process.env.PYTHON_BIN ?? 'python3',
          [
            join(
              process.cwd(),
              'test/integration/fixtures/python-deployment-submission-wire.py',
            ),
            mode,
          ],
          {
            timeout: 60_000,
            env: {
              ...process.env,
              API_URL: getTestApiUrl(),
              PYTHONDONTWRITEBYTECODE: '1',
              PYTHONPATH: process.env.ANYCLOUD_WHEEL_TEST
                ? ''
                : [
                    join(process.cwd(), 'python/generated'),
                    join(process.cwd(), 'python/extensions'),
                  ].join(delimiter),
            },
          },
        );
        expect(claimFailure).toBeUndefined();
        const result = JSON.parse(stdout) as {
          expired: string;
          running: string;
          peer?: string;
          uncertain?: string[];
        };
        expect(result.expired).not.toBe(result.running);
        expect(await queries().getWorkload(result.expired)).toMatchObject({
          state: 'terminated',
          submissionRevision: 1,
          firstClaimedAt: null,
        });
        const running = await queries().getWorkload(result.running);
        expect(running).toMatchObject({
          state: 'running',
          submissionRevision: 0,
        });
        expect(typeof running?.firstClaimedAt).toBe('number');
        if (mode === 'async') {
          const peer = await queries().getWorkload(result.peer!);
          expect(peer).toMatchObject({
            state: 'running',
            submissionRevision: 0,
          });
          expect(typeof peer?.firstClaimedAt).toBe('number');
          expect(result.uncertain).toHaveLength(2);
          for (const id of result.uncertain!) {
            expect(await queries().getWorkload(id)).toMatchObject({
              state: 'terminated',
              submissionRevision: 0,
              firstClaimedAt: null,
            });
          }
        }
      } finally {
        clearInterval(timer);
      }
    },
  );
});
