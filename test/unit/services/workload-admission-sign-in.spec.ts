import { describe, expect, it, vi } from 'vitest';

import { prepareWorkloadCreation } from '../../../src/api/services/workload-admission-plan.js';
import { resolveWorkloadAdmission } from '../../../src/api/services/workload-admission-resolution.js';
import type { WorkloadAdmissionInput } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { GithubSignInRequiredError } from '../../../src/shared/errors.js';
import { TEST_AWS_CRED, TEST_GCP_CRED } from '../helpers/fixtures.js';

const inspectImage = vi.hoisted(() => vi.fn());
const bucketExistsForRequest = vi.hoisted(() => vi.fn());
vi.mock('../../../src/shared/image-registry.js', () => ({
  inspectImage,
}));
vi.mock(
  '../../../src/api/services/workload-operation-helpers.js',
  async (original) => ({
    ...(await original<
      typeof import('../../../src/api/services/workload-operation-helpers.js')
    >()),
    bucketExistsForRequest,
  }),
);

describe('VM-host Service admission without a GitHub sign-in', () => {
  it('stops before image inspection and any bucket check', async () => {
    const input: WorkloadAdmissionInput = {
      image: 'nginx:1.27',
      workloadType: 'service',
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        credentials: TEST_AWS_CRED,
        region: 'us-east-1',
        vmType: 'm5.large',
        checkpointBucket: 'signed-out-checkpoint',
      },
    };
    const resolved = await resolveWorkloadAdmission({
      actor: { id: `local:${'1'.repeat(32)}`, username: 'local', token: null },
      input,
    });

    await expect(
      prepareWorkloadCreation({ resolved, progress: {} }),
    ).rejects.toBeInstanceOf(GithubSignInRequiredError);
    expect(inspectImage).not.toHaveBeenCalled();
    expect(bucketExistsForRequest).not.toHaveBeenCalled();
  });
});

describe('gp3 performance in VM Job admission', () => {
  it('refuses it during resolution, on a cloud other than AWS, before anything is prepared', async () => {
    await expect(
      resolveWorkloadAdmission({
        actor: {
          id: `local:${'1'.repeat(32)}`,
          username: 'local',
          token: null,
        },
        input: {
          image: 'ghcr.io/acme/ci:1',
          cloudConfig: {
            cloudProvider: CloudType.GCP,
            credentials: TEST_GCP_CRED,
            region: 'us-central1',
            vmType: 'e2-standard-4',
            diskIops: 3000,
          },
        },
      }),
    ).rejects.toThrow('AWS gp3 only; pin the Job to AWS');
    await expect(
      resolveWorkloadAdmission({
        actor: {
          id: `local:${'1'.repeat(32)}`,
          username: 'local',
          token: null,
        },
        input: {
          image: 'ghcr.io/acme/ci:1',
          cloudConfig: {
            cloudProvider: CloudType.AWS,
            credentials: TEST_AWS_CRED,
            region: 'us-east-1',
            vmType: 'm5.large',
            diskIops: 3000,
            diskThroughputMibps: 500,
          },
        },
      }),
    ).resolves.toMatchObject({
      cloudConfig: { diskIops: 3000, diskThroughputMibps: 500 },
    });
  });
});
