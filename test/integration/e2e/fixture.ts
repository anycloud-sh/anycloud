import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, inject, test as base } from 'vitest';

import {
  createE2ELifecycle,
  finalizeE2ELifecycle,
  type E2EWorld,
} from './internal/context.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/**
 * Only `vitest.e2e.config.mts` provides this marker. Any other configuration
 * would run a candidate under unit-test setup, environment, and timeouts, so
 * refuse before the lifecycle can reach a provider.
 */
export function assertConstrainedRunner(marker: boolean | undefined): void {
  if (marker === true) return;
  throw new Error(
    'Constrained E2E candidates run only under vitest.e2e.config.mts. Use ' +
      '`./test/integration/e2e.sh <candidate> --vitest` or the matching ' +
      '`yarn test:<candidate>:vitest` script.',
  );
}

const test = base.extend<{ e2e: E2EWorld }>({
  e2e: [
    async ({ task, signal }, use) => {
      assertConstrainedRunner(inject('constrainedE2E'));
      const lifecycle = await createE2ELifecycle({
        projectRoot,
        signal,
        testName: task.name,
      });
      try {
        await use(lifecycle.e2e);
      } finally {
        await finalizeE2ELifecycle(
          lifecycle,
          task.result?.errors ? [...task.result.errors] : [],
        );
      }
    },
    { auto: true, scope: 'test' },
  ],
});

export { expect, test };
