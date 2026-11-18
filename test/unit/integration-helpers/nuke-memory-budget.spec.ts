import { describe, expect, it } from 'vitest';
import {
  analyzeMemoryBudget,
  formatMemorySummary,
  parseMemoryRows,
} from '../../integration/helpers/nuke-memory-budget.mjs';

const mb = 1024 * 1024;

const baseOptions = {
  maxRssMb: 4096,
  maxHeapMb: 2048,
  maxRssSlopeMbPerMin: 64,
  maxHeapSlopeMbPerMin: 32,
  warmupSec: 180,
  maxTransientSampleErrors: 2,
  maxConsecutiveSampleErrors: 2,
  maxSampleErrorRate: 0.05,
};

function sample(elapsedSec: number, rssMb: number, heapMb: number) {
  return {
    elapsedSec,
    rssBytes: rssMb * mb,
    heapUsedBytes: heapMb * mb,
    heapTotalBytes: (heapMb + 16) * mb,
    cgroupMemoryBytes: rssMb * mb,
  };
}

function error(elapsedSec: number, curlExit = 28) {
  return {
    elapsedSec,
    error: 'memory endpoint curl failed',
    curlExit,
  };
}

describe('nuke memory budget analyzer', () => {
  it('passes with one transient sampler error and healthy memory samples', () => {
    const report = analyzeMemoryBudget(
      [
        sample(0, 500, 220),
        sample(15, 505, 222),
        error(30),
        sample(45, 510, 224),
      ],
      baseOptions,
    );

    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('transient errors=1');
    expect(formatMemorySummary(report)).toContain('memory: samples=3');
  });

  it('fails on three consecutive sampler errors', () => {
    const report = analyzeMemoryBudget(
      [
        sample(0, 500, 220),
        error(15),
        error(30),
        error(45),
        sample(60, 510, 230),
      ],
      baseOptions,
    );

    expect(report.ok).toBe(false);
    expect(report.failures).toContain('memory sample error streak 3 > 2');
  });

  it('fails when total sampler error rate is too high', () => {
    const report = analyzeMemoryBudget(
      [
        sample(0, 500, 220),
        error(15),
        sample(30, 510, 225),
        error(45),
        sample(60, 520, 230),
        error(75),
        sample(90, 530, 235),
      ],
      baseOptions,
    );

    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain('memory sample errors 3/7');
  });

  it('fails when there are no valid samples', () => {
    const report = analyzeMemoryBudget([error(15), error(30)], baseOptions);

    expect(report.ok).toBe(false);
    expect(report.failures).toContain('No valid memory samples');
  });

  it('fails when max RSS exceeds the budget', () => {
    const report = analyzeMemoryBudget(
      [sample(0, 500, 220), sample(15, 4097, 230), sample(30, 600, 240)],
      baseOptions,
    );

    expect(report.ok).toBe(false);
    expect(report.failures).toContain('max RSS 4097.0MB > 4096MB');
  });

  it('fails when max heap exceeds the budget', () => {
    const report = analyzeMemoryBudget(
      [sample(0, 500, 220), sample(15, 600, 2049), sample(30, 650, 240)],
      baseOptions,
    );

    expect(report.ok).toBe(false);
    expect(report.failures).toContain('max heap 2049.0MB > 2048MB');
  });

  it('fails when post-warmup RSS slope exceeds the budget', () => {
    const report = analyzeMemoryBudget(
      [
        sample(0, 500, 220),
        sample(180, 500, 220),
        sample(240, 600, 225),
        sample(300, 700, 230),
      ],
      baseOptions,
    );

    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain('RSS slope 100.0MB/min > 64MB/min');
  });

  // Post-warmup heap ramp at 40MB/min: `count` samples, `stepSec` apart.
  function heapRamp(count: number, stepSec: number) {
    return [
      sample(0, 500, 220),
      ...Array.from({ length: count }, (_, i) =>
        sample(180 + i * stepSec, 500, 220 + (i * stepSec * 40) / 60),
      ),
    ];
  }

  it('fails on a heap slope over budget once the window is 55s and 5 samples', () => {
    const report = analyzeMemoryBudget(heapRamp(5, 13.75), baseOptions);

    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain('heap slope 40.0MB/min > 32MB/min');
  });

  it.each([
    ['3 samples over 30s, the flaky-run shape', 3, 15],
    ['enough seconds, too few samples', 4, 30],
    ['enough samples, too few seconds (54s)', 6, 10.8],
  ])('warns without failing on a heap slope with %s', (_, count, stepSec) => {
    const report = analyzeMemoryBudget(heapRamp(count, stepSec), baseOptions);

    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toContain('heap slope 40.0MB/min > 32MB/min');
    expect(report.warnings[0]).toContain('not enforced');
  });

  it('fails malformed NDJSON with the offending line number', () => {
    expect(() =>
      parseMemoryRows('{"elapsedSec":0}\nnot-json\n', 'samples.ndjson'),
    ).toThrow(/samples\.ndjson:2/);
  });
});
