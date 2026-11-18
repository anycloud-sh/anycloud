import { describe, expect, it, vi } from 'vitest';
import {
  abandon,
  deleteThroughApi,
  deleteWithoutApi,
  type HostedSelfDelete,
  type SeedDeleteDependencies,
} from '../../../src/cli/services/seed-delete';
import type { CloudSeed, SeedStatus } from '../../../src/cli/seed/types';
import type { SelfDeleteStatus } from '../../../src/shared/api-contract/system-release-schemas';

const ID = 'prod-1781234567890-abcd';
const deployed = (stopped: boolean): SeedStatus => ({
  kind: 'deployed',
  stopped,
  outputs: {
    publicIp: '203.0.113.7',
    instanceId: 'i-mgmt',
    bucket: ID,
    identity: 'role',
  },
});
const status = (
  overrides: Partial<SelfDeleteStatus> = {},
): SelfDeleteStatus => ({
  state: 'sweeping',
  installation: {
    clusterId: ID,
    cloud: 'aws',
    region: 'us-east-1',
    bucket: { name: ID, managed: true },
  },
  finalBackup: 'taken',
  backedUpAt: '2026-11-07T10:00:00.000Z',
  deleted: [],
  remaining: [],
  error: null,
  ...overrides,
});

/** One account as the user's CLI shows it, and a log of what ran in order. */
function world(
  options: {
    cloud?: CloudSeed['cloud'];
    statuses?: SeedStatus[];
    manifest?: object | null;
    account?: string;
  } = {},
) {
  const log: string[] = [];
  const statuses = [...(options.statuses ?? [{ kind: 'absent' }])];
  const seed: CloudSeed = {
    cloud: options.cloud ?? 'aws',
    checkRights: async () => [],
    selfDeleteValues: () => ({ cloud: 'azure', resourceGroup: 'x' }),
    deploy: async () => {
      throw new Error('not in delete');
    },
    findByName: async () => null,
    backupValues: () => {
      throw new Error('not in delete');
    },
    afterSelfDelete: vi.fn(async () => {
      log.push('after');
      return {
        deleted: [{ kind: 'identity' as const, id: `anycloud-${ID}-cfn` }],
        remaining: [],
      };
    }),
    discoverAccount: async () => ({
      account: options.account ?? '111122223333',
      principal: 'me',
    }),
    status: vi.fn(async () => {
      log.push('status');
      return statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    }),
    readObject: async () =>
      options.manifest === null
        ? null
        : JSON.stringify(
            options.manifest ?? {
              clusterId: ID,
              cloud: 'aws',
              account: '111122223333',
            },
          ),
    deleteFallback: vi.fn(async () => {
      log.push('fallback');
      return {
        deleted: [
          { kind: 'stack' as const, id: `anycloud-${ID}` },
          { kind: 'vm' as const, id: 'i-pool', location: 'us-east-1' },
        ],
        remaining: [
          {
            kind: 'bucket' as const,
            id: ID,
            selector: `anycloud_cluster=${ID}`,
          },
        ],
      };
    }),
  };
  const deps: SeedDeleteDependencies = {
    seed,
    region: 'us-east-1',
    confirm: vi.fn(async () => {
      log.push('confirm');
    }),
    removeDns: vi.fn(async () => {
      log.push('dns');
    }),
    sleep: async () => undefined,
    now: () => 0,
    log: () => undefined,
  };
  return { deps, log, seed };
}

const NONE = { deleteVms: false, deleteBuckets: false, skipCloud: false };

describe('cluster delete through the hosted API', () => {
  function api(
    states: Array<SelfDeleteStatus | null>,
  ): HostedSelfDelete & { request: ReturnType<typeof vi.fn> } {
    // The first read is the installation before the request.
    const reads = [status({ state: 'idle' }), ...states];
    return {
      request: vi.fn(async () => status()),
      status: vi.fn(async () =>
        reads.length > 1 ? reads.shift()! : reads[0]!,
      ),
    };
  }

  it("follows the API until it's gone, then the cloud until the stack is, then cleans up and removes DNS last", async () => {
    const { deps, log } = world({
      statuses: [
        { kind: 'in-progress', detail: 'DELETE_IN_PROGRESS' },
        { kind: 'absent' },
      ],
    });
    const hosted = api([
      status({
        state: 'removing',
        deleted: [{ type: 'vm', id: 'i-job', location: 'eu-west-1' }],
      }),
      null,
    ]);
    const report = await deleteThroughApi(deps, hosted, NONE);
    // The role the stack's delete runs under goes only once the stack is absent.
    expect(log).toEqual(['status', 'status', 'after', 'dns']);
    expect(hosted.request).toHaveBeenCalledWith(ID, false);
    expect(report).toMatchObject({
      outcome: 'destroyed',
      finalBackup: 'taken',
      deleted: [
        {
          kind: 'cloudResource',
          type: 'vm',
          id: 'i-job',
          location: 'eu-west-1',
        },
        { kind: 'cloudResource', type: 'identity', id: `anycloud-${ID}-cfn` },
        { kind: 'dnsRecord', name: `${ID}.anycloud.sh` },
      ],
      remaining: [
        {
          kind: 'checkpointBucket',
          name: ID,
          managed: true,
          deleteCommand: `anycloud api delete ${ID} --delete-buckets`,
        },
      ],
    });
  });

  it('confirms --delete-buckets first and reports the bucket deleted only when the seed did', async () => {
    const { deps, log } = world();
    vi.mocked(deps.seed.afterSelfDelete).mockResolvedValue({
      deleted: [{ kind: 'bucket', id: ID }],
      remaining: [],
    });
    const report = await deleteThroughApi(deps, api([null]), {
      ...NONE,
      deleteBuckets: true,
    });
    expect(log[0]).toBe('confirm');
    expect(deps.seed.afterSelfDelete).toHaveBeenCalledWith(ID, 'us-east-1', {
      deleteBuckets: true,
    });
    expect(report.deleted).toContainEqual({
      kind: 'cloudResource',
      type: 'bucket',
      id: ID,
      location: null,
    });
    expect(report.remaining).toEqual([]);
  });

  it('stops with what is left when the API reports its delete failed, removing nothing else', async () => {
    const { deps, log } = world();
    await expect(
      deleteThroughApi(
        deps,
        api([
          status({
            state: 'failed',
            error: '1 resource(s) could not be deleted',
            remaining: [
              {
                type: 'securityGroup',
                id: 'sg-1',
                location: null,
                error: 'DependencyViolation',
              },
            ],
          }),
        ]),
        NONE,
      ),
    ).rejects.toMatchObject({
      code: 'SELF_DELETE_FAILED',
      message: expect.stringContaining(
        'securityGroup sg-1 (DependencyViolation)',
      ),
    });
    expect(log).toEqual([]);
  });

  it('fails when the API restarts and forgets the delete, instead of waiting forever', async () => {
    const { deps } = world();
    await expect(
      deleteThroughApi(deps, api([status({ state: 'idle' })]), NONE),
    ).rejects.toMatchObject({
      code: 'SELF_DELETE_FAILED',
      message: expect.stringContaining('restarted'),
    });
  });

  it('keeps the DNS record when the Worker refuses it, and lists it as remaining', async () => {
    const { deps } = world();
    deps.removeDns = async () => {
      throw new Error('403');
    };
    const report = await deleteThroughApi(deps, api([null]), NONE);
    expect(report.remaining).toContainEqual({
      kind: 'dnsRecord',
      name: `${ID}.anycloud.sh`,
    });
  });
});

describe('cluster delete with the hosted API dead', () => {
  it.each([
    { kind: 'in-progress', detail: 'STOPPING' },
    { kind: 'failed', detail: 'CREATE_FAILED' },
  ] as const)(
    'refuses an installation $kind as incomplete unless --delete-vms, naming its detail',
    async (incomplete) => {
      const { deps, seed } = world({ statuses: [incomplete] });
      await expect(
        deleteWithoutApi(deps, ID, { ...NONE, deleteBuckets: true }),
      ).rejects.toMatchObject({
        code: 'INSTALLATION_INCOMPLETE',
        message: expect.stringMatching(
          new RegExp(
            `is ${incomplete.kind} \\(${incomplete.detail}\\).*--delete-vms`,
          ),
        ),
      });
      // --delete-vms takes it.
      const taken = world({ statuses: [incomplete, { kind: 'absent' }] });
      await expect(
        deleteWithoutApi(taken.deps, ID, { ...NONE, deleteVms: true }),
      ).resolves.toMatchObject({ outcome: 'destroyed' });
      expect(seed.deleteFallback).not.toHaveBeenCalled();
      expect(taken.seed.deleteFallback).toHaveBeenCalledOnce();
    },
  );

  it('without a flag only lists, after checking the recorded account', async () => {
    const { deps, log } = world({ statuses: [deployed(true)] });
    const report = await deleteWithoutApi(deps, ID, NONE);
    expect(report.outcome).toBe('planned');
    expect(report.remaining).toContainEqual({
      kind: 'managementVm',
      id: 'i-mgmt',
      stopped: true,
    });
    expect(log).toEqual(['status']);
  });

  it.each(['aws', 'gcp', 'azure'] as const)(
    'on %s refuses a running VM, a session for another account, and an account backup.json can’t confirm',
    async (cloud) => {
      const manifest = { clusterId: ID, cloud, account: '111122223333' };
      await expect(
        deleteWithoutApi(
          world({ cloud, manifest, statuses: [deployed(false)] }).deps,
          ID,
          { ...NONE, deleteVms: true },
        ),
      ).rejects.toMatchObject({ code: 'MANAGEMENT_VM_RUNNING' });
      await expect(
        deleteWithoutApi(world({ cloud, manifest, account: '999' }).deps, ID, {
          ...NONE,
          deleteVms: true,
        }),
      ).rejects.toMatchObject({
        code: 'ACCOUNT_MISMATCH',
        message: expect.stringContaining('111122223333'),
      });
      // No backup.json and nothing of the cluster here: no listing, and a
      // delete that finds nothing tagged keeps the DNS record.
      await expect(
        deleteWithoutApi(
          world({ cloud, manifest: null, statuses: [{ kind: 'absent' }] }).deps,
          ID,
          NONE,
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_UNCONFIRMED' });
      const empty = world({
        cloud,
        manifest: null,
        statuses: [{ kind: 'absent' }],
      });
      vi.mocked(empty.seed.deleteFallback).mockResolvedValue({
        deleted: [],
        remaining: [],
      });
      await expect(
        deleteWithoutApi(empty.deps, ID, { ...NONE, deleteVms: true }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_UNCONFIRMED' });
      expect(empty.deps.removeDns).not.toHaveBeenCalled();
    },
  );

  it.each(['aws', 'gcp', 'azure'] as const)(
    'on %s deletes what a create that failed before its backup left, found by the cluster’s tags',
    async (cloud) => {
      const { deps, log } = world({
        cloud,
        manifest: null,
        statuses: [{ kind: 'absent' }],
      });
      const report = await deleteWithoutApi(deps, ID, {
        ...NONE,
        deleteVms: true,
        deleteBuckets: true,
      });
      expect(log).toEqual([
        'status',
        'confirm',
        'fallback',
        'status',
        'after',
        'dns',
      ]);
      expect(report).toMatchObject({
        outcome: 'destroyed',
        deleted: expect.arrayContaining([
          expect.objectContaining({
            kind: 'cloudResource',
            id: `anycloud-${ID}`,
          }),
        ]),
      });
    },
  );

  it('under --delete-vms confirms, runs the fallback, and removes DNS once the cloud shows it gone', async () => {
    const { deps, log, seed } = world({
      statuses: [deployed(true), { kind: 'absent' }],
    });
    const report = await deleteWithoutApi(deps, ID, {
      ...NONE,
      deleteVms: true,
    });
    expect(log).toEqual([
      'status',
      'confirm',
      'fallback',
      'status',
      'after',
      'dns',
    ]);
    expect(seed.deleteFallback).toHaveBeenCalledWith(ID, 'us-east-1', {
      deleteBuckets: false,
    });
    expect(report.remaining).toContainEqual(
      expect.objectContaining({
        kind: 'cloudResource',
        type: 'bucket',
        selector: `anycloud_cluster=${ID}`,
      }),
    );
    expect(report.remaining).toContainEqual(
      expect.objectContaining({ kind: 'checkpointBucket', name: ID }),
    );
  });

  it('refuses --delete-buckets alone while the stopped VM exists', async () => {
    const { deps } = world({ statuses: [deployed(true)] });
    await expect(
      deleteWithoutApi(deps, ID, { ...NONE, deleteBuckets: true }),
    ).rejects.toMatchObject({
      code: 'MANAGEMENT_VM_STOPPED',
    });
  });

  it('removes a bucket a normal delete kept, from any machine', async () => {
    const { deps, seed } = world({ statuses: [{ kind: 'absent' }] });
    const report = await deleteWithoutApi(deps, ID, {
      ...NONE,
      deleteBuckets: true,
    });
    // Only the bucket: no pool VM goes without --delete-vms.
    expect(seed.deleteFallback).not.toHaveBeenCalled();
    expect(seed.afterSelfDelete).toHaveBeenCalledWith(ID, 'us-east-1', {
      deleteBuckets: true,
    });
    // Once: the bucket-only path runs the seed's cleanup a single time.
    expect(seed.afterSelfDelete).toHaveBeenCalledTimes(1);
    expect(report.deleted).toContainEqual({
      kind: 'dnsRecord',
      name: `${ID}.anycloud.sh`,
    });
    expect(report.remaining).not.toContainEqual(
      expect.objectContaining({ kind: 'checkpointBucket' }),
    );
  });

  it('never claims to delete a supplied bucket, and reports it kept', async () => {
    const { deps } = world({ statuses: [{ kind: 'absent' }] });
    const report = await deleteWithoutApi(deps, ID, {
      ...NONE,
      deleteBuckets: true,
      checkpointBucket: 'mine',
    });
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining('mine was supplied and is never deleted'),
    );
    expect(report.remaining).toContainEqual(
      expect.objectContaining({
        kind: 'checkpointBucket',
        name: 'mine',
        reason: 'supplied',
      }),
    );
  });

  it('with --delete-vms and a supplied bucket, names only the VMs and keeps the bucket', async () => {
    const { deps } = world({ statuses: [deployed(true), { kind: 'absent' }] });
    const report = await deleteWithoutApi(deps, ID, {
      ...NONE,
      deleteVms: true,
      deleteBuckets: true,
      checkpointBucket: 'mine',
    });
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.not.stringContaining('managed checkpoint bucket'),
    );
    expect(report.remaining).toContainEqual(
      expect.objectContaining({
        kind: 'checkpointBucket',
        name: 'mine',
        reason: 'supplied',
      }),
    );
  });
});

describe('--skip-cloud', () => {
  it('deletes nothing in the cloud, removes DNS only once the cloud shows the installation gone', async () => {
    const { deps, log, seed } = world({ statuses: [{ kind: 'absent' }] });
    expect((await abandon(deps, ID)).deleted).toEqual([
      { kind: 'dnsRecord', name: `${ID}.anycloud.sh` },
    ]);
    expect(seed.deleteFallback).not.toHaveBeenCalled();
    expect(log).toEqual(['status', 'dns']);
    await expect(
      abandon(world({ statuses: [deployed(true)] }).deps, ID),
    ).rejects.toMatchObject({
      code: 'MANAGEMENT_VM_STOPPED',
    });
    expect(await abandon(null, ID)).toMatchObject({
      outcome: 'abandoned',
      remaining: [{ kind: 'dnsRecord', name: `${ID}.anycloud.sh` }],
    });
  });
});
