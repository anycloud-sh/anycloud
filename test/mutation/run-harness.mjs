import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectMutationScope } from '../../scripts/check-mutation-scope.mjs';

export function mutationArguments(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dryRunOnly')) {
    throw new Error(
      'Only --dryRunOnly is supported; change mutation scope and sandbox options in the reviewed configuration.',
    );
  }
  return ['run', 'stryker.harness.config.mjs', ...args];
}

export function assertCampaignCompleted(report) {
  const mutants = Object.values(report.files).flatMap((file) => file.mutants);
  if (
    mutants.length === 0 ||
    mutants.some(
      ({ status }) => status === 'RuntimeError' || status === 'Pending',
    )
  ) {
    throw new Error(
      'Mutation execution was incomplete or had runtime errors; inspect reports/mutation/harness/.',
    );
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  const args = mutationArguments(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = inspectMutationScope(root);
  if (errors.length) {
    console.error(
      `Mutation scope check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    const child = spawnSync(
      process.execPath,
      [
        resolve(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'),
        ...args,
      ],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    if (child.status === 0 && !args.includes('--dryRunOnly')) {
      assertCampaignCompleted(
        JSON.parse(
          readFileSync(
            resolve(root, 'reports/mutation/harness/mutation.json'),
            'utf8',
          ),
        ),
      );
    }
  }
}
