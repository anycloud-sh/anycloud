#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import parser from '@typescript-eslint/parser';

import { validateEslintDirectiveComments } from './repository-policy/eslint-directive-policy.mjs';

const inspectedExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const ignoredDirectories = new Set([
  '.context',
  '.git',
  '.stryker-tmp',
  'dist',
  'node_modules',
  'website',
]);

function normalize(path) {
  return path.replaceAll('\\', '/');
}

export function inspectEslintDirectiveSource(file, source, options = {}) {
  const { ast } = parser.parseForESLint(source, {
    comment: true,
    ecmaFeatures: { jsx: true },
    ecmaVersion: 'latest',
    filePath: file,
    loc: true,
    range: true,
    sourceType: 'module',
  });
  return validateEslintDirectiveComments({
    file: normalize(file),
    comments: ast.comments ?? [],
    ...options,
  });
}

function listInspectedFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listInspectedFiles(root, path));
    else if (inspectedExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export function inspectRepositoryEslintDirectives(root) {
  const violations = [];
  for (const path of listInspectedFiles(root)) {
    const file = normalize(relative(root, path));
    try {
      violations.push(
        ...inspectEslintDirectiveSource(file, readFileSync(path, 'utf8')),
      );
    } catch (error) {
      violations.push({
        file,
        line: 1,
        message: `Could not parse file while checking ESLint directives: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  return violations;
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = process.cwd();
  if (!existsSync(join(root, 'package.json'))) {
    console.error(
      'Run the ESLint directive policy check from the repository root.',
    );
    process.exit(1);
  }

  const violations = inspectRepositoryEslintDirectives(root);
  if (violations.length > 0) {
    console.error('ESLint directive policy check failed.');
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line}: ${violation.message}`,
      );
    }
    process.exit(1);
  }
}
