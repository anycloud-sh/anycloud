#!/usr/bin/env tsx
/**
 * Live check for CF2: the product's R2 storage, minter and rclone
 * wiring against real R2, with no VM. It builds storage the way the API does
 * (createStorageProvider), mints the credentials a Job's VM receives, and
 * runs the exact rclone config, environment and commands the VM runs.
 *
 * `run` creates buckets named `anycloud-r2-jobs-<run>-*` and deletes them at
 * the end; `cleanup` deletes every bucket with the `anycloud-r2-jobs-` prefix
 * in both jurisdictions. Reports go to SPIKE_OUTPUT_DIR without token or key
 * material.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageProvider } from '../../src/api/services/cloud-config.js';
import {
  canMintScopedStorageToken,
  type CloudStorage,
} from '../../src/api/services/gateways/cloud.js';
import {
  getRemotePath,
  RCLONE_CONF_TEMPLATE,
  rcloneCopyCommand,
  rcloneEnvVars,
  rcloneInputSyncCommand,
  type BucketConfig,
} from '../../src/api/services/rclone-config.js';
import {
  RCLONE_VERSION,
  RUNTIME_ARTIFACTS_BY_HOST_ARCH,
  rcloneArchiveDirectory,
} from '../../src/api/runtime-artifacts.js';
import {
  CloudType,
  type CloudflareJurisdiction,
} from '../../src/shared/cloud.js';
import { CLOUDFLARE_API } from '../../src/shared/cloudflare-token.js';
import { ObjectNotFoundError } from '../../src/shared/errors.js';

// The account that serves anycloud.sh, from the CLOUDFLARE_ACCOUNT_ID variable.
function cloudflareAccountId(): string {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  return id;
}
const PREFIX = 'anycloud-r2-jobs-';
const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';

interface Check {
  check: string;
  expected: string;
  ok: boolean;
  observed: unknown;
}
const checks: Check[] = [];

function errorShape(error: unknown): Record<string, unknown> {
  const e = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
    message?: string;
  };
  return {
    name: e.name,
    code: e.Code,
    status: e.$metadata?.httpStatusCode,
    message: e.message?.slice(0, 300),
  };
}

async function expectOp(
  check: string,
  shouldSucceed: boolean,
  fn: () => Promise<unknown> | unknown,
): Promise<boolean> {
  try {
    await fn();
    checks.push({
      check,
      expected: shouldSucceed ? 'succeeds' : 'fails',
      ok: shouldSucceed,
      observed: 'succeeded',
    });
    return true;
  } catch (error) {
    checks.push({
      check,
      expected: shouldSucceed ? 'succeeds' : 'fails',
      ok: !shouldSucceed,
      observed: errorShape(error),
    });
    return false;
  }
}

function observe(check: string, observed: unknown) {
  checks.push({ check, expected: 'observe', ok: true, observed });
}

function r2(
  token: string,
  jurisdiction?: CloudflareJurisdiction,
  accountId = cloudflareAccountId(),
): CloudStorage {
  return createStorageProvider({
    cloudProvider: CloudType.Cloudflare,
    credentials: {
      accountId,
      apiToken: token,
      ...(jurisdiction ? { jurisdiction } : {}),
    },
  });
}

async function text(storage: CloudStorage, bucket: string, key: string) {
  const { stream } = await storage.downloadObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function upload(
  storage: CloudStorage,
  bucket: string,
  key: string,
  body: string,
) {
  const bytes = Buffer.from(body);
  return storage.uploadObject(bucket, key, {
    kind: 'buffer',
    bytes,
    contentLength: bytes.length,
  });
}

async function installRclone(): Promise<string> {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const artifact = RUNTIME_ARTIFACTS_BY_HOST_ARCH[arch].rclone;
  const dir = mkdtempSync(join(tmpdir(), 'rclone-'));
  const zip = join(dir, 'rclone.zip');
  const response = await fetch(artifact.url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`rclone download: ${response.status}`);
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  if (
    createHash('sha256').update(readFileSync(zip)).digest('hex') !==
    artifact.sha256
  ) {
    throw new Error('rclone archive digest mismatch');
  }
  try {
    execFileSync('unzip', ['-q', zip, '-d', dir]);
  } catch {
    execFileSync('python3', ['-m', 'zipfile', '-e', zip, dir]);
  }
  const binary = join(
    dir,
    rcloneArchiveDirectory(arch === 'aarch64' ? 'arm64' : 'amd64'),
    'rclone',
  );
  execFileSync('chmod', ['+x', binary]);
  return binary;
}

/** Run a VM's rclone command line with the VM's config and per-bucket env. */
function runOnVmShape(binary: string, config: BucketConfig, command: string) {
  const confDir = mkdtempSync(join(tmpdir(), 'rclone-conf-'));
  const conf = join(confDir, 'rclone.conf');
  writeFileSync(conf, RCLONE_CONF_TEMPLATE);
  try {
    execFileSync('bash', ['-c', command], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RCLONE_CONFIG: conf,
        ...rcloneEnvVars(config),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw Object.assign(
      new Error(
        stderr.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400),
      ),
      { name: 'RcloneError' },
    );
  }
}

async function minted(
  storage: CloudStorage,
  bucket: string,
  mode: 'read' | 'readwrite',
): Promise<BucketConfig> {
  if (!canMintScopedStorageToken(storage))
    throw new Error('R2 storage does not mint');
  const token = await storage.mintScopedStorageToken([{ bucket, mode }]);
  // The same fields bucketConfigForRole copies (vm-runtime-storage.ts).
  return {
    name: bucket,
    cloudType: storage.type,
    region: storage.region,
    endpoint: storage.s3Endpoint,
    credentials: token?.credentials,
    credentialExpiresAt: token?.expiresAt,
  };
}

async function listOwned(
  token: string,
  jurisdiction: CloudflareJurisdiction,
): Promise<string[]> {
  const response = await fetch(
    `${CLOUDFLARE_API}/accounts/${cloudflareAccountId()}/r2/buckets?name_contains=${PREFIX}&per_page=1000`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(jurisdiction === 'default'
          ? {}
          : { 'cf-r2-jurisdiction': jurisdiction }),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = (await response.json()) as {
    success?: boolean;
    result?: { buckets?: Array<{ name: string }> };
  };
  if (!response.ok || !body.success)
    throw new Error(
      `List buckets (${jurisdiction}) failed: HTTP ${response.status}`,
    );
  return (body.result?.buckets ?? [])
    .map((b) => b.name)
    .filter((name) => name.startsWith(PREFIX));
}

/** Delete every owned bucket through the product's own deleteBucket. */
async function cleanup(token: string): Promise<Record<string, string[]>> {
  const remaining: Record<string, string[]> = {};
  for (const jurisdiction of ['default', 'eu'] as const) {
    const storage = r2(
      token,
      jurisdiction === 'default' ? undefined : jurisdiction,
    );
    for (const bucket of await listOwned(token, jurisdiction)) {
      if (!bucket.startsWith(PREFIX))
        throw new Error(`Refusing to delete ${bucket}`);
      await storage
        .deleteBucket(bucket)
        .catch((error: unknown) =>
          console.error(
            `Cleanup of ${bucket} (${jurisdiction}): ${error instanceof Error ? error.message : 'failed'}`,
          ),
        );
    }
    remaining[jurisdiction] = await listOwned(token, jurisdiction);
  }
  return remaining;
}

function writeReport(name: string, report: unknown) {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, name), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function run(token: string) {
  const id = `${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const input = `${PREFIX}${id}-in`;
  const out = `${PREFIX}${id}-out`;
  const eu = `${PREFIX}${id}-eu`;
  writeReport('inventory.json', {
    buckets: [input, out, eu],
    cleanup: 'run.ts cleanup deletes every bucket with the prefix',
  });
  const storage = r2(token);

  // Bucket commands and the API's own storage calls.
  await expectOp(
    'upsert creates a bucket, and again is a no-op',
    true,
    async () => {
      await storage.upsertBucket(input, 'live', 'cf2-live', 'cf2-live');
      await storage.upsertBucket(input, 'live', 'cf2-live', 'cf2-live');
      await storage.upsertBucket(out, 'live', 'cf2-live', 'cf2-live');
    },
  );
  await expectOp('hasBucket sees it', true, async () => {
    if (!(await storage.hasBucket(input))) throw new Error('missing');
  });
  await expectOp(
    'upload, download, list and delete an object',
    true,
    async () => {
      await upload(storage, input, 'data/input.txt', 'job input');
      if ((await text(storage, input, 'data/input.txt')) !== 'job input')
        throw new Error('content mismatch');
      const lister = storage as unknown as {
        listObjects(b: string, o: object): Promise<{ entries: unknown[] }>;
      };
      const page = await lister.listObjects(input, {
        prefix: 'data/',
        recursive: true,
        pageSize: 100,
      });
      if (page.entries.length !== 1)
        throw new Error(`listed ${page.entries.length}`);
      await upload(storage, input, 'data/extra.txt', 'x');
      await storage.deleteObject(input, 'data/extra.txt');
    },
  );
  await expectOp(
    'a missing object downloads as ObjectNotFoundError',
    true,
    async () => {
      const error = await text(storage, input, 'absent.txt').then(
        () => undefined,
        (e: unknown) => e,
      );
      if (!(error instanceof ObjectNotFoundError))
        throw new Error(`got ${JSON.stringify(errorShape(error))}`);
    },
  );

  // EU jurisdiction through the product path.
  const euStorage = r2(token, 'eu');
  await expectOp(
    'EU: upsert creates the bucket in the EU jurisdiction',
    true,
    async () => {
      await euStorage.upsertBucket(eu, 'live', 'cf2-live', 'cf2-live');
      if (!(await euStorage.hasBucket(eu)))
        throw new Error('missing on the EU endpoint');
    },
  );
  // What a Job's VM gets: minted credentials and the VM's rclone commands.
  const binary = await installRclone();
  const local = mkdtempSync(join(tmpdir(), 'r2-job-'));
  const inputConfig = await minted(storage, input, 'read');
  const outputConfig = await minted(storage, out, 'readwrite');
  observe('minted credential shape', {
    cloudType: inputConfig.cloudType,
    endpointSet: Boolean(inputConfig.endpoint),
    credentialProvider: inputConfig.credentials?.cloudProvider,
    hasSessionToken: Boolean(
      (inputConfig.credentials as { sessionToken?: string } | undefined)
        ?.sessionToken,
    ),
    expiresInHours: inputConfig.credentialExpiresAt
      ? Math.round((inputConfig.credentialExpiresAt - Date.now()) / 3_600_000)
      : null,
  });
  await expectOp(
    `rclone ${RCLONE_VERSION}: input hydration with read-only credentials`,
    true,
    () => {
      runOnVmShape(
        binary,
        inputConfig,
        rcloneInputSyncCommand(
          getRemotePath(input, CloudType.Cloudflare),
          join(local, 'input'),
          binary,
        ).replace('--retries 30 --retries-sleep 15s', '--retries 1'),
      );
      if (
        readFileSync(join(local, 'input', 'data', 'input.txt'), 'utf8') !==
        'job input'
      )
        throw new Error('not hydrated');
    },
  );
  mkdirSync(join(local, 'output'), { recursive: true });
  writeFileSync(join(local, 'output', 'result.txt'), 'job output');
  await expectOp(
    `rclone ${RCLONE_VERSION}: output sync with read-write credentials`,
    true,
    async () => {
      runOnVmShape(
        binary,
        outputConfig,
        rcloneCopyCommand(
          getRemotePath(out, CloudType.Cloudflare),
          join(local, 'output'),
          binary,
        ),
      );
      if ((await text(storage, out, 'result.txt')) !== 'job output')
        throw new Error('not uploaded');
    },
  );
  await expectOp(
    `rclone ${RCLONE_VERSION}: read-only credentials cannot write the input bucket`,
    false,
    () =>
      runOnVmShape(
        binary,
        inputConfig,
        rcloneCopyCommand(
          getRemotePath(input, CloudType.Cloudflare),
          join(local, 'output'),
          binary,
        ),
      ),
  );
  await expectOp(
    `rclone ${RCLONE_VERSION}: output credentials cannot reach the input bucket`,
    false,
    () =>
      runOnVmShape(
        binary,
        outputConfig,
        rcloneCopyCommand(
          getRemotePath(input, CloudType.Cloudflare),
          join(local, 'output'),
          binary,
        ),
      ),
  );
  await expectOp(
    'EU: minted credentials sync through the EU endpoint',
    true,
    async () => {
      await upload(euStorage, eu, 'eu.txt', 'eu data');
      const euConfig = await minted(euStorage, eu, 'read');
      runOnVmShape(
        binary,
        euConfig,
        rcloneInputSyncCommand(
          getRemotePath(eu, CloudType.Cloudflare),
          join(local, 'eu'),
          binary,
        ).replace('--retries 30 --retries-sleep 15s', '--retries 1'),
      );
      if (!existsSync(join(local, 'eu', 'eu.txt')))
        throw new Error('not hydrated');
    },
  );

  // Checkpoints: the output sync command under the Job's prefix, then the
  // restore a replacement VM runs after a preemption (input sync).
  const checkpointConfig = await minted(storage, out, 'readwrite');
  mkdirSync(join(local, 'ckpt'), { recursive: true });
  writeFileSync(join(local, 'ckpt', 'step-1.bin'), 'checkpoint 1');
  await expectOp(
    `rclone ${RCLONE_VERSION}: checkpoint sync and restore after preemption`,
    true,
    () => {
      const remote = `${getRemotePath(out, CloudType.Cloudflare)}/job-1`;
      runOnVmShape(
        binary,
        checkpointConfig,
        rcloneCopyCommand(remote, join(local, 'ckpt'), binary),
      );
      runOnVmShape(
        binary,
        checkpointConfig,
        rcloneInputSyncCommand(remote, join(local, 'restored'), binary).replace(
          '--retries 30 --retries-sleep 15s',
          '--retries 1',
        ),
      );
      if (
        readFileSync(join(local, 'restored', 'step-1.bin'), 'utf8') !==
        'checkpoint 1'
      )
        throw new Error('not restored');
    },
  );

  // Only after the EU sync: reusing the name could otherwise mask whether the
  // jurisdiction header mattered.
  observe(
    'EU: the default endpoint sees the EU bucket name',
    await storage.hasBucket(eu).catch((e: unknown) => errorShape(e)),
  );
  observe(
    'reusing the EU bucket name in the default jurisdiction',
    await storage.upsertBucket(eu, 'live', 'cf2-live', 'cf2-live').then(
      async () => ({ created: true, defaultSees: await storage.hasBucket(eu) }),
      (e: unknown) => errorShape(e),
    ),
  );

  // A user token with a mistyped account ID (CF1 review finding 3): what
  // bucket access and minting report.
  const wrongAccount = r2(token, undefined, 'ffffffffffffffffffffffffffffffff');
  observe(
    'missing bucket on the right account: what minting reports',
    await minted(storage, `${PREFIX}${id}-absent`, 'read').then(
      () => ({ minted: true }),
      (e: unknown) => errorShape(e),
    ),
  );
  observe(
    'wrong account ID: what minting reports',
    await minted(wrongAccount, input, 'read').then(
      () => ({ minted: true }),
      (e: unknown) => errorShape(e),
    ),
  );
  observe(
    'wrong account ID: what hasBucket reports',
    await wrongAccount.hasBucket(input).then(
      (exists) => ({ exists }),
      (e: unknown) => errorShape(e),
    ),
  );
}

async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if ((command !== 'run' && command !== 'cleanup') || extra.length)
    throw new Error('Usage: run.ts run | run.ts cleanup');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');

  if (command === 'cleanup') {
    const remaining = await cleanup(token);
    writeReport('cleanup-report.json', { remaining });
    console.log(`Remaining buckets: ${JSON.stringify(remaining)}`);
    if (Object.values(remaining).some((names) => names.length))
      process.exitCode = 1;
    return;
  }
  try {
    await run(token);
  } finally {
    const remaining = await cleanup(token).catch((e: unknown) => ({
      error: errorShape(e),
    }));
    checks.push({
      check: 'every bucket deleted at the end of run',
      expected: 'none remain',
      ok: JSON.stringify(remaining) === JSON.stringify({ default: [], eu: [] }),
      observed: remaining,
    });
    writeReport('run-report.json', {
      experiment: 'cloudflare-r2-jobs',
      rclone: RCLONE_VERSION,
      checks,
    });
    for (const c of checks)
      console.log(
        `${c.ok ? 'PASS' : 'FAIL'}  ${c.check}  [expected ${c.expected}]  ${JSON.stringify(c.observed)}`,
      );
  }
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Run failed');
  process.exitCode = 1;
});
