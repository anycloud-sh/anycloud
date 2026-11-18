import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  observeNukeApiContainer,
  observeNukeBuiltImage,
  parseNukeApiContainer,
  parseNukeWorkloadImages,
  projectNukeWorkloadImages,
  validateNukeApiImageBinding,
} from '../../integration/helpers/nuke-image-evidence.js';

const metadata = {
  sourceRevision: 'a'.repeat(40),
  runId: '123',
  runAttempt: 1,
};
const engineId = `sha256:${'b'.repeat(64)}`;
const imageDigest = `sha256:${'c'.repeat(64)}`;
const apiImage = 'ghcr.io/anycloud-sh/anycloud-api:0.0.0';
const rawContainer = {
  Id: 'd'.repeat(64),
  Name: '/anycloud-api',
  Image: engineId,
  ConfiguredImage: apiImage,
  Running: true,
};
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('nuke image observations', () => {
  it('binds the actual API container to the original local build using engine identity only', () => {
    const calls: string[][] = [];
    const built = observeNukeBuiltImage(metadata, apiImage, (args) => {
      calls.push(args);
      return JSON.stringify(engineId);
    });
    const container = observeNukeApiContainer(metadata, (args) => {
      calls.push(args);
      return JSON.stringify(rawContainer);
    });
    expect(() => validateNukeApiImageBinding(built, container)).not.toThrow();
    expect(built).toMatchObject({
      status: 'observed',
      engineImageId: engineId,
      imageReference: apiImage,
    });
    expect(container).toMatchObject({
      status: 'observed',
      containerId: rawContainer.Id,
      engineImageId: engineId,
      configuredImageReference: apiImage,
      running: true,
    });
    expect(calls).toEqual([
      ['image', 'inspect', '--format', '{{json .Id}}', apiImage],
      [
        'container',
        'inspect',
        '--format',
        '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"ConfiguredImage":{{json .Config.Image}},"Running":{{json .State.Running}}}',
        'anycloud-api',
      ],
    ]);
    expect(JSON.stringify({ built, container })).not.toContain('manifest');
  });

  it.each([
    { engineImageId: imageDigest },
    { configuredImageReference: 'different:latest' },
    { running: false },
    { containerId: 'short-id' },
    { sourceRevision: 'e'.repeat(40) },
    { runAttempt: 2 },
    { observedAt: '2000-01-01T00:00:00.000Z' },
    { Env: ['SECRET=private-canary'] },
  ])('rejects substituted or stale stored container evidence %j', (change) => {
    const built = observeNukeBuiltImage(metadata, apiImage, () =>
      JSON.stringify(engineId),
    );
    const container = observeNukeApiContainer(metadata, () =>
      JSON.stringify(rawContainer),
    );
    expect(() =>
      validateNukeApiImageBinding(built, { ...container, ...change }),
    ).toThrow();
  });

  it.each([
    () => {
      throw new Error('credentials=private-canary');
    },
    () => JSON.stringify({ ...rawContainer, Env: ['SECRET=private-canary'] }),
    () => '{private-canary',
    () => `${JSON.stringify(rawContainer)}\n${JSON.stringify(rawContainer)}`,
    () => JSON.stringify({ ...rawContainer, Name: '/another-container' }),
  ])(
    'retains a narrow failed container receipt without raw Docker output',
    (inspect) => {
      const record = observeNukeApiContainer(metadata, inspect);
      expect(record.status).toBe('unavailable');
      expect(() => parseNukeApiContainer(record)).not.toThrow();
      expect(JSON.stringify(record)).not.toContain('private-canary');
      expect(record).not.toHaveProperty('engineImageId');
    },
  );

  it('retains build inspection failure without treating the configured tag as an observed ID', () => {
    const built = observeNukeBuiltImage(metadata, apiImage, () => {
      throw new Error('private-canary');
    });
    expect(built).toMatchObject({
      status: 'unavailable',
      reason: 'inspection-failed',
      imageReference: apiImage,
    });
    expect(JSON.stringify(built)).not.toContain('private-canary');
    expect(built).not.toHaveProperty('engineImageId');
    expect(
      observeNukeBuiltImage(metadata, apiImage, () => JSON.stringify(apiImage)),
    ).toMatchObject({ status: 'unavailable', reason: 'malformed-observation' });
  });

  it.each(['normal', 'witness'])(
    'projects concrete controller image facts for the %s caller without retaining private status fields',
    (cohort) => {
      const id = cohort === 'normal' ? 'nuke-1231-1' : 'nuke-witness-1231-1';
      const record = projectNukeWorkloadImages(
        metadata,
        cohort,
        'inventory',
        [id],
        'busybox:1.36',
        [
          {
            id,
            image: 'busybox:1.36',
            imageDigest,
            state: 'running',
            githubToken: 'private-canary',
            sshPrivateKey: 'private-canary',
            env: { SECRET: 'private-canary' },
          },
        ],
      );
      expect(record).toMatchObject({
        kind: 'controller-workload-image-configuration',
        cohort,
        workloads: [
          {
            id,
            image: 'busybox:1.36',
            imageStatus: 'observed',
            imageDigest,
            digestStatus: 'observed',
          },
        ],
      });
      expect(JSON.stringify(record)).not.toContain('private-canary');
      expect(record).not.toHaveProperty('guestExecution');
    },
  );

  it('keeps valid rows while distinguishing unresolved, missing and malformed image observations', () => {
    const ids = [1, 2, 3, 4, 5].map((id) => `nuke-1231-${id}`);
    const record = projectNukeWorkloadImages(
      metadata,
      'normal',
      'inventory',
      ids,
      'busybox:1.36',
      [
        { id: ids[0], image: 'busybox:1.36', imageDigest },
        { id: ids[1], image: null, imageDigest: null },
        { id: ids[2] },
        {
          id: ids[3],
          image: { token: 'private-canary' },
          imageDigest: 'private-canary',
        },
        { id: ids[4], image: 'private-canary', imageDigest },
      ],
    );
    expect(record.workloads.map(({ id }) => id)).toEqual(ids);
    expect(
      record.workloads.map(({ imageStatus, digestStatus }) => [
        imageStatus,
        digestStatus,
      ]),
    ).toEqual([
      ['observed', 'observed'],
      ['unresolved', 'unresolved'],
      ['missing', 'missing'],
      ['invalid', 'invalid'],
      ['mismatch', 'observed'],
    ]);
    expect(record.workloads[0]).toMatchObject({
      image: 'busybox:1.36',
      imageDigest,
    });
    expect(JSON.stringify(record)).not.toContain('private-canary');
  });

  it.each([
    [],
    [{ id: 'nuke-1231-1' }, { id: 'nuke-1231-1' }],
    [{ id: 'nuke-9991-1' }],
    { token: 'private-canary' },
  ])(
    'rejects partial, duplicate, foreign or malformed inventory %j',
    (rows) => {
      expect(() =>
        projectNukeWorkloadImages(
          metadata,
          'normal',
          'inventory',
          ['nuke-1231-1'],
          'busybox:1.36',
          rows,
        ),
      ).toThrow();
    },
  );

  it('rejects altered retained projections rather than trusting their writer', () => {
    const record = projectNukeWorkloadImages(
      metadata,
      'normal',
      'inventory',
      ['nuke-1231-1'],
      'busybox:1.36',
      [{ id: 'nuke-1231-1', image: 'busybox:1.36', imageDigest }],
    );
    expect(() =>
      parseNukeWorkloadImages({
        ...record,
        workloads: [{ ...record.workloads[0], image: 'foreign:latest' }],
      }),
    ).toThrow();
    expect(() =>
      parseNukeWorkloadImages({
        ...record,
        workloads: [{ ...record.workloads[0], imageDigest: null }],
      }),
    ).toThrow();
    expect(() =>
      parseNukeWorkloadImages({ ...record, credentials: 'private-canary' }),
    ).toThrow();
  });
});

describe('nuke image evidence in the isolated runner', () => {
  it.each([
    { exitCode: 0, inspectFailure: false, collision: false },
    { exitCode: 143, inspectFailure: false, collision: false },
    { exitCode: 143, inspectFailure: true, collision: false },
    { exitCode: 0, inspectFailure: false, collision: true },
    { exitCode: 143, inspectFailure: false, collision: true },
  ])(
    'captures before API teardown and preserves the original result %j',
    ({ exitCode, inspectFailure, collision }) => {
      const directory = mkdtempSync(join(tmpdir(), 'nuke-image-runner-'));
      temporary.push(directory);
      const bin = join(directory, 'bin');
      const results = join(directory, 'results');
      mkdirSync(bin);
      mkdirSync(results);
      const alive = join(directory, 'api-alive');
      writeFileSync(alive, 'running');
      writeFileSync(join(directory, 'image.json'), JSON.stringify(engineId));
      writeFileSync(
        join(directory, 'container.json'),
        JSON.stringify(rawContainer),
      );
      writeFileSync(
        join(results, 'e2e-run.json'),
        JSON.stringify({ exitCode }),
      );
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/bash
set -e
case "$1 $2" in
  'image inspect') printf 'built\\n' >> "$NUKE_TEST_TRACE"; cat "$NUKE_TEST_IMAGE" ;;
  'container inspect')
    printf 'container\\n' >> "$NUKE_TEST_TRACE"
    [ -f "$NUKE_TEST_ALIVE" ] && [ "$NUKE_TEST_INSPECT_FAILURE" = false ] || exit 7
    cat "$NUKE_TEST_CONTAINER"
    ;;
  'logs anycloud-api') printf 'logs\\n' >> "$NUKE_TEST_TRACE" ;;
  *) exit 9 ;;
esac
`,
        { mode: 0o755 },
      );
      const source = readFileSync('test/integration/e2e.sh', 'utf8');
      const definitionsStart = source.indexOf('\ncapture_runner_evidence() {');
      expect(definitionsStart).toBeGreaterThan(0);
      const definitions = source
        .slice(definitionsStart, source.indexOf('\ntrap cleanup EXIT'))
        .replaceAll('/tmp/api-e2e.log', join(results, 'api-e2e.log'));
      const buildHookStart = source.indexOf(
        '\nif [ "$TEST_NAME" = "nuke" ]; then\n    node test/integration/helpers/nuke-image-evidence.ts built',
      );
      expect(buildHookStart).toBeGreaterThan(0);
      const buildHook = source.slice(
        buildHookStart,
        source.indexOf('\nfi', buildHookStart) + 3,
      );
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
set -e
RESULTS_DIR=$1
TEMP_DIR=$2
TEST_NAME=nuke
E2E_IMPLEMENTATION=bash
IMAGE_TAG=$3
E2E_API_STARTED=true
DEBUG_MODE=false
CLI=stop_api
print_info() { :; }
print_error() { printf '%s\\n' "$*" >&2; }
e2e_ensure_run_record() { :; }
e2e_process_evidence() { :; }
stop_api() { printf 'stop\\n' >> "$NUKE_TEST_TRACE"; rm "$NUKE_TEST_ALIVE"; }
kill_port() { :; }
needs_local_smolvm_runtime() { return 1; }
yarn() { printf 'unexpected-hosted-audit\\n' >> "$NUKE_TEST_TRACE"; return 1; }
cleanup_anycloud_dir() { printf 'cleaned\\n' >> "$NUKE_TEST_TRACE"; }
eval "$4"
trap cleanup EXIT
eval "$5"
if [ "$7" = true ]; then
  node test/integration/helpers/nuke-image-evidence.ts container "$RESULTS_DIR/nuke-api-container.json"
  cp "$RESULTS_DIR/nuke-api-container.json" "$TEMP_DIR/first-api-container.json"
fi
exit "$6"
`,
          'fixture',
          results,
          directory,
          apiImage,
          definitions,
          buildHook,
          String(exitCode),
          String(collision),
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_RUN_ID: '123',
            GITHUB_RUN_ATTEMPT: '1',
            NUKE_TEST_TRACE: join(directory, 'trace'),
            NUKE_TEST_IMAGE: join(directory, 'image.json'),
            NUKE_TEST_CONTAINER: join(directory, 'container.json'),
            NUKE_TEST_ALIVE: alive,
            NUKE_TEST_INSPECT_FAILURE: String(inspectFailure),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(exitCode);
      expect(
        readFileSync(join(directory, 'trace'), 'utf8').trim().split('\n'),
      ).toEqual([
        'built',
        ...(collision ? ['container'] : []),
        'container',
        'logs',
        'stop',
        'cleaned',
      ]);
      if (collision) {
        expect(result.stderr).toContain(
          'Nuke image evidence could not be recorded',
        );
        expect(result.stderr).toContain(
          'Nuke API container image evidence unavailable',
        );
        expect(
          readFileSync(join(results, 'nuke-api-container.json'), 'utf8'),
        ).toBe(
          readFileSync(join(directory, 'first-api-container.json'), 'utf8'),
        );
      }
      const built = JSON.parse(
        readFileSync(join(results, 'nuke-api-built.json'), 'utf8'),
      );
      const container = JSON.parse(
        readFileSync(join(results, 'nuke-api-container.json'), 'utf8'),
      );
      if (inspectFailure) {
        expect(container).toMatchObject({
          status: 'unavailable',
          reason: 'inspection-failed',
        });
        expect(() => validateNukeApiImageBinding(built, container)).toThrow();
      } else
        expect(() =>
          validateNukeApiImageBinding(built, container),
        ).not.toThrow();
    },
  );
});
