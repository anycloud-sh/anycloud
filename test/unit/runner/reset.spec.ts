import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { empty, mirror, replicaReset } from '../../../src/runner/reset.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'runner-reset-'));

/** Every entry under `root`: its type and mode, and its content or target. */
function tree(root: string, dir = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(join(root, dir)).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(join(root, path));
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) {
      entries[path] = `link ${readlinkSync(join(root, path))}`;
    } else if (stat.isDirectory()) {
      entries[path] = `dir ${mode}`;
      Object.assign(entries, tree(root, path));
    } else {
      entries[path] = `file ${mode} ${readFileSync(join(root, path), 'utf8')}`;
    }
  }
  return entries;
}

/** A checked-out repository, as an image's working directory holds one. */
function workingDirectory() {
  const root = scratch();
  const workdir = join(root, 'app');
  mkdirSync(join(workdir, 'src', 'models'), { recursive: true });
  writeFileSync(join(workdir, 'src', 'train.py'), 'print("train")\n');
  writeFileSync(join(workdir, 'src', 'models', 'mace.py'), 'MACE = 1\n');
  writeFileSync(join(workdir, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(workdir, 'run.sh'), 0o755);
  writeFileSync(join(workdir, 'config.yaml'), 'epochs: 3\n');
  symlinkSync('src/train.py', join(workdir, 'main.py'));
  mkdirSync(join(workdir, 'vendor'));
  writeFileSync(join(workdir, 'vendor', 'pinned.txt'), 'v1\n');
  chmodSync(join(workdir, 'vendor'), 0o555);
  mkdirSync(join(workdir, 'docs'));
  return { root, workdir, copy: join(root, 'copy') };
}

describe('the reset between pool Jobs', () => {
  it('restores the working directory to its start, rewriting only what the Job changed', async () => {
    const { workdir, copy } = workingDirectory();
    mkdirSync(copy);
    await mirror(workdir, copy, []);
    const start = tree(workdir);
    expect(tree(copy)).toEqual(start);
    const untouched = statSync(join(workdir, 'src', 'models', 'mace.py')).ino;
    // A chmod would advance the ctime, and fails on a directory the runner
    // doesn't own; file times advance by the kernel's clock tick.
    const docs = statSync(join(workdir, 'docs')).ctimeMs;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The Job pulls, builds, edits and leaves files behind.
    writeFileSync(join(workdir, 'results.csv'), 'loss\n');
    mkdirSync(join(workdir, '.cache', 'pip'), { recursive: true });
    writeFileSync(join(workdir, '.cache', 'pip', 'wheel'), 'x');
    writeFileSync(join(workdir, 'config.yaml'), 'epochs: 9\n');
    chmodSync(join(workdir, 'config.yaml'), 0o444);
    writeFileSync(join(workdir, 'src', 'train.py'), 'print("TRAIN")\n');
    rmSync(join(workdir, 'run.sh'));
    mkdirSync(join(workdir, 'run.sh'));
    rmSync(join(workdir, 'main.py'));
    symlinkSync('config.yaml', join(workdir, 'main.py'));
    chmodSync(join(workdir, 'src'), 0o700);
    // Read-only trees, as Go's module cache leaves them.
    writeFileSync(join(workdir, 'src', 'models', 'new.py'), '');
    chmodSync(join(workdir, 'src', 'models'), 0o555);
    mkdirSync(join(workdir, 'build', 'pkg'), { recursive: true });
    writeFileSync(join(workdir, 'build', 'pkg', 'mod.go'), '');
    chmodSync(join(workdir, 'build', 'pkg'), 0o555);
    chmodSync(join(workdir, 'build'), 0o555);
    // Directories it can't list or search, and a read-only working directory.
    mkdirSync(join(workdir, 'logs', 'run'), { recursive: true });
    chmodSync(join(workdir, 'logs', 'run'), 0o300);
    chmodSync(join(workdir, 'logs'), 0o600);
    writeFileSync(join(workdir, 'vendor.lock'), '');
    chmodSync(workdir, 0o555);

    await mirror(copy, workdir, []);
    expect(tree(workdir)).toEqual(start);
    expect(statSync(join(workdir, 'src', 'models', 'mace.py')).ino).toBe(
      untouched,
    );
    expect(statSync(join(workdir, 'docs')).ctimeMs).toBe(docs);
  });

  it("neither copies nor deletes the runner's own mounts inside the working directory", async () => {
    const { workdir, copy } = workingDirectory();
    const runner = join(workdir, 'anycloud-runner');
    mkdirSync(runner);
    writeFileSync(join(runner, 'rclone'), 'binary');
    mkdirSync(copy);
    await mirror(workdir, copy, [runner, copy]);
    expect(existsSync(join(copy, 'anycloud-runner'))).toBe(false);
    await mirror(copy, workdir, [runner, copy]);
    expect(readFileSync(join(runner, 'rclone'), 'utf8')).toBe('binary');
  });

  it('kills every other process, empties the fixed paths and restores the working directory and its mode', async () => {
    const { root, workdir, copy } = workingDirectory();
    const [output, shm] = [join(root, 'output'), join(root, 'shm')];
    mkdirSync(output);
    mkdirSync(shm);
    mkdirSync(copy);
    const killAll = vi.fn();
    const reset = await replicaReset({
      workdir,
      copy,
      mounts: [copy],
      // An image may have no `/dev/shm`.
      emptied: [output, shm, join(root, 'missing')],
      killAll,
      log: vi.fn(),
    });
    const start = tree(workdir);
    writeFileSync(join(output, 'model.pt'), 'weights');
    writeFileSync(join(shm, 'nccl-segment'), '');
    writeFileSync(join(workdir, 'notes.txt'), '');
    chmodSync(workdir, 0o711);
    await reset();
    expect(killAll).toHaveBeenCalledOnce();
    expect(readdirSync(output)).toEqual([]);
    expect(readdirSync(shm)).toEqual([]);
    expect(tree(workdir)).toEqual(start);
    expect(statSync(workdir).mode & 0o777).toBe(0o755);
  });

  it('RFC 0049 C12 keeps a Node cache through the reset, inside the working directory or holding it', async () => {
    const { workdir, copy } = workingDirectory();
    const cache = join(workdir, '.cache', 'pip');
    mkdirSync(cache, { recursive: true });
    mkdirSync(copy);
    const options = { emptied: [], killAll: vi.fn(), log: vi.fn() };
    const inside = await replicaReset({
      ...options,
      workdir,
      copy,
      mounts: [copy, cache],
    });
    writeFileSync(join(cache, 'wheel'), 'x');
    writeFileSync(join(workdir, 'results.csv'), '');
    await inside();
    expect(readFileSync(join(cache, 'wheel'), 'utf8')).toBe('x');
    expect(existsSync(join(workdir, 'results.csv'))).toBe(false);

    // A working directory in a cache is the cache's, so nothing restores it.
    const holding = await replicaReset({
      ...options,
      workdir: cache,
      copy,
      mounts: [copy, join(workdir, '.cache')],
    });
    writeFileSync(join(cache, 'sdist'), 'y');
    await holding();
    expect(readdirSync(cache).sort()).toEqual(['sdist', 'wheel']);
  });

  it("restarts the replica after every Job when the runner's user can't read part of the working directory", async () => {
    const { workdir, copy } = workingDirectory();
    writeFileSync(join(workdir, 'secret'), 'token');
    chmodSync(join(workdir, 'secret'), 0o000);
    mkdirSync(copy);
    const log = vi.fn();
    const reset = await replicaReset({
      workdir,
      copy,
      mounts: [copy],
      emptied: [],
      killAll: vi.fn(),
      log,
    });
    // The fresh container's reset before its first claim.
    await reset();
    // Root reads everything, so it restores.
    if (process.getuid?.() === 0)
      return expect(reset()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`can't read ${join(workdir, 'secret')}`),
    );
    await expect(reset()).rejects.toThrow(
      "Can't restore the working directory",
    );
  });

  it('keeps a working directory inside an emptied path, for the restore to reset', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'app', 'src'), { recursive: true });
    writeFileSync(join(dir, 'scratch.bin'), '');
    await empty(dir, join(dir, 'app', 'src'));
    expect(readdirSync(dir)).toEqual(['app']);
  });

  it('empties a fixed path and keeps it, and finds a missing one empty', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'epoch-1'));
    writeFileSync(join(dir, 'epoch-1', 'model.pt'), 'weights');
    writeFileSync(join(dir, '.lock'), '');
    chmodSync(join(dir, 'epoch-1'), 0o555);
    await empty(dir);
    expect(readdirSync(dir)).toEqual([]);
    await expect(empty(join(dir, 'missing'))).resolves.toBeUndefined();
  });
});
