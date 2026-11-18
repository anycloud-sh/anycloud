import { appendFile, readFile, writeFile } from 'node:fs/promises';

import { isRecord } from './types.js';

export class CleanupManifest {
  readonly #file: string | undefined;
  #pending = Promise.resolve();

  constructor(file: string | undefined) {
    this.#file = file;
  }

  add(value: string): Promise<void> {
    return this.#update(async (file) => {
      await appendFile(file, `${value}\n`, 'utf8');
    });
  }

  remove(value: string): Promise<void> {
    return this.#update(async (file) => {
      let current: string;
      try {
        current = await readFile(file, 'utf8');
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return;
        throw error;
      }
      const remaining = current
        .split('\n')
        .filter((line) => line.length > 0 && line !== value);
      await writeFile(
        file,
        remaining.length > 0 ? `${remaining.join('\n')}\n` : '',
        'utf8',
      );
    });
  }

  #update(operation: (file: string) => Promise<void>): Promise<void> {
    const file = this.#file;
    if (!file) return Promise.resolve();
    // Appends and removals share the queue so a release cannot erase a new
    // reservation or restore an entry removed by another concurrent release.
    const update = this.#pending.then(() => operation(file));
    // Report failure to this caller while allowing other resources to persist.
    this.#pending = update.catch(() => undefined);
    return update;
  }
}
