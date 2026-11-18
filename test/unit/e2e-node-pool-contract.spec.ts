import { describe, expect, it } from 'vitest';
import {
  forcedCapacityFailureUnmet,
  proveCapacityReplacement,
} from '../integration/e2e/internal/contracts/node-pool.js';
import type { KubernetesCapacityObservation } from '../integration/e2e/internal/targets/cluster-node-pool.js';
import { WorkloadState } from '../../src/shared/workload.js';
import { trackedNodePoolRefForTest } from './helpers/e2e.js';

const forced = {
  vmRowId: 1,
  region: 'us-east-1',
  diagnosis: 'capacity-exhausted',
};
const real = {
  vmRowId: 2,
  region: 'us-west-1',
  diagnosis: 'capacity-exhausted',
};

describe('node pool contract with real rotation', () => {
  it('accepts the forced capacity failure followed by real failover failures', () => {
    expect(forcedCapacityFailureUnmet([forced, real])).toBeUndefined();
    expect(
      forcedCapacityFailureUnmet([
        forced,
        { ...real, diagnosis: 'invalid-target' },
      ]),
    ).toBeUndefined();
    expect(forcedCapacityFailureUnmet([])).toMatch(/missing/);
    expect(
      forcedCapacityFailureUnmet([
        forced,
        { ...real, diagnosis: 'invalid-request' },
      ]),
    ).toMatch(/us-west-1 failed invalid-request/);
    expect(
      forcedCapacityFailureUnmet([
        forced,
        { ...real, diagnosis: 'bad-credential' },
      ]),
    ).toMatch(/us-west-1 failed bad-credential/);
    expect(
      forcedCapacityFailureUnmet([
        { ...forced, diagnosis: 'quota-exhausted-account' },
        real,
      ]),
    ).toMatch(/not the forced/);
  });

  it('proves a replacement that launched after one failed launch', async () => {
    // Rows: 1 forced failure, 3 the ready VM; the replacement fails as 4,
    // then launches as 5.
    const rows = [
      { vmRowId: 1, cloudId: 'f1' },
      { vmRowId: 3, cloudId: 'vm-3' },
    ];
    let failedLaunches = [forced];
    const capacity = (): KubernetesCapacityObservation => ({
      nodePoolId: 'np',
      totalVmCount: rows.length,
      liveVmCount: 1,
      failedLaunches,
    });
    const replaced = await proveCapacityReplacement(
      {
        policy: { nodePoolTimeoutMs: 1_000 },
        wait: {
          async for(_label, probe, options) {
            const value = await probe(0);
            const unmet = options.unmet?.(value);
            if (unmet) throw new Error(unmet);
            return value;
          },
        },
        target: {
          capacityIdentities: async () => [...rows],
          deleteOneCapacityHost: async () => {
            failedLaunches = [...failedLaunches, { ...real, vmRowId: 4 }];
            rows.push(
              { vmRowId: 4, cloudId: 'f4' },
              { vmRowId: 5, cloudId: 'vm-5' },
            );
            return 'vm-3';
          },
          capacity: async () => capacity(),
          nodePoolStatus: async () => ({
            id: 'np',
            name: 'np',
            state: WorkloadState.Running,
            readyVmCount: 1,
          }),
        },
      },
      {
        id: 'np',
        ref: trackedNodePoolRefForTest('np'),
        totalVmCount: 2,
        vmCount: 1,
        failedLaunches: [forced],
      },
    );
    expect(replaced.replacementVmRowId).toBe(5);
  });
});
