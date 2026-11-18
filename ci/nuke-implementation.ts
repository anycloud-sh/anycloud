// Implementation evidence, not a qualification receipt. Node built-ins keep
// failed setup runs recordable even when dependency installation never finished.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseNukeApiContainer,
  parseNukeBuiltImage,
  parseNukeWorkloadImages,
  validateNukeApiImageBinding,
  type NukeImageIdentity,
} from '../test/integration/helpers/nuke-image-evidence.ts';

const states = [
  'queued',
  'provisioning',
  'initializing',
  'downloading',
  'syncing',
  'starting',
  'running',
  'retrying',
  'recovering',
  'finalizing',
  'completed',
  'failed',
  'errored',
  'invalid',
  'terminated',
];
const terminalStates = new Set([
  'completed',
  'failed',
  'errored',
  'invalid',
  'terminated',
]);
const providers = ['local', 'aws', 'azure', 'gcp', 'lambda'];
const stepOutcomes = ['success', 'failure', 'cancelled', 'skipped'];
const localBusyboxImage =
  'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
const localBusyboxAmd64Digest =
  'sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f';

export interface NukeEvidenceContext {
  sourceRevision: string | null;
  sourceParentRevision: string | null;
  eventRevision: string | null;
  eventBaseRevision: string | null;
  runId: string | null;
  runAttempt: string | null;
  provider: string | null;
  interruptAfterWitness: boolean | null;
  overlayCount: number | null;
  testsOutcome: string | null;
  localCleanupOutcome: string | null;
  cloudCleanupOutcome: string | null;
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), fields.toSorted());
  return Object.fromEntries(Object.entries(value));
}

function versioned(value: unknown, fields: string[]): Record<string, unknown> {
  const record = object(value, ['version', ...fields]);
  assert.equal(record.version, 1);
  return record;
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  assert(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
  );
  return value;
}

function boolean(value: unknown): boolean {
  assert(typeof value === 'boolean');
  return value;
}

function ids(value: unknown): string[] {
  assert(Array.isArray(value));
  const parsed = value.map((id: unknown) => {
    assert(
      typeof id === 'string' &&
        /^nuke-(?:witness-)?[0-9]+-[1-9][0-9]*$/u.test(id) &&
        id.length <= 100,
    );
    return id;
  });
  assert.equal(new Set(parsed).size, parsed.length);
  return parsed;
}

function pids(value: unknown): number[] {
  assert(Array.isArray(value));
  const parsed = value.map((pid: unknown) => integer(pid, 2));
  assert.equal(new Set(parsed).size, parsed.length);
  return parsed;
}

function inventory(value: unknown, cohort: string) {
  const record = versioned(value, ['cohort', 'workloads']);
  assert.equal(record.cohort, cohort);
  assert(Array.isArray(record.workloads));
  const workloads = record.workloads.map((row: unknown) => {
    const entry = object(row, ['id', 'state']);
    const [id] = ids([entry.id]);
    assert(typeof entry.state === 'string' && states.includes(entry.state));
    return { id, state: entry.state };
  });
  ids(workloads.map(({ id }) => id));
  return workloads;
}

function cohortCleanup(value: unknown, cohort: string) {
  const record = versioned(value, [
    'cohort',
    'ids',
    'terminationFailedIds',
    'vmsEnded',
  ]);
  assert.equal(record.cohort, cohort);
  return {
    ids: ids(record.ids),
    terminationFailedIds: ids(record.terminationFailedIds),
    vmsEnded: boolean(record.vmsEnded),
  };
}

function sameIds(actual: string[], expected: string[]): boolean {
  return (
    JSON.stringify(actual.toSorted()) === JSON.stringify(expected.toSorted())
  );
}

interface RawRecord {
  name: string;
  sha256: string;
  body: string;
}

export function collectNukeEvidence(
  resultsDir: string,
  context: NukeEvidenceContext,
) {
  const errors: string[] = [];
  const records: RawRecord[] = [];
  const require = (condition: boolean, message: string) => {
    if (!condition) errors.push(message);
  };
  const read = <T>(
    name: string,
    parse: (value: unknown) => T,
    maximumBytes = 256 * 1024,
  ): T | null => {
    try {
      const path = join(resultsDir, name);
      const stat = lstatSync(path);
      assert(stat.isFile() && stat.size <= maximumBytes);
      const body = readFileSync(path, 'utf8');
      const parsed = parse(JSON.parse(body));
      records.push({
        name,
        sha256: createHash('sha256').update(body).digest('hex'),
        body,
      });
      return parsed;
    } catch {
      // Do not retain or echo malformed content: it might contain credentials.
      errors.push(`${name}: missing or invalid`);
      return null;
    }
  };
  require(context.sourceRevision !== null &&
    /^[a-f0-9]{40}$/u.test(
      context.sourceRevision,
    ), 'source revision unavailable');
  require(context.sourceParentRevision !== null &&
    /^[a-f0-9]{40}$/u.test(
      context.sourceParentRevision,
    ), 'source parent revision unavailable');
  require(context.eventRevision ===
    context.sourceRevision, 'checkout differs from the event revision');
  require(context.eventBaseRevision === null ||
    /^[a-f0-9]{40}$/u.test(
      context.eventBaseRevision,
    ), 'event base revision invalid');
  require(context.runId !== null &&
    /^[1-9][0-9]*$/u.test(context.runId), 'run ID unavailable');
  require(context.runAttempt !== null &&
    /^[1-9][0-9]*$/u.test(context.runAttempt), 'run attempt unavailable');
  require(context.provider !== null &&
    providers.includes(context.provider), 'provider unavailable');
  require(typeof context.interruptAfterWitness ===
    'boolean', 'interruption input unavailable');
  require(context.overlayCount !== null &&
    Number.isInteger(context.overlayCount) &&
    context.overlayCount >= 300 &&
    context.overlayCount <= 1000, 'overlay count must be 300–1000');
  const expectedExit = context.interruptAfterWitness ? 143 : 0;
  require(context.testsOutcome ===
    (context.interruptAfterWitness
      ? 'failure'
      : 'success'), 'unexpected test step outcome');
  require(context.cloudCleanupOutcome ===
    'success', 'provider backstop did not succeed');
  require(context.localCleanupOutcome ===
    (context.provider === 'local'
      ? 'success'
      : 'skipped'), 'Local backstop has an unexpected outcome');

  const sameImageIdentity = (record: NukeImageIdentity | null) =>
    record !== null &&
    record.sourceRevision === context.sourceRevision &&
    record.runId === context.runId &&
    String(record.runAttempt) === context.runAttempt;
  const builtImage = read('nuke-api-built.json', parseNukeBuiltImage);
  const apiContainer = read('nuke-api-container.json', parseNukeApiContainer);
  require(sameImageIdentity(builtImage) &&
    sameImageIdentity(
      apiContainer,
    ), 'local API image observations are missing or belong to another source/attempt');
  require(builtImage?.status ===
    'observed', 'built API engine image was not observed');
  require(apiContainer?.status ===
    'observed', 'actual API container engine image was not observed');
  if (
    builtImage?.status === 'observed' &&
    apiContainer?.status === 'observed'
  ) {
    try {
      validateNukeApiImageBinding(builtImage, apiContainer);
    } catch {
      errors.push(
        'running API container does not match the original built engine image',
      );
    }
  }
  const workloadImageReferences = new Set<string>();
  const workloadImageDigests = new Set<string>();
  const readWorkloadImages = (
    cohort: string,
    stage: string,
    expected: string[] | undefined,
  ) => {
    const record = read(
      `nuke-cleanup/${cohort}-${stage}-images.json`,
      parseNukeWorkloadImages,
      1024 * 1024,
    );
    require(sameImageIdentity(record) &&
      record?.cohort === cohort &&
      record.stage ===
        stage, `${cohort} ${stage} image observation identity differs`);
    require(record !== null &&
      expected !== undefined &&
      sameIds(
        record.workloads.map(({ id }) => id),
        expected,
      ), `${cohort} ${stage} image cohort is incomplete or foreign`);
    if (record !== null) {
      workloadImageReferences.add(record.expectedImage);
      for (const row of record.workloads) {
        if (row.digestStatus === 'observed' && row.imageDigest !== null)
          workloadImageDigests.add(row.imageDigest);
      }
      require(record.workloads.every(
        (row) =>
          row.imageStatus === 'observed' && row.digestStatus === 'observed',
      ), `${cohort} ${stage} controller image/digest is missing, unresolved or invalid`);
      if (
        context.provider === 'local' &&
        record.expectedImage === localBusyboxImage
      ) {
        // The runner fixture's index and its observed amd64 child are distinct.
        // A pinned input never supplies a missing controller observation.
        require(record.workloads.every(
          (row) => row.imageDigest === localBusyboxAmd64Digest,
        ), `${cohort} ${stage} controller digest differs from the Local BusyBox amd64 fixture`);
      }
    }
  };

  const launch = read('nuke-launch.json', (value) => {
    const record = versioned(value, ['exitCode']);
    return integer(record.exitCode, 0, 255);
  });
  const outcome = read('e2e-run.json', (value) => {
    const record = versioned(value, [
      'testName',
      'implementation',
      'command',
      'logFile',
      'exitCode',
      'durationSeconds',
    ]);
    assert.equal(record.testName, 'nuke');
    assert.equal(record.implementation, 'bash');
    assert(
      [
        'bash ./test/integration/nuke.test.sh',
        'isolated runner setup for nuke (bash)',
      ].includes(String(record.command)),
    );
    assert.equal(record.logFile, 'nuke-bash.log');
    assert(
      typeof record.durationSeconds === 'number' &&
        Number.isFinite(record.durationSeconds) &&
        record.durationSeconds >= 0,
    );
    return {
      exitCode: integer(record.exitCode, 0, 255),
      command: record.command,
    };
  });
  const start = read('nuke-cleanup/start.json', (value) => {
    const record = versioned(value, [
      'exitCode',
      'forcedRequested',
      'forcedArmed',
      'normalIds',
      'witnessIds',
    ]);
    return {
      exitCode: integer(record.exitCode, 0, 255),
      forcedRequested: boolean(record.forcedRequested),
      forcedArmed: boolean(record.forcedArmed),
      normalIds: ids(record.normalIds),
      witnessIds: ids(record.witnessIds),
    };
  });
  const cleanup = read('nuke-cleanup/result.json', (value) => {
    const record = versioned(value, [
      'exitCode',
      'cleanupExitCode',
      'repeatedTerm',
    ]);
    return {
      exitCode: integer(record.exitCode, 0, 255),
      cleanupExitCode: integer(record.cleanupExitCode, 0, 255),
      repeatedTerm: boolean(record.repeatedTerm),
    };
  });
  const submissions = read('nuke-cleanup/submissions.json', (value) => {
    const record = versioned(value, ['groupIds', 'remainingGroupIds']);
    return {
      groupIds: pids(record.groupIds),
      remainingGroupIds: pids(record.remainingGroupIds),
    };
  });
  require(launch === expectedExit &&
    outcome?.exitCode === expectedExit &&
    start?.exitCode === expectedExit &&
    cleanup?.exitCode ===
      expectedExit, 'original and outer exits must match the declared outcome');
  require(outcome?.command ===
    'bash ./test/integration/nuke.test.sh', 'nuke assertions did not start');
  require(cleanup?.cleanupExitCode === 0, 'cleanup did not succeed');
  require(submissions?.remainingGroupIds.length ===
    0, 'submission shutdown unresolved');
  require(start?.forcedRequested === context.interruptAfterWitness &&
    start?.forcedArmed === context.interruptAfterWitness &&
    cleanup?.repeatedTerm ===
      context.interruptAfterWitness, 'interruption and repeated-signal evidence disagree');

  const prefix = `nuke-${context.runId?.slice(-9)}${context.runAttempt}-`;
  const expectedNormal = Array.from(
    { length: context.overlayCount ?? 0 },
    (_, index) => `${prefix}${index + 1}`,
  );
  require(start !== null &&
    sameIds(
      start.normalIds,
      expectedNormal,
    ), 'normal caller cohort is incomplete or foreign');
  // Witnesses sit outside the wall's prefix: every caller lists both.
  const witnessPrefix = `nuke-witness-${context.runId?.slice(-9)}${context.runAttempt}-`;
  require(start !== null &&
    start.witnessIds.length >= 1 &&
    sameIds(
      start.witnessIds,
      start.witnessIds.map((_, index) => `${witnessPrefix}${index + 1}`),
    ), 'second lane cohort is incomplete or foreign');
  for (const cohort of ['normal', 'witness']) {
    const expected = cohort === 'normal' ? start?.normalIds : start?.witnessIds;
    const observed = read(`nuke-cleanup/${cohort}-inventory.json`, (value) =>
      inventory(value, cohort),
    );
    const drained = read(`nuke-cleanup/${cohort}.json`, (value) =>
      cohortCleanup(value, cohort),
    );
    readWorkloadImages(cohort, 'inventory', expected);
    require(expected !== undefined &&
      observed !== null &&
      sameIds(
        observed.map(({ id }) => id),
        expected,
      ), `${cohort} caller inventory incomplete`);
    require(expected !== undefined &&
      drained !== null &&
      sameIds(drained.ids, expected) &&
      drained.terminationFailedIds.length === 0 &&
      drained.vmsEnded, `${cohort} caller termination or VM ledger drain unresolved`);
  }
  if (context.interruptAfterWitness) {
    readWorkloadImages('normal', 'before-interrupt', start?.normalIds);
    readWorkloadImages('witness', 'before-interrupt', start?.witnessIds);
    const admitted = read('nuke-cleanup/admitted-witness.json', (value) => {
      const record = versioned(value, [
        'kind',
        'witnessId',
        'wrapperPid',
        'holdPid',
        'holdSeconds',
        'admissionExitCode',
      ]);
      assert.equal(record.kind, 'admitted-witness-wrapper-hold');
      assert.equal(record.holdSeconds, 30);
      assert.equal(record.admissionExitCode, 0);
      return {
        witnessId: ids([record.witnessId])[0],
        wrapperPid: integer(record.wrapperPid, 2),
        holdPid: integer(record.holdPid, 2),
      };
    });
    const interruption = read('nuke-cleanup/interruption.json', (value) => {
      const record = versioned(value, [
        'admittedWitnessId',
        'wrapperPid',
        'holdPid',
        'activeIds',
      ]);
      return {
        admittedWitnessId: ids([record.admittedWitnessId])[0],
        wrapperPid: integer(record.wrapperPid, 2),
        holdPid: integer(record.holdPid, 2),
        activeIds: ids(record.activeIds),
      };
    });
    const normal = read('nuke-cleanup/normal-before-interrupt.json', (value) =>
      inventory(value, 'normal'),
    );
    const witness = read(
      'nuke-cleanup/witness-before-interrupt.json',
      (value) => inventory(value, 'witness'),
    );
    const activeIds = [...(normal ?? []), ...(witness ?? [])]
      .filter(({ state }) => !terminalStates.has(state))
      .map(({ id }) => id);
    require(start !== null &&
      normal !== null &&
      witness !== null &&
      sameIds(
        normal.map(({ id }) => id),
        start.normalIds,
      ) &&
      sameIds(
        witness.map(({ id }) => id),
        start.witnessIds,
      ), 'both caller inventories are required before interruption');
    require(interruption !== null &&
      activeIds.length > 0 &&
      sameIds(
        interruption.activeIds,
        activeIds,
      ), 'interruption has no observed active tracked Workload');
    require(admitted !== null &&
      interruption !== null &&
      start?.witnessIds.length === 1 &&
      admitted.witnessId === start.witnessIds[0] &&
      interruption.admittedWitnessId === admitted.witnessId &&
      interruption.wrapperPid === admitted.wrapperPid &&
      interruption.holdPid === admitted.holdPid &&
      admitted.wrapperPid !== admitted.holdPid &&
      submissions?.groupIds.includes(admitted.wrapperPid) ===
        true, 'admitted witness hold was not owned and reaped');
  }
  require(workloadImageReferences.size ===
    1, 'normal and witness callers did not use the same configured Workload image');
  require(workloadImageDigests.size ===
    1, 'normal and witness controller image digests are missing or disagree');
  return { records, errors };
}

export function captureNukeEvidence(
  resultsDir: string,
  evidenceDir: string,
  context: NukeEvidenceContext,
): void {
  const evidence = collectNukeEvidence(resultsDir, context);
  mkdirSync(evidenceDir, { recursive: true });
  for (const record of evidence.records) {
    const destination = join(evidenceDir, 'raw', record.name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, record.body, { flag: 'wx' });
  }
  writeFileSync(
    join(evidenceDir, 'record.json'),
    `${JSON.stringify(
      {
        version: 1,
        authority: 'bash',
        kind: 'implementation-only',
        qualificationCount: 0,
        context,
        errors: evidence.errors,
        records: evidence.records.map(({ name, sha256 }) => ({ name, sha256 })),
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
}

export function validateNukeEvidence(
  evidenceDir: string,
  context: NukeEvidenceContext,
): string[] {
  try {
    const report = versioned(
      JSON.parse(readFileSync(join(evidenceDir, 'record.json'), 'utf8')),
      [
        'authority',
        'kind',
        'qualificationCount',
        'context',
        'errors',
        'records',
      ],
    );
    assert.equal(report.authority, 'bash');
    assert.equal(report.kind, 'implementation-only');
    assert.equal(report.qualificationCount, 0);
    assert.deepEqual(report.context, context);
    const collected = collectNukeEvidence(join(evidenceDir, 'raw'), context);
    assert.deepEqual(report.errors, collected.errors);
    assert.deepEqual(
      report.records,
      collected.records.map(({ name, sha256 }) => ({ name, sha256 })),
    );
    return collected.errors;
  } catch {
    return ['implementation record is missing, changed or invalid'];
  }
}

function matched(value: string | undefined, pattern: RegExp): string | null {
  return value !== undefined && pattern.test(value) ? value : null;
}

function revision(ref: string): string | null {
  try {
    return matched(
      execFileSync('git', ['rev-parse', ref], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      /^[a-f0-9]{40}$/u,
    );
  } catch {
    return null;
  }
}

function contextFromEnvironment(): NukeEvidenceContext {
  const outcome = (key: string) =>
    stepOutcomes.includes(process.env[key] ?? '')
      ? (process.env[key] ?? null)
      : null;
  const count = Number(process.env.NUKE_COUNT);
  return {
    sourceRevision: revision('HEAD'),
    sourceParentRevision: revision('HEAD^'),
    eventRevision: matched(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/u),
    eventBaseRevision: matched(
      process.env.NUKE_EVENT_BASE_SHA,
      /^[a-f0-9]{40}$/u,
    ),
    runId: matched(process.env.GITHUB_RUN_ID, /^[1-9][0-9]*$/u),
    runAttempt: matched(process.env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/u),
    provider: providers.includes(process.env.PROVIDER ?? '')
      ? (process.env.PROVIDER ?? null)
      : null,
    interruptAfterWitness:
      process.env.NUKE_INTERRUPT_AFTER_WITNESS === 'true'
        ? true
        : process.env.NUKE_INTERRUPT_AFTER_WITNESS === 'false'
          ? false
          : null,
    overlayCount:
      Number.isInteger(count) && count >= 300 && count <= 1000 ? count : null,
    testsOutcome: outcome('NUKE_TESTS_OUTCOME'),
    localCleanupOutcome: outcome('NUKE_LOCAL_CLEANUP_OUTCOME'),
    cloudCleanupOutcome: outcome('NUKE_CLOUD_CLEANUP_OUTCOME'),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assert(process.env.RESULTS_DIR && process.env.NUKE_EVIDENCE_DIR);
    const context = contextFromEnvironment();
    if (process.argv[2] === 'capture') {
      captureNukeEvidence(
        process.env.RESULTS_DIR,
        process.env.NUKE_EVIDENCE_DIR,
        context,
      );
    } else {
      assert.equal(process.argv[2], 'validate');
      assert.equal(process.env.NUKE_CAPTURE_OUTCOME, 'success');
      const errors = validateNukeEvidence(
        process.env.NUKE_EVIDENCE_DIR,
        context,
      );
      if (errors.length > 0) {
        console.error(errors.join('\n'));
        process.exitCode = 1;
      }
    }
  } catch {
    console.error('Nuke implementation evidence capture or validation failed');
    process.exitCode = 1;
  }
}
