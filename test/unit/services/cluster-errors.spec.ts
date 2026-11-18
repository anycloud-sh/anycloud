import { describe, expect, it } from 'vitest';
import { dependentsRefusal } from '../../../src/api/services/cluster-errors';

/** The cloud-cluster contract's check that a refusal names the steps. */
const STEPS =
  /anycloud node-pool delete <name>, then anycloud api delete [^ ]+ again/u;

describe('cluster delete refusals', () => {
  it('lets the delete go on when nothing holds the cluster', () => {
    expect(dependentsRefusal({ pools: [], workloads: [] }, 'prod')).toBeNull();
  });

  it('names idle node pools and their delete, then the cluster delete', () => {
    const refusal = dependentsRefusal(
      {
        pools: [
          { name: 'cpu-a', liveReferences: 0 },
          { name: 'cpu-b', liveReferences: 0 },
        ],
        workloads: [],
      },
      'prod-1',
    );
    expect(refusal).toBe(
      "Node pools cpu-a, cpu-b still exist. With the CLI of the hosted API's release, run anycloud node-pool delete <name>, then anycloud api delete prod-1 again.",
    );
    expect(refusal).toMatch(STEPS);
  });

  it('names the pools in use first, with the Workload deletes before the pool delete', () => {
    const refusal = dependentsRefusal(
      {
        pools: [
          { name: 'gpu', liveReferences: 2 },
          { name: 'cpu', liveReferences: 0 },
        ],
        workloads: [],
      },
      'production',
      'https://prod-1.anycloud.sh',
    );
    expect(refusal).toBe(
      'Node pool gpu still has Deployments or Services. Node pool cpu also exists. Against the hosted API (https://prod-1.anycloud.sh) with the CLI of its release: run anycloud deployment delete <id> / anycloud terminate <id>, then anycloud node-pool delete <name>, then anycloud api delete production again.',
    );
    expect(refusal).toMatch(STEPS);
  });

  it('names VM Workloads on no pool with terminate alone, and skips the pool delete with no pools', () => {
    expect(
      dependentsRefusal({ pools: [], workloads: ['svc-1', 'job-2'] }, 'prod-1'),
    ).toBe(
      'Workloads svc-1, job-2 still run. Run anycloud terminate <id>, then anycloud api delete prod-1 again.',
    );
  });

  it('names idle pools next to a running VM Workload', () => {
    const refusal = dependentsRefusal(
      { pools: [{ name: 'cpu', liveReferences: 0 }], workloads: ['svc-1'] },
      'prod-1',
    );
    expect(refusal).toBe(
      "Workload svc-1 still runs. Node pool cpu also exists. With the CLI of the hosted API's release, run anycloud terminate <id>, then anycloud node-pool delete <name>, then anycloud api delete prod-1 again.",
    );
    expect(refusal).toMatch(STEPS);
  });
});
