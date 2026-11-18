import { defineConfig } from 'vitest/config';

// These harness tests use fake ports, local HTTP fixtures, and Node children.
// They need neither catalog downloads nor the ordinary database/GitHub setup.
export default defineConfig({
  test: {
    include: [
      'test/unit/e2e-fixture.spec.ts',
      'test/unit/e2e-persistent-vm-boundaries.spec.ts',
      'test/unit/e2e-persistent-vm-contract.spec.ts',
      'test/unit/e2e-persistent-vm-host-loss-contract.spec.ts',
    ],
    globalSetup: [],
    setupFiles: [],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    expect: { requireAssertions: true },
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    env: {
      IS_TEST: 'true',
      CIPHER_KEY: 'a'.repeat(64),
    },
    deps: { interopDefault: false },
  },
});
