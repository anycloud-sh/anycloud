import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import {
  GITHUB_TOKEN_HEADER,
  apiTokensPath,
  getLoopbackApiPort,
  localApiTokenPath,
  githubTokenPath,
  normalizeApiUrl,
} from '../config.js';

function readSavedToken(
  path: string,
  label: string,
  fix: string,
): string | null {
  try {
    return readFileSync(path, 'utf-8').trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Could not read the ${label} ${path}: ${(error as Error).message}. ${fix}`,
    );
  }
}

/**
 * Resolve the GitHub access token, first match wins (the Python SDK's order):
 * 1. The token `anycloud login` saved in $ANYCLOUD_DIR/.token
 * 2. GITHUB_TOKEN
 *
 * Returns null if no token is found (caller decides what to do). A saved
 * token that exists but can't be read is an error, not a fallback.
 */
export function resolveGitHubToken(): string | null {
  return (
    readSavedToken(
      githubTokenPath(),
      'saved token',
      "Fix the file's permissions or run `anycloud login` again.",
    ) ??
    (process.env.GITHUB_TOKEN?.trim() || null)
  );
}

/** The token `anycloud api start` wrote for the local API, or null before then. */
export function readLocalApiToken(): string | null {
  return readSavedToken(
    localApiTokenPath(),
    'local API token',
    'Run the CLI as the user who ran `anycloud api start`.',
  );
}

const savedApiTokensSchema = z.record(z.string(), z.string());

/** A damaged file reads as empty: the next exchange rewrites it. */
function readApiTokens(): Record<string, string> {
  const saved = readSavedToken(
    apiTokensPath(),
    'saved API tokens',
    "Fix the file's permissions or delete it, then run `anycloud login <api>`.",
  );
  if (!saved) return {};
  try {
    return savedApiTokensSchema.parse(JSON.parse(saved));
  } catch {
    return {};
  }
}

/** The token `anycloud login <api>` saved for a hosted API, or null. */
export function readApiToken(apiUrl: string): string | null {
  return readApiTokens()[normalizeApiUrl(apiUrl)] ?? null;
}

/** Save a hosted API's token, readable only by this user. */
export function saveApiToken(apiUrl: string, token: string): void {
  const path = apiTokensPath();
  const tokens = { ...readApiTokens(), [normalizeApiUrl(apiUrl)]: token };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(tokens, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

let unreadableSignInWarned = false;

/**
 * A local API takes the caller's GitHub sign-in beside its own token, for the
 * features that need GitHub. No other API receives it this way. A sign-in that
 * can't be read counts as signed out, so it never blocks public-image work.
 */
export function githubSignInHeader(apiUrl: string): Record<string, string> {
  const token =
    getLoopbackApiPort(apiUrl) === undefined ? null : optionalGitHubToken();
  return token ? { [GITHUB_TOKEN_HEADER]: token } : {};
}

/** The GitHub sign-in, or null when there is none or it can't be read. */
export function optionalGitHubToken(): string | null {
  try {
    return resolveGitHubToken();
  } catch (error) {
    if (!unreadableSignInWarned) {
      unreadableSignInWarned = true;
      process.stderr.write(
        `Warning: continuing without a GitHub sign-in. ${(error as Error).message}\n`,
      );
    }
    return null;
  }
}
