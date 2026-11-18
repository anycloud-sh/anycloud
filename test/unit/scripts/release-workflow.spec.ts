import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

describe('release workflow notes', () => {
  it('keeps generated and packaged Python versions in release lockstep', () => {
    const verification = readFileSync(
      'scripts/verify-release-state.js',
      'utf8',
    );

    expect(verification).toContain('python/generated/anycloud/__init__.py');
    expect(verification).toContain(
      'generated Python SDK version ${generatedVersion} does not match package.json version ${version}',
    );

    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['release:check']).toMatch(
      /^yarn generate:python-sdk && node scripts\/verify-release-state\.js/,
    );
  });

  it('creates an immutable release from the generated notes', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain(
      'yarn release:notes --version "${{ steps.release.outputs.version }}" --output release-notes.md',
    );
    expect(workflow).toMatch(
      /gh release create "\$TAG"[\s\S]*--notes-file release-notes\.md/,
    );
    expect(workflow).not.toContain('gh release edit');
    expect(workflow).not.toContain('--clobber');
    expect(workflow).not.toContain('gh release view');
    expect(workflow).not.toContain(
      'NOTES="Public anycloud CLI binaries for ${TAG}."',
    );
  });

  it('bumps the version before the gate that reads it', () => {
    // verify-release-state.js asserts docs/changelog.md has a section for
    // package.json's version. Run before the bump, that version is the release
    // that just shipped, whose section always exists — so the gate would pass
    // without anyone having written notes for the release being cut.
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const bump = workflow.indexOf('npm version patch --no-git-tag-version');
    const gate = workflow.indexOf('node scripts/verify-release-state.js');

    expect(bump).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(bump);
  });

  it('records the replaced release as the predecessor the client window admits', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const bumpLines = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith('npm pkg set previousVersion=') ||
          line === 'npm version patch --no-git-tag-version',
      );
    expect(bumpLines).toHaveLength(2);

    const directory = mkdtempSync(join(tmpdir(), 'release-bump-'));
    try {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'bump', version: '0.1.71' }),
      );
      execFileSync('bash', ['-euc', bumpLines.join('\n')], {
        cwd: directory,
        stdio: 'pipe',
      });
      expect(
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
      ).toMatchObject({ version: '0.1.72', previousVersion: '0.1.71' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically pushes the validated release through branch protection', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain(
      'RELEASE_TOKEN: ${{ secrets.E2E_SERVE_GITHUB_TOKEN }}',
    );
    expect(workflow).toContain(
      'git commit -m "Bump version to ${VERSION} [skip ci]"',
    );
    expect(workflow).toMatch(
      /git push --atomic[\s\S]*HEAD:main "v\$\{VERSION\}"/,
    );
  });

  it('regenerates before sealing the immutable release commit', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const bump = workflow.indexOf('npm version patch --no-git-tag-version');
    const generate = workflow.indexOf('yarn generate:python-sdk');
    const stage = workflow.indexOf(
      'git add package.json python/pyproject.toml',
    );
    const commit = workflow.indexOf('git commit -m "Bump version');
    const tag = workflow.indexOf('git tag -a "v${VERSION}"');
    const tests = workflow.indexOf('- name: Run unit tests');

    expect(generate).toBeGreaterThan(bump);
    expect(workflow).not.toContain('generate:python-sdk --');
    expect(workflow).not.toMatch(/git add[^\n]*python\/generated/u);
    expect(stage).toBeGreaterThan(generate);
    expect(commit).toBeGreaterThan(stage);
    expect(tag).toBeGreaterThan(tests);
  });

  it('publishes the distributions qualified by both Python versions', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain("python-version: ['3.10', '3.12']");
    expect(workflow).toContain('distribution: [wheel, sdist]');
    expect(workflow).toContain("package_pattern: '*.whl'");
    expect(workflow).toContain("package_pattern: '*.tar.gz'");
    expect(workflow).toContain('name: release-python-sdk-distributions');
    expect(workflow).toContain('needs: [prepare, docker-merge, sdk-qualify]');
    expect(workflow).toContain("ANYCLOUD_EXPECT_INSTALLED: '1'");
    expect(workflow).toContain(
      '"$PYTHON_BIN" test/integration/fixtures/qualify-python-sdk-extensions.py',
    );
    expect(workflow).toContain("ANYCLOUD_WHEEL_TEST: '1'");
    expect(workflow).toContain('packages-dir: python/dist/');
  });

  it('publishes retained build artifacts without a GPU qualification dependency', () => {
    const source = readFileSync('.github/workflows/release.yml', 'utf8');
    const workflow = loadYaml<{
      jobs: Record<
        string,
        {
          needs: string[];
          if?: string;
          steps: {
            name?: string;
            uses?: string;
            run?: string;
            with?: Record<string, string | boolean>;
          }[];
        }
      >;
    }>(source);
    expect(workflow.jobs['gpu-qualification']).toBeUndefined();
    expect(source).not.toContain('managed-gpu-candidate');
    expect(workflow.jobs['docker-merge'].needs).toEqual([
      'prepare',
      'docker',
      'sdk-qualify',
    ]);
    expect(workflow.jobs['docker-merge'].if).toBeUndefined();

    const artifacts = {
      'docker-merge': [
        { name: 'digest-amd64', path: '/tmp/digests' },
        { name: 'digest-arm64', path: '/tmp/digests' },
      ],
      'cli-release': [
        {
          name: 'cli-binary-artifacts',
          path: '/tmp/cli-binary-artifacts',
        },
      ],
      sdk: [{ name: 'release-python-sdk-distributions', path: 'python/dist' }],
    };
    for (const [name, artifact] of Object.entries(artifacts)) {
      const job = workflow.jobs[name];
      const checkout = job.steps.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with?.ref).toBe(
        '${{ needs.prepare.outputs.commit_sha }}',
      );
      const downloads = job.steps.filter(
        (step) =>
          step.uses ===
          'anycloud-sh/anycloud/.github/actions/download-retained-artifact@main',
      );
      expect(downloads.map((step) => step.with)).toEqual(artifact);
    }
    expect(workflow.jobs['cli-release'].needs).toContain('docker-merge');
    expect(workflow.jobs.sdk.needs).toEqual([
      'prepare',
      'docker-merge',
      'sdk-qualify',
    ]);
    expect(
      workflow.jobs.sdk.steps.find((step) =>
        step.uses?.startsWith('pypa/gh-action-pypi-publish@'),
      )!.with?.['packages-dir'],
    ).toBe('python/dist/');
  });

  it('skips the hosted_stage gate only for a waiver reason, kept out of the run', () => {
    const workflow = loadYaml<{
      on: {
        workflow_dispatch: {
          inputs: Record<string, { type: string; default: string }>;
        };
      };
      jobs: Record<
        string,
        {
          needs?: string | string[];
          environment?: string;
          steps?: {
            name?: string;
            if?: string;
            run?: string;
            env?: Record<string, string>;
          }[];
        }
      >;
    }>(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(workflow.on.workflow_dispatch.inputs.hosted_gate_waiver).toEqual(
      expect.objectContaining({ type: 'string', default: '' }),
    );
    // No extra job: one that is skipped or fails would cut prepare's
    // downstream jobs off after it pushed the tag.
    expect(workflow.jobs.prepare.needs).toBe('artifact-cleanup');
    expect(
      Object.values(workflow.jobs).map((job) => job.environment),
    ).not.toContain('release-gate-waiver');

    const steps = workflow.jobs.prepare.steps ?? [];
    const gate = steps.find(
      (step) => step.name === 'Require a green hosted_stage run on this tree',
    );
    expect(gate?.if).toBe("inputs.hosted_gate_waiver == ''");
    const reasonSteps = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) =>
        Object.values(step.env ?? {}).includes(
          '${{ inputs.hosted_gate_waiver }}',
        ),
      );
    expect(reasonSteps).toHaveLength(1);
    expect(reasonSteps[0]?.if).toBe("inputs.hosted_gate_waiver != ''");
    expect(reasonSteps[0]?.run).toContain('$GITHUB_STEP_SUMMARY');
    // A blank reason skips the gate too, so it must fail before the bump.
    expect(reasonSteps[0]?.run).toContain('[ -n "${REASON//[[:space:]]/}" ]');
    // Neither the public run summary nor the release notes carry the reason.
    expect(
      reasonSteps[0]?.run
        ?.split('\n')
        .filter((line) => line.includes('$GITHUB_STEP_SUMMARY')),
    ).toEqual([expect.not.stringContaining('REASON')]);
    expect(reasonSteps[0]?.run).not.toContain('release-notes.md');
    expect(
      readFileSync('.github/workflows/release.yml', 'utf8').match(
        /\$\{\{ inputs\.hosted_gate_waiver \}\}/g,
      ),
    ).toHaveLength(1);
  });

  // Prepare pushes the tag, and every publish job needs it, so a failed
  // job upstream of prepare must stop it rather than strand a tag.
  it('runs prepare only after artifact cleanup succeeded', () => {
    const workflow = loadYaml<{
      jobs: Record<string, { needs?: string | string[]; if?: string }>;
    }>(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(workflow.jobs.prepare.needs).toBe('artifact-cleanup');
    expect(workflow.jobs.prepare.if).toBe(
      "${{ !cancelled() && needs.artifact-cleanup.result == 'success' }}",
    );
  });

  it('retains build artifacts for failed-job retries', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('retention-days: 7');
  });
});
