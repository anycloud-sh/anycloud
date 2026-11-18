#!/usr/bin/env node
/**
 * Operator script: drain orphan GCP firewall rules.
 *
 * GCP firewall rules don't support labels — production cleanup matches them
 * via `targetTags[0]` (the workload ID set at creation). When a workload
 * ends and its VMs are gone, the firewall rule should be cleaned. In practice
 * old test runs accumulate by the hundreds because cleanup/gcp.ts only runs
 * against whichever project's creds are loaded.
 *
 * Safety model:
 *  - Dry-run by default. Just lists candidates.
 *  - `--delete` REQUIRES `--name-prefix <p>`. Refuses an unscoped delete.
 *    A customer project can mix test fixtures with customer-named rules.
 *    Operator must pick a narrow prefix that excludes those.
 *  - Interactive y/N confirmation before any deletion.
 *
 * Usage:
 *   set -a; source .env.gcp; set +a   # or any project's creds
 *   npx tsx scripts/drain-orphan-gcp-firewalls.ts                              # all candidates
 *   npx tsx scripts/drain-orphan-gcp-firewalls.ts --name-prefix sigterm-test-
 *   npx tsx scripts/drain-orphan-gcp-firewalls.ts --name-prefix sigterm-test- --delete
 */

import { FirewallsClient } from '@google-cloud/compute';

interface Args {
  delete: boolean;
  namePrefix?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { delete: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--delete') args.delete = true;
    else if (argv[i] === '--name-prefix') args.namePrefix = argv[++i];
  }
  return args;
}

async function promptYes(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      resolve(String(data).trim().toLowerCase() === 'y');
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requiredEnv = ['GCP_PROJECT_ID', 'GCP_PRIVATE_KEY', 'GCP_CLIENT_EMAIL'];
  for (const v of requiredEnv) {
    if (!process.env[v]) {
      console.error(`Set ${requiredEnv.join(', ')}.`);
      process.exit(1);
    }
  }
  if (args.delete && !args.namePrefix) {
    console.error(
      '--delete requires --name-prefix to scope the candidate set.\n' +
        'Run without --delete first to list candidates, then pick a prefix.',
    );
    process.exit(1);
  }

  const projectId = process.env.GCP_PROJECT_ID!;
  const client = new FirewallsClient({
    projectId,
    credentials: {
      client_email: process.env.GCP_CLIENT_EMAIL,
      private_key: process.env.GCP_PRIVATE_KEY,
    },
  });

  console.log(
    `Project: ${projectId}, Mode: ${args.delete ? 'DELETE' : 'DRY-RUN'}` +
      (args.namePrefix ? `, name-prefix=${args.namePrefix}` : ''),
  );

  const candidates: string[] = [];
  for await (const fw of client.listAsync({ project: projectId })) {
    if (!fw.name) continue;
    if (args.namePrefix && !fw.name.startsWith(args.namePrefix)) continue;
    candidates.push(fw.name);
  }
  console.log(`\n${candidates.length} candidate(s):`);
  for (const name of candidates) console.log(`  ${name}`);

  if (!args.delete) {
    console.log(
      '\nDry-run only — re-run with --delete --name-prefix <p> to drain.',
    );
    return;
  }
  if (candidates.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const confirmed = await promptYes(
    `\nReally delete ${candidates.length} firewall rule(s) matching prefix "${args.namePrefix}"?`,
  );
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  let deleted = 0;
  let failed = 0;
  // Parallel-ish delete with a small concurrency cap so we don't blast GCP.
  const CONCURRENCY = 10;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const name = candidates[idx++];
      if (!name) continue;
      try {
        const [op] = await client.delete({
          project: projectId,
          firewall: name,
        });
        // Don't bother waiting — fire-and-forget; final count comes from a
        // post-drain list call by the operator.
        if (op) {
          // op is the long-running operation
        }
        console.log(`  deleted ${name}`);
        deleted++;
      } catch (error: any) {
        console.error(`  failed ${name}: ${error.message || error}`);
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nDone: deleted=${deleted}, failed=${failed}`);
}

main().catch((error) => {
  console.error('drain-orphan-gcp-firewalls failed:', error);
  process.exit(1);
});
