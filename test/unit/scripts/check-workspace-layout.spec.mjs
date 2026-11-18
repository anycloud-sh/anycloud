import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectRepository,
  validateWorkspaceLayout,
} from '../../../scripts/check-workspace-layout.mjs';

const completeReadme = `# Example

- Status: Active
- Decision record: [RFC](../../rfcs/example.md)
- Run: \`npx tsx experiments/example/run.ts\`

## Promotion criteria

Promote it.

## Deletion criteria

Delete it.
`;

describe('repository layout boundary', () => {
  it('runs executable ownership from the real layout entrypoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-owner-'));
    try {
      execFileSync('git', ['init', '--quiet', root]);
      const files = {
        'package.json': JSON.stringify({
          scripts: {
            'test:unowned': 'node test/integration/helpers/unowned.mjs',
          },
        }),
        'eslint.config.mjs':
          'const grandfatheredIntegrationTests = []; const lowerLayerIntegrationTests = [];',
        'tsconfig.tooling.json': JSON.stringify({
          include: ['experiments/**/*.ts'],
        }),
        'test/integration/helpers/unowned.mjs':
          'console.log("standalone qualification");',
      };
      for (const [path, source] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), source);
      }
      expect(inspectRepository(root)).toContainEqual(
        expect.stringContaining(
          'package.json#test:unowned: test/integration/helpers/unowned.mjs is a helper library',
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('accepts owned test commands, scripts, and documented experiments', () => {
    expect(
      validateWorkspaceLayout({
        packageScripts: {
          'test:example': 'vitest run test/integration/example.spec.ts',
        },
        scriptPaths: ['check-workspace-layout.mjs', 'ci/setup-runtime.ts'],
        experiments: [
          {
            name: 'example',
            files: ['README.md', 'run.ts'],
            readme: completeReadme,
          },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects an empty decision record', () => {
    expect(
      validateWorkspaceLayout({
        packageScripts: {},
        scriptPaths: [],
        experiments: [
          {
            name: 'example',
            files: ['README.md', 'run.ts'],
            readme: completeReadme.replace(
              '- Decision record: [RFC](../../rfcs/example.md)',
              '- Decision record:',
            ),
          },
        ],
      }),
    ).toEqual(['experiments/example/README.md is missing decision record.']);
  });

  it('rejects test commands that execute scripts', () => {
    const violations = validateWorkspaceLayout({
      packageScripts: {
        'test:bad': 'tsx scripts/local-e2e.ts',
        'release:ok': 'node scripts/release.js',
      },
      scriptPaths: [],
      experiments: [],
    });

    expect(violations).toEqual([
      expect.stringContaining('test:bad executes a file under scripts/'),
    ]);
  });

  it.each(['spike-provider.ts', 'probe-storage.js', 'cleanup-provider-e2e.ts'])(
    'rejects misplaced script %s',
    (path) => {
      const violations = validateWorkspaceLayout({
        packageScripts: {},
        scriptPaths: [path],
        experiments: [],
      });

      expect(violations).toEqual([expect.stringContaining(`scripts/${path}`)]);
    },
  );

  it('requires every experiment lifecycle field and run entrypoint', () => {
    const violations = validateWorkspaceLayout({
      packageScripts: {},
      scriptPaths: [],
      experiments: [{ name: 'unfinished', files: [], readme: '# Unfinished' }],
    });

    expect(violations).toHaveLength(6);
    expect(violations).toContain(
      'experiments/unfinished is missing its run.ts entrypoint.',
    );
    expect(violations).toContain(
      'experiments/unfinished/README.md is missing decision record.',
    );
  });
});
