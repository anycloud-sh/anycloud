import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createHttpHeaders, RestError } from '@azure/core-rest-pipeline';
import config, {
  COST_CALCULATION_CONCURRENCY,
} from '../../../../src/api/config.js';
import { calculateVmCosts } from '../../../../src/api/services/cost-calculation/index.js';
import { runCostCalculationOnce } from '../../../../src/api/services/cost-calculation/monitor.js';
import { resetPersistence } from '../../../../src/api/services/persistence.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import {
  seedBillingCredential,
  seedBillingGroup,
} from '../../../helpers/billing-groups.mjs';

vi.mock('../../../../src/api/services/cost-calculation/index', () => ({
  calculateVmCosts: vi.fn(),
}));

/** A deleted node pool whose VMs ran one after another. */
const azureThrottle = (headers: Record<string, string> = {}) =>
  Object.assign(new RestError('Throttled', { statusCode: 429 }), {
    response: { headers: createHttpHeaders(headers) },
  });

const throttles: [string, () => Error][] = [
  ['Azure', () => azureThrottle()],
  // Run 37728871263 saw a zero wait on a quota that was already spent.
  [
    'Azure with a zero wait',
    () =>
      azureThrottle({
        'x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after': '0',
      }),
  ],
  [
    'AWS Cost Explorer',
    () =>
      Object.assign(new Error('Rate exceeded'), {
        name: 'LimitExceededException',
        $metadata: { httpStatusCode: 400 },
      }),
  ],
  [
    'BigQuery',
    () =>
      Object.assign(new Error('Exceeded rate limits'), {
        code: 403,
        errors: [{ reason: 'rateLimitExceeded' }],
      }),
  ],
];

describe('runCostCalculationOnce', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(() => {
    resetPersistence();
    vi.clearAllMocks();
  });

  // A credential the provider throttles sits out the rest of the sweep.
  it.each(throttles)('stops a credential %s throttles', async (_, throttle) => {
    const throttled = await seedBillingCredential('throttled-account');
    const healthy = await seedBillingCredential('healthy-account');
    const throttledGroups = COST_CALCULATION_CONCURRENCY * 2 + 5;
    for (let index = 0; index < throttledGroups; index++) {
      await seedBillingGroup({
        id: `throttled-${index}`,
        credentialId: throttled,
        weights: [1],
      });
    }
    await seedBillingGroup({
      id: 'z-healthy',
      credentialId: healthy,
      weights: [1],
    });
    vi.mocked(calculateVmCosts).mockImplementation(
      async (_identity, groups) => {
        if (groups[0][0].credential_id === throttled) {
          throw throttle();
        }
        return new Map(groups.map(([vm]) => [vm.cloud_id, 1.5]));
      },
    );

    await runCostCalculationOnce({ billLagMs: 0 });

    const throttledCalls = vi
      .mocked(calculateVmCosts)
      .mock.calls.filter(
        ([, groups]) => groups[0][0].credential_id === throttled,
      );
    expect(throttledCalls).toHaveLength(1);
    expect(throttledCalls[0][1]).toHaveLength(COST_CALCULATION_CONCURRENCY);
    await expect(
      getDB().query<{ cost: number | null }>(
        `SELECT cost FROM vms WHERE workload_id = 'z-healthy'`,
      ),
    ).resolves.toEqual([{ cost: 1.5 }]);
  });

  it('resumes a credential later in the sweep once the largest Cost Management wait passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const azure = await seedBillingCredential('azure-account');
      const other = await seedBillingCredential('other-account');
      // Four pages, each with one batch per credential.
      for (let index = 0; index < COST_CALCULATION_CONCURRENCY * 2; index++) {
        const id = `group-${String(index).padStart(2, '0')}`;
        await seedBillingGroup({ id: `${id}-a`, credentialId: azure });
        await seedBillingGroup({ id: `${id}-b`, credentialId: other });
      }
      const azureCalls: number[] = [];
      vi.mocked(calculateVmCosts).mockImplementation(
        async (_identity, groups) => {
          if (groups[0][0].credential_id === other) {
            // Each page waits for a 30 s query on the other credential.
            vi.advanceTimersByTime(30_000);
          } else if (azureCalls.push(Date.now()) === 1) {
            // Entity, tenant and qpu from run 37727637947; clienttype from
            // run 37728871263.
            throw azureThrottle({
              'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after':
                '40',
              'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after':
                '39',
              'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after': '17',
              'x-ms-ratelimit-microsoft.costmanagement-clienttype-retry-after':
                '2',
            });
          }
          return new Map(groups.map(([vm]) => [vm.cloud_id, 1.5]));
        },
      );

      await runCostCalculationOnce({ billLagMs: 0 });

      // Skipped on at least one page, then asked again after 40 s.
      expect(azureCalls.length).toBeGreaterThan(1);
      expect(azureCalls.length).toBeLessThan(4);
      expect(azureCalls[1] - azureCalls[0]).toBeGreaterThanOrEqual(40_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
