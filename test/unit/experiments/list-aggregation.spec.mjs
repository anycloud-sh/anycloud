import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  workBudget,
  inventory,
  verifyInventory,
  validateTrial,
  writeJson,
  digest,
} from '../../helpers/list-aggregation/evidence.mjs';
import {
  pairedIntervals,
  completePairBootstrap,
  classifyInterval,
  penaltySummary,
} from '../../helpers/list-aggregation/qualification.mjs';
import { summarizeRequests } from '../../helpers/list-aggregation/accounting.mjs';
import { readRequestJournal } from '../../helpers/list-aggregation/traces.mjs';
import { classifyListStatement } from '../../helpers/list-aggregation/sql-shapes.mjs';

const temporary = [];
const directory = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'list-aggregation-test-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true });
});

function trialFixture(dir) {
  const body = Buffer.from('[]');
  const snapshot = {
    case: 'ordinary-1000',
    file: 'ordinary-1000.json.gz',
    bytes: body.length,
    bodySha256: digest(body),
    status: 200,
    headers: { contentType: 'application/json' },
  };
  const record = {
    id: 'request-0',
    case: snapshot.case,
    path: '/v1/workloads?limit=1000',
    phase: 'matrix:ordinary-1000',
    sample: true,
    outcome: 'success',
    status: 200,
    elapsedMs: 1,
    offeredAt: 0,
    scheduledAt: 0,
    offerDelayMs: 0,
    bytes: body.length,
    bodySha256: snapshot.bodySha256,
  };
  const observed = {
    id: record.id,
    receivedAt: 0,
    finishedAt: 1,
    path: record.path,
    sqlMs: 0.5,
    sqlCount: 1,
  };
  const health = {
    phase: 'work',
    scheduledAt: 0,
    offeredAt: 0,
    offerDelayMs: 0,
    ok: true,
    status: 200,
    elapsedMs: 1,
  };
  const result = {
    exitCode: 0,
    setup: { compileOptions: [] },
    serverDrained: true,
    pendingAfterDrain: {},
    nativeRecords: [],
    requests: [observed],
    queryPlans: [{ sql: 'SELECT 1', details: ['SCAN CONSTANT ROW'] }],
    driver: {
      records: [record],
      snapshots: [snapshot],
      timeoutMs: 15000,
      summary: summarizeRequests([record], 15000),
    },
  };
  writeJson(path.join(dir, 'result.json'), result);
  writeFileSync(path.join(dir, snapshot.file), gzipSync(body));
  writeJson(path.join(dir, 'health.json'), [health]);
  const lines = (name, rows) =>
    writeFileSync(
      path.join(dir, name),
      rows.map((r) => JSON.stringify(r) + '\n').join(''),
    );
  lines('requests.jsonl', [
    { ...record, sequence: 0, event: 'offered', outcome: 'unfinished' },
    { ...record, sequence: 1, event: 'settled' },
  ]);
  lines('server.jsonl', [
    { event: 'received', ...observed },
    { event: 'finished', ...observed },
  ]);
  lines('health.jsonl', [
    { event: 'offered', ...health },
    { event: 'settled', ...health },
  ]);
  return { result, record };
}

describe('list aggregation evidence and qualification', () => {
  it('rejects a new list projection shape while leaving unrelated SQL alone', () => {
    expect(classifyListStatement('SELECT 1')).toBe(null);
    expect(() =>
      classifyListStatement('SELECT unknown.*, 1 AS latest_event_metadata'),
    ).toThrow(/Unrecognized public list/);
  });
  it('keeps the work budget independent of noisy wall time and includes every temporary structure', () => {
    const make = (kind, bytes) => ({
      nativeRecords: [
        {
          rows: 10,
          case: 'ordinary-1000',
          kind: 'ordinary',
          readBytes: 0,
          writeBytes: 0,
          sites: [{ kind, records: 100, bytes, maxBytes: bytes / 100 }],
        },
      ],
    });
    for (const kind of [1, 2, 3]) {
      expect(workBudget(make(kind, 19200)).passes).toBe(true);
      expect(workBudget(make(kind, 19201)).passes).toBe(false);
    }
    expect(() => workBudget({ nativeRecords: [] })).toThrow(/No nonempty/);
  });

  it('thresholds paired ratios when arm medians point in the opposite direction', () => {
    const a = [1, 1, 1, 100, 100, 100];
    const b = [2, 2, 2, 80, 80, 80];
    const intervals = pairedIntervals(
      a.map((value, i) => ({
        baseline: { cost: value },
        candidate: { cost: b[i] },
      })),
      [{ id: 'cost', type: 'ratio', primary: true }],
    );
    expect(intervals[0].estimate).toBeCloseTo(Math.sqrt(1.6));
    expect(intervals[0].descriptive.armMedianRatio).toBeLessThan(1);
    expect(intervals[0].resamples).toBe(46656);
  });

  it('resamples complete vectors jointly', () => {
    const draws = completePairBootstrap(
      [1, 2, 3, 4, 5, 6].map((n) => [n, 2 * n]),
    );
    expect(draws[0]).toHaveLength(46656);
    expect(draws[1].every((value, i) => value === 2 * draws[0][i])).toBe(true);
  });

  it('retains inclusive boundaries and distinguishes rejection from uncertainty', () => {
    expect(
      classifyInterval({ type: 'ratio', lower: 0.95, upper: 1.05 }, true),
    ).toBe('passes');
    expect(
      classifyInterval({ type: 'ratio', lower: 0.95, upper: 1.05001 }, true),
    ).toBe('inconclusive');
    expect(
      classifyInterval({
        type: 'ratio',
        primary: true,
        lower: 0.8,
        upper: 0.9,
      }),
    ).toBe('passes');
    expect(
      classifyInterval({
        type: 'ratio',
        primary: true,
        lower: 0.90001,
        upper: 1,
      }),
    ).toBe('reject');
    expect(
      classifyInterval({
        type: 'ratio',
        primary: true,
        lower: 0.8,
        upper: 0.95,
      }),
    ).toBe('inconclusive');
  });

  it('penalizes delayed successes, skips, cancellation and unfinished requests', () => {
    const outcomes = [
      'success',
      'success',
      'scheduling-skip',
      'admission-skip',
      'timeout',
      'unfinished',
    ];
    const records = outcomes.map((outcome, i) => ({
      outcome,
      elapsedMs: i === 0 ? 1 : 16000,
    }));
    const result = penaltySummary(records, 15000);
    expect(result.failureRatePp).toBeCloseTo(500 / 6);
    expect(result.penalizedP95Ms).toBe(15000);
    expect(result.successfulP95Ms).toBe(16000);
  });

  it('requires complete request, server, health and gzip evidence', () => {
    const dir = directory();
    trialFixture(dir);
    expect(validateTrial(dir).records).toHaveLength(1);
    writeFileSync(
      path.join(dir, 'ordinary-1000.json.gz'),
      gzipSync(Buffer.from('[1]')),
    );
    expect(() => validateTrial(dir)).toThrow(
      /byte count mismatch|hash mismatch/,
    );
  });

  it('rejects cancelled partial request traces and missing health settlements', () => {
    const dir = directory();
    const { record } = trialFixture(dir);
    writeFileSync(
      path.join(dir, 'requests.jsonl'),
      JSON.stringify({ ...record, event: 'offered', sequence: 0 }) + '\n',
    );
    expect(() => readRequestJournal(path.join(dir, 'requests.jsonl'))).toThrow(
      /Unfinished/,
    );
    trialFixture(dir);
    writeFileSync(
      path.join(dir, 'health.jsonl'),
      JSON.stringify({ event: 'offered', scheduledAt: 0 }) + '\n',
    );
    expect(() => validateTrial(dir)).toThrow(/Unfinished health/);
  });

  it('detects artifact disappearance and corruption independently of the writer', () => {
    const dir = directory();
    writeFileSync(path.join(dir, 'proof.json'), '{}\n');
    inventory(dir, []);
    expect(verifyInventory(dir).files).toBe(1);
    writeFileSync(path.join(dir, 'proof.json'), '[]\n');
    expect(() => verifyInventory(dir)).toThrow(/hash mismatch/);
    rmSync(path.join(dir, 'proof.json'));
    expect(() => verifyInventory(dir)).toThrow(/Missing or unexpected/);
  });

  it('retains caught provider violations as fatal evidence', () => {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../helpers/list-aggregation/guard-check.mjs',
              import.meta.url,
            ),
          ),
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH } },
      ),
    );
    expect(result.caught).toHaveLength(3);
    expect(result.violations).toHaveLength(3);
    expect(result.fatal).toContain('caught isolation violation');
  });
});
