import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantile } from './analyze-diagnostics.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const journal = (file) =>
  readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const hash = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const maximum = (values) => (values.length ? Math.max(...values) : null);
const countBy = (values) =>
  Object.fromEntries(
    [...new Set(values)].map((key) => [
      key,
      values.filter((value) => value === key).length,
    ]),
  );
const overlap = (a, b, start, end) =>
  Math.max(0, Math.min(b, end) - Math.max(a, start));

export function diagnosticOutcomes(records, deadlineMs) {
  const successful = records.filter((r) => r.outcome === 'success');
  assert(
    successful.every((r) => Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0),
    'Successful response lacks a finite latency',
  );
  const failures = records.filter(
    (r) => r.outcome !== 'success' || r.elapsedMs > deadlineMs,
  ).length;
  return {
    offered: records.length,
    outcomes: countBy(records.map((r) => r.outcome)),
    failures,
    failureRatePp: records.length ? (failures / records.length) * 100 : null,
    lateSuccesses: successful.filter((r) => r.elapsedMs > deadlineMs).length,
    deadlineMs,
    penalizedP95Ms: quantile(
      records.map((r) =>
        r.outcome === 'success'
          ? Math.min(r.elapsedMs, deadlineMs)
          : deadlineMs,
      ),
      0.95,
    ),
    successfulResponses: {
      p50Ms: quantile(
        successful.map((r) => r.elapsedMs),
        0.5,
      ),
      p95Ms: quantile(
        successful.map((r) => r.elapsedMs),
        0.95,
      ),
      maximumMs: maximum(successful.map((r) => r.elapsedMs)),
    },
  };
}

export function nativeWindow(events, start, end) {
  const samples = events.filter((e) => e.event === 'sample');
  const before = samples.findLast((e) => e.wallMs <= start);
  const after = samples.find((e) => e.wallMs >= end);
  if (!before || !after) return null;
  const selected = samples.filter(
    (e) => e.wallMs >= before.wallMs && e.wallMs <= after.wallMs,
  );
  const scale = events[0].timebaseNumer / events[0].timebaseDenom / 1e6;
  assert(Number.isFinite(scale) && scale > 0, 'Missing Mach timebase');
  const delta = (key) => after[key] - before[key];
  const threads = before.threads
    .flatMap((thread) => {
      const last = after.threads.find((t) => t.handle === thread.handle);
      if (!last) return [];
      const observations = selected.flatMap((row) =>
        row.threads.filter((t) => t.handle === thread.handle),
      );
      return [
        {
          handle: thread.handle,
          cpuMs:
            (last.userNs + last.systemNs - thread.userNs - thread.systemNs) /
            1e6,
          states: Object.fromEntries(
            [...new Set(observations.map((t) => t.state))].map((state) => [
              state,
              observations.filter((t) => t.state === state).length,
            ]),
          ),
        },
      ];
    })
    .sort((a, b) => b.cpuMs - a.cpuMs);
  const sockets = selected.flatMap((row) => row.sockets);
  return {
    startWallMs: before.wallMs,
    endWallMs: after.wallMs,
    elapsedMs: after.monotonicMs - before.monotonicMs,
    cpuMs: (delta('userTicks') + delta('systemTicks')) * scale,
    runnableMs: delta('runnableTicks') * scale,
    pageins: delta('pageins'),
    diskReadBytes: delta('diskReadBytes'),
    diskWriteBytes: delta('diskWriteBytes'),
    faults: delta('faults'),
    contextSwitches: delta('contextSwitches'),
    rssBefore: before.rssBytes,
    rssAfter: after.rssBytes,
    footprintBefore: before.footprintBytes,
    footprintAfter: after.footprintBytes,
    threadCounters: threads.slice(0, 3),
    socketMaxima: {
      acceptQueue: maximum(sockets.map((s) => s.acceptQueue)),
      incompleteQueue: maximum(sockets.map((s) => s.incompleteQueue)),
      receiveBytes: maximum(sockets.map((s) => s.receiveBytes)),
      sendBytes: maximum(sockets.map((s) => s.sendBytes)),
    },
    hostVmDelta:
      before.hostVm && after.hostVm
        ? Object.fromEntries(
            [
              'compressions',
              'decompressions',
              'swapins',
              'swapouts',
              'pageins',
              'pageouts',
            ].map((key) => [key, after.hostVm[key] - before.hostVm[key]]),
          )
        : null,
  };
}

export function correlateNativeRequest(
  record,
  server,
  apiEvents,
  driverEvents,
) {
  const apiOrigin = apiEvents[0].timeOrigin,
    driverOrigin = driverEvents[0].timeOrigin;
  const parsed = apiEvents.filter(
    (e) => e.name === 'http.server.request.start' && e.probeId === record.id,
  );
  const writes = driverEvents.filter(
    (e) => e.name === 'undici:client:sendHeaders' && e.probeId === record.id,
  );
  assert(parsed.length <= 1, 'Ambiguous HTTP parse observation');
  const parse = parsed[0];
  // Keep a unique client write even when the API never parses the request.
  // Closed peers may lack a remote port; any ports still present must agree.
  const matching = writes.filter(
    (e) =>
      !parse ||
      [
        [e.socket?.localPort, parse.socket?.remotePort],
        [e.socket?.remotePort, parse.socket?.localPort],
      ].every(
        ([client, api]) =>
          client === undefined || api === undefined || client === api,
      ),
  );
  assert(matching.length <= 1, 'Ambiguous socket write observation');
  assert(
    !parse || !writes.length || matching.length,
    'Contradictory socket ports for the same request ID',
  );
  const write = matching[0];
  const completePorts =
    write &&
    parse &&
    [
      write.socket?.localPort,
      write.socket?.remotePort,
      parse.socket?.localPort,
      parse.socket?.remotePort,
    ].every(Number.isFinite);
  assert(
    !write || completePorts || writes.length === 1,
    'Ambiguous request ID with incomplete socket ports',
  );
  for (const observation of [write, parse])
    if (observation?.path !== undefined && record.path !== undefined)
      assert.equal(observation.path, record.path, 'Request ID path mismatch');
  const bodySent =
    write &&
    driverEvents.find(
      (e) =>
        e.name === 'undici:request:bodySent' &&
        e.requestId === write.requestId &&
        e.atMs >= write.atMs,
    );
  const accepted =
    parse &&
    apiEvents.find(
      (e) => e.name === 'net.server.socket' && e.socket.id === parse.socket.id,
    );
  const offered = driverOrigin + record.offeredAt;
  const written = bodySent ? driverOrigin + bodySent.atMs : null;
  const received = server ? apiOrigin + server.receivedAt : null;
  const parsedAt = parse ? apiOrigin + parse.atMs : null;
  return {
    id: record.id,
    case: record.case,
    phase: record.phase,
    outcome: record.outcome,
    error: record.error ?? null,
    elapsedMs: record.elapsedMs,
    offeredAtEpoch: offered,
    writtenAtEpoch: written,
    receivedAtEpoch: received,
    parsedAtEpoch: parsedAt,
    serverFinished: Number.isFinite(server?.finishedAt),
    sqlMs: server?.sqlMs ?? null,
    handlerMs:
      server?.finishedAt === undefined
        ? null
        : server.finishedAt - server.receivedAt,
    offeredToWriteMs: written === null ? null : written - offered,
    writtenToParsedMs:
      written === null || parsedAt === null ? null : parsedAt - written,
    parsedToCallbackMs:
      parsedAt === null || received === null ? null : received - parsedAt,
    offeredToCallbackMs: received === null ? null : received - offered,
    acceptedBeforeOffer: accepted ? apiOrigin + accepted.atMs < offered : null,
    acceptedAtEpoch: accepted ? apiOrigin + accepted.atMs : null,
    correlation:
      write && parse
        ? completePorts
          ? 'request-id-and-ports'
          : 'unique-request-id-with-missing-port'
        : 'unmatched',
    socket:
      write && parse
        ? {
            client: write.socket.id,
            server: parse.socket.id,
            clientPort: write.socket.localPort,
            serverPort: write.socket.remotePort,
            observedServerPeerPort: parse.socket.remotePort ?? null,
          }
        : null,
    clientWriteCount: writes.length,
  };
}

function stackSummary(file) {
  const text = readFileSync(file, 'utf8');
  const section = text
    .split('Sort by top of stack, same collapsed (when >= 5):')[1]
    ?.split('Binary Images:')[0];
  return {
    sha256: hash(file),
    topOfStackAcrossAllThreads:
      section?.trim().split('\n').slice(0, 15) ?? null,
    sqliteSortWriteMentions: text
      .split('\n')
      .flatMap((line, index) =>
        /vdbeSorterFlushPMA|vdbeSorterListToPMA/.test(line)
          ? [{ line: index + 1, text: line.trim() }]
          : [],
      ),
  };
}

export function analyzeNativeTrial(directory) {
  const raw = json(path.join(directory, 'result.json'));
  assert.equal(raw.exitCode, 0);
  assert(!raw.failure, raw.failure);
  const native = json(path.join(directory, 'native.json'));
  const diagnostics = Object.fromEntries(
    ['api', 'driver', 'parent'].map((role) => [
      role,
      journal(path.join(directory, 'diagnostics-' + role + '.jsonl')),
    ]),
  );
  const counters = Object.fromEntries(
    native.commands
      .filter((c) => c.kind === 'counters')
      .map((c) => [c.role, journal(path.join(directory, c.stdout))]),
  );
  const health = json(path.join(directory, 'health.json'));
  const measured = raw.driver.records.filter((r) => r.sample);
  const workDeadlineMs = raw.driver.timeoutMs;
  const healthOutcome = (r) => ({
    ...r,
    outcome: r.ok ? 'success' : (r.error ?? 'failure'),
  });
  const apiOrigin = diagnostics.api[0].timeOrigin;
  const sqlStarts = new Map(
    diagnostics.api
      .filter((e) => e.event === 'sql-start')
      .map((e) => [e.statement, e]),
  );
  const sql = diagnostics.api
    .filter((e) => e.event === 'sql-end')
    .map((e) => {
      const start = sqlStarts.get(e.statement);
      assert(start, 'SQL interval lacks a start');
      return {
        id: e.requestId,
        case: e.case,
        shape: e.shape,
        start: apiOrigin + e.startedAtMs,
        end: apiOrigin + e.atMs,
        cpuMs: (e.cpu.user + e.cpu.system) / 1000,
      };
    });
  const apiGc = diagnostics.api.filter((e) => e.event === 'gc');
  const requests = measured.map((record) => {
    const server = raw.requests.find((r) => r.id === record.id);
    const item = correlateNativeRequest(
      record,
      server,
      diagnostics.api,
      diagnostics.driver,
    );
    if (item.writtenAtEpoch !== null && item.receivedAtEpoch !== null) {
      item.sqlOverlapBeforeReceiptMs = sql.reduce(
        (n, s) =>
          n +
          overlap(s.start, s.end, item.writtenAtEpoch, item.receivedAtEpoch),
        0,
      );
      item.gcOverlapBeforeReceiptMs = apiGc.reduce(
        (n, e) =>
          n +
          overlap(
            apiOrigin + e.startMs,
            apiOrigin + e.startMs + e.durationMs,
            item.writtenAtEpoch,
            item.receivedAtEpoch,
          ),
        0,
      );
    }
    return item;
  });
  const failures = requests.filter(
    (r) => r.outcome !== 'success' || r.elapsedMs > workDeadlineMs,
  );
  const errorCodes = (error) =>
    error
      ? [
          ...(error.code === undefined ? [] : [String(error.code)]),
          ...errorCodes(error.cause),
        ]
      : [];
  const phaseSummary = (records, healthRecords) => ({
    work: diagnosticOutcomes(records, workDeadlineMs),
    endpoints: Object.fromEntries(
      [...new Set(records.map((r) => r.case))].map((name) => [
        name,
        diagnosticOutcomes(
          records.filter((r) => r.case === name),
          workDeadlineMs,
        ),
      ]),
    ),
    health: diagnosticOutcomes(healthRecords.map(healthOutcome), 1000),
  });
  const listenerSamples = counters.api.filter((r) => r.event === 'sample');
  const fullQueue = listenerSamples.filter((r) =>
    r.sockets.some((s) => s.queueLimit > 0 && s.acceptQueue >= s.queueLimit),
  );
  const slowSql = [...sql]
    .filter((s) => requests.some((r) => r.id === s.id))
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, 10)
    .map((s) => ({
      ...s,
      elapsedMs: s.end - s.start,
      request: requests.find((r) => r.id === s.id),
      nativeApi: nativeWindow(counters.api, s.start, s.end),
      nativeHost: nativeWindow(counters.parent, s.start, s.end),
    }));
  const beforeReceipt = requests
    .filter((r) => r.writtenToParsedMs !== null)
    .sort((a, b) => b.writtenToParsedMs - a.writtenToParsedMs)
    .slice(0, 10)
    .map((r) => ({
      ...r,
      nativeApi: nativeWindow(
        counters.api,
        r.writtenAtEpoch,
        r.receivedAtEpoch,
      ),
      nativeDriver: nativeWindow(
        counters.driver,
        r.writtenAtEpoch,
        r.receivedAtEpoch,
      ),
      nativeHost: nativeWindow(
        counters.parent,
        r.writtenAtEpoch,
        r.receivedAtEpoch,
      ),
    }));
  const first = requests[0].offeredAtEpoch,
    last = Math.max(
      ...raw.driver.records
        .filter((r) => r.sample)
        .map(
          (r) =>
            diagnostics.driver[0].timeOrigin +
            (r.bodyCompletedAt ?? r.settledAt),
        ),
    );
  return {
    directory,
    profile: raw.profile,
    mode: raw.mode,
    scope: raw.scope,
    reportSha256: hash(path.join(directory, 'result.json')),
    work: raw.driver.summary,
    firstRequest: raw.driver.records.find((r) => r.phase === 'first-request'),
    outcomes: diagnosticOutcomes(measured, workDeadlineMs),
    health: {
      coverage:
        'Every performance-trial health offer, including warmup and drain',
      offered: health.length,
      misses: health.filter((r) => !r.ok || r.elapsedMs > 1000).length,
      maximumMs: maximum(health.map((r) => r.elapsedMs)),
      ...diagnosticOutcomes(health.map(healthOutcome), 1000),
    },
    phases: Object.fromEntries(
      [...new Set(measured.map((r) => r.phase))].map((phase) => [
        phase,
        phaseSummary(
          measured.filter((r) => r.phase === phase),
          health.filter((r) => r.workPhase === phase),
        ),
      ]),
    ),
    finalRecovery:
      raw.mode === 'load'
        ? phaseSummary(
            measured.filter(
              (r) => r.phase === 'recovery' && r.phaseElapsedMs >= 60000,
            ),
            health.filter(
              (r) =>
                r.workPhase === 'recovery' &&
                r.phaseElapsedMs >= 60000 &&
                r.phaseElapsedMs < 90000,
            ),
          )
        : null,
    correlations: {
      offered: requests.length,
      socketMatched: requests.filter((r) => r.socket).length,
      multipleWrites: requests.filter((r) => r.clientWriteCount > 1).length,
      methods: countBy(requests.map((r) => r.correlation)),
    },
    failures: {
      count: failures.length,
      serverObserved: failures.filter((r) => r.receivedAtEpoch !== null).length,
      serverFinished: failures.filter((r) => r.serverFinished).length,
      errorCodes: countBy(failures.flatMap((r) => errorCodes(r.error))),
      requests: failures,
    },
    listener: {
      samples: listenerSamples.length,
      samplesWithFullAcceptQueue: fullQueue.length,
      firstFullAtEpoch: fullQueue[0]?.wallMs ?? null,
      lastFullAtEpoch: fullQueue.at(-1)?.wallMs ?? null,
      queueLimits: [
        ...new Set(
          listenerSamples.flatMap((r) =>
            r.sockets.filter((s) => s.queueLimit > 0).map((s) => s.queueLimit),
          ),
        ),
      ],
    },
    drained: {
      pending: raw.pendingAfterDrain,
      serverDrained: raw.serverDrained,
      unfinished: raw.driver.summary.unfinished,
    },
    nativePolicy: native.metadata.policy,
    nativeSourceSha256: native.metadata.sourceSha256,
    nativeExecutableSha256: native.metadata.executableSha256,
    processWindows: Object.fromEntries(
      ['api', 'driver', 'parent'].map((role) => [
        role,
        nativeWindow(counters[role], first, last),
      ]),
    ),
    stackCaptures: native.commands
      .filter((c) => c.kind === 'stack')
      .map((c) => ({
        phase: c.phase,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        report: c.report,
        ...stackSummary(path.join(directory, c.report)),
      })),
    slowSql,
    beforeReceipt,
    gcEvents: Object.fromEntries(
      Object.entries(diagnostics).map(([role, rows]) => [
        role,
        rows.filter((r) => r.event === 'gc').length,
      ]),
    ),
    nativeClockOffsetRangeMs: Object.fromEntries(
      Object.entries(counters).map(([role, rows]) => {
        const offsets = rows
          .filter((r) => r.event === 'sample')
          .map((r) => r.wallMs - r.monotonicMs);
        return [role, Math.max(...offsets) - Math.min(...offsets)];
      }),
    ),
  };
}

export function analyzeNativeStudy(input) {
  const plan = json(path.join(input, 'diagnostic-plan.json'));
  const execution = json(path.join(input, 'execution.json'));
  assert.equal(
    execution.planSha256,
    hash(path.join(input, 'diagnostic-plan.json')),
  );
  assert.equal(execution.status, 'complete', execution.failure);
  const cases = plan.cases.map((definition, index) => {
    const directory = path.join(input, definition.id);
    const report = json(path.join(directory, 'results.json'));
    assert.equal(execution.cases[index].id, definition.id);
    assert.equal(
      hash(path.join(directory, 'results.json')),
      execution.cases[index].reportSha256,
      'Case report changed after execution',
    );
    assert.equal(report.status, 'complete', report.failure);
    assert.equal(report.harnessSha256, plan.harnessSha256);
    assert.deepEqual(
      report.runs.map((r) => r.runDir),
      definition.expectedTrialDirectories,
    );
    return {
      id: definition.id,
      reportSha256: hash(path.join(directory, 'results.json')),
      inventorySha256: hash(path.join(directory, 'artifacts.json')),
      fixture: report.fixtures[definition.profile],
      correctnessResponses: report.correctness.reduce(
        (n, r) => n + r.snapshots.length,
        0,
      ),
      trials: report.runs.map((r) =>
        analyzeNativeTrial(path.join(directory, r.runDir)),
      ),
    };
  });
  assert.equal(
    cases.reduce((n, c) => n + c.trials.length, 0),
    plan.expectedTrials,
  );
  assert.equal(
    cases.reduce(
      (n, c) => n + c.trials.reduce((sum, t) => sum + t.work.offered, 0),
      0,
    ),
    plan.expectedMeasuredOffers,
  );
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose:
      'Diagnostic attribution only; no qualification estimators or decisions',
    analyzer: {
      node: process.version,
      files: Object.fromEntries(
        ['analyze-native.mjs', 'analyze-diagnostics.mjs'].map((file) => [
          file,
          hash(fileURLToPath(new URL(file, import.meta.url))),
        ]),
      ),
    },
    plan,
    planSha256: execution.planSha256,
    execution,
    cases,
  };
}
