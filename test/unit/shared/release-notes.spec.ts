import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_URL,
  extractReleaseNotes,
} from '../../../src/shared/release-notes.js';

describe('release notes', () => {
  it('extracts exactly one version section', () => {
    const changelog = `# Changelog

## Unreleased

Not shipped.

## 1.2.3

### First feature

Release body.

## 1.2.2

Older body.
`;

    expect(extractReleaseNotes(changelog, '1.2.3')).toBe(
      '### First feature\n\nRelease body.',
    );
  });

  it('rejects missing, empty, and invalid release sections', () => {
    expect(() => extractReleaseNotes('## 1.2.2\n\nOld', '1.2.3')).toThrow(
      /missing/,
    );
    expect(() =>
      extractReleaseNotes('## 1.2.3\n\n## 1.2.2\n\nOld', '1.2.3'),
    ).toThrow(/empty/);
    expect(() => extractReleaseNotes('## nope\n\nBody', 'nope')).toThrow(
      /invalid release version/,
    );
  });

  it('normalizes documentation links and preserves external links', () => {
    expect(
      extractReleaseNotes(
        '## 1.2.3\n\n[Spend Controls](/platform/spend-controls) and [section](#details) and [GitHub](https://github.com/anycloud-sh).',
        '1.2.3',
      ),
    ).toBe(
      `[Spend Controls](https://anycloud.sh/platform/spend-controls) and [section](${CHANGELOG_URL}#details) and [GitHub](https://github.com/anycloud-sh).`,
    );
  });
});
