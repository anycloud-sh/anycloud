/**
 * The runner (RFC 0044 § Pool Jobs on managed Deployments, RFC 0043): inside
 * one managed replica, claim one Job at a time, stage its inputs and
 * checkpoint, run its command unmodified as a child, upload outputs and
 * checkpoints about every 60 s and once more at the end, report how the
 * attempt ended, reset, and claim the next.
 */
import { randomUUID } from 'node:crypto';
import type {
  RunnerCause,
  WorkloadExecution,
} from '../shared/api-contract/deployment-workload-schemas.js';
import { sleep } from '../shared/utils.js';
import { FenceError, type RunnerApi } from './api.js';
import { NO_PROGRESS_MS, type Copy } from './transfer.js';

const RETRY_MS = 30_000;

export interface RunnerPorts {
  api: RunnerApi;
  copy: Copy;
  /** The image's Entrypoint, which the Job's command follows. */
  entrypoint: string[];
  /** The image's Cmd, run when the Job has no command, as `docker run` does. */
  cmd: string[];
  /**
   * Between SIGTERM and SIGKILL when the runner stops a command: half the
   * replica's grace, so the final upload gets the rest.
   */
  stopGraceMs: number;
  /** Start the command as a child; resolves with its exit code. */
  start(argv: string[], env: Record<string, string>): Promise<number>;
  /** `kill(-1, signal)`: every process but the runner and PID 1. */
  killAll(signal: 'SIGTERM' | 'SIGKILL'): void;
  /**
   * The container cgroup's `oom_kill` count, from `memory.events`; in a
   * user-namespace replica, its root's own `oom` count.
   */
  oomKills(): Promise<number>;
  /** Return the replica to its start state, or throw. */
  reset(): Promise<void>;
  /** Remove everything inside a directory. */
  empty(dir: string): Promise<void>;
  log(message: string): void;
}

type Stop = 'terminate' | 'sigterm' | 'deadline' | 'expired' | 'fenced';

const pause = (ms: number, signal?: AbortSignal) =>
  sleep(Math.max(0, ms), signal).catch(() => {});

/**
 * The runner's exit code. A replica SIGTERM exits 143, never 0: a limit
 * eviction gives 2 s, and when every container exits 0 the kubelet's
 * terminal status turns Succeeded and drops the Pod's Evicted reason, which
 * the Deployment owner needs to end the Job invalid (RFC 0043 S12).
 */
export function runnerExitCode(end: 'stopped' | 'restart'): number {
  return end === 'restart' ? 1 : 143;
}

/**
 * Claim and run Jobs until the replica is told to stop, or until anything in
 * its container was OOM-killed: containerd keeps the container's `OOMKilled`
 * reason, so the replica restarts to name only a later Job's OOM with it.
 * Each container gets a fresh cgroup, so any kill in it counts.
 */
export async function runRunner(
  ports: RunnerPorts,
  shutdown: AbortSignal,
): Promise<'stopped' | 'restart'> {
  const replica: Replica = {};
  // Before the first claim too: a restarted container keeps the last Job's
  // fixed paths, which are emptyDirs. An empty poll changes nothing.
  let dirty = true;
  while (!shutdown.aborted) {
    if (dirty) await ports.reset();
    dirty = false;
    const candidate = await ports.api.candidate(shutdown).catch((error) => {
      if (shutdown.aborted) return null;
      throw error;
    });
    const executionId = randomUUID();
    if (!candidate || !(await ports.api.claim(candidate, executionId))) {
      continue;
    }
    dirty = true;
    await runJob(ports, candidate.jobId, executionId, shutdown, replica).catch(
      (error: unknown) => {
        // S14: another execution holds the Job now; drop this one.
        if (!(error instanceof FenceError)) throw error;
        ports.log(`Job ${candidate.jobId} is no longer this replica's`);
      },
    );
    if ((await ports.oomKills()) > 0) return 'restart';
  }
  return 'stopped';
}

/** What the replica keeps between Jobs: which input `/mnt/input` holds. */
interface Replica {
  input?: string;
}

/**
 * An input grant's bucket, without its credentials, which change with every
 * mint: the remote path plus the env that isn't secret (account, region,
 * endpoint).
 */
const inputIdentity = (grant: {
  remote: string;
  env: Record<string, string>;
}) =>
  JSON.stringify([
    grant.remote,
    Object.entries(grant.env)
      .filter(([name]) => !/SAS|TOKEN|SECRET|KEY|PASSWORD/i.test(name))
      .sort(),
  ]);

/** One claimed execution, from staging to its report. */
export async function runJob(
  ports: RunnerPorts,
  jobId: string,
  executionId: string,
  shutdown: AbortSignal,
  replica: Replica = {},
): Promise<void> {
  const { api } = ports;
  const job = {
    spec: await api.execution(jobId, executionId),
    stop: undefined as Stop | undefined,
    staging: true,
    exited: false,
  };
  const done = new AbortController();
  const stopped = new AbortController();
  const requestStop = (reason: Stop) => {
    // Once the command's exit wins, a cancel can't replace it until finish;
    // other stops are kept for the ending and the final upload.
    if (job.stop || done.signal.aborted) return;
    if (job.exited && reason === 'terminate') return;
    job.stop = reason;
    stopped.abort();
    if (job.staging) ports.killAll('SIGKILL');
  };
  const onShutdown = () => requestStop('sigterm');
  shutdown.addEventListener('abort', onShutdown);
  if (shutdown.aborted) onShutdown();
  const background = (task: () => Promise<unknown>) =>
    void task().catch((error: unknown) => {
      if (error instanceof FenceError) requestStop('fenced');
      else if (!done.signal.aborted) ports.log(`Runner task failed: ${error}`);
    });

  background(async () => {
    while (!done.signal.aborted) {
      if (await api.cancelled(jobId, executionId, done.signal)) {
        return requestStop('terminate');
      }
      await pause(1_000, done.signal);
    }
  });
  // Renew every credential once half the earliest one's remaining lifetime
  // has passed; if one expires first, stop the command (RFC 0043).
  background(async () => {
    for (;;) {
      const expiries = Object.values(job.spec.storage).map((g) => g.expiresAt);
      if (expiries.length === 0) return;
      const earliest = Math.min(...expiries);
      await pause((earliest - Date.now()) / 2, done.signal);
      if (done.signal.aborted) return;
      const renewal = new AbortController();
      const renewed = await Promise.race([
        api.execution(jobId, executionId, renewal.signal),
        pause(earliest - Date.now(), done.signal).then(() => null),
      ]);
      renewal.abort();
      if (done.signal.aborted) return;
      if (!renewed) return requestStop('expired');
      job.spec = { ...job.spec, storage: renewed.storage };
    }
  });

  try {
    const invalid = await stage(ports, job, replica, stopped.signal);
    job.staging = false;
    if (job.stop === 'fenced') throw new FenceError(`Job ${jobId} was fenced`);
    if (invalid || job.stop) {
      const ending = invalid
        ? ({ kind: 'unrecoverable', detail: invalid } as const)
        : endingOf(job);
      return await finish(ports, jobId, executionId, job, done, ending, false);
    }
    await api.report(jobId, { executionId, phase: 'running' });
    const limit = job.spec.timeLimitSeconds;
    const deadline =
      limit === null
        ? undefined
        : setTimeout(() => requestStop('deadline'), limit * 1_000);
    const oomBefore = await ports.oomKills();
    // The exit wins as it resolves, so a stop landing in the same microtask
    // flush can't replace it.
    const exit = ports
      .start(
        [
          ...ports.entrypoint,
          ...(job.spec.command.length > 0 ? job.spec.command : ports.cmd),
        ],
        job.spec.env,
      )
      .then((code) => ((job.exited = !job.stop), code));
    const ended = new AbortController();
    const uploads = (async () => {
      // A failed periodic upload is retried on the next tick (RFC 0043).
      for (;;) {
        await pause(60_000, ended.signal);
        if (ended.signal.aborted) return;
        await upload(ports, job.spec);
      }
    })();
    const stopRequested = new Promise<undefined>((resolve) =>
      stopped.signal.addEventListener('abort', () => resolve(undefined)),
    );
    let code = await Promise.race([exit, stopRequested]);
    if (code === undefined) {
      ports.killAll('SIGTERM');
      const graceful = await Promise.race([exit, pause(ports.stopGraceMs)]);
      if (graceful === undefined) ports.killAll('SIGKILL');
      code = await exit;
    }
    clearTimeout(deadline);
    ended.abort();
    await uploads;
    if (job.stop === 'fenced') throw new FenceError(`Job ${jobId} was fenced`);
    const oom = code !== 0 && (await ports.oomKills()) > oomBefore;
    // A stop that won the race ends the Job by its cause, and so does an
    // expiry after the exit: outputs can't be uploaded with expired
    // credentials, so the Job retries.
    const ending =
      job.stop === 'expired' || (job.stop && !job.exited)
        ? endingOf(job)
        : ({ kind: 'exit', code, oom } as const);
    job.exited = false;
    return await finish(ports, jobId, executionId, job, done, ending, true);
  } finally {
    done.abort();
    shutdown.removeEventListener('abort', onShutdown);
  }
}

/**
 * The cause the runner reports for a stop, or none for a replica SIGTERM: the
 * runner can't tell a drain or an upgrade from an eviction at the replica's
 * `ephemeral-storage` limit, so the Deployment owner classifies the held Pod
 * (RFC 0043 S12).
 */
function endingOf(job: {
  stop?: Stop;
  spec: WorkloadExecution;
}): RunnerCause | undefined {
  if (job.stop === 'sigterm') return undefined;
  if (job.stop === 'deadline') {
    return {
      kind: 'deadline',
      detail: `Time limit of ${job.spec.timeLimitSeconds}s reached`,
    };
  }
  return {
    kind: 'disrupted',
    detail: 'storage credentials expired before they could be renewed',
  };
}

/** Stage inputs and the checkpoint; the reason when staging can't succeed. */
async function stage(
  ports: RunnerPorts,
  job: { spec: WorkloadExecution; stop?: Stop },
  replica: Replica,
  stopped: AbortSignal,
): Promise<string | undefined> {
  // Inputs stay only for a Job of the same input bucket, which syncs them;
  // any other Job sees none of the last Job's (RFC 0044 S19).
  const { input } = job.spec.storage;
  const identity = input && inputIdentity(input);
  if (!identity || identity !== replica.input) {
    await ports.empty('/mnt/input');
  }
  replica.input = identity;
  for (const role of ['input', 'checkpoint'] as const) {
    for (;;) {
      const grant = job.spec.storage[role];
      if (!grant || job.stop) break;
      // Inputs stay between Jobs, so a sync re-stages only what changed.
      const copied = await ports.copy(
        grant.remote,
        `/mnt/${role}`,
        grant.env,
        role === 'input',
      );
      // Every first attempt finds no checkpoint yet.
      if (copied.result === 'done') break;
      if (copied.result === 'missing' && role === 'checkpoint') break;
      if (copied.result === 'missing' || copied.result === 'denied') {
        return `Could not stage the ${role} bucket: ${copied.detail}`;
      }
      ports.log(`Staging ${role} failed, retrying: ${copied.detail}`);
      await pause(RETRY_MS, stopped);
    }
  }
}

/** One copy of outputs and checkpoints; the last failure, if any. */
async function upload(ports: RunnerPorts, spec: WorkloadExecution) {
  let failure: string | undefined;
  let moved = false;
  for (const role of ['output', 'checkpoint'] as const) {
    const grant = spec.storage[role];
    if (!grant) continue;
    const copied = await ports.copy(`/mnt/${role}`, grant.remote, grant.env);
    moved ||= copied.moved;
    if (copied.result !== 'done') {
      ports.log(`Uploading ${role} failed: ${copied.detail}`);
      failure = copied.detail;
    }
  }
  return failure === undefined ? undefined : { detail: failure, moved };
}

/**
 * Upload, then publish the outcome: the Job completes only after its final
 * upload (invariant 12). A failing upload retries and keeps the Job
 * `finalizing` until it makes no progress for 15 min (S20); after a replica
 * SIGTERM it gets one try within the grace.
 */
async function finish(
  ports: RunnerPorts,
  jobId: string,
  executionId: string,
  job: { spec: WorkloadExecution; stop?: Stop },
  done: AbortController,
  ending: RunnerCause | undefined,
  ran: boolean,
): Promise<void> {
  const { api } = ports;
  if (ran && job.stop !== 'terminate') {
    await api.report(jobId, { executionId, phase: 'finalizing' });
  }
  for (let since = Date.now(); ran && job.stop !== 'expired'; ) {
    const failure = await upload(ports, job.spec);
    if (!failure) break;
    if (failure.moved) since = Date.now();
    // Stopped before the outputs were safe: the attempt retries. The stop
    // may arrive while this loop waits.
    const stop = job.stop as Stop | undefined;
    if (stop === 'sigterm' || stop === 'expired') {
      ending = endingOf(job);
      break;
    }
    if (Date.now() - since >= NO_PROGRESS_MS) {
      ending = { kind: 'transfer', detail: failure.detail };
      break;
    }
    await pause(RETRY_MS);
  }
  done.abort();
  // A Node shutdown signals every process in the container at once, so a
  // command it killed can exit before the runner's own SIGTERM lands; that
  // exit retries as the SIGTERM does, and any other exit stays final.
  if (
    ending?.kind === 'exit' &&
    ending.code === 143 &&
    job.stop === 'sigterm'
  ) {
    ending = endingOf(job);
  }
  if (job.stop === 'terminate') return api.cleanup(jobId, executionId);
  if (ending) await api.report(jobId, { executionId, cause: ending });
}
