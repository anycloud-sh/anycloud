/**
 * Boot marks: when each step of a VM host's start happened, in seconds since
 * its kernel started, so the time from boot to the workload's first process
 * splits into its pieces. A Job host's user data and the API's own SSH steps
 * append `<name> <seconds>` lines to BOOT_MARKS_PATH, on tmpfs; startup reads
 * them, with the container's own start, onto the Running event.
 */

import { shellEscape } from '../../../shared/utils.js';
import type { DbVM } from '../entities.js';
import { createTransport } from '../gateways/transport.js';
import type { StoredWorkload } from '../workload-record.js';

/** The host's boot marks; tmpfs, so a reboot starts them afresh. */
export const BOOT_MARKS_PATH = '/run/anycloud/boot-marks';

/** Bounds the read of a host's marks, which only delays the Running event. */
const READ_TIMEOUT_MS = 15_000;

/** A command that appends mark `name` at the host's uptime; it never fails. */
export function bootMark(name: string): string {
  return `{ mkdir -p /run/anycloud && echo "${name} $(cut -d' ' -f1 /proc/uptime)" >> ${BOOT_MARKS_PATH}; } 2>/dev/null || :`;
}

/**
 * `systemd_marks`: systemd's times for the steps before the user data:
 * userspace, cloud-init's first stage, the network online, cloud-init's
 * network stage (cloud-init.service before cloud-init 24.3) and sshd; then
 * what can hold up a login: sshd's own start (socket-activated on Ubuntu
 * 24.04), logins opening, and GCP's guest agent and snapd's seeding. A unit
 * that never started reports 0 and is left out.
 */
export const SYSTEMD_BOOT_MARKS = `systemd_mark() {
  v=$(systemctl show -p "$3" --value $2 2>/dev/null)
  [ "\${v:-0}" -gt 0 ] 2>/dev/null &&
    awk -v n="$1" -v v="$v" 'BEGIN { printf "%s %.2f\\n", n, v / 1e6 }' >> ${BOOT_MARKS_PATH}
}
systemd_marks() {
  systemd_mark userspace "" UserspaceTimestampMonotonic
  systemd_mark cloud-init-local cloud-init-local.service InactiveExitTimestampMonotonic
  systemd_mark network-online network-online.target ActiveEnterTimestampMonotonic
  systemd_mark cloud-init-network cloud-init-network.service InactiveExitTimestampMonotonic ||
    systemd_mark cloud-init-network cloud-init.service InactiveExitTimestampMonotonic
  systemd_mark sshd ssh.socket ActiveEnterTimestampMonotonic ||
    systemd_mark sshd ssh.service ActiveEnterTimestampMonotonic
  systemd_mark ssh-service ssh.service ActiveEnterTimestampMonotonic
  systemd_mark user-sessions systemd-user-sessions.service ActiveEnterTimestampMonotonic
  systemd_mark guest-agent google-guest-agent.service ActiveEnterTimestampMonotonic
  systemd_mark snapd-seeded snapd.seeded.service ActiveEnterTimestampMonotonic
}`;

/**
 * The marks, then the container's creation and start, which Docker records
 * on the wall clock, moved onto the uptime clock.
 */
function readCommand(container: string): string {
  return `cat ${BOOT_MARKS_PATH} 2>/dev/null
up=$(cut -d' ' -f1 /proc/uptime); now=$(date +%s.%N)
set -- $(docker inspect -f '{{.Created}} {{.State.StartedAt}}' ${shellEscape(container)} 2>/dev/null)
for name in container-created container-started; do
  [ -n "\${1:-}" ] && t=$(date -d "$1" +%s.%N 2>/dev/null) &&
    awk -v n="$name" -v t="$t" -v now="$now" -v up="$up" 'BEGIN { printf "%s %.2f\\n", n, up - (now - t) }'
  shift
done
exit 0`;
}

/** Bounds the marks kept: a `--host-docker` Job is root on its host. */
const MAX_MARKS = 64;

/**
 * `<name> <number>` lines as a map, of up to MAX_MARKS names of up to 32
 * characters; a later mark of a name replaces it.
 */
export function parseBootMarks(text: string): Record<string, number> {
  const marks: Record<string, number> = {};
  let count = 0;
  for (const line of text.split('\n')) {
    const match = /^([a-z][a-z-]{0,31}) (\d+(?:\.\d+)?)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!;
    if (!(name in marks)) {
      if (count === MAX_MARKS) continue;
      count++;
    }
    marks[name] = Number(match[2]);
  }
  return marks;
}

/** The host's marks and its container's start; undefined when there are none. */
export async function readBootMarks(
  exec: (command: string, timeoutMs: number) => Promise<{ stdout: string }>,
  container: string,
): Promise<Record<string, number> | undefined> {
  try {
    const { stdout } = await exec(readCommand(container), READ_TIMEOUT_MS);
    const marks = parseBootMarks(stdout);
    return Object.keys(marks).length > 0 ? marks : undefined;
  } catch {
    return undefined;
  }
}

/** The first VM's marks, as the Running event's metadata; none without them. */
export async function bootMarksMetadata(
  vms: Pick<DbVM, 'ip' | 'sshHost' | 'sshPort'>[],
  props: Pick<StoredWorkload, 'id' | 'sshPrivateKey'>,
): Promise<{ metadata: { bootMarks: Record<string, number> } } | undefined> {
  const vm = vms[0];
  if (!vm) return undefined;
  const ssh = createTransport(
    vm.sshHost ?? vm.ip,
    props.sshPrivateKey,
    vm.sshPort,
  );
  const bootMarks = await readBootMarks(
    (command, ms) => ssh.exec(command, 1, false, ms),
    props.id,
  );
  return bootMarks && { metadata: { bootMarks } };
}
