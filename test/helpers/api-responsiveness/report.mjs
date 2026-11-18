import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { median } from './metrics.mjs';

export function directoryHash(directory) {
  const hash = createHash('sha256');
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        hash.update(path.relative(directory, file) + '\0');
        hash.update(readFileSync(file));
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}

export function revisionMetadata(buildDir) {
  assert(
    existsSync(path.join(buildDir, 'dist/api/server.js')),
    'Build this checkout before benchmarking: ' + buildDir,
  );
  const git = (...args) =>
    execFileSync('git', args, { cwd: buildDir, encoding: 'utf8' }).trim();
  return {
    sourceSha: git('rev-parse', 'HEAD'),
    sourceDirty:
      git(
        'status',
        '--porcelain',
        '--',
        'src',
        'migrations',
        'package.json',
        'yarn.lock',
      ) !== '',
    buildSha256: directoryHash(path.join(buildDir, 'dist')),
    migrationsSha256: directoryHash(path.join(buildDir, 'migrations')),
    lockfileSha256: createHash('sha256')
      .update(readFileSync(path.join(buildDir, 'yarn.lock')))
      .digest('hex'),
    version: JSON.parse(
      readFileSync(path.join(buildDir, 'package.json'), 'utf8'),
    ).version,
  };
}

export function runtimeMetadata() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

export function pairedOrder(repetition) {
  return repetition % 2 === 0
    ? ['baseline', 'candidate']
    : ['candidate', 'baseline'];
}

export function summarizeRuns(runs) {
  const cases = [...new Set(runs.map((run) => run.profile + '/' + run.case))];
  return cases.map((key) => {
    const selected = runs.filter((run) => run.profile + '/' + run.case === key);
    const arms = Object.fromEntries(
      ['baseline', 'candidate'].map((arm) => {
        const trials = selected.filter((run) => run.arm === arm);
        return [
          arm,
          {
            trials: trials.length,
            medianElapsedMs: median(trials.map((run) => run.elapsedMs)),
            medianCpuMs: median(trials.map((run) => run.cpuMs)),
            medianSqlMs: median(
              trials.map((run) => run.sql.totalMs).filter(Number.isFinite),
            ),
            medianTransactionOverheadMs: median(
              trials
                .map((run) => run.sql.transactionOverheadMs)
                .filter(Number.isFinite),
            ),
            maxTransactionMs: trials.some((run) =>
              Number.isFinite(run.sql.maxTransactionMs),
            )
              ? Math.max(
                  ...trials
                    .map((run) => run.sql.maxTransactionMs)
                    .filter(Number.isFinite),
                )
              : null,
            maxEventLoopMs: trials.length
              ? Math.max(
                  ...trials.map((run) =>
                    Math.max(run.eventLoopMaxMs, run.initialTimerDelayMs),
                  ),
                )
              : null,
            maxSqlMs: trials.length
              ? Math.max(...trials.map((run) => run.sql.maxMs))
              : null,
            maxReturnedRows: trials.length
              ? Math.max(...trials.map((run) => run.sql.maxReturnedRows))
              : null,
            healthOffers: trials.reduce(
              (sum, run) => sum + run.health.offered,
              0,
            ),
            healthMisses: trials.reduce(
              (sum, run) => sum + run.health.deadlineMisses,
              0,
            ),
            healthErrors: trials.reduce(
              (sum, run) => sum + run.health.otherFailures,
              0,
            ),
            unsampledTrials: trials.filter(
              (run) => run.health.responsive === null,
            ).length,
          },
        ];
      }),
    );
    return { case: key, ...arms };
  });
}

/** Each independent case retains its own runtime and six paired trials. */
export function combineCaseReports(
  entries,
  {
    profiles,
    repetitions,
    responses = ['empty', 'mixed'],
    boundaries = ['immediate', 'yield'],
  },
) {
  assert(Number.isSafeInteger(repetitions) && repetitions > 0);
  for (const [name, values, allowed] of [
    ['profiles', profiles, ['smoke', 'standard', 'backlog3', 'oversized']],
    ['responses', responses, ['empty', 'mixed']],
    ['boundaries', boundaries, ['immediate', 'yield']],
  ]) {
    assert(
      values.length > 0 &&
        new Set(values).size === values.length &&
        values.every((value) => allowed.includes(value)),
      'Invalid comparison ' + name,
    );
  }
  const expected = profiles.flatMap((profile) =>
    responses.flatMap((response) =>
      boundaries.map((boundary) => ({
        name: [profile, response, boundary].join('-'),
        profile,
        case: response + '-' + boundary,
      })),
    ),
  );
  const failures = [];
  const reference = entries.find(
    (entry) => entry.report?.status === 'complete',
  )?.report;
  const cases = expected.map((item) => {
    const matches = entries.filter((entry) => entry.name === item.name);
    const report = matches[0]?.report;
    try {
      assert.equal(matches.length, 1, 'Expected exactly one case report');
      assert(report, matches[0].failure ?? 'Missing report');
      assert.equal(report.formatVersion, 1, 'Unsupported report format');
      assert.equal(report.scenario, 'billing');
      assert.equal(
        report.status,
        'complete',
        report.failure ?? 'Incomplete case',
      );
      assert.equal(report.repetitions, repetitions, 'Wrong paired trial count');
      assert.deepEqual(report.profiles, [item.profile]);
      assert.match(report.runtime.node, /^v22\./, 'Expected Node 22');
      assert.equal(
        report.harnessSha256,
        reference.harnessSha256,
        'Mixed harness versions',
      );
      assert.deepEqual(
        report.revisions,
        reference.revisions,
        'Mixed build revisions',
      );
      for (const arm of ['baseline', 'candidate']) {
        assert.equal(
          report.revisions[arm].sourceDirty,
          false,
          'Dirty measured source',
        );
        assert(
          report.preparation[item.profile]?.[arm],
          'Missing preparation evidence',
        );
      }
      assert(report.fixtures[item.profile], 'Missing fixture manifest');
      assert.equal(
        report.runs.length,
        repetitions * 2,
        'Missing or extra trials',
      );
      for (let repetition = 0; repetition < repetitions; repetition++) {
        pairedOrder(repetition).forEach((arm, offset) => {
          const run = report.runs[repetition * 2 + offset];
          assert.equal(run.profile, item.profile, 'Unexpected trial profile');
          assert.equal(run.case, item.case, 'Unexpected trial case');
          assert.equal(run.repetition, repetition + 1, 'Wrong trial order');
          assert.equal(run.arm, arm, 'Wrong alternating arm order');
        });
      }
      // Validate the metrics needed by the report while keeping timing and
      // health misses informational. Raw sample validity is checked by the driver.
      summarizeRuns(report.runs);
      return { ...item, status: 'complete', report };
    } catch (error) {
      const failure = error.message;
      failures.push(item.name + ': ' + failure);
      return { ...item, status: 'failed', failure };
    }
  });
  for (const entry of entries) {
    if (!expected.some((item) => item.name === entry.name))
      failures.push('Unexpected case report: ' + entry.name);
  }
  return {
    formatVersion: 1,
    status: failures.length ? 'failed' : 'complete',
    profiles,
    responses,
    boundaries,
    repetitions,
    cases,
    failures,
  };
}

export function markdownMatrixReport(matrix) {
  const lines = [
    '# API responsiveness matrix',
    '',
    'Status: ' +
      matrix.status +
      '. ' +
      matrix.repetitions +
      ' alternating paired trials per case.',
    'Each case measures both revisions sequentially on one runner. Independent cases may use different hosts; compare arms within a case.',
    'Timing differences and one-second health misses are informational. Missing, failed, or inconsistent cases fail this report.',
    '',
    '| Case | Status | Node / CPU |',
    '| --- | --- | --- |',
  ];
  for (const item of matrix.cases) {
    const runtime = item.report?.runtime;
    lines.push(
      '| ' +
        item.name +
        ' | ' +
        item.status +
        ' | ' +
        (runtime ? runtime.node + ' / ' + runtime.cpuModel : 'unavailable') +
        ' |',
    );
  }
  for (const failure of matrix.failures) lines.push('', '- ' + failure);
  for (const item of matrix.cases.filter((item) => item.report)) {
    lines.push(
      '',
      '<details>',
      '<summary>' + item.name + '</summary>',
      '',
      markdownReport(item.report),
      '</details>',
    );
  }
  return lines.join('\n') + '\n';
}

function ms(value) {
  return value === null ? 'n/a' : value.toFixed(1);
}

function healthCell(arm) {
  const rate =
    arm.healthOffers === 0
      ? 'n/a (no offers)'
      : arm.healthMisses + '/' + arm.healthOffers;
  return (
    rate +
    '; ' +
    arm.healthErrors +
    ' errors; ' +
    arm.unsampledTrials +
    ' unsampled'
  );
}

export function markdownReport(report) {
  const lines = [
    '# API responsiveness comparison',
    '',
    'Timing differences are informational. Fixture, allocation, and harness failures fail the run.',
    '',
    '- Baseline: ' + report.revisions.baseline.sourceSha,
    '- Candidate: ' + report.revisions.candidate.sourceSha,
    '- Node: ' +
      report.runtime.node +
      '; ' +
      report.runtime.platform +
      '/' +
      report.runtime.arch,
    '- Harness SHA-256: ' + report.harnessSha256,
    '- Status: ' + report.status,
    '',
    '| Profile / response | Baseline median ms | Candidate median ms | Baseline max pause ms | Candidate max pause ms | Health misses / offers (base → candidate) |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const item of summarizeRuns(report.runs)) {
    const a = item.baseline;
    const b = item.candidate;
    lines.push(
      '| ' +
        item.case +
        ' | ' +
        ms(a.medianElapsedMs) +
        ' | ' +
        ms(b.medianElapsedMs) +
        ' | ' +
        ms(a.maxEventLoopMs) +
        ' | ' +
        ms(b.maxEventLoopMs) +
        ' | ' +
        healthCell(a) +
        ' → ' +
        healthCell(b) +
        ' |',
    );
  }
  lines.push(
    '',
    '| Workload / arm | Median synchronous SQL ms | Median transaction overhead ms | Max synchronous transaction ms |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const item of summarizeRuns(report.runs)) {
    for (const arm of ['baseline', 'candidate']) {
      const metrics = item[arm];
      lines.push(
        '| ' +
          item.case +
          '/' +
          arm +
          ' | ' +
          ms(metrics.medianSqlMs) +
          ' | ' +
          ms(metrics.medianTransactionOverheadMs) +
          ' | ' +
          ms(metrics.maxTransactionMs) +
          ' |',
      );
    }
  }
  lines.push(
    '',
    '| Setup profile / arm | Initialize + migrations ms | Added/changed index creation ms | Database MiB | Insert probe ms | Update probe ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [profile, arms] of Object.entries(report.preparation)) {
    for (const [arm, setup] of Object.entries(arms)) {
      lines.push(
        '| ' +
          profile +
          '/' +
          arm +
          ' | ' +
          ms(setup.initMs) +
          ' | ' +
          ms(setup.indexCreation.totalCreateMs) +
          ' | ' +
          (setup.storage.bytes / 1024 ** 2).toFixed(1) +
          ' | ' +
          ms(setup.writeProbe.insertMs) +
          ' | ' +
          ms(setup.writeProbe.updateMs) +
          ' |',
      );
    }
  }
  lines.push(
    '',
    'Index creation is a warm rebuild of added/changed DDL. Index and 256-row write probes roll back and exclude commit/fsync.',
    'Workload SQL includes implicit autocommit and explicit transaction begin/commit/rollback. Explicit transaction overhead is included once in SQL totals; maximum transaction time includes its entire synchronous callback.',
    'Zero work-phase health offers provide no health result. Late HTTP 200s count as deadline misses.',
    'CPU, memory, SQL, query plans, input digests, migration/storage/write costs, and every trial are in the JSON artifacts.',
    'Peak RSS includes startup and fixture validation. Maximum rows returned by one statement is not a page-memory bound.',
    '',
  );
  if (report.failure) lines.push('Run failed: ' + report.failure, '');
  return lines.join('\n');
}
