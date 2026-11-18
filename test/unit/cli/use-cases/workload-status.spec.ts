import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  readWorkloadStatus,
  watchWorkloadStatus,
  workloadStatusView,
  type WorkloadStatusClient,
} from '../../../../src/cli/use-cases/workload-status.js';
import type { WorkloadStatusResponse } from '../../../../src/shared/api-contract/workload-management-schemas.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import {
  ContainerState,
  ServiceState,
  WorkloadHealthStatus,
} from '../../../../src/shared/runtime.js';
import {
  makeStatusWorkloadMetadata,
  makeWorkloadEvent,
} from '../../helpers/fixtures.js';

const response = (
  overrides: Partial<WorkloadStatusResponse> = {},
): WorkloadStatusResponse => ({
  workload: makeStatusWorkloadMetadata({ state: WorkloadState.Running }),
  events: [],
  status: WorkloadHealthStatus.Unknown,
  vms: [],
  ...overrides,
});

const statusMock = () => vi.fn<WorkloadStatusClient['workloads']['status']>();
const statusClient = (
  status: WorkloadStatusClient['workloads']['status'],
): WorkloadStatusClient => ({ workloads: { status } });

afterEach(() => {
  vi.useRealTimers();
});

describe('readWorkloadStatus', () => {
  it('--history asks the API for every event; a default read takes the tail', async () => {
    const status = statusMock().mockResolvedValue(response());
    await readWorkloadStatus(statusClient(status), { id: 'dep-1' }, {});
    await readWorkloadStatus(
      statusClient(status),
      { id: 'dep-1' },
      { history: true },
    );
    expect(status.mock.calls.map((c) => c[0].query)).toEqual([
      { verbose: undefined, eventsLimit: undefined },
      { verbose: undefined, eventsLimit: 'all' },
    ]);
  });
});

describe('watchWorkloadStatus', () => {
  it('polls until the workload reaches a terminal state', async () => {
    vi.useFakeTimers();
    const status = statusMock()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        response({
          workload: makeStatusWorkloadMetadata({
            state: WorkloadState.Completed,
          }),
        }),
      );
    const onStatus = vi.fn();
    const run = watchWorkloadStatus(
      statusClient(status),
      { id: 'dep-1' },
      { intervalSeconds: 1, onStatus },
    );
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(status).toHaveBeenCalledTimes(2);
    expect(onStatus.mock.calls.map(([, iteration]) => iteration)).toEqual([
      0, 1,
    ]);
  });
});

describe('workloadStatusView', () => {
  const vm = {
    ip: '1.2.3.4',
    endedAt: null,
    container: { state: ContainerState.Running },
    rclone: {
      output: { status: ServiceState.Running, logs: 'rclone: ok' },
      checkpoint: { status: ServiceState.Running, logs: 'rclone: ok' },
    },
  };
  const syncLabels = (
    workload: Parameters<typeof makeStatusWorkloadMetadata>[0],
  ) =>
    workloadStatusView(
      response({ workload: makeStatusWorkloadMetadata(workload), vms: [vm] }),
      {},
    ).vms[0]?.syncs.map((sync) => sync.label);

  it('does not show checkpoint-sync for a non-spot workload', () => {
    expect(syncLabels({ spot: false, outputBucket: 'results-bucket' })).toEqual(
      ['output-sync'],
    );
  });

  it('shows checkpoint-sync for an explicit non-spot checkpoint bucket', () => {
    expect(
      syncLabels({ spot: false, checkpointBucket: 'server-state' }),
    ).toEqual(['checkpoint-sync']);
  });

  it('hides terminated VMs unless verbose, and marks VMs a terminal workload still holds', () => {
    const view = (verbose: boolean) =>
      workloadStatusView(
        response({
          workload: makeStatusWorkloadMetadata({
            state: WorkloadState.Terminated,
          }),
          vms: [vm, { ...vm, ip: '5.6.7.8', endedAt: 1 }],
        }),
        { verbose },
      ).vms.map(({ ip, lifecycle }) => [ip, lifecycle]);
    expect(view(false)).toEqual([['1.2.3.4', 'releasing']]);
    expect(view(true)).toEqual([
      ['1.2.3.4', 'releasing'],
      ['5.6.7.8', 'terminated'],
    ]);
  });

  it('decides pending, terminal, event visibility and upgrade grouping from a read', async () => {
    const event = makeWorkloadEvent({ state: WorkloadState.Running });
    const status = statusMock().mockResolvedValue(
      response({
        workload: makeStatusWorkloadMetadata({
          state: WorkloadState.Starting,
          workloadType: WorkloadType.Service,
        }),
        events: [event],
        eventsTotal: 42,
        vms: [vm],
      }),
    );
    const view = workloadStatusView(
      await readWorkloadStatus(statusClient(status), { id: 'dep-1' }, {}),
      {},
    );
    expect(view).toMatchObject({
      isPending: true,
      isCompleted: false,
      showEvents: true,
      groupServiceUpgrades: true,
      hiddenEvents: 41,
    });

    const settled = workloadStatusView(
      response({
        workload: makeStatusWorkloadMetadata({ state: WorkloadState.Failed }),
        events: [event],
        eventsTotal: 1,
      }),
      {},
    );
    expect(settled).toMatchObject({
      isPending: false,
      isCompleted: true,
      groupServiceUpgrades: false,
      hiddenEvents: null,
    });
    expect(workloadStatusView(response(), {}).showEvents).toBe(false);
  });

  it('judges container and sync health, counting only structured rclone errors', () => {
    const [view] = workloadStatusView(
      response({
        workload: makeStatusWorkloadMetadata({
          outputBucket: 'results',
          checkpointBucket: 'state',
        }),
        vms: [
          {
            ...vm,
            container: { state: ContainerState.Exited, exitCode: 1 },
            rclone: {
              output: {
                status: ServiceState.Running,
                logs: 'systemd: Failed to clean up cgroup',
              },
              checkpoint: {
                status: ServiceState.Running,
                logs: 'ERROR : checkpoint.tar: Failed to copy',
              },
            },
          },
        ],
      }),
      {},
    ).vms;
    expect(view?.containerHealthy).toBe(false);
    expect(
      view?.syncs.map(({ label, running, hasErrors, ok }) => ({
        label,
        running,
        hasErrors,
        ok,
      })),
    ).toEqual([
      { label: 'output-sync', running: true, hasErrors: false, ok: true },
      { label: 'checkpoint-sync', running: true, hasErrors: true, ok: false },
    ]);
  });
});
