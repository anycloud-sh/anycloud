import { describe, expect, it, vi } from 'vitest';
import {
  readThroughBucketThrottle,
  walkBucketListPages,
} from '../../integration/credentials-onboarding/harness.js';

describe('credential onboarding bucket-list page walker', () => {
  it('aggregates names across pages and forwards each cursor', async () => {
    const readPage = vi.fn(async (cursor?: string): Promise<unknown> => {
      if (cursor === undefined) {
        return {
          buckets: [{ name: 'bucket-a' }, { name: 'bucket-b' }],
          nextCursor: 'page-2',
        };
      }
      if (cursor === 'page-2') {
        return {
          buckets: [{ name: 'bucket-c' }],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected cursor: ${cursor}`);
    });

    await expect(walkBucketListPages(readPage)).resolves.toEqual([
      'bucket-a',
      'bucket-b',
      'bucket-c',
    ]);
    expect(readPage.mock.calls).toEqual([[undefined], ['page-2']]);
  });

  it('completes when the response omits nextCursor', async () => {
    const readPage = vi.fn(
      async (): Promise<unknown> => ({
        buckets: [{ name: 'only-bucket' }],
      }),
    );

    await expect(walkBucketListPages(readPage)).resolves.toEqual([
      'only-bucket',
    ]);
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it.each([null, ''])(
    'treats %j as an exhausted cursor',
    async (nextCursor) => {
      const readPage = vi.fn(
        async (): Promise<unknown> => ({
          buckets: [],
          nextCursor,
        }),
      );

      await expect(walkBucketListPages(readPage)).resolves.toEqual([]);
      expect(readPage).toHaveBeenCalledTimes(1);
    },
  );

  it.each<{
    label: string;
    page: unknown;
    error: RegExp;
  }>([
    {
      label: 'a non-object page',
      page: null,
      error: /expected a JSON object with a buckets array/,
    },
    {
      label: 'a missing buckets array',
      page: {},
      error: /expected a JSON object with a buckets array/,
    },
    {
      label: 'a malformed bucket entry',
      page: { buckets: [{ name: 123 }] },
      error: /invalid bucket at index 0.*non-empty string name/,
    },
    {
      label: 'a malformed cursor',
      page: { buckets: [], nextCursor: 123 },
      error: /invalid nextCursor.*string, null, or no cursor/,
    },
  ])('rejects $label clearly', async ({ page, error }) => {
    await expect(
      walkBucketListPages(async (): Promise<unknown> => page),
    ).rejects.toThrow(error);
  });

  it('rejects a repeated cursor instead of looping forever', async () => {
    const readPage = vi.fn(
      async (cursor?: string): Promise<unknown> => ({
        buckets: [{ name: cursor === undefined ? 'first' : 'second' }],
        nextCursor: 'same-page',
      }),
    );

    await expect(walkBucketListPages(readPage)).rejects.toThrow(
      /repeated pagination cursor: same-page/,
    );
    expect(readPage.mock.calls).toEqual([[undefined], ['same-page']]);
  });
});

// Job 113392661189: one ARM 429 surfaced as BUCKET_THROTTLED and failed the read.
describe('credential onboarding bucket reads under provider throttling', () => {
  const answer = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => new Response(JSON.stringify(body), { status, headers });
  const throttled = (headers?: Record<string, string>) =>
    answer(
      503,
      { defined: true, code: 'BUCKET_THROTTLED', status: 503 },
      headers,
    );

  function clock() {
    let at = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => at,
      random: () => 1,
      wait: async (ms: number) => {
        waits.push(ms);
        at += ms;
      },
    };
  }

  it('retries a throttled read with backoff, honouring Retry-After', async () => {
    const options = clock();
    const send = vi
      .fn<() => Promise<Response>>()
      // An unparseable value keeps the backoff; a valid one lengthens it.
      .mockResolvedValueOnce(throttled({ 'Retry-After': 'soon' }))
      .mockResolvedValueOnce(throttled({ 'Retry-After': '5' }))
      .mockResolvedValueOnce(answer(200, { buckets: [] }));
    const response = await readThroughBucketThrottle(send, options);
    expect(response.status).toBe(200);
    expect(options.waits).toEqual([1_000, 5_000]);
  });

  it('returns the last throttled answer once about 30 s are spent', async () => {
    const options = clock();
    const send = vi.fn(async () => throttled());
    const response = await readThroughBucketThrottle(send, options);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'BUCKET_THROTTLED',
    });
    expect(options.waits).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 7_000]);
  });

  it('caps a Retry-After beyond the budget at the deadline', async () => {
    const options = clock();
    const send = vi.fn(async () => throttled({ 'Retry-After': '120' }));
    const response = await readThroughBucketThrottle(send, options);
    expect(response.status).toBe(503);
    expect(options.waits).toEqual([30_000]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, { defined: true, code: 'BUCKET_ACCESS_DENIED', status: 403 }],
    [503, { defined: true, code: 'BUCKET_CREDENTIAL_NOT_READY', status: 503 }],
    [503, 'not json'],
    [404, { defined: true, code: 'BUCKET_NOT_FOUND', status: 404 }],
  ])('answers HTTP %i (%j) without retrying', async (status, body) => {
    const options = clock();
    const send = vi.fn(async () => answer(status, body));
    const response = await readThroughBucketThrottle(send, options);
    expect(response.status).toBe(status);
    expect(send).toHaveBeenCalledTimes(1);
    expect(options.waits).toEqual([]);
  });
});
