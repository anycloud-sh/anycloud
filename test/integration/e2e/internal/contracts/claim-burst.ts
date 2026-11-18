import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { FixtureNames } from '../names.js';
import type { StageProgress } from '../progress.js';
import { WaitTimeoutError, type Waiter } from '../wait.js';
import {
  createReadyNodePool,
  deleteNodePools,
  type NodePoolContractDependencies,
  type NodePoolContractRecord,
  type ReadyNodePool,
} from './node-pool.js';

export interface Spread {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** The API process over one window (`substrates/local-cluster/api-load.ts`). */
export interface ApiLoad {
  readonly windowMs: number;
  readonly cpuCores: number;
  readonly eventLoopP99Ms: number;
  readonly eventLoopMaxMs: number;
  /** A one-row query's latency: the wait on SQLite's one operation queue. */
  readonly sqliteWaitMs: Spread;
  /** The runner's claim-queue routes, server side; 5xx counts by status. */
  readonly routes: Readonly<
    Record<string, Spread & { errors: Readonly<Record<string, number>> }>
  >;
}

export interface BurstJob {
  readonly id: string;
  readonly state: string;
  readonly session: string | null;
  readonly submittedAt: number;
  /** The latest spend-cap reason it waited with, if any. */
  readonly blocked: string | null;
  /** How often its command reported that it ran. */
  readonly runs: number;
  readonly attempts: readonly {
    readonly executionId: string;
    readonly podUid: string | null;
    readonly openedAt: number;
    readonly endedAt: number | null;
    readonly slotUsd: number | null;
    readonly outcome: string | null;
    readonly reason: string | null;
  }[];
}

export interface BurstFacts {
  readonly jobs: readonly BurstJob[];
  readonly load: ApiLoad;
}

/** One look at the managed Deployment and the management node. */
export interface BurstSample {
  readonly at: number;
  readonly desiredReplicas: number;
  readonly readyPods: number;
  /** Why a replica waits to be scheduled, if one does. */
  readonly pendingReason: string | null;
  /** A LIST of the pool namespace's Pods: the apiserver and kine under load. */
  readonly apiserverListMs: number;
  readonly managementCpuPercent: number;
  readonly managementMemoryBytes: number;
  readonly managementRestarts: number;
}

export interface BurstJobSubmission {
  readonly id: string;
  readonly script: string;
  readonly cpus: string;
  /** The agent session the CLI detects and tags the Job with, or none. */
  readonly session: string | null;
}

/** The substrate: the local K3s, its API child and KWOK (`substrates/local-cluster`). */
export interface ClaimBurstTarget {
  prepare(): Promise<void>;
  /** The next node pool of this name is priced (spend caps) or KWOK. */
  usePoolVmType(name: string, kind: 'priced' | 'kwok'): void;
  preparePoolJobImages(nodePoolId: string): Promise<void>;
  poolNodeFreeMillicores(nodePoolId: string): Promise<number>;
  /** Best effort: an overloaded API may refuse some. */
  terminatePoolJobs(ids: readonly string[]): Promise<void>;
  /** Delete every replica Pod of a managed Deployment, as a drain does. */
  deleteReplicas(nodePoolId: string, deploymentId: string): Promise<void>;
  /** `anycloud job IMAGE --node-pool` for each, several at a time. */
  submitPoolJobs(
    nodePoolId: string,
    jobs: readonly BurstJobSubmission[],
  ): Promise<readonly { id: string; exitCode: number; output: string }[]>;
  deploymentOf(jobId: string): Promise<string | null>;
  /** Where a Job's command reports that it ran. */
  runsUrl(): string;
  /** Record a run of `gate`, releasing the Jobs that wait on it; returns when. */
  openGate(gate: string): Promise<number>;
  setSessionThrottle(capUsd: number | null): Promise<void>;
  jobs(deploymentId: string | null, closeWindow: boolean): Promise<BurstFacts>;
  sample(nodePoolId: string, deploymentId: string): Promise<BurstSample>;
  startKwok(): Promise<void>;
  setInFlightCap(cap: number): Promise<void>;
  /** A runner loop per running KWOK replica, until `stopClaimers`. */
  startClaimers(nodePoolId: string, deploymentId: string, jobMs: number): void;
  stopClaimers(): Promise<void>;
}

export interface ClaimBurstPolicy {
  readonly nodePoolTimeoutMs: number;
  /** For the burst's Jobs to end. */
  readonly burstTimeoutMs: number;
  /** For a KWOK level's Jobs to end; one past it is not green. */
  readonly levelTimeoutMs: number;
  /** The product's `IN_FLIGHT_CAP`. */
  readonly inFlightCap: number;
  readonly burstJobs: number;
  /** Replicas the burst pool's two Nodes hold; the rest stay Pending. */
  readonly burstReplicas: number;
  /** Managed replicas on KWOK, in order; the first is today's cap. */
  readonly levels: readonly number[];
  readonly kwokJobMs: number;
}

export interface ClaimBurstMeasurement {
  readonly jobs: number;
  readonly seconds: number;
  readonly jobsPerSecond: number;
  readonly maxDesiredReplicas: number;
  readonly maxReadyReplicas: number;
  readonly maxConcurrentJobs: number;
  readonly pendingReason: string | null;
  /** Claim calls per claimed Job: 1 without contention. */
  readonly claimsPerJob: number;
  readonly api: ApiLoad;
  readonly management: {
    readonly apiserverListMs: Spread;
    readonly cpuPercentMax: number;
    readonly memoryMaxBytes: number;
    readonly restarts: number;
  };
}

export interface ClaimBurstLevel extends ClaimBurstMeasurement {
  readonly level: number;
  readonly green: boolean;
  readonly misses: readonly string[];
}

export interface ClaimBurstContractResult {
  readonly contract: 'e2e-claim-burst-local';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: 'e2e-claim-burst-local';
  readonly records: {
    readonly burst: ClaimBurstMeasurement & {
      readonly throttle: {
        readonly capUsd: number;
        readonly slotUsd: number;
        readonly perSession: number;
        /** Per session: the most Jobs it held at once, and Jobs passed over. */
        readonly sessions: Readonly<
          Record<string, { held: number; skipped: number }>
        >;
        readonly reason: string | null;
      };
    };
    readonly levels: readonly ClaimBurstLevel[];
    readonly nodePools: readonly NodePoolContractRecord[];
  };
}

type ClaimBurstDependencies = Pick<
  NodePoolContractDependencies,
  'nodePools' | 'target'
> & {
  readonly burst: ClaimBurstTarget;
  readonly names: Pick<FixtureNames, 'nodePool' | 'workload'>;
  readonly policy: ClaimBurstPolicy;
  readonly progress: Pick<StageProgress, 'mark'>;
  readonly wait: Pick<Waiter, 'for'>;
};

const RUNNER_ROUTES = [
  'candidate',
  'claim',
  'execution',
  'report',
  'cancellation',
  'cleanup',
];

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Claim burst contract: ${message}`);
}

export function spread(samples: readonly number[]): Spread {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
  };
}

type Attempt = BurstJob['attempts'][number];

/** The most attempts open at once. */
function concurrency(attempts: readonly Attempt[]): number {
  const edges = attempts.flatMap((attempt) => [
    [attempt.openedAt, 1],
    [attempt.endedAt ?? Infinity, -1],
  ]);
  // An attempt ending as another opens at the same millisecond frees first.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let most = 0;
  for (const [, step] of edges) {
    open += step;
    most = Math.max(most, open);
  }
  return most;
}

/**
 * Every Job ended `completed` after one attempt that ran its command
 * `runsPerAttempt` times. Anything else, a retry or a double dispatch
 * included, is `broken`.
 */
function exactlyOnce(
  jobs: readonly BurstJob[],
  expected: readonly string[],
  runsPerAttempt: 0 | 1,
): string[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const broken: string[] = [];
  for (const id of expected) {
    const job = byId.get(id);
    if (!job) {
      broken.push(`${id} lost`);
      continue;
    }
    if (
      job.state !== String(WorkloadState.Completed) ||
      job.attempts.length !== 1 ||
      job.runs !== runsPerAttempt
    ) {
      broken.push(
        `${id} ${job.state} after ${String(job.attempts.length)} attempts (${job.attempts.map((a) => `${a.outcome ?? 'open'}: ${a.reason ?? ''}`).join('; ')}), ran ${String(job.runs)}×`,
      );
    }
  }
  return broken;
}

function measure(
  facts: BurstFacts,
  samples: readonly BurstSample[],
  /** When Jobs held at a gate were released; the window opens no earlier. */
  released = -Infinity,
): ClaimBurstMeasurement {
  const attempts = facts.jobs.flatMap((job) => job.attempts);
  const start = Math.max(
    released,
    Math.min(...attempts.map((a) => a.openedAt)),
  );
  const end = Math.max(start, ...attempts.map((a) => a.endedAt ?? 0));
  const seconds = attempts.length > 0 ? (end - start) / 1000 : 0;
  const ended = facts.jobs.filter((job) => ENDED.includes(job.state)).length;
  return {
    jobs: facts.jobs.length,
    seconds,
    jobsPerSecond: seconds > 0 ? ended / seconds : 0,
    maxDesiredReplicas: Math.max(0, ...samples.map((s) => s.desiredReplicas)),
    maxReadyReplicas: Math.max(0, ...samples.map((s) => s.readyPods)),
    pendingReason:
      samples.findLast((s) => s.pendingReason !== null)?.pendingReason ?? null,
    maxConcurrentJobs: concurrency(attempts),
    claimsPerJob:
      (facts.load.routes.claim?.count ?? 0) /
      Math.max(1, new Set(attempts.map((a) => a.executionId)).size),
    api: facts.load,
    management: {
      apiserverListMs: spread(samples.map((s) => s.apiserverListMs)),
      cpuPercentMax: Math.max(0, ...samples.map((s) => s.managementCpuPercent)),
      memoryMaxBytes: Math.max(
        0,
        ...samples.map((s) => s.managementMemoryBytes),
      ),
      restarts: Math.max(0, ...samples.map((s) => s.managementRestarts)),
    },
  };
}

function runnerErrors(load: ApiLoad): number {
  return RUNNER_ROUTES.flatMap((route) =>
    Object.values(load.routes[route]?.errors ?? {}),
  ).reduce((sum, count) => sum + count, 0);
}

/**
 * Submit `jobs`, open their `gate` if they wait on one, then sample the
 * Deployment and the management node until every one has ended; the API's
 * load window is the run's.
 */
async function runJobs(
  d: ClaimBurstDependencies,
  pool: ReadyNodePool,
  jobs: readonly BurstJobSubmission[],
  timeoutMs: number,
  beforeRest: (deploymentId: string) => void = () => undefined,
  gate?: string,
): Promise<{
  deploymentId: string;
  facts: BurstFacts;
  samples: BurstSample[];
  /** Jobs still live at the deadline. */
  left: readonly string[];
  released: number | undefined;
}> {
  await d.burst.jobs(null, true);
  // The first admission creates the managed Deployment the rest share.
  const [first, ...rest] = jobs;
  invariant(first, 'no Jobs to run');
  const admitted = [...(await d.burst.submitPoolJobs(pool.id, [first]))];
  const deploymentId = await d.burst.deploymentOf(first.id);
  invariant(deploymentId, `${first.id} has no managed Deployment`);
  beforeRest(deploymentId);
  admitted.push(...(await d.burst.submitPoolJobs(pool.id, rest)));
  const refused = admitted.filter((result) => result.exitCode !== 0);
  invariant(
    refused.length === 0,
    `${String(refused.length)} Jobs were not admitted: ${refused[0]?.output ?? ''}`,
  );
  d.progress.mark(`${String(jobs.length)} Jobs admitted on ${deploymentId}`);
  const released =
    gate === undefined ? undefined : await d.burst.openGate(gate);
  const samples: BurstSample[] = [];
  const live = (facts: BurstFacts) =>
    facts.jobs.filter((job) => !ENDED.includes(job.state)).map((job) => job.id);
  const ended = await d.wait
    .for(
      `${String(jobs.length)} Jobs on ${deploymentId} to end`,
      async () => {
        samples.push(await d.burst.sample(pool.id, deploymentId));
        return d.burst.jobs(deploymentId, false);
      },
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (facts) =>
          live(facts).length === 0 && facts.jobs.length >= jobs.length
            ? undefined
            : `${String(live(facts).length)} of ${String(facts.jobs.length)} still live`,
      },
    )
    .then(
      () => true,
      (error: unknown) => {
        if (error instanceof WaitTimeoutError) return false;
        throw error;
      },
    );
  const facts = await d.burst.jobs(deploymentId, true);
  // Past the deadline, the Jobs are measured as they stand.
  const ids = new Set(jobs.map((job) => job.id));
  const own = { ...facts, jobs: facts.jobs.filter((job) => ids.has(job.id)) };
  return {
    deploymentId,
    facts: own,
    samples,
    left: ended ? [] : live(own),
    released,
  };
}

/**
 * End a KWOK level's Jobs. Their runner loops stop first, so ending a Job
 * wakes no waiting replica; the replicas go, so the Jobs they held retry,
 * every queued Job is terminated, and the Deployment returns to zero.
 */
async function endJobs(
  d: ClaimBurstDependencies,
  pool: ReadyNodePool,
  deploymentId: string,
): Promise<void> {
  await d.burst.stopClaimers();
  await d.burst.deleteReplicas(pool.id, deploymentId);
  await d.wait.for(
    `the Jobs on ${deploymentId} to end`,
    async () => {
      const facts = await d.burst.jobs(deploymentId, false);
      const queued = facts.jobs
        .filter((job) => job.state === String(WorkloadState.Queued))
        .map((job) => job.id);
      if (queued.length > 0) await d.burst.terminatePoolJobs(queued);
      return facts;
    },
    {
      timeoutMs: d.policy.levelTimeoutMs,
      intervalMs: 10_000,
      probeError: 'fail',
      unmet: (facts) => {
        const live = facts.jobs.filter((job) => !ENDED.includes(job.state));
        return live.length === 0 ? undefined : `${String(live.length)} live`;
      },
    },
  );
  await scaledToZero(d, pool, deploymentId);
}

const ENDED = ['completed', 'errored', 'failed', 'invalid', 'terminated'];

async function scaledToZero(
  d: ClaimBurstDependencies,
  pool: ReadyNodePool,
  deploymentId: string,
): Promise<void> {
  await d.wait.for(
    `managed Deployment ${deploymentId} back at zero replicas`,
    () => d.burst.sample(pool.id, deploymentId),
    {
      timeoutMs: d.policy.nodePoolTimeoutMs,
      intervalMs: 2_000,
      probeError: 'fail',
      unmet: (s) =>
        s.desiredReplicas === 0 && s.readyPods === 0
          ? undefined
          : `${String(s.desiredReplicas)} desired, ${String(s.readyPods)} ready`,
    },
  );
}

/**
 * Each claim of a session's Job cleared its throttle: the session's open
 * slots plus this one stayed under the cap (`overSessionThrottle`), so no
 * claim over-dispatched it. Each session's Jobs waited with the throttle's
 * reason while replicas took other Jobs, and no human Job did.
 */
function throttleCheck(jobs: readonly BurstJob[], capUsd: number) {
  const misses: string[] = [];
  const sessions: Record<string, { held: number; skipped: number }> = {};
  for (const session of new Set(jobs.map((job) => job.session))) {
    const own = jobs.filter((job) => job.session === session);
    const skipped = own.filter((job) => job.blocked !== null).length;
    if (session === null) {
      if (skipped > 0)
        misses.push(`${String(skipped)} human Jobs waited on a cap`);
      continue;
    }
    const attempts = own.flatMap((job) => job.attempts);
    for (const attempt of attempts) {
      const burn = attempts
        .filter(
          (open) =>
            open.openedAt < attempt.openedAt &&
            (open.endedAt === null || open.endedAt > attempt.openedAt),
        )
        .reduce((sum, open) => sum + (open.slotUsd ?? 0), 0);
      if (attempt.slotUsd === null || burn + attempt.slotUsd >= capUsd) {
        misses.push(
          `${session} claimed ${attempt.executionId} at $${burn.toFixed(3)}/h open of a $${String(capUsd)}/h throttle`,
        );
      }
    }
    if (skipped === 0) misses.push(`no ${session} Job waited on its throttle`);
    sessions[session] = { held: concurrency(attempts), skipped };
  }
  const reason = jobs.find((job) => job.blocked !== null)?.blocked ?? null;
  return { misses, sessions, reason };
}

/**
 * The burst: 1,000+ pool Jobs on about 20 real runner replicas, one
 * in five of them in each of two throttled agent sessions. Every Job runs
 * exactly once, the managed Deployment peaks at exactly the in-flight cap,
 * no session claim passes its throttle, and the Deployment returns to zero.
 */
async function qualifyBurst(
  d: ClaimBurstDependencies,
  pool: ReadyNodePool,
): Promise<ClaimBurstContractResult['records']['burst']> {
  await d.burst.preparePoolJobImages(pool.id);
  const free = await d.burst.poolNodeFreeMillicores(pool.id);
  const cpus = (
    Math.floor((free * pool.vmCount) / d.policy.burstReplicas) / 1000
  ).toFixed(3);
  const runs = d.burst.runsUrl();
  const job = (name: string, session: string | null, gate?: string) => {
    const id = d.names.workload(name);
    // Wait for the gate to have a run, if any; then a short CPU loop and
    // one report that this run happened.
    const wait = gate
      ? `until python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=30)' ${runs}/${gate} 2>/dev/null; do sleep 2; done; `
      : '';
    const script = `${wait}python3 -c 'import sys, urllib.request; sum(i * i for i in range(300000)); urllib.request.urlopen(urllib.request.Request(sys.argv[1], method="POST"), timeout=30)' ${runs}/${id}`;
    return { id, script, cpus, session };
  };
  // Human Jobs first: their replicas bind and price a slot for the throttle.
  const warm = Array.from({ length: d.policy.burstReplicas }, (_, i) =>
    job(`w${String(i)}`, null),
  );
  const warmed = await runJobs(d, pool, warm, d.policy.levelTimeoutMs);
  invariant(warmed.left.length === 0, 'the warm-up Jobs did not end');
  const warmBroken = exactlyOnce(
    warmed.facts.jobs,
    warm.map((each) => each.id),
    1,
  );
  invariant(warmBroken.length === 0, warmBroken.slice(0, 5).join('; '));
  const slotUsd = Math.max(
    ...warmed.facts.jobs.flatMap((each) =>
      each.attempts.map((attempt) => attempt.slotUsd ?? 0),
    ),
  );
  invariant(slotUsd > 0, 'the warm-up replicas priced no slot');
  // A whole-dollar throttle that holds one Job and refuses a second.
  const capUsd = Math.floor(2 * slotUsd);
  invariant(
    capUsd > slotUsd,
    `a $${slotUsd.toFixed(3)}/h slot is too cheap for a whole-dollar throttle of one Job`,
  );
  const perSession = Math.ceil(capUsd / slotUsd) - 1;
  await d.burst.setSessionThrottle(capUsd);
  d.progress.mark(
    `slot $${slotUsd.toFixed(3)}/h; session throttle $${String(capUsd)}/h holds ${String(perSession)} Jobs`,
  );
  // One in five Jobs in each session, more than its throttle holds; the
  // human three keep more Jobs claimable than the in-flight cap. Claimed
  // Jobs wait at a gate until all are admitted: a Job that ended during
  // the minutes of admission would leave fewer queued than the cap.
  const sessions = ['s12-a', 's12-b', null, null, null];
  const gate = d.names.workload('gate');
  const jobs = Array.from({ length: d.policy.burstJobs }, (_, i) =>
    job(`b${String(i)}`, sessions[i % 5] ?? null, gate),
  );
  const { deploymentId, facts, samples, left, released } = await runJobs(
    d,
    pool,
    jobs,
    d.policy.burstTimeoutMs,
    undefined,
    gate,
  );
  await d.burst.setSessionThrottle(null);
  invariant(
    left.length === 0,
    `${String(left.length)} burst Jobs were still live`,
  );
  const ids = new Set(jobs.map((each) => each.id));
  const burst = {
    ...facts,
    jobs: facts.jobs.filter((each) => ids.has(each.id)),
  };
  const measured = measure(burst, samples, released);
  d.progress.mark(`burst: ${JSON.stringify(measured)}`);
  const broken = exactlyOnce(
    burst.jobs,
    jobs.map((each) => each.id),
    1,
  );
  invariant(
    broken.length === 0,
    `${String(broken.length)} Jobs did not complete once: ${broken.slice(0, 5).join('; ')}`,
  );
  invariant(
    measured.maxDesiredReplicas === d.policy.inFlightCap,
    `the managed Deployment asked for ${String(measured.maxDesiredReplicas)} replicas at most, not the in-flight cap of ${String(d.policy.inFlightCap)}`,
  );
  invariant(
    measured.maxReadyReplicas >= d.policy.burstReplicas,
    `${String(measured.maxReadyReplicas)} replicas were ready at most, not ${String(d.policy.burstReplicas)}: ${measured.pendingReason ?? ''}`,
  );
  const throttle = throttleCheck(burst.jobs, capUsd);
  invariant(
    throttle.misses.length === 0,
    throttle.misses.slice(0, 5).join('; '),
  );
  invariant(
    runnerErrors(facts.load) === 0,
    `the runner's calls met ${String(runnerErrors(facts.load))} server errors`,
  );
  await scaledToZero(d, pool, deploymentId);
  return {
    ...measured,
    throttle: {
      capUsd,
      slotUsd,
      perSession,
      sessions: throttle.sessions,
      reason: throttle.reason,
    },
  };
}

/**
 * S12's verdict: a level is green when every Job ends within its
 * window, the managed Deployment asks for exactly the level, every replica
 * holds a Job at once, no runner call fails with a server error and the
 * management node doesn't restart. A retried Job fails the contract.
 * Latencies are recorded beside it for the owner, not judged.
 */
function levelMisses(
  level: number,
  measured: ClaimBurstMeasurement,
  live: {
    readonly left: number;
    readonly of: number;
    readonly minutes: number;
  },
): string[] {
  return [
    live.left > 0 &&
      `${String(live.left)} of ${String(live.of)} Jobs still live after ${String(live.minutes)} min`,
    measured.maxDesiredReplicas !== level &&
      `the managed Deployment asked for ${String(measured.maxDesiredReplicas)} replicas`,
    measured.maxConcurrentJobs < level &&
      `${String(measured.maxConcurrentJobs)} replicas held a Job at once`,
    measured.management.restarts > 0 && 'the management node restarted',
    runnerErrors(measured.api) > 0 &&
      `${String(runnerErrors(measured.api))} server errors on runner calls (${JSON.stringify(Object.fromEntries(RUNNER_ROUTES.map((route) => [route, measured.api.routes[route]?.errors ?? {}])))})`,
  ].filter((miss): miss is string => typeof miss === 'string');
}

/**
 * The cap: at each level, twice that many Jobs on a KWOK pool, so
 * that many managed replicas each claim through a production runner loop,
 * against the 2 vCPU / 4 GiB management node's kine. Each must run every Job
 * exactly once; its verdict is recorded for the owner.
 */
async function qualifyLevels(
  d: ClaimBurstDependencies,
  pool: ReadyNodePool,
): Promise<ClaimBurstLevel[]> {
  const results: ClaimBurstLevel[] = [];
  try {
    for (const level of d.policy.levels) {
      await d.burst.setInFlightCap(level);
      const jobs = Array.from({ length: 2 * level }, (_, i) => ({
        id: d.names.workload(`k${String(level)}-${String(i)}`),
        script: 'true',
        cpus: '0.100',
        session: null,
      }));
      const { deploymentId, facts, samples, left } = await runJobs(
        d,
        pool,
        jobs,
        d.policy.levelTimeoutMs,
        (id) => d.burst.startClaimers(pool.id, id, d.policy.kwokJobMs),
      );
      // KWOK runs no command, so none reports a run. A Job still live at
      // the deadline is the level's miss; any other must have run once.
      const broken = exactlyOnce(
        facts.jobs,
        jobs.map((each) => each.id).filter((id) => !left.includes(id)),
        0,
      );
      invariant(
        broken.length === 0,
        `${String(broken.length)} KWOK Jobs did not complete once at ${String(level)}: ${broken.slice(0, 5).join('; ')}`,
      );
      const measured = measure(facts, samples);
      const misses = levelMisses(level, measured, {
        left: left.length,
        of: jobs.length,
        minutes: d.policy.levelTimeoutMs / 60_000,
      });
      d.progress.mark(`${String(level)}: ${JSON.stringify(measured)}`);
      results.push({ ...measured, level, green: misses.length === 0, misses });
      d.progress.mark(
        `${String(level)} replicas: ${misses.length === 0 ? 'green' : `not green (${misses.join('; ')})`}; claim p99 ${(measured.api.routes.claim?.p99 ?? 0).toFixed(0)} ms, ${measured.jobsPerSecond.toFixed(1)} Jobs/s`,
      );
      await endJobs(d, pool, deploymentId);
    }
  } finally {
    await d.burst.stopClaimers();
  }
  return results;
}

/**
 * S12's claim-queue burst and in-flight cap (RFC 0044 decision 26)
 * on the local K3s, its management node constrained to a production
 * default's 2 vCPU and 4 GiB.
 */
export class ClaimBurstContract {
  readonly #dependencies: ClaimBurstDependencies;

  constructor(dependencies: ClaimBurstDependencies) {
    this.#dependencies = dependencies;
  }

  async run(
    target: 'e2e-claim-burst-local',
  ): Promise<ClaimBurstContractResult> {
    invariant(
      target === 'e2e-claim-burst-local',
      `unsupported target ${target}`,
    );
    const d = this.#dependencies;
    await d.burst.prepare();
    const burstName = d.names.nodePool('burst');
    d.burst.usePoolVmType(burstName, 'priced');
    const burstPool = await createReadyNodePool(
      d,
      await d.nodePools.reserve(burstName, d.policy.nodePoolTimeoutMs),
      2,
    );
    d.progress.mark('burst node pool ready');
    const burst = await qualifyBurst(d, burstPool);
    d.progress.mark(
      `burst: ${String(burst.jobs)} Jobs in ${burst.seconds.toFixed(0)} s, ${burst.jobsPerSecond.toFixed(1)} Jobs/s; claim p99 ${(burst.api.routes.claim?.p99 ?? 0).toFixed(0)} ms; ${burst.claimsPerJob.toFixed(1)} claim calls per Job`,
    );

    await d.burst.startKwok();
    const kwokName = d.names.nodePool('kwok');
    d.burst.usePoolVmType(kwokName, 'kwok');
    // KWOK Nodes hold 250 Pods each.
    const kwokPool = await createReadyNodePool(
      d,
      await d.nodePools.reserve(kwokName, d.policy.nodePoolTimeoutMs),
      Math.ceil(Math.max(...d.policy.levels) / 200),
    );
    d.progress.mark('KWOK node pool ready');
    const levels = await qualifyLevels(d, kwokPool);
    await d.burst.setInFlightCap(d.policy.inFlightCap);
    const nodePools = await deleteNodePools(
      { ...d, policy: { nodePoolTimeoutMs: d.policy.nodePoolTimeoutMs } },
      [burstPool, kwokPool],
    );
    return {
      contract: 'e2e-claim-burst-local',
      qualification: 'conclusive',
      satisfied: true,
      target: 'e2e-claim-burst-local',
      records: { burst, levels, nodePools },
    };
  }
}
