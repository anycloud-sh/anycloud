import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.context/ctrl-c-diagnosis');
const artifacts = join(evidence, 'artifacts');
const base = '07f5c3ecd69a68e13363e1b08be3f239728cfeb7';
const bun = realpathSync(join(root, 'node_modules/.bin/bun'));
const exec = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
const sha = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

mkdirSync(artifacts, { recursive: true });
if (!existsSync(join(root, 'dist/cli/index.js'))) {
  throw new Error('Run yarn build before preparing the spike.');
}
const changedSource = exec('git', [
  'diff',
  '--name-only',
  base,
  'HEAD',
  '--',
  'src',
  'package.json',
  'yarn.lock',
]);
if (changedSource !== 'src/cli/utils/interrupt.ts') {
  throw new Error(
    `Reassess isolated base build: changed files are ${changedSource}`,
  );
}
const manifest = {
  createdAt: new Date().toISOString(),
  revision: exec('git', ['rev-parse', 'HEAD']),
  base,
  node: process.version,
  nodePath: process.execPath,
  bun: exec(bun, ['--version']),
  os: exec('/usr/bin/sw_vers', []),
  architecture: process.arch,
  shell: process.env.SHELL,
  conductorVersion: exec('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    '/Applications/Conductor.app/Contents/Info.plist',
  ]),
  lockSha256: sha(join(root, 'yarn.lock')),
  artifacts: [],
};
for (const variant of ['base', 'candidate']) {
  const directory = join(artifacts, variant);
  mkdirSync(directory, { recursive: true });
  cpSync(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(directory, 'package.json'));
  if (variant === 'base') {
    const source = exec('git', ['show', `${base}:src/cli/utils/interrupt.ts`]);
    writeFileSync(
      join(directory, 'dist/cli/utils/interrupt.js'),
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    );
  }
  const entry = join(directory, 'dist/cli/index.js');
  const binary = join(directory, 'anycloud-darwin-arm64');
  exec(bun, [
    'build',
    '--compile',
    '--target=bun-darwin-arm64',
    entry,
    '--outfile',
    binary,
  ]);
  manifest.artifacts.push({
    variant,
    entry,
    binary,
    binarySha256: sha(binary),
    interruptSha256: sha(join(directory, 'dist/cli/utils/interrupt.js')),
    version: exec(binary, ['--version']),
  });
}
const installed = '/opt/homebrew/bin/anycloud';
if (existsSync(installed)) {
  manifest.artifacts.push({
    variant: 'installed',
    binary: realpathSync(installed),
    binarySha256: sha(installed),
    version: exec(installed, ['--version']),
  });
}
writeFileSync(
  join(evidence, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(JSON.stringify(manifest, null, 2));
