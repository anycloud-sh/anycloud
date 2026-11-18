/**
 * A GPU VM's NVIDIA GPU health, as `anycloud status` reports it: whether a
 * GPU says it needs a reset (nvidia-smi's reset status and recovery action),
 * the Xid errors the kernel logged this boot, and whether nvidia-smi answers
 * at all. Report only: nothing here resets, reboots or replaces anything.
 *
 * It can't see a GPU that stalls without an Xid (a silent kernel hang), only
 * the states the driver reports.
 */

import type { GpuHealth } from '../../../shared/api-contract/workload-management-schemas.js';
import { gpuRuntimeForVMType } from '../../../shared/cloud-config.js';
import type { StoredWorkload } from '../workload-record.js';

/**
 * How long a status read waits for nvidia-smi and the journal. With the SSH
 * exec around it (its timeout starts once connected), the read fits
 * status's 5 s budget beside docker inspect, and the CLI's 6 s request
 * timeout with a cold handshake.
 */
export const GPU_HEALTH_TIMEOUT_SECONDS = 2.5;
/**
 * nvidia-smi runs on the host apart from any one status read, under this
 * cutoff; one that hasn't answered after it is hung. Long enough for a
 * healthy 8-GPU host without persistence mode to start its driver.
 */
const GPU_HUNG_SECONDS = 30;
/** How old an nvidia-smi answer status still reports. */
const SMI_FRESH_SECONDS = 120;
/** Unhealthy Xid lines kept from the boot, and other Xid lines, newest last. */
const UNHEALTHY_XID_LINES = 50;
const OTHER_XID_LINES = 20;
/** Xids kept per GPU in the report, newest last. */
const XIDS_PER_GPU = 5;

/**
 * Xids after which NVIDIA's Xid catalog
 * (https://docs.nvidia.com/deploy/xid-errors/) says the GPU needs a reset or
 * a new host. Others, such as 63 (row remap recorded) and 94 (contained ECC),
 * are listed but don't make the GPU unhealthy; a remap waiting for a reset
 * reads as one through nvidia-smi's Remapped Rows.
 */
const UNHEALTHY_XIDS = [48, 64, 74, 79, 95, 109, 119, 120, 154];

/** What nvidia-smi prints for no recovery action, or one it can't report. */
const NO_RECOVERY_ACTION =
  /^(|None|N\/A|\[N\/A\]|Not Supported|Unknown Error)$/i;

const SMI = '--anycloud-gpu-smi';
const JOURNAL = '--anycloud-gpu-journal';
const UNHEALTHY_XID_PATTERN = `NVRM: Xid \\(PCI:[^)]*\\): (${UNHEALTHY_XIDS.join('|')}),`;

const WAIT_TICKS = GPU_HEALTH_TIMEOUT_SECONDS * 10;

/**
 * One SSH command (POSIX sh, GNU coreutils). nvidia-smi runs on the host
 * apart from the read: at most one at a time (a lock), under the hang
 * cutoff, leaving its answer and exit code in a per-user cache. The read
 * starts one when none is running, waits a little for an answer newer than
 * itself, and reports the latest answer if it is fresh, 124 if the running
 * nvidia-smi has gone past the cutoff, or `pending` otherwise. So a slow
 * healthy host is never called hung, a stuck nvidia-smi neither holds the
 * command nor piles up, and concurrent reads share one answer. The journal's
 * Xid lines are read beside it, every unhealthy one kept before benign ones.
 * A non-root SSH user reads the journal through `sudo -n`.
 */
export const GPU_HEALTH_COMMAND = [
  // The user's own cache, which no other user can plant files in.
  'c="${TMPDIR:-/var/tmp}/anycloud-gpu-health-$(id -u)"; mkdir -p -m 700 "$c" && [ ! -L "$c" ] && [ -O "$c" ] || exit 1',
  'd=$(mktemp -d) || exit 1',
  `trap 'rm -rf "$d"' EXIT`,
  "t0=$(date +%s); boot=$(awk '/^btime/ {print $2}' /proc/stat 2>/dev/null); boot=${boot:-0}",
  `f=; command -v flock >/dev/null 2>&1 || { echo '${SMI}' noflock; f=1; }`,
  `[ -n "$f" ] || (flock -n 9 || exit 0; rm -f "$c/started"; date +%s >"$c/started.new" && mv -f "$c/started.new" "$c/started"; timeout -k 5 ${GPU_HUNG_SECONDS} nvidia-smi -q >"$c/out.new" 2>&1; echo $? >"$c/rc.new"; mv -f "$c/out.new" "$c/out"; mv -f "$c/rc.new" "$c/rc"; rm -f "$c/started") 9>"$c/lock" </dev/null >/dev/null 2>&1 &`,
  'if [ "$(id -u)" = 0 ]; then j=journalctl; else j="sudo -n journalctl"; fi',
  `({ timeout ${GPU_HEALTH_TIMEOUT_SECONDS} $j -k -b --no-pager -o short-iso 2>/dev/null; echo $? >"$d/j.rc"; } | grep -F 'NVRM: Xid' >"$d/x"; : >"$d/x.done") </dev/null >/dev/null 2>&1 &`,
  'at() { stat -c %Y "$c/rc" 2>/dev/null || echo 0; }',
  `i=0; while { [ "$(at)" -lt "$t0" ] || [ ! -e "$d/x.done" ]; } && [ $i -lt ${WAIT_TICKS} ]; do if sleep 0.1 2>/dev/null; then i=$((i+1)); else sleep 1; i=$((i+10)); fi; done`,
  'now=$(date +%s); since=$(cat "$c/started" 2>/dev/null); case $since in ""|*[!0-9]*) since=$now;; esac',
  'rc=$(cat "$c/rc" 2>/dev/null)',
  // Hung: the running nvidia-smi has passed the cutoff, or this boot's
  // latest answer was the cutoff itself, with none newer since.
  `if [ -n "$f" ]; then :`,
  `elif [ $((now - since)) -ge ${GPU_HUNG_SECONDS} ] || { { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && [ "$(at)" -ge "$boot" ]; }; then echo '${SMI}' 124`,
  `elif [ "$(at)" -ge $((now - ${SMI_FRESH_SECONDS})) ] && [ "$(at)" -ge "$boot" ] && [ -n "$rc" ]; then echo '${SMI}' "$rc"; cat "$c/out" 2>/dev/null`,
  `else echo '${SMI}' pending; fi`,
  `echo '${JOURNAL}' "$([ -e "$d/x.done" ] && cat "$d/j.rc" 2>/dev/null || echo 124)"`,
  `{ grep -nE '${UNHEALTHY_XID_PATTERN}' "$d/x" | tail -n ${UNHEALTHY_XID_LINES}; grep -nvE '${UNHEALTHY_XID_PATTERN}' "$d/x" | tail -n ${OTHER_XID_LINES}; } 2>/dev/null | sort -n | cut -d: -f2-`,
].join('\n');

/**
 * Whether the workload's VMs have an NVIDIA GPU, whose health status reads:
 * every VM type it may run on is a CUDA type.
 */
export function hasNvidiaGpu(
  workload: Pick<StoredWorkload, 'cloudProvider' | 'vmType'>,
): boolean {
  const { cloudProvider, vmType } = workload;
  const types = Array.isArray(vmType) ? vmType : vmType ? [vmType] : [];
  return (
    cloudProvider !== null &&
    types.length > 0 &&
    types.every((type) => gpuRuntimeForVMType(cloudProvider, type) === 'cuda')
  );
}

/** `00000001:00:1E.0` or `0001:00:1e` as `1:0:30`: domain, bus and device. */
function pciKey(address: string): string {
  const [domain, bus, device] = address.split(':');
  return [domain, bus, device!.split('.')[0]]
    .map((part) => parseInt(part!, 16))
    .join(':');
}

interface SmiGpu {
  pci: string;
  resetRequired: boolean;
  recoveryAction: string | null;
}

function parseSmi(text: string): SmiGpu[] {
  const gpus: SmiGpu[] = [];
  let group = '';
  for (const line of text.split('\n')) {
    const header = /^GPU ([0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+\.\d)\s*$/.exec(
      line.trim(),
    );
    if (header) {
      gpus.push({
        pci: header[1]!,
        resetRequired: false,
        recoveryAction: null,
      });
      group = '';
      continue;
    }
    const gpu = gpus.at(-1);
    if (!gpu) continue;
    const field = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!field) {
      group = line.trim();
      continue;
    }
    const [, key, value] = field;
    const yes = value === 'Yes';
    if (key === 'Reset Required' || key === 'Drain and Reset Recommended') {
      gpu.resetRequired ||= yes;
    }
    // A row remap waiting for the next reset.
    if (group === 'Remapped Rows' && key === 'Pending') {
      gpu.resetRequired ||= yes;
    }
    if (key === 'GPU Recovery Action' && !NO_RECOVERY_ACTION.test(value!)) {
      gpu.recoveryAction = value!;
    }
  }
  return gpus;
}

interface Xid {
  pci: string;
  code: number;
  at: string | null;
  message: string;
}

function parseXids(text: string): Xid[] {
  return text.split('\n').flatMap((line) => {
    const match =
      /^(\S+)?.*NVRM: Xid \(PCI:([0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+)\): (\d+), ?(.*)$/.exec(
        line,
      );
    if (!match) return [];
    const at =
      match[1] && !Number.isNaN(Date.parse(match[1])) ? match[1] : null;
    return [
      {
        pci: match[2]!,
        code: Number(match[3]),
        at: at ? new Date(at).toISOString() : null,
        message: match[4]!.trim().slice(0, 200),
      },
    ];
  });
}

/** The section's text after its marker line, and the exit code on that line. */
function section(
  output: string,
  marker: string,
  next: string | null,
): { code: number | null; text: string } | null {
  const start = output.indexOf(`${marker} `);
  if (start === -1) return null;
  const lineEnd = output.indexOf('\n', start);
  const raw = output
    .slice(start + marker.length + 1, lineEnd === -1 ? undefined : lineEnd)
    .trim();
  const code = raw === '' ? Number.NaN : Number(raw);
  const end = next ? output.indexOf(`${next} `, start) : -1;
  return {
    code: Number.isInteger(code) ? code : null,
    text:
      lineEnd === -1
        ? ''
        : output.slice(lineEnd + 1, end === -1 ? undefined : end),
  };
}

const unhealthyXid = (code: number) => UNHEALTHY_XIDS.includes(code);
/** Xid 154 logs a recovery action changing back to none, too. */
const RECOVERED = /to 0x0 \(None\)/i;

/** The latest Xids that need a reset and the latest others, in order. */
function latestXids(xids: Xid[]): Xid[] {
  const keep = new Set([
    ...xids.filter((xid) => unhealthyXid(xid.code)).slice(-XIDS_PER_GPU),
    ...xids.filter((xid) => !unhealthyXid(xid.code)).slice(-XIDS_PER_GPU),
  ]);
  return xids.filter((xid) => keep.has(xid));
}

/**
 * `GPU_HEALTH_COMMAND`'s output as the status report. The journal counts
 * even when nvidia-smi fails or hangs, as it does once a GPU falls off the
 * bus; a GPU nvidia-smi no longer lists is reported by its PCI address.
 */
export function parseGpuHealth(output: string): GpuHealth {
  const smi = section(output, SMI, JOURNAL);
  const journal = section(output, JOURNAL, null);
  if (!smi || !journal) {
    return {
      state: 'unknown',
      gpus: [],
      detail: 'the GPU read returned nothing',
    };
  }
  // Whatever either half read counts; their exit codes only decide
  // between unknown and healthy.
  const listed = parseSmi(smi.text);
  const xids = parseXids(journal.text);
  const unlisted = [
    ...new Set(
      xids
        .map((xid) => xid.pci)
        .filter((pci) => !listed.some((gpu) => pciKey(gpu.pci) === pciKey(pci)))
        .map((pci) => pci.toLowerCase()),
    ),
  ];
  const gpus = [
    ...listed.map((gpu, index) => ({ ...gpu, index })),
    ...unlisted.map((pci) => ({
      pci,
      index: null,
      resetRequired: false,
      recoveryAction: null,
    })),
  ].map(({ pci, index, resetRequired, recoveryAction }) => ({
    index,
    pci: pci.toLowerCase(),
    resetRequired,
    recoveryAction,
    xids: latestXids(xids.filter((xid) => pciKey(xid.pci) === pciKey(pci))).map(
      ({ code, at, message }) => ({
        code,
        at,
        message,
        resetNeeded: unhealthyXid(code) && !RECOVERED.test(message),
      }),
    ),
  }));
  // `timeout` exits 124, or 137 when it had to kill a stuck nvidia-smi.
  const hung = smi.code === 124 || smi.code === 137;
  const pending = smi.code === null;
  const faulty = gpus.some(
    (gpu) =>
      gpu.resetRequired ||
      gpu.recoveryAction !== null ||
      gpu.xids.some((xid) => xid.resetNeeded),
  );
  if (hung || faulty) {
    return {
      state: 'unhealthy',
      gpus,
      ...(hung && {
        detail: `nvidia-smi did not answer within ${GPU_HUNG_SECONDS} s`,
      }),
    };
  }
  if (output.includes(`${SMI} noflock`)) {
    return {
      state: 'unknown',
      gpus,
      detail: 'flock is not installed on the host, so nvidia-smi is not run',
    };
  }
  if (pending) {
    return {
      state: 'unknown',
      gpus,
      detail: 'nvidia-smi has not answered yet',
    };
  }
  if (smi.code !== 0) {
    const last = smi.text.trim().split('\n').at(-1)?.slice(0, 200);
    return {
      state: 'unknown',
      gpus,
      detail: `nvidia-smi failed: ${last || `exit ${smi.code}`}`,
    };
  }
  if (listed.length === 0) {
    return {
      state: 'unknown',
      gpus,
      detail: 'nvidia-smi listed no GPU',
    };
  }
  if (journal.code !== 0) {
    return {
      state: 'unknown',
      gpus,
      detail:
        journal.code === 124
          ? `the kernel journal did not answer within ${GPU_HEALTH_TIMEOUT_SECONDS} s`
          : 'could not read the kernel journal for Xid errors',
    };
  }
  return { state: 'healthy', gpus };
}
