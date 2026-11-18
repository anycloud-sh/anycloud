import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { FixtureNames } from '../names.js';
import type { StageProgress } from '../progress.js';
import type {
  ClusterNodePoolAdapter,
  PoolVmRow,
} from '../targets/cluster-node-pool.js';
import {
  createReadyNodePool,
  deleteNodePools,
  type NodePoolContractDependencies,
  type NodePoolContractRecord,
  type ReadyNodePool,
} from './node-pool.js';

/** The node pool controller's reconcile interval. */
const PASS_MS = 30_000;
/** The Deployment resync: the replica autoscaler's wake without a Pod event. */
const RESYNC_MS = 60_000;
/** One Node, room for a burst of `BURST` more, and one above that (R1). */
const MIN_VMS = 1;
const MAX_VMS = 5;
const BURST = 4;

export interface PoolScalingLocalContractResult {
  readonly contract: 'e2e-pool-scaling-local';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: 'e2e-pool-scaling-local';
  readonly records: {
    readonly nodePool: NodePoolContractRecord;
    /** VMs each scale-out pass of the burst bought, by pass time. */
    readonly burstPasses: Readonly<Record<string, number>>;
    /** The idle Nodes' removals, ms after the restart in their window. */
    readonly removedAfterRestartMs: readonly number[];
  };
}

type PoolScalingLocalDependencies = NodePoolContractDependencies & {
  readonly names: Pick<FixtureNames, 'nodePool' | 'workload'>;
  readonly policy: {
    readonly nodePoolTimeoutMs: number;
    readonly workloadTimeoutMs: number;
    /** How long a Node stays idle before scale-in removes it. */
    readonly idleWindowMs: number;
  };
  readonly progress: Pick<StageProgress, 'mark'>;
  readonly target: NodePoolContractDependencies['target'] &
    Pick<
      ClusterNodePoolAdapter,
      | 'prepare'
      | 'submitPoolJob'
      | 'poolJobStatus'
      | 'poolJobPod'
      | 'replicaNode'
      | 'terminatePoolJob'
      | 'poolNodeFreeMillicores'
      | 'deploymentPodCount'
      | 'poolVms'
      | 'holdNodeWithFinalizer'
      | 'accountBudget'
      | 'scaleOutPass'
    >;
  readonly clock: { now(): number };
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool scaling contract: ${message}`);
}

const launched = (rows: readonly PoolVmRow[]) =>
  rows.filter((row) => row.ip !== null);
const live = (rows: readonly PoolVmRow[]) =>
  launched(rows).filter((row) => row.endedAt === null);

class PoolScaling {
  readonly #d: PoolScalingLocalDependencies;
  readonly #pool: ReadyNodePool;
  /** Millicores of one empty Node. */
  readonly #free: number;
  /** Submitted Jobs not yet terminated. */
  readonly #jobs = new Set<string>();

  constructor(
    d: PoolScalingLocalDependencies,
    pool: ReadyNodePool,
    free: number,
  ) {
    this.#d = d;
    this.#pool = pool;
    this.#free = free;
  }

  get id(): string {
    return this.#pool.id;
  }

  get ref(): ReadyNodePool['ref'] {
    return this.#pool.ref;
  }

  /** A pool Job asking for `share` of an empty Node's CPU, until terminated. */
  async submit(name: string, share: number): Promise<string> {
    const id = this.#d.names.workload(name);
    const submitted = await this.#d.target.submitPoolJob(this.#pool.id, {
      id,
      script: 'echo scaling-started; sleep 3600',
      cpus: (Math.floor(this.#free * share) / 1000).toFixed(3),
      // Else it requests its CPU share of m5.24xlarge's memory, which fits
      // only if the runner has as much memory per CPU; this packs by CPU.
      memory: '128m',
    });
    invariant(submitted.exitCode === 0, `${id}: ${submitted.output}`);
    this.#jobs.add(id);
    return id;
  }

  async terminate(id: string): Promise<void> {
    await this.#d.target.terminatePoolJob(id);
    this.#jobs.delete(id);
  }

  /**
   * Terminates every Job still submitted, trying each one, then waits until
   * no Job or Deployment holds the pool: a terminated Job holds it until its
   * execution is cleaned up, and the pool's deletion refuses until then.
   */
  async endAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#jobs].map((id) => this.terminate(id)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Pool scaling contract: terminate');
    }
    await this.#d.wait.for(
      'no Job or Deployment holding the pool',
      () => this.#d.nodePools.status(this.#pool.ref),
      {
        timeoutMs: this.#d.policy.nodePoolTimeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: ({ liveReferences }) =>
          liveReferences === 0
            ? undefined
            : `${String(liveReferences)} live references`,
      },
    );
  }

  /** The Node and Deployment of a running Job. */
  async running(id: string) {
    const pod = await this.#d.wait.for(
      `${id} running`,
      () => this.#d.target.poolJobPod(this.#pool.id, id, 'scaling-started'),
      {
        timeoutMs: this.#d.policy.workloadTimeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (found) => (found ? undefined : 'not running'),
      },
    );
    const node = await this.#d.target.replicaNode(
      this.#pool.id,
      pod!.deploymentId,
      pod!.podUid,
    );
    return { ...node, deploymentId: pod!.deploymentId };
  }

  /** The Job is still running its first execution. */
  async unretried(id: string): Promise<void> {
    const { workload, events } = await this.#d.target.poolJobStatus(id);
    invariant(
      workload.state === WorkloadState.Running && !retried(events),
      `${id} must keep running without a retry: ${workload.state}`,
    );
  }

  rows(): Promise<readonly PoolVmRow[]> {
    return this.#d.target.poolVms(this.#pool.id);
  }

  /** Waits until `unmet` passes, failing at once when `reject` does. */
  until(
    label: string,
    timeoutMs: number,
    unmet: (rows: readonly PoolVmRow[]) => string | undefined,
    reject: (rows: readonly PoolVmRow[]) => string | undefined = () =>
      undefined,
  ): Promise<readonly PoolVmRow[]> {
    return this.#d.wait.for(label, () => this.rows(), {
      timeoutMs,
      intervalMs: 5_000,
      probeError: 'fail',
      unmet,
      reject,
    });
  }

  /** `reject` holds for `ms`: across passes nothing is bought or removed. */
  async hold(
    label: string,
    ms: number,
    reject: (rows: readonly PoolVmRow[]) => string | undefined,
  ): Promise<void> {
    const end = this.#d.clock.now() + ms;
    await this.until(
      label,
      ms + 60_000,
      () => (this.#d.clock.now() < end ? 'holding' : undefined),
      reject,
    );
  }

  /** The launched VMs stay exactly `count`, live ones `liveCount`. */
  steady(count: number, liveCount = count) {
    return (rows: readonly PoolVmRow[]) =>
      launched(rows).length === count && live(rows).length === liveCount
        ? undefined
        : `${String(launched(rows).length)} launched, ${String(live(rows).length)} live; want ${String(count)} and ${String(liveCount)}`;
  }

  /** Waits on a Job's `status --json` until `met`. */
  async job(
    id: string,
    label: string,
    met: (
      status: Awaited<ReturnType<ClusterNodePoolAdapter['poolJobStatus']>>,
    ) => boolean | undefined,
  ): Promise<void> {
    await this.#d.wait.for(
      `${id} ${label}`,
      () => this.#d.target.poolJobStatus(id),
      {
        timeoutMs: this.#d.policy.nodePoolTimeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (status) =>
          met(status)
            ? undefined
            : `${status.workload.state}: ${status.waiting ?? 'no reason'}`,
      },
    );
  }
}

const retried = (events: readonly { state: string }[]) =>
  events.some((event) => event.state === String(WorkloadState.Retrying));

/**
 * RFC 0048 S1 and S2: a burst of `BURST` Jobs, each taking over half a Node,
 * on a pool with one Node buys exactly `BURST - 1` VMs, though the API
 * restarts while they join; then `BURST` more buy only up to `--max-vms`,
 * and the rest stay queued.
 */
async function scaleOut(d: PoolScalingLocalDependencies, s: PoolScaling) {
  const passes = new Map<number, number>();
  const observe = async () => {
    const status = await d.nodePools.status(s.ref);
    const pass = d.target.scaleOutPass(status);
    if (pass) passes.set(pass.at, pass.bought);
    return { status, rows: await s.rows() };
  };
  const overBought = ({ rows }: { rows: readonly PoolVmRow[] }) =>
    launched(rows).length > BURST
      ? `${String(launched(rows).length)} VMs launched for a burst that needs ${String(BURST)}`
      : undefined;
  const burst = await Promise.all(
    Array.from({ length: BURST }, (_, index) =>
      s.submit(`burst-${String(index)}`, 0.6),
    ),
  );
  // S2: the restart lands once every VM is launched, while some still join;
  // a restart mid-launch would make the next pass re-count the same intent.
  await d.wait.for('the burst launched and joining', observe, {
    timeoutMs: d.policy.workloadTimeoutMs,
    intervalMs: 1_000,
    probeError: 'fail',
    unmet: ({ status, rows }) =>
      launched(rows).length === BURST &&
      (status.capacity?.startingVmCount ?? 0) > 0
        ? undefined
        : JSON.stringify(status.capacity),
    reject: overBought,
  });
  await d.target.replaceController();
  d.progress.mark('the API restarted while the burst VMs joined');
  await d.wait.for(`${String(BURST)} Ready VMs`, observe, {
    timeoutMs: d.policy.nodePoolTimeoutMs,
    intervalMs: 2_000,
    probeError: 'fail',
    unmet: ({ status }) =>
      status.capacity?.readyVmCount === BURST
        ? undefined
        : JSON.stringify(status.capacity),
    reject: overBought,
  });
  const nodes = await Promise.all(burst.map((id) => s.running(id)));
  invariant(
    new Set(nodes.map((node) => node.name)).size === BURST,
    `the burst must run one Job per Node: ${JSON.stringify(nodes)}`,
  );
  await s.hold('no VM beyond the burst', 3 * PASS_MS, s.steady(BURST));
  const bought = [...passes.values()].reduce((sum, vms) => sum + vms, 0);
  invariant(
    bought === BURST - MIN_VMS,
    `the scale-out passes bought ${String(bought)} VMs, not ${String(BURST - MIN_VMS)}: ${JSON.stringify([...passes])}`,
  );
  d.progress.mark(`the burst bought exactly ${String(bought)} VMs`);

  const more = await Promise.all(
    Array.from({ length: BURST }, (_, index) =>
      s.submit(`more-${String(index)}`, 0.6),
    ),
  );
  await s.until(
    `the pool at --max-vms ${String(MAX_VMS)}`,
    d.policy.nodePoolTimeoutMs,
    s.steady(MAX_VMS),
    (rows) => (launched(rows).length > MAX_VMS ? 'over --max-vms' : undefined),
  );
  const states = await d.wait.for(
    `${String(MAX_VMS)} Jobs running and the rest queued`,
    () =>
      Promise.all(
        [...burst, ...more].map(async (id) => ({
          id,
          state: (await d.target.poolJobStatus(id)).workload.state,
        })),
      ),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 2_000,
      probeError: 'fail',
      unmet: (all) =>
        all.filter(({ state }) => state === WorkloadState.Running).length ===
          MAX_VMS &&
        all.filter(({ state }) => state === WorkloadState.Queued).length ===
          2 * BURST - MAX_VMS
          ? undefined
          : JSON.stringify(all),
    },
  );
  await s.hold('the pool held at --max-vms', 2 * PASS_MS, s.steady(MAX_VMS));
  return { burst, states, passes };
}

/**
 * RFC 0048 S3, S4 and S6, and RFC 0044 S7: one Node runs a Job and one holds
 * a finalizer Pod; the others go idle, and the API restarts 8 min into
 * their window. Only the idle Nodes go, fewer than the minimum asks, and no
 * sooner than a full window after the restart. Once the busy two are
 * released, a window later the pool is back at its minimum.
 */
async function scaleIn(
  d: PoolScalingLocalDependencies,
  s: PoolScaling,
  jobs: Awaited<ReturnType<typeof scaleOut>>,
) {
  const [kept, held] = await Promise.all(
    jobs.burst.slice(0, 2).map((id) => s.running(id)),
  );
  const finalizer = await d.target.holdNodeWithFinalizer(held.name);
  // Queued Jobs first, so no freed replica claims one.
  const ordered = [...jobs.states]
    .filter(({ id }) => id !== jobs.burst[0])
    .sort((a, b) =>
      a.state === b.state ? 0 : a.state === WorkloadState.Queued ? -1 : 1,
    );
  for (const { id } of ordered) await s.terminate(id);
  const idleAt = d.clock.now();
  d.progress.mark('the burst ended but for one Job and a finalizer Pod');
  await s.hold(
    'no Node removed 8 min into the idle window',
    8 * 60_000 - (d.clock.now() - idleAt),
    s.steady(MAX_VMS),
  );
  // Each bound is taken before its action, which only loosens it.
  const restartedAt = d.clock.now();
  await d.target.replaceController();
  d.progress.mark('the API restarted 8 min into the idle window');
  const busy = new Set([kept.vmRowId, held.vmRowId]);
  const early = (rows: readonly PoolVmRow[]) =>
    launched(rows).find(
      (row) =>
        row.endedAt !== null &&
        (busy.has(row.id) || row.endedAt < restartedAt + d.policy.idleWindowMs),
    );
  const rows = await s.until(
    'the idle Nodes removed',
    d.policy.idleWindowMs + 4 * PASS_MS,
    (current) =>
      live(current).length === busy.size
        ? undefined
        : `${String(live(current).length)} live`,
    (current) => {
      const row = early(current);
      return row
        ? `VM ${String(row.id)} was removed at ${String(row.endedAt! - restartedAt)} ms after the restart; busy: ${String(busy.has(row.id))}`
        : undefined;
    },
  );
  invariant(
    live(rows).every((row) => busy.has(row.id)),
    `the busy Nodes must be the ones kept: ${JSON.stringify(live(rows))}`,
  );
  await s.unretried(jobs.burst[0]);
  await s.hold('the busy Nodes kept', 2 * PASS_MS, s.steady(MAX_VMS, 2));
  await s.unretried(jobs.burst[0]);
  d.progress.mark('only the idle Nodes went, a full window after the restart');

  // The window runs from the last pass that saw the Node busy, which can be
  // up to one pass before the release.
  const releasedAt = d.clock.now();
  await s.terminate(jobs.burst[0]);
  await finalizer.release();
  await s.until(
    'the pool back at its minimum',
    d.policy.idleWindowMs + 4 * PASS_MS,
    (current) =>
      live(current).length === MIN_VMS
        ? undefined
        : `${String(live(current).length)} live`,
    (current) =>
      current.some(
        (row) =>
          busy.has(row.id) &&
          row.endedAt !== null &&
          row.endedAt < releasedAt + d.policy.idleWindowMs - PASS_MS,
      )
        ? 'a released Node went before its idle window'
        : undefined,
  );
  await s.hold(
    'the pool held at its minimum',
    2 * PASS_MS,
    s.steady(MAX_VMS, MIN_VMS),
  );
  invariant(
    (await d.target.deploymentPodCount(s.id, kept.deploymentId)) === 0,
    'the drained managed Deployment must be back at zero replicas',
  );
  d.progress.mark('the released Nodes went a window later; one Node stayed');
  return {
    removedAfterRestartMs: launched(rows)
      .filter((row) => row.endedAt !== null)
      .map((row) => row.endedAt! - restartedAt),
  };
}

/**
 * RFC 0044 S6, then RFC 0048 S8 and S7, on the one Node left. A Job that
 * fits only an empty Node buys one while the smaller Job keeps running; its
 * VM is deleted with the pool above its minimum, and one VM is bought for
 * its retry. With the account budget spent, a lost busy Node buys nothing.
 */
async function demand(d: PoolScalingLocalDependencies, s: PoolScaling) {
  const before = launched(await s.rows()).length;
  const small = await s.submit('small', 0.45);
  const smallNode = await s.running(small);
  const large = await s.submit('large', 0.7);
  let largeNode = await s.running(large);
  invariant(
    largeNode.name !== smallNode.name,
    'the large Job must run on the Node it bought',
  );
  await s.hold(
    'one VM bought for the large Job',
    PASS_MS,
    s.steady(before + 1, 2),
  );
  await s.unretried(small);
  d.progress.mark('a Job that fits only an empty Node bought one (0044/S6)');

  await d.target.deleteOneCapacityHost(s.id, largeNode.vmRowId);
  await s.job(
    large,
    'retried',
    ({ workload, events }) =>
      workload.state === WorkloadState.Running && retried(events),
  );
  const lost = largeNode.vmRowId;
  largeNode = await s.running(large);
  invariant(largeNode.vmRowId !== lost, 'the retry must run on a new VM');
  await s.hold(
    'one VM bought for the lost one',
    2 * PASS_MS,
    s.steady(before + 2, 2),
  );
  await s.unretried(small);
  d.progress.mark('a lost VM above the minimum was replaced once (S8)');

  await d.target.accountBudget(1);
  await d.target.deleteOneCapacityHost(s.id, largeNode.vmRowId);
  const queued = await s.submit('capped', 0.7);
  const budget = 'blocked by daily budget';
  await d.wait.for(
    'the pool blocked by the account cap',
    () => d.nodePools.status(s.ref),
    {
      timeoutMs: d.policy.workloadTimeoutMs,
      intervalMs: 2_000,
      probeError: 'fail',
      unmet: (status) =>
        status.state === WorkloadState.Running &&
        status.lastError?.startsWith('scale-out blocked by account cap: ')
          ? undefined
          : `${status.state}: ${status.lastError ?? 'no error'}`,
    },
  );
  for (const id of [large, queued]) {
    await s.job(
      id,
      `waiting on "${budget}"`,
      ({ workload, waiting }) =>
        workload.state === WorkloadState.Queued && waiting?.includes(budget),
    );
  }
  await s.hold(
    'no VM bought over the cap',
    2 * PASS_MS,
    s.steady(before + 2, 1),
  );
  // Two Jobs want replicas; under the cap RA may scale down, never up.
  const replicas = await d.target.deploymentPodCount(
    s.id,
    largeNode.deploymentId,
  );
  invariant(
    replicas <= 1,
    `the replica autoscaler must hold its step-up under the cap: ${String(replicas)} replicas`,
  );
  await s.unretried(small);
  d.progress.mark('the spent budget bought nothing and held the replicas (S7)');

  await d.target.accountBudget(null);
  // Lifting the cap wakes nothing: the next pass clears the pool's cap block,
  // the replica autoscaler's next resync steps up, and the pass after that
  // buys. The 30 s margin covers the launch. A cap block is soft, so a
  // provisioning backoff (60 s, doubling per blocked pass) would fail this.
  await s.until(
    'a VM bought within the reconcile chain after the cap lifted',
    2 * PASS_MS + RESYNC_MS + 30_000,
    (rows) =>
      launched(rows).length > before + 2 ? undefined : 'nothing bought yet',
  );
  await s.until(
    'both Jobs bought their VMs once the cap lifted',
    d.policy.nodePoolTimeoutMs,
    s.steady(before + 4, 3),
    (rows) =>
      launched(rows).length > before + 4
        ? 'over-bought after the cap'
        : undefined,
  );
  await Promise.all([large, queued].map((id) => s.running(id)));
}

export class PoolScalingLocalContract {
  readonly #d: PoolScalingLocalDependencies;

  constructor(dependencies: PoolScalingLocalDependencies) {
    this.#d = dependencies;
  }

  async run(
    target: 'e2e-pool-scaling-local',
  ): Promise<PoolScalingLocalContractResult> {
    invariant(target === 'e2e-pool-scaling-local', `unsupported ${target}`);
    const d = this.#d;
    await d.target.prepare();
    const ref = await d.nodePools.reserve(
      d.names.nodePool('scaling'),
      d.policy.nodePoolTimeoutMs,
    );
    const pool = await createReadyNodePool(d, ref, MIN_VMS, MAX_VMS);
    const s = new PoolScaling(
      d,
      pool,
      await d.target.poolNodeFreeMillicores(pool.id),
    );
    d.progress.mark(
      `scaling pool ${pool.id} ready, ${String(MIN_VMS)}..${String(MAX_VMS)}`,
    );
    let jobs: Awaited<ReturnType<typeof scaleOut>>;
    let removedAfterRestartMs: readonly number[];
    try {
      jobs = await scaleOut(d, s);
      ({ removedAfterRestartMs } = await scaleIn(d, s, jobs));
      await demand(d, s);
    } catch (error) {
      // Live Jobs would block the pool's cleanup, whose error then hid this
      // one; a failed termination is left for that cleanup to report.
      await s.endAll().catch(() => undefined);
      throw error;
    }
    await s.endAll();
    const [nodePool] = await deleteNodePools(d, [pool]);
    return {
      contract: 'e2e-pool-scaling-local',
      qualification: 'conclusive',
      satisfied: true,
      target: 'e2e-pool-scaling-local',
      records: {
        nodePool,
        burstPasses: Object.fromEntries(
          [...jobs.passes].map(([at, vms]) => [String(at), vms]),
        ),
        removedAfterRestartMs,
      },
    };
  }
}
