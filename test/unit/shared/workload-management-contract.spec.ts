import { describe, expect, it } from 'vitest';
import {
  workloadCostRowsSchema,
  workloadListResponseSchema,
  workloadStatusRequestSchema,
  workloadStatusResponseSchema,
} from '../../../src/shared/api-contract/workload-management-schemas.js';
import { WorkloadHealthStatus } from '../../../src/shared/runtime.js';
import {
  makeWorkloadListRow,
  makeStatusWorkloadMetadata,
} from '../helpers/fixtures.js';

describe('Workload management container ownership contract', () => {
  it('accepts VM-backed list and status responses', () => {
    const row = makeWorkloadListRow();
    expect(workloadListResponseSchema.parse([row])).toEqual([row]);
    const status = {
      workload: makeStatusWorkloadMetadata(),
      events: [],
      status: WorkloadHealthStatus.Down,
    };
    expect(workloadStatusResponseSchema.parse(status)).toEqual(status);
  });

  it.each(['job', 'service', 'vm'] as const)(
    'requires a container image for VM-backed %s list and status rows',
    (workloadType) => {
      const fields = { workloadType, image: null };
      expect(
        workloadListResponseSchema.safeParse([makeWorkloadListRow(fields)])
          .success,
      ).toBe(false);
      expect(
        workloadStatusResponseSchema.safeParse({
          workload: makeStatusWorkloadMetadata(fields),
          events: [],
          status: WorkloadHealthStatus.Down,
        }).success,
      ).toBe(false);
    },
  );

  it('reads eventsLimit as a positive count or "all" on a status request', () => {
    const parse = (query: object) =>
      workloadStatusRequestSchema.safeParse({ params: { id: 'w' }, query });
    expect(parse({}).data).toEqual({ id: 'w' });
    expect(parse({ eventsLimit: '25' }).data).toMatchObject({
      eventsLimit: 25,
    });
    expect(parse({ eventsLimit: 'all' }).data).toMatchObject({
      eventsLimit: 'all',
    });
    for (const bad of ['0', '-1', '1.5', 'none'])
      expect(parse({ eventsLimit: bad }).success).toBe(false);
  });

  it('requires a container image on every cost row', () => {
    const row = {
      id: 'vm-job',
      workloadType: 'job',
      image: 'ghcr.io/acme/train:1',
      cloudProvider: null,
      region: null,
      vmType: null,
      spot: false,
      vmDurationMs: null,
      awaitingReleaseMs: null,
      totalCost: null,
      costSource: null,
      agent: null,
    };
    expect(workloadCostRowsSchema.parse([row])).toEqual([row]);
    for (const workloadType of ['job', 'service', 'vm']) {
      expect(
        workloadCostRowsSchema.safeParse([
          { ...row, workloadType, image: null },
        ]).success,
      ).toBe(false);
    }
  });
});
