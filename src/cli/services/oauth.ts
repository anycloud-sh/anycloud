import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { githubTokenPath } from '../../shared/config.js';
import { GITHUB_LOGIN_SCOPES } from '../../shared/hosted-api.js';
import { openInBrowser } from '../utils/browser.js';
import {
  printSuccess,
  printInfo,
  printError,
  printHighlight,
  createSpinner,
  exitWithActionRequired,
} from '../utils/output.js';

// Under IS_TEST, ANYCLOUD_GITHUB_URL points the device flow at a fake GitHub.
function githubUrl(path: string, host = 'https://github.com'): string {
  const testUrl =
    process.env.IS_TEST === 'true'
      ? process.env.ANYCLOUD_GITHUB_URL
      : undefined;
  return `${testUrl ?? host}${path}`;
}

const CLIENT_ID = 'Ov23liaPWSFbk7P7XDEY';
const SCOPE = GITHUB_LOGIN_SCOPES.join(' ');

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string; // Pre-filled URL from GitHub
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  interval?: number;
  error?: string;
  error_description?: string;
}

/**
 * Initiate GitHub OAuth Device Flow
 * Returns an access token after user authorization
 */
export async function authenticateWithGitHub(): Promise<string> {
  try {
    // Step 1: Get device code and user code
    const deviceCodeData = await getDeviceCode();
    const { url } = pendingSignIn(deviceCodeData);

    // Step 2: Display user code and verification URL
    console.log('');
    printInfo(`Continue GitHub Authentication at ${url}`);
    console.log('');
    printHighlight(`Your one-time code: ${deviceCodeData.user_code}`);
    console.log('');

    // Step 3: Open browser if a display is available
    await openInBrowser(url, {
      unavailable: 'Open the URL above in a browser to authenticate',
      failed: 'If the browser did not open, use the URL above',
    });

    // Step 4: Poll for access token
    console.log('');
    const spinner = createSpinner(
      'Waiting for GitHub authorization...',
    ).start();
    const token = await pollForToken(
      deviceCodeData.device_code,
      deviceCodeData.interval,
      deviceCodeData.expires_in,
    );
    spinner.succeed('Successfully authenticated with GitHub!');

    // Step 5: Save token
    await writePrivate(githubTokenPath(), token);

    console.log('');
    printSuccess('Token saved successfully');
    printInfo(`Token stored at: ${githubTokenPath()}`);

    return token;
  } catch (error) {
    printError(`Authentication failed: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Get device code and user code from GitHub
 */
async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(githubUrl('/login/device/code'), {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  });

  if (!response.ok) {
    let errorDetails = '';
    try {
      const errorBody = (await response.json()) as any;
      errorDetails = errorBody.error_description || errorBody.error || '';
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(
      `Failed to get device code: ${response.statusText}${errorDetails ? ` - ${errorDetails}` : ''}`,
    );
  }

  const data = (await response.json()) as DeviceCodeResponse;

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error('Invalid response from GitHub');
  }

  return data;
}

/**
 * Poll GitHub for access token
 */
async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<string> {
  // Add 1 second to interval for safety
  const pollInterval = (interval + 1) * 1000;
  const startTime = Date.now();
  const timeout = expiresIn * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check if we've exceeded the timeout
    if (Date.now() - startTime > timeout) {
      throw new Error('Device code expired. Please try again.');
    }

    // Wait for the interval before polling
    await sleep(pollInterval);

    const data = await requestToken(deviceCode);

    // Success - we got the token!
    if (data.access_token) {
      return data.access_token;
    }

    // Still waiting for user to authorize
    if (data.error === 'authorization_pending') {
      continue;
    }

    // Slow down polling if requested
    if (data.error === 'slow_down') {
      // GitHub asks us to slow down, wait an extra interval
      await sleep(pollInterval);
      continue;
    }

    // Any other error is a failure
    if (data.error) throw tokenError(data);
  }
}

async function requestToken(
  deviceCode: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const response = await fetch(githubUrl('/login/oauth/access_token'), {
    signal,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to poll for token: ${response.statusText}`);
  }

  return (await response.json()) as TokenResponse;
}

function tokenError(data: TokenResponse): Error {
  return new Error(
    `GitHub authentication failed: ${data.error}${data.error_description ? ` - ${data.error_description}` : ''}`,
  );
}

/** A relayed code awaiting approval. `deviceCode` buys a token: owner-only, never printed. */
interface PendingSignIn {
  deviceCode: string;
  userCode: string;
  url: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
}

function pendingPath(): string {
  return join(dirname(githubTokenPath()), 'github-device.json');
}

function pendingSignIn(data: DeviceCodeResponse): PendingSignIn {
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    // Use verification_uri_complete if GitHub provides it, otherwise construct manually
    url:
      data.verification_uri_complete ||
      `${data.verification_uri}?user_code=${data.user_code}`,
    expiresAt: Date.now() + data.expires_in * 1000,
    interval: data.interval,
    nextPollAt: 0,
  };
}

/** The unexpired pending sign-in, if any; an expired or unreadable one is removed. */
async function readPending(): Promise<PendingSignIn | null> {
  const text = await readFile(pendingPath(), 'utf-8').catch(() => null);
  let pending: PendingSignIn | null = null;
  try {
    pending = text ? (JSON.parse(text) as PendingSignIn) : null;
  } catch {
    // A torn file counts as none and is replaced by a fresh code.
  }
  if (pending && pending.expiresAt > Date.now()) return pending;
  await rm(pendingPath(), { force: true });
  return null;
}

/**
 * Exchange a pending device code once, without waiting and no sooner than
 * GitHub's interval allows; null until approved. A refused or expired code is
 * removed, so the next relay asks for a fresh one.
 */
export async function completePendingSignIn(): Promise<string | null> {
  const pending = await readPending();
  if (!pending || Date.now() < pending.nextPollAt) return null;
  // Set first, so an offline machine waits an interval before trying again.
  pending.nextPollAt = Date.now() + pending.interval * 1000;
  await writePrivate(pendingPath(), JSON.stringify(pending));
  const data = await requestToken(
    pending.deviceCode,
    AbortSignal.timeout(2000),
  );
  if (data.error === 'slow_down') {
    pending.interval = data.interval ?? pending.interval + 5;
    pending.nextPollAt = Date.now() + pending.interval * 1000;
    await writePrivate(pendingPath(), JSON.stringify(pending));
  }
  if (data.error === 'authorization_pending' || data.error === 'slow_down') {
    return null;
  }
  await rm(pendingPath(), { force: true });
  if (data.error === 'expired_token' || data.error === 'access_denied') {
    return null;
  }
  if (!data.access_token) throw tokenError(data);
  await writePrivate(githubTokenPath(), data.access_token);
  console.error('   ✓ Signed in with GitHub.');
  return data.access_token;
}

/** The GitHub account a token signs in as: its immutable id and login. */
export async function gitHubUser(
  token: string,
): Promise<{ id: string; username: string }> {
  const response = await fetch(githubUrl('/user', 'https://api.github.com'), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub did not name the signed-in account (HTTP ${response.status}); run anycloud login`,
    );
  }
  const user = (await response.json()) as { id?: number; login?: string };
  if (user.id === undefined || !user.login) {
    throw new Error('GitHub did not name the signed-in account');
  }
  return { id: String(user.id), username: user.login };
}

/** Whether GitHub still accepts a saved sign-in; only a 401 means it doesn't. */
export async function gitHubAccepts(token: string): Promise<boolean> {
  const response = await fetch(githubUrl('/user', 'https://api.github.com'), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) return false;
  if (!response.ok) {
    throw new Error(
      `GitHub could not check the sign-in (HTTP ${response.status})`,
    );
  }
  return true;
}

/**
 * Relay the device URL and user code as `actionRequired` and exit instead of
 * waiting. Repeated runs relay the same unexpired code.
 */
export async function relayGitHubSignIn(
  reason = 'GitHub sign-in required.',
  exitCode = 1,
): Promise<never> {
  let pending = await readPending();
  if (!pending) {
    pending = pendingSignIn(await getDeviceCode());
    await writePrivate(pendingPath(), JSON.stringify(pending));
  }
  return exitWithActionRequired(
    {
      code: 'GITHUB_SIGN_IN_REQUIRED',
      message: `${reason} Ask the user to open ${pending.url} and enter the code ${pending.userCode} to approve it; the next anycloud command completes the sign-in.`,
      url: pending.url,
      userCode: pending.userCode,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    },
    exitCode,
  );
}

/**
 * Replace a file with one readable only by its owner. The rename means a
 * reader never sees it half written, and an older file's mode doesn't carry over.
 */
async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
