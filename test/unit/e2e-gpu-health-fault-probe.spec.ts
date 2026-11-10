import { describe, expect, test } from 'vitest';

import { parseGpuHealth } from '../../src/api/services/host-runtime/gpu-health.js';
import {
  driverPci,
  GPU_HEALTH_FAULT_XID,
  gpuHealthFaultCommand,
  gpuHealthFaultHumanLine,
  gpuHealthFaultLine,
  gpuHealthFaultNeedle,
  gpuHealthFaultScript,
} from '../integration/e2e/internal/probes/gpu-health-fault.js';

describe('gpu-health-fault PCI and line forms (#2332)', () => {
  test('nvidia-smi domain:bus:device.function becomes the driver bus-only form', () => {
    expect(driverPci('00000000:00:1E.0')).toBe('0000:00:1e');
    expect(driverPci('00000000:3B:00.0')).toBe('0000:3b:00');
    // A real domain is kept to its last four hex digits.
    expect(driverPci('0001:00:1e.0')).toBe('0001:00:1e');
  });

  test('an invalid address is rejected rather than silently mangled', () => {
    expect(() => driverPci('not-a-pci-address')).toThrow(
      /not an nvidia-smi PCI address/,
    );
  });

  test('the injected line and its journal needle agree on the driver address and code', () => {
    const pci = '00000000:00:1E.0';
    const line = gpuHealthFaultLine(pci, 79);
    expect(line).toBe(
      '<3>NVRM: Xid (PCI:0000:00:1e): 79, pid=0, name=gpu-health-fault-e2e, GPU has fallen off the bus.',
    );
    const needle = gpuHealthFaultNeedle(pci, 79);
    // journalctl never prints the kmsg syslog priority back.
    expect(line.includes(needle)).toBe(true);
    expect(line.startsWith('<3>')).toBe(true);
    expect(needle.startsWith('<')).toBe(false);
  });

  test('the default code is #2332’s fallen-off-the-bus Xid', () => {
    expect(GPU_HEALTH_FAULT_XID).toBe(79);
    expect(gpuHealthFaultLine('0000:00:1e.0')).toContain(': 79, pid=0');
  });

  test('the script writes to /dev/kmsg, then reads the same boot’s journal back', () => {
    const script = gpuHealthFaultScript('0000:00:1e.0', 79);
    expect(script).toContain('> /dev/kmsg');
    expect(script).toContain('journalctl -k -b --no-pager -o short-iso');
    expect(script).toContain("grep -F 'NVRM: Xid'");
  });

  test('the command uses the same root/sudo -n branch gpu-health.ts reads the journal with', () => {
    const command = gpuHealthFaultCommand('0000:00:1e.0', 79);
    expect(command.startsWith('if [ "$(id -u)" = 0 ]; then sh -c')).toBe(true);
    expect(command).toContain('else sudo -n sh -c');
    expect(command).toContain('fi');
  });
});

describe('the injected line turns the production GPU health parser unhealthy', () => {
  test('parseGpuHealth reads the exact injected journal text as unhealthy with Xid 79 needing a reset', () => {
    const pci = '00000000:00:1E.0';
    const line = gpuHealthFaultLine(pci, 79);
    // The exact shape GPU_HEALTH_COMMAND emits: a healthy nvidia-smi section
    // (one listed GPU, no reset required) plus the journal section, now
    // carrying the injected Xid line as journalctl would print it (no kmsg
    // priority prefix).
    const output = [
      '--anycloud-gpu-smi 0',
      `GPU ${pci}`,
      '    Reset Required             : No',
      '--anycloud-gpu-journal 0',
      line.replace('<3>', '2026-11-10T00:00:00+0000 host kernel: '),
    ].join('\n');
    const health = parseGpuHealth(output);
    expect(health.state).toBe('unhealthy');
    expect(health.gpus).toHaveLength(1);
    const xid = health.gpus[0]!.xids.find((entry) => entry.code === 79);
    expect(xid).toBeDefined();
    expect(xid!.resetNeeded).toBe(true);

    // The human status line names the GPU and the Xid, as #2332 promises.
    const human = gpuHealthFaultHumanLine(health);
    expect(human).toBeDefined();
    expect(human).toContain('GPU 0 needs a reset (Xid 79');
  });
});
