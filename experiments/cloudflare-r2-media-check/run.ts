#!/usr/bin/env tsx
/**
 * Cloudflare checks and setup for hosting the landing-page launch video on R2
 * behind media.anycloud.sh.
 *
 * `preflight` only issues GET requests and creates nothing. `setup` creates the
 * bucket, attaches the custom domain, and uploads the encodes (see setup.ts).
 * Reports go to SPIKE_OUTPUT_DIR without token material.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './setup.js';

const API = 'https://api.cloudflare.com/client/v4';
// The account that serves anycloud.sh, from the CLOUDFLARE_ACCOUNT_ID variable.
function cloudflareAccountId(): string {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  return id;
}
const ZONE_NAME = 'anycloud.sh';
const MEDIA_HOST = 'media.anycloud.sh';
const BUCKET = 'anycloud-media';
const TIMEOUT_MS = 30_000;

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

interface Probe {
  check: string;
  request: string;
  status: number;
  ok: boolean;
  errors: string[];
  observation?: unknown;
}

async function get<T>(
  token: string,
  path: string,
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({
    success: false,
  }))) as Envelope<T>;
  return { status: response.status, body };
}

async function probe<T>(
  token: string,
  check: string,
  path: string,
  observe: (result: T) => unknown,
): Promise<Probe & { result?: T }> {
  const { status, body } = await get<T>(token, path);
  const ok = status === 200 && body.success;
  return {
    check,
    request: `GET ${path}`,
    status,
    ok,
    errors: (body.errors ?? []).map((e) => `${e.code}: ${e.message}`),
    observation:
      ok && body.result !== undefined ? observe(body.result) : undefined,
    result: ok ? body.result : undefined,
  };
}

async function preflight(token: string): Promise<Probe[]> {
  const probes: Probe[] = [];
  const strip = ({ result: _result, ...rest }: Probe & { result?: unknown }) =>
    rest;

  probes.push(
    strip(
      await probe<{ status: string }>(
        token,
        'token is valid (account token)',
        `/accounts/${cloudflareAccountId()}/tokens/verify`,
        (r) => ({ status: r.status }),
      ),
    ),
  );
  probes.push(
    strip(
      await probe<{ status: string }>(
        token,
        'token is valid (user token)',
        '/user/tokens/verify',
        (r) => ({ status: r.status }),
      ),
    ),
  );

  const buckets = await probe<{ buckets?: Array<{ name: string }> }>(
    token,
    'can read R2 buckets',
    // The list is paginated; filter by name so one page always answers.
    `/accounts/${cloudflareAccountId()}/r2/buckets?name_contains=${BUCKET}&per_page=1000`,
    (r) => ({
      bucketCount: r.buckets?.length ?? 0,
      mediaBucketExists: (r.buckets ?? []).some((b) => b.name === BUCKET),
    }),
  );
  probes.push(strip(buckets));
  if ((buckets.result?.buckets ?? []).some((b) => b.name === BUCKET)) {
    probes.push(
      strip(
        await probe<{ domains?: Array<{ domain: string; enabled: boolean }> }>(
          token,
          `can read ${BUCKET} custom domains`,
          `/accounts/${cloudflareAccountId()}/r2/buckets/${BUCKET}/domains/custom`,
          (r) => ({ domains: r.domains ?? [] }),
        ),
      ),
    );
  }

  const zones = await probe<Array<{ id: string; name: string }>>(
    token,
    `can read the ${ZONE_NAME} zone`,
    `/zones?name=${ZONE_NAME}`,
    (r) => ({ zoneFound: r.length === 1 }),
  );
  probes.push(strip(zones));
  const zoneId = zones.result?.[0]?.id;
  if (zoneId) {
    probes.push(
      strip(
        await probe<Array<{ type: string; name: string }>>(
          token,
          `can read DNS records for ${MEDIA_HOST}`,
          `/zones/${zoneId}/dns_records?name=${MEDIA_HOST}`,
          (r) => ({ existingRecords: r.map((x) => x.type) }),
        ),
      ),
    );
  }
  return probes;
}

async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (
    !(command === 'preflight' && extra.length === 0) &&
    !(command === 'setup' && extra.length > 0)
  ) {
    throw new Error(
      'Usage: run.ts preflight | run.ts setup <version> <base-url> <file:sha256>...',
    );
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const output = process.env.SPIKE_OUTPUT_DIR ?? 'spike-evidence';
  mkdirSync(output, { recursive: true, mode: 0o700 });

  if (command === 'setup') {
    await setup(
      token,
      {
        accountId: cloudflareAccountId(),
        zoneName: ZONE_NAME,
        mediaHost: MEDIA_HOST,
        bucket: BUCKET,
      },
      extra,
      output,
    );
    return;
  }

  const probes = await preflight(token);
  const report = {
    experiment: 'cloudflare-r2-media-check',
    checkedAt: new Date().toISOString(),
    zone: ZONE_NAME,
    mediaHost: MEDIA_HOST,
    bucket: BUCKET,
    probes,
    note: 'Read-only. Write permissions (bucket create, custom domain, object put) are not exercised.',
  };
  writeFileSync(
    join(output, 'preflight.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const p of probes) {
    console.log(
      `${p.ok ? 'PASS' : 'FAIL'}  ${p.check}  (${p.status})${p.errors.length ? `  ${p.errors.join('; ')}` : ''}${p.observation ? `  ${JSON.stringify(p.observation)}` : ''}`,
    );
  }
  // Either verify endpoint succeeding means the token works; the capability
  // probes are reported rather than failing the run.
  if (!probes.slice(0, 2).some((p) => p.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Run failed');
  process.exitCode = 1;
});
