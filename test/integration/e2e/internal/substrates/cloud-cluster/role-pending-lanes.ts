import { stripVTControlCharacters } from 'node:util';
import { createApiClient } from '../../../../../../src/shared/services/api-client/rpc.js';
import type {
  RoleCloud,
  SaveOutcome,
} from '../../contracts/role-connections.js';
import type { CliClient } from '../../cli.js';
import { cliArgs } from '../../cli-surface.js';
import type { CommandResult } from '../../types.js';

/**
 * The role-connection checks' CLI verbs. `save` drives lane R1 part 2
 * (`credentials new --role`). `rotateSigningKey` throws, naming its
 * lane, until it lands: `cluster signing-key add <cluster>` and
 * `cluster signing-key retire <cluster>`, which answers 409 until 24 hours
 * after the add, then with `--skip-overlap --yes`, which deletes the Pods
 * holding old-key tokens (the API's own too) before it retires; lane R4.
 */
export interface PendingLanes {
  save(
    cloud: RoleCloud,
    name: string,
    identifiers: Readonly<Record<string, string>>,
    api: 'hosted' | 'local',
  ): Promise<SaveOutcome>;
  rotateSigningKey(step: 'add'): Promise<void>;
  rotateSigningKey(step: 'retire'): Promise<{ readonly refusedEarly: string }>;
}

export interface PendingLaneOptions {
  /** This tree's CLI: the hosted API by its URL, the installer without. */
  readonly cli: Pick<CliClient, 'run'>;
  readonly hostedUrl: () => string;
}

export class LaneNotLandedError extends Error {
  constructor(what: string, lane: string) {
    super(`${what} needs ${lane}, which has not landed on this branch`);
    this.name = 'LaneNotLandedError';
  }
}

/**
 * The CLI's last error line, `✗ Failed to add credentials: …` with its
 * continuation lines: not the setup preamble or a pending notice before it.
 */
function refusal(stderr: string): string {
  const plain = stripVTControlCharacters(stderr);
  const at = plain.lastIndexOf('✗ ');
  return (at < 0 ? plain : plain.slice(at + 2))
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** What a role connection's save answered; anything but a refusal or a save throws. */
export async function saveOutcome(
  result: CommandResult,
  listed: () => Promise<Readonly<Record<string, unknown>> | undefined>,
): Promise<SaveOutcome> {
  if (
    result.timedOut ||
    result.aborted ||
    result.spawnError ||
    result.exitCode === null
  )
    throw new Error(
      `credentials new --role did not finish: ${result.combined.slice(-500)}`,
    );
  if (result.exitCode !== 0)
    return { saved: false, message: refusal(result.stderr) };
  const entry = await listed();
  if (!entry)
    throw new Error(
      'credentials new --role succeeded but the connection is not listed',
    );
  return { saved: true, listed: entry };
}

function ok(result: CommandResult, label: string): string {
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(
      `${label} failed (exit ${String(result.exitCode)}): ${result.combined.slice(-1000)}`,
    );
  return result.stdout;
}

export function pendingLanes(options: PendingLaneOptions): PendingLanes {
  const { cli } = options;
  // The hosted API by its URL; the installer's local API without one.
  const run = (
    args: readonly string[],
    api: 'hosted' | 'local',
    label: string,
    timeoutMs: number,
  ) =>
    cli.run(args, {
      label,
      timeoutMs,
      ...(api === 'hosted' ? { env: { API_URL: options.hostedUrl() } } : {}),
    });
  return {
    async save(cloud, name, identifiers, api) {
      const result = await run(
        cliArgs(
          'credentials new',
          {
            provider: cloud,
            role: true,
            overwrite: api === 'hosted',
            ...identifiers,
          },
          [name],
        ),
        api,
        `role-save-${cloud}`,
        600_000,
      );
      return saveOutcome(result, async () => {
        if (api === 'local') {
          // S15 fails on any local save; the CLI's listing shows it is there.
          const list = JSON.parse(
            ok(
              await run(
                cliArgs('credentials list', { json: true }),
                api,
                'credentials-list',
                120_000,
              ),
              'credentials list',
            ),
          ) as Record<string, unknown>[];
          return list.find((entry) => entry.name === name);
        }
        // The API's own redacted record, not the CLI's projection of it
        // (invariant 7), read with the API token the CLI saved.
        const bearer = ok(
          await cli.run(cliArgs('api token', {}), {
            label: 'hosted-api-token',
            timeoutMs: 120_000,
            recordArtifact: false,
            env: { API_URL: options.hostedUrl() },
          }),
          'api token',
        ).trim();
        const list = await createApiClient(bearer, {
          apiUrl: options.hostedUrl(),
        }).credentials.list();
        return list.find((entry) => entry.name === name);
      });
    },
    rotateSigningKey: ((step: 'add' | 'retire') =>
      Promise.reject(
        new LaneNotLandedError(
          `The signing-key rotation's ${step} step`,
          'lane R4',
        ),
      )) as PendingLanes['rotateSigningKey'],
  };
}
