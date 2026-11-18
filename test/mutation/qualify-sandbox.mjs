// Exercise Stryker's actual copy behavior with dummy files, never real secrets.
// This explicit qualification stays outside ordinary verification.
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import mutation from '../../stryker.harness.config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = await mkdtemp(join(tmpdir(), 'anycloud-mutation-sandbox-'));
const privateFiles = [
  '.env',
  '.env.aws',
  'nested/.env.gcp',
  '.context/private.txt',
  'nested/.context/private.txt',
  '.dev.vars',
  'nested/.dev.vars.local',
  '.mcp.json',
  'nested/.mcp.local.json',
  '.claude/private.txt',
  'nested/.claude/private.txt',
  '.wrangler/private.txt',
  'dist/private.txt',
  'get-dist/private.txt',
  'binaries/private.txt',
  'website/private.txt',
  'reports/private.txt',
];

async function put(path, contents) {
  const destination = join(fixture, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

try {
  await symlink(
    join(root, 'node_modules'),
    join(fixture, 'node_modules'),
    'dir',
  );
  for (const path of privateFiles) await put(path, 'dummy-private-sentinel');
  await put('included.txt', 'public-copy-sentinel');
  await put('package.json', '{"type":"module"}');
  await put(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'bundler',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts', 'test/**/*.ts'],
    }),
  );
  await put(
    'src/decision.ts',
    'export const staticValue = true;\nexport function accept(value: boolean): boolean { return value; }',
  );
  await put(
    'test/unit/sandbox.spec.ts',
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      "import { test, expect } from 'vitest';",
      "import { accept, staticValue } from '../../src/decision';",
      "test('0040/S2 private sentinels are absent from the actual sandbox', () => {",
      `  for (const path of ${JSON.stringify(privateFiles)}) expect(existsSync(path), path).toBe(false);`,
      "  expect(readFileSync('included.txt', 'utf8')).toBe('public-copy-sentinel');",
      '  expect(accept(true)).toBe(true);',
      '  expect(staticValue).toBe(true);',
      '});',
    ].join('\n'),
  );
  await put(
    'vitest.config.mjs',
    "export default { test: { include: ['test/unit/sandbox.spec.ts'], environment: 'node', passWithNoTests: false } };",
  );
  await put(
    'stryker.config.mjs',
    `export default ${JSON.stringify(
      {
        ...mutation,
        $schema: undefined,
        mutate: ['src/decision.ts'],
        tsconfigFile: 'tsconfig.json',
        vitest: { configFile: 'vitest.config.mjs', related: true },
        concurrency: 1,
        reporters: ['clear-text', 'json'],
      },
      null,
      2,
    )};`,
  );
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'), 'run'],
    {
      cwd: fixture,
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
  const report = JSON.parse(
    await readFile(join(fixture, mutation.jsonReporter.fileName), 'utf8'),
  );
  const mutants = Object.values(report.files).flatMap((file) => file.mutants);
  const staticMutants = mutants.filter((mutant) => mutant.static);
  if (
    staticMutants.length !== 1 ||
    staticMutants[0].status !== 'Killed' ||
    mutants.some(({ status }) => ['RuntimeError', 'Pending'].includes(status))
  ) {
    throw new Error('Static mutant activation qualification failed.');
  }
  console.log(
    `Sandbox qualification passed: ${privateFiles.length} private/generated sentinels excluded; public sentinel copied; static mutant killed.`,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
