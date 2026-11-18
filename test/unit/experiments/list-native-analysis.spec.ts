import { describe, expect, it } from 'vitest';
import {
  correlateNativeRequest,
  diagnosticOutcomes,
  nativeWindow,
} from '../../helpers/list-responsiveness/analyze-native.mjs';

describe('native list analysis', () => {
  it('converts Mach ticks while preserving the wider native observation window', () => {
    const row = (wallMs: number, ticks: number, userNs: number) => ({
      event: 'sample',
      wallMs,
      monotonicMs: wallMs - 1000,
      userTicks: ticks,
      systemTicks: 0,
      runnableTicks: ticks,
      pageins: 0,
      diskReadBytes: 0,
      diskWriteBytes: 0,
      faults: 0,
      contextSwitches: 0,
      rssBytes: 100,
      footprintBytes: 100,
      threads: [{ handle: 'main', state: 3, userNs, systemNs: 0 }],
      sockets: [],
    });
    const events = [
      { event: 'start', timebaseNumer: 125, timebaseDenom: 3 },
      row(1000, 0, 0),
      row(1100, 1200000, 50000000),
    ];
    const result = nativeWindow(events, 1020, 1080);
    expect(result).toMatchObject({
      startWallMs: 1000,
      endWallMs: 1100,
      elapsedMs: 100,
      cpuMs: 50,
    });
    expect(result?.threadCounters[0].cpuMs).toBe(50);
    expect(nativeWindow(events, 900, 1080)).toBeNull();
  });

  it('separates a reused connection from delay between write and HTTP parsing', () => {
    const api = [
      { timeOrigin: 1000 },
      {
        name: 'net.server.socket',
        atMs: 10,
        socket: { id: 'api-socket', localPort: 8000, remotePort: 9000 },
      },
      {
        name: 'http.server.request.start',
        atMs: 710,
        probeId: 'request-1',
        socket: { id: 'api-socket', localPort: 8000, remotePort: 9000 },
      },
    ];
    const driver = [
      { timeOrigin: 1000 },
      {
        name: 'undici:client:sendHeaders',
        atMs: 101,
        probeId: 'request-1',
        requestId: 'network-1',
        socket: { id: 'client', localPort: 9000, remotePort: 8000 },
      },
      { name: 'undici:request:bodySent', atMs: 102, requestId: 'network-1' },
    ];
    const result = correlateNativeRequest(
      { id: 'request-1', offeredAt: 100, elapsedMs: 620 },
      { receivedAt: 711, finishedAt: 714, sqlMs: 1 },
      api,
      driver,
    );
    expect(result).toMatchObject({
      acceptedBeforeOffer: true,
      offeredToCallbackMs: 611,
      writtenToParsedMs: 608,
      parsedToCallbackMs: 1,
      handlerMs: 3,
    });
    expect(result.socket?.clientPort).toBe(9000);
    expect(() =>
      correlateNativeRequest(
        { id: 'request-1', offeredAt: 100 },
        null,
        [...api, api[2]],
        driver,
      ),
    ).toThrow('Ambiguous');
  });

  it('retains an unmatched transport failure without inventing server receipt', () => {
    const result = correlateNativeRequest(
      { id: 'request-1', offeredAt: 100, outcome: 'transport-error' },
      undefined,
      [{ timeOrigin: 1000 }],
      [{ timeOrigin: 1000 }],
    );
    expect(result).toMatchObject({
      outcome: 'transport-error',
      receivedAtEpoch: null,
      writtenToParsedMs: null,
      socket: null,
      clientWriteCount: 0,
    });
  });

  it('retains a client write when the timed-out request is never parsed by the API', () => {
    const record = {
      id: 'request-1',
      path: '/v1/deployments',
      offeredAt: 100,
      outcome: 'timeout',
    };
    const api = [{ timeOrigin: 1000 }];
    const write = {
      name: 'undici:client:sendHeaders',
      atMs: 101,
      probeId: record.id,
      path: record.path,
      requestId: 'network-1',
      socket: { id: 'client', localPort: 9000, remotePort: 8000 },
    };
    const driver = [
      { timeOrigin: 5000 },
      write,
      { name: 'undici:request:bodySent', atMs: 102, requestId: 'network-1' },
    ];
    expect(
      correlateNativeRequest(record, undefined, api, driver),
    ).toMatchObject({
      writtenAtEpoch: 5102,
      offeredToWriteMs: 2,
      receivedAtEpoch: null,
      parsedAtEpoch: null,
      writtenToParsedMs: null,
      acceptedAtEpoch: null,
      correlation: 'unmatched',
      socket: null,
      clientWriteCount: 1,
    });
    expect(() =>
      correlateNativeRequest(record, undefined, api, [...driver, write]),
    ).toThrow('Ambiguous');
    expect(() =>
      correlateNativeRequest(record, undefined, api, [
        driver[0],
        { ...write, path: '/health' },
        driver[2],
      ]),
    ).toThrow('Request ID path mismatch');
  });

  it('correlates a timed-out peer by its unique request ID when Node omits the remote port', () => {
    const api = [
      { timeOrigin: 1000 },
      {
        name: 'net.server.socket',
        atMs: 45102,
        socket: { id: 'api-socket', localPort: 8000 },
      },
      {
        name: 'http.server.request.start',
        atMs: 46102,
        probeId: 'request-1',
        socket: { id: 'api-socket', localPort: 8000 },
      },
    ];
    const write = {
      name: 'undici:client:sendHeaders',
      atMs: 101,
      probeId: 'request-1',
      requestId: 'network-1',
      socket: { id: 'client', localPort: 9000, remotePort: 8000 },
    };
    const driver = [
      { timeOrigin: 5000 },
      write,
      { name: 'undici:request:bodySent', atMs: 102, requestId: 'network-1' },
    ];
    const record = {
      id: 'request-1',
      outcome: 'timeout',
      offeredAt: 100,
      elapsedMs: 15001,
    };
    const result = correlateNativeRequest(
      record,
      { receivedAt: 46103, finishedAt: 46106, sqlMs: 1 },
      api,
      driver,
    );
    expect(result).toMatchObject({
      correlation: 'unique-request-id-with-missing-port',
      writtenToParsedMs: 42000,
      offeredToCallbackMs: 42003,
      offeredToWriteMs: 2,
      handlerMs: 3,
      serverFinished: true,
      socket: { clientPort: 9000, observedServerPeerPort: null },
    });
    expect(() =>
      correlateNativeRequest(record, undefined, api, [...driver, write]),
    ).toThrow('Ambiguous');
    expect(() =>
      correlateNativeRequest(record, undefined, api, [
        driver[0],
        { ...write, socket: { ...write.socket, remotePort: 8001 } },
      ]),
    ).toThrow('Contradictory socket ports');
  });

  it('keeps failed offers and late successes in penalized tails and rate denominators', () => {
    const result = diagnosticOutcomes(
      [
        { outcome: 'success', elapsedMs: 1000 },
        { outcome: 'success', elapsedMs: 15000 },
        { outcome: 'success', elapsedMs: 16000 },
        { outcome: 'transport-error', elapsedMs: 7000 },
        { outcome: 'scheduling-skipped' },
        { outcome: 'admission-skipped' },
        { outcome: 'unfinished' },
        { outcome: 'timeout', elapsedMs: 15100 },
      ],
      15000,
    );
    expect(result).toMatchObject({
      offered: 8,
      failures: 6,
      failureRatePp: 75,
      lateSuccesses: 1,
      penalizedP95Ms: 15000,
      successfulResponses: { p95Ms: 16000 },
    });
    expect(diagnosticOutcomes([], 15000)).toMatchObject({
      offered: 0,
      failureRatePp: null,
      penalizedP95Ms: null,
    });
  });
});
