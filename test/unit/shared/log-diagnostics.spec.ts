import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_TAIL_CHARS,
  collectDiagnosticSections,
  diagnosticDedupeKey,
  errorForDiagnosticMetadata,
  normalizeLogText,
} from '../../../src/shared/log-diagnostics';

describe('normalizeLogText', () => {
  it('returns null for null, undefined, empty, and whitespace-only input', () => {
    expect(normalizeLogText(null)).toBeNull();
    expect(normalizeLogText(undefined)).toBeNull();
    expect(normalizeLogText('')).toBeNull();
    expect(normalizeLogText('   \n  \n')).toBeNull();
  });

  it('strips ANSI escapes and normalizes CRLF/CR to LF', () => {
    expect(normalizeLogText('\u001b[31mred\u001b[0m\r\nplain\r\n')).toBe(
      'red\nplain',
    );
    expect(normalizeLogText('a\rb')).toBe('a\nb');
  });

  it('collapses runs of 3+ blank lines into a single blank line', () => {
    expect(normalizeLogText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('keeps the tail and drops the head when text exceeds DIAGNOSTIC_TAIL_CHARS', () => {
    // Total length 4108 (> 4000). slice(-4000) keeps only the final 4000
    // UTF-16 code units, which include END but drop the leading HEAD marker.
    const input = `HEAD\n${'x'.repeat(4100)}END`;
    const result = normalizeLogText(input);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(DIAGNOSTIC_TAIL_CHARS);
    expect(result).toContain('END');
    expect(result).not.toContain('HEAD');
  });

  it('respects an explicit tailChars override', () => {
    expect(normalizeLogText('abcdef', { tailChars: 3 })).toBe('def');
  });

  describe('maxLines boundary at exactly 120 lines', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line${i}`).join('\n');

    it('keeps all 120 lines when maxLines === 120', () => {
      const result = normalizeLogText(lines, { maxLines: 120 });
      const out = result?.split('\n') ?? [];
      expect(out).toHaveLength(120);
      expect(out[0]).toBe('line0');
      expect(out[119]).toBe('line119');
    });

    it('drops the first line when maxLines === 119', () => {
      const result = normalizeLogText(lines, { maxLines: 119 });
      const out = result?.split('\n') ?? [];
      expect(out).toHaveLength(119);
      expect(out[0]).toBe('line1');
      expect(out[118]).toBe('line119');
    });

    it('keeps all available lines when maxLines === 121', () => {
      const result = normalizeLogText(lines, { maxLines: 121 });
      const out = result?.split('\n') ?? [];
      expect(out).toHaveLength(120);
      expect(out[0]).toBe('line0');
    });
  });

  describe('multibyte / UTF-16 slice semantics', () => {
    // normalizeLogText truncates with String.prototype.slice, so tailChars is
    // measured in UTF-16 code units (not Unicode code points): a surrogate pair
    // counts as two. These tests pin that behavior down.
    it('slices on UTF-16 code units, keeping a surrogate pair intact on an even boundary', () => {
      // U+1F600 is one code POINT but two UTF-16 code UNITS (0xD83D 0xDE00).
      // 2100 emoji = 4200 units. slice(-4000) lands on a pair boundary, so the
      // result is 4000 units and starts with an intact high surrogate.
      const input = '\u{1F600}'.repeat(2100);
      expect(input.length).toBe(4200);
      const result = normalizeLogText(input);
      expect(result?.length).toBe(DIAGNOSTIC_TAIL_CHARS);
      expect(result?.charCodeAt(0)).toBe(0xd83d); // intact high surrogate
    });

    it('can split a surrogate pair when the boundary falls mid-pair, leaving a lone low surrogate', () => {
      // 2000 emoji (4000 units) + 'C' (1 unit) = 4001 units. slice(-4000) drops
      // exactly one leading high surrogate, leaving a lone low surrogate first.
      // .trim() does not strip lone surrogates (they are not whitespace).
      const input = `${'\u{1F600}'.repeat(2000)}C`;
      expect(input.length).toBe(4001);
      const result = normalizeLogText(input);
      expect(result?.length).toBe(DIAGNOSTIC_TAIL_CHARS);
      expect(result?.charCodeAt(0)).toBe(0xde00); // lone low surrogate
      expect(result?.endsWith('C')).toBe(true);
    });
  });
});

describe('diagnosticDedupeKey', () => {
  it('does not truncate (uses Infinity tailChars)', () => {
    const huge = 'z'.repeat(9000);
    expect(diagnosticDedupeKey(huge)).toHaveLength(9000);
  });

  it('produces equal keys for ANSI/CRLF variants of the same content', () => {
    expect(diagnosticDedupeKey('\u001b[31mfoo\u001b[0m\r\nbar')).toBe(
      diagnosticDedupeKey('foo\nbar'),
    );
  });

  it('returns an empty string for empty input', () => {
    expect(diagnosticDedupeKey('')).toBe('');
    expect(diagnosticDedupeKey('   ')).toBe('');
  });
});

describe('collectDiagnosticSections', () => {
  it('groups Docker output and Command output into separate sections', () => {
    expect(
      collectDiagnosticSections({
        pullStderr: 'denied',
        stdout: 'app crashed',
        stderr: 'stack trace',
      }),
    ).toEqual([
      { label: 'Docker output', text: 'denied' },
      // Command output joins fields in declared order: logTail, stderr, stdout.
      { label: 'Command output', text: 'stack trace\napp crashed' },
    ]);
  });

  it('dedupes identical fields within a group', () => {
    expect(
      collectDiagnosticSections({ stderr: 'same out', stdout: 'same out' }),
    ).toEqual([{ label: 'Command output', text: 'same out' }]);
  });

  it('dedupes identical text across sections, keeping the first', () => {
    expect(
      collectDiagnosticSections({
        pullStdout: 'identical',
        logTail: 'identical',
      }),
    ).toEqual([{ label: 'Docker output', text: 'identical' }]);
  });

  it('returns an empty array for non-objects and inputs with no matching fields', () => {
    expect(collectDiagnosticSections(null)).toEqual([]);
    expect(collectDiagnosticSections('a string')).toEqual([]);
    expect(collectDiagnosticSections({ foo: 'bar' })).toEqual([]);
  });
});

describe('errorForDiagnosticMetadata zero scalars', () => {
  it('preserves exitCode: 0 and elapsedMs: 0 as 0 (not dropped as falsy)', () => {
    const error = Object.assign(new Error('clean exit'), {
      name: 'SSHExecError',
      exitCode: 0,
      elapsedMs: 0,
    });

    expect(errorForDiagnosticMetadata(error)).toEqual({
      message: 'clean exit',
      name: 'SSHExecError',
      exitCode: 0,
      elapsedMs: 0,
    });
  });
});
