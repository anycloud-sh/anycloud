// Nuke implementation observations only. Docker engine IDs identify the local
// build and API container; they are not claimed to be OCI manifest/config IDs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const imagePattern =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/u;
const identityFields = ['sourceRevision', 'runId', 'runAttempt'];

export interface NukeImageIdentity {
  sourceRevision: string;
  runId: string;
  runAttempt: number;
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  const record = object(value);
  assert.deepEqual(Object.keys(record).sort(), fields.toSorted());
  return record;
}

function text(value: unknown, pattern: RegExp): string {
  assert(typeof value === 'string' && pattern.test(value));
  return value;
}

function image(value: unknown): string {
  const result = text(value, imagePattern);
  assert(result.length <= 512);
  return result;
}

function identity(record: Record<string, unknown>): NukeImageIdentity {
  assert(
    typeof record.runAttempt === 'number' &&
      Number.isSafeInteger(record.runAttempt) &&
      record.runAttempt > 0,
  );
  return {
    sourceRevision: text(record.sourceRevision, /^[a-f0-9]{40}$/u),
    runId: text(record.runId, /^(?:local-)?[1-9][0-9]*$/u),
    runAttempt: record.runAttempt,
  };
}

function observation(value: unknown, kind: string, fields: string[]) {
  const record = exact(value, [
    'version',
    'kind',
    ...identityFields,
    'observedAt',
    'status',
    ...fields,
  ]);
  assert.equal(record.version, 1);
  assert.equal(record.kind, kind);
  const observedAt = text(
    record.observedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  assert.equal(new Date(observedAt).toISOString(), observedAt);
  return {
    record,
    metadata: { version: 1, kind, ...identity(record), observedAt },
  };
}

export function parseNukeBuiltImage(value: unknown) {
  const status = object(value).status;
  const { record, metadata } = observation(
    value,
    'local-api-built-engine-image',
    status === 'observed'
      ? ['imageReference', 'engineImageId']
      : ['imageReference', 'reason'],
  );
  const imageReference = image(record.imageReference);
  if (status === 'observed')
    return {
      ...metadata,
      status: 'observed' as const,
      imageReference,
      engineImageId: text(record.engineImageId, digestPattern),
    };
  assert.equal(status, 'unavailable');
  const reason = text(
    record.reason,
    /^(?:inspection-failed|malformed-observation)$/u,
  );
  return {
    ...metadata,
    status: 'unavailable' as const,
    imageReference,
    reason,
  };
}

export function parseNukeApiContainer(value: unknown) {
  const status = object(value).status;
  const { record, metadata } = observation(
    value,
    'local-api-container-engine-image',
    status === 'observed'
      ? [
          'containerName',
          'containerId',
          'engineImageId',
          'configuredImageReference',
          'running',
        ]
      : ['containerName', 'reason'],
  );
  assert.equal(record.containerName, 'anycloud-api');
  const containerName = 'anycloud-api';
  if (status === 'observed') {
    assert(typeof record.running === 'boolean');
    return {
      ...metadata,
      status: 'observed' as const,
      containerName,
      containerId: text(record.containerId, /^[a-f0-9]{64}$/u),
      engineImageId: text(record.engineImageId, digestPattern),
      configuredImageReference: image(record.configuredImageReference),
      running: record.running,
    };
  }
  assert.equal(status, 'unavailable');
  const reason = text(
    record.reason,
    /^(?:inspection-failed|malformed-observation)$/u,
  );
  return {
    ...metadata,
    status: 'unavailable' as const,
    containerName,
    reason,
  };
}

export function validateNukeApiImageBinding(
  builtValue: unknown,
  containerValue: unknown,
): void {
  const built = parseNukeBuiltImage(builtValue);
  const container = parseNukeApiContainer(containerValue);
  assert.equal(built.status, 'observed');
  assert.equal(container.status, 'observed');
  if (built.status !== 'observed' || container.status !== 'observed') return;
  assert.deepEqual(identity(built), identity(container));
  assert(built.observedAt <= container.observedAt);
  assert.equal(container.running, true);
  assert.equal(container.configuredImageReference, built.imageReference);
  assert.equal(container.engineImageId, built.engineImageId);
}

type Inspect = (args: string[]) => string;

function inspectDocker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function observeNukeBuiltImage(
  metadata: NukeImageIdentity,
  reference: string,
  inspect: Inspect = inspectDocker,
) {
  const base = {
    version: 1,
    kind: 'local-api-built-engine-image',
    ...identity(object(metadata)),
    imageReference: image(reference),
    observedAt: new Date().toISOString(),
  };
  let raw: string;
  try {
    raw = inspect(['image', 'inspect', '--format', '{{json .Id}}', reference]);
  } catch {
    return parseNukeBuiltImage({
      ...base,
      status: 'unavailable',
      reason: 'inspection-failed',
    });
  }
  try {
    const engineImageId: unknown = JSON.parse(raw);
    return parseNukeBuiltImage({
      ...base,
      status: 'observed',
      engineImageId,
    });
  } catch {
    return parseNukeBuiltImage({
      ...base,
      status: 'unavailable',
      reason: 'malformed-observation',
    });
  }
}

export function observeNukeApiContainer(
  metadata: NukeImageIdentity,
  inspect: Inspect = inspectDocker,
) {
  const base = {
    version: 1,
    kind: 'local-api-container-engine-image',
    ...identity(object(metadata)),
    containerName: 'anycloud-api',
    observedAt: new Date().toISOString(),
  };
  let raw: string;
  try {
    raw = inspect([
      'container',
      'inspect',
      '--format',
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"ConfiguredImage":{{json .Config.Image}},"Running":{{json .State.Running}}}',
      'anycloud-api',
    ]);
  } catch {
    return parseNukeApiContainer({
      ...base,
      status: 'unavailable',
      reason: 'inspection-failed',
    });
  }
  try {
    const row = exact(JSON.parse(raw), [
      'Id',
      'Name',
      'Image',
      'ConfiguredImage',
      'Running',
    ]);
    assert.equal(row.Name, '/anycloud-api');
    return parseNukeApiContainer({
      ...base,
      status: 'observed',
      containerId: row.Id,
      engineImageId: row.Image,
      configuredImageReference: row.ConfiguredImage,
      running: row.Running,
    });
  } catch {
    return parseNukeApiContainer({
      ...base,
      status: 'unavailable',
      reason: 'malformed-observation',
    });
  }
}

function workloadIds(value: unknown): string[] {
  assert(Array.isArray(value) && value.length <= 1000);
  const ids = value.map((id: unknown) =>
    text(id, /^nuke-(?:witness-)?[0-9]+-[1-9][0-9]*$/u),
  );
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}

function imageField(value: unknown, expected: string) {
  if (value === undefined) return { image: null, imageStatus: 'missing' };
  if (value === null) return { image: null, imageStatus: 'unresolved' };
  if (
    typeof value !== 'string' ||
    !imagePattern.test(value) ||
    value.length > 512
  )
    return { image: null, imageStatus: 'invalid' };
  // An unexpected image string can be malformed credential-bearing input even
  // if it resembles a repository name. Retain the mismatch, never that value.
  if (value !== expected) return { image: null, imageStatus: 'mismatch' };
  return { image: value, imageStatus: 'observed' };
}

function digestField(value: unknown) {
  if (value === undefined)
    return { imageDigest: null, digestStatus: 'missing' };
  if (value === null) return { imageDigest: null, digestStatus: 'unresolved' };
  if (typeof value !== 'string' || !digestPattern.test(value))
    return { imageDigest: null, digestStatus: 'invalid' };
  return { imageDigest: value, digestStatus: 'observed' };
}

export function parseNukeWorkloadImages(value: unknown) {
  const record = exact(value, [
    'version',
    'kind',
    ...identityFields,
    'cohort',
    'stage',
    'expectedImage',
    'workloads',
  ]);
  assert.equal(record.version, 1);
  assert.equal(record.kind, 'controller-workload-image-configuration');
  assert(record.cohort === 'normal' || record.cohort === 'witness');
  assert(record.stage === 'inventory' || record.stage === 'before-interrupt');
  const expectedImage = image(record.expectedImage);
  assert(Array.isArray(record.workloads));
  const workloads = record.workloads.map((value: unknown) => {
    const row = exact(value, [
      'id',
      'image',
      'imageStatus',
      'imageDigest',
      'digestStatus',
    ]);
    const id = workloadIds([row.id])[0];
    const imageStatus = text(
      row.imageStatus,
      /^(?:observed|missing|unresolved|invalid|mismatch)$/u,
    );
    const digestStatus = text(
      row.digestStatus,
      /^(?:observed|missing|unresolved|invalid)$/u,
    );
    if (imageStatus === 'observed') assert.equal(row.image, expectedImage);
    else assert.equal(row.image, null);
    if (digestStatus === 'observed') text(row.imageDigest, digestPattern);
    else assert.equal(row.imageDigest, null);
    return {
      id,
      image: row.image === null ? null : image(row.image),
      imageStatus,
      imageDigest:
        row.imageDigest === null ? null : text(row.imageDigest, digestPattern),
      digestStatus,
    };
  });
  workloadIds(workloads.map(({ id }) => id));
  return {
    version: 1,
    kind: 'controller-workload-image-configuration',
    ...identity(record),
    cohort: record.cohort,
    stage: record.stage,
    expectedImage,
    workloads,
  };
}

export function projectNukeWorkloadImages(
  metadata: NukeImageIdentity,
  cohort: string,
  stage: string,
  expectedIds: unknown,
  expectedImage: string,
  value: unknown,
) {
  const expected = workloadIds(expectedIds);
  const reference = image(expectedImage);
  assert(Array.isArray(value));
  const rows = value.map(object);
  assert.deepEqual(
    workloadIds(rows.map((row) => row.id)).toSorted(),
    expected.toSorted(),
  );
  return parseNukeWorkloadImages({
    version: 1,
    kind: 'controller-workload-image-configuration',
    ...identity(object(metadata)),
    cohort,
    stage,
    expectedImage: reference,
    workloads: rows.map((row) => ({
      id: row.id,
      ...imageField(row.image, reference),
      ...digestField(row.imageDigest),
    })),
  });
}

function currentIdentity(): NukeImageIdentity {
  return identity({
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
    runId:
      process.env.GITHUB_RUN_ID ??
      process.env.E2E_NUKE_IMAGE_RUN_ID ??
      `local-${process.ppid}`,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? '1'),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [mode, path, ...args] = process.argv.slice(2);
    assert(path);
    const metadata = currentIdentity();
    let record;
    if (mode === 'built') {
      assert.equal(args.length, 1);
      record = observeNukeBuiltImage(metadata, args[0]);
    } else if (mode === 'container') {
      assert.equal(args.length, 0);
      record = observeNukeApiContainer(metadata);
    } else {
      assert.equal(mode, 'workloads');
      assert.equal(args.length, 4);
      record = projectNukeWorkloadImages(
        metadata,
        args[0],
        args[1],
        JSON.parse(args[2]),
        args[3],
        JSON.parse(readFileSync(0, 'utf8')),
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    // Never replace an earlier complete observation in the same attempt.
    writeFileSync(path, `${JSON.stringify(record)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    console.error('Nuke image evidence could not be recorded');
    process.exitCode = 1;
  }
}
