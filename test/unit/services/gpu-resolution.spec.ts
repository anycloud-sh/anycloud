import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { getDB } from '../../../src/api/services/repositories/db';
import { resetTestStore } from '../utils';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import config from '../../../src/api/config';
import { resolveVMTypes } from '../../../src/shared/cloud-config';
import * as catalogModule from '../../../src/shared/catalog/index';
import {
  CandidateRegionAvailability,
  candidateRegionKey,
} from '../../../src/api/services/gateways/cloud';
import {
  GCP,
  resetGcpCandidatePreflightCache,
} from '../../../src/api/services/gateways/gcp';

vi.mock('../../../src/api/services/workload-workflows/vm-host-startup', () => ({
  deploy: vi.fn().mockResolvedValue(undefined),
  resumeOnExistingVM: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/api/services/workload-workflows/completion', async () =>
  (await import('../helpers/monitor-harness')).completionMock(),
);
vi.mock('../../../src/api/services/host-runtime/termination', () => ({
  terminateStep: vi.fn().mockResolvedValue(undefined),
  terminate: vi.fn().mockResolvedValue(undefined),
  teardownVMs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/api/services/docker');

vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    createComputeProvider: vi.fn().mockReturnValue({}),
    createStorageProvider: vi.fn().mockReturnValue({}),
  };
});

import { runProvisioningSchedulerOnce } from '../../../src/api/services/monitor';
import * as startup from '../../../src/api/services/workload-workflows/vm-host-startup';
import {
  encryptCredential,
  hashCredential,
} from '../../../src/api/services/cloud-config';
import { TEST_GCP_CRED, TEST_LAMBDA_CRED } from '../helpers/fixtures';
import { internalsOf } from '../helpers/internals';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getWorkloadQueryStore as queries } from '../../../src/api/services/persistence.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

/** The private preflight this spec stubs behind the public resolution path. */
type GcpInternals = {
  runCandidatePreflight: GCP['runCandidatePreflight'];
};

function stubGcpCandidatePreflight(): void {
  vi.spyOn(
    internalsOf<GcpInternals>(GCP.prototype),
    'runCandidatePreflight',
  ).mockImplementation(async (candidates) => ({
    availability: new Map(
      candidates.map((candidate) => [
        candidateRegionKey(candidate),
        CandidateRegionAvailability.Verified,
      ]),
    ),
    complete: true,
  }));
}

describe('gpuType → vmType resolution on API', () => {
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(async () => {
    await resetTestStore();
    resetGcpCandidatePreflightCache();
    vi.clearAllMocks();
    stubGcpCandidatePreflight();
  });

  it('resolves gpuType to vmType when vmType is null', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'gpu-resolve-1',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      gpuType: 'A100',
      dockerOptions: { gpus: 'all' },
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    // resolveVMType('A100', GCP) → 'a2-highgpu-1g' from the normalized catalog
    expect(cloudConfig.vmType).toBe('a2-highgpu-1g');
    expect(cloudConfig.region).toBeDefined();
  });

  it('places RTXPRO6000:1 only in a real g4-standard-48 zone', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'g4-real-zone-resolution',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      gpuType: 'RTXPRO6000:1',
      region: 'us-central1',
      dockerOptions: { gpus: 'all' },
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startup.deploy).mock.calls[0][1]).toMatchObject({
      cloudProvider: CloudType.GCP,
      vmType: 'g4-standard-48',
      region: 'us-central1',
      availabilityZone: 'b',
    });
  });

  it('no longer marks GPU workloads invalid when Docker GPU access is omitted', async () => {
    // The --gpus default moved from submit/provision-time to conduct-time
    // (derived from the resolved config next to gpuRuntime). A GPU workload
    // with omitted dockerOptions must therefore proceed, not be rejected here.
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'gpu-missing-docker-access',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      gpuType: 'A100',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.vmType).toBe('a2-highgpu-1g');
    const workload = await queries().getWorkload('gpu-missing-docker-access');
    expect(workload?.state).not.toBe(WorkloadState.Invalid);
  });

  it('expands a vmType array against a pinned region — drops unresolvable entries', async () => {
    // The real catalog filters the fake primary and retains the GCP fallback
    // that is genuinely offered in the pinned region.

    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'arr-pinned-region',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: ['totally_fake_vm', 'a2-highgpu-1g'],
      dockerOptions: { gpus: 'all' },
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.vmType).toBe('a2-highgpu-1g');
    expect(cloudConfig.region).toBe('us-central1');
  });

  it('skips an unresolvable gpuType prefix and picks the next resolvable alias', async () => {
    // Regression: buildCloudConfig used to feed gpuType[0] directly into
    // resolveVMType. With ['fake', 'A100'], step 2 marked the workload
    // Invalid before resolveProvisioningConfig's candidate expansion could
    // pick the real fallback. Now the helper walks the list.
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'gpu-array-prefix-fake',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      gpuType: ['fake_unknown_gpu', 'A100'],
      dockerOptions: { gpus: 'all' },
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.vmType).toBe('a2-highgpu-1g');

    const d = await queries().getWorkload('gpu-array-prefix-fake');
    expect(d?.state).not.toBe(WorkloadState.Invalid);
  });

  it('expands a gpuType array into a candidate pool (array input)', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'gpu-array-1',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      gpuType: ['A100', 'H100'],
      dockerOptions: { gpus: 'all' },
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    // Primary (first) gpu in the array is A100 → a2-highgpu-1g on GCP.
    expect(cloudConfig.vmType).toBe('a2-highgpu-1g');

    // Confirm the ordered array was preserved on the workload row.
    const d = await queries().getWorkload('gpu-array-1');
    expect(d?.gpuType).toEqual(['A100', 'H100']);
  });

  it('marks Invalid when gpuType cannot be resolved', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'gpu-invalid-1',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      gpuType: 'fake-gpu',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    // Should NOT dispatch deploy
    expect(startup.deploy).not.toHaveBeenCalled();

    // Should be marked Invalid
    const workload = await queries().getWorkload('gpu-invalid-1');
    expect(workload?.state).toBe(WorkloadState.Invalid);
  });

  it('marks Invalid when vmType is null with no gpuType', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkload(getDB(), {
      id: 'no-vmtype-1',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).not.toHaveBeenCalled();

    const workload = await queries().getWorkload('no-vmtype-1');
    expect(workload?.state).toBe(WorkloadState.Invalid);
  });

  it('stays Queued when catalog has no regions for VM type', async () => {
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.Lambda,
    );

    await createWorkload(getDB(), {
      id: 'no-regions-1',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Lambda,
      vmType: 'future_gpu_type_not_yet_in_catalog',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).not.toHaveBeenCalled();

    const workload = await queries().getWorkload('no-regions-1');
    expect(workload?.state).toBe(WorkloadState.Queued);
  });

  it('marks Invalid when credentials are missing', async () => {
    // Simulate the missing-credentials state — the FK is RESTRICT, so we
    // can't actually delete the cred row; instead NULL the workload's
    // credential_id to mirror legacy '' rows that 0042 NULLifies and
    // any operator/manual edits that produce NULL.
    const encryptedCred = await encryptCredential(TEST_LAMBDA_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_LAMBDA_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    await createWorkload(getDB(), {
      id: 'no-creds-1',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      vmType: 'a2-highgpu-1g',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });
    await getDB().query(
      `UPDATE workloads SET credential_id = NULL WHERE id = ?`,
      ['no-creds-1'],
    );

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).not.toHaveBeenCalled();

    const workload = await queries().getWorkload('no-creds-1');
    expect(workload?.state).toBe(WorkloadState.Invalid);
  });
});

describe('resolveVMTypes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns multiple exact siblings from the published Lambda catalog', () => {
    expect(resolveVMTypes('h100:1', CloudType.Lambda)).toEqual([
      'gpu_1x_h100_pcie',
      'gpu_1x_h100_sxm5',
    ]);
  });

  it('primary type is always first', () => {
    expect(resolveVMTypes('h100:1', CloudType.Lambda)[0]).toBe(
      'gpu_1x_h100_pcie',
    );
  });

  it('excludes real catalog entries with a different GPU count or vCPU shape', () => {
    const catalog = catalogModule.readCatalog(CloudType.Lambda);
    expect(catalog).toBeDefined();
    const result = resolveVMTypes('h100:1', CloudType.Lambda);
    const primary = catalog!.typesPerAccelerator.H100!.find(
      (entry) => entry.instanceType === result[0],
    )!;
    const excluded = catalog!.typesPerAccelerator.H100!.filter(
      (entry) => entry.count !== 1 || entry.vCPUs !== primary.vCPUs,
    );
    expect(excluded.length).toBeGreaterThan(0);
    expect(result).not.toEqual(
      expect.arrayContaining(excluded.map((entry) => entry.instanceType)),
    );
  });

  it('keeps a same-accelerator sibling SKU that differs only in host RAM', () => {
    // Lambda H100:1 — gpu_1x_h100_pcie and gpu_1x_h100_sxm5 share the
    // GPU, count and vCPUs but differ in attached host RAM (200 vs 225 GiB). Both
    // must be returned (cheapest first) so the scheduler can fall back to the
    // sibling when the cheapest variant is capacity-blocked.
    const catalog = catalogModule.readCatalog(CloudType.Lambda);
    const pcie = catalog!.typesPerAccelerator.H100!.find(
      (entry) => entry.instanceType === 'gpu_1x_h100_pcie',
    )!;
    const sxm5 = catalog!.typesPerAccelerator.H100!.find(
      (entry) => entry.instanceType === 'gpu_1x_h100_sxm5',
    )!;
    expect(pcie.memoryGiB).not.toBe(sxm5.memoryGiB);
    expect(pcie.vCPUs).toBe(sxm5.vCPUs);
    const result = resolveVMTypes('h100:1', CloudType.Lambda);
    expect(result).toEqual(['gpu_1x_h100_pcie', 'gpu_1x_h100_sxm5']);
  });

  it('returns a single real type when no interchangeable sibling exists', () => {
    const result = resolveVMTypes('a100:8', CloudType.AWS);
    expect(result).toEqual(['p4d.24xlarge']);
  });

  it('falls back to [primary unchanged] when catalog is unavailable', () => {
    vi.spyOn(catalogModule, 'readCatalog').mockReturnValue(undefined);
    // No catalog means no accelerator → instance-type lookup for any cloud.
    // Pre-normalization, GCP had a hardcoded map fallback; the normalized
    // catalog now carries the same data, so the runtime no longer needs it.
    const result = resolveVMTypes('A100', CloudType.GCP);
    expect(result).toEqual(['A100']);
  });
});
