import { describe, expect, it } from 'vitest';
import {
  integrationTestOwners,
  validateIntegrationEntrypoints,
} from '../../../scripts/repository-policy/integration-entrypoints.mjs';

const workflow = '.github/workflows/qualification.yml';
const helper = 'test/integration/helpers/recovery';
const spec = 'test/integration/e2e/specs/recovery.spec.ts';
const experiment = 'experiments/recovery/candidate.ts';
const yaml = (run) =>
  JSON.stringify({ jobs: { qualification: { steps: [{ run }] } } });
const validate = (run, overrides = {}) =>
  validateIntegrationEntrypoints({
    files: {
      [workflow]: yaml(run),
      [helper + '.ts']: 'export const observation = 1;',
      ...overrides.files,
    },
    packageScripts: overrides.packageScripts ?? {},
    testOwners: overrides.testOwners ?? [],
    shellTests: [],
    utilities: overrides.utilities ?? [],
    toolingFiles: overrides.toolingFiles ?? [],
  });

describe('declared integration entrypoints', () => {
  it.each(['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'sh', 'py'])(
    'rejects an unowned executable with .%s',
    (extension) => {
      const path = helper + '.' + extension;
      expect(
        validate('yarn tsx "' + path + '"', { files: { [path]: '' } }),
      ).toContainEqual(expect.stringContaining(path + ' is a helper library'));
    },
  );

  it.each([
    './' + helper + '.ts --profile cpu',
    'echo preparing && QUALIFY=true npx tsx "' + helper + '.ts"',
    'result=$(node "' + helper + '.ts")',
    'node --import tsx ' + helper + '.ts',
    'node --require=' + helper + '.ts -e "console.log(1)"',
    'npx ' + helper + '.ts',
    'pnpm exec ' + helper + '.ts',
  ])('checks direct launches in shell commands: %s', (run) => {
    expect(validate(run)).toContainEqual(
      expect.stringContaining('is a helper library'),
    );
  });

  it.each([
    'timeout 300s node ' + helper + '.ts',
    'env QUALIFY=true node ' + helper + '.ts',
    'command -p node ' + helper + '.ts',
    'bash -euc "node ' + helper + '.ts"',
  ])('rejects unsupported test wrappers: %s', (run) => {
    expect(validate(run)).toContainEqual(
      expect.stringContaining('unsupported'),
    );
  });

  it.each([
    'PROGRAM="' + helper + '.ts"; node "$PROGRAM"',
    '"$WRAPPER" node ' + helper + '.ts',
    'cd test/integration/helpers && node recovery.ts',
  ])('requires a literal repository-root program: %s', (run) => {
    expect(validate(run)).toContainEqual(expect.stringContaining('entrypoint'));
  });

  it.each(['node', 'tsx', 'bash', 'node --import tsx'])(
    'rejects an alias whose program would be supplied later: %s',
    (command) => {
      expect(
        validate('yarn test:forward ' + helper + '.ts', {
          packageScripts: {
            'test:forward': 'yarn test:probe',
            'test:probe': command,
          },
        }),
      ).toContainEqual(
        expect.stringContaining(
          'a test package script must name its executable entrypoint',
        ),
      );
    },
  );

  it('checks every alias declaration without following forwarded data', () => {
    expect(
      validate('yarn test:recovery', {
        packageScripts: { 'test:recovery': 'node ' + helper + '.ts' },
      }),
    ).toContainEqual(expect.stringContaining('package.json#test:recovery:'));

    expect(
      validate('yarn report "ready; node ' + helper + '.ts"', {
        packageScripts: { report: 'node ci/report.mjs' },
        files: { 'ci/report.mjs': 'console.log(process.argv[2]);' },
      }),
    ).toEqual([]);
  });

  it('leaves wrapper internals to code review and executable tests', () => {
    expect(
      validate('node ci/report.mjs', {
        files: {
          'ci/report.mjs':
            'import { spawnSync } from "node:child_process"; spawnSync("node", ["' +
            helper +
            '.ts"]);',
        },
      }),
    ).toEqual([]);
  });

  it('checks composite actions and resolves literal matrix selections', () => {
    expect(
      validate('echo ready', {
        files: {
          '.github/actions/recovery/action.yml': JSON.stringify({
            runs: {
              using: 'composite',
              steps: [{ shell: 'bash', run: 'node ' + helper + '.ts' }],
            },
          }),
        },
      }),
    ).toContainEqual(
      expect.stringContaining('.github/actions/recovery/action.yml:'),
    );

    expect(
      validate('echo ready', {
        files: {
          [workflow]: JSON.stringify({
            jobs: {
              qualification: {
                strategy: { matrix: { provider: ['aws', 'azure'] } },
                steps: [{ run: 'yarn test:' + '$' + '{{ matrix.provider }}' }],
              },
            },
          }),
        },
        packageScripts: {
          'test:aws': 'echo ready',
          'test:azure': 'node ' + helper + '.ts',
        },
      }),
    ).toContainEqual(expect.stringContaining('package.json#test:azure:'));
  });

  it.each(['yarn "$QUALIFICATION_COMMAND"', 'yarn test:missing'])(
    'rejects an unresolved package launcher: %s',
    (run) => {
      expect(validate(run)).toContainEqual(
        expect.stringContaining('unresolved package launcher'),
      );
    },
  );

  it('preserves constrained-spec configuration and existing test owners', () => {
    const files = { [spec]: '', 'test/integration/wire.spec.ts': '' };
    expect(
      validate('yarn vitest run --config vitest.e2e.config.mts ' + spec, {
        files,
      }),
    ).toEqual([]);
    for (const command of ['node ' + spec, 'yarn vitest run ' + spec])
      expect(validate(command, { files })).toContainEqual(
        expect.stringContaining('must run through vitest.e2e.config.mts'),
      );
    expect(
      validate('yarn vitest run test/integration/wire.spec.ts', {
        files,
        testOwners: ['test/integration/wire.spec.ts'],
      }),
    ).toEqual([]);
  });

  it('permits an owned utility without maintaining a caller graph', () => {
    expect(
      validate('node ' + helper + '.ts', {
        utilities: [helper + '.ts'],
        packageScripts: { 'test:utility': 'node ' + helper + '.ts' },
      }),
    ).toEqual([]);
  });

  it.each([
    'test/integration/helpers/*',
    'test/integration/missing.ts',
    'scripts/wrong-owner.ts',
  ])('rejects broad, stale, or misplaced ownership: %s', (path) => {
    expect(validate('echo ready', { utilities: [path] })).toContainEqual(
      expect.stringContaining('existing exact file'),
    );
  });

  it('requires a documented and type-checked experiment entrypoint', () => {
    const run = 'yarn spike:recovery';
    const packageScripts = { 'spike:recovery': 'tsx ' + experiment };
    const files = {
      [experiment]: '',
      'experiments/recovery/README.md': 'Run: yarn spike:recovery',
    };
    expect(
      validate(run, { files, packageScripts, toolingFiles: [experiment] }),
    ).toEqual([]);
    expect(validate(run, { files, packageScripts })).toContainEqual(
      expect.stringContaining('tsconfig.tooling.json'),
    );
    expect(
      validate(run, {
        files: { [experiment]: '' },
        packageScripts,
        toolingFiles: [experiment],
      }),
    ).toContainEqual(
      expect.stringContaining('documented experiment run command'),
    );
  });

  it('does not execute comments, quoted examples, sources, or command lookups', () => {
    expect(
      validate(
        'echo "node ' +
          helper +
          '.ts"\n# node ' +
          helper +
          '.ts\ncat <<\\EOF\nnode ' +
          helper +
          '.ts\nEOF\nsource test/integration/helpers/library.sh\ncommand -v node',
      ),
    ).toEqual([]);
  });

  it('reuses the literal lint owner lists', () => {
    expect(
      integrationTestOwners(
        'const grandfatheredIntegrationTests = ["test/integration/a.spec.ts"]; const lowerLayerIntegrationTests = [];',
      ),
    ).toEqual(['test/integration/a.spec.ts']);
    expect(() =>
      integrationTestOwners(
        'const grandfatheredIntegrationTests = compute(); const lowerLayerIntegrationTests = [];',
      ),
    ).toThrow('exact literal path list');
  });
});
