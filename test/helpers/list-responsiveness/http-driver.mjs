import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { installGuard } from './guard.mjs';
import {
  matrixCases,
  loadCases,
  correctnessCases,
  checkResponse,
  requestHeaders,
} from './cases.mjs';
import { arrivalDisposition, summarizeRequests } from './accounting.mjs';

const options = JSON.parse(process.argv[2]);
const guard = installGuard({ port: options.port });
let finished = false;
process.once('disconnect', () => {
  if (!finished) process.exit(1);
});
const records = [];
const snapshots = [];
let counter = 0;
let peakInFlight = 0;
const pending = new Set();
const timeoutMs = options.timeoutMs ?? 15000;
const send = (message) =>
  new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve())),
  );
const origin = 'http://127.0.0.1:' + options.port;

function journalRequest(record) {
  appendFileSync(
    path.join(options.runDir, 'request-journal.jsonl'),
    JSON.stringify(record) + '\n',
  );
}

async function request(
  testCase,
  phase,
  due = performance.now(),
  sample = true,
) {
  const offeredAt = performance.now();
  const record = {
    id: 'request-' + counter++,
    case: testCase.id,
    path: testCase.path,
    phase,
    sample,
    scheduledAt: due,
    offeredAt,
    offerDelayMs: Math.max(0, offeredAt - due),
    outcome: 'unfinished',
    bytes: 0,
  };
  records.push(record);
  journalRequest(record);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const pieces = [];
  try {
    const response = await fetch(origin + testCase.path, {
      headers: requestHeaders(testCase, options.version, record.id, phase),
      signal: controller.signal,
    });
    record.status = response.status;
    for await (const piece of response.body) {
      record.bytes += piece.length;
      if (record.bytes > 64 * 1024 * 1024) {
        record.outcome = 'body-limit';
        controller.abort();
        break;
      }
      if (options.mode === 'correctness') pieces.push(Buffer.from(piece));
    }
    if (record.outcome !== 'body-limit')
      record.outcome = response.ok ? 'success' : 'http-error';
    if (options.mode === 'correctness') {
      const body = Buffer.concat(pieces);
      const data = JSON.parse(body);
      checkResponse(testCase, data, response.status, options.scope);
      const snapshot = {
        case: testCase.id,
        status: response.status,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
      };
      snapshots.push(snapshot);
      writeFileSync(
        path.join(options.runDir, testCase.id + '.json.gz'),
        gzipSync(body),
      );
    }
  } catch (error) {
    if (options.mode === 'correctness') throw error;
    if (record.outcome !== 'body-limit')
      record.outcome = controller.signal.aborted
        ? 'timeout'
        : 'transport-error';
    record.error = error.message;
  } finally {
    clearTimeout(timer);
    record.settledAt = performance.now();
    record.elapsedMs = record.settledAt - offeredAt;
    record.scheduledElapsedMs = record.settledAt - due;
    journalRequest(record);
  }
  return record;
}

async function matrix() {
  const cases = matrixCases();
  await request(cases.at(-1), 'first-request', undefined, false);
  for (const testCase of cases) {
    send({ kind: 'phase', phase: 'matrix:' + testCase.id });
    for (let i = 0; i < (options.warmups ?? (options.small ? 2 : 10)); i++)
      await request(testCase, 'warmup:' + testCase.id, undefined, false);
    for (let i = 0; i < options.samples; i++)
      await request(testCase, 'matrix:' + testCase.id);
  }
}

async function load() {
  const cases = loadCases(options.fixture);
  // Each real endpoint receives the same warmup before the fixed-arrival lane.
  for (const testCase of cases)
    await request(testCase, 'endpoint-warmup', undefined, false);
  const phases = options.small
    ? [
        { name: 'normal', seconds: 2, rate: 2.4 },
        { name: 'overload', seconds: 3, rate: 8 },
        { name: 'recovery', seconds: 3, rate: 2.4 },
      ]
    : [
        { name: 'normal', seconds: 30, rate: 2.4 },
        { name: 'overload', seconds: 60, rate: 8 },
        { name: 'recovery', seconds: 90, rate: 2.4 },
      ];
  let nextPhase = performance.now();
  let offer = 0;
  for (const phase of phases) {
    send({ kind: 'phase', phase: phase.name });
    const planned = Math.floor(phase.seconds * phase.rate);
    for (let i = 0; i < planned; i++) {
      const due = nextPhase + (i * 1000) / phase.rate;
      if (due > performance.now()) await sleep(due - performance.now());
      const testCase = cases[offer++ % cases.length];
      const now = performance.now();
      const disposition = arrivalDisposition({
        now,
        due,
        maximumLagMs: 100,
        inFlight: pending.size,
        maximumInFlight: 128,
      });
      if (disposition !== 'admitted') {
        const record = {
          id: 'request-' + counter++,
          case: testCase.id,
          path: testCase.path,
          phase: phase.name,
          sample: true,
          scheduledAt: due,
          offeredAt: now,
          offerDelayMs: Math.max(0, now - due),
          outcome: disposition,
          bytes: 0,
        };
        records.push(record);
        journalRequest(record);
      } else {
        const work = request(testCase, phase.name, due).finally(() =>
          pending.delete(work),
        );
        pending.add(work);
        peakInFlight = Math.max(peakInFlight, pending.size);
      }
    }
    nextPhase += phase.seconds * 1000;
    if (nextPhase > performance.now())
      await sleep(nextPhase - performance.now());
  }
  send({ kind: 'phase', phase: 'drain' });
  await Promise.all([...pending]);
}

try {
  if (options.mode === 'correctness') {
    for (const testCase of correctnessCases(options.scope))
      await request(testCase, 'correctness');
  } else if (options.mode === 'matrix') await matrix();
  else if (options.mode === 'load') await load();
  else throw new Error('Unknown driver mode');
  guard.assertClean();
  const measured = records.filter((record) => record.sample);
  if (options.mode === 'matrix') {
    const summary = summarizeRequests(measured, timeoutMs);
    assert.equal(
      summary.completed,
      summary.offered,
      'Matrix requests must all complete successfully',
    );
    assert.equal(
      summary.deadlineMisses,
      0,
      'Matrix request exceeded its deadline',
    );
  }
  await send({
    kind: 'result',
    result: {
      mode: options.mode,
      records,
      snapshots,
      peakInFlight,
      timeoutMs,
      clockOrigin: performance.timeOrigin,
      summary: summarizeRequests(measured, timeoutMs),
      phases: Object.fromEntries(
        [...new Set(measured.map((record) => record.phase))].map((phase) => [
          phase,
          summarizeRequests(
            measured.filter((record) => record.phase === phase),
            timeoutMs,
          ),
        ]),
      ),
    },
  });
} catch (error) {
  await send({ kind: 'failure', error: error.stack });
  process.exitCode = 1;
} finally {
  writeFileSync(
    path.join(options.runDir, 'requests.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  finished = true;
  process.disconnect();
}
