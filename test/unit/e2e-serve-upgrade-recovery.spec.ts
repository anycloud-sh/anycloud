import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, onTestFinished, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import {
  SERVICE_CHECKPOINT_MARKER_FILE,
  ServiceUpgradeRecoveryProbe,
} from '../integration/e2e/internal/probes/serve-upgrade-recovery.js';
import { RemoteExecutor } from '../integration/e2e/internal/remote.js';
import { ApiClient } from '../integration/e2e/internal/api.js';
import { createE2ELifecycle } from '../integration/e2e/internal/context.js';
import { ServeUpgradeContract } from '../integration/e2e/internal/contracts/serve-upgrade.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import type {
  CommandResult,
  WorkloadStatusLookup,
} from '../integration/e2e/internal/types.js';
import { cloudHostStatusForTest } from './helpers/cloud-kubernetes.js';
import { isolatedJobEnvironment } from '../integration/e2e/internal/transports/job-command.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';
import { makeStatusWorkloadMetadata } from './helpers/fixtures.js';

const CONNECTIVITY_SENTINEL = {
  kind: 'object',
  key: '.rclone-keep',
  sizeBytes: 0,
  lastModifiedAt: 100,
} as const;

function harness(
  options: {
    existingBucket?: boolean;
    bucketCheckError?: boolean;
    holdFailure?: 'prerequisite' | 'arm';
    unmaskFailure?: Error;
    bucketCreateFailure?: Error;
    bucketObjects?: readonly unknown[];
  } = {},
) {
  const calls: string[] = [];
  const cleanup = new CleanupStack();
  let lookup: WorkloadStatusLookup = { kind: 'absent' };
  let vmId = 42;
  let cloudId = 'i-original';
  let checkpointHostPath = '/mnt/owned-checkpoint';
  let unmaskFailure = options.unmaskFailure;
  const probe = new ServiceUpgradeRecoveryProbe({
    cleanupApi: { lookupStatus: async () => lookup },
    cleanup,
    cleanupCli: {
      run: async (args) => {
        calls.push(args.join(' '));
        return commandResultForTest();
      },
    },
    cli: {
      run: async (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'db')
          return commandResultForTest({
            stdout: JSON.stringify({
              rows: [
                {
                  id: vmId,
                  cloud_id: cloudId,
                  checkpoint_host_path: checkpointHostPath,
                },
              ],
            }),
          });
        if (args[1] === 'exists')
          return commandResultForTest({
            exitCode: options.bucketCheckError
              ? 2
              : options.existingBucket
                ? 0
                : 1,
          });
        if (args[1] === 'list')
          return commandResultForTest({
            stdout: JSON.stringify({
              entries: options.bucketObjects ?? [CONNECTIVITY_SENTINEL],
              truncated: false,
              nextCursor: null,
            }),
          });
        if (args[1] === 'create' && options.bucketCreateFailure)
          throw options.bucketCreateFailure;
        return commandResultForTest();
      },
    },
    credentials: { save: async () => undefined },
    names: { workload: (scope) => `d-${scope}` },
    profiles: {
      serve: () => ({
        slug: 'aws',
        provider: CloudType.AWS,
        credentialName: 'aws-test',
        credential: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'test',
          secretAccessKey: 'test',
        },
        vmTypes: ['t3.small'],
        region: 'us-west-2',
      }),
    },
    cleanupRemote: {
      pinHost: async (id) => {
        calls.push(`pin:${id}`);
        return {
          run: async (command) => {
            calls.push(command);
            if (command.includes('systemctl unmask') && unmaskFailure)
              throw unmaskFailure;
            const failed =
              (options.holdFailure === 'prerequisite' &&
                command.includes('ps -p 1')) ||
              (options.holdFailure === 'arm' &&
                command.includes('systemctl mask'));
            return commandResultForTest({ exitCode: failed ? 1 : 0 });
          },
          close: async () => {
            calls.push('close-pinned-host');
          },
        };
      },
    },
  });
  return {
    calls,
    cleanup,
    probe,
    setUnmaskFailure: (error: Error | undefined) => {
      unmaskFailure = error;
    },
    service: {
      ref: trackedWorkloadRefForTest('d-svup-aws'),
      hosts: [
        { cloudId: 'i-original', region: 'us-west-2', availabilityZone: 'b' },
      ],
    },
    setVmId: (value: number) => {
      vmId = value;
    },
    setCloudId: (value: string) => {
      cloudId = value;
    },
    setCheckpointHostPath: (value: string) => {
      checkpointHostPath = value;
    },
    setWorkload: (cleanedAt: number | null, live: boolean) => {
      lookup = {
        kind: 'found',
        status: {
          workload: makeStatusWorkloadMetadata({
            id: 'd-svup-aws',
            workloadType: 'service',
            state: live ? WorkloadState.Recovering : WorkloadState.Terminated,
            cleanedAt,
          }),
          events: [],
          status: WorkloadHealthStatus.Up,
          vms: [
            {
              ip: '203.0.113.7',
              cloudId: 'i-original',
              endedAt: live ? null : 100,
            },
          ],
        },
      };
    },
  };
}

describe('Service upgrade checkpoint fault fixture', () => {
  test('the composed fixture unmasks its pinned original host and deletes its bucket after foreground cancellation', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'e2e-service-cleanup-'),
    );
    onTestFinished(async () => {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    });
    const foreground = new AbortController();
    const primary = new Error('foreground cancelled after hold arming');
    let workloadId = '';
    const commands: {
      executable: string;
      args: readonly string[];
      result: CommandResult;
    }[] = [];
    const runProcess = ProcessRunner.prototype.run;
    vi.spyOn(ProcessRunner.prototype, 'run').mockImplementation(async function (
      this: ProcessRunner,
      executable,
      args,
      options,
    ) {
      const command = executable === 'ssh' ? args : args.slice(1);
      const stdout =
        command[0] === 'db'
          ? JSON.stringify({
              rows: [
                {
                  id: 42,
                  cloud_id: 'i-original',
                  checkpoint_host_path: '/mnt/checkpoint',
                },
              ],
            })
          : command[1] === 'list'
            ? '{"entries":[],"truncated":false,"nextCursor":null}'
            : 'executed';
      const exitCode = command[1] === 'exists' ? 1 : 0;
      // Substitute only the external executable. Use the composed runner's
      // real cancellation scope and require an actual child-process result.
      const result = await runProcess.call(
        this,
        process.execPath,
        [
          '-e',
          `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exitCode}`,
        ],
        options,
      );
      commands.push({ executable, args: command, result });
      return result;
    });
    vi.spyOn(ApiClient.prototype, 'saveCredential').mockResolvedValue();
    const sshAccess = vi
      .spyOn(ApiClient.prototype, 'sshAccess')
      .mockImplementation(async () => ({
        workloadId,
        vmIp: '203.0.113.7',
        sshHost: '203.0.113.7',
        sshPort: 2222,
        sshUsername: 'root',
        sshPrivateKey: 'private-original-key',
      }));
    const readStatus = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, options) => {
        const request = new Request(input, options);
        expect(new URL(request.url).pathname).toBe(
          `/v1/workloads/${workloadId}`,
        );
        expect(foreground.signal.aborted).toBe(true);
        expect(request.signal.aborted).toBe(false);
        const status = cloudHostStatusForTest(
          workloadId,
          WorkloadState.Terminated,
          200,
        );
        status.vms![0]!.endedAt = 100;
        return Response.json(status);
      });
    // This case is the checkpointed journey's cancellation; skip the plain one.
    vi.spyOn(ServeUpgradeContract.prototype, 'plain').mockResolvedValue({
      contract: 'serve-upgrade',
      qualification: 'conclusive',
      satisfied: true,
      target: 'aws',
    });
    const create = ServiceUpgradeRecoveryProbe.prototype.create;
    let keyPath = '';
    vi.spyOn(
      ServiceUpgradeRecoveryProbe.prototype,
      'create',
    ).mockImplementation(async function (
      this: ServiceUpgradeRecoveryProbe,
      target,
      scope,
    ) {
      const fixture = await create.call(this, target, scope);
      await fixture.hold({
        ref: trackedWorkloadRefForTest(workloadId),
        hosts: [
          { cloudId: 'i-original', region: 'us-west-2', availabilityZone: 'b' },
        ],
      });
      keyPath = commands.find((entry) => entry.executable === 'ssh')!.args[1]!;
      expect(await readFile(keyPath, 'utf8')).toBe('private-original-key\n');
      // A fresh lookup would now follow a replacement. Teardown must use the
      // already-pinned endpoint and key instead of resolving the Service again.
      sshAccess.mockResolvedValue({
        workloadId,
        vmIp: '203.0.113.8',
        sshPrivateKey: 'private-replacement-key',
      });
      foreground.abort(primary);
      throw primary;
    });
    const lifecycle = await createE2ELifecycle({
      projectRoot: process.cwd(),
      signal: foreground.signal,
      testName: 'Service recovery cancellation',
      environment: {
        API_URL: 'https://fixture.invalid',
        E2E_ARTIFACT_DIR: directory,
        AWS_ACCESS_KEY_ID: 'fixture-access',
        AWS_SECRET_ACCESS_KEY: 'fixture-secret',
      },
    });
    workloadId = lifecycle.e2e.names.workload('svup-aws');
    const failure = await lifecycle.e2e.contracts
      .serveUpgrade('aws')
      .catch((error: unknown) => error);
    const disposed = await Promise.allSettled([lifecycle.dispose()]);
    expect(failure).toBe(primary);
    expect(disposed).toEqual([{ status: 'fulfilled', value: undefined }]);
    const unmask = commands.filter((entry) =>
      entry.args.at(-1)?.includes('systemctl unmask'),
    );
    expect(unmask).toHaveLength(1);
    expect(unmask[0]!.args).toContain('root@203.0.113.7');
    expect(unmask[0]!.args[1]).toBe(keyPath);
    expect(unmask[0]!.args).toContain('StrictHostKeyChecking=yes');
    expect(unmask[0]!.result).toMatchObject({
      exitCode: 0,
      aborted: false,
      stdout: 'executed',
    });
    expect(
      commands.filter(
        (entry) => entry.args[0] === 'bucket' && entry.args[1] === 'delete',
      ),
    ).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          exitCode: 0,
          aborted: false,
          stdout: 'executed',
        }),
      }),
    ]);
    expect(sshAccess).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledOnce();
    await expect(access(keyPath)).rejects.toThrow();
    const [artifacts] = await readdir(directory);
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, artifacts!, 'cleanup-observations.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      completed: true,
      registrations: [
        {
          label: expect.stringContaining('Service checkpoint '),
          completed: true,
        },
        { label: `Service checkpoint hold ${workloadId}`, completed: true },
      ],
    });
  });

  test('pins the exact attempt and holds only its final flush; cleanup unblocks the host before deleting owned resources', async () => {
    const world = harness();
    const fixture = await world.probe.create('aws', 'svup-aws');
    world.setWorkload(null, true);
    world.cleanup.defer('owned Service', async () => {
      world.calls.push('workload-cleanup');
      world.setWorkload(200, false);
    });
    const hold = await fixture.hold(world.service);

    expect(hold.vmId).toBe(42);
    expect(hold.cloudId).toBe('i-original');
    expect(hold.checkpointHostPath).toBe('/mnt/owned-checkpoint');
    expect(fixture.region).toBe('us-west-2');
    const arm = world.calls.find((call) => call.includes('systemctl mask'))!;
    expect(arm).toContain(
      "systemctl mask --runtime 'ac-final-checkpoint-d-svup-aws.service'",
    );
    expect(arm.indexOf('systemctl stop rclone-checkpoint')).toBeLessThan(
      arm.indexOf('printf'),
    );
    expect(arm).toContain('/mnt/owned-checkpoint/rfc0036-checkpoint-marker');
    expect(world.calls.filter((call) => call.startsWith('pin:'))).toEqual([
      'pin:d-svup-aws',
    ]);

    await hold.assertHeld();
    await world.cleanup.run();
    const unmask = world.calls.findIndex((call) =>
      call.includes('systemctl unmask'),
    );
    const workloadCleanup = world.calls.indexOf('workload-cleanup');
    const deleteBucket = world.calls.findIndex((call) =>
      call.startsWith('bucket delete'),
    );
    expect(unmask).toBeLessThan(workloadCleanup);
    expect(workloadCleanup).toBeLessThan(deleteBucket);
    expect(world.calls[deleteBucket]).toBe(
      'bucket delete --credentials aws-test --region us-west-2 d-svup-aws-checkpoint',
    );
    await hold.release();
    await fixture.releaseBucket();
    expect(
      world.calls.filter((call) => call.includes('systemctl unmask')),
    ).toHaveLength(1);
    expect(
      world.calls.filter((call) => call.startsWith('bucket delete')),
    ).toHaveLength(1);
  });

  test('retains bucket cleanup if its create response is lost before Service reservation', async () => {
    const primary = new Error('bucket creation response lost');
    const world = harness({ bucketCreateFailure: primary });
    await expect(world.probe.create('aws', 'svup-aws')).rejects.toBe(primary);
    expect(world.cleanup.observations()).toEqual([
      { label: 'Service checkpoint d-svup-aws-checkpoint', completed: false },
    ]);
    await world.cleanup.run();
    expect(world.calls.at(-1)).toBe(
      'bucket delete --credentials aws-test --region us-west-2 d-svup-aws-checkpoint',
    );
    expect(world.cleanup.observations()[0]!.completed).toBe(true);
  });

  test('preserves a partial arming failure and failed release while keeping pinned cleanup armed', async () => {
    const secondary = new Error('original host unavailable');
    const world = harness({ holdFailure: 'arm', unmaskFailure: secondary });
    const fixture = await world.probe.create('aws', 'svup-aws');
    const failure = await fixture
      .hold(world.service)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [
        new Error(
          'Service upgrade recovery: hold final checkpoint and write unsynced marker failed',
        ),
        secondary,
      ],
    });
    expect(world.calls).not.toContain('close-pinned-host');
    expect(world.cleanup.observations()).toContainEqual({
      label: 'Service checkpoint hold d-svup-aws',
      completed: false,
    });
    world.setUnmaskFailure(undefined);
    await world.cleanup.run();
    expect(
      world.calls.filter((call) => call.includes('systemctl unmask')),
    ).toHaveLength(2);
    expect(
      world.calls.filter((call) => call === 'close-pinned-host'),
    ).toHaveLength(1);
    expect(world.cleanup.observations().every((entry) => entry.completed)).toBe(
      true,
    );
  });

  test.each([{ existingBucket: true }, { bucketCheckError: true }])(
    'fails closed unless the bucket is demonstrably absent: %j',
    async (options) => {
      const world = harness(options);
      await expect(world.probe.create('aws', 'svup-aws')).rejects.toThrow(
        'demonstrably absent',
      );
      await world.cleanup.run();
      expect(
        world.calls.some(
          (call) =>
            call.startsWith('bucket create') ||
            call.startsWith('bucket delete'),
        ),
      ).toBe(false);
    },
  );

  test.each([
    { cleanedAt: null, live: false },
    { cleanedAt: 200, live: true },
  ])(
    'never deletes a checkpoint until cleanup and VM absence are both recorded: %j',
    async ({ cleanedAt, live }) => {
      const world = harness();
      const fixture = await world.probe.create('aws', 'svup-aws');
      world.setWorkload(cleanedAt, live);
      await expect(fixture.releaseBucket()).rejects.toThrow(
        'before Service cleanup',
      );
      await expect(world.cleanup.run()).rejects.toThrow(
        'before Service cleanup',
      );
      expect(world.calls.some((call) => call.startsWith('bucket delete'))).toBe(
        false,
      );
    },
  );

  test('does not touch a pre-existing mask or unsupported host when preflight fails', async () => {
    const world = harness({ holdFailure: 'prerequisite' });
    const fixture = await world.probe.create('aws', 'svup-aws');
    await expect(fixture.hold(world.service)).rejects.toThrow('prerequisites');
    expect(world.calls).toContain('close-pinned-host');
    expect(
      world.calls.some(
        (call) =>
          call.includes('systemctl unmask') || call.includes('systemctl mask'),
      ),
    ).toBe(false);
    await world.cleanup.run();
  });

  test.each([
    { holdFailure: 'arm' as const },
    {
      bucketObjects: [
        CONNECTIVITY_SENTINEL,
        {
          kind: 'object',
          key: SERVICE_CHECKPOINT_MARKER_FILE,
          sizeBytes: 42,
          lastModifiedAt: 100,
        },
      ],
    },
    { bucketObjects: [{ kind: 'prefix', key: '.rclone-keep' }] },
    { bucketObjects: [{ key: '.rclone-keep' }] },
    { bucketObjects: [{ ...CONNECTIVITY_SENTINEL, sizeBytes: 42 }] },
  ])(
    'unmasks the pinned old host if arming or unsynced proof fails: %j',
    async (options) => {
      const world = harness(options);
      const fixture = await world.probe.create('aws', 'svup-aws');
      await expect(fixture.hold(world.service)).rejects.toThrow();
      expect(
        world.calls.filter((call) => call.includes('systemctl unmask')),
      ).toHaveLength(1);
      await world.cleanup.run();
      expect(
        world.calls.filter((call) => call.includes('systemctl unmask')),
      ).toHaveLength(1);
    },
  );

  test.each(['row', 'cloud ID', 'checkpoint path'])(
    'fails when restart changes the original live attempt %s',
    async (field) => {
      const world = harness();
      const fixture = await world.probe.create('aws', 'svup-aws');
      const hold = await fixture.hold(world.service);
      if (field === 'row') world.setVmId(43);
      else if (field === 'cloud ID') world.setCloudId('i-replacement');
      else world.setCheckpointHostPath('/mnt/another-attempt');
      await expect(hold.assertHeld()).rejects.toThrow(
        'exact original live VM attempt',
      );
      await world.cleanup.run();
    },
  );

  test('also accepts an empty bucket when no connectivity sentinel remains', async () => {
    const world = harness({ bucketObjects: [] });
    const fixture = await world.probe.create('aws', 'svup-aws');
    const hold = await fixture.hold(world.service);
    await expect(hold.assertHeld()).resolves.toBeUndefined();
    await world.cleanup.run();
  });
});

describe('pinned Service SSH host', () => {
  test('Job probes can bind the expected host and pass bounded private cancellation without changing Service defaults', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'job-pinned-ssh-'));
    try {
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-aws-must-not-reach-ssh');
      vi.stubEnv('AZURE_CLIENT_SECRET', 'ambient-azure-must-not-reach-ssh');
      const artifacts = new ArtifactStore(
        path.join(directory, 'artifacts'),
        new Redactor(),
      );
      await artifacts.initialize({ testName: 'job-pinned-ssh' });
      const recorded = vi.spyOn(artifacts, 'command');
      const runner = new ProcessRunner(
        artifacts,
        new AbortController().signal,
        directory,
      );
      const environments: unknown[] = [];
      // Keep the real child environment merge and output-recording boundary,
      // without opening an SSH connection or provisioning a host.
      const run = vi.fn<ProcessRunner['run']>(
        async (_executable, _args, options) => {
          const result = await runner.run(
            process.execPath,
            [
              '-e',
              'process.stdout.write(JSON.stringify({ aws: process.env.AWS_SECRET_ACCESS_KEY ?? null, azure: process.env.AZURE_CLIENT_SECRET ?? null }))',
            ],
            options,
          );
          environments.push(JSON.parse(result.stdout) as unknown);
          return result;
        },
      );
      const sshAccess = vi.fn(async () => ({
        workloadId: 'job-pinned',
        vmIp: '203.0.113.7',
        sshPrivateKey: 'private-test-key',
      }));
      const remote = new RemoteExecutor(
        { sshAccess },
        new FixtureFiles(directory),
        { run },
        { add: () => undefined },
      );
      const host = await remote.pinHost('job-pinned', {
        expectedHost: '203.0.113.7',
        env: isolatedJobEnvironment(),
        recordArtifact: false,
      });
      const signal = new AbortController().signal;
      await host.run('bound Job probe command', {
        timeoutMs: 1_200_000,
        signal,
        recordArtifact: false,
        env: isolatedJobEnvironment(),
      });
      expect(run.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 45_000 });
      expect(run.mock.calls[1]?.[2]).toMatchObject({
        timeoutMs: 1_200_000,
        signal,
        recordArtifact: false,
      });
      expect(sshAccess).toHaveBeenCalledOnce();
      expect(environments).toEqual([
        { aws: null, azure: null },
        { aws: null, azure: null },
      ]);
      expect(recorded).not.toHaveBeenCalled();
      await host.close();
      expect(await readdir(path.join(directory, 'ssh'))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(['workload', 'host'] as const)(
    'pinned Job SSH rejects a foreign %s before creating key material or sending commands',
    async (failure) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'job-foreign-ssh-'));
      try {
        const run = vi.fn<ProcessRunner['run']>(async () =>
          commandResultForTest(),
        );
        const remote = new RemoteExecutor(
          {
            sshAccess: async () => ({
              workloadId: failure === 'workload' ? 'foreign' : 'job-pinned',
              vmIp: failure === 'host' ? '203.0.113.8' : '203.0.113.7',
              sshPrivateKey: 'private-test-key',
            }),
          },
          new FixtureFiles(directory),
          { run },
          { add: () => undefined },
        );
        await expect(
          remote.pinHost('job-pinned', { expectedHost: '203.0.113.7' }),
        ).rejects.toThrow('original Workload host');
        expect(run).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test('resolves the original endpoint/key once and enforces its captured host key for all later commands', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'anycloud-service-pinned-ssh-'),
    );
    try {
      let lookups = 0;
      const captured: string[][] = [];
      const redacted: string[] = [];
      const remote = new RemoteExecutor(
        {
          sshAccess: async () => {
            lookups += 1;
            return {
              workloadId: 'd-service',
              vmIp: lookups === 1 ? '203.0.113.7' : '203.0.113.8',
              sshHost: lookups === 1 ? '203.0.113.7' : '203.0.113.8',
              sshPort: 2222,
              sshUsername: 'root',
              sshPrivateKey: 'private-test-key',
            };
          },
        },
        new FixtureFiles(directory),
        {
          run: async (_executable, args) => {
            captured.push([...args]);
            return commandResultForTest();
          },
        },
        {
          add: (value) => {
            if (value) redacted.push(value);
          },
        },
      );
      const host = await remote.pinHost('d-service');
      await host.run('release original checkpoint mask');
      expect(lookups).toBe(1);
      expect(captured[0]).toContain('StrictHostKeyChecking=accept-new');
      expect(captured[1]).toContain('StrictHostKeyChecking=yes');
      expect(captured.every((args) => args.includes('root@203.0.113.7'))).toBe(
        true,
      );
      expect(redacted).toEqual(['private-test-key']);
      const key = captured[0]![1]!;
      await access(key);
      await host.close();
      await host.close();
      await expect(access(key)).rejects.toThrow();
      expect(await readdir(path.join(directory, 'ssh'))).toEqual([]);
      expect(() => host.run('must not run')).toThrow('already released');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('removes private material when initial host-key capture fails', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'anycloud-service-pinned-ssh-'),
    );
    try {
      const remote = new RemoteExecutor(
        {
          sshAccess: async () => ({
            workloadId: 'd-service',
            vmIp: '203.0.113.7',
            sshHost: '203.0.113.7',
            sshPrivateKey: 'private-test-key',
          }),
        },
        new FixtureFiles(directory),
        { run: async () => commandResultForTest({ exitCode: 255 }) },
        { add: () => undefined },
      );
      await expect(remote.pinHost('d-service')).rejects.toThrow(
        'Could not pin',
      );
      expect(await readdir(path.join(directory, 'ssh'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
