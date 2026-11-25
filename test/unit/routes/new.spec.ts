import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  getCredentialSecretStore,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { callApi as rawCallDeployment } from '../helpers/api-test-helper';
import { mockNewWorkloadPayload, mockCloudConfig } from '../config';
import { resetPersistence } from '../../../src/api/services/persistence.js';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import {
  createCheckpointStorageProvider,
  createComputeProvider,
  hashCredential,
  encryptCredential,
} from '../../../src/api/services/cloud-config';
import Github from '../../../src/api/services/gateways/github';
import { TEST_USER_ID } from '../../../src/api/services/test-identity.js';
import {
  CloudType,
  DiskTier,
  type CloudCredentials,
} from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import {
  ImageInspectionFailureReason,
  ImageRuntime,
  ImageVerdict,
} from '../../../src/shared/image.js';
import {
  ApiAccessDeniedError,
  CatalogUnavailableError,
} from '../../../src/shared/errors';
import * as admissionChecks from '../../../src/api/services/workload-admission-checks';
import * as catalogReadiness from '../../../src/api/services/catalog-readiness';
import { inspectImage } from '../../../src/shared/image-registry';
import { getDefaultServeRuntime } from '../../../src/api/services/serve/default-runtime';
import { PROVIDER_DATA } from '../../../src/shared/providers';
import { recordEvent } from '../../../src/api/services/telemetry';
import { kickProvisioningScheduler } from '../../../src/api/services/monitor';
import { getDB } from '../../../src/api/services/repositories/db';
import {
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { storageOnlyComputeMessage } from '../../../src/shared/providers.js';
import {
  TEST_AWS_ROLE,
  TEST_AZURE_ROLE,
  TEST_GCP_ROLE,
} from '../helpers/fixtures.js';

// Generate unique ID for each test to avoid UNIQUE constraint failures
let testCounter = 0;
const getUniqueTestId = () => `test-workload-${Date.now()}-${testCounter++}`;

/** Add the common Bearer header for these domain-heavy route tests. */
async function callApi(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer mock-github-token');
  return rawCallDeployment(url.toString(), {
    ...init,
    headers,
  });
}

async function callUpgrade(
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return callApi(
    `https://example.com/v1/workloads/${encodeURIComponent(id)}/upgrades`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

async function callResubmit(
  id: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return callApi(
    `https://example.com/v1/workloads/${encodeURIComponent(id)}/resubmissions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

async function expectDefinedRpcError(
  response: Response,
  code: string,
  message: string,
): Promise<void> {
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    defined: true,
    code,
    status: 400,
    message: expect.stringContaining(message),
  });
}

const { checkpointBucketExists, outputBucketExists } = vi.hoisted(() => ({
  checkpointBucketExists: vi.fn(),
  outputBucketExists: vi.fn(),
}));

// Mock external dependencies to prevent actual workloads
vi.mock('../../../src/api/services/workload-admission-checks', () => ({
  validateId: vi
    .fn()
    .mockImplementation((id) => id || `test-workload-${Date.now()}`),
  validateCredentials: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/api/services/monitor', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/api/services/monitor')
  >()),
  kickProvisioningScheduler: vi.fn(),
}));
vi.mock('../../../src/api/services/workload-workflows/vm-host-startup', () => ({
  deploy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    createCheckpointStorageProvider: vi.fn((cloudConfig) => ({
      hasBucket: checkpointBucketExists,
      ...(cloudConfig.checkpointStorageCredentials?.cloudProvider === 'AWS'
        ? {
            validateScopedStorageTokenSource: vi.fn(),
            mintScopedStorageToken: vi.fn(),
          }
        : {}),
    })),
    createOutputStorageProvider: vi.fn(() => ({
      hasBucket: outputBucketExists,
    })),
  };
});

// The handler now runs a server-side image preflight. Default to 'ok' so existing
// tests don't make a real registry request; the dedicated tests below override
// the verdict.
vi.mock('../../../src/shared/image-registry', async () => {
  const { ImageRuntime, ImageVerdict } = await vi.importActual<
    typeof import('../../../src/shared/image')
  >('../../../src/shared/image');

  return {
    inspectImage: vi.fn().mockResolvedValue({
      verdict: ImageVerdict.Ok,
      digest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
    }),
  };
});

// Spy on the analytics event without touching the rest of the module: the
// route also imports recordStatusEvent from here.
vi.mock('../../../src/api/services/telemetry', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/telemetry')
    >();
  return { ...real, recordEvent: vi.fn() };
});

vi.mock('../../../src/api/services/gateways/ssh', () => ({
  SSHManager: {
    validateKeypair: vi.fn().mockReturnValue(undefined),
    generateKeypair: vi.fn().mockReturnValue({
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKey anycloud',
      privateKey:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nmock-key\n-----END OPENSSH PRIVATE KEY-----',
    }),
  },
}));

describe('/v1/workloads endpoint', () => {
  beforeEach(() => {
    checkpointBucketExists.mockReset();
    checkpointBucketExists.mockResolvedValue(true);
    vi.mocked(createCheckpointStorageProvider).mockClear();
    vi.mocked(admissionChecks.validateCredentials).mockImplementation(
      async (config) => createComputeProvider(config),
    );
    vi.mocked(recordEvent).mockClear();
    vi.mocked(kickProvisioningScheduler).mockClear();
  });

  it.each([
    packageJson.apiImage,
    `${packageJson.apiImage}:0.1.64`,
    `${packageJson.apiImage}@sha256:${'a'.repeat(64)}`,
  ])(
    '0029/S17 refuses API-image Service admission before durable mutation: %s',
    async (image) => {
      const id = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id,
          image,
          workloadType: 'service',
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'WORKLOAD_ADMISSION_REJECTED',
        message: expect.stringContaining('anycloud api create'),
      });
      expect(await queries().getWorkload(id)).toBeNull();
    },
  );

  it.each([
    [`${packageJson.apiImage}:0.1.64`, `${packageJson.apiImage}:0.1.65`],
    [`${packageJson.apiImage}:0.1.64`, 'nginx:alpine'],
    ['nginx:alpine', `${packageJson.apiImage}:0.1.65`],
  ])(
    '0029/S17 refuses VM-hosted API upgrade from %s to %s before mutation',
    async (image, nextImage) => {
      const id = getUniqueTestId();
      await createWorkload(getDB(), {
        id,
        userId: 'test-user',
        workloadType: WorkloadType.Service,
        image,
        requestedComputeProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-key',
      });
      await walkToState(id, WorkloadState.Running);
      vi.mocked(inspectImage).mockClear();
      const update = vi.spyOn(getDefaultServeRuntime(), 'update');
      try {
        const response = await callUpgrade(id, { image: nextImage });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code: 'SERVICE_UPGRADE_INVALID',
          message: expect.stringContaining('anycloud api create'),
        });
        expect(inspectImage).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(await queries().getWorkload(id)).toMatchObject({
          image,
          state: WorkloadState.Running,
        });
      } finally {
        update.mockRestore();
      }
    },
  );

  it('should accept workload request with env field', async () => {
    const testId = getUniqueTestId();
    const payload = { ...mockNewWorkloadPayload, id: testId };

    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status !== 202) {
      console.error('New workload error:', await response.text());
    }

    expect(response.status).toBe(202);

    const data = await response.json();
    expect(data).toHaveProperty('id');
    expect(data.id).toBe(testId);
  });

  it('kicks the provisioning scheduler once the Job is queued', async () => {
    const id = getUniqueTestId();
    let queued: unknown;
    vi.mocked(kickProvisioningScheduler).mockImplementationOnce(() => {
      queued = queries().getWorkload(id);
    });

    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...mockNewWorkloadPayload, id }),
    });

    expect(response.status).toBe(202);
    expect(kickProvisioningScheduler).toHaveBeenCalledOnce();
    await expect(queued).resolves.toMatchObject({
      state: WorkloadState.Queued,
    });
  });

  it('rejects admission when SQLite silently skips the workload insert', async () => {
    const testId = getUniqueTestId();
    const db = getDB();
    await db.query(`CREATE TRIGGER ignore_test_workload BEFORE INSERT ON workloads
      BEGIN SELECT RAISE(IGNORE); END`);
    try {
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mockNewWorkloadPayload, id: testId }),
      });

      expect(response.status).toBe(500);
      expect(recordEvent).toHaveBeenCalledWith(
        expect.anything(),
        'new',
        expect.objectContaining({
          error: `Workload ${testId}: expected exactly one workload insert`,
        }),
      );
      expect(
        await db.query('SELECT id FROM workloads WHERE id = ?', [testId]),
      ).toEqual([]);
      expect(
        await db.query(
          'SELECT workload_id FROM container_specs WHERE workload_id = ?',
          [testId],
        ),
      ).toEqual([]);
    } finally {
      await db.query('DROP TRIGGER ignore_test_workload');
    }
  });

  it('normalizes and stores disk tier from workload requests', async () => {
    const testId = getUniqueTestId();
    const payload = {
      ...mockNewWorkloadPayload,
      id: testId,
      cloudConfig: {
        ...mockCloudConfig,
        diskSizeGb: 100,
        diskTier: 'ultra',
      },
    };

    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(202);

    const workload = await queries().getWorkload(testId);
    expect(workload?.diskSizeGb).toBe(100);
    expect(workload?.diskTier).toBe(DiskTier.Ultra);
  });

  it('rejects unsupported disk tier aliases', async () => {
    const testId = getUniqueTestId();
    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: {
          ...mockCloudConfig,
          diskTier: 'best',
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [
          expect.objectContaining({
            code: 'invalid_value',
            path: ['cloudConfig', 'diskTier'],
          }),
        ],
      },
    });
    expect(await queries().getWorkload(testId)).toBeNull();
  });

  it('rejects one bucket assigned to checkpoint and output sync roles', async () => {
    const testId = getUniqueTestId();
    const credentialRows = () => getDB().query('SELECT id FROM credentials');
    const credentialsBefore = await credentialRows();
    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: {
          ...mockCloudConfig,
          outputBucket: 'shared-state',
          checkpointBucket: 'shared-state',
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKLOAD_ADMISSION_REJECTED',
      message:
        'Output bucket name cannot be "shared-state" (conflicts with checkpoint bucket)',
    });
    expect(await queries().getWorkload(testId)).toBeNull();
    expect(await credentialRows()).toEqual(credentialsBefore);
  });

  it('should accept workload request without env field', async () => {
    const testId = getUniqueTestId();
    const payloadWithoutEnv = {
      ...mockNewWorkloadPayload,
      id: testId,
      env: undefined,
    };
    delete payloadWithoutEnv.env;

    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadWithoutEnv),
    });

    if (response.status !== 202) {
      console.error('New workload error:', await response.text());
    }

    expect(response.status).toBe(202);

    const data = await response.json();
    expect(data).toHaveProperty('id');
  });

  it('rejects an unknown cloud provider as a request error, not a crash', async () => {
    const testId = getUniqueTestId();
    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: { cloudProvider: 'not-a-cloud' },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      defined: false,
      code: 'BAD_REQUEST',
      status: 400,
      message: 'Input validation failed',
      data: {
        issues: [
          expect.objectContaining({
            code: 'invalid_value',
            path: ['cloudConfig', 'cloudProvider'],
          }),
        ],
      },
    });
    expect(await queries().getWorkload(testId)).toBeNull();
  });

  it('0047/S10 rejects inline AWS session credentials at submit and stores nothing', async () => {
    const testId = getUniqueTestId();
    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: {
          ...mockCloudConfig,
          credentials: {
            ...mockCloudConfig.credentials,
            sessionToken: 'temporary-session-token',
          },
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      'session credentials cannot be used',
    );
    expect(await queries().getWorkload(testId)).toBeNull();
  });

  // RFC 0047: a role connection is saved, never inline; inline stays key-only.
  it.each([TEST_AWS_ROLE, TEST_GCP_ROLE, TEST_AZURE_ROLE])(
    'rejects an inline $cloudProvider role connection as storage and stores nothing',
    async (role) => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {
            ...mockCloudConfig,
            outputBucket: 'results',
            outputStorageCredentials: role,
            outputStorageRegion: 'us-east-1',
          },
        }),
      });

      expect(response.status).toBe(400);
      // The key-only schema refuses the role's own fields.
      expect(JSON.stringify(await response.json())).toContain('"keys":["kind"');
      expect(await queries().getWorkload(testId)).toBeNull();
    },
  );

  it('queues a URL-preserving serve upgrade on the existing workload row', async () => {
    const testId = getUniqueTestId();
    const checkpointCreds: CloudCredentials = {
      cloudProvider: CloudType.AWS,
      accessKeyId: `upgrade-${testId}`,
      secretAccessKey: 'test-secret',
    };
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(checkpointCreds),
      await encryptCredential(checkpointCreds),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.small',
      checkpointBucket: 'service-state',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-key',
      credentialId,
      command: ['node', 'old.js'],
    });
    await walkToState(testId, WorkloadState.Running);
    // A cloud serve that reached Running has a published endpoint; the
    // upgrade response derives its url from this record.
    await ledger().updateDnsRecordId(testId, 'dns-record-test');
    vi.mocked(inspectImage).mockResolvedValueOnce({
      verdict: ImageVerdict.Ok,
      digest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
    });
    const updateSpy = vi.spyOn(getDefaultServeRuntime(), 'update');

    try {
      const response = await callUpgrade(testId, {
        image: 'nginx:v2',
        command: ['node', 'new.js'],
      });

      if (response.status !== 202) {
        console.error('Serve upgrade error:', await response.text());
      }

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        id: testId,
        url: `https://${testId}.anycloud.sh`,
      });
      expect(inspectImage).toHaveBeenCalledWith(
        'nginx:v2',
        'mock-github-token',
        'amd64',
      );
      expect(checkpointBucketExists).toHaveBeenCalledWith('service-state');
      expect(updateSpy).toHaveBeenCalledWith({
        workload: expect.objectContaining({
          id: testId,
          workloadType: WorkloadType.Service,
          image: 'nginx:v1',
          state: WorkloadState.Running,
        }),
        update: expect.objectContaining({
          id: testId,
          image: 'nginx:v2',
          previousImage: 'nginx:v1',
        }),
      });

      const workload = await queries().getWorkload(testId);
      expect(workload?.id).toBe(testId);
      expect(workload?.userId).toBe('test-user');
      expect(workload?.state).toBe(WorkloadState.Recovering);
      expect(workload?.image).toBe('nginx:v2');
      expect(workload?.command).toEqual(['node', 'new.js']);
      expect(workload?.imageDigest).toBe(
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(workload?.githubToken).toBe('mock-github-token');
      expect(workload?.dockerCommand).toContain('nginx:v2');
      expect(workload?.dockerCommand).toContain('new.js');
      expect(workload?.dockerCommand).toContain(
        '/mnt/checkpoint:/mnt/checkpoint',
      );

      const events = await eventLog().getWorkloadEvents(testId);
      const latest = events.at(-1);
      expect(latest?.state).toBe(WorkloadState.Recovering);
      expect(latest?.metadata ? JSON.parse(latest.metadata) : null).toEqual({
        reason: 'serve-upgrade',
        previousImage: 'nginx:v1',
        image: 'nginx:v2',
      });
    } finally {
      updateSpy.mockRestore();
    }
  });

  it.each([{ binds: ['data:/data', 'workspaces:/workspace'] }, { binds: [] }])(
    'merges Service environment changes and replaces binds with $binds',
    async ({ binds }) => {
      const testId = getUniqueTestId();
      await createWorkload(getDB(), {
        id: testId,
        userId: 'test-user',
        workloadType: WorkloadType.Service,
        image: 'nginx:v1',
        requestedComputeProvider: CloudType.Local,
        dockerCommand: 'old command',
        sshPrivateKey: 'test-key',
        command: ['node', 'server.js'],
        env: { KEEP: 'kept-value', MODE: 'old', PORT: '8088' },
        dockerOptions: { memory: '2g', binds: ['old-data:/old'] },
      });
      await walkToState(testId, WorkloadState.Running);
      await ledger().updateDnsRecordId(testId, 'retained-dns');

      const response = await callUpgrade(testId, {
        image: 'nginx:v2',
        env: { MODE: 'production', ADDED: 'new-value', PORT: '9000' },
        binds,
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        id: testId,
        url: `https://${testId}.anycloud.sh`,
      });
      const workload = await queries().getWorkload(testId);
      expect(workload).toMatchObject({
        state: WorkloadState.Recovering,
        image: 'nginx:v2',
        command: ['node', 'server.js'],
        env: {
          KEEP: 'kept-value',
          MODE: 'production',
          ADDED: 'new-value',
          PORT: '9000',
        },
        dockerOptions: { memory: '2g', binds },
        dnsRecordId: 'retained-dns',
      });
      expect(workload?.dockerCommand).not.toContain('old-data:/old');
      for (const bind of binds) expect(workload?.dockerCommand).toContain(bind);
      expect(workload?.dockerCommand).toContain('-p 0.0.0.0:80:9000');
      expect(
        JSON.stringify(
          await getDB().query(
            'SELECT env FROM container_specs WHERE workload_id = ?',
            [testId],
          ),
        ),
      ).not.toContain('new-value');
    },
  );

  it.each(['data:relative', 'data:/mnt/checkpoint', 'data:/mnt'])(
    'rejects invalid upgrade mount %s before changing the Service',
    async (bind) => {
      const testId = getUniqueTestId();
      await createWorkload(getDB(), {
        id: testId,
        userId: 'test-user',
        workloadType: WorkloadType.Service,
        image: 'nginx:v1',
        dockerCommand: 'old command',
        sshPrivateKey: 'test-key',
        checkpointBucket: 'retained-checkpoints',
        env: { KEEP: 'kept' },
        dockerOptions: { binds: ['data:/data'] },
      });
      await walkToState(testId, WorkloadState.Running);
      const before = await queries().getWorkload(testId);
      vi.mocked(inspectImage).mockClear();

      const response = await callUpgrade(testId, {
        image: 'nginx:v2',
        env: { KEEP: 'changed' },
        binds: [bind],
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'SERVICE_UPGRADE_INVALID',
      });
      expect(inspectImage).not.toHaveBeenCalled();
      expect(checkpointBucketExists).not.toHaveBeenCalled();
      expect(await queries().getWorkload(testId)).toEqual(before);
    },
  );

  it('returns a null URL when upgrading a Local Service without DNS', async () => {
    const testId = getUniqueTestId();
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-key',
    });
    await walkToState(testId, WorkloadState.Running);
    const updateSpy = vi.spyOn(getDefaultServeRuntime(), 'update');

    try {
      const response = await callUpgrade(testId, {
        image: 'nginx:v2',
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        id: testId,
        url: null,
      });
      expect(updateSpy).toHaveBeenCalledOnce();
      expect((await queries().getWorkload(testId))?.dnsRecordId).toBeNull();
    } finally {
      updateSpy.mockRestore();
    }
  });

  it('rejects an ordinary Service upgrade before mutation when its checkpoint bucket is missing', async () => {
    checkpointBucketExists.mockResolvedValueOnce(false);
    const testId = getUniqueTestId();
    const checkpointCreds: CloudCredentials = {
      cloudProvider: CloudType.AWS,
      accessKeyId: `missing-upgrade-${testId}`,
      secretAccessKey: 'test-secret',
    };
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(checkpointCreds),
      await encryptCredential(checkpointCreds),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.small',
      checkpointBucket: 'deleted-service-state',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-key',
      credentialId,
    });
    await walkToState(testId, WorkloadState.Running);
    vi.mocked(inspectImage).mockClear();
    const updateSpy = vi.spyOn(getDefaultServeRuntime(), 'update');

    try {
      const response = await callUpgrade(testId, {
        image: 'nginx:v2',
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'SERVICE_UPGRADE_INVALID',
        message: expect.stringContaining(
          'Checkpoint bucket "deleted-service-state" not found. Recreate it before upgrading this Service',
        ),
      });
      expect(inspectImage).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect((await queries().getWorkload(testId))?.state).toBe(
        WorkloadState.Running,
      );
      expect((await queries().getWorkload(testId))?.image).toBe('nginx:v1');
    } finally {
      updateSpy.mockRestore();
    }
  });

  it('lets a shared API member upgrade a Service someone else created', async () => {
    const testId = getUniqueTestId();
    await createWorkload(getDB(), {
      id: testId,
      userId: 'teammate',
      ownerUserId: '77',
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-key',
    });
    await walkToState(testId, WorkloadState.Running);
    await upsertApiAccessOwner('original-owner', '77');
    await upsertApiAccessUser({ userId: TEST_USER_ID, username: 'test-user' });
    const updateSpy = vi.spyOn(getDefaultServeRuntime(), 'update');

    try {
      const response = await callUpgrade(testId, {
        image: 'nginx:v2',
      });

      expect(response.status).toBe(202);
      expect(updateSpy).toHaveBeenCalledOnce();
    } finally {
      updateSpy.mockRestore();
      await getDB().query('DELETE FROM api_access_users');
      await getDB().query('DELETE FROM api_access_policy');
    }
  });

  it('rejects serve upgrade for non-service workloads', async () => {
    const testId = getUniqueTestId();
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Job,
      image: 'nginx:v1',
      region: 'us-east-1',
      vmType: 't3.small',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-key',
    });
    await walkToState(testId, WorkloadState.Running);

    const response = await callUpgrade(testId, {
      image: 'nginx:v2',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SERVICE_UPGRADE_INVALID',
      message: 'serve upgrade only supports service workloads',
    });
    const workload = await queries().getWorkload(testId);
    expect(workload?.state).toBe(WorkloadState.Running);
    expect(workload?.image).toBe('nginx:v1');
  });

  it('rejects serve upgrade unless the Service is running', async () => {
    const testId = getUniqueTestId();
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: 'nginx:v1',
      region: 'us-east-1',
      vmType: 't3.small',
      dockerCommand: 'docker run nginx:v1',
      sshPrivateKey: 'test-key',
    });

    const response = await callUpgrade(testId, {
      image: 'nginx:v2',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SERVICE_UPGRADE_CONFLICT',
      message:
        'Service workload must be running to upgrade; current state is queued',
    });
    const workload = await queries().getWorkload(testId);
    expect(workload?.state).toBe(WorkloadState.Queued);
    expect(workload?.image).toBe('nginx:v1');
  });

  async function createFailedResubmittable(
    provision?: (testId: string) => Promise<unknown>,
  ): Promise<string> {
    const testId = getUniqueTestId();
    const credential = {
      cloudProvider: CloudType.AWS,
      accessKeyId: `AKIA-${testId}`,
      secretAccessKey: 'secret',
    } satisfies CloudCredentials;
    const credentialId = hashCredential(credential);
    await getCredentialSecretStore().saveNamedCredential(
      `resubmit-${testId}`,
      credentialId,
      await encryptCredential(credential),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Job,
      image: 'alpine:latest',
      region: 'us-east-1',
      vmType: 't3.micro',
      dockerCommand: 'docker run alpine:latest',
      sshPrivateKey: 'test-key',
      credentialId,
    });
    await provision?.(testId);
    await walkToState(testId, WorkloadState.Failed);
    return testId;
  }

  function requestResubmit(id: string): Promise<Response> {
    return callResubmit(id);
  }

  it('0036/S10 refuses resubmission of a legacy API Service without recreating it', async () => {
    const id = getUniqueTestId();
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: `${packageJson.apiImage}:0.1.64`,
      dockerCommand: 'docker run test',
      sshPrivateKey: 'test-key',
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    });
    await walkToState(id, WorkloadState.Terminated);
    const response = await requestResubmit(id);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('anycloud api create');
    expect(await queries().getWorkload(id)).toMatchObject({
      state: WorkloadState.Terminated,
    });
  });

  it('0036/S11 rejects resubmission of a VM workload', async () => {
    const testId = getUniqueTestId();
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Vm,
      image: 'ghcr.io/acme/dev:latest',
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run vm',
      sshPrivateKey: 'test-key',
      requestedComputeProvider: CloudType.AWS,
    });
    await walkToState(testId, WorkloadState.Failed);
    const resubmitSpy = vi.spyOn(
      getWorkloadOutcomes(),
      'resubmitWorkloadForScope',
    );

    try {
      const response = await requestResubmit(testId);

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'VM workloads cannot be resubmitted',
      );
      expect(resubmitSpy).not.toHaveBeenCalled();
      expect((await queries().getWorkload(testId))?.state).toBe(
        WorkloadState.Failed,
      );
    } finally {
      resubmitSpy.mockRestore();
    }
  });

  it('allows resubmission of credentialless Local workloads', async () => {
    const testId = getUniqueTestId();
    await createWorkload(getDB(), {
      id: testId,
      userId: 'test-user',
      workloadType: WorkloadType.Job,
      image: 'alpine:latest',
      region: 'local',
      vmType: 'local',
      dockerCommand: 'docker run alpine:latest',
      sshPrivateKey: 'test-key',
      requestedComputeProvider: CloudType.Local,
    });
    await walkToState(testId, WorkloadState.Failed);
    expect(await getWorkloadOutcomes().markCleanupComplete(testId)).toBe(true);

    const response = await requestResubmit(testId);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      message: `Workload ${testId} resubmitted`,
    });
    expect((await queries().getWorkload(testId))?.state).toBe(
      WorkloadState.Queued,
    );
  });

  it('reports a live VM as still releasing instead of an unresubmittable state', async () => {
    const testId = await createFailedResubmittable((id) =>
      provisionTestVm(id, { ip: '10.0.0.5', cloudId: `${id}-vm` }),
    );

    const response = await requestResubmit(testId);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'resources are still being released',
    );
    expect((await queries().getWorkload(testId))?.state).toBe(
      WorkloadState.Failed,
    );
  });

  it('reports an IP-less failed attempt as still releasing too', async () => {
    // A provisioning failure leaves an unended ledger row that never got an IP.
    // It blocks resubmit exactly like a live VM, so it owes the same reason.
    const testId = await createFailedResubmittable((id) =>
      provisionTestVm(id, { cloudId: `${id}-0` }, { region: 'us-east-1' }),
    );

    const response = await requestResubmit(testId);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'resources are still being released',
    );
    expect((await queries().getWorkload(testId))?.state).toBe(
      WorkloadState.Failed,
    );
  });

  it('reports network-only cleanup as still releasing without a VM row', async () => {
    const testId = await createFailedResubmittable();

    const response = await requestResubmit(testId);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'resources are still being released',
    );
    expect(await ledger().getProvisioningAttempts(testId)).toEqual([]);

    expect(await getWorkloadOutcomes().markCleanupComplete(testId)).toBe(true);
    const retried = await requestResubmit(testId);
    expect(retried.status).toBe(202);
    expect((await queries().getWorkload(testId))?.state).toBe(
      WorkloadState.Queued,
    );
  });

  it('should handle empty env object', async () => {
    const testId = getUniqueTestId();
    const payloadWithEmptyEnv = {
      ...mockNewWorkloadPayload,
      id: testId,
      env: {},
    };

    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadWithEmptyEnv),
    });

    if (response.status !== 202) {
      console.error('New workload error:', await response.text());
    }

    expect(response.status).toBe(202);

    const data = await response.json();
    expect(data).toHaveProperty('id');
  });

  it('should reject request with missing required fields', async () => {
    const invalidPayload = {
      image: 'nginx:alpine',
      // Missing required fields
    };

    const response = await callApi('https://example.com/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidPayload),
    });

    expect(response.status).toBe(400);
  });

  it('rejects owner-policy failures before credential or secret lookup', async () => {
    const store = getCredentialSecretStore();
    const getNamedCredentialSpy = vi.spyOn(store, 'getNamedCredential');
    const listNamedCredentialsSpy = vi.spyOn(store, 'listNamedCredentials');
    const getSecretValuesSpy = vi.spyOn(store, 'getSecretValues');
    vi.mocked(Github.authenticate).mockRejectedValueOnce(
      new ApiAccessDeniedError(),
    );

    try {
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
          credentialName: 'private-aws',
          secrets: ['PRIVATE_SECRET'],
        }),
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toContain('API access denied');
      expect(getNamedCredentialSpy).not.toHaveBeenCalled();
      expect(listNamedCredentialsSpy).not.toHaveBeenCalled();
      expect(getSecretValuesSpy).not.toHaveBeenCalled();
    } finally {
      getNamedCredentialSpy.mockRestore();
      listNamedCredentialsSpy.mockRestore();
      getSecretValuesSpy.mockRestore();
    }
  });

  it('returns 503 when the requested provider catalog is not ready', async () => {
    const spy = vi
      .spyOn(catalogReadiness, 'ensureCatalogReady')
      .mockRejectedValueOnce(
        new CatalogUnavailableError(
          'Catalog for AWS is temporarily unavailable; retry shortly.',
        ),
      );
    vi.mocked(inspectImage).mockClear();

    try {
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
        }),
      });

      expect(response.status).toBe(503);
      expect(await response.text()).toContain(
        'Catalog for AWS is temporarily unavailable',
      );
      expect(inspectImage).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  describe('dockerOptions', () => {
    it('should accept workload request with dockerOptions', async () => {
      const testId = getUniqueTestId();
      const payloadWithDockerOptions = {
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: {
          ...mockCloudConfig,
          vmType: 'p5.48xlarge',
        },
        dockerOptions: {
          shmSize: '8g',
          gpus: 'all',
          ipc: 'host',
          ulimits: ['memlock=-1:-1', 'stack=67108864'],
          memory: '32g',
          cpus: '8',
          runtime: 'nvidia',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithDockerOptions),
      });

      if (response.status !== 202) {
        console.error('New workload error:', await response.text());
      }

      expect(response.status).toBe(202);

      const data = await response.json();
      expect(data).toHaveProperty('id');
      expect(data.id).toBe(testId);
    });

    it('should accept workload request with partial dockerOptions', async () => {
      const testId = getUniqueTestId();
      const payloadWithPartialDockerOptions = {
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: {
          ...mockCloudConfig,
          vmType: 'p5.48xlarge',
        },
        dockerOptions: {
          shmSize: '4g',
          gpus: '2',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithPartialDockerOptions),
      });

      if (response.status !== 202) {
        console.error('New workload error:', await response.text());
      }

      expect(response.status).toBe(202);

      const data = await response.json();
      expect(data).toHaveProperty('id');
    });

    it('should accept workload request without dockerOptions', async () => {
      const testId = getUniqueTestId();
      const payloadWithoutDockerOptions = {
        ...mockNewWorkloadPayload,
        id: testId,
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithoutDockerOptions),
      });

      expect(response.status).toBe(202);
    });

    it.each([
      {
        name: 'an unknown runtime',
        dockerOptions: { runtime: 'kata' },
        message: 'support runc and nvidia',
      },
      {
        name: 'a malformed CPU limit',
        dockerOptions: { cpus: 'many' },
        message: '--cpus must be a positive number',
      },
      {
        name: 'GPU access on a CPU VM',
        dockerOptions: { gpus: 'all' },
        message: 'require an NVIDIA CUDA VM',
      },
      {
        name: 'the NVIDIA runtime on a CPU VM',
        dockerOptions: { runtime: 'nvidia' },
        message: 'require an NVIDIA CUDA VM',
      },
      {
        name: 'an unknown Docker option field',
        dockerOptions: { gpu: 'all' },
        message: 'Unknown dockerOptions field',
      },
    ])(
      'rejects $name before image inspection',
      async ({ name, dockerOptions, message }) => {
        const testId = getUniqueTestId();
        vi.mocked(inspectImage).mockClear();

        const response = await callApi('https://example.com/v1/workloads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id: testId,
            dockerOptions,
          }),
        });

        expect(response.status).toBe(400);
        const error = await response.json();
        if (name === 'an unknown Docker option field') {
          expect(error).toMatchObject({
            code: 'BAD_REQUEST',
            data: {
              issues: [
                expect.objectContaining({
                  code: 'unrecognized_keys',
                  keys: ['gpu'],
                  path: ['dockerOptions'],
                }),
              ],
            },
          });
        } else {
          expect(error.message).toContain(message);
        }
        expect(inspectImage).not.toHaveBeenCalled();
        expect(await queries().getWorkload(testId)).toBeNull();
      },
    );

    it('rejects binds that overlap an Anycloud-managed bucket mount', async () => {
      const testId = getUniqueTestId();
      vi.mocked(inspectImage).mockClear();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {
            ...mockCloudConfig,
            outputBucket: 'results',
          },
          dockerOptions: { binds: ['/tmp/results:/mnt/output'] },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'conflicts with Anycloud-managed /mnt/output',
      );
      expect(inspectImage).not.toHaveBeenCalled();
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('rejects binds that overlap the checkpoint mount a spot request creates', async () => {
      const testId = getUniqueTestId();
      vi.mocked(inspectImage).mockClear();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {
            ...mockCloudConfig,
            spot: true,
          },
          dockerOptions: { binds: ['/tmp/ckpt:/mnt/checkpoint'] },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'conflicts with Anycloud-managed /mnt/checkpoint',
      );
      expect(inspectImage).not.toHaveBeenCalled();
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('0036/S22 persists the user dockerOptions verbatim on a GPU submit (no submit-time gpus injection)', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        gpuType: 'h100',
        dockerOptions: { gpus: '2', shmSize: '8g' },
        cloudConfig: {
          ...mockCloudConfig,
          vmType: undefined,
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      // Conduct now defaults --gpus from the resolved config; submit persists
      // exactly what the user sent — the explicit '2' is preserved untouched.
      expect(workload?.dockerOptions).toMatchObject({
        gpus: '2',
        shmSize: '8g',
      });
    });
  });

  describe('vm workload validation', () => {
    const vmPayload = (id: string) => ({
      ...mockNewWorkloadPayload,
      id,
      workloadType: WorkloadType.Vm,
      image: 'ghcr.io/acme/dev:latest',
      env: { FOO: 'bar' },
    });

    it('stores an SSH-only VM without publishing an endpoint', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...vmPayload(testId),
          env: { FOO: 'bar', PORT: '3000' },
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ id: testId });
      const workload = await queries().getWorkload(testId);
      expect(workload?.workloadType).toBe(WorkloadType.Vm);
      expect(workload?.env).toEqual({ FOO: 'bar', PORT: '3000' });
      expect(workload?.dockerCommand).not.toContain('--user');
      expect(workload?.dockerCommand).toContain('--workdir /workspace');
      expect(workload?.dockerCommand).toContain('-v /workspace:/workspace');
      expect(workload?.dockerCommand).not.toContain('0.0.0.0:80:');
    });

    it.each([
      {
        name: 'spot',
        patch: {
          cloudConfig: { ...mockCloudConfig, spot: true },
        },
        message: '--spot',
      },
      {
        name: 'removed persistence flag',
        patch: { persist: true },
        message: 'Unrecognized key',
      },
      {
        name: 'bucket sync',
        patch: {
          cloudConfig: { ...mockCloudConfig, inputBucket: 'inputs' },
        },
        message: 'Buckets are not supported',
      },
      {
        name: 'storage credentials',
        patch: {
          cloudConfig: {
            ...mockCloudConfig,
            inputStorageCredentials: {
              cloudProvider: CloudType.AWS,
              accessKeyId: 'AKIA',
              secretAccessKey: 'secret',
            },
          },
        },
        message: 'Storage credentials and regions are not supported',
      },
      {
        name: 'startup commands',
        patch: { command: ['sleep', '1'] },
        message: 'Startup commands are not supported',
      },
      {
        name: 'Docker options',
        patch: { dockerOptions: { ipc: 'host' } },
        message: 'Custom Docker options are not supported',
      },
      {
        name: 'multiple VM capacity',
        patch: {
          cloudConfig: { ...mockCloudConfig, maxVmCount: 2 },
        },
        message: 'maxVmCount must be exactly 1',
      },
    ])('rejects VM-only exclusion: $name', async ({ patch, message }) => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...vmPayload(testId), ...patch }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(message);
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('accepts pinned Local VM workloads without compute credentials', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...vmPayload(testId),
          cloudConfig: { cloudProvider: CloudType.Local },
        }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ id: testId });
      await expect(queries().getWorkload(testId)).resolves.toMatchObject({
        workloadType: WorkloadType.Vm,
        cloudProvider: CloudType.Local,
        credentialId: null,
      });
    });

    it('rejects the removed direct Cluster target field', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...vmPayload(testId),
          cluster: 'cluster-a',
          cloudConfig: {},
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        defined: false,
        code: 'BAD_REQUEST',
        data: {
          issues: [
            expect.objectContaining({
              code: 'unrecognized_keys',
              keys: ['cluster'],
            }),
          ],
        },
      });
      expect(await queries().getWorkload(testId)).toBeNull();
    });
  });

  describe('job workload validation', () => {
    const localPayload = (id: string) => ({
      ...mockNewWorkloadPayload,
      id,
      cloudConfig: {
        cloudProvider: CloudType.Local,
      },
    });

    it('should accept Local job workloads without compute credentials', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localPayload(testId)),
      });

      expect(response.status).toBe(202);
      const stored = await queries().getWorkload(testId);
      expect(stored?.credentialId).toBeNull();
      expect(stored?.cloudProvider).toBe(CloudType.Local);
    });

    it('should accept Local jobs with named secrets and GPU access', async () => {
      const testId = getUniqueTestId();
      await getCredentialSecretStore().saveSecret('MY_SECRET', {
        TOKEN: 'secret-value',
      });

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...localPayload(testId),
          secrets: ['MY_SECRET'],
          dockerOptions: { gpus: 'all' },
        }),
      });

      expect(response.status).toBe(202);
      const stored = await queries().getWorkload(testId);
      expect(stored?.secretNames).toEqual(['MY_SECRET']);
      expect(stored?.dockerOptions?.gpus).toBe('all');
    });

    it('accepts credentialless Local services without advertising a URL', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...localPayload(testId),
          workloadType: 'service',
        }),
      });

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toEqual({ id: testId });
      const stored = await queries().getWorkload(testId);
      expect(stored?.workloadType).toBe(WorkloadType.Service);
      expect(stored?.cloudProvider).toBe(CloudType.Local);
      expect(stored?.dnsRecordId).toBeNull();
    });

    it('should accept the canonical service type and store the legacy wire value', async () => {
      const testId = getUniqueTestId();
      const servicePayload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'service',
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(servicePayload),
      });

      expect(response.status).toBe(202);
      // Cloud substrates publish an endpoint, so the response advertises it.
      const body = await response.json();
      expect(body.url).toBe(`https://${testId}.anycloud.sh`);
      const stored = await queries().getWorkload(testId);
      expect(stored?.workloadType).toBe('service');
      expect(stored?.imageDigest).toBe(
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
        expect.anything(),
        'new',
        expect.objectContaining({ workloadType: 'service' }),
      );
    });

    it('rejects the persisted server discriminator on the public request', async () => {
      const testId = getUniqueTestId();
      const response = await rawCallDeployment(
        'https://example.com/v1/workloads',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer mock-github-token',
          },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id: testId,
            // Deliberately exercise rejection of the removed discriminator.
            // service-terminology-ok: negative contract coverage
            workloadType: 'server',
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('should use Service env PORT in the stored docker command', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          env: { PORT: '9000' },
        }),
      });

      expect(response.status).toBe(202);
      const stored = await queries().getWorkload(testId);
      expect(stored?.dockerCommand).toContain('-p 0.0.0.0:80:9000');
      expect(stored?.dockerCommand).toContain('PORT=9000');
      expect(stored?.dockerCommand).not.toContain('0.0.0.0:80:8088');
    });

    it('should reject service workloads with invalid env PORT', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          env: { PORT: 'not-a-port' },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'PORT must be an integer between 1 and 65535 for service workloads',
      );
    });

    it('should accept Lambda service workloads', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          cloudConfig: {
            credentials: {
              cloudProvider: 'Lambda',
              apiKey: 'test-lambda-key',
            },
            region: 'us-east-1',
            vmType: 'cpu_4x_general',
            cloudProvider: 'Lambda',
          },
        }),
      });

      expect(response.status).toBe(202);
      const stored = await queries().getWorkload(testId);
      expect(stored?.workloadType).toBe('service');
      expect(stored?.cloudProvider).toBe(CloudType.Lambda);
    });

    it('should reject service workloads with spot', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            spot: true,
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('spot is not supported');
    });

    it('should accept a Service with a pre-existing explicit checkpoint bucket', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            checkpointBucket: 'service-checkpoint',
            checkpointStorageRegion: 'us-west-2',
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(createCheckpointStorageProvider).toHaveBeenCalledWith(
        expect.objectContaining({ checkpointBucket: 'service-checkpoint' }),
      );
      expect(checkpointBucketExists).toHaveBeenCalledWith('service-checkpoint');
      const workload = await queries().getWorkload(testId);
      expect(workload?.checkpointBucket).toBe('service-checkpoint');
      expect(workload?.checkpointStorageCredentialId).toBeNull();
      expect(workload?.checkpointStorageRegion).toBe('us-west-2');
      expect(workload?.dockerCommand).toContain(
        '/mnt/checkpoint:/mnt/checkpoint',
      );
    });

    it('should use a selected named compute credential for a Service checkpoint bucket', async () => {
      const testId = getUniqueTestId();
      const credentialName = `service-compute-${testId}`;
      const computeCred: CloudCredentials = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-SERVICE-COMPUTE',
        secretAccessKey: 'secret',
      };
      const credentialId = hashCredential(computeCred);
      await getCredentialSecretStore().saveNamedCredential(
        credentialName,
        credentialId,
        await encryptCredential(computeCred),
        CloudType.AWS,
      );

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          credentialName,
          cloudConfig: {
            vmType: 't3.medium',
            checkpointBucket: 'service-checkpoint',
            checkpointStorageRegion: 'us-west-2',
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(createCheckpointStorageProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudProvider: CloudType.AWS,
          checkpointBucket: 'service-checkpoint',
        }),
      );
      const workload = await queries().getWorkload(testId);
      expect(workload?.credentialId).toBe(credentialId);
      expect(workload?.checkpointStorageCredentialId).toBeNull();
    });

    it('should reject a remote Service without a selected credential', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          cloudConfig: {
            vmType: 't3.medium',
            checkpointBucket: 'service-checkpoint',
          },
        }),
      });

      await expectDefinedRpcError(
        response,
        'WORKLOAD_ADMISSION_REJECTED',
        'Remote compute requires a selected credential',
      );
      expect(await queries().getWorkload(testId)).toBeNull();
      expect(createCheckpointStorageProvider).not.toHaveBeenCalled();
    });

    it('should reject a Service when its explicit checkpoint bucket does not exist', async () => {
      checkpointBucketExists.mockResolvedValueOnce(false);
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            checkpointBucket: 'missing-service-checkpoint',
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'WORKLOAD_ADMISSION_REJECTED',
        message:
          'Checkpoint bucket "missing-service-checkpoint" not found. Create it before deploying.',
      });
      expect(checkpointBucketExists).toHaveBeenCalledWith(
        'missing-service-checkpoint',
      );
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('should reject service workloads requesting unsupported capacity', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            maxVmCount: 2,
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('launch one Service per VM');
    });

    it.each([
      {
        name: 'input/output buckets',
        patch: {
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            inputBucket: 'input-bucket',
          },
        },
        message: 'input/output buckets',
      },
      {
        name: 'inline input storage credentials',
        patch: {
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            inputStorageCredentials: {
              cloudProvider: 'AWS',
              accessKeyId: 'AKIA',
              secretAccessKey: 'secret',
            },
          },
        },
        message: 'storage credentials',
      },
      {
        name: 'inline output storage credentials',
        patch: {
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            outputStorageCredentials: {
              cloudProvider: 'AWS',
              accessKeyId: 'AKIA',
              secretAccessKey: 'secret',
            },
          },
        },
        message: 'storage credentials',
      },
      {
        name: 'storage regions',
        patch: {
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            outputStorageRegion: 'us-east-1',
          },
        },
        message: 'storage credentials',
      },
    ])(
      'should reject service workloads with job-only $name',
      async ({ patch, message }) => {
        const testId = getUniqueTestId();
        const response = await callApi('https://example.com/v1/workloads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id: testId,
            workloadType: 'service',
            ...patch,
          }),
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toContain(message);
        expect(await queries().getWorkload(testId)).toBeNull();
      },
    );

    it('should reject service workloads with named storage credentials', async () => {
      const testId = getUniqueTestId();
      const name = `service-storage-${testId}`;
      const creds: CloudCredentials = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-SERVICE-STORAGE',
        secretAccessKey: 'secret',
      };
      await getCredentialSecretStore().saveNamedCredential(
        name,
        hashCredential(creds),
        await encryptCredential(creds),
        CloudType.AWS,
      );

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          workloadType: 'service',
          inputStorageCredentialName: name,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('storage credentials');
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it.each(['named', 'inline'] as const)(
      'accepts %s Service checkpoint storage independently of compute credentials',
      async (mode) => {
        const testId = getUniqueTestId();
        const name = `service-checkpoint-storage-${testId}`;
        const creds: CloudCredentials = {
          cloudProvider: CloudType.AWS,
          accessKeyId: `AKIA-SERVICE-CHECKPOINT-${mode}`,
          secretAccessKey: 'secret',
        };
        if (mode === 'named')
          await getCredentialSecretStore().saveNamedCredential(
            name,
            hashCredential(creds),
            await encryptCredential(creds),
            CloudType.AWS,
          );

        const response = await callApi('https://example.com/v1/workloads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id: testId,
            workloadType: 'service',
            ...(mode === 'named'
              ? { checkpointStorageCredentialName: name }
              : {}),
            cloudConfig: {
              ...mockNewWorkloadPayload.cloudConfig,
              checkpointBucket: 'service-checkpoint',
              checkpointStorageRegion: 'us-east-1',
              ...(mode === 'inline'
                ? { checkpointStorageCredentials: creds }
                : {}),
            },
          }),
        });

        expect(response.status).toBe(202);
        expect(await queries().getWorkload(testId)).toMatchObject({
          checkpointBucket: 'service-checkpoint',
          checkpointStorageCredentialId: hashCredential(creds),
        });
      },
    );

    it('accepts named checkpoint storage credentials for a Service on Lambda', async () => {
      const image = 'alpine:latest';
      const testId = getUniqueTestId();
      const name = `service-checkpoint-storage-${testId}`;
      const creds: CloudCredentials = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-SERVICE-CHECKPOINT',
        secretAccessKey: 'secret',
      };
      await getCredentialSecretStore().saveNamedCredential(
        name,
        hashCredential(creds),
        await encryptCredential(creds),
        CloudType.AWS,
      );

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          image,
          workloadType: 'service',
          checkpointStorageCredentialName: name,
          cloudConfig: {
            credentials: {
              cloudProvider: CloudType.Lambda,
              apiKey: 'lambda-test-key',
            },
            cloudProvider: CloudType.Lambda,
            region: 'us-east-1',
            vmType: 'cpu_4x_general',
            checkpointBucket: 'service-cross-cloud-checkpoint',
            checkpointStorageRegion: 'us-east-1',
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(await queries().getWorkload(testId)).toMatchObject({
        checkpointBucket: 'service-cross-cloud-checkpoint',
        checkpointStorageCredentialId: hashCredential(creds),
        checkpointStorageRegion: 'us-east-1',
      });
      expect(createCheckpointStorageProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudProvider: CloudType.Lambda,
          checkpointStorageCredentials: creds,
        }),
      );
    });

    it('should accept env vars for host-side Docker on Lambda', async () => {
      const testId = getUniqueTestId();
      const lambdaEnvPayload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        env: { FOO: 'bar' },
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lambdaEnvPayload),
      });

      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.env).toEqual({ FOO: 'bar' });
    });

    it('should pass non-shell-identifier env keys to Docker on Lambda', async () => {
      const testId = getUniqueTestId();
      const lambdaBadEnvPayload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        env: { 'BAD-KEY': 'x' },
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lambdaBadEnvPayload),
      });

      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.env).toEqual({ 'BAD-KEY': 'x' });
    });

    it('should accept named secrets for host-side Docker injection on Lambda', async () => {
      const testId = getUniqueTestId();
      await getCredentialSecretStore().saveSecret('MY_SECRET', {
        TOKEN: 'secret-value',
      });
      const lambdaSecretsPayload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        env: {},
        secrets: ['MY_SECRET'],
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lambdaSecretsPayload),
      });

      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.secretNames).toEqual(['MY_SECRET']);
    });

    it('should accept a Lambda job with an input bucket backed by AWS S3 creds', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
          inputBucket: 'my-input-bucket',
          inputStorageCredentials: {
            cloudProvider: 'AWS',
            accessKeyId: 'AKIA',
            secretAccessKey: 'secret',
          },
          inputStorageRegion: 'us-east-1',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it('should reject a Lambda bucket backed by AWS S3 creds with a session token', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
          inputBucket: 'my-input-bucket',
          inputStorageCredentials: {
            cloudProvider: 'AWS',
            accessKeyId: 'ASIA',
            secretAccessKey: 'secret',
            sessionToken: 'temporary-session-token',
          },
          inputStorageRegion: 'us-east-1',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'GetFederationToken requires long-term IAM user credentials',
      );
    });

    it('should reject a Lambda bucket backed by non-AWS (GCP) storage creds', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
          inputBucket: 'my-input-bucket',
          inputStorageCredentials: {
            cloudProvider: 'GCP',
            projectId: 'p',
            clientEmail: 'e',
            privateKey: 'k',
          },
          inputStorageRegion: 'us-central1',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'Cross-cloud input storage requires credentials that can mint scoped',
      );
    });

    it('should reject a Lambda bucket with no storage credentials', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        workloadType: 'job',
        command: ['echo', 'hi'],
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: 'cpu_4x_general',
          cloudProvider: 'Lambda',
          inputBucket: 'my-input-bucket',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'Lambda does not provide storage. Set inputStorageCredentials',
      );
    });
  });

  describe('image preflight', () => {
    const submit = async (payload: Record<string, unknown> = {}) =>
      callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
          ...payload,
        }),
      });

    it('rejects an image with no linux/amd64 build before provisioning', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.NoPlatform,
        digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });
      vi.mocked(admissionChecks.validateCredentials).mockClear();

      const response = await submit();

      expect(response.status).toBe(400);
      const msg = await response.text();
      expect(msg).toContain('linux/amd64');
      expect(msg).toContain('buildx');
      // Failed fast — never reached credential validation / provisioning.
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
    });

    it("inspects the image for a Graviton type's arm64 build", async () => {
      vi.mocked(inspectImage).mockClear();

      const response = await submit({
        cloudConfig: { ...mockCloudConfig, vmType: 'm8g.xlarge' },
      });

      expect(response.status).toBe(202);
      expect(inspectImage).toHaveBeenCalledWith(
        'nginx:alpine',
        expect.anything(),
        'arm64',
      );
    });

    it('names arm64 when the image has no build for a Graviton type', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.NoPlatform,
        digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });

      const response = await submit({
        cloudConfig: { ...mockCloudConfig, vmType: 'm8g.xlarge' },
      });

      expect(response.status).toBe(400);
      const msg = await response.text();
      expect(msg).toContain('has no linux/arm64 build');
      expect(msg).toContain('--platform linux/arm64');
    });

    it('refuses a VM type list that mixes arm64 and amd64', async () => {
      vi.mocked(inspectImage).mockClear();

      const response = await submit({
        cloudConfig: {
          ...mockCloudConfig,
          vmType: ['m8g.xlarge', 'm8a.xlarge'],
        },
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'mixes arm64 (m8g.xlarge) and amd64 (m8a.xlarge)',
      );
      expect(inspectImage).not.toHaveBeenCalled();
    });

    it('rejects a not-found image with a clear error', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.NotFound,
        digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });
      const response = await submit();
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('not found');
    });

    it('rejects an inaccessible image with a clear error', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Unauthorized,
        digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });
      const response = await submit();
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Can't access");
    });

    it('reports private GHCR token exchange failures clearly', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Unauthorized,
        digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
        failureReason: ImageInspectionFailureReason.GhcrTokenExchangeFailed,
      });

      const response = await submit({
        image: 'ghcr.io/org/private:tag',
      });

      expect(response.status).toBe(400);
      const msg = await response.text();
      expect(msg).toContain('GHCR rejected the package pull token request');
      expect(msg).toContain('verify the token has read access');
    });

    it('proceeds when the preflight is inconclusive (unknown)', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Unknown,
        digest: null,
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });
      expect((await submit()).status).toBe(202);
    });

    it('rejects when compressed image layers exceed the explicit disk size', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Ok,
        digest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: 2_000_000_000,
      });
      vi.mocked(admissionChecks.validateCredentials).mockClear();

      const response = await submit({
        cloudConfig: {
          ...mockCloudConfig,
          diskSizeGb: 1,
        },
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Increase --disk-size');
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
    });

    it('rejects when compressed image layers exceed the catalog disk size', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Ok,
        digest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: 131_000_000_000,
      });
      vi.mocked(admissionChecks.validateCredentials).mockClear();

      const response = await submit({
        cloudConfig: { ...mockCloudConfig, vmType: 'm5d.large' },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'WORKLOAD_ADMISSION_REJECTED',
        message: expect.stringContaining(
          'catalog disk for VM type "m5d.large"',
        ),
      });
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
    });

    it('proceeds when compressed image layers fit the explicit disk size', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Ok,
        digest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: 2_000_000_000,
      });

      expect(
        (
          await submit({
            cloudConfig: {
              ...mockCloudConfig,
              diskSizeGb: 2,
            },
          })
        ).status,
      ).toBe(202);
    });

    it('proceeds when no disk limit is known', async () => {
      vi.mocked(inspectImage).mockResolvedValueOnce({
        verdict: ImageVerdict.Ok,
        digest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: 2_000_000_000,
      });

      expect((await submit()).status).toBe(202);
    });
  });

  describe('gpuType and vmType mutual exclusion', () => {
    it('should reject request with both gpuType and vmType', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        gpuType: 'h100',
        cloudConfig: {
          ...mockCloudConfig,
          vmType: 't3.medium',
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const errorMsg = await response.text();
      expect(errorMsg).toContain('Cannot specify both gpuType and vmType');
    });
  });

  describe('capability validation', () => {
    it('rejects spot on a non-preemptible cloud with 400 (not 500)', async () => {
      const testId = getUniqueTestId();
      // A gateway lacking the branded Preemptible capability makes
      // isPreemptible() return false, so spot must be rejected. The fix routes
      // this through InvalidAnycloudConfigError (400) instead of a bare Error (500).
      const nonPreemptibleGateway = {};
      vi.mocked(admissionChecks.validateCredentials).mockResolvedValueOnce(
        nonPreemptibleGateway as any,
      );
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        cloudConfig: {
          credentials: { cloudProvider: 'Lambda', apiKey: 'test-lambda-key' },
          region: 'us-east-1',
          vmType: PROVIDER_DATA[CloudType.Lambda].compute!.defaultVmType,
          cloudProvider: 'Lambda',
          spot: true,
        },
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'Lambda does not support spot instances',
      );
    });
  });

  describe('compute credential selection', () => {
    beforeEach(() => {
      resetPersistence();
      vi.mocked(admissionChecks.validateCredentials).mockClear();
      vi.mocked(inspectImage).mockClear();
      vi.mocked(inspectImage).mockResolvedValue({
        verdict: ImageVerdict.Ok,
        digest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        imageRuntime: ImageRuntime.Unknown,
        compressedLayerBytes: null,
      });
    });

    async function seedNamedCred(
      name: string,
      creds: CloudCredentials,
      cloud: CloudType,
    ): Promise<void> {
      await getCredentialSecretStore().saveNamedCredential(
        name,
        hashCredential(creds),
        await encryptCredential(creds),
        cloud,
      );
    }

    it('rejects credentialName arrays', async () => {
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
          credentialName: ['aws-a', 'gcp-b'],
          cloudConfig: { vmType: ['t3.large', 'n2-standard-4'] },
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'BAD_REQUEST',
        data: {
          issues: [expect.objectContaining({ path: ['credentialName'] })],
        },
      });
    });

    const cloudflareCreds: CloudCredentials = {
      cloudProvider: CloudType.Cloudflare,
      accountId: 'cf-account',
      apiToken: 'cf-token',
    };

    it('refuses a storage-only Cloudflare credential as compute', async () => {
      await seedNamedCred('r2', cloudflareCreds, CloudType.Cloudflare);

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
          credentialName: 'r2',
          cloudConfig: {},
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        storageOnlyComputeMessage(CloudType.Cloudflare),
      );
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
    });

    it('refuses Cloudflare as a compute provider without a credential', async () => {
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
          cloudConfig: { cloudProvider: CloudType.Cloudflare },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        storageOnlyComputeMessage(CloudType.Cloudflare),
      );
    });

    it('keeps the implicit Local default when only a Cloudflare credential is saved', async () => {
      await seedNamedCred('r2', cloudflareCreds, CloudType.Cloudflare);

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: getUniqueTestId(),
          cloudConfig: {},
        }),
      });

      expect(response.status).toBe(202);
    });

    it('does not implicitly select Local when a saved compute credential exists', async () => {
      await seedNamedCred(
        'available-aws',
        {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-AVAILABLE',
          secretAccessKey: 'secret',
        },
        CloudType.AWS,
      );
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {},
        }),
      });

      await expectDefinedRpcError(
        response,
        'WORKLOAD_ADMISSION_REJECTED',
        'Remote compute requires a selected credential',
      );
      expect(await queries().getWorkload(testId)).toBeNull();
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
      expect(inspectImage).not.toHaveBeenCalled();
    });

    it('declares provider outages during credential validation as retryable', async () => {
      vi.mocked(admissionChecks.validateCredentials).mockRejectedValueOnce(
        new Error('connect ETIMEDOUT 52.94.233.129:443'),
      );
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mockNewWorkloadPayload, id: testId }),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        defined: true,
        code: 'WORKLOAD_ADMISSION_UNAVAILABLE',
        status: 503,
        message:
          'AWS is temporarily unavailable while validating cloud credentials — please retry.',
      });
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('declares standard credential-validation timeouts as retryable', async () => {
      vi.mocked(admissionChecks.validateCredentials).mockRejectedValueOnce(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mockNewWorkloadPayload, id: testId }),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        defined: true,
        code: 'WORKLOAD_ADMISSION_UNAVAILABLE',
        status: 503,
      });
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('does not use a VM type as an implicit Local provider selector', async () => {
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: { vmType: 'local' },
        }),
      });

      await expectDefinedRpcError(
        response,
        'WORKLOAD_ADMISSION_REJECTED',
        'No compute credentials configured',
      );
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('selects Local for a placementless request when no saved credentials exist and SmolVM is available', async () => {
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {},
        }),
      });

      expect(response.status).toBe(202);
      await expect(queries().getWorkload(testId)).resolves.toMatchObject({
        cloudProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
        credentialId: null,
      });
      expect(admissionChecks.validateCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudProvider: CloudType.Local,
          region: 'local',
          vmType: 'local',
        }),
      );
    });

    // Naming a credential is a dead end for an operator who has none, so an
    // empty store gets the creation command instead of --credentials.
    it('sends a first-run operator to credential creation when no saved credentials or Local capability exist', async () => {
      vi.mocked(admissionChecks.validateCredentials).mockRejectedValueOnce(
        new Error('smolvm is not running'),
      );
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {},
        }),
      });

      await expectDefinedRpcError(
        response,
        'WORKLOAD_ADMISSION_REJECTED',
        'No compute credentials configured. Use "anycloud credentials new" to add credentials.',
      );
      expect(admissionChecks.validateCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ cloudProvider: CloudType.Local }),
      );
      expect(await queries().getWorkload(testId)).toBeNull();
      expect(inspectImage).not.toHaveBeenCalled();
    });

    it('honors an explicit Local API request even when saved credentials exist', async () => {
      await seedNamedCred(
        'available-but-not-selected-aws',
        {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-NOT-SELECTED',
          secretAccessKey: 'secret',
        },
        CloudType.AWS,
      );
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: { cloudProvider: CloudType.Local },
        }),
      });

      expect(response.status).toBe(202);
      await expect(queries().getWorkload(testId)).resolves.toMatchObject({
        cloudProvider: CloudType.Local,
        credentialId: null,
      });
    });

    it('rejects inline credentials that do not match the compute provider', async () => {
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          cloudConfig: {
            cloudProvider: CloudType.AWS,
            vmType: 't3.large',
            credentials: {
              projectId: 'wrong-provider',
              clientEmail: 'agent@example.com',
              privateKey: 'secret',
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'Inline credentials do not match cloudConfig.cloudProvider',
      );
      expect(await queries().getWorkload(testId)).toBeNull();
      expect(admissionChecks.validateCredentials).not.toHaveBeenCalled();
      expect(inspectImage).not.toHaveBeenCalled();
    });

    it('persists an explicitly selected named credential', async () => {
      const creds = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-SELECTED',
        secretAccessKey: 'secret',
      } satisfies CloudCredentials;
      const credentialName = `selected-aws-${Date.now()}-${testCounter++}`;
      await seedNamedCred(credentialName, creds, CloudType.AWS);
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          credentialName,
          cloudConfig: { vmType: 't3.large' },
        }),
      });

      expect(response.status).toBe(202);
      expect((await queries().getWorkload(testId))?.credentialId).toBe(
        hashCredential(creds),
      );
    });

    it("keeps a VM Job's output credential by name after its material is saved under another", async () => {
      const suffix = `${Date.now()}-${testCounter++}`;
      const storageName = `output-aws-${suffix}`;
      const storageCreds = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-OUTPUT',
        secretAccessKey: 'output-secret',
      } satisfies CloudCredentials;
      await seedNamedCred(storageName, storageCreds, CloudType.AWS);

      const secondSave = await callApi(
        `https://example.com/v1/credentials/second-${suffix}?overwrite=false`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(storageCreds),
        },
      );
      expect(secondSave.status).toBe(409);

      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          outputStorageCredentialName: storageName,
          cloudConfig: {
            ...mockNewWorkloadPayload.cloudConfig,
            outputBucket: `output-${suffix}`,
            vmType: 't3.large',
            outputStorageRegion: 'us-east-1',
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(
        (await queries().getWorkload(testId))?.outputStorageCredentialId,
      ).toBe(hashCredential(storageCreds));
    });

    it('persists named storage credentials independently of selected compute', async () => {
      const suffix = `${Date.now()}-${testCounter++}`;
      const computeName = `compute-aws-${suffix}`;
      const storageName = `storage-aws-${suffix}`;
      const computeCreds = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-COMPUTE',
        secretAccessKey: 'compute-secret',
      } satisfies CloudCredentials;
      const storageCreds = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-STORAGE',
        secretAccessKey: 'storage-secret',
      } satisfies CloudCredentials;
      await seedNamedCred(computeName, computeCreds, CloudType.AWS);
      await seedNamedCred(storageName, storageCreds, CloudType.AWS);
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          credentialName: computeName,
          inputStorageCredentialName: storageName,
          outputStorageCredentialName: storageName,
          checkpointStorageCredentialName: storageName,
          cloudConfig: {
            inputBucket: `input-${suffix}`,
            outputBucket: `output-${suffix}`,
            checkpointBucket: `checkpoint-${suffix}`,
            vmType: 't3.large',
            inputStorageRegion: 'us-east-1',
            outputStorageRegion: 'us-east-1',
            checkpointStorageRegion: 'us-east-1',
          },
        }),
      });

      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.credentialId).toBe(hashCredential(computeCreds));
      expect(workload?.inputStorageCredentialId).toBe(
        hashCredential(storageCreds),
      );
      expect(workload?.outputStorageCredentialId).toBe(
        hashCredential(storageCreds),
      );
      expect(workload?.checkpointStorageCredentialId).toBe(
        hashCredential(storageCreds),
      );
    });

    it.each([
      {
        label: 'AWS',
        cloud: CloudType.AWS,
        vmType: 't3.large',
        creds: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-SELECTED-SPOT',
          secretAccessKey: 'secret',
        } satisfies CloudCredentials,
      },
      {
        label: 'Azure',
        cloud: CloudType.Azure,
        vmType: 'Standard_B1s',
        creds: {
          cloudProvider: CloudType.Azure,
          applicationId: 'selected-spot-app',
          secret: 'secret',
          directoryId: 'selected-spot-directory',
          subscriptionId: 'selected-spot-subscription',
        } satisfies CloudCredentials,
      },
      {
        label: 'GCP',
        cloud: CloudType.GCP,
        vmType: 'n2-standard-4',
        creds: {
          cloudProvider: CloudType.GCP,
          projectId: 'selected-spot-project',
          clientEmail: 'selected-spot@example.com',
          privateKey: 'test-private-key',
        } satisfies CloudCredentials,
      },
    ])(
      'accepts a selected $label spot job without explicit checkpoint storage',
      async ({ label, cloud, vmType, creds }) => {
        const credentialName = `selected-spot-${label.toLowerCase()}-${Date.now()}-${testCounter++}`;
        await seedNamedCred(credentialName, creds, cloud);
        const testId = getUniqueTestId();

        const response = await callApi('https://example.com/v1/workloads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id: testId,
            credentialName,
            cloudConfig: { vmType, spot: true },
          }),
        });

        expect(response.status).toBe(202);
        const workload = await queries().getWorkload(testId);
        expect(workload?.credentialId).toBe(hashCredential(creds));
        expect(workload?.checkpointStorageCredentialId).toBeNull();
      },
    );

    it.each([
      {
        id: 'a--b',
        vmType: 'Standard_B1s',
        creds: {
          cloudProvider: CloudType.Azure,
          applicationId: 'selected-spot-app',
          secret: 'secret',
          directoryId: 'selected-spot-directory',
          subscriptionId: 'selected-spot-subscription',
        } satisfies CloudCredentials,
        rule: 'Azure container names must contain only lowercase letters, numbers, and hyphens, must start/end with a letter or number, and must not contain consecutive hyphens.',
      },
      {
        id: 'xn--abc',
        vmType: 't3.large',
        creds: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-SELECTED-SPOT',
          secretAccessKey: 'secret',
        } satisfies CloudCredentials,
        rule: 'S3 reserves the prefix "xn--" for new buckets.',
      },
    ])(
      'rejects a $creds.cloudProvider spot job whose ID $id is not a valid bucket name',
      async ({ id, vmType, creds, rule }) => {
        const credentialName = `selected-spot-invalid-${id}-${Date.now()}-${testCounter++}`;
        await seedNamedCred(credentialName, creds, creds.cloudProvider);

        const response = await callApi('https://example.com/v1/workloads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id,
            credentialName,
            cloudConfig: { vmType, spot: true },
          }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code: 'WORKLOAD_ADMISSION_REJECTED',
          message: `A Spot workload without --checkpoint-bucket uses its ID as its checkpoint bucket name. Invalid bucket name '${id}': ${rule} Pass --checkpoint-bucket or choose a different --id.`,
        });
        expect(await queries().getWorkload(id)).toBeNull();
      },
    );

    it.each([
      [
        'existing checkpoint',
        { spot: true, checkpointBucket: 'a--x-s3' },
        202,
        false,
        0,
      ],
      ['existing output', { outputBucket: 'out-s3alias' }, 202, true, 1],
      ['missing output', { outputBucket: 'out-s3alias' }, 400, false, 1],
      ['ordinary output', { outputBucket: 'results' }, 202, false, 0],
    ])(
      'checks S3 reserved names only for buckets Anycloud creates: %s',
      async (_label, cloudConfig, status, outputExists, lookups) => {
        outputBucketExists.mockReset().mockResolvedValue(outputExists);
        const credentialName = `selected-reserved-${Date.now()}-${testCounter++}`;
        const creds: CloudCredentials = {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA-SELECTED-RESERVED',
          secretAccessKey: 'secret',
        };
        await seedNamedCred(credentialName, creds, CloudType.AWS);

        const response = await callApi('https://example.com/v1/workloads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockNewWorkloadPayload,
            id: getUniqueTestId(),
            credentialName,
            cloudConfig: { vmType: 't3.large', ...cloudConfig },
          }),
        });

        expect(response.status).toBe(status);
        expect(outputBucketExists).toHaveBeenCalledTimes(lookups);
        if (status === 400) {
          await expect(response.json()).resolves.toMatchObject({
            message: expect.stringContaining(
              'Output bucket "out-s3alias" does not exist, and Anycloud cannot create it.',
            ),
          });
        }
      },
    );

    it.each([
      { label: 'with --checkpoint-bucket', id: 'c--d', spot: true },
      { label: 'without spot', id: 'e--f', spot: false },
    ])('admits an Azure job whose ID has -- $label', async ({ id, spot }) => {
      const credentialName = `selected-azure-${id}-${Date.now()}-${testCounter++}`;
      await seedNamedCred(
        credentialName,
        {
          cloudProvider: CloudType.Azure,
          applicationId: 'selected-spot-app',
          secret: 'secret',
          directoryId: 'selected-spot-directory',
          subscriptionId: 'selected-spot-subscription',
        },
        CloudType.Azure,
      );

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id,
          credentialName,
          cloudConfig: {
            vmType: 'Standard_B1s',
            spot,
            ...(spot ? { checkpointBucket: 'user-state' } : {}),
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(await queries().getWorkload(id)).not.toBeNull();
    });
  });
  describe('version validation', () => {
    it('rejects a mismatched client-version header', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
      };

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AnyCloud-Client-Version': '0.0.1',
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const errorMsg = await response.text();
      expect(errorMsg).toContain('Client/API version mismatch');
      expect(errorMsg).toContain('Client version 0.0.1');
      expect(errorMsg).toContain(`API version ${packageJson.version}`);
      expect(errorMsg).toContain('anycloud update');
    });
  });

  describe('removed persist flag', () => {
    it('rejects persist: true from an older client', async () => {
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          persist: true,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('persist');
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('rejects persist: false instead of carrying a compatibility field', async () => {
      const testId = getUniqueTestId();

      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          persist: false,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('persist');
      expect(await queries().getWorkload(testId)).toBeNull();
    });
  });

  describe('image identity and removed workload-image controls', () => {
    const resolvedDigest =
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    it('rejects a caller-supplied image digest', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mockNewWorkloadPayload,
          id: testId,
          imageDigest: 'sha256:client-supplied-value-is-ignored',
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('imageDigest');
      expect(await queries().getWorkload(testId)).toBeNull();
    });

    it('persists the server-resolved image digest', async () => {
      const testId = getUniqueTestId();
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mockNewWorkloadPayload, id: testId }),
      });

      expect(response.status).toBe(202);
      expect((await queries().getWorkload(testId))?.imageDigest).toBe(
        resolvedDigest,
      );
    });
  });

  describe('session / agent attribution', () => {
    it('stamps session and agent on the workload row', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        session: 'claude-1234',
        agent: 'claude',
      };
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.session).toBe('claude-1234');
      expect(workload?.agent).toBe('claude');
    });

    it('leaves columns NULL when caller omits both fields', async () => {
      const testId = getUniqueTestId();
      const payload = { ...mockNewWorkloadPayload, id: testId };
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.session).toBeNull();
      expect(workload?.agent).toBeNull();
    });

    it('rejects session > 64 chars with 400', async () => {
      const payload = {
        ...mockNewWorkloadPayload,
        id: getUniqueTestId(),
        session: 'x'.repeat(65),
      };
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('session');
    });

    it('rejects non-string agent with 400', async () => {
      const payload = {
        ...mockNewWorkloadPayload,
        id: getUniqueTestId(),
        agent: 42,
      };
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('agent');
    });

    it('treats whitespace-only session as unset (column NULL)', async () => {
      const testId = getUniqueTestId();
      const payload = {
        ...mockNewWorkloadPayload,
        id: testId,
        session: '   ',
      };
      const response = await callApi('https://example.com/v1/workloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(202);
      const workload = await queries().getWorkload(testId);
      expect(workload?.session).toBeNull();
    });
  });
});
