import { type CloudType } from '../../../shared/cloud.js';
import { hostedApiIdentity } from '../../../shared/hosted-api-identity.js';
import { OWNER_API_TAG } from '../api-identity.js';

export interface ResourceSweepResult {
  vmIds: string[];
  otherResources: Array<{
    type: string;
    id: string;
  }>;
  errors: ResourceSweepError[];
  /**
   * Installation resources kept because they name a running VM-host workload
   * (RFC 0049 C26 (c)); only an installation sweep fills it.
   */
  spared?: SparedSweepResource[];
}

export interface SparedSweepResource {
  readonly type: string;
  readonly id: string;
  readonly workloadId: string;
}

export interface ResourceSweepError {
  resourceType: string;
  resourceId: string;
  error: string;
}

export interface ResourceSweepPolicy {
  /** User ids whose resources the caller is authorized to reclaim. */
  readonly reclaimableUserIds: readonly string[];
  /** Whether old resources that no installation stamped may be reclaimed. */
  readonly includeUnowned: boolean;
  /** Minimum age for stale-user and unowned resources. */
  readonly minAgeMs: number;
  /** Whether an end mark is sufficient for a reclaimable user's resource. */
  readonly reclaimMarkedEnded: boolean;
  /**
   * Select one installation's resources instead, regardless of user and age.
   * The fields above are then ignored.
   */
  readonly installation?: InstallationSweepSelector;
}

/**
 * One installation's resources: tagged `anycloud_cluster=<id>`, stamped by its
 * hosted API, or named for it (RFC 0049 C26 (c)).
 */
interface InstallationSweepSelector {
  readonly clusterId: string;
  /** `hostedApiIdentity(clusterId)`: VM Jobs and per-Job buckets carry only this. */
  readonly ownerApi: string;
  /**
   * Scope IDs (`anycloud-cluster-<id>` and pool IDs) that name a resource
   * carrying no tags, such as a GCP firewall rule.
   */
  readonly resourceOwnerIds: readonly string[];
  /** Keep running VM-host workload VMs and report them as spared. */
  readonly spareRunningWorkloads: boolean;
  /** Workloads whose resources stay: the running ones a dry run reported. */
  readonly spareWorkloadIds: readonly string[];
  /**
   * The API's own self-delete: the management VM's scope, and the managed
   * bucket unless it goes too, stay for the cloud's own delete.
   */
  readonly keep?: {
    readonly resourceOwnerIds: readonly string[];
    readonly names: readonly string[];
  };
}

export function installationSweepPolicy(
  clusterId: string,
  options: {
    resourceOwnerIds?: readonly string[];
    spareRunningWorkloads: boolean;
    spareWorkloadIds?: readonly string[];
    /** Leave the management scope, and the managed bucket unless `false`. */
    keepManagement?: { keepBucket: boolean };
  },
): ResourceSweepPolicy {
  // The management scope's ID, cut to a label as clusters-domain does.
  const managementScope = `anycloud-cluster-${clusterId}`.slice(0, 63);
  const keep = options.keepManagement;
  return {
    reclaimableUserIds: [],
    includeUnowned: false,
    minAgeMs: Number.POSITIVE_INFINITY,
    reclaimMarkedEnded: false,
    installation: {
      clusterId,
      ownerApi: hostedApiIdentity(clusterId),
      resourceOwnerIds: [
        ...(keep ? [] : [managementScope]),
        ...(options.resourceOwnerIds ?? []),
      ],
      spareRunningWorkloads: options.spareRunningWorkloads,
      spareWorkloadIds: options.spareWorkloadIds ?? [],
      ...(keep && {
        keep: {
          resourceOwnerIds: [managementScope],
          names: keep.keepBucket ? [clusterId] : [],
        },
      }),
    },
  };
}

export interface ResourceSweepOptions {
  readonly dryRun?: boolean;
  readonly policy: ResourceSweepPolicy;
}

export interface ResourceSweepOwner {
  readonly userId?: string | null;
  /** The stamping installation (`anycloud_owner_api`). */
  readonly ownerApi?: string | null;
  /** `anycloud_cluster`: the installation a scoped resource belongs to. */
  readonly clusterId?: string | null;
  /** `anycloud_deployment`: the workload a workload-scoped resource serves. */
  readonly workloadId?: string | null;
  /** `anycloud_resource`: the scope a scoped resource belongs to. */
  readonly resourceOwnerId?: string | null;
}

export interface ResourceSweepCandidate extends ResourceSweepOwner {
  readonly createdAt?: Date | string | number | null;
  readonly endedAt?: string | number | null;
  /** The provider proves the resource is detached or idle. */
  readonly detached?: boolean;
  /** A VM not known to be stopped (see `ResourceVM`): starting, stopping and unknown count. */
  readonly running?: boolean;
  /** The resource's name, for selectors that match untagged resources by it. */
  readonly name?: string;
  /** Where an installation sweep reports this resource when it spares it. */
  readonly spare?: {
    readonly into: ResourceSweepResult;
    readonly type: string;
    /** Unnamed resources go unreported. */
    readonly id: string | null | undefined;
  };
}

/** The owner a resource's `anycloud_*` tags or labels name. */
export function sweepOwner(
  tags: Record<string, string | null | undefined>,
): ResourceSweepOwner {
  return {
    userId: tags.anycloud_user,
    ownerApi: tags[OWNER_API_TAG],
    clusterId: tags.anycloud_cluster,
    workloadId: tags.anycloud_deployment,
    resourceOwnerId: tags.anycloud_resource,
  };
}

/**
 * The workload a running VM-host VM, or a resource that names a spared
 * workload, keeps; undefined when the installation sweep may take it.
 */
function sparedWorkload(
  candidate: ResourceSweepCandidate,
  selector: InstallationSweepSelector,
): string | undefined {
  const workloadId = candidate.workloadId;
  if (!workloadId || workloadId === selector.clusterId) return undefined;
  if (selector.spareWorkloadIds.includes(workloadId)) return workloadId;
  const runningWorkloadVm =
    candidate.running === true &&
    (candidate.endedAt === undefined || candidate.endedAt === null);
  return selector.spareRunningWorkloads && runningWorkloadVm
    ? workloadId
    : undefined;
}

function isInstallationResource(
  candidate: ResourceSweepCandidate,
  selector: InstallationSweepSelector,
): boolean {
  return (
    candidate.clusterId === selector.clusterId ||
    candidate.ownerApi === selector.ownerApi ||
    // The managed checkpoint bucket: its workload, and its name, is the ID.
    candidate.workloadId === selector.clusterId ||
    candidate.name === selector.clusterId
  );
}

export function isResourceSweepCandidate(
  candidate: ResourceSweepCandidate,
  policy: ResourceSweepPolicy,
): boolean {
  const selector = policy.installation;
  if (selector) {
    if (!isInstallationResource(candidate, selector)) return false;
    const { keep } = selector;
    if (
      keep &&
      ((candidate.resourceOwnerId &&
        keep.resourceOwnerIds.includes(candidate.resourceOwnerId)) ||
        (candidate.name !== undefined && keep.names.includes(candidate.name)))
    ) {
      return false;
    }
    const workloadId = sparedWorkload(candidate, selector);
    if (workloadId === undefined) return true;
    if (candidate.spare?.id) {
      const { into, type, id } = candidate.spare;
      (into.spared ??= []).push({ type, id, workloadId });
    }
    return false;
  }
  // A resource another installation stamped is never unowned, even without a
  // user tag.
  const reclaimableOwner = candidate.userId
    ? policy.reclaimableUserIds.includes(candidate.userId)
    : policy.includeUnowned && !candidate.ownerApi;
  if (!reclaimableOwner) return false;
  if (candidate.detached) return true;
  // An end mark proves the workload is over only for a user the policy owns.
  if (
    policy.reclaimMarkedEnded &&
    candidate.userId &&
    candidate.endedAt !== undefined &&
    candidate.endedAt !== null
  ) {
    return true;
  }
  return isOlderThan(candidate.createdAt, policy.minAgeMs);
}

/** Unknown age is never eligible: a sweep must fail safe. */
export function isOlderThan(
  creationTime: Date | string | number | undefined | null,
  minAgeMs: number,
): boolean {
  if (creationTime === undefined || creationTime === null) return false;
  const parsed =
    typeof creationTime === 'string' && /^\d+$/.test(creationTime)
      ? Number(creationTime)
      : creationTime;
  const createdAtMs = new Date(parsed).getTime();
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs > minAgeMs;
}

interface CloudResourceSweeperPublic {
  readonly type: CloudType;
  readonly region: string;
  /**
   * Discover and reclaim account resources. The policy controls candidates
   * inferred from ownership metadata; providers may also reclaim supporting
   * resources they can prove are detached.
   */
  sweepResources(options: ResourceSweepOptions): Promise<ResourceSweepResult>;
  /** Account-global storage pass for providers that cannot scope it by region. */
  sweepStorage?(options: ResourceSweepOptions): Promise<ResourceSweepResult>;
  /**
   * The locations whose sweeps together cover the account: AWS's enabled
   * regions, Azure's regions with an `anycloud-<region>` group. Absent when
   * one sweep covers every location (GCP lists across zones).
   */
  sweepLocations?(): Promise<string[]>;
}

const cloudResourceSweeperBrand: unique symbol = Symbol('CloudResourceSweeper');

export type CloudResourceSweeper = CloudResourceSweeperPublic & {
  readonly [cloudResourceSweeperBrand]: true;
};

type CloudResourceSweeperBuilder = {
  -readonly [Key in keyof CloudResourceSweeperPublic]: CloudResourceSweeperPublic[Key];
};

export interface CloudResourceSweeperOps {
  readonly type: CloudType;
  readonly region: string;
  rawSweepResources(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult>;
  rawSweepStorage?(options: ResourceSweepOptions): Promise<ResourceSweepResult>;
  rawSweepLocations?(): Promise<string[]>;
}

export function createCloudResourceSweeper(
  ops: CloudResourceSweeperOps,
): CloudResourceSweeper {
  const sweeper: CloudResourceSweeperBuilder = {
    type: ops.type,
    region: ops.region,
    sweepResources: (options) => ops.rawSweepResources(options),
  };

  if (ops.rawSweepStorage) {
    sweeper.sweepStorage = (options) => ops.rawSweepStorage!(options);
  }
  if (ops.rawSweepLocations) {
    sweeper.sweepLocations = () => ops.rawSweepLocations!();
  }

  Object.defineProperty(sweeper, cloudResourceSweeperBrand, {
    value: true,
    enumerable: false,
  });

  return sweeper as CloudResourceSweeper;
}
