#!/usr/bin/env node
/**
 * Check that the vendored Cloudflare edge IP ranges still match the public API.
 *
 * Usage:
 *   npx tsx ci/check-cloudflare-ips.ts
 */
import {
  CLOUDFLARE_IP_RANGES_ETAG,
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
} from '../src/shared/cloudflare-ips.js';

interface CloudflareIpsResponse {
  success: boolean;
  result?: {
    etag?: string;
    ipv4_cidrs?: string[];
    ipv6_cidrs?: string[];
  };
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function main(): Promise<void> {
  const response = await fetch('https://api.cloudflare.com/client/v4/ips', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Cloudflare IP API returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as CloudflareIpsResponse;
  const result = body.result;
  if (!body.success || !result) {
    throw new Error('Cloudflare IP API returned an unsuccessful response');
  }

  const remoteEtag = result.etag ?? '';
  const remoteV4 = result.ipv4_cidrs ?? [];
  const remoteV6 = result.ipv6_cidrs ?? [];

  const matches =
    remoteEtag === CLOUDFLARE_IP_RANGES_ETAG &&
    sameValues(remoteV4, CLOUDFLARE_IPV4_RANGES) &&
    sameValues(remoteV6, CLOUDFLARE_IPV6_RANGES);

  if (matches) {
    console.log(`Cloudflare IP ranges are current (${remoteEtag})`);
    return;
  }

  console.error('Cloudflare IP ranges have changed.');
  console.error(`Vendored etag: ${CLOUDFLARE_IP_RANGES_ETAG}`);
  console.error(`Remote etag:   ${remoteEtag}`);
  console.error('');
  console.error('Update src/shared/cloudflare-ips.ts from:');
  console.error('  https://api.cloudflare.com/client/v4/ips');
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
