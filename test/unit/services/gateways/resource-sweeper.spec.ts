import { describe, expect, it } from 'vitest';
import {
  createCloudResourceSweeper,
  isOlderThan,
  installationSweepPolicy,
  isResourceSweepCandidate,
  type ResourceSweepPolicy,
  type ResourceSweepResult,
} from '../../../../src/api/services/gateways/resource-sweeper';
import { hostedApiIdentity } from '../../../../src/shared/hosted-api-identity.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import {
  TEST_USER_ID,
  TEST_USERNAMES,
} from '../../../../src/api/services/test-identity.js';
import {
  CI_RESOURCE_SWEEP_MIN_AGE_MS,
  CI_RESOURCE_SWEEP_POLICY,
} from '../../../../ci/cleanup/policy';

const POLICY: ResourceSweepPolicy = {
  reclaimableUserIds: ['test-user'],
  includeUnowned: true,
  minAgeMs: 3_000,
  reclaimMarkedEnded: true,
};

describe('isOlderThan', () => {
  it('fails safe for unknown and invalid creation times', () => {
    expect(isOlderThan(undefined, 1_000)).toBe(false);
    expect(isOlderThan(null, 1_000)).toBe(false);
    expect(isOlderThan('not-a-date', 1_000)).toBe(false);
  });

  it('supports Date, ISO, and numeric-millisecond creation times', () => {
    const oldMs = Date.now() - 5_000;
    for (const createdAt of [
      new Date(oldMs),
      new Date(oldMs).toISOString(),
      String(oldMs),
      oldMs,
    ]) {
      expect(isOlderThan(createdAt, 3_000)).toBe(true);
      expect(isOlderThan(createdAt, 10_000)).toBe(false);
    }
  });
});

describe('isResourceSweepCandidate', () => {
  it('reclaims an end-marked resource only for a CI test user', () => {
    const ended = { endedAt: String(Date.now()), createdAt: Date.now() };
    // Dedicated Jobs tag the test username; pools tag the test user's id.
    for (const userId of [TEST_USERNAMES[0], TEST_USER_ID]) {
      expect(
        isResourceSweepCandidate(
          { ...ended, userId },
          CI_RESOURCE_SWEEP_POLICY,
        ),
      ).toBe(true);
    }
    expect(
      isResourceSweepCandidate(
        { ...ended, userId: 'customer' },
        CI_RESOURCE_SWEEP_POLICY,
      ),
    ).toBe(false);
    expect(isResourceSweepCandidate(ended, CI_RESOURCE_SWEEP_POLICY)).toBe(
      false,
    );
    expect(
      isResourceSweepCandidate(
        { ...ended, userId: TEST_USERNAMES[0] },
        { ...CI_RESOURCE_SWEEP_POLICY, reclaimMarkedEnded: false },
      ),
    ).toBe(false);
  });

  it('keeps the CI age rule for test-user and unowned resources', () => {
    const old = Date.now() - CI_RESOURCE_SWEEP_MIN_AGE_MS - 1_000;
    const recent = Date.now() - CI_RESOURCE_SWEEP_MIN_AGE_MS + 60_000;
    for (const owner of [{ userId: TEST_USERNAMES[0] }, {}]) {
      expect(
        isResourceSweepCandidate(
          { ...owner, createdAt: old },
          CI_RESOURCE_SWEEP_POLICY,
        ),
      ).toBe(true);
      expect(
        isResourceSweepCandidate(
          { ...owner, createdAt: recent },
          CI_RESOURCE_SWEEP_POLICY,
        ),
      ).toBe(false);
    }
  });

  it('never treats a resource another installation stamped as unowned', () => {
    const candidate = {
      ownerApi: '0123456789abcdef0123456789abcdef',
      createdAt: Date.now() - CI_RESOURCE_SWEEP_MIN_AGE_MS - 1_000,
      endedAt: String(Date.now()),
    };
    for (const detached of [false, true]) {
      expect(
        isResourceSweepCandidate(
          { ...candidate, detached },
          CI_RESOURCE_SWEEP_POLICY,
        ),
      ).toBe(false);
    }
  });

  it('requires both an eligible owner and sufficient age', () => {
    const old = Date.now() - 5_000;
    expect(
      isResourceSweepCandidate({ userId: 'test-user', createdAt: old }, POLICY),
    ).toBe(true);
    expect(
      isResourceSweepCandidate({ userId: 'customer', createdAt: old }, POLICY),
    ).toBe(false);
    expect(
      isResourceSweepCandidate(
        { userId: 'test-user', createdAt: Date.now() },
        POLICY,
      ),
    ).toBe(false);
  });

  it('treats missing owners according to policy', () => {
    const candidate = { createdAt: Date.now() - 5_000 };
    expect(isResourceSweepCandidate(candidate, POLICY)).toBe(true);
    expect(
      isResourceSweepCandidate(candidate, {
        ...POLICY,
        includeUnowned: false,
      }),
    ).toBe(false);
  });
});

describe('installation sweep selector', () => {
  const policy = installationSweepPolicy('prod-1', {
    spareRunningWorkloads: true,
  });
  const recent = Date.now();

  it('takes the installation by cluster tag, hosted stamp or name, at any age, and nothing else', () => {
    for (const candidate of [
      { clusterId: 'prod-1' },
      { ownerApi: hostedApiIdentity('prod-1'), workloadId: 'job-1' },
      // The managed checkpoint bucket, tagged or not.
      { workloadId: 'prod-1' },
      { name: 'prod-1' },
    ]) {
      expect(
        isResourceSweepCandidate({ ...candidate, createdAt: recent }, policy),
      ).toBe(true);
    }
    for (const candidate of [
      { clusterId: 'prod-2' },
      { ownerApi: hostedApiIdentity('prod-2') },
      // A user the CI policy would reclaim, old and ended.
      { userId: TEST_USERNAMES[0], createdAt: 1, endedAt: '1' },
      { createdAt: 1 },
    ]) {
      expect(isResourceSweepCandidate(candidate, policy)).toBe(false);
    }
  });

  it('spares a running VM-host workload and reports it, but takes a stopped or ended one', () => {
    const result: ResourceSweepResult = {
      vmIds: [],
      otherResources: [],
      errors: [],
    };
    const workload = {
      ownerApi: hostedApiIdentity('prod-1'),
      workloadId: 'svc-1',
      spare: { into: result, type: 'vm', id: 'i-svc' },
    };
    expect(
      isResourceSweepCandidate({ ...workload, running: true }, policy),
    ).toBe(false);
    expect(
      isResourceSweepCandidate({ ...workload, running: false }, policy),
    ).toBe(true);
    expect(
      isResourceSweepCandidate(
        { ...workload, running: true, endedAt: '1' },
        policy,
      ),
    ).toBe(true);
    expect(
      isResourceSweepCandidate(
        { ...workload, running: true },
        installationSweepPolicy('prod-1', { spareRunningWorkloads: false }),
      ),
    ).toBe(true);
    expect(result.spared).toEqual([
      { type: 'vm', id: 'i-svc', workloadId: 'svc-1' },
    ]);
  });

  it("spares every resource that names a skipped workload, but not the cluster's own", () => {
    const sparing = installationSweepPolicy('prod-1', {
      spareRunningWorkloads: true,
      spareWorkloadIds: ['svc-1', 'prod-1'],
    });
    const owner = { ownerApi: hostedApiIdentity('prod-1') };
    expect(
      isResourceSweepCandidate({ ...owner, workloadId: 'svc-1' }, sparing),
    ).toBe(false);
    expect(
      isResourceSweepCandidate({ ...owner, workloadId: 'job-2' }, sparing),
    ).toBe(true);
    expect(
      isResourceSweepCandidate(
        { clusterId: 'prod-1', workloadId: 'prod-1' },
        sparing,
      ),
    ).toBe(true);
    expect(sparing.installation?.resourceOwnerIds).toEqual([
      'anycloud-cluster-prod-1',
    ]);
    const long = 'a'.repeat(60);
    expect(
      installationSweepPolicy(long, { spareRunningWorkloads: true })
        .installation?.resourceOwnerIds,
    ).toEqual(['anycloud-cluster-' + 'a'.repeat(46)]);
  });
});

describe('createCloudResourceSweeper', () => {
  it('keeps resource and account-storage sweeps behind the separate role', async () => {
    const clean = { vmIds: [], otherResources: [], errors: [] };
    const rawSweepResources = async () => clean;
    const rawSweepStorage = async () => clean;
    const sweeper = createCloudResourceSweeper({
      type: CloudType.AWS,
      region: 'us-east-1',
      rawSweepResources,
      rawSweepStorage,
    });

    await expect(sweeper.sweepResources({ policy: POLICY })).resolves.toBe(
      clean,
    );
    await expect(sweeper.sweepStorage?.({ policy: POLICY })).resolves.toBe(
      clean,
    );
  });
});
