const BUCKET_EXISTS_POSITIVE_TTL_MS = 60_000;
const COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_MS = 10 * 60_000;
const COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_DELAY_MS = 500;
const COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_MAX_DELAY_MS = 5_000;
const COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_BACKOFF_MULTIPLIER = 1.5;

const positiveBucketExists = new Map<string, number>();
const inFlightBucketExists = new Map<string, Promise<boolean>>();
const inFlightBucketUpserts = new Map<string, Promise<void>>();

export type CoordinatedBucketUpsertOptions =
  | {
      shouldRetryFailure?: undefined;
      retryFailuresForMs?: undefined;
      retryDelayMs?: undefined;
    }
  | {
      shouldRetryFailure: (error: unknown) => boolean;
      retryFailuresForMs: number;
      retryDelayMs: number;
      retryMaxDelayMs?: number;
      retryBackoffMultiplier?: number;
      retryJitter?: boolean;
    };

export function coordinatedBucketTransientRetryOptions(
  shouldRetryFailure: (error: unknown) => boolean,
): CoordinatedBucketUpsertOptions {
  return {
    shouldRetryFailure,
    retryFailuresForMs: COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_MS,
    retryDelayMs: COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_DELAY_MS,
    retryMaxDelayMs: COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_MAX_DELAY_MS,
    retryBackoffMultiplier:
      COORDINATED_BUCKET_UPSERT_TRANSIENT_RETRY_BACKOFF_MULTIPLIER,
    retryJitter: true,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stop one caller waiting without transferring ownership of its signal. */
function waitForCoordinatedWork<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(
        signal.reason ??
          new DOMException('The coordinated wait was aborted', 'AbortError'),
      );
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function hasPositiveExists(key: string): boolean {
  const expiresAt = positiveBucketExists.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  positiveBucketExists.delete(key);
  return false;
}

function markBucketExists(key: string): void {
  positiveBucketExists.set(key, Date.now() + BUCKET_EXISTS_POSITIVE_TTL_MS);
}

export function invalidateBucketExists(key: string): void {
  positiveBucketExists.delete(key);
}

export function storageCoordinationKey(parts: string[]): string {
  return JSON.stringify(parts);
}

export async function coordinatedBucketExists(
  key: string,
  checkExists: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (hasPositiveExists(key)) return true;

  const inFlightUpsert = inFlightBucketUpserts.get(key);
  if (inFlightUpsert) {
    try {
      await waitForCoordinatedWork(inFlightUpsert, signal);
      markBucketExists(key);
      return true;
    } catch {
      signal?.throwIfAborted();
      // The existence check below should observe the provider's current state.
    }
  }

  if (hasPositiveExists(key)) return true;

  const existing = inFlightBucketExists.get(key);
  if (existing) return waitForCoordinatedWork(existing, signal);

  const promise = checkExists()
    .then((exists) => {
      if (exists) markBucketExists(key);
      return exists;
    })
    .finally(() => {
      inFlightBucketExists.delete(key);
    });
  inFlightBucketExists.set(key, promise);
  return waitForCoordinatedWork(promise, signal);
}

export async function coordinatedBucketUpsert(
  key: string,
  upsert: () => Promise<void>,
  options: CoordinatedBucketUpsertOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const retryPolicy =
    options.shouldRetryFailure === undefined ? undefined : options;

  for (;;) {
    if (hasPositiveExists(key)) return;

    const existing = inFlightBucketUpserts.get(key);
    if (existing) {
      await waitForCoordinatedWork(existing, signal);
      return;
    }

    const inFlightExists = inFlightBucketExists.get(key);
    if (inFlightExists) {
      try {
        if (await waitForCoordinatedWork(inFlightExists, signal)) return;
      } catch {
        signal?.throwIfAborted();
        // The upsert below is the authoritative operation.
      }
    }

    signal?.throwIfAborted();
    if (hasPositiveExists(key)) return;

    const sessionStartedWhileChecking = inFlightBucketUpserts.get(key);
    if (sessionStartedWhileChecking) {
      await waitForCoordinatedWork(sessionStartedWhileChecking, signal);
      return;
    }

    const promise = runBucketUpsertSession(
      key,
      upsert,
      retryPolicy ?? null,
    ).finally(() => {
      if (inFlightBucketUpserts.get(key) === promise) {
        inFlightBucketUpserts.delete(key);
      }
    });
    inFlightBucketUpserts.set(key, promise);
    await waitForCoordinatedWork(promise, signal);
    return;
  }
}

async function runBucketUpsertSession(
  key: string,
  upsert: () => Promise<void>,
  retryPolicy: Extract<
    CoordinatedBucketUpsertOptions,
    { shouldRetryFailure: (error: unknown) => boolean }
  > | null,
): Promise<void> {
  let retryUntil: number | null = null;
  let retryAttempt = 0;

  for (;;) {
    if (hasPositiveExists(key)) return;

    const inFlightExists = inFlightBucketExists.get(key);
    if (inFlightExists) {
      try {
        if (await inFlightExists) return;
      } catch {
        // The upsert below is the authoritative operation.
      }
    }

    if (hasPositiveExists(key)) return;

    try {
      await upsert();
      markBucketExists(key);
      return;
    } catch (error) {
      if (retryPolicy === null) throw error;
      if (!retryPolicy.shouldRetryFailure(error)) throw error;
      retryUntil ??= Date.now() + retryPolicy.retryFailuresForMs;
      const remainingMs = retryUntil - Date.now();
      if (remainingMs <= 0) throw error;
      const waitMs = getUpsertRetryDelayMs(retryPolicy, retryAttempt);
      retryAttempt += 1;
      if (waitMs > 0) await delay(Math.min(waitMs, remainingMs));
    }
  }
}

function getUpsertRetryDelayMs(
  retryPolicy: Extract<
    CoordinatedBucketUpsertOptions,
    { shouldRetryFailure: (error: unknown) => boolean }
  >,
  retryAttempt: number,
): number {
  const baseDelayMs = retryPolicy.retryDelayMs;
  if (baseDelayMs <= 0) return 0;

  const multiplier = retryPolicy.retryBackoffMultiplier ?? 1;
  const maxDelayMs = retryPolicy.retryMaxDelayMs ?? baseDelayMs;
  const uncappedDelayMs = baseDelayMs * Math.pow(multiplier, retryAttempt);
  const delayMs = Math.min(uncappedDelayMs, maxDelayMs);

  if (retryPolicy.retryJitter === false) return delayMs;
  return Math.max(1, Math.floor(delayMs / 2 + Math.random() * (delayMs / 2)));
}

/** Test-only: clear process-wide storage coordination state. */
export function resetStorageCoordinatorForTests(): void {
  positiveBucketExists.clear();
  inFlightBucketExists.clear();
  inFlightBucketUpserts.clear();
}
