import { describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import {
  createWorkloadManagementDomain,
  type WorkloadManagementDomainDependencies,
} from '../../../src/api/services/workload-management-domain.js';
import { DEFAULT_STATUS_EVENTS_LIMIT } from '../../../src/shared/api-contract/workload-management-schemas.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../../src/shared/runtime.js';
import { retryWindow } from '../../../src/api/services/retry-backoff.js';
import type { JobOperations } from '../../../src/api/services/job/operations.js';
import { makeStoredWorkload, makeWorkloadEvent } from '../helpers/fixtures.js';

describe('workload management status events paging', () => {
  type Store = WorkloadManagementDomainDependencies['store'];
  const row = {
    id: 1,
    workload_id: 'w',
    state: WorkloadState.Running,
    metadata: null,
    created_at: 0,
  };
  const getWorkloadStatusForScope = vi.fn<Store['getWorkloadStatusForScope']>(
    async (_id, _scope, limit) => ({
      workload: makeStoredWorkload(),
      events: Array.from({ length: limit ?? 5_000 }, () => row),
      eventsTotal: 5_000,
      retry: null,
    }),
  );
  // Only the members a status read touches are stubbed.
  const operations: Partial<JobOperations> = {
    observeHealth: async () => ({ status: WorkloadHealthStatus.Up }),
  };
  const store: Partial<Store> = {
    getWorkloadStatusForScope,
    listVms: async () => [],
  };
  const stubs: Partial<WorkloadManagementDomainDependencies> = {
    store: store as Store,
    resolveScope: async () => ({ kind: 'api' }),
    toWorkloadEvent: () =>
      makeWorkloadEvent({ metadata: { pad: 'x'.repeat(200) } }),
    recordStatusEvent: () => undefined,
    getWorkloadOperations: () => operations as JobOperations,
    statusHealthCheckTimeoutMs: 1_000,
    now: () => 0,
  };
  const domain = createWorkloadManagementDomain(
    stubs as WorkloadManagementDomainDependencies,
  );
  const actor: User = { id: '1', username: 'owner', token: '' };

  it('defaults to the recent tail, bounding a heavy workload payload', async () => {
    const response = await domain.status(actor, { id: 'w' }, '0');
    expect(getWorkloadStatusForScope).toHaveBeenLastCalledWith(
      'w',
      { kind: 'api' },
      DEFAULT_STATUS_EVENTS_LIMIT,
    );
    expect(response.events).toHaveLength(DEFAULT_STATUS_EVENTS_LIMIT);
    expect(response.eventsTotal).toBe(5_000);
    expect(JSON.stringify(response).length).toBeLessThan(100_000);
    await domain.status(actor, { id: 'w', eventsLimit: 'all' }, '0');
    expect(getWorkloadStatusForScope).toHaveBeenLastCalledWith(
      'w',
      { kind: 'api' },
      null,
    );
  });
});

describe('workload management status retry and checkpoint facts', () => {
  type Store = WorkloadManagementDomainDependencies['store'];
  const actor: User = { id: '1', username: 'owner', token: '' };

  const build = (
    snapshot: Partial<Awaited<ReturnType<Store['getWorkloadStatusForScope']>>>,
    readCheckpointHealth: WorkloadManagementDomainDependencies['readCheckpointHealth'] = vi.fn(),
    now = { value: 100_000 },
  ) => {
    const store: Partial<Store> = {
      getWorkloadStatusForScope: async () => ({
        workload: makeStoredWorkload(),
        events: [],
        eventsTotal: 0,
        retry: null,
        ...snapshot,
      }),
      listVms: async () => [],
    };
    const operations: Partial<JobOperations> = {
      observeHealth: async () => ({
        status: WorkloadHealthStatus.Up,
        vmHealth: [],
      }),
    };
    const dependencies: Partial<WorkloadManagementDomainDependencies> = {
      store: store as Store,
      resolveScope: async () => ({ kind: 'api' }),
      toWorkloadEvent: () => makeWorkloadEvent(),
      recordStatusEvent: () => undefined,
      readCheckpointHealth,
      getWorkloadOperations: () => operations as JobOperations,
      statusHealthCheckTimeoutMs: 1_000,
      logDebug: () => undefined,
      now: () => now.value,
    };
    return createWorkloadManagementDomain(
      dependencies as WorkloadManagementDomainDependencies,
    );
  };

  it('reports the retry attempt and the window the next attempt is sampled from', async () => {
    const domain = build({
      workload: makeStoredWorkload({
        state: WorkloadState.Retrying,
      }),
      retry: {
        retryCount: 3,
        lastRetryAt: 50_000,
        failedAtState: WorkloadState.Provisioning,
        regionDenied: 0,
        deniedRetryCount: 0,
      },
    });
    const { minMs, maxMs } = retryWindow(WorkloadState.Provisioning, 3);
    const response = await domain.status(actor, { id: 'w' }, '0');
    expect(response.retry).toEqual({
      attempt: 3,
      earliestAt: 50_000 + minMs,
      latestAt: 50_000 + maxMs,
    });
  });

  it('0047 reports an immediate retry after a regional denial', async () => {
    const domain = build({
      workload: makeStoredWorkload({
        state: WorkloadState.Retrying,
      }),
      retry: {
        retryCount: 3,
        lastRetryAt: 50_000,
        failedAtState: WorkloadState.Provisioning,
        regionDenied: 1,
        deniedRetryCount: 2,
      },
    });
    const response = await domain.status(actor, { id: 'w' }, '0');
    expect(response.retry).toEqual({
      attempt: 3,
      earliestAt: 50_000,
      latestAt: 50_000,
    });
  });

  it('0047 sizes the window from attempts that were not region denials', async () => {
    const domain = build({
      workload: makeStoredWorkload({
        state: WorkloadState.Retrying,
      }),
      retry: {
        retryCount: 5,
        lastRetryAt: 50_000,
        failedAtState: WorkloadState.Provisioning,
        regionDenied: 0,
        deniedRetryCount: 4,
      },
    });
    const { minMs, maxMs } = retryWindow(WorkloadState.Provisioning, 1);
    const response = await domain.status(actor, { id: 'w' }, '0');
    expect(response.retry).toEqual({
      attempt: 5,
      earliestAt: 50_000 + minMs,
      latestAt: 50_000 + maxMs,
    });
  });

  it('omits retry facts outside Retrying', async () => {
    const response = await build({}).status(actor, { id: 'w' }, '0');
    expect(response.retry).toBeUndefined();
  });

  it('reports the checkpoint target and its bucket health while live, cached for a minute', async () => {
    const health = {
      objects: 52,
      bytes: 105_906_176,
      lastModifiedAt: 99_000,
      truncated: false,
    };
    const readCheckpointHealth = vi.fn(async () => health);
    const now = { value: 100_000 };
    const domain = build(
      {
        workload: makeStoredWorkload({
          id: 'spot-job',
          spot: true,
          checkpointBucket: null,
          state: WorkloadState.Running,
        }),
      },
      readCheckpointHealth,
      now,
    );
    const first = await domain.status(actor, { id: 'spot-job' }, '0');
    expect(first.checkpoint).toEqual({
      bucket: 'spot-job',
      mount: '/mnt/checkpoint',
      retained: false,
      health,
    });
    now.value += 59_000;
    await domain.status(actor, { id: 'spot-job' }, '0');
    expect(readCheckpointHealth).toHaveBeenCalledTimes(1);
    now.value += 2_000;
    await domain.status(actor, { id: 'spot-job' }, '0');
    expect(readCheckpointHealth).toHaveBeenCalledTimes(2);
  });

  it('keeps the checkpoint target without health once terminal or when the listing fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('AccessDenied');
    });
    const live = await build(
      {
        workload: makeStoredWorkload({
          checkpointBucket: 'my-ckpt',
          state: WorkloadState.Running,
        }),
      },
      failing,
    ).status(actor, { id: 'w' }, '0');
    expect(live.checkpoint).toEqual({
      bucket: 'my-ckpt',
      mount: '/mnt/checkpoint',
      retained: true,
    });

    const unused = vi.fn();
    const done = await build(
      {
        workload: makeStoredWorkload({
          spot: true,
          state: WorkloadState.Completed,
        }),
      },
      unused,
    ).status(actor, { id: 'w' }, '0');
    expect(done.checkpoint?.health).toBeUndefined();
    expect(unused).not.toHaveBeenCalled();
  });

  it('bounds a hung listing and shares it with concurrent reads', async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(() => new Promise<never>(() => undefined));
      const domain = build(
        {
          workload: makeStoredWorkload({
            spot: true,
            state: WorkloadState.Running,
          }),
        },
        hung,
      );
      const reads = Promise.all([
        domain.status(actor, { id: 'w' }, '0'),
        domain.status(actor, { id: 'w' }, '0'),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      const responses = await reads;
      expect(responses.map((r) => r.checkpoint?.health)).toEqual([
        undefined,
        undefined,
      ]);
      expect(hung).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
