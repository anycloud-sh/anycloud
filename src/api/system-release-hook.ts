import { AppsV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../shared/log-diagnostics.js';
import {
  assessReleaseGuard,
  assessReleaseReadiness,
  type ExpectedRelease,
  type ObservedApiPod,
} from './services/system-release/release-readiness.js';

/**
 * Helm hook entrypoint for the API system release. Runs inside the API image
 * under the chart's delegated hook ServiceAccounts.
 *
 * `guard` (pre-upgrade, always rendered) refuses an incoming revision that is
 * not newer than the running Deployment's, so the cluster cannot be rolled back
 * from inside the cluster. `ready` (post-install/post-upgrade) decides
 * completion: the Pod for the requested revision/operation runs the pinned
 * image digest, is Ready, and serves the expected version through its real
 * endpoint.
 */
const READY_DEADLINE_MS = 540_000;
const READY_POLL_MS = 3_000;
const HTTP_TIMEOUT_MS = 5_000;

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function expectedRelease(): ExpectedRelease {
  const revision = Number(
    required(
      'ANYCLOUD_RELEASE_REVISION',
      process.env.ANYCLOUD_RELEASE_REVISION,
    ),
  );
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('ANYCLOUD_RELEASE_REVISION must be a positive integer');
  }
  return {
    revision,
    operationId: required(
      'ANYCLOUD_RELEASE_OPERATION',
      process.env.ANYCLOUD_RELEASE_OPERATION,
    ),
    image: required(
      'ANYCLOUD_RELEASE_IMAGE',
      process.env.ANYCLOUD_RELEASE_IMAGE,
    ),
    version: required(
      'ANYCLOUD_RELEASE_VERSION',
      process.env.ANYCLOUD_RELEASE_VERSION,
    ),
  };
}

async function observePods(
  core: CoreV1Api,
  namespace: string,
): Promise<ObservedApiPod[]> {
  const list = await core.listNamespacedPod({
    namespace,
    labelSelector: 'app.kubernetes.io/name=anycloud-api',
  });
  return list.items.map((pod) => ({
    name: pod.metadata?.name ?? '',
    podIp: pod.status?.podIP ?? null,
    ready:
      pod.status?.phase === 'Running' &&
      (pod.status.conditions ?? []).some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
    annotations: pod.metadata?.annotations ?? {},
    imageIds: (pod.status?.containerStatuses ?? []).map(
      (status) => status.imageID,
    ),
  }));
}

async function observeEndpoint(
  podIp: string,
  port: string,
): Promise<{ healthy: boolean; servedVersion: string | null }> {
  const origin = `http://${podIp}:${port}`;
  try {
    const health = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!health.ok) return { healthy: false, servedVersion: null };
    const version = await fetch(`${origin}/v1/version`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!version.ok) return { healthy: true, servedVersion: null };
    const body = (await version.json()) as { version?: unknown };
    return {
      healthy: true,
      servedVersion: typeof body.version === 'string' ? body.version : null,
    };
  } catch {
    return { healthy: false, servedVersion: null };
  }
}

async function ready(): Promise<void> {
  const expected = expectedRelease();
  const namespace = required(
    'ANYCLOUD_RELEASE_NAMESPACE',
    process.env.ANYCLOUD_RELEASE_NAMESPACE,
  );
  const port = required('ANYCLOUD_API_PORT', process.env.ANYCLOUD_API_PORT);
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromCluster();
  const core = kubeConfig.makeApiClient(CoreV1Api);
  const deadline = Date.now() + READY_DEADLINE_MS;
  let lastReason = 'not observed';
  while (Date.now() < deadline) {
    const pods = await observePods(core, namespace);
    const candidate = pods.find(
      (pod) =>
        pod.annotations['anycloud.sh/release-operation'] ===
        expected.operationId,
    );
    const endpoint =
      candidate?.podIp && candidate.ready
        ? await observeEndpoint(candidate.podIp, port)
        : null;
    const readiness = assessReleaseReadiness(pods, expected, endpoint);
    if (readiness.ready) {
      console.log(
        JSON.stringify({
          hook: 'ready',
          outcome: 'complete',
          pod: readiness.pod,
          revision: expected.revision,
          operation: expected.operationId,
        }),
      );
      return;
    }
    lastReason = readiness.reason;
    await delay(READY_POLL_MS);
  }
  throw new Error(`Release did not reach its requested target: ${lastReason}`);
}

async function guard(): Promise<void> {
  const expected = expectedRelease();
  const namespace = required(
    'ANYCLOUD_RELEASE_NAMESPACE',
    process.env.ANYCLOUD_RELEASE_NAMESPACE,
  );
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromCluster();
  const apps = kubeConfig.makeApiClient(AppsV1Api);
  let annotations: Record<string, string> | null;
  try {
    const deployment = await apps.readNamespacedDeployment({
      name: 'anycloud-api',
      namespace,
    });
    annotations = deployment.metadata?.annotations ?? {};
  } catch (error) {
    if ((error as { code?: number }).code === 404) annotations = null;
    else throw error;
  }
  const verdict = assessReleaseGuard(annotations, expected);
  if (!verdict.allowed) {
    throw new Error(`Refusing release: ${verdict.reason}`);
  }
  console.log(
    JSON.stringify({
      hook: 'guard',
      outcome: 'allowed',
      revision: expected.revision,
      operation: expected.operationId,
    }),
  );
}

async function main(step: string | undefined): Promise<void> {
  switch (step) {
    case 'guard':
      await guard();
      return;
    case 'ready':
      await ready();
      return;
    case undefined:
    default:
      throw new Error(`Unknown system release hook step: ${step ?? '(none)'}`);
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
