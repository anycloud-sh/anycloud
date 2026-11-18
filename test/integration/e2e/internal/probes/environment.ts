import type { CleanupRegistration, CleanupStack } from '../cleanup.js';
import type { FixtureFiles } from '../files.js';

/**
 * Collision-safe keys the workload reads back. They are fixed so a target
 * cannot quietly probe a different variable than the one it submitted.
 */
export const ENVIRONMENT_PROBE_KEYS = {
  direct: 'SERVE_MARKER',
  file: 'SERVE_ENV_FILE_MARKER',
  override: 'SERVE_ENV_OVERRIDE',
} as const;

export interface EnvironmentProbe {
  /** Values submitted as direct environment flags. */
  readonly directEnvironment: Readonly<Record<string, string>>;
  readonly environmentFile: string;
  /** The resolved values the workload must report, direct value winning. */
  readonly expected: Readonly<Record<string, string>>;
  readonly markers: readonly string[];
  release(): Promise<void>;
}

/**
 * Owns the env file and the direct/file value pair that prove environment
 * precedence. It has no secret value, provider selection, expected lifecycle
 * state, or endpoint assertion: a contract decides what to do with the values,
 * and only the fixture removes the file.
 */
export class EnvironmentProbeFixture {
  readonly #cleanup: Pick<CleanupStack, 'defer'>;
  readonly #files: Pick<FixtureFiles, 'remove' | 'text'>;

  constructor(
    cleanup: Pick<CleanupStack, 'defer'>,
    files: Pick<FixtureFiles, 'remove' | 'text'>,
  ) {
    this.#cleanup = cleanup;
    this.#files = files;
  }

  async create(scope: string): Promise<EnvironmentProbe> {
    const fileMarker = `env-file-${scope}`;
    const fileOverride = `env-override-from-file-${scope}`;
    const directMarker = `anycloud-serve-${scope}`;
    const directOverride = `env-override-from-flag-${scope}`;
    const name = `environment-probe/${scope}.env`;
    // Register removal before the file exists so a creation failure that still
    // wrote a partial file cannot leave it behind.
    const registration: CleanupRegistration = this.#cleanup.defer(
      `environment probe ${scope}`,
      () => this.#files.remove(name),
    );
    const environmentFile = await this.#files.text(
      name,
      `${ENVIRONMENT_PROBE_KEYS.file}=${fileMarker}\n${ENVIRONMENT_PROBE_KEYS.override}=${fileOverride}\n`,
    );

    return {
      directEnvironment: {
        [ENVIRONMENT_PROBE_KEYS.direct]: directMarker,
        [ENVIRONMENT_PROBE_KEYS.override]: directOverride,
      },
      environmentFile,
      expected: {
        [ENVIRONMENT_PROBE_KEYS.direct]: directMarker,
        [ENVIRONMENT_PROBE_KEYS.file]: fileMarker,
        [ENVIRONMENT_PROBE_KEYS.override]: directOverride,
      },
      markers: [directMarker, fileMarker, directOverride],
      release: async () => {
        await this.#files.remove(name);
        registration.complete();
      },
    };
  }
}
