import { describe, it, expect } from 'vitest';
import { resolveListWindow } from '../../../src/cli/utils/list-window.js';
import { parseDurationMs } from '../../../src/cli/utils/duration.js';
import {
  clampListLimit,
  DEFAULT_LIST_LIMIT,
  MAX_COST_REPORT_PERIOD_MS,
  MAX_LIST_LIMIT,
  MIN_COST_REPORT_PERIOD_MS,
  normalizeCostReportSinceMs,
} from '../../../src/shared/workload-list.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('parseDurationMs', () => {
  it('parses unit-suffixed durations', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('45s')).toBe(45_000);
    expect(parseDurationMs('90m')).toBe(90 * 60_000);
    expect(parseDurationMs('24h')).toBe(24 * HOUR);
    expect(parseDurationMs('7d')).toBe(7 * DAY);
  });

  it('defaults a bare number to days', () => {
    expect(parseDurationMs('7')).toBe(7 * DAY);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDurationMs('  30d ')).toBe(30 * DAY);
  });

  it('throws on malformed input', () => {
    expect(() => parseDurationMs('soon')).toThrow(/Duration must look like/);
    expect(() => parseDurationMs('7w')).toThrow();
    expect(() => parseDurationMs('-3d')).toThrow();
    expect(() => parseDurationMs('')).toThrow();
  });
});

describe('resolveListWindow', () => {
  it('sends no limit by default (server picks) and no time bound', () => {
    expect(resolveListWindow({}, NOW)).toEqual({
      limit: undefined,
      sinceMs: undefined,
    });
  });

  it('translates --period into a started-at cutoff that only narrows', () => {
    expect(resolveListWindow({ period: '7d' }, NOW)).toEqual({
      limit: undefined,
      sinceMs: NOW - 7 * DAY,
    });
    expect(resolveListWindow({ period: '24h' }, NOW).sinceMs).toBe(
      NOW - 24 * HOUR,
    );
  });

  it('parses --limit and composes with --period', () => {
    expect(resolveListWindow({ limit: '50', period: '30d' }, NOW)).toEqual({
      limit: 50,
      sinceMs: NOW - 30 * DAY,
    });
  });

  it('passes --limit through unclamped — the server owns the cap', () => {
    expect(resolveListWindow({ limit: '99999' }, NOW).limit).toBe(99999);
  });

  it('rejects non-positive or non-integer --limit', () => {
    expect(() => resolveListWindow({ limit: '0' }, NOW)).toThrow(
      /positive integer/,
    );
    expect(() => resolveListWindow({ limit: '-5' }, NOW)).toThrow();
    expect(() => resolveListWindow({ limit: '1.5' }, NOW)).toThrow();
    expect(() => resolveListWindow({ limit: 'lots' }, NOW)).toThrow();
  });

  it('surfaces a bad --period through the duration parser', () => {
    expect(() => resolveListWindow({ period: 'whenever' }, NOW)).toThrow(
      /Duration must look like/,
    );
  });
});

describe('clampListLimit (server-side enforcement)', () => {
  it('defaults missing or non-numeric limits', () => {
    expect(clampListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(clampListLimit(NaN)).toBe(DEFAULT_LIST_LIMIT);
    expect(clampListLimit('200')).toBe(DEFAULT_LIST_LIMIT);
  });

  it('uses the caller-supplied default for absent limits (picker → cap)', () => {
    expect(clampListLimit(undefined, MAX_LIST_LIMIT)).toBe(MAX_LIST_LIMIT);
    expect(clampListLimit(NaN, MAX_LIST_LIMIT)).toBe(MAX_LIST_LIMIT);
  });

  it('floors non-positive direct calls to 1 (routes reject them)', () => {
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(-1)).toBe(1);
  });

  it('caps any positive request at MAX_LIST_LIMIT', () => {
    expect(clampListLimit(50)).toBe(50);
    expect(clampListLimit(MAX_LIST_LIMIT + 1)).toBe(MAX_LIST_LIMIT);
    expect(clampListLimit(10_000_000)).toBe(MAX_LIST_LIMIT);
  });

  it('floors a fractional positive to 1', () => {
    expect(clampListLimit(0.5)).toBe(1);
    expect(clampListLimit(0.999)).toBe(1);
    expect(clampListLimit(1.9)).toBe(1);
  });
});

describe('normalizeCostReportSinceMs', () => {
  it('accepts and preserves windows inside the 1..90 day range', () => {
    expect(normalizeCostReportSinceMs(NOW - 7 * DAY, NOW)).toBe(NOW - 7 * DAY);
  });

  it('pins small request/clock drift back to the boundary', () => {
    expect(
      normalizeCostReportSinceMs(NOW - MAX_COST_REPORT_PERIOD_MS - 1000, NOW),
    ).toBe(NOW - MAX_COST_REPORT_PERIOD_MS);
    expect(
      normalizeCostReportSinceMs(NOW - MIN_COST_REPORT_PERIOD_MS + 1000, NOW),
    ).toBe(NOW - MIN_COST_REPORT_PERIOD_MS);
  });

  it('rejects invalid and out-of-range cutoffs', () => {
    expect(normalizeCostReportSinceMs(NOW, NOW)).toBeNull();
    expect(normalizeCostReportSinceMs(NOW - 91 * DAY, NOW)).toBeNull();
    expect(normalizeCostReportSinceMs('30d', NOW)).toBeNull();
    expect(normalizeCostReportSinceMs(1.5, NOW)).toBeNull();
  });
});
