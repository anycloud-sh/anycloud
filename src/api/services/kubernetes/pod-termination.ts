import type { V1Pod } from '@kubernetes/client-node';
import type { Cause } from '../job-outcome.js';

/** What one Pod shows about how its main container instance ended. */
export interface PodEvidence {
  phase: string;
  node: string | null;
  /** `status.reason: status.message`, such as an `Evicted` Pod's. */
  podReason: { reason: string; detail: string } | null;
  /** `DisruptionTarget=True`, as `reason: message`. */
  disruption: string | null;
  /** A delete (a drain, a Node's removal or a rollout) has been asked for. */
  deleting: boolean;
  main:
    | {
        kind: 'ended';
        exitCode: number;
        oom: boolean;
        /** The kubelet has started a new instance since the claimed one. */
        restarted: boolean;
      }
    | { kind: 'running' }
    | { kind: 'absent' };
}

const said = (reason: string, message: string | null | undefined) =>
  message ? `${reason}: ${message}` : reason;

/**
 * Waiting reasons of a restart the kubelet tried and couldn't start, which
 * count as one: a teardown never shows them.
 */
const RESTART_FAILURES = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
]);

/**
 * Reads `container`'s end from one Pod. With `containerId`, only that
 * instance counts: `state.terminated` under `restartPolicy: Never`, or
 * `lastState.terminated` once an `Always` container has restarted.
 */
export function terminationEvidence(
  pod: V1Pod,
  container: string,
  containerId?: string,
): PodEvidence {
  const status = pod.status;
  const main = status?.containerStatuses?.find(
    (candidate) => candidate.name === container,
  );
  // A crash-looping container keeps its exited instance's ID on the status,
  // so lastState is read first; a terminated state without its own ID (a
  // synthesized ContainerStatusUnknown) is the status's instance.
  const current = main?.state?.terminated;
  const previous = main?.lastState?.terminated;
  const terminated =
    containerId === undefined
      ? current
      : previous?.containerID === containerId
        ? previous
        : (current?.containerID ?? main?.containerID) === containerId
          ? current
          : undefined;
  const disruption = status?.conditions?.find(
    (condition) =>
      condition.type === 'DisruptionTarget' && condition.status === 'True',
  );
  return {
    phase: status?.phase ?? 'Unknown',
    node: pod.spec?.nodeName ?? null,
    podReason: status?.reason
      ? { reason: status.reason, detail: said(status.reason, status.message) }
      : null,
    disruption: disruption
      ? said(disruption.reason ?? 'DisruptionTarget', disruption.message)
      : null,
    deleting: Boolean(pod.metadata?.deletionTimestamp),
    main: terminated
      ? {
          kind: 'ended',
          exitCode: terminated.exitCode,
          // A new instance has started; a kubelet tearing the Pod down can
          // already show the ended one in lastState with none started.
          restarted:
            (containerId !== undefined &&
              main?.containerID !== undefined &&
              main.containerID !== containerId) ||
            RESTART_FAILURES.has(main?.state?.waiting?.reason ?? ''),
          oom: terminated.reason === 'OOMKilled',
        }
      : main?.state?.running &&
          (containerId === undefined || main.containerID === containerId)
        ? { kind: 'running' }
        : { kind: 'absent' },
  };
}

/**
 * Total: every input maps to exactly one Cause, and the first matching rule
 * wins. A disruption explains whatever exit it caused, and an eviction
 * outranks the exit it forced.
 */
export function classify(evidence: PodEvidence | null): Cause {
  if (!evidence) {
    return {
      kind: 'lost',
      detail: 'its Pod was gone before its status was read',
    };
  }
  // A limit eviction says the Pod or a container "exceeds" or "exceeded" it
  // and carries no DisruptionTarget; a node-pressure eviction carries one and
  // never says that.
  if (
    evidence.podReason?.reason === 'Evicted' &&
    /exceed/.test(evidence.podReason.detail)
  ) {
    return { kind: 'evicted-storage', detail: evidence.podReason.detail };
  }
  if (evidence.disruption) {
    return { kind: 'disrupted', detail: evidence.disruption };
  }
  if (evidence.podReason?.reason === 'Evicted') {
    return { kind: 'evicted-storage', detail: evidence.podReason.detail };
  }
  const { main } = evidence;
  if (main.kind === 'ended') {
    return { kind: 'exit', code: main.exitCode, oom: main.oom };
  }
  return {
    kind: 'lost',
    detail: `no exit was recorded (phase ${evidence.phase})`,
  };
}
