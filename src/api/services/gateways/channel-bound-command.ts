/**
 * Tie a remote command's lifetime to the SSH channel that started it.
 *
 * Deliberately not in transport.ts: tests fake the transport with a whole-module
 * mock, which would take this pure helper with it.
 */

import { shellEscape } from '../../../shared/utils.js';

/**
 * How long a cancelled command gets to exit on its own before it is killed
 * outright. Nothing is waiting on the other end by then — the client has already
 * disconnected — so this only has to be long enough for an orderly shutdown.
 */
const TERM_GRACE_SECONDS = 2;

/**
 * Wrap a command so it dies with the channel that started it.
 *
 * Closing a channel does not stop the command behind it: OpenSSH ignores SSH
 * signal requests, and a command that writes nothing never takes a SIGPIPE from
 * the closed pipe either. Without this, cancelling a log follow leaves
 * `docker logs -f` running on the VM for as long as the container lives.
 *
 * A guard blocks reading the channel's stdin, which stays open for the life of
 * the channel. When the channel closes, stdin hits EOF and the guard stops the
 * command, escalating to SIGKILL if it does not go quietly.
 *
 * Every detail below is load-bearing, and each was established against a real
 * sshd rather than reasoned about:
 *
 * - `exec 3<&0` saves stdin first. A backgrounded command in a shell without
 *   job control gets its stdin from /dev/null, so a guard reading plain stdin
 *   sees EOF immediately and kills the command milliseconds after it starts.
 * - The command runs under `setsid`, in a process group of its own. Signalling
 *   a group is the only way to reach the real process, which sits several shell
 *   levels below the pid we background — but signalling *our* group is unsafe,
 *   because only OpenSSH puts the session in one. Dropbear, for instance,
 *   shares its connection process's group with the session, so signalling it
 *   drops the whole SSH connection and takes every other command sharing that
 *   pooled connection with it. Every substrate AnyCloud reaches over SSH runs
 *   OpenSSH today, but a marketplace image supplies its own server.
 * - `setsid` does not fork here, because a command backgrounded by a shell
 *   without job control is not a process group leader. So the backgrounded pid
 *   is the command itself and leads the new group, which keeps `wait` and the
 *   exit status working.
 * - Without `setsid` the guard falls back to signalling the pid alone. That
 *   cannot reach a deeply nested process, but it is never unsafe — the point is
 *   to degrade rather than either kill a group we do not own or fail to run the
 *   command at all.
 * - The normal-exit path kills the guard with SIGKILL. SIGTERM would do, but
 *   the guard has no handler and nothing depends on it unwinding.
 * - The guard blocks on `read`, a shell builtin, rather than `cat`. This runs
 *   inside the user's container on the exec path, where the only thing we can
 *   assume is the `sh` that path already requires — a minimal image with no
 *   coreutils would otherwise lose `anycloud exec` entirely, which is worse
 *   than the leak this prevents.
 *
 * `wait` before the cleanup preserves the command's exit status.
 *
 * Note that this consumes the channel's stdin, so the wrapped command reads
 * /dev/null. Nothing forwards stdin today. If that is ever wanted (an
 * interactive `anycloud exec`), this mechanism cannot be kept as-is: the
 * alternative is a second exec on the pooled connection that kills the
 * session's process group, which leaves stdin free but leaks the command if the
 * connection itself dropped — the case this guard handles for free.
 */
export function channelBoundCommand(command: string): string {
  const escaped = shellEscape(command);
  return [
    'exec 3<&0',
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid sh -c ${escaped} &`,
    '  cmd=$!; target="-$cmd"',
    'else',
    `  sh -c ${escaped} &`,
    '  cmd=$!; target="$cmd"',
    'fi',
    `{ while read -r _; do :; done <&3; kill -TERM "$target" 2>/dev/null; sleep ${TERM_GRACE_SECONDS}; kill -KILL "$target" 2>/dev/null; } &`,
    'guard=$!',
    'wait "$cmd"; status=$?',
    'kill -KILL "$guard" 2>/dev/null',
    'exit "$status"',
  ].join('\n');
}
