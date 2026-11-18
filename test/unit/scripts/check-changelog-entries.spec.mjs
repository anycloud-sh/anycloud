import { describe, expect, it } from 'vitest';
import { validateChangelogEntryNames } from '../../../scripts/check-changelog-entries.mjs';

describe('changelog entry naming', () => {
  it('accepts pull-request numbers and the directory placeholder', () => {
    expect(
      validateChangelogEntryNames(['.gitkeep', '905.md', '975.md', '1042.md']),
    ).toEqual([]);
  });

  it('rejects an entry named for the change instead of its pull request', () => {
    const violations = validateChangelogEntryNames(['api-outage-reports.md']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'changelog-unreleased/api-outage-reports.md',
    );
    expect(violations[0]).toContain('<pr-number>.md');
  });

  it('rejects a number carrying anything beyond the digits', () => {
    expect(
      validateChangelogEntryNames([
        '975-lambda.md',
        'pr-975.md',
        '975.markdown',
      ]),
    ).toHaveLength(3);
  });

  it('rejects files that are not entries at all', () => {
    // A README here would fold into published release notes as an entry.
    expect(
      validateChangelogEntryNames(['README.md', 'notes.txt']),
    ).toHaveLength(2);
  });

  it('reports every offender, so one run fixes them all', () => {
    expect(
      validateChangelogEntryNames(['zebra.md', '905.md', 'alpha.md']),
    ).toHaveLength(2);
  });
});
