import type { CoreV1Event, V1Pod } from '@kubernetes/client-node';
import type { ImagePullTelemetry } from '../../../shared/image.js';
import { log } from '../logger.js';
import type { ClusterKubernetesClient } from './cluster-client.js';
import { kubernetesRequestOptions } from './request-options.js';

/** A claim waits at most this long for the replica's Pod's events. */
export const POD_EVENTS_TIMEOUT_MS = 2000;

const GO_DURATION_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
};

const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
/** The pull's time leads kubelet's message; what follows varies by version. */
const PULLED_IN =
  /^Successfully pulled image ".*" in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/;

/** Milliseconds of kubelet's Go duration, such as `1m2.345s`. */
function goDurationMs(value: string): number {
  return Math.round(
    [...value.matchAll(GO_DURATION_PART)].reduce(
      (sum, [, amount, unit]) =>
        sum + Number(amount) * GO_DURATION_UNIT_MS[unit!]!,
      0,
    ),
  );
}

/**
 * The container's image pull from kubelet's `Pulled` events: `Successfully
 * pulled image "…" in 41.2s…` gives the pull's time (since Kubernetes 1.28
 * without its wait in kubelet's pull queue), and `Container image "…"
 * already present on machine…` that the Node had it. A pull wins over a
 * restart's later already-present event. A message in no known form records
 * nothing.
 */
export function imagePullFromEvents(
  events: readonly CoreV1Event[],
  container: string,
): ImagePullTelemetry | undefined {
  const messages = events
    .filter(
      (e) => e.involvedObject.fieldPath === `spec.containers{${container}}`,
    )
    .map((e) => e.message ?? '');
  const elapsedMs = messages
    .map((m) => PULLED_IN.exec(m)?.[1])
    .map((d) => (d ? goDurationMs(d) : undefined))
    .find((ms) => ms !== undefined);
  const alreadyPresent =
    elapsedMs === undefined &&
    messages.some((m) => m.includes('already present on machine'));
  if (elapsedMs === undefined && !alreadyPresent) return undefined;
  return {
    schemaVersion: 1,
    method: 'kubelet',
    outcome: 'succeeded',
    elapsedMs: elapsedMs ?? 0,
    ...(alreadyPresent ? { alreadyPresent } : {}),
  };
}

/**
 * A replica's image pull, read from its Pod's events. Events are best-effort
 * and expire (an hour by default), so a pull may record none; telemetry never
 * fails or holds up the caller past `POD_EVENTS_TIMEOUT_MS`.
 */
export async function podImagePull(
  cluster: Pick<ClusterKubernetesClient, 'core'>,
  pod: V1Pod,
  container: string,
  signal?: AbortSignal,
): Promise<ImagePullTelemetry | undefined> {
  try {
    const { items } = await cluster.core.listNamespacedEvent(
      {
        namespace: pod.metadata!.namespace!,
        fieldSelector: `involvedObject.uid=${pod.metadata!.uid!},reason=Pulled`,
      },
      kubernetesRequestOptions(
        AbortSignal.any([
          AbortSignal.timeout(POD_EVENTS_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      ),
    );
    return imagePullFromEvents(items, container);
  } catch (error) {
    log.warn('Failed to read a replica Pod image pull', {
      pod: pod.metadata?.name,
      error,
    });
    return undefined;
  }
}
