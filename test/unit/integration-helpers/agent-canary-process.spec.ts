import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startCanaryProcess } from '../../integration/helpers/agent-canary-process';

async function withCanary(
  run: (
    canary: ReturnType<typeof startCanaryProcess>,
    pid: number,
  ) => Promise<void>,
): Promise<void> {
  const canary = startCanaryProcess(
    process.execPath,
    ['-e', "setInterval(() => {}, 1000); process.stdout.write('ready');"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH } },
  );
  const closed = once(canary.child, 'close');
  try {
    await once(canary.child.stdout, 'data');
    if (canary.child.pid === undefined) throw new Error('Canary has no PID');
    await run(canary, canary.child.pid);
  } finally {
    vi.restoreAllMocks();
    canary.child.kill('SIGKILL');
    await closed;
    canary.child.stdin.destroy();
    canary.child.stdout.destroy();
    canary.child.stderr.destroy();
  }
}

describe('canary process group cleanup', () => {
  it('closes the child after a denied group signal before requiring final group cleanup', async () => {
    await withCanary(async (canary, childPid) => {
      const nativeKill = process.kill.bind(process);
      const groupClosedStates: boolean[] = [];
      let closed = false;
      canary.child.once('close', () => {
        closed = true;
      });
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -childPid) {
          groupClosedStates.push(closed);
          if (groupClosedStates.length === 1) {
            throw Object.assign(new Error('group awaits reaping'), {
              code: 'EPERM',
            });
          }
        }
        return nativeKill(pid, signal);
      });

      await canary.stop(1);

      expect(groupClosedStates).toEqual([false, true]);
      expect(canary.child.signalCode).toBe('SIGKILL');
      expect(() => nativeKill(childPid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    });
  });

  it('retains a persistent group permission failure and closes every pipe', async () => {
    await withCanary(async (canary, childPid) => {
      const nativeKill = process.kill.bind(process);
      const denied = Object.assign(new Error('group cleanup denied'), {
        code: 'EPERM',
      });
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -childPid) throw denied;
        return nativeKill(pid, signal);
      });

      await expect(canary.stop(1)).rejects.toBe(denied);

      expect(canary.child.signalCode).toBe('SIGKILL');
      expect(canary.child.stdin.destroyed).toBe(true);
      expect(canary.child.stdout.destroyed).toBe(true);
      expect(canary.child.stderr.destroyed).toBe(true);
    });
  });

  it('requires group cleanup even after the child has already closed', async () => {
    await withCanary(async (canary, childPid) => {
      const closed = once(canary.child, 'close');
      canary.child.kill('SIGKILL');
      await closed;
      const nativeKill = process.kill.bind(process);
      const denied = Object.assign(
        new Error('remaining group cleanup denied'),
        {
          code: 'EPERM',
        },
      );
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -childPid) throw denied;
        return nativeKill(pid, signal);
      });

      await expect(canary.stop(1)).rejects.toBe(denied);

      expect(canary.child.stdout.destroyed).toBe(true);
    });
  });

  it('does not use the child fallback for unrelated group signal errors', async () => {
    await withCanary(async (canary, childPid) => {
      const nativeKill = process.kill.bind(process);
      const invalid = Object.assign(new Error('invalid group signal'), {
        code: 'EINVAL',
      });
      const childKill = vi.spyOn(canary.child, 'kill');
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -childPid) throw invalid;
        return nativeKill(pid, signal);
      });

      await expect(canary.stop(1)).rejects.toBe(invalid);

      expect(childKill).not.toHaveBeenCalled();
      expect(canary.child.stdin.destroyed).toBe(true);
    });
  });
});
