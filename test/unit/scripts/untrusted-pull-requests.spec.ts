import { readdirSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  evaluateField,
  UNTRUSTED_PULL_REQUEST,
  UNTRUSTED_WORKFLOW_RUN,
  type Value,
} from '../helpers/workflow-expression';

// Fork and Dependabot pull requests run untrusted code without secrets. They
// run the secret-free checks on GitHub-hosted runners and skip the rest; no
// job they reach runs on a self-hosted runner or behind an environment. This
// checks our workflow files only: a fork's PR runs its own copy, which it can
// edit, so maintainer approval of outsider runs and the runner side's fork
// confinement are what stop an edited one.

const REPOSITORY = 'anycloud-sh/anycloud';
const BACKENDS = ['', 'backmesh', 'hosted'];
// Every trigger outside this list needs a review of who can fire it.
const TRIGGERS = [
  'push',
  'pull_request',
  'schedule',
  'workflow_dispatch',
  'workflow_call',
  'workflow_run',
];
const CLOUD_SECRET =
  /^(AWS_|AZURE_|GCP_|LAMBDA_API_KEY$|MODAL_|E2E_ANYCLOUD_LOGIN_TOKEN$)/;

type Job = {
  if?: string;
  'runs-on'?: unknown;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  needs?: string | string[];
  strategy?: { matrix?: unknown };
  environment?: unknown;
};
type Workflow = {
  on: Record<string, { inputs?: Record<string, { default?: Value }> } | null>;
  jobs: Record<string, Job>;
  permissions?: unknown;
};

function workflowFiles(): string[] {
  return readdirSync('.github/workflows')
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
}

function workflow(file: string): Workflow {
  const parsed = load(
    readFileSync(`.github/workflows/${file}`, 'utf8'),
  ) as Workflow & { true?: Workflow['on'] };
  // YAML 1.1 reads a bare `on:` key as the boolean true.
  return { ...parsed, on: parsed.on ?? parsed.true! };
}

function secretsOf(job: Job): string[] {
  const names = JSON.stringify(job).match(/secrets\.\w+/g) ?? [];
  return [...new Set(names.map((name) => name.slice('secrets.'.length)))];
}

// The fixtures fill every field a job could gate on, so a job that admits
// only forks or only their authors counts as reached.
function pullRequest(head: string, author: string): Value {
  return {
    event_name: 'pull_request',
    repository: REPOSITORY,
    ref: 'refs/pull/1/merge',
    head_ref: 'feature',
    base_ref: 'main',
    actor: author,
    triggering_actor: author,
    event: {
      pull_request: {
        number: 1,
        draft: false,
        head: {
          ref: 'feature',
          sha: 'abc',
          repo: { full_name: head, fork: head !== REPOSITORY },
        },
        base: { ref: 'main', repo: { full_name: REPOSITORY } },
        user: { login: author },
      },
    },
  };
}

const FORK = pullRequest('outsider/anycloud', 'outsider');
const DEPENDABOT = pullRequest(REPOSITORY, 'dependabot[bot]');
const SAME_REPOSITORY = pullRequest(REPOSITORY, 'depombo');

function followingRun(head: string, actor: string): Value {
  return {
    event_name: 'workflow_run',
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    actor: actor,
    triggering_actor: actor,
    event: {
      repository: { default_branch: 'main' },
      workflow_run: {
        id: 7,
        event: 'pull_request',
        conclusion: 'success',
        head_branch: 'feature',
        head_repository: { full_name: head, fork: head !== REPOSITORY },
        actor: { login: actor },
        triggering_actor: { login: actor },
      },
    },
  };
}

function matrixCombinations(matrix: unknown): Record<string, Value>[] {
  if (matrix === undefined) return [{}];
  if (typeof matrix !== 'object' || matrix === null) {
    throw new Error(`cannot expand a computed matrix: ${String(matrix)}`);
  }
  const { include = [], exclude, ...axes } = matrix as Record<string, Value[]>;
  if (exclude) throw new Error('matrix exclude is not modelled');
  const product = Object.entries(axes).reduce<Record<string, Value>[]>(
    (combinations, [key, values]) =>
      combinations.flatMap((combination) =>
        values.map((value) => ({ ...combination, [key]: value })),
      ),
    Object.keys(axes).length ? [{}] : [],
  );
  return [...product, ...(include as Record<string, Value>[])];
}

const STATUS_FUNCTION = /\b(success|failure|always|cancelled)\(/;

function expressionOf(condition: string | undefined): string {
  if (condition === undefined) return 'success()';
  const inner = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition)?.[1] ?? condition;
  return STATUS_FUNCTION.test(inner) ? inner : `success() && (${inner})`;
}

interface ReachedJob {
  id: string;
  runsOn: Value[];
  environment: Value;
  secrets: string[];
}

/**
 * The jobs an event can start, conservatively: each started job may succeed
 * or fail, so failure-path jobs (notifications, cleanups) count as reached.
 */
function reachedJobs(
  file: string,
  github: Value,
  backend: string,
  inputs: Record<string, Value> = {},
  secretsPassed = true,
): ReachedJob[] {
  const { jobs } = workflow(file);
  const vars = { CI_BACKEND: backend };
  const startable = new Map<string, boolean>();

  const needsOf = (job: Job) =>
    job.needs === undefined ? [] : [job.needs].flat();
  const canStart = (name: string): boolean => {
    if (startable.has(name)) return startable.get(name)!;
    const job = jobs[name];
    const result = ['success', 'failure'].some((outcome) => {
      const results = needsOf(job).map((need) =>
        canStart(need) ? outcome : 'skipped',
      );
      const needs = Object.fromEntries(
        needsOf(job).map((need, i) => [
          need,
          { result: results[i], outputs: {} },
        ]),
      );
      return Boolean(
        evaluate(
          expressionOf(job.if),
          { github, vars, inputs, needs },
          {
            success: () => results.every((r) => r === 'success'),
            failure: () => results.includes('failure'),
            always: () => true,
            cancelled: () => false,
          },
        ),
      );
    });
    startable.set(name, result);
    return result;
  };

  return Object.entries(jobs)
    .filter(([name]) => canStart(name))
    .flatMap(([name, job]): ReachedJob[] => {
      const context = { github, vars, inputs, needs: {} };
      if (job.uses?.startsWith('./.github/workflows/')) {
        const callee = job.uses.slice('./.github/workflows/'.length);
        const declared = workflow(callee).on.workflow_call?.inputs ?? {};
        const calleeInputs = Object.fromEntries(
          Object.entries(declared).map(([key, input]) => [
            key,
            job.with?.[key] === undefined
              ? (input.default ?? null)
              : evaluateField(job.with[key], context),
          ]),
        );
        return reachedJobs(
          callee,
          github,
          backend,
          calleeInputs,
          secretsPassed && job.secrets !== undefined,
        ).map((reached) => ({ ...reached, id: `${name} > ${reached.id}` }));
      }
      return [
        {
          id: `${file}:${name}`,
          runsOn: matrixCombinations(job.strategy?.matrix).map((matrix) =>
            evaluateField(job['runs-on'], { ...context, matrix }),
          ),
          environment: evaluateField(job.environment, context),
          secrets: secretsPassed ? secretsOf(job) : [],
        },
      ];
    });
}

function pullRequestWorkflows(): string[] {
  return workflowFiles().filter((file) => 'pull_request' in workflow(file).on);
}

/** workflow_run listeners that follow a workflow pull requests start. */
function pullRequestFollowers(): string[] {
  const names = new Set(
    pullRequestWorkflows().map(
      (file) =>
        (
          load(readFileSync(`.github/workflows/${file}`, 'utf8')) as {
            name?: string;
          }
        ).name,
    ),
  );
  return workflowFiles().filter((file) =>
    (
      workflow(file).on.workflow_run as { workflows?: string[] } | null
    )?.workflows?.some((name) => names.has(name)),
  );
}

/** Every event an outsider can cause, with the workflows it starts. */
function untrustedEvents(): [string, Value][] {
  return [
    ...pullRequestWorkflows().flatMap((file): [string, Value][] => [
      [file, FORK],
      [file, DEPENDABOT],
    ]),
    ...pullRequestFollowers().flatMap((file): [string, Value][] => [
      [file, followingRun('outsider/anycloud', 'outsider')],
      [file, followingRun(REPOSITORY, 'dependabot[bot]')],
    ]),
  ];
}

describe('routing expressions', () => {
  const route = (github: Value, backend: string) =>
    evaluate(
      `(vars.CI_BACKEND == 'hosted' || ${UNTRUSTED_PULL_REQUEST}) && 'ubuntu-latest' || 'backmesh-4'`,
      { github, vars: { CI_BACKEND: backend } },
    );

  it('sends fork and Dependabot pull requests to GitHub-hosted runners on every backend', () => {
    for (const backend of BACKENDS) {
      expect(route(FORK, backend), backend).toBe('ubuntu-latest');
      expect(route(DEPENDABOT, backend), backend).toBe('ubuntu-latest');
    }
  });

  it('keeps our own pull requests and pushes on the configured backend', () => {
    const push = { event_name: 'push', repository: REPOSITORY, event: {} };
    expect(route(SAME_REPOSITORY, 'backmesh')).toBe('backmesh-4');
    expect(route(SAME_REPOSITORY, '')).toBe('backmesh-4');
    expect(route(push, '')).toBe('backmesh-4');
    expect(route(SAME_REPOSITORY, 'hosted')).toBe('ubuntu-latest');
    expect(route(push, 'hosted')).toBe('ubuntu-latest');
  });

  it('sends only runs that follow untrusted pull requests to GitHub-hosted runners', () => {
    const follow = (github: Value) =>
      evaluate(`${UNTRUSTED_WORKFLOW_RUN} && 'ubuntu-latest' || 'backmesh-2'`, {
        github,
      });
    expect(follow(followingRun('outsider/anycloud', 'outsider'))).toBe(
      'ubuntu-latest',
    );
    expect(follow(followingRun(REPOSITORY, 'dependabot[bot]'))).toBe(
      'ubuntu-latest',
    );
    expect(follow(followingRun(REPOSITORY, 'depombo'))).toBe('backmesh-2');
    expect(follow(SAME_REPOSITORY)).toBe('backmesh-2');
  });

  it('follows GitHub expression semantics', () => {
    const context = {
      needs: { a: { result: 'success' }, b: { result: 'failure' } },
      inputs: { provider: null },
    };
    expect(evaluate("'A' == 'a'", context)).toBe(true);
    expect(evaluate("'1' == 1 && null == 0 && !''", context)).toBe(true);
    expect(evaluate("inputs.provider || 'azure'", context)).toBe('azure');
    expect(evaluate("0 || '' || null", context)).toBe(null);
    expect(evaluate("contains(needs.*.result, 'FAILURE')", context)).toBe(true);
    expect(evaluate('fromJSON(\'["x"]\')[0]', context)).toBe('x');
    expect(evaluate("format('{0}-{1}', 'a', 2)", context)).toBe('a-2');
    expect(evaluateField('${{ 1 == 1 }}', context)).toBe(true);
    expect(evaluateField('ci (${{ inputs.provider }})', context)).toBe('ci ()');
    expect(evaluateField("inputs.provider == ''", context, {}, true)).toBe(
      true,
    );
    expect(evaluateField('plain', context)).toBe('plain');
    expect(() => evaluate('a ==', context)).toThrow();
  });
});

describe('untrusted pull requests and the runs they start', () => {
  it('runs no job they reach on a self-hosted runner, behind an environment, or with a secret', () => {
    const reached = untrustedEvents().flatMap(([file, github]) =>
      BACKENDS.flatMap((backend) => reachedJobs(file, github, backend)),
    );
    for (const job of reached) {
      for (const label of job.runsOn) {
        expect(label, job.id).toMatch(/^ubuntu-[\w.-]+$/);
      }
      expect(job.environment ?? '', job.id).toBe('');
      // The read-only fixture token is withheld from these runs, which skip
      // the private clone that needs it.
      const fixture =
        job.id === 'integration.yml:e2e-cluster-local'
          ? 'E2E_PRIVATE_REPO_TOKEN'
          : undefined;
      expect(
        job.secrets.filter((s) => s !== 'GITHUB_TOKEN' && s !== fixture),
        job.id,
      ).toEqual([]);
    }
    // The secret-free checks still run for forks.
    const ids = new Set(reached.map((job) => job.id));
    for (const id of [
      'style.yml:style',
      'tests.yml:test',
      'tests.yml:generated-sdk',
      'docs.yml:verify',
      'integration.yml:e2e-cluster-local',
      'integration.yml:local-smolvm',
      'actions-storage.yml:cleanup',
    ]) {
      expect(ids, id).toContain(id);
    }
    // The Local nuke needs a backmesh-kvm-16; a hosted runner can't hold it.
    expect(ids).not.toContain('local-smolvm-nuke > nuke.yml:nuke');
  });

  it('skips the private clone exactly where the fixture token is withheld', () => {
    const { steps } = workflow('integration.yml').jobs[
      'e2e-cluster-local'
    ] as Job & { steps: { env?: Record<string, string> }[] };
    const skip = steps.find((step) => step.env?.E2E_PRIVATE_REPO_SKIP)!.env!
      .E2E_PRIVATE_REPO_SKIP;
    const run = (github: Value) => evaluateField(skip, { github });
    expect(run(FORK)).toBe('1');
    expect(run(DEPENDABOT)).toBe('1');
    expect(run(SAME_REPOSITORY)).toBe('');
  });

  it('leaves our own pull requests on backmesh, with secret jobs running', () => {
    const reached = new Map(
      pullRequestWorkflows()
        .flatMap((file) => reachedJobs(file, SAME_REPOSITORY, 'backmesh'))
        .map((job) => [job.id, job]),
    );
    expect(reached.get('tests.yml:test')?.runsOn).toEqual(['backmesh-4']);
    expect(reached.get('integration.yml:cloud-sad-tests')?.environment).toBe(
      'cloud-e2e',
    );
    expect(reached.get('tests.yml:agent-session-title')?.secrets).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
    // The Local nuke runs on backmesh and is skipped on hosted runners.
    const nuke = 'local-smolvm-nuke > nuke.yml:nuke';
    expect(reached.get(nuke)?.runsOn).toEqual(['backmesh-kvm-16']);
    expect(
      reachedJobs('integration.yml', SAME_REPOSITORY, 'hosted').map(
        (job) => job.id,
      ),
    ).not.toContain(nuke);
  });

  it('cannot start a workflow except through a pull request', () => {
    for (const file of workflowFiles()) {
      const triggers = Object.keys(workflow(file).on);
      expect(
        triggers.filter((t) => !TRIGGERS.includes(t)),
        file,
      ).toEqual([]);
    }
    // workflow_run jobs run trusted. One that follows a workflow an outsider
    // can start must run only default-branch code and take no artifact from
    // the run it follows.
    for (const file of pullRequestFollowers()) {
      const steps = Object.values(workflow(file).jobs).flatMap(
        (job) =>
          (job as { steps?: { uses?: string; with?: { ref?: string } }[] })
            .steps ?? [],
      );
      for (const step of steps) {
        expect(step.uses ?? '', file).not.toMatch(/download-artifact/);
        if (step.uses?.startsWith('actions/checkout')) {
          expect(step.with?.ref, file).toBe(
            '${{ github.event.repository.default_branch }}',
          );
        }
      }
    }
  });
});

describe('environments and permissions', () => {
  it('reads cloud credentials only in cloud-e2e and the Cloudflare token only in an environment', () => {
    for (const file of workflowFiles()) {
      for (const [name, job] of Object.entries(workflow(file).jobs)) {
        const secrets = secretsOf(job);
        const environment = evaluateField(job.environment, {
          inputs: { provider: 'aws' },
        });
        if (secrets.some((s) => CLOUD_SECRET.test(s))) {
          expect(environment, `${file}:${name}`).toBe('cloud-e2e');
        } else if (secrets.includes('CLOUDFLARE_API_TOKEN')) {
          expect(environment, `${file}:${name}`).toBe('cloudflare-deploy');
        }
      }
    }
    // A local nuke boots microVMs only, so it needs no approval.
    expect(
      evaluateField(workflow('nuke.yml').jobs.nuke.environment, {
        inputs: { provider: 'local' },
      }),
    ).toBe('');
  });

  it('declares workflow-level token permissions in every workflow', () => {
    for (const file of workflowFiles()) {
      expect(workflow(file).permissions, file).toBeDefined();
    }
  });

  it('makes the owner review every workflow change', () => {
    expect(readFileSync('.github/CODEOWNERS', 'utf8')).toMatch(
      /^\/\.github\/ @depombo$/m,
    );
  });
});
