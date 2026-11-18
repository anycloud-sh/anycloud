import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  UNTRUSTED_PULL_REQUEST,
  UNTRUSTED_WORKFLOW_RUN,
} from '../helpers/workflow-expression';

const HOSTED_FALLBACKS: Record<string, Record<string, string>> = {
  'actions-storage.yml': { cleanup: "'ubuntu-latest'" },
  'api-performance.yml': {
    resolve: "'ubuntu-24.04'",
    compare: "'ubuntu-24.04'",
    report: "'ubuntu-24.04'",
    'notify-slack': 'reusable:notify-slack.yml',
  },
  'base-image-canary.yml': { 'base-image-canary': "'ubuntu-latest'" },
  'build-deps-base.yml': {
    build: 'matrix.runner',
    merge: "'ubuntu-24.04'",
  },
  'catalog.yml': {
    preflight: "'ubuntu-latest'",
    refresh: "'ubuntu-latest'",
    'notify-slack': 'reusable:notify-slack.yml',
  },
  'cloudflare-ips.yml': { check: "'ubuntu-latest'" },
  'dns-worker.yml': {
    verify: "'ubuntu-24.04'",
    'dns-worker': "'ubuntu-24.04'",
  },
  'docs.yml': {
    verify: "'ubuntu-latest'",
    preview: "'ubuntu-latest'",
    deploy: "'ubuntu-latest'",
  },
  'e2e-gpu.yml': {
    'e2e-gpu-serve-vitest': "'ubuntu-latest'",
    'azure-ghcr-probe-vitest': "'ubuntu-latest'",
    'e2e-mace-vitest': "'ubuntu-latest'",
    'e2e-disk-tier-vitest': "'ubuntu-latest'",
    'post-cleanup-aws': "'ubuntu-latest'",
    'post-cleanup-azure': "'ubuntu-latest'",
    'post-cleanup-gcp': "'ubuntu-latest'",
    'post-cleanup-lambda': "'ubuntu-latest'",
    'service-native-audit': "'ubuntu-latest'",
  },
  'e2e-job.yml': {
    'e2e-job-vitest': "'ubuntu-latest'",
    'post-cleanup-aws': "'ubuntu-latest'",
    'post-cleanup-azure': "'ubuntu-latest'",
    'post-cleanup-gcp': "'ubuntu-latest'",
    'post-cleanup-lambda': "'ubuntu-latest'",
  },
  'e2e-serve.yml': {
    'e2e-serve-vitest': "'ubuntu-latest'",
    'post-cleanup-aws': "'ubuntu-latest'",
    'post-cleanup-azure': "'ubuntu-latest'",
    'post-cleanup-gcp': "'ubuntu-latest'",
    'post-cleanup-lambda': "'ubuntu-latest'",
  },
  'e2e-vm.yml': {
    'e2e-vm-vitest': "'ubuntu-latest'",
    'post-cleanup-aws': "'ubuntu-latest'",
    'post-cleanup-azure': "'ubuntu-latest'",
    'post-cleanup-gcp': "'ubuntu-latest'",
    'post-cleanup-lambda': "'ubuntu-latest'",
  },
  'install-script.yml': { deploy: "'ubuntu-24.04'" },
  'integration.yml': {
    docs: "'ubuntu-latest'",
    'integration-tests-common': "'ubuntu-24.04'",
    'vitest-e2e': "'ubuntu-24.04'",
    'credentials-onboarding-e2e': "'ubuntu-24.04'",
    'azure-onboarding-runner-loss-create': "'ubuntu-24.04'",
    'azure-onboarding-runner-loss-recover': "'ubuntu-24.04'",
    'e2e-cluster-local': "'ubuntu-24.04'",
    'cloud-sad-tests': "'ubuntu-24.04'",
    'e2e-noprovision': "'ubuntu-latest'",
    'local-smolvm': "'ubuntu-24.04'",
    'local-smolvm-nuke': 'reusable:nuke.yml',
  },
  'e2e-cluster-cloud.yml': { 'e2e-cluster-cloud': "'ubuntu-latest'" },
  'lambda-boot-failover.yml': {
    'forced-timeout': "'ubuntu-latest'",
    'cleanup-audit': "'ubuntu-latest'",
  },
  'managed-gpu-recovery.yml': {
    recover: "'ubuntu-24.04'",
    'azure-job-identity-readback': "'ubuntu-24.04'",
  },
  'mutant-parity.yml': {
    plans: "'ubuntu-latest'",
    side: "'ubuntu-latest'",
    compare: "'ubuntu-latest'",
    score: "'ubuntu-latest'",
    floors: "'ubuntu-latest'",
  },
  'mutant-survivors.yml': {
    mutate: "'ubuntu-latest'",
    comment: "'ubuntu-latest'",
  },
  'mutation.yml': { mutation: "'ubuntu-latest'" },
  'notify-slack.yml': { notify: "'ubuntu-latest'" },
  'nuke.yml': { nuke: "'ubuntu-24.04'" },
  // Release is the recovery path: GitHub-hosted whatever CI_BACKEND says.
  'release.yml': {
    'artifact-cleanup': 'trusted:actions-storage.yml',
    ...Object.fromEntries(
      [
        'prepare',
        'sdk-build',
        'sdk-qualify',
        'sdk',
        'chart',
        'docker',
        'docker-merge',
        'cli-release',
        'published-cli-canary',
        'homebrew',
        'skill',
      ].map((job) => [
        job,
        job === 'docker'
          ? 'hosted:${{ matrix.runner }}'
          : 'hosted:ubuntu-latest',
      ]),
    ),
  },
  'skills.yml': {
    validate: "'ubuntu-latest'",
    preflight: "'ubuntu-latest'",
    publish: "'ubuntu-latest'",
  },
  'slack-worker.yml': {
    verify: "'ubuntu-24.04'",
    deploy: "'ubuntu-24.04'",
  },
  'spike.yml': { experiment: "'ubuntu-24.04'" },
  'style.yml': { style: "'ubuntu-latest'" },
  'tests.yml': {
    test: "'ubuntu-latest'",
    'generated-sdk': "'ubuntu-latest'",
    'test-sdk': "'ubuntu-latest'",
    'installed-sdk': "'ubuntu-latest'",
    'credentials-integration': "'ubuntu-latest'",
    'agent-session-title': "'ubuntu-latest'",
  },
};

// Each job's backmesh label, used unless CI_BACKEND is `hosted`; unlisted
// jobs run on backmesh-4. backmesh-2 takes the short notify and cleanup
// jobs; backmesh-8 the deps base build.
// On-demand labels take the K3s local clusters and the multi-hour dispatch
// jobs, where a spot reclaim would cost more than on demand. The KVM
// labels give Local SmolVM `/dev/kvm`.
const POST_CLEANUP = {
  'post-cleanup-aws': 'backmesh-2',
  'post-cleanup-azure': 'backmesh-2',
  'post-cleanup-gcp': 'backmesh-2',
  'post-cleanup-lambda': 'backmesh-2',
};
const BACKMESH_LABELS: Record<string, Record<string, string>> = {
  'actions-storage.yml': { cleanup: 'backmesh-2' },
  'api-performance.yml': { compare: 'backmesh-od-4' },
  'build-deps-base.yml': { build: 'backmesh-8' },
  'e2e-cluster-cloud.yml': { 'e2e-cluster-cloud': 'backmesh-od-4' },
  'e2e-gpu.yml': { ...POST_CLEANUP, 'service-native-audit': 'backmesh-2' },
  'e2e-job.yml': POST_CLEANUP,
  'e2e-serve.yml': POST_CLEANUP,
  'e2e-vm.yml': POST_CLEANUP,
  'integration.yml': {
    'e2e-cluster-local': 'backmesh-od-8',
    'local-smolvm': 'backmesh-kvm-4',
  },
  'lambda-boot-failover.yml': {
    'forced-timeout': 'backmesh-od-4',
    'cleanup-audit': 'backmesh-2',
  },
  'managed-gpu-recovery.yml': {
    recover: 'backmesh-od-4',
    'azure-job-identity-readback': 'backmesh-2',
  },
  'mutant-parity.yml': {
    side: 'backmesh-od-4',
    compare: 'backmesh-od-4',
    score: 'backmesh-od-4',
  },
  'mutant-survivors.yml': { comment: 'backmesh-2' },
  'notify-slack.yml': { notify: 'backmesh-2' },
  // A local nuke boots SmolVM microVMs, 300 of them in 8 minutes on kvm-16;
  // the cloud ones run for hours.
  'nuke.yml': {
    nuke: "(inputs.provider || 'azure') == 'local' && 'backmesh-kvm-16' || 'backmesh-od-4'",
  },
};

/** The `||` branch that follows a job's hosted runner. */
function backmeshBranches(file: string, job: string): string {
  const label = BACKMESH_LABELS[file]?.[job] ?? 'backmesh-4';
  return /^[a-z0-9-]+$/.test(label) ? `'${label}'` : label;
}

function workflowSource(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

function survivorsWorkflow() {
  return load(workflowSource('mutant-survivors.yml')) as {
    jobs: Record<
      string,
      {
        steps: {
          uses?: string;
          'continue-on-error'?: boolean;
          with?: { script?: string };
        }[];
      }
    >;
  };
}

function workflowFiles(): string[] {
  return readdirSync('.github/workflows')
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
}

function jobBlocks(source: string): Map<string, string> {
  const jobsIndex = source.indexOf('\njobs:\n');
  expect(jobsIndex).toBeGreaterThanOrEqual(0);

  const jobs = source.slice(jobsIndex + 1);
  const headings = [...jobs.matchAll(/^ {2}([a-zA-Z0-9_-]+):\n/gm)];
  return new Map(
    headings.map((heading, index) => {
      const start = heading.index;
      const end = headings[index + 1]?.index ?? jobs.length;
      return [heading[1], jobs.slice(start, end)];
    }),
  );
}

describe('CI backend workflow policy', () => {
  it('routes jobs through the backend switch', () => {
    for (const [file, expectedJobs] of Object.entries(HOSTED_FALLBACKS)) {
      const jobs = jobBlocks(workflowSource(file));
      expect([...jobs.keys()], file).toEqual(Object.keys(expectedJobs));

      for (const [job, hostedFallback] of Object.entries(expectedJobs)) {
        if (hostedFallback.startsWith('trusted:')) {
          expect(jobs.get(job), `${file}:${job}`).toContain(
            `uses: anycloud-sh/anycloud/.github/workflows/${hostedFallback.slice('trusted:'.length)}@main`,
          );
          continue;
        }
        if (hostedFallback.startsWith('hosted:')) {
          expect(jobs.get(job), `${file}:${job}`).toContain(
            `runs-on: ${hostedFallback.slice('hosted:'.length)}\n`,
          );
          continue;
        }
        if (hostedFallback.startsWith('reusable:')) {
          expect(jobs.get(job), `${file}:${job}`).toContain(
            `uses: ./.github/workflows/${hostedFallback.slice('reusable:'.length)}`,
          );
          continue;
        }
        // Release's artifact cleanup asks for a hosted runner; jobs that
        // untrusted pull requests reach also run hosted for them
        // (untrusted-pull-requests.spec.ts).
        const hosted =
          file === 'actions-storage.yml'
            ? `(inputs.hosted || vars.CI_BACKEND == 'hosted' || ${UNTRUSTED_WORKFLOW_RUN})`
            : jobs.get(job)!.includes(UNTRUSTED_PULL_REQUEST)
              ? `(vars.CI_BACKEND == 'hosted' || ${UNTRUSTED_PULL_REQUEST})`
              : "vars.CI_BACKEND == 'hosted'";
        const expectedSelector =
          `runs-on: \${{ ${hosted} && ${hostedFallback} || ` +
          `${backmeshBranches(file, job)} }}`;
        expect(jobs.get(job), `${file}:${job}`).toContain(expectedSelector);
        // backmesh's image has no Yarn: the install script enables it.
        // Style enables it inline before its policy install.
        if (file === 'style.yml') continue;
        expect(jobs.get(job), `${file}:${job}`).not.toMatch(
          /^\s+(- )?(run: )?yarn install/m,
        );
      }
    }
  });

  it('covers every workflow file, so a new workflow cannot skip the switch', () => {
    expect(workflowFiles()).toEqual(Object.keys(HOSTED_FALLBACKS).sort());
  });

  it('routes every runs-on through the backend switch', () => {
    for (const file of workflowFiles()) {
      workflowSource(file)
        .split('\n')
        .forEach((line, index) => {
          if (!/^\s+runs-on:/.test(line)) return;
          const location = `${file}:${index + 1}`;
          if (file === 'release.yml') {
            expect(line.trim(), location).toMatch(
              /^runs-on: (ubuntu-latest|\$\{\{ matrix\.runner \}\})$/,
            );
            return;
          }
          expect(line, location).toContain("vars.CI_BACKEND == 'hosted'");
          expect(line, location).toMatch(/'backmesh-[a-z0-9-]+' \}\}$/);
        });
    }
  });

  it('runs no job on a GitHub-hosted macOS runner', () => {
    // macOS bills at about 10x Linux against a capped Actions budget, so the
    // owner removed the darwin launch check; darwin binaries are
    // built and signature-checked on Linux only.
    for (const file of workflowFiles()) {
      const source = workflowSource(file);
      expect(source, file).not.toMatch(/\bmacos-[\w.-]+/i);
      expect(source, file).not.toMatch(/runs-on:[^\n]*macos/i);
    }
  });

  it('uses GitHub caches only on hosted runners', () => {
    for (const file of Object.keys(HOSTED_FALLBACKS)) {
      if (file === 'release.yml') continue;
      for (const line of workflowSource(file).split('\n')) {
        if (/^\s+cache:.*yarn/.test(line) || line.includes('type=gha')) {
          expect(line, `${file}: ${line.trim()}`).toContain(
            "vars.CI_BACKEND == 'hosted'",
          );
        }
      }
    }

    const composite = readFileSync(
      '.github/actions/serve-e2e-setup/action.yml',
      'utf8',
    );
    expect(composite).toContain(
      "cache: ${{ inputs.backend == 'hosted' && 'yarn' || '' }}",
    );
  });

  it('keeps Mutant Survivors advisory, with write access only where no PR code runs', () => {
    const source = workflowSource('mutant-survivors.yml');
    expect(source).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(source).toMatch(/^permissions: \{\}$/m);
    const jobs = jobBlocks(source);
    const mutate = jobs.get('mutate')!;
    expect(mutate).toContain('permissions:\n      contents: read\n');
    expect(mutate).not.toContain('secrets.');
    const comment = jobs.get('comment')!;
    expect(comment).toContain('permissions:\n      pull-requests: write\n');
    expect(comment).not.toContain('actions/checkout');
    expect(comment).not.toContain('run:');
    const steps = Object.values(survivorsWorkflow().jobs).flatMap(
      (job) => job.steps,
    );
    // Evidence uploads fail loudly (actions-artifact-workflows.spec.ts).
    expect(
      steps.filter((step) => !step['continue-on-error']).map((s) => s.uses),
    ).toEqual(['actions/upload-artifact@v4']);
  });

  it('updates only the bot-authored Mutant Survivors comment and truncates a long report', async () => {
    const script = survivorsWorkflow().jobs.comment.steps.at(-1)!.with!.script;
    const marker = '<!-- mutant-survivors -->';
    const post = async (comments: object[], report: string) => {
      const rest = { createComment: vi.fn(), updateComment: vi.fn() };
      const context = {
        repo: { owner: 'o', repo: 'r' },
        serverUrl: 'https://github.com',
        runId: 7,
        payload: {
          pull_request: { number: 1, head: { sha: 'abcdef1234567' } },
        },
      };
      const github = { paginate: async () => comments, rest: { issues: rest } };
      const fs = { readFileSync: () => report };
      await new Function(
        'github',
        'context',
        'require',
        `return (async () => {${script}})();`,
      )(github, context, () => fs);
      return rest;
    };
    const pasted = { id: 1, user: { login: 'someone' }, body: `${marker}\nx` };
    const bot = { id: 2, user: { login: 'github-actions[bot]' }, body: marker };

    const created = await post([pasted], 'report');
    expect(created.updateComment).not.toHaveBeenCalled();
    expect(created.createComment.mock.calls[0][0].body).toBe(
      `${marker}\n### Mutant survivors on changed lines at \`abcdef123\` (advisory)\n\nreport`,
    );

    const updated = await post([pasted, bot], `${'- line\n'.repeat(20_000)}`);
    expect(updated.createComment).not.toHaveBeenCalled();
    const { comment_id, body } = updated.updateComment.mock.calls[0][0];
    expect(comment_id).toBe(2);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toMatch(
      /- line\n\n_Truncated; see the report in \[the run's artifact\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\)\._$/,
    );
  });

  it('excludes fork and Dependabot PRs from both agent canaries on either backend', () => {
    const canary = jobBlocks(workflowSource('tests.yml')).get(
      'agent-session-title',
    )!;
    const guard = canary.match(/^ {4}if: >-\n((?: {6}.+\n)+)/m)?.[1];

    expect(guard?.trim().replace(/\s+/g, ' ')).toBe(
      'github.event.pull_request.head.repo.full_name == github.repository && ' +
        "github.event.pull_request.user.login != 'dependabot[bot]'",
    );
  });

  it('selects the matching latest CLI and agent tests with independent failures', () => {
    const canary = jobBlocks(workflowSource('tests.yml')).get(
      'agent-session-title',
    )!;
    expect(canary).toContain('timeout-minutes: 10');
    expect(canary).toContain('fail-fast: false');
    expect(canary).toContain(
      "- agent: claude\n            cli: '@anthropic-ai/claude-code'",
    );
    expect(canary).toContain(
      "- agent: codex\n            cli: '@openai/codex'",
    );
    expect(canary).toContain("npm install -g '${{ matrix.cli }}@latest'");
    const steps = canary.split(/\n(?= {6}- )/);
    for (const agent of ['claude', 'codex']) {
      const execution = steps.find((step) =>
        step.includes(`if: matrix.agent == '${agent}'`),
      );
      expect(execution).toContain(
        `test/integration/agent-session-title.spec.ts -t '^${agent} ' --reporter=verbose`,
      );
    }
    expect(canary).not.toContain('continue-on-error');
    expect(canary).not.toContain('passWithNoTests');
  });

  it('exposes the Claude API key only to its conditional execution step', () => {
    const workflow = workflowSource('tests.yml');
    const canary = jobBlocks(workflow).get('agent-session-title')!;
    const secretSteps = canary
      .split(/\n(?= {6}- )/)
      .filter((step) => step.includes('secrets.'));
    expect(secretSteps).toHaveLength(1);
    expect(secretSteps[0]).toContain(
      'name: Run Claude session-title drift canary',
    );
    expect(secretSteps[0]).toContain("if: matrix.agent == 'claude'");
    expect(secretSteps[0]).toContain(
      'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
    );
    expect(canary).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(canary).not.toContain('OPENAI_API_KEY');
    expect(workflow.match(/secrets\.ANTHROPIC_API_KEY/g)).toHaveLength(1);
  });

  it('runs Integration on pull requests with the required fairness workload', () => {
    const integration = workflowSource('integration.yml');
    expect(integration).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(integration).toContain("nuke_count: '300'");
  });

  it('keeps Azure runner-loss qualification opt-in with independent recovery and no artifact handoff', () => {
    const integration = workflowSource('integration.yml');
    const jobs = jobBlocks(integration);
    const creator = jobs.get('azure-onboarding-runner-loss-create')!;
    const recovery = jobs.get('azure-onboarding-runner-loss-recover')!;
    expect(integration).toMatch(
      /azure_runner_loss:[\s\S]*?type: boolean\n\s+default: false/,
    );
    expect(creator).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.azure_runner_loss",
    );
    expect(creator).toContain('runner-loss.ts create');
    expect(recovery).toContain('needs: azure-onboarding-runner-loss-create');
    expect(recovery).toContain(
      "always() && github.event_name == 'workflow_dispatch'",
    );
    expect(recovery).toContain('actions: read');
    expect(recovery).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(
      recovery.match(/cleanup:azure-onboarding-e2e --run-recovery/g),
    ).toHaveLength(2);
    expect(`${creator}\n${recovery}`).not.toMatch(
      /(?:upload|download)-artifact|--sweep|needs\.[\w-]+\.outputs/,
    );
    expect(integration).toContain(
      "format('-azure-runner-loss-{0}', github.run_id)",
    );
  });

  it('runs the born-Vitest local cluster members as required, cleaned-up jobs', () => {
    const clusterLocal = jobBlocks(workflowSource('integration.yml')).get(
      'e2e-cluster-local',
    );
    expect(clusterLocal).toBeDefined();
    expect(clusterLocal).toContain('name: ${{ matrix.member }}');
    expect(clusterLocal).toContain('member: [e2e-cluster-local]');
    const run =
      clusterLocal?.indexOf('yarn test:${{ matrix.member }}:vitest') ?? -1;
    const retain =
      clusterLocal?.indexOf('name: Retain local cluster container logs') ?? -1;
    const cleanup =
      clusterLocal?.indexOf('name: Delete retained local cluster resources') ??
      -1;
    expect(run).toBeGreaterThanOrEqual(0);
    expect(retain).toBeGreaterThan(run);
    expect(cleanup).toBeGreaterThan(retain);
    // No Bash twin exists, so the candidate step itself must report failures.
    const candidate = clusterLocal?.slice(run, retain) ?? '';
    expect(candidate).not.toContain('continue-on-error');
    // A job cancelled at its timeout still keeps the K3s logs and uploads them.
    expect(clusterLocal?.slice(retain, cleanup)).toContain(
      'if: failure() || cancelled()',
    );
    expect(clusterLocal?.slice(cleanup)).toContain('if: always()');
    expect(clusterLocal?.slice(cleanup)).toContain('failure() || cancelled()');
    expect(clusterLocal).toContain('timeout-minutes: 60');
  });

  it('e2e-serve.yml queues every dispatch instead of replacing a pending run', () => {
    const concurrency = workflowSource('e2e-serve.yml')
      .split('\nconcurrency:\n')[1]
      .split('\n\n')[0];
    expect(concurrency).toContain('queue: max');
    expect(concurrency).toContain('cancel-in-progress: false');
  });

  it('stamps the CI cluster version before the live AWS cluster run', () => {
    const workflow = workflowSource('e2e-cluster-cloud.yml');
    const stamp = workflow.indexOf('name: Stamp CI cluster version');
    const run = workflow.indexOf('e2e.sh e2e-cluster-cloud');
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(stamp);
  });

  it("stamps from_release as the candidate's predecessor (RFC 0049 C27)", () => {
    const workflow = workflowSource('e2e-cluster-cloud.yml');
    const step = workflow.split('name: Stamp CI cluster version')[1]!;
    const script = step.slice(step.indexOf('node -e "') + 'node -e "'.length);
    const directory = mkdtempSync(join(tmpdir(), 'cluster-stamp-'));
    const stamp = (env: Record<string, string>) => {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ version: '0.1.72', previousVersion: '0.1.50' }),
      );
      execFileSync('node', ['-e', script.slice(0, script.indexOf('"\n'))], {
        cwd: directory,
        env: { ...process.env, ...env },
      });
      return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    };
    try {
      expect(stamp({ VERSION: '0.1.999', FROM_RELEASE: '0.1.71' })).toEqual({
        version: '0.1.999',
        previousVersion: '0.1.71',
      });
      expect(stamp({ VERSION: '0.0.999', FROM_RELEASE: '' })).toEqual({
        version: '0.0.999',
        previousVersion: '0.1.50',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('provides generated Python source to fresh-checkout consumers', () => {
    const tests = jobBlocks(workflowSource('tests.yml')).get('test');
    expect(tests).toContain('needs: generated-sdk');
    expect(tests).toContain('name: generated-python-sdk');
    expect(tests).toContain('path: python/generated/anycloud');
  });

  it('keeps Service qualification and cleanup after the VM-hosted API members are removed', () => {
    const serve = workflowSource('e2e-serve.yml');
    const jobs = jobBlocks(serve);
    expect(jobs.has('e2e-api-serve')).toBe(false);
    expect(jobs.has('e2e-api-update')).toBe(false);
    expect(jobs.has('e2e-serve-vitest')).toBe(true);
    expect(jobs.get('post-cleanup-aws')).toContain('needs: [e2e-serve-vitest]');
  });

  it('blocks on the Service cells except for forced-cleanup dispatches', () => {
    // The Service Bash twins retired (RFC 0017); only a deliberate forced
    // failure may stay advisory.
    const cells = jobBlocks(workflowSource('e2e-serve.yml')).get(
      'e2e-serve-vitest',
    );
    // Job-level (four-space) key; step-level upload guards are separate.
    expect(cells).toContain(
      '\n    continue-on-error: ${{ inputs.force_service_cleanup }}\n',
    );
    expect(cells).not.toContain('\n    continue-on-error: true\n');
  });

  it('qualifies wheel and source distributions on supported Python versions', () => {
    const tests = jobBlocks(workflowSource('tests.yml')).get('installed-sdk');
    const release = jobBlocks(workflowSource('release.yml')).get('sdk-qualify');

    for (const job of [tests, release]) {
      expect(job).toContain('fail-fast: false');
      expect(job).toContain("python-version: ['3.10', '3.12']");
      expect(job).toContain('distribution: [wheel, sdist]');
      expect(job).toContain("package_pattern: '*.whl'");
      expect(job).toContain("package_pattern: '*.tar.gz'");
      expect(job).toContain(
        '"$PYTHON_BIN" test/integration/fixtures/qualify-python-sdk-extensions.py',
      );
    }
  });

  it.each([
    ['tests.yml', 'installed-sdk'],
    ['release.yml', 'sdk-qualify'],
  ])('isolates every installed SDK qualification in %s', (file, name) => {
    const job = jobBlocks(workflowSource(file)).get(name)!;
    const setup = job.indexOf('uses: actions/setup-python@v5');
    const isolation = job.indexOf('- name: Create isolated SDK environment');
    const exportInterpreter =
      'echo "PYTHON_BIN=$sdk_venv/bin/python" >> "$GITHUB_ENV"';
    const exportIndex = job.indexOf(exportInterpreter);
    const install = job.indexOf(
      '"$PYTHON_BIN" -m pip install python/dist/${{ matrix.package_pattern }}',
    );

    expect(job).toMatch(/^ {4}env:\n {6}PYTHONPATH: ''$/m);
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(isolation).toBeGreaterThan(setup);
    expect(job.slice(isolation, exportIndex)).toContain(
      'sdk_venv="$(mktemp -d "$RUNNER_TEMP/anycloud-sdk-venv.XXXXXX")"',
    );
    expect(job.slice(isolation, exportIndex)).toContain(
      'python -m venv "$sdk_venv"',
    );
    expect(exportIndex).toBeGreaterThan(isolation);
    expect(install).toBeGreaterThan(exportIndex);

    for (const command of [
      '"$PYTHON_BIN" test/integration/fixtures/generated-python-sdk-models.py',
      '"$PYTHON_BIN" test/integration/fixtures/qualify-python-sdk-extensions.py',
      'yarn test:generated-python-sdk-wire',
    ]) {
      expect(job.indexOf(command), command).toBeGreaterThan(install);
    }

    const qualification = job.slice(exportIndex + exportInterpreter.length);
    expect(qualification).not.toMatch(
      /^\s*(?:run:\s*['"]?)?(?:python(?:3(?:\.\d+)?)?|pip(?:3(?:\.\d+)?)?)\s/mu,
    );
    expect(qualification).not.toMatch(/PYTHON_BIN\s*[:=]/u);
    expect(job).not.toContain('--system-site-packages');
    expect(job).not.toMatch(/(?:source|\.)\s+[^\n]*\/bin\/activate/u);
  });

  it('enables ARM64 emulation only off GitHub-hosted runners', () => {
    const source = workflowSource('build-deps-base.yml');
    expect(source).toContain('uses: docker/setup-qemu-action@v3');
    expect(source).toContain(
      "if: vars.CI_BACKEND != 'hosted' && matrix.platform == 'linux/arm64'",
    );
  });

  it('keeps Release on GitHub-hosted Linux runners, its artifact cleanup included', () => {
    const release = load(workflowSource('release.yml')) as {
      jobs: Record<
        string,
        {
          'runs-on'?: string;
          with?: { hosted?: boolean };
          strategy?: { matrix?: { include?: { runner?: string }[] } };
        }
      >;
    };
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name === 'artifact-cleanup') {
        expect(job.with?.hosted, name).toBe(true);
        continue;
      }
      const runners =
        job['runs-on'] === '${{ matrix.runner }}'
          ? (job.strategy?.matrix?.include ?? []).map((entry) => entry.runner)
          : [job['runs-on']];
      expect(runners.length, name).toBeGreaterThan(0);
      for (const runner of runners)
        expect(runner, name).toMatch(/^ubuntu-(latest|24\.04-arm)$/);
    }
    // No step branches on the backend either.
    expect(workflowSource('release.yml')).not.toContain('vars.CI_BACKEND');
  });

  it('bounds unit-test workers only on backmesh', () => {
    const source = workflowSource('tests.yml');
    expect(source).toContain('if [ "${CI_BACKEND:-backmesh}" = hosted ]; then');
    expect(source).toContain('yarn test:ci-backmesh');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['test:ci-backmesh']).toContain(
      '--maxWorkers=2',
    );
    expect(packageJson.scripts?.test).toContain('--maxWorkers=4');
  });

  it('defaults an unset backend to backmesh', () => {
    const action = readFileSync(
      '.github/actions/ci-backend/action.yml',
      'utf8',
    );
    expect(action).toContain("''|backmesh|hosted)");
    expect(action).toContain('effective_backend=${CI_BACKEND_INPUT:-backmesh}');
  });

  it('installs the runner tools before the jobs that use cloud CLIs', () => {
    const jobs: Record<string, string[]> = {
      'e2e-cluster-cloud.yml': ['e2e-cluster-cloud'],
      'integration.yml': ['cloud-sad-tests', 'credentials-onboarding-e2e'],
      'tests.yml': ['credentials-integration'],
      'release.yml': ['published-cli-canary'],
    };
    for (const [file, names] of Object.entries(jobs)) {
      const blocks = jobBlocks(workflowSource(file));
      for (const name of names) {
        expect(blocks.get(name), `${file}:${name}`).toContain(
          'run: bash ci/install-runner-tools.sh',
        );
      }
    }
  });
});

describe('CI base images', () => {
  it('does not spend the Docker Hub pull quota on CI base images', () => {
    const files = [
      'Dockerfile',
      'test/docker/Dockerfile',
      'test/docker/Dockerfile.arm64-only',
      'test/docker/Dockerfile.mace',
      'test/integration/helpers/sshd-container.ts',
      'test/integration/e2e/internal/substrates/local-cluster/constants.ts',
    ];

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).toContain('mirror.gcr.io');
    }
  });
});
