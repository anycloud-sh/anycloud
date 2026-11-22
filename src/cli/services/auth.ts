import { ORPCError } from '@orpc/client';
import { SIGN_IN_INSTRUCTION_PATTERN } from '../../shared/errors.js';
import {
  getApiUrl,
  getLoopbackApiPort,
  localApiTokenPath,
  normalizeApiUrl,
  resolveApiTarget,
} from '../../shared/config.js';
import {
  createApiClient,
  type ApiClient,
  type CreateApiClientOptions,
} from '../../shared/services/api-client/rpc.js';
import { assertLocalApiRunning } from '../../shared/services/api-client/runtime.js';
import {
  readApiToken,
  readLocalApiToken,
  resolveGitHubToken,
  optionalGitHubToken,
  saveApiToken,
} from '../../shared/services/auth.js';
import { exitWithError, printInfo } from '../utils/output.js';
import { authenticateWithGitHub, relayGitHubSignIn } from './oauth.js';
import { isUnattended } from '../session/detect.js';

/**
 * Get the GitHub access token from resolveGitHubToken, else run the OAuth
 * device flow: in a terminal it prints the URL and code, then polls; without
 * one it relays them as `actionRequired`. GitHub receives it, and a
 * hosted API exchanges it for that API's token.
 */
export async function getGitHubToken(missingExitCode = 1): Promise<string> {
  const token = resolveGitHubToken();
  if (token) {
    return token;
  }

  if (isUnattended()) {
    return relayGitHubSignIn(undefined, missingExitCode);
  }

  console.log('');
  printInfo('No GitHub token found. Starting authentication...');
  console.log('');

  return await authenticateWithGitHub();
}

function isSignInRequired(error: unknown): error is ORPCError<string, unknown> {
  return error instanceof ORPCError && error.code === 'GITHUB_SIGN_IN_REQUIRED';
}

/** GITHUB_SIGN_IN_REQUIRED: `refresh` once and retry, else relay when unattended. */
function signInRecovery(
  missingExitCode: number,
  refresh?: () => Promise<boolean>,
): NonNullable<CreateApiClientOptions['interceptors']>[number] {
  return async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      let failure = error;
      if (refresh && isSignInRequired(failure)) {
        try {
          if (await refresh()) return await next();
        } catch (retryError) {
          failure = retryError;
        }
      }
      if (isSignInRequired(failure) && isUnattended()) {
        return relayGitHubSignIn(
          failure.message.replace(SIGN_IN_INSTRUCTION_PATTERN, '').trim(),
          missingExitCode,
        );
      }
      throw failure;
    }
  };
}

/** Exchange the GitHub sign-in for a hosted API's token and save it. */
export async function exchangeApiToken(
  apiUrl: string,
  githubToken: string,
): Promise<string> {
  const { token } = await createApiClient(githubToken, {
    apiUrl,
    interceptors: [signInRecovery(1)],
  }).apiAccess.exchangeToken({});
  saveApiToken(apiUrl, token);
  return token;
}

/** `ANYCLOUD_API_TOKEN`, only when `API_URL` names the same API. */
function environmentApiToken(apiUrl: string): string | undefined {
  const envUrl = process.env.API_URL?.trim();
  return envUrl && normalizeApiUrl(envUrl) === apiUrl
    ? process.env.ANYCLOUD_API_TOKEN?.trim() || undefined
    : undefined;
}

/** `ANYCLOUD_API_TOKEN`, the saved token, or an exchange; null when signed out. */
export async function hostedApiBearer(
  apiUrl: string,
  signIn: () => Promise<string | null>,
): Promise<string | null> {
  const fromEnv = environmentApiToken(apiUrl);
  if (fromEnv) return fromEnv;
  const saved = readApiToken(apiUrl);
  if (saved) return saved;
  const githubToken = await signIn();
  if (!githubToken) return null;
  return exchangeApiToken(apiUrl, githubToken);
}

/**
 * The bearer `apiUrl` takes: a local API's per-install token, which never
 * leaves this machine, or a hosted API's own token.
 */
async function bearerFor(
  apiUrl: string,
  missingExitCode: number,
): Promise<string> {
  if (getLoopbackApiPort(apiUrl) === undefined) {
    const bearer = await hostedApiBearer(apiUrl, () =>
      getGitHubToken(missingExitCode),
    );
    if (!bearer) exitWithError('No GitHub sign-in found.', missingExitCode);
    return bearer;
  }
  const token = readLocalApiToken();
  if (token) return token;
  // Without its token there is usually no local API at all; say that first.
  let running = false;
  try {
    running = assertLocalApiRunning({ url: apiUrl });
  } catch (error) {
    exitWithError((error as Error).message, missingExitCode);
  }
  // A running API without a token here started before this release (a CLI
  // reinstalled without `anycloud update`), or under another ANYCLOUD_DIR.
  exitWithError(
    running
      ? `A local API is running, but there is no local API token at ${localApiTokenPath()}.\n` +
          '   If it is from an earlier release, run `anycloud update` to restart it on this release. Otherwise run the CLI as the user who started it, with the same ANYCLOUD_DIR.'
      : `No local API token at ${localApiTokenPath()}.\n` +
          '   Start the local API with `anycloud api start`, as the same user and with the same ANYCLOUD_DIR.',
    missingExitCode,
  );
}

export interface CliApiOptions extends CreateApiClientOptions {
  /** Exit code when no bearer is available (`wait` reports observer errors). */
  missingExitCode?: number;
}

/** A client for the active API, or `apiUrl`, carrying the bearer that API takes. */
export async function apiClient(
  options: CliApiOptions = {},
): Promise<ApiClient> {
  const { missingExitCode = 1, ...clientOptions } = options;
  const { apiUrl, ...rest } = clientOptions;
  // Resolved once, so the local API's Docker inspection is reused per request.
  const target = apiUrl ? { url: normalizeApiUrl(apiUrl) } : resolveApiTarget();
  // A hosted API's stale stored sign-in is replaced with this machine's,
  // unless the bearer is ANYCLOUD_API_TOKEN, whose account may be another.
  const refreshable =
    getLoopbackApiPort(target.url) === undefined &&
    !environmentApiToken(target.url);
  return createApiClient(await bearerFor(target.url, missingExitCode), {
    ...rest,
    target,
    interceptors: [
      signInRecovery(
        missingExitCode,
        refreshable
          ? async () => {
              const githubToken = optionalGitHubToken();
              if (githubToken === null) return false;
              await exchangeApiToken(target.url, githubToken);
              return true;
            }
          : undefined,
      ),
    ],
  });
}

/**
 * The active API's bearer, for its native streaming and upload routes only.
 * Never hand it to anything that isn't an Anycloud API client.
 */
export async function nativeApiBearer(missingExitCode = 1): Promise<string> {
  return bearerFor(getApiUrl(), missingExitCode);
}
