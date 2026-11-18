import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  RESOURCE_DISK_PROBE,
  resourceDiskStoreInstallCommand,
  resourceDiskStoreMount,
  resourceDiskStoreUnit,
} from '../../../src/api/services/resource-disk-store';
import { initializeAllVMs } from '../../../src/api/services/host-runtime/host-startup';
import type { VmTransport } from '../../../src/api/services/gateways/transport-contract';
import { GpuRuntime } from '../../../src/shared/cloud';
import { WorkloadType } from '../../../src/shared/workload';
import { makeMockVM, makeStoredWorkload } from '../helpers/fixtures';
import { makeVmTransport } from '../helpers/vm-transport';

const transport = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../../../src/api/services/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: () => transport.current,
}));

const sh = (script: string) =>
  spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });

describe('resourceDiskStoreMount', () => {
  it('uses a mounted resource disk at least as large as the root filesystem', () => {
    // NC4as_T4_v3: a 180 GB resource disk beside the 100 GB OS disk.
    expect(resourceDiskStoreMount('/mnt 184443844 101430960\n')).toBe('/mnt');
  });

  it('keeps the stores on the OS disk otherwise', () => {
    expect(resourceDiskStoreMount('')).toBeNull();
    expect(resourceDiskStoreMount('/mnt unknown 101430960\n')).toBeNull();
    expect(resourceDiskStoreMount('/mnt 76794788 520300000\n')).toBeNull();
    expect(resourceDiskStoreMount('/ 184443844 101430960\n')).toBeNull();
  });

  it('finds no resource disk on a host without Azure disk links', () => {
    const probe = sh(RESOURCE_DISK_PROBE);
    expect(probe.status, probe.stderr).toBe(0);
    expect(resourceDiskStoreMount(probe.stdout)).toBeNull();
  });
});

describe('resource disk store unit', () => {
  it('generates valid POSIX shell', () => {
    const execStart = resourceDiskStoreUnit('/mnt')
      .split('\n')
      .find((line) => line.startsWith('ExecStart='))!
      .slice('ExecStart='.length);
    for (const script of [
      RESOURCE_DISK_PROBE,
      resourceDiskStoreInstallCommand('/mnt'),
      execStart,
    ]) {
      const result = spawnSync('/bin/sh', ['-n'], {
        input: script,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('binds both stores before either daemon starts on every boot', () => {
    const unit = resourceDiskStoreUnit('/mnt');
    expect(unit).toContain('Before=containerd.service docker.service');
    // A fresh disk's warning must land before the binds share its device.
    expect(unit).toContain('After=ephemeral-disk-warning.service');
    expect(unit).toContain('RequiresMountsFor=/mnt');
    expect(unit).toContain('WantedBy=multi-user.target');
    for (const store of ['docker', 'containerd']) {
      expect(unit).toContain(`install -d -m 0711 /mnt/anycloud/${store}`);
      expect(unit).toContain(
        `mount --bind /mnt/anycloud/${store} /var/lib/${store}`,
      );
    }
  });
});

describe('initializeAllVMs on an Azure type with a resource disk', () => {
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

  async function initialize(
    preinstalled: boolean,
    probe: string,
    workloadType = WorkloadType.Job,
  ) {
    const commands: string[] = [];
    let started = false;
    const ssh = makeVmTransport({
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === 'docker --version' && !preinstalled) {
          throw new Error('not installed');
        }
        if (command === 'ps -p 1 -o comm= 2>/dev/null') return ok('systemd\n');
        if (command === 'systemctl start docker') started = true;
        if (command === 'systemctl is-active --quiet docker' && !started) {
          throw new Error('inactive');
        }
        if (command === RESOURCE_DISK_PROBE) return ok(probe);
        return ok();
      }),
      ping: vi.fn(async () => true),
    });
    transport.current = ssh satisfies VmTransport;
    await initializeAllVMs(
      [makeMockVM({ ip: 'ip' })],
      makeStoredWorkload({ sshPrivateKey: 'key', workloadType }),
      GpuRuntime.Rocm,
      false,
    );
    return commands;
  }

  it.each([
    ['preinstalled', true, 'systemctl start docker'],
    [
      'static',
      false,
      'systemctl daemon-reload && systemctl enable docker && systemctl start docker',
    ],
  ])('binds the stores before a %s Docker starts', async (_, pre, start) => {
    const commands = await initialize(pre, '/mnt 184443844 101430960\n');
    const install = commands.indexOf(resourceDiskStoreInstallCommand('/mnt'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(commands.indexOf(start));
  });

  it('leaves the stores alone without a usable resource disk', async () => {
    const commands = await initialize(true, '');
    expect(commands).toContain(RESOURCE_DISK_PROBE);
    expect(commands.some((c) => c.includes('anycloud-image-store'))).toBe(
      false,
    );
  });

  // Nothing restores a Service's or a VM's container on a fresh disk.
  it.each([WorkloadType.Service, WorkloadType.Vm])(
    'keeps a %s store on the OS disk',
    async (workloadType) => {
      const commands = await initialize(
        true,
        '/mnt 184443844 101430960\n',
        workloadType,
      );
      expect(commands).not.toContain(RESOURCE_DISK_PROBE);
    },
  );
});
