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

const deploymentContainerFields = {
  deploymentId: 'deployment-a',
  image: null,
  imageDigest: null,
  command: null,
  dockerOptions: null,
};

describe('Workload management container ownership contract', () => {
  it('0036/S19 accepts identity-only Deployment Jobs alongside VM-backed list and status responses', () => {
    const vmJob = makeWorkloadListRow();
    const deploymentJob = makeWorkloadListRow(deploymentContainerFields);
    expect(workloadListResponseSchema.parse([vmJob, deploymentJob])).toEqual([
      vmJob,
      deploymentJob,
    ]);
    const status = {
      workload: makeStatusWorkloadMetadata(deploymentContainerFields),
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

  it("accepts a pool Job's own image and command on its managed Deployment", () => {
    const value = {
      ...deploymentContainerFields,
      image: 'ghcr.io/acme/train:1',
      command: ['python', 'train.py'],
    };
    expect(
      workloadListResponseSchema.safeParse([makeWorkloadListRow(value)])
        .success,
    ).toBe(true);
  });

  it.each([
    { image: 'copied:latest', dockerOptions: { cpus: '2' } },
    { imageDigest: 'sha256:copied' },
    { command: ['copied'] },
    { dockerOptions: { cpus: '2' } },
    { workloadType: 'service' as const },
    { workloadType: 'vm' as const },
  ])(
    'rejects configuration or a non-Job type on a Deployment target: %j',
    (fields) => {
      const value = { ...deploymentContainerFields, ...fields };
      expect(
        workloadListResponseSchema.safeParse([makeWorkloadListRow(value)])
          .success,
      ).toBe(false);
      expect(
        workloadStatusResponseSchema.safeParse({
          workload: makeStatusWorkloadMetadata(value),
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

  it('allows absent images only for Job cost rows', () => {
    const row = {
      id: 'deployment-job',
      workloadType: 'job',
      image: null,
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
    for (const workloadType of ['service', 'vm']) {
      expect(
        workloadCostRowsSchema.safeParse([{ ...row, workloadType }]).success,
      ).toBe(false);
    }
  });
});
