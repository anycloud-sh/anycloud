#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import ts from 'typescript';

import mutation from '../stryker.harness.config.mjs';
import vitest from '../vitest.mutation.config.mjs';

const sources = [
  'test/integration/e2e/internal/cleanup.ts',
  'test/integration/e2e/internal/wait.ts',
  'test/integration/e2e/internal/controller-session.ts',
  'test/integration/e2e/internal/persistent-vm-submission.ts',
  'test/integration/e2e/internal/contracts/persistent-vm-policy.ts',
  'test/integration/e2e/internal/contracts/persistent-vm-running.ts',
];
const suites = [
  'test/unit/e2e-fixture.spec.ts',
  'test/unit/e2e-persistent-vm-boundaries.spec.ts',
  'test/unit/e2e-persistent-vm-contract.spec.ts',
  'test/unit/e2e-persistent-vm-host-loss-contract.spec.ts',
];
const requiredExclusions = [
  '**/.env*',
  '**/.context/**',
  '**/.dev.vars*',
  '**/.mcp.*',
  '**/.claude/**',
  '**/.wrangler/**',
  '/dist/**',
  '/get-dist/**',
  '/binaries/**',
  '/website/**',
  '/reports/**',
  '/.stryker-tmp/**',
];

function literalPaths(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (path) =>
        typeof path === 'string' &&
        !/[!*?{}[\]\\]/u.test(path) &&
        !path.split('/').some((part) => part === '..' || part === '.'),
    ) &&
    new Set(value).size === value.length
  );
}

function sameFiles(left, right) {
  return (
    literalPaths(left) &&
    literalPaths(right) &&
    left.length === right.length &&
    left.every((path) => right.includes(path))
  );
}

export function validateMutationScope({
  config,
  testConfig,
  availableFiles,
  checkedFiles,
  compilerOptions,
  integrationCompilerOptions,
  discoveredTests,
}) {
  const errors = [];
  const test = testConfig.test ?? {};
  if (!sameFiles(config.mutate, sources) || !sameFiles(test.include, suites)) {
    errors.push('Keep the six-source, six-suite harness allowlist.');
  }
  for (const [key, files, prefix, suffix] of [
    ['mutate', config.mutate, 'test/integration/e2e/internal/', '.ts'],
    ['include', test.include, 'test/unit/', '.spec.ts'],
  ]) {
    if (!literalPaths(files)) {
      errors.push(`${key} must be a non-empty list of unique literal paths.`);
      continue;
    }
    for (const path of files) {
      if (
        !path.startsWith(prefix) ||
        !path.endsWith(suffix) ||
        (key === 'mutate' && /\.(?:spec|test)\.ts$/u.test(path))
      ) {
        errors.push(`${key} selects an unsafe path: ${path}`);
      }
      if (!availableFiles.has(path)) {
        errors.push(`${path} is missing or resolves outside its scope.`);
      }
      if (!checkedFiles.has(path)) {
        errors.push(
          `${path} is not covered by the mutation TypeScript project.`,
        );
      }
    }
  }
  if (config.testFiles !== undefined) {
    errors.push(
      'Select tests through Vitest include; Stryker testFiles breaks static mutant activation.',
    );
  }
  if (!sameFiles(test.include, discoveredTests)) {
    errors.push('Actual Vitest discovery must match the explicit include.');
  }
  if (
    config.inPlace !== false ||
    config.testRunner !== 'vitest' ||
    config.vitest?.configFile !== 'vitest.mutation.config.mjs' ||
    config.vitest?.related !== true ||
    config.coverageAnalysis !== 'perTest' ||
    config.dryRunOnly === true ||
    config.allowEmpty === true ||
    config.ignoreStatic !== false
  ) {
    errors.push('Use the sandboxed, related, per-test Vitest harness runner.');
  }
  if (
    config.tsconfigFile !== 'test/mutation/tsconfig.json' ||
    !Array.isArray(config.checkers) ||
    config.checkers.length !== 1 ||
    config.checkers[0] !== 'typescript' ||
    config.typescriptChecker?.prioritizePerformanceOverAccuracy !== false ||
    config.typescriptChecker?.experimentalNativePreview === true
  ) {
    errors.push(
      'The harness requires its scoped integration TypeScript checker.',
    );
  }
  if (
    !compilerOptions ||
    !integrationCompilerOptions ||
    !isDeepStrictEqual(compilerOptions, integrationCompilerOptions)
  ) {
    errors.push('Keep the integration TypeScript compiler options unchanged.');
  }
  if (test.allowOnly !== false || test.expect?.requireAssertions !== true) {
    errors.push(
      'Reject focused tests and require assertions in the mutation runner.',
    );
  }
  if (
    test.provide?.constrainedE2E ||
    test.environment !== 'node' ||
    test.env?.IS_TEST !== 'true' ||
    test.passWithNoTests !== false ||
    !Array.isArray(test.globalSetup) ||
    test.globalSetup.length !== 0 ||
    !Array.isArray(test.setupFiles) ||
    test.setupFiles.length !== 0
  ) {
    errors.push('Use isolated unit setup without the constrained E2E marker.');
  }
  const ignored = config.ignorePatterns ?? [];
  if (
    !Array.isArray(ignored) ||
    ignored.some(
      (pattern) => typeof pattern !== 'string' || pattern.startsWith('!'),
    ) ||
    ignored.length !== requiredExclusions.length ||
    requiredExclusions.some((pattern) => !ignored.includes(pattern))
  ) {
    errors.push(
      'Keep exactly the reviewed private/generated sandbox exclusions.',
    );
  }
  if (
    config.tempDirName !== '.stryker-tmp' ||
    config.htmlReporter?.fileName !== 'reports/mutation/harness/index.html' ||
    config.jsonReporter?.fileName !== 'reports/mutation/harness/mutation.json'
  ) {
    errors.push(
      'Keep mutation temporary files and reports in their ignored directories.',
    );
  }
  return errors;
}

function readProject(root, path) {
  const configuration = ts.readConfigFile(resolve(root, path), ts.sys.readFile);
  if (configuration.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(configuration.error.messageText, '\n'),
    );
  const project = ts.parseJsonConfigFileContent(
    configuration.config,
    ts.sys,
    dirname(resolve(root, path)),
  );
  if (project.errors.length) {
    throw new Error(
      project.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, '\n'),
        )
        .join('\n'),
    );
  }
  return project;
}

export function inspectMutationScope(root) {
  const project = readProject(root, mutation.tsconfigFile);
  const integration = readProject(root, 'test/integration/tsconfig.json');
  const selected = [mutation.mutate, vitest.test.include].flatMap((files) =>
    Array.isArray(files)
      ? files.filter((path) => typeof path === 'string')
      : [],
  );
  const availableFiles = new Set(
    selected.filter((path) => {
      const absolute = resolve(root, path);
      return (
        existsSync(absolute) &&
        relative(root, realpathSync(absolute)).replaceAll('\\', '/') === path
      );
    }),
  );
  const inputs = {
    config: mutation,
    testConfig: vitest,
    availableFiles,
    checkedFiles: new Set(
      project.fileNames.map((path) =>
        relative(root, path).replaceAll('\\', '/'),
      ),
    ),
    compilerOptions: project.options,
    integrationCompilerOptions: integration.options,
    discoveredTests: vitest.test.include,
  };
  const errors = validateMutationScope(inputs);
  // Reject a malformed scope before even asking Vitest to discover files.
  if (errors.length) return errors;
  const output = execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'list',
      '--filesOnly',
      '--config',
      'vitest.mutation.config.mjs',
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return validateMutationScope({
    ...inputs,
    discoveredTests: output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.spec.ts')),
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = inspectMutationScope(root);
  if (errors.length) {
    console.error(
      `Mutation scope check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
    process.exitCode = 1;
  }
}
