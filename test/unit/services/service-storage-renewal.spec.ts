import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../../src/api/config.js';
import { encryptCredential } from '../../../src/api/services/cloud-config.js';
import {
  resetPersistence,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { createStorageRenewer } from '../../../src/api/services/service-storage-renewal.js';
import { SupervisorManager } from '../../../src/api/services/supervisor.js';
import {
  hasWorkloadWork,
  trackWorkloadWork,
  drainWorkloadWork,
} from '../../../src/api/services/workload-work-registry.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';
import {
  TEST_AWS_CRED,
  TEST_GCP_CRED,
  TEST_AZURE_CRED,
  TEST_LAMBDA_CRED,
} from '../helpers/fixtures.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const { mint, transport } = vi.hoisted(() => ({
  mint: vi.fn(),
  transport: vi.fn(),
}));
vi.mock('../../../src/api/services/gateways/transport.js', () => ({
  createTransport: transport,
}));
vi.mock('../../../src/api/services/cloud-config.js', async (importOriginal) => {
  const minter = () => ({
    type: 'AWS',
    region: 'us-east-1',
    validateScopedStorageTokenSource: vi.fn(),
    mintScopedStorageToken: mint,
  });
  return {
    ...(await importOriginal<
      typeof import('../../../src/api/services/cloud-config.js')
    >()),
    createOutputStorageProvider: minter,
    createCheckpointStorageProvider: minter,
  };
});

const NOW = 2_000_000_000_000;
const ID = 'renew-service';
const TOKEN = {
  credentials: { ...TEST_AWS_CRED, sessionToken: 'temporary-token' },
  expiresAt: NOW + 3_600_000,
};

async function workload() {
  const result = await queries().getWorkload(ID);
  if (!result) throw new Error('Missing fixture');
  return result;
}

describe('Service checkpoint credential renewal', () => {
  beforeEach(async () => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mint.mockReset().mockResolvedValue(TOKEN);
    transport.mockReset().mockReturnValue({});
    vi.spyOn(
      SupervisorManager.prototype,
      'refreshRcloneCredentials',
    ).mockResolvedValue();
    await upsertCredential(
      getDB(),
      'compute',
      await encryptCredential(TEST_LAMBDA_CRED),
      CloudType.Lambda,
    );
    await upsertCredential(
      getDB(),
      'storage',
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id: ID,
      userId: 'test-user',
      workloadType: WorkloadType.Service,
      image: 'alpine',
      dockerCommand: '',
      sshPrivateKey: 'test-key',
      credentialId: 'compute',
      requestedComputeProvider: CloudType.Lambda,
      region: 'us-east-1',
      vmType: 'cpu_4x_general',
      spot: false,
      checkpointStorageCredentialId: 'storage',
      checkpointStorageRegion: 'us-east-1',
      checkpointBucket: 'conversation-state',
    });
    await provisionTestVm(ID, {
      cloudId: 'vm-1',
      ip: '192.0.2.1',
    });
    await walkToState(ID, WorkloadState.Running);
  });

  afterEach(async () => {
    await drainWorkloadWork(ID);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses actual token expiration and remints five minutes before expiry', async () => {
    const renewer = createStorageRenewer();
    const row = await workload();
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledWith([
      { bucket: 'conversation-state', mode: 'readwrite' },
    ]);
    expect(
      SupervisorManager.prototype.refreshRcloneCredentials,
    ).toHaveBeenCalledWith({
      checkpoint: expect.objectContaining({
        credentials: TOKEN.credentials,
        credentialExpiresAt: TOKEN.expiresAt,
      }),
    });
    vi.setSystemTime(TOKEN.expiresAt - 300_001);
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledTimes(1);
    vi.setSystemTime(TOKEN.expiresAt - 300_000);
    mint.mockResolvedValue({
      ...TOKEN,
      expiresAt: TOKEN.expiresAt + 3_600_000,
    });
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('remints after API restart and after VM replacement without reusing a deadline', async () => {
    const first = createStorageRenewer();
    await first.renew(await workload());
    const restarted = createStorageRenewer();
    await restarted.renew(await workload());
    expect(mint).toHaveBeenCalledTimes(2);
    await releaseTestVms(ID, 'vm-1');
    await walkToState(ID, WorkloadState.Provisioning);
    await provisionTestVm(ID, {
      cloudId: 'vm-2',
      ip: '192.0.2.2',
    });
    await walkToState(ID, WorkloadState.Running);
    await restarted.renew(await workload());
    expect(mint).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenLastCalledWith(
      '192.0.2.2',
      'test-key',
      22,
      'root',
    );
  });

  it('retries failed minting and failed credential replacement without advancing the deadline', async () => {
    const renewer = createStorageRenewer();
    const row = await workload();
    mint.mockRejectedValueOnce(new Error('STS unavailable'));
    await expect(renewer.renew(row)).rejects.toThrow('STS unavailable');
    vi.mocked(
      SupervisorManager.prototype.refreshRcloneCredentials,
    ).mockRejectedValueOnce(new Error('SSH unavailable'));
    await expect(renewer.renew(row)).rejects.toThrow('SSH unavailable');
    await expect(renewer.renew(row)).resolves.toEqual({
      disposition: 'completed',
    });
    expect(mint).toHaveBeenCalledTimes(3);
    expect(hasWorkloadWork(ID)).toBe(false);
  });

  it('fences teardown during renewal and discards a token if upgrade begins while minting', async () => {
    const row = await workload();
    const renewer = createStorageRenewer();
    let minted!: (value: typeof TOKEN) => void;
    mint.mockImplementation(
      () =>
        new Promise((resolve) => {
          minted = resolve;
        }),
    );
    const pending = renewer.renew(row);
    expect(hasWorkloadWork(ID)).toBe(true);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    await walkToState(ID, WorkloadState.Retrying);
    minted(TOKEN);
    await expect(pending).resolves.toEqual({ disposition: 'stale' });
    expect(
      SupervisorManager.prototype.refreshRcloneCredentials,
    ).not.toHaveBeenCalled();
    expect(hasWorkloadWork(ID)).toBe(false);
  });

  it('defers to already running lifecycle work', async () => {
    let release!: () => void;
    trackWorkloadWork(
      ID,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const result = await createStorageRenewer().renew(await workload());
    release();
    expect(result).toEqual({ disposition: 'deferred' });
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('same-account minted token renewal on VM hosts', () => {
  const COMPUTE = 'aws-compute';
  const GCP_COMPUTE = 'gcp-compute';

  beforeEach(async () => {
    resetPersistence();
    config.cipherKey = 'a'.repeat(64);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mint.mockReset().mockResolvedValue(TOKEN);
    transport.mockReset().mockReturnValue({});
    vi.spyOn(
      SupervisorManager.prototype,
      'refreshRcloneCredentials',
    ).mockResolvedValue();
    await upsertCredential(
      getDB(),
      COMPUTE,
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await upsertCredential(
      getDB(),
      GCP_COMPUTE,
      await encryptCredential(TEST_GCP_CRED),
      CloudType.GCP,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function running(
    id: string,
    workloadType: WorkloadType,
    buckets: { outputBucket?: string; checkpointBucket?: string },
    compute: Pick<
      Parameters<typeof createWorkload>[1],
      'credentialId' | 'requestedComputeProvider' | 'region' | 'vmType'
    > = {
      credentialId: COMPUTE,
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.small',
    },
  ) {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType,
      image: 'ubuntu:24.04',
      dockerCommand: '',
      sshPrivateKey: 'test-key',
      ...compute,
      spot: false,
      ...buckets,
    });
    await provisionTestVm(id, { cloudId: `i-${id}`, ip: '192.0.2.10' });
    await walkToState(id, WorkloadState.Running);
    const row = await queries().getWorkload(id);
    if (!row) throw new Error('Missing fixture');
    return row;
  }

  it('0047/S7 renews a running VM-host Job output token five minutes before it expires', async () => {
    const id = 'renew-job';
    const row = await running(id, WorkloadType.Job, {
      outputBucket: 'job-results',
    });
    const renewer = createStorageRenewer();
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledWith([
      { bucket: 'job-results', mode: 'readwrite' },
    ]);
    expect(
      SupervisorManager.prototype.refreshRcloneCredentials,
    ).toHaveBeenCalledWith({
      output: expect.objectContaining({
        credentials: TOKEN.credentials,
        credentialExpiresAt: TOKEN.expiresAt,
      }),
    });
    vi.setSystemTime(TOKEN.expiresAt - 300_001);
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledTimes(1);
    vi.setSystemTime(TOKEN.expiresAt - 300_000);
    mint.mockResolvedValue({
      ...TOKEN,
      expiresAt: TOKEN.expiresAt + 3_600_000,
    });
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledTimes(2);
    await drainWorkloadWork(id);
  });

  it('0047/S11 renews an Azure Job output SAS minted from the compute credential', async () => {
    await upsertCredential(
      getDB(),
      'azure-compute',
      await encryptCredential(TEST_AZURE_CRED),
      CloudType.Azure,
    );
    const id = 'renew-azure-job';
    const row = await running(
      id,
      WorkloadType.Job,
      { outputBucket: 'azure-results' },
      {
        credentialId: 'azure-compute',
        requestedComputeProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B2s',
      },
    );
    const sas = {
      credentials: {
        cloudProvider: CloudType.Azure,
        sasToken: 'sv=2025-01-05&sr=c&sp=racwdl&sig=x',
      },
      expiresAt: NOW + 3_600_000,
    };
    mint.mockResolvedValue(sas);
    const renewer = createStorageRenewer();
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledWith([
      { bucket: 'azure-results', mode: 'readwrite' },
    ]);
    expect(
      SupervisorManager.prototype.refreshRcloneCredentials,
    ).toHaveBeenCalledWith({
      output: expect.objectContaining({
        credentials: sas.credentials,
        credentialExpiresAt: sas.expiresAt,
      }),
    });
    vi.setSystemTime(sas.expiresAt - 300_000);
    mint.mockResolvedValue({ ...sas, expiresAt: sas.expiresAt + 3_600_000 });
    await renewer.renew(row);
    expect(mint).toHaveBeenCalledTimes(2);
    await drainWorkloadWork(id);
  });

  it('0047/S7 renews a running Service checkpoint token minted from the compute credential', async () => {
    const id = 'renew-same-account';
    const row = await running(id, WorkloadType.Service, {
      checkpointBucket: 'service-state',
    });
    await createStorageRenewer().renew(row);
    expect(mint).toHaveBeenCalledWith([
      { bucket: 'service-state', mode: 'readwrite' },
    ]);
    expect(
      SupervisorManager.prototype.refreshRcloneCredentials,
    ).toHaveBeenCalledWith({
      checkpoint: expect.objectContaining({
        credentials: TOKEN.credentials,
      }),
    });
    await drainWorkloadWork(id);
  });

  it('0047/S11 keeps a GCP Job syncing past several one-hour token lifetimes', async () => {
    const id = 'renew-gcp-job';
    const row = await running(
      id,
      WorkloadType.Job,
      { outputBucket: 'job-results' },
      {
        credentialId: GCP_COMPUTE,
        requestedComputeProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'e2-standard-2',
      },
    );
    const renewer = createStorageRenewer();
    const refresh = vi.mocked(
      SupervisorManager.prototype.refreshRcloneCredentials,
    );
    let expiresAt = NOW + 3_600_000;
    for (let lifetime = 1; lifetime <= 3; lifetime++) {
      const token = {
        credentials: {
          cloudProvider: CloudType.GCP,
          accessToken: `downscoped-${lifetime}`,
        },
        expiresAt,
      };
      mint.mockResolvedValueOnce(token);
      await renewer.renew(row);
      expect(mint).toHaveBeenLastCalledWith([
        { bucket: 'job-results', mode: 'readwrite' },
      ]);
      expect(refresh).toHaveBeenLastCalledWith({
        output: expect.objectContaining({
          credentials: token.credentials,
          credentialExpiresAt: expiresAt,
        }),
      });
      vi.setSystemTime(expiresAt - 300_000);
      expiresAt += 3_600_000;
    }
    expect(mint).toHaveBeenCalledTimes(3);
    await drainWorkloadWork(id);
  });
});
