import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';

const mocks = vi.hoisted(() => ({
  ensureProviderRegistered: vi.fn(),
  getInsufficientQuotaRegions: vi.fn(),
  catalogOverlayRead: vi.fn(),
  catalogOverlayRefresh: vi.fn(),
  catalogOverlayInvalidate: vi.fn(),
  provisionVMs: vi.fn(),
  teardownVMs: vi.fn(),
}));

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/api/services/catalog-readiness', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../src/api/services/catalog-readiness')
    >();
  return {
    ...actual,
    ensureCatalogReady: vi.fn().mockResolvedValue(undefined),
    isCatalogUnavailableError: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../../../src/api/services/quota/azure', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../src/api/services/quota/azure')
    >();
  return {
    ...actual,
    AzureQuotaProvider: vi.fn().mockImplementation(function () {
      return {
        ensureProviderRegistered: mocks.ensureProviderRegistered,
        getInsufficientQuotaRegions: mocks.getInsufficientQuotaRegions,
      };
    }),
  };
});

vi.mock('../../../src/api/services/catalog-overlays/azure', () => ({
  createAzureCatalogOverlayProvider: vi.fn().mockImplementation(() => ({
    cloud: 'Azure',
    read: mocks.catalogOverlayRead,
    refresh: mocks.catalogOverlayRefresh,
    invalidate: mocks.catalogOverlayInvalidate,
  })),
}));

vi.mock('../../../src/api/services/vm-provisioner', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../src/api/services/vm-provisioner')
    >();
  return {
    ...actual,
    provisionVMs: mocks.provisionVMs,
  };
});

vi.mock(
  '../../../src/api/services/host-runtime/termination',
  async (importActual) => {
    const actual =
      await importActual<
        typeof import('../../../src/api/services/host-runtime/termination')
      >();
    return {
      ...actual,
      teardownVMs: mocks.teardownVMs,
    };
  },
);

import config from '../../../src/api/config';
import {
  encryptCredential,
  hashCredential,
  resolveProvisioningConfig,
} from '../../../src/api/services/cloud-config';
import {
  getCredentialSecretStore,
  resetPersistence,
  getWorkloadLifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { deploy } from '../../../src/api/services/workload-workflows/vm-host-startup';
import { vmHostStartupDeps } from '../../../src/api/services/job/default-runtime';
import { resetAzurePreflightSweeps } from '../../../src/api/services/gateways/azure';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import { pickTarget } from '../../../src/api/services/launch-targets';
import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor';
import { VMCreationError } from '../../../src/api/services/codes';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import type { ProvisionParams } from '../../../src/api/services/vm-provisioner';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  getRegionsForVMType,
  getVCPUsForVMType,
} from '../../../src/shared/cloud-config';
import { TEST_AZURE_CRED } from '../helpers/fixtures';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import {
  provisionTestVm,
  releaseTestVms,
} from '../../helpers/workload-store.js';

const WORKLOAD_ID = 't4-unpinned-quota';
const VM_TYPE = 'Standard_NC4as_T4_v3';
const ATTEMPTED_VM_ID = `${WORKLOAD_ID}-0`;
const REGIONS = getRegionsForVMType(VM_TYPE, CloudType.Azure, false);
if (REGIONS.length < 2) {
  throw new Error(
    `${VM_TYPE} needs at least two published Azure regions for failover coverage`,
  );
}
const [FIRST_REGION, SECOND_REGION] = REGIONS;
const VCPUS = getVCPUsForVMType(VM_TYPE, CloudType.Azure);
if (VCPUS === undefined) {
  throw new Error(`${VM_TYPE} is missing vCPU data in the published catalog`);
}

const QUOTA_ERROR_MESSAGE =
  'Operation could not be completed as it results in exceeding approved ' +
  'Standard NCASv3_T4 Family Cores quota. Additional details - Workload ' +
  `Model: Resource Manager, Location: ${FIRST_REGION}, Current Limit: 0, Current ` +
  `Usage: 0, Additional Required: ${VCPUS}, (Minimum) New Limit Required: ${VCPUS}.`;

type InsufficientQuotaResult = {
  insufficientRegions: Set<string>;
  unknownRegions: Set<string>;
  complete: boolean;
};

describe('Azure on-demand T4 unpinned-region regression', () => {
  let sshPrivateKey: string;
  let releaseQuotaSweep: (result: InsufficientQuotaResult) => void;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T21:00:00.000Z'));
    resetPersistence();
    resetAzurePreflightSweeps();
    vi.clearAllMocks();

    mocks.ensureProviderRegistered.mockResolvedValue(true);
    mocks.catalogOverlayRead.mockReturnValue(undefined);
    mocks.catalogOverlayRefresh.mockResolvedValue(undefined);
    mocks.getInsufficientQuotaRegions.mockReturnValue(
      new Promise<InsufficientQuotaResult>((resolve) => {
        releaseQuotaSweep = resolve;
      }),
    );
    mocks.teardownVMs.mockImplementation(
      async (_cloudConfig: unknown, id: string) => {
        // This fixture models confirmed cleanup. Persist the retired attempts,
        // as real teardown does for provider-confirmed releases.
        await releaseTestVms(id);
      },
    );
  });

  afterEach(async () => {
    releaseQuotaSweep?.({
      insufficientRegions: new Set([FIRST_REGION]),
      unknownRegions: new Set(),
      complete: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    resetAzurePreflightSweeps();
    resetPersistence();
    vi.useRealTimers();
  });

  it('fails open, records the first published-region quota failure, then retries in the next published region', async () => {
    const encryptedCredential = await encryptCredential(TEST_AZURE_CRED);
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(TEST_AZURE_CRED),
      encryptedCredential,
      CloudType.Azure,
    );

    await createWorkload(getDB(), {
      id: WORKLOAD_ID,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Azure,
      vmType: VM_TYPE,
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey,
      credentialId,
    });

    const workload = await queries().getWorkload(WORKLOAD_ID);
    expect(workload).not.toBeNull();
    if (!workload) throw new Error('workload fixture was not created');
    expect(workload.region).toBeNull();

    const firstResolutionPromise = resolveProvisioningConfig(
      workload,
      queries(),
      getCredentialSecretStore(),
    );
    await vi.waitFor(() =>
      expect(mocks.getInsufficientQuotaRegions).toHaveBeenCalledWith(
        'azure:standardncasv3_t4family',
        VCPUS,
        false,
        REGIONS,
        expect.any(AbortSignal),
      ),
    );

    // resolveProvisioningConfig owns a 30-second end-to-end deadline; the
    // central availability coordinator reserves its final two seconds.
    await vi.advanceTimersByTimeAsync(28_001);
    const firstResolution = await firstResolutionPromise;
    expect(firstResolution.state).toBe(WorkloadState.Provisioning);
    if (firstResolution.state !== WorkloadState.Provisioning) {
      throw new Error(`unexpected first resolution: ${firstResolution.state}`);
    }
    expect(firstResolution.config).toMatchObject({
      cloudProvider: CloudType.Azure,
      vmType: VM_TYPE,
      region: FIRST_REGION,
      spot: false,
    });
    expect(firstResolution.eligibleRegions).toEqual(REGIONS);
    expect(firstResolution.credentialId).toBe(credentialId);
    expect(mocks.getInsufficientQuotaRegions).toHaveBeenCalledOnce();

    const claimed = await getWorkloadLifecycle().updateState(
      WORKLOAD_ID,
      WorkloadState.Provisioning,
      {
        metadata: {
          region: firstResolution.config.region,
          eligibleRegions: firstResolution.eligibleRegions,
        },
      },
    );
    expect(claimed).toBe(true);

    const rawQuotaError = Object.assign(new Error(QUOTA_ERROR_MESSAGE), {
      code: 'OperationNotAllowed',
      statusCode: 500,
    });
    mocks.provisionVMs.mockImplementationOnce(async (...args: unknown[]) => {
      const params = args[1] as ProvisionParams;
      const ref = await provisionTestVm(
        params.workloadId,
        { cloudId: ATTEMPTED_VM_ID },
        {
          region: params.cloudConfig.region,
          vmType: params.cloudConfig.vmType,
          credentialId: params.credentialId,
        },
      );
      params.onAttempt?.(ref);
      throw new VMCreationError(rawQuotaError, [ATTEMPTED_VM_ID]);
    });

    await expect(
      deploy(
        vmHostStartupDeps(),
        firstResolution.config,
        workload,
        firstResolution.credentialId,
      ),
    ).rejects.toBeInstanceOf(VMCreationError);

    expect(mocks.provisionVMs).toHaveBeenCalledOnce();
    const provisionParams = mocks.provisionVMs.mock.calls[0]?.[1] as
      | ProvisionParams
      | undefined;
    expect(provisionParams?.cloudConfig).toMatchObject({
      vmType: VM_TYPE,
      region: FIRST_REGION,
      spot: false,
    });
    expect(
      await eventLog().getLatestFailureClassification(WORKLOAD_ID),
    ).toEqual({
      diagnosis: CloudFailureDiagnosis.InvalidTarget,
      disposition: FailureDisposition.FailoverTarget,
    });
    const failureEvent = (await eventLog().getWorkloadEvents(WORKLOAD_ID))
      .map((event) => JSON.parse(event.metadata ?? '{}'))
      .findLast(
        (metadata) =>
          metadata.diagnosis === CloudFailureDiagnosis.InvalidTarget,
      );
    expect(failureEvent).toMatchObject({
      credentialId,
      targetVmType: VM_TYPE,
      targetRegion: FIRST_REGION,
      targetSpot: false,
    });
    expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
      WorkloadState.Retrying,
    );

    const attempts = await ledger().getProvisioningAttempts(WORKLOAD_ID);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      cloud_id: ATTEMPTED_VM_ID,
      region: FIRST_REGION,
      vm_type: VM_TYPE,
      credential_id: credentialId,
      launch_diagnosis: CloudFailureDiagnosis.InvalidTarget,
    });
    expect(
      pickTarget(
        REGIONS.map((region) => ({ vmType: VM_TYPE, region })),
        await queries().getProvisioningFailures(
          WORKLOAD_ID,
          credentialId,
          CloudType.Azure,
        ),
      ).region,
    ).toBe(SECOND_REGION);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await runWorkloadReconcileOnce();
    // The no-IP ledger row can represent partial Azure resources. Retry
    // preparation must clean it before admitting the next target.
    expect(mocks.teardownVMs).toHaveBeenCalledWith(
      expect.objectContaining({ region: FIRST_REGION }),
      WORKLOAD_ID,
    );
    expect(
      (await ledger().getProvisioningAttempts(WORKLOAD_ID))[0]?.ended_at,
    ).not.toBeNull();
    expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
      WorkloadState.Queued,
    );

    releaseQuotaSweep({
      insufficientRegions: new Set([FIRST_REGION]),
      unknownRegions: new Set(),
      complete: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    mocks.getInsufficientQuotaRegions.mockResolvedValue({
      insufficientRegions: new Set([FIRST_REGION]),
      unknownRegions: new Set(),
      complete: true,
    });
    expect(mocks.ensureProviderRegistered).toHaveBeenCalledOnce();

    // This probe reached its own fixed shared-work deadline and is not
    // cacheable, so the next resolution must start a fresh probe.
    await vi.advanceTimersByTimeAsync(5_000);

    const queuedWorkload = await queries().getWorkload(WORKLOAD_ID);
    expect(queuedWorkload).not.toBeNull();
    if (!queuedWorkload) throw new Error('queued workload disappeared');
    const secondResolution = await resolveProvisioningConfig(
      queuedWorkload,
      queries(),
      getCredentialSecretStore(),
    );

    expect(secondResolution.state).toBe(WorkloadState.Provisioning);
    if (secondResolution.state !== WorkloadState.Provisioning) {
      throw new Error(
        `retry became terminal: ${secondResolution.state} ${secondResolution.message}`,
      );
    }
    expect(secondResolution.config).toMatchObject({
      cloudProvider: CloudType.Azure,
      vmType: VM_TYPE,
      region: SECOND_REGION,
      spot: false,
    });
    expect(secondResolution.eligibleRegions).toEqual(REGIONS.slice(1));
    expect(mocks.ensureProviderRegistered).toHaveBeenCalledTimes(2);
    expect(mocks.getInsufficientQuotaRegions).toHaveBeenCalledTimes(2);
    expect(mocks.getInsufficientQuotaRegions).toHaveBeenCalledWith(
      'azure:standardncasv3_t4family',
      VCPUS,
      false,
      REGIONS,
      expect.any(AbortSignal),
    );
  });
});
