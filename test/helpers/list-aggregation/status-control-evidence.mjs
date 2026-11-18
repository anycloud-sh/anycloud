import assert from 'node:assert/strict';
import path from 'node:path';
import { readJson, readJsonLines, sameResponses } from './evidence.mjs';

export function sameSelectedResponses(reference, snapshots) {
  const selected = new Set(snapshots.map((snapshot) => snapshot.case));
  sameResponses(
    reference.filter((snapshot) => selected.has(snapshot.case)),
    snapshots,
  );
}

export function verifyDiagnosticTrial(directory, checked, trial, policy) {
  const { result, records } = checked;
  assert.equal(result.arm, trial.arm);
  const expected = [
    { case: trial.firstCaseId, phase: 'first-request', sample: false },
    ...trial.caseIds.flatMap((id) => [
      ...Array.from({ length: policy.warmups }, () => ({
        case: id,
        phase: 'warmup:' + id,
        sample: false,
      })),
      ...Array.from({ length: policy.samples }, () => ({
        case: id,
        phase: 'matrix:' + id,
        sample: true,
      })),
    ]),
  ];
  assert.deepEqual(
    records.map(({ case: id, phase, sample }) => ({ case: id, phase, sample })),
    expected,
    'Diagnostic request order or count changed',
  );
  const traces = {};
  for (const role of ['parent', 'api', 'driver']) {
    const trace = readJsonLines(
      path.join(directory, 'diagnostics-' + role + '.jsonl'),
    );
    const start = trace[0];
    const stop = trace.at(-1);
    assert.equal(start.event, 'start');
    assert.equal(stop.event, 'stop');
    assert.equal(start.role, role);
    assert(start.timeOrigin > 0);
    assert.equal(stop.observerWrites.count, trace.length - 1);
    assert(stop.observerWrites.elapsedMs >= 0);
    assert(stop.observerWrites.cpuMicros >= 0);
    const profile = readJson(path.join(directory, 'profile-' + role + '.json'));
    assert.equal(profile.role, role);
    assert.equal(profile.pid, start.pid);
    assert.equal(profile.clockOrigin, start.timeOrigin);
    assert(profile.profile.nodes.length && profile.profile.samples.length);
    assert.equal(
      profile.profile.samples.length,
      profile.profile.timeDeltas.length,
    );
    traces[role] = trace;
  }
  const operations = (role, id, name) =>
    traces[role].filter(
      (row) =>
        row.event === 'operation' && row.probeId === id && row.name === name,
    );
  for (const record of records) {
    for (const event of ['received', 'finished', 'closed'])
      assert.equal(
        operations('api', record.id, 'server-journal:' + event).length,
        1,
      );
    for (const name of ['response-serialize', 'response-end'])
      assert.equal(operations('api', record.id, name).length, 1, name);
    for (const event of ['offered', 'settled'])
      assert.equal(
        operations('driver', record.id, 'request-journal:' + event).length,
        1,
      );
    assert(operations('driver', record.id, 'body-hash-and-copy').length > 0);
    for (const name of [
      'undici:request:create',
      'undici:request:headers',
      'undici:request:trailers',
    ])
      assert.equal(
        traces.driver.filter(
          (row) =>
            row.event === 'network' &&
            row.probeId === record.id &&
            row.name === name,
        ).length,
        1,
        'Missing client transport event: ' + name,
      );
    const observed = result.requests.find((row) => row.id === record.id);
    for (const event of ['sql-start', 'sql-end'])
      assert.equal(
        traces.api.filter(
          (row) => row.event === event && row.requestId === record.id,
        ).length,
        observed.sqlCount,
        'Missing per-request SQL diagnostic',
      );
  }
  for (const trace of Object.values(traces))
    for (const row of trace.filter((item) => item.event === 'operation')) {
      assert(Number.isFinite(row.durationMs) && row.durationMs >= 0);
      assert.equal(row.durationMs, row.endedAtMs - row.startedAtMs);
      assert(row.cpu.user >= 0 && row.cpu.system >= 0);
    }
  return { requests: records.length, profiles: 3, diagnosticOnly: true };
}
