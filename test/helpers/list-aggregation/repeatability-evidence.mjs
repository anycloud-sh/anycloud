import assert from 'node:assert/strict';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  readJson,
  readJsonLines,
  verifyInventory,
  validateTrial,
  sameResponses,
  digest,
  hashFile,
  hashTree,
} from './evidence.mjs';
import { correctnessCases } from './cases.mjs';
import { evaluatePairs, trialMetrics } from './qualification.mjs';
import {
  REPEATABILITY,
  pairedTrialOrder,
  repeatabilityDefinition,
} from './repeatability-policy.mjs';
import { STATUS_CONTROL } from './status-control-policy.mjs';
import {
  sameSelectedResponses,
  verifyDiagnosticTrial,
} from './status-control-evidence.mjs';

export async function calibratedComparison(runStage) {
  const calibration = await runStage('calibration');
  return {
    calibration,
    comparison:
      calibration.decision === 'passes' ? await runStage('comparison') : null,
  };
}

export function verifyRepeatability(directory, study = 'repeatability') {
  assert(['repeatability', 'status-control'].includes(study));
  const policy = study === 'status-control' ? STATUS_CONTROL : REPEATABILITY;
  const inventory = verifyInventory(directory);
  const execution = readJson(path.join(directory, 'execution.json'));
  assert.deepEqual(readJson(path.join(directory, 'protocol.json')), policy);
  assert.equal(
    execution.status,
    'complete',
    'Incomplete repeatability evidence',
  );
  assert(execution.experimentalMs <= policy.executionBudgetMs);
  assert(execution.experimentalMs <= execution.effectiveBudgetMs);
  assert(execution.effectiveBudgetMs <= policy.executionBudgetMs);
  assert.equal(execution.promotion, false);
  const pins = readJson(path.join(directory, 'pins.json'));
  const fixtures = readJson(path.join(directory, 'fixtures.json'));
  assert.equal(pins.baseline.source, policy.application);
  assert.equal(pins.candidate.source, policy.application);
  assert.equal(pins.baseline.sourceDiff, '');
  assert.equal(
    digest(pins.candidate.sourceDiff + '\n'),
    policy.candidatePatchSha256,
  );
  assert.equal(pins.baseline.nativeSha256, pins.candidate.nativeSha256);
  assert.equal(pins.baseline.lockSha256, pins.candidate.lockSha256);
  assert.equal(pins.baseline.migrationsSha256, pins.candidate.migrationsSha256);
  assert.equal(pins.runtime.node, policy.node);
  assert.equal(pins.runtime.platform, 'linux');
  assert.equal(pins.runtime.arch, 'x64');
  assert.equal(pins.runner.environment, 'github-hosted');
  assert.deepEqual(
    {
      runner: hashFile(
        path.join(
          directory,
          'source/experiments/list-responsiveness/repeatability.mjs',
        ),
      ),
      helpers: hashTree(
        path.join(directory, 'source/test/helpers/list-aggregation'),
      ),
      fixture: hashFile(
        path.join(
          directory,
          'source/test/helpers/list-responsiveness/fixture.mjs',
        ),
      ),
    },
    pins.harness,
    'Archived harness differs from the measured sources',
  );
  const expected = [];
  const references = new Map();
  let previousCompletion = -Infinity;
  const inspect = (id, profile, proof, options) => {
    expected.push(id);
    const checked = validateTrial(path.join(directory, id), options);
    const { result } = checked;
    const firstOffer = result.driver.clockOrigin + checked.records[0].offeredAt;
    assert(
      firstOffer > previousCompletion,
      'Trials did not execute in the frozen sequential order',
    );
    previousCompletion =
      result.driver.clockOrigin +
      Math.max(...checked.records.map((r) => r.settledAt));
    assert.equal(result.setup.sqlite, policy.sqlite);
    assert.equal(result.setup.nativeSha256, pins.baseline.nativeSha256);
    assert.equal(
      result.setup.logicalSha256,
      fixtures[profile].fixture.logicalSha256,
    );
    assert.equal(result.fixtureAfterDrain.afterHealthDrain, true);
    assert.equal(
      result.fixtureAfterDrain.logicalSha256,
      result.setup.logicalSha256,
    );
    const { capacity, ...storage } = readJson(
      path.join(directory, id, 'storage.json'),
    );
    if (profile === 'correctness') {
      const bytes = gunzipSync(
        readFileSync(path.join(directory, id, 'database.db.gz')),
      );
      assert(bytes.length <= policy.storage.maximumCorrectnessBytes);
      assert.deepEqual(storage, {
        version: policy.storage.version,
        strategy: 'retained-correctness-copy',
        database: { bytes: bytes.length, sha256: digest(bytes) },
        independentDuringTrial: true,
        sharedAfterExit: false,
      });
    } else {
      assert.equal(result.scope, policy.scope);
      assert.deepEqual(
        storage,
        {
          version: policy.storage.version,
          strategy: 'identical-closed-copy',
          database: fixtures[profile].proof.database,
          independentDuringTrial: true,
          sharedAfterExit: true,
        },
        'Closed fixture storage differs from the retained seed',
      );
    }
    assert(
      capacity.availableBytes >= capacity.requiredBytes,
      'Trial started without disk headroom',
    );
    assert.equal(
      capacity.fixtureBytes,
      Math.max(...Object.values(fixtures).map((f) => f.proof.database.bytes)),
    );
    assert.equal(
      capacity.requiredBytes,
      capacity.fixtureBytes * policy.storage.transientCopies +
        policy.storage.reportingReserveBytes,
    );
    const trace = readJsonLines(path.join(directory, id, 'setup.jsonl'));
    const ready = trace.filter((row) => row.stage === 'fixture-ready');
    assert.equal(ready.length, 1);
    assert.equal(
      ready[0].validationStrategy,
      proof ? 'file-proof' : 'in-process',
    );
    if (proof) {
      const receipt = result.setup.fixtureValidation;
      assert.deepEqual(receipt, {
        strategy: 'file-proof',
        ...fixtures[profile].proof,
      });
      assert.equal(
        trace.filter((row) => row.stage === 'fixture-bytes-verified').length,
        1,
      );
    } else assert.equal(result.setup.fixtureValidation, undefined);
    const key = profile + '/' + result.scope;
    if (references.has(key)) {
      const original = references.get(key);
      if (policy.diagnosticTrials)
        sameSelectedResponses(original, checked.snapshots);
      else sameResponses(original, checked.snapshots);
    } else references.set(key, checked.snapshots);
    return checked;
  };
  const decisions = {};
  if (policy.diagnosticTrials) {
    assert.equal(execution.calibration, null);
    assert.equal(execution.comparison, null);
    assert.equal(execution.outcome, 'diagnostic-complete-no-promotion');
    for (const trial of policy.diagnosticTrials) {
      const checked = inspect(trial.id, 'mixed', true, {
        samples: policy.samples,
        caseIds: trial.caseIds,
      });
      assert.equal(checked.result.buildDir, pins[trial.arm].directory);
      verifyDiagnosticTrial(
        path.join(directory, trial.id),
        checked,
        trial,
        policy,
      );
    }
  } else {
    for (const mode of ['original', 'proof', 'candidate'])
      for (const scope of ['user', 'api']) {
        const checked = inspect(
          'correctness-' + mode + '-' + scope,
          'correctness',
          mode !== 'original',
        );
        assert.equal(
          checked.result.buildDir,
          mode === 'candidate'
            ? pins.candidate.directory
            : pins.baseline.directory,
        );
        assert.deepEqual(
          checked.records.map((r) => r.case),
          correctnessCases(scope).map((c) => c.id),
        );
      }
    for (const trial of policy.setupTrials)
      inspect(trial.id, 'mixed', trial.proof, {
        samples: policy.setupSamples,
        caseIds: policy.endpoints,
      });
    const definition = repeatabilityDefinition();
    for (const stage of ['calibration', 'comparison']) {
      if (
        stage === 'comparison' &&
        decisions.calibration.decision !== 'passes'
      ) {
        assert.equal(
          execution.comparison,
          null,
          'A/B ran after failed calibration',
        );
        break;
      }
      const runs = pairedTrialOrder(stage).map((trial) => {
        const measured = inspect(trial.id, 'mixed', true, {
          samples: policy.samples,
          caseIds: policy.endpoints,
        });
        const expectedBuild =
          stage === 'comparison' && trial.arm === 'candidate'
            ? pins.candidate.directory
            : pins.baseline.directory;
        assert.equal(
          measured.result.buildDir,
          expectedBuild,
          'Wrong built application for paired trial',
        );
        for (const id of policy.endpoints)
          assert.equal(
            measured.records.filter(
              (r) => r.case === id && r.phase === 'warmup:' + id,
            ).length,
            policy.warmups,
          );
        return {
          ...trial,
          metrics: trialMetrics(measured.result, definition, measured.health),
        };
      });
      decisions[stage] = evaluatePairs(
        runs,
        definition,
        stage === 'calibration',
      );
      assert.deepEqual(
        execution[stage],
        decisions[stage],
        'Decision differs from raw paired evidence',
      );
    }
  }
  assert.deepEqual(inventory.trials.map((t) => t.id).sort(), expected.sort());
  assert.deepEqual(
    execution.trials.map((t) => t.path),
    inventory.trials.map((t) => t.id),
  );
  const capacity = readJsonLines(
    path.join(directory, 'storage-capacity.jsonl'),
  );
  assert.deepEqual(
    capacity.map((row) => row.trial),
    ['prepare', ...execution.trials.map((t) => t.path)],
    'Missing storage admission observation',
  );
  for (const { trial, epochMs, ...receipt } of capacity) {
    assert(epochMs > 0 && receipt.availableBytes >= receipt.requiredBytes);
    assert.equal(
      receipt.requiredBytes,
      receipt.fixtureBytes * policy.storage.transientCopies +
        policy.storage.reportingReserveBytes,
    );
    if (trial === 'prepare')
      assert.equal(receipt.fixtureBytes, policy.storage.maximumFixtureBytes);
    else
      assert.deepEqual(
        receipt,
        readJson(path.join(directory, trial, 'storage.json')).capacity,
      );
  }
  for (const [profile, record] of Object.entries(fixtures)) {
    assert.deepEqual(
      readJson(path.join(directory, 'seed-' + profile, 'result.json')).fixture,
      record.fixture,
    );
    const bytes = gunzipSync(
      readFileSync(path.join(directory, 'seed-' + profile, 'fixture.db.gz')),
    );
    assert.equal(
      digest(bytes),
      record.proof.database.sha256,
      'Retained seed differs from fixture proof',
    );
    assert.equal(bytes.length, record.proof.database.bytes);
  }
  return {
    ...inventory,
    decisions,
    experimentalMs: execution.experimentalMs,
    promotion: false,
  };
}
