import packageJson from '../../../../package.json' with { type: 'json' };
import {
  getApiUrl,
  getLoopbackApiPort,
  normalizeApiUrl,
  type ResolvedApiTarget,
} from '../../config.js';
import type { LocalApiContainerInspection } from '../../local-api-container.js';
import { errorMessage } from '../../log-diagnostics.js';

const API_VERSION_CHECK_TIMEOUT_MS = 3000;

export interface ApiVersionCheck {
  url: string;
  cliVersion: string;
  apiVersion?: string;
  compatible: boolean;
  reason?: string;
}

export function getAnycloudVersion(): string {
  return packageJson.version;
}

export function createAbortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : createAbortError();
}

export async function checkApiVersion(
  apiUrl = getApiUrl(),
  signal?: AbortSignal,
): Promise<ApiVersionCheck> {
  const url = normalizeApiUrl(apiUrl);
  const cliVersion = getAnycloudVersion();
  const timeoutSignal = AbortSignal.timeout(API_VERSION_CHECK_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    throwIfAborted(signal);
    const response = await fetch(`${url}/v1/version`, {
      signal: requestSignal,
    });
    if (!response.ok) {
      return {
        url,
        cliVersion,
        compatible: false,
        reason: `/v1/version returned HTTP ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        url,
        cliVersion,
        compatible: false,
        reason: '/v1/version did not return JSON',
      };
    }

    const apiVersion =
      body && typeof body === 'object' && 'version' in body
        ? body.version
        : undefined;
    if (typeof apiVersion !== 'string' || apiVersion.length === 0) {
      return {
        url,
        cliVersion,
        compatible: false,
        reason: '/v1/version response is missing version',
      };
    }

    // An API one release newer still serves this CLI's workload calls.
    const compatible =
      apiVersion === cliVersion ||
      (typeof body === 'object' &&
        body !== null &&
        'previousVersion' in body &&
        body.previousVersion === cliVersion);
    return {
      url,
      cliVersion,
      apiVersion,
      compatible,
      ...(compatible ? {} : { reason: `API version is ${apiVersion}` }),
    };
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    const message =
      timeoutSignal.aborted || isAbortError(error) || isTimeoutError(error)
        ? `timed out after ${API_VERSION_CHECK_TIMEOUT_MS}ms`
        : errorMessage(error);
    return {
      url,
      cliVersion,
      compatible: false,
      reason: `could not read /v1/version: ${message}`,
    };
  }
}

let preFlightCheck: (() => LocalApiContainerInspection) | null = null;

export function setPreFlightCheck(
  check: (() => LocalApiContainerInspection) | null,
): void {
  preFlightCheck = check;
}

function localApiPreFlightErrorMessage(
  inspection: LocalApiContainerInspection,
): string {
  switch (inspection.failure) {
    case 'timeout':
      return 'Timed out checking the local API container. Check that Docker is responsive.';
    case 'unavailable':
      return 'Docker is unavailable. Start Docker and try again.';
    case 'malformed':
      return 'Docker returned an invalid response while checking the local API container.';
    case 'missing':
    case undefined:
      return 'No local API is running. Run `anycloud api start`.';
  }
}

/** The local API is not running or could not be checked; retrying will not help. */
export class LocalApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalApiUnavailableError';
  }
}

/** Throws unless the local API runs; true only when Docker confirmed it. */
export function assertLocalApiRunning(
  target: Pick<ResolvedApiTarget, 'url' | 'localApiContainer'>,
): boolean {
  const { url } = target;
  if (
    process.env.IS_TEST === 'true' ||
    !preFlightCheck ||
    getLoopbackApiPort(url) === undefined
  ) {
    return false;
  }

  const inspection = target.localApiContainer ?? preFlightCheck();
  if (!inspection.running) {
    throw new LocalApiUnavailableError(
      localApiPreFlightErrorMessage(inspection),
    );
  }
  return true;
}
