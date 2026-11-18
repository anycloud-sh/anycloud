import { describe, expect, it, vi } from 'vitest';
import {
  assertSmolvmHealth,
  isSmolvmNotFound,
  isSmolvmPortInUse,
  parseSmolvmHealth,
  SmolvmServeClient,
  SmolvmServeError,
} from '../../../../src/api/services/gateways/smolvm-serve-client';

/** Never answers; records each request's signal so the test can drive its deadline. */
function hangUntilAborted(signals: AbortSignal[]): typeof fetch {
  return vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SmolvmServeClient', () => {
  it('calls the smolvm serve lifecycle endpoints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(jsonResponse([{ name: 'ac-local-a' }]))
      .mockResolvedValueOnce(jsonResponse({ name: 'ac-local-a' }))
      .mockResolvedValueOnce(jsonResponse({ name: 'ac-local-a' }))
      .mockResolvedValueOnce(
        jsonResponse({ exitCode: 0, stdout: 'ready\n', stderr: '' }),
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'ac-local-a' }))
      .mockResolvedValueOnce(jsonResponse({ deleted: 'ac-local-a' }));
    const client = new SmolvmServeClient({
      baseUrl: 'http://127.0.0.1:4545/',
      fetchImpl,
    });

    await expect(client.health()).resolves.toBe('ok');
    await expect(client.listMachines()).resolves.toEqual([
      { name: 'ac-local-a' },
    ]);
    await client.createMachine({
      name: 'ac-local-a',
      network: true,
      networkBackend: 'virtio-net',
      ports: [{ host: 2201, guest: 22 }],
    });
    await client.startMachine('ac-local-a');
    await client.execMachine('ac-local-a', {
      command: ['/bin/sh', '-lc', 'true'],
      timeoutSecs: 5,
    });
    await client.stopMachine('ac-local-a');
    await client.deleteMachine('ac-local-a');

    expect(
      fetchImpl.mock.calls.map(([url, init]) => [String(url), init]),
    ).toEqual([
      [
        'http://127.0.0.1:4545/health',
        expect.objectContaining({ method: 'GET' }),
      ],
      [
        'http://127.0.0.1:4545/api/v1/machines',
        expect.objectContaining({ method: 'GET' }),
      ],
      [
        'http://127.0.0.1:4545/api/v1/machines',
        expect.objectContaining({ method: 'POST' }),
      ],
      [
        'http://127.0.0.1:4545/api/v1/machines/ac-local-a/start',
        expect.objectContaining({ method: 'POST' }),
      ],
      [
        'http://127.0.0.1:4545/api/v1/machines/ac-local-a/exec',
        expect.objectContaining({ method: 'POST' }),
      ],
      [
        'http://127.0.0.1:4545/api/v1/machines/ac-local-a/stop',
        expect.objectContaining({ method: 'POST' }),
      ],
      [
        'http://127.0.0.1:4545/api/v1/machines/ac-local-a?force=true',
        expect.objectContaining({ method: 'DELETE' }),
      ],
    ]);
  });

  it('serializes a stopped-image source and host mounts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ name: 'ac-local-cold' }));
    const client = new SmolvmServeClient({
      baseUrl: 'http://127.0.0.1:4545',
      fetchImpl,
    });

    await client.createMachine({
      name: 'ac-local-cold',
      from: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      mounts: [
        {
          source: '/var/lib/anycloud-test/local/buckets',
          target: '/var/lib/anycloud/buckets',
          readonly: false,
        },
      ],
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'ac-local-cold',
      from: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      mounts: [
        {
          source: '/var/lib/anycloud-test/local/buckets',
          target: '/var/lib/anycloud/buckets',
          readonly: false,
        },
      ],
    });
  });

  it('surfaces status and body for API errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: 'machine not found' }, { status: 404 }),
      );
    const client = new SmolvmServeClient({
      baseUrl: 'http://127.0.0.1:4545',
      fetchImpl,
    });
    await expect(client.getMachine('missing')).rejects.toMatchObject({
      name: 'SmolvmServeError',
      status: 404,
      body: { error: 'machine not found' },
    } satisfies Partial<SmolvmServeError>);
  });

  // smolvm withholds response headers until the guest command finishes, so the
  // client deadline has to outlast the exec's own timeoutSecs. Otherwise a slow
  // bootstrap is aborted by the caller while the server is still running it.
  it('extends the request deadline to cover an exec timeoutSecs', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const client = new SmolvmServeClient({
        baseUrl: 'http://127.0.0.1:4545',
        fetchImpl: hangUntilAborted(signals),
      });

      const exec = client.execMachine('ac-local-a', {
        command: ['/bin/sh', '-lc', 'true'],
        timeoutSecs: 60,
      });
      const rejection = expect(exec).rejects.toThrow(
        'smolvm serve request failed',
      );

      await vi.advanceTimersByTimeAsync(31_000);
      expect(signals[0].aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(signals[0].aborted).toBe(true);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the default deadline for calls without an exec timeout', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const client = new SmolvmServeClient({
        baseUrl: 'http://127.0.0.1:4545',
        fetchImpl: hangUntilAborted(signals),
      });

      const rejection = expect(client.getMachine('ac-local-a')).rejects.toThrow(
        'smolvm serve request failed',
      );

      await vi.advanceTimersByTimeAsync(30_001);
      expect(signals[0].aborted).toBe(true);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  // Creating a machine materializes disk images and starting one boots a
  // kernel; both routinely outlast a deadline sized for reading state.
  it.each([
    ['createMachine', (c: SmolvmServeClient) => c.createMachine({ name: 'a' })],
    ['startMachine', (c: SmolvmServeClient) => c.startMachine('a')],
  ])('gives %s the provisioning deadline', async (_name, call) => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const client = new SmolvmServeClient({
        baseUrl: 'http://127.0.0.1:4545',
        fetchImpl: hangUntilAborted(signals),
        timeoutMs: 30_000,
        provisionTimeoutMs: 120_000,
      });

      const rejection = expect(call(client)).rejects.toThrow(
        'smolvm serve request failed',
      );
      await vi.advanceTimersByTimeAsync(31_000);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(signals[0].aborted).toBe(true);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shortens a provisioning call below the request deadline', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const client = new SmolvmServeClient({
        baseUrl: 'http://127.0.0.1:4545',
        fetchImpl: hangUntilAborted(signals),
        timeoutMs: 60_000,
        provisionTimeoutMs: 1_000,
      });

      const rejection = expect(client.startMachine('a')).rejects.toThrow(
        'smolvm serve request failed',
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(signals[0].aborted).toBe(true);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks an expired deadline distinctly from a refused connection', async () => {
    vi.useFakeTimers();
    try {
      const client = new SmolvmServeClient({
        baseUrl: 'http://127.0.0.1:4545',
        fetchImpl: hangUntilAborted([]),
      });
      const rejection = expect(client.getMachine('a')).rejects.toMatchObject({
        name: 'SmolvmServeError',
        status: null,
        timedOut: true,
      });
      await vi.advanceTimersByTimeAsync(30_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    const refused = new SmolvmServeClient({
      baseUrl: 'http://127.0.0.1:4545',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await expect(refused.getMachine('a')).rejects.toMatchObject({
      status: null,
      timedOut: false,
    });
  });

  it('detects not-found from a JSON error body without a 404 status', () => {
    const jsonBody = new SmolvmServeError(
      'smolvm serve POST /api/v1/machines/x/stop failed with HTTP 400: machine not found',
      400,
      { error: 'machine not found' },
    );
    expect(isSmolvmNotFound(jsonBody)).toBe(true);
    expect(
      isSmolvmNotFound(new SmolvmServeError('boom', 400, { error: 'busy' })),
    ).toBe(false);
  });

  it('detects the structured host-port conflict returned by smolvm', () => {
    expect(
      isSmolvmPortInUse(
        new SmolvmServeError('start rejected', 409, {
          error: 'published host port is already in use',
          code: 'PORT_IN_USE',
        }),
      ),
    ).toBe(true);
    expect(
      isSmolvmPortInUse(
        new SmolvmServeError('different conflict', 409, {
          error: 'machine is already running',
          code: 'CONFLICT',
        }),
      ),
    ).toBe(false);
  });

  it('parses and enforces health versions', () => {
    const health = JSON.stringify({ status: 'ok', version: '1.8.1' });
    expect(parseSmolvmHealth(health)).toEqual({
      status: 'ok',
      version: '1.8.1',
    });
    expect(assertSmolvmHealth(health, '1.8.1')).toEqual({
      status: 'ok',
      version: '1.8.1',
    });
    expect(() => assertSmolvmHealth('ok', '1.8.1')).toThrow(
      'did not report a version',
    );
    expect(() =>
      assertSmolvmHealth(
        JSON.stringify({ status: 'ok', version: '1.8.0' }),
        '1.8.1',
      ),
    ).toThrow('Expected smolvm 1.8.1, got 1.8.0');
  });
});
