import { describe, expect, it, vi } from 'vitest';

import {
  LambdaReleaseVerificationError,
  requestLambdaInstanceTermination,
  verifyLambdaInstanceReleased,
} from '../../integration/helpers/lambda-release-verifier.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function testClock() {
  let current = 0;
  return {
    delay: vi.fn(async (ms: number) => {
      current += ms;
    }),
    now: () => current,
  };
}

describe('independent Lambda release verifier', () => {
  it('requires two complete point/list agreements ten seconds apart', async () => {
    const clock = testClock();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: { id: 'vm-1', status: 'terminated' } }),
      )
      .mockResolvedValueOnce(response({ data: [], page_token: null }))
      .mockResolvedValueOnce(
        response({ data: { id: 'vm-1', status: 'terminated' } }),
      )
      .mockResolvedValueOnce(response({ data: [], page_token: null }));

    await verifyLambdaInstanceReleased({
      apiKey: 'key',
      delay: clock.delay,
      fetch,
      instanceId: 'vm-1',
      now: clock.now,
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(clock.delay).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it('rejects a list page that has a later page', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: { id: 'vm-1', status: 'terminated' } }),
      )
      .mockResolvedValueOnce(response({ data: [], page_token: 'p2' }));

    await expect(
      verifyLambdaInstanceReleased({
        apiKey: 'key',
        ...testClock(),
        fetch,
        instanceId: 'vm-1',
      }),
    ).rejects.toThrow(/partial page/);
  });

  it('does not pass while the exact instance remains live in the list view', async () => {
    const clock = testClock();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ data: { id: 'vm-1', status: 'terminated' } }),
      )
      .mockResolvedValueOnce(
        response({ data: [{ id: 'vm-1', status: 'terminating' }] }),
      )
      .mockResolvedValueOnce(
        response({ data: { id: 'vm-1', status: 'terminated' } }),
      )
      .mockResolvedValueOnce(response({ data: [{ id: 'other-vm' }] }))
      .mockResolvedValueOnce(
        response({ data: { id: 'vm-1', status: 'terminated' } }),
      )
      .mockResolvedValueOnce(response({ data: [] }));

    await verifyLambdaInstanceReleased({
      apiKey: 'key',
      delay: clock.delay,
      fetch,
      instanceId: 'vm-1',
      now: clock.now,
    });

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(clock.delay.mock.calls).toEqual([[2_000], [10_000]]);
  });

  it('retries a throttled observation but fails auth errors immediately', async () => {
    const clock = testClock();
    const throttledFetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'throttled' }, 429))
      .mockResolvedValueOnce(response({ error: 'missing' }, 404))
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ error: 'missing' }, 404))
      .mockResolvedValueOnce(response({ data: [] }));

    await verifyLambdaInstanceReleased({
      apiKey: 'key',
      delay: clock.delay,
      fetch: throttledFetch,
      instanceId: 'vm-1',
      now: clock.now,
    });
    expect(clock.delay.mock.calls).toEqual([[2_000], [10_000]]);

    const authFetch = vi
      .fn()
      .mockResolvedValue(response({ error: 'unauthorized' }, 401));
    await expect(
      verifyLambdaInstanceReleased({
        apiKey: 'bad-key',
        delay: clock.delay,
        fetch: authFetch,
        instanceId: 'vm-1',
        now: clock.now,
      }),
    ).rejects.toBeInstanceOf(LambdaReleaseVerificationError);
    expect(authFetch).toHaveBeenCalledOnce();
  });

  it('retries a throttled termination request without proactive pacing', async () => {
    const clock = testClock();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'throttled' }, 429))
      .mockResolvedValueOnce(
        response({ data: { terminated_instances: [{ id: 'vm-1' }] } }),
      );

    await requestLambdaInstanceTermination({
      apiKey: 'key',
      delay: clock.delay,
      fetch,
      instanceId: 'vm-1',
      now: clock.now,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(clock.delay).toHaveBeenCalledExactlyOnceWith(2_000);
  });
});
