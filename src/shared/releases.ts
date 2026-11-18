import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import * as https from 'node:https';
import { dirname, join } from 'node:path';
import * as semver from 'semver';
import { getAnycloudDir } from './utils.js';

export const RELEASES_LATEST_URL =
  'https://api.github.com/repos/anycloud-sh/releases/releases/latest';
const RELEASE_FETCH_TIMEOUT_MS = 3000;

export interface VersionCache {
  latestVersion: string;
  lastCheck: number;
  lastNotifiedVersion?: string;
}

export interface LatestRelease {
  version: string;
  url: string;
}

interface GitHubLatestRelease {
  tag_name?: unknown;
  html_url?: unknown;
}

export function versionCachePath(): string {
  return join(getAnycloudDir(), 'version-cache.json');
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && semver.valid(value) !== null;
}

function parseVersionCache(value: unknown): VersionCache | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<VersionCache>;
  if (
    !isVersion(candidate.latestVersion) ||
    typeof candidate.lastCheck !== 'number' ||
    !Number.isFinite(candidate.lastCheck)
  ) {
    return null;
  }

  return {
    latestVersion: candidate.latestVersion,
    lastCheck: candidate.lastCheck,
    ...(isVersion(candidate.lastNotifiedVersion)
      ? { lastNotifiedVersion: candidate.lastNotifiedVersion }
      : {}),
  };
}

export function readVersionCache(): VersionCache | null {
  try {
    return parseVersionCache(
      JSON.parse(readFileSync(versionCachePath(), 'utf8')),
    );
  } catch {
    return null;
  }
}

/**
 * Merge a cache update into the latest on-disk value and replace the file
 * atomically. The merge preserves fields written by the CLI and API when they
 * update the cache at different times; the rename prevents readers from ever
 * observing a partial JSON document.
 */
export async function updateVersionCache(
  update: Partial<VersionCache>,
): Promise<void> {
  const path = versionCachePath();
  const previous = readVersionCache();
  const next = parseVersionCache({ ...(previous ?? {}), ...update });
  if (!next) {
    throw new Error('version cache update is missing valid release metadata');
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseReleaseVersion(payload: GitHubLatestRelease): string | null {
  return typeof payload.tag_name === 'string'
    ? semver.valid(payload.tag_name.replace(/^v/, ''))
    : null;
}

export const releaseInternals = { httpsGet: https.get };

function requestLatestRelease(): Promise<GitHubLatestRelease | null> {
  return new Promise((resolve) => {
    const req = releaseInternals.httpsGet(
      RELEASES_LATEST_URL,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'anycloud',
        },
        timeout: RELEASE_FETCH_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const payload: unknown = JSON.parse(body);
            resolve(
              payload && typeof payload === 'object'
                ? (payload as GitHubLatestRelease)
                : null,
            );
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    // The CLI's version banner refresh is intentionally fire-and-forget. Do
    // not keep a short-lived CLI process alive just for this network request.
    req.on('socket', (socket) => socket.unref());
  });
}

/** Resolve only the version, preserving the CLI updater's existing contract. */
export async function fetchLatestVersion(): Promise<string | null> {
  const payload = await requestLatestRelease();
  return payload ? parseReleaseVersion(payload) : null;
}

/** Resolve the version and page of the latest public release. */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const payload = await requestLatestRelease();
  if (!payload) return null;

  const version = parseReleaseVersion(payload);
  const url = typeof payload.html_url === 'string' ? payload.html_url : '';
  if (!version || !URL.canParse(url) || new URL(url).protocol !== 'https:')
    return null;

  return { version, url };
}
