import { describe, it, expect } from 'vitest';
import {
  firstKeyword,
  READ_ONLY_KEYWORDS,
} from '../../../src/api/services/database-domain';

describe('db route keyword guard', () => {
  it('extracts the first keyword in upper-case', () => {
    expect(firstKeyword('select * from t')).toBe('SELECT');
    expect(firstKeyword('  SELECT 1')).toBe('SELECT');
    expect(firstKeyword('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('WITH');
    expect(firstKeyword('EXPLAIN QUERY PLAN SELECT 1')).toBe('EXPLAIN');
    expect(firstKeyword('PRAGMA table_info(t)')).toBe('PRAGMA');
  });

  it('skips leading -- and /* */ comments', () => {
    expect(firstKeyword('-- comment\nSELECT 1')).toBe('SELECT');
    expect(firstKeyword('/* hi */ SELECT 1')).toBe('SELECT');
    expect(firstKeyword('  -- a\n  /* b */ \n SELECT 1')).toBe('SELECT');
  });

  it('returns empty for blank or non-keyword input', () => {
    expect(firstKeyword('')).toBe('');
    expect(firstKeyword('   ')).toBe('');
    expect(firstKeyword('1 + 1')).toBe('');
  });

  it('rejects write keywords by surfacing them for the caller to filter', () => {
    expect(firstKeyword('DELETE FROM t')).toBe('DELETE');
    expect(firstKeyword('UPDATE t SET a=1')).toBe('UPDATE');
    expect(firstKeyword('INSERT INTO t VALUES (1)')).toBe('INSERT');
    expect(firstKeyword('DROP TABLE t')).toBe('DROP');
    expect(firstKeyword('ATTACH DATABASE x AS y')).toBe('ATTACH');
    for (const w of ['DELETE', 'UPDATE', 'INSERT', 'DROP', 'ATTACH']) {
      expect(READ_ONLY_KEYWORDS.has(w)).toBe(false);
    }
  });
});
