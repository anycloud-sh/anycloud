import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CommandResult } from './types.js';

const SENSITIVE_KEY =
  /(?:access.?token|api.?key|credential|password|private.?key|secret)/iu;

function safeName(value: string): string {
  const result = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100);
  return result.length > 0 ? result : 'artifact';
}

function sanitizeStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeStructured);
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeStructured(child);
  }
  return output;
}

export class Redactor {
  readonly #values = new Set<string>();

  add(value: string | undefined): void {
    if (value && value.length >= 3) this.#values.add(value);
  }

  text(value: string): string {
    let redacted = value;
    const secrets = [...this.#values].sort(
      (left, right) => right.length - left.length,
    );
    for (const secret of secrets) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  }

  structured(value: unknown): unknown {
    return sanitizeStructured(value);
  }
}

export class ArtifactStore {
  readonly #root: string;
  readonly #redactor: Redactor;
  #counter = 0;

  constructor(root: string, redactor: Redactor) {
    this.#root = root;
    this.#redactor = redactor;
  }

  get directory(): string {
    return this.#root;
  }

  async initialize(metadata: Readonly<Record<string, unknown>>): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await this.json('metadata', metadata);
  }

  async text(name: string, value: string): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    const target = path.join(this.#root, `${safeName(name)}.log`);
    await writeFile(target, this.#redactor.text(value), 'utf8');
    return target;
  }

  async json(name: string, value: unknown): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    const target = path.join(this.#root, `${safeName(name)}.json`);
    const safeValue = this.#redactor.structured(value);
    const serialized = this.#redactor.text(
      `${JSON.stringify(safeValue, undefined, 2)}\n`,
    );
    await writeFile(target, serialized, 'utf8');
    return target;
  }

  async command(label: string, result: CommandResult): Promise<void> {
    this.#counter += 1;
    const prefix = `${String(this.#counter).padStart(3, '0')}-${safeName(label)}`;
    await this.json(`${prefix}-result`, {
      executable: result.executable,
      args: result.args,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      aborted: result.aborted,
      outputTruncated: result.outputTruncated,
      spawnError: result.spawnError,
    });
    await this.text(
      `${prefix}-output`,
      [
        '[stdout]',
        result.stdout,
        '',
        '[stderr]',
        result.stderr,
        '',
        '[combined]',
        result.combined,
      ].join('\n'),
    );
  }
}

export { safeName, sanitizeStructured };
