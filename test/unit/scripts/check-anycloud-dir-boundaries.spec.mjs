import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOME_DIR_PATHS,
  findAnycloudDirViolations,
} from '../../../scripts/check-anycloud-dir-boundaries.mjs';

describe('anycloud state directory boundary', () => {
  it('flags a hardcoded state directory', () => {
    // The shape that made hosted APIs silently unable to send notifications:
    // ANYCLOUD_DIR points at the checkpoint mount, this resolves elsewhere.
    expect(
      findAnycloudDirViolations([
        {
          path: 'src/api/services/example.ts',
          source: [
            "import { homedir } from 'node:os';",
            '',
            'export function configPath() {',
            "  return join(homedir(), '.anycloud', 'example.json');",
            '}',
          ].join('\n'),
        },
      ]),
    ).toEqual(['src/api/services/example.ts:4']);
  });

  it('accepts the shared accessor', () => {
    expect(
      findAnycloudDirViolations([
        {
          path: 'src/api/services/example.ts',
          source: "return join(getAnycloudDir(), 'example.json');",
        },
      ]),
    ).toEqual([]);
  });

  it('leaves genuine home-directory paths alone', () => {
    // Cloud CLIs really do read the user's home; only Anycloud's own state
    // directory is in scope.
    expect(
      findAnycloudDirViolations([
        {
          path: 'src/cli/services/slurp/aws.ts',
          source: "return join(homedir(), '.aws');",
        },
        {
          path: 'src/cli/services/slurp/gcp.ts',
          source: "return join(homedir(), '.config', 'gcloud');",
        },
      ]),
    ).toEqual([]);
  });

  it('exempts only the reviewed paths', () => {
    const source = "join(homedir(), '.anycloud')";
    const files = ALLOWED_HOME_DIR_PATHS.map((path) => ({ path, source }));

    expect(findAnycloudDirViolations(files)).toEqual([]);
    expect(
      findAnycloudDirViolations([...files, { path: 'src/other.ts', source }]),
    ).toEqual(['src/other.ts:1']);
  });

  it('matches other spellings that reach the same directory', () => {
    expect(
      findAnycloudDirViolations([
        { path: 'src/a.ts', source: 'join(homedir(), ".anycloud")' },
        { path: 'src/b.ts', source: 'join(homedir(),`.anycloud`)' },
        { path: 'src/c.ts', source: "join(homedir() , '.anycloud')" },
      ]),
    ).toEqual(['src/a.ts:1', 'src/b.ts:1', 'src/c.ts:1']);
  });
});
