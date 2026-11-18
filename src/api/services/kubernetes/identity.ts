import { createHash } from 'node:crypto';

import { getApiIdentity } from '../api-identity.js';

const DNS_LABEL_MAX_LENGTH = 63;

export const KUBERNETES_MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const KUBERNETES_COMPONENT_LABEL = 'app.kubernetes.io/component';
// Persisted ownership metadata and name prefixes survive product terminology changes.
const KUBERNETES_WORKLOAD_HASH_LABEL = 'anycloud.sh/deployment-hash';
export const KUBERNETES_WORKLOAD_ID_ANNOTATION = 'anycloud.sh/deployment-id';
export const KUBERNETES_USER_ID_ANNOTATION = 'anycloud.sh/user-id';
export const KUBERNETES_OWNER_API_ANNOTATION = 'anycloud.sh/owner-api';
export const KUBERNETES_GENERATION_ANNOTATION = 'anycloud.sh/generation';
/** The rendered Pod template's hash, on a native Deployment. */
export const KUBERNETES_TEMPLATE_ANNOTATION = 'anycloud.sh/template-hash';

// 'deployment' fixes the native Kubernetes names backing a Deployment record.
export type KubernetesWorkloadKind = 'serve' | 'job' | 'deployment';
export type KubernetesSecretKind =
  | 'runtime-auth'
  | 'registry-auth'
  | 'application-env';

export interface KubernetesWorkloadIdentity {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  podSelector: string;
  imagePullSecretName: string;
}

function hash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function dnsSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

function workloadPrefix(kind: KubernetesWorkloadKind): string {
  return `anycloud-${kind}`;
}

function workloadComponent(kind: KubernetesWorkloadKind): string {
  return `kubernetes-${kind}`;
}

/** The component label on a Deployment record's native objects. */
export const KUBERNETES_DEPLOYMENT_COMPONENT = workloadComponent('deployment');

export function kubernetesWorkloadResourceName(
  kind: KubernetesWorkloadKind,
  workloadId: string,
): string {
  const prefix = workloadPrefix(kind);
  const suffix = `-${hash(workloadId, 10)}`;
  const slugLength = DNS_LABEL_MAX_LENGTH - prefix.length - 1 - suffix.length;
  const slug =
    dnsSegment(workloadId).slice(0, slugLength).replace(/-+$/g, '') || 'x';
  return `${prefix}-${slug}${suffix}`;
}

export function kubernetesWorkloadPodSelector(workloadId: string): string {
  return `${KUBERNETES_WORKLOAD_HASH_LABEL}=${hash(workloadId, 16)}`;
}

/** Whether labels match `kubernetesWorkloadPodSelector(workloadId)`. */
export function isKubernetesWorkloadPod(
  labels: Record<string, string> | undefined,
  workloadId: string,
): boolean {
  return labels?.[KUBERNETES_WORKLOAD_HASH_LABEL] === hash(workloadId, 16);
}

function kubernetesWorkloadLabels(
  kind: KubernetesWorkloadKind,
  workloadId: string,
): Record<string, string> {
  return {
    [KUBERNETES_MANAGED_BY_LABEL]: 'anycloud',
    [KUBERNETES_COMPONENT_LABEL]: workloadComponent(kind),
    [KUBERNETES_WORKLOAD_HASH_LABEL]: hash(workloadId, 16),
  };
}

/** Label selector for every node pool Service replica, whichever Service it belongs to. */
export function nodePoolServicePodSelector(): string {
  return `${KUBERNETES_COMPONENT_LABEL}=${workloadComponent('serve')}`;
}

export function kubernetesWorkloadSecretName(
  kind: KubernetesWorkloadKind,
  workloadId: string,
  secretKind: KubernetesSecretKind,
): string {
  const prefix = workloadPrefix(kind);
  const identitySuffix = `-${secretKind}-${hash(workloadId, 10)}`;
  const base = `${prefix}-${dnsSegment(workloadId)}`;
  return `${base
    .slice(0, DNS_LABEL_MAX_LENGTH - identitySuffix.length)
    .replace(/-+$/g, '')}${identitySuffix}`;
}

export function kubernetesWorkloadIdentity(input: {
  kind: KubernetesWorkloadKind;
  workloadId: string;
  userId: string;
}): KubernetesWorkloadIdentity {
  return {
    name: kubernetesWorkloadResourceName(input.kind, input.workloadId),
    labels: kubernetesWorkloadLabels(input.kind, input.workloadId),
    annotations: {
      [KUBERNETES_WORKLOAD_ID_ANNOTATION]: input.workloadId,
      [KUBERNETES_USER_ID_ANNOTATION]: input.userId,
      [KUBERNETES_OWNER_API_ANNOTATION]: getApiIdentity(),
    },
    podSelector: kubernetesWorkloadPodSelector(input.workloadId),
    imagePullSecretName: kubernetesWorkloadSecretName(
      input.kind,
      input.workloadId,
      'registry-auth',
    ),
  };
}
