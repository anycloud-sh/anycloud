import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

interface Step {
  if?: string;
  run?: string;
}
interface Workflow {
  on?: Record<string, unknown> | string | string[];
  jobs?: Record<string, { if?: string; steps?: Step[] }>;
}

const scripts = (
  JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The CONTRIBUTING.md mapping: these two workflows own `yarn verify` in CI. */
const VERIFY_WORKFLOWS = ['style.yml', 'tests.yml'];

/** The only accepted job gate: fork and Dependabot PRs run on hosted runners. */
const FORK_BACKEND_GATE =
  "vars.CI_BACKEND == 'hosted' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]')";

/** `yarn verify` components that no ungated pull_request step runs. */
function uncoveredVerifyChecks(
  verify: string,
  workflows: Record<string, string>,
): string[] {
  const components = verify
    .split('&&')
    .map((part) => /^yarn ([\w:-]+)$/.exec(part.trim())?.[1] ?? part.trim());
  const runs = VERIFY_WORKFLOWS.map((name) =>
    loadYaml<Workflow>(workflows[name] ?? ''),
  )
    .filter(({ on } = {}) =>
      typeof on === 'string' || Array.isArray(on)
        ? [on].flat().includes('pull_request')
        : on !== undefined && 'pull_request' in on,
    )
    .flatMap(({ jobs }) => Object.values(jobs ?? {}))
    .filter((job) => job.if === undefined || job.if === FORK_BACKEND_GATE)
    .flatMap(({ steps }) => steps ?? [])
    .filter((step) => step.if === undefined)
    .map(({ run }) => run ?? '');
  return components.filter(
    (component) =>
      !runs.some((run) =>
        new RegExp(`(^|\\s)yarn ${component}(\\s|$)`, 'm').test(run),
      ),
  );
}

const STYLE_FIXTURE = `
on:
  pull_request:
    branches: [main]
jobs:
  style:
    steps:
      - run: yarn check:boundaries
      - run: yarn style
`;
const TESTS_FIXTURE = `
on: [pull_request]
jobs:
  test:
    if: >-
      ${FORK_BACKEND_GATE}
    steps:
      - run: yarn build
      - run: |
          if [ "$CI_BACKEND" = hosted ]; then
            yarn test
          else
            yarn test:ci-backmesh
          fi
`;
const VERIFY = 'yarn check:boundaries && yarn build && yarn style && yarn test';

describe('yarn verify CI parity', () => {
  it('runs every yarn verify check in the Style and CI workflows', () => {
    const uncovered = uncoveredVerifyChecks(
      scripts.verify,
      Object.fromEntries(
        VERIFY_WORKFLOWS.map((name) => [
          name,
          readFileSync(`.github/workflows/${name}`, 'utf8'),
        ]),
      ),
    );
    expect(
      uncovered,
      `yarn verify runs ${uncovered.map((check) => `"yarn ${check}"`).join(', ')}, ` +
        'but no ungated pull_request step in .github/workflows/style.yml or ' +
        'tests.yml runs it. Add the step there, or remove it from verify, and ' +
        'update the CI mapping in CONTRIBUTING.md.',
    ).toEqual([]);
  });

  it('accepts workflows that run every verify component', () => {
    expect(
      uncoveredVerifyChecks(VERIFY, {
        'style.yml': STYLE_FIXTURE,
        'tests.yml': TESTS_FIXTURE,
      }),
    ).toEqual([]);
  });

  it('rejects dropped, gated, and prefixed steps, and new components', () => {
    expect(
      uncoveredVerifyChecks(`${VERIFY} && yarn check:new`, {
        'style.yml': STYLE_FIXTURE.replace('      - run: yarn style\n', ''),
        'tests.yml': TESTS_FIXTURE.replace(
          '      - run: yarn build\n',
          '      - if: always()\n        run: yarn build\n',
        ).replace('yarn test\n', 'true\n'),
      }),
    ).toEqual(['build', 'style', 'test', 'check:new']);
  });

  it('rejects other job gates, non-PR triggers, and other workflows', () => {
    expect(
      uncoveredVerifyChecks(VERIFY, {
        'style.yml': STYLE_FIXTURE.replace(
          /on:[\s\S]*?jobs:/,
          'on: workflow_dispatch\njobs:',
        ),
        'tests.yml': TESTS_FIXTURE.replace(
          FORK_BACKEND_GATE,
          'github.event.pull_request.draft == false',
        ),
        'integration.yml': STYLE_FIXTURE,
      }),
    ).toEqual(['check:boundaries', 'build', 'style', 'test']);
  });

  it('runs the same unit test set on backmesh runners, with fewer workers', () => {
    expect(
      scripts['test:ci-backmesh']?.replace('--maxWorkers=2', '--maxWorkers=4'),
    ).toBe(scripts.test);
  });
});
