#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MB = 1024 * 1024;
// A few post-warmup samples fit GC sawtooth noise, not growth, so the heap
// slope fails only when the fitted window is long and dense enough.
const MIN_HEAP_SLOPE_WINDOW_SEC = 55;
const MIN_HEAP_SLOPE_WINDOW_SAMPLES = 5;

function die(message) {
  throw new Error(message);
}

function numberEnv(name, min, max = Infinity) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    die(
      `${name} must be a number >= ${min}${max === Infinity ? '' : ` and <= ${max}`}`,
    );
  }
  return value;
}

export function parseMemoryRows(text, file = 'memory ndjson') {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        die(`Malformed memory sample JSON in ${file}:${index + 1}: ${detail}`);
      }
    });
}

export function readMemoryRows(file) {
  return parseMemoryRows(readFileSync(file, 'utf8'), file);
}

function maxConsecutiveErrors(rows) {
  let current = 0;
  let max = 0;
  for (const row of rows) {
    if (row?.error) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function postWarmup(samples, warmupSec) {
  return samples.filter((sample) => sample.elapsedSec >= warmupSec);
}

function slopeMbPerMin(samples, field, warmupSec) {
  let window = postWarmup(samples, warmupSec);
  if (window.length < 3) window = samples;
  if (window.length < 3) return 0;

  const xs = window.map((sample) => sample.elapsedSec / 60);
  const ys = window.map((sample) => sample[field] / MB);
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

export function analyzeMemoryBudget(rows, options) {
  const errors = rows.filter((row) => row?.error);
  const samples = rows.filter(
    (row) =>
      Number.isFinite(row?.elapsedSec) &&
      Number.isFinite(row?.rssBytes) &&
      Number.isFinite(row?.heapUsedBytes),
  );
  const failures = [];
  const warnings = [];
  const sampleErrorRate = rows.length === 0 ? 0 : errors.length / rows.length;
  const maxSampleErrorStreak = maxConsecutiveErrors(rows);

  if (samples.length === 0) {
    failures.push('No valid memory samples');
  }

  if (maxSampleErrorStreak > options.maxConsecutiveSampleErrors) {
    failures.push(
      `memory sample error streak ${maxSampleErrorStreak} > ${options.maxConsecutiveSampleErrors}`,
    );
  }

  if (
    errors.length > options.maxTransientSampleErrors &&
    sampleErrorRate > options.maxSampleErrorRate
  ) {
    failures.push(
      `memory sample errors ${errors.length}/${rows.length} (${(sampleErrorRate * 100).toFixed(1)}%) > ${options.maxTransientSampleErrors} transient errors and > ${(options.maxSampleErrorRate * 100).toFixed(1)}% rate`,
    );
  }

  let stats = {
    samples: samples.length,
    errors: errors.length,
    maxConsecutiveErrors: maxSampleErrorStreak,
    sampleErrorRate,
    maxRssMb: 0,
    maxHeapMb: 0,
    maxCgroupMb: null,
    rssSlopeMbPerMin: 0,
    heapSlopeMbPerMin: 0,
  };

  if (samples.length > 0) {
    const max = (field) => Math.max(...samples.map((sample) => sample[field]));
    const cgroupSamples = samples
      .map((sample) => sample.cgroupMemoryBytes)
      .filter(Number.isFinite);

    stats = {
      ...stats,
      maxRssMb: max('rssBytes') / MB,
      maxHeapMb: max('heapUsedBytes') / MB,
      maxCgroupMb:
        cgroupSamples.length > 0 ? Math.max(...cgroupSamples) / MB : null,
      rssSlopeMbPerMin: slopeMbPerMin(samples, 'rssBytes', options.warmupSec),
      heapSlopeMbPerMin: slopeMbPerMin(
        samples,
        'heapUsedBytes',
        options.warmupSec,
      ),
    };

    if (stats.maxRssMb > options.maxRssMb) {
      failures.push(
        `max RSS ${stats.maxRssMb.toFixed(1)}MB > ${options.maxRssMb}MB`,
      );
    }
    if (stats.maxHeapMb > options.maxHeapMb) {
      failures.push(
        `max heap ${stats.maxHeapMb.toFixed(1)}MB > ${options.maxHeapMb}MB`,
      );
    }
    if (stats.rssSlopeMbPerMin > options.maxRssSlopeMbPerMin) {
      failures.push(
        `RSS slope ${stats.rssSlopeMbPerMin.toFixed(1)}MB/min > ${options.maxRssSlopeMbPerMin}MB/min after ${options.warmupSec}s warmup`,
      );
    }
    const window = postWarmup(samples, options.warmupSec);
    const windowSec =
      window.length > 0 ? window.at(-1).elapsedSec - window[0].elapsedSec : 0;
    if (stats.heapSlopeMbPerMin > options.maxHeapSlopeMbPerMin) {
      const message = `heap slope ${stats.heapSlopeMbPerMin.toFixed(1)}MB/min > ${options.maxHeapSlopeMbPerMin}MB/min after ${options.warmupSec}s warmup`;
      if (
        windowSec >= MIN_HEAP_SLOPE_WINDOW_SEC &&
        window.length >= MIN_HEAP_SLOPE_WINDOW_SAMPLES
      ) {
        failures.push(message);
      } else {
        warnings.push(
          `${message} not enforced: post-warmup window ${windowSec}s/${window.length} samples < ${MIN_HEAP_SLOPE_WINDOW_SEC}s/${MIN_HEAP_SLOPE_WINDOW_SAMPLES} samples`,
        );
      }
    }
  }

  if (errors.length > 0 && failures.length === 0) {
    warnings.push(
      `memory sampler transient errors=${errors.length} maxConsecutive=${maxSampleErrorStreak} first=${JSON.stringify(errors[0])}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    stats,
  };
}

export function formatMemorySummary(report) {
  const { stats } = report;
  const cgroupPart =
    stats.maxCgroupMb == null
      ? ''
      : ` cgroup=${stats.maxCgroupMb.toFixed(1)}MB`;
  return `memory: samples=${stats.samples} max rss=${stats.maxRssMb.toFixed(1)}MB heap=${stats.maxHeapMb.toFixed(1)}MB${cgroupPart} slopes rss=${stats.rssSlopeMbPerMin.toFixed(1)}MB/min heap=${stats.heapSlopeMbPerMin.toFixed(1)}MB/min`;
}

export function optionsFromEnv() {
  return {
    maxRssMb: numberEnv('NUKE_MAX_RSS_MB', 1),
    maxHeapMb: numberEnv('NUKE_MAX_HEAP_MB', 1),
    maxRssSlopeMbPerMin: numberEnv('NUKE_MAX_RSS_SLOPE_MB_PER_MIN', 0),
    maxHeapSlopeMbPerMin: numberEnv('NUKE_MAX_HEAP_SLOPE_MB_PER_MIN', 0),
    warmupSec: numberEnv('NUKE_MEMORY_WARMUP_SEC', 0),
    maxTransientSampleErrors: numberEnv(
      'NUKE_MEMORY_MAX_TRANSIENT_SAMPLE_ERRORS',
      0,
    ),
    maxConsecutiveSampleErrors: numberEnv(
      'NUKE_MEMORY_MAX_CONSECUTIVE_SAMPLE_ERRORS',
      0,
    ),
    maxSampleErrorRate: numberEnv('NUKE_MEMORY_MAX_SAMPLE_ERROR_RATE', 0, 1),
  };
}

export function runCli() {
  const file = process.env.NUKE_MEMORY_FILE;
  if (!file) die('NUKE_MEMORY_FILE must be set');

  const report = analyzeMemoryBudget(readMemoryRows(file), optionsFromEnv());
  const reportFile = process.env.NUKE_MEMORY_REPORT_FILE;
  if (reportFile) {
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const warning of report.warnings) {
    console.log(`warning: ${warning}`);
  }
  console.log(formatMemorySummary(report));

  if (!report.ok) {
    for (const failure of report.failures) {
      console.error(`memory gate failed: ${failure}`);
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
