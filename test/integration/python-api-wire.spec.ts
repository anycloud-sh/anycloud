import { execFile } from 'node:child_process';
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
import type { User } from '../../src/api/services/entities.js';
import type { SecretsDomain } from '../../src/api/services/secrets-domain.js';
import type { WorkloadListResponse } from '../../src/shared/api-contract/workload-management-schemas.js';
import type {
  RedactedCredential,
  SaveCredentialInput,
} from '../../src/shared/api-contract/credentials-schemas.js';
import type { SecretSummary } from '../../src/shared/api-contract/secrets-schemas.js';
import { SecretInUseError } from '../../src/shared/errors.js';
import { type StoredWorkload } from '../../src/api/services/workload-record.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { ImageRuntime } from '../../src/shared/image.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
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

function createWorkloadFixture(): WorkloadFixture {
  const workload: StoredWorkload = {
    id: 'python-job',
    userId: ACTOR.username,
    registryUsername: ACTOR.username,
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
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
    latestMessage: null,
  };
  const {
    registryUsername: _registryUsername,
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
    version: null,
    isOwnedByCaller: true,
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
    Promise.resolve({ id: input.id ?? workload.id }),
  );
  const list = vi.fn<WorkloadManagementDomain['list']>(() =>
    Promise.resolve([listedWorkload]),
  );
  const status = vi.fn<WorkloadManagementDomain['status']>((_actor, input) =>
    Promise.resolve({
      workload: {
        ...statusWorkload,
        id: input.id,
        state: WorkloadState.Queued,
        version: null,
      },
      events: [
        {
          id: 1,
          workloadId: input.id,
          state: WorkloadState.Queued,
          metadata: null,
          createdAt: workload.startedAt,
        },
      ],
      status: WorkloadHealthStatus.Unknown,
    }),
  );
  const terminate = vi.fn<WorkloadManagementDomain['terminate']>(() =>
    Promise.resolve({ message: 'Workload termination scheduled' }),
  );
  const resubmit = vi.fn<WorkloadManagementDomain['resubmit']>(() =>
    Promise.resolve({ message: 'Workload resubmitted' }),
  );

  return {
    submit,
    list,
    status,
    terminate,
    resubmit,
    admission: { submit },
    management: {
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
  let bucketMetadata: BucketMetadataDomain;
  let deleteSecret: Mock<SecretsDomain['delete']>;
  let saveCredential: Mock<CredentialsDomain['save']>;
  let deleteCredential: Mock<CredentialsDomain['delete']>;
  let submitWorkload: Mock<WorkloadAdmissionDomain['submit']>;
  let listWorkloads: Mock<WorkloadManagementDomain['list']>;
  let getWorkloadStatus: Mock<WorkloadManagementDomain['status']>;
  let terminateWorkload: Mock<WorkloadManagementDomain['terminate']>;
  let resubmitWorkload: Mock<WorkloadManagementDomain['resubmit']>;
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
    const bucketFixture = createBucketFixture();
    bucketMetadata = bucketFixture.domain;
    listBuckets = bucketFixture.list;
    listBucketObjects = bucketFixture.objects;
    deleteBucketObject = bucketFixture.deleteObject;
    authenticate = vi.fn<AuthenticateApiRequest>((token) => {
      if (token !== ACTOR.token) throw new Error('Invalid access token');
      return Promise.resolve(ACTOR);
    });

    const app = express();
    app.use(
      createApiRpcMiddleware({
        authenticate,
        domains: createApiRpcDomains({
          overrides: {
            bucketMetadata,
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
        listed: ['python-job'],
        state: 'queued',
      },
      conflict: 'SecretInUseApiError',
      workloads: ['workload-1'],
      notFound: 'CredentialNotFoundApiError',
      mismatch: 'ClientVersionMismatchApiError',
      unauthorized: 'UnauthorizedApiError',
      async: { secrets: [] },
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
        Promise.resolve({ id: input.id ?? 'python-job' }),
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
      expect(JSON.parse(stdout)).toEqual({ image: 'parity-image' });
      expect(submitWorkload).toHaveBeenCalledTimes(1);
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
      async: { secrets: [] },
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
    expect(authenticate).toHaveBeenCalled();
    expect(
      vi
        .mocked(authenticate)
        .mock.calls.some(([token]) => token === ACTOR.token),
    ).toBe(true);
  }, 75_000);
});
