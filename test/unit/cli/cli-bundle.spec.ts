/**
 * The CLI drives the user's own cloud CLIs for api create and delete
 * (RFC 0049 C26 (e)) and never bundles the API or a cloud SDK. This bundles
 * the CLI's entry as `bun build --compile` does, dynamic imports included,
 * and lists what Bun put in it.
 *
 * `@aws-sdk/client-sts` is the one exception: `credentials new` for AWS
 * already ships it on main to check a key. The seed itself needs none.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const API_OR_CLOUD_SDK =
  /\/src\/api\/|\/node_modules\/(@google-cloud|google-auth-library|google-gax|@azure|@kubernetes)\/|\/node_modules\/@aws-sdk\/(lib-storage|util-waiter|client-(?!sts\/))/;

it('keeps the API and every cloud SDK out of the CLI bundle', () => {
  const out = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  try {
    execFileSync(
      'npx',
      [
        'bun',
        'build',
        'src/cli/index.ts',
        '--target=bun',
        '--sourcemap=external',
        '--outdir',
        out,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const { sources } = JSON.parse(
      readFileSync(join(out, 'index.js.map'), 'utf8'),
    ) as { sources: string[] };
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.filter((source) => API_OR_CLOUD_SDK.test(source))).toEqual(
      [],
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120_000);
