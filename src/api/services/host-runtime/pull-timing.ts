/**
 * Pull timing: wraps a detached image pull in a sampler of the bytes the VM
 * receives, so pull telemetry can say whether the download or the unpack took
 * the time (from experiments/vm-image-pull-attribution).
 */

import { type ImagePullTelemetry } from '../../../shared/image.js';

const PULL_STATS_PATTERN =
  /^AC_PULL_STATS bytes=(\d+) last_byte_ms=(\d+) elapsed_ms=(\d+)\n?/m;

/** Reads `<uptime s> <rx bytes>` samples; the last byte is the first sample at
 * 99.5% of the bytes, as the experiment's summary took it. */
export const PULL_STATS_AWK = `NF == 2 {n++; t[n] = $1; b[n] = $2}
END {
  total = b[n] - b[1]
  if (n < 2 || total < 0) exit
  for (i = 1; b[i] - b[1] < total * 0.995; i++) {}
  printf "AC_PULL_STATS bytes=%.0f last_byte_ms=%.0f elapsed_ms=%.0f\\n", total, (t[i] - t[1]) * 1000, (t[n] - t[1]) * 1000
}`;

/**
 * Wraps a detached pull so it attributes its own time, as
 * experiments/vm-image-pull-attribution did: a sampler records the bytes the
 * VM's NICs receive once a second (not loopback, bridges, or a VF its parent
 * already counts), and an `AC_PULL_STATS` trailer after the pull's output
 * gives the bytes, the time to the last byte (99.5% of them) and the run time.
 * The command's exit code is kept.
 */
export function measuredPullCommand(command: string): string {
  return `ac_rx() {
  for ac_nic in /sys/class/net/*; do
    case \${ac_nic##*/} in lo|docker*|veth*|br-*|virbr*) continue ;; esac
    [ -e "$ac_nic/master" ] || cat "$ac_nic/statistics/rx_bytes"
  done 2>/dev/null | awk '{s += $1} END {printf "%.0f\\n", s}'
}
ac_sample() { printf '%s %s\\n' "$(cut -d' ' -f1 /proc/uptime)" "$(ac_rx)"; }
ac_samples=$(mktemp /tmp/ac-pull-samples.XXXXXX)
ac_sample > "$ac_samples"
while sleep 1; do ac_sample; done >> "$ac_samples" 2>/dev/null &
ac_sampler=$!
(
${command}
)
ac_code=$?
kill "$ac_sampler" 2>/dev/null
wait "$ac_sampler" 2>/dev/null
ac_sample >> "$ac_samples"
awk '${PULL_STATS_AWK}' "$ac_samples"
rm -f "$ac_samples"
exit "$ac_code"`;
}

type PullTiming = Pick<
  ImagePullTelemetry,
  'bytesFetched' | 'timeToLastByteMs' | 'unpackTailMs'
>;

/** The trailer's fields, and the log without it for the user-facing output. */
export function parsePullStats(logTail: string): {
  stats: PullTiming;
  output: string;
} {
  const match = PULL_STATS_PATTERN.exec(logTail);
  if (!match) return { stats: {}, output: logTail };
  const [bytes, lastByteMs, elapsedMs] = match.slice(1).map(Number);
  return {
    stats: {
      bytesFetched: bytes,
      timeToLastByteMs: lastByteMs,
      unpackTailMs: elapsedMs! - lastByteMs!,
    },
    output: logTail.replace(PULL_STATS_PATTERN, ''),
  };
}
