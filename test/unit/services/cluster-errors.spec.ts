import { describe, expect, it } from 'vitest';
import { dependentsRefusal } from '../../../src/api/services/cluster-errors';

describe('api delete refusals', () => {
  it('lets the api delete go on when nothing holds the cluster', () => {
    expect(dependentsRefusal({ workloads: [] }, 'prod')).toBeNull();
  });

  it('names a running VM Workload and its terminate', () => {
    expect(dependentsRefusal({ workloads: ['svc-1'] }, 'prod-1')).toBe(
      'Workload svc-1 still runs. Run anycloud terminate <id>, then anycloud api delete prod-1 again.',
    );
  });

  it('names several VM Workloads', () => {
    expect(dependentsRefusal({ workloads: ['svc-1', 'job-2'] }, 'prod-1')).toBe(
      'Workloads svc-1, job-2 still run. Run anycloud terminate <id>, then anycloud api delete prod-1 again.',
    );
  });
});
