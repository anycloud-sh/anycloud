import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { USER_NAMESPACE_BASE_SPEC } from '../../src/api/services/kubernetes/user-namespace.js';
import {
  baseSpecDrift,
  userNamespaceProbe,
} from '../integration/e2e/internal/contracts/user-namespace-probe.js';
import { shellValues } from '../integration/e2e/internal/contracts/pool-checks.js';

/** K3s's containerd default spec as the constant was captured from it. */
const nodeDefault = () => {
  const spec = structuredClone(USER_NAMESPACE_BASE_SPEC) as unknown as {
    process: Record<string, unknown>;
    mounts: { destination: string; options?: string[] }[];
  };
  spec.process.rlimits = [{ type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 }];
  spec.mounts = spec.mounts.map((mount) =>
    mount.destination === '/sys'
      ? { ...mount, type: 'sysfs', source: 'sysfs', options: ['nosuid', 'ro'] }
      : mount,
  );
  return spec;
};

describe('C32 user-namespace check probes', () => {
  test('the drift check ignores only /sys and process.rlimits', () => {
    expect(baseSpecDrift(nodeDefault(), USER_NAMESPACE_BASE_SPEC)).toBeNull();
    const drifted = nodeDefault();
    drifted.mounts = drifted.mounts.filter((m) => m.destination !== '/run');
    expect(baseSpecDrift(drifted, USER_NAMESPACE_BASE_SPEC)).not.toBeNull();
  });

  test('the probe is valid POSIX sh', () => {
    const [, , script] = userNamespaceProbe('oom', 'k3s@sha256:0', 'marker');
    expect(() => execFileSync('sh', ['-n', '-c', script!])).not.toThrow();
  });

  test('reduces a /sys submount path to a key shellValues reads', () => {
    const key = execFileSync(
      'sh',
      ['-c', `echo /sys/fs/fuse/a-b.c | tr -c 'A-Za-z0-9_\\n' _`],
      { encoding: 'utf8' },
    ).trim();
    expect(shellValues(`SUBMOUNT_WRITE${key}=denied`)).toEqual({
      SUBMOUNT_WRITE_sys_fs_fuse_a_b_c: 'denied',
    });
    // The probe applies exactly this mapping.
    const [, , script] = userNamespaceProbe('oom', 'k3s@sha256:0', 'm');
    expect(script).toContain(`tr -c 'A-Za-z0-9_\\n' _`);
  });

  test('reads keys with digits, as CGROUP2 and NESTED_K3S are', () => {
    expect(
      shellValues(
        'CGROUP2=rw,nsdelegate\nNESTED_K3S=nested-ok\nSUBMOUNT_WRITE_sys_fs_bpf=denied\n2BAD=x',
      ),
    ).toEqual({
      CGROUP2: 'rw,nsdelegate',
      NESTED_K3S: 'nested-ok',
      SUBMOUNT_WRITE_sys_fs_bpf: 'denied',
    });
  });
});
