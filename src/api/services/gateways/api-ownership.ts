import type { CloudType } from '../../../shared/cloud.js';
import { OWNER_API_TAG } from '../api-identity.js';

export const ApiOwnershipBackfillResult = {
  Updated: 'updated',
  AlreadyOwned: 'already-owned',
  Missing: 'missing',
} as const;

export type ApiOwnershipBackfillResult =
  (typeof ApiOwnershipBackfillResult)[keyof typeof ApiOwnershipBackfillResult];

export interface ExactVmApiOwnership {
  readonly cloudId: string;
  readonly apiIdentity: string;
  readonly ownerKind: 'workload' | 'resource';
  readonly ownerId: string;
  readonly userId: string;
}

export class ApiOwnershipConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiOwnershipConflictError';
  }
}

/**
 * Decide whether an exact, database-known provider resource may receive this
 * owner's marker. Legacy resources may omit the user tag, but the durable
 * owner id must match and an existing owner marker is never overwritten.
 */
export function apiOwnershipTagDecision(
  tags: Readonly<Record<string, string | undefined>>,
  target: ExactVmApiOwnership,
): 'update' | 'already-owned' {
  const ownerKey =
    target.ownerKind === 'workload'
      ? 'anycloud_deployment'
      : 'anycloud_resource';
  if (tags[ownerKey] !== target.ownerId) {
    throw new ApiOwnershipConflictError(
      `${target.cloudId} does not carry the expected ${ownerKey}=${target.ownerId}`,
    );
  }
  if (tags.anycloud_user && tags.anycloud_user !== target.userId) {
    throw new ApiOwnershipConflictError(
      `${target.cloudId} belongs to user ${tags.anycloud_user}, not ${target.userId}`,
    );
  }

  const observedOwnerApi = tags[OWNER_API_TAG];
  if (observedOwnerApi === target.apiIdentity) return 'already-owned';
  if (observedOwnerApi) {
    throw new ApiOwnershipConflictError(
      `${target.cloudId} belongs to API ${observedOwnerApi}, not ${target.apiIdentity}`,
    );
  }
  return 'update';
}

interface CloudApiOwnershipPublic {
  readonly type: CloudType;
  readonly region: string;
  backfillExactVM(
    target: ExactVmApiOwnership,
  ): Promise<ApiOwnershipBackfillResult>;
}

const cloudApiOwnershipBrand: unique symbol = Symbol('CloudApiOwnership');

export type CloudApiOwnership = CloudApiOwnershipPublic & {
  readonly [cloudApiOwnershipBrand]: true;
};

export interface CloudApiOwnershipOps {
  readonly type: CloudType;
  readonly region: string;
  rawBackfillExactVM(
    target: ExactVmApiOwnership,
  ): Promise<ApiOwnershipBackfillResult>;
}

export function createCloudApiOwnership(
  ops: CloudApiOwnershipOps,
): CloudApiOwnership {
  const ownership: CloudApiOwnershipPublic = {
    type: ops.type,
    region: ops.region,
    backfillExactVM: (target) => ops.rawBackfillExactVM(target),
  };
  Object.defineProperty(ownership, cloudApiOwnershipBrand, {
    value: true,
    enumerable: false,
  });
  return ownership as CloudApiOwnership;
}
