import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureNukeEvidence,
  collectNukeEvidence,
  validateNukeEvidence,
  type NukeEvidenceContext,
} from '../../../ci/nuke-implementation.js';
import { projectNukeWorkloadImages } from '../../integration/helpers/nuke-image-evidence.js';

let directory: string;
let resultsDir: string;
let evidenceDir: string;
const normalIds = Array.from(
  { length: 300 },
  (_, index) => `nuke-1231-${index + 1}`,
);
const witnessIds = ['nuke-witness-1231-1'];
const engineImageId = `sha256:${'c'.repeat(64)}`;
const imageDigest = `sha256:${'d'.repeat(64)}`;
const localBusyboxImage =
  'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
const localBusyboxAmd64Digest =
  'sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nuke-implementation-'));
  resultsDir = join(directory, 'results');
  evidenceDir = join(directory, 'evidence');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function write(name: string, value: unknown): void {
  const path = join(resultsDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function patch(name: string, fields: Record<string, unknown>): void {
  const current: unknown = JSON.parse(
    readFileSync(join(resultsDir, name), 'utf8'),
  );
  if (current === null || typeof current !== 'object')
    throw new Error('fixture must be an object');
  write(name, { ...current, ...fields });
}

function fixture(
  forced = false,
  workloadImage = 'busybox:1.36',
  workloadDigest = imageDigest,
): NukeEvidenceContext {
  const exitCode = forced ? 143 : 0;
  const context: NukeEvidenceContext = {
    sourceRevision: 'a'.repeat(40),
    sourceParentRevision: 'b'.repeat(40),
    eventRevision: 'a'.repeat(40),
    eventBaseRevision: null,
    runId: '123',
    runAttempt: '1',
    provider: 'local',
    interruptAfterWitness: forced,
    overlayCount: 300,
    testsOutcome: forced ? 'failure' : 'success',
    localCleanupOutcome: 'success',
    cloudCleanupOutcome: 'success',
  };
  const imageIdentity = {
    sourceRevision: 'a'.repeat(40),
    runId: '123',
    runAttempt: 1,
  };
  write('nuke-api-built.json', {
    version: 1,
    kind: 'local-api-built-engine-image',
    ...imageIdentity,
    observedAt: '2026-09-20T01:00:00.000Z',
    status: 'observed',
    imageReference: 'ghcr.io/anycloud-sh/anycloud-api:0.0.0',
    engineImageId,
  });
  write('nuke-api-container.json', {
    version: 1,
    kind: 'local-api-container-engine-image',
    ...imageIdentity,
    observedAt: '2026-09-20T01:01:00.000Z',
    status: 'observed',
    containerName: 'anycloud-api',
    containerId: 'e'.repeat(64),
    engineImageId,
    configuredImageReference: 'ghcr.io/anycloud-sh/anycloud-api:0.0.0',
    running: true,
  });
  write('nuke-launch.json', { version: 1, exitCode });
  write('e2e-run.json', {
    version: 1,
    testName: 'nuke',
    implementation: 'bash',
    command: 'bash ./test/integration/nuke.test.sh',
    logFile: 'nuke-bash.log',
    exitCode,
    durationSeconds: 100,
  });
  write('nuke-cleanup/start.json', {
    version: 1,
    exitCode,
    forcedRequested: forced,
    forcedArmed: forced,
    normalIds,
    witnessIds,
  });
  write('nuke-cleanup/result.json', {
    version: 1,
    exitCode,
    cleanupExitCode: 0,
    repeatedTerm: forced,
  });
  write('nuke-cleanup/submissions.json', {
    version: 1,
    groupIds: forced ? [1000] : [],
    remainingGroupIds: [],
  });
  for (const [cohort, tracked] of [
    ['normal', normalIds],
    ['witness', witnessIds],
  ] as const) {
    write(`nuke-cleanup/${cohort}.json`, {
      version: 1,
      cohort,
      ids: tracked,
      terminationFailedIds: [],
      vmsEnded: true,
    });
    const inventory = {
      version: 1,
      cohort,
      workloads: tracked.map((id) => ({ id, state: 'running' })),
    };
    write(`nuke-cleanup/${cohort}-inventory.json`, inventory);
    const images = projectNukeWorkloadImages(
      imageIdentity,
      cohort,
      'inventory',
      tracked,
      workloadImage,
      tracked.map((id) => ({
        id,
        image: workloadImage,
        imageDigest: workloadDigest,
      })),
    );
    write(`nuke-cleanup/${cohort}-inventory-images.json`, images);
    if (forced)
      write(`nuke-cleanup/${cohort}-before-interrupt.json`, inventory);
    if (forced)
      write(`nuke-cleanup/${cohort}-before-interrupt-images.json`, {
        ...images,
        stage: 'before-interrupt',
      });
  }
  if (forced) {
    write('nuke-cleanup/admitted-witness.json', {
      version: 1,
      kind: 'admitted-witness-wrapper-hold',
      witnessId: witnessIds[0],
      wrapperPid: 1000,
      holdPid: 1001,
      holdSeconds: 30,
      admissionExitCode: 0,
    });
    write('nuke-cleanup/interruption.json', {
      version: 1,
      admittedWitnessId: witnessIds[0],
      wrapperPid: 1000,
      holdPid: 1001,
      activeIds: [...normalIds, ...witnessIds],
    });
  }
  return context;
}

describe('nuke implementation evidence', () => {
  it.each([
    [localBusyboxImage, localBusyboxAmd64Digest],
    ['busybox:1.36', imageDigest],
    [`registry.example.test/custom@sha256:${'f'.repeat(64)}`, imageDigest],
  ])(
    'validates actual controller observations for the fixture or explicit override %s',
    (workloadImage, workloadDigest) => {
      const context = fixture(true, workloadImage, workloadDigest);
      captureNukeEvidence(resultsDir, evidenceDir, context);
      expect(validateNukeEvidence(evidenceDir, context)).toEqual([]);
      for (const cohort of ['normal', 'witness']) {
        for (const stage of ['inventory', 'before-interrupt']) {
          const name = `nuke-cleanup/${cohort}-${stage}-images.json`;
          expect(readFileSync(join(evidenceDir, 'raw', name), 'utf8')).toBe(
            readFileSync(join(resultsDir, name), 'utf8'),
          );
        }
      }
    },
  );

  it.each(['normal', 'witness'])(
    'retains a null %s digest without filling it from the Local fixture pin',
    (cohort) => {
      const context = fixture(true, localBusyboxImage, localBusyboxAmd64Digest);
      const tracked = cohort === 'normal' ? normalIds : witnessIds;
      const name = `nuke-cleanup/${cohort}-inventory-images.json`;
      write(
        name,
        projectNukeWorkloadImages(
          { sourceRevision: 'a'.repeat(40), runId: '123', runAttempt: 1 },
          cohort,
          'inventory',
          tracked,
          localBusyboxImage,
          tracked.map((id, index) => ({
            id,
            image: localBusyboxImage,
            imageDigest: index === 0 ? null : localBusyboxAmd64Digest,
          })),
        ),
      );
      captureNukeEvidence(resultsDir, evidenceDir, context);
      expect(validateNukeEvidence(evidenceDir, context)).toContain(
        `${cohort} inventory controller image/digest is missing, unresolved or invalid`,
      );
      expect(
        JSON.parse(readFileSync(join(evidenceDir, 'raw', name), 'utf8'))
          .workloads[0],
      ).toMatchObject({ imageDigest: null, digestStatus: 'unresolved' });
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/result.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ exitCode: 143, cleanupExitCode: 0 });
    },
  );

  it.each([
    imageDigest,
    'sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662',
  ])(
    'retains but rejects a uniform non-child Local fixture digest %s',
    (workloadDigest) => {
      const context = fixture(true, localBusyboxImage, workloadDigest);
      captureNukeEvidence(resultsDir, evidenceDir, context);
      const errors = validateNukeEvidence(evidenceDir, context);
      for (const cohort of ['normal', 'witness']) {
        for (const stage of ['inventory', 'before-interrupt']) {
          const name = `nuke-cleanup/${cohort}-${stage}-images.json`;
          expect(errors).toContain(
            `${cohort} ${stage} controller digest differs from the Local BusyBox amd64 fixture`,
          );
          expect(readFileSync(join(evidenceDir, 'raw', name), 'utf8')).toBe(
            readFileSync(join(resultsDir, name), 'utf8'),
          );
        }
      }
      expect(errors).not.toContain(
        'normal and witness controller image digests are missing or disagree',
      );
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/result.json'),
            'utf8',
          ),
        ).cleanupExitCode,
      ).toBe(0);
    },
  );

  it.each([false, true])(
    'preserves source-bound raw outcomes and cleanup (forced: %s)',
    (forced) => {
      const context = fixture(forced);
      captureNukeEvidence(resultsDir, evidenceDir, context);
      expect(validateNukeEvidence(evidenceDir, context)).toEqual([]);
      expect(
        readFileSync(join(evidenceDir, 'raw/nuke-cleanup/result.json'), 'utf8'),
      ).toBe(
        readFileSync(join(resultsDir, 'nuke-cleanup/result.json'), 'utf8'),
      );
      expect(
        JSON.parse(readFileSync(join(evidenceDir, 'record.json'), 'utf8')),
      ).toMatchObject({
        authority: 'bash',
        kind: 'implementation-only',
        qualificationCount: 0,
        context,
        errors: [],
      });
    },
  );

  it('captures missing primary output after failed setup and still fails validation', () => {
    const context = {
      ...fixture(),
      testsOutcome: 'skipped',
      cloudCleanupOutcome: 'failure',
    };
    rmSync(resultsDir, { recursive: true });
    captureNukeEvidence(resultsDir, evidenceDir, context);
    const report = JSON.parse(
      readFileSync(join(evidenceDir, 'record.json'), 'utf8'),
    );
    expect(report).toMatchObject({ context, records: [] });
    expect(report.errors).toContain('e2e-run.json: missing or invalid');
    expect(validateNukeEvidence(evidenceDir, context)).toContain(
      'provider backstop did not succeed',
    );
  });

  it('records failed setup with native Node even without a project or installed dependencies', () => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'ci/nuke-implementation.ts'), 'capture'],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          // TMPDIR may be inside a checkout; this fixture has no repository.
          GIT_CEILING_DIRECTORIES: dirname(directory),
          RESULTS_DIR: resultsDir,
          NUKE_EVIDENCE_DIR: evidenceDir,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(evidenceDir, 'record.json'), 'utf8')).toContain(
      'source revision unavailable',
    );
  });

  it('excludes malformed raw content and credentials from compact and retained records', () => {
    const context = fixture(true);
    patch('e2e-run.json', { credentials: 'private-token-canary' });
    patch('nuke-cleanup/witness-inventory.json', {
      workloads: [
        {
          id: witnessIds[0],
          state: 'running',
          providerBody: 'private-token-canary',
        },
      ],
    });
    writeFileSync(
      join(resultsDir, 'nuke-cleanup/normal.json'),
      'private-token-canary',
    );
    patch('nuke-api-container.json', { Env: ['SECRET=private-token-canary'] });
    patch('nuke-cleanup/witness-inventory-images.json', {
      credentials: 'private-token-canary',
    });
    captureNukeEvidence(resultsDir, evidenceDir, context);
    const evidence = collectNukeEvidence(resultsDir, context);
    expect(evidence.errors).toContain('e2e-run.json: missing or invalid');
    expect(evidence.errors).toContain(
      'nuke-cleanup/witness-inventory.json: missing or invalid',
    );
    expect(
      readFileSync(join(evidenceDir, 'record.json'), 'utf8'),
    ).not.toContain('private-token-canary');
    expect(
      evidence.records.some(({ body }) =>
        body.includes('private-token-canary'),
      ),
    ).toBe(false);
    expect(validateNukeEvidence(evidenceDir, context).length).toBeGreaterThan(
      0,
    );
  });

  it.each([
    [
      'nuke-api-built.json',
      { runAttempt: 2 },
      'local API image observations are missing or belong to another source/attempt',
    ],
    [
      'nuke-api-container.json',
      { sourceRevision: 'f'.repeat(40) },
      'local API image observations are missing or belong to another source/attempt',
    ],
    [
      'nuke-api-container.json',
      { engineImageId: imageDigest },
      'running API container does not match the original built engine image',
    ],
    [
      'nuke-api-container.json',
      { configuredImageReference: 'foreign:latest' },
      'running API container does not match the original built engine image',
    ],
    [
      'nuke-api-container.json',
      { running: false },
      'running API container does not match the original built engine image',
    ],
    [
      'nuke-cleanup/witness-inventory-images.json',
      { stage: 'before-interrupt' },
      'witness inventory image observation identity differs',
    ],
    [
      'nuke-cleanup/normal-before-interrupt-images.json',
      { runId: '124' },
      'normal before-interrupt image observation identity differs',
    ],
  ])(
    'fails image binding %s while retaining primary outcome and cleanup (%j)',
    (name, fields, error) => {
      const context = fixture(true);
      patch(name, fields);
      captureNukeEvidence(resultsDir, evidenceDir, context);
      expect(validateNukeEvidence(evidenceDir, context)).toContain(error);
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/result.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ exitCode: 143, cleanupExitCode: 0 });
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/normal.json'),
            'utf8',
          ),
        ).ids,
      ).toEqual(normalIds);
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/witness.json'),
            'utf8',
          ),
        ).ids,
      ).toEqual(witnessIds);
    },
  );

  it.each(['missing', 'unresolved', 'invalid'])(
    'retains a %s controller digest as incomplete evidence, never guest proof',
    (digestStatus) => {
      const context = fixture(true);
      patch('nuke-cleanup/witness-inventory-images.json', {
        workloads: [
          {
            id: witnessIds[0],
            image: 'busybox:1.36',
            imageStatus: 'observed',
            imageDigest: null,
            digestStatus,
          },
        ],
      });
      captureNukeEvidence(resultsDir, evidenceDir, context);
      expect(validateNukeEvidence(evidenceDir, context)).toContain(
        'witness inventory controller image/digest is missing, unresolved or invalid',
      );
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/witness-inventory-images.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({
        kind: 'controller-workload-image-configuration',
        workloads: [{ imageDigest: null, digestStatus }],
      });
      expect(
        JSON.parse(
          readFileSync(
            join(evidenceDir, 'raw/nuke-cleanup/witness.json'),
            'utf8',
          ),
        ).vmsEnded,
      ).toBe(true);
    },
  );

  it('retains the first valid caller image record when a later observation is missing', () => {
    const context = fixture(true);
    rmSync(join(resultsDir, 'nuke-cleanup/witness-inventory-images.json'));
    captureNukeEvidence(resultsDir, evidenceDir, context);
    expect(validateNukeEvidence(evidenceDir, context)).toContain(
      'nuke-cleanup/witness-inventory-images.json: missing or invalid',
    );
    expect(
      JSON.parse(
        readFileSync(
          join(
            evidenceDir,
            'raw/nuke-cleanup/witness-before-interrupt-images.json',
          ),
          'utf8',
        ),
      ).workloads,
    ).toEqual([
      {
        id: witnessIds[0],
        image: 'busybox:1.36',
        imageStatus: 'observed',
        imageDigest,
        digestStatus: 'observed',
      },
    ]);
    expect(
      JSON.parse(
        readFileSync(
          join(evidenceDir, 'raw/nuke-cleanup/witness.json'),
          'utf8',
        ),
      ).ids,
    ).toEqual(witnessIds);
  });

  it('retains but rejects a different controller digest in the second caller cohort', () => {
    const context = fixture();
    patch('nuke-cleanup/witness-inventory-images.json', {
      workloads: [
        {
          id: witnessIds[0],
          image: 'busybox:1.36',
          imageStatus: 'observed',
          imageDigest: `sha256:${'f'.repeat(64)}`,
          digestStatus: 'observed',
        },
      ],
    });
    captureNukeEvidence(resultsDir, evidenceDir, context);
    expect(validateNukeEvidence(evidenceDir, context)).toContain(
      'normal and witness controller image digests are missing or disagree',
    );
    expect(
      JSON.parse(
        readFileSync(
          join(evidenceDir, 'raw/nuke-cleanup/witness-inventory-images.json'),
          'utf8',
        ),
      ).workloads[0].imageDigest,
    ).toBe(`sha256:${'f'.repeat(64)}`);
    expect(
      JSON.parse(
        readFileSync(join(evidenceDir, 'raw/nuke-cleanup/result.json'), 'utf8'),
      ).cleanupExitCode,
    ).toBe(0);
  });

  it.each([
    [
      'nuke-cleanup/normal.json',
      { vmsEnded: false },
      'normal caller termination or VM ledger drain unresolved',
    ],
    [
      'nuke-cleanup/witness.json',
      { terminationFailedIds: witnessIds },
      'witness caller termination or VM ledger drain unresolved',
    ],
    [
      'nuke-cleanup/submissions.json',
      { remainingGroupIds: [1000] },
      'submission shutdown unresolved',
    ],
    [
      'nuke-launch.json',
      { exitCode: 1 },
      'original and outer exits must match the declared outcome',
    ],
    [
      'nuke-cleanup/result.json',
      { exitCode: 130 },
      'original and outer exits must match the declared outcome',
    ],
    [
      'nuke-cleanup/result.json',
      { cleanupExitCode: 1 },
      'cleanup did not succeed',
    ],
    [
      'nuke-cleanup/result.json',
      { repeatedTerm: false },
      'interruption and repeated-signal evidence disagree',
    ],
    [
      'nuke-cleanup/start.json',
      { forcedArmed: false },
      'interruption and repeated-signal evidence disagree',
    ],
    [
      'nuke-cleanup/submissions.json',
      { groupIds: [] },
      'admitted witness hold was not owned and reaped',
    ],
    [
      'nuke-cleanup/interruption.json',
      { holdPid: 2000 },
      'admitted witness hold was not owned and reaped',
    ],
    [
      'nuke-cleanup/admitted-witness.json',
      { admissionExitCode: 42 },
      'nuke-cleanup/admitted-witness.json: missing or invalid',
    ],
    [
      'nuke-cleanup/admitted-witness.json',
      { kind: 'lost-provider-launch-reply' },
      'nuke-cleanup/admitted-witness.json: missing or invalid',
    ],
  ])(
    'rejects a failed cancellation assertion in %s (%j)',
    (name, fields, error) => {
      const context = fixture(true);
      patch(name, fields);
      captureNukeEvidence(resultsDir, evidenceDir, context);
      expect(validateNukeEvidence(evidenceDir, context)).toContain(error);
    },
  );

  it('requires real active Workloads before arming, not merely a held process', () => {
    const context = fixture(true);
    for (const [cohort, tracked] of [
      ['normal', normalIds],
      ['witness', witnessIds],
    ] as const) {
      patch(`nuke-cleanup/${cohort}-before-interrupt.json`, {
        workloads: tracked.map((id) => ({ id, state: 'completed' })),
      });
    }
    patch('nuke-cleanup/interruption.json', { activeIds: [] });
    expect(collectNukeEvidence(resultsDir, context).errors).toContain(
      'interruption has no observed active tracked Workload',
    );
  });

  it.each([
    [[], 'witness caller inventory incomplete'],
    [
      [{ id: normalIds[0], state: 'running' }],
      'witness caller inventory incomplete',
    ],
    [
      [
        { id: witnessIds[0], state: 'running' },
        { id: witnessIds[0], state: 'running' },
      ],
      'nuke-cleanup/witness-inventory.json: missing or invalid',
    ],
    [
      [{ id: witnessIds[0], state: 'unknown' }],
      'nuke-cleanup/witness-inventory.json: missing or invalid',
    ],
  ])(
    'rejects missing, foreign, duplicate or unknown caller inventory %j',
    (workloads, error) => {
      const context = fixture();
      patch('nuke-cleanup/witness-inventory.json', { workloads });
      expect(collectNukeEvidence(resultsDir, context).errors).toContain(error);
    },
  );

  it.each([
    [
      { localCleanupOutcome: 'failure' },
      'Local backstop has an unexpected outcome',
    ],
    [{ cloudCleanupOutcome: 'skipped' }, 'provider backstop did not succeed'],
    [{ testsOutcome: 'success' }, 'unexpected test step outcome'],
    [
      { eventRevision: 'c'.repeat(40) },
      'checkout differs from the event revision',
    ],
  ])(
    'requires the declared source, failure and successful backstops %j',
    (change, error) => {
      const context = { ...fixture(true), ...change };
      expect(collectNukeEvidence(resultsDir, context).errors).toContain(error);
    },
  );

  it('detects changed raw bytes and mismatched final source revisions', () => {
    const context = fixture(true);
    captureNukeEvidence(resultsDir, evidenceDir, context);
    expect(
      validateNukeEvidence(evidenceDir, {
        ...context,
        sourceRevision: 'c'.repeat(40),
      }),
    ).toEqual(['implementation record is missing, changed or invalid']);
    writeFileSync(
      join(evidenceDir, 'raw/nuke-cleanup/result.json'),
      `${readFileSync(join(evidenceDir, 'raw/nuke-cleanup/result.json'), 'utf8')} `,
    );
    expect(validateNukeEvidence(evidenceDir, context)).toEqual([
      'implementation record is missing, changed or invalid',
    ]);
  });
});
