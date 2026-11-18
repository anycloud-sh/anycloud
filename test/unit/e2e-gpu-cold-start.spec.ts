import type { CoreV1Event, V1Node, V1Pod } from '@kubernetes/client-node';
import { describe, expect, test } from 'vitest';

import { cpuColdStartRecord } from '../integration/e2e/internal/contracts/gpu-cold-start.js';
import { poolColdStartTimes } from '../integration/e2e/internal/substrates/cloud-cluster/cold-start.js';
import { timingMarks } from '../integration/e2e/internal/substrates/cloud-cluster/hosted-stage.js';

const at = (ms: number) => new Date(ms);

describe('time to first inference', () => {
  test("reads the fixtures' AC_TIMING lines from a log, each name's first", () => {
    // json.dumps(sort_keys=True), as the fixtures print it.
    const log = [
      'AC_TIMING {"epochMs": 100, "name": "process_start"}',
      'receive-wait:20',
      'AC_TIMING {"epochMs": 250, "jobId": "j-1", "name": "first_claim"}',
      'AC_TIMING {"epochMs": 900, "name": "process_start"}',
      'AC_TIMING {"name": "no_time"}',
    ].join('\n');
    expect(timingMarks(log)).toEqual({ process_start: 100, first_claim: 250 });
  });

  const node = (ready = true, gpus = 1): V1Node => ({
    metadata: { name: 'node-a', creationTimestamp: at(60_000) },
    status: {
      capacity: gpus ? { 'nvidia.com/gpu': String(gpus) } : {},
      conditions: ready
        ? [
            {
              type: 'MemoryPressure',
              status: 'False',
              lastTransitionTime: at(1),
            },
            { type: 'Ready', status: 'True', lastTransitionTime: at(62_000) },
          ]
        : [],
    },
  });
  const pod: V1Pod = {
    metadata: { uid: 'pod-1' },
    status: {
      conditions: [
        {
          type: 'PodScheduled',
          status: 'True',
          lastTransitionTime: at(64_000),
        },
      ],
      containerStatuses: [
        {
          name: 'sidecar',
          image: '',
          imageID: '',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: at(1) } },
        },
        {
          name: 'workload',
          image: '',
          imageID: '',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: at(124_000) } },
        },
      ],
    },
  };
  const plugin: V1Pod = {
    status: {
      containerStatuses: [
        {
          name: 'nvidia-device-plugin',
          image: '',
          imageID: '',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: at(63_000) } },
        },
      ],
    },
  };

  test("dates a Node and its receiver Pod, and takes the pool's latest launch before the Node as its VM", () => {
    // 90 s is the host-loss replacement, launched after this Node registered.
    expect(
      poolColdStartTimes(pod, node(), plugin, [1_000, 5_000, 90_000]),
    ).toEqual({
      node: 'node-a',
      vmLaunchedAtMs: 5_000,
      nodeCreatedAtMs: 60_000,
      nodeReadyAtMs: 62_000,
      gpuPluginStartedAtMs: 63_000,
      podScheduledAtMs: 64_000,
      imagePull: null,
      runnerImagePull: null,
      containerStartedAtMs: 124_000,
    });
    // Lambda reports no launch.
    expect(poolColdStartTimes(pod, node(), plugin, [])).toMatchObject({
      vmLaunchedAtMs: null,
    });
  });

  test('fails on a time the read lacks, so a record is never partial', () => {
    expect(() => poolColdStartTimes(pod, node(false), undefined, [])).toThrow(
      'Node node-a and Pod pod-1 have no nodeReadyAtMs, gpuPluginStartedAtMs',
    );
  });

  const pulled = (
    message: string,
    ms: number,
    fieldPath = 'spec.containers{workload}',
  ) =>
    ({
      metadata: {},
      involvedObject: { fieldPath },
      reason: 'Pulled',
      message,
      firstTimestamp: at(ms),
    }) satisfies CoreV1Event;

  test("dates a CPU Node without a device plugin, and the replica's image from its Pulled event", () => {
    const times = poolColdStartTimes(
      pod,
      node(true, 0),
      undefined,
      [5_000],
      [
        pulled(
          'Successfully pulled image "x" in 41.2s (41.2s including waiting)',
          110_000,
        ),
        pulled(
          'Successfully pulled image "y" in 1s',
          2_000,
          'spec.containers{sidecar}',
        ),
        pulled(
          'Successfully pulled image "api" in 30.5s',
          95_000,
          'spec.initContainers{runner-install}',
        ),
      ],
    );
    expect(times).toMatchObject({
      gpuPluginStartedAtMs: null,
      imagePull: { atMs: 110_000, elapsedMs: 41_200, alreadyPresent: false },
      runnerImagePull: {
        atMs: 95_000,
        elapsedMs: 30_500,
        alreadyPresent: false,
      },
    });
    // A Node that pre-pulled the image: kubelet found it present.
    expect(
      poolColdStartTimes(
        pod,
        node(true, 0),
        undefined,
        [],
        [pulled('Container image "x" already present on machine', 123_000)],
      ).imagePull,
    ).toEqual({ atMs: 123_000, elapsedMs: 0, alreadyPresent: true });

    // From the VM to the Job's running event, each step between them.
    expect(
      cpuColdStartRecord('job-1', 'pod-1', times, 126_000, true).durationsMs,
    ).toEqual({
      total: 121_000,
      'vm_launched->node_created': 55_000,
      'node_created->node_ready': 2_000,
      'node_ready->pod_scheduled': 2_000,
      'pod_scheduled->image_pulled': 46_000,
      'image_pulled->container_started': 14_000,
      'container_started->job_running': 2_000,
    });
    // A Pod that came after its Node's boot has no total and no wait for it.
    expect(
      Object.keys(
        cpuColdStartRecord('job-1', 'pod-1', times, 126_000, false).durationsMs,
      ),
    ).toEqual([
      'vm_launched->node_created',
      'node_created->node_ready',
      'pod_scheduled->image_pulled',
      'image_pulled->container_started',
      'container_started->job_running',
    ]);
  });

  test('fails a CPU record whose pull or running event is missing', () => {
    const times = poolColdStartTimes(pod, node(true, 0), undefined, []);
    expect(() => cpuColdStartRecord('job-1', 'pod-1', times, 1, true)).toThrow(
      'Pod pod-1 of Job job-1 has no Pulled event for its image',
    );
    // No launch before the Node registered: the VM's time is missing.
    expect(() =>
      cpuColdStartRecord(
        'job-1',
        'pod-1',
        poolColdStartTimes(
          pod,
          node(true, 0),
          undefined,
          [90_000],
          [pulled('Container image "x" already present on machine', 1)],
        ),
        1,
        true,
      ),
    ).toThrow('Node node-a has no VM launch time');
    expect(() =>
      cpuColdStartRecord(
        'job-1',
        'pod-1',
        poolColdStartTimes(
          pod,
          node(true, 0),
          undefined,
          [],
          [pulled('Container image "x" already present on machine', 1)],
        ),
        undefined,
        true,
      ),
    ).toThrow('Job job-1 has no running event');
  });
});
