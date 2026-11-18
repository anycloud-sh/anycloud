import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cgroupOomKills } from '../../../src/runner/oom.js';

const events = (oomKill: number) =>
  `low 0\nhigh 0\nmax 9\noom ${String(oomKill)}\noom_kill ${String(oomKill)}\noom_group_kill 0\n`;

/** A replica's `/proc/self/cgroup` and the cgroup v2 mount it sees. */
function replicaRoot(self: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'runner-oom-'));
  mkdirSync(join(root, 'proc/self'), { recursive: true });
  writeFileSync(join(root, 'proc/self/cgroup'), self);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, 'sys/fs/cgroup', path, '..'), { recursive: true });
    writeFileSync(join(root, 'sys/fs/cgroup', path), content);
  }
  return root;
}

const container =
  '/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod6dd37747_6a90_4612_9bc7_b75331a0e25c.slice/cri-containerd-7dd9a6225313208f9d550213d7718da765bca33704a77a4d136b05dab85a9757.scope';

describe("the runner's OOM kill count", () => {
  it.each<{ layout: string; self: string; files: Record<string, string> }>([
    {
      layout: 'a private cgroup namespace (an unprivileged replica)',
      self: '0::/\n',
      files: { 'memory.events': events(1), 'cgroup.procs': '1\n' },
    },
    {
      // The host's root cgroup has no memory.events.
      layout:
        "the host's cgroup namespace (a privileged replica on a pool Node)",
      self: `0::${container}\n`,
      files: {
        'cgroup.controllers': 'cpuset cpu io memory hugetlb pids\n',
        'memory.stat': 'anon 0\n',
        [`${container}/memory.events`]: events(1),
      },
    },
    {
      // A K3s agent in a container: its root counts every Pod on the Node.
      layout:
        "a K3s agent container's namespace (a privileged replica on a local pool Node)",
      self: `0::/kubepods/burstable/pod45efaa56-07e8-4b4c-9f5c-f34ffdd7ae79/1590ebbb6838\n`,
      files: {
        'memory.events': events(5),
        'kubepods/burstable/pod45efaa56-07e8-4b4c-9f5c-f34ffdd7ae79/1590ebbb6838/memory.events':
          events(1),
      },
    },
  ])('reads its own cgroup in $layout', async ({ self, files }) => {
    const log = vi.fn();
    const oomKills = cgroupOomKills(replicaRoot(self, files), log);
    expect(await oomKills()).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs once when the count cannot be read, and reads it as 0', async () => {
    const log = vi.fn();
    const oomKills = cgroupOomKills(
      replicaRoot(`0::${container}\n`, { 'memory.stat': 'anon 0\n' }),
      log,
    );
    expect([await oomKills(), await oomKills()]).toEqual([0, 0]);
    expect(log).toHaveBeenCalledOnce();
  });
});
