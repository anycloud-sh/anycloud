import {
  setHeaderOptions,
  type CoreV1Api,
  type V1Container,
  type V1Deployment as KubernetesDeployment,
  type V1Pod,
  type V1PodTemplateSpec,
  type V1Secret,
} from '@kubernetes/client-node';
import type { KubernetesWorkloadIdentity } from './identity.js';
import {
  isKubernetesConflictError,
  isKubernetesNotFoundError,
} from './managed-resources.js';
import { parseNodeCache } from '../../../shared/docker-options.js';
import {
  applyNodePoolScheduling,
  assertNodePoolScheduling,
  type NodePoolCapabilityConstraint,
} from './node-pool-scheduling.js';
import {
  buildKubernetesPodParts,
  type KubernetesPodPartsRequest,
} from './pod-parts.js';
import { KVM_RESOURCE } from './user-namespace.js';

/** The one container of every anycloud workload Pod. */
export const KUBERNETES_DEPLOYMENT_CONTAINER = 'workload';

/** Holds a deleted Pod until its owner has recorded what it shows. */
export const ANYCLOUD_POD_FINALIZER = 'anycloud.sh/outcome';

/** The audience of a replica's projected claim-queue token. */
export const ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE = 'anycloud-runtime';

const RUNTIME_IDENTITY_VOLUME = 'anycloud-runtime-identity';
const RUNTIME_IDENTITY_DIRECTORY = '/var/run/secrets/anycloud';

/** Where the API image keeps the runner, rclone and tini, and the replica mounts them. */
const RUNNER_DIRECTORY = '/opt/anycloud-runner';
/** The runner's copy of the image's working directory, which each reset restores. */
const WORKDIR_COPY = '/opt/anycloud-workdir';
/**
 * The Node's cache directory, which the join makes and which outlives its
 * Pods: a pool Job's `--cache` mounts a directory in it (RFC 0049 C12).
 */
export const NODE_CACHE_DIR = '/var/lib/anycloud/node-cache';
/** VM Jobs' fixed paths, each an emptyDir in a runner replica. */
const RUNNER_PATHS = ['input', 'output', 'checkpoint'] as const;

/**
 * Everything one anycloud workload Pod is rendered from, as plain values; no
 * product record reaches the substrate. Each option is off when omitted and
 * lands with the first owner that uses it (RFC 0044, owner decision 14).
 */
export interface PodTemplateSpec {
  namespace: string;
  identity: KubernetesWorkloadIdentity;
  /** Names the workload in option-validation errors. */
  workloadName: string;
  request: KubernetesPodPartsRequest;
  /** Container arguments, unmodified. */
  command: string[] | null;
  extraEnv?: Record<string, string>;
  clusterId: string;
  nodePoolId: string;
  capability: NodePoolCapabilityConstraint;
  /** Ports and probes the owner adds to the container. */
  container?: Pick<V1Container, 'ports' | 'startupProbe' | 'readinessProbe'>;
  /** Application env in one owned Secret, under every explicit `env` entry. */
  envSecret?: { name: string; values: Record<string, string> };
  /** A projected token for this audience, under the named ServiceAccount. */
  runtimeIdentity?: { serviceAccountName: string; audience: string };
  /** Placement hints added to the pool's own node selector. */
  nodeSelector?: Record<string, string>;
  /** `terminationGracePeriodSeconds`, which the runner splits. */
  gracePeriodSeconds?: number;
  /** Hold the Pod with `ANYCLOUD_POD_FINALIZER` until its owner releases it. */
  finalizer?: boolean;
  /**
   * Make the runner the entrypoint, under tini as PID 1 (RFC 0044 decision
   * 26): `runner-install` copies both and rclone from the API image, and
   * the image's Entrypoint goes to the runner, which starts each claimed
   * Job's command after it. `command` is then unused.
   */
  runner?: { installImage: string; entrypoint: string[]; cmd: string[] };
  /**
   * K6 and K9: `RuntimeDefault` seccomp and no privilege escalation on a
   * container neither privileged nor in a user namespace, and these resources under what
   * `--cpus` and `--memory` set, so the Pod isn't BestEffort.
   */
  hardening?: {
    requests: { cpu: string; memory: string; 'ephemeral-storage'?: string };
    limits?: {
      memory?: string;
      'ephemeral-storage'?: string;
      /** `/dev/kvm` for a user-namespace replica (RFC 0049 C32). */
      [KVM_RESOURCE]?: string;
    };
  };
}

/** The one Pod template for every owner of a pool workload Pod. */
export function podTemplate(spec: PodTemplateSpec): {
  template: V1PodTemplateSpec;
  secrets: V1Secret[];
} {
  const { identity, runtimeIdentity, envSecret, runner } = spec;
  if (runner && !runtimeIdentity) {
    throw new Error('The runner needs a runtime identity to claim Jobs');
  }
  if (runner && spec.gracePeriodSeconds === undefined) {
    throw new Error('The runner needs the grace it splits with the upload');
  }
  // RFC 0049 C12: each cache is a Node directory shared by the pool's Jobs.
  const caches = (spec.request.dockerOptions?.caches ?? []).map((cache) => {
    const { name, target } = parseNodeCache(cache)!;
    return { name, target, volume: `cache-${name}` };
  });
  if (caches.length > 0 && !runner) {
    throw new Error('Only a runner replica mounts Node caches');
  }
  const parts = buildKubernetesPodParts({
    namespace: spec.namespace,
    identity,
    workloadName: spec.workloadName,
    request: spec.request,
    extraEnv: {
      ...spec.extraEnv,
      ...(runtimeIdentity
        ? {
            ANYCLOUD_WORKLOAD_TOKEN_FILE: `${RUNTIME_IDENTITY_DIRECTORY}/token`,
          }
        : {}),
      ...(runner
        ? {
            ANYCLOUD_RUNNER_ENTRYPOINT: JSON.stringify(runner.entrypoint),
            ANYCLOUD_RUNNER_CMD: JSON.stringify(runner.cmd),
            ANYCLOUD_RUNNER_WORKDIR_COPY: WORKDIR_COPY,
            ANYCLOUD_RUNNER_GRACE_SECONDS: String(spec.gracePeriodSeconds),
            ...(caches.length > 0 && {
              ANYCLOUD_RUNNER_CACHES: JSON.stringify(
                caches.map(({ target }) => target),
              ),
            }),
            // The runner delegates the replica's cgroup before its first claim.
            ...(spec.request.dockerOptions?.userNamespace && {
              ANYCLOUD_RUNNER_USER_NAMESPACE: '1',
            }),
          }
        : {}),
    },
  });
  const secrets = [...parts.secrets];
  if (envSecret) {
    secrets.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: envSecret.name,
        namespace: spec.namespace,
        labels: identity.labels,
        annotations: identity.annotations,
      },
      type: 'Opaque',
      stringData: envSecret.values,
    });
  }
  const runnerMounts = runner
    ? [
        {
          name: 'anycloud-runner',
          mountPath: RUNNER_DIRECTORY,
          readOnly: true,
        },
        { name: 'anycloud-workdir', mountPath: WORKDIR_COPY },
        ...RUNNER_PATHS.map((path) => ({
          name: `anycloud-${path}`,
          mountPath: `/mnt/${path}`,
        })),
        ...caches.map(({ volume, target }) => ({
          name: volume,
          mountPath: target,
        })),
      ]
    : [];
  const volumeMounts = runtimeIdentity
    ? [
        ...(parts.containerBase.volumeMounts ?? []),
        {
          name: RUNTIME_IDENTITY_VOLUME,
          mountPath: RUNTIME_IDENTITY_DIRECTORY,
          readOnly: true,
        },
        ...runnerMounts,
      ]
    : parts.containerBase.volumeMounts;
  const volumes = runtimeIdentity
    ? [
        ...(parts.volumes ?? []),
        ...(runner
          ? ['runner', 'workdir', ...RUNNER_PATHS].map((path) => ({
              name: `anycloud-${path}`,
              emptyDir: {},
            }))
          : []),
        ...caches.map(({ volume, name }) => ({
          name: volume,
          hostPath: {
            path: `${NODE_CACHE_DIR}/${spec.nodePoolId}/${name}`,
            type: 'DirectoryOrCreate',
          },
        })),
        {
          name: RUNTIME_IDENTITY_VOLUME,
          projected: {
            sources: [
              {
                serviceAccountToken: {
                  audience: runtimeIdentity.audience,
                  expirationSeconds: 3600,
                  path: 'token',
                },
              },
            ],
          },
        },
      ]
    : parts.volumes;
  // The Pod lands only on the pool's Nodes: outbound-connected, node-local
  // DNS (`dnsPolicy: Default` from the parts), never on the management Node
  // or a sibling pool.
  const { securityContext } = parts.containerBase;
  const hardening = spec.hardening;
  const resources = hardening
    ? {
        requests: {
          ...hardening.requests,
          ...parts.containerBase.resources?.requests,
        },
        ...(hardening.limits || parts.containerBase.resources?.limits
          ? {
              limits: {
                ...hardening.limits,
                ...parts.containerBase.resources?.limits,
              },
            }
          : {}),
      }
    : parts.containerBase.resources;
  const podSpec = applyNodePoolScheduling(
    {
      serviceAccountName: runtimeIdentity?.serviceAccountName,
      automountServiceAccountToken: false,
      ...parts.podSpecDefaults,
      restartPolicy: 'Always',
      terminationGracePeriodSeconds: spec.gracePeriodSeconds,
      imagePullSecrets: parts.imagePullSecrets,
      initContainers: runner
        ? [
            {
              name: 'runner-install',
              image: runner.installImage,
              // Kubelet makes a new cache root-owned 0755; any image user
              // writes it, as `/tmp`.
              command: [
                'sh',
                '-c',
                [
                  `cp ${RUNNER_DIRECTORY}/* /install/`,
                  ...caches.map(({ name }) => `chmod 1777 /caches/${name}`),
                ].join(' && '),
              ],
              // C30: the main container's resources, so a Pod with equal
              // requests and limits is Guaranteed. An init container's
              // request counts only as a maximum with the main container's,
              // so the Pod requests no more.
              resources,
              volumeMounts: [
                { name: 'anycloud-runner', mountPath: '/install' },
                ...caches.map(({ volume, name }) => ({
                  name: volume,
                  mountPath: `/caches/${name}`,
                })),
              ],
            },
          ]
        : undefined,
      containers: [
        {
          name: KUBERNETES_DEPLOYMENT_CONTAINER,
          ...parts.containerBase,
          ...(runner
            ? {
                command: [
                  `${RUNNER_DIRECTORY}/tini`,
                  '--',
                  `${RUNNER_DIRECTORY}/anycloud-runner`,
                ],
              }
            : { args: spec.command ?? undefined }),
          ...(envSecret
            ? { envFrom: [{ secretRef: { name: envSecret.name } }] }
            : {}),
          ...spec.container,
          volumeMounts,
          ...(hardening
            ? {
                resources,
                securityContext:
                  spec.request.dockerOptions?.userNamespace ||
                  securityContext?.privileged
                    ? securityContext
                    : {
                        ...securityContext,
                        allowPrivilegeEscalation: false,
                        seccompProfile: { type: 'RuntimeDefault' },
                      },
              }
            : {}),
        },
      ],
      volumes,
    },
    spec.clusterId,
    spec.nodePoolId,
  );
  if (spec.nodeSelector) {
    podSpec.nodeSelector = { ...podSpec.nodeSelector, ...spec.nodeSelector };
  }
  // A GPU pool's Pod requests whole devices under the NVIDIA runtime class
  // and a CPU pool's none. Admission refuses the mismatch first; this keeps
  // every rendered template validator-compliant.
  assertNodePoolScheduling(
    podSpec,
    spec.clusterId,
    spec.nodePoolId,
    spec.capability,
  );
  const metadata = spec.finalizer
    ? { ...parts.metadata, finalizers: [ANYCLOUD_POD_FINALIZER] }
    : parts.metadata;
  return { template: { metadata, spec: podSpec }, secrets };
}

/**
 * Remove the anycloud finalizer from one Pod by JSON patch, guarded by
 * `test` on its UID and the entry, so a same-name successor or a concurrent
 * edit is never changed. A Pod already gone or changed is left to its next
 * watch event.
 */
export async function releasePodFinalizer(
  core: Pick<CoreV1Api, 'patchNamespacedPod'>,
  pod: V1Pod,
): Promise<void> {
  const index = pod.metadata?.finalizers?.indexOf(ANYCLOUD_POD_FINALIZER);
  if (index === undefined || index < 0) return;
  const path = `/metadata/finalizers/${index}`;
  try {
    await core.patchNamespacedPod(
      {
        namespace: pod.metadata!.namespace!,
        name: pod.metadata!.name!,
        body: [
          { op: 'test', path: '/metadata/uid', value: pod.metadata!.uid },
          { op: 'test', path, value: ANYCLOUD_POD_FINALIZER },
          { op: 'remove', path },
        ],
      },
      setHeaderOptions('Content-Type', 'application/json-patch+json'),
    );
  } catch (error) {
    // 422: a `test` failed, as when the entry moved or the UID changed.
    if (
      !isKubernetesNotFoundError(error) &&
      !isKubernetesConflictError(error) &&
      (error as { code?: number }).code !== 422
    ) {
      throw error;
    }
  }
}

/** The one-replica `Recreate` native Kubernetes Deployment over a template. */
export function renderDeployment(spec: {
  name: string;
  namespace: string;
  identity: Pick<KubernetesWorkloadIdentity, 'labels' | 'annotations'>;
  template: V1PodTemplateSpec;
  minReadySeconds?: number;
  /** Replica Pods; one when omitted. */
  replicas?: number;
}): KubernetesDeployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: spec.identity.labels,
      annotations: spec.identity.annotations,
    },
    spec: {
      replicas: spec.replicas ?? 1,
      // K1: an old ReplicaSet would keep a rotated value.
      revisionHistoryLimit: 1,
      strategy: { type: 'Recreate' },
      minReadySeconds: spec.minReadySeconds,
      selector: { matchLabels: spec.identity.labels },
      template: spec.template,
    },
  };
}

export const DELETION_COST = 'controller.kubernetes.io/pod-deletion-cost';
/** The lowest cost, so the ReplicaSet removes a draining replica first. */
export const DRAINING_COST = String(-(2 ** 31));

export const isPodReady = (pod: V1Pod) =>
  !!pod.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );

/** The newest Pod, by creation time and then name. */
export function latestPod(pods: V1Pod[]): V1Pod | undefined {
  return [...pods].sort(
    (left, right) =>
      (right.metadata?.creationTimestamp?.getTime() ?? 0) -
        (left.metadata?.creationTimestamp?.getTime() ?? 0) ||
      (left.metadata?.name ?? '').localeCompare(right.metadata?.name ?? ''),
  )[0];
}

/** Why the newest Pod hasn't started: a container's waiting reason, or why it isn't scheduled. */
export function podPendingReason(pod: V1Pod | undefined): string | null {
  if (!pod) return null;
  for (const status of pod.status?.containerStatuses ?? []) {
    const waiting = status.state?.waiting;
    if (waiting?.reason) {
      return waiting.message
        ? `${waiting.reason}: ${waiting.message}`
        : waiting.reason;
    }
  }
  const scheduled = pod.status?.conditions?.find(
    (condition) =>
      condition.type === 'PodScheduled' && condition.status !== 'True',
  );
  return scheduled?.message ?? scheduled?.reason ?? null;
}
