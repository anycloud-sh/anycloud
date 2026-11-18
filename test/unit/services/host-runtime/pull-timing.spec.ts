import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  PULL_STATS_AWK,
  measuredPullCommand,
} from '../../../../src/api/services/host-runtime/pull-timing';

// Real shells and awk: the trailer is computed on the VM, so these run the
// script rather than a mock of it. awk gets the program quoted as the VM's
// script quotes it.
const stats = (input: string) =>
  spawnSync('sh', ['-c', `awk '${PULL_STATS_AWK}'`], {
    input,
  }).stdout.toString();

describe('pull timing trailer', () => {
  it('takes the last byte as the first sample at 99.5% of the bytes', () => {
    // 10,000 bytes from t=100 s; 9,950 of them by t=102 s, then a partial
    // line from a sampler killed mid-write.
    const samples = [
      '100.00 1000',
      '101.00 5000',
      '102.00 10950',
      '103.00 11000',
      '105.50 11000',
      '105.9',
    ].join('\n');
    expect(stats(samples)).toBe(
      'AC_PULL_STATS bytes=10000 last_byte_ms=2000 elapsed_ms=5500\n',
    );
  });

  it('puts the last byte at the start when nothing was fetched', () => {
    expect(stats('10.00 500\n12.25 500\n')).toBe(
      'AC_PULL_STATS bytes=0 last_byte_ms=0 elapsed_ms=2250\n',
    );
  });

  // VM hosts are Linux: the sampler reads /proc/uptime and /sys/class/net.
  it('keeps the pull output and exit code and appends the trailer', () => {
    const result = spawnSync('sh', [
      '-c',
      measuredPullCommand('set -eu\necho pulled\nsleep 0.3\nexit 3'),
    ]);
    const lines = result.stdout.toString().trim().split('\n');
    expect(result.status).toBe(3);
    expect(lines[0]).toBe('pulled');
    const trailer =
      /^AC_PULL_STATS bytes=(\d+) last_byte_ms=(\d+) elapsed_ms=(\d+)$/.exec(
        lines[1] ?? '',
      );
    expect(trailer).not.toBeNull();
    const [, , lastByteMs, elapsedMs] = trailer!.map(Number);
    expect(elapsedMs).toBeGreaterThanOrEqual(290);
    expect(lastByteMs).toBeLessThanOrEqual(elapsedMs!);
  });
});
