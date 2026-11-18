import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  JOB_NATIVE_CREDENTIALS,
  jobNativeSessionFixture,
} from '../helpers/e2e-job-native.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import type { JobBucketRef } from '../integration/e2e/internal/job-cloud-storage.js';
import type { JobRecoveryIdentity } from '../integration/e2e/internal/targets/job-types.js';
import type { JobNativeBucketObservation } from '../integration/e2e/internal/transports/job-bucket-native.js';
import type { TargetHttpOptions } from '../integration/e2e/internal/transports/http.js';
import { JobHydrationTransport } from '../integration/e2e/internal/transports/job-hydration.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';
import { Waiter } from '../integration/e2e/internal/wait.js';

const directories: string[] = [];
const id = 'job-hydration-owned';
const apiId = 'a'.repeat(64);
const shardBytes = 128 * 1024 * 1024;
const identity: JobRecoveryIdentity = {
  cloudId: 'i-123abc',
  vmId: 'vm-original',
  osDiskId: 'vol-456def',
  region: 'us-east-1',
  zone: 'us-east-1a',
  vmType: 't3.large',
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function commandResult(
  stdout: string,
  changes: Partial<CommandResult> = {},
): CommandResult {
  return {
    executable: 'ssh',
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    combined: stdout,
    durationMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...changes,
  };
}

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'job-hydration-transport-'),
  );
  directories.push(directory);
  const input = Object.freeze({ name: 'job-owned-input' }) as JobBucketRef;
  const output = Object.freeze({ name: 'job-owned-output' }) as JobBucketRef;
  const receipt: Record<string, unknown> = {
    bucket: input.name,
    region: 'us-east-1',
    objects: 2049,
    bytes: 2049 * shardBytes,
    shardCount: 2048,
    shardBytes,
  };
  const nodeResult: Partial<CommandResult> = {};
  const remoteResult: Partial<CommandResult> = {};
  const disk: Record<string, unknown> = {
    Volumes: [
      {
        VolumeId: identity.osDiskId,
        AvailabilityZone: identity.zone,
        VolumeType: 'gp3',
        Iops: 3000,
        Throughput: 125,
        Size: 350,
        Attachments: [{ InstanceId: identity.cloudId, State: 'attached' }],
      },
    ],
  };
  const state = {
    containerId: apiId,
    running: 'true',
    controllerChanged: false,
    receipt,
    nodeResult,
    remote: `active|${'b'.repeat(32)}|123|${'c'.repeat(64)}|4096`,
    remoteResult,
    logs: '',
    disk,
    bucketPresent: true,
    health: 200,
    afterHealth: undefined as (() => void) | undefined,
  };
  const native = jobNativeSessionFixture(
    JOB_NATIVE_CREDENTIALS.aws,
    (executable, args) => {
      if (executable === 'node')
        return commandResult(JSON.stringify(state.receipt), state.nodeResult);
      if (executable === 'aws' && args[1] === 'describe-volumes')
        return JSON.stringify(state.disk);
      if (executable === 'docker' && args[0] === 'inspect')
        return args[2] === '{{.Id}}' ? state.containerId : state.running;
      if (executable === 'docker' && args[0] === 'logs')
        return commandResult('', { stderr: state.logs, combined: state.logs });
      if (executable === 'docker' && args[0] === 'start') {
        state.running = 'true';
        return apiId;
      }
      throw new Error(
        `Unexpected hydration native operation: ${executable} ${args[0]}`,
      );
    },
  );
  const records: Array<{ name: string; body: unknown }> = [];
  const observe = vi.fn(
    async (bucket: JobBucketRef): Promise<JobNativeBucketObservation> =>
      state.bucketPresent
        ? {
            presence: 'present',
            identity: {
              name: bucket.name,
              scope: '123456789012',
              provider: 'aws',
              nativeId: `arn:aws:s3:::${bucket.name}`,
              region: 'us-east-1',
              ownerApi: 'a'.repeat(32),
              ownerUser: 'test-user',
              workloadId: id,
              createdAt: Date.now(),
            },
          }
        : { presence: 'absent', name: bucket.name, scope: '123456789012' },
  );
  const readText = vi.fn(async () => 'owned-manifest');
  const remote = vi.fn(async () =>
    commandResult(state.remote, state.remoteResult),
  );
  const restart = vi.fn(async () => ({
    identityBefore: apiId,
    identityAfter: apiId,
  }));
  const health = vi.fn(
    async (_label: string, _url: URL, _options?: TargetHttpOptions) => {
      state.afterHealth?.();
      return { status: state.health, body: null };
    },
  );
  const probe = new JobHydrationTransport({
    id,
    region: 'us-east-1',
    apiUrl: 'http://original.invalid',
    assertController: () => {
      if (state.controllerChanged)
        throw new Error('original controller changed');
    },
    input,
    output,
    storage: { observe, readText },
    session: native.session,
    commands: native.commands,
    cleanupCommands: native.cleanupCommands,
    apiRestarter: { restart },
    cleanupHttp: { get: health },
    cleanupWait: new Waiter(native.cleanup.signal),
    remote: { run: remote },
    files: new FixtureFiles(directory),
    artifacts: {
      json: async (name, body) => {
        records.push({ name, body });
        return name;
      },
    },
  });
  return {
    directory,
    input,
    output,
    state,
    native,
    records,
    observe,
    readText,
    remote,
    restart,
    health,
    probe,
  };
}

describe('AWS Job hydration native observations', () => {
  test('prepares the real private 128 MiB seed, all 2048 shards and original-account copy intent', async () => {
    vi.stubEnv('AWS_SESSION_TOKEN', 'unrelated-ambient-session');
    const h = await fixture();
    const result = await h.probe.prepareInput(Date.now() + 30_000);
    const seed = path.join(h.directory, `job-hydration-${id}`, 'seed.bin');
    const details = await stat(seed);
    expect(details.size).toBe(shardBytes);
    expect(details.mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(seed))).mode & 0o777).toBe(0o700);
    expect(result).toMatchObject({
      seedSha256: createHash('sha256')
        .update(await readFile(seed))
        .digest('hex'),
      apiContainerId: apiId,
      objects: 2049,
      bytes: 2049 * shardBytes,
    });
    expect(result.command).toContain('/mnt/input/shards/1024.bin');
    const copy = h.native.calls.find((call) => call.executable === 'node');
    expect(copy?.args[0]).toMatch(/fixtures\/job-input-hydration-copy\.mjs$/u);
    expect(copy?.options).toMatchObject({
      recordArtifact: false,
      env: {
        AWS_ACCESS_KEY_ID: 'original-access',
        AWS_SECRET_ACCESS_KEY: 'private-original-aws',
        AWS_SESSION_TOKEN: undefined,
        AWS_FIXTURE_ACCOUNT: '123456789012',
        AWS_FIXTURE_BUCKET: h.input.name,
        AWS_FIXTURE_REGION: 'us-east-1',
        AWS_FIXTURE_SEED_FILE: seed,
        AWS_FIXTURE_SHARDS: '2048',
        AWS_FIXTURE_SHARD_BYTES: String(shardBytes),
      },
    });
    expect(h.observe).toHaveBeenCalledWith(h.input, expect.any(Number));
    expect(JSON.stringify(h.records)).not.toContain('private-original-aws');
    await expect(h.probe.prepareInput(Date.now() + 30_000)).rejects.toThrow(
      'replayed',
    );
    expect(
      h.native.calls.filter((call) => call.executable === 'node'),
    ).toHaveLength(1);
  });

  test.each([
    { objects: 2048 },
    { bytes: 2048 * shardBytes },
    { bucket: 'foreign-bucket' },
    { region: 'us-west-2' },
    { shardCount: 2 },
    { shardBytes: 1 },
    { extra: 'untrusted' },
  ])('rejects incomplete or foreign copy readback %j', async (changes) => {
    const h = await fixture();
    Object.assign(h.state.receipt, changes);
    await expect(h.probe.prepareInput(Date.now() + 30_000)).rejects.toThrow(
      'all real 256 GiB',
    );
    expect(h.records).toEqual([]);
    expect(h.restart).not.toHaveBeenCalled();
  });

  test('refuses truncated success without recording fixture completion', async () => {
    const h = await fixture();
    h.state.nodeResult = { outputTruncated: true };
    await expect(h.probe.prepareInput(Date.now() + 30_000)).rejects.toThrow(
      'truncated=true',
    );
    expect(h.records).toEqual([]);
  });

  test.each(['short', '', 'A'.repeat(64)])(
    'refuses an invalid controller identity before fixture mutation: %j',
    async (containerId) => {
      const h = await fixture();
      h.state.containerId = containerId;
      await expect(h.probe.prepareInput(Date.now() + 5_000)).rejects.toThrow(
        'identity is malformed',
      );
      expect(
        h.native.calls.filter((call) => call.executable === 'node'),
      ).toEqual([]);
      expect(h.observe).not.toHaveBeenCalled();
    },
  );

  test('reads only the owned worker and suppresses raw remote output', async () => {
    const h = await fixture();
    await expect(h.probe.snapshot(Date.now() + 5_000)).resolves.toMatchObject({
      active: true,
      invocation: 'b'.repeat(32),
      pid: 123,
      identity: 'c'.repeat(64),
      logBytes: 4096,
    });
    expect(h.remote).toHaveBeenCalledWith(
      id,
      'vm',
      expect.stringContaining(`ac-input-${id}`),
      {
        recordArtifact: false,
        timeoutMs: expect.any(Number),
      },
    );
    expect(h.records).toEqual([]);
  });

  test.each([
    'active|bad|1||0',
    'alien||0||0',
    'active||-1||0',
    'active||1||-1',
    'active||1|bad|0',
    'active||1||1.5',
    'active||1||9007199254740992',
    'active||1||0|extra',
  ])('rejects malformed worker receipts: %s', async (receipt) => {
    const h = await fixture();
    h.state.remote = receipt;
    await expect(h.probe.snapshot(Date.now() + 5_000)).rejects.toThrow();
  });

  test.each([
    { outputTruncated: true },
    { exitCode: 1 },
    { timedOut: true },
    { aborted: true },
  ])('rejects partial remote receipts %j', async (changes) => {
    const h = await fixture();
    h.state.remoteResult = changes;
    await expect(h.probe.snapshot(Date.now() + 5_000)).rejects.toThrow(
      'Job private command failed',
    );
  });

  test('binds disk placement and attachment to the original native VM and original AWS account', async () => {
    const h = await fixture();
    await expect(h.probe.disk(identity, Date.now() + 5_000)).resolves.toEqual({
      id: identity.osDiskId,
      type: 'gp3',
      iops: 3000,
      throughput: 125,
      sizeGb: 350,
    });
    const call = h.native.calls.find(
      (item) => item.args[1] === 'describe-volumes',
    );
    expect(call?.args).toEqual([
      'ec2',
      'describe-volumes',
      '--volume-ids',
      identity.osDiskId,
      '--no-paginate',
      '--region',
      'us-east-1',
      '--endpoint-url',
      'https://ec2.us-east-1.amazonaws.com',
      '--output',
      'json',
      '--no-cli-pager',
    ]);
    expect(call?.options?.env?.AWS_ACCESS_KEY_ID).toBe('original-access');
    await expect(
      h.probe.disk({ ...identity, region: 'us-west-2' }, Date.now() + 5_000),
    ).rejects.toThrow('original placement');
  });

  test.each([
    { NextToken: 'more', Volumes: [] },
    { Volumes: [] },
    { Volumes: [{ VolumeId: 'vol-foreign' }] },
  ])('rejects partial or foreign disk inventories %j', async (disk) => {
    const h = await fixture();
    h.state.disk = disk;
    await expect(h.probe.disk(identity, Date.now() + 5_000)).rejects.toThrow();
  });

  test.each([
    { AvailabilityZone: 'us-east-1b' },
    { Iops: '3000' },
    { Throughput: 1.5 },
    { Attachments: [{ InstanceId: 'i-foreign', State: 'attached' }] },
    { Attachments: [{ InstanceId: identity.cloudId, State: 'detaching' }] },
  ])('rejects mismatched disk evidence %j', async (changes) => {
    const h = await fixture();
    const volumes = h.state.disk.Volumes as Record<string, unknown>[];
    Object.assign(volumes[0], changes);
    await expect(h.probe.disk(identity, Date.now() + 5_000)).rejects.toThrow(
      'identity or profile',
    );
  });

  test('hides only the owned activity log once and parses observed byte counts strictly', async () => {
    const h = await fixture();
    h.state.remote = '0|8192';
    await expect(h.probe.hideActivity()).resolves.toMatchObject({
      visibleBytes: 0,
      hiddenBytes: 8192,
    });
    expect(h.remote).toHaveBeenCalledWith(
      id,
      'vm',
      expect.stringContaining(`chmod 600 '/tmp/ac-input-${id}.log'`),
      expect.objectContaining({ recordArtifact: false }),
    );
    await expect(h.probe.hideActivity()).rejects.toThrow('replayed');
    h.state.remote = '0|-1';
    await expect(h.probe.activity(Date.now() + 5_000)).rejects.toThrow(
      'invalid integer',
    );
  });

  test('requires the owned output bucket before reading its manifest', async () => {
    const h = await fixture();
    await expect(h.probe.manifest(Date.now() + 5_000)).resolves.toBe(
      'owned-manifest',
    );
    expect(h.readText).toHaveBeenCalledWith(
      h.output,
      'manifest.txt',
      expect.any(Number),
    );
    h.state.bucketPresent = false;
    h.readText.mockClear();
    await expect(h.probe.manifest(Date.now() + 5_000)).resolves.toBeUndefined();
    expect(h.readText).not.toHaveBeenCalled();
  });
});

describe('Job hydration original API rescue', () => {
  test('requires an armed original identity and counts only owned stderr lifecycle logs', async () => {
    const h = await fixture();
    await expect(h.probe.restart()).rejects.toThrow(
      'original armed controller',
    );
    expect(h.restart).not.toHaveBeenCalled();
    await h.probe.prepareInput(Date.now() + 30_000);
    const cleanup = new CleanupStack();
    h.probe.armApiRescue(cleanup, 5_000);
    expect(() => h.probe.armApiRescue(cleanup, 5_000)).toThrow('reused');
    h.state.logs = `${id} Launched detached VM command\n${id} Adopted detached VM command\nother-job Launched detached VM command`;
    await expect(h.probe.apiLogs(Date.now() + 5_000)).resolves.toEqual({
      launched: 1,
      adopted: 1,
    });
    await expect(h.probe.restart()).resolves.toEqual({
      identityBefore: apiId,
      identityAfter: apiId,
    });
    await expect(h.probe.restart()).rejects.toThrow(
      'original armed controller',
    );
    expect(h.restart).toHaveBeenCalledOnce();
  });

  test('restores the same killed API in independent cleanup before Workload cleanup after cancellation', async () => {
    const h = await fixture();
    await h.probe.prepareInput(Date.now() + 30_000);
    const cleanup = new CleanupStack();
    cleanup.defer('workload', async () => {
      expect(h.state.running).toBe('true');
      expect(h.records.at(-1)?.name).toBe(`job-${id}-hydration-api-cleanup`);
    });
    h.probe.armApiRescue(cleanup, 5_000);
    h.restart.mockImplementationOnce(async () => {
      h.state.running = 'false';
      throw new Error('restart reply lost after kill');
    });
    await expect(h.probe.restart()).rejects.toThrow('reply lost');
    h.native.foreground.abort();
    await cleanup.run();
    expect(
      h.native.calls
        .filter((call) => call.args[0] === 'start')
        .map((call) => call.args),
    ).toEqual([['start', apiId]]);
    const [, url, options] = h.health.mock.calls[0];
    expect(url.toString()).toBe('http://original.invalid/health');
    expect(options).toMatchObject({ redirect: 'error', timeoutMs: 30_000 });
    expect(options?.signal?.aborted).toBe(false);
    expect(options?.deadlineAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(cleanup.observations().every((entry) => entry.completed)).toBe(true);
  });

  test.each([
    'container',
    'endpoint',
    'state',
    'health',
    'after-readback',
  ] as const)(
    'retains uncertain API cleanup when %s is no longer authoritative',
    async (fault) => {
      const h = await fixture();
      await h.probe.prepareInput(Date.now() + 30_000);
      const cleanup = new CleanupStack();
      h.probe.armApiRescue(cleanup, 5_000);
      if (fault === 'container') h.state.containerId = 'd'.repeat(64);
      if (fault === 'endpoint') h.state.controllerChanged = true;
      if (fault === 'state') h.state.running = 'unknown';
      if (fault === 'health') h.state.health = 401;
      if (fault === 'after-readback')
        h.state.afterHealth = () => {
          h.state.containerId = 'd'.repeat(64);
        };
      await expect(cleanup.run()).rejects.toThrow('E2E cleanup failed');
      expect(cleanup.observations()).toEqual([
        { label: `job-${id}-hydration-api`, completed: false },
      ]);
      expect(
        h.records.some((record) => record.name.endsWith('-api-cleanup')),
      ).toBe(false);
      expect(h.native.calls.some((call) => call.args[0] === 'start')).toBe(
        false,
      );
    },
  );

  test('does not start a cleanup mutation after the remaining deadline expires', async () => {
    const h = await fixture();
    await h.probe.prepareInput(Date.now() + 30_000);
    const cleanup = new CleanupStack();
    h.probe.armApiRescue(cleanup, 5_000);
    h.state.running = 'false';
    const before = h.native.calls.length;
    await expect(h.probe.finish(Date.now() - 1)).rejects.toThrow(
      'deadline expired',
    );
    expect(h.native.calls).toHaveLength(before);
    expect(cleanup.observations()[0].completed).toBe(false);
  });
});
