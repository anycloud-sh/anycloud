import type {
  V1Container,
  V1EnvVar,
  V1LocalObjectReference,
  V1ObjectMeta,
  V1PodSpec,
  V1Secret,
  V1Volume,
} from '@kubernetes/client-node';
import { type DockerOptions } from '../../../shared/runtime.js';
import { parseDockerVolumeBind } from '../../../shared/docker-volume.js';
import { resolveWorkloadImage } from '../container-image.js';
import { GHCR_TOKEN_USERNAME } from '../../../shared/image.js';
import type { KubernetesWorkloadIdentity } from './identity.js';
import {
  normalizeKubernetesCpus,
  normalizeKubernetesMemory,
  normalizeKubernetesShmSize,
  resolveKubernetesRuntimeClass,
  validateKubernetesDockerOptions,
} from './pod-options.js';

const KUBERNETES_SHM_VOLUME = 'dev-shm';

/**
 * RFC 0049 C32's measured minimum for container engines and nested clusters
 * in a user namespace (run A″): every capability, each namespaced to
 * the Pod's own user namespace; Unconfined seccomp, as `RuntimeDefault`
 * blocks the session keyring every runc container joins; Unconfined
 * AppArmor, as `RuntimeDefault` denies overlay's mounts; and an unmasked
 * `/proc` for the engine's network setup. The API server refuses
 * `allowPrivilegeEscalation: false` with these capabilities.
 */
const USER_NAMESPACE_SECURITY_CONTEXT = {
  capabilities: { add: ['ALL'] },
  seccompProfile: { type: 'Unconfined' },
  appArmorProfile: { type: 'Unconfined' },
  procMount: 'Unmasked',
};

const DOCKER_CONFIG_JSON_KEY = '.dockerconfigjson';
export const GHCR_REGISTRY = 'ghcr.io';

export interface KubernetesPodPartsRequest {
  workloadId: string;
  image: string;
  imageDigest?: string | null;
  env?: Record<string, string> | null;
  githubToken?: string | null;
  gpuCount: number;
  dockerOptions?: DockerOptions | null;
}

export interface KubernetesPodParts {
  metadata: V1ObjectMeta;
  /**
   * Spread into every workload PodSpec. Managed capacity provisions no
   * node-to-node network (RFC 0033), so a CoreDNS replica may sit on an
   * unreachable node; `dnsPolicy: Default` resolves through the Pod's own
   * node instead.
   */
  podSpecDefaults: Pick<
    V1PodSpec,
    'dnsPolicy' | 'runtimeClassName' | 'hostUsers'
  >;
  containerBase: Pick<
    V1Container,
    'image' | 'env' | 'resources' | 'volumeMounts' | 'securityContext'
  >;
  volumes?: V1Volume[];
  imagePullSecrets?: V1LocalObjectReference[];
  secrets: V1Secret[];
  imagePullSecretName?: string;
}

export function imageRegistry(image: string): string | undefined {
  const firstSegment = image.trim().split('/')[0]?.toLowerCase();
  return firstSegment?.includes('.') || firstSegment?.includes(':')
    ? firstSegment
    : undefined;
}

/** Whether a replica of `image` renders a pull Secret from its token. */
export function pullsWithSecret(image: string, hasToken: boolean): boolean {
  return hasToken && imageRegistry(image) === GHCR_REGISTRY;
}

function workloadEnv(
  request: KubernetesPodPartsRequest,
  extraEnv: Record<string, string>,
): V1EnvVar[] {
  const env: Record<string, string> = {
    WORKLOAD_ID: request.workloadId,
    // One-release compatibility for 0.1.64 containers; a later release removes this.
    DEPLOYMENT_ID: request.workloadId,
    ...(request.env ?? {}),
    ...extraEnv,
  };
  // The API server drops an empty value (omitempty); so does the render.
  return Object.entries(env).map(([name, value]) =>
    value === '' ? { name } : { name, value },
  );
}

export function buildKubernetesPodParts(input: {
  namespace: string;
  identity: KubernetesWorkloadIdentity;
  request: KubernetesPodPartsRequest;
  workloadName: string;
  extraEnv?: Record<string, string>;
}): KubernetesPodParts {
  const { identity, request } = input;
  validateKubernetesDockerOptions(request.dockerOptions, input.workloadName);
  const runtimeClassName = resolveKubernetesRuntimeClass(
    request.dockerOptions,
    request.gpuCount,
  );
  // The registry token only pulls the image; it never reaches the container.
  const token = request.githubToken?.trim();
  const secrets: V1Secret[] = [];

  let imagePullSecretName: string | undefined;
  if (pullsWithSecret(request.image, Boolean(token))) {
    imagePullSecretName = identity.imagePullSecretName;
    const dockerAuth = Buffer.from(`${GHCR_TOKEN_USERNAME}:${token}`).toString(
      'base64',
    );
    secrets.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: imagePullSecretName,
        namespace: input.namespace,
        labels: identity.labels,
        annotations: identity.annotations,
      },
      type: 'kubernetes.io/dockerconfigjson',
      stringData: {
        [DOCKER_CONFIG_JSON_KEY]: JSON.stringify({
          auths: {
            [GHCR_REGISTRY]: {
              username: GHCR_TOKEN_USERNAME,
              password: token,
              auth: dockerAuth,
            },
          },
        }),
      },
    });
  }

  const cpuCount = normalizeKubernetesCpus(request.dockerOptions?.cpus);
  const memory = normalizeKubernetesMemory(request.dockerOptions?.memory);
  const shmSize = normalizeKubernetesShmSize(request.dockerOptions?.shmSize);
  const resourceValues: Record<string, string> = {
    ...(cpuCount ? { cpu: cpuCount } : {}),
    ...(memory ? { memory } : {}),
    ...(request.gpuCount === 0
      ? {}
      : { 'nvidia.com/gpu': String(request.gpuCount) }),
  };
  const resources =
    Object.keys(resourceValues).length === 0
      ? undefined
      : { requests: resourceValues, limits: resourceValues };
  const volumeMounts = shmSize
    ? [{ name: KUBERNETES_SHM_VOLUME, mountPath: '/dev/shm' }]
    : [];
  const volumes: V1Volume[] = shmSize
    ? [
        {
          name: KUBERNETES_SHM_VOLUME,
          emptyDir: { medium: 'Memory', sizeLimit: shmSize },
        },
      ]
    : [];
  for (const [index, bind] of (request.dockerOptions?.binds ?? []).entries()) {
    // Validation accepts anonymous volumes only. Each volume belongs to this
    // Pod, survives a container restart, and is removed with the Pod.
    const name = `scratch-${index}`;
    const mountPath = parseDockerVolumeBind(bind)!.target;
    volumes.push({ name, emptyDir: {} });
    volumeMounts.push({ name, mountPath });
  }

  return {
    metadata: {
      labels: identity.labels,
      annotations: identity.annotations,
    },
    podSpecDefaults: {
      dnsPolicy: 'Default',
      ...(runtimeClassName ? { runtimeClassName } : {}),
      ...(request.dockerOptions?.userNamespace && { hostUsers: false }),
    },
    containerBase: {
      image: resolveWorkloadImage(request),
      env: workloadEnv(request, input.extraEnv ?? {}),
      resources,
      volumeMounts: volumeMounts.length ? volumeMounts : undefined,
      ...(request.dockerOptions?.userNamespace
        ? { securityContext: USER_NAMESPACE_SECURITY_CONTEXT }
        : request.dockerOptions?.privileged === undefined
          ? {}
          : {
              securityContext: { privileged: request.dockerOptions.privileged },
            }),
    },
    volumes: volumes.length ? volumes : undefined,
    imagePullSecrets: imagePullSecretName
      ? [{ name: imagePullSecretName }]
      : undefined,
    secrets,
    imagePullSecretName,
  };
}
