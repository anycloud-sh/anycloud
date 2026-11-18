#!/usr/bin/env tsx
import { runCloudCleanup } from '../../ci/cleanup/runner.js';
import { cleanupLocalSmolvmMachines } from '../../src/api/services/gateways/local-smolvm-cleanup.js';
import { createDefaultLocalSmolvmRuntime } from '../../src/api/services/gateways/local-smolvm-runtime.js';

const runtime = createDefaultLocalSmolvmRuntime();

async function main(): Promise<void> {
  await runCloudCleanup({
    cloud: 'Local',
    units: ['smolvm'],
    unitLabel: 'runtime',
    cleanupUnit: () => cleanupLocalSmolvmMachines(runtime, { minAgeMs: null }),
    failOnErrors: true,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
