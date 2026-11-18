import type {
  CoreV1Event,
  V1ContainerStatus,
  V1Node,
  V1Pod,
} from '@kubernetes/client-node';

import { imagePullFromEvents } from '../../../../../../src/api/services/kubernetes/pod-image-pull.js';
import { KUBERNETES_DEPLOYMENT_CONTAINER } from '../../../../../../src/api/services/kubernetes/pool-objects.js';
import type { PoolColdStartTimes } from '../../contracts/gpu-cold-start.js';

/** The init container that copies the runner from the API image. */
const RUNNER_INSTALL_CONTAINER = 'runner-install';

const ms = (value: Date | string | undefined) =>
  value === undefined ? null : new Date(value).getTime();

/**
 * One container's `Pulled` events as kubelet's pull: the first event's time
 * (kubelet's clock, to the second), kubelet's own pull time and whether the
 * image was present. `imagePullFromEvents` reads a regular container's
 * events, so an init container's are matched by `fieldPath` here first.
 */
function containerPull(
  events: readonly CoreV1Event[],
  fieldPath: string,
): PoolColdStartTimes['imagePull'] {
  const matching = events
    .filter((e) => e.involvedObject.fieldPath === fieldPath)
    .map((e) => ({
      ...e,
      involvedObject: { ...e.involvedObject, fieldPath: 'spec.containers{c}' },
    }));
  const pull = imagePullFromEvents(matching, 'c');
  const at = matching
    .map((e) => ms(e.firstTimestamp ?? e.eventTime))
    .filter((value) => value !== null);
  return pull && at.length
    ? {
        atMs: Math.min(...at),
        elapsedMs: pull.elapsedMs,
        alreadyPresent: pull.alreadyPresent === true,
      }
    : null;
}

/**
 * The replica Pod's and its Node's start from their Kubernetes objects; the
 * device plugin's Pod on that Node dates a GPU Node's GPU, and the Pod's
 * `Pulled` events its image. The VM is the latest of the pool's launches
 * before the Node registered. Throws on a time the read lacks, so a
 * cold-start record is whole or absent; only the pull may be missing, since
 * Events expire.
 */
export function poolColdStartTimes(
  pod: V1Pod,
  node: V1Node,
  plugin: V1Pod | undefined,
  launchesMs: readonly number[],
  pulled: readonly CoreV1Event[] = [],
): PoolColdStartTimes {
  const name = node.metadata?.name ?? '';
  const nodeCreatedAtMs = ms(node.metadata?.creationTimestamp);
  const condition = (
    conditions: readonly { type: string; lastTransitionTime?: Date }[] = [],
    type: string,
  ) => ms(conditions.find((c) => c.type === type)?.lastTransitionTime);
  const startedAt = (
    statuses: readonly V1ContainerStatus[] | undefined,
    container?: string,
  ) =>
    ms(
      statuses?.find((c) => !container || c.name === container)?.state?.running
        ?.startedAt,
    );
  const gpuNode = Number(node.status?.capacity?.['nvidia.com/gpu'] ?? 0) > 0;
  const times = {
    nodeCreatedAtMs,
    nodeReadyAtMs: condition(node.status?.conditions, 'Ready'),
    ...(gpuNode
      ? { gpuPluginStartedAtMs: startedAt(plugin?.status?.containerStatuses) }
      : {}),
    podScheduledAtMs: condition(pod.status?.conditions, 'PodScheduled'),
    containerStartedAtMs: startedAt(
      pod.status?.containerStatuses,
      KUBERNETES_DEPLOYMENT_CONTAINER,
    ),
  };
  const missing = Object.entries(times).filter(([, value]) => value === null);
  if (missing.length) {
    throw new Error(
      `Node ${name} and Pod ${pod.metadata?.uid ?? ''} have no ${missing.map(([key]) => key).join(', ')}`,
    );
  }
  const launched = launchesMs.filter((at) => at <= nodeCreatedAtMs!);
  return {
    node: name,
    vmLaunchedAtMs: launched.length ? Math.max(...launched) : null,
    gpuPluginStartedAtMs: null,
    ...(times as { [K in keyof typeof times]: number }),
    imagePull: containerPull(
      pulled,
      `spec.containers{${KUBERNETES_DEPLOYMENT_CONTAINER}}`,
    ),
    runnerImagePull: containerPull(
      pulled,
      `spec.initContainers{${RUNNER_INSTALL_CONTAINER}}`,
    ),
  };
}
