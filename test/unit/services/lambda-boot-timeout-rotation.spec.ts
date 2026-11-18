/**
 * Replay of managed-Kubernetes qualification run 33635355557.
 *
 * Lambda accepts the first launch, then reports `booting` without an IP for
 * every readiness check. This test drives that response through the real
 * Lambda gateway, workload store, retry cleanup, and target picker. Only
 * Lambda's HTTP boundary and the work performed inside a healthy VM are
 * replaced with local fakes.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { randomBytes } from 'crypto';

vi.mock('../../../src/shared/utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/shared/utils')>();
  return {
    ...actual,
    checkNetworkConnectivity: vi.fn().mockResolvedValue(true),
  };
});

const { fakeTransport, initializeVMMock } = await vi.hoisted(async () => {
  const { createFakeTransport } = await import('../helpers/mock-transport');
  return {
    fakeTransport: createFakeTransport(),
    initializeVMMock: vi.fn(),
  };
});

vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => fakeTransport),
}));

vi.mock('../../../src/api/services/vm-initializer', () => ({
  initializeVM: initializeVMMock,
}));

vi.mock('../../../src/api/services/host-runtime/image-delivery', () => ({
  pullImage: vi.fn(),
}));

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import config from '../../../src/api/config';
import {
  encryptCredential,
  hashCredential,
  loadWorkloadConfigs,
  resolveProvisioningConfig,
} from '../../../src/api/services/cloud-config';
import {
  getCredentialSecretStore,
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import { deploy } from '../../../src/api/services/workload-workflows/vm-host-startup';
import { vmHostStartupDeps } from '../../../src/api/services/job/default-runtime';
import { pullImage } from '../../../src/api/services/host-runtime/image-delivery';
import { teardownVMs } from '../../../src/api/services/host-runtime/termination';
import { CloudFailureDiagnosis, CloudType } from '../../../src/shared/cloud.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import {
  runWorkloadReconcileOnce,
  runProvisioningSchedulerOnce,
} from '../../../src/api/services/monitor';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { resetLambdaCandidatePreflightCache } from '../../../src/api/services/gateways/lambda';
import { DockerManager } from '../../../src/api/services/docker';
import {
  drainWorkloadWork,
  hasWorkloadWork,
} from '../../../src/api/services/workload-work-registry';
import { ContainerState } from '../../../src/shared/runtime.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { TEST_LAMBDA_CRED } from '../helpers/fixtures';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

type FetchMock = Mock<typeof fetch>;
type LambdaStatus = 'booting' | 'active' | 'terminating' | 'terminated';

interface LaunchRequest {
  region_name: string;
  instance_type_name: string;
  name: string;
  tags: Array<{ key: string; value: string }>;
}

interface FakeLambdaInstance {
  id: string;
  name: string;
  ip: string | null;
  private_ip: string | null;
  status: LambdaStatus;
  region: { name: string; description: string };
  instance_type: { name: string };
  ssh_key_names: string[];
  tags: Array<{ key: string; value: string }>;
}

interface FakeLambdaInstanceState {
  point: FakeLambdaInstance;
  listedStatus: LambdaStatus;
}

const WORKLOAD_ID = 'mk8s-store-replay';
const VM_TYPES = ['gpu_1x_a10', 'cpu_4x_general', 'gpu_1x_a100_sxm4'];
const STUCK_INSTANCE_ID = '8f26a84293a94edca562c4a51e2d1af4';
const REPLACEMENT_INSTANCE_ID = '7ccbe8a7b12c41338725ddc66c5825d3';
const AVAILABLE_REGIONS = ['us-east-1', 'us-west-1'];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Keep the production polling and timeout implementation; only time is virtual.
async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const observed = work.finally(() => {
    done = true;
  });
  // Attach before advancing time so an expected rejection is always handled.
  void observed.catch(() => undefined);
  for (let tick = 0; tick < 3_600 && !done; tick++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  if (!done) throw new Error('Replay work exceeded one virtual hour');
  return observed;
}

describe('Lambda boot-timeout target rotation (run 33635355557 replay)', () => {
  let sshPrivateKey: string;
  let sshPublicKey: string;
  let originalFetch: typeof global.fetch;
  let fetchMock: FetchMock;

  beforeAll(async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    ({ privateKey: sshPrivateKey } = await SSHManager.generateKeypair());
    sshPublicKey = await SSHManager.derivePublicKey(sshPrivateKey);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T13:50:00.000Z'));
    resetPersistence();
    resetLambdaCandidatePreflightCache();
    vi.clearAllMocks();
    // Real subprocess time must not advance with the accelerated provider clock.
    vi.spyOn(SSHManager, 'derivePublicKey').mockResolvedValue(sshPublicKey);
    fakeTransport.reset();
    fakeTransport.default({ stdout: '', stderr: '', code: 0 });
    initializeVMMock.mockResolvedValue(undefined);
    vi.spyOn(DockerManager.prototype, 'ping').mockResolvedValue(true);
    vi.mocked(pullImage).mockResolvedValue({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      elapsedMs: 1,
    });
    vi.spyOn(DockerManager.prototype, 'startContainer').mockResolvedValue(
      undefined,
    );
    vi.spyOn(DockerManager.prototype, 'getContainerStatus').mockResolvedValue({
      state: ContainerState.Running,
    });
    originalFetch = global.fetch;
    fetchMock = vi.fn() as unknown as FetchMock;
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetLambdaCandidatePreflightCache();
    resetPersistence();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'waits for confirmed release before replacing the VM (exhausted batch: %s)',
    async (exhaustBatch) => {
      const instances = new Map<string, FakeLambdaInstanceState>();
      const launchRequests: LaunchRequest[] = [];
      const terminationReads = new Map<string, number>();
      const listTerminationReads = new Map<string, number>();
      const confirmedGone = new Set<string>();
      const agreementStreaks = new Map<string, number>();
      let stuckBootReads = 0;
      let allowRelease = !exhaustBatch;

      fetchMock.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';

        if (path.endsWith('/instance-types') && method === 'GET') {
          const data = Object.fromEntries(
            VM_TYPES.map((vmType) => [
              vmType,
              {
                instance_type: { name: vmType },
                regions_with_capacity_available: AVAILABLE_REGIONS.map(
                  (name) => ({ name }),
                ),
              },
            ]),
          );
          return jsonResponse({ data });
        }

        if (path.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'key-1', name: 'anycloud-api' }],
          });
        }

        if (path.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({ data: [] });
        }

        if (path.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [...instances.values()].map((instance) => {
              if (instance.point.status === 'terminated') {
                const reads =
                  (listTerminationReads.get(instance.point.id) ?? 0) + 1;
                listTerminationReads.set(instance.point.id, reads);
                if (instance.point.id === STUCK_INSTANCE_ID) {
                  // Reproduce the live failure: the list agrees once, reports
                  // the VM live again for several reads, then converges for good.
                  instance.listedStatus =
                    allowRelease && (reads === 1 || reads >= 5)
                      ? 'terminated'
                      : 'terminating';
                } else {
                  instance.listedStatus = 'terminated';
                }
                const agrees = instance.listedStatus === 'terminated';
                const streak = agrees
                  ? (agreementStreaks.get(instance.point.id) ?? 0) + 1
                  : 0;
                agreementStreaks.set(instance.point.id, streak);
                if (streak >= 2) confirmedGone.add(instance.point.id);
                else confirmedGone.delete(instance.point.id);
              }
              return { ...instance.point, status: instance.listedStatus };
            }),
          });
        }

        const instanceMatch = path.match(/\/instances\/([^/]+)$/);
        if (instanceMatch && method === 'GET') {
          const state = instances.get(instanceMatch[1]);
          if (!state) {
            throw new Error(
              `Unexpected read for Lambda instance ${instanceMatch[1]}`,
            );
          }
          const instance = state.point;
          if (
            instance.id === STUCK_INSTANCE_ID &&
            instance.status === 'booting'
          ) {
            stuckBootReads += 1;
          }
          if (instance.status === 'terminating') {
            const reads = (terminationReads.get(instance.id) ?? 0) + 1;
            terminationReads.set(instance.id, reads);
            if (reads >= 2) {
              instance.status = 'terminated';
            }
          }
          return jsonResponse({ data: instance });
        }

        if (path.endsWith('/instance-operations/launch') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as LaunchRequest;
          if (
            launchRequests.length > 0 &&
            !confirmedGone.has(STUCK_INSTANCE_ID)
          ) {
            throw new Error(
              'Replacement launched before the stuck VM was gone',
            );
          }
          launchRequests.push(body);
          const id =
            launchRequests.length === 1
              ? STUCK_INSTANCE_ID
              : REPLACEMENT_INSTANCE_ID;
          const replacement = launchRequests.length > 1;
          const status = replacement ? 'active' : 'booting';
          instances.set(id, {
            point: {
              id,
              name: body.name,
              ip: replacement ? '203.0.113.20' : null,
              private_ip: replacement ? '10.0.0.20' : null,
              status,
              region: { name: body.region_name, description: '' },
              instance_type: { name: body.instance_type_name },
              ssh_key_names: ['anycloud-api'],
              tags: body.tags,
            },
            listedStatus: status,
          });
          return jsonResponse({ data: { instance_ids: [id] } });
        }

        if (
          path.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            instance_ids?: string[];
          };
          const terminated = (body.instance_ids ?? []).map((id) => {
            const state = instances.get(id);
            if (!state) throw new Error(`Unexpected termination for ${id}`);
            if (state.point.status !== 'terminated') {
              state.point.status = 'terminating';
            }
            if (state.listedStatus !== 'terminated') {
              state.listedStatus = 'terminating';
            }
            return state.point;
          });
          return jsonResponse({ data: { terminated_instances: terminated } });
        }

        throw new Error(`Unhandled Lambda request: ${method} ${path}`);
      });

      const encryptedCredential = await encryptCredential(TEST_LAMBDA_CRED);
      const credentialId = await upsertCredential(
        getDB(),
        hashCredential(TEST_LAMBDA_CRED),
        encryptedCredential,
        CloudType.Lambda,
      );

      await createWorkload(getDB(), {
        id: WORKLOAD_ID,
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.Lambda,
        vmType: VM_TYPES,
        spot: false,
        dockerCommand: 'docker run alpine echo ok',
        sshPrivateKey,
        credentialId,
      });

      const workload = await queries().getWorkload(WORKLOAD_ID);
      if (!workload) throw new Error('workload fixture was not created');

      const firstResolution = await resolveProvisioningConfig(
        workload,
        queries(),
        getCredentialSecretStore(),
      );
      if (firstResolution.state !== WorkloadState.Provisioning) {
        throw new Error(`unexpected resolution: ${firstResolution.state}`);
      }
      const firstTarget = {
        vmType: firstResolution.config.vmType,
        region: firstResolution.config.region,
      };
      expect(typeof firstTarget.vmType).toBe('string');
      expect(typeof firstTarget.region).toBe('string');

      expect(
        await lifecycle().updateState(WORKLOAD_ID, WorkloadState.Provisioning, {
          metadata: {
            region: firstResolution.config.region,
            eligibleRegions: firstResolution.eligibleRegions,
          },
        }),
      ).toBe(true);

      await expect(
        settle(
          deploy(
            vmHostStartupDeps(),
            firstResolution.config,
            workload,
            firstResolution.credentialId,
          ),
        ),
      ).rejects.toThrow(
        `Lambda instance ${STUCK_INSTANCE_ID} did not get IP: status=booting, hasIp=false`,
      );

      expect(stuckBootReads).toBe(60);
      expect(launchRequests).toHaveLength(1);
      expect(
        await eventLog().getLatestFailureClassification(WORKLOAD_ID),
      ).toEqual({
        diagnosis: CloudFailureDiagnosis.CapacityExhausted,
        disposition: FailureDisposition.FailoverTarget,
      });
      expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
        WorkloadState.Retrying,
      );
      expect(await ledger().getProvisioningAttempts(WORKLOAD_ID)).toEqual([
        expect.objectContaining({
          cloud_id: STUCK_INSTANCE_ID,
          ended_at: null,
          vm_type: firstTarget.vmType,
          region: firstTarget.region,
        }),
      ]);

      const initialRetry = (
        await lifecycle().getRetryCandidatesByIds([WORKLOAD_ID])
      )[0]!;
      if (exhaustBatch) {
        // Discover immediately: cleanup preparation happens before launch backoff.
        vi.setSystemTime(initialRetry.lastRetryAt);
        const prepare = await settle(runWorkloadReconcileOnce());
        expect(prepare.deferredCount).toBe(1);
        expect(prepare.failureCount).toBe(0);
        // The first point read is still terminating; the other 29 polls
        // see a terminated point whose account-list view remains live.
        expect(listTerminationReads.get(STUCK_INSTANCE_ID)).toBe(29);
        expect(
          (await ledger().getProvisioningAttempts(WORKLOAD_ID))[0]?.ended_at,
        ).toBeNull();
        expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
          WorkloadState.Retrying,
        );

        // Even once launch backoff has elapsed, another exhausted batch must not
        // queue the workload or consume another provisioning attempt.
        await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
        const retry = await settle(runWorkloadReconcileOnce());
        expect(retry.deferredCount).toBe(1);
        await settle(runProvisioningSchedulerOnce());
        expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
          WorkloadState.Retrying,
        );
        expect(
          (await lifecycle().getRetryCandidatesByIds([WORKLOAD_ID]))[0]
            ?.retryCount,
        ).toBe(initialRetry.retryCount);
        expect(launchRequests).toHaveLength(1);
        allowRelease = true;
      }

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      const releaseReadsBefore =
        listTerminationReads.get(STUCK_INSTANCE_ID) ?? 0;
      const releaseStarted = Date.now();
      await settle(runWorkloadReconcileOnce());
      // A completed preparation may need another scheduler admission to launch.
      await settle(runWorkloadReconcileOnce());

      expect(confirmedGone).toContain(STUCK_INSTANCE_ID);
      if (exhaustBatch) {
        expect(
          listTerminationReads.get(STUCK_INSTANCE_ID)! - releaseReadsBefore,
        ).toBe(2);
        expect(Date.now() - releaseStarted).toBeGreaterThanOrEqual(10_000);
      }
      expect(
        listTerminationReads.get(STUCK_INSTANCE_ID),
      ).toBeGreaterThanOrEqual(6);
      expect(launchRequests).toHaveLength(1);
      expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
        WorkloadState.Queued,
      );
      expect(
        (await ledger().getProvisioningAttempts(WORKLOAD_ID))[0]?.ended_at,
      ).not.toBeNull();

      // Dispatch through the real provisioning scheduler and let its tracked
      // pipeline run. No direct state write or deploy call releases this retry.
      await settle(runProvisioningSchedulerOnce());
      await settle(drainWorkloadWork(WORKLOAD_ID));
      expect(hasWorkloadWork(WORKLOAD_ID)).toBe(false);
      await settle(runProvisioningSchedulerOnce());
      expect(launchRequests).toHaveLength(2);
      expect({
        vmType: launchRequests[1]?.instance_type_name,
        region: launchRequests[1]?.region_name,
      }).not.toEqual(firstTarget);
      expect((await queries().getWorkload(WORKLOAD_ID))?.state).toBe(
        WorkloadState.Running,
      );
      expect(await queries().getVMs(WORKLOAD_ID)).toEqual([
        expect.objectContaining({ cloudId: REPLACEMENT_INSTANCE_ID }),
      ]);

      const runningWorkload = await queries().getWorkload(WORKLOAD_ID);
      if (!runningWorkload) throw new Error('running workload disappeared');
      const runningConfig = await loadWorkloadConfigs(runningWorkload);
      if (!runningConfig)
        throw new Error('running workload lost its credentials');
      await settle(teardownVMs(runningConfig, WORKLOAD_ID));
      expect(confirmedGone).toContain(REPLACEMENT_INSTANCE_ID);
      expect(await queries().getVMs(WORKLOAD_ID)).toEqual([]);
    },
  );
});
