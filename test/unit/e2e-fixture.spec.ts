import { existsSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import type {
  CommandResult,
  StatusResponse,
} from '../integration/e2e/internal/types.js';
import { commandResultForTest } from './helpers/e2e.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';
import { assertConstrainedRunner } from '../integration/e2e/fixture.js';
import { ApiClient } from '../integration/e2e/internal/api.js';
import {
  E2E_FIXTURE_RECORD_FILE,
  parseE2EFixtureRecord,
} from '../integration/helpers/e2e-fixture-record.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { CliClient } from '../integration/e2e/internal/cli.js';
import { ControllerEndpoint } from '../integration/e2e/internal/controller-session.js';
import {
  createE2ELifecycle,
  finalizeE2ELifecycle,
  type E2ELifecycle,
} from '../integration/e2e/internal/context.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { FailureDiagnostics } from '../integration/e2e/internal/diagnostics.js';
import { CliDatabase } from '../integration/e2e/internal/database.js';
import { ManagedProcess } from '../integration/e2e/internal/managed-process.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import { retryUnavailableApiRead } from '../integration/e2e/internal/read-retry.js';
import { ProviderProfiles } from '../integration/e2e/internal/profiles.js';
import { PublicCloudVmHostPresenceProbe } from '../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import { ServiceDnsProbe } from '../integration/e2e/internal/transports/service-dns.js';
import {
  rethrowLastAttempt,
  Waiter,
  WaitTimeoutError,
  retryTransientProbeError,
} from '../integration/e2e/internal/wait.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-fixture-contract-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('constrained E2E fixture contracts', () => {
  test.each([
    {
      name: 'readback failure=false',
      bundleFailure: false,
      missing: false,
      terminalOverrides: {},
    },
    {
      name: 'readback failure=true',
      bundleFailure: true,
      missing: false,
      terminalOverrides: {},
    },
    {
      name: 'nonterminal state',
      bundleFailure: false,
      missing: false,
      terminalOverrides: { state: WorkloadState.Running },
    },
    {
      name: 'missing completedAt',
      bundleFailure: false,
      missing: false,
      terminalOverrides: { completedAt: null },
    },
    {
      name: 'nonfinite completedAt',
      bundleFailure: false,
      missing: false,
      terminalOverrides: { completedAt: Number.POSITIVE_INFINITY },
    },
    {
      name: 'nonfinite cleanedAt',
      bundleFailure: false,
      missing: false,
      terminalOverrides: { cleanedAt: Number.NaN },
    },
    {
      name: 'cleanup precedes completion',
      bundleFailure: false,
      missing: false,
      terminalOverrides: { cleanedAt: 19 },
    },
    {
      name: 'absent persisted record',
      bundleFailure: false,
      missing: true,
      terminalOverrides: {},
    },
  ] satisfies {
    name: string;
    bundleFailure: boolean;
    missing: boolean;
    terminalOverrides: Partial<StatusResponse['workload']>;
  }[])(
    'GPU Service fallback waits for named-bundle readback after cancellation: $name',
    async ({ bundleFailure, missing, terminalOverrides }) => {
      const invalidRecord =
        missing || Object.keys(terminalOverrides).length > 0;
      const cleanupFailed = bundleFailure || invalidRecord;
      const directory = await temporaryDirectory();
      const primary = new AbortController();
      const cloudId = 'i-0123456789abcdef0';
      // The fake product's `running` event sits a dwell after its `starting` event.
      const startingEventAt = Date.now();
      const runningEventAt = startingEventAt + 60_000;
      let workloadId = '';
      let command: readonly string[] = [];
      let terminated = false;
      vi.spyOn(ApiClient.prototype, 'saveCredential').mockResolvedValue();
      vi.spyOn(ApiClient.prototype, 'createSecret').mockResolvedValue();
      vi.spyOn(FailureDiagnostics.prototype, 'capture').mockResolvedValue();
      const bundleRead = vi
        .spyOn(ApiClient.prototype, 'deleteSecret')
        .mockImplementation(async () => {
          expect(primary.signal.aborted).toBe(true);
          expect(terminated).toBe(true);
          expect(
            await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
          ).toContain(workloadId);
          if (bundleFailure)
            throw new Error('named-bundle readback unavailable');
        });
      vi.spyOn(CliClient.prototype, 'run').mockImplementation(
        async (args): Promise<CommandResult> => {
          if (args[0] === 'service') {
            workloadId = args[args.indexOf('--id') + 1]!;
            command = args.slice(args.indexOf('--') + 1);
          }
          if (args[0] === 'terminate') terminated = true;
          const rows = args.at(-1)?.includes('COUNT(*)')
            ? [{ count: terminated ? 0 : 1 }]
            : args.at(-1)?.includes('FROM credentials')
              ? [
                  {
                    id: 'original-credential',
                    name: 'aws-test',
                    cloud_provider: CloudType.AWS,
                  },
                ]
              : workloadId
                ? [
                    {
                      id: 1,
                      workload_id: workloadId,
                      credential_id: 'original-credential',
                      cloud_provider: CloudType.AWS,
                      created_at: 10,
                      ended_at: terminated ? 20 : null,
                      cloud_id: cloudId,
                      region: 'us-east-1',
                      availability_zone: 'b',
                      ip: '203.0.113.1',
                      vm_type: 'g6e.xlarge',
                    },
                  ]
                : [];
          const stdout = JSON.stringify({
            rows,
            rowCount: rows.length,
            truncated: false,
          });
          return {
            executable: 'anycloud',
            args,
            exitCode: 0,
            signal: null,
            stdout,
            stderr: '',
            combined: stdout,
            timedOut: false,
            aborted: false,
            outputTruncated: false,
            durationMs: 1,
          };
        },
      );
      vi.spyOn(ApiClient.prototype, 'lookupStatus').mockImplementation(
        async (id) =>
          terminated && missing
            ? { kind: 'absent' }
            : {
                kind: 'found',
                status: {
                  workload: persistentVmWorkload(id, {
                    workloadType: WorkloadType.Service,
                    cloudProvider: CloudType.AWS,
                    region: 'us-east-1',
                    availabilityZone: 'b',
                    vmType: 'g6e.xlarge',
                    diskSizeGb: 100,
                    image: 'python:3.12-slim',
                    command: [...command],
                    dockerOptions: { gpus: 'all' },
                    dnsRecordId: 'dns-owned',
                    state: terminated
                      ? WorkloadState.Terminated
                      : WorkloadState.Running,
                    completedAt: terminated ? 20 : null,
                    cleanedAt: terminated ? 30 : null,
                    ...(terminated ? terminalOverrides : {}),
                  }),
                  events: [
                    {
                      id: 1,
                      workloadId: id,
                      state: WorkloadState.Starting,
                      metadata: null,
                      createdAt: startingEventAt,
                    },
                    {
                      id: 2,
                      workloadId: id,
                      state: WorkloadState.Running,
                      metadata: null,
                      createdAt: runningEventAt,
                    },
                  ],
                  status: WorkloadHealthStatus.Up,
                  vms: [
                    {
                      cloudId,
                      ip: '203.0.113.1',
                      region: 'us-east-1',
                      availabilityZone: 'b',
                      endedAt: terminated ? 20 : null,
                    },
                  ],
                },
              },
      );
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, options) => {
          expect(options?.redirect).toBe('manual');
          return new Response(
            'anycloud-serve-gpu-serve-aws\nenv-file-gpu-serve-aws\nenv-override-from-flag-gpu-serve-aws\nsecret-ok\nGPU 0: NVIDIA A10 (UUID: GPU-fixture)\n',
          );
        },
      );
      const nativeRead = vi
        .spyOn(PublicCloudVmHostPresenceProbe.prototype, 'observe')
        .mockImplementation(async (host, options) => {
          expect(primary.signal.aborted).toBe(true);
          expect(options?.signal?.aborted).toBe(false);
          return {
            provider: CloudType.AWS,
            cloudId: host.cloudId,
            presence: 'absent',
            diagnostic: 'terminated',
          };
        });
      const dnsRead = vi
        .spyOn(ServiceDnsProbe.prototype, 'observe')
        .mockImplementation(async (hostname, deadlineAt) => {
          expect(primary.signal.aborted).toBe(true);
          expect(deadlineAt).toBeGreaterThan(Date.now());
          return {
            hostname,
            authorities: ['one.ns.example'],
            answers: [
              {
                authority: 'one.ns.example',
                address: '192.0.2.1',
                presence: 'absent',
                diagnostic: 'NXDOMAIN',
              },
            ],
          };
        });
      const lifecycle = await createE2ELifecycle({
        projectRoot: process.cwd(),
        signal: primary.signal,
        testName: 'GPU Service cancellation',
        environment: {
          API_URL: 'http://original-controller.invalid',
          E2E_ARTIFACT_DIR: directory,
          RESULTS_DIR: directory,
          AWS_ACCESS_KEY_ID: 'test-access',
          AWS_SECRET_ACCESS_KEY: 'test-private',
          E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE: '1',
          SERVE_SMOKE_CLEANUP_TIMEOUT_SECONDS: '10',
        },
      });
      const failure = await lifecycle.e2e.contracts
        .gpuServe('aws')
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        message: 'Service forced cleanup: before-finalize',
      });
      primary.abort(new Error('foreground cancelled'));
      const finalized = finalizeE2ELifecycle(lifecycle, [failure]);
      if (cleanupFailed) {
        await expect(finalized).rejects.toMatchObject({
          errors: expect.arrayContaining([failure]),
        });
      } else await expect(finalized).resolves.toBeUndefined();
      expect(nativeRead).toHaveBeenCalled();
      if (invalidRecord) expect(dnsRead).not.toHaveBeenCalled();
      else expect(dnsRead).toHaveBeenCalled();
      expect(bundleRead).toHaveBeenCalled();
      const artifactName = (
        await readdir(directory, { withFileTypes: true })
      ).find((entry) => entry.isDirectory())!.name;
      const artifactDirectory = path.join(directory, artifactName);
      const record: unknown = JSON.parse(
        await readFile(
          path.join(artifactDirectory, 'cleanup-observations.json'),
          'utf8',
        ),
      );
      expect(record).toMatchObject({
        completed: !cleanupFailed,
        outstandingWorkloads: cleanupFailed ? [workloadId] : [],
      });
      expect(
        await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
      ).toBe(cleanupFailed ? `${workloadId}\n` : '');
      expect(
        existsSync(path.join(artifactDirectory, 'gpu-serve-evidence.json')),
      ).toBe(true);
      expect(
        existsSync(path.join(artifactDirectory, 'gpu-serve-result.json')),
      ).toBe(false);
    },
  );

  test('VM composition retains successful native cleanup after a primary cancellation', async () => {
    const directory = await temporaryDirectory();
    const primary = new AbortController();
    let workloadId = '';
    let terminated = false;
    vi.spyOn(ApiClient.prototype, 'createSecret').mockResolvedValue();
    vi.spyOn(ApiClient.prototype, 'deleteSecret').mockResolvedValue();
    vi.spyOn(FailureDiagnostics.prototype, 'capture').mockResolvedValue();
    vi.spyOn(CliClient.prototype, 'run').mockImplementation(
      async (args): Promise<CommandResult> => {
        if (args[0] === 'vm') workloadId = args[args.indexOf('--id') + 1];
        if (args[0] === 'terminate') terminated = true;
        const rows = workloadId
          ? [
              {
                id: 1,
                workload_id: workloadId,
                credential_id: null,
                cloud_provider: null,
                created_at: 10,
                ended_at: terminated ? 20 : null,
                cloud_id: `ac-local-${workloadId}-0`,
                region: 'local',
                availability_zone: null,
                ip: 'localhost',
                vm_type: 'local',
              },
            ]
          : [];
        const stdout = JSON.stringify({
          rows,
          rowCount: rows.length,
          truncated: false,
        });
        return {
          executable: 'anycloud',
          args,
          exitCode: 0,
          signal: null,
          stdout,
          stderr: '',
          combined: stdout,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          durationMs: 1,
        };
      },
    );
    vi.spyOn(ApiClient.prototype, 'lookupStatus').mockImplementation(
      async (id) => ({
        kind: 'found',
        status: {
          workload: persistentVmWorkload(id, {
            cloudProvider: CloudType.Local,
            region: 'local',
            vmType: 'local',
            state: terminated
              ? WorkloadState.Terminated
              : WorkloadState.Running,
            completedAt: terminated ? 20 : null,
            cleanedAt: terminated ? 30 : null,
          }),
          events: [],
          status: WorkloadHealthStatus.Up,
          vms: [
            {
              cloudId: `ac-local-${id}-0`,
              ip: 'localhost',
              region: 'local',
              availabilityZone: null,
              endedAt: terminated ? 20 : null,
            },
          ],
        },
      }),
    );
    const nativeRead = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, options) => {
        expect(String(url)).toBe('http://127.0.0.1:18089/api/v1/machines');
        expect(primary.signal.aborted).toBe(true);
        expect(options?.signal?.aborted).toBe(false);
        expect(options?.redirect).toBe('manual');
        return Response.json([]);
      });
    const lifecycle = await createE2ELifecycle({
      projectRoot: process.cwd(),
      signal: primary.signal,
      testName: 'VM native cleanup cancellation',
      environment: {
        API_URL: 'http://original-controller.invalid',
        E2E_ARTIFACT_DIR: directory,
        E2E_VM_FORCE_FAILURE_AFTER_RUNNING: '1',
        VM_SMOKE_CLEANUP_TIMEOUT_SECONDS: '10',
      },
    });
    const failure = await lifecycle.e2e.contracts
      .persistentVm('local-smolvm')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: expect.stringContaining('forced failure after Running'),
    });
    primary.abort(new Error('test cancelled after provisioning'));
    await expect(
      finalizeE2ELifecycle(lifecycle, [failure]),
    ).resolves.toBeUndefined();
    expect(nativeRead).toHaveBeenCalled();
    const [artifactName] = await readdir(directory);
    const artifactDirectory = path.join(directory, artifactName);
    const cleanupRecord: unknown = JSON.parse(
      await readFile(
        path.join(artifactDirectory, 'cleanup-observations.json'),
        'utf8',
      ),
    );
    expect(cleanupRecord).toMatchObject({
      completed: true,
      outstandingWorkloads: [],
      failures: [],
    });
    expect(cleanupRecord).toHaveProperty('registrations', [
      { label: expect.stringMatching(/^secret /u), completed: true },
      { label: `workload ${workloadId}`, completed: true },
    ]);
    expect(
      JSON.parse(
        await readFile(
          path.join(artifactDirectory, `vm-${workloadId}-native-cleanup.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
      completed: true,
      observations: [
        {
          cloudId: `ac-local-${workloadId}-0`,
          presence: 'absent',
          provider: CloudType.Local,
        },
      ],
      ownedLocalInventoryChecks: [{ machineNames: [] }],
    });
    expect(
      existsSync(path.join(artifactDirectory, 'persistent-vm-result.json')),
    ).toBe(false);
  });

  test('the public surface hides raw escape hatches and guards resource mutations', async () => {
    const directory = await temporaryDirectory();
    const lifecycle = await createE2ELifecycle({
      projectRoot: process.cwd(),
      signal: new AbortController().signal,
      testName: 'public fixture surface',
      environment: { E2E_ARTIFACT_DIR: directory },
    });
    try {
      expect(Object.keys(lifecycle.e2e).sort()).toEqual([
        'api',
        'apiAuth',
        'bucketAccess',
        'cli',
        'contracts',
        'env',
        'files',
        'names',
        'readModels',
        'runId',
        'workloadFacts',
      ]);
      expect(Object.keys(lifecycle.e2e.api)).toEqual(['saveCredential']);
      expect(Object.keys(lifecycle.e2e.apiAuth).sort()).toEqual([
        'accessPolicy',
        'secretCrudPrivacy',
      ]);
      expect(lifecycle.e2e).not.toHaveProperty('process');
      expect(lifecycle.e2e).not.toHaveProperty('remote');
      expect(lifecycle.e2e).not.toHaveProperty('workloads');
      expect(lifecycle.e2e).not.toHaveProperty('artifacts');
      expect(lifecycle.e2e).not.toHaveProperty('hash');
      expect(lifecycle.e2e).not.toHaveProperty('providers');
      expect(lifecycle.e2e).not.toHaveProperty('secrets');
      expect(lifecycle.e2e).not.toHaveProperty('vm');
      expect(lifecycle.e2e).not.toHaveProperty('wait');
      expect(lifecycle.e2e.api).not.toHaveProperty('json');
      expect(Object.keys(lifecycle.e2e.workloadFacts).sort()).toEqual([
        'liveVmCount',
        'provisioningRecordCounts',
      ]);
      const workloadName = lifecycle.e2e.names.workload(
        'persistent-vm-host-loss-local-smolvm',
      );
      const secretName = lifecycle.e2e.names.secret(
        'persistent-vm-host-loss-local-smolvm-secret',
      );
      const neighboringWorkloadName = lifecycle.e2e.names.workload(
        'persistent-vm-host-loss-local-smolvm-secret',
      );
      expect(workloadName).toHaveLength(28);
      expect(secretName).toHaveLength(28);
      expect(workloadName).not.toBe(secretName);
      expect(workloadName).not.toBe(neighboringWorkloadName);
      expect(
        lifecycle.e2e.names.workload('persistent-vm-host-loss-local-smolvm'),
      ).toBe(workloadName);
      expect(workloadName).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
      expect(workloadName).toMatch(new RegExp(`-${lifecycle.e2e.runId}$`, 'u'));
      await expect(
        lifecycle.e2e.cli.run(['vm', 'alpine:3.20', '--vm-type', 't3.small']),
      ).rejects.toThrow('require an explicit --id');
      await expect(
        lifecycle.e2e.cli.run(['bucket', 'create', 'untracked-bucket']),
      ).rejects.toThrow('need a named fixture capability');
      await expect(
        lifecycle.e2e.cli.run(['node-pool', 'create', 'untracked-pool']),
      ).rejects.toThrow('not an explicitly safe read');
      await expect(
        lifecycle.e2e.cli.run([
          'credentials',
          'new',
          'untracked-credential',
          '--provider',
          'AWS',
        ]),
      ).rejects.toThrow('not an explicitly safe read');
      await expect(
        lifecycle.e2e.cli.run(['db', 'query', 'DELETE FROM workloads']),
      ).rejects.toThrow('not an explicitly safe read');
    } finally {
      await lifecycle.dispose();
    }
  });

  test('cleanup is LIFO, idempotent, and supports completed resources', async () => {
    const cleanup = new CleanupStack();
    const calls: string[] = [];
    cleanup.defer('first', async () => {
      calls.push('first');
    });
    const completed = cleanup.defer('completed', async () => {
      calls.push('completed');
    });
    cleanup.defer('last', async () => {
      calls.push('last');
    });
    completed.complete();

    await cleanup.run();
    await cleanup.run();

    expect(calls).toEqual(['last', 'first']);
    expect(cleanup.observations()).toEqual([
      { label: 'first', completed: true },
      { label: 'completed', completed: true },
      { label: 'last', completed: true },
    ]);
  });

  test('cleanup aggregates failures without abandoning later actions', async () => {
    const cleanup = new CleanupStack();
    const calls: string[] = [];
    cleanup.defer('survivor', async () => {
      calls.push('survivor');
    });
    cleanup.defer('broken', async () => {
      throw new Error('provider unavailable');
    });

    let failure: unknown;
    try {
      await cleanup.run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      'broken: provider unavailable',
    );
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect((failure as AggregateError).errors[0]).toMatchObject({
      message: 'broken: provider unavailable',
      cause: new Error('provider unavailable'),
    });
    expect(calls).toEqual(['survivor']);
    expect(cleanup.observations()).toEqual([
      { label: 'survivor', completed: true },
      { label: 'broken', completed: false },
    ]);
  });

  test('cleanup keeps every failure in teardown order and does not repeat failed actions', async () => {
    const cleanup = new CleanupStack();
    const calls: string[] = [];
    const firstFailure = new Error('first provider failed');
    const lastFailure = new Error('last provider failed');
    cleanup.defer('first', async () => {
      calls.push('first');
      throw firstFailure;
    });
    cleanup.defer('middle', async () => {
      calls.push('middle');
    });
    cleanup.defer('last', async () => {
      calls.push('last');
      throw lastFailure;
    });
    const failure: unknown = await cleanup
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('Expected cleanup failure');
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0].cause).toBe(lastFailure);
    expect(failure.errors[1].cause).toBe(firstFailure);
    expect(failure.message).toContain('last: last provider failed');
    expect(failure.message).toContain('first: first provider failed');
    await cleanup.run();
    expect(calls).toEqual(['last', 'middle', 'first']);
    expect(cleanup.observations()).toEqual([
      { label: 'first', completed: false },
      { label: 'middle', completed: true },
      { label: 'last', completed: false },
    ]);
  });

  test('cleanup closes registration as soon as teardown starts', async () => {
    const cleanup = new CleanupStack();
    const lateAction = vi.fn(async () => {});
    cleanup.defer('registered', async () => {
      expect(() => cleanup.defer('during teardown', lateAction)).toThrow(
        'Cannot register cleanup',
      );
    });
    await cleanup.run();
    expect(() => cleanup.defer('after teardown', lateAction)).toThrow(
      'Cannot register cleanup',
    );
    expect(lateAction).not.toHaveBeenCalled();
  });

  test('failure finalization captures diagnostics first and preserves primary and cleanup causes', async () => {
    const calls: string[] = [];
    const primary = new Error('primary assertion failed');
    const cleanupFailure = new Error('provider cleanup failed');
    const unusedE2E = null as unknown as E2ELifecycle['e2e'];
    const lifecycle: E2ELifecycle = {
      e2e: unusedE2E,
      recordOutcome: async (errors) => {
        calls.push(`diagnostics:${String(errors.length)}`);
      },
      dispose: async () => {
        calls.push('cleanup');
        throw new AggregateError([cleanupFailure], 'cleanup failed');
      },
    };

    let failure: unknown;
    try {
      await finalizeE2ELifecycle(lifecycle, [primary]);
    } catch (error) {
      failure = error;
    }

    expect(calls).toEqual(['diagnostics:1', 'cleanup']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primary,
      cleanupFailure,
    ]);
  });

  test('diagnostic failure cannot prevent cleanup', async () => {
    const calls: string[] = [];
    const unusedE2E = null as unknown as E2ELifecycle['e2e'];
    const lifecycle: E2ELifecycle = {
      e2e: unusedE2E,
      recordOutcome: async () => {
        calls.push('diagnostics');
        throw new Error('diagnostics unavailable');
      },
      dispose: async () => {
        calls.push('cleanup');
      },
    };

    await expect(
      finalizeE2ELifecycle(lifecycle, [new Error('primary')]),
    ).rejects.toThrow('test failed and its diagnostics or cleanup also failed');
    expect(calls).toEqual(['diagnostics', 'cleanup']);
  });

  test('a passing test still records its fixture outcome for triage', async () => {
    const calls: string[] = [];
    const unusedE2E = null as unknown as E2ELifecycle['e2e'];
    const lifecycle: E2ELifecycle = {
      e2e: unusedE2E,
      recordOutcome: async (errors) => {
        calls.push(`record:${String(errors.length)}`);
      },
      dispose: async () => {
        calls.push('cleanup');
      },
    };

    await finalizeE2ELifecycle(lifecycle, []);

    expect(calls).toEqual(['record:0', 'cleanup']);
  });

  test('a failed evidence record fails the test it was meant to explain', async () => {
    const unusedE2E = null as unknown as E2ELifecycle['e2e'];
    const lifecycle: E2ELifecycle = {
      e2e: unusedE2E,
      recordOutcome: async () => {
        throw new Error('fixture record could not be written');
      },
      dispose: async () => undefined,
    };

    await expect(finalizeE2ELifecycle(lifecycle, [])).rejects.toThrow(
      'fixture record could not be written',
    );
  });

  test('processes use argv, capture both streams, and enforce deadlines', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'process' });
    const runner = new ProcessRunner(
      artifacts,
      new AbortController().signal,
      directory,
    );

    const completed = await runner.run(
      process.execPath,
      [
        '-e',
        'process.stdout.write(process.argv[1]); process.stderr.write("stderr")',
        'literal;$(not-a-shell)',
      ],
      { timeoutMs: 2_000, label: 'argv' },
    );
    expect(completed).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: 'literal;$(not-a-shell)',
      stderr: 'stderr',
    });

    const timedOut = await runner.run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100, label: 'deadline' },
    );
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).not.toBe(0);
    expect(timedOut).not.toHaveProperty('spawnError');

    const consolidatedProbe = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write("public host key material")'],
      {
        timeoutMs: 2_000,
        label: 'consolidated-probe',
        recordArtifact: false,
      },
    );
    expect(consolidatedProbe.exitCode).toBe(0);
    expect(await readdir(directory)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('consolidated-probe')]),
    );
  });

  test('process input, environment deletion, and exit outcomes retain their contracts', async () => {
    const directory = await temporaryDirectory();
    const runner = new ProcessRunner(
      new ArtifactStore(directory, new Redactor()),
      new AbortController().signal,
      directory,
    );
    vi.stubEnv('RUNNER_REMOVED', 'ambient');
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        'let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input,selected:process.env.RUNNER_SELECTED,removed:process.env.RUNNER_REMOVED})))',
      ],
      {
        stdin: 'input\r\n',
        env: { RUNNER_SELECTED: 'selected', RUNNER_REMOVED: undefined },
        recordArtifact: false,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      input: 'input\r\n',
      selected: 'selected',
    });
    expect(
      await runner.run(process.execPath, [
        '-e',
        'process.stdin.pipe(process.stdout)',
      ]),
    ).toMatchObject({ exitCode: 0, stdout: '' });
    expect(
      await runner.run(process.execPath, ['-e', 'process.exitCode=23']),
    ).toMatchObject({ exitCode: 23, signal: null });
    expect(
      await runner.run(process.execPath, [
        '-e',
        'process.kill(process.pid,"SIGTERM")',
      ]),
    ).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    expect(await runner.run(path.join(directory, 'missing'), [])).toMatchObject(
      {
        exitCode: -2,
        signal: null,
        spawnError: expect.stringContaining('ENOENT'),
        timedOut: false,
      },
    );
    await expect(
      runner.run(process.execPath, [], { timeoutMs: 0 }),
    ).rejects.toThrow('process timeout must be an integer');
  });

  test.each(['early-exit', 'cancelled'] as const)(
    'settles pending process input when the child is %s',
    async (mode) => {
      const directory = await temporaryDirectory();
      const readyPath = path.join(directory, 'input-child.pid');
      const controller = new AbortController();
      const artifacts = new ArtifactStore(directory, new Redactor());
      const runner = new ProcessRunner(artifacts, controller.signal, directory);
      const script =
        'require("node:fs").writeFileSync(process.argv[1],String(process.pid));' +
        (mode === 'early-exit'
          ? 'require("node:fs").closeSync(0);process.stdout.write("input-closed",()=>process.exit(23))'
          : 'setInterval(()=>{},1000)');
      const pending = runner.run(process.execPath, ['-e', script, readyPath], {
        stdin: 'x'.repeat(4 * 1024 * 1024),
        timeoutMs: 10_000,
        recordArtifact: false,
      });
      try {
        if (mode === 'cancelled') {
          await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true), {
            timeout: 3_000,
          });
          controller.abort(new Error('foreground SDK cancelled'));
        }
        const result = await pending;
        expect(result).toMatchObject({
          exitCode: mode === 'early-exit' ? 23 : null,
          signal: mode === 'early-exit' ? null : 'SIGTERM',
          stdout: mode === 'early-exit' ? 'input-closed' : '',
          timedOut: false,
          aborted: mode === 'cancelled',
        });
        expect(result).not.toHaveProperty('spawnError');
        const pid = Number(await readFile(readyPath, 'utf8'));
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();

        const cleanupRunner = new ProcessRunner(
          artifacts,
          new AbortController().signal,
          directory,
        );
        expect(
          await cleanupRunner.run(process.execPath, ['-e', 'process.exit(0)'], {
            recordArtifact: false,
          }),
        ).toMatchObject({ exitCode: 0, aborted: false, timedOut: false });
      } finally {
        controller.abort();
        await pending;
      }
    },
  );

  test.each(['stdout', 'stderr'] as const)(
    'retains the last 4 MiB of %s and continues beyond the limit',
    async (stream) => {
      const directory = await temporaryDirectory();
      const runner = new ProcessRunner(
        new ArtifactStore(directory, new Redactor()),
        new AbortController().signal,
        directory,
      );
      const other = stream === 'stdout' ? 'stderr' : 'stdout';
      const result = await runner.run(
        process.execPath,
        [
          '-e',
          `process.${stream}.write('discarded-prefix'+'x'.repeat(4*1024*1024+65536),()=>setTimeout(()=>{process.${stream}.write('after-limit\\r\\n');process.${other}.write('other-stream')},25))`,
        ],
        { recordArtifact: false },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        outputTruncated: true,
        [other]: 'other-stream',
      });
      expect(Buffer.byteLength(result[stream])).toBe(4 * 1024 * 1024);
      expect(result[stream]).toMatch(/after-limit\r\n$/);
      expect(result[stream]).not.toContain('discarded-prefix');
      expect(result.combined).toContain('after-limit');
      expect(result.combined).toContain('other-stream');
    },
  );

  test.each(['abort', 'overlap', 'leader-exits'])(
    'drains and force-kills an owned process group (%s)',
    async (mode) => {
      const directory = await temporaryDirectory();
      const readyPath = path.join(directory, 'tree.json');
      const termPath = path.join(directory, 'terminated');
      const controller = new AbortController();
      const descendant =
        'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([Number(process.argv[2]),process.pid]));setInterval(()=>{},1000)';
      const script = `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(process.argv[2],'term');${mode === 'leader-exits' ? 'process.exit(0)' : ''}});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1],String(process.pid)],{stdio:'inherit'});setInterval(()=>{},1000)`;
      const runner = new ProcessRunner(
        new ArtifactStore(directory, new Redactor()),
        controller.signal,
        directory,
      );
      const pending = runner.run(
        process.execPath,
        ['-e', script, readyPath, termPath],
        { timeoutMs: mode === 'abort' ? 10_000 : 1_000, recordArtifact: false },
      );
      let pids: number[] = [];
      let watchdogFired = false;
      const kill = () => {
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already reaped. */
          }
        }
      };
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        kill();
      }, 8_000);
      try {
        await vi.waitFor(
          async () => {
            pids = JSON.parse(await readFile(readyPath, 'utf8')) as number[];
            expect(pids).toHaveLength(2);
          },
          { timeout: 3_000 },
        );
        if (mode === 'overlap')
          await vi.waitFor(() => expect(existsSync(termPath)).toBe(true), {
            timeout: 3_000,
          });
        if (mode !== 'leader-exits')
          controller.abort(
            Object.assign(new Error('test cancellation'), {
              code: 'TEST_CANCEL',
            }),
          );
        const result = await pending;
        expect(result).toMatchObject({
          timedOut: mode !== 'abort',
          aborted: mode !== 'leader-exits',
          exitCode: mode === 'leader-exits' ? 0 : null,
        });
        expect(watchdogFired).toBe(false);
        expect(result).not.toHaveProperty('spawnError');
        await vi.waitFor(() => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        });
      } finally {
        clearTimeout(watchdog);
        kill();
        controller.abort();
        await pending;
      }
    },
  );

  test('test cancellation does not cancel an independent cleanup runner', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'separate cleanup signal' });
    const testController = new AbortController();
    testController.abort();
    const testRunner = new ProcessRunner(
      artifacts,
      testController.signal,
      directory,
    );
    const cleanupRunner = new ProcessRunner(
      artifacts,
      new AbortController().signal,
      directory,
    );

    const aborted = await testRunner.run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 2_000, label: 'cancelled-test' },
    );
    const cleanup = await cleanupRunner.run(
      process.execPath,
      ['-e', 'process.stdout.write("cleanup-complete")'],
      { timeoutMs: 2_000, label: 'independent-cleanup' },
    );

    expect(aborted.aborted).toBe(true);
    expect(cleanup).toMatchObject({
      aborted: false,
      exitCode: 0,
      stdout: 'cleanup-complete',
    });
  });

  test('cancels one native command without cancelling its reusable runner', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'per-command native cancellation' });
    const controller = new AbortController();
    controller.abort();
    const runner = new ProcessRunner(
      artifacts,
      new AbortController().signal,
      directory,
    );
    const cancelled = await runner.run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        signal: controller.signal,
        timeoutMs: 2_000,
        recordArtifact: false,
      },
    );
    const subsequent = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write("independent-read")'],
      {
        timeoutMs: 2_000,
        recordArtifact: false,
      },
    );
    expect(cancelled.aborted).toBe(true);
    expect(subsequent).toMatchObject({
      exitCode: 0,
      aborted: false,
      timedOut: false,
      stdout: 'independent-read',
    });
  });

  test('CLI retry backoff is cancelled without starting another attempt', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'CLI retry cancellation' });
    const controller = new AbortController();
    const runner = new ProcessRunner(artifacts, controller.signal, directory);
    const cli = new CliClient(
      runner,
      directory,
      directory,
      undefined,
      'token',
      controller.signal,
    );
    const transientResult = {
      executable: 'anycloud',
      args: ['vm'],
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'fetch failed',
      combined: 'fetch failed',
      durationMs: 1,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
    } as const;
    let attempts = 0;
    cli.run = async () => {
      attempts += 1;
      return transientResult;
    };

    const retry = cli.runWithTransientRetries(['vm']);
    setTimeout(() => controller.abort(), 10);

    await expect(retry).rejects.toThrow('CLI retry wait aborted');
    expect(attempts).toBe(1);
  });

  test('CLI children use the fixture API without production local-container discovery', async () => {
    const directory = await temporaryDirectory();
    const cliDirectory = path.join(directory, 'dist', 'cli');
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(
      path.join(cliDirectory, 'index.js'),
      'process.stdout.write(JSON.stringify({ apiUrl: process.env.API_URL, isTest: process.env.IS_TEST }))',
      'utf8',
    );
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'CLI fixture environment' });
    const endpoint = new ControllerEndpoint();
    endpoint.attach('http://127.0.0.1:43210');
    const cli = new CliClient(
      new ProcessRunner(artifacts, new AbortController().signal, directory),
      directory,
      path.join(directory, 'anycloud'),
      endpoint,
      'token',
    );

    const result = await cli.run(['probe']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      apiUrl: 'http://127.0.0.1:43210',
      isTest: 'true',
    });
  });

  test('artifacts redact registered values and sensitive response keys', async () => {
    const directory = await temporaryDirectory();
    const redactor = new Redactor();
    redactor.add('known-secret-value');
    const artifacts = new ArtifactStore(directory, redactor);
    await artifacts.initialize({ test: 'redaction' });

    const textPath = await artifacts.text(
      'output',
      'prefix known-secret-value suffix',
    );
    const jsonPath = await artifacts.json('response', {
      ordinary: 'visible',
      sshPrivateKey: 'unregistered-private-material',
    });

    expect(await readFile(textPath, 'utf8')).toBe('prefix [REDACTED] suffix');
    expect(await readFile(jsonPath, 'utf8')).toContain(
      '"sshPrivateKey": "[REDACTED]"',
    );
    expect(await readFile(jsonPath, 'utf8')).not.toContain(
      'unregistered-private-material',
    );
  });

  test('failure diagnostics retain primary context and tolerate unavailable remote evidence', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'failure diagnostics' });
    const unusedStatus = undefined as never;
    const diagnostics = new FailureDiagnostics({
      api: {
        lookupStatus: async () => ({
          kind: 'found' as const,
          status: unusedStatus,
        }),
      },
      artifacts,
      kernel: { trackedWorkloadIds: () => ['vm-diagnostic'] },
      remote: {
        run: async () => {
          throw new Error('SSH unavailable');
        },
      },
      runId: 'abc123def4',
      testName: 'loses its host',
    });

    await diagnostics.capture([new Error('primary assertion failed')]);

    expect(
      parseE2EFixtureRecord(
        JSON.parse(
          await readFile(path.join(directory, E2E_FIXTURE_RECORD_FILE), 'utf8'),
        ),
      ),
    ).toEqual({
      version: 1,
      testName: 'loses its host',
      runId: 'abc123def4',
      outcome: 'failed',
      failures: ['primary assertion failed'],
      workloads: [
        {
          id: 'vm-diagnostic',
          status: 'found',
          artifacts: ['diagnostic-status-vm-diagnostic.json'],
        },
      ],
      diagnosticErrors: [
        {
          workloadId: 'vm-diagnostic',
          operation: 'remote Docker diagnostics',
          error: 'SSH unavailable',
        },
      ],
    });
  });

  test('failure diagnostics link the substrate evidence they captured', async () => {
    const directory = await temporaryDirectory();
    const redactor = new Redactor();
    redactor.add('provider-token-value');
    const artifacts = new ArtifactStore(directory, redactor);
    await artifacts.initialize({ test: 'linked diagnostics' });
    const unusedStatus = undefined as never;
    const diagnostics = new FailureDiagnostics({
      api: {
        lookupStatus: async (id) =>
          id === 'vm-gone'
            ? { kind: 'absent' as const }
            : { kind: 'found' as const, status: unusedStatus },
      },
      artifacts,
      kernel: { trackedWorkloadIds: () => ['vm-live', 'vm-gone'] },
      remote: {
        run: async () => ({
          executable: 'ssh',
          args: [],
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          combined: 'container exited with provider-token-value',
          durationMs: 5,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
        }),
      },
      runId: 'run1234567',
      testName: 'keeps its container',
    });

    await diagnostics.capture([
      new Error('workload container missing after provider-token-value login'),
    ]);

    const record = parseE2EFixtureRecord(
      JSON.parse(
        await readFile(path.join(directory, E2E_FIXTURE_RECORD_FILE), 'utf8'),
      ),
    );
    // Triage copies these strings verbatim into START_HERE.md, so the record
    // itself must already be redacted.
    expect(record.failures).toEqual([
      'workload container missing after [REDACTED] login',
    ]);
    expect(record.diagnosticErrors).toEqual([]);
    expect(record.workloads).toEqual([
      {
        id: 'vm-live',
        status: 'found',
        artifacts: [
          'diagnostic-status-vm-live.json',
          'diagnostic-docker-vm-live.log',
        ],
      },
      // A confirmed-absent workload has no host left to inspect.
      { id: 'vm-gone', status: 'absent', artifacts: [] },
    ]);
    for (const artifact of record.workloads.flatMap((d) => d.artifacts)) {
      expect(existsSync(path.join(directory, artifact))).toBe(true);
    }
    expect(
      await readFile(
        path.join(directory, 'diagnostic-docker-vm-live.log'),
        'utf8',
      ),
    ).toBe('container exited with [REDACTED]');
  });

  test('Docker diagnostics collect state without container commands or environment secrets', async () => {
    const directory = await temporaryDirectory();
    const binaries = path.join(directory, 'bin');
    await mkdir(binaries);
    await writeFile(
      path.join(binaries, 'docker'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : undefined;
if (args[0] === 'ps') {
  const state = 'container-id\\timage:tag\\tUp 1 minute\\tvm-live';
  console.log(state + (format && !format.includes('.Command')
    ? ''
    : ' k3s server --token unregistered-k3s-bootstrap'));
} else if (args[0] === 'inspect') {
  const state = { Status: 'running', ExitCode: 0 };
  console.log(JSON.stringify(format === '{{json .State}}'
    ? state
    : { State: state, Config: { Env: ['TOKEN=unregistered-container-env'] } }));
} else if (args[0] === 'logs') {
  console.log('application ready');
} else {
  process.exitCode = 1;
}
`,
      { mode: 0o755 },
    );
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'Docker diagnostic privacy' });
    const runner = new ProcessRunner(
      artifacts,
      new AbortController().signal,
      directory,
    );
    const diagnostics = new FailureDiagnostics({
      api: {
        lookupStatus: async () => ({
          kind: 'found' as const,
          status: undefined as never,
        }),
      },
      artifacts,
      kernel: { trackedWorkloadIds: () => ['vm-live'] },
      remote: {
        run: async (_id, _target, command) =>
          runner.run('bash', ['-c', command], {
            env: { PATH: `${binaries}${path.delimiter}${process.env.PATH}` },
          }),
      },
      runId: 'privacy123',
      testName: 'retains only diagnostic container state',
    });

    await diagnostics.capture([new Error('primary failure')]);

    const output = await readFile(
      path.join(directory, 'diagnostic-docker-vm-live.log'),
      'utf8',
    );
    expect(output).toContain('container-id\timage:tag\tUp 1 minute\tvm-live');
    expect(output).toContain('"Status":"running"');
    expect(output).toContain('application ready');
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json') && !name.endsWith('.log')) continue;
      const retained = await readFile(path.join(directory, name), 'utf8');
      expect(retained).not.toContain('unregistered-k3s-bootstrap');
      expect(retained).not.toContain('unregistered-container-env');
    }
  });

  test('a passing fixture records the outcome without probing substrates', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'passing outcome' });
    const diagnostics = new FailureDiagnostics({
      api: {
        lookupStatus: async () => {
          throw new Error('a passing test must not be probed');
        },
      },
      artifacts,
      kernel: { trackedWorkloadIds: () => ['vm-passing'] },
      remote: {
        run: async () => {
          throw new Error('a passing test must not be probed');
        },
      },
      runId: 'pass123456',
      testName: 'reaches Running',
    });

    await diagnostics.capture([]);

    expect(
      parseE2EFixtureRecord(
        JSON.parse(
          await readFile(path.join(directory, E2E_FIXTURE_RECORD_FILE), 'utf8'),
        ),
      ),
    ).toMatchObject({
      outcome: 'passed',
      failures: [],
      workloads: [],
      diagnosticErrors: [],
    });
  });

  test('waits are bounded and retain the last useful observation', async () => {
    const waiter = new Waiter(new AbortController().signal);
    let attempt = 0;
    const deadlines: number[] = [];
    const started = Date.now();
    const value = await waiter.for(
      'eventual value',
      async (deadlineAt) => {
        deadlines.push(deadlineAt);
        attempt += 1;
        return attempt;
      },
      {
        timeoutMs: 200,
        intervalMs: 10,
        probeError: 'fail',
        unmet: (candidate: number) =>
          candidate === 3 ? undefined : String(candidate),
      },
    );
    expect(value).toBe(3);
    expect(deadlines).toHaveLength(3);
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(started + 200);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + 200);

    await expect(
      waiter.for('never ready', async () => 'pending', {
        timeoutMs: 30,
        intervalMs: 10,
        probeError: 'fail',
        unmet: (candidate: string) => candidate,
      }),
    ).rejects.toThrow('last observation: pending');

    await expect(
      waiter.for(
        'late accepted observation',
        () => new Promise((resolve) => setTimeout(() => resolve('ready'), 80)),
        {
          timeoutMs: 20,
          intervalMs: 5,
          probeError: 'fail',
          unmet: (candidate: unknown) =>
            candidate === 'ready' ? undefined : 'pending',
        },
      ),
    ).rejects.toThrow('timed out after 20ms');
  });

  test('a pause schedule bounds the attempts and an injected sleep paces them', async () => {
    const sleeps: number[] = [];
    const waiter = new Waiter(new AbortController().signal, async (ms) => {
      sleeps.push(ms);
    });
    const failures = [
      new Error('first'),
      new Error('second'),
      new Error('last'),
    ];
    const probe = vi.fn(async () => {
      throw failures[probe.mock.calls.length - 1];
    });
    const waiting = waiter.for('scheduled', probe, {
      timeoutMs: 10_000,
      intervalMs: [5, 0],
      probeError: { retry: () => true },
      unmet: () => undefined,
    });
    await expect(waiting).rejects.toThrow(
      'scheduled: gave up after 3 attempts (last observation: last)',
    );
    expect(sleeps).toEqual([5, 0]);
    await expect(waiting.catch(rethrowLastAttempt)).rejects.toBe(failures[2]);
  });

  test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 7_200_001])(
    'rejects invalid wait timeout %s before probing',
    async (timeoutMs) => {
      const probe = vi.fn(async () => 'ready');
      const waiter = new Waiter(new AbortController().signal);
      await expect(
        waiter.for('invalid timeout', probe, {
          timeoutMs,
          intervalMs: 1,
          probeError: 'fail',
          unmet: () => undefined,
        }),
      ).rejects.toThrow('wait timeout must be an integer');
      expect(probe).not.toHaveBeenCalled();
    },
  );

  test.each([0, -1, 0.5, 101])(
    'rejects invalid wait interval %s before probing',
    async (intervalMs) => {
      const probe = vi.fn(async () => 'ready');
      const waiter = new Waiter(new AbortController().signal);
      await expect(
        waiter.for('invalid interval', probe, {
          timeoutMs: 100,
          intervalMs,
          probeError: 'fail',
          unmet: () => undefined,
        }),
      ).rejects.toThrow('wait interval must be an integer');
      expect(probe).not.toHaveBeenCalled();
    },
  );

  test('accepts the maximum wait duration and an interval equal to the timeout', async () => {
    const waiter = new Waiter(new AbortController().signal);
    await expect(
      waiter.for('maximum duration', async () => 'ready', {
        timeoutMs: 7_200_000,
        intervalMs: 7_200_000,
        probeError: 'fail',
        unmet: () => undefined,
      }),
    ).resolves.toBe('ready');
  });

  test('does not start a probe after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn(async () => 'ready');
    await expect(
      new Waiter(controller.signal).for('cancelled', probe, {
        timeoutMs: 100,
        intervalMs: 10,
        probeError: 'fail',
        unmet: () => undefined,
      }),
    ).rejects.toThrow('cancelled: wait aborted');
    expect(probe).not.toHaveBeenCalled();
  });

  test('cancels an in-flight probe and releases its deadline timer and listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    let finishProbe = (_value: string): void => {};
    const pendingProbe = new Promise<string>((resolve) => {
      finishProbe = resolve;
    });
    const unmet = vi.fn(() => undefined);
    const settled = vi.fn();
    const waiting = new Waiter(controller.signal).for(
      'in-flight',
      () => pendingProbe,
      {
        timeoutMs: 100,
        intervalMs: 10,
        probeError: 'fail',
        unmet,
      },
    );
    void waiting.then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({
        message: expect.stringContaining('wait aborted'),
      }),
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    finishProbe('late response');
    await vi.advanceTimersByTimeAsync(100);
    expect(unmet).not.toHaveBeenCalled();
  });

  test('interrupts the interval between probes without leaving a timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const probe = vi.fn(async () => 'pending');
    const settled = vi.fn();
    const waiting = new Waiter(controller.signal).for('between probes', probe, {
      timeoutMs: 100,
      intervalMs: 10,
      probeError: 'fail',
      unmet: (value) => value,
    });
    void waiting.then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({
        message: expect.stringContaining('wait aborted'),
      }),
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test('rejects a hung probe at its deadline without waiting for the probe to settle', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const waiting = new Waiter(new AbortController().signal).for(
      'hung probe',
      () => new Promise<never>(() => {}),
      {
        timeoutMs: 100,
        intervalMs: 10,
        probeError: 'fail',
        unmet: () => undefined,
      },
    );
    void waiting.then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.any(WaitTimeoutError),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    { observedAt: 1_100, accepted: true },
    { observedAt: 1_101, accepted: false },
  ])(
    'accepts a ready response at the deadline but not after it: $observedAt',
    async ({ observedAt, accepted }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const waiting = new Waiter(new AbortController().signal).for(
        'deadline',
        async () => {
          vi.setSystemTime(observedAt);
          return 'ready';
        },
        {
          timeoutMs: 100,
          intervalMs: 10,
          probeError: 'fail',
          unmet: () => undefined,
        },
      );
      if (accepted) await expect(waiting).resolves.toBe('ready');
      else await expect(waiting).rejects.toBeInstanceOf(WaitTimeoutError);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test('does not start a probe if the deadline passes between checks', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_100);
    const probe = vi.fn(async () => 'ready');
    await expect(
      new Waiter(new AbortController().signal).for(
        'expired before probe',
        probe,
        {
          timeoutMs: 100,
          intervalMs: 10,
          probeError: 'fail',
          unmet: () => undefined,
        },
      ),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
    expect(probe).not.toHaveBeenCalled();
  });

  test('does not schedule another interval when an observation cancels the wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const settled = vi.fn();
    const waiting = new Waiter(controller.signal).for(
      'cancelled observation',
      async () => 'pending',
      {
        timeoutMs: 100,
        intervalMs: 10,
        probeError: 'fail',
        unmet: (value) => {
          controller.abort();
          return value;
        },
      },
    );
    void waiting.then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({
        message: expect.stringContaining('wait aborted'),
      }),
    });
  });

  test('releases timers and abort listeners after a completed multi-probe wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attempts = 0;
    const settled = vi.fn();
    const waiting = new Waiter(controller.signal).for(
      'ready after polling',
      async () => ++attempts,
      {
        timeoutMs: 100,
        intervalMs: 10,
        probeError: 'fail',
        unmet: (value) => (value === 3 ? undefined : 'pending'),
      },
    );
    void waiting.then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ value: 3 });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('terminal rejection takes precedence over an otherwise acceptable observation', async () => {
    const unmet = vi.fn(() => undefined);
    await expect(
      new Waiter(new AbortController().signal).for(
        'terminal',
        async () => 'failed',
        {
          timeoutMs: 100,
          intervalMs: 10,
          probeError: 'fail',
          unmet,
          reject: (value) =>
            value === 'failed' ? 'host permanently failed' : undefined,
        },
      ),
    ).rejects.toThrow('terminal: host permanently failed');
    expect(unmet).not.toHaveBeenCalled();
  });

  test('preserves a non-Error probe rejection as the error cause', async () => {
    const reason = { providerCode: 'E_CAPACITY' };
    await expect(
      new Waiter(new AbortController().signal).for(
        'provider',
        async () => {
          throw reason;
        },
        {
          timeoutMs: 100,
          intervalMs: 10,
          probeError: 'fail',
          unmet: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      message: 'E2E wait probe rejected with a non-Error value',
      cause: reason,
    });
  });

  test.each([
    '401',
    '403',
    'UNAUTHORIZED',
    'Unauthenticated',
    'Forbidden',
    'invalid credential',
    'authentication failed',
    'access denied',
    'credential mismatch',
  ])('does not retry a permanent probe failure: %s', (message) => {
    expect(retryTransientProbeError.retry(new Error(message))).toBe(false);
  });

  test.each([
    'provider 500',
    'connection reset',
    'retry in 4010ms',
    'provider 405',
    'request id x401',
  ])('allows a transient probe failure: %s', (message) => {
    expect(retryTransientProbeError.retry(new Error(message))).toBe(true);
  });

  test('caps retry pauses at the remaining deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    const probe = vi.fn(async () => {
      throw new Error('retryable probe failure');
    });
    const settled = vi.fn();
    void new Waiter(new AbortController().signal)
      .for('retry deadline', probe, {
        timeoutMs: 25,
        intervalMs: 10,
        probeError: { retry: () => true },
        unmet: () => undefined,
      })
      .then(
        (value) => settled({ value }),
        (error: unknown) => settled({ error }),
      );
    await vi.advanceTimersByTimeAsync(25);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.any(WaitTimeoutError),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['retryable error', 'unmet observation'] as const)(
    'finishes without another pause when a %s arrives at the deadline',
    async (outcome) => {
      vi.useFakeTimers({
        now: 0,
        toFake: ['Date', 'setTimeout', 'clearTimeout'],
      });
      const probe = vi.fn(async () => {
        vi.setSystemTime(25);
        if (outcome === 'retryable error') throw new Error('retryable failure');
        return 'pending';
      });
      const settled = vi.fn();
      void new Waiter(new AbortController().signal)
        .for('last attempt', probe, {
          timeoutMs: 25,
          intervalMs: 10,
          probeError: { retry: () => true },
          unmet: () => 'still pending',
        })
        .then(
          (value) => settled({ value }),
          (error: unknown) => settled({ error }),
        );
      // Drain promise continuations through a real turn, without advancing
      // the fake clock or allowing an unnecessary zero-delay pause to finish.
      await nextEventLoopTurn();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledExactlyOnceWith({
        error: expect.any(WaitTimeoutError),
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test('clears an earlier probe error when a later observation reaches the deadline', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const settled = vi.fn();
    const waiting = new Waiter(new AbortController().signal).for(
      'latest observation',
      async () => {
        if (++attempts === 1) throw new Error('old connection reset');
        return 'pending';
      },
      {
        timeoutMs: 25,
        intervalMs: 10,
        probeError: retryTransientProbeError,
        unmet: (value) => value,
      },
    );
    void waiting.then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({
        message: expect.stringContaining('last observation: pending)'),
      }),
    });
  });

  test('reports the same condition it was waiting on', async () => {
    // The predicate that decides to keep waiting is the one that explains the
    // timeout, so a wait cannot accept on one condition and report another.
    const waiter = new Waiter(new AbortController().signal);

    await expect(
      waiter.for('endpoint markers', async () => 'secret-ok', {
        timeoutMs: 30,
        intervalMs: 10,
        probeError: 'fail',
        unmet: (body: string) =>
          body.includes('service-marker')
            ? undefined
            : 'response omitted service-marker',
      }),
    ).rejects.toThrow('last observation: response omitted service-marker');
  });

  test('waits require an explicit probe-error policy', async () => {
    const waiter = new Waiter(new AbortController().signal);
    const fatal = new Error('contract response failed validation');
    let fatalAttempts = 0;
    await expect(
      waiter.for(
        'fatal probe',
        async () => {
          fatalAttempts += 1;
          throw fatal;
        },
        {
          timeoutMs: 100,
          intervalMs: 10,
          probeError: 'fail',
          unmet: () => 'never satisfied',
        },
      ),
    ).rejects.toBe(fatal);
    expect(fatalAttempts).toBe(1);

    await expect(
      waiter.for(
        'retryable probe',
        async () => {
          throw new Error('provider connection reset');
        },
        {
          timeoutMs: 30,
          intervalMs: 10,
          probeError: retryTransientProbeError,
          unmet: () => 'never satisfied',
        },
      ),
    ).rejects.toThrow('last observation: provider connection reset');
  });

  test('refuses to poll a failure that cannot become transient', async () => {
    // The hazard this replaces: a rejected credential polled to the deadline and
    // then reported as a bare timeout, hiding the actual cause.
    const waiter = new Waiter(new AbortController().signal);
    const rejected = new Error(
      'Azure host presence was rejected: 401 Unauthorized',
    );
    let attempts = 0;

    await expect(
      waiter.for(
        'provider presence',
        async () => {
          attempts += 1;
          throw rejected;
        },
        {
          timeoutMs: 100,
          intervalMs: 10,
          probeError: retryTransientProbeError,
          unmet: () => 'still present',
        },
      ),
    ).rejects.toBe(rejected);
    expect(attempts).toBe(1);
  });

  test('reports the probe error behind a wait that had already observed a value', async () => {
    const waiter = new Waiter(new AbortController().signal);
    let attempts = 0;

    await expect(
      waiter.for(
        'endpoint readiness',
        async () => {
          attempts += 1;
          if (attempts === 1) return 'starting';
          throw new Error('provider connection reset');
        },
        {
          timeoutMs: 40,
          intervalMs: 10,
          probeError: retryTransientProbeError,
          unmet: (state: string) =>
            state === 'ready' ? undefined : `state ${state}`,
        },
      ),
    ).rejects.toThrow(
      'state starting; last probe error: provider connection reset',
    );
  });

  test('provider profiles validate required input and redact credentials', () => {
    const redactor = new Redactor();
    const environment = new Environment(
      {
        AWS_ACCESS_KEY_ID: 'access-id',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_SESSION_TOKEN: 'session-token',
        AZURE_CLIENT_ID: 'azure-client',
        AZURE_CLIENT_SECRET: 'azure-secret',
        AZURE_SUBSCRIPTION_ID: 'azure-subscription',
        AZURE_TENANT_ID: 'azure-tenant',
        GCP_CLIENT_EMAIL: 'gcp@example.com',
        GCP_PRIVATE_KEY: 'gcp-private-key',
        GCP_PROJECT_ID: 'gcp-project',
        LAMBDA_API_KEY: 'lambda-key',
      },
      redactor,
    );
    const profiles = new ProviderProfiles(environment);
    const profile = profiles.vm('aws');

    expect(profile).toMatchObject({
      provider: 'AWS',
      credentialName: 'aws-test',
      vmTypes: ['t3.small'],
      credential: {
        accessKeyId: 'access-id',
        secretAccessKey: 'secret-key',
        sessionToken: 'session-token',
      },
    });
    expect(profiles.vm('azure')).toMatchObject({
      provider: 'Azure',
      credentialName: 'azure-test',
      vmTypes: ['Standard_D2s_v5'],
    });
    expect(profiles.vm('gcp')).toMatchObject({
      provider: 'GCP',
      credentialName: 'gcp-test',
      vmTypes: ['e2-standard-2'],
    });
    expect(profiles.vm('lambda')).toMatchObject({
      provider: 'Lambda',
      credentialName: 'lambda-test',
      vmTypes: ['cpu_4x_general', 'gpu_1x_a10', 'gpu_1x_a100_sxm4'],
    });
    expect(redactor.text('access-id secret-key session-token')).toBe(
      '[REDACTED] [REDACTED] [REDACTED]',
    );
    expect(() =>
      new ProviderProfiles(new Environment({}, new Redactor())).vm('aws'),
    ).toThrow('AWS_ACCESS_KEY_ID');
  });

  test('API calls own auth, status checks, artifacts, and private-key filtering', async () => {
    const directory = await temporaryDirectory();
    const redactor = new Redactor();
    const artifacts = new ArtifactStore(directory, redactor);
    await artifacts.initialize({ test: 'api' });
    const requests: {
      authorization?: string;
      body: unknown;
      method?: string;
      url?: string;
    }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body: body.length > 0 ? (JSON.parse(body) as unknown) : null,
          method: request.method,
          url: request.url,
        });
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/workloads/vm-test/ssh-access?mode=container') {
          response.end(
            JSON.stringify({
              workloadId: 'vm-test',
              vmIp: '127.0.0.1',
              sshHost: '127.0.0.1',
              sshPort: 22,
              sshUsername: 'root',
              sshPrivateKey: 'private-key-that-must-not-reach-artifacts',
            }),
          );
          return;
        }
        response.end(JSON.stringify({ message: 'Credential saved' }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not expose a TCP address');
      }
      const api = new ApiClient(
        `http://127.0.0.1:${address.port}`,
        'test-token',
        artifacts,
        redactor,
      );
      await api.saveCredential('aws-test', {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'access',
        secretAccessKey: 'secret',
      });
      const access = await api.sshAccessSummary('vm-test', 'container');

      expect(access).toMatchObject({
        workloadId: 'vm-test',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        hasPrivateKey: true,
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.authorization).toBe('Bearer test-token');
      expect(requests[0]).toMatchObject({
        method: 'PUT',
        url: '/v1/credentials/aws-test',
        body: {
          accessKeyId: 'access',
          secretAccessKey: 'secret',
        },
      });
      expect(requests[0]?.body).not.toHaveProperty('name');
      expect(requests[1]).toMatchObject({
        method: 'GET',
        url: '/v1/workloads/vm-test/ssh-access?mode=container',
      });

      const artifactNames = await readdir(directory);
      const apiArtifacts = await Promise.all(
        artifactNames
          .filter((name) => name.includes('api-'))
          .map((name) => readFile(path.join(directory, name), 'utf8')),
      );
      expect(apiArtifacts.join('\n')).not.toContain(
        'private-key-that-must-not-reach-artifacts',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('secret deletion and its durable readback share the original cleanup deadline', async () => {
    const directory = await temporaryDirectory();
    const redactor = new Redactor();
    const artifacts = new ArtifactStore(directory, redactor);
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
      if (request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
      }
      // The independent list read never responds. A successful DELETE cannot
      // complete cleanup, and readback must not start another 60-second budget.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Test API address missing');
      const cleanup = new AbortController();
      const api = new ApiClient(
        `http://127.0.0.1:${address.port}`,
        'test-token',
        artifacts,
        redactor,
        cleanup.signal,
      );
      await expect(
        api.deleteSecret('service-owned', Date.now() + 1_000),
      ).rejects.toThrow();
      expect(requests).toEqual([
        'DELETE /v1/secrets/service-owned?force=true',
        'GET /v1/secrets',
      ]);
      expect(cleanup.signal.aborted).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('API operations stop when the fixture signal is cancelled', async () => {
    const directory = await temporaryDirectory();
    const redactor = new Redactor();
    const artifacts = new ArtifactStore(directory, redactor);
    await artifacts.initialize({ test: 'API cancellation' });
    const server = createServer(() => {
      // Keep the response pending until the fixture aborts the request.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not expose a TCP address');
      }
      const controller = new AbortController();
      const api = new ApiClient(
        `http://127.0.0.1:${String(address.port)}`,
        'test-token',
        artifacts,
        redactor,
        controller.signal,
      );

      const request = api.lookupStatus('vm-cancelled');
      setTimeout(() => controller.abort(), 10);

      await expect(request).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('the fixture refuses to provision outside the constrained runner', () => {
    expect(() => assertConstrainedRunner(undefined)).toThrow(
      /run only under vitest\.e2e\.config\.mts/u,
    );
    expect(() => assertConstrainedRunner(false)).toThrow(
      /e2e\.sh <candidate> --vitest/u,
    );
    expect(assertConstrainedRunner(true)).toBeUndefined();
  });
});

// Safety cases from the retired controller-session internals spec: a cancelled
// readiness probe never yields a live child, a caller that will reuse durable
// process state gets a failure, not a silent unclean exit, a rejected startup
// leaves no child and keeps its output, and stop owns the whole process tree.
const readyRecordSchema = z.strictObject({
  version: z.literal(1),
  launchNonce: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
});

describe('managed controller process safety', () => {
  test('does not accept a successful readiness probe after cancellation', async () => {
    const directory = await temporaryDirectory();
    const managed = new ManagedProcess<number>(
      new ArtifactStore(directory, new Redactor()),
    );
    const controller = new AbortController();
    let pid: number | undefined;
    await expect(
      managed.startWithProbe({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: directory,
        label: 'cancelled-probe',
        readyTimeoutMs: 5_000,
        signal: controller.signal,
        probeReady: async (childPid) => {
          pid = childPid;
          controller.abort(new Error('readiness cancelled'));
          return childPid;
        },
      }),
    ).rejects.toThrow('readiness cancelled');
    expect(managed.active).toBe(false);
    expect(pid).toBeTypeOf('number');
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  test('requires a clean exit when the caller will reuse durable process state', async () => {
    const directory = await temporaryDirectory();
    const managed = new ManagedProcess<number>(
      new ArtifactStore(directory, new Redactor()),
    );
    const pid = await managed.startWithProbe({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: directory,
      label: 'unclean-state-owner',
      readyTimeoutMs: 5_000,
      signal: new AbortController().signal,
      probeReady: async (childPid) => childPid,
    });
    await expect(managed.stop(true)).rejects.toThrow('did not stop cleanly');
    expect(managed.active).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test.each(['missing', 'timeout', 'malformed', 'stale', 'rejected'])(
    'cleans up rejected startup and retains evidence (%s)',
    async (mode) => {
      const directory = await temporaryDirectory();
      const readyPath = path.join(directory, 'ready.json');
      const artifacts = new ArtifactStore(directory, new Redactor());
      const managed = new ManagedProcess(artifacts);
      if (mode === 'stale') await writeFile(readyPath, '{}');
      const script = `console.error('startup-evidence',process.pid);${mode === 'malformed' || mode === 'rejected' ? `require('node:fs').writeFileSync(process.argv[1],${JSON.stringify(mode === 'malformed' ? 'invalid' : '{}')});` : ''}setInterval(()=>{},1000)`;
      await expect(
        managed.start({
          executable:
            mode === 'missing'
              ? path.join(directory, 'missing')
              : process.execPath,
          args: ['-e', script, readyPath],
          cwd: directory,
          label: 'startup',
          readyPath,
          readyTimeoutMs: mode === 'timeout' ? 500 : 5_000,
          parseReady: () => {
            throw new Error('rejected-ready');
          },
        }),
      ).rejects.toThrow(
        {
          missing: 'ENOENT',
          timeout: 'did not become ready',
          malformed: 'not valid JSON',
          stale: 'already exists',
          rejected: 'rejected-ready',
        }[mode],
      );
      expect(managed.active).toBe(false);
      expect(() => managed.ready).toThrow(
        'has not emitted a valid ready record',
      );
      if (mode !== 'missing' && mode !== 'stale') {
        const evidence = await readFile(
          path.join(directory, 'startup-start-failure.log'),
          'utf8',
        );
        const pid = Number(/startup-evidence (\d+)/u.exec(evidence)?.[1]);
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
      }
      await managed.stop();
    },
  );

  test('treats an empty ready file as not ready until the record is written', async () => {
    const directory = await temporaryDirectory();
    const readyPath = path.join(directory, 'ready.json');
    const managed = new ManagedProcess<number>(
      new ArtifactStore(directory, new Redactor()),
    );
    // A truncating writer exposes an empty file before its bytes land.
    const script =
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'');setTimeout(()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid})),300);setInterval(()=>{},1000)";
    const pid = await managed.start({
      executable: process.execPath,
      args: ['-e', script, readyPath],
      cwd: directory,
      label: 'truncating-writer',
      readyPath,
      readyTimeoutMs: 5_000,
      parseReady: (candidate, childPid) => {
        expect(candidate).toEqual({ pid: childPid });
        return childPid;
      },
    });
    expect(pid).toBeTypeOf('number');
    await managed.stop();
    expect(managed.active).toBe(false);
  });

  test.each([false, true])(
    'retains tails and owns graceful/forced service shutdown (ignore TERM: %s)',
    async (ignoreTerm) => {
      const directory = await temporaryDirectory();
      const readyPath = path.join(directory, 'ready.json');
      const descendantPath = path.join(directory, 'descendant');
      const managed = new ManagedProcess<number>(
        new ArtifactStore(directory, new Redactor()),
      );
      vi.stubEnv('MANAGED_REMOVED', 'ambient');
      const descendant =
        'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
      const script = `process.on('SIGTERM',()=>{${ignoreTerm ? '' : "console.error('graceful-stop');clearInterval(interval)"}});const interval=setInterval(()=>{},1000);${ignoreTerm ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[2]],{stdio:'inherit'});` : ''}process.stdout.write('x'.repeat(4*1024*1024+65536)+'tail-marker',()=>{console.error(JSON.stringify({selected:process.env.MANAGED_SELECTED,removed:process.env.MANAGED_REMOVED}));require('node:fs').writeFileSync(process.argv[1],'{}')})`;
      const pid = await managed.start({
        executable: process.execPath,
        args: ['-e', script, readyPath, descendantPath],
        cwd: directory,
        env: { MANAGED_SELECTED: 'selected', MANAGED_REMOVED: undefined },
        label: 'service',
        readyPath,
        readyTimeoutMs: 5_000,
        parseReady: (_value, childPid) => childPid,
      });
      expect(managed.ready).toBe(pid);
      const pids = [pid];
      let watchdogFired = false;
      const kill = () => {
        for (const childPid of pids) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            /* Already reaped. */
          }
        }
      };
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        kill();
      }, 8_000);
      try {
        if (ignoreTerm) {
          await vi.waitFor(
            async () =>
              expect(
                Number(await readFile(descendantPath, 'utf8')),
              ).toBeGreaterThan(0),
            { timeout: 5_000 },
          );
          pids.push(Number(await readFile(descendantPath, 'utf8')));
        }
        await managed.stop();
        expect(managed.active).toBe(false);
        expect(watchdogFired).toBe(false);
        await vi.waitFor(() => {
          for (const childPid of pids)
            expect(() => process.kill(childPid, 0)).toThrow();
        });
        const output = await readFile(
          path.join(directory, 'service-stop.log'),
          'utf8',
        );
        expect(output).toContain('tail-marker');
        expect(output).toContain('{"selected":"selected"}');
        expect(output.includes('graceful-stop')).toBe(!ignoreTerm);
        expect(output.indexOf('\n\n[stderr]')).toBe(
          '[stdout]\n'.length + 4 * 1024 * 1024,
        );
        await managed.stop();
      } finally {
        clearTimeout(watchdog);
        kill();
      }
    },
  );

  test('retains child output when it exits before readiness', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'managed process failure' });
    const managed = new ManagedProcess(artifacts);
    await expect(
      managed.start({
        executable: process.execPath,
        args: ['-e', "console.error('before-ready-marker'); process.exit(23)"],
        cwd: directory,
        label: 'failing-child',
        readyPath: path.join(directory, 'missing-ready.json'),
        readyTimeoutMs: 5_000,
        parseReady: () => ({ ready: true }),
      }),
    ).rejects.toThrow('exited before readiness');
    expect(managed.active).toBe(false);
    expect(
      await readFile(
        path.join(directory, 'failing-child-start-failure.log'),
        'utf8',
      ),
    ).toContain('before-ready-marker');
  });

  // RFC 0017 core invariant 14: a replaced controller is a new OS process.
  test('hard-crashes one ready incarnation and accepts a new PID', async () => {
    const directory = await temporaryDirectory();
    const artifacts = new ArtifactStore(directory, new Redactor());
    await artifacts.initialize({ test: 'managed process replacement' });
    const managed = new ManagedProcess<{
      readonly launchNonce: string;
      readonly pid: number;
      readonly port: number;
      readonly version: 1;
    }>(artifacts);

    const start = async (launchNonce: string) => {
      const readyPath = path.join(directory, `${launchNonce}.json`);
      const script = [
        "const fs = require('node:fs')",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({version: 1, launchNonce: ${JSON.stringify(launchNonce)}, pid: process.pid, port: 8123}), {flag: 'wx'})`,
        'setInterval(() => {}, 1000)',
      ].join(';');
      return managed.start({
        executable: process.execPath,
        args: ['-e', script],
        cwd: directory,
        label: `child-${launchNonce}`,
        readyPath,
        readyTimeoutMs: 5_000,
        parseReady: (value, childPid) => {
          const record = readyRecordSchema.parse(value);
          if (record.launchNonce !== launchNonce) {
            throw new Error('stale launch nonce');
          }
          if (record.pid !== childPid) throw new Error('foreign child PID');
          return record;
        },
      });
    };

    const before = await start('first-launch');
    await managed.crash();
    const after = await start('second-launch');
    try {
      expect(after.pid).not.toBe(before.pid);
      expect(after.launchNonce).not.toBe(before.launchNonce);
    } finally {
      await managed.stop();
    }
  });
});

// Negative check kept from the retired read-retry internals spec: only the
// recognised unavailable-API diagnostics are retried, never plain errors or
// invalid successful output.
describe('bounded unavailable API reads', () => {
  test('does not retry plain errors or invalid successful database output', async () => {
    expect(
      retryUnavailableApiRead.retry(
        new Error('The API is temporarily unavailable (HTTP 522)'),
      ),
    ).toBe(false);
    const run = vi
      .fn()
      .mockResolvedValue(commandResultForTest({ stdout: '{}' }));
    const database = new CliDatabase({ run });
    const [result] = await Promise.allSettled([
      database.query('SELECT connection_revision FROM clusters', 'connection'),
    ]);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Expected invalid shape');
    expect(result.reason).toBeInstanceOf(Error);
    expect(retryUnavailableApiRead.retry(result.reason)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
