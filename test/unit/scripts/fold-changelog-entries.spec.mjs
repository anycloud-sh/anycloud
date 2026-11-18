import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listEntryFiles,
  mergeEntries,
  nextRelease,
} from '../../../scripts/ci/fold-changelog-entries.mjs';

// The repository at rest: the topmost section is the last published release,
// and package.json holds that same version.
const CHANGELOG = `---
sidebar_position: 9
---

# Changelog

## 0.1.61

### Slack notifications work on hosted APIs

They do now.
`;

// A release PR has already folded, so `## 0.1.62` is the release being cut.
const FOLDED = `# Changelog

## 0.1.62

### Cluster status and delete accept cluster names

They do.

## 0.1.61

### Slack notifications work on hosted APIs

They do now.
`;

function entry(content, path = 'changelog-unreleased/1.md') {
  return { path, content };
}

describe('nextRelease', () => {
  it('is the patch the release workflow will cut', () => {
    // release.yml runs `npm version patch`, so the target is never a choice.
    expect(nextRelease('0.1.61')).toBe('0.1.62');
    expect(nextRelease('0.2.0')).toBe('0.2.1');
    expect(nextRelease('1.9.9')).toBe('1.9.10');
  });

  it('refuses a released version that is not X.Y.Z', () => {
    expect(() => nextRelease('v0.1.61')).toThrow(/invalid released version/);
  });
});

describe('mergeEntries', () => {
  it('inserts the next release above the newest section, keeping the preamble', () => {
    const merged = mergeEntries({
      changelog: CHANGELOG,
      released: '0.1.61',
      entries: [
        entry('### Newer thing\n\nIt works.\n', 'a.md'),
        entry('### Older thing\n\nIt also works.\n', 'b.md'),
      ],
    });

    expect(merged).toContain('sidebar_position: 9');
    expect(merged.indexOf('# Changelog')).toBeLessThan(
      merged.indexOf('## 0.1.62'),
    );
    expect(merged.indexOf('## 0.1.62')).toBeLessThan(
      merged.indexOf('## 0.1.61'),
    );
    expect(merged.indexOf('### Newer thing')).toBeLessThan(
      merged.indexOf('### Older thing'),
    );
    // The published section below is left exactly as it was.
    expect(merged.slice(merged.indexOf('## 0.1.61'))).toBe(
      CHANGELOG.slice(CHANGELOG.indexOf('## 0.1.61')),
    );
  });

  it('appends into the release being cut when an entry lands after the fold', () => {
    // The release gate sends the operator back to this command, so re-running
    // it has to absorb the late entry rather than refuse the whole release.
    const merged = mergeEntries({
      changelog: FOLDED,
      released: '0.1.61',
      entries: [entry('### Late thing\n\nIt landed after the release PR.\n')],
    });

    expect(merged.match(/^## 0\.1\.62$/gm)).toHaveLength(1);
    expect(merged).toContain(
      '### Cluster status and delete accept cluster names',
    );
    expect(merged.indexOf('### Late thing')).toBeLessThan(
      merged.indexOf('## 0.1.61'),
    );
    expect(merged.slice(merged.indexOf('## 0.1.61'))).toBe(
      FOLDED.slice(FOLDED.indexOf('## 0.1.61')),
    );
  });

  it('refuses to cut a release with no entries', () => {
    expect(() =>
      mergeEntries({ changelog: CHANGELOG, released: '0.1.61', entries: [] }),
    ).toThrow(/holds no entries to release/);
  });

  it('refuses an entry carrying its own release heading', () => {
    // Such an entry would splice in a second `## ` section and quietly claim
    // every entry written below it.
    expect(() =>
      mergeEntries({
        changelog: CHANGELOG,
        released: '0.1.61',
        entries: [entry('## 0.1.99\n\n### Thing\n\nBody.\n', 'bad.md')],
      }),
    ).toThrow(/bad\.md must not contain a "## " heading/);
  });
});

describe('listEntryFiles', () => {
  it('returns nothing when the directory is absent', () => {
    expect(listEntryFiles(join(tmpdir(), 'anycloud-no-such-dir-9d3f'))).toEqual(
      [],
    );
  });

  it('orders newest first, comparing numbers as numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anycloud-changelog-entries-'));
    for (const name of ['9.md', '975.md', '105.md', 'notes.txt']) {
      writeFileSync(join(dir, name), '### Thing\n\nBody.\n', 'utf8');
    }

    expect(listEntryFiles(dir)).toEqual(['975.md', '105.md', '9.md']);

    rmSync(dir, { recursive: true, force: true });
  });
});
