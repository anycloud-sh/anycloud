import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import {
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
  preemptTestVm,
} from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import config from '../../../src/api/config';
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
import {
  getRegionsForVMType,
  getZonesForVMType,
} from '../../../src/shared/cloud-config';
import { TEST_GCP_CRED } from '../helpers/fixtures';
import {
  CandidateRegionAvailability,
  candidateRegionKey,
} from '../../../src/api/services/gateways/cloud.js';
import { internalsOf } from '../helpers/internals';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const VM_TYPE = 'a2-highgpu-1g';

function publishedRegions(): string[] {
  const regions = getRegionsForVMType(VM_TYPE, CloudType.GCP);
  if (regions.length < 3) {
    throw new Error(
      `${VM_TYPE} needs at least three published GCP regions for failover coverage`,
    );
  }
  return regions;
}

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

describe('region failover', () => {
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(() => {
    resetPersistence();
    resetGcpCandidatePreflightCache();
    vi.clearAllMocks();
    stubGcpCandidatePreflight();
  });

  async function createWorkloadWithoutRegion(
    id: string,
    credentialId: string,
    vmType = VM_TYPE,
  ): Promise<void> {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      vmType,
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });
  }

  async function createWorkloadWithRegion(
    id: string,
    credentialId: string,
    region: string,
  ): Promise<void> {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.GCP,
      region,
      vmType: 'n2-standard-4',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });
  }

  async function getProvisioningMetadata(
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const events = await eventLog().getWorkloadEvents(id);
    const event = events.find((e) => e.state === WorkloadState.Provisioning);
    return event?.metadata ? JSON.parse(event.metadata) : null;
  }

  async function recordTargetFailure(
    id: string,
    region: string,
  ): Promise<void> {
    const now = Date.now();
    await getDB().query(
      `INSERT INTO vms (workload_id, cloud_id, created_at, ended_at, region, vm_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, `${id}-${region}`, now, now, region, VM_TYPE],
    );
  }

  it('resolves region from catalog when workload has no region', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    await createWorkloadWithoutRegion('no-region-1', credentialId);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    const regions = publishedRegions();
    expect(cloudConfig.region).toBe(regions[0]);

    // Workload row region stays NULL (user intent is immutable)
    const updated = await store.getWorkload('no-region-1');
    expect(updated?.region).toBeNull();

    await expect(getProvisioningMetadata('no-region-1')).resolves.toMatchObject(
      {
        region: regions[0],
        eligibleRegions: regions,
      },
    );
  });

  it('does not override user-specified region', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );

    const pinnedRegion = getRegionsForVMType(
      'n2-standard-4',
      CloudType.GCP,
    )[0]!;
    await createWorkloadWithRegion('has-region-1', credentialId, pinnedRegion);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(pinnedRegion);

    await expect(
      getProvisioningMetadata('has-region-1'),
    ).resolves.toMatchObject({
      region: pinnedRegion,
    });
  });

  it('picks next untried region after a failed attempt', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const [firstRegion, secondRegion] = publishedRegions();

    await createWorkloadWithoutRegion('failover-1', credentialId);

    await recordTargetFailure('failover-1', firstRegion);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(secondRegion);
  });

  it('wraps around when all regions have been tried', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const regions = publishedRegions();

    await createWorkloadWithoutRegion('wrap-1', credentialId);

    for (const region of regions) {
      await recordTargetFailure('wrap-1', region);
    }

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(regions[0]);
  });

  it('stays Queued when no catalog regions for vmType', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const futureVMType = 'future-gcp-type-not-yet-in-catalog';
    expect(getRegionsForVMType(futureVMType, CloudType.GCP)).toEqual([]);

    await createWorkloadWithoutRegion(
      'no-regions-1',
      credentialId,
      futureVMType,
    );

    await runProvisioningSchedulerOnce();

    // Catalog may be stale — stay Queued to retry after refresh
    expect(startup.deploy).toHaveBeenCalledTimes(0);
    const dep = await store.getWorkload('no-regions-1');
    expect(dep?.state).toBe(WorkloadState.Queued);

    const events = await eventLog().getWorkloadEvents('no-regions-1');
    expect(
      events.some((event) => event.state === WorkloadState.Provisioning),
    ).toBe(false);
  });

  it('reuses region from existing VMs instead of re-resolving', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const secondRegion = publishedRegions()[1];

    await createWorkloadWithoutRegion('vm-reuse-1', credentialId);

    // Simulate a previous attempt that provisioned in a non-primary region.
    await lifecycle().updateState('vm-reuse-1', WorkloadState.Provisioning);

    // Add a VM (simulates successful provisioning)
    await provisionTestVm(
      'vm-reuse-1',
      {
        ip: '1.2.3.4',
        cloudId: 'gcp-instance-1',
        privateIp: '10.0.0.1',
      },
      { region: secondRegion },
    );

    // Back to Queued after a host-step failure that keeps the VM for reuse
    await walkToState('vm-reuse-1', WorkloadState.Downloading);
    await walkToState('vm-reuse-1', WorkloadState.Queued);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(secondRegion);
  });

  it('stores and retrieves availability zone on VM row', async () => {
    const store = queries();
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const region = publishedRegions()[1];
    const availabilityZone = getZonesForVMType(region, VM_TYPE)[0]!;

    await createWorkloadWithoutRegion('zone-roundtrip-1', credentialId);
    await lifecycle().updateState(
      'zone-roundtrip-1',
      WorkloadState.Provisioning,
    );

    await provisionTestVm(
      'zone-roundtrip-1',
      {
        ip: '1.2.3.4',
        cloudId: 'gcp-instance-1',
        privateIp: '10.0.0.1',
        availabilityZone,
      },
      { region },
    );

    const vms = await store.getVMs('zone-roundtrip-1');
    expect(vms).toHaveLength(1);
    expect(vms[0].availabilityZone).toBe(availabilityZone);
  });

  it('does not carry stale availability zone to new region', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const [firstRegion, secondRegion] = publishedRegions();

    await createWorkloadWithoutRegion('stale-zone-1', credentialId);

    // A legacy failed VM has no zone, so it penalizes the whole first region.
    await lifecycle().updateState('stale-zone-1', WorkloadState.Provisioning);
    await provisionTestVm(
      'stale-zone-1',
      { cloudId: 'vm-failed-1' },
      { region: firstRegion },
    );
    await releaseTestVms('stale-zone-1');
    await walkToState('stale-zone-1', WorkloadState.Queued);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(secondRegion);
    expect(cloudConfig.availabilityZone).toBe(
      getZonesForVMType(secondRegion, VM_TYPE)[0],
    );
  });

  it('reuses region when last attempt provisioned successfully (non-preempted)', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const firstRegion = publishedRegions()[0];

    await createWorkloadWithoutRegion('reuse-region-1', credentialId);

    // Simulate successful provisioning, then external termination.
    await lifecycle().updateState('reuse-region-1', WorkloadState.Provisioning);
    await provisionTestVm(
      'reuse-region-1',
      { ip: '1.2.3.4', cloudId: 'gcp-instance-1' },
      { region: firstRegion },
    );
    // VM terminated externally (ended, not preempted)
    await releaseTestVms('reuse-region-1');
    await walkToState('reuse-region-1', WorkloadState.Queued);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(firstRegion);
  });

  it('skips region when last attempt was preempted', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const [firstRegion, secondRegion] = publishedRegions();

    await createWorkloadWithoutRegion('preempt-skip-1', credentialId);

    // Simulate successful provisioning then preemption in the first region.
    await lifecycle().updateState('preempt-skip-1', WorkloadState.Provisioning);
    await provisionTestVm(
      'preempt-skip-1',
      { ip: '1.2.3.4', cloudId: 'gcp-instance-1' },
      { region: firstRegion },
    );
    await preemptTestVm('preempt-skip-1', 'gcp-instance-1');
    await releaseTestVms('preempt-skip-1');
    await walkToState('preempt-skip-1', WorkloadState.Queued);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(secondRegion);
  });

  it('prefers previously successful region when all have been tried', async () => {
    const encryptedCred = await encryptCredential(TEST_GCP_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_GCP_CRED),
      encryptedCred,
      CloudType.GCP,
    );
    const [failedRegion, preemptedRegion, successfulRegion] =
      publishedRegions();

    await createWorkloadWithoutRegion('prefer-good-1', credentialId);

    // First region: provisioning failed.
    await lifecycle().updateState('prefer-good-1', WorkloadState.Provisioning);
    await provisionTestVm(
      'prefer-good-1',
      { cloudId: 'vm-f-0' },
      { region: failedRegion },
    );

    // Second region: provisioned successfully, then preempted.
    await provisionTestVm(
      'prefer-good-1',
      { ip: '2.3.4.5', cloudId: 'gcp-instance-2' },
      { region: preemptedRegion },
    );
    await preemptTestVm('prefer-good-1', 'gcp-instance-2');
    await releaseTestVms('prefer-good-1');

    // Third region: provisioned successfully, not preempted, then externally
    // terminated. It should remain the preferred known-good target.
    await walkToState('prefer-good-1', WorkloadState.Provisioning);
    await provisionTestVm(
      'prefer-good-1',
      { ip: '3.4.5.6', cloudId: 'gcp-instance-3' },
      { region: successfulRegion },
    );
    await releaseTestVms('prefer-good-1');

    await walkToState('prefer-good-1', WorkloadState.Queued);

    await runProvisioningSchedulerOnce();

    expect(startup.deploy).toHaveBeenCalledTimes(1);
    const cloudConfig = vi.mocked(startup.deploy).mock.calls[0][1];
    expect(cloudConfig.region).toBe(successfulRegion);
  });
});
