import { ApiVersionMismatchError } from '../../shared/errors.js';
import * as semver from 'semver';
import config from '../config.js';

/**
 * Workload and credential read, quota status, cost and token procedures
 * accept the current release and the one before it, so a pinned client survives one
 * upgrade. Releases bump only the patch, so the window names the predecessor
 * the release recorded instead of counting minors.
 */
export function clientWindowVersionCheck(
  version: string | undefined,
): asserts version is string {
  if (!inClientWindow(version)) {
    throw new ApiVersionMismatchError(version, config.currVersion);
  }
}

/** A missing version is never in the window, even with no predecessor. */
function inClientWindow(version: string | null | undefined): boolean {
  return (
    !!version &&
    (version === config.currVersion || version === config.previousVersion)
  );
}

/**
 * The `api upgrade` procedures and the token exchange also accept a newer
 * client in the same major line: the CLI updating an API is ahead of it, by
 * as many releases as the owner skipped.
 */
export function releaseWindowVersionCheck(
  version: string | undefined,
): asserts version is string {
  if (inClientWindow(version)) return;
  const client = version ? semver.parse(version) : null;
  const served = semver.parse(config.currVersion);
  if (
    !client ||
    !served ||
    client.major !== served.major ||
    !semver.gt(client, served)
  ) {
    throw new ApiVersionMismatchError(version, config.currVersion);
  }
}

/** Require the CLI and API package versions to match exactly. */
export function versionCheck(
  version: string | undefined,
): asserts version is string {
  if (version !== config.currVersion) {
    throw new ApiVersionMismatchError(version, config.currVersion);
  }
}
