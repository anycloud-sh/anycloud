import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCloudCleanup } from '../../../ci/cleanup/runner';
import type { ResourceSweepResult } from '../../../src/api/services/gateways/resource-sweeper';

const CLEAN: ResourceSweepResult = {
  vmIds: ['ac-local-a'],
  otherResources: [],
  errors: [],
};
const LEAKED: ResourceSweepResult = {
  vmIds: [],
  otherResources: [],
  errors: [
    {
      resourceType: 'vm',
      resourceId: 'ac-local-stuck',
      error: 'delete failed',
    },
  ],
};

// process.exit is typed to return never, so an implementation that always
// throws both satisfies the type and lets the test observe the exit code
// without tearing down the worker.
function spyOnExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
}

describe('runCloudCleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits non-zero when failOnErrors is set and a resource survived', async () => {
    const exit = spyOnExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runCloudCleanup({
        cloud: 'Local',
        units: ['smolvm'],
        cleanupUnit: async () => LEAKED,
        failOnErrors: true,
      }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits zero when failOnErrors is set and cleanup succeeded', async () => {
    const exit = spyOnExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runCloudCleanup({
        cloud: 'Local',
        units: ['smolvm'],
        cleanupUnit: async () => CLEAN,
        failOnErrors: true,
      }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(0);
  });

  // An unreachable endpoint at teardown never got to enumerate anything, so it
  // is not evidence of a leak. Failing on it would let a post-test `if: always()`
  // cleanup step turn an otherwise green job red.
  it('exits zero when the sweep itself could not run', async () => {
    const exit = spyOnExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runCloudCleanup({
        cloud: 'Local',
        units: ['smolvm'],
        cleanupUnit: () => Promise.reject(new Error('ECONNREFUSED')),
        failOnErrors: true,
      }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits zero when the sweep exceeds its deadline', async () => {
    const exit = spyOnExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runCloudCleanup({
        cloud: 'Local',
        units: ['smolvm'],
        cleanupUnit: () =>
          new Promise((resolve) => setTimeout(() => resolve(CLEAN), 50)),
        timeoutMs: 1,
        failOnErrors: true,
      }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps best-effort exit-zero behavior for the cloud sweeps', async () => {
    const exit = spyOnExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runCloudCleanup({
        cloud: 'AWS',
        units: ['us-east-1'],
        cleanupUnit: async () => LEAKED,
      }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(0);
  });
});
