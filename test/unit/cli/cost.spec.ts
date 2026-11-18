import { describe, it, expect } from 'vitest';
import { parsePeriod } from '../../../src/cli/commands/cost';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('parsePeriod', () => {
  it('parses days', () => {
    expect(parsePeriod('30d')).toBe(30 * DAY_MS);
    expect(parsePeriod('7d')).toBe(7 * DAY_MS);
    expect(parsePeriod('90d')).toBe(90 * DAY_MS);
    expect(parsePeriod('1d')).toBe(DAY_MS);
  });

  it('rejects "all" (no all-time period)', () => {
    expect(() => parsePeriod('all')).toThrow('Invalid period');
  });

  it('rejects hours', () => {
    expect(() => parsePeriod('24h')).toThrow('Invalid period');
  });

  it('rejects invalid formats', () => {
    expect(() => parsePeriod('abc')).toThrow('Invalid period');
    expect(() => parsePeriod('')).toThrow('Invalid period');
    expect(() => parsePeriod('30')).toThrow('Invalid period');
  });

  it('rejects periods outside the server-supported 1..90 day window', () => {
    expect(() => parsePeriod('0d')).toThrow('1d to 90d');
    expect(() => parsePeriod('91d')).toThrow('1d to 90d');
    expect(() => parsePeriod(`${Number.MAX_SAFE_INTEGER}d`)).toThrow(
      'Invalid period',
    );
  });
});
