import { Command } from 'commander';
import { execFileSync, execSync } from 'child_process';
import { realpathSync } from 'fs';
import { dirname } from 'path';
import * as semver from 'semver';
import { printInfo, printError, printWarning } from '../utils/output.js';
import { fetchLatestVersion } from '../utils/version-check.js';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  LocalApiStillStartingError,
  reconcileLocalApi,
  runningAnycloud,
} from '../services/local-api-update.js';
import { LOCAL_API_STILL_STARTING_EXIT_CODE } from '../../shared/local-api-container.js';

export const HOMEBREW_TAP = 'anycloud-sh/tap/anycloud';
const HOMEBREW_UPDATE_COMMAND = `brew update && brew upgrade ${HOMEBREW_TAP}`;
const HOMEBREW_VERSION_QUERY_COMMAND = `brew list --versions ${HOMEBREW_TAP}`;
// Download first so a failed request fails the update instead of piping
// nothing into sh. $1 is the install directory and $2 the release.
export const INSTALL_SCRIPT =
  'installer=$(curl -fsSL https://get.anycloud.sh) && ' +
  'printf \'%s\\n\' "$installer" | sh -s -- --install-dir "$1" --version "$2"';

export function isHomebrewManagedPath(path: string | undefined): boolean {
  if (!path) return false;
  let resolved = path;
  try {
    resolved = realpathSync.native(path);
  } catch {
    // The path may not exist in tests or dev mode. Fall back to string matching.
  }
  return resolved.includes('/Cellar/anycloud/');
}

function isHomebrewManagedInstall(): boolean {
  return [process.execPath, process.argv[1]].some(isHomebrewManagedPath);
}

// Ask Homebrew directly what it installed, rather than shelling out to
// `anycloud` on PATH — a bare PATH lookup could resolve to a different,
// non-Homebrew anycloud binary (the installer-script and Homebrew
// distributions are both supported, and can coexist on one machine).
function readHomebrewInstalledVersion(): string | null {
  try {
    const output = execSync(HOMEBREW_VERSION_QUERY_COMMAND, {
      encoding: 'utf-8',
    });
    const versions = String(output)
      .trim()
      .split(/\s+/)
      .slice(1)
      .filter((version) => semver.valid(version));
    if (versions.length === 0) return null;
    return versions.reduce((latest, version) =>
      semver.gt(version, latest) ? version : latest,
    );
  } catch {
    return null;
  }
}

async function runHomebrewUpdate(targetVersion: string): Promise<void> {
  printInfo('anycloud was installed with Homebrew. Updating with Homebrew...');
  execSync(HOMEBREW_UPDATE_COMMAND, { stdio: 'inherit' });

  const installedVersion = readHomebrewInstalledVersion();
  if (!installedVersion) {
    throw new Error(
      'Homebrew update completed, but could not determine the installed ' +
        `anycloud version. Run \`${HOMEBREW_VERSION_QUERY_COMMAND}\` to check, ` +
        'then run `anycloud update` again.',
    );
  }

  const homebrewIsBehind = semver.lt(installedVersion, targetVersion);
  if (homebrewIsBehind) {
    printInfo(
      `Homebrew has anycloud ${installedVersion}, but the current anycloud release is ${targetVersion}.`,
    );
  }

  await reconcileLocalApi(installedVersion);

  if (homebrewIsBehind) {
    printInfo(
      `Run \`anycloud update\` again after Homebrew makes ${targetVersion} available.`,
    );
  }
}

export function createUpdateCommand(): Command {
  return new Command('update')
    .alias('upgrade')
    .description('⬆️  Update anycloud CLI and local API to the current release')
    .allowExcessArguments(false)
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud update
`,
    )
    .action(async () => {
      try {
        const currentVersion = packageJson.version;
        printInfo(`Current version: ${currentVersion}`);

        const resolvedTarget = await fetchLatestVersion();
        if (!resolvedTarget || !semver.valid(resolvedTarget)) {
          throw new Error('Could not resolve the current anycloud release.');
        }

        printInfo(`Target version: ${resolvedTarget}`);

        if (semver.lt(resolvedTarget, currentVersion)) {
          throw new Error(
            `Refusing to downgrade from ${currentVersion} to ${resolvedTarget}.`,
          );
        }

        if (semver.eq(resolvedTarget, currentVersion)) {
          // The CLI is already current, but a running API container may still be
          // on an older image (e.g. the user updated the CLI but skipped the
          // restart). Reconcile it instead of just reporting "nothing to do".
          await reconcileLocalApi(currentVersion);
          return;
        }

        if (isHomebrewManagedInstall()) {
          await runHomebrewUpdate(resolvedTarget);
          return;
        }

        const [binary, ...script] = runningAnycloud();
        if (script.length > 0) {
          throw new Error(
            `anycloud update replaces an installed binary, but this is running ${script.at(-1)} under ${binary}. Update the source checkout instead.`,
          );
        }
        execFileSync(
          'sh',
          ['-c', INSTALL_SCRIPT, 'sh', dirname(binary), resolvedTarget],
          { stdio: 'inherit' },
        );

        // Reconcile the local API server (if any) so it picks up the
        // freshly-installed image.
        await reconcileLocalApi(resolvedTarget);
      } catch (error) {
        if (error instanceof LocalApiStillStartingError) {
          printWarning(`anycloud is updated. ${error.message}`);
          process.exit(LOCAL_API_STILL_STARTING_EXIT_CODE);
        }
        printError(`Update failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
