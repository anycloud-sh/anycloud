import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const journal = (file) =>
  readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const hash = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const geometric = (values) => Math.exp(mean(values.map(Math.log)));
const countBy = (values) =>
  Object.fromEntries(
    [...new Set(values)].map((key) => [
      key,
      values.filter((v) => v === key).length,
    ]),
  );
export function quantile(values, p) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
}

export function parentClockOrigin(raw) {
  const phase = raw.driver.phases[0];
  const marker = raw.phaseMarkers[0];
  assert.equal(phase.phase, marker.phase);
  return phase.clockOrigin + phase.at - marker.at;
}

export function calibrationSummary(report) {
  const cases = report.caseResults.filter((c) => c.calibration);
  const matrix = cases.filter((c) => c.id.endsWith('-matrix'));
  const intervals = matrix.flatMap((c) => c.calibration.intervals);
  const failed = intervals.filter((m) => m.decision !== 'passes');
  return {
    completedCases: cases.length,
    matrixGates: intervals.length,
    failedMatrixGates: failed.length,
    failedByMetric: countBy(failed.map((m) => m.id.split('/').at(-1))),
    failedByEndpoint: countBy(failed.map((m) => m.id.split('/')[0])),
    primary: matrix.flatMap((c) =>
      c.calibration.intervals
        .filter((m) => m.primary)
        .map((m) => ({ caseId: c.id, ...m })),
    ),
    ordering: matrix.flatMap((c) => {
      const runs = report.runs.filter(
        (r) => r.caseId === c.id && r.stage === 'calibration',
      );
      return c.calibration.intervals.map((metric) => {
        const ratios = [];
        for (let repetition = 1; repetition <= 6; repetition++) {
          const pair = runs.filter((r) => r.repetition === repetition);
          assert.equal(pair.length, 2);
          ratios.push(
            pair[1].metrics.values[metric.id] /
              pair[0].metrics.values[metric.id],
          );
        }
        return {
          caseId: c.id,
          metric: metric.id,
          assignedArmRatio: metric.estimate,
          chronologicalSecondFirstRatio: geometric(ratios),
          chronologicalRatios: ratios,
        };
      });
    }),
  };
}

function overlap(events, origin, start, end) {
  if (!events) return null;
  return events.reduce(
    (sum, e) =>
      sum +
      Math.max(
        0,
        Math.min(end, origin + e.startMs + e.durationMs) -
          Math.max(start, origin + e.startMs),
      ),
    0,
  );
}

export function correlateNetwork(records, events) {
  const admitted = records.filter((r) => !r.outcome.endsWith('-skipped'));
  const creates = events.filter((r) => r.name === 'undici:request:create');
  assert.equal(creates.length, admitted.length, 'Incomplete network creates');
  assert.equal(new Set(creates.map((r) => r.requestId)).size, creates.length);
  return new Map(
    admitted.map((record, i) => {
      const create = creates[i];
      // The retained events lack the correlation header in this runtime. Pair
      // synchronous fetch creation with the immediately preceding
      // offer, validating every path and interval instead of guessing from time.
      assert.equal(create.path, record.path, 'Network/request path mismatch');
      assert(create.atMs >= record.offeredAt, 'Network create precedes offer');
      assert(
        create.atMs <= record.settledAt,
        'Network create follows settlement',
      );
      if (admitted[i + 1])
        assert(
          create.atMs < admitted[i + 1].offeredAt,
          'Ambiguous network create',
        );
      if (create.probeId !== undefined) assert.equal(create.probeId, record.id);
      const milestones = events.filter((r) => r.requestId === create.requestId);
      const at = (name) =>
        milestones.find((r) => r.name === 'undici:request:' + name)?.atMs;
      return [
        record.id,
        {
          requestId: create.requestId,
          createAtMs: create.atMs,
          bodySentAtMs: at('bodySent'),
          headersAtMs: at('headers'),
          trailersAtMs: at('trailers'),
          errors: milestones
            .filter((r) => r.name === 'undici:request:error')
            .map((r) => ({ atMs: r.atMs, ...r.error })),
        },
      ];
    }),
  );
}

export function summarizeTrial(raw, probes = {}) {
  const server = new Map(raw.requests.map((r) => [r.id, r]));
  const apiOrigin = probes.api?.find((r) => r.event === 'start')?.timeOrigin;
  const apiGc = probes.api?.filter((r) => r.event === 'gc');
  const driverGc = probes.driver?.filter((r) => r.event === 'gc');
  const networkEvents = probes.driver?.filter((r) => r.event === 'network');
  const network = networkEvents?.length
    ? correlateNetwork(raw.driver.records, networkEvents)
    : null;
  // Receipt lies within a successful client's round trip. This bounds clock
  // offsets in historical traces that lack the API process's clock origin.
  const successes = raw.driver.records.filter((r) => r.outcome === 'success');
  const clockOffsetBounds =
    apiOrigin === undefined
      ? [
          Math.max(
            ...successes.map((r) => r.offeredAt - server.get(r.id).receivedAt),
          ),
          Math.min(
            ...successes.map(
              (r) => r.bodyCompletedAt - server.get(r.id).receivedAt,
            ),
          ),
        ]
      : [
          apiOrigin - raw.driver.clockOrigin,
          apiOrigin - raw.driver.clockOrigin,
        ];
  assert(
    clockOffsetBounds[0] <= clockOffsetBounds[1],
    'Inconsistent process clocks',
  );
  const rows = raw.driver.records
    .filter((r) => r.sample)
    .map((r) => {
      const s = server.get(r.id);
      const n = network?.get(r.id);
      const start = raw.driver.clockOrigin + r.offeredAt;
      const end =
        raw.driver.clockOrigin +
        (r.bodyCompletedAt ?? r.settledAt ?? r.offeredAt);
      return {
        id: r.id,
        case: r.case,
        phase: r.phase,
        outcome: r.outcome,
        lateSuccess:
          r.outcome === 'success' && r.elapsedMs > raw.driver.timeoutMs,
        elapsedMs: r.elapsedMs,
        sqlMs: s?.sqlMs,
        handlerMs:
          s?.finishedAt === undefined ? undefined : s.finishedAt - s.receivedAt,
        serverObserved: Boolean(s),
        serverArrivalDelayBoundsMs: s
          ? clockOffsetBounds.map(
              (offset) => s.receivedAt + offset - r.offeredAt,
            )
          : null,
        network: n,
        createDelayMs: n ? n.createAtMs - r.offeredAt : null,
        sendDelayMs:
          n?.bodySentAtMs === undefined ? null : n.bodySentAtMs - r.offeredAt,
        sendToReceiptBoundsMs:
          s && n?.bodySentAtMs !== undefined
            ? clockOffsetBounds.map(
                (offset) => s.receivedAt + offset - n.bodySentAtMs,
              )
            : null,
        headersToCompletionMs:
          r.bodyCompletedAt !== undefined && n?.headersAtMs !== undefined
            ? r.bodyCompletedAt - n.headersAtMs
            : null,
        apiGcMs: overlap(apiGc, apiOrigin, start, end),
        driverGcMs: overlap(driverGc, raw.driver.clockOrigin, start, end),
      };
    });
  const groups = [...new Set(rows.map((r) => r.case + '/' + r.phase))].map(
    (key) => {
      const all = rows.filter((r) => r.case + '/' + r.phase === key);
      const samples = all.filter((r) => r.outcome === 'success');
      const segment = (s) => ({
        httpP50Ms: quantile(
          s.map((r) => r.elapsedMs),
          0.5,
        ),
        sqlMeanMs: s.length ? mean(s.map((r) => r.sqlMs)) : null,
      });
      const gcRows = samples.filter(
        (r) => (r.apiGcMs ?? 0) + (r.driverGcMs ?? 0) > 0,
      );
      const noGc = samples.filter((r) => r.apiGcMs === 0 && r.driverGcMs === 0);
      return {
        key,
        offered: all.length,
        outcomes: countBy(all.map((r) => r.outcome)),
        lateSuccesses: all.filter((r) => r.lateSuccess).length,
        failuresObservedByServer: all.filter(
          (r) => (r.outcome !== 'success' || r.lateSuccess) && r.serverObserved,
        ).length,
        httpP50Ms: quantile(
          samples.map((r) => r.elapsedMs),
          0.5,
        ),
        httpP95Ms: quantile(
          samples.map((r) => r.elapsedMs),
          0.95,
        ),
        sqlMeanMs: samples.length ? mean(samples.map((r) => r.sqlMs)) : null,
        createDelayP95Ms: network
          ? quantile(
              samples.map((r) => r.createDelayMs),
              0.95,
            )
          : null,
        sendDelayP95Ms: network
          ? quantile(
              samples.map((r) => r.sendDelayMs),
              0.95,
            )
          : null,
        headersToCompletionP95Ms: network
          ? quantile(
              samples.map((r) => r.headersToCompletionMs),
              0.95,
            )
          : null,
        sqlP95Ms: quantile(
          samples.map((r) => r.sqlMs),
          0.95,
        ),
        handlerP95Ms: quantile(
          samples.map((r) => r.handlerMs),
          0.95,
        ),
        residualP95Ms: quantile(
          samples.map((r) => r.elapsedMs - r.handlerMs),
          0.95,
        ),
        first10: segment(samples.slice(0, 10)),
        last10: segment(samples.slice(-10)),
        gcObserved: Boolean(apiGc && driverGc),
        gcOverlaps: gcRows.length,
        withGcP95Ms: quantile(
          gcRows.map((r) => r.elapsedMs),
          0.95,
        ),
        withoutGcP95Ms: quantile(
          noGc.map((r) => r.elapsedMs),
          0.95,
        ),
        slowest: [...samples]
          .sort((a, b) => b.elapsedMs - a.elapsedMs)
          .slice(0, 5),
      };
    },
  );
  const hostSamples = probes.parent?.filter(
    (r) => r.event === 'sample' && r.host,
  );
  const host = hostSamples?.map((r) => {
    const sums = r.host.cpuTimes.reduce(
      (s, c) => ({
        idle: s.idle + c.idle,
        total: s.total + Object.values(c).reduce((a, n) => a + n, 0),
      }),
      { idle: 0, total: 0 },
    );
    return {
      atMs: r.atMs,
      idlePercent: sums.total ? (sums.idle * 100) / sums.total : null,
      freeBytes: r.host.freeBytes,
      load1: r.host.load[0],
    };
  });
  return {
    clockAlignment:
      apiOrigin === undefined
        ? 'bounds from successful round trips'
        : 'recorded process origins',
    clockOffsetBounds,
    groups,
    host,
    failures: rows.filter((r) => r.outcome !== 'success' || r.lateSuccess),
    schedulingGaps: Object.entries(probes).flatMap(([role, events]) =>
      events
        .filter((r) => r.event === 'scheduling-gap')
        .map((r) => ({ role, ...r })),
    ),
  };
}

function failureSummary(directory, origin) {
  const health = read(path.join(directory, 'health.json'));
  const pairs = health.slice(1).map((r, i) => ({
    gapMs: r.offeredAt - health[i].offeredAt,
    before: health[i].offeredAt,
    after: r.offeredAt,
  }));
  const gap = pairs.sort((a, b) => b.gapMs - a.gapMs)[0];
  const requests = journal(path.join(directory, 'requests.jsonl'));
  const settled = new Set(
    requests.filter((r) => r.event === 'settled').map((r) => r.id),
  );
  const unfinished = requests.filter(
    (r) => r.event === 'offered' && !settled.has(r.id),
  );
  const observations = journal(path.join(directory, 'server.jsonl'));
  return {
    runDir: path.basename(directory),
    result: read(path.join(directory, 'result.json')),
    unfinished: unfinished.map((r) => ({
      ...r,
      server: observations.filter((s) => s.id === r.id),
    })),
    healthGap: gap
      ? {
          ...gap,
          beforeUtc: new Date(origin + gap.before).toISOString(),
          afterUtc: new Date(origin + gap.after).toISOString(),
        }
      : null,
  };
}

export function analyzeDirectory(input) {
  const report = read(path.join(input, 'results.json'));
  assert.equal(report.scenario, 'list');
  assert(report.runs.length, 'No completed performance trials');
  const origin = parentClockOrigin(
    read(path.join(input, report.runs[0].runDir, 'result.json')),
  );
  const trials = report.runs.map((run) => {
    const directory = path.join(input, run.runDir);
    const raw = read(path.join(directory, 'result.json'));
    const probes = Object.fromEntries(
      ['api', 'driver', 'parent'].flatMap((role) => {
        const file = path.join(directory, 'diagnostics-' + role + '.jsonl');
        return existsSync(file) ? [[role, journal(file)]] : [];
      }),
    );
    if (report.diagnostics)
      for (const role of ['api', 'driver', 'parent']) {
        assert.equal(
          probes[role]?.[0]?.event,
          'start',
          'Missing diagnostic start',
        );
        assert.equal(
          probes[role]?.at(-1)?.event,
          'stop',
          'Incomplete diagnostic trace',
        );
      }
    return {
      caseId: run.caseId,
      runDir: run.runDir,
      repetition: run.repetition,
      arm: run.arm,
      ...summarizeTrial(raw, probes),
    };
  });
  const failures = readdirSync(input, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-(matrix|load)-/.test(d.name))
    .flatMap((d) => {
      const directory = path.join(input, d.name);
      const file = path.join(directory, 'result.json');
      return existsSync(file) && read(file).failure
        ? [failureSummary(directory, origin)]
        : [];
    });
  return {
    input: path.resolve(input),
    reportSha256: hash(path.join(input, 'results.json')),
    analyzerSha256: hash(fileURLToPath(import.meta.url)),
    qualificationStatusUnchanged: report.qualification,
    note: 'Diagnostic summaries and correlations only. No qualification gates, repetitions or original measurements are changed.',
    calibration: calibrationSummary(report),
    trials,
    failures,
  };
}
