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

// Replays the 2026-07-22 queue-starvation incident through the real
// scheduler: a deep backlog wedged against an account-wide spot cap must not
// own the dispatch window. Resolution, conduct, the retry
// disposition, and the store all run for real; only the cloud gateway is faked.
// Every seeded job pins a scalar (region, vmType), so resolution takes its
// fast path and never builds a gateway of its own.
vi.mock('../../../src/api/services/catalog-readiness', () => ({
  ensureCatalogReady: vi.fn().mockResolvedValue(undefined),
  isCatalogUnavailableError: vi.fn(() => false),
}));

vi.mock('../../../src/shared/utils', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../src/shared/utils')>();
  return {
    ...real,
    withTimeout: vi.fn((promise: Promise<unknown>) => promise),
    tcpPing: vi.fn().mockResolvedValue(true),
    checkNetworkConnectivity: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    createComputeProvider: vi.fn(),
    createStorageProvider: vi.fn(),
    createInputStorageProvider: vi.fn(),
    createOutputStorageProvider: vi.fn(),
    createCheckpointStorageProvider: vi.fn(),
  };
});

import { runProvisioningSchedulerOnce } from '../../../src/api/services/monitor';
import {
  createCheckpointStorageProvider,
  createComputeProvider,
  createInputStorageProvider,
  createOutputStorageProvider,
  createStorageProvider,
} from '../../../src/api/services/cloud-config';
import {
  createCloudStorage,
  VM_RELEASE_CANDIDATE,
  type CloudStorage,
} from '../../../src/api/services/gateways/cloud.js';
import type { CloudConfig } from '../../../src/shared/cloud.js';
import {
  resetPersistence,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { CloudFailureDiagnosis, CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import config from '../../../src/api/config';
import {
  makeMockCloudCompute,
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
} from '../helpers/fixtures';
import { ConcurrencyMeter } from '../helpers/concurrency-meter';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { activeWorkloadWorkCount } from '../../../src/api/services/workload-work-registry';
import { seedQueuedJobs } from '../helpers/seed';

// Deeper than the dispatch window, so plain FIFO could never reach the work
// queued behind it.
const WALL = 120;

const AWS_STORM_REGION = 'us-east-1';
const AWS_STORM_VMTYPE = 'c7i.4xlarge';

function maxSpotError(): Error {
  const err = new Error('Max spot instance count exceeded');
  Object.assign(err, {
    name: 'MaxSpotInstanceCountExceeded',
    Code: 'MaxSpotInstanceCountExceeded',
    code: 'MaxSpotInstanceCountExceeded',
    $metadata: { httpStatusCode: 400 },
  });
  return err;
}

// Verbatim Azure spot-pool cap wording (subscription-wide, per region).
function lowPriorityCoresError(): Error {
  const err = new Error(
    'Operation could not be completed as it results in exceeding approved LowPriorityCores quota. Additional details - Workload Model: Resource Manager, Location: eastus, Current Limit: 24.',
  );
  Object.assign(err, { code: 'OperationNotAllowed' });
  return err;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Detached deploy pipelines outlive the tick, and the work registry is
 * process-global: leaving one running would suppress the next test's dispatch.
 */
async function settle(): Promise<void> {
  const store = queries();
  await waitFor(
    async () =>
      activeWorkloadWorkCount() === 0 && (await store.countDeploying()) === 0,
    'deploy pipelines to settle',
    30_000,
  );
}

async function stateOf(id: string): Promise<WorkloadState | undefined> {
  return (await queries().getWorkload(id))?.state;
}

describe('provisioning scheduler — account-wide spot storm must not starve other lanes', () => {
  let meter: ConcurrencyMeter;
  let sshPrivateKey: string;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    // Provisioning derives a public key before it ever calls the gateway.
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
    meter = new ConcurrencyMeter();
  });

  afterEach(async () => {
    await settle();
  });

  /**
   * Both lanes fail their VM creation, which is all the dispatch assertions
   * need: leaving Queued with a recorded newVM call proves the row won a slot.
   * Keeping the witness off the success path keeps the spec free of SSH and
   * container work.
   */
  function installGateways(witness: {
    cloud: CloudType;
    region: string;
    vmType: string;
    error: () => Error;
    diagnosis: CloudFailureDiagnosis;
  }): void {
    const storm = makeMockCloudCompute({
      type: CloudType.AWS,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      rawNewVM: meter.track('storm-newVM', async () => {
        throw maxSpotError();
      }),
      rawClassifyError: vi
        .fn()
        .mockReturnValue(
          CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
        ),
      // The attempt never created anything, so rollback must confirm the
      // placeholder as gone rather than leave a live row behind.
      observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
    });
    const behind = makeMockCloudCompute({
      type: witness.cloud,
      region: witness.region,
      vmType: witness.vmType,
      rawNewVM: meter.track('witness-newVM', async () => {
        throw witness.error();
      }),
      rawClassifyError: vi.fn().mockReturnValue(witness.diagnosis),
      observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
    });

    installStorage();
    vi.mocked(createComputeProvider).mockImplementation((cloudConfig) =>
      cloudConfig.cloudProvider === CloudType.AWS && cloudConfig.spot === true
        ? storm
        : behind,
    );
  }

  /**
   * Spot workloads resolve a managed checkpoint bucket before provisioning,
   * so the storage seam must be faked too or the storm dies on a real S3 call
   * instead of on the modeled quota wall.
   */
  function installStorage(): void {
    const factory = (cloudConfig: CloudConfig): CloudStorage =>
      createCloudStorage({
        type: cloudConfig.cloudProvider,
        region: cloudConfig.region ?? 'us-east-1',
        rawGetBucketRegion: vi
          .fn()
          .mockResolvedValue(cloudConfig.region ?? 'us-east-1'),
        rawHasBucket: vi.fn().mockResolvedValue(true),
        rawUpsertBucketUncoordinated: vi.fn().mockResolvedValue(undefined),
        rawDeleteBucket: vi.fn().mockResolvedValue(undefined),
        rawDeleteObject: vi.fn().mockResolvedValue(undefined),
        rawUploadObject: vi.fn().mockResolvedValue(undefined),
        rawDownloadObject: vi.fn(),
      });
    for (const create of [
      createStorageProvider,
      createInputStorageProvider,
      createOutputStorageProvider,
      createCheckpointStorageProvider,
    ]) {
      vi.mocked(create).mockImplementation(factory);
    }
  }

  async function seedStormWall(
    idPrefix: string,
    extra?: { ownerUserId?: string; userId?: string; session?: string },
  ): Promise<string[]> {
    const { ids } = await seedQueuedJobs(WALL, {
      ...extra,
      cloud: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      spot: true,
      idPrefix,
      startedAtBase: 1_000,
      sshPrivateKey,
    });
    return ids;
  }

  it('dispatches an Azure job queued behind a 120-deep AWS spot wall', async () => {
    installGateways({
      cloud: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_NC4as_T4_v3',
      error: lowPriorityCoresError,
      diagnosis: CloudFailureDiagnosis.TemporaryProviderFailure,
    });
    await seedStormWall('storm-azure-case');
    const { ids: behindIds } = await seedQueuedJobs(1, {
      cloud: CloudType.Azure,
      credentials: TEST_AZURE_CRED,
      region: 'eastus',
      vmType: 'Standard_NC4as_T4_v3',
      spot: false,
      idPrefix: 'behind-azure',
      startedAtBase: 9_000_000,
      sshPrivateKey,
    });
    const behindId = behindIds[0]!;

    await runProvisioningSchedulerOnce();
    await settle();

    // FAIRNESS: the row queued last, on another cloud's credential, won a slot
    // on the very first tick — under one global FIFO window it is at position
    // 121 of 120 and never dispatches.
    expect(meter.count('witness-newVM')).toBe(1);
    expect(await stateOf(behindId)).not.toBe(WorkloadState.Queued);
  }, 60_000);

  it('dispatches a second member queued behind a wall on the same credential', async () => {
    // Hosted-API members share the API's credentials, so the credential cannot
    // separate them — only the owner can.
    installGateways({
      cloud: CloudType.AWS,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      error: () => new Error('insufficient capacity'),
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
    });
    await seedStormWall('storm-member-case', {
      ownerUserId: 'user-a',
      userId: 'member-a',
    });
    const { ids: behindIds } = await seedQueuedJobs(1, {
      cloud: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      spot: false,
      idPrefix: 'behind-member',
      startedAtBase: 9_000_000,
      sshPrivateKey,
      ownerUserId: 'user-b',
      userId: 'member-b',
    });
    const behindId = behindIds[0]!;

    await runProvisioningSchedulerOnce();
    await settle();

    expect(meter.count('witness-newVM')).toBe(1);
    expect(await stateOf(behindId)).not.toBe(WorkloadState.Queued);
  }, 60_000);

  it("dispatches work queued behind one agent session's wall on the same credential", async () => {
    // A batch sweep and the tenant's other work share the credential AND the
    // caller, so neither term above can separate them — only the session (and,
    // for the sweep session's own vm, the workload type) can.
    installGateways({
      cloud: CloudType.AWS,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      error: () => new Error('insufficient capacity'),
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
    });
    await seedStormWall('storm-session-case', { session: 'sess-batch-sweep' });
    const { ids: otherSessionIds } = await seedQueuedJobs(1, {
      cloud: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      spot: false,
      idPrefix: 'behind-session',
      startedAtBase: 9_000_000,
      sshPrivateKey,
      session: 'sess-interactive',
    });
    const { ids: vmIds } = await seedQueuedJobs(1, {
      cloud: CloudType.AWS,
      credentials: TEST_AWS_CRED,
      region: AWS_STORM_REGION,
      vmType: AWS_STORM_VMTYPE,
      spot: false,
      idPrefix: 'behind-vm',
      startedAtBase: 9_000_001,
      sshPrivateKey,
      session: 'sess-batch-sweep',
      workloadType: 'vm',
    });

    await runProvisioningSchedulerOnce();
    await settle();

    // FAIRNESS: a second session's job and the sweep session's own vm each get
    // their own lane, so both win slots on the first tick — under one lane per
    // (tenant, credential) they sit at positions 121-122 of 120 and starve.
    expect(meter.count('witness-newVM')).toBe(2);
    expect(await stateOf(otherSessionIds[0]!)).not.toBe(WorkloadState.Queued);
    expect(await stateOf(vmIds[0]!)).not.toBe(WorkloadState.Queued);
  }, 60_000);
});
