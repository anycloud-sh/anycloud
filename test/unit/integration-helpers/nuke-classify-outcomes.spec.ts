import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  analyzeApiLogSignals,
  analyzeNukeOutcomes,
  classifyWorkload,
  formatNukeOutcomeSummary,
  parseWorkloadsJson,
} from '../../integration/helpers/nuke-classify-outcomes.mjs';
import { ACTIVE_STATES as CANONICAL } from '../../../src/shared/workload.js';

describe('nuke outcome classifier', () => {
  it('classifies completed and invalid workloads from state', () => {
    expect(
      classifyWorkload({
        id: 'done',
        state: 'completed',
        latestMessage: null,
      }).category,
    ).toBe('completed');
    expect(
      classifyWorkload({
        id: 'bad',
        state: 'invalid',
        latestMessage: 'VM type is not offered',
      }).category,
    ).toBe('invalid-workload');
  });

  it('classifies queued admission messages by failure class', () => {
    expect(
      classifyWorkload({
        id: 'quota',
        state: 'queued',
        latestMessage:
          'AWS g4dn.xlarge/us-east-1 is temporarily blocked by observed regional quota exhaustion',
      }).category,
    ).toBe('quota-blocked');
    expect(
      classifyWorkload({
        id: 'capacity',
        state: 'queued',
        latestMessage:
          'Azure Standard_D2as_v5/eastus is temporarily blocked by observed capacity exhaustion',
      }).category,
    ).toBe('provider-capacity');
  });

  it('classifies terminal storage and unknown failures', () => {
    expect(
      classifyWorkload({
        id: 'storage',
        state: 'failed',
        latestMessage: 'GCS upload object failed: ERR_STREAM_PREMATURE_CLOSE',
      }).category,
    ).toBe('storage-blocked');
    expect(
      classifyWorkload({
        id: 'unknown',
        state: 'failed',
        latestMessage: null,
      }).category,
    ).toBe('failed-unknown');
  });

  it('includes missing rows and API log signals in the report', () => {
    const report = analyzeNukeOutcomes(
      [
        { id: 'a', state: 'completed', latestMessage: null },
        {
          id: 'b',
          state: 'failed',
          latestMessage: 'Operation results in exceeding quota limit',
        },
      ],
      {
        expectedCount: 4,
        apiLogText:
          'ERR_STREAM_PREMATURE_CLOSE while using shared output bucket\nFatal SQLite IOERR\n',
      },
    );

    expect(report.counts.completed).toBe(1);
    expect(report.counts['quota-blocked']).toBe(1);
    expect(report.counts.missing).toBe(2);
    expect(report.apiLogSignals.counts['storage-blocked']).toBe(1);
    expect(report.apiLogSignals.counts['api-health']).toBe(1);
    expect(formatNukeOutcomeSummary(report)).toContain('missing=2');
  });

  it('does not treat normal bucket and quota lifecycle logs as failures', () => {
    const signals = analyzeApiLogSignals(
      [
        JSON.stringify({
          level: 'INFO',
          message: 'Output bucket ready',
          id: 'nuke-run-1',
        }),
        JSON.stringify({
          level: 'INFO',
          message: 'Checkpoint bucket created',
          id: 'nuke-run-1',
        }),
        JSON.stringify({
          level: 'INFO',
          message: 'Starting quota-monitor',
          id: 'system',
        }),
        JSON.stringify({
          level: 'ERROR',
          message: 'Retryable request error',
          id: 'nuke-run-1',
          storage: 'local cache',
        }),
      ].join('\n'),
      { workloadIdPrefix: 'nuke-run-' },
    );

    expect(signals.counts['storage-blocked']).toBe(0);
    expect(signals.counts['quota-blocked']).toBe(0);
  });

  it('keeps explicit current-run API failures while excluding other jobs', () => {
    const signals = analyzeApiLogSignals(
      [
        JSON.stringify({
          level: 'WARN',
          message: 'GCS bucket upload failed',
          id: 'nuke-run-1',
        }),
        JSON.stringify({
          level: 'WARN',
          message: 'GCS bucket upload failed',
          id: 'other-run-1',
        }),
        JSON.stringify({
          level: 'INFO',
          message: 'State transition: terminated',
          id: 'nuke-run-2',
          logs: 'rclone: results.json failed to copy: permission denied',
        }),
        JSON.stringify({
          level: 'ERROR',
          message: 'Fatal SQLite IOERR',
          id: 'system',
        }),
      ].join('\n'),
      { workloadIdPrefix: 'nuke-run-' },
    );

    expect(signals.counts['storage-blocked']).toBe(2);
    expect(signals.counts['api-health']).toBe(1);
  });

  it('rejects malformed list JSON', () => {
    expect(() => parseWorkloadsJson('{bad', 'list.json')).toThrow(
      /Malformed workload list JSON in list\.json/,
    );
    expect(() => parseWorkloadsJson('{}', 'list.json')).toThrow(
      /must be an array/,
    );
  });

  it('keeps ACTIVE_STATES in sync with the canonical enum', () => {
    expect([...ACTIVE_STATES].sort()).toEqual([...CANONICAL].sort());
  });

  it('applies category precedence (storage before quota)', () => {
    expect(
      classifyWorkload({
        id: 'ambiguous',
        state: 'failed',
        latestMessage:
          'GCS upload object failed: quota exceeded for storage bucket',
      }).category,
    ).toBe('storage-blocked');
  });

  it('clamps missing to zero when the list exceeds expectedCount', () => {
    const report = analyzeNukeOutcomes(
      [
        { id: 'a', state: 'completed', latestMessage: null },
        { id: 'b', state: 'completed', latestMessage: null },
        { id: 'c', state: 'completed', latestMessage: null },
      ],
      { expectedCount: 1 },
    );
    expect(report.missing).toBe(0);
    expect(report.counts.missing).toBe(0);
  });

  it('does not let identity fields (region/vmType) invent a category', () => {
    // Cause matching runs on latestMessage only; an identifier containing a
    // keyword like "storage" or "capacity" must not be classified as a failure.
    expect(
      classifyWorkload({
        id: 'keyworded',
        state: 'failed',
        latestMessage: null,
        cloudProvider: 'aws',
        region: 'storage-zone-1',
        vmType: 'capacity-xl',
      }).category,
    ).toBe('failed-unknown');
  });

  it('buckets terminal failures with no latestMessage as failed-unknown', () => {
    // Real failed/errored rows from `list --json` carry no top-level message
    // (the API records the failure under metadata.reason/diagnosis, not
    // metadata.message), and identity fields must not leak into classification.
    // Per-workload quota/storage attribution for terminal rows comes from the
    // API-log signal channel, not from this row text.
    expect(
      classifyWorkload({
        id: 'terminal',
        state: 'failed',
        latestMessage: null,
        cloudProvider: 'aws',
        region: 'us-east-1',
        vmType: 'g4dn.xlarge',
      }).category,
    ).toBe('failed-unknown');
  });

  it('buckets terminated workloads distinctly from failures', () => {
    expect(
      classifyWorkload({
        id: 'torn-down',
        state: 'terminated',
        latestMessage: null,
      }).category,
    ).toBe('terminated');
  });

  it('distinguishes deadline snapshots from early aborts', () => {
    const workload = {
      id: 'still-running',
      state: 'running',
      latestMessage: null,
    };
    expect(
      classifyWorkload(workload, { snapshotKind: 'deadline' }).category,
    ).toBe('active-deadline');
    expect(
      classifyWorkload(workload, { snapshotKind: 'early-abort' }).category,
    ).toBe('active-at-abort');
  });

  it('includes a failed memory gate in diagnostic signals', () => {
    const report = analyzeNukeOutcomes(
      [{ id: 'done', state: 'completed', latestMessage: null }],
      {
        expectedCount: 1,
        memoryReport: {
          ok: false,
          failures: ['max RSS 4097.0MB > 4096MB'],
        },
      },
    );

    expect(report.diagnosticSignals.counts.memory).toBe(1);
    expect(report.diagnosticSignals.examples.memory).toContain('max RSS');
    expect(formatNukeOutcomeSummary(report)).toContain('memory=1');
  });
});
