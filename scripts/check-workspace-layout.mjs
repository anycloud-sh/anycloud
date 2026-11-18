#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectIntegrationEntrypoints } from './repository-policy/integration-entrypoints.mjs';

const forbiddenScriptName = /^(?:spike-|probe-)|-e2e/i;

function normalize(path) {
  return path.replaceAll('\\', '/');
}

function listFiles(dir, root = dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path, root));
    else files.push(normalize(relative(root, path)));
  }
  return files;
}

export function validateWorkspaceLayout({
  packageScripts,
  scriptPaths,
  experiments,
}) {
  const violations = [];

  for (const [name, command] of Object.entries(packageScripts)) {
    if (
      name.startsWith('test:') &&
      /(?:^|[\s"'=])\.?\/?scripts\//.test(command)
    ) {
      violations.push(
        `package.json script ${name} executes a file under scripts/; test entrypoints belong in test/.`,
      );
    }
  }

  for (const path of scriptPaths) {
    const basename = normalize(path).split('/').at(-1) ?? path;
    if (forbiddenScriptName.test(basename)) {
      violations.push(
        `scripts/${normalize(path)} has a test, spike, or probe filename; move it to test/, experiments/, or benchmarks/.`,
      );
    }
  }

  for (const experiment of experiments) {
    const prefix = `experiments/${experiment.name}`;
    if (!experiment.files.includes('run.ts')) {
      violations.push(`${prefix} is missing its run.ts entrypoint.`);
    }
    if (experiment.readme === undefined) {
      violations.push(`${prefix} is missing README.md.`);
      continue;
    }

    const requiredSections = [
      ['status', /^- Status:[ \t]*\S/im],
      ['decision record', /^- Decision record:[ \t]*\S/im],
      ['run command', /^- Run:\s*`[^`]+`/im],
      ['promotion criteria', /^## Promotion criteria\s*$/im],
      ['deletion criteria', /^## Deletion criteria\s*$/im],
    ];
    for (const [label, pattern] of requiredSections) {
      if (!pattern.test(experiment.readme)) {
        violations.push(`${prefix}/README.md is missing ${label}.`);
      }
    }
  }

  return violations;
}

export function inspectRepository(root) {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const experimentsRoot = join(root, 'experiments');
  const experiments = existsSync(experimentsRoot)
    ? readdirSync(experimentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = join(experimentsRoot, entry.name);
          const readmePath = join(dir, 'README.md');
          return {
            name: entry.name,
            files: listFiles(dir),
            readme: existsSync(readmePath)
              ? readFileSync(readmePath, 'utf8')
              : undefined,
          };
        })
    : [];

  return [
    ...validateWorkspaceLayout({
      packageScripts: packageJson.scripts ?? {},
      scriptPaths: listFiles(join(root, 'scripts')),
      experiments,
    }),
    ...inspectIntegrationEntrypoints(root),
  ];
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = inspectRepository(root);
  if (violations.length > 0) {
    console.error('Repository layout boundary check failed.');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
}
