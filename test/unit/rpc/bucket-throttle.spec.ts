import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';

const THROTTLED_MESSAGE =
  'Azure throttled credential "prod" trying to list buckets (HTTP 429). Retry shortly.';

const throttled = (retryAfter?: string) =>
  Response.json(
    {
      defined: true,
      code: 'BUCKET_THROTTLED',
      status: 503,
      message: THROTTLED_MESSAGE,
    },
    {
      status: 503,
      headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    },
  );
const restarting = () =>
  Response.json(
    {
      defined: true,
      code: 'API_RESTARTING',
      status: 503,
      message: 'API server is restarting',
    },
    { status: 503, headers: { 'Retry-After': '1' } },
  );
const page = () => Response.json({ buckets: [], nextCursor: null });

describe('BUCKET_THROTTLED retries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    // The backoff's jitter at its floor: half of each step.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Answers each request with the next response, the last one thereafter. */
  function client(responses: (() => Response)[]) {
    const sentAt: number[] = [];
    const fetch: typeof globalThis.fetch = async () => {
      sentAt.push(Date.now());
      return responses[Math.min(sentAt.length, responses.length) - 1]();
    };
    const api = createApiClient('token', {
      apiUrl: 'http://api.example.test',
      fetch,
    });
    const waits = () => sentAt.slice(1).map((at, index) => at - sentAt[index]);
    return { api, waits };
  }

  async function settle<T>(call: Promise<T>): Promise<T | unknown> {
    const outcome = call.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    return outcome;
  }

  const list = (api: ReturnType<typeof client>['api']) =>
    api.bucket.list({ params: { credentialName: 'prod' }, query: {} });

  it('waits at least Retry-After, else a jittered backoff from 1 s', async () => {
    const { api, waits } = client([
      () => throttled('3'),
      () => throttled('soon'),
      () => throttled(),
      page,
    ]);
    await expect(settle(list(api))).resolves.toEqual({
      buckets: [],
      nextCursor: null,
    });
    expect(waits()).toEqual([3_000, 1_000, 2_000]);
  });

  it('gives up 30 s after the first throttled answer with its message', async () => {
    const { api, waits } = client([() => throttled('20')]);
    await expect(settle(list(api))).resolves.toMatchObject({
      status: 503,
      code: 'BUCKET_THROTTLED',
      message: THROTTLED_MESSAGE,
    });
    expect(waits()).toEqual([20_000, 10_000]);
  });

  it('gives up after eight retries, backing off to 8 s', async () => {
    const { api, waits } = client([() => throttled()]);
    await expect(settle(list(api))).resolves.toMatchObject({
      code: 'BUCKET_THROTTLED',
    });
    expect(waits()).toEqual([
      500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000,
    ]);
  });

  it('still sends a never-replayed command once', async () => {
    const { api, waits } = client([() => throttled('1'), page]);
    await expect(
      settle(api.apiAccess.grant({ username: 'u' })),
    ).resolves.toMatchObject({ code: 'BUCKET_THROTTLED' });
    expect(waits()).toEqual([]);
  });

  it('keeps the restart ride-out whole after throttling', async () => {
    // 26 restart retries, the last decided 112.5 s in, are the full
    // ride-out; the 30 s of throttling before it takes none of them, nor any
    // of its 120 s.
    const { api, waits } = client([
      ...Array.from({ length: 3 }, () => () => throttled('10')),
      ...Array.from({ length: 26 }, () => restarting),
      page,
    ]);
    await expect(settle(list(api))).resolves.toEqual({
      buckets: [],
      nextCursor: null,
    });
    expect(waits()).toHaveLength(29);
  });

  it('keeps the throttle budget whole after a restart', async () => {
    const { api, waits } = client([
      ...Array.from({ length: 5 }, () => restarting),
      ...Array.from({ length: 8 }, () => () => throttled()),
      page,
    ]);
    await expect(settle(list(api))).resolves.toEqual({
      buckets: [],
      nextCursor: null,
    });
    expect(waits().slice(0, 5)).toEqual([500, 1_000, 2_000, 4_000, 5_000]);
  });
});
