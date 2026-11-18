import type { Redactor } from '../artifacts.js';
import type { FixtureNames } from '../names.js';
import type { SecretManager } from '../secrets.js';

/** The variable a named secret bundle projects into the workload. */
export const NAMED_SECRET_PROBE_KEY = 'SERVE_SECRET_TOKEN';

export interface NamedSecretProbe {
  /** One-way digest the workload compares against; the value never leaves. */
  readonly digest: string;
  readonly name: string;
  /** Whether text carries the value, without handing the value out. */
  appearsIn(text: string): boolean;
  release(): Promise<void>;
}

export interface NamedSecretProbeDependencies {
  readonly names: Pick<FixtureNames, 'secret'>;
  readonly redactor: Pick<Redactor, 'add'>;
  readonly secrets: Pick<SecretManager, 'create' | 'delete'>;
  sha256(value: string): string;
}

/**
 * Creates the named secret whose injection a contract verifies through a
 * digest rather than a plaintext comparison. Redaction is registered before
 * the value can reach any command output or artifact, and `SecretManager`
 * arms LIFO deletion before the secret exists.
 */
export class NamedSecretProbeFixture {
  readonly #dependencies: NamedSecretProbeDependencies;

  constructor(dependencies: NamedSecretProbeDependencies) {
    this.#dependencies = dependencies;
  }

  async create(scope: string): Promise<NamedSecretProbe> {
    const name = this.#dependencies.names.secret(scope);
    const value = `anycloud-serve-secret-${name}`;
    this.#dependencies.redactor.add(value);
    await this.#dependencies.secrets.create(name, {
      [NAMED_SECRET_PROBE_KEY]: value,
    });

    return {
      digest: this.#dependencies.sha256(value),
      name,
      appearsIn: (text) => text.includes(value),
      release: async () => {
        await this.#dependencies.secrets.delete(name);
      },
    };
  }
}
