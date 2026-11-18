import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEPENDENCIES,
  runSeedCreate,
  SeedCreateError,
  type SeedCreateDependencies,
  type SeedCreateInput,
} from '../../../src/cli/seed/create.js';
import type { CloudSeed, SeedParams } from '../../../src/cli/seed/types.js';
import { UsageError } from '../../../src/cli/utils/lifecycle-result.js';
import {
  hostedClusterEnvironment,
  recordHostedCluster,
} from '../../../src/api/services/cluster-self-record.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  clearCatalogCache,
  readCatalog,
} from '../../../src/shared/catalog/index.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { BOOT_PLACEHOLDERS } from '../../../src/shared/management-boot.js';

const CHART = `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;

function fakeSeed(overrides: Partial<CloudSeed> = {}) {
  const deployed: SeedParams[] = [];
  const base: CloudSeed = {
    cloud: 'aws',
    discoverAccount: vi.fn(async () => ({
      account: '123456789012',
      principal: 'arn:aws:iam::123456789012:user/ops',
    })),
    checkRights: vi.fn(async () => []),
    findByName: vi.fn(async () => null),
    selfDeleteValues: vi.fn(({ clusterId }) => ({
      cloud: 'aws' as const,
      stackName: `anycloud-${clusterId}`,
      roleArn: `arn:aws:iam::123456789012:role/anycloud-${clusterId}-cfn`,
    })),
    backupValues: vi.fn(({ bucket, region }) => ({
      bucket: bucket.name,
      region,
      cloudProvider: CloudType.AWS,
      credentials: {
        kind: 'instance' as const,
        cloudProvider: CloudType.AWS as const,
      },
    })),
    deploy: vi.fn(async (params: SeedParams) => {
      deployed.push(params);
      return {
        publicIp: '203.0.113.7',
        instanceId: 'i-0abc',
        bucket: params.bucket.name,
        identity: 'arn:aws:iam::123456789012:role/vm',
      };
    }),
    status: vi.fn(async () => ({ kind: 'absent' as const })),
    readObject: vi.fn(),
    deleteFallback: vi.fn(),
    afterSelfDelete: vi.fn(),
  };
  const seed: CloudSeed = { ...base, ...overrides };
  return { seed, deployed };
}

function harness(
  options: {
    seed?: Partial<CloudSeed>;
    statuses?: Array<unknown>;
    /** Results of building the hosted API client, in order; then it succeeds. */
    connects?: Error[];
    /** Results of the 1.1.1.1 lookup, in order; then it finds the record. */
    lookups?: Array<boolean | Error>;
    e2eAccess?: boolean;
  } = {},
) {
  const { seed, deployed } = fakeSeed(options.seed);
  const events: string[] = [];
  let clock = 1_700_000_000_000;
  const statuses = [...(options.statuses ?? [])];
  const connects = [...(options.connects ?? [])];
  const lookups = [...(options.lookups ?? [])];
  const status = vi.fn(async () => {
    const next = statuses.shift() ?? {
      firstBackup: { state: 'landed', backedUpAt: 'now' },
    };
    if (next instanceof Error) throw next;
    return next;
  });
  const cluster = { id: 'cluster-from-api', name: 'production' };
  const api = {
    systemRelease: { status },
    clusters: { get: vi.fn(async () => ({ cluster })) },
  };
  const dependencies: SeedCreateDependencies = {
    resolveApiImage: vi.fn(async () => ({ digest: DIGEST, chart: CHART })),
    publish: vi.fn(async (subdomain, ip, _token, publishOptions) => {
      events.push(
        `publish ${subdomain} ${ip} ${JSON.stringify(publishOptions)}`,
      );
      return 'record-1';
    }),
    publicARecordExists: vi.fn(async () => {
      events.push('lookup');
      const next = lookups.shift() ?? true;
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    e2eAccess: options.e2eAccess ?? false,
    bootstrapCatalog: vi.fn(async () => {
      events.push('catalog');
    }),
  };
  const input: SeedCreateInput = {
    seed,
    name: 'production',
    region: 'us-east-1',
    zone: null,
    vmType: 't3.medium',
    checkpointBucket: null,
    githubToken: 'gh-token',
    owner: { id: '4242', username: 'owner' },
    version: '0.1.74',
    hostedApi: vi.fn(async () => {
      const failure = connects.shift();
      if (failure) throw failure;
      return api as never;
    }),
    progress: (message) => events.push(message),
  };
  return { seed, deployed, events, status, dependencies, input, api };
}

/** S5's boot script body, release values included, read back from its gzip+base64 heredoc. */
function bootValues(script: string): string {
  const body = /<<'ANYCLOUD_BOOT'[^\n]*\n([\s\S]*?)ANYCLOUD_BOOT\n/.exec(
    script,
  )![1]!;
  return gunzipSync(Buffer.from(body.replace(/\n/g, ''), 'base64')).toString();
}

describe('cluster create through the seed', () => {
  it('checks rights, deploys with the resolved release, publishes DNS for bootstrap, and waits for the first backup', async () => {
    const { seed, deployed, events, dependencies, input, status } = harness({
      statuses: [
        new Error('fetch failed'),
        { firstBackup: { state: 'pending', attempts: 1, lastError: null } },
      ],
    });
    const cluster = await runSeedCreate(input, dependencies);
    expect(cluster).toEqual({ id: 'cluster-from-api', name: 'production' });

    const [params] = deployed;
    const clusterId = params!.clusterId;
    expect(seed.findByName).toHaveBeenCalledWith('production', 'us-east-1');
    expect(params).toMatchObject({
      clusterName: 'production',
      region: 'us-east-1',
      vmType: 't3.medium',
      bucket: { name: clusterId, managed: true },
      tags: {
        anycloud_cluster: clusterId,
        anycloud_cluster_name: 'production',
        anycloud_owner_api: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    });
    expect(params!.releaseValues).toMatchObject({
      release: { image: `ghcr.io/anycloud-sh/api:0.1.74@${DIGEST}` },
      installation: { id: clusterId, ownerUserId: '4242' },
      selfDelete: { cloud: 'aws', stackName: `anycloud-${clusterId}` },
      backup: {
        bucket: clusterId,
        credentials: { kind: 'instance' },
        account: '123456789012',
        target: {
          name: 'production',
          region: 'us-east-1',
          vmType: 't3.medium',
        },
      },
    });
    expect(params!.releaseValues).not.toHaveProperty('e2e');
    expect(params!.releaseValues).not.toHaveProperty('e2eAccess');
    expect(bootValues(params!.startupScript)).not.toContain('e2e-access');
    // The boot script carries those values, selfDelete included.
    expect(bootValues(params!.startupScript)).toContain(
      `anycloud-${clusterId}-cfn`,
    );

    // DNS only once the VM's address is known, marked for bootstrap; the
    // first lookup waits out Cloudflare's propagation.
    const publish = events.findIndex((event) => event.startsWith('publish'));
    expect(events[publish]).toBe(
      `publish ${clusterId} 203.0.113.7 {"proxied":true,"bootstrap":true}`,
    );
    expect(events.indexOf('lookup')).toBeGreaterThan(publish);
    expect(dependencies.sleep).toHaveBeenCalledWith(10_000, undefined);
    // An API that doesn't answer yet, then a pending backup, then landed.
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('refuses a resume without the --checkpoint-bucket the installation backs up to', async () => {
    const { dependencies, input, seed } = harness({
      seed: {
        findByName: vi.fn(async () => 'production-held-1'),
        status: vi.fn(async () => ({
          kind: 'deployed' as const,
          stopped: false,
          outputs: {
            publicIp: '203.0.113.7',
            instanceId: 'i-0abc',
            bucket: 'my-api-state',
            identity: 'role',
          },
        })),
      },
    });
    const refusal = await runSeedCreate(input, dependencies).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(UsageError);
    expect(String((refusal as Error).message)).toContain(
      '--checkpoint-bucket my-api-state',
    );
    expect(seed.deploy).not.toHaveBeenCalled();
  });

  it('resumes the installation the cloud already holds under the name', async () => {
    const { deployed, dependencies, input } = harness({
      seed: {
        findByName: vi.fn(async () => 'production-held-1'),
        status: vi.fn(async () => ({
          kind: 'deployed' as const,
          stopped: false,
          outputs: {
            publicIp: '203.0.113.7',
            instanceId: 'i-0abc',
            bucket: 'production-held-1',
            identity: 'role',
          },
        })),
      },
    });
    await runSeedCreate(input, dependencies);
    expect(deployed[0]!.clusterId).toBe('production-held-1');
    // A resume never creates the bucket the installation already holds, even
    // after a restore into it; it stays managed.
    expect(deployed[0]!.bucket).toEqual({
      name: 'production-held-1',
      managed: true,
      exists: true,
    });
    expect(
      (
        deployed[0]!.releaseValues.cluster as {
          record: { checkpointBucket: unknown };
        }
      ).record.checkpointBucket,
    ).toEqual({ name: 'production-held-1', managed: true });
  });

  it('creates the managed bucket on a resume of an installation still deploying, which may not hold it yet', async () => {
    const { deployed, dependencies, input } = harness({
      seed: {
        findByName: vi.fn(async () => 'production-held-1'),
        status: vi.fn(async () => ({
          kind: 'in-progress' as const,
          detail: 'CREATE_IN_PROGRESS',
        })),
      },
    });
    await runSeedCreate(input, dependencies);
    expect(deployed[0]!.bucket).toEqual({
      name: 'production-held-1',
      managed: true,
    });
  });

  it('refuses a resume whose --checkpoint-bucket names another bucket than the installation backs up to', async () => {
    for (const [held, flag, hint] of [
      [
        'production-held-1',
        'other-bucket',
        '--checkpoint-bucket production-held-1, or without the flag',
      ],
      ['bucket-a', 'bucket-b', '--checkpoint-bucket bucket-a'],
    ] as const) {
      const { dependencies, input, seed } = harness({
        seed: {
          findByName: vi.fn(async () => 'production-held-1'),
          readObject: vi.fn(async () => null),
          status: vi.fn(async () => ({
            kind: 'deployed' as const,
            stopped: false,
            outputs: {
              publicIp: '203.0.113.7',
              instanceId: 'i-0abc',
              bucket: held,
              identity: 'role',
            },
          })),
        },
      });
      input.checkpointBucket = flag;
      const refusal = await runSeedCreate(input, dependencies).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(UsageError);
      expect(String((refusal as Error).message)).toContain(hint);
      expect(seed.deploy).not.toHaveBeenCalled();
    }
  });

  it("keeps the cluster's own managed bucket managed when it is passed back before any backup", async () => {
    const { deployed, dependencies, input } = harness({
      seed: {
        findByName: vi.fn(async () => 'production-held-1'),
        readObject: vi.fn(async () => null),
        status: vi.fn(async () => ({
          kind: 'deployed' as const,
          stopped: false,
          outputs: {
            publicIp: '203.0.113.7',
            instanceId: 'i-0abc',
            bucket: 'production-held-1',
            identity: 'role',
          },
        })),
      },
    });
    input.checkpointBucket = 'production-held-1';
    await runSeedCreate(input, dependencies);
    const params = deployed[0]!;
    expect(params.bucket).toEqual({
      name: 'production-held-1',
      managed: true,
      exists: true,
    });
    expect(
      (
        params.releaseValues.cluster as {
          record: { checkpointBucket: unknown };
        }
      ).record.checkpointBucket,
    ).toEqual({ name: 'production-held-1', managed: true });
  });

  it('refuses before anything is bought when the caller lacks a right, and goes on when the cloud cannot say', async () => {
    const missing = harness({
      seed: { checkRights: vi.fn(async () => ['ec2:RunInstances']) },
    });
    const refusal = await runSeedCreate(
      missing.input,
      missing.dependencies,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SeedCreateError);
    expect(refusal).toMatchObject({ code: 'CLOUD_RIGHTS_MISSING' });
    expect(String((refusal as Error).message)).toContain('ec2:RunInstances');
    expect(missing.seed.deploy).not.toHaveBeenCalled();

    const unknown = harness({ seed: { checkRights: vi.fn(async () => null) } });
    await runSeedCreate(unknown.input, unknown.dependencies);
    expect(unknown.seed.deploy).toHaveBeenCalled();
  });

  it('keeps waiting through failed lookups and a client that cannot reach the API yet', async () => {
    const { dependencies, input, status } = harness({
      lookups: [new Error('1.1.1.1 timed out'), false],
      // Building the client exchanges a token: it fails while the VM boots.
      connects: [new Error('ORPCError 521'), new Error('ORPCError 521')],
    });
    await runSeedCreate(input, dependencies);
    expect(dependencies.publicARecordExists).toHaveBeenCalledTimes(3);
    expect(input.hostedApi).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client after a refused call, since a client keeps its first bearer', async () => {
    const { dependencies, input, status } = harness({
      statuses: [new Error('401 Unauthorized')],
    });
    await runSeedCreate(input, dependencies);
    expect(input.hostedApi).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("fails with the first backup's error, when it stalls, and when the API never answers", async () => {
    const failed = harness({
      statuses: [
        {
          firstBackup: {
            state: 'failed',
            lastError: 'AccessDenied on PutObject',
          },
        },
      ],
    });
    await expect(
      runSeedCreate(failed.input, failed.dependencies),
    ).rejects.toMatchObject({
      code: 'FIRST_BACKUP_FAILED',
      message: expect.stringContaining('AccessDenied on PutObject'),
    });

    const stalled = harness({
      statuses: Array.from({ length: 400 }, () => ({
        firstBackup: { state: 'pending', attempts: 1, lastError: null },
      })),
    });
    await expect(
      runSeedCreate(stalled.input, stalled.dependencies),
    ).rejects.toMatchObject({ code: 'FIRST_BACKUP_FAILED' });

    const silent = harness({
      connects: Array.from({ length: 400 }, () => new Error('ORPCError 521')),
    });
    await expect(
      runSeedCreate(silent.input, silent.dependencies),
    ).rejects.toMatchObject({ code: 'API_NOT_READY' });
  });

  it('turns on the e2e access hand-off in both the chart values and the startup script, together', async () => {
    const armed = harness({ e2eAccess: true });
    await runSeedCreate(armed.input, armed.dependencies);
    const [params] = armed.deployed;
    expect(params!.releaseValues.e2eAccess).toBe(true);
    expect(bootValues(params!.startupScript)).toContain(
      '/var/lib/anycloud/e2e-access/kubeconfig',
    );
  });

  it('fills the cluster record, which the hosted API keeps for cluster status once the VM names itself', async () => {
    const { deployed, dependencies, input } = harness();
    await runSeedCreate(input, dependencies);
    const params = deployed[0]!;
    const clusterId = params.clusterId;
    const cluster = params.releaseValues.cluster as {
      record: Record<string, unknown>;
    };
    expect(cluster.record).toEqual({
      cloudProvider: CloudType.AWS,
      cloudAccount: '123456789012',
      region: 'us-east-1',
      zone: null,
      vmType: 't3.medium',
      managementVmId: BOOT_PLACEHOLDERS.managementVmId,
      networkScope: `anycloud-cluster-${clusterId}`,
      k3s: { version: expect.any(String), sha256: expect.any(String) },
      checkpointBucket: { name: clusterId, managed: true },
    });

    // The boot script fills the placeholders; the API's chart env then
    // carries the record, which it keeps on its own row.
    resetPersistence();
    const record = JSON.stringify(cluster.record).replace(
      BOOT_PLACEHOLDERS.managementVmId,
      'i-0abc',
    );
    await recordHostedCluster({
      clusterId,
      ownerUserId: '4242',
      environment: hostedClusterEnvironment({
        name: 'production',
        kubernetesIdentity: 'uid-1',
        joinEndpoint: 'https://203.0.113.7:6443',
        certificateAuthorityData: 'Y2E=',
        record,
      }),
      installations: getPersistence().clusters,
      observeKubernetesIdentity: async () => 'uid-1',
    });
    const kept = await getPersistence().clusterRecords.getForScope(clusterId, {
      kind: 'api',
    });
    expect(kept?.record).toMatchObject({
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      managementVmId: 'i-0abc',
    });
  });

  describe('restore through --checkpoint-bucket', () => {
    const manifest = (fields: Record<string, unknown> = {}) =>
      JSON.stringify({
        version: 1,
        clusterId: 'production-old-1',
        backedUpAt: '2026-11-07T00:00:00.000Z',
        schemaAppVersion: '0.1.74',
        databaseSha256: 'f'.repeat(64),
        cloud: 'aws',
        account: '123456789012',
        region: 'us-east-1',
        ...fields,
      });

    it("restores under the backup's cluster ID into the supplied bucket once the old VM is gone", async () => {
      const { deployed, events, dependencies, input, seed } = harness({
        seed: {
          readObject: vi.fn(async () => manifest()),
          status: vi.fn(async () => ({ kind: 'absent' as const })),
        },
      });
      input.checkpointBucket = 'my-api-state';
      await runSeedCreate(input, dependencies);
      expect(seed.readObject).toHaveBeenCalledWith(
        'my-api-state',
        'anycloud-api/backup.json',
        'us-east-1',
      );
      expect(seed.status).toHaveBeenCalledWith('production-old-1', 'us-east-1');
      const params = deployed[0]!;
      expect(params.clusterId).toBe('production-old-1');
      expect(params.bucket).toEqual({ name: 'my-api-state', managed: false });
      expect(params.releaseValues).toMatchObject({
        installation: { id: 'production-old-1' },
        backup: { bucket: 'my-api-state' },
        state: { restoreFromBackup: true },
      });
      expect(events).toContain(
        'publish production-old-1 203.0.113.7 {"proxied":true,"bootstrap":true}',
      );
    });

    it('refuses another account, a backup without one, a newer API, another cluster under the name, and an old VM that still exists, before anything is bought', async () => {
      for (const [readObject, named, status, refusal] of [
        [
          manifest({ schemaAppVersion: '0.2.0' }),
          null,
          { kind: 'absent' },
          /written by anycloud 0\.2\.0, newer than this CLI \(0\.1\.74\); run anycloud update/,
        ],
        [
          manifest(),
          'production-other-2',
          { kind: 'absent' },
          /already exists as production-other-2/,
        ],
        [
          manifest(),
          null,
          { kind: 'failed', detail: 'DELETE_FAILED' },
          /is broken \(DELETE_FAILED\)/,
        ],
      ] as const) {
        const { dependencies, input, seed } = harness({
          seed: {
            readObject: vi.fn(async () => readObject),
            findByName: vi.fn(async () => named),
            status: vi.fn(async () => status),
          },
        });
        input.checkpointBucket = 'my-api-state';
        await expect(runSeedCreate(input, dependencies)).rejects.toMatchObject({
          code: 'RESTORE_REFUSED',
          message: expect.stringMatching(refusal),
        });
        expect(seed.deploy).not.toHaveBeenCalled();
      }
      for (const [readObject, status, refusal] of [
        [
          manifest({ account: '999999999999' }),
          'absent',
          /sign in to 999999999999/,
        ],
        [
          manifest({ cloud: undefined }),
          'absent',
          /records no cloud \(backup.json's "cloud"\)/,
        ],
        [manifest(), 'stopped', /has a stopped management VM/],
        [manifest(), 'running', /still runs/],
        ['{', 'absent', /backup\.json is malformed/],
      ] as const) {
        const { dependencies, input, seed } = harness({
          seed: {
            readObject: vi.fn(async () => readObject),
            status: vi.fn(async () =>
              status === 'absent'
                ? ({ kind: 'absent' } as const)
                : ({
                    kind: 'deployed',
                    stopped: status === 'stopped',
                    outputs: {
                      publicIp: '203.0.113.9',
                      instanceId: 'i-old',
                      bucket: 'my-api-state',
                      identity: 'role',
                    },
                  } as const),
            ),
          },
        });
        input.checkpointBucket = 'my-api-state';
        await expect(runSeedCreate(input, dependencies)).rejects.toMatchObject({
          code: 'RESTORE_REFUSED',
          message: expect.stringMatching(refusal),
        });
        expect(seed.deploy).not.toHaveBeenCalled();
      }
    });

    const running = {
      kind: 'deployed',
      stopped: false,
      outputs: {
        publicIp: '203.0.113.7',
        instanceId: 'i-0abc',
        bucket: 'my-api-state',
        identity: 'role',
      },
    } as const;

    it("resumes the running or still-deploying installation the name holds under the backup's ID", async () => {
      for (const status of [
        running,
        { kind: 'in-progress', detail: 'CREATE_IN_PROGRESS' } as const,
      ]) {
        const { deployed, dependencies, input, seed, events } = harness({
          seed: {
            readObject: vi.fn(async () => manifest()),
            findByName: vi.fn(async () => 'production-old-1'),
            status: vi.fn(async () => status),
          },
        });
        input.checkpointBucket = 'my-api-state';
        await runSeedCreate(input, dependencies);
        expect(seed.status).toHaveBeenCalledWith(
          'production-old-1',
          'us-east-1',
        );
        expect(deployed[0]!.clusterId).toBe('production-old-1');
        expect(events).toContain(
          'Resuming cluster production (ID: production-old-1)',
        );
        // Restore fills only an empty state volume, so a resume over a
        // running API leaves its database alone.
        expect(deployed[0]!.releaseValues).toMatchObject({
          state: { restoreFromBackup: true },
        });
      }
    });

    it('refuses to resume an installation whose VM is stopped or gone, which a deploy would adopt without a VM', async () => {
      for (const [status, refusal] of [
        [{ ...running, stopped: true }, /has a stopped management VM/],
        [
          { kind: 'failed', detail: 'management VM i-0abc is gone' },
          /is broken \(management VM i-0abc is gone\); delete it/,
        ],
      ] as const) {
        const { dependencies, input, seed } = harness({
          seed: {
            // The backup came from another region: the installation this
            // name holds is looked up where the name was found.
            readObject: vi.fn(async () => manifest({ region: 'us-west-2' })),
            findByName: vi.fn(async () => 'production-old-1'),
            status: vi.fn(async () => status),
          },
        });
        input.checkpointBucket = 'my-api-state';
        await expect(runSeedCreate(input, dependencies)).rejects.toMatchObject({
          code: 'RESTORE_REFUSED',
          message: expect.stringMatching(refusal),
        });
        expect(seed.status).toHaveBeenCalledWith(
          'production-old-1',
          'us-east-1',
        );
        expect(seed.deploy).not.toHaveBeenCalled();
      }
    });

    it("refuses while another installation under the backup's ID is still changing", async () => {
      const { dependencies, input, seed } = harness({
        seed: {
          readObject: vi.fn(async () => manifest()),
          status: vi.fn(async () => ({
            kind: 'in-progress' as const,
            detail: 'DELETE_IN_PROGRESS',
          })),
        },
      });
      input.checkpointBucket = 'my-api-state';
      await expect(runSeedCreate(input, dependencies)).rejects.toMatchObject({
        code: 'RESTORE_REFUSED',
        message: expect.stringMatching(
          /still changing \(DELETE_IN_PROGRESS\); wait/,
        ),
      });
      expect(seed.deploy).not.toHaveBeenCalled();
    });

    it('keeps managing the bucket Anycloud made for the cluster, without creating it again', async () => {
      const { deployed, dependencies, input } = harness({
        seed: {
          readObject: vi.fn(async () => manifest()),
          status: vi.fn(async () => ({ kind: 'absent' as const })),
        },
      });
      input.checkpointBucket = 'production-old-1';
      await runSeedCreate(input, dependencies);
      const params = deployed[0]!;
      expect(params.bucket).toEqual({
        name: 'production-old-1',
        managed: true,
        exists: true,
      });
      expect(
        (
          params.releaseValues.cluster as {
            record: { checkpointBucket: unknown };
          }
        ).record.checkpointBucket,
      ).toEqual({ name: 'production-old-1', managed: true });
    });

    it('creates normally in a supplied bucket that holds no backup', async () => {
      const { deployed, dependencies, input } = harness({
        seed: { readObject: vi.fn(async () => null) },
      });
      input.checkpointBucket = 'my-api-state';
      await runSeedCreate(input, dependencies);
      expect(deployed[0]!.releaseValues).toMatchObject({
        state: { restoreFromBackup: false },
      });
      expect(deployed[0]!.clusterId).not.toBe('production-old-1');
    });
  });

  it("downloads the session cloud's catalog into an empty catalog dir before the seed reads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-catalog-'));
    vi.stubEnv('ANYCLOUD_DIR', dir);
    clearCatalogCache();
    const csv = `InstanceType,vCPUs,MemoryGiB,AcceleratorName,AcceleratorCount,GpuInfo,Region,AvailabilityZone,Price,SpotPrice
e2-standard-2,2.0,8.0,,,,us-central1,us-central1-a,0.067,0.02`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(csv)),
    );
    try {
      let seen: unknown;
      const { dependencies, input } = harness({
        seed: {
          cloud: 'gcp',
          checkRights: vi.fn(async () => {
            // GCP's catalog is indexed by zone.
            seen = readCatalog(CloudType.GCP)?.typesPerRegion['us-central1-a'];
            return [];
          }),
        },
      });
      const events: string[] = [];
      input.progress = (message) => events.push(message);
      await runSeedCreate(input, {
        ...dependencies,
        bootstrapCatalog: DEFAULT_DEPENDENCIES.bootstrapCatalog,
      });
      expect(seen).toContain('e2-standard-2');
      expect(events[0]).toBe('First run: downloading the GCP catalog');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      clearCatalogCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bootstraps the catalog before the rights check and the deploy, on every cloud', async () => {
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      const { events, dependencies, input, seed } = harness({
        seed: { cloud },
      });
      (seed.checkRights as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          events.push('rights');
          return [];
        },
      );
      await runSeedCreate(input, dependencies);
      expect(dependencies.bootstrapCatalog).toHaveBeenCalledWith(
        { aws: CloudType.AWS, gcp: CloudType.GCP, azure: CloudType.Azure }[
          cloud
        ],
        input.progress,
      );
      expect(events.indexOf('catalog')).toBeLessThan(events.indexOf('rights'));
    }
  });
});
