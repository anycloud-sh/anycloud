import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  delegateCgroup,
  namespaceRootOoms,
} from '../../../src/runner/cgroup.js';

describe('RFC 0049 C32 cgroup delegation', () => {
  it('evacuates as the image user, and through sudo -n only when that user cannot', () => {
    const run = vi.fn((_argv: string[]) => ({ status: 0, stderr: '' }));
    expect(delegateCgroup(0, run)).toBeNull();
    expect(delegateCgroup(1000, run)).toBeNull();
    // Each runs the evacuation once, as the image's user.
    const [asRoot, asUser] = run.mock.calls.map(([argv]) => argv);
    expect(asRoot!.slice(0, 2)).toEqual(['sh', '-c']);
    expect(asUser).toEqual(asRoot);
    run.mockClear();
    run.mockReturnValueOnce({ status: 1, stderr: 'Permission denied' });
    expect(delegateCgroup(1000, run)).toBeNull();
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      asRoot,
      ['sudo', '-n', ...asRoot!],
    ]);
    // Root has nothing to retry with.
    run.mockClear();
    run.mockReturnValueOnce({ status: 1, stderr: 'Permission denied' });
    expect(delegateCgroup(0, run)).toMatch(/Permission denied$/);
    expect(run).toHaveBeenCalledOnce();
  });

  it('moves every process into a leaf, delegates every controller, and opens the delegated entries to the container root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cgroup-'));
    writeFileSync(join(root, 'cgroup.procs'), '1\n7\n');
    writeFileSync(join(root, 'cgroup.controllers'), 'cpu memory pids\n');
    for (const file of ['cgroup.subtree_control', 'cgroup.threads']) {
      writeFileSync(join(root, file), '');
    }
    expect(delegateCgroup(1000, undefined, root)).toBeNull();
    // One write per PID, as a real cgroup takes them.
    expect(
      readFileSync(join(root, 'anycloud-runner/cgroup.procs'), 'utf8'),
    ).toBe('1\n7\n');
    expect(readFileSync(join(root, 'cgroup.subtree_control'), 'utf8')).toBe(
      '+cpu +memory +pids\n',
    );
    expect(statSync(root).mode & 0o777).toBe(0o777);
    for (const file of [
      'cgroup.procs',
      'cgroup.subtree_control',
      'cgroup.threads',
    ]) {
      expect(statSync(join(root, file)).mode & 0o666).toBe(0o666);
    }
  });

  it("says what the image needs when it can't", () => {
    const failure = delegateCgroup(1000, (argv) => ({
      status: 1,
      stderr:
        argv[0] === 'sudo'
          ? 'sudo: a password is required\n'
          : "mkdir: can't create directory: Permission denied\n",
    }));
    expect(failure).toMatch(
      /couldn't delegate its replica's cgroup, as the image's user or through passwordless sudo/,
    );
    expect(failure).toMatch(
      /Permission denied; with sudo -n: sudo: a password is required$/,
    );
  });

  it("counts only the namespace root's own OOMs, not an inner container's", async () => {
    const root = mkdtempSync(join(tmpdir(), 'cgroup-'));
    // `memory.events` is hierarchical: an inner container killed at its own
    // limit counts there, never in the root's local events.
    writeFileSync(join(root, 'memory.events'), 'oom 1\noom_kill 1\n');
    writeFileSync(
      join(root, 'memory.events.local'),
      'low 0\nhigh 0\nmax 3\noom 0\noom_kill 0\n',
    );
    expect(await namespaceRootOoms(root)).toBe(0);
    writeFileSync(join(root, 'memory.events.local'), 'oom 2\noom_kill 0\n');
    expect(await namespaceRootOoms(root)).toBe(2);
  });
});
