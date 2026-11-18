import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The `oom_kill` count of the runner's own cgroup, under `root` (`/` in a
 * replica). Its path is the `0::` line of `/proc/self/cgroup`: `/` in a
 * private cgroup namespace, but the container's full path in a privileged
 * replica, which containerd leaves in the host's, whose root has no
 * `memory.events`. A count that can't be read is logged once and
 * reads as 0.
 */
export function cgroupOomKills(
  root: string,
  log: (message: string) => void,
): () => Promise<number> {
  let logged = false;
  return async () => {
    try {
      const self = await readFile(join(root, 'proc/self/cgroup'), 'utf8');
      const path = /^0::(\/.*)$/m.exec(self)?.[1];
      if (path === undefined)
        throw new Error(`no cgroup v2 entry in ${JSON.stringify(self)}`);
      const events = join(root, 'sys/fs/cgroup', path, 'memory.events');
      const counts = await readFile(events, 'utf8');
      return Number(/^oom_kill (\d+)$/m.exec(counts)?.[1] ?? 0);
    } catch (error) {
      if (!logged) log(`OOM kills can't be counted: ${String(error)}`);
      logged = true;
      return 0;
    }
  };
}
