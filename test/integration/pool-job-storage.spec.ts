/**
 * RFC 0043 on real Azure, S3 or GCS storage (POOL_JOB_STORAGE_CLOUD, Azure by
 * default), with the runner's pinned rclone and the remotes and env a runner
 * receives. S3, S4 and S18: a pool Job's credentials work inside its own
 * prefixes and nowhere else, and delete only where GCS needs it to overwrite.
 * S1, S2, S7, S10 and S17: the runner's own `runJob` stages, uploads,
 * restores and reports, with its `/mnt` paths in a temporary directory. S19:
 * a copy with a lapsed grant fails and is retried, and S22: a managed bucket
 * name another owner holds is refused. RFC 0044 S20: an output
 * bucket missing at the end, then recreated. No VM or Pod; the buckets are
 * deleted afterwards.
 *
 * Needs AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID and
 * AZURE_CLIENT_SECRET; AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; or
 * GCP_PROJECT_ID, GCP_PRIVATE_KEY and GCP_CLIENT_EMAIL.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Storage } from '@google-cloud/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCheckpointStorageProvider } from '../../src/api/services/cloud-config.js';
import { Azure } from '../../src/api/services/gateways/azure.js';
import {
  canListObjects,
  canMintScopedStorageToken,
} from '../../src/api/services/gateways/cloud.js';
import {
  attemptEndOf,
  batchPolicy,
} from '../../src/api/services/job-outcome.js';
import { rcloneGrantRemote } from '../../src/api/services/rclone-config.js';
import { empty } from '../../src/runner/reset.js';
import { runJob, type RunnerPorts } from '../../src/runner/runner.js';
import { rcloneCopy } from '../../src/runner/transfer.js';
import type {
  WorkloadExecution,
  WorkloadRunnerReport,
} from '../../src/shared/api-contract/deployment-workload-schemas.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { mintPoolJobGrants } from '../../src/api/services/pool-job-storage.js';
import { azureDirectorySas } from '../../src/api/services/provider-clients/azure.js';
import {
  readWorkloadCheckpointHealth,
  resolveWorkloadStorage,
} from '../../src/api/services/workload-storage.js';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../src/shared/cloud.js';
import { BucketNameTakenError } from '../../src/shared/errors.js';
import { TEST_USERNAMES } from '../../src/api/services/test-identity.js';
import { requireAzureAuthentication } from './helpers/external-errors.js';
import { pinnedRclone } from './helpers/pinned-rclone.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const cloud = process.env.POOL_JOB_STORAGE_CLOUD ?? 'azure';
const run = randomBytes(4).toString('hex');
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const input = `st1b-in-${run}`;
const output = `st1b-out-${run}`;
const checkpoint = `st1b-ck-${run}`;
const gone = `st1b-gone-${run}`;
const recreated = `st1b-s20-${run}`;
const managed = `st1b-mg-${run}`;
const owner = TEST_USERNAMES[0];

/** Each backend's credential and region, and its rclone remote's name. */
const BACKENDS = {
  azure: {
    remote: 'azureblob',
    region: 'eastus',
    credentials: (): CloudCredentials => ({
      cloudProvider: CloudType.Azure,
      subscriptionId: env('AZURE_SUBSCRIPTION_ID'),
      directoryId: env('AZURE_TENANT_ID'),
      applicationId: env('AZURE_CLIENT_ID'),
      secret: env('AZURE_CLIENT_SECRET'),
    }),
  },
  aws: {
    remote: 's3',
    region: 'us-east-2',
    credentials: (): CloudCredentials => ({
      cloudProvider: CloudType.AWS,
      accessKeyId: env('AWS_ACCESS_KEY_ID'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    }),
  },
  gcp: {
    remote: 'gcs',
    region: 'us-central1',
    credentials: (): CloudCredentials => ({
      cloudProvider: CloudType.GCP,
      projectId: env('GCP_PROJECT_ID'),
      privateKey: env('GCP_PRIVATE_KEY'),
      clientEmail: env('GCP_CLIENT_EMAIL'),
    }),
  },
}[cloud]!;
const credentials = BACKENDS.credentials();
const config = completeCloudConfig(
  {
    cloudProvider: credentials.cloudProvider,
    region: BACKENDS.region,
    credentials,
    inputBucket: input,
    outputBucket: output,
  },
  { zone: false },
);
/** The same buckets, signed by an explicit storage credential (RFC 0043 O11). */
const explicit: CloudConfig = {
  ...config,
  inputStorageCredentials: credentials,
  inputStorageRegion: BACKENDS.region,
  outputStorageCredentials: credentials,
  outputStorageRegion: BACKENDS.region,
};
const storage = createCheckpointStorageProvider(config);
const remote = (bucket: string, path = '') =>
  `${BACKENDS.remote}:${bucket}/${path}`;
let rclone: string;
let local: string;

const grantsFor = async (jobId: string, signer: CloudConfig = config) => {
  const started = Date.now();
  const resolved = await resolveWorkloadStorage(signer, jobId);
  const resolvedAt = Date.now();
  const grants = await mintPoolJobGrants(resolved);
  // Timing only: where a slow mint spends its time.
  console.log(
    `resolve ${resolvedAt - started} ms, mint ${Date.now() - resolvedAt} ms`,
  );
  return { input: grants.input!, output: grants.output! };
};

/**
 * One attempt of a pool Job through the runner's own `runJob`: grants
 * minted as the API mints them, the real `rcloneCopy`, a claim API that
 * records the reports, and `/mnt/<role>` in a temporary directory. `command`
 * stands in for the Job's command, with those directories.
 */
async function runPoolJob(
  jobId: string,
  buckets: {
    inputBucket?: string;
    outputBucket?: string;
    checkpointBucket?: string;
  },
  command: (mnt: (role: string) => string) => number | Promise<number>,
  reports: WorkloadRunnerReport[] = [],
  logs: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), `pool-job-${jobId}-`));
  const mnt = (role: string) => join(root, role);
  for (const role of ['input', 'output', 'checkpoint']) mkdirSync(mnt(role));
  const local = (path: string) => path.replace(/^\/mnt\//u, `${root}/`);
  const storageGrants = await mintPoolJobGrants(
    await resolveWorkloadStorage({ ...config, ...buckets }, jobId),
  );
  const spec: WorkloadExecution = {
    command: ['job'],
    env: {},
    timeLimitSeconds: null,
    storage: storageGrants,
  };
  // The runner's rclone reads the CA bundle the image ships beside it.
  const bundle = join(dirname(rclone), 'ca-certificates.crt');
  if (!existsSync(bundle)) copyFileSync(SYSTEM_CA_BUNDLE, bundle);
  const copy = rcloneCopy(rclone);
  const ports: RunnerPorts = {
    api: {
      candidate: () => Promise.resolve(null),
      claim: () => Promise.resolve(true),
      execution: () => Promise.resolve(spec),
      report: (_job, report) => {
        reports.push(report);
        return Promise.resolve();
      },
      cancelled: (_job, _execution, signal) =>
        new Promise<boolean>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('ended'))),
        ),
      cleanup: () => Promise.resolve(),
    },
    copy: (from, to, grantEnv, sync) =>
      copy(local(from), local(to), grantEnv, sync),
    entrypoint: [],
    cmd: [],
    stopGraceMs: 1_000,
    start: async () => command(mnt),
    killAll: () => {},
    oomKills: () => Promise.resolve(0),
    reset: async () => {},
    empty: (dir) => empty(local(dir)),
    log: (message) => {
      logs.push(message);
      console.log(message);
    },
  };
  await runJob(
    ports,
    jobId,
    randomBytes(8).toString('hex'),
    new AbortController().signal,
  );
  const ended = reports.at(-1);
  return { cause: ended && 'cause' in ended ? ended.cause : undefined };
}

/** Every object's name in a bucket, through the account's own credential. */
async function objectNames(bucket: string): Promise<string[]> {
  if (!canListObjects(storage)) throw new Error('storage cannot list');
  const page = await storage.listObjects(bucket, {
    prefix: '',
    recursive: true,
    pageSize: 1000,
  });
  return page.entries
    .filter((entry) => entry.kind === 'object')
    .map((entry) => entry.key)
    .sort();
}

/** A blob request made with a grant's own SAS, outside rclone's scoping. */
async function blobStatus(
  grantEnv: Record<string, string>,
  path: string,
  method = 'GET',
) {
  const sasUrl = new URL(grantEnv.RCLONE_CONFIG_AZUREBLOB_SAS_URL);
  const url = `${sasUrl.origin}/${path}${sasUrl.search}`;
  const response = await fetch(url, {
    method,
    headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-08-06' },
    body: method === 'PUT' ? 'x' : undefined,
  });
  return response.status;
}

/** One rclone call with only the grant's env; a refusal fails fast. */
function rcloneWith(grantEnv: Record<string, string>, ...args: string[]) {
  const started = Date.now();
  const result = spawnSync(
    rclone,
    [...args, '--retries', '1', '--low-level-retries', '1'],
    {
      env: { PATH: process.env.PATH, ...grantEnv },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  // Timing only: the args name test containers, never credentials.
  console.log(
    `rclone ${args[0]}: exit ${result.status} in ${Date.now() - started} ms`,
  );
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    // Refused by the backend, not by a timeout or a missing binary.
    denied:
      result.status !== 0 &&
      /AuthorizationPermissionMismatch|AuthorizationFailure|AuthorizationResourceTypeMismatch|AccessDenied|\b403\b/.test(
        result.stderr,
      ),
  };
}

/**
 * Whether a grant reads and writes nothing in another bucket. An Azure SAS
 * URL names its container, which rclone can't leave, so Azure is asked
 * directly; S3 and GCS remotes name any bucket.
 */
async function refusedIn(grantEnv: Record<string, string>, bucket: string) {
  if (cloud === 'azure') {
    return (
      (await blobStatus(grantEnv, `${bucket}/shard-0`)) === 403 &&
      (await blobStatus(grantEnv, `${bucket}/job-a/x`, 'PUT')) === 403
    );
  }
  return (
    rcloneWith(grantEnv, 'cat', remote(bucket, 'shard-0')).denied &&
    rcloneWith(grantEnv, 'copy', `${local}/output`, remote(bucket, 'job-a/'))
      .denied
  );
}

/** An S3 grant minted at the start, to lapse by S19 (RFC 0043 § Decided, 6). */
let lapsing: { env: Record<string, string>; expiresAt: number } | undefined;

describe(`pool Job credentials on real ${cloud} storage`, () => {
  beforeAll(async () => {
    if (cloud === 'azure') {
      await requireAzureAuthentication({
        tenantId: env('AZURE_TENANT_ID'),
        clientId: env('AZURE_CLIENT_ID'),
        clientSecret: env('AZURE_CLIENT_SECRET'),
      });
    }
    rclone = await pinnedRclone();
    for (const bucket of [input, output, checkpoint, gone, recreated]) {
      // The CI sweep reclaims a test user's buckets that a cancelled run leaves.
      await storage.upsertBucket(bucket, 'test', `st1b-${run}`, owner);
    }
    const shard = Buffer.from('shard');
    await storage.uploadObject(input, 'shard-0', {
      kind: 'buffer',
      bytes: shard,
      contentLength: shard.length,
    });
    local = mkdtempSync(join(tmpdir(), 'pool-job-storage-'));
    mkdirSync(join(local, 'output'));
    writeFileSync(join(local, 'output', 'result.txt'), 'result');
    // Outputs and checkpoints nest below the Job prefix.
    mkdirSync(join(local, 'output', 'step-100'));
    writeFileSync(join(local, 'output', 'step-100', 'model.pt'), 'model');
    if (cloud === 'aws' && canMintScopedStorageToken(storage)) {
      const token = (await storage.mintScopedStorageToken(
        [{ bucket: input, mode: 'read' }],
        { lifetimeMs: 900_000 },
      ))!;
      lapsing = {
        env: rcloneGrantRemote({
          name: input,
          cloudType: CloudType.AWS,
          region: BACKENDS.region,
          credentials: token.credentials,
        }).env,
        expiresAt: token.expiresAt,
      };
    }
  }, 300_000);

  afterAll(async () => {
    for (const bucket of [
      input,
      output,
      checkpoint,
      gone,
      recreated,
      managed,
    ]) {
      await storage.deleteBucket(bucket).catch(() => {});
    }
  }, 300_000);

  it('0043/S3 0043/S18 reads the input and writes the Job prefix, and nothing else, deleting only where GCS overwrites', async () => {
    const a = await grantsFor('job-a');

    // Input: the whole bucket, read and list, never write.
    expect(
      rcloneWith(a.input.env, 'copy', a.input.remote, `${local}/input`).ok,
    ).toBe(true);
    expect(readFileSync(join(local, 'input', 'shard-0'), 'utf8')).toBe('shard');
    expect(
      rcloneWith(a.input.env, 'copy', `${local}/output`, a.input.remote).denied,
    ).toBe(true);

    // Output: create, overwrite, read and list inside the Job's prefix.
    for (let i = 0; i < 2; i++) {
      writeFileSync(join(local, 'output', 'result.txt'), `result ${i}`);
      expect(
        rcloneWith(a.output.env, 'copy', `${local}/output`, a.output.remote).ok,
      ).toBe(true);
    }
    // Listing order isn't promised; the set is.
    expect(
      rcloneWith(a.output.env, 'lsf', '-R', a.output.remote)
        .stdout.split('\n')
        .filter(Boolean)
        .sort(),
    ).toEqual(['result.txt', 'step-100/', 'step-100/model.pt']);
    expect(
      rcloneWith(a.output.env, 'cat', `${a.output.remote}result.txt`).stdout,
    ).toBe('result 1');
    expect(
      rcloneWith(a.output.env, 'cat', `${a.output.remote}step-100/model.pt`)
        .stdout,
    ).toBe('model');

    // No read, write or list in Job B's prefix, nor delete there; no read or
    // write in another bucket.
    const other = remote(output, 'job-b/');
    const bytes = Buffer.from('b');
    await storage.uploadObject(output, 'job-b/x', {
      kind: 'buffer',
      bytes,
      contentLength: bytes.length,
    });
    expect(
      rcloneWith(a.output.env, 'copy', `${local}/output`, other).denied,
    ).toBe(true);
    expect(rcloneWith(a.output.env, 'lsf', other).denied).toBe(true);
    expect(rcloneWith(a.output.env, 'cat', `${other}x`).denied).toBe(true);
    // S3 and GCS stat first, and rclone calls a refused stat not found.
    expect(rcloneWith(a.output.env, 'deletefile', `${other}x`).ok).toBe(false);
    expect(await objectNames(output)).toContain('job-b/x');
    expect(await refusedIn(a.output.env, input)).toBe(true);
    // Delete inside its own prefix: refused on Azure and S3, which overwrite
    // without it; allowed on GCS, which can't (`noDelete`).
    const deleted = rcloneWith(
      a.output.env,
      'deletefile',
      `${a.output.remote}result.txt`,
    );
    expect(cloud === 'gcp' ? deleted.ok : deleted.denied).toBe(true);

    // Signed by an explicit storage credential, the grant is as narrow.
    const signed = await grantsFor('job-a', explicit);
    expect(
      rcloneWith(signed.output.env, 'copy', `${local}/output`, a.output.remote)
        .ok,
    ).toBe(true);
    expect(rcloneWith(signed.output.env, 'lsf', other).denied).toBe(true);

    // rclone needs read and list beside create and write: an Azure upload
    // with `cw` fails.
    if (cloud === 'azure') {
      const azure = new Azure(config);
      const key = await (
        azure as unknown as { accountKey(): Promise<string> }
      ).accountKey();
      const now = Date.now();
      const sas = azureDirectorySas(
        azure.storageAccountName,
        key,
        output,
        'job-a/',
        {
          permissions: 'cw',
          startsOn: new Date(now - 300_000),
          expiresOn: new Date(now + 3_600_000),
        },
      );
      const cw = {
        ...a.output.env,
        RCLONE_CONFIG_AZUREBLOB_SAS_URL: `https://${azure.storageAccountName}.blob.core.windows.net/${output}?${sas}`,
      };
      expect(
        rcloneWith(cw, 'copy', `${local}/output`, a.output.remote).denied,
      ).toBe(true);
    }
  }, 300_000);

  it('0043/S1 0043/S17 stages the input and uploads output and checkpoints under the Job prefix only, and 0043/S2 restores the checkpoint on the next attempt', async () => {
    const jobId = `job-s1-${run}`;
    const first = await runPoolJob(
      jobId,
      { inputBucket: input, checkpointBucket: checkpoint },
      (mnt) => {
        const staged = readFileSync(join(mnt('input'), 'shard-0'), 'utf8');
        writeFileSync(join(mnt('output'), 'result.txt'), `staged ${staged}`);
        writeFileSync(join(mnt('checkpoint'), 'step.txt'), 'step 1');
        return 0;
      },
    );
    expect(first.cause).toEqual({ kind: 'exit', code: 0, oom: false });
    expect(
      (await objectNames(output)).filter((key) => key.startsWith(jobId)),
    ).toEqual([`${jobId}/result.txt`]);
    expect(await objectNames(checkpoint)).toEqual([`${jobId}/step.txt`]);
    expect(await objectNames(input)).toEqual(['shard-0']);

    // S2: a retry of the Job, as after a lost replica, starts from the
    // checkpoint its first attempt uploaded.
    const retry = await runPoolJob(
      jobId,
      { inputBucket: input, checkpointBucket: checkpoint },
      (mnt) =>
        readFileSync(join(mnt('checkpoint'), 'step.txt'), 'utf8') === 'step 1'
          ? 0
          : 9,
    );
    expect(retry.cause).toEqual({ kind: 'exit', code: 0, oom: false });
  }, 600_000);

  it('0043/S7 an input bucket deleted after admission ends the Job invalid, without running it', async () => {
    let ran = false;
    const jobId = `job-s7-${run}`;
    await storage.deleteBucket(gone);
    // Azure deletes a container in the background; until then a read is
    // `ContainerBeingDeleted`, not missing.
    await vi.waitFor(
      async () => expect(await storage.hasBucket(gone)).toBe(false),
      { timeout: 180_000, interval: 5_000 },
    );
    const { cause } = await runPoolJob(jobId, { inputBucket: gone }, () => {
      ran = true;
      return 0;
    });
    expect(ran).toBe(false);
    expect(cause?.kind).toBe('unrecoverable');
    expect(cause && 'detail' in cause ? cause.detail : '').toContain(
      'Could not stage the input bucket',
    );
    expect(attemptEndOf(batchPolicy({ resumable: false }), cause!).state).toBe(
      WorkloadState.Invalid,
    );
  }, 600_000);

  it("0043/S10 checkpoint health counts only the Job's own prefix", async () => {
    const jobId = `job-s10-${run}`;
    for (const key of [`${jobId}/a.pt`, `${jobId}/b.pt`, 'other-job/c.pt']) {
      const bytes = Buffer.from(key);
      await storage.uploadObject(checkpoint, key, {
        kind: 'buffer',
        bytes,
        contentLength: bytes.length,
      });
    }
    const health = await readWorkloadCheckpointHealth(
      { ...config, checkpointBucket: checkpoint },
      jobId,
      `${jobId}/`,
    );
    expect(health).toMatchObject({ objects: 2, truncated: false });
    expect(health.bytes).toBe(`${jobId}/a.pt`.length + `${jobId}/b.pt`.length);
  }, 300_000);

  it('0044/S20 an output bucket missing at the end keeps the Job finalizing, and it completes once the bucket is recreated', async () => {
    const jobId = `job-s20-${run}`;
    const reports: WorkloadRunnerReport[] = [];
    const logs: string[] = [];
    let settled = false;
    const attempt = runPoolJob(
      jobId,
      { outputBucket: recreated },
      async (mnt) => {
        writeFileSync(join(mnt('output'), 'result.txt'), 'result');
        await storage.deleteBucket(recreated);
        await vi.waitFor(
          async () => expect(await storage.hasBucket(recreated)).toBe(false),
          { timeout: 180_000, interval: 5_000 },
        );
        return 0;
      },
      reports,
      logs,
    ).finally(() => {
      settled = true;
    });
    // The final upload fails, and is retried, while the bucket is gone.
    await vi.waitFor(
      () =>
        expect(
          logs.filter((l) => l.startsWith('Uploading output failed')).length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 420_000, interval: 1_000 },
    );
    expect(reports.map((r) => 'phase' in r && r.phase)).toContain('finalizing');
    // Still finalizing: no outcome, and the runner holds the Job, so its
    // replica claims nothing else.
    expect(settled).toBe(false);
    expect(reports.some((r) => 'cause' in r)).toBe(false);
    // Azure, S3 and GCS each refuse a name they are still deleting.
    await vi.waitFor(
      () => storage.upsertBucket(recreated, 'test', `st1b-${run}`, owner),
      { timeout: 180_000, interval: 10_000 },
    );
    const { cause } = await attempt;
    expect(cause).toEqual({ kind: 'exit', code: 0, oom: false });
    expect(await objectNames(recreated)).toEqual([`${jobId}/result.txt`]);
  }, 900_000);

  it('0043/S22 reuses a managed bucket name the account holds, and refuses one another owner holds, in any region', async () => {
    const create = (name: string, region = BACKENDS.region) =>
      createCheckpointStorageProvider({ ...config, region }).createOwnedBucket(
        name,
        'test',
        `st1b-${run}`,
        owner,
      );
    await expect(create(input)).resolves.toBe(BACKENDS.region);
    // Azure containers live in the account, so no other owner holds one.
    if (cloud === 'azure') return;
    // `test` has been taken on S3 and GCS since their first days.
    await expect(create('test')).rejects.toBeInstanceOf(BucketNameTakenError);
    if (cloud === 'aws') {
      await expect(create('test', 'us-west-2')).rejects.toBeInstanceOf(
        BucketNameTakenError,
      );
      // Ours, created in another region, is reused where it is.
      await expect(create(input, 'us-west-2')).resolves.toBe(BACKENDS.region);
    } else {
      // A new managed GCS bucket keeps no soft-deleted checkpoints.
      await create(managed);
      const [metadata] = await new Storage({
        projectId: env('GCP_PROJECT_ID'),
        credentials: {
          client_email: env('GCP_CLIENT_EMAIL'),
          private_key: env('GCP_PRIVATE_KEY'),
        },
      })
        .bucket(managed)
        .getMetadata();
      expect(Number(metadata.softDeletePolicy?.retentionDurationSeconds)).toBe(
        0,
      );
    }
  }, 300_000);

  // Last, so the S3 token minted at the start has lapsed (S19).
  it('0043/S4 a renewal returns credentials that work, and 0043/S19 a stage whose S3 or GCS grant lapsed fails, never denied, and the retry with the held grant completes', async () => {
    // Each mint lasts its full lifetime from now (a GCS token 1 h, the rest
    // 36 h); two mints' expiries can differ by a second either way.
    const renewed = await grantsFor('job-a');
    expect(renewed.output.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
    writeFileSync(join(local, 'output', 'renewed.txt'), 'renewed');
    expect(
      rcloneWith(
        renewed.output.env,
        'copy',
        `${local}/output`,
        renewed.output.remote,
      ).ok,
    ).toBe(true);
    expect(
      rcloneWith(
        renewed.output.env,
        'cat',
        `${renewed.output.remote}renewed.txt`,
      ).stdout,
    ).toBe('renewed');

    // An Azure SAS lasts 36 h and is renewed at half of it.
    if (cloud === 'azure') return;
    let lapsed: Record<string, string>;
    if (cloud === 'aws') {
      // A real 900 s federation token: S3 answers ExpiredToken.
      await sleep(Math.max(0, lapsing!.expiresAt + 5_000 - Date.now()));
      lapsed = lapsing!.env;
    } else {
      // rclone checks a GCS token's expiry locally, as at an hour's lapse.
      const token = JSON.parse(
        renewed.input.env.RCLONE_CONFIG_GCS_TOKEN,
      ) as object;
      lapsed = {
        ...renewed.input.env,
        RCLONE_CONFIG_GCS_TOKEN: JSON.stringify({
          ...token,
          expiry: new Date(Date.now() - 60_000).toISOString(),
        }),
      };
    }
    const copy = rcloneCopy(rclone);
    const target = mkdtempSync(join(tmpdir(), 'pool-job-s19-'));
    const stage = await copy(renewed.input.remote, target, lapsed, true);
    expect(stage.result).toBe('failed');
    await expect(
      copy(renewed.input.remote, target, renewed.input.env, true),
    ).resolves.toMatchObject({ result: 'done' });
    expect(readFileSync(join(target, 'shard-0'), 'utf8')).toBe('shard');
  }, 1_200_000);
});
