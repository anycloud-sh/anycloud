import {
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
} from '../../../shared/system-release.js';

/**
 * Completion of a system release is decided from native observations plus the
 * real endpoint, never from a successful Helm process alone: the bundled Helm
 * invocation has no `--wait`.
 */
export interface ObservedApiPod {
  name: string;
  podIp: string | null;
  ready: boolean;
  annotations: Record<string, string>;
  /** Container image IDs as reported by the runtime (`...@sha256:...`). */
  imageIds: string[];
}

export interface ExpectedRelease {
  revision: number;
  operationId: string;
  image: string;
  version: string;
}

export interface ObservedEndpoint {
  healthy: boolean;
  servedVersion: string | null;
}

type ReleaseReadiness =
  | { ready: true; pod: string }
  | { ready: false; reason: string };

export type ReleaseGuard =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * In-cluster monotonicity: the pre-upgrade guard compares the incoming
 * revision with the one the running Deployment carries. Only a strictly newer
 * revision, or a replay of the same revision and operation, may proceed.
 */
export function assessReleaseGuard(
  currentAnnotations: Record<string, string> | null,
  expected: Pick<ExpectedRelease, 'revision' | 'operationId'>,
): ReleaseGuard {
  if (!currentAnnotations) return { allowed: true };
  const current = currentAnnotations[RELEASE_REVISION_ANNOTATION];
  if (current === undefined) {
    return {
      allowed: false,
      reason: 'running release carries no AnyCloud revision',
    };
  }
  const currentRevision = Number(current);
  if (!Number.isSafeInteger(currentRevision)) {
    return {
      allowed: false,
      reason: `running release revision ${current} is not a number`,
    };
  }
  if (currentRevision > expected.revision) {
    return {
      allowed: false,
      reason: `running release revision ${currentRevision} is newer than incoming ${expected.revision}`,
    };
  }
  if (
    currentRevision === expected.revision &&
    currentAnnotations[RELEASE_OPERATION_ANNOTATION] !== expected.operationId
  ) {
    return {
      allowed: false,
      reason: `running release revision ${currentRevision} was applied by a different operation`,
    };
  }
  return { allowed: true };
}

function digestOf(reference: string): string | null {
  const at = reference.lastIndexOf('@');
  return at === -1 ? null : reference.slice(at + 1);
}

/** Select the one Pod that belongs to the requested operation, if any. */
function selectReleasePod(
  pods: readonly ObservedApiPod[],
  expected: ExpectedRelease,
): ObservedApiPod | null {
  return (
    pods.find(
      (pod) =>
        pod.annotations[RELEASE_REVISION_ANNOTATION] ===
          String(expected.revision) &&
        pod.annotations[RELEASE_OPERATION_ANNOTATION] === expected.operationId,
    ) ?? null
  );
}

export function assessReleaseReadiness(
  pods: readonly ObservedApiPod[],
  expected: ExpectedRelease,
  endpoint: ObservedEndpoint | null,
): ReleaseReadiness {
  const pod = selectReleasePod(pods, expected);
  if (!pod) {
    return {
      ready: false,
      reason: `no API Pod carries revision ${expected.revision} operation ${expected.operationId}`,
    };
  }
  const expectedDigest = digestOf(expected.image);
  if (!expectedDigest) {
    return { ready: false, reason: 'expected image is not digest-pinned' };
  }
  if (!pod.imageIds.some((id) => digestOf(id) === expectedDigest)) {
    return {
      ready: false,
      reason: `Pod ${pod.name} does not run image digest ${expectedDigest}`,
    };
  }
  if (!pod.ready || !pod.podIp) {
    return { ready: false, reason: `Pod ${pod.name} is not ready` };
  }
  if (!endpoint?.healthy) {
    return { ready: false, reason: `Pod ${pod.name} did not answer /health` };
  }
  if (endpoint.servedVersion !== expected.version) {
    return {
      ready: false,
      reason: `Pod ${pod.name} serves version ${endpoint.servedVersion ?? 'unknown'}, expected ${expected.version}`,
    };
  }
  return { ready: true, pod: pod.name };
}
