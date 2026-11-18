#!/usr/bin/env tsx
/** The transfer matrix between our storage and candidate clouds; see README.md. */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CreateBucketCommand,
  PutBucketTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import {
  canMintScopedStorageToken,
  type CloudStorage,
} from '../../src/api/services/gateways/cloud.js';
import {
  azureContainerSas,
  azureDirectorySas,
} from '../../src/api/services/provider-clients/azure.js';
import {
  getRemotePath,
  RCLONE_CONF_TEMPLATE,
  rcloneEnvVars,
  rcloneTokenConfig,
  type BucketConfig,
} from '../../src/api/services/rclone-config.js';
import {
  RCLONE_VERSION,
  RUNTIME_ARTIFACTS_BY_HOST_ARCH,
  rcloneArchiveDirectory,
} from '../../src/api/runtime-artifacts.js';
import { CloudType } from '../../src/shared/cloud.js';
import {
  AWS_REGION,
  AZURE_REGION,
  azure,
  COMPUTES,
  type ComputeId,
  ensureAzureGroup,
  GCP_REGION,
  GCP_SECRETS,
  gcpOptions,
  name,
  productAws,
  productGcs,
  r2,
  redact,
  runId,
  STORAGES,
  type StorageId,
  TAG,
} from './clouds.js';

const output = process.env.SPIKE_OUTPUT_DIR ?? join(process.cwd(), 'evidence');
/** The Spike workflow allows 85 minutes; setup and seeding take about 10. */
const GUEST_DEADLINE_MIN = 65;
const REMINT_MS = 20 * 60_000;
const MiB = 2 ** 20;

/** The fixed data every (storage, compute) pair moves; see README.md. */
const SIZES = {
  inputFileMiB: 2048,
  inputShards: 1024,
  inputShardMiB: 2,
  checkpointFileMiB: 1024,
  checkpointShards: 1024,
  checkpointShardKiB: 1024,
};
const INPUT = {
  files: 1 + SIZES.inputShards,
  bytes: (SIZES.inputFileMiB + SIZES.inputShards * SIZES.inputShardMiB) * MiB,
};
const CHECKPOINT = {
  files: 1 + SIZES.checkpointShards,
  bytes:
    SIZES.checkpointFileMiB * MiB +
    SIZES.checkpointShards * SIZES.checkpointShardKiB * 1024,
};
/** RFC 0043 W1's input, in bytes. */
const W1_INPUT_BYTES = 527e9;

const STORAGE_IDS = Object.keys(STORAGES) as StorageId[];
const COMPUTE_IDS = Object.keys(COMPUTES) as ComputeId[];

function save(file: string, content: unknown): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, file),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
interface Options {
  compute: ComputeId[];
  storage: StorageId[];
  size: Partial<Record<ComputeId, string>>;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    compute: COMPUTE_IDS,
    storage: STORAGE_IDS,
    size: {},
  };
  const pick = <T extends string>(value: string, known: T[]) =>
    value.split(',').map((id) => {
      if (!known.includes(id as T)) {
        throw new Error(`Unknown target ${id}; expected ${known.join(', ')}`);
      }
      return id as T;
    });
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1] ?? ''];
    if (flag === '--compute') options.compute = pick(value, COMPUTE_IDS);
    else if (flag === '--storage') options.storage = pick(value, STORAGE_IDS);
    else if (flag === '--size' && value.includes('=')) {
      const [id, size] = value.split('=') as [string, string];
      options.size[pick(id, COMPUTE_IDS)[0]!] = size;
    } else {
      throw new Error(
        'Usage: run.ts [run|preflight] [--compute a,b] [--storage a,b] [--size <compute>=<type>]... | run.ts cleanup',
      );
    }
  }
  return options;
}

/**
 * Every selected target's credential, and Lambda, Nebius, Hyperstack and
 * Verda's read-only checks, before anything is created. A plain `run`
 * selects every target, so it refuses until those secrets exist.
 */
async function preflight(options: Options) {
  const missing = new Set(
    [
      ...GCP_SECRETS, // The evidence bucket.
      ...options.storage.flatMap((id) => STORAGES[id].secrets),
      ...options.compute.flatMap((id) => COMPUTES[id].secrets),
    ].filter((key) => !process.env[key]),
  );
  if (missing.size) {
    throw new Error(
      `Missing ${[...missing].join(', ')}. The Nebius, Hyperstack and Verda columns need their own secrets; run without them only by naming the others, for example ["run", "--compute", "aws,gcp,azure,lambda"].`,
    );
  }
  const checks: Record<string, unknown> = {};
  for (const id of options.compute) {
    const check = COMPUTES[id].preflight;
    if (check) checks[id] = await check(sizeOf(options, id));
  }
  // Cleanup's listings, read-only, so one that errors fails here first.
  for (const [id, cloud] of selected(options)) {
    for (const [kind, owned] of Object.entries(cloud.owned)) {
      checks[`${id}-${kind}`] = { listed: (await owned.list()).length };
    }
  }
  return checks;
}

/** The selected targets' records, keyed as cleanup reports them. */
const selected = (options: Options) => [
  ...options.storage.map((id) => [`${id}-storage`, STORAGES[id]] as const),
  ...options.compute.map((id) => [id, COMPUTES[id]] as const),
];

/**
 * Cleanup deletes only what it lists, so a launched resource its listing
 * can't see would keep billing after a green cleanup.
 */
async function unlisted(
  options: Options,
  launched: Partial<Record<ComputeId, { id?: string }>>,
) {
  const errors: string[] = [];
  for (const [id, cloud] of selected(options)) {
    const launch = launched[id as ComputeId];
    if (!(id.endsWith('-storage') || launch)) continue;
    for (const [kind, owned] of Object.entries(cloud.owned)) {
      const listed = await owned.list().catch((error: unknown) => {
        errors.push(
          `${id}: cleanup cannot list ${kind}: ${redact(String(error))}`,
        );
        return undefined;
      });
      const seen =
        kind === 'instances'
          ? listed?.includes(launch?.id ?? '')
          : listed?.length;
      if (listed && !seen) {
        errors.push(
          kind === 'instances'
            ? `${id}: cleanup cannot see ${launch?.id || 'its instance'}; delete it by the ID in launch.json`
            : `${id}: cleanup cannot see its ${kind}; check cleanup.json's removed, else delete the ${name}-named resources by hand`,
        );
      }
    }
  }
  return errors;
}

const sizeOf = (options: Options, id: ComputeId) =>
  options.size[id] ?? COMPUTES[id].size;

// ------------------------------------------------------------------ storage

interface Grant {
  remote: string;
  conf: string;
  env: Record<string, string>;
}
type Role = 'seed' | 'input' | 'checkpoint';
interface StorageHandle {
  /** The endpoint the guest times TCP connects to. */
  host: string;
  grant: (role: Role, compute?: ComputeId) => Promise<Grant>;
}

/** Inputs sit under `input/`, each worker's checkpoint under its own prefix. */
const pathFor = (role: Role, compute?: ComputeId) =>
  role === 'checkpoint' ? `checkpoint/${compute}/` : 'input';

/**
 * Grants as the product mints them for a bucket: its minter, its rclone
 * config and env. AWS, GCS and R2 minters scope a whole bucket so far.
 */
function productGrants(
  storage: CloudStorage,
  extra: Partial<BucketConfig>,
): StorageHandle['grant'] {
  if (!canMintScopedStorageToken(storage)) {
    throw new Error(`${storage.type} storage does not mint`);
  }
  return async (role, compute) => {
    const token = await storage.mintScopedStorageToken([
      { bucket: name, mode: role === 'input' ? 'read' : 'readwrite' },
    ]);
    const config: BucketConfig = {
      name,
      cloudType: storage.type,
      ...extra,
      credentials: token!.credentials,
      credentialExpiresAt: token!.expiresAt,
    };
    return {
      remote: `${getRemotePath(name, storage.type)}/${pathFor(role, compute)}`,
      conf: rcloneTokenConfig(config) ?? RCLONE_CONF_TEMPLATE,
      env: rcloneEnvVars(config),
    };
  };
}

const CREATE_STORAGE: Record<StorageId, () => Promise<StorageHandle>> = {
  // Pool Job grants as mintPoolJobGrants signs them: the input container
  // read-only, the checkpoint prefix create and write without delete.
  azure: async () => {
    const { storage } = azure();
    await ensureAzureGroup();
    const account = `acspikexfer${runId}`.slice(0, 24);
    await storage.storageAccounts.beginCreateAndWait(name, account, {
      location: AZURE_REGION,
      kind: 'StorageV2',
      sku: { name: 'Standard_LRS' },
      accessTier: 'Hot',
      allowSharedKeyAccess: true,
      minimumTlsVersion: 'TLS1_2',
      tags: { [TAG.key]: TAG.value },
    });
    await storage.blobContainers.create(name, account, name, {});
    const { keys = [] } = await storage.storageAccounts.listKeys(name, account);
    const key = keys[0]!.value!;
    return {
      host: `${account}.blob.core.windows.net`,
      grant: async (role, compute) => {
        const window = {
          startsOn: new Date(Date.now() - 5 * 60_000),
          expiresOn: new Date(Date.now() + 2 * 3600_000),
        };
        const path = pathFor(role, compute);
        const sasToken =
          role === 'checkpoint'
            ? azureDirectorySas(account, key, name, path, {
                ...window,
                permissions: 'rcwl',
              })
            : azureContainerSas(account, key, name, {
                ...window,
                permissions: role === 'seed' ? 'racwdl' : 'rl',
              });
        return {
          remote: `azureblob:${name}/${path}`,
          conf: RCLONE_CONF_TEMPLATE,
          env: rcloneEnvVars({
            name,
            cloudType: CloudType.Azure,
            storageAccountName: account,
            credentials: { cloudProvider: CloudType.Azure, sasToken },
          }),
        };
      },
    };
  },
  // R2 buckets take no tags: the name prefix marks ownership.
  r2: async () => {
    const storage = r2();
    await storage.upsertBucket(name, 'spike', 'provider-transfer', 'spike');
    return {
      host: new URL(storage.s3Endpoint!).host,
      grant: productGrants(storage, { endpoint: storage.s3Endpoint }),
    };
  },
  aws: async () => {
    const client = new S3Client({ region: AWS_REGION });
    await client.send(new CreateBucketCommand({ Bucket: name }));
    await client.send(
      new PutBucketTaggingCommand({
        Bucket: name,
        Tagging: { TagSet: [{ Key: TAG.key, Value: TAG.value }] },
      }),
    );
    return {
      host: `s3.${AWS_REGION}.amazonaws.com`,
      grant: productGrants(productAws(), { region: AWS_REGION }),
    };
  },
  gcs: async () => {
    await new Storage(gcpOptions())
      .bucket(name)
      .create({ location: GCP_REGION, labels: { [TAG.key]: TAG.value } });
    return {
      host: 'storage.googleapis.com',
      grant: productGrants(productGcs(), {}),
    };
  },
};

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
  const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
  if (digest !== artifact.sha256) {
    throw new Error('rclone archive digest mismatch');
  }
  execFileSync('python3', ['-m', 'zipfile', '-e', zip, dir]);
  const goArch = arch === 'aarch64' ? 'arm64' : 'amd64';
  const binary = join(dir, rcloneArchiveDirectory(goArch), 'rclone');
  execFileSync('chmod', ['+x', binary]);
  return binary;
}

/** The input every guest stages, written once on the runner. */
function writeInput(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xfer-input-'));
  mkdirSync(join(dir, 'shards'));
  execFileSync(
    'bash',
    [
      '-c',
      `head -c ${SIZES.inputFileMiB}M /dev/urandom > model.bin && head -c ${SIZES.inputShards * SIZES.inputShardMiB}M /dev/urandom | split -b ${SIZES.inputShardMiB}M -a 4 -d - shards/`,
    ],
    { cwd: dir },
  );
  return dir;
}

async function seed(rclone: string, local: string, grant: Grant) {
  const dir = mkdtempSync(join(tmpdir(), 'rclone-conf-'));
  writeFileSync(join(dir, 'rclone.conf'), grant.conf);
  await promisify(execFile)(rclone, ['copy', local, grant.remote], {
    env: {
      PATH: process.env.PATH,
      RCLONE_CONFIG: join(dir, 'rclone.conf'),
      ...grant.env,
    },
  });
}

/** One tarball per worker: each storage's endpoint and its two grants. */
async function bundleGrants(
  compute: ComputeId,
  storages: Map<StorageId, StorageHandle>,
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'xfer-grants-'));
  for (const [id, handle] of storages) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'host'), handle.host);
    for (const role of ['input', 'checkpoint'] as const) {
      const grant = await handle.grant(role, compute);
      const roleDir = join(dir, id, role);
      mkdirSync(roleDir);
      writeFileSync(join(roleDir, 'remote'), grant.remote);
      writeFileSync(join(roleDir, 'rclone.conf'), grant.conf);
      writeFileSync(
        join(roleDir, 'env'),
        Object.entries(grant.env)
          .map(([key, value]) => `${key}=${quote(value)}\n`)
          .join(''),
      );
    }
  }
  return execFileSync('tar', ['czf', '-', '-C', dir, '.']);
}

// ------------------------------------------------------------------ guests

function guestScript(
  compute: ComputeId,
  storages: StorageId[],
  urls: { grants: string; evidence: string },
): string {
  const rclone = RUNTIME_ARTIFACTS_BY_HOST_ARCH.x86_64.rclone;
  const settings = {
    SPIKE_TARGET: compute,
    // Each guest starts on a different storage, so no pair shares its objects
    // with the other workers' readers.
    SPIKE_STORAGES: storages
      .map(
        (_, index) =>
          storages[(index + COMPUTE_IDS.indexOf(compute)) % storages.length],
      )
      .join(' '),
    SPIKE_DEADLINE_MIN: GUEST_DEADLINE_MIN,
    SPIKE_GRANTS_URL: urls.grants,
    SPIKE_EVIDENCE_URL: urls.evidence,
    SPIKE_RCLONE_URL: rclone.url,
    SPIKE_RCLONE_SHA256: rclone.sha256,
    SPIKE_RCLONE_DIR: rcloneArchiveDirectory('amd64'),
    SPIKE_TMPFS_GIB: 7,
    SPIKE_CHECKPOINT_FILE_MIB: SIZES.checkpointFileMiB,
    SPIKE_CHECKPOINT_SHARDS: SIZES.checkpointShards,
    SPIKE_CHECKPOINT_SHARD_KIB: SIZES.checkpointShardKiB,
  };
  const guest = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'guest.sh'),
    'utf8',
  );
  return `#!/bin/bash\n${Object.entries(settings)
    .map(([key, value]) => `${key}=${quote(String(value))}`)
    .join('\n')}\n${guest}`;
}

// ------------------------------------------------------------------ results

const GB = (bytes: number) => bytes / 1e9;

/** What a worker measured against each storage, with its list-price cost. */
function analyse(dir: string, compute: ComputeId) {
  const lines = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'));
  const rows = lines('results.tsv');
  if (!rows.length) throw new Error('no transfer ran');
  const pairs: Record<string, unknown> = {};
  for (const storage of new Set(rows.map((row) => row[0] as StorageId))) {
    const def = STORAGES[storage];
    const sameCloud = def.sameCloud === compute;
    const storageEgress = sameCloud ? 0 : def.egressPerGB;
    const computeEgress = sameCloud ? 0 : COMPUTES[compute].egressPerGB;
    const steps: Record<string, Record<string, unknown>> = {};
    let costUsd = 0;
    for (const [, step, start, end, exit, files, bytes] of rows.filter(
      (row) => row[0] === storage,
    )) {
      const expected = step === 'stage' ? INPUT : CHECKPOINT;
      const seconds = Number(end) - Number(start);
      const log = readFileSync(
        join(dir, 'logs', `${storage}-${step}.log`),
        'utf8',
      );
      const errors = log
        .split('\n')
        .filter((line) => line.includes('"level":"error"'));
      const cost =
        step === 'checkpoint-upload'
          ? GB(expected.bytes) * computeEgress +
            (expected.files * def.writePer1k) / 1000
          : GB(expected.bytes) * storageEgress +
            (expected.files * def.readPer1k) / 1000;
      costUsd += cost;
      steps[step!] = {
        seconds: +seconds.toFixed(1),
        MBps: +(expected.bytes / 1e6 / seconds).toFixed(1),
        ok:
          exit === '0' &&
          Number(files) === expected.files &&
          Number(bytes) === expected.bytes,
        exit: Number(exit),
        files: Number(files),
        bytes: Number(bytes),
        errors: errors.length,
        lastError: errors.length ? redact(errors.at(-1)!).slice(0, 300) : null,
        throttled: (
          log.match(/\b(429|503)\b|SlowDown|TooManyRequests|ServerBusy/g) ?? []
        ).length,
        costUsd: +cost.toFixed(4),
      };
    }
    const connects = lines('rtt.tsv')
      .filter((row) => row[0] === storage)
      .map((row) => Number(row[1]))
      .filter((seconds) => seconds > 0);
    const stage = steps.stage as { seconds: number } | undefined;
    pairs[storage] = {
      connectMs: connects.length
        ? +(Math.min(...connects) * 1000).toFixed(1)
        : null,
      ...steps,
      checkpointRoundTripSeconds:
        steps['checkpoint-upload'] && steps['checkpoint-restore']
          ? +(
              (steps['checkpoint-upload'].seconds as number) +
              (steps['checkpoint-restore'].seconds as number)
            ).toFixed(1)
          : null,
      costUsd: +costUsd.toFixed(4),
      w1: stage && {
        stagingHours: +(
          W1_INPUT_BYTES /
          (INPUT.bytes / stage.seconds) /
          3600
        ).toFixed(2),
        stagingEgressUsd: +(GB(W1_INPUT_BYTES) * storageEgress).toFixed(2),
      },
    };
  }
  return pairs;
}

/** A Markdown table of the matrix for the decision record. */
function table(results: Record<string, Record<string, any>>): string {
  const rows = [
    '| Compute | Storage | Connect ms | Stage MB/s | Checkpoint up MB/s | Restore MB/s | Pair $ | W1 staging h | W1 egress $ |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [compute, pairs] of Object.entries(results)) {
    if ('error' in pairs) {
      rows.push(`| ${compute} | — | ${pairs.error} | | | | | | |`);
      continue;
    }
    for (const [storage, pair] of Object.entries(pairs)) {
      if (pair.error) {
        rows.push(`| ${compute} | ${storage} | ${pair.error} | | | | | | |`);
        continue;
      }
      const rate = (step: string) =>
        pair[step] ? `${pair[step].MBps}${pair[step].ok ? '' : ' ✗'}` : '—';
      rows.push(
        `| ${compute} | ${storage} | ${pair.connectMs ?? '—'} | ${rate('stage')} | ${rate('checkpoint-upload')} | ${rate('checkpoint-restore')} | ${pair.costUsd} | ${pair.w1?.stagingHours ?? '—'} | ${pair.w1?.stagingEgressUsd ?? '—'} |`,
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

async function run(options: Options): Promise<void> {
  const checks = await preflight(options);
  // Guests fetch grants and upload evidence through signed URLs on one GCS
  // bucket; no cloud credential reaches a VM.
  const evidence = new Storage(gcpOptions()).bucket(`${name}-evidence`);
  await evidence.create({
    location: GCP_REGION,
    labels: { [TAG.key]: TAG.value },
  });
  const expires = Date.now() + (GUEST_DEADLINE_MIN + 30) * 60_000;
  const [rclone, input, storages] = await Promise.all([
    installRclone(),
    writeInput(),
    Promise.all(
      options.storage.map(
        async (id) => [id, await CREATE_STORAGE[id]()] as const,
      ),
    ).then((entries) => new Map(entries)),
  ]);
  const launched: Partial<Record<ComputeId, { id?: string }>> = {};
  const launches = Promise.allSettled(
    options.compute.map(async (compute) => {
      const [[grants], [upload]] = await Promise.all([
        evidence.file(`grants/${compute}.tgz`).getSignedUrl({
          version: 'v4',
          action: 'read',
          expires,
        }),
        evidence.file(`evidence/${compute}.tgz`).getSignedUrl({
          version: 'v4',
          action: 'write',
          contentType: 'application/gzip',
          expires,
        }),
      ]);
      const script = guestScript(compute, options.storage, {
        grants,
        evidence: upload,
      });
      launched[compute] = await COMPUTES[compute].launch(
        script,
        sizeOf(options, compute),
      );
    }),
  );
  // Settled, so a failed seed can't reject unhandled while launches finish.
  const seeding = Promise.allSettled(
    [...storages.values()].map(async (handle) =>
      seed(rclone, input, await handle.grant('seed')),
    ),
  );
  const launchErrors = [
    ...(await launches).flatMap((launch, index) =>
      launch.status === 'rejected'
        ? [`${options.compute[index]}: ${redact(String(launch.reason))}`]
        : [],
    ),
    ...(await unlisted(options, launched)),
  ];
  save('launch.json', {
    runId,
    name,
    rclone: RCLONE_VERSION,
    sizes: SIZES,
    options,
    preflight: checks,
    launched,
    launchErrors,
  });
  for (const seeded of await seeding) {
    if (seeded.status === 'rejected') throw seeded.reason;
  }
  const seededAt = Date.now();
  const results: Record<string, Record<string, unknown>> = {};
  const pending = new Set(options.compute.filter((id) => launched[id]));
  const deadline = seededAt + (GUEST_DEADLINE_MIN + 3) * 60_000;
  let mintedAt = 0;
  while (pending.size && Date.now() < deadline) {
    if (Date.now() - mintedAt > REMINT_MS) {
      for (const compute of pending) {
        await evidence
          .file(`grants/${compute}.tgz`)
          .save(await bundleGrants(compute, storages));
      }
      mintedAt = Date.now();
    }
    await delay(30_000);
    for (const compute of [...pending]) {
      const file = evidence.file(`evidence/${compute}.tgz`);
      if (!(await file.exists())[0]) continue;
      pending.delete(compute);
      const dir = join(output, compute);
      mkdirSync(dir, { recursive: true });
      await file.download({ destination: `${dir}.tgz` });
      execFileSync('tar', ['xzf', `${dir}.tgz`, '-C', dir]);
      execFileSync('rm', [`${dir}.tgz`]);
      for (const log of readdirSync(join(dir, 'logs'))) {
        const path = join(dir, 'logs', log);
        writeFileSync(path, redact(readFileSync(path, 'utf8')));
      }
      // The guest's last progress line says where it stopped.
      const log = join(dir, 'logs', 'spike.log');
      const stopped = existsSync(log)
        ? readFileSync(log, 'utf8')
            .match(/^SPIKE (?!complete).*$/gm)
            ?.pop()
        : undefined;
      try {
        const pairs = analyse(dir, compute);
        for (const storage of options.storage) {
          pairs[storage] ??= { error: stopped ?? 'not run' };
        }
        results[compute] = pairs;
      } catch (error) {
        results[compute] = {
          error: [String(error), stopped].filter(Boolean).join('; '),
        };
      }
    }
  }
  for (const id of pending) results[id] = { error: 'no evidence uploaded' };
  save('summary.json', {
    runId,
    sourceSha: process.env.SPIKE_SOURCE_SHA ?? null,
    sizes: { ...SIZES, input: INPUT, checkpoint: CHECKPOINT },
    prices: {
      storages: Object.fromEntries(
        STORAGE_IDS.map((id) => {
          const { egressPerGB, readPer1k, writePer1k } = STORAGES[id];
          return [id, { egressPerGB, readPer1k, writePer1k }];
        }),
      ),
      computeEgressPerGB: Object.fromEntries(
        COMPUTE_IDS.map((id) => [id, COMPUTES[id].egressPerGB]),
      ),
    },
    launchErrors,
    results,
  });
  save('summary.md', table(results as Record<string, Record<string, any>>));
  console.log(table(results as Record<string, Record<string, any>>));
  const complete = options.compute.every((compute) =>
    options.storage.every((storage) => {
      const pair = results[compute]?.[storage] as
        | Record<string, { ok?: boolean }>
        | undefined;
      return (
        pair?.stage?.ok &&
        pair['checkpoint-upload']?.ok &&
        pair['checkpoint-restore']?.ok
      );
    }),
  );
  if (launchErrors.length || !complete) {
    throw new Error('a pair did not launch or finish; see summary.json');
  }
}

// ------------------------------------------------------------------ cleanup

/**
 * Delete every owned resource, retrying in rounds until listings are empty:
 * a dependent resource (a Hyperstack environment, a Verda volume) goes once
 * what holds it is gone. A provider without a credential created nothing.
 */
async function cleanup(): Promise<void> {
  const clouds = [
    ...Object.entries(STORAGES).map(
      ([id, cloud]) => [`${id}-storage`, cloud] as const,
    ),
    ...Object.entries(COMPUTES),
  ];
  const credentialed = clouds.filter(([, cloud]) =>
    cloud.secrets.every((key) => process.env[key]),
  );
  const active = credentialed.flatMap(([id, cloud]) =>
    Object.entries(cloud.owned).map(
      ([kind, owned]) => [`${id}-${kind}`, owned] as const,
    ),
  );
  const skipped = clouds
    .filter((entry) => !credentialed.includes(entry))
    .map(([id]) => id);
  const removed: Record<string, string[]> = {};
  let remaining: Record<string, string[]> = {};
  let errors: Record<string, string> = {};
  // Inside the workflow's 20-minute cleanup step.
  const deadline = Date.now() + 17 * 60_000;
  while (Date.now() < deadline) {
    remaining = {};
    errors = {};
    for (const [key, owner] of active) {
      try {
        const ids = await owner.list();
        if (!ids.length) continue;
        remaining[key] = ids;
        removed[key] = [...new Set([...(removed[key] ?? []), ...ids])];
        await Promise.all(ids.map(owner.remove));
      } catch (error) {
        errors[key] = redact(String(error)).slice(0, 300);
        remaining[key] ??= [];
      }
    }
    if (!Object.keys(remaining).length) break;
    await delay(15_000);
  }
  save('cleanup.json', { removed, remaining, errors, skipped });
  if (Object.keys(remaining).length) {
    throw new Error(
      `owned spike resources remain: ${JSON.stringify({ remaining, errors })}`,
    );
  }
}

const [phase = process.env.SPIKE_PHASE ?? 'run', ...args] =
  process.argv.slice(2);
if (phase === 'cleanup') await cleanup();
else if (phase === 'preflight')
  save('preflight.json', await preflight(parseOptions(args)));
else if (phase === 'run') await run(parseOptions(args));
else throw new Error(`Unknown phase ${phase}`);
