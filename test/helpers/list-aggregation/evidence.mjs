import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readRequestJournal } from './traces.mjs';
import { summarizeRequests } from './accounting.mjs';
import {
  assertDrained,
  evaluatePairs,
  trialMetrics,
} from './qualification.mjs';
import { correctnessCases } from './cases.mjs';

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const writeJson = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export const digest = (value) =>
  createHash('sha256').update(value).digest('hex');
export function hashFile(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function filesBelow(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      assert(
        !entry.isSymbolicLink(),
        'Evidence cannot depend on a symlink: ' + entry.name,
      );
      const relative = prefix + entry.name;
      return entry.isDirectory()
        ? filesBelow(path.join(directory, entry.name), relative + '/')
        : [relative];
    });
}

export function hashTree(directory) {
  const hash = createHash('sha256');
  for (const file of filesBelow(directory))
    hash.update(file + '\0' + hashFile(path.join(directory, file)) + '\n');
  return hash.digest('hex');
}

export function readJsonLines(file) {
  const text = readFileSync(file, 'utf8');
  assert(text.endsWith('\n'), 'Truncated JSONL file: ' + file);
  return text.trim().split('\n').filter(Boolean).map(JSON.parse);
}

export function validateTrial(
  directory,
  { native = false, samples, caseIds } = {},
) {
  const result = readJson(path.join(directory, 'result.json'));
  assert.equal(result.exitCode, 0, 'Failed child');
  assert(!result.failure, result.failure);
  assertDrained(result);
  const records = readRequestJournal(path.join(directory, 'requests.jsonl'));
  assert.deepEqual(
    records,
    result.driver.records,
    'Request trace/result mismatch',
  );
  assert.deepEqual(
    summarizeRequests(
      records.filter((r) => r.sample),
      result.driver.timeoutMs,
    ),
    result.driver.summary,
  );
  assert.equal(
    Boolean(result.setup.compileOptions.includes('EXTRA_INIT=list_sort_init')),
    native,
    'Wrong driver for trial role',
  );
  const server = readJsonLines(path.join(directory, 'server.jsonl'));
  assert.deepEqual(
    server.filter((r) => r.event === 'received').map((r) => r.id),
    result.requests.map((r) => r.id),
    'Server trace mismatch',
  );
  const health = readJson(path.join(directory, 'health.json'));
  const healthJournal = readJsonLines(path.join(directory, 'health.jsonl'));
  const offered = healthJournal.filter((r) => r.event === 'offered');
  const settled = healthJournal.filter((r) => r.event === 'settled');
  assert.equal(offered.length, health.length, 'Missing health offers');
  assert.equal(settled.length, health.length, 'Unfinished health observations');
  assert.equal(
    new Set(offered.map((r) => r.scheduledAt)).size,
    offered.length,
    'Duplicate health offer',
  );
  for (const sample of health) {
    const matches = settled.filter((r) => r.scheduledAt === sample.scheduledAt);
    assert.equal(matches.length, 1, 'Missing or repeated health settlement');
    for (const key of ['ok', 'status', 'error', 'elapsedMs', 'offeredAt'])
      assert.deepEqual(sample[key], matches[0][key]);
  }
  const snapshots = new Map();
  for (const snapshot of result.driver.snapshots) {
    assert.equal(
      path.basename(snapshot.file),
      snapshot.file,
      'Unsafe response path',
    );
    const body = gunzipSync(readFileSync(path.join(directory, snapshot.file)));
    JSON.parse(body);
    assert.equal(body.length, snapshot.bytes, 'Response byte count mismatch');
    assert.equal(digest(body), snapshot.bodySha256, 'Response hash mismatch');
    assert(!snapshots.has(snapshot.case), 'Duplicate response snapshot');
    snapshots.set(snapshot.case, snapshot);
  }
  for (const record of records) {
    const snapshot = snapshots.get(record.case);
    assert(snapshot, 'Missing complete response: ' + record.case);
    assert.equal(
      record.bodySha256,
      snapshot.bodySha256,
      'Public response changed within trial',
    );
    assert.equal(record.status, snapshot.status);
    const observed = result.requests.find((r) => r.id === record.id);
    assert(
      observed && Number.isFinite(observed.finishedAt),
      'Missing completed server observation',
    );
    assert.equal(
      server.filter((r) => r.id === record.id && r.event === 'finished').length,
      1,
    );
  }
  assert(
    result.queryPlans.length &&
      result.queryPlans.every((p) => p.sql && Array.isArray(p.details)),
    'Missing actual SQL/plans',
  );
  if (native) {
    assert.deepEqual(
      readJsonLines(path.join(directory, 'native.jsonl')),
      result.nativeRecords,
      'Native observer trace mismatch',
    );
    assert(result.nativeRecords.length, 'Missing native work observations');
    for (const record of result.nativeRecords) {
      const plan = result.queryPlans.find(
        (p) => digest(p.sql) === record.sqlSha256 && p.case === record.case,
      );
      assert(plan?.bytecode?.length, 'Missing observed statement bytecode');
      for (const site of record.sites) {
        const opcode = plan.bytecode.find((op) => op.addr === site.pc)?.opcode;
        assert.equal(
          opcode,
          { 1: 'SorterInsert', 2: 'IdxInsert', 3: 'Insert' }[site.kind],
          'Counter site does not match bytecode',
        );
      }
    }
  } else assert.equal(result.nativeRecords.length, 0);
  if (samples !== undefined) {
    assert.equal(result.mode, 'matrix');
    assert.deepEqual(
      [...new Set(records.filter((r) => r.sample).map((r) => r.case))].sort(),
      [...caseIds].sort(),
    );
    for (const id of caseIds)
      assert.equal(
        records.filter((r) => r.sample && r.case === id).length,
        samples,
      );
  }
  return { result, health, records, snapshots: [...snapshots.values()] };
}

export function workBudget(result, maximumWidth = 192) {
  const queries = result.nativeRecords
    .filter((r) => r.rows > 0)
    .map((record) => {
      const amplified = record.sites.filter(
        (site) => site.records > 2 * record.rows,
      );
      return {
        requestId: record.requestId,
        case: record.case,
        kind: record.kind,
        rows: record.rows,
        temporaryBytes: record.sites.reduce((sum, site) => sum + site.bytes, 0),
        readBytes: record.readBytes,
        writeBytes: record.writeBytes,
        sites: record.sites,
        amplified: amplified.map((site) => ({
          ...site,
          averageBytes: site.bytes / site.records,
        })),
        passes: amplified.every(
          (site) => site.bytes <= maximumWidth * site.records,
        ),
      };
    });
  assert(queries.length, 'No nonempty list queries observed');
  return {
    maximumWidth,
    queries,
    passes: queries.every((q) => q.passes),
    failures: queries.filter((q) => !q.passes).length,
  };
}

export function sameResponses(left, right) {
  const summarize = (rows) =>
    rows
      .map(({ case: id, status, bytes, bodySha256, headers }) => ({
        id,
        status,
        bytes,
        bodySha256,
        headers,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    summarize(left),
    summarize(right),
    'Complete public responses differ',
  );
}

export function inventory(directory, expectedTrials) {
  const files = filesBelow(directory).filter((f) => f !== 'inventory.json');
  const entries = files.map((relative) => ({
    path: relative,
    bytes: statSync(path.join(directory, relative)).size,
    sha256: hashFile(path.join(directory, relative)),
  }));
  const record = { version: 1, expectedTrials, files: entries };
  writeJson(path.join(directory, 'inventory.json'), record);
  return record;
}

export function verifyInventory(directory) {
  const record = readJson(path.join(directory, 'inventory.json'));
  const expected = record.files.map((f) => f.path).sort();
  assert.equal(
    new Set(expected).size,
    expected.length,
    'Duplicate artifact path',
  );
  assert.deepEqual(
    filesBelow(directory)
      .filter((f) => f !== 'inventory.json')
      .sort(),
    expected,
    'Missing or unexpected artifact',
  );
  for (const entry of record.files) {
    assert(
      !path.isAbsolute(entry.path) && !entry.path.split('/').includes('..'),
      'Unsafe artifact path',
    );
    const file = path.join(directory, entry.path);
    assert.equal(statSync(file).size, entry.bytes, 'Artifact size mismatch');
    assert.equal(hashFile(file), entry.sha256, 'Artifact hash mismatch');
  }
  const trials = record.expectedTrials.map((trial) => {
    assert(
      expected.includes(trial.path + '/result.json'),
      'Missing expected trial',
    );
    const checked = validateTrial(path.join(directory, trial.path), trial);
    return {
      id: trial.path,
      requests: checked.records.length,
      responses: checked.snapshots.length,
      healthOffers: checked.health.length,
    };
  });
  return { files: record.files.length, trials };
}

/** Derive required trials from the frozen protocol and verified stopping state. */
export function verifyStudy(directory) {
  const checked = verifyInventory(directory);
  const execution = readJson(path.join(directory, 'execution.json'));
  const acceptance = readJson(path.join(directory, 'acceptance.json'));
  const pins = readJson(path.join(directory, 'pins.json'));
  const seeds = readJson(path.join(directory, 'seeds.json'));
  assert.equal(acceptance.study, 'list-aggregation-v1');
  assert.equal(acceptance.maximumRecordWidth, 192);
  assert.equal(acceptance.executionBudgetMs, 1800000);
  assert(
    execution.experimentalMs <= acceptance.executionBudgetMs,
    'Execution budget exceeded',
  );
  assert.notEqual(
    execution.status,
    'incomplete',
    'Incomplete experimental evidence',
  );
  const expected = [];
  for (const stage of acceptance.structuralStages) {
    if (!execution.completed.includes('observe-' + stage)) continue;
    for (const scope of acceptance.scopes) {
      expected.push('correctness-' + stage + '-' + scope);
      const trial = validateTrial(path.join(directory, expected.at(-1)));
      assert.deepEqual(
        trial.records.map((r) => r.case),
        correctnessCases(scope).map((c) => c.id),
        'Incomplete correctness coverage',
      );
    }
    const reports = readJson(
      path.join(directory, 'work-budget-' + stage + '.json'),
    );
    for (const fixture of acceptance.structuralFixtures)
      for (const scope of acceptance.scopes) {
        const name = `observed-${stage}-${fixture}-${scope}`;
        expected.push(name);
        const trial = validateTrial(path.join(directory, name), {
          native: true,
          samples: 1,
          caseIds: acceptance.endpoints,
        });
        assert.equal(
          trial.result.setup.nativeSha256,
          pins.observedNativeSha256,
        );
        assert.deepEqual(
          workBudget(trial.result),
          reports[fixture + '-' + scope],
          'Work budget report does not match raw counters',
        );
        const referenceFixture =
          fixture === 'ip-heavy-depth' ? 'ip-heavy' : fixture;
        const reference = validateTrial(
          path.join(
            directory,
            `observed-baseline-${referenceFixture}-${scope}`,
          ),
          { native: true },
        );
        sameResponses(reference.snapshots, trial.snapshots);
      }
  }
  if (execution.completed.includes('compare')) {
    const calibration = readJson(
      path.join(directory, 'calibration-decision.json'),
    );
    assert.equal(
      readJson(path.join(directory, 'previous-aa-audit.json'))
        .alternatingOrderVerified,
      true,
    );
    const groups = { calibration: [], comparison: [] };
    for (const trial of acceptance.expectedTimingTrials) {
      if (trial.stage === 'comparison' && calibration.decision !== 'passes')
        continue;
      const name = `${trial.stage}-${trial.repetition}-${trial.arm}`;
      expected.push(name);
      const measured = validateTrial(path.join(directory, name), {
        native: false,
        samples: acceptance.timing.samples,
        caseIds: acceptance.endpoints,
      });
      groups[trial.stage].push({
        arm: trial.arm,
        repetition: trial.repetition,
        metrics: trialMetrics(
          measured.result,
          acceptance.timing,
          measured.health,
        ),
      });
    }
    for (const [stage, runs] of Object.entries(groups))
      if (runs.length) {
        assert.deepEqual(
          evaluatePairs(runs, acceptance.timing, stage === 'calibration'),
          readJson(path.join(directory, stage + '-decision.json')),
          'Paired decision differs from raw evidence',
        );
      }
  }
  assert.deepEqual(
    checked.trials.map((t) => t.id).sort(),
    expected.sort(),
    'Missing or extra complete experimental trials',
  );
  for (const [profile, seed] of Object.entries(seeds)) {
    const file = path.join(directory, 'seed-' + profile, 'fixture.db.gz');
    const bytes = gunzipSync(readFileSync(file));
    assert.equal(
      bytes.subarray(0, 16).toString(),
      'SQLite format 3\0',
      'Invalid retained SQLite fixture',
    );
    assert(
      seed.fixture.logicalSha256 && seed.fixture.counts.workloads > 0,
      'Missing fixture identity',
    );
  }
  return {
    ...checked,
    status: execution.status,
    experimentalMs: execution.experimentalMs,
  };
}
