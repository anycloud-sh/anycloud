import { describe, expect, it, vi } from 'vitest';

import {
  ApiOwnershipConflictError,
  apiOwnershipTagDecision,
  createCloudApiOwnership,
} from '../../../../src/api/services/gateways/api-ownership.js';
import { CloudType } from '../../../../src/shared/cloud.js';

const target = {
  cloudId: 'vm-1',
  apiIdentity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ownerKind: 'workload' as const,
  ownerId: 'workload-1',
  userId: 'user-1',
};

describe('API ownership provider role', () => {
  it('accepts matching legacy ownership while never overwriting another API', () => {
    expect(
      apiOwnershipTagDecision({ anycloud_deployment: 'workload-1' }, target),
    ).toBe('update');
    expect(
      apiOwnershipTagDecision(
        {
          anycloud_deployment: 'workload-1',
          anycloud_user: 'user-1',
          anycloud_owner_api: target.apiIdentity,
        },
        target,
      ),
    ).toBe('already-owned');
    expect(() =>
      apiOwnershipTagDecision(
        {
          anycloud_deployment: 'workload-1',
          anycloud_owner_api: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        target,
      ),
    ).toThrow(ApiOwnershipConflictError);
  });

  it('requires the exact durable owner id and rejects a different user', () => {
    expect(() =>
      apiOwnershipTagDecision({ anycloud_deployment: 'workload-2' }, target),
    ).toThrow('expected anycloud_deployment=workload-1');
    expect(() =>
      apiOwnershipTagDecision(
        {
          anycloud_deployment: 'workload-1',
          anycloud_user: 'user-2',
        },
        target,
      ),
    ).toThrow('belongs to user user-2');
  });

  it('exposes only the exact-resource mutation supplied by a gateway', async () => {
    const rawBackfillExactVM = vi.fn().mockResolvedValue('updated');
    const provider = createCloudApiOwnership({
      type: CloudType.AWS,
      region: 'us-east-1',
      rawBackfillExactVM,
    });

    await expect(provider.backfillExactVM(target)).resolves.toBe('updated');
    expect(rawBackfillExactVM).toHaveBeenCalledWith(target);
  });
});
