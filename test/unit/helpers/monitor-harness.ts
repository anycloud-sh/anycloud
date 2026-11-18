/**
 * Module mocks shared by the monitor and workload-workflow specs. Each spec
 * registers them with `vi.mock(path, async () => (await import(this)).x())`;
 * this module imports no mocked source module, so a factory can load it.
 */
import { vi } from 'vitest';
import type * as CloudConfigModule from '../../../src/api/services/cloud-config';
import type * as SharedUtilsModule from '../../../src/shared/utils';

async function workloadQueries() {
  const { getWorkloadQueryStore } = await import(
    '../../../src/api/services/persistence'
  );
  return getWorkloadQueryStore();
}

async function workloadStore() {
  return import('../../helpers/workload-store.js');
}

async function workloadOutcomes() {
  const { getWorkloadOutcomes } = await import(
    '../../../src/api/services/persistence'
  );
  return getWorkloadOutcomes();
}

export const serveRuntime = {
  deploy: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(true),
  teardown: vi.fn(async ({ workload }: { workload: { id: string } }) => {
    await (await workloadStore()).releaseTestVms(workload.id);
  }),
  cleanup: vi.fn().mockResolvedValue(undefined),
};

export function serveRuntimeMock() {
  return { getDefaultServeRuntime: () => serveRuntime };
}

export function terminationMock() {
  const terminateStep = vi.fn().mockResolvedValue(undefined);
  const completeCleanup = async (
    workloadId: string,
    cleanup: (workload: unknown) => Promise<void>,
    workloadSnapshot?: {
      completedAt: number | null;
      cleanedAt?: number | null;
    },
  ) => {
    const store = await workloadQueries();
    const workload = workloadSnapshot ?? (await store.getWorkload(workloadId));
    if (
      !workload ||
      workload.completedAt === null ||
      workload.cleanedAt !== null
    ) {
      return false;
    }
    await cleanup(workload);
    // The real terminateStep soft-deletes every provider-confirmed row before
    // cleaned_at is committed. Keep this orchestration mock faithful now that
    // the store enforces that invariant atomically.
    await (await workloadStore()).releaseTestVms(workloadId);
    return (await workloadOutcomes()).markCleanupComplete(workloadId);
  };
  return {
    terminateStep,
    teardownVMs: vi.fn(async (_cloudConfig, workloadId: string) => {
      // A successful retry teardown retires the provider-confirmed attempts.
      // Tests for pending release deliberately override this with a no-op.
      await (await workloadStore()).releaseTestVms(workloadId);
    }),
    terminate: vi.fn((cloudConfig, workloadId, workloadSnapshot) =>
      completeCleanup(
        workloadId,
        () => terminateStep(cloudConfig, workloadId),
        workloadSnapshot,
      ),
    ),
  };
}

export function vmContainerRepairMock() {
  return {
    reconcileRunningVmContainer: vi
      .fn()
      .mockResolvedValue({ outcome: 'healthy' }),
  };
}

export function vmHostStartupMock() {
  return {
    deploy: vi.fn().mockResolvedValue(undefined),
    resumeOnExistingVM: vi.fn().mockResolvedValue(undefined),
  };
}

export function completionMock() {
  return {
    checkJobCompletion: vi.fn().mockResolvedValue(undefined),
    finalizeJobArtifacts: vi.fn().mockResolvedValue(undefined),
  };
}

export function workloadCleanupMock() {
  return {
    completeWorkloadCleanup: vi.fn(
      async (_cloudConfig, workloadId, cleanup) => {
        const store = await workloadQueries();
        const workload = await store.getWorkload(workloadId);
        if (
          !workload ||
          workload.completedAt === null ||
          workload.cleanedAt !== null
        ) {
          return false;
        }
        await cleanup(workload);
        await (await workloadStore()).releaseTestVms(workloadId);
        return (await workloadOutcomes()).markCleanupComplete(workloadId);
      },
    ),
  };
}

export function catalogReadinessMock() {
  return {
    ensureCatalogReady: vi.fn().mockResolvedValue(undefined),
    isCatalogUnavailableError: vi.fn(() => false),
    CATALOG_REFRESH_INTERVAL_MS: 60 * 60_000,
    refreshCatalogs: vi.fn().mockResolvedValue(undefined),
  };
}

// The default withTimeout mock: hand the operation back untouched so a test
// only sees a deadline when it opts into one. Annotating instead of casting
// keeps the generic signature checked.
export const passthroughTimeout: typeof SharedUtilsModule.withTimeout = (
  promise,
) => promise;

export function sharedUtilsMock(real: typeof SharedUtilsModule) {
  return {
    ...real,
    withTimeout: vi.fn((promise: Promise<any>) => promise),
    tcpPing: vi.fn().mockResolvedValue(false),
    checkNetworkConnectivity: vi.fn().mockResolvedValue(true),
  };
}

export function cloudConfigMock(real: typeof CloudConfigModule) {
  return {
    ...real,
    buildCloudConfig: vi.fn().mockReturnValue({
      cloudProvider: 'GCP',
      region: 'us-central1',
      vmType: 'n2-standard-4',
    }),
    createComputeProvider: vi.fn().mockReturnValue({}),
    createStorageProvider: vi.fn().mockReturnValue({}),
    resolveProvisioningConfig: vi.fn(real.resolveProvisioningConfig),
  };
}
