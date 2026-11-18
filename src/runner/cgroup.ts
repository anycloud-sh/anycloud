/**
 * RFC 0049 C32: a user-namespace replica's cgroup, delegated to the Job. A
 * container engine enables controllers for its children only once no
 * process is left in the cgroup root (cgroup v2), so before the first claim
 * the runner moves every process into a leaf and enables every available
 * controller, as `docker:dind`'s entrypoint does. The root's `memory.max`
 * and `cpu.max` stay host root's, so a Job can't lift its own limits.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = '/sys/fs/cgroup';
// runc hands the cgroup to the container process's user, with a group the
// namespace doesn't map, so the container's root can't override its mode
// (runs 42183822028, 42183825026, 42183827775: `sudo -n mkdir` was denied).
// The owner opens the root's delegated entries to every user in the
// container, as an engine started through sudo needs; `memory.max` and
// `cpu.max` stay host root's either way.
const evacuation = (root: string) =>
  [
    `mkdir -p ${root}/anycloud-runner`,
    `{ xargs -rn1 < ${root}/cgroup.procs > ${root}/anycloud-runner/cgroup.procs || :; }`,
    `sed -e 's/ / +/g' -e 's/^/+/' < ${root}/cgroup.controllers > ${root}/cgroup.subtree_control`,
    `chmod a+rwx ${root}`,
    `chmod a+rw ${root}/cgroup.procs ${root}/cgroup.subtree_control ${root}/cgroup.threads`,
  ].join(' && ');

const USER_NAMESPACE_REQUIREMENT =
  "A Job on a --user-namespace-jobs pool couldn't delegate its replica's cgroup, as the image's user or through passwordless sudo";

/**
 * After runc's hand-over only the cgroup's owner may write the namespace
 * root's `cgroup.procs` and `cgroup.subtree_control`: the image's user, or
 * the container's root. So the runner evacuates as the image's user, and a
 * non-root one that can't retries through passwordless `sudo -n`. Returns
 * why it failed, or null.
 */
export function delegateCgroup(
  uid: number,
  run: (argv: string[]) => { status: number | null; stderr: string } = (
    argv,
  ) => {
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    return {
      status: result.status,
      stderr: result.error?.message ?? result.stderr,
    };
  },
  root = ROOT,
): string | null {
  const argv = ['sh', '-c', evacuation(root)];
  const failures: string[] = [];
  for (const attempt of uid === 0 ? [argv] : [argv, ['sudo', '-n', ...argv]]) {
    const result = run(attempt);
    if (result.status === 0) return null;
    failures.push(result.stderr.trim() || `exit ${result.status}`);
  }
  return `${USER_NAMESPACE_REQUIREMENT}: ${failures.join('; with sudo -n: ')}`;
}

/**
 * OOM kills at the replica's own limit. The namespace root's `oom` in
 * `memory.events.local` moves only when its own limit is reached, whatever
 * process the kernel then kills, so an inner container stopped at its own
 * `--memory` doesn't count; `memory.events` is hierarchical.
 */
export async function namespaceRootOoms(root = ROOT): Promise<number> {
  const events = await readFile(`${root}/memory.events.local`, 'utf8').catch(
    () => '',
  );
  return Number(/^oom (\d+)$/m.exec(events)?.[1] ?? 0);
}

/** The kubelet reports this file as the container's termination message. */
export async function writeTerminationMessage(message: string): Promise<void> {
  await writeFile('/dev/termination-log', message).catch(() => {});
}
