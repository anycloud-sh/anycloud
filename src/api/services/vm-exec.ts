/**
 * Run a long command on a VM *detached from the SSH control stream*, then poll a
 * result sentinel with short execs.
 *
 * Long commands run as a single held-open SSH exec (`docker pull`, the initial
 * rclone input-bucket download, …) get killed by ~5-min NAT/idle teardowns of the
 * control connection — and an item larger than that window then never completes
 * (it restarts from scratch each retry). The fix is to let the VM own the work:
 * launch it as a systemd transient unit (or `nohup` on no-systemd hosts) that
 * writes its exit code to a sentinel file, then poll that sentinel with short
 * execs that comfortably finish inside the teardown window.
 *
 * Used by DockerManager (image pull) and SupervisorManager (input-bucket download).
 */

import { log } from './logger.js';
import { shellEscape, sleep } from '../../shared/utils.js';
import { SSHExecError } from './gateways/ssh.js';

/** Short-command runner (throws on non-zero exit). Provided by the caller so this
 * stays decoupled from SSHManager and trivially unit-testable. */
export type VmExecFn = (
  cmd: string,
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export class DetachedRunError extends Error {
  constructor(
    message: string,
    /** `null` when the run timed out or the unit vanished without a result. */
    public readonly exitCode: number | null,
    public readonly logTail: string,
  ) {
    super(message);
    this.name = 'DetachedRunError';
  }
}

export interface DetachedRunOptions {
  /** Transient-unit name and sentinel basename, e.g. `ac-pull-<id>`. Must be a
   * valid systemd unit name (`[A-Za-z0-9_.-]`). */
  unit: string;
  /** The actual work, as a shell command. May source env files (e.g. rclone
   * creds), which keeps secrets off argv. Stdout+stderr are captured to a log. */
  command: string;
  /** Non-secret extra env (e.g. the image ref) passed via `systemd-run --setenv`
   * / an inline assignment, so it needs no nested quoting. Do NOT pass secrets
   * here — put those in a sourced env file inside `command`. */
  env?: Record<string, string>;
  /** Overall wall-clock budget. At least one timeout policy is required. */
  totalTimeoutMs?: number;
  /** Stop an active worker whose captured output has not grown for this long.
   * Work whose valid duration is data-dependent uses this in place of a total
   * budget, and must emit periodic progress or heartbeat output. */
  inactivityTimeoutMs?: number;
  /** The longest one poll waits on the VM for the run to finish; it returns
   * within half a second of the result. */
  pollIntervalMs: number;
  /** Per short control exec (launch / poll / tail). */
  controlTimeoutMs: number;
  /** Relaunch budget on a real failure / vanished unit (default 3). */
  maxLaunches?: number;
  /** Skip the `ps -p 1` probe when the caller already knows (Supervisor caches it). */
  hasSystemd?: boolean;
  /** Fingerprint of the work definition. When set, an already-active unit that
   * recorded the same value is adopted instead of replaced, so a controller
   * restart reattaches to a healthy transfer rather than starting it over. */
  runIdentity?: string;
  /** Structured-log context (id, image, host, …). */
  logContext?: Record<string, unknown>;
}

/**
 * Launch `command` detached on the VM (or adopt an equivalent run already in
 * flight, when `runIdentity` is supplied) and poll until it finishes.
 * Resolves with the captured log tail on exit 0; throws `DetachedRunError` on a
 * non-zero exit, either timeout policy, or a unit that vanished without a
 * result. At least one timeout policy is required.
 */
export async function runDetachedOnVm(
  exec: VmExecFn,
  opts: DetachedRunOptions,
): Promise<{ logTail: string }> {
  const {
    unit,
    command,
    env = {},
    totalTimeoutMs,
    inactivityTimeoutMs,
    pollIntervalMs,
    controlTimeoutMs,
  } = opts;
  if (totalTimeoutMs === undefined && inactivityTimeoutMs === undefined) {
    throw new Error(
      'runDetachedOnVm requires a total or inactivity timeout policy',
    );
  }
  const maxLaunches = opts.maxLaunches ?? 3;
  const ctx = opts.logContext ?? {};
  const donePath = `/tmp/${unit}.done`;
  const logPath = `/tmp/${unit}.log`;
  const pidPath = `/tmp/${unit}.pid`;
  const identityPath = `/tmp/${unit}.identity`;

  // Detect systemd unless told. On hosts without it (docker-in-docker test VMs,
  // some minimal images) we fall back to `nohup` — the same mechanism supervisor
  // already uses for its no-systemd rclone services.
  let hasSystemd = opts.hasSystemd;
  if (hasSystemd === undefined) {
    try {
      const { stdout } = await exec(
        'ps -p 1 -o comm= 2>/dev/null',
        controlTimeoutMs,
      );
      hasSystemd = stdout.trim() === 'systemd';
    } catch {
      hasSystemd = false;
    }
  }

  // Run the caller body in a subshell so its shell options cannot prevent the
  // wrapper from recording the result. In particular, transfer workers use
  // `set -e`; without the subshell, their first failure exits before the done
  // sentinel is written and looks like a vanished systemd unit.
  const innerScript = [
    '(',
    command,
    `) > ${logPath} 2>&1`,
    'exit_code=$?',
    `printf '%s\\n' "$exit_code" > ${donePath}`,
  ].join('\n');

  let launchCmd: string;
  let livenessCmd: string; // prints 'active' while running, anything else when gone
  let stopCmd: string;
  const writeIdentity = opts.runIdentity
    ? `printf '%s\\n' ${shellEscape(opts.runIdentity)} > ${identityPath}; `
    : `rm -f ${identityPath}; `;
  if (hasSystemd) {
    const setenv = Object.entries(env)
      .map(([k, v]) => `--setenv=${k}=${shellEscape(v)}`)
      .join(' ');
    // Stop+reset any leftover unit (a still-running attempt from a prior deploy)
    // so the fixed unit name never collides, then launch fresh. systemd expands
    // `${…}` in the unit's arguments (an invalid name such as `${VAR#prefix}`
    // becomes empty) and reads `$$` as a literal `$`, so double every `$` for
    // `sh` to receive the script verbatim.
    const systemdScript = innerScript.replace(/\$/g, () => '$$');
    launchCmd =
      `systemctl stop ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null; ` +
      `rm -f ${donePath} ${logPath}; ` +
      writeIdentity +
      `systemd-run --collect --quiet --unit=${unit} ${setenv} /bin/sh -c ${shellEscape(systemdScript)}`;
    livenessCmd = `systemctl is-active ${unit} 2>/dev/null || true`;
    stopCmd = `systemctl stop ${unit} 2>/dev/null || true`;
  } else {
    // No systemd: `nohup`, detaching the worker from the SSH session. Track its
    // PID in a file so liveness/stop are exact (a `pkill -f` would match this
    // launching shell too, since the command line contains the unit name).
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellEscape(v)} `)
      .join('');
    launchCmd =
      `kill "$(cat ${pidPath} 2>/dev/null)" 2>/dev/null; rm -f ${donePath} ${logPath} ${pidPath}; ` +
      writeIdentity +
      `${envPrefix}nohup sh -c ${shellEscape(innerScript)} </dev/null >/dev/null 2>&1 & echo $! > ${pidPath}`;
    livenessCmd = `if kill -0 "$(cat ${pidPath} 2>/dev/null)" 2>/dev/null; then echo active; else echo inactive; fi`;
    stopCmd = `kill "$(cat ${pidPath} 2>/dev/null)" 2>/dev/null || true`;
  }
  // One probe shape for both the pre-launch adoption check and the poll loop:
  // three positional lines — state (or `DONE <code>`), captured log bytes, and
  // the recorded run identity. Check liveness before the sentinel: the worker
  // writes the sentinel before exiting, so a subsequent sentinel read is the
  // authoritative result if it completes while this probe is running.
  // Positional fields beat an in-band marker because an empty state still holds
  // its own line instead of shifting the other fields.
  const probeCmd =
    `probe_state="$(${livenessCmd})"; ` +
    `if [ -f ${donePath} ]; then printf 'DONE %s\\n' "$(cat ${donePath})"; else printf '%s\\n' "$probe_state"; fi; ` +
    `wc -c 2>/dev/null < ${logPath} || echo 0; ` +
    `cat ${identityPath} 2>/dev/null || echo`;
  // The poll waits on the VM, checking every half second, so a result is seen
  // at once rather than at the next of a backed-off series of polls.
  const waitCmd =
    `for _ in $(seq ${Math.max(1, Math.round(pollIntervalMs / 500))}); do ` +
    `[ -f ${donePath} ] && break; ` +
    `case "$(${livenessCmd})" in active|activating|reloading) sleep 0.5 ;; *) break ;; esac; ` +
    `done; `;
  const parseProbe = (stdout: string) => {
    const [state = '', activity = '', identity = ''] = stdout
      .split('\n')
      .map((line) => line.trim());
    return { state, activity, identity };
  };
  const isRunning = (state: string) =>
    state === 'active' || state === 'activating' || state === 'reloading';
  const formatTimeout = (timeoutMs: number) =>
    timeoutMs < 60_000
      ? `${Math.max(1, Math.ceil(timeoutMs / 1000))} sec`
      : `${Math.round(timeoutMs / 60_000)} min`;

  const startedAt = Date.now();
  let launches = 0;
  let logTail = '';
  let lastActivityBytes: string | undefined;
  let lastActivityAt = Date.now();
  // Between polls, so a poll that fails at once (an SSH drop) doesn't spin.
  const pollGapMs = Math.min(500, pollIntervalMs);

  const readLogTail = async (): Promise<string> => {
    try {
      const { stdout } = await exec(
        `tail -c 4000 ${logPath} 2>/dev/null || true`,
        controlTimeoutMs,
      );
      return stdout;
    } catch {
      return logTail;
    }
  };
  const launch = async () => {
    launches++;
    lastActivityBytes = undefined;
    lastActivityAt = Date.now();
    await exec(launchCmd, controlTimeoutMs);
    log.info('Launched detached VM command', {
      ...ctx,
      unit,
      systemd: hasSystemd,
      attempt: launches,
    });
  };
  const beforeDeadline = () =>
    totalTimeoutMs === undefined || Date.now() < startedAt + totalTimeoutMs;
  const stopForInactivity = async (timeoutMs: number) => {
    await exec(stopCmd, controlTimeoutMs).catch(() => {});
    logTail = await readLogTail();
    throw new DetachedRunError(
      `produced no output within ${formatTimeout(timeoutMs)}`,
      null,
      logTail.slice(-2000),
    );
  };
  /** A transient SSH drop while reading the probe says nothing about the detached
   * worker — it keeps running VM-side, so returning lets the caller re-poll on the
   * next tick. An unreadable worker is still an unobserved one though: a run with
   * no total budget would otherwise poll forever, because the inactivity clock is
   * only consulted on a probe that succeeds. Anything that is not a transport
   * failure is rethrown. */
  const handleProbeFailure = async (err: unknown) => {
    if (!(err instanceof SSHExecError)) throw err;
    if (
      inactivityTimeoutMs !== undefined &&
      Date.now() - lastActivityAt > inactivityTimeoutMs
    ) {
      await stopForInactivity(inactivityTimeoutMs);
    }
  };

  try {
    // Adoption is requested by supplying an identity: reattach only to a unit
    // that is still running the same work definition. A mismatch falls through
    // to launch(), whose stop-then-start on the shared unit name also clears
    // the stale worker so two of them never write the same destination.
    const existing =
      opts.runIdentity === undefined
        ? undefined
        : parseProbe((await exec(probeCmd, controlTimeoutMs)).stdout);
    if (
      existing &&
      isRunning(existing.state) &&
      existing.identity === opts.runIdentity
    ) {
      launches = 1;
      log.info('Adopted detached VM command', {
        ...ctx,
        unit,
        systemd: hasSystemd,
      });
    } else {
      await launch();
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (
        totalTimeoutMs !== undefined &&
        Date.now() > startedAt + totalTimeoutMs
      ) {
        await exec(stopCmd, controlTimeoutMs).catch(() => {});
        logTail = await readLogTail();
        throw new DetachedRunError(
          `did not complete within ${formatTimeout(totalTimeoutMs)}`,
          null,
          logTail.slice(-2000),
        );
      }
      await sleep(pollGapMs);

      let probe: { state: string; activity: string; identity: string };
      try {
        probe = parseProbe(
          (await exec(waitCmd + probeCmd, controlTimeoutMs)).stdout,
        );
      } catch (err) {
        await handleProbeFailure(err);
        continue;
      }

      if (!probe.state.startsWith('DONE') && !isRunning(probe.state)) {
        // A worker can write its sentinel and exit while a liveness probe is in
        // flight, or a liveness read can transiently report it as gone. Confirm
        // once before treating the run as vanished and spending a relaunch.
        try {
          probe = parseProbe((await exec(probeCmd, controlTimeoutMs)).stdout);
        } catch (err) {
          await handleProbeFailure(err);
          continue;
        }
      }

      if (probe.state.startsWith('DONE')) {
        const code = parseInt(probe.state.slice(4).trim(), 10);
        logTail = await readLogTail();
        if (code === 0) return { logTail };
        log.warn('Detached VM command failed', {
          ...ctx,
          unit,
          code,
          attempt: launches,
          stdout: logTail.slice(-2000),
        });
        // Relaunch a bounded number of times (cached work is skipped), else fail.
        if (launches < maxLaunches && beforeDeadline()) {
          await sleep(pollIntervalMs);
          await launch();
          continue;
        }
        throw new DetachedRunError(
          `exited with code ${code}`,
          Number.isNaN(code) ? null : code,
          logTail.slice(-2000),
        );
      }

      if (isRunning(probe.state)) {
        if (probe.activity !== '' && probe.activity !== lastActivityBytes) {
          lastActivityBytes = probe.activity;
          lastActivityAt = Date.now();
        } else if (
          inactivityTimeoutMs !== undefined &&
          Date.now() - lastActivityAt > inactivityTimeoutMs
        ) {
          await stopForInactivity(inactivityTimeoutMs);
        }
        continue; // still running
      }

      // Ended without a sentinel (killed / vanished). Relaunch — cached work
      // resumes fast if it had actually completed.
      logTail = await readLogTail();
      log.warn('Detached VM command ended without a result', {
        ...ctx,
        unit,
        state: probe.state || 'unknown',
        attempt: launches,
        stdout: logTail.slice(-2000),
      });
      if (launches < maxLaunches && beforeDeadline()) {
        await sleep(pollIntervalMs);
        await launch();
        continue;
      }
      throw new DetachedRunError(
        `ended unexpectedly (state: ${probe.state || 'unknown'})`,
        null,
        logTail.slice(-2000),
      );
    }
  } catch (error) {
    if (error instanceof DetachedRunError) throw error;
    const msg = (error as Error)?.message || String(error);
    throw new DetachedRunError(
      msg,
      null,
      (logTail || (await readLogTail())).slice(-2000),
    );
  }
}
