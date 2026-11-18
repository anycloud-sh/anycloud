import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMaceReport } from '../../integration/helpers/mace-report.js';

function reportOptions(diskTier = 'medium') {
  return {
    generatedAt: '2026-08-12T00:00:00Z',
    cloud: 'gcp',
    workloadId: `mace-${diskTier}`,
    image: 'example@sha256:abc',
    vmType: 'g2-standard-4',
    requestedRegion: 'us-east4',
    requestedZone: 'c',
    diskSizeGb: 100,
    diskTier,
    deliveryPath: 'containerd-transfer',
  };
}

describe('MACE timing reports', () => {
  it('selects the final successful attempt and reports phase boundaries', () => {
    const status = {
      workload: { state: 'completed' },
      vms: [{ region: 'us-west4' }, { region: 'us-east4' }],
      events: [
        { id: 1, state: 'queued', createdAt: 900, metadata: null },
        { id: 2, state: 'provisioning', createdAt: 2_000, metadata: null },
        {
          id: 3,
          state: 'retrying',
          createdAt: 3_000,
          metadata: { diagnosis: 'capacity-exhausted' },
        },
        { id: 4, state: 'queued', createdAt: 3_200, metadata: null },
        { id: 5, state: 'provisioning', createdAt: 4_000, metadata: null },
        {
          id: 6,
          state: 'provisioning',
          createdAt: 4_250,
          metadata: { reason: 'active-step-replay' },
        },
        { id: 7, state: 'initializing', createdAt: 6_000, metadata: null },
        { id: 8, state: 'downloading', createdAt: 7_000, metadata: null },
        { id: 9, state: 'starting', createdAt: 9_000, metadata: null },
        { id: 10, state: 'running', createdAt: 12_000, metadata: null },
      ],
    };
    const observer = {
      observerArmedAtMs: 1_000,
      firstInferenceLogObservedAtMs: 11_000,
      marker: {
        payload: { elapsed_s: 0.25, device: 'cuda', energy: -1.5 },
      },
    };

    const report = buildMaceReport(status, observer, reportOptions());

    expect(report.reportType).toBe('mace-timing');
    expect(report.schemaVersion).toBe(2);
    expect(report.observedRegion).toBe('us-east4');
    expect(report.vmAttempts).toBe(2);
    expect(report.retryEvents).toBe(1);
    expect(report.capacityRetryEvents).toBe(1);
    expect(report.firstInference).toMatchObject({
      totalSeconds: 10,
      successfulAttemptSeconds: 7,
      preSuccessfulAttemptSeconds: 3,
      phases: {
        provisioningSeconds: 2,
        initializingSeconds: 1,
        downloadingSeconds: 2,
        syncingSeconds: null,
        startToFirstInferenceSeconds: 2,
      },
    });
    expect(report.provisioningAttempts).toHaveLength(2);
    expect(report.provisioningAttempts[0]).toMatchObject({
      durationSeconds: 1,
      outcome: 'retrying',
    });
    expect(report.provisioningAttempts[1]).toMatchObject({
      eventId: 5,
      eventIds: [5, 6],
      startedAt: 4_000,
      lastProvisioningEventAt: 4_250,
      durationSeconds: 2,
      outcome: 'initializing',
    });
    expect(report.eventTimeline).toHaveLength(10);
  });

  it('separates an optional syncing phase from image download', () => {
    const report = buildMaceReport(
      {
        workload: { state: 'completed' },
        events: [
          { id: 1, state: 'provisioning', createdAt: 1_000 },
          { id: 2, state: 'initializing', createdAt: 2_000 },
          { id: 3, state: 'downloading', createdAt: 3_000 },
          { id: 4, state: 'syncing', createdAt: 5_000 },
          { id: 5, state: 'starting', createdAt: 8_000 },
        ],
      },
      {
        observerArmedAtMs: 500,
        firstInferenceLogObservedAtMs: 10_000,
        marker: { payload: {} },
      },
      reportOptions(),
    );

    expect(report.firstInference.phases).toMatchObject({
      downloadingSeconds: 2,
      syncingSeconds: 3,
      startToFirstInferenceSeconds: 2,
    });
  });

  it('retains failed attempts without inventing a successful boundary', () => {
    const report = buildMaceReport(
      {
        workload: { state: 'retrying' },
        events: [
          { id: 1, state: 'provisioning', createdAt: 1_000 },
          {
            id: 2,
            state: 'provisioning',
            createdAt: 1_100,
            metadata: { reason: 'active-step-replay' },
          },
          {
            id: 3,
            state: 'retrying',
            createdAt: 2_000,
            metadata: { diagnosis: 'capacity-exhausted' },
          },
        ],
      },
      { observerArmedAtMs: 500 },
      reportOptions('high'),
    );

    expect(report.provisioningAttempts).toHaveLength(1);
    expect(report.provisioningAttempts[0]).toMatchObject({
      eventIds: [1, 2],
      durationSeconds: 1,
      outcome: 'retrying',
    });
    expect(report.firstInference).toMatchObject({
      totalSeconds: null,
      successfulAttemptSeconds: null,
      preSuccessfulAttemptSeconds: null,
      boundaries: { successfulProvisioningAtMs: null },
    });
  });

  it('keeps the per-attempt build CLI on its existing helper path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mace-build-'));
    try {
      const status = {
        workload: { state: 'completed' },
        events: [
          { state: 'provisioning', createdAt: 1000 },
          { state: 'initializing', createdAt: 2000 },
        ],
      };
      const observer = {
        observerArmedAtMs: 500,
        firstInferenceLogObservedAtMs: 3000,
      };
      writeFileSync(join(directory, 'status.json'), JSON.stringify(status));
      writeFileSync(join(directory, 'observer.json'), JSON.stringify(observer));
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'test/integration/helpers/mace-report.ts',
          'build',
          '--status',
          join(directory, 'status.json'),
          '--observer',
          join(directory, 'observer.json'),
          '--generated-at',
          '2026-08-12T00:00:00Z',
          '--cloud',
          'gcp',
          '--workload-id',
          'mace-medium',
          '--image',
          'example@sha256:abc',
          '--vm-type',
          'g2-standard-4',
          '--region',
          'us-east4',
          '--zone',
          'c',
          '--disk-size-gb',
          '100',
          '--disk-tier',
          'medium',
          '--delivery-path',
          'containerd-transfer',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        buildMaceReport(status, observer, reportOptions()),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
