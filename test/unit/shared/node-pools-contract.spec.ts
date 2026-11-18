import { describe, expect, it } from 'vitest';
import {
  createNodePoolInputSchema,
  NODE_POOL_BOUNDS_REASON,
} from '../../../src/shared/api-contract/node-pools-schemas.js';

const request = (minVmCount: number, maxVmCount: number) => ({
  name: 'aws-east',
  credentialName: 'aws-compute',
  region: 'us-east-2',
  vmTypes: ['t3.small'],
  minVmCount,
  maxVmCount,
});

describe('node pool creation contract', () => {
  it('0048/S10, 0049/C22: accepts --min-vms ≤ --max-vms with --max-vms at least 1, zero and equal bounds included, and refuses others', () => {
    for (const [min, max] of [
      [1, 8],
      [2, 2],
      [0, 4],
      [0, 1],
    ]) {
      expect(createNodePoolInputSchema.parse(request(min, max))).toMatchObject({
        minVmCount: min,
        maxVmCount: max,
      });
    }
    for (const [min, max] of [
      [0, 0],
      [3, 2],
    ]) {
      expect(
        createNodePoolInputSchema.safeParse(request(min, max)).error?.issues,
      ).toEqual([
        expect.objectContaining({
          path: ['minVmCount'],
          message: NODE_POOL_BOUNDS_REASON,
        }),
      ]);
    }
  });

  it('RFC 0049 C32 refuses --user-namespace-jobs with --allow-privileged-jobs', () => {
    const both = {
      ...request(1, 1),
      userNamespaceJobs: true,
      allowPrivilegedJobs: true,
    };
    expect(createNodePoolInputSchema.safeParse(both).error?.issues).toEqual([
      expect.objectContaining({ path: ['userNamespaceJobs'] }),
    ]);
    expect(
      createNodePoolInputSchema.parse({ ...both, allowPrivilegedJobs: false }),
    ).toMatchObject({ userNamespaceJobs: true });
  });
});
