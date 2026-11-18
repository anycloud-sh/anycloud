import { describe, expect, test } from 'vitest';

import { WorkloadState } from '../../src/shared/workload.js';
import {
  CHECK_IMAGE,
  POOL_CHECK_PASSED,
  POOL_RERUN,
  POOL_RETRY_ELSEWHERE,
  PoolChecks,
  type PoolChecksPort,
  type PoolJob,
  type PoolNode,
  type PoolPod,
} from '../integration/e2e/internal/contracts/pool-checks.js';
import type { Waiter } from '../integration/e2e/internal/wait.js';

/** Probes until met, at most eight times, without sleeping; a timeout names the last unmet reason. */
const wait: Pick<Waiter, 'for'> = {
  for: async (label, probe, options) => {
    let unmet: string | undefined;
    for (let poll = 0; poll < 8; poll += 1) {
      const value = await probe(0);
      const rejection = options.reject?.(value);
      if (rejection) throw new Error(`${label}: ${rejection}`);
      unmet = options.unmet(value);
      if (unmet === undefined) return value;
    }
    throw new Error(`${label}: timed out: ${String(unmet)}`);
  },
};

const GIB = 1024 ** 3;
const START = 1_000_000;

function node(overrides: Partial<PoolNode> = {}): PoolNode {
  return {
    name: 'node-a',
    ready: true,
    unschedulable: false,
    unusableGpu: false,
    attempt: '7',
    bootId: 'boot-1',
    leaseRenewedAt: 0,
    allocatableMemoryBytes: 2 * GIB,
    ...overrides,
  };
}

function pod(overrides: Partial<PoolPod> & Pick<PoolPod, 'uid'>): PoolPod {
  return {
    name: overrides.uid,
    nodeName: 'node-a',
    phase: 'Running',
    unschedulable: false,
    createdAt: 0,
    cpuRequestMilli: 1000,
    memoryRequestBytes: GIB,
    memoryLimitBytes: GIB,
    ephemeralStorageRequestBytes: 45 * GIB,
    gpus: 0,
    runnerImage: null,
    ...overrides,
  };
}

const syncing = (podUid: string) => ({
  state: WorkloadState.Syncing,
  text: JSON.stringify({ podUid }),
  podUid,
  at: 0,
});
const event = (state: WorkloadState, metadata: object, at = 0) => ({
  state,
  text: JSON.stringify(metadata),
  podUid: null,
  at,
});

/** A port whose every verb is unused unless the test supplies it. */
function port(overrides: Partial<PoolChecksPort>): PoolChecksPort {
  const unused = (name: string) => () => {
    throw new Error(`unexpected ${name}`);
  };
  return {
    nodes: unused('nodes'),
    coldStart: unused('coldStart'),
    bootstrapTokenAttempts: async () => [],
    hostShell: unused('hostShell'),
    startHostShell: unused('startHostShell'),
    instances: unused('instances'),
    pods: unused('pods'),
    createPool: unused('createPool'),
    deletePool: async () => undefined,
    stageInput: unused('stageInput'),
    submitJob: unused('submitJob'),
    victim: unused('victim'),
    job: unused('job'),
    jobLog: unused('jobLog'),
    readOutput: unused('readOutput'),
    terminateJob: async () => undefined,
    publishedService: unused('publishedService'),
    entryIp: unused('entryIp'),
    watchRequests: unused('watchRequests'),
    record: async () => undefined,
    ...overrides,
  };
}

/** `p`, recording each Job it submits and terminates. */
function tracked(p: PoolChecksPort) {
  const submitted: string[] = [];
  const terminated: string[] = [];
  return {
    submitted,
    terminated,
    port: {
      ...p,
      submitJob: async (...args: Parameters<PoolChecksPort['submitJob']>) => {
        submitted.push(args[0]);
        return p.submitJob(...args);
      },
      terminateJob: async (id: string) => {
        terminated.push(id);
        await p.terminateJob(id);
      },
    },
  };
}

function checks(
  p: PoolChecksPort,
  policy: Partial<ConstructorParameters<typeof PoolChecks>[0]['policy']> = {},
) {
  let t = START;
  return new PoolChecks({
    port: p,
    policy: { gpusPerNode: 1, nodePoolMs: 1, workloadMs: 1, ...policy },
    wait,
    progress: { mark: () => undefined },
    // Each read of the clock is a second later.
    clock: { now: () => (t += 1_000) },
  });
}

describe('agent-restart', () => {
  /**
   * The pool's one Node through a restart and a reboot. `fixed` keeps the
   * agent's kubelet certificates; without it the restarted agent can't
   * authenticate, so its Lease is never renewed again.
   */
  function restartPort(options: {
    fixed: boolean;
    rebootChangesBoot?: boolean;
    instancesAfter?: readonly string[];
    renamed?: boolean;
    pidAfter?: string;
    keyAfter?: string;
    removed?: string[];
  }) {
    let now = 0;
    let bootId = 'boot-1';
    let shells = 0;
    let rebootReads = 0;
    const instanceReads: (readonly string[])[] = [
      ['i-1'],
      options.instancesAfter ?? ['i-1'],
    ];
    return port({
      nodes: async () => {
        now += 60_000;
        // The reboot lands a few reads after its Pod starts, never at once.
        if (shells > 1 && (rebootReads += 1) === 3) {
          if (options.rebootChangesBoot ?? true) bootId = 'boot-2';
        }
        return [
          node({
            name: options.renamed && shells > 1 ? 'node-b' : 'node-a',
            bootId,
            leaseRenewedAt: shells === 0 || options.fixed ? 2e6 + now * 10 : 1,
          }),
        ];
      },
      instances: async () => instanceReads.shift() ?? [],
      hostShell: async (_node, script) => {
        shells += 1;
        expect(script).toContain('systemctl restart k3s-agent');
        return `PID_BEFORE=100\nKEY_BEFORE=k1\nPID_AFTER=${options.pidAfter ?? '200'}\nKEY_AFTER=${options.keyAfter ?? 'k1'}\n`;
      },
      startHostShell: async (_node, script) => {
        shells += 1;
        expect(script).toContain('= "boot-1" &&');
        expect(script).toContain('systemctl reboot');
        return async () => {
          options.removed?.push(script);
        };
      },
    });
  }

  test('passes when the Node rejoins as itself after a restart and a reboot awaited by its boot ID', async () => {
    const removed: string[] = [];
    const record = await checks(
      restartPort({ fixed: true, removed }),
    ).agentRestart('np-1');
    expect(removed).toHaveLength(1);
    expect(record).toMatchObject({
      node: 'node-a',
      attempt: '7',
      instances: ['i-1'],
      restart: { pidBefore: '100', pidAfter: '200' },
      reboot: { bootIdBefore: 'boot-1', bootIdAfter: 'boot-2' },
    });
  });

  test('fails when the restarted agent never renews its Lease, as before the fix', async () => {
    await expect(
      checks(restartPort({ fixed: false })).agentRestart('np-1'),
    ).rejects.toThrow(/Ready again[\s\S]*Lease last renewed 1/u);
  });

  test('fails when the reboot did not happen, and still deletes its Pod', async () => {
    const removed: string[] = [];
    await expect(
      checks(
        restartPort({ fixed: true, rebootChangesBoot: false, removed }),
      ).agentRestart('np-1'),
    ).rejects.toThrow(/boot ID still boot-1/u);
    expect(removed).toHaveLength(1);
  });

  test('fails when the agent kept its PID: no restart happened', async () => {
    await expect(
      checks(restartPort({ fixed: true, pidAfter: '100' })).agentRestart(
        'np-1',
      ),
    ).rejects.toThrow(/k3s-agent on node-a did not restart/u);
  });

  test('fails when the restart replaced the kubelet client key, as before the fix', async () => {
    await expect(
      checks(restartPort({ fixed: true, keyAfter: 'k2' })).agentRestart('np-1'),
    ).rejects.toThrow(/did not keep its kubelet client key/u);
  });

  test('fails when the Node was replaced or a VM was added', async () => {
    await expect(
      checks(restartPort({ fixed: true, renamed: true })).agentRestart('np-1'),
    ).rejects.toThrow(/Node node-a is gone: replaced/u);
    await expect(
      checks(
        restartPort({ fixed: true, instancesAfter: ['i-1', 'i-2'] }),
      ).agentRestart('np-1'),
    ).rejects.toThrow(/instances changed from i-1 to i-1, i-2/u);
  });

  test('fails when the bootstrap token is never deleted', async () => {
    await expect(
      checks({
        ...restartPort({ fixed: true }),
        bootstrapTokenAttempts: async () => ['7'],
      }).agentRestart('np-1'),
    ).rejects.toThrow(/token for attempt 7 remains/u);
  });
});

describe('entry-handoff', () => {
  function handoffPort(failed: number, ips: readonly string[]) {
    const queue = [...ips];
    return port({
      publishedService: async () => ({
        url: 'https://svc.anycloud.sh/',
        ip: ips[0],
      }),
      entryIp: async () => (queue.length > 1 ? queue.shift()! : queue[0]),
      watchRequests: () => async () => ({
        requests: 400,
        failed,
        longestGapMs: 300,
        failures: {},
      }),
    });
  }

  test('passes with every request answered while the entry moved', async () => {
    const handoff = await checks(
      handoffPort(0, ['10.0.0.1', '10.0.0.2']),
    ).startEntryHandoff('svc');
    await handoff.observe();
    const record = await handoff.stop();
    expect(record.requests).toEqual({
      requests: 400,
      failed: 0,
      longestGapMs: 300,
      failures: {},
    });
    expect(record.entries.map((entry) => entry.ip)).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
  });

  test('fails when a request failed through the replacements, as before the fix', async () => {
    const handoff = await checks(
      handoffPort(3, ['10.0.0.1', '10.0.0.2']),
    ).startEntryHandoff('svc');
    await handoff.observe();
    await expect(handoff.stop()).rejects.toThrow(/3 of 400 requests/u);
  });

  test('fails when the entry never moved, so no hand-off was tested', async () => {
    const handoff = await checks(
      handoffPort(0, ['10.0.0.1']),
    ).startEntryHandoff('svc');
    await handoff.observe();
    await expect(handoff.stop()).rejects.toThrow(/no entry hand-off/u);
  });
});

/**
 * The CPU pools of `cpu-defaults`: each Job's state script is read in turn
 * and its last entry sticks; Pods follow the Jobs that hold a replica.
 */
function cpuPort(options: {
  readonly replica?: Partial<PoolPod>;
  readonly allocatable?: number;
  readonly hogEnd?: PoolJob;
  /** The privileged hog's end; OOMKilled otherwise. */
  readonly privilegedHogEnd?: PoolJob;
  readonly hogNode?: string;
  readonly neighbourEnd?: WorkloadState;
  readonly scaleInstances?: number;
  readonly unschedulable?: boolean;
  /** Each Job's end by label; Completed otherwise. */
  readonly ends?: Readonly<Record<string, WorkloadState>>;
  readonly smallAllocatable?: number;
}) {
  const scripts = new Map<string, PoolJob[]>();
  const live = new Set<string>();
  const running = (id: string): PoolJob => ({
    state: WorkloadState.Running,
    events: [syncing(`pod-${id}`)],
  });
  const ended = (id: string, state: WorkloadState, extra: object = {}) => ({
    state,
    events: [syncing(`pod-${id}`), event(state, extra)],
  });
  let scaling = false;
  return port({
    createPool: async (label) => label,
    stageInput: async () => 'e2e-clust-in-1-abcd',
    submitJob: async (label) => {
      live.add(label);
      if (label.startsWith('cpu-scale-')) scaling = true;
      scripts.set(
        label,
        label === 'cpu-hog' || label === 'cpu-hog-priv'
          ? [
              (label === 'cpu-hog'
                ? options.hogEnd
                : options.privilegedHogEnd) ??
                ended(label, WorkloadState.Errored, {
                  reason: 'OOMKilled',
                  exitCode: 137,
                }),
            ]
          : label === 'cpu-neighbour'
            ? [running(label)]
            : [
                running(label),
                running(label),
                ended(label, options.ends?.[label] ?? WorkloadState.Completed),
              ],
      );
      return label;
    },
    job: async (id) => {
      const script = scripts.get(id)!;
      const next = script.length > 1 ? script.shift()! : script[0];
      if (
        id === 'cpu-neighbour' &&
        options.neighbourEnd &&
        scripts.has('cpu-hog')
      )
        return { ...next, state: options.neighbourEnd };
      return next;
    },
    terminateJob: async (id) => {
      live.delete(id);
    },
    pods: async (pool) =>
      [...live]
        .filter((id) => (pool === 'cpu-small') === (id === 'cpu-small'))
        .map((id, i) =>
          pod({
            uid: `pod-${id}`,
            ...(id.startsWith('cpu-scale-')
              ? i > 1
                ? {
                    nodeName: options.scaleInstances === 1 ? null : 'node-b',
                    unschedulable: options.unschedulable ?? true,
                    phase: 'Pending',
                  }
                : {}
              : id === 'cpu-hog' && options.hogNode
                ? { nodeName: options.hogNode }
                : {}),
            ...options.replica,
          }),
        )
        .concat(
          scaling && options.scaleInstances !== 1
            ? [pod({ uid: 'pod-late', nodeName: 'node-b' })]
            : [],
        ),
    instances: async () =>
      scaling
        ? Array.from(
            { length: options.scaleInstances ?? 2 },
            (_, i) => `i-${String(i)}`,
          )
        : ['i-0'],
    nodes: async (pool) => [
      node({
        allocatableMemoryBytes:
          (pool === 'cpu-small'
            ? options.smallAllocatable
            : options.allocatable) ?? 2 * GIB,
      }),
    ],
  });
}

describe('cpu-defaults', () => {
  const policy = {
    gpusPerNode: 0,
    cpu: { vmType: 't3.large', vCPUs: 2, smallVmType: 't2.micro' },
  };

  test('passes with 1-CPU replicas, an OOMKilled hog, a scale-out and a small Node', async () => {
    const record = await checks(cpuPort({}), policy).cpuDefaults();
    expect(record.disk.pod.cpuRequestMilli).toBe(1000);
    expect(record.memory.node).toBe('node-a');
    expect(record.scaleOut.instances).toHaveLength(2);
    expect(record.smallNode.vmType).toBe('t2.micro');
  });

  test('runs its privileged hog on the cpu-defaults pool, created to allow privileged Jobs', async () => {
    const pools: Parameters<PoolChecksPort['createPool']>[] = [];
    const jobs: Parameters<PoolChecksPort['submitJob']>[] = [];
    const p = cpuPort({});
    await checks(
      {
        ...p,
        createPool: async (...args) => (
          pools.push(args),
          p.createPool(...args)
        ),
        submitJob: async (...args) => (jobs.push(args), p.submitJob(...args)),
      },
      policy,
    ).cpuDefaults();
    expect(pools.map(([label, spec]) => [label, spec.privilegedJobs])).toEqual([
      ['cpu-defaults', true],
      ['cpu-small', undefined],
    ]);
    expect(
      jobs
        .filter(([, , spec]) => spec.privileged)
        .map(([label, pool]) => [label, pool]),
    ).toEqual([['cpu-hog-priv', 'cpu-defaults']]);
  });

  test('terminates every Job it waited on, so no cleanup calls a deleted hosted API (run 40815343132)', async () => {
    const { port: p, submitted, terminated } = tracked(cpuPort({}));
    await checks(p, policy).cpuDefaults();
    expect(terminated.sort()).toEqual(submitted.sort());
  });

  test.each<[string, Parameters<typeof cpuPort>[0], RegExp]>([
    [
      'a 100m replica, as before the fix',
      { replica: { cpuRequestMilli: 100, memoryLimitBytes: null } },
      /requests 100m CPU, not 1/u,
    ],
    [
      'a default disk Job that fails',
      { ends: { 'cpu-disk': WorkloadState.Errored } },
      /the default disk Job ended errored/u,
    ],
    [
      'a 1-CPU replica with no memory limit',
      { replica: { memoryLimitBytes: null } },
      /memory limit null is not its request/u,
    ],
    [
      'a disk share that cannot hold the Job',
      { replica: { ephemeralStorageRequestBytes: GIB } },
      /disk share .* cannot hold/u,
    ],
    [
      "a Node that can't hold two default replicas",
      { allocatable: 1.5 * GIB },
      /t3.large's allocatable memory .* can't hold two default replicas/u,
    ],
    [
      'a hog that is not OOMKilled',
      {
        hogEnd: {
          state: WorkloadState.Errored,
          events: [
            syncing('pod-cpu-hog'),
            event(WorkloadState.Errored, { exitCode: 1 }),
          ],
        },
      },
      /without OOMKilled/u,
    ],
    [
      'a privileged hog reported as a plain exit 137, as before the fix',
      {
        privilegedHogEnd: {
          state: WorkloadState.Errored,
          events: [
            syncing('pod-cpu-hog-priv'),
            event(WorkloadState.Errored, { exitCode: 137 }),
          ],
        },
      },
      /privileged Job past its memory share ended errored without OOMKilled/u,
    ],
    ['a hog on another Node', { hogNode: 'node-b' }, /did not share a Node/u],
    [
      'a neighbour that ended with the hog',
      { neighbourEnd: WorkloadState.Errored },
      /neighbour Job did not keep running/u,
    ],
    [
      'a pool that never scales out',
      { scaleInstances: 1 },
      /scale out .* timed out/u,
    ],
    [
      'a scale-out with no Unschedulable replica',
      { unschedulable: false },
      /unschedulable seen: false/u,
    ],
    [
      'a default Job on the 1 GiB type that fails',
      { ends: { 'cpu-small': WorkloadState.Errored } },
      /a default Job on t2.micro ended errored/u,
    ],
    [
      "a 1 GiB Node that can't allocate a default replica's memory",
      { smallAllocatable: GIB / 2 },
      /t2.micro's allocatable memory/u,
    ],
  ])('fails on %s', async (_case, options, error) => {
    await expect(
      checks(cpuPort(options), policy).cpuDefaults(),
    ).rejects.toThrow(error);
  });
});

/**
 * `cpu-cold-start`'s pool: each cache Job is observed running, then
 * completed; the replica's Node and Pod times are fixed.
 */
function coldStartPort(options: {
  readonly instances?: readonly string[];
  readonly logs?: Readonly<Record<string, string>>;
  readonly cacheEnd?: WorkloadState;
  readonly noPull?: boolean;
  readonly noLaunch?: boolean;
  readonly warmNode?: string;
}) {
  const scripts = new Map<string, PoolJob[]>();
  const pools: { minVms: number }[] = [];
  const caches: (readonly string[] | undefined)[] = [];
  const running = (id: string): PoolJob => ({
    state: WorkloadState.Running,
    events: [syncing(`pod-${id}`), event(WorkloadState.Running, {}, 70_000)],
  });
  return {
    pools,
    caches,
    port: port({
      createPool: async (label, spec) => {
        pools.push({ minVms: spec.minVms });
        return label;
      },
      instances: async () => options.instances ?? [],
      submitJob: async (label, _pool, spec) => {
        expect(spec.image).toBe(CHECK_IMAGE);
        caches.push(spec.caches);
        scripts.set(label, [
          running(label),
          {
            state: options.cacheEnd ?? WorkloadState.Completed,
            events: running(label).events,
          },
        ]);
        return label;
      },
      job: async (id) => {
        const script = scripts.get(id)!;
        return script.length > 1 ? script.shift()! : script[0];
      },
      coldStart: async (_pool, podUid) => ({
        node:
          podUid === 'pod-cache-warm'
            ? (options.warmNode ?? 'node-a')
            : 'node-a',
        vmLaunchedAtMs: options.noLaunch ? null : 1_000,
        nodeCreatedAtMs: 50_000,
        nodeReadyAtMs: 60_000,
        gpuPluginStartedAtMs: null,
        podScheduledAtMs: 61_000,
        imagePull: options.noPull
          ? null
          : { atMs: 65_000, elapsedMs: 0, alreadyPresent: true },
        runnerImagePull: null,
        containerStartedAtMs: 66_000,
      }),
      jobLog: async (id) =>
        options.logs?.[id] ??
        (id === 'cache-cold'
          ? 'Successfully installed\nCACHE_BEFORE=0\nCACHE_AFTER=57000000\nINSTALL_MS=9000\nFETCHED_BYTES=58000000\n'
          : 'CACHE_BEFORE=57000000\nCACHE_AFTER=57000000\nINSTALL_MS=2000\nFETCHED_BYTES=900000\n'),
    }),
  };
}

describe('cpu-cold-start (RFC 0049 C11, C12, C22)', () => {
  const policy = {
    gpusPerNode: 0,
    cpu: { vmType: 't3.large', vCPUs: 2, smallVmType: 't2.micro' },
  };

  test('with C11, C12 and C22: a Job scales a pool from zero, then a second finds its cache', async () => {
    const { port: p, pools, caches } = coldStartPort({});
    const { port: t, submitted, terminated } = tracked(p);
    const record = await checks(t, policy).cpuColdStart(true);
    expect(pools).toEqual([{ minVms: 0 }]);
    expect(caches).toEqual([['pip:/cache'], ['pip:/cache']]);
    // The Pod waited for its Node: the whole span from the VM's launch.
    expect(record.coldStart).toMatchObject({
      jobId: 'cache-cold',
      jobRunningAtMs: 70_000,
      imagePull: { alreadyPresent: true },
      durationsMs: expect.objectContaining({ total: 69_000 }),
    });
    expect(record.cache).toEqual({
      cold: {
        jobId: 'cache-cold',
        installMs: 9000,
        fetchedBytes: 58_000_000,
        cacheBytesBefore: 0,
        cacheBytesAfter: 57_000_000,
      },
      warm: {
        jobId: 'cache-warm',
        installMs: 2000,
        fetchedBytes: 900_000,
        cacheBytesBefore: 57_000_000,
        cacheBytesAfter: 57_000_000,
      },
    });
    expect(terminated.sort()).toEqual(submitted.sort());
  });

  test('without them (0.1.72): the same Job once on the pool its one Node started, with no total', async () => {
    const {
      port: p,
      pools,
      caches,
    } = coldStartPort({
      instances: ['i-1'],
    });
    const record = await checks(p, policy).cpuColdStart(false);
    expect(pools).toEqual([{ minVms: 1 }]);
    expect(caches).toEqual([undefined]);
    expect(record.coldStart.durationsMs.total).toBeUndefined();
    expect(record.cache.warm).toBeUndefined();
  });

  test.each<[string, Parameters<typeof coldStartPort>[0], RegExp]>([
    [
      'a --min-vms 0 pool that starts with a VM',
      { instances: ['i-1'] },
      /the --min-vms 0 pool cold-start started with i-1/u,
    ],
    [
      'a replica with no Pulled event',
      { noPull: true },
      /has no Pulled event for its image/u,
    ],
    ['a Node with no VM launch', { noLaunch: true }, /has no VM launch time/u],
    [
      'a cache Job that fails',
      { cacheEnd: WorkloadState.Errored },
      /the cache Job cache-cold ended errored/u,
    ],
    [
      'a cache Job that logs no install time',
      { logs: { 'cache-cold': 'CACHE_BEFORE=0\n' } },
      /the cache Job cache-cold logged no INSTALL_MS/u,
    ],
    [
      'a cold cache that was not empty',
      {
        logs: {
          'cache-cold':
            'CACHE_BEFORE=5\nCACHE_AFTER=57000000\nINSTALL_MS=1\nFETCHED_BYTES=1\n',
        },
      },
      /the cold cache Job found 5 bytes/u,
    ],
    [
      'a warm Job on another Node',
      { warmNode: 'node-b' },
      /the warm cache Job ran on node-b, not the cold one's Node node-a/u,
    ],
    [
      'a warm Job on a Node without the cache',
      {
        logs: {
          'cache-warm':
            'CACHE_BEFORE=0\nCACHE_AFTER=57000000\nINSTALL_MS=9000\nFETCHED_BYTES=58000000\n',
        },
      },
      /the warm cache Job found 0 bytes, not the 57000000/u,
    ],
  ])('fails on %s', async (_case, options, error) => {
    await expect(
      checks(coldStartPort(options).port, policy).cpuColdStart(true),
    ).rejects.toThrow(error);
  });
});

describe('pool-gpu-probe', () => {
  /** A one-Node GPU pool; `rerun` is the missing-GPU Job's events. */
  function gpuPort(options: {
    fabric?: string;
    gpuOk?: WorkloadState;
    rerunEnd?: WorkloadState;
    rerun?: PoolJob['events'];
    /** On a 2-GPU Node: the missing-GPU Job beside the memory holder. */
    coLocated?: PoolJob['events'];
    marked?: boolean;
    leftover?: boolean;
    /** A check Pod created this long before the run's clock. */
    checkAgeMs?: number;
    firstReplicaKept?: boolean;
    gpuReplicaLeft?: boolean;
  }) {
    const jobs = new Map<string, PoolJob>();
    const rerun = options.rerun ?? [
      syncing('pod-1'),
      event(WorkloadState.Retrying, {
        reason: `GPU unusable in its container; ${POOL_RERUN}`,
      }),
      syncing('pod-2'),
      event(WorkloadState.Errored, {
        message: `Exited with code 1; the Job failed the same way in a new Pod, and the GPUs on Node node-a ${POOL_CHECK_PASSED}, so the image is the likely cause`,
      }),
    ];
    let reads = 0;
    return port({
      nodes: async () => [node({ unusableGpu: options.marked ?? false })],
      hostShell: async () =>
        options.fabric ??
        'LoadState=loaded\nResult=success\nExecMainStatus=0\n',
      submitJob: async (label) => {
        jobs.set(
          label,
          label === 'gpu-ok'
            ? { state: options.gpuOk ?? WorkloadState.Completed, events: [] }
            : label === 'gpu-hold'
              ? { state: WorkloadState.Running, events: [syncing('pod-hold')] }
              : {
                  state: options.rerunEnd ?? WorkloadState.Errored,
                  events:
                    label === 'gpu-coloc'
                      ? (options.coLocated ?? rerun)
                      : rerun,
                },
        );
        return label;
      },
      job: async (id) => jobs.get(id)!,
      jobLog: async () => 'HELD=23000000000\nTOTAL=24000000000\n',
      pods: async () => {
        reads += 1;
        return [
          ...(options.firstReplicaKept
            ? [pod({ uid: 'pod-1', gpus: 1, phase: 'Succeeded' })]
            : []),
          ...(reads === 1 || options.leftover
            ? [
                pod({
                  uid: 'check',
                  name: 'anycloud-gpu-check-1',
                  createdAt: START - (options.checkAgeMs ?? 0),
                  gpus: 0,
                }),
              ]
            : []),
          ...(options.gpuReplicaLeft
            ? [pod({ uid: 'pod-stuck', gpus: 1, phase: 'Running' })]
            : []),
        ];
      },
    });
  }

  test('passes on the rerun path with a passing check and an untouched Node', async () => {
    const record = await checks(gpuPort({})).poolGpuProbe('np-1');
    expect(record.pass.replicaPods).toEqual(['pod-1', 'pod-2']);
    expect(record.pass.errored).toContain(POOL_CHECK_PASSED);
    expect(record.coLocated).toBeNull();
  });

  test('terminates every Job it waited on, so no cleanup calls a deleted hosted API (run 40815343132)', async () => {
    const { port: p, submitted, terminated } = tracked(gpuPort({}));
    await checks(p, { gpusPerNode: 2 }).poolGpuProbe('np-1');
    expect(submitted).toHaveLength(4);
    expect(terminated.sort()).toEqual(submitted.sort());
  });

  test('runs the co-located case on a 2-GPU Node', async () => {
    const record = await checks(gpuPort({}), { gpusPerNode: 2 }).poolGpuProbe(
      'np-1',
    );
    expect(record.coLocated).toMatchObject({
      holderJobId: 'gpu-hold',
      held: '23000000000 of 24000000000 bytes',
      replicaPods: ['pod-1', 'pod-2'],
    });
  });

  test('fails when the co-located Job made the check call the Node unusable', async () => {
    await expect(
      checks(
        gpuPort({
          coLocated: [
            syncing('pod-1'),
            event(WorkloadState.Retrying, {
              reason: `GPU unusable on its Node; ${POOL_RETRY_ELSEWHERE}`,
            }),
            syncing('pod-2'),
            event(WorkloadState.Errored, { exitCode: 1 }),
          ],
        }),
        { gpusPerNode: 2 },
      ).poolGpuProbe('np-1'),
    ).rejects.toThrow(/gpu-coloc was retried on another Node/u);
  });

  test('fails when a check Pod outlives its 60 s bound', async () => {
    await expect(
      checks(gpuPort({ checkAgeMs: 80_000 })).poolGpuProbe('np-1'),
    ).rejects.toThrow(
      /GPU check anycloud-gpu-check-1 ran \d+ ms, over its 60 s bound/u,
    );
  });

  test('fails when a GPU Job does not complete, or a check replica keeps its GPU', async () => {
    await expect(
      checks(gpuPort({ gpuOk: WorkloadState.Errored })).poolGpuProbe('np-1'),
    ).rejects.toThrow(/a GPU Job on np-1 ended errored/u);
    await expect(
      checks(gpuPort({ gpuReplicaLeft: true })).poolGpuProbe('np-1'),
    ).rejects.toThrow(/check replicas gone[\s\S]*still running: pod-stuck/u);
  });

  test('fails without the fabric gate, as before the fix', async () => {
    await expect(
      checks(
        gpuPort({
          fabric: 'LoadState=not-found\nResult=success\nExecMainStatus=0\n',
        }),
      ).poolGpuProbe('np-1'),
    ).rejects.toThrow(/anycloud-gpu-fabric.service on node-a did not succeed/u);
  });

  test('fails when the Job ends Errored at once, without a rerun, as before the fix', async () => {
    await expect(
      checks(
        gpuPort({
          rerun: [
            syncing('pod-1'),
            event(WorkloadState.Errored, { exitCode: 1 }),
          ],
        }),
      ).poolGpuProbe('np-1'),
    ).rejects.toThrow(/did not rerun once in a new Pod/u);
  });

  test('fails when the check called a healthy Node unusable', async () => {
    await expect(
      checks(gpuPort({ marked: true })).poolGpuProbe('np-1'),
    ).rejects.toThrow(/cordoned or labelled Node node-a/u);
    await expect(
      checks(
        gpuPort({
          rerun: [
            syncing('pod-1'),
            event(WorkloadState.Retrying, {
              reason: `GPU unusable on its Node; ${POOL_RETRY_ELSEWHERE}`,
            }),
            syncing('pod-2'),
            event(WorkloadState.Errored, { message: POOL_CHECK_PASSED }),
          ],
        }),
      ).poolGpuProbe('np-1'),
    ).rejects.toThrow(/retried on another Node/u);
  });

  test('fails when the end does not name a passing check, or the rerun kept its Pod', async () => {
    await expect(
      checks(
        gpuPort({
          rerun: [
            syncing('pod-1'),
            event(WorkloadState.Retrying, { reason: POOL_RERUN }),
            syncing('pod-2'),
            event(WorkloadState.Errored, {
              message: "couldn't be checked: no result within 60 s",
            }),
          ],
        }),
      ).poolGpuProbe('np-1'),
    ).rejects.toThrow(/does not name a passing GPU check/u);
    await expect(
      checks(gpuPort({ firstReplicaKept: true })).poolGpuProbe('np-1'),
    ).rejects.toThrow(/first replica pod-1 was not deleted/u);
    await expect(
      checks(gpuPort({ rerunEnd: WorkloadState.Completed })).poolGpuProbe(
        'np-1',
      ),
    ).rejects.toThrow(/gpu-pass ended completed after its rerun/u);
    await expect(
      checks(
        gpuPort({
          rerun: [
            syncing('pod-1'),
            event(WorkloadState.Retrying, { reason: POOL_RERUN }),
            syncing('pod-1'),
            event(WorkloadState.Errored, { message: POOL_CHECK_PASSED }),
          ],
        }),
      ).poolGpuProbe('np-1'),
    ).rejects.toThrow(/rerun did not run in a new Pod/u);
  });

  test('fails when a check Pod is left behind', async () => {
    await expect(
      checks(gpuPort({ leftover: true })).poolGpuProbe('np-1'),
    ).rejects.toThrow(/no GPU check Pod left[\s\S]*anycloud-gpu-check-1/u);
  });
});

describe('pool-job-upgrade (RFC 0049 C27)', () => {
  const running = (pod: string): PoolJob => ({
    state: WorkloadState.Running,
    events: [syncing(pod)],
  });
  const completed = (...pods: string[]): PoolJob => ({
    state: WorkloadState.Completed,
    events: pods.map(syncing),
  });
  const queued: PoolJob = { state: WorkloadState.Queued, events: [] };
  const OUTPUTS: Record<string, string> = {
    'job-1/before': 'claimed-before-upgrade\n',
    'job-1/after': 'finished-after-upgrade\n',
    'job-2/queued': 'claimed-after-upgrade\n',
  };

  /**
   * Each Job's reads in order, the last repeating. The first Job runs on
   * replica-a through the upgrade; the second waits, then runs on replica-b,
   * the surge Node's, under `runner`.
   */
  function upgradePort(
    overrides: {
      first?: readonly PoolJob[];
      second?: readonly PoolJob[];
      log?: string;
      runner?: string;
      outputs?: Record<string, string>;
      /** The queued Job's replica Pod is gone, as once it ends. */
      queuedGone?: () => boolean;
    } = {},
  ) {
    const reads: Record<string, PoolJob[]> = {
      'job-1': [
        ...(overrides.first ?? [
          running('replica-a'),
          running('replica-a'),
          completed('replica-a'),
        ]),
      ],
      'job-2': [
        ...(overrides.second ?? [
          queued,
          running('replica-b'),
          completed('replica-b'),
        ]),
      ],
    };
    const records = new Map<string, unknown>();
    const ids = ['job-1', 'job-2'];
    const specs: Parameters<PoolChecksPort['submitJob']>[2][] = [];
    const p = tracked(
      port({
        stageInput: async () => 'out-bucket',
        submitJob: async (_label, _pool, spec) => {
          specs.push(spec);
          return ids.shift()!;
        },
        job: async (id) =>
          reads[id]!.length > 1 ? reads[id]!.shift()! : reads[id]![0]!,
        jobLog: async () =>
          overrides.log ?? 'claimed-before-upgrade\nfinished-after-upgrade\n',
        readOutput: async (bucket, key) => {
          expect(bucket).toBe('out-bucket');
          return (overrides.outputs ?? OUTPUTS)[key] ?? '';
        },
        pods: async () => [
          pod({ uid: 'replica-a' }),
          ...(overrides.queuedGone?.()
            ? []
            : [
                pod({
                  uid: 'replica-b',
                  nodeName: 'node-b',
                  runnerImage:
                    overrides.runner ?? 'ghcr.io/anycloud-sh/api:0.1.70',
                }),
              ]),
        ],
        record: async (name, value) => {
          records.set(name, value);
        },
      }),
    );
    return { ...p, records, specs };
  }
  const policy = { poolVCPUs: 2 };

  test.each([
    [
      'a GPU pool, which refuses a Job without --gpus',
      { gpusPerNode: 1 },
      { gpus: 1 },
    ],
    ['a CPU pool', { gpusPerNode: 0, poolVCPUs: 2 }, { cpus: '1.1' }],
  ] as const)(
    'on %s, each Job takes the Node',
    async (_case, sizing, shape) => {
      const f = upgradePort();
      await checks(f.port, sizing).startJobThroughUpgrade('pool-a', '0.1.71');
      expect(f.specs).toHaveLength(2);
      for (const spec of f.specs) {
        expect(spec).toMatchObject(shape);
        expect(Object.keys(spec)).not.toContain(
          'gpus' in shape ? 'cpus' : 'gpus',
        );
      }
    },
  );

  test('passes when the first Job runs through once with its outputs and the old runner claims the queued one', async () => {
    const f = upgradePort();
    const through = await checks(f.port, policy).startJobThroughUpgrade(
      'pool-a',
      '0.1.70',
    );
    await through.finish();
    expect(f.submitted).toEqual(['upgrade', 'upgrade-queued']);
    expect(f.terminated).toEqual(['job-1', 'job-2']);
    expect(f.records.get('pool-check-pool-job-upgrade')).toMatchObject({
      first: 'job-1',
      queued: 'job-2',
      replica: 'replica-a',
      queuedReplica: 'replica-b',
      node: 'node-a',
      queuedNode: 'node-b',
      queuedOnSpare: true,
    });
  });

  test("reads the queued Job's runner while it runs, before finish, when its replica is gone by then", async () => {
    // Runs 42283992171 and 42283995900: on the upgrade's spare Node the
    // queued Job ran and ended, and its replica Pod was gone, before finish.
    let finished = false;
    const f = upgradePort({ queuedGone: () => finished });
    const through = await checks(f.port, policy).startJobThroughUpgrade(
      'pool-a',
      '0.1.70',
    );
    await new Promise((resolve) => setImmediate(resolve));
    finished = true;
    await through.finish();
    expect(f.records.get('pool-check-pool-job-upgrade')).toMatchObject({
      queuedReplica: 'replica-b',
      queuedOnSpare: true,
    });
  });

  test('fails when the second Job is claimed before the upgrade', async () => {
    const f = upgradePort({ second: [running('replica-b')] });
    await expect(
      checks(f.port, policy).startJobThroughUpgrade('pool-a', '0.1.70'),
    ).rejects.toThrow(/was claimed beside job-1: the Node fits two/u);
  });

  test.each([
    [
      'the first Job ended before the upgrade finished',
      { first: [running('replica-a'), completed('replica-a')] },
      /was completed when the upgrade finished/u,
    ],
    [
      'the first Job reran on another replica',
      {
        first: [
          running('replica-a'),
          running('replica-a'),
          completed('replica-a', 'replica-b'),
        ],
      },
      /ran on replicas replica-a, replica-b/u,
    ],
    [
      'the first Job lost its log line from after the upgrade',
      { log: 'claimed-before-upgrade\n' },
      /lacks a line/u,
    ],
    [
      'the first Job lost an output',
      { outputs: { ...OUTPUTS, 'job-1/after': '' } },
      /output job-1\/after is ""/u,
    ],
    [
      'the new runner claimed the queued Job',
      { runner: 'ghcr.io/anycloud-sh/api:0.1.71' },
      /not 0\.1\.70's/u,
    ],
  ] as const)('fails when %s', async (_case, overrides, message) => {
    const f = upgradePort(overrides);
    const through = await checks(f.port, policy).startJobThroughUpgrade(
      'pool-a',
      '0.1.70',
    );
    await expect(through.finish()).rejects.toThrow(message);
  });
});
