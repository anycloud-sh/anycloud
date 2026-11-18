import { describe, expect, it } from 'vitest';
import { retryAfterMs } from '../../../src/shared/retry-after.js';

const NOW = Date.parse('2026-10-12T00:33:00Z');
const at = (headers: Record<string, string>, maxMs?: number) =>
  retryAfterMs(new Headers(headers), NOW, { maxMs });

describe('retryAfterMs', () => {
  it('reads Retry-After delay-seconds', () => {
    expect(at({ 'Retry-After': '90' })).toBe(90_000);
    expect(at({ 'Retry-After': ' 1.5 ' })).toBe(1_500);
    expect(at({ 'Retry-After': '0' })).toBe(0);
  });

  it('reads a Retry-After HTTP-date relative to now', () => {
    expect(at({ 'Retry-After': 'Mon, 12 Oct 2026 00:33:45 GMT' })).toBe(45_000);
    expect(at({ 'Retry-After': 'Mon, 12 Oct 2026 00:32:00 GMT' })).toBe(0);
  });

  it("prefers Azure's millisecond headers, retry-after-ms first", () => {
    expect(
      at({
        'retry-after-ms': '250.4',
        'x-ms-retry-after-ms': '500',
        'Retry-After': '9',
      }),
    ).toBe(251);
    expect(at({ 'x-ms-retry-after-ms': '500', 'Retry-After': '9' })).toBe(500);
  });

  it('caps every form at maxMs', () => {
    expect(at({ 'Retry-After': '600' }, 120_000)).toBe(120_000);
    expect(at({ 'retry-after-ms': '600000' }, 120_000)).toBe(120_000);
    expect(
      at({ 'Retry-After': 'Mon, 12 Oct 2026 01:33:00 GMT' }, 120_000),
    ).toBe(120_000);
    expect(at({ 'Retry-After': '30' }, 120_000)).toBe(30_000);
  });

  it('ignores missing and malformed values', () => {
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
    expect(at({})).toBeUndefined();
    expect(at({ 'Retry-After': '' })).toBeUndefined();
    expect(at({ 'Retry-After': '-5' })).toBeUndefined();
    expect(at({ 'Retry-After': '2026-13' })).toBeUndefined();
    expect(at({ 'Retry-After': 'soon' })).toBeUndefined();
    expect(at({ 'retry-after-ms': 'NaN', 'Retry-After': '2' })).toBe(2_000);
    expect(at({ 'x-ms-retry-after-ms': '1e3' })).toBeUndefined();
    expect(at({ 'retry-after-ms': '9'.repeat(400), 'Retry-After': '2' })).toBe(
      2_000,
    );
    expect(at({ 'Retry-After': '9'.repeat(306) })).toBeUndefined();
  });

  it('reads SDK headers that answer undefined and keep whitespace', () => {
    const headers = new Map([
      ['retry-after', ' 7 '],
      ['x-ms-retry-after-ms', ''],
    ]);
    expect(retryAfterMs({ get: (name) => headers.get(name) }, NOW)).toBe(7_000);
  });

  it('reads lowercase header records', () => {
    expect(retryAfterMs({ 'retry-after': '3' }, NOW)).toBe(3_000);
    expect(retryAfterMs({ 'retry-after': ['3'] }, NOW)).toBeUndefined();
  });

  it('takes the longest of the named headers', () => {
    const names = ['x-a-retry-after', 'x-b-retry-after'];
    const headers = new Headers({
      'x-a-retry-after': '40',
      'x-b-retry-after': 'Mon, 12 Oct 2026 00:34:00 GMT',
      'Retry-After': '90',
    });
    expect(retryAfterMs(headers, NOW, { names })).toBe(60_000);
    expect(
      retryAfterMs(new Headers({ 'Retry-After': '9' }), NOW, { names }),
    ).toBeUndefined();
  });
});
