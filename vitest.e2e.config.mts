import { defineConfig } from 'vitest/config';
import { defaultExclude } from 'vitest/config';

const outerTimeoutMs = 3 * 60 * 60 * 1_000;

// The default configuration excludes exactly this glob, so watch mode, IDE
// gutters, and a bare `vitest run <path>` cannot start a constrained candidate
// under unit-test setup, environment, and timeouts.
export const constrainedE2eSpecs = 'test/integration/e2e/specs/**/*.spec.ts';

export default defineConfig({
  test: {
    include: [constrainedE2eSpecs],
    exclude: [...defaultExclude, '**/.context/**'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: outerTimeoutMs,
    teardownTimeout: outerTimeoutMs,
    testTimeout: outerTimeoutMs,
    passWithNoTests: false,
    expect: { requireAssertions: true },
    allowOnly: false,
    // The mandatory fixture refuses to provision without this marker, so a
    // candidate cannot run under any other configuration.
    provide: { constrainedE2E: true },
    deps: {
      interopDefault: false,
    },
  },
});
