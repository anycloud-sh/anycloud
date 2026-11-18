#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BILLING_PROFILES } from '../test/helpers/api-responsiveness/billing-fixture.mjs';
import { runChild } from '../test/helpers/api-responsiveness/run-child.mjs';
import {
  directoryHash,
  markdownReport,
  pairedOrder,
  revisionMetadata,
  runtimeMetadata,
} from '../test/helpers/api-responsiveness/report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    'base-dir': { type: 'string', default: root },
    'candidate-dir': { type: 'string', default: root },
    scenario: { type: 'string', default: 'billing' },
    profile: { type: 'string', default: 'standard' },
    response: { type: 'string', default: 'all' },
    boundary: { type: 'string', default: 'all' },
    repetitions: { type: 'string', default: '6' },
    'timeout-ms': { type: 'string', default: '1800000' },
    output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(
    'Usage: yarn probe:api-responsiveness [options]\n\n' +
      '  --base-dir DIR        Built baseline checkout (default: this checkout)\n' +
      '  --candidate-dir DIR   Built candidate checkout (default: this checkout)\n' +
      '  --scenario billing    List joins this shared runner after its spike\n' +
      '  --profile PROFILE     smoke | standard | backlog3 | oversized | all\n' +
      '  --response RESPONSE   empty | settled | mixed | all (empty + mixed)\n' +
      '  --boundary MODE       immediate | yield | all\n' +
      '  --repetitions N       Paired trials, alternating AB/BA (default: 6)\n' +
      '  --timeout-ms N        Child watchdog including setup (default: 1800000)\n' +
      '  --output NEW_DIR      Raw artifacts and Markdown/JSON report\n\n' +
      'Timings never gate CI. Setup is excluded; fixture and outcome failures fail the run.',
  );
} else {
  await main();
}

async function main() {
  assert.equal(
    values.scenario,
    'billing',
    'Only the qualified billing scenario is available',
  );
  const repetitions = Number(values.repetitions);
  assert(
    Number.isSafeInteger(repetitions) && repetitions > 0,
    'Invalid repetitions',
  );
  const timeoutMs = Number(values['timeout-ms']);
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 2_147_483_647,
    'Invalid child watchdog',
  );
  const profiles =
    values.profile === 'all'
      ? ['standard', 'backlog3', 'oversized']
      : [values.profile];
  assert(
    profiles.every((profile) => BILLING_PROFILES[profile]),
    'Unknown profile',
  );
  const responses =
    values.response === 'all' ? ['empty', 'mixed'] : [values.response];
  assert(
    responses.every((response) =>
      ['empty', 'settled', 'mixed'].includes(response),
    ),
    'Unknown response',
  );
  const boundaries =
    values.boundary === 'all' ? ['immediate', 'yield'] : [values.boundary];
  assert(
    boundaries.every((boundary) => ['immediate', 'yield'].includes(boundary)),
    'Unknown boundary',
  );
  const builds = {
    baseline: path.resolve(values['base-dir']),
    candidate: path.resolve(values['candidate-dir']),
  };
  const output = path.resolve(
    values.output ??
      path.join(
        root,
        '.context',
        'api-responsiveness-' + new Date().toISOString().replace(/[:.]/g, '-'),
      ),
  );
  assert(!existsSync(output), 'Output directory must be new: ' + output);
  const helpersDir = fileURLToPath(
    new URL('../test/helpers/api-responsiveness/', import.meta.url),
  );
  const harnessHash = () =>
    createHash('sha256')
      .update(directoryHash(helpersDir))
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex');
  const report = {
    formatVersion: 1,
    scenario: values.scenario,
    status: 'running',
    revisions: {
      baseline: revisionMetadata(builds.baseline),
      candidate: revisionMetadata(builds.candidate),
    },
    runtime: runtimeMetadata(),
    harnessSha256: harnessHash(),
    repetitions,
    profiles,
    fixtures: {},
    preparation: {},
    runs: [],
    method: {
      childWatchdogMs: timeoutMs,
      cache: 'identical warm table reads before measurement',
      timing:
        'real monitor, allocator and persistence; synthetic Cost Explorer responses',
      health: 'independent driver, 10 Hz, one-second deadline',
      peakRss: 'includes imports, migrations and fixture validation',
      plans: 'captured outside timing after the workload',
      indexBuild:
        'initialization includes migrations; separate rolled-back rebuild probe for added/changed indexes',
      writeProbe:
        '256 inserts and updates in one rolled-back transaction; excludes commit/fsync',
    },
  };
  mkdirSync(output, { recursive: true });
  const persist = () => {
    writeFileSync(
      path.join(output, 'results.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    writeFileSync(path.join(output, 'summary.md'), markdownReport(report));
  };
  persist();
  try {
    for (const profile of profiles) {
      const seed = await runChild({
        timeoutMs,
        buildDir: builds.baseline,
        action: 'seed',
        profile,
        runDir: path.join(output, profile + '-seed'),
      });
      report.fixtures[profile] = seed.fixture;
      report.preparation[profile] = {};
      const prepared = {};
      for (const arm of ['baseline', 'candidate']) {
        prepared[arm] = await runChild({
          timeoutMs,
          buildDir: builds[arm],
          action: 'prepare',
          fixture: seed.fixture,
          baselineIndexes: seed.indexes,
          runDir: path.join(output, profile + '-prepare-' + arm),
          copyFrom: seed.databasePath,
        });
        const { databasePath: _databasePath, ...metrics } = prepared[arm];
        report.preparation[profile][arm] = metrics;
      }
      persist();
      for (const response of responses) {
        for (const boundary of boundaries) {
          const caseName = response + '-' + boundary;
          for (let repetition = 0; repetition < repetitions; repetition++) {
            for (const arm of pairedOrder(repetition)) {
              const runDir = path.join(
                output,
                [profile, caseName, repetition + 1, arm].join('-'),
              );
              const measured = await runChild({
                timeoutMs,
                buildDir: builds[arm],
                action: 'measure',
                fixture: seed.fixture,
                response,
                boundary,
                runDir,
                copyFrom: prepared[arm].databasePath,
              });
              const { databasePath, ...metrics } = measured;
              report.runs.push({
                profile,
                case: caseName,
                repetition: repetition + 1,
                arm,
                ...metrics,
              });
              // Keep seeds and failures; successful copies are reproducible.
              rmSync(databasePath);
              persist();
              console.log(
                JSON.stringify({
                  profile,
                  case: caseName,
                  repetition: repetition + 1,
                  arm,
                  elapsedMs: measured.elapsedMs,
                  health: measured.health,
                }),
              );
            }
          }
        }
      }
      for (const arm of ['baseline', 'candidate'])
        rmSync(prepared[arm].databasePath);
      assert.equal(
        harnessHash(),
        report.harnessSha256,
        'Harness changed during measurement',
      );
    }
    for (const arm of ['baseline', 'candidate']) {
      assert.deepEqual(
        revisionMetadata(builds[arm]),
        report.revisions[arm],
        'Build changed during measurement',
      );
    }
    report.status = 'complete';
  } catch (error) {
    report.status = 'failed';
    report.failure = error.stack ?? String(error);
    process.exitCode = 1;
  } finally {
    persist();
    console.log('Results: ' + path.join(output, 'summary.md'));
  }
}
