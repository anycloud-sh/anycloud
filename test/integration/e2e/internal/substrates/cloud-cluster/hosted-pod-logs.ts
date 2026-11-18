import type {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from '@kubernetes/client-node';
import sodium from 'libsodium-wrappers';
import {
  kubeConfigFromClusterConnection,
  parseClusterConnection,
} from '../../../../../../src/api/services/kubernetes/cluster-connection.js';
import { API_INGRESS_RELEASE } from '../../../../../../src/shared/api-ingress.js';
import { SYSTEM_RELEASE_NAMESPACE } from '../../../../../../src/shared/system-release.js';
import { errorMessage } from '../../types.js';

const KUBE_SYSTEM = 'kube-system';

/**
 * The hosted API's Pods and its own Traefik release's: the API process and
 * the ingress in front of it; and, in kube-system, only the `helm-install-*`
 * Pods of K3s's helm-controller (the ingress chart's), whose log is helm's own.
 * Its other Pods run on pool nodes too, whose kubelet may be gone.
 */
export const HOSTED_LOG_NAMESPACES = [
  SYSTEM_RELEASE_NAMESPACE,
  API_INGRESS_RELEASE,
  KUBE_SYSTEM,
] as const;

/** In kube-system, only helm-controller's install Pods. */
const logged = (namespace: string, pod: string) =>
  namespace !== KUBE_SYSTEM || pod.startsWith('helm-install-');

/**
 * Where the HelmChart objects and their `helm-install-*` Jobs live: the API's
 * release in its own namespace, its ingress in kube-system.
 */
const HELM_NAMESPACES = [SYSTEM_RELEASE_NAMESPACE, KUBE_SYSTEM] as const;

/**
 * How the cluster's Helm releases stand, per namespace in `HELM_NAMESPACES`:
 * its Jobs (helm-controller's `helm-install-*`), status and conditions; the
 * HelmChart objects' specs and status; and Helm's release Secrets by name and
 * labels alone (name, owner, status, version: whether a revision reached
 * `deployed`), never their data. helm-controller itself runs inside the K3s
 * server, so its log is the host's journal, which this connection cannot
 * read. Each read reports its own failure (a refused right included), so the
 * record never throws.
 */
export async function readHelmState(
  core: Pick<CoreV1Api, 'listNamespacedSecret'>,
  batch: Pick<BatchV1Api, 'listNamespacedJob'>,
  custom: Pick<CustomObjectsApi, 'listNamespacedCustomObject'>,
): Promise<unknown> {
  const read = async <T>(request: () => Promise<T>) => {
    try {
      return await request();
    } catch (error) {
      return { unavailable: errorMessage(error) };
    }
  };
  return Promise.all(
    HELM_NAMESPACES.map(async (namespace) => {
      const [jobs, helmCharts, releases] = await Promise.all([
        read(async () =>
          (await batch.listNamespacedJob({ namespace })).items.map((job) => ({
            name: job.metadata?.name,
            labels: job.metadata?.labels,
            status: job.status,
          })),
        ),
        read(async () => {
          const list = (await custom.listNamespacedCustomObject({
            group: 'helm.cattle.io',
            version: 'v1',
            namespace,
            plural: 'helmcharts',
          })) as {
            items?: {
              metadata?: { name?: string; generation?: number };
              spec?: Record<string, unknown>;
              status?: unknown;
            }[];
          };
          // The spec without its values: they are the release's, read elsewhere.
          return (list.items ?? []).map(({ metadata, spec, status }) => {
            const { valuesContent: _values, set: _set, ...rest } = spec ?? {};
            return {
              name: metadata?.name,
              generation: metadata?.generation,
              spec: rest,
              status,
            };
          });
        }),
        read(async () =>
          (
            await core.listNamespacedSecret({
              namespace,
              fieldSelector: 'type=helm.sh/release.v1',
            })
          ).items.map((secret) => ({
            name: secret.metadata?.name,
            labels: secret.metadata?.labels,
          })),
        ),
      ]);
      return { namespace, jobs, helmCharts, releases };
    }),
  );
}

const TAIL_LINES = 500;

type PodLogReader = Pick<
  CoreV1Api,
  'listNamespacedPod' | 'readNamespacedPodLog'
>;

/** `read`, or why it gave no answer within `ms`; it never runs past the deadline. */
export async function withinDeadline<T>(
  read: Promise<T>,
  ms: number,
): Promise<T | { unavailable: string }> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<{ unavailable: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ unavailable: `timed out after ${ms / 1000} s` }),
      ms,
    );
  });
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The installer's stored connection, opened with its cipher key (secret-crypto's secretbox). */
async function openConnection(
  encrypted: string,
  cipherKey: string,
): Promise<string> {
  await sodium.ready;
  const combined = new Uint8Array(Buffer.from(encrypted, 'base64'));
  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.crypto_secretbox_open_easy(
    combined.slice(sodium.crypto_secretbox_NONCEBYTES),
    nonce,
    sodium.from_hex(cipherKey.trim()),
  );
  return sodium.to_string(plaintext);
}

/** The cluster connection the installer holds, as a kubeconfig. */
export async function hostedKubeConfig(
  encryptedConnection: string,
  cipherKey: string,
): Promise<KubeConfig> {
  return kubeConfigFromClusterConnection(
    parseClusterConnection(
      await openConnection(encryptedConnection, cipherKey),
    ),
  );
}

/**
 * Each container's log, current and previous, for the Pods in
 * `HOSTED_LOG_NAMESPACES`. Every read is independent and reports its own
 * failure, so the record never throws.
 */
export async function readHostedPodLogs(core: PodLogReader): Promise<unknown> {
  const read = async (request: () => Promise<string>) => {
    try {
      return await request();
    } catch (error) {
      return { unavailable: errorMessage(error) };
    }
  };
  return Promise.all(
    HOSTED_LOG_NAMESPACES.map(async (namespace) => {
      let pods;
      try {
        ({ items: pods } = await core.listNamespacedPod({ namespace }));
      } catch (error) {
        return { namespace, unavailable: errorMessage(error) };
      }
      return {
        namespace,
        pods: await Promise.all(
          pods
            .filter((pod) => logged(namespace, pod.metadata?.name ?? ''))
            .map(async (pod) => ({
              name: pod.metadata?.name,
              phase: pod.status?.phase,
              containers: await Promise.all(
                (pod.status?.containerStatuses ?? []).map(async (container) => {
                  const [current, previous] = await Promise.all(
                    [false, true].map((previous) =>
                      read(() =>
                        core.readNamespacedPodLog({
                          namespace,
                          name: pod.metadata!.name!,
                          container: container.name,
                          previous,
                          tailLines: TAIL_LINES,
                        }),
                      ),
                    ),
                  );
                  return {
                    name: container.name,
                    restartCount: container.restartCount,
                    state: container.state,
                    lastState: container.lastState,
                    current,
                    previous,
                  };
                }),
              ),
            })),
        ),
      };
    }),
  );
}
