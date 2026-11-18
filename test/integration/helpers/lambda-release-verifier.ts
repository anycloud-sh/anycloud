const LAMBDA_API = 'https://cloud.lambda.ai/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RELEASE_DEADLINE_MS = 5 * 60_000;
const DEFAULT_RELEASE_STABILITY_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

type Presence = 'absent' | 'present' | 'unknown';

interface HttpResult {
  readonly body: unknown;
  readonly bodyText: string;
  readonly status: number;
}

interface VerificationDependencies {
  readonly delay?: (ms: number) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface LambdaReleaseObservation {
  readonly completedAt: number;
  readonly diagnostic: string;
  readonly presence: Presence;
}

export interface LambdaReleaseVerificationOptions
  extends VerificationDependencies {
  readonly apiKey: string;
  readonly deadlineMs?: number;
  readonly instanceId: string;
  readonly onObservation?: (observation: LambdaReleaseObservation) => void;
  readonly retryDelayMs?: number;
  readonly stabilityIntervalMs?: number;
}

export class LambdaReleaseVerificationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseDiagnostic(result: HttpResult): string {
  return result.bodyText.replaceAll(/\s+/gu, ' ').trim().slice(0, 300);
}

async function request(
  fetchFn: typeof globalThis.fetch,
  now: () => number,
  deadlineAt: number,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) throw new Error('verification deadline exceeded');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Lambda request deadline exceeded')),
    Math.min(REQUEST_TIMEOUT_MS, remainingMs),
  );
  timeout.unref?.();
  try {
    const response = await fetchFn(`${LAMBDA_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let body: unknown;
    try {
      body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    return { body, bodyText, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function pointPresence(result: HttpResult): Presence {
  if (
    result.status === 404 ||
    result.bodyText.includes('object-does-not-exist')
  ) {
    return 'absent';
  }
  if (result.status === 429 || result.status >= 500) return 'unknown';
  if (result.status !== 200) {
    throw new LambdaReleaseVerificationError(
      `Lambda point verification returned HTTP ${result.status}: ${responseDiagnostic(result)}`,
    );
  }
  if (!isRecord(result.body) || !isRecord(result.body.data)) {
    throw new LambdaReleaseVerificationError(
      'Lambda point verification returned an unrecognized response',
    );
  }
  const status = text(result.body.data.status);
  if (!status) {
    throw new LambdaReleaseVerificationError(
      'Lambda point verification omitted the instance status',
    );
  }
  return status === 'terminated' ? 'absent' : 'present';
}

function listPresence(result: HttpResult, instanceId: string): Presence {
  if (result.status === 429 || result.status >= 500) return 'unknown';
  if (result.status !== 200) {
    throw new LambdaReleaseVerificationError(
      `Lambda list verification returned HTTP ${result.status}: ${responseDiagnostic(result)}`,
    );
  }
  if (!isRecord(result.body) || !Array.isArray(result.body.data)) {
    throw new LambdaReleaseVerificationError(
      'Lambda list verification returned an unrecognized response',
    );
  }
  // A later page could still hold the instance, so only the last page counts.
  if (result.body.page_token != null) {
    throw new LambdaReleaseVerificationError(
      'Lambda list verification returned a partial page',
    );
  }
  const matches = result.body.data
    .filter(isRecord)
    .filter((instance) => text(instance.id) === instanceId);
  if (matches.length === 0) return 'absent';
  const statuses = matches.map((instance) => text(instance.status));
  if (statuses.some((status) => !status)) {
    throw new LambdaReleaseVerificationError(
      'Lambda list verification omitted the instance status',
    );
  }
  return statuses.every((status) => status === 'terminated')
    ? 'absent'
    : 'present';
}

export async function observeLambdaInstanceReleaseOnce(
  options: Pick<LambdaReleaseVerificationOptions, 'apiKey' | 'instanceId'> &
    VerificationDependencies & { readonly deadlineAt: number },
): Promise<LambdaReleaseObservation> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  let point: HttpResult;
  try {
    point = await request(
      fetchFn,
      now,
      options.deadlineAt,
      options.apiKey,
      `/instances/${encodeURIComponent(options.instanceId)}`,
    );
  } catch (error) {
    return {
      completedAt: now(),
      diagnostic: `point request failed: ${String(error)}`,
      presence: 'unknown',
    };
  }
  const pointResult = pointPresence(point);
  if (pointResult !== 'absent') {
    return {
      completedAt: now(),
      diagnostic: `point=HTTP ${point.status}`,
      presence: pointResult,
    };
  }

  let list: HttpResult;
  try {
    list = await request(
      fetchFn,
      now,
      options.deadlineAt,
      options.apiKey,
      '/instances',
    );
  } catch (error) {
    return {
      completedAt: now(),
      diagnostic: `point=HTTP ${point.status}, list request failed: ${String(error)}`,
      presence: 'unknown',
    };
  }
  const listResult = listPresence(list, options.instanceId);
  return {
    completedAt: now(),
    diagnostic: `point=HTTP ${point.status}, list=HTTP ${list.status}`,
    presence:
      listResult === 'present'
        ? 'present'
        : listResult === 'absent'
          ? 'absent'
          : 'unknown',
  };
}

export async function verifyLambdaInstanceReleased(
  options: LambdaReleaseVerificationOptions,
): Promise<void> {
  const delay = options.delay ?? defaultDelay;
  const now = options.now ?? (() => Date.now());
  const deadlineAt =
    now() + (options.deadlineMs ?? DEFAULT_RELEASE_DEADLINE_MS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const stabilityIntervalMs =
    options.stabilityIntervalMs ?? DEFAULT_RELEASE_STABILITY_MS;
  let firstAbsentCompletedAt: number | undefined;
  let lastDiagnostic = 'no observations completed';

  while (now() < deadlineAt) {
    const observation = await observeLambdaInstanceReleaseOnce({
      apiKey: options.apiKey,
      deadlineAt,
      fetch: options.fetch,
      instanceId: options.instanceId,
      now,
    });
    options.onObservation?.(observation);
    lastDiagnostic = observation.diagnostic;

    if (observation.presence === 'absent') {
      if (
        firstAbsentCompletedAt !== undefined &&
        observation.completedAt - firstAbsentCompletedAt >= stabilityIntervalMs
      ) {
        return;
      }
      firstAbsentCompletedAt ??= observation.completedAt;
    } else {
      firstAbsentCompletedAt = undefined;
    }

    const waitMs =
      firstAbsentCompletedAt === undefined
        ? retryDelayMs
        : Math.max(0, firstAbsentCompletedAt + stabilityIntervalMs - now());
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(waitMs, remainingMs));
  }

  throw new LambdaReleaseVerificationError(
    `Lambda instance ${options.instanceId} was not stably released before the deadline (${lastDiagnostic})`,
  );
}

export async function requestLambdaInstanceTermination(
  options: Pick<LambdaReleaseVerificationOptions, 'apiKey' | 'instanceId'> &
    VerificationDependencies & { readonly deadlineMs?: number },
): Promise<void> {
  const delay = options.delay ?? defaultDelay;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const deadlineAt = now() + (options.deadlineMs ?? 30_000);
  let lastDiagnostic = 'no response';

  while (now() < deadlineAt) {
    let result: HttpResult;
    try {
      result = await request(
        fetchFn,
        now,
        deadlineAt,
        options.apiKey,
        '/instance-operations/terminate',
        {
          body: JSON.stringify({ instance_ids: [options.instanceId] }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
    } catch (error) {
      lastDiagnostic = String(error);
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) break;
      await delay(Math.min(DEFAULT_RETRY_DELAY_MS, remainingMs));
      continue;
    }

    lastDiagnostic = `HTTP ${result.status}: ${responseDiagnostic(result)}`;
    if (
      (result.status >= 200 && result.status < 300) ||
      result.status === 404 ||
      result.bodyText.includes('object-does-not-exist')
    ) {
      return;
    }
    if (result.status !== 429 && result.status < 500) {
      throw new LambdaReleaseVerificationError(
        `Lambda termination for ${options.instanceId} failed (${lastDiagnostic})`,
      );
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(DEFAULT_RETRY_DELAY_MS, remainingMs));
  }

  throw new LambdaReleaseVerificationError(
    `Lambda termination for ${options.instanceId} remained inconclusive (${lastDiagnostic})`,
  );
}
