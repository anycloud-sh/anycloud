import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectMatrixCases } from '../../helpers/list-aggregation/cases.mjs';
import {
  StandardBracketNotationSerializer,
  StandardOpenAPIJsonSerializer,
  StandardOpenAPISerializer,
} from '@orpc/openapi-client/standard';
import { assertListShapeCoverage } from '../../helpers/list-aggregation/sql-shapes.mjs';
import {
  observeOperation,
  observeResponseSerialization,
} from '../../helpers/list-aggregation/diagnostic-operation.mjs';
import { STATUS_CONTROL } from '../../helpers/list-aggregation/status-control-policy.mjs';
import {
  sameSelectedResponses,
  verifyDiagnosticTrial,
} from '../../helpers/list-aggregation/status-control-evidence.mjs';

function diagnosticFixture(directory) {
  const trial = STATUS_CONTROL.diagnosticTrials[2];
  const policy = { warmups: 1, samples: 2 };
  const records = [
    'first-request',
    'warmup:terminal-status',
    'matrix:terminal-status',
    'matrix:terminal-status',
  ].map((phase, i) => ({
    id: 'request-' + i,
    case: 'terminal-status',
    phase,
    sample: i >= 2,
  }));
  const checked = {
    records,
    result: {
      arm: trial.arm,
      requests: records.map(({ id }) => ({ id, sqlCount: 1 })),
    },
  };
  const operation = (name, probeId) => ({
    event: 'operation',
    name,
    probeId,
    startedAtMs: 10,
    endedAtMs: 11,
    durationMs: 1,
    cpu: { user: 1, system: 0 },
  });
  for (const role of ['parent', 'api', 'driver']) {
    const trace = [{ event: 'start', role, pid: 100, timeOrigin: 1000 }];
    for (const { id } of records) {
      if (role === 'api') {
        for (const name of [
          'server-journal:received',
          'server-journal:finished',
          'server-journal:closed',
          'response-serialize',
          'response-end',
        ])
          trace.push(operation(name, id));
        for (const event of ['sql-start', 'sql-end'])
          trace.push({ event, requestId: id });
      } else if (role === 'driver') {
        for (const name of [
          'request-journal:offered',
          'request-journal:settled',
          'body-hash-and-copy',
        ])
          trace.push(operation(name, id));
        for (const name of [
          'undici:request:create',
          'undici:request:headers',
          'undici:request:trailers',
        ])
          trace.push({ event: 'network', name, probeId: id });
      }
    }
    trace.push({
      event: 'stop',
      observerWrites: { count: trace.length, elapsedMs: 1, cpuMicros: 1 },
    });
    writeFileSync(
      path.join(directory, 'diagnostics-' + role + '.jsonl'),
      trace.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    writeFileSync(
      path.join(directory, 'profile-' + role + '.json'),
      JSON.stringify({
        role,
        pid: 100,
        clockOrigin: 1000,
        profile: { nodes: [{ id: 1 }], samples: [1], timeDeltas: [1000] },
      }),
    );
  }
  return { checked, trial, policy };
}

describe('Bounded status-control diagnosis', () => {
  it('observes the real recursive oRPC serializer and preserves conversion, exceptions and unrelated calls', () => {
    const input = {
      vms: [{ ip: '192.0.2.1', endedAt: null, optional: undefined }],
      metadata: { count: 3n, date: new Date(0), invalid: NaN },
    };
    const serializer = new StandardOpenAPISerializer(
      new StandardOpenAPIJsonSerializer(),
      new StandardBracketNotationSerializer(),
    );
    const expected = serializer.serialize(input);
    const original = StandardOpenAPISerializer.prototype.serialize;
    const events = [];
    let owner = { id: 'request-1' };
    const restore = observeResponseSerialization(
      StandardOpenAPISerializer,
      () => owner,
      { write: (event, row) => events.push({ event, ...row }) },
    );
    try {
      expect(serializer.serialize(input)).toEqual(expected);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: 'response-serialize',
        probeId: 'request-1',
      });
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      const failure = new Error('getter failed');
      expect(() =>
        serializer.serialize({
          get value() {
            throw failure;
          },
        }),
      ).toThrow(failure);
      expect(events).toHaveLength(2);
      expect(serializer.serialize(input)).toEqual(expected);
      expect(events).toHaveLength(3);
      owner = undefined;
      expect(serializer.serialize(input)).toEqual(expected);
      expect(events).toHaveLength(3);
    } finally {
      restore();
    }
    expect(StandardOpenAPISerializer.prototype.serialize).toBe(original);
  });

  it('compares isolated status against the full sequence without overlooking missing or changed bodies', () => {
    const status = {
      case: 'terminal-status',
      status: 200,
      bytes: 12,
      bodySha256: 'unchanged',
      headers: { contentType: 'application/json' },
    };
    const reference = [{ ...status, case: 'ordinary-1000' }, status];
    expect(() => sameSelectedResponses(reference, [status])).not.toThrow();
    expect(() =>
      sameSelectedResponses(reference, [{ ...status, case: 'missing' }]),
    ).toThrow('Complete public responses differ');
    expect(() =>
      sameSelectedResponses(reference, [{ ...status, bodySha256: 'changed' }]),
    ).toThrow('Complete public responses differ');
  });

  it('keeps the isolated status request free of list warmup', () => {
    const fixture = { statusId: 'terminal', session: 'synthetic' };
    const isolated = selectMatrixCases(
      fixture,
      STATUS_CONTROL.diagnosticTrials[2],
    );
    expect(isolated.first).toEqual({
      id: 'terminal-status',
      path: '/v1/workloads/terminal',
    });
    expect(isolated.cases).toEqual([isolated.first]);
    const sequence = selectMatrixCases(
      fixture,
      STATUS_CONTROL.diagnosticTrials[0],
    );
    expect(sequence.first.id).toBe('ordinary-1000');
    expect(sequence.cases.map((row) => row.id)).toEqual(
      STATUS_CONTROL.endpoints,
    );
  });

  it('requires both list SQL shapes normally and no list SQL in the isolated status diagnostic', () => {
    const both = { ordinary: 4, terminatable: 3 };
    const neither = { ordinary: 0, terminatable: 0 };
    expect(() => assertListShapeCoverage(both)).not.toThrow();
    expect(() => assertListShapeCoverage(neither)).toThrow('Public list shape');
    const isolated = { mode: 'matrix', caseIds: ['terminal-status'] };
    expect(() => assertListShapeCoverage(neither, isolated)).not.toThrow();
    expect(() => assertListShapeCoverage(both, isolated)).toThrow(
      'Public list shape',
    );
    expect(() =>
      assertListShapeCoverage({ ordinary: 1, terminatable: 0 }),
    ).toThrow('Public list shape');
  });

  it('rejects omitted first requests, unknown cases and duplicate cases', () => {
    expect(() =>
      selectMatrixCases({}, { caseIds: ['terminal-status'] }),
    ).toThrow('First request');
    expect(() => selectMatrixCases({}, { caseIds: ['unknown'] })).toThrow(
      'Unknown or repeated',
    );
    expect(() =>
      selectMatrixCases({}, { caseIds: ['ordinary-1000', 'ordinary-1000'] }),
    ).toThrow('Unknown or repeated');
  });

  it('preserves return values and exceptions while observing synchronous work', () => {
    const rows = [];
    const probe = { write: (event, row) => rows.push({ event, ...row }) };
    const expected = { value: 1 };
    expect(
      observeOperation(undefined, 'off', 'request-0', () => expected),
    ).toBe(expected);
    expect(observeOperation(probe, 'return', 'request-1', () => expected)).toBe(
      expected,
    );
    const failure = new Error('caught isolation violation');
    expect(() =>
      observeOperation(probe, 'throw', 'request-2', () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(
      rows.map(({ event, name, probeId }) => ({ event, name, probeId })),
    ).toEqual([
      { event: 'operation', name: 'return', probeId: 'request-1' },
      { event: 'operation', name: 'throw', probeId: 'request-2' },
    ]);
    expect(
      rows.every(
        (row) =>
          row.durationMs >= 0 &&
          row.durationMs === row.endedAtMs - row.startedAtMs,
      ),
    ).toBe(true);
  });

  it('freezes four diagnostic trials without adding qualification pairs', () => {
    expect(
      STATUS_CONTROL.diagnosticTrials.map(({ id, arm }) => [id, arm]),
    ).toEqual([
      ['sequence-baseline', 'baseline'],
      ['sequence-candidate', 'candidate'],
      ['isolated-candidate', 'candidate'],
      ['isolated-baseline', 'baseline'],
    ]);
    expect(STATUS_CONTROL.executionBudgetMs).toBe(20 * 60_000);
    expect(STATUS_CONTROL.repetitions).toBe(0);
    expect(STATUS_CONTROL.promotion).toBe(false);
  });

  it('requires profiles and complete request-linked attribution after download', () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'list-status-attribution-'),
    );
    try {
      const { checked, trial, policy } = diagnosticFixture(directory);
      expect(verifyDiagnosticTrial(directory, checked, trial, policy)).toEqual({
        requests: 4,
        profiles: 3,
        diagnosticOnly: true,
      });
      const file = path.join(directory, 'diagnostics-driver.jsonl');
      const original = readFileSync(file, 'utf8');
      const trace = original
        .trim()
        .split('\n')
        .map(JSON.parse)
        .filter(
          (row) =>
            !(
              row.probeId === 'request-2' &&
              row.name === 'undici:request:headers'
            ),
        );
      trace.at(-1).observerWrites.count = trace.length - 1;
      writeFileSync(
        file,
        trace.map((row) => JSON.stringify(row)).join('\n') + '\n',
      );
      expect(() =>
        verifyDiagnosticTrial(directory, checked, trial, policy),
      ).toThrow('Missing client transport event');
      writeFileSync(file, original);
      rmSync(path.join(directory, 'profile-api.json'));
      expect(() =>
        verifyDiagnosticTrial(directory, checked, trial, policy),
      ).toThrow('ENOENT');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a hidden list request in an otherwise complete isolated trace', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'list-status-order-'));
    try {
      const { checked, trial, policy } = diagnosticFixture(directory);
      checked.records[0].case = 'ordinary-1000';
      expect(() =>
        verifyDiagnosticTrial(directory, checked, trial, policy),
      ).toThrow('Diagnostic request order');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
