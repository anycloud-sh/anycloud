import { describe, expect, it } from 'vitest';
import {
  correlateNetwork,
  parentClockOrigin,
  quantile,
  summarizeTrial,
} from '../../helpers/list-responsiveness/analyze-diagnostics.mjs';

describe('List diagnostic evidence analysis', () => {
  it('aligns independent clocks using the same retained phase marker', () => {
    expect(
      parentClockOrigin({
        driver: { phases: [{ phase: 'matrix:x', clockOrigin: 10000, at: 30 }] },
        phaseMarkers: [{ phase: 'matrix:x', at: 1030 }],
      }),
    ).toBe(9000);
    expect(() =>
      parentClockOrigin({
        driver: { phases: [{ phase: 'x', clockOrigin: 10000, at: 30 }] },
        phaseMarkers: [{ phase: 'y', at: 1030 }],
      }),
    ).toThrow();
  });

  it('keeps uncollected GC observations distinct from observed zero overlap', () => {
    const raw = {
      requests: [{ id: 'r', receivedAt: 1012, finishedAt: 1016, sqlMs: 2 }],
      driver: {
        clockOrigin: 10000,
        records: [
          {
            id: 'r',
            case: 'x',
            phase: 'matrix:x',
            sample: true,
            outcome: 'success',
            offeredAt: 10,
            bodyCompletedAt: 20,
            elapsedMs: 10,
          },
        ],
      },
    };
    const historical = summarizeTrial(raw).groups[0];
    expect(historical.gcObserved).toBe(false);
    expect(historical.slowest[0].apiGcMs).toBeNull();
    expect(historical.withoutGcP95Ms).toBeNull();
    const observed = summarizeTrial(raw, {
      api: [
        { event: 'start', timeOrigin: 9000 },
        { event: 'gc', startMs: 1015, durationMs: 3 },
      ],
      driver: [],
    }).groups[0];
    expect(observed.gcObserved).toBe(true);
    expect(observed.slowest[0].apiGcMs).toBe(3);
    expect(observed.withGcP95Ms).toBe(10);
  });

  it('reports the specified nearest-rank p95 of 50 observations', () => {
    expect(
      quantile(
        Array.from({ length: 50 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(48);
    expect(quantile([], 0.95)).toBeNull();
  });

  it('locates a timeout before application receipt despite a short handler duration', () => {
    const raw = {
      requests: [
        { id: 'ok', receivedAt: 5, finishedAt: 7, sqlMs: 1 },
        { id: 'late', receivedAt: 15510, finishedAt: 15512, sqlMs: 1 },
      ],
      driver: {
        clockOrigin: 10000,
        records: [
          {
            id: 'ok',
            case: 'x',
            phase: 'overload',
            sample: true,
            outcome: 'success',
            offeredAt: 100,
            bodyCompletedAt: 110,
            elapsedMs: 10,
          },
          {
            id: 'late',
            case: 'x',
            phase: 'overload',
            sample: true,
            outcome: 'timeout',
            offeredAt: 300,
            settledAt: 15300,
            elapsedMs: 15000,
          },
        ],
      },
    };
    const result = summarizeTrial(raw);
    expect(result.clockOffsetBounds).toEqual([95, 105]);
    expect(result.failures[0].serverArrivalDelayBoundsMs).toEqual([
      15305, 15315,
    ]);
    expect(result.failures[0].handlerMs).toBe(2);
  });

  it('correlates interleaved network events while excluding skipped offers', () => {
    const records = [
      {
        id: 'a',
        path: '/control',
        outcome: 'success',
        offeredAt: 10,
        settledAt: 40,
      },
      {
        id: 'skip',
        path: '/control',
        outcome: 'scheduling-skipped',
        offeredAt: 15,
      },
      {
        id: 'b',
        path: '/list',
        outcome: 'timeout',
        offeredAt: 20,
        settledAt: 15020,
      },
    ];
    const events = [
      {
        name: 'undici:request:create',
        requestId: 'n0',
        path: '/control',
        atMs: 11,
      },
      { name: 'undici:request:bodySent', requestId: 'n0', atMs: 12 },
      {
        name: 'undici:request:create',
        requestId: 'n1',
        path: '/list',
        atMs: 21,
      },
      { name: 'undici:request:headers', requestId: 'n0', atMs: 39 },
      { name: 'undici:request:bodySent', requestId: 'n1', atMs: 22 },
      {
        name: 'undici:request:error',
        requestId: 'n1',
        atMs: 15020,
        error: { name: 'AbortError' },
      },
    ];
    const result = correlateNetwork(records, events);
    expect(result.size).toBe(2);
    expect(result.get('a').headersAtMs).toBe(39);
    expect(result.get('b').bodySentAtMs).toBe(22);
    expect(result.get('b').errors[0].name).toBe('AbortError');
    expect(() => correlateNetwork(records, events.slice(1))).toThrow(
      'Incomplete network creates',
    );
    expect(() =>
      correlateNetwork(records, [
        { ...events[0], atMs: 25 },
        ...events.slice(1),
      ]),
    ).toThrow('Ambiguous network create');
  });

  it('keeps a response completed after its deadline in the failure analysis', () => {
    const result = summarizeTrial({
      requests: [{ id: 'late', receivedAt: 102, finishedAt: 15103, sqlMs: 1 }],
      driver: {
        clockOrigin: 10000,
        timeoutMs: 15000,
        records: [
          {
            id: 'late',
            case: 'status',
            phase: 'overload',
            sample: true,
            outcome: 'success',
            offeredAt: 100,
            bodyCompletedAt: 15105,
            elapsedMs: 15005,
          },
        ],
      },
    });
    expect(result.failures[0].outcome).toBe('success');
    expect(result.failures[0].lateSuccess).toBe(true);
    expect(result.groups[0].lateSuccesses).toBe(1);
  });
});
