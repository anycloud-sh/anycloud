import { describe, expect, it } from 'vitest';
import {
  buildWitnessTracker,
  createWitnessTracker,
  evaluateFairness,
  formatFairnessSummary,
  parseWitnessSamples,
  NON_DISPATCH_STATES,
  QUEUED_STATE,
  recordWitnessSample,
} from '../../integration/helpers/nuke-fairness.mjs';
import { WorkloadState } from '../../../src/shared/workload.js';

const sample = (
  t: number,
  rows: Array<[string, string]>,
): { t: number; workloads: Array<{ id: string; state: string }> } => ({
  t,
  workloads: rows.map(([id, state]) => ({ id, state })),
});

describe('nuke fairness gate', () => {
  it('watches the same queued state the product uses', () => {
    expect(QUEUED_STATE).toBe(WorkloadState.Queued);
  });

  it('records the first sample at which each witness left the queue', () => {
    const tracker = buildWitnessTracker([
      sample(0, [
        ['w1', 'queued'],
        ['w2', 'queued'],
      ]),
      sample(15, [
        ['w1', 'provisioning'],
        ['w2', 'queued'],
      ]),
      sample(30, [
        ['w1', 'running'],
        ['w2', 'starting'],
      ]),
    ]);
    expect(tracker.dispatchedAt).toEqual({ w1: 15, w2: 30 });
    expect(tracker.samples).toBe(3);
  });

  it('fails a witness that never left the queue, naming the last sample', () => {
    const tracker = buildWitnessTracker([
      sample(0, [['w1', 'queued']]),
      sample(600, [['w1', 'queued']]),
    ]);
    const result = evaluateFairness(tracker, {
      witnessIds: ['w1'],
      maxDispatchSeconds: 90,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('never left queued');
    expect(result.failures[0]).toContain('t=600s');
  });

  it('fails a witness that waited past the bar, and passes one inside it', () => {
    const late = buildWitnessTracker([
      sample(0, [['w1', 'queued']]),
      sample(120, [['w1', 'provisioning']]),
    ]);
    expect(
      evaluateFairness(late, { witnessIds: ['w1'], maxDispatchSeconds: 90 })
        .failures[0],
    ).toContain('waited 120s');

    const prompt = buildWitnessTracker([
      sample(0, [['w1', 'queued']]),
      sample(15, [['w1', 'provisioning']]),
    ]);
    expect(
      evaluateFairness(prompt, { witnessIds: ['w1'], maxDispatchSeconds: 90 })
        .ok,
    ).toBe(true);
  });

  it('counts a terminal state as dispatched — it left the queue to get there', () => {
    const tracker = buildWitnessTracker([
      sample(0, [['w1', 'queued']]),
      sample(30, [['w1', 'completed']]),
    ]);
    expect(evaluateFairness(tracker, { witnessIds: ['w1'] }).ok).toBe(true);
  });

  it('says so plainly when no samples were recorded at all', () => {
    const result = evaluateFairness(createWitnessTracker(), {
      witnessIds: ['w1'],
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('no samples recorded');
  });

  it('rejects a witness that left the queue by failing, not by dispatching', () => {
    for (const state of NON_DISPATCH_STATES) {
      const tracker = buildWitnessTracker([
        sample(0, [['w1', 'queued']]),
        sample(15, [['w1', state]]),
      ]);
      const result = evaluateFairness(tracker, {
        witnessIds: ['w1'],
        maxDispatchSeconds: 60,
      });
      expect(result.ok, `${state} must not read as a dispatch`).toBe(false);
      expect(result.failures[0]).toContain(`went ${state}`);
    }
  });

  it('keeps a real dispatch that later fails', () => {
    const tracker = buildWitnessTracker([
      sample(0, [['w1', 'queued']]),
      sample(15, [['w1', 'provisioning']]),
      sample(30, [['w1', 'failed']]),
    ]);
    expect(
      evaluateFairness(tracker, { witnessIds: ['w1'], maxDispatchSeconds: 60 })
        .ok,
    ).toBe(true);
  });

  it('fails closed when no witness ids were given', () => {
    const result = evaluateFairness(createWitnessTracker(), {});
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('nothing was measured');
  });

  it('ignores malformed rows instead of failing the run', () => {
    const tracker = createWitnessTracker();
    recordWitnessSample(tracker, {
      t: 5,
      workloads: [
        { id: 'w1', state: 'provisioning' },
        { id: 'no-state' },
        { state: 'provisioning' },
        null,
      ],
    });
    expect(tracker.dispatchedAt).toEqual({ w1: 5 });
  });

  it('rejects a sample with no usable timestamp', () => {
    expect(() =>
      recordWitnessSample(createWitnessTracker(), {
        t: 'later',
        workloads: [],
      }),
    ).toThrow(/non-numeric t/);
  });

  it('parses the harness JSONL and reports a readable summary', () => {
    const samples = parseWitnessSamples(
      [
        JSON.stringify(sample(0, [['w1', 'queued']])),
        '',
        JSON.stringify(sample(15, [['w1', 'provisioning']])),
      ].join('\n'),
    );
    expect(samples).toHaveLength(2);
    expect(
      formatFairnessSummary(buildWitnessTracker(samples), ['w1', 'w2']),
    ).toBe('samples=2  witness dispatch: w1=15s w2=never');
  });

  it('names the offending line when a sample is not JSON', () => {
    expect(() => parseWitnessSamples('{"t":0}\nnot-json')).toThrow(
      /sample 2 is not valid JSON/,
    );
  });
});
