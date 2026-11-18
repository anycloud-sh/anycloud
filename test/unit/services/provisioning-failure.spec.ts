import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { completeCloudConfig } from '../../../src/shared/cloud-config.js';
import { randomBytes } from 'crypto';

// Terminal states now always release the VM, so completion runs teardown. These
// tests are about the completion decision, not the provider call, so stub the
// compute provider rather than letting teardown reach a real cloud SDK.
vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...actual,
    createComputeProvider: vi.fn(
      (cloudConfig: import('../../../src/shared/cloud.js').CloudConfig) => ({
        type: cloudConfig.cloudProvider,
        region: cloudConfig.region ?? '',
        terminateVMs: vi.fn(async (vmIds: string[]) => vmIds),
        terminateNetworking: vi.fn(async () => undefined),
        classifyError: vi.fn(() => undefined),
        isTerminalAuthError: vi.fn(() => false),
      }),
    ),
  };
});

import { resolveProvisioningFailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud.js';
import {
  FailureDisposition,
  classifyStepFailure,
} from '../../../src/api/services/provisioning-failure.js';
import { Lambda } from '../../../src/api/services/gateways/lambda';
import { Azure } from '../../../src/api/services/gateways/azure';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { resetTestStore } from '../utils';
import { runStep } from '../../../src/api/services/task';
import config from '../../../src/api/config';
import { ResourceStateIndeterminateError } from '../../../src/shared/errors';
import {
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

describe('resolveProvisioningFailureDisposition', () => {
  const pinned = 'us-east-1';

  it('routes pinned invalid-target to terminal-invalid while preserving the diagnosis', () => {
    expect(
      resolveProvisioningFailureDisposition(
        CloudFailureDiagnosis.InvalidTarget,
        pinned,
      ),
    ).toBe(FailureDisposition.TerminalInvalid);
  });

  it('routes pinned provisioning-rejected to retry-same-target', () => {
    expect(
      resolveProvisioningFailureDisposition(
        CloudFailureDiagnosis.ProvisioningRejected,
        pinned,
      ),
    ).toBe(FailureDisposition.RetrySameTarget);
  });

  it.each([
    CloudFailureDiagnosis.TemporaryProviderFailure,
    CloudFailureDiagnosis.QuotaExhaustedRegion,
    CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
    CloudFailureDiagnosis.QuotaExhaustedAccount,
    CloudFailureDiagnosis.CapacityExhausted,
  ])('routes pinned %s to retry-same-target', (diagnosis) => {
    expect(resolveProvisioningFailureDisposition(diagnosis, pinned)).toBe(
      FailureDisposition.RetrySameTarget,
    );
  });

  it.each([
    CloudFailureDiagnosis.InvalidTarget,
    CloudFailureDiagnosis.ProvisioningRejected,
    CloudFailureDiagnosis.QuotaExhaustedRegion,
    CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
    CloudFailureDiagnosis.CapacityExhausted,
  ])('routes region-unpinned %s to failover-target', (diagnosis) => {
    expect(resolveProvisioningFailureDisposition(diagnosis, undefined)).toBe(
      FailureDisposition.FailoverTarget,
    );
  });

  it.each([
    CloudFailureDiagnosis.InvalidTarget,
    CloudFailureDiagnosis.ProvisioningRejected,
    CloudFailureDiagnosis.CapacityExhausted,
  ])(
    'routes selected-region/unpinned-zone %s to failover-target',
    (diagnosis) => {
      expect(
        resolveProvisioningFailureDisposition(diagnosis, pinned, true),
      ).toBe(FailureDisposition.FailoverTarget);
    },
  );

  it('keeps regional quota pinned to its region even when zones are selectable', () => {
    expect(
      resolveProvisioningFailureDisposition(
        CloudFailureDiagnosis.QuotaExhaustedRegion,
        pinned,
        true,
      ),
    ).toBe(FailureDisposition.RetrySameTarget);
  });

  it.each([
    CloudFailureDiagnosis.InvalidRequest,
    CloudFailureDiagnosis.BadCredential,
  ])('routes %s to terminal-invalid', (diagnosis) => {
    expect(resolveProvisioningFailureDisposition(diagnosis, pinned)).toBe(
      FailureDisposition.TerminalInvalid,
    );
  });

  it('0047: fails a regional permission denial over only when unpinned', () => {
    const denied = CloudFailureDiagnosis.PermissionDenied;
    expect(
      resolveProvisioningFailureDisposition(denied, undefined, false, true),
    ).toBe(FailureDisposition.FailoverTarget);
    expect(
      resolveProvisioningFailureDisposition(denied, pinned, true, true),
    ).toBe(FailureDisposition.TerminalInvalid);
    expect(resolveProvisioningFailureDisposition(denied, undefined)).toBe(
      FailureDisposition.TerminalInvalid,
    );
    expect(classifyStepFailure(denied).disposition).toBe(
      FailureDisposition.TerminalInvalid,
    );
  });

  it('treats an empty region as unpinned', () => {
    expect(
      resolveProvisioningFailureDisposition(
        CloudFailureDiagnosis.InvalidTarget,
        '',
      ),
    ).toBe(FailureDisposition.FailoverTarget);
  });
});

// End-to-end wiring: cloud.classifyError → provisioning disposition → runStep
// → terminal/retry state. Each hop is tested in isolation elsewhere, but
// nothing verified they compose correctly for Lambda errors. Without this
// test, a reworded Lambda error that silently falls through to
// temporary-provider-failure would still pass the per-hop tests but misbehave
// in production.
describe('cloud error → workload state wiring', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    await resetTestStore();
  });

  const PINNED_REGION = 'us-east-1';

  function classifyPinnedProvisioning(diagnosis: CloudFailureDiagnosis) {
    return classifyStepFailure(
      diagnosis,
      resolveProvisioningFailureDisposition(diagnosis, PINNED_REGION),
    );
  }

  async function createTestWorkload(id: string) {
    await upsertCredential(
      getDB(),
      'cred-hash',
      'cred-encrypted',
      CloudType.Lambda,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Lambda,
      region: PINNED_REGION,
      vmType: 'gpu_fake',
      spot: false,
      dockerCommand: 'echo hi',
      sshPrivateKey: 'k',
      credentialId: 'cred-hash',
    });
  }

  it('routes Lambda "Instance type does not exist" to Invalid (pinned region)', async () => {
    const id = 'runstep-invalid-type';
    await createTestWorkload(id);

    const lambda = new Lambda(
      completeCloudConfig({
        cloudProvider: CloudType.Lambda,
        credentials: { apiKey: 'x' },
        region: PINNED_REGION,
        availabilityZone: undefined,
        vmType: 'gpu_fake',
      }),
    );

    await expect(
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: async () => {
          throw new Error(
            'Lambda API POST /instance-operations/launch: [global/invalid-parameters] Instance type gpu_fake does not exist',
          );
        },
        timeoutMs: 5_000,
        onErrorState: WorkloadState.Retrying,
        classifyError: (e) =>
          classifyPinnedProvisioning(lambda.compute().classifyError(e)),
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Invalid);
    const events = await eventLog().getWorkloadEvents(id);
    const retryOrInvalidMetadata = JSON.parse(events.at(-1)?.metadata ?? '{}');
    expect(retryOrInvalidMetadata.diagnosis).toBe(
      CloudFailureDiagnosis.InvalidTarget,
    );
    expect(retryOrInvalidMetadata.disposition).toBe(
      FailureDisposition.TerminalInvalid,
    );
  });

  it('routes Lambda insufficient-capacity to Retrying (CapacityExhausted survives pinned-region coercion)', async () => {
    // CapacityExhausted is deliberately retryable in a pinned region because
    // capacity comes back on a timer.
    const id = 'runstep-quota';
    await createTestWorkload(id);

    const lambda = new Lambda(
      completeCloudConfig({
        cloudProvider: CloudType.Lambda,
        credentials: { apiKey: 'x' },
        region: PINNED_REGION,
        availabilityZone: undefined,
        vmType: 'gpu_1x_a100',
      }),
    );

    await expect(
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: async () => {
          throw new Error(
            'Lambda API POST /instance-operations/launch: [instance-operations/launch/insufficient-capacity] No capacity',
          );
        },
        timeoutMs: 5_000,
        onErrorState: WorkloadState.Retrying,
        classifyError: (e) =>
          classifyPinnedProvisioning(lambda.compute().classifyError(e)),
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });

  it('routes Azure stopped provisioning to Retrying in a pinned region', async () => {
    const id = 'runstep-azure-stopped';
    await createTestWorkload(id);

    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'tenant',
          applicationId: 'app',
          secret: 'secret',
        },
        region: PINNED_REGION,
        vmType: 'Standard_NC4as_T4_v3',
      }),
    );

    await expect(
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: async () => {
          throw Object.assign(
            new Error('Azure VM stopped before startup finished'),
            {
              code: 'AzureVMStatusError',
              powerState: 'stopped',
              vmStatus: 'failed',
            },
          );
        },
        timeoutMs: 5_000,
        onErrorState: WorkloadState.Retrying,
        classifyError: (e) =>
          classifyPinnedProvisioning(azure.compute().classifyError(e)),
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });

  it('routes the Azure shared-identity throttle to Retrying in a pinned region', async () => {
    // Regression: an HTTP-400 managed-identity throttle classifies as
    // temporary-provider-failure (no recognized code). The disposition resolver
    // must route it to Retrying — before, pinned temporary failures were coerced
    // to invalid-request and the job died Invalid, even though the throttle
    // clears on its own.
    const id = 'runstep-azure-throttle';
    await createTestWorkload(id);

    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'tenant',
          applicationId: 'app',
          secret: 'secret',
        },
        region: PINNED_REGION,
        vmType: 'Standard_NC4as_T4_v3',
      }),
    );

    await expect(
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: async () => {
          throw Object.assign(
            new Error(
              'Request is temporarily throttled because resource ' +
                '/subscriptions/x/resourcegroups/anycloud-storage/providers/' +
                'Microsoft.ManagedIdentity/userAssignedIdentities/anycloud-vm-identity ' +
                'has issued too many requests. Retry after 20 seconds.',
            ),
            { statusCode: 400 },
          );
        },
        timeoutMs: 5_000,
        onErrorState: WorkloadState.Retrying,
        classifyError: (e) =>
          classifyPinnedProvisioning(azure.compute().classifyError(e)),
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });

  it('routes the Azure concurrent-write conflict to Retrying in a pinned region', async () => {
    const id = 'runstep-azure-conflict';
    await createTestWorkload(id);

    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'tenant',
          applicationId: 'app',
          secret: 'secret',
        },
        region: PINNED_REGION,
        vmType: 'Standard_NC4as_T4_v3',
      }),
    );

    await expect(
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: async () => {
          throw Object.assign(
            new Error(
              'The operation was interrupted by a conflicting concurrent ' +
                'write on the same entity. Please retry later.',
            ),
            { statusCode: 400 },
          );
        },
        timeoutMs: 5_000,
        onErrorState: WorkloadState.Retrying,
        classifyError: (e) =>
          classifyPinnedProvisioning(azure.compute().classifyError(e)),
      }),
    ).rejects.toThrow();

    const workload = await queries().getWorkload(id);
    expect(workload?.state).toBe(WorkloadState.Retrying);
  });

  it('keeps the active step unchanged when provider state is inconclusive', async () => {
    const id = 'runstep-indeterminate-provider-state';
    await createTestWorkload(id);
    const onError = vi.fn();

    await expect(
      runStep({
        id,
        step: WorkloadState.Provisioning,
        fn: async () => {
          throw new ResourceStateIndeterminateError(
            'Could not inspect the existing provisioning attempt',
            new Error('provider timeout'),
          );
        },
        timeoutMs: 5_000,
        onErrorState: WorkloadState.Retrying,
        onError,
      }),
    ).rejects.toThrow(ResourceStateIndeterminateError);

    expect(onError).not.toHaveBeenCalled();
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Provisioning,
    );
  });
});
