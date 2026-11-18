#!/usr/bin/env node
/**
 * Delete fresh Azure resources for the current E2E serve workflow run.
 *
 * Generic orphan cleanup intentionally waits for the normal 3h age gate. This
 * script is narrower: it only deletes anycloud-test resources tagged with the
 * current run's serve-* workload prefix.
 *
 * Usage:
 *   npx tsx ci/cleanup/azure-serve-run.ts
 *   npx tsx ci/cleanup/azure-serve-run.ts serve-123456-
 */

import { pathToFileURL } from 'node:url';
import { cleanupAzureServeRun, errorMessage } from './azure-nuke-run';

async function main(): Promise<void> {
  const summary = await cleanupAzureServeRun(process.argv[2]);
  console.log(
    `Azure serve cleanup summary for ${summary.prefix}: resourceGroups=${summary.resourceGroups.length} deleted=${JSON.stringify(summary.deleted)} errors=${summary.errors.length}`,
  );
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Azure serve cleanup failed: ${errorMessage(error)}`);
    process.exit(1);
  });
}
