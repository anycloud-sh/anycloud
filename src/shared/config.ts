import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { getAnycloudDir } from './utils.js';
import {
  inspectLocalApiContainer,
  localApiUrlForPort,
  type LocalApiContainerInspection,
} from './local-api-container.js';

/** The GitHub sign-in `anycloud login` saves. */
export function githubTokenPath(): string {
  return join(getAnycloudDir(), '.token');
}

/** The per-install token `api start` writes; only it opens a local API. */
export function localApiTokenPath(): string {
  return join(getAnycloudDir(), 'local-api-token');
}
/** Hosted APIs' tokens by API URL, as `anycloud login <api>` saved them. */
export function apiTokensPath(): string {
  return join(getAnycloudDir(), 'api-tokens.json');
}

/** Carries the caller's GitHub sign-in to a local API, which never verifies it. */
export const GITHUB_TOKEN_HEADER = 'AnyCloud-GitHub-Token';

export const API_URL_PATH = join(getAnycloudDir(), 'api-url');
export const DEFAULT_API_URL = 'http://localhost:8080';

export type ApiUrlSource = 'env' | 'file' | 'default';

export interface ResolvedApiTarget {
  url: string;
  source: ApiUrlSource;
  /** Present only when the implicit local target was resolved through Docker. */
  localApiContainer?: LocalApiContainerInspection;
}

export function normalizeApiUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error('API URL cannot be empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid API URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('API URL must start with http:// or https://');
  }

  if (parsed.username || parsed.password) {
    throw new Error('API URL must not contain credentials (user:pass@).');
  }

  return parsed.toString().replace(/\/+$/, '');
}

/** Return the port named by an HTTP(S) loopback URL, or undefined for remote URLs. */
export function getLoopbackApiPort(raw: string): number | undefined {
  const parsed = new URL(normalizeApiUrl(raw));
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '[::1]' &&
    hostname !== '::1'
  ) {
    return undefined;
  }

  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

/**
 * True when an API URL names the caller's own host (localhost, 127.0.0.0/8,
 * ::1) or no host (0.0.0.0, ::), so a Pod can never reach the API through it.
 * `URL` lowercases the host and writes an IPv4-mapped address in hex, so
 * `[::ffff:127.0.0.1]` reads `[::ffff:7f00:1]` and `[::ffff:0.0.0.0]`
 * `[::ffff:0:0]`.
 */
export function isLoopbackApiUrl(raw: string): boolean {
  const hostname = new URL(normalizeApiUrl(raw)).hostname.replace(/\.$/, '');
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d+){3}$/.test(hostname) ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(hostname) ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname === '[::]'
  );
}

export function readPersistedApiUrl(): string | undefined {
  if (!existsSync(API_URL_PATH)) return undefined;
  try {
    return normalizeApiUrl(readFileSync(API_URL_PATH, 'utf-8'));
  } catch {
    return undefined;
  }
}

export function writePersistedApiUrl(url: string): string {
  const normalized = normalizeApiUrl(url);
  mkdirSync(dirname(API_URL_PATH), { recursive: true });
  writeFileSync(API_URL_PATH, `${normalized}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return normalized;
}

export function getApiUrlSource(): ApiUrlSource {
  if (process.env.API_URL) return 'env';
  if (readPersistedApiUrl()) return 'file';
  return 'default';
}

/** Resolve the well-known local API independently of the active API setting. */
export function resolveLocalApiTarget(): ResolvedApiTarget {
  const localApiContainer = inspectLocalApiContainer();
  const url =
    localApiContainer.running && localApiContainer.hostPort !== null
      ? localApiUrlForPort(localApiContainer.hostPort)
      : DEFAULT_API_URL;
  return { url, source: 'default', localApiContainer };
}

export function getDefaultApiUrl(): string {
  return resolveLocalApiTarget().url;
}

/** Resolve the configured API URL and any Docker evidence used to choose it. */
export function resolveApiTarget(): ResolvedApiTarget {
  if (process.env.API_URL) {
    return { url: normalizeApiUrl(process.env.API_URL), source: 'env' };
  }
  const persisted = readPersistedApiUrl();
  if (persisted) return { url: persisted, source: 'file' };
  return resolveLocalApiTarget();
}

// API URL — use API_URL env var if set, then persisted api-url, then localhost.
export function getApiUrl(): string {
  return resolveApiTarget().url;
}
