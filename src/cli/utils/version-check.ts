import * as semver from 'semver';
import chalk from 'chalk';
import {
  fetchLatestVersion as fetchLatestVersionShared,
  readVersionCache,
  updateVersionCache,
  type VersionCache,
} from '../../shared/releases.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readCache(): VersionCache | null {
  return readVersionCache();
}

async function writeCache(cache: VersionCache): Promise<void> {
  try {
    await updateVersionCache(cache);
  } catch {
    // Best-effort — a cache write failure just means we'll re-check next run.
  }
}

export function fetchLatestVersion(): Promise<string | null> {
  return fetchLatestVersionShared();
}

export function maybeShowVersionBanner(currentVersion: string): void {
  if (!process.stdout.isTTY) return;

  const cache = internals.readCache();

  if (
    cache &&
    semver.valid(cache.latestVersion) &&
    semver.gt(cache.latestVersion, currentVersion)
  ) {
    process.stderr.write(
      chalk.yellow(
        `anycloud is out of date: ${currentVersion} → ${cache.latestVersion}\n` +
          'Run `anycloud update` to upgrade\n\n',
      ),
    );
  }

  const now = Date.now();
  if (!cache || now - cache.lastCheck > CHECK_INTERVAL_MS) {
    void internals.fetchLatestVersion().then((latestVersion) => {
      if (latestVersion) {
        void internals.writeCache({ latestVersion, lastCheck: now });
      }
    });
  }
}

// Indirection so tests can spy on the helpers without exporting each one
// individually as part of the public surface.
export const internals = {
  readCache,
  writeCache,
  fetchLatestVersion,
};
