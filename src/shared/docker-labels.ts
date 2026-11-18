// Keep label values stable so upgraded runtimes recognize existing containers.
export const ANYCLOUD_DOCKER_LABEL_KEYS = {
  managed: 'sh.anycloud.managed',
  role: 'sh.anycloud.role',
  workloadId: 'sh.anycloud.deployment-id',
  clusterId: 'sh.anycloud.cluster-id',
  userId: 'sh.anycloud.user-id',
  vmId: 'sh.anycloud.vm-id',
} as const;

export const ANYCLOUD_DOCKER_ROLES = {
  control: 'control',
  workload: 'workload',
} as const;

type AnycloudDockerRole =
  (typeof ANYCLOUD_DOCKER_ROLES)[keyof typeof ANYCLOUD_DOCKER_ROLES];

export interface AnycloudDockerLabelsInput {
  role: AnycloudDockerRole;
  workloadId: string;
  clusterId?: string;
  userId?: string;
  vmId?: string;
}

export function buildAnycloudDockerLabels({
  role,
  workloadId,
  clusterId,
  userId,
  vmId,
}: AnycloudDockerLabelsInput): Record<string, string> {
  return {
    [ANYCLOUD_DOCKER_LABEL_KEYS.managed]: 'true',
    [ANYCLOUD_DOCKER_LABEL_KEYS.role]: role,
    [ANYCLOUD_DOCKER_LABEL_KEYS.workloadId]: workloadId,
    ...(clusterId ? { [ANYCLOUD_DOCKER_LABEL_KEYS.clusterId]: clusterId } : {}),
    ...(userId ? { [ANYCLOUD_DOCKER_LABEL_KEYS.userId]: userId } : {}),
    ...(vmId ? { [ANYCLOUD_DOCKER_LABEL_KEYS.vmId]: vmId } : {}),
  };
}
