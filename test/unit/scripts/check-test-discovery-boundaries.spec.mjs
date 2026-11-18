import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '@kubernetes/client-node';
import { shellCommands } from '../../../scripts/repository-policy/shell.mjs';

import { describe, expect, it } from 'vitest';
import {
  listDiscoveredFiles,
  resolveSpecLintRules,
  validateSpecLintCoverage,
  validateTestDiscovery,
  validateTestExecutionConfiguration,
  validateTestSkipLintCoverage,
} from '../../../scripts/check-test-discovery-boundaries.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const specFiles = [
  'test/integration/e2e/specs/cli-exit.spec.ts',
  'test/integration/e2e/specs/contracts/persistent-vm/aws-vm.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/local-held-job.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/local-completed-job.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/local-resubmitted-job.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-bucket-sync.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-bucket-sync.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-bucket-sync.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/lambda-bucket-sync.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-concurrent-output.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-concurrent-output.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-concurrent-output.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-job-host-unreachable.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-job-host-unreachable.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-job-host-unreachable.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-input-hydration-recovery.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-spot-request-cleanup.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-spot-eviction.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-spot-eviction.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-spot-eviction.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-runtime-secrets.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-restricted-credential.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-restricted-credential.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-host-docker.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-host-docker.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-host-docker.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-invalid.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-invalid.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-invalid.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-disk-tier.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-ghcr-probe.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/aws-mace-full-pull.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/azure-mace-full-pull.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/gcp-mace-full-pull.spec.ts',
  'test/integration/e2e/specs/contracts/dedicated-job/lambda-mace-full-pull.spec.ts',
];

describe('mandatory Vitest execution policy', () => {
  const config = {
    expect: { requireAssertions: true },
    allowOnly: false,
    passWithNoTests: false,
  };
  it('requires assertions and rejects focused and empty suites', () => {
    expect(validateTestExecutionConfiguration(config, 'config')).toEqual([]);
    for (const regression of [
      { ...config, expect: {} },
      { ...config, expect: { requireAssertions: false } },
      { ...config, allowOnly: true },
      { ...config, passWithNoTests: true },
    ]) {
      expect(
        validateTestExecutionConfiguration(regression, 'config'),
      ).toHaveLength(1);
    }
  });

  it('checks the skip rule on legacy integration and unit tests as well as constrained specs', async () => {
    const testFiles = [
      ...specFiles,
      'test/integration/quota.spec.ts',
      'test/unit/services/optimizer.spec.ts',
    ];
    const testLintRules = await resolveSpecLintRules(projectRoot, testFiles);
    expect(validateTestSkipLintCoverage({ testFiles, testLintRules })).toEqual(
      [],
    );
    for (const setting of [undefined, 0, 'off', [0], 1, ['warn']]) {
      testLintRules['test/integration/quota.spec.ts'][
        'local/no-skipped-or-focused-tests'
      ] = setting;
      expect(
        validateTestSkipLintCoverage({ testFiles, testLintRules }),
      ).toEqual([expect.stringContaining('on test/integration/quota.spec.ts')]);
    }
  });
});

describe('Lambda suite selection', () => {
  it('selects every API error test and every paid trial through their owning commands', () => {
    const scripts = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ).scripts;
    const workflow = loadYaml(
      readFileSync(
        join(projectRoot, '.github/workflows/lambda-boot-failover.yml'),
        'utf8',
      ),
    );
    const trialCommand = workflow.jobs['forced-timeout'].steps.find(
      (step) => step.id === 'tests',
    ).run;
    const directory = mkdtempSync(join(tmpdir(), 'lambda-suite-discovery-'));
    try {
      for (const [command, expected] of [
        [
          scripts['test:lambda-sad'],
          [
            'Lambda sad path integration > classifies invalid API key as BadCredential',
            'Lambda sad path integration > classifies invalid instance type as InvalidTarget',
            'Lambda sad path integration > classifies invalid region as InvalidTarget',
          ],
        ],
        [
          trialCommand,
          [
            'Lambda boot failover qualification > forces one real no-IP failure, changes target, and reaches Running',
          ],
        ],
      ]) {
        const tokens = shellCommands(command).find((tokens) =>
          tokens.includes('vitest'),
        );
        const args = tokens.slice(tokens.indexOf('vitest') + 2);
        const output = join(directory, 'tests.json');
        execFileSync(
          process.execPath,
          ['node_modules/vitest/vitest.mjs', 'list', ...args, '--json', output],
          {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 20_000,
            env: {
              ...process.env,
              RUN_LAMBDA_BOOT_FAILOVER_QUALIFICATION: '',
              LAMBDA_API_KEY: '',
            },
          },
        );
        expect(
          JSON.parse(readFileSync(output, 'utf8')).map((test) => test.name),
        ).toEqual(expected);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('test discovery boundary', () => {
  it('excludes generated mutation sandboxes and reports from actual default discovery', () => {
    const directories = [];
    try {
      for (const base of ['.stryker-tmp', 'reports/mutation']) {
        mkdirSync(join(projectRoot, base), { recursive: true });
        const directory = mkdtempSync(join(projectRoot, base, 'discovery-'));
        directories.push(directory);
        writeFileSync(join(directory, 'must-not-run.spec.ts'), 'export {};');
      }
      const files = listDiscoveredFiles(projectRoot, 'vitest.config.mts');
      expect(files).toContain('test/unit/e2e-fixture.spec.ts');
      expect(
        files.filter((file) =>
          /(^|\/)(?:\.stryker-tmp|reports\/mutation)\//u.test(file),
        ),
      ).toEqual([]);
    } finally {
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it.each([
    '.stryker-tmp/sandbox/test/unit/copied.spec.ts',
    'reports/mutation/copied.spec.ts',
  ])('rejects generated artifacts in default discovery: %s', (file) => {
    expect(
      validateTestDiscovery({
        defaultFiles: [file],
        constrainedFiles: specFiles,
        specFiles,
      }),
    ).toEqual([
      expect.stringContaining(`${file} is a generated mutation artifact`),
    ]);
  });

  it('accepts split configurations that select disjoint files', () => {
    expect(
      validateTestDiscovery({
        defaultFiles: ['test/unit/e2e-fixture.spec.ts'],
        constrainedFiles: specFiles,
        specFiles,
      }),
    ).toEqual([]);
  });

  it('rejects a constrained spec the default configuration can discover', () => {
    const violations = validateTestDiscovery({
      defaultFiles: ['test/unit/e2e-fixture.spec.ts', ...specFiles],
      constrainedFiles: specFiles,
      specFiles,
    });

    expect(violations).toEqual(
      specFiles.map((file) =>
        expect.stringContaining(`${file} is discoverable by vitest.config.mts`),
      ),
    );
  });

  it('rejects a spec no configuration would run', () => {
    expect(
      validateTestDiscovery({
        defaultFiles: [],
        constrainedFiles: [specFiles[0]],
        specFiles,
      }),
    ).toEqual(
      specFiles
        .slice(1)
        .map((file) =>
          expect.stringContaining(
            `${file} is not selected by vitest.e2e.config.mts`,
          ),
        ),
    );
  });

  it('rejects a constrained configuration that reaches outside the spec root', () => {
    expect(
      validateTestDiscovery({
        defaultFiles: [],
        constrainedFiles: [...specFiles, 'test/integration/aws-sad.spec.ts'],
        specFiles,
      }),
    ).toEqual([
      expect.stringContaining(
        'test/integration/aws-sad.spec.ts is selected by vitest.e2e.config.mts but lives outside',
      ),
    ]);
  });

  const enforced = {
    'local/require-e2e-fixture': [2],
    'local/no-e2e-escape-hatches': [2],
    'local/valid-e2e-spec-shape': [2],
  };

  it('accepts specs with all required fixture rules enforced', () => {
    expect(
      validateSpecLintCoverage({
        specFiles,
        specLintRules: Object.fromEntries(
          specFiles.map((file) => [file, enforced]),
        ),
      }),
    ).toEqual([]);
  });

  it.each(Object.keys(enforced))(
    'rejects missing, disabled, or warning-only %s',
    (rule) => {
      for (const setting of [undefined, 0, 'off', [0], 1, ['warn']]) {
        const violations = validateSpecLintCoverage({
          specFiles,
          specLintRules: Object.fromEntries(
            specFiles.map((file) => [file, { ...enforced, [rule]: setting }]),
          ),
        });
        expect(violations).toHaveLength(specFiles.length);
        expect(violations).toContainEqual(
          expect.stringContaining(`ESLint does not enforce ${rule}`),
        );
      }
    },
  );

  it('checks the effective repository lint configuration', async () => {
    expect(
      validateSpecLintCoverage({
        specFiles,
        specLintRules: await resolveSpecLintRules(projectRoot, specFiles),
      }),
    ).toEqual([]);
  });

  it.each([
    'dist/test/integration/e2e/specs/cli-exit.spec.ts',
    'test/integration/e2e/specs/escaped.spec.mjs',
  ])('reports missing enforcement for %s', async (file) => {
    const violations = validateSpecLintCoverage({
      specFiles: [file],
      specLintRules: await resolveSpecLintRules(projectRoot, [file]),
    });
    expect(violations).toHaveLength(3);
    expect(violations).toContainEqual(
      expect.stringContaining(`local/require-e2e-fixture on ${file}`),
    );
  });
});
