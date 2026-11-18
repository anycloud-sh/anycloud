import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, expectTypeOf, onTestFinished, test } from 'vitest';

import type {
  WorkloadStatusResponse as StatusResponse,
  StatusWorkloadMetadata,
} from '../../src/shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { WorkloadMutationTransport } from '../integration/e2e/internal/workload-mutations.js';
import {
  TrackedWorkloadKernel,
  type CleanupRecorded,
  type WorkloadKernel,
  type WorkloadReleaseEvidence,
  type TrackedWorkloadRef,
} from '../integration/e2e/internal/workloads.js';
import type { CliRunOptions } from '../integration/e2e/internal/cli.js';
import type {
  CommandResult,
  WorkloadCreateBody,
  WorkloadCreateResponse,
} from '../integration/e2e/internal/types.js';
import type { WaitOptions } from '../integration/e2e/internal/wait.js';
import {
  cleanupRecordedForTest,
  trackedWorkloadRefForTest,
  releaseEvidenceForTest,
} from './helpers/e2e.js';

function workload(
  id: string,
  state: WorkloadState,
  cleanedAt: number | null = null,
): StatusWorkloadMetadata {
  const terminal = state === WorkloadState.Terminated;
  return {
    id,
    userId: 'e2e-user',
    deploymentId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    claimed: false,
    workloadType: WorkloadType.Vm,
    image: 'alpine:3.20',
    cloudProvider: CloudType.Local,
    region: 'local',
    vmType: 'local',
    gpuType: null,
    spot: false,
    state,
    startedAt: 1,
    completedAt: terminal ? 100 : null,
    cleanedAt,
    endReason: null,
    lastAttemptEndReason: null,
    version: '1.0.0',
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: null,
    diskTier: null,
    diskIops: null,
    diskThroughputMibps: null,
    regions: null,
    dockerOptions: null,
    availabilityZone: null,
    vmCount: terminal ? 0 : 1,
    inputStorageRegion: null,
    outputStorageRegion: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    vmDurationMs: null,
    awaitingReleaseMs: null,
    totalCost: null,
    costSource: null,
    dnsRecordId: null,
    publicEndpoint: null,
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
  };
}

function status(
  id: string,
  state: WorkloadState,
  cleanedAt: number | null = null,
): StatusResponse {
  return {
    workload: workload(id, state, cleanedAt),
    events: [
      {
        id: 1,
        workloadId: id,
        state,
        metadata: null,
        createdAt: 100,
      },
    ],
    status: WorkloadHealthStatus.Up,
    vms: [],
  };
}

function commandResult(args: readonly string[]): CommandResult {
  return {
    executable: 'anycloud',
    args,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    combined: '',
    durationMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
  };
}

class SingleProbeWaiter {
  async for<T>(
    label: string,
    probe: (deadlineAt: number) => Promise<T>,
    options: WaitOptions<T>,
  ): Promise<T> {
    const value = await probe(Date.now() + options.timeoutMs);
    const rejection = options.reject?.(value);
    if (rejection) throw new Error(`${label}: ${rejection}`);
    const unmet = options.unmet(value);
    if (unmet === undefined) return value;
    throw new Error(`${label}: observation was not accepted (${unmet})`);
  }
}

function workloadBody(id: string): WorkloadCreateBody {
  return {
    id,
    image: 'alpine:3.20',
    workloadType: WorkloadType.Vm,
    cloudConfig: {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    },
  };
}

function kernelHarness(resultsDirectory?: string): {
  readonly apiCreateIds: string[];
  readonly cleanup: CleanupStack;
  readonly cliCalls: string[];
  readonly kernel: TrackedWorkloadKernel;
  readonly mutations: WorkloadMutationTransport;
  setStatus(value: StatusResponse | undefined): void;
} {
  let currentStatus: StatusResponse | undefined;
  const apiCreateIds: string[] = [];
  const cliCalls: string[] = [];
  const api = {
    createWorkload: async (
      body: WorkloadCreateBody,
    ): Promise<WorkloadCreateResponse> => {
      apiCreateIds.push(body.id);
      return { id: body.id };
    },
    lookupStatus: async () =>
      currentStatus
        ? { kind: 'found' as const, status: currentStatus }
        : { kind: 'absent' as const },
  };
  const run = async (
    args: readonly string[],
    _options?: CliRunOptions,
  ): Promise<CommandResult> => {
    cliCalls.push(args.join(' '));
    return commandResult(args);
  };
  const cli = { run, runWithTransientRetries: run };
  const cleanup = new CleanupStack();
  const kernel = new TrackedWorkloadKernel(
    api,
    cli,
    cleanup,
    new SingleProbeWaiter(),
    resultsDirectory,
  );
  return {
    apiCreateIds,
    cleanup,
    cliCalls,
    kernel,
    mutations: new WorkloadMutationTransport(kernel, api, cli),
    setStatus: (value) => {
      currentStatus = value;
    },
  };
}

async function controllerBoundKernel() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'e2e-workload-controller-'),
  );
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const original = { url: 'http://controller.invalid', generation: 1 };
  const state: {
    foreground: number;
    teardown: number;
    replaceAt?: 'termination' | 'status' | 'verification';
    terminateExitCode: number;
    absent: boolean;
    pauseStatus?: Promise<void>;
    statusError?: Error;
  } = { foreground: 1, teardown: 1, terminateExitCode: 0, absent: false };
  const calls: string[] = [];
  const client = (role: 'foreground' | 'teardown') => ({
    get controller() {
      return { url: original.url, generation: state[role] };
    },
    lookupStatus: async () => {
      calls.push(`${role}:status:${state[role]}`);
      await state.pauseStatus;
      if (state.replaceAt === 'status') state[role] += 1;
      if (state.statusError) throw state.statusError;
      if (state.absent) return { kind: 'absent' as const };
      return {
        kind: 'found' as const,
        status: status('job-controller', WorkloadState.Terminated, 100),
      };
    },
  });
  const cli = (role: 'foreground' | 'teardown') => ({
    run: async (args: readonly string[]) => {
      calls.push(`${role}:${args[0]}:${state[role]}`);
      if (state.replaceAt === 'termination') state[role] += 1;
      return { ...commandResult(args), exitCode: state.terminateExitCode };
    },
  });
  const cleanup = new CleanupStack();
  const kernel = new TrackedWorkloadKernel(
    client('foreground'),
    cli('foreground'),
    cleanup,
    new SingleProbeWaiter(),
    directory,
    {
      api: client('teardown'),
      cli: cli('teardown'),
      wait: new SingleProbeWaiter(),
    },
  );
  const ref = await kernel.reserveWithCleanupVerification(
    'job-controller',
    1_000,
    async () => {
      calls.push(`verify:${state.teardown}`);
      if (state.replaceAt === 'verification') state.teardown += 1;
    },
    original,
  );
  return {
    original,
    state,
    calls,
    cleanup,
    kernel,
    ref,
    manifest: () =>
      readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
  };
}

describe('rejected admission release', () => {
  test('releases exactly once after original native proof and a fresh original-controller API absence', async () => {
    const w = await controllerBoundKernel();
    w.state.absent = true;
    w.kernel.authorizeMutation(w.ref, w.ref.id);
    const proof = w.kernel.recordSubstrateAbsence(w.ref);
    expect(await w.manifest()).toContain(w.ref.id);
    await w.kernel.releaseUncreated(w.ref, proof);
    expect(w.calls).toEqual(['foreground:status:1']);
    expect(await w.manifest()).toBe('');
    expect(w.cleanup.observations()).toEqual([
      expect.objectContaining({
        label: `workload ${w.ref.id}`,
        completed: true,
      }),
    ]);
    await expect(w.kernel.releaseUncreated(w.ref, proof)).rejects.toThrow(
      'released',
    );
    await w.cleanup.run();
    expect(w.calls).toEqual(['foreground:status:1']);
  });

  test('rejects copied, foreign and pre-mutation native proofs without disarming cleanup', async () => {
    const w = await controllerBoundKernel();
    const other = await controllerBoundKernel();
    const early = w.kernel.recordSubstrateAbsence(w.ref);
    w.kernel.authorizeMutation(w.ref, w.ref.id);
    other.kernel.authorizeMutation(other.ref, other.ref.id);
    const original = w.kernel.recordSubstrateAbsence(w.ref);
    for (const proof of [
      early,
      { ...original },
      other.kernel.recordSubstrateAbsence(other.ref),
    ])
      await expect(w.kernel.releaseUncreated(w.ref, proof)).rejects.toThrow(
        'original native proof',
      );
    expect(await w.manifest()).toContain(w.ref.id);
    expect(w.calls).toEqual([]);
    expect(w.cleanup.observations()[0].completed).toBe(false);
  });

  test('neither repeated creation generations nor reservations without a controller can use admission release', async () => {
    const w = await controllerBoundKernel();
    w.kernel.authorizeMutation(w.ref, w.ref.id);
    const proof = w.kernel.recordSubstrateAbsence(w.ref);
    w.kernel.authorizeMutation(w.ref, w.ref.id);
    for (const candidate of [proof, w.kernel.recordSubstrateAbsence(w.ref)])
      await expect(w.kernel.releaseUncreated(w.ref, candidate)).rejects.toThrow(
        'original native proof',
      );
    const unbound = kernelHarness();
    const ref = await unbound.kernel.reserveWithCleanupVerification(
      'unbound',
      1000,
      async () => {},
    );
    unbound.kernel.authorizeMutation(ref, ref.id);
    await expect(
      unbound.kernel.releaseUncreated(
        ref,
        unbound.kernel.recordSubstrateAbsence(ref),
      ),
    ).rejects.toThrow('original native proof');
    expect(w.calls).toEqual([]);
    expect(unbound.cleanup.observations()[0].completed).toBe(false);
  });

  test.each(['present', 'replaced', 'lookup-error'] as const)(
    'keeps the reference and manifest when final API absence is %s',
    async (failure) => {
      const w = await controllerBoundKernel();
      w.kernel.authorizeMutation(w.ref, w.ref.id);
      w.state.absent = failure !== 'present';
      if (failure === 'replaced') w.state.replaceAt = 'status';
      if (failure === 'lookup-error')
        w.state.statusError = new Error('original API read failed');
      await expect(
        w.kernel.releaseUncreated(
          w.ref,
          w.kernel.recordSubstrateAbsence(w.ref),
        ),
      ).rejects.toThrow(
        failure === 'present'
          ? 'API record'
          : failure === 'replaced'
            ? 'original controller'
            : 'original API read failed',
      );
      expect(w.kernel.activeReference(w.ref.id)).toBe(w.ref);
      expect(await w.manifest()).toContain(w.ref.id);
      expect(w.cleanup.observations()[0].completed).toBe(false);
    },
  );

  test('joins a finalizer already reading absence and rejects mutation and a second finalizer', async () => {
    const w = await controllerBoundKernel();
    w.state.absent = true;
    let resume!: () => void;
    w.state.pauseStatus = new Promise<void>((resolve) => {
      resume = resolve;
    });
    w.kernel.authorizeMutation(w.ref, w.ref.id);
    const proof = w.kernel.recordSubstrateAbsence(w.ref);
    const release = w.kernel.releaseUncreated(w.ref, proof);
    const cleanup = w.cleanup.run();
    expect(() => w.kernel.authorizeMutation(w.ref, w.ref.id)).toThrow(
      'release has started',
    );
    await expect(w.kernel.releaseUncreated(w.ref, proof)).rejects.toThrow(
      'release has started',
    );
    resume();
    await Promise.all([release, cleanup]);
    expect(w.calls).toEqual(['foreground:status:1']);
    expect(await w.manifest()).toBe('');
  });

  test('native absence cannot impersonate persisted cleanup for the normal release path', async () => {
    const w = await controllerBoundKernel();
    w.kernel.authorizeMutation(w.ref, w.ref.id);
    const substrate = w.kernel.recordSubstrateAbsence(w.ref);
    await expect(
      w.kernel.release({
        cleanup: substrate as unknown as CleanupRecorded,
        substrate,
        ledger: w.kernel.recordLedgerCleared(w.ref, 0),
      }),
    ).rejects.toThrow('forged or belongs elsewhere');
    expect(await w.manifest()).toContain(w.ref.id);
    expect(w.cleanup.observations()[0].completed).toBe(false);
  });
});

describe('opted-in Workload controller ownership', () => {
  test('requires the actual foreground and teardown controller readers before registration', async () => {
    const world = kernelHarness();
    await expect(
      world.kernel.reserveWithCleanupVerification(
        'missing-controller',
        1_000,
        async () => undefined,
        { url: 'http://controller.invalid', generation: 1 },
      ),
    ).rejects.toThrow('original controller');
    expect(world.kernel.trackedWorkloadIds()).toEqual([]);
    expect(world.cleanup.observations()).toEqual([]);
    expect(world.cliCalls).toEqual([]);
  });

  test.each(['foreground', 'teardown'] as const)(
    'does not mutate through a replacement %s controller',
    async (role) => {
      const w = await controllerBoundKernel();
      w.state[role] = 2;
      if (role === 'foreground') {
        expect(() => w.kernel.authorizeMutation(w.ref, w.ref.id)).toThrow(
          'original controller',
        );
        await expect(w.kernel.requestTermination(w.ref, 1_000)).rejects.toThrow(
          'original controller',
        );
      } else
        await expect(w.cleanup.run()).rejects.toThrow('original controller');
      expect(w.calls).toEqual([]);
      expect(await w.manifest()).toContain(w.ref.id);
      expect(w.cleanup.observations()).toEqual([
        expect.objectContaining({ completed: false }),
      ]);
    },
  );

  test.each([0, 1])(
    'a replacement during termination exit %i cannot reach a later read or native verifier',
    async (terminateExitCode) => {
      const w = await controllerBoundKernel();
      w.state.terminateExitCode = terminateExitCode;
      w.state.replaceAt = 'termination';
      await expect(w.cleanup.run()).rejects.toThrow('original controller');
      expect(w.calls).toEqual(['teardown:terminate:1']);
      expect(await w.manifest()).toContain(w.ref.id);
      expect(w.cleanup.observations()[0].completed).toBe(false);
    },
  );

  test('a replacement during a fallback status read cannot count as original cleanup', async () => {
    const w = await controllerBoundKernel();
    w.state.replaceAt = 'status';
    await expect(w.cleanup.run()).rejects.toThrow('original controller');
    expect(w.calls).toEqual(['teardown:terminate:1', 'teardown:status:1']);
    expect(await w.manifest()).toContain(w.ref.id);
    expect(w.cleanup.observations()[0].completed).toBe(false);
  });

  test('a replacement during the native verifier retains the manifest after all earlier cleanup reads', async () => {
    const w = await controllerBoundKernel();
    w.state.replaceAt = 'verification';
    await expect(w.cleanup.run()).rejects.toThrow('original controller');
    expect(w.calls).toEqual([
      'teardown:terminate:1',
      'teardown:status:1',
      'verify:1',
    ]);
    expect(await w.manifest()).toContain(w.ref.id);
    expect(w.cleanup.observations()[0].completed).toBe(false);
  });

  test.each(['status', 'state', 'cleanup'] as const)(
    'does not accept %s observations after the controller changes during the read',
    async (operation) => {
      const w = await controllerBoundKernel();
      w.state.replaceAt = 'status';
      const result =
        operation === 'status'
          ? w.kernel.status(w.ref)
          : operation === 'state'
            ? w.kernel.waitForState(w.ref, WorkloadState.Terminated, 1_000)
            : w.kernel.waitForCleanupRecorded(w.ref, 1_000);
      await expect(result).rejects.toThrow('original controller');
      expect(w.calls).toEqual(['foreground:status:1']);
      expect(await w.manifest()).toContain(w.ref.id);
    },
  );

  test('a previously minted cleanup proof cannot release a reference through a replacement controller', async () => {
    const w = await controllerBoundKernel();
    const cleanup = await w.kernel.waitForCleanupRecorded(w.ref, 1_000);
    const evidence = {
      cleanup,
      ledger: w.kernel.recordLedgerCleared(w.ref, 0),
      substrate: w.kernel.recordSubstrateAbsence(w.ref),
    };
    w.state.foreground = 2;
    await expect(w.kernel.release(evidence)).rejects.toThrow(
      'original controller',
    );
    expect(await w.manifest()).toContain(w.ref.id);
    expect(w.cleanup.observations()[0].completed).toBe(false);
  });

  test('caller mutation cannot replace the original bound incarnation', async () => {
    const w = await controllerBoundKernel();
    w.original.generation = 2;
    w.state.teardown = 2;
    await expect(w.cleanup.run()).rejects.toThrow('original controller');
    expect(w.calls).toEqual([]);
    expect(await w.manifest()).toContain(w.ref.id);
  });

  test('unchanged original teardown completes after native verification', async () => {
    const w = await controllerBoundKernel();
    await w.cleanup.run();
    expect(w.calls).toEqual([
      'teardown:terminate:1',
      'teardown:status:1',
      'verify:1',
    ]);
    expect(await w.manifest()).toBe('');
    expect(w.cleanup.observations()[0].completed).toBe(true);
  });
});

/**
 * Releasing requires all three observations. These cases are about the cleanup
 * proof, so the other two are minted from the kernel under test.
 */
function evidenceFor(
  kernel: TrackedWorkloadKernel,
  cleanup: CleanupRecorded,
): WorkloadReleaseEvidence {
  return {
    cleanup,
    ledger: kernel.recordLedgerCleared(cleanup.ref, 0),
    substrate: kernel.recordSubstrateAbsence(cleanup.ref),
  };
}

describe('tracked workload kernel', () => {
  test.each([false, true])(
    'joins an already-owned explicit release without racing native verification (durable manifest: %s)',
    async (durableManifest) => {
      const directory = durableManifest
        ? await mkdtemp(path.join(tmpdir(), 'e2e-release-ownership-'))
        : undefined;
      if (directory)
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const world = kernelHarness(directory);
      let verifierCalls = 0;
      const ref = await world.kernel.reserveWithCleanupVerification(
        'job-release-owner',
        1_000,
        async () => {
          verifierCalls += 1;
          throw new Error('A second cleanup owner must not run');
        },
      );
      world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
      const proof = evidenceFor(
        world.kernel,
        await world.kernel.waitForCleanupRecorded(ref, 1_000),
      );
      const release = world.kernel.release(proof);
      const cleanup = world.cleanup.run();
      const attempts = await Promise.allSettled([release, cleanup]);
      expect(attempts).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(verifierCalls).toBe(0);
      expect(world.cliCalls).toEqual([]);
      expect(world.kernel.activeReference(ref.id)).toBeUndefined();
      expect(world.cleanup.observations()).toEqual([
        { label: `workload ${ref.id}`, completed: true },
      ]);
      if (directory)
        expect(
          await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
        ).toBe('');
    },
  );

  test('keeps unresolved tracking when fallback wins the race and its native verifier rejects', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'e2e-fallback-ownership-'),
    );
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const world = kernelHarness(directory);
    let fail: (() => void) | undefined;
    let begin: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const original = new Error('Native Job host remains present');
    const ref = await world.kernel.reserveWithCleanupVerification(
      'job-fallback-owner',
      1_000,
      async () => {
        begin?.();
        await waiting;
        throw original;
      },
    );
    world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
    const proof = evidenceFor(
      world.kernel,
      await world.kernel.waitForCleanupRecorded(ref, 1_000),
    );
    const cleanup = Promise.allSettled([world.cleanup.run()]);
    const release = Promise.allSettled([world.kernel.release(proof)]);
    await started;
    const [releaseResult] = await release;
    expect(releaseResult?.status).toBe('rejected');
    if (releaseResult?.status !== 'rejected')
      throw new Error('Release unexpectedly passed');
    expect(releaseResult.reason).toHaveProperty(
      'message',
      `Workload cleanup verification has started: ${ref.id}`,
    );
    fail?.();
    const [cleanupResult] = await cleanup;
    expect(cleanupResult?.status).toBe('rejected');
    if (cleanupResult?.status !== 'rejected')
      throw new Error('Cleanup unexpectedly passed');
    const aggregate = cleanupResult.reason as AggregateError;
    expect(aggregate.errors[0]).toHaveProperty('cause', original);
    expect(world.kernel.activeReference(ref.id)).toBe(ref);
    expect(
      await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
    ).toBe(`${ref.id}\n`);
    expect(world.cleanup.observations()).toEqual([
      { label: `workload ${ref.id}`, completed: false },
    ]);
  });

  test.each(['absent', 'cleaned'] as const)(
    'verifies native cleanup before forgetting a %s Workload',
    async (durableState) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'e2e-native-cleanup-'),
      );
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const world = kernelHarness(directory);
      const verified: TrackedWorkloadRef[] = [];
      const ref = await world.kernel.reserveWithCleanupVerification(
        'job-native-cleanup',
        1_000,
        async (candidate, timeoutMs) => {
          verified.push(candidate);
          expect(timeoutMs).toBe(1_000);
          expect(world.cliCalls).toEqual(['terminate job-native-cleanup']);
          expect(world.kernel.activeReference(candidate.id)).toBe(candidate);
          expect(
            await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
          ).toBe('job-native-cleanup\n');
          expect(world.cleanup.observations()).toEqual([
            { label: 'workload job-native-cleanup', completed: false },
          ]);
        },
      );
      if (durableState === 'cleaned') {
        world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
      }
      await world.cleanup.run();
      expect(verified).toEqual([ref]);
      expect(world.kernel.activeReference(ref.id)).toBeUndefined();
      expect(
        await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
      ).toBe('');
      expect(world.cleanup.observations()).toEqual([
        { label: 'workload job-native-cleanup', completed: true },
      ]);
    },
  );

  test.each(['absent', 'cleaned'] as const)(
    'retains the original reference and manifest when %s cleanup has unresolved native identity',
    async (durableState) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'e2e-unresolved-cleanup-'),
      );
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const world = kernelHarness(directory);
      const original = new Error(
        'Original native attempt coordinates remain unknown',
      );
      const ref = await world.kernel.reserveWithCleanupVerification(
        'job-native-unknown',
        1_000,
        async () => {
          throw original;
        },
      );
      await world.mutations.createWithApi(ref, workloadBody(ref.id));
      if (durableState === 'cleaned') {
        world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
      }
      const [result] = await Promise.allSettled([world.cleanup.run()]);
      expect(result?.status).toBe('rejected');
      if (result?.status !== 'rejected')
        throw new Error('Cleanup unexpectedly passed');
      expect(result.reason).toBeInstanceOf(AggregateError);
      const aggregate = result.reason as AggregateError;
      expect(aggregate.errors).toHaveLength(1);
      expect(aggregate.errors[0]).toHaveProperty('cause', original);
      expect(world.kernel.activeReference(ref.id)).toBe(ref);
      expect(
        await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
      ).toBe(`${ref.id}\n`);
      expect(world.cleanup.observations()).toEqual([
        { label: `workload ${ref.id}`, completed: false },
      ]);
    },
  );

  test('atomically reserves one private verification requirement and fences mutation or release while it awaits native absence', async () => {
    expectTypeOf<'reserveWithCleanupVerification'>().not.toMatchTypeOf<
      keyof WorkloadKernel
    >();
    const world = kernelHarness();
    let finish: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ref = await world.kernel.reserveWithCleanupVerification(
      'job-fenced-cleanup',
      1_000,
      async (candidate) => {
        expect(candidate).toBe(ref);
        entered?.();
        await pending;
      },
    );
    await world.mutations.createWithApi(ref, workloadBody(ref.id));
    world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
    const proof = evidenceFor(
      world.kernel,
      await world.kernel.waitForCleanupRecorded(ref, 1_000),
    );
    let replacementCalls = 0;
    await expect(
      world.kernel.reserveWithCleanupVerification(ref.id, 1_000, async () => {
        replacementCalls += 1;
      }),
    ).rejects.toThrow('already registered');
    const cleanup = Promise.allSettled([world.cleanup.run()]);
    await started;
    await expect(
      world.mutations.createWithApi(ref, workloadBody(ref.id)),
    ).rejects.toThrow('cleanup verification has started');
    await expect(world.kernel.release(proof)).rejects.toThrow(
      'cleanup verification has started',
    );
    expect(world.apiCreateIds).toEqual([ref.id]);
    expect(world.kernel.activeReference(ref.id)).toBe(ref);
    finish?.();
    expect(await cleanup).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(replacementCalls).toBe(0);
    expect(world.kernel.activeReference(ref.id)).toBeUndefined();
  });

  test('does not call native verification before durable cleanup is confirmed', async () => {
    const world = kernelHarness();
    let verifierCalls = 0;
    const ref = await world.kernel.reserveWithCleanupVerification(
      'job-durable-pending',
      1_000,
      async () => {
        verifierCalls += 1;
      },
    );
    world.setStatus(status(ref.id, WorkloadState.Terminated));
    await expect(world.cleanup.run()).rejects.toThrow('cleanup pending');
    expect(verifierCalls).toBe(0);
    expect(world.kernel.activeReference(ref.id)).toBe(ref);
    expect(world.cleanup.observations()).toEqual([
      { label: `workload ${ref.id}`, completed: false },
    ]);
  });

  test('keeps a new reservation when two Workloads release concurrently', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e2e-workloads-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const world = kernelHarness(directory);
    const refs = await Promise.all(
      ['job-one', 'job-two'].map((id) => world.kernel.reserve(id, 1_000)),
    );
    const evidence = [];
    for (const ref of refs) {
      world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
      evidence.push(
        evidenceFor(
          world.kernel,
          await world.kernel.waitForCleanupRecorded(ref, 1_000),
        ),
      );
    }

    await Promise.all([
      ...evidence.map((proofs) => world.kernel.release(proofs)),
      world.kernel.reserve('job-three', 1_000),
    ]);

    expect(
      await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
    ).toBe('job-three\n');
    expect(world.cleanup.observations()).toEqual([
      { label: 'workload job-one', completed: true },
      { label: 'workload job-two', completed: true },
      { label: 'workload job-three', completed: false },
    ]);
    world.setStatus(undefined);
    await world.cleanup.run();
    expect(
      await readFile(path.join(directory, 'workloads-to-clean'), 'utf8'),
    ).toBe('');
  });

  test('retains fallback tracking when its manifest cannot be read', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e2e-workloads-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const world = kernelHarness(directory);
    const ref = await world.kernel.reserve('job-one', 1_000);
    world.setStatus(status(ref.id, WorkloadState.Terminated, 200));
    const manifest = path.join(directory, 'workloads-to-clean');
    await rm(manifest);
    await mkdir(manifest);

    await expect(world.cleanup.run()).rejects.toThrow('E2E cleanup failed');
    expect(() => world.kernel.assertActive(ref)).not.toThrow();
    expect(world.cleanup.observations()).toEqual([
      { label: 'workload job-one', completed: false },
    ]);
  });

  test('requires an opaque active reference and the exact outgoing ID', async () => {
    expectTypeOf<string>().not.toMatchTypeOf<TrackedWorkloadRef>();
    expectTypeOf<
      Parameters<WorkloadMutationTransport['createWithApi']>[0]
    >().toEqualTypeOf<TrackedWorkloadRef>();

    const harness = kernelHarness();
    const ref = await harness.kernel.reserve('vm-one', 1_000);
    await expect(harness.kernel.reserve(ref.id, 1_000)).rejects.toThrow(
      'already registered',
    );

    await expect(
      harness.mutations.createWithApi(ref, workloadBody(ref.id)),
    ).resolves.toMatchObject({ id: 'vm-one' });
    expect(harness.apiCreateIds).toEqual(['vm-one']);

    await expect(
      harness.mutations.createWithApi(ref, workloadBody('vm-two')),
    ).rejects.toThrow('cannot authorize mutation of vm-two');
    await expect(
      harness.mutations.createWithApi(
        trackedWorkloadRefForTest(ref.id),
        workloadBody(ref.id),
      ),
    ).rejects.toThrow('forged, stale, or released');
    await expect(
      harness.kernel.requestTermination(
        trackedWorkloadRefForTest(ref.id),
        1_000,
      ),
    ).rejects.toThrow('forged, stale, or released');
    expect(harness.apiCreateIds).toEqual(['vm-one']);

    harness.setStatus(status('different-id', WorkloadState.Terminated, 110));
    await expect(harness.kernel.status(ref)).rejects.toThrow(
      'identified workload different-id',
    );
    harness.setStatus(status(ref.id, WorkloadState.Terminated, 110));
    const proof = await harness.kernel.waitForCleanupRecorded(ref, 1_000);
    await harness.kernel.release(evidenceFor(harness.kernel, proof));
    await expect(harness.kernel.status(ref)).rejects.toThrow(
      'forged, stale, or released',
    );
  });

  // Invariant 12: the three observations cannot stand in for one another, so
  // releasing fallback cleanup requires evidence of all three rather than a
  // persisted record alone.
  test('refuses to release without every cleanup observation', async () => {
    const harness = kernelHarness();
    const ref = await harness.kernel.reserve('vm-evidence', 1_000);
    await harness.mutations.runCliCreate(ref, [
      'service',
      'example:v1',
      '--id',
      ref.id,
    ]);
    harness.setStatus(status(ref.id, WorkloadState.Terminated, 110));
    const cleanup = await harness.kernel.waitForCleanupRecorded(ref, 1_000);

    expect(() => harness.kernel.recordLedgerCleared(ref, 1)).toThrow(
      'still has 1 live VM rows',
    );

    const other = await harness.kernel.reserve('vm-other', 1_000);
    await expect(
      harness.kernel.release({
        cleanup,
        ledger: harness.kernel.recordLedgerCleared(other, 0),
        substrate: harness.kernel.recordSubstrateAbsence(ref),
      }),
    ).rejects.toThrow('mixes workloads');

    await harness.kernel.release({
      cleanup,
      ledger: harness.kernel.recordLedgerCleared(ref, 0),
      substrate: harness.kernel.recordSubstrateAbsence(ref),
    });
    await expect(harness.kernel.status(ref)).rejects.toThrow(
      'forged, stale, or released',
    );
  });

  test('rejects stale and reused persisted-cleanup proofs', async () => {
    const harness = kernelHarness();
    const ref = await harness.kernel.reserve('vm-generation', 1_000);
    await harness.mutations.runCliCreate(ref, [
      'service',
      'example:v1',
      '--id',
      ref.id,
    ]);
    harness.setStatus(status(ref.id, WorkloadState.Terminated, 110));
    await expect(
      harness.kernel.release(
        releaseEvidenceForTest(
          cleanupRecordedForTest(
            ref,
            status(ref.id, WorkloadState.Terminated, 110),
          ),
        ),
      ),
    ).rejects.toThrow('forged or belongs elsewhere');
    const stale = await harness.kernel.waitForCleanupRecorded(ref, 1_000);

    await harness.mutations.runCliUpgrade(ref, [
      'service',
      'upgrade',
      ref.id,
      'example:v2',
    ]);
    await expect(
      harness.kernel.release(evidenceFor(harness.kernel, stale)),
    ).rejects.toThrow('stale');

    const staleAfterResubmit = await harness.kernel.waitForCleanupRecorded(
      ref,
      1_000,
    );
    await harness.mutations.runCliResubmit(ref, ['resubmit', ref.id]);
    await expect(
      harness.kernel.release(evidenceFor(harness.kernel, staleAfterResubmit)),
    ).rejects.toThrow('stale');

    const current = await harness.kernel.waitForCleanupRecorded(ref, 1_000);
    const currentEvidence = evidenceFor(harness.kernel, current);
    await harness.kernel.release(currentEvidence);
    await expect(harness.kernel.release(currentEvidence)).rejects.toThrow(
      'already used',
    );
    await harness.cleanup.run();
    expect(harness.cliCalls).toEqual([
      'service example:v1 --id vm-generation',
      'service upgrade vm-generation example:v2',
      'resubmit vm-generation',
    ]);
  });

  test('keeps create, upgrade, and resubmit transports distinct', async () => {
    const harness = kernelHarness();
    const ref = await harness.kernel.reserve('vm-mutation-kind', 1_000);

    await expect(
      harness.mutations.runCliCreate(ref, [
        'service',
        'upgrade',
        ref.id,
        'example:v2',
      ]),
    ).rejects.toThrow('Unsupported tracked CLI create');
    await expect(
      harness.mutations.runCliUpgrade(ref, [
        'vm',
        'example:v1',
        '--id',
        ref.id,
      ]),
    ).rejects.toThrow('service upgrade <id>');
    await expect(
      harness.mutations.runCliResubmit(ref, [
        'resubmit',
        ref.id,
        'different-id',
      ]),
    ).rejects.toThrow('exactly: resubmit <id>');
    await expect(
      harness.mutations.runCliCreate(ref, ['api', 'serve', '--id', ref.id]),
    ).rejects.toThrow('Unsupported tracked CLI create');
    expect(harness.cliCalls).toEqual([]);

    await harness.cleanup.run();
  });

  test('does not reinterpret an absent row as an exact terminal state', async () => {
    const harness = kernelHarness();
    const ref = await harness.kernel.reserve('vm-absent', 1_000);

    await expect(
      harness.kernel.waitForState(ref, WorkloadState.Terminated, 1_000),
    ).rejects.toThrow('observation was not accepted (not found)');

    await harness.cleanup.run();
    expect(harness.cliCalls).toEqual(['terminate vm-absent']);
  });

  test('mints no cleanup proof before cleanedAt is persisted', async () => {
    const harness = kernelHarness();
    const ref = await harness.kernel.reserve('vm-cleanup-pending', 1_000);
    harness.setStatus(status(ref.id, WorkloadState.Terminated));

    await expect(
      harness.kernel.waitForCleanupRecorded(ref, 1_000),
    ).rejects.toThrow(
      'observation was not accepted (terminated, cleanup pending)',
    );

    harness.setStatus(undefined);
    await harness.cleanup.run();
  });

  test('keeps fallback cleanup armed until a persisted proof is released', async () => {
    const harness = kernelHarness();
    await harness.kernel.reserve('vm-fallback', 1_000);

    await harness.cleanup.run();

    expect(harness.cliCalls).toEqual(['terminate vm-fallback']);
  });

  test('fallback cleanup uses teardown-owned clients after test clients fail', async () => {
    const cleanup = new CleanupStack();
    const cleanupCalls: string[] = [];
    const failedTestDependency = async (): Promise<never> => {
      throw new Error('test signal already aborted');
    };
    const kernel = new TrackedWorkloadKernel(
      { lookupStatus: failedTestDependency },
      { run: failedTestDependency },
      cleanup,
      new SingleProbeWaiter(),
      undefined,
      {
        api: {
          lookupStatus: async () => {
            cleanupCalls.push('cleanup-status');
            return { kind: 'absent' as const };
          },
        },
        cli: {
          run: async (args) => {
            cleanupCalls.push(args.join(' '));
            return commandResult(args);
          },
        },
        wait: new SingleProbeWaiter(),
      },
    );
    await kernel.reserveWithCleanupVerification(
      'vm-independent-cleanup',
      1_000,
      async (ref) => {
        cleanupCalls.push(`native-absence ${ref.id}`);
      },
    );

    await cleanup.run();

    expect(cleanupCalls).toEqual([
      'terminate vm-independent-cleanup',
      'cleanup-status',
      'native-absence vm-independent-cleanup',
    ]);
  });
});
