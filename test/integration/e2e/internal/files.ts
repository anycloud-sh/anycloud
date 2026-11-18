import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function within(root: string, name: string): string {
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Fixture path must remain inside its workspace: ${name}`);
  }
  return target;
}

export class FixtureFiles {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async directory(
    name: string,
    options: { readonly private?: boolean } = {},
  ): Promise<string> {
    const target = within(this.#root, name);
    await mkdir(target, {
      recursive: true,
      ...(options.private ? { mode: 0o700 } : {}),
    });
    if (options.private) await chmod(target, 0o700);
    return target;
  }

  async executableDirectory(
    directoryName: string,
    executableName: string,
    contents: string,
  ): Promise<string> {
    if (path.basename(executableName) !== executableName) {
      throw new Error('Executable name cannot contain path separators');
    }
    const directory = await this.directory(directoryName);
    const target = within(directory, executableName);
    await writeFile(target, contents, 'utf8');
    await chmod(target, 0o755);
    return directory;
  }

  async remove(name: string): Promise<void> {
    await rm(within(this.#root, name), { force: true, recursive: true });
  }

  async text(name: string, contents: string): Promise<string> {
    const target = within(this.#root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
    return target;
  }

  async privateText(name: string, contents: string): Promise<string> {
    const target = await this.text(name, contents);
    await chmod(target, 0o600);
    return target;
  }
}
