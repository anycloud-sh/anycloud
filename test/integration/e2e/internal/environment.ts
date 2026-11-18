import type { Redactor } from './artifacts.js';

export class Environment {
  readonly #source: Readonly<NodeJS.ProcessEnv>;
  readonly #redactor: Redactor;

  constructor(source: Readonly<NodeJS.ProcessEnv>, redactor: Redactor) {
    this.#source = source;
    this.#redactor = redactor;
  }

  optional(name: string, fallback = ''): string {
    const value = this.#source[name] ?? fallback;
    if (/(?:CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu.test(name)) {
      this.#redactor.add(value);
    }
    return value;
  }

  required(name: string): string {
    const value = this.#source[name];
    if (!value)
      throw new Error(`Required E2E environment variable ${name} is missing`);
    return value;
  }

  secret(name: string): string {
    const value = this.required(name);
    this.#redactor.add(value);
    return value;
  }

  optionalSecret(name: string, fallback?: string): string | undefined {
    const value = this.#source[name] ?? fallback;
    this.#redactor.add(value);
    return value || undefined;
  }

  milliseconds(name: string, defaultSeconds: number): number {
    const raw = this.#source[name];
    const seconds = raw === undefined ? defaultSeconds : Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error(`${name} must be a positive integer number of seconds`);
    }
    return seconds * 1_000;
  }
}
