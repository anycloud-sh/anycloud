/**
 * Setup of the launch-video media host: the anycloud-media R2 bucket and its
 * media.anycloud.sh custom domain (created once, skipped later), plus the five
 * web encodes of one cut (uploaded per cut).
 *
 * Files are downloaded from a temporary URL and checked against SHA-256 digests
 * passed as arguments before anything is uploaded. The bucket and domain steps
 * are skipped when they already exist; uploads always overwrite, so each cut
 * needs a new version folder.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const WRANGLER = 'wrangler@4.148.0';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_TYPES: Record<string, string> = {
  '1080.av1.webm': 'video/webm',
  '720.av1.webm': 'video/webm',
  '1080.h264.mp4': 'video/mp4',
  '720.h264.mp4': 'video/mp4',
  'poster.jpg': 'image/jpeg',
};
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const VERIFY_INTERVAL_MS = 15_000;

export interface SetupTarget {
  accountId: string;
  zoneName: string;
  mediaHost: string;
  bucket: string;
}

interface FileSpec {
  name: string;
  sha256: string;
}

export function parseSetupArguments(args: string[]): {
  prefix: string;
  baseUrl: string;
  files: FileSpec[];
} {
  const [version, baseUrl, ...pairs] = args;
  // One immutable folder per cut, for example 2026-10-v2.
  if (!version || !/^\d{4}-\d{2}-v\d+$/.test(version)) {
    throw new Error('setup needs a version folder such as 2026-10-v2 first');
  }
  if (!baseUrl || !/^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/i.test(baseUrl)) {
    throw new Error('setup needs an https base URL after the version');
  }
  const files = pairs.map((pair) => {
    const [name, sha256] = pair.split(':');
    if (!name || !(name in CONTENT_TYPES)) {
      throw new Error(`Unexpected file ${name ?? '(missing)'}`);
    }
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`File ${name} needs a lowercase SHA-256 digest`);
    }
    return { name, sha256 };
  });
  const names = new Set(files.map((f) => f.name));
  if (
    names.size !== files.length ||
    names.size !== Object.keys(CONTENT_TYPES).length
  ) {
    throw new Error(
      `setup needs each of ${Object.keys(CONTENT_TYPES).join(', ')} exactly once`,
    );
  }
  return {
    prefix: `launch/${version}`,
    baseUrl: baseUrl.replace(/\/$/, ''),
    files,
  };
}

async function api<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    success: boolean;
    result: T;
    errors?: Array<{ code: number; message: string }>;
  };
  if (!response.ok || !body.success) {
    const errors = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`);
    throw new Error(
      `GET ${path} failed (${response.status}) ${errors.join('; ')}`,
    );
  }
  return body.result;
}

function wrangler(target: SetupTarget, cwd: string, args: string[]): void {
  execFileSync('npx', ['--yes', WRANGLER, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: target.accountId,
      WRANGLER_SEND_METRICS: 'false',
    },
  });
}

interface Report {
  prefix?: string;
  steps: Array<{ step: string; result: string }>;
  zoneId?: string;
  // Last HEAD outcome per file, so a failed serve check says why.
  served: Record<string, string>;
}

export async function setup(
  token: string,
  target: SetupTarget,
  args: string[],
  output: string,
): Promise<void> {
  const report: Report = { steps: [], served: {} };
  try {
    await provision(token, target, args, report);
  } finally {
    // Written on failure too, so the evidence shows how far the run got.
    writeFileSync(
      join(output, 'setup.json'),
      `${JSON.stringify({ ...target, ...report }, null, 2)}\n`,
      { mode: 0o600 },
    );
    for (const s of report.steps) console.log(`${s.step}: ${s.result}`);
  }
}

async function provision(
  token: string,
  target: SetupTarget,
  args: string[],
  report: Report,
): Promise<void> {
  const { prefix, baseUrl, files } = parseSetupArguments(args);
  report.prefix = prefix;
  const work = mkdtempSync(join(tmpdir(), 'r2-media-'));
  const { steps, served } = report;

  for (const file of files) {
    const response = await fetch(`${baseUrl}/${file.name}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Download of ${file.name} failed (${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256) {
      throw new Error(`${file.name} does not match its SHA-256 digest`);
    }
    writeFileSync(join(work, file.name), bytes);
  }
  steps.push({ step: 'download and verify', result: `${files.length} files` });

  const zones = await api<Array<{ id: string }>>(
    token,
    `/zones?name=${target.zoneName}`,
  );
  const zoneId = zones[0]?.id;
  if (!zoneId) throw new Error(`Zone ${target.zoneName} not found`);
  report.zoneId = zoneId;

  const listed = await api<{ buckets?: Array<{ name: string }> }>(
    token,
    `/accounts/${target.accountId}/r2/buckets?name_contains=${target.bucket}&per_page=1000`,
  );
  if ((listed.buckets ?? []).some((b) => b.name === target.bucket)) {
    steps.push({ step: 'create bucket', result: 'already exists' });
  } else {
    wrangler(target, work, ['r2', 'bucket', 'create', target.bucket]);
    steps.push({ step: 'create bucket', result: 'created' });
  }

  const domains = await api<{ domains?: Array<{ domain: string }> }>(
    token,
    `/accounts/${target.accountId}/r2/buckets/${target.bucket}/domains/custom`,
  );
  if ((domains.domains ?? []).some((d) => d.domain === target.mediaHost)) {
    steps.push({ step: 'attach custom domain', result: 'already attached' });
  } else {
    wrangler(target, work, [
      'r2',
      'bucket',
      'domain',
      'add',
      target.bucket,
      '--domain',
      target.mediaHost,
      '--zone-id',
      zoneId,
      '--min-tls',
      '1.2',
      '--force',
    ]);
    steps.push({ step: 'attach custom domain', result: 'attached' });
  }

  for (const file of files) {
    wrangler(target, work, [
      'r2',
      'object',
      'put',
      `${target.bucket}/${prefix}/${file.name}`,
      '--file',
      join(work, file.name),
      '--content-type',
      CONTENT_TYPES[file.name],
      '--cache-control',
      CACHE_CONTROL,
      '--remote',
    ]);
  }
  steps.push({
    step: 'upload',
    result: `${files.length} objects under ${prefix}/`,
  });

  const pending = new Set(files.map((f) => f.name));
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (pending.size && Date.now() < deadline) {
    for (const name of [...pending]) {
      const url = `https://${target.mediaHost}/${prefix}/${name}`;
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => {
        served[name] =
          `error: ${error instanceof Error ? error.message : 'request failed'}`;
        return null;
      });
      if (!response) continue;
      const type = response.headers.get('content-type') ?? '';
      served[name] = `${response.status} ${type}`;
      if (response.status === 200 && type.startsWith(CONTENT_TYPES[name])) {
        pending.delete(name);
      }
    }
    if (pending.size)
      await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
  }
  steps.push({
    step: 'serve check',
    result: pending.size
      ? `not serving: ${[...pending].join(', ')}`
      : 'all served',
  });

  if (pending.size) {
    throw new Error(`${target.mediaHost} is not serving every file yet`);
  }
}
