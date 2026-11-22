import { execFile } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GPU_HEALTH_COMMAND,
  hasNvidiaGpu,
  parseGpuHealth,
} from '../../../../src/api/services/host-runtime/gpu-health.js';
import { CloudType } from '../../../../src/shared/cloud.js';

/** `nvidia-smi -q`'s per-GPU sections, trimmed to the fields read. */
function smi(
  gpus: Array<{
    bus: string;
    reset?: 'Yes' | 'No';
    drain?: 'Yes' | 'No';
    recovery?: string;
  }>,
): string {
  return [
    '==============NVSMI LOG==============',
    '',
    'Driver Version                            : 570.172.08',
    `Attached GPUs                             : ${gpus.length}`,
    ...gpus.flatMap((gpu) => [
      `GPU ${gpu.bus}`,
      '    Product Name                          : NVIDIA H100 80GB HBM3',
      '    GPU Reset Status',
      `        Reset Required                    : ${gpu.reset ?? 'No'}`,
      `        Drain and Reset Recommended       : ${gpu.drain ?? 'No'}`,
      `    GPU Recovery Action                   : ${gpu.recovery ?? 'None'}`,
    ]),
  ].join('\n');
}

const xid = (at: string, pci: string, code: number, rest: string) =>
  `${at} gpu-host kernel: NVRM: Xid (PCI:${pci}): ${code}, ${rest}`;

/** The command's output, as the host prints it. */
const output = (
  smiCode: number,
  smiText: string,
  journalCode: number,
  xids: string[] = [],
) =>
  [
    `--anycloud-gpu-smi ${smiCode}`,
    smiText,
    `--anycloud-gpu-journal ${journalCode}`,
    ...xids,
    '',
  ].join('\n');

const TWO = smi([{ bus: '00000000:18:00.0' }, { bus: '00000000:2A:00.0' }]);

/** The host's boot time, in Unix seconds. */
const bootSeconds = () =>
  Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))![1]);

describe('GPU health from nvidia-smi and the kernel journal', () => {
  it('reports healthy GPUs, listing an Xid that needs no reset', () => {
    expect(
      parseGpuHealth(
        output(0, TWO, 0, [
          xid(
            '2026-11-08T01:02:03+0000',
            '0000:18:00',
            31,
            'pid=4242, name=python, Ch 00000008, intr 00000000. MMU Fault',
          ),
        ]),
      ),
    ).toEqual({
      state: 'healthy',
      gpus: [
        {
          index: 0,
          pci: '00000000:18:00.0',
          resetRequired: false,
          recoveryAction: null,
          xids: [
            {
              code: 31,
              at: '2026-11-08T01:02:03.000Z',
              message:
                'pid=4242, name=python, Ch 00000008, intr 00000000. MMU Fault',
              resetNeeded: false,
            },
          ],
        },
        {
          index: 1,
          pci: '00000000:2a:00.0',
          resetRequired: false,
          recoveryAction: null,
          xids: [],
        },
      ],
    });
  });

  it('reports a GPU that needs a reset, a recovery action, or a pending row remap', () => {
    for (const [fields, recovery] of [
      [{ reset: 'Yes' as const }, null],
      [{ drain: 'Yes' as const }, null],
      [{ recovery: 'Reset' }, 'Reset'],
      [{ recovery: 'Reboot' }, 'Reboot'],
      [{ recovery: 'Bus Reset' }, 'Bus Reset'],
      [{ recovery: 'System Reboot' }, 'System Reboot'],
      [{ recovery: 'Drain and Reset' }, 'Drain and Reset'],
    ] as const) {
      const health = parseGpuHealth(
        output(0, smi([{ bus: '00000000:18:00.0', ...fields }]), 0),
      );
      expect(health.state).toBe('unhealthy');
      expect(health.gpus[0]).toMatchObject({ recoveryAction: recovery });
    }
    const remap = `${smi([{ bus: '00000000:18:00.0' }])}\n    Remapped Rows\n        Pending                           : Yes`;
    expect(parseGpuHealth(output(0, remap, 0))).toMatchObject({
      state: 'unhealthy',
      gpus: [{ resetRequired: true }],
    });
  });

  it('reads a recovery action nvidia-smi cannot report (N/A) as none', () => {
    for (const recovery of ['N/A', '[N/A]', 'Not Supported', 'Unknown Error']) {
      expect(
        parseGpuHealth(
          output(0, smi([{ bus: '00000000:18:00.0', recovery }]), 0),
        ),
      ).toMatchObject({ state: 'healthy', gpus: [{ recoveryAction: null }] });
    }
  });

  it.each([48, 64, 74, 79, 95, 109, 119, 120, 154])(
    'reports Xid %i as unhealthy on the GPU at its PCI address',
    (code) => {
      const health = parseGpuHealth(
        output(0, TWO, 0, [
          xid('2026-11-08T01:02:03+0000', '0000:2a:00', code, 'pid=1, name=x'),
        ]),
      );
      expect(health.state).toBe('unhealthy');
      expect(health.gpus[0]!.xids).toEqual([]);
      expect(health.gpus[1]!.xids).toMatchObject([{ code, resetNeeded: true }]);
    },
  );

  it.each([63, 94, 13, 31])(
    'lists Xid %i without making the GPU unhealthy',
    (code) => {
      const health = parseGpuHealth(
        output(0, TWO, 0, [
          xid('2026-11-08T01:02:03+0000', '0000:18:00', code, 'pid=1'),
        ]),
      );
      expect(health.state).toBe('healthy');
      expect(health.gpus[0]!.xids).toMatchObject([
        { code, resetNeeded: false },
      ]);
    },
  );

  it('reads Xid 154 changing back to no action as no reset needed', () => {
    const health = parseGpuHealth(
      output(0, TWO, 0, [
        xid(
          '2026-11-08T01:02:03+0000',
          '0000:18:00',
          154,
          'GPU recovery action changed from 0x1 (GPU Reset Required) to 0x0 (None)',
        ),
      ]),
    );
    expect(health.state).toBe('healthy');
    expect(health.gpus[0]!.xids[0]!.resetNeeded).toBe(false);
  });

  it('keeps what a half read before it was cut off, and calls an empty GPU list unknown', () => {
    // The journal was cut off, but had already shown a lost GPU.
    expect(
      parseGpuHealth(
        output(0, TWO, 124, [
          xid('2026-11-08T01:02:03+0000', '0000:2a:00', 79, 'pid=1, lost'),
        ]),
      ).state,
    ).toBe('unhealthy');
    expect(
      parseGpuHealth(output(0, 'NVSMI LOG, but no GPUs', 0)),
    ).toMatchObject({
      state: 'unknown',
      detail: 'nvidia-smi listed no GPU',
    });
  });

  it('tells apart GPUs that differ only in PCI domain, as on Azure', () => {
    const azure = smi([
      { bus: '00000001:00:00.0' },
      { bus: '00000002:00:00.0' },
      { bus: '00000003:00:00.0' },
    ]);
    const { gpus } = parseGpuHealth(
      output(0, azure, 0, [
        xid('2026-11-08T01:02:03+0000', '0002:00:00', 79, 'pid=1, lost'),
      ]),
    );
    expect(gpus.map((gpu) => gpu.xids.length)).toEqual([0, 1, 0]);
  });

  it('counts the journal when nvidia-smi fails or no longer lists a GPU that fell off the bus', () => {
    const lost = xid(
      '2026-11-08T01:02:03+0000',
      '0000:2a:00',
      79,
      'pid=1, GPU has fallen off the bus.',
    );
    expect(
      parseGpuHealth(
        output(
          15,
          'Unable to determine the device handle for GPU0000:2A:00.0: Unknown Error',
          0,
          [lost],
        ),
      ),
    ).toMatchObject({
      state: 'unhealthy',
      gpus: [{ index: null, pci: '0000:2a:00', xids: [{ code: 79 }] }],
    });
    // nvidia-smi answers but lists only the GPU that is left.
    expect(
      parseGpuHealth(output(0, smi([{ bus: '00000000:18:00.0' }]), 0, [lost])),
    ).toMatchObject({
      state: 'unhealthy',
      gpus: [{ index: 0 }, { index: null, pci: '0000:2a:00' }],
    });
  });

  it('keeps the latest five Xids per GPU from the whole boot', () => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      xid(`2026-11-0${i + 1}T00:00:00+0000`, '0000:18:00', 13, `n=${i}`),
    );
    const { gpus } = parseGpuHealth(output(0, TWO, 0, lines));
    expect(gpus[0]!.xids.map((entry) => entry.message)).toEqual([
      'n=3',
      'n=4',
      'n=5',
      'n=6',
      'n=7',
    ]);
  });

  it('reports a hung nvidia-smi as unhealthy, and a pending or failed one, no flock, or an unreadable journal as unknown', () => {
    expect(
      parseGpuHealth(
        ['--anycloud-gpu-smi noflock', '--anycloud-gpu-journal 0', ''].join(
          '\n',
        ),
      ),
    ).toMatchObject({
      state: 'unknown',
      detail: expect.stringContaining('flock is not installed'),
    });
    // Its journal still counts.
    expect(
      parseGpuHealth(
        [
          '--anycloud-gpu-smi noflock',
          '--anycloud-gpu-journal 0',
          xid('2026-11-08T01:02:03+0000', '0000:2a:00', 79, 'pid=1, lost'),
          '',
        ].join('\n'),
      ).state,
    ).toBe('unhealthy');
    expect(
      parseGpuHealth(
        ['--anycloud-gpu-smi pending', '--anycloud-gpu-journal 0', ''].join(
          '\n',
        ),
      ),
    ).toMatchObject({
      state: 'unknown',
      detail: 'nvidia-smi has not answered yet',
    });
    expect(parseGpuHealth(output(124, '', 0))).toEqual({
      state: 'unhealthy',
      gpus: [],
      detail: 'nvidia-smi did not answer within 30 s',
    });
    expect(
      parseGpuHealth(
        output(
          9,
          "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
          0,
        ),
      ),
    ).toMatchObject({
      state: 'unknown',
      detail: expect.stringContaining("couldn't communicate"),
    });
    // Never healthy without the journal; a reset it reports still counts.
    expect(parseGpuHealth(output(0, TWO, 1))).toMatchObject({
      state: 'unknown',
      detail: 'could not read the kernel journal for Xid errors',
    });
    expect(parseGpuHealth(output(0, TWO, 124))).toMatchObject({
      state: 'unknown',
      detail: 'the kernel journal did not answer within 2.5 s',
    });
    expect(
      parseGpuHealth(
        output(0, smi([{ bus: '00000000:18:00.0', reset: 'Yes' }]), 1),
      ).state,
    ).toBe('unhealthy');
    expect(parseGpuHealth('')).toMatchObject({ state: 'unknown' });
  });

  it('reads only workloads whose every VM type is an NVIDIA type', () => {
    const gpu = { cloudProvider: CloudType.AWS, vmType: 'g4dn.xlarge' };
    expect(hasNvidiaGpu(gpu)).toBe(true);
    expect(hasNvidiaGpu({ ...gpu, vmType: ['g4dn.xlarge', 't3.medium'] })).toBe(
      false,
    );
    expect(hasNvidiaGpu({ ...gpu, vmType: 't3.medium' })).toBe(false);
    expect(hasNvidiaGpu({ ...gpu, vmType: null })).toBe(false);
  });
});

describe('the GPU health command on a host', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A host with fake nvidia-smi, journalctl and sudo on PATH. */
  function host(
    smiScript: string,
    journalScript = 'true',
    sleepScript?: string,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'gpu-health-'));
    dirs.push(dir);
    const tool = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    tool('nvidia-smi', smiScript);
    tool('journalctl', journalScript);
    // A non-root user reads the journal through sudo -n.
    tool('sudo', '[ "$1" = -n ] && shift; exec "$@"');
    if (sleepScript) tool('sleep', sleepScript);
    const env = { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: dir };
    const cache = join(dir, `anycloud-gpu-health-${process.getuid!()}`);
    return {
      dir,
      cache,
      env,
      async read() {
        const started = Date.now();
        const { stdout } = await promisify(execFile)(
          'sh',
          ['-c', GPU_HEALTH_COMMAND],
          { env },
        );
        return { health: parseGpuHealth(stdout), ms: Date.now() - started };
      },
    };
  }
  const healthySmi = `cat <<'EOF'\n${smi([{ bus: '00000000:18:00.0' }])}\nEOF`;

  it('reads both halves and parses them', async () => {
    const { health } = await host(
      healthySmi,
      `echo '2026-11-08T01:02:03+0000 h kernel: NVRM: Xid (PCI:0000:18:00): 79, pid=1, GPU has fallen off the bus.'`,
    ).read();
    expect(health).toMatchObject({
      state: 'unhealthy',
      gpus: [{ index: 0, xids: [{ code: 79 }] }],
    });
  });

  it('returns in about 3 s while nvidia-smi is slow, and calls it unknown, not hung, until the hang cutoff', async () => {
    // Stuck and deaf to SIGTERM, beside a journal that hangs too.
    const gpu = host("trap '' TERM; while :; do sleep 1; done", 'sleep 20');
    const { health, ms } = await gpu.read();
    expect(health).toMatchObject({
      state: 'unknown',
      detail: 'nvidia-smi has not answered yet',
    });
    expect(ms).toBeLessThan(4_000);
    // The same nvidia-smi, 31 s on: hung, at once, without starting another.
    writeFileSync(
      join(gpu.cache, 'started'),
      `${Math.floor(Date.now() / 1_000) - 31}\n`,
    );
    const later = await gpu.read();
    expect(later.health).toMatchObject({
      state: 'unhealthy',
      detail: 'nvidia-smi did not answer within 30 s',
    });
  }, 20_000);

  it('never calls an empty or half-written started file hung', async () => {
    const gpu = host('/bin/sleep 5');
    mkdirSync(gpu.cache, { recursive: true, mode: 0o700 });
    writeFileSync(join(gpu.cache, 'started'), '');
    // A run that is still going, holding the lock.
    await promisify(execFile)('sh', [
      '-c',
      `flock "${gpu.cache}/lock" /bin/sleep 5 >/dev/null 2>&1 & /bin/sleep 0.3`,
    ]);
    const { health } = await gpu.read();
    expect(health).toMatchObject({ state: 'unknown' });
  }, 15_000);

  it("keeps reporting this boot's hang until nvidia-smi answers again, and ignores an answer from before the boot", async () => {
    const gpu = host("trap '' TERM; while :; do /bin/sleep 1; done");
    mkdirSync(gpu.cache, { recursive: true, mode: 0o700 });
    writeFileSync(join(gpu.cache, 'out'), '');
    writeFileSync(join(gpu.cache, 'rc'), '124\n');
    // The hang was cut off this boot, five minutes ago on a host up that long.
    const cutOff = new Date(
      Math.max(bootSeconds(), Math.floor(Date.now() / 1_000) - 300) * 1_000,
    );
    utimesSync(join(gpu.cache, 'rc'), cutOff, cutOff);
    expect((await gpu.read()).health).toMatchObject({
      state: 'unhealthy',
      detail: 'nvidia-smi did not answer within 30 s',
    });

    // A healthy answer from before this boot says nothing about it.
    const before = host("trap '' TERM; while :; do /bin/sleep 1; done");
    mkdirSync(before.cache, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(before.cache, 'out'),
      smi([{ bus: '00000000:18:00.0' }]),
    );
    writeFileSync(join(before.cache, 'rc'), '0\n');
    const boot = new Date((bootSeconds() - 10) * 1_000);
    utimesSync(join(before.cache, 'rc'), boot, boot);
    expect((await before.read()).health).toMatchObject({
      state: 'unknown',
      detail: 'nvidia-smi has not answered yet',
    });
  }, 20_000);

  it('shares one nvidia-smi between reads at the same time, each reporting its answer', async () => {
    const gpu = host(`echo run >>"$TMPDIR/runs"; sleep 1; ${healthySmi}`);
    const [first, second] = await Promise.all([gpu.read(), gpu.read()]);
    expect(first.health.state).toBe('healthy');
    expect(second.health.state).toBe('healthy');
    expect(
      readFileSync(join(gpu.dir, 'runs'), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
  }, 15_000);

  it('still waits for nvidia-smi where sleep takes whole seconds only', async () => {
    const { health } = await host(
      `/bin/sleep 1; ${healthySmi}`,
      'true',
      // A sleep that rejects fractions.
      'case "$1" in *.*) exit 1;; esac; exec /bin/sleep "$1"',
    ).read();
    expect(health.state).toBe('healthy');
  }, 15_000);

  it('keeps every unhealthy Xid when benign ones flood the journal', async () => {
    const benign = Array.from(
      { length: 200 },
      (_, i) =>
        `echo '2026-11-08T02:00:00+0000 h kernel: NVRM: Xid (PCI:0000:18:00): 13, n=${i}'`,
    ).join('; ');
    const { health } = await host(
      healthySmi,
      `echo '2026-11-08T01:00:00+0000 h kernel: NVRM: Xid (PCI:0000:18:00): 119, pid=1, Timeout'; ${benign}`,
    ).read();
    expect(health.state).toBe('unhealthy');
    expect(health.gpus[0]!.xids.some((entry) => entry.code === 119)).toBe(true);
  });
});
