import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCS,
  findCanonicalDocViolations,
  headingAnchors,
} from '../../../scripts/check-canonical-docs.mjs';
import { runScriptInTree } from '../../helpers/run-script-in-tree.mjs';

const tree = {
  'CONTRIBUTING.md': '# Contributing\n\n## Task context\n\n## Code review\n',
  'docs/guide.md':
    '# Guide\n\n## Update a `hosted` API!\n\n## Notes\n\n## Notes\n',
  'src/api/services/monitor.ts': '',
};
const repo = {
  // Like existsSync: files, their parent directories, and trailing slashes.
  exists: (path) =>
    Object.keys(tree).some((file) =>
      `${file}/`.startsWith(path.endsWith('/') ? path : `${path}/`),
    ),
  read: (path) => tree[path],
  commands: new Set(['verify', 'check:boundaries', 'prettier']),
};
const check = (source, path = 'RELEASE.md') =>
  findCanonicalDocViolations([{ path, source }], repo);

describe('canonical document check', () => {
  it('accepts references that resolve', () => {
    expect(
      check(
        [
          'Owners: `src/api/services/monitor.ts:12:3`, `api/services/monitor.ts`, and `src/api/services/`.',
          'Not repo paths: `/v1/workloads`, `../docs/`, `src/**/*.ts`, `monitor.ts`, `@azure/identity`, `ghcr.io/anycloud-sh/api`, `local/some-rule`.',
          'See [review](CONTRIBUTING.md#code-review), [guide](<docs/guide.md#update-a-hosted-api>),',
          '[notes](docs/guide.md?plain=1#notes-1), [line](docs/guide.md:3), and [site](https://anycloud.sh/#x).',
          'Run `yarn verify`, `yarn run check:boundaries`, `yarn prettier --write`, and `yarn why x`.',
          'Prose such as yarn anything is not a command.',
          '```sh\nyarn verify\n```',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('rejects a stranded path cited from the root or src/', () => {
    expect(
      check('Owners:\n`src/api/services/moved.ts`, `api/moved.ts`.'),
    ).toEqual(
      ['`src/api/services/moved.ts`', '`api/moved.ts`'].map(
        (token) =>
          `RELEASE.md:2: ${token} does not exist — cite the file's current path, or remove the reference.`,
      ),
    );
  });

  it('rejects a relative link to a missing file', () => {
    expect(check('[x](<docs/gone.md?plain=1>)')).toEqual([
      'RELEASE.md:1: link docs/gone.md?plain=1 does not resolve — point it at the moved file, or remove the link.',
    ]);
  });

  it('rejects links to renamed headings, in another document or its own', () => {
    expect(
      check('[a](CONTRIBUTING.md#task-brief)\n[b](#code-review)', 'AGENTS.md'),
    ).toEqual([
      "AGENTS.md:1: link CONTRIBUTING.md#task-brief names no heading in CONTRIBUTING.md — link to the heading's current anchor.",
      "AGENTS.md:2: link #code-review names no heading in AGENTS.md — link to the heading's current anchor.",
    ]);
  });

  it('rejects an unknown yarn command in inline code or a code fence', () => {
    expect(
      check(
        'Run `yarn check:graphs`.\n\n```sh\nyarn test\nyarn run lint:all\n```',
      ),
    ).toEqual(
      ['yarn check:graphs', 'yarn test', 'yarn run lint:all'].map(
        (command, i) =>
          `RELEASE.md:${[1, 4, 5][i]}: \`${command}\` names no package.json script, package binary, or Yarn command — use the script's current name.`,
      ),
    );
  });

  it('derives GitHub anchors outside code fences, numbering duplicates', () => {
    expect([
      ...headingAnchors('## A `b` c!\n```sh\n# comment\n```\n## A b c\n'),
    ]).toEqual(['a-b-c', 'a-b-c-1']);
  });

  it('fails the entrypoint on a stranded reference in a Git tree', () => {
    const files = Object.fromEntries(CANONICAL_DOCS.map((doc) => [doc, '']));
    const result = runScriptInTree(
      'scripts/check-canonical-docs.mjs',
      {
        ...files,
        'AGENTS.md': 'See `src/gone.ts`.',
        'package.json': '{"scripts":{}}',
        'node_modules/.bin/tsx': '',
      },
      { git: true },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'AGENTS.md:1: `src/gone.ts` does not exist',
    );
  });

  it('explains missing dependencies instead of failing on ENOENT', () => {
    const result = runScriptInTree(
      'scripts/check-canonical-docs.mjs',
      { 'package.json': '{}' },
      { git: true },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'node_modules/.bin is missing. Run `yarn install` first.',
    );
  });
});
