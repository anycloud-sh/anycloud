import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import mutation from '../../../stryker.harness.config.mjs';
import vitest from '../../../vitest.mutation.config.mjs';
import {
  assertCampaignCompleted,
  mutationArguments,
} from '../../mutation/run-harness.mjs';
import {
  inspectMutationScope,
  validateMutationScope,
} from '../../../scripts/check-mutation-scope.mjs';

function inputs() {
  return {
    config: structuredClone(mutation),
    testConfig: structuredClone(vitest),
    availableFiles: new Set([...mutation.mutate, ...vitest.test.include]),
    checkedFiles: new Set([...mutation.mutate, ...vitest.test.include]),
    compilerOptions: { strict: true, noEmit: true },
    integrationCompilerOptions: { strict: true, noEmit: true },
    discoveredTests: [...vitest.test.include],
  };
}

describe('mutation harness scope', () => {
  it('rejects Stryker testFiles filters even when they match the Vitest allowlist', () => {
    for (const testFiles of [[], [...vitest.test.include]]) {
      const candidate = inputs();
      candidate.config.testFiles = testFiles;
      expect(validateMutationScope(candidate)).toContain(
        'Select tests through Vitest include; Stryker testFiles breaks static mutant activation.',
      );
    }
  });

  it('accepts informational mutation outcomes but fails incomplete or errored execution', () => {
    const report = (statuses) => ({
      files: {
        'harness.ts': { mutants: statuses.map((status) => ({ status })) },
      },
    });
    for (const status of [
      'Killed',
      'Survived',
      'NoCoverage',
      'CompileError',
      'Timeout',
      'Ignored',
    ]) {
      expect(() => assertCampaignCompleted(report([status]))).not.toThrow();
    }
    for (const statuses of [[], ['RuntimeError'], ['Killed', 'Pending']]) {
      expect(() => assertCampaignCompleted(report(statuses))).toThrow(
        'Mutation execution was incomplete',
      );
    }
  });
  it('accepts a normal campaign or dry run and rejects CLI scope overrides', () => {
    expect(mutationArguments([])).toEqual([
      'run',
      'stryker.harness.config.mjs',
    ]);
    expect(mutationArguments(['--dryRunOnly'])).toEqual([
      'run',
      'stryker.harness.config.mjs',
      '--dryRunOnly',
    ]);
    for (const args of [
      ['--inPlace'],
      ['--mutate', 'src/**'],
      ['--testFiles', 'test/integration/**'],
      ['--ignorePatterns', '!**/.env*'],
      ['--configFile', 'vitest.config.mts'],
      ['--dryRunOnly', '--inPlace'],
    ]) {
      expect(() => mutationArguments(args)).toThrow(
        'Only --dryRunOnly is supported',
      );
    }
  });

  it('0040/S1 discovers exactly the four approved unit suites', () => {
    expect(vitest.test.include).toEqual([
      'test/unit/e2e-fixture.spec.ts',
      'test/unit/e2e-persistent-vm-boundaries.spec.ts',
      'test/unit/e2e-persistent-vm-contract.spec.ts',
      'test/unit/e2e-persistent-vm-host-loss-contract.spec.ts',
    ]);
    expect(mutation.mutate).toEqual([
      'test/integration/e2e/internal/cleanup.ts',
      'test/integration/e2e/internal/wait.ts',
      'test/integration/e2e/internal/controller-session.ts',
      'test/integration/e2e/internal/persistent-vm-submission.ts',
      'test/integration/e2e/internal/contracts/persistent-vm-policy.ts',
      'test/integration/e2e/internal/contracts/persistent-vm-running.ts',
    ]);
    expect(inspectMutationScope(process.cwd())).toEqual([]);
  });

  it.each([undefined, [], ['test/unit/missing-*.spec.ts']])(
    'rejects a missing, empty, or globbed test selection: %j',
    (files) => {
      const candidate = inputs();
      candidate.testConfig.test.include = files;
      candidate.discoveredTests = files;
      expect(validateMutationScope(candidate)).toContain(
        'include must be a non-empty list of unique literal paths.',
      );
    },
  );

  it.each([undefined, [], ['test/integration/e2e/internal/*.ts']])(
    'rejects a missing, empty, or globbed mutation selection: %j',
    (files) => {
      const candidate = inputs();
      candidate.config.mutate = files;
      expect(validateMutationScope(candidate)).toContain(
        'mutate must be a non-empty list of unique literal paths.',
      );
    },
  );

  it('rejects stale source and test paths instead of falling back to discovery', () => {
    const candidate = inputs();
    for (const file of [mutation.mutate[0], vitest.test.include[0]]) {
      candidate.availableFiles.delete(file);
      candidate.checkedFiles.delete(file);
    }
    expect(validateMutationScope(candidate)).toEqual(
      expect.arrayContaining([
        `${mutation.mutate[0]} is missing or resolves outside its scope.`,
        `${vitest.test.include[0]} is missing or resolves outside its scope.`,
      ]),
    );
  });

  it.each([
    'test/integration/aws-sad.spec.ts',
    'test/integration/e2e/specs/contracts/vm/aws.spec.ts',
  ])(
    'rejects integration selection even when both configs agree: %s',
    (file) => {
      const candidate = inputs();
      candidate.testConfig.test.include = [file];
      candidate.discoveredTests = [file];
      candidate.availableFiles.add(file);
      candidate.checkedFiles.add(file);
      expect(validateMutationScope(candidate)).toContain(
        `include selects an unsafe path: ${file}`,
      );
    },
  );

  it.each([
    'src/api/services/monitor.ts',
    'test/integration/e2e/internal/cleanup.spec.ts',
    'test/integration/e2e/internal/../../../../src/api/server.ts',
  ])('rejects mutation outside the harness implementation: %s', (file) => {
    const candidate = inputs();
    candidate.config.mutate = [file];
    candidate.availableFiles.add(file);
    candidate.checkedFiles.add(file);
    expect(validateMutationScope(candidate).length).toBeGreaterThan(0);
  });

  it('rejects incomplete TypeScript coverage', () => {
    const candidate = inputs();
    candidate.checkedFiles.delete(mutation.mutate[0]);
    expect(validateMutationScope(candidate)).toContain(
      `${mutation.mutate[0]} is not covered by the mutation TypeScript project.`,
    );
  });

  it('rejects changed compiler options even when all selected files are covered', () => {
    const candidate = inputs();
    candidate.compilerOptions.strict = false;
    expect(validateMutationScope(candidate)).toContain(
      'Keep the integration TypeScript compiler options unchanged.',
    );
  });

  it('rejects expanding or reducing the pilot even within safe directories', () => {
    for (const selection of ['mutate', 'include']) {
      const candidate = inputs();
      const owner =
        selection === 'mutate' ? candidate.config : candidate.testConfig.test;
      owner[selection] = owner[selection].slice(1);
      expect(validateMutationScope(candidate)).toContain(
        'Keep the six-source, six-suite harness allowlist.',
      );
    }
    const candidate = inputs();
    const file = 'test/integration/e2e/internal/environment.ts';
    candidate.config.mutate.push(file);
    candidate.availableFiles.add(file);
    candidate.checkedFiles.add(file);
    expect(validateMutationScope(candidate)).toContain(
      'Keep the six-source, six-suite harness allowlist.',
    );
  });

  it('rejects Vitest discovery drift and an empty discovery result', () => {
    for (const discoveredTests of [
      [],
      [...vitest.test.include, 'test/unit/unrelated.spec.ts'],
    ]) {
      expect(validateMutationScope({ ...inputs(), discoveredTests })).toContain(
        'Actual Vitest discovery must match the explicit include.',
      );
    }
  });

  it('rejects in-place mutation, a different runner, and removed type checking', () => {
    for (const override of [
      { inPlace: true },
      { dryRunOnly: true },
      { allowEmpty: true },
      { vitest: { configFile: 'vitest.config.mts' } },
      { checkers: [] },
      { typescriptChecker: { prioritizePerformanceOverAccuracy: true } },
    ]) {
      const candidate = inputs();
      Object.assign(candidate.config, override);
      expect(validateMutationScope(candidate).length).toBeGreaterThan(0);
    }
  });

  it('rejects provisioning or ordinary global setup in the mutation configuration', () => {
    for (const override of [
      { provide: { constrainedE2E: true } },
      { globalSetup: ['test/global-setup.ts'] },
      { setupFiles: ['test/unit/setup.ts'] },
      { passWithNoTests: true },
    ]) {
      const candidate = inputs();
      Object.assign(candidate.testConfig.test, override);
      expect(validateMutationScope(candidate)).toContain(
        'Use isolated unit setup without the constrained E2E marker.',
      );
    }
  });

  it.each([
    { allowOnly: true },
    { allowOnly: undefined },
    { expect: { requireAssertions: false } },
    { expect: {} },
  ])(
    'rejects disabled or missing test-execution safeguards: %j',
    (override) => {
      const candidate = inputs();
      Object.assign(candidate.testConfig.test, override);
      expect(validateMutationScope(candidate)).toContain(
        'Reject focused tests and require assertions in the mutation runner.',
      );
    },
  );

  it('0040/S2 rejects missing exclusions and ignores that hide selected sources', () => {
    for (const pattern of [
      '**/.env*',
      '**/.context/**',
      '**/.dev.vars*',
      '**/.mcp.*',
      '**/.claude/**',
    ]) {
      const candidate = inputs();
      candidate.config.ignorePatterns = candidate.config.ignorePatterns.filter(
        (value) => value !== pattern,
      );
      expect(validateMutationScope(candidate)).toContain(
        'Keep exactly the reviewed private/generated sandbox exclusions.',
      );
    }
    for (const pattern of ['!**/.env*', mutation.mutate[0]]) {
      const candidate = inputs();
      candidate.config.ignorePatterns.push(pattern);
      expect(validateMutationScope(candidate)).toContain(
        'Keep exactly the reviewed private/generated sandbox exclusions.',
      );
    }
  });

  it('0040/S4 keeps mutation campaigns out of ordinary verification and automatic CI', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    const pending = ['verify'];
    const visited = new Set();
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      expect(name).not.toBe('test:mutation:harness');
      const command = scripts[name];
      expect(command).not.toMatch(/\bstryker\b|qualify-sandbox/u);
      for (const [, child] of command.matchAll(/\byarn\s+([\w:-]+)/gu)) {
        if (Object.hasOwn(scripts, child)) pending.push(child);
      }
    }
    expect(visited.has('check:mutation-scope')).toBe(true);
    expect(mutation.thresholds.break).toBe(0);

    const workflow = readFileSync('.github/workflows/mutation.yml', 'utf8');
    const events = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/mu)?.[1] ?? '';
    expect(
      [...events.matchAll(/^ {2}([\w_]+):/gmu)].map((match) => match[1]),
    ).toEqual(['workflow_dispatch']);
    expect(workflow).not.toMatch(/continue-on-error:\s*true/u);
    expect(workflow).toContain('run: yarn test:mutation:harness');
  });
});
