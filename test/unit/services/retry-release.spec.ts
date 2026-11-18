import { randomBytes } from 'crypto';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import config from '../../../src/api/config';
import {
  createComputeProvider,
  encryptCredential,
  hashCredential,
} from '../../../src/api/services/cloud-config';
import {
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
} from '../../../src/api/services/gateways/cloud';
import {
  runWorkloadReconcileOnce,
  runProvisioningSchedulerOnce,
} from '../../../src/api/services/monitor';
import {
  resetPersistence,
  getProvisioningAttemptStore as ledger,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence';
import { CloudType } from '../../../src/shared/cloud';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { makeMockCloudCompute, TEST_GCP_CRED } from '../helpers/fixtures';
import { getWorkloadLifecycle } from '../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

// Substitute provider operations while retaining the actual shared gateway,
// teardown, attempt ledger, retry controller, scheduler, and timer utilities.
vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return { ...actual, createComputeProvider: vi.fn() };
});

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

async function reconcile(): Promise<
  Awaited<ReturnType<typeof runWorkloadReconcileOnce>>
> {
  let done = false;
  const work = runWorkloadReconcileOnce().finally(() => {
    done = true;
  });
  for (let tick = 0; tick < 120 && !done; tick++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  if (!done)
    throw new Error('Retry reconciliation exceeded two virtual minutes');
  return work;
}

describe.each([WorkloadType.Job, WorkloadType.Service])(
  'Shared VM release retry admission (%s)',
  (workloadType) => {
    beforeAll(() => {
      config.cipherKey = randomBytes(32).toString('hex');
    });

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-08T00:00:00.000Z'));
      resetPersistence();
      vi.clearAllMocks();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          throw new Error(
            'Unexpected network request in local release regression',
          );
        }),
      );
    });

    afterEach(() => {
      resetPersistence();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it.each([
      'request rejected',
      'confirmation exhausted',
      'partial cleanup',
    ] as const)(
      'does not queue an initially due retry while release is pending: %s',
      async (scenario) => {
        const id = 'shared-release-retry';
        const credentialId = await upsertCredential(
          getDB(),
          hashCredential(TEST_GCP_CRED),
          await encryptCredential(TEST_GCP_CRED),
          CloudType.GCP,
        );
        await createWorkload(getDB(), {
          id,
          userId: 'test-user',
          workloadType,
          image: 'alpine:latest',
          requestedComputeProvider: CloudType.GCP,
          region: 'us-central1',
          vmType: 'n2-standard-4',
          spot: false,
          dockerCommand: 'docker run alpine',
          sshPrivateKey: 'test-ssh-key',
          credentialId,
        });
        const partialCleanup = scenario === 'partial cleanup';
        await provisionTestVm(
          id,
          { cloudId: 'unresolved-vm' },
          { region: 'us-central1', vmType: 'n2-standard-4', credentialId },
        );
        if (partialCleanup) {
          // Ending only the no-IP attempt must not make the other VM reusable:
          // prepareTermination has already requested its removal too.
          await provisionTestVm(id, {
            cloudId: 'complete-vm',
            ip: '203.0.113.10',
          });
          await walkToState(id, WorkloadState.Downloading);
        }
        await walkToState(id, WorkloadState.Retrying);

        let allowRelease = false;
        const requestTermination = vi.fn(async (cloudId: string) => {
          if (!allowRelease && scenario === 'request rejected') {
            throw new Error(`Termination request rejected for ${cloudId}`);
          }
        });
        const observeRelease = vi.fn(async (cloudId: string) =>
          allowRelease || (partialCleanup && cloudId === 'unresolved-vm')
            ? VM_RELEASE_CANDIDATE
            : VM_PRESENT,
        );
        const compute = makeMockCloudCompute({
          rawRequestVMTermination: requestTermination,
          observeVMReleaseOnce: observeRelease,
        });
        vi.mocked(createComputeProvider).mockReturnValue(compute);
        const initialRetry = (
          await getWorkloadLifecycle().getRetryCandidatesByIds([id])
        )[0]!;

        // Discovery begins after backoff, so this also covers the direct launch
        // route that never saw an earlier preparation pass.
        await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
        const first = await reconcile();
        expect(first.deferredCount).toBe(1);
        expect(first.failureCount).toBe(0);
        expect((await queries().getWorkload(id))?.state).toBe(
          WorkloadState.Retrying,
        );
        const remaining = (await ledger().getProvisioningAttempts(id)).filter(
          (attempt) => attempt.ended_at === null,
        );
        expect(remaining.map((attempt) => attempt.cloud_id)).toEqual([
          partialCleanup ? 'complete-vm' : 'unresolved-vm',
        ]);
        expect(remaining[0]?.removal_requested_at).not.toBeNull();
        expect(compute.newVM).not.toHaveBeenCalled();
        if (scenario === 'request rejected') {
          expect(observeRelease).not.toHaveBeenCalled();
        } else {
          expect(
            observeRelease.mock.calls.filter(
              ([cloudId]) =>
                cloudId === (partialCleanup ? 'complete-vm' : 'unresolved-vm'),
            ),
          ).toHaveLength(4);
        }

        // Retry with the same still-unconfirmed resource. In the partial case
        // this proves the surviving complete VM cannot switch into layer reuse.
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await reconcile()).deferredCount).toBe(1);
        await runProvisioningSchedulerOnce();
        expect((await queries().getWorkload(id))?.state).toBe(
          WorkloadState.Retrying,
        );
        expect(
          (await getWorkloadLifecycle().getRetryCandidatesByIds([id]))[0]
            ?.retryCount,
        ).toBe(initialRetry.retryCount);
        expect(compute.newVM).not.toHaveBeenCalled();

        allowRelease = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await reconcile()).failureCount).toBe(0);
        expect((await queries().getWorkload(id))?.state).toBe(
          WorkloadState.Queued,
        );
        expect(
          (await ledger().getProvisioningAttempts(id)).every(
            (attempt) => attempt.ended_at !== null,
          ),
        ).toBe(true);
        expect(
          requestTermination.mock.calls.filter(
            ([cloudId]) => cloudId === 'unresolved-vm',
          ),
        ).toHaveLength(partialCleanup ? 1 : 3);
        expect(compute.terminateNetworking).not.toHaveBeenCalled();
      },
    );
  },
);
