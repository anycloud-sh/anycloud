import { describe, expect, it } from 'vitest';
import { checkProductionOwnerSizes } from '../../../scripts/check-production-owner-sizes.mjs';

describe('production owner size ceilings', () => {
  it('accepts files at their exact ceilings and rejects growth beyond them', () => {
    const files = {
      'owner.ts': 'line\n'.repeat(2),
      'other.ts': 'line\n',
    };
    const readFile = (file) => files[file];
    expect(
      checkProductionOwnerSizes(readFile, { 'owner.ts': 2, 'other.ts': 1 }),
    ).toEqual([]);
    expect(
      checkProductionOwnerSizes(readFile, { 'owner.ts': 1, 'other.ts': 1 }),
    ).toEqual([
      'owner.ts: 2 lines exceeds the 1-line owner ceiling. Split the file ' +
        'along its responsibilities, or, if the growth is justified, raise ' +
        'its ceiling in this PR with the rationale in the comment beside it ' +
        'in scripts/check-production-owner-sizes.mjs.',
    ]);
  });

  it('requires a split issue or a shared responsibility above 800 lines', () => {
    const readFile = () => 'line\n';
    expect(
      checkProductionOwnerSizes(readFile, {
        'at-800.ts': 800,
        'split.ts': { ceiling: 801, split: '#42' },
        'whole.ts': { ceiling: 801, whole: 'one transaction owner for X' },
      }),
    ).toEqual([]);
    expect(
      checkProductionOwnerSizes(readFile, {
        'bare.ts': 801,
        'bad-split.ts': { ceiling: 801, split: '1594' },
        'blank-whole.ts': { ceiling: 801, whole: ' ' },
        'non-string-whole.ts': { ceiling: 801, whole: true },
      }),
    ).toEqual(
      ['bare.ts', 'bad-split.ts', 'blank-whole.ts', 'non-string-whole.ts'].map(
        (file) =>
          `${file}: its 801-line ceiling is above 800, so it needs ` +
          "split: '#N' (an open split issue) or whole: '<the shared " +
          "responsibility>' in scripts/check-production-owner-sizes.mjs.",
      ),
    );
    expect(
      checkProductionOwnerSizes(readFile, {
        'misspelled.ts': { celing: 801, split: '#42' },
      }),
    ).toEqual(['misspelled.ts: its entry needs a numeric ceiling.']);
  });
});
