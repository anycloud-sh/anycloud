import { PassThrough, type Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  POD_LOG_TAIL_BYTES,
  captureTail,
  podLogs,
  tail,
} from '../../../../src/api/services/kubernetes/pod-logs.js';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';

const target = { namespace: 'ns', pod: 'api-1', container: 'workload' };

/** A `pods/log` request that writes `chunks` and ends, or fails like the API. */
function fakeLog(chunks: string[] | Error, request = new AbortController()) {
  const log = vi.fn(async (...args: unknown[]) => {
    if (chunks instanceof Error) throw chunks;
    const sink = args[3] as Writable;
    for (const chunk of chunks) sink.write(Buffer.from(chunk));
    sink.end();
    return request;
  });
  return { log, cluster: makeClusterKubernetesClientFixture({ log: { log } }) };
}

const signal = () => new AbortController().signal;

describe('pod logs', () => {
  it('streams one container log in order, current run unless asked for the previous', async () => {
    const fake = fakeLog(['a\n', 'b\n']);
    const written: string[] = [];

    await podLogs(
      fake.cluster,
      target,
      { follow: true, signal: signal() },
      (c) => {
        written.push(c.toString());
      },
    );

    expect(written).toEqual(['a\n', 'b\n']);
    expect(fake.log).toHaveBeenCalledWith(
      'ns',
      'api-1',
      'workload',
      expect.anything(),
      { follow: true, previous: false },
    );
  });

  it("keeps a pool Job's span of the log: from the claim to its end, stamps removed, across split chunks", async () => {
    const fake = fakeLog([
      '2026-10-14T10:00:00.999999999Z earlier Job\n2026-10-14T10:00:01.5',
      '00000000Z this Job ✓\n2026-10-14T10:00:02.000000001Z its last',
      ' line\n2026-10-14T10:00:03.000000000Z next Job',
    ]);
    const written: string[] = [];

    await podLogs(
      fake.cluster,
      target,
      {
        follow: false,
        signal: signal(),
        window: {
          from: Date.parse('2026-10-14T10:00:01.200Z'),
          until: async () => Date.parse('2026-10-14T10:00:02.500Z'),
        },
      },
      (c) => {
        written.push(c.toString());
      },
    );

    expect(written.join('')).toBe('this Job ✓\nits last line\n');
    expect(fake.log).toHaveBeenCalledWith(
      'ns',
      'api-1',
      'workload',
      expect.anything(),
      {
        follow: false,
        previous: false,
        timestamps: true,
        sinceTime: '2026-10-14T10:00:01.000Z',
      },
    );
  });

  it('waits for each write before taking the next chunk', async () => {
    const fake = fakeLog(['a', 'b']);
    const order: string[] = [];

    await podLogs(
      fake.cluster,
      target,
      { follow: false, signal: signal() },
      async (c) => {
        order.push(`start ${c.toString()}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${c.toString()}`);
      },
    );

    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('aborts the log request when the reader goes away', async () => {
    const request = new AbortController();
    const log = vi.fn(async (...args: unknown[]) => {
      (args[3] as Writable).write(Buffer.from('line\n'));
      return request;
    });
    const cluster = makeClusterKubernetesClientFixture({ log: { log } });
    const reader = new AbortController();
    const written: string[] = [];

    const streaming = podLogs(
      cluster,
      target,
      { follow: true, signal: reader.signal },
      (c) => {
        written.push(c.toString());
      },
    );
    await vi.waitFor(() => expect(written).toEqual(['line\n']));
    reader.abort(new Error('client gone'));

    await expect(streaming).rejects.toThrow('client gone');
    expect(request.signal.aborted).toBe(true);
  });

  it('rejects with the API error for a missing Pod or container', async () => {
    const error = new Error('pods "api-1" not found');
    const fake = fakeLog(error);

    await expect(
      podLogs(
        fake.cluster,
        target,
        { follow: false, signal: signal() },
        () => {},
      ),
    ).rejects.toBe(error);
    await expect(tail(fake.cluster, target)).rejects.toBe(error);
  });

  it('rejects when the log connection drops mid-stream', async () => {
    // The client pipes the response body into the sink, as client-node does.
    const log = vi.fn(async (...args: unknown[]) => {
      const body = new PassThrough();
      body.pipe(args[3] as Writable);
      body.write('line\n');
      setImmediate(() => body.destroy(new Error('Premature close')));
      return new AbortController();
    });
    const cluster = makeClusterKubernetesClientFixture({ log: { log } });

    await expect(
      podLogs(cluster, target, { follow: true, signal: signal() }, () => {}),
    ).rejects.toThrow('Premature close');
    await expect(tail(cluster, target)).rejects.toThrow('Premature close');
  });

  it('keeps only the last limitBytes of a longer log', async () => {
    const fake = fakeLog(['0123', '4567', '89ab', 'cdef']);

    await expect(
      tail(fake.cluster, { ...target, previous: true }, 6),
    ).resolves.toEqual(Buffer.from('abcdef'));
    expect(fake.log.mock.calls[0]![4]).toEqual({
      follow: false,
      previous: true,
    });
  });

  it('returns a log shorter than the bound whole, and bounds at 1 MiB by default', async () => {
    const short = fakeLog(['only\n']);
    await expect(tail(short.cluster, target)).resolves.toEqual(
      Buffer.from('only\n'),
    );

    const long = fakeLog(['x'.repeat(POD_LOG_TAIL_BYTES), 'end']);
    const kept = await tail(long.cluster, target);
    expect(POD_LOG_TAIL_BYTES).toBe(1024 * 1024);
    expect(kept.length).toBe(POD_LOG_TAIL_BYTES);
    expect(kept.subarray(-3).toString()).toBe('end');
    await expect(tail(fakeLog(['a', 'b']).cluster, target, 0)).resolves.toEqual(
      Buffer.alloc(0),
    );
  });

  it('captures the claimed instance: its previous run once restarted, and says why when it cannot', async () => {
    const replica = (containerID: string) => ({
      metadata: { namespace: 'ns', name: 'api-1' },
      status: {
        containerStatuses: [
          {
            name: 'workload',
            containerID,
            image: 'i',
            imageID: 'i',
            ready: true,
            restartCount: 1,
          },
        ],
      },
    });
    const fake = fakeLog(['kept\n']);
    await expect(
      captureTail(fake.cluster, replica('c://new'), 'workload', 'c://old'),
    ).resolves.toEqual({ state: 'captured', text: 'kept\n' });
    await expect(
      captureTail(fake.cluster, replica('c://old'), 'workload', 'c://old'),
    ).resolves.toEqual({ state: 'captured', text: 'kept\n' });
    expect(fake.log.mock.calls.map((call) => call[4])).toEqual([
      { follow: false, previous: true },
      { follow: false, previous: false },
    ]);
    await expect(
      captureTail(fake.cluster, undefined, 'workload', 'c://old'),
    ).resolves.toEqual({
      state: 'unavailable',
      text: 'Its Pod was gone before its log was read.',
    });
    await expect(
      captureTail(
        fakeLog(new Error('connection refused')).cluster,
        replica('c://old'),
        'workload',
        'c://old',
      ),
    ).resolves.toEqual({
      state: 'unavailable',
      text: 'Its log could not be read: connection refused.',
    });
  });
});
