import { describe, expect, it } from 'vitest';
import type { V1ContainerStatus, V1Pod } from '@kubernetes/client-node';

import type { Cause } from '../../../../src/api/services/job-outcome.js';
import {
  classify,
  terminationEvidence,
} from '../../../../src/api/services/kubernetes/pod-termination.js';

type State = Pick<V1ContainerStatus, 'state' | 'lastState' | 'containerID'>;

const exited = (exitCode: number, reason = exitCode ? 'Error' : 'Completed') =>
  ({ state: { terminated: { exitCode, reason } } }) satisfies State;

/** A Pod status in the shape K3s reports it. */
function pod(input: {
  phase?: string;
  reason?: string;
  message?: string;
  disruption?: { reason: string; message: string };
  main?: State;
}): V1Pod {
  const status = (name: string, value: State): V1ContainerStatus => ({
    name,
    image: 'image',
    imageID: 'image@sha256:0',
    ready: false,
    restartCount: 0,
    ...value,
  });
  return {
    status: {
      phase: input.phase ?? 'Failed',
      reason: input.reason,
      message: input.message,
      conditions: input.disruption
        ? [{ type: 'DisruptionTarget', status: 'True', ...input.disruption }]
        : [],
      containerStatuses: input.main ? [status('workload', input.main)] : [],
    },
  };
}

const evictionApi = {
  reason: 'EvictionByEvictionAPI',
  message: 'Eviction API: evicting',
};
const podGc = {
  reason: 'DeletionByPodGC',
  message: 'PodGC: node no longer exists',
};
const storage =
  'Pod ephemeral local storage usage exceeds the total limit of containers 1Gi.';
const nodeShutdown =
  'Pod was terminated in response to imminent node shutdown.';
const nodePressure =
  'The node was low on resource: ephemeral-storage. Threshold quantity: 1Gi, available: 512Mi.';
const kubeletEviction = (message: string) => ({
  reason: 'TerminationByKubelet',
  message,
});

// The termination cases of a spike run 36920226200, rebuilt from its
// recorded exit codes, conditions and Pod reasons. The first matching rule
// wins.
const cases: [string, V1Pod | null, Cause][] = [
  [
    'a Pod gone before its status was read',
    null,
    { kind: 'lost', detail: 'its Pod was gone before its status was read' },
  ],
  [
    'c8: an Eviction API eviction outranks the SIGTERM exit it caused',
    pod({ disruption: evictionApi, main: exited(143) }),
    {
      kind: 'disrupted',
      detail: 'EvictionByEvictionAPI: Eviction API: evicting',
    },
  ],
  [
    'n1: a Node deletion leaves no exit at all',
    pod({ disruption: podGc }),
    {
      kind: 'disrupted',
      detail: 'DeletionByPodGC: PodGC: node no longer exists',
    },
  ],
  [
    'c10: a storage eviction outranks the 137 it forced',
    pod({ reason: 'Evicted', message: storage, main: exited(137) }),
    { kind: 'evicted-storage', detail: `Evicted: ${storage}` },
  ],
  [
    // A guard: a limit eviction carries no DisruptionTarget upstream (c10),
    // but one that did is still the Job's.
    "a kubelet eviction at the Pod's own limit is the Job's, not a disruption",
    pod({
      reason: 'Evicted',
      message: storage,
      disruption: kubeletEviction(storage),
      main: exited(137),
    }),
    { kind: 'evicted-storage', detail: `Evicted: ${storage}` },
  ],
  [
    // RT9's spot pools: a graceful node shutdown keeps its reason now that
    // the runner exits 143.
    'a node shutdown is a disruption',
    pod({
      reason: 'Terminated',
      message: nodeShutdown,
      disruption: kubeletEviction(nodeShutdown),
      main: exited(143),
    }),
    { kind: 'disrupted', detail: `TerminationByKubelet: ${nodeShutdown}` },
  ],
  [
    'a node shutdown without its condition is the runner exit, which retries',
    pod({ reason: 'Terminated', message: nodeShutdown, main: exited(143) }),
    { kind: 'exit', code: 143, oom: false },
  ],
  [
    'a node-pressure eviction is a disruption',
    pod({
      reason: 'Evicted',
      message: nodePressure,
      disruption: kubeletEviction(nodePressure),
      main: exited(137),
    }),
    {
      kind: 'disrupted',
      detail: `TerminationByKubelet: ${nodePressure}`,
    },
  ],
  [
    'c1: main exits 0',
    pod({ phase: 'Succeeded', main: exited(0) }),
    { kind: 'exit', code: 0, oom: false },
  ],
  [
    'c2: main exits 3',
    pod({ main: exited(3) }),
    { kind: 'exit', code: 3, oom: false },
  ],
  [
    'c6: main ignores SIGTERM and is killed',
    pod({ main: exited(137) }),
    { kind: 'exit', code: 137, oom: false },
  ],
  [
    'main is OOMKilled',
    pod({ main: exited(137, 'OOMKilled') }),
    { kind: 'exit', code: 137, oom: true },
  ],
  [
    'main still running',
    pod({
      phase: 'Running',
      main: { state: { running: { startedAt: new Date(0) } } },
    }),
    { kind: 'lost', detail: 'no exit was recorded (phase Running)' },
  ],
];

describe('classify', () => {
  it.each(cases)('%s', (_name, input, cause) => {
    expect(classify(input && terminationEvidence(input, 'workload'))).toEqual(
      cause,
    );
  });

  describe('a restartPolicy: Always container, by claimed instance', () => {
    // One replica, restarted once after an OOM kill: instance X ended, Y runs.
    const replica = pod({
      phase: 'Running',
      main: {
        containerID: 'containerd://y',
        state: { running: { startedAt: new Date(1) } },
        lastState: {
          terminated: {
            exitCode: 137,
            reason: 'OOMKilled',
            containerID: 'containerd://x',
          },
        },
      },
    });

    it('reads the ended instance from lastState', () => {
      expect(
        classify(terminationEvidence(replica, 'workload', 'containerd://x')),
      ).toEqual({ kind: 'exit', code: 137, oom: true });
    });

    it('sees the current instance running', () => {
      expect(
        terminationEvidence(replica, 'workload', 'containerd://y').main,
      ).toEqual({ kind: 'running' });
    });

    it('reads a repeated OOM in CrashLoopBackOff, where the status keeps the exited ID', () => {
      const crashLooping = pod({
        phase: 'Running',
        main: {
          containerID: 'containerd://x',
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: {
            terminated: {
              exitCode: 137,
              reason: 'OOMKilled',
              containerID: 'containerd://x',
            },
          },
        },
      });
      expect(
        classify(
          terminationEvidence(crashLooping, 'workload', 'containerd://x'),
        ),
      ).toEqual({ kind: 'exit', code: 137, oom: true });
    });

    it('reports an instance a second restart overwrote as lost', () => {
      expect(
        classify(terminationEvidence(replica, 'workload', 'containerd://w')),
      ).toEqual({
        kind: 'lost',
        detail: 'no exit was recorded (phase Running)',
      });
    });
  });
});
