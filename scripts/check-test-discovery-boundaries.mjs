#!/usr/bin/env node

// Constrained E2E candidates provision real cloud resources and own
// vitest.e2e.config.mts. Under any other configuration they inherit unit-test
// setup, environment, and 30-second timeouts, which aborts a candidate
// mid-provision and cuts off its cleanup. Prove that the default configuration
// never selects one, that the constrained configuration selects them all, and
// that the lint layer still recognizes the same files.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadESLint } from 'eslint';
import { resolveConfig } from 'vitest/node';

const constrainedSpecRoot = 'test/integration/e2e/specs';
// eslint.config.mjs matches constrained specs by its own copy of the glob. A
// spec it stops matching silently loses every constrained-spec rule, so prove
// the lint layer still recognizes the same files the runner selects.
const requiredSpecRules = [
  'local/require-e2e-fixture',
  'local/no-e2e-escape-hatches',
  'local/valid-e2e-spec-shape',
];
const testFileName = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

function normalize(path) {
  return path.replaceAll('\\', '/');
}

export function validateTestDiscovery({
  defaultFiles,
  constrainedFiles,
  specFiles,
}) {
  const violations = [];
  const constrained = new Set(constrainedFiles);

  for (const file of defaultFiles) {
    if (/(^|\/)(?:\.stryker-tmp|reports\/mutation)\//u.test(file)) {
      violations.push(
        `${file} is a generated mutation artifact discoverable by vitest.config.mts; exclude mutation sandboxes and reports.`,
      );
    }
    if (file.startsWith(`${constrainedSpecRoot}/`)) {
      violations.push(
        `${file} is discoverable by vitest.config.mts; exclude the constrained specs so watch mode and IDE gutters cannot run a candidate.`,
      );
    }
  }

  for (const file of specFiles) {
    if (!constrained.has(file)) {
      violations.push(`${file} is not selected by vitest.e2e.config.mts.`);
    }
  }

  for (const file of constrainedFiles) {
    if (!file.startsWith(`${constrainedSpecRoot}/`)) {
      violations.push(
        `${file} is selected by vitest.e2e.config.mts but lives outside ${constrainedSpecRoot}.`,
      );
    }
  }

  return violations;
}

export function validateSpecLintCoverage({ specFiles, specLintRules }) {
  const violations = [];
  for (const file of specFiles) {
    for (const requiredSpecRule of requiredSpecRules) {
      const setting = specLintRules[file]?.[requiredSpecRule];
      const severity = Array.isArray(setting) ? setting[0] : setting;
      if (severity !== 2 && severity !== 'error') {
        violations.push(
          `ESLint does not enforce ${requiredSpecRule} on ${file}; the constrained spec globs or rule severities have drifted.`,
        );
      }
    }
  }

  return violations;
}

export function validateTestExecutionConfiguration(config, name) {
  return [
    [
      config.expect?.requireAssertions === true,
      'expect.requireAssertions must be true',
    ],
    [config.allowOnly === false, 'allowOnly must be false'],
    [config.passWithNoTests === false, 'passWithNoTests must be false'],
  ]
    .filter(([valid]) => !valid)
    .map(([, message]) => `${name}: ${message}.`);
}

export function validateTestSkipLintCoverage({ testFiles, testLintRules }) {
  return testFiles.flatMap((file) => {
    const setting = testLintRules[file]?.['local/no-skipped-or-focused-tests'];
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return severity === 2 || severity === 'error'
      ? []
      : [`ESLint must enforce local/no-skipped-or-focused-tests on ${file}.`];
  });
}

function listSpecFiles(dir, root) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listSpecFiles(path, root));
    else if (testFileName.test(entry))
      files.push(normalize(relative(root, path)));
  }
  return files;
}

export function listDiscoveredFiles(root, config) {
  const output = execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'list',
      '--filesOnly',
      '--config',
      config,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return output
    .split('\n')
    .map((line) => normalize(line.trim()))
    .filter((line) => testFileName.test(line));
}

export async function resolveSpecLintRules(root, files) {
  // ESLint 8 still defaults to eslintrc; this repository is flat-config only.
  const FlatESLint = await loadESLint({ useFlatConfig: true });
  const eslint = new FlatESLint({ cwd: root });
  const entries = await Promise.all(
    files.map(async (file) => {
      // An ignored path resolves to no configuration at all. Treat that as
      // missing rules so the drift surfaces as a violation, not a crash.
      const config = await eslint.calculateConfigForFile(join(root, file));
      return [file, config?.rules ?? {}];
    }),
  );
  return Object.fromEntries(entries);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const specFiles = listSpecFiles(join(root, constrainedSpecRoot), root);
  const defaultFiles = listDiscoveredFiles(root, 'vitest.config.mts');
  const constrainedFiles = listDiscoveredFiles(root, 'vitest.e2e.config.mts');
  const testFiles = [...new Set([...defaultFiles, ...constrainedFiles])];
  const testLintRules = await resolveSpecLintRules(root, testFiles);
  const configurations = await Promise.all(
    ['vitest.config.mts', 'vitest.e2e.config.mts'].map(async (name) => {
      const { vitestConfig } = await resolveConfig({ root, config: name });
      return validateTestExecutionConfiguration(vitestConfig, name);
    }),
  );
  const violations = [
    ...configurations.flat(),
    ...validateTestSkipLintCoverage({ testFiles, testLintRules }),
    ...validateTestDiscovery({
      defaultFiles,
      constrainedFiles,
      specFiles,
    }),
    ...validateSpecLintCoverage({
      specFiles,
      specLintRules: testLintRules,
    }),
  ];
  if (violations.length > 0) {
    console.error('Test discovery boundary check failed.');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
