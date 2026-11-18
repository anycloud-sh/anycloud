import { defineConfig } from 'vitest/config';
import { defaultExclude } from 'vitest/config';

import { constrainedE2eSpecs } from './vitest.e2e.config.mts';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30000, // 30 seconds for workload operations
    // File-parallel CI can run several fresh SQLite databases through the full
    // migration chain at once. Give those setup hooks the same budget as tests.
    hookTimeout: 30000,
    teardownTimeout: 10000,
    environment: 'node', // Use Node.js environment instead of Workers
    setupFiles: ['./test/unit/setup.ts'], // Load GitHub mock before all tests
    fileParallelism: false, // Run test files sequentially to avoid port conflicts
    expect: { requireAssertions: true },
    allowOnly: false,
    passWithNoTests: false,
    env: {
      IS_TEST: 'true',
      CIPHER_KEY:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    // Constrained E2E candidates own vitest.e2e.config.mts. Excluding them here
    // keeps watch mode and IDE gutters from provisioning real cloud resources
    // under unit-test setup, environment, and 30-second timeouts.
    exclude: [
      ...defaultExclude,
      '**/.context/**',
      '**/.stryker-tmp/**',
      '**/reports/mutation/**',
      constrainedE2eSpecs,
    ],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    deps: {
      // Disable automatic ESM/CJS interop to match Node.js behavior
      interopDefault: false,
    },
  },
});
