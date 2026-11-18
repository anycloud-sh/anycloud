import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * Remove everything inside a directory but the entry that holds `keep`, a
 * working directory there, which the restore resets instead. A missing
 * directory is already empty.
 */
export async function empty(dir: string, keep = ''): Promise<void> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(dir, entry);
    if (keep !== path && !keep.startsWith(`${path}/`)) await remove(path);
  }
}

/** `rm -rf`, first making writable any directory the Job made read-only. */
async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(async (error) => {
    if (errorCode(error) !== 'EACCES') throw error;
    await writable(path);
    await rm(path, { recursive: true, force: true });
  });
}

/** Give back an owned directory's owner rwx, which a Job may have removed. */
async function regain(path: string, stat: Stats): Promise<void> {
  if ((stat.mode & 0o700) !== 0o700 && stat.uid === process.getuid?.()) {
    await chmod(path, stat.mode | 0o700);
  }
}

async function writable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory()) return;
  await regain(path, stat);
  for (const name of await readdir(path)) await writable(join(path, name));
}

/**
 * Copy the working directory, less the runner's `mounts`, and return the
 * reset between Jobs: kill every other process (tini, PID 1,
 * reaps them), empty `emptied`, keeping each directory itself and any
 * missing (not `/mnt/input`, which staging syncs), and restore the working
 * directory and its mode, unless it is `/` or in one of `mounts`, such as a
 * Node cache, which outlasts the Job. One the runner can't wholly
 * read can't be restored, so each reset after a Job fails and the replica
 * restarts: a fresh container per Job.
 */
export async function replicaReset(options: {
  workdir: string;
  copy: string;
  mounts: string[];
  emptied: string[];
  killAll(): void;
  log(message: string): void;
}): Promise<() => Promise<void>> {
  const { workdir, copy, emptied } = options;
  const skip = [...options.mounts];
  const mode = (await lstat(workdir)).mode;
  const restore =
    workdir !== '/' &&
    !skip.some((mount) => workdir === mount || workdir.startsWith(`${mount}/`));
  if (restore) await mirror(workdir, copy, skip, true);
  const unreadable = skip.slice(options.mounts.length);
  if (unreadable.length > 0) {
    options.log(
      `The runner's user can't read ${unreadable.join(', ')}, so it can't restore the working directory; the replica restarts after every Job`,
    );
  }
  // The first reset is a fresh container's.
  let first = true;
  return async () => {
    if (unreadable.length > 0 && !first) {
      // Each restart takes the kubelet's back-off, up to 5 min (RFC 0044).
      throw new Error("Can't restore the working directory; restarting");
    }
    first = false;
    options.killAll();
    for (const dir of emptied) await empty(dir, workdir);
    if (!restore) return;
    await mirror(copy, workdir, skip);
    if ((await lstat(workdir)).mode !== mode)
      await chmod(workdir, mode & 0o7777);
  };
}

/**
 * Make `to` hold what `from` holds: delete what `from` lacks and copy what
 * differs in type, size, modification time or mode, so a reset rewrites only
 * what the Job changed. Paths in `skip` are neither copied nor deleted; with
 * `unreadable`, the start copy adds to it what the runner can't read. Owned
 * directories get their owner's rwx back first. Symlinks stay links;
 * sockets, FIFOs, devices and owners aren't copied.
 */
export async function mirror(
  from: string,
  to: string,
  skip: string[],
  unreadable = false,
): Promise<void> {
  await regain(to, await lstat(to));
  const names = new Set(
    (await readdir(from)).filter((name) => !skip.includes(join(from, name))),
  );
  for (const name of await readdir(to)) {
    if (!names.has(name) && !skip.includes(join(to, name))) {
      await remove(join(to, name));
    }
  }
  await Promise.all(
    [...names].map((name) =>
      mirrorEntry(join(from, name), join(to, name), skip, unreadable).catch(
        async (error: unknown) => {
          if (!unreadable || errorCode(error) !== 'EACCES') throw error;
          await remove(join(to, name));
          skip.push(join(from, name));
        },
      ),
    ),
  );
}

async function mirrorEntry(
  source: string,
  target: string,
  skip: string[],
  unreadable: boolean,
): Promise<void> {
  const want = await lstat(source);
  let have = await lstat(target).catch(() => undefined);
  const kind = (mode: number) => mode & 0o170000;
  if (have && kind(have.mode) !== kind(want.mode)) {
    await remove(target);
    have = undefined;
  }
  if (want.isSymbolicLink()) {
    const link = await readlink(source);
    if (have && (await readlink(target)) === link) return;
    await rm(target, { force: true });
    await symlink(link, target);
    return;
  }
  if (want.isDirectory()) {
    if (!have) await mkdir(target);
    // Children first: a read-only directory's mode would block them. The
    // mirror may regain rwx, so the mode is checked after.
    await mirror(source, target, skip, unreadable);
    have = await lstat(target);
  } else if (!want.isFile()) {
    return;
  } else if (
    !have ||
    have.size !== want.size ||
    // Timestamps round to the millisecond when copied.
    Math.abs(have.mtimeMs - want.mtimeMs) >= 1
  ) {
    // A fresh file: the Job may have made the old one read-only.
    await rm(target, { force: true });
    await copyFile(source, target);
    await utimes(target, want.atime, want.mtime);
    have = undefined;
  }
  if (have?.mode !== want.mode) await chmod(target, want.mode & 0o7777);
}
