import { describe, expect, test } from 'vitest';

import { GPU_RERUN_DIAGNOSIS } from '../../src/api/services/workload-event-metadata.js';
import { GPU_PASSED_PROBE } from '../../src/api/services/workload-workflows/missing-gpu.js';
import { WorkloadState } from '../../src/shared/workload.js';
import {
  gpuProbeRerunEvidence,
  gpusMatchType,
  launchFailovers,
} from '../integration/e2e/internal/contracts/dedicated-job.js';

const PROBE = 'GPU 0: NVIDIA A10 (UUID: GPU-0)\nCUresult 0\nexit=0';
let id = 0;
const event = (state: WorkloadState, metadata: Record<string, unknown>) => ({
  id: (id += 1),
  workloadId: 'j',
  state,
  metadata,
  createdAt: id,
});
const status = (state: WorkloadState, events: ReturnType<typeof event>[]) => ({
  workload: { state },
  events,
});

describe('gpu-probe-rerun evidence', () => {
  test('one in-place rerun on one VM, then the passed-probe end, satisfies it even with an event after it', () => {
    expect(
      gpuProbeRerunEvidence(
        status(WorkloadState.Errored, [
          event(WorkloadState.Running, {}),
          event(WorkloadState.Retrying, {
            diagnosis: GPU_RERUN_DIAGNOSIS,
            gpuProbe: PROBE,
          }),
          event(WorkloadState.Running, {}),
          event(WorkloadState.Errored, { message: GPU_PASSED_PROBE }),
          // A later event doesn't hide the Errored end.
          event(WorkloadState.Finalizing, {}),
        ]),
        [{ cloudId: 'i-1' }, { cloudId: 'i-1' }],
      ),
    ).toEqual({ vms: ['i-1'], failures: [] });
  });

  test('three fresh VMs and a Failed end name every broken promise', () => {
    const { failures } = gpuProbeRerunEvidence(
      status(WorkloadState.Failed, [
        event(WorkloadState.Retrying, { diagnosis: 'unusable-gpu' }),
        event(WorkloadState.Retrying, { diagnosis: 'unusable-gpu' }),
        event(WorkloadState.Failed, {
          message: 'GPU unusable on every fresh VM',
        }),
      ]),
      [{ cloudId: 'i-1' }, { cloudId: 'i-2' }, { cloudId: 'i-3' }],
    );
    expect(failures).toEqual([
      'ended failed, not errored',
      expect.stringContaining('the end does not say the GPU passed'),
      '0 in-place reruns, not one',
      '2 retries besides the in-place rerun',
      expect.stringContaining("the rerun's probe did not pass"),
      'ran on 3 VMs: i-1, i-2, i-3',
    ]);
  });

  test('capacity failovers before the Job ran are not reruns or its VMs', () => {
    const before = id;
    expect(
      gpuProbeRerunEvidence(
        status(WorkloadState.Errored, [
          event(WorkloadState.Retrying, { diagnosis: 'capacity-exhausted' }),
          event(WorkloadState.Running, {}),
          event(WorkloadState.Retrying, {
            diagnosis: GPU_RERUN_DIAGNOSIS,
            gpuProbe: PROBE,
          }),
          event(WorkloadState.Errored, { message: GPU_PASSED_PROBE }),
        ]),
        [
          { cloudId: 'refused', endedAt: before + 1 },
          { cloudId: 'i-1', endedAt: null },
        ],
      ),
    ).toEqual({ vms: ['i-1'], failures: [] });
  });

  test('a retry before the Job ran that is not a capacity failover still counts', () => {
    const { failures } = gpuProbeRerunEvidence(
      status(WorkloadState.Errored, [
        event(WorkloadState.Retrying, { diagnosis: 'unusable-gpu' }),
        event(WorkloadState.Running, {}),
        event(WorkloadState.Retrying, {
          diagnosis: GPU_RERUN_DIAGNOSIS,
          gpuProbe: PROBE,
        }),
        event(WorkloadState.Errored, { message: GPU_PASSED_PROBE }),
      ]),
      [{ cloudId: 'i-0', endedAt: id - 3 }, { cloudId: 'i-1' }],
    );
    expect(failures).toEqual([
      '1 retries besides the in-place rerun',
      'ran on 2 VMs: i-0, i-1',
    ]);
  });

  test('a rerun whose probe found no GPU is not the passing path', () => {
    const { failures } = gpuProbeRerunEvidence(
      status(WorkloadState.Errored, [
        event(WorkloadState.Retrying, {
          diagnosis: GPU_RERUN_DIAGNOSIS,
          gpuProbe: 'No devices were found\nexit=9',
        }),
        event(WorkloadState.Errored, { message: GPU_PASSED_PROBE }),
      ]),
      [{ cloudId: 'i-1' }],
    );
    expect(failures).toEqual([
      expect.stringContaining("the rerun's probe did not pass"),
    ]);
  });
});

describe('launched-type and failover evidence', () => {
  test('a Lambda type names its GPU count and model; other types have none', () => {
    expect(gpusMatchType('gpu_1x_a10', ['NVIDIA A10'])).toBe(true);
    expect(gpusMatchType('gpu_1x_a10', ['NVIDIA A100-SXM4-40GB'])).toBe(false);
    expect(gpusMatchType('gpu_2x_a10', ['NVIDIA A10'])).toBe(false);
    expect(gpusMatchType('t3.large', [])).toBe(true);
  });

  test('pairs each launch failover with the next claim and its untried count', () => {
    const at = (
      state: WorkloadState,
      createdAt: number,
      metadata: Record<string, unknown>,
    ) => ({ ...event(state, metadata), createdAt });
    const failover = { disposition: 'failover-target', launchFailover: true };
    expect(
      launchFailovers([
        at(WorkloadState.Provisioning, 0, { untriedTargets: 3 }),
        at(WorkloadState.Retrying, 1_000, failover),
        at(WorkloadState.Provisioning, 3_000, { untriedTargets: 2 }),
        at(WorkloadState.Retrying, 4_000, failover),
        at(WorkloadState.Retrying, 5_000, { disposition: 'retry-same-target' }),
      ]),
    ).toEqual({
      failovers: [
        { id: id - 3, claimAfterMs: 2_000 },
        { id: id - 1, claimAfterMs: Number.POSITIVE_INFINITY },
      ],
      untried: [3, 2],
    });
  });
});
