import { CommandFailedError, runArgv } from '../services/slurp/cli-exec.js';
import { SEED_EXECUTABLES } from './accounts.js';
import { CloudCliError, type CloudCli, type SeedCloud } from './types.js';

/** A cloud's long calls (a stack deploy) report through `status` instead. */
const CLOUD_CLI_TIMEOUT_MS = 30 * 60_000;

/**
 * The user's own `aws`, `gcloud` or `az`, run by argv on this machine; `env`
 * selects an account (`CLOUDSDK_CORE_PROJECT`).
 */
export function createCloudCli(
  cloud: SeedCloud,
  env?: NodeJS.ProcessEnv,
): CloudCli {
  const executable = SEED_EXECUTABLES[cloud];
  return {
    async run(command, options) {
      try {
        return await runArgv(executable, command.args, {
          input: command.input,
          signal: options?.signal,
          timeoutMs: CLOUD_CLI_TIMEOUT_MS,
          env,
        });
      } catch (error) {
        if (error instanceof CommandFailedError) {
          throw new CloudCliError(
            executable,
            command.args,
            error.exitCode,
            error.stderr,
          );
        }
        throw error;
      }
    },
  };
}
