import { describe, expect, it, vi } from 'vitest';
import {
  cleanupLocalSmolvmMachines,
  isLocalSmolvmCleanupCandidate,
  type LocalSmolvmCleanupClient,
} from '../../../../src/api/services/gateways/local-smolvm-cleanup';
import type { SmolvmMachineInfo } from '../../../../src/api/services/gateways/smolvm-serve-client';
import { CI_RESOURCE_SWEEP_MIN_AGE_MS } from '../../../../ci/cleanup/policy';

function makeClient(
  machines: SmolvmMachineInfo[],
  overrides: Partial<LocalSmolvmCleanupClient> = {},
): LocalSmolvmCleanupClient {
  return {
    listMachines: vi.fn().mockResolvedValue(machines),
    stopMachine: vi.fn().mockResolvedValue({}),
    deleteMachine: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeRuntime(client: LocalSmolvmCleanupClient) {
  return { client, config: { machinePrefix: 'ac-local-' } };
}

describe('cleanupLocalSmolvmMachines', () => {
  it('uses the supplied age guard', async () => {
    const client = makeClient([
      { name: 'ac-local-old', state: 'running', createdAt: 1 },
      { name: 'ac-local-new', state: 'running', createdAt: Date.now() },
      { name: 'ac-local-unknown-age', state: 'running' },
      { name: 'other-old', state: 'running', createdAt: 1 },
    ]);
    await expect(
      cleanupLocalSmolvmMachines(makeRuntime(client), {
        dryRun: true,
        minAgeMs: CI_RESOURCE_SWEEP_MIN_AGE_MS,
      }),
    ).resolves.toEqual({
      vmIds: ['ac-local-old'],
      otherResources: [],
      errors: [],
    });
    expect(client.deleteMachine).not.toHaveBeenCalled();
  });

  it('can delete every owned VM during CI teardown', async () => {
    const client = makeClient([
      { name: 'ac-local-new', state: 'running', createdAt: Date.now() },
      { name: 'ac-local-unknown-age', state: 'running' },
      { name: 'other-old', state: 'running', createdAt: 1 },
    ]);
    await expect(
      cleanupLocalSmolvmMachines(makeRuntime(client), { minAgeMs: null }),
    ).resolves.toEqual({
      vmIds: ['ac-local-new', 'ac-local-unknown-age'],
      otherResources: [],
      errors: [],
    });
    expect(client.deleteMachine).not.toHaveBeenCalledWith('other-old', true);
  });

  it('reports delete failures without marking the VM cleaned', async () => {
    const client = makeClient(
      [{ name: 'ac-local-stuck', state: 'running', createdAt: 1 }],
      {
        deleteMachine: vi.fn().mockRejectedValue(new Error('delete failed')),
      },
    );
    await expect(
      cleanupLocalSmolvmMachines(makeRuntime(client), {
        minAgeMs: CI_RESOURCE_SWEEP_MIN_AGE_MS,
      }),
    ).resolves.toEqual({
      vmIds: [],
      otherResources: [],
      errors: [
        {
          resourceType: 'vm',
          resourceId: 'ac-local-stuck',
          error: 'delete failed',
        },
      ],
    });
  });

  it('reads a string creation time in the same unit as the VM listing', () => {
    const config = { machinePrefix: 'ac-local-' };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const freshForms = [
      nowSeconds,
      String(nowSeconds),
      Date.now(),
      String(Date.now()),
      new Date().toISOString(),
    ];

    for (const createdAt of freshForms) {
      expect(
        isLocalSmolvmCleanupCandidate(
          { name: 'ac-local-fresh', state: 'running', createdAt },
          config,
          CI_RESOURCE_SWEEP_MIN_AGE_MS,
        ),
      ).toBe(false);
    }

    const staleSeconds = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    expect(
      isLocalSmolvmCleanupCandidate(
        {
          name: 'ac-local-stale',
          state: 'running',
          createdAt: String(staleSeconds),
        },
        config,
        CI_RESOURCE_SWEEP_MIN_AGE_MS,
      ),
    ).toBe(true);
  });

  it('treats every owned machine as an ordinary cleanup candidate', () => {
    const machine: SmolvmMachineInfo = {
      name: 'ac-local-dep-1-0',
      state: 'running',
      createdAt: 1,
    };
    const config = { machinePrefix: 'ac-local-' };

    expect(
      isLocalSmolvmCleanupCandidate(
        machine,
        config,
        CI_RESOURCE_SWEEP_MIN_AGE_MS,
      ),
    ).toBe(true);
    expect(isLocalSmolvmCleanupCandidate(machine, config, null)).toBe(true);
  });
});
