/**
 * `anycloud-runner`: a managed replica's entrypoint, under tini as PID 1,
 * which reaps orphans and forwards the replica's SIGTERM here.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
// Not the API client's runtime module: its config computes paths under the
// home directory at load, and a Job image's user may have none.
import packageJson from '../../package.json' with { type: 'json' };
import { USER_NAMESPACE_RUNNER_EXIT_CODE } from '../shared/runtime.js';
import { createRunnerApi } from './api.js';
import {
  delegateCgroup,
  namespaceRootOoms,
  writeTerminationMessage,
} from './cgroup.js';
import { cgroupOomKills } from './oom.js';
import { empty, replicaReset } from './reset.js';
import { runRunner, runnerExitCode } from './runner.js';
import { rcloneCopy } from './transfer.js';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const log = (message: string) =>
  process.stderr.write(`[anycloud-runner] ${message}\n`);

const killAll = (signal: 'SIGTERM' | 'SIGKILL') => {
  try {
    process.kill(-1, signal);
  } catch {
    // ESRCH: no other process is left.
  }
};

// RFC 0049 C32: before any claim, so a replica whose image can't delegate
// its cgroup claims nothing; the Deployment owner ends its queued Jobs with
// the termination message.
const userNamespace = process.env.ANYCLOUD_RUNNER_USER_NAMESPACE === '1';
const delegation = userNamespace ? delegateCgroup(process.getuid!()) : null;
if (delegation) {
  log(delegation);
  await writeTerminationMessage(delegation);
  process.exit(USER_NAMESPACE_RUNNER_EXIT_CODE);
}

// The runner's mounts and the Job's Node caches (RFC 0049 C12) stay out of
// the working directory's copy, so a reset neither restores nor empties them.
const workdirCopy = required('ANYCLOUD_RUNNER_WORKDIR_COPY');
const caches = JSON.parse(
  process.env.ANYCLOUD_RUNNER_CACHES ?? '[]',
) as string[];
const reset = await replicaReset({
  workdir: process.cwd(),
  copy: workdirCopy,
  mounts: [dirname(process.execPath), workdirCopy, ...caches],
  emptied: ['/mnt/output', '/mnt/checkpoint', '/tmp', '/dev/shm'],
  killAll: () => killAll('SIGKILL'),
  log,
});

const shutdown = new AbortController();
process.on('SIGTERM', () => shutdown.abort());

const end = await runRunner(
  {
    api: createRunnerApi({
      apiUrl: required('ANYCLOUD_API_URL'),
      deploymentId: required('ANYCLOUD_DEPLOYMENT_ID'),
      tokenFile: required('ANYCLOUD_WORKLOAD_TOKEN_FILE'),
      release: packageJson.version,
      log,
    }),
    copy: rcloneCopy(join(dirname(process.execPath), 'rclone')),
    entrypoint: JSON.parse(required('ANYCLOUD_RUNNER_ENTRYPOINT')) as string[],
    cmd: JSON.parse(required('ANYCLOUD_RUNNER_CMD')) as string[],
    stopGraceMs: (Number(required('ANYCLOUD_RUNNER_GRACE_SECONDS')) * 1000) / 2,
    start: (argv, env) =>
      new Promise((resolve) => {
        if (!argv[0]) return resolve(127);
        const child = spawn(argv[0], argv.slice(1), {
          env: { ...process.env, ...env },
          stdio: 'inherit',
        });
        // As a shell reports them: 127 not found, 126 not executable.
        child.on('error', (error: NodeJS.ErrnoException) =>
          resolve(error.code === 'ENOENT' ? 127 : 126),
        );
        child.on('exit', (code, signal) =>
          resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)),
        );
      }),
    killAll,
    // A user-namespace replica's runner sits in a leaf after the delegation,
    // so its OOMs are the namespace root's own (memory.events.local); any
    // other replica's are its own cgroup's.
    oomKills: userNamespace
      ? () => namespaceRootOoms()
      : cgroupOomKills('/', log),
    reset,
    empty,
    log,
  },
  shutdown.signal,
);
// Exiting restarts the replica's container (restartPolicy Always) unless
// the replica is stopping.
process.exit(runnerExitCode(end));
