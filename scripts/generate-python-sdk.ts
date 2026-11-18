#!/usr/bin/env npx tsx
/** Generate the ignored Python SDK build input from the canonical contract. */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateApiOpenApiDocument } from '../src/shared/api-contract/openapi.js';
import { canonicalJson } from './generate-openapi.js';

const execFileAsync = promisify(execFile);
const GENERATOR_VERSION = '7.24.0';
const GENERATOR_ARTIFACT = `openapi-generator-cli-${GENERATOR_VERSION}.jar`;
const GENERATOR_URL = `https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/${GENERATOR_VERSION}/${GENERATOR_ARTIFACT}`;
const PYTHON_DEPENDENCIES = [
  'httpx>=0.28.1,<1',
  'pydantic>=2.11,<3',
  'python-dateutil>=2.8.2,<3',
  'typing-extensions>=4.12.2,<5',
] as const;
const PYTHON = process.env.PYTHON_BIN ?? 'python3';

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function assertNoArguments(args: readonly string[]): void {
  if (args.length !== 0) {
    throw new Error('Usage: yarn generate:python-sdk');
  }
}

async function checksum(path: string): Promise<string> {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function readExpectedChecksum(root: string): Promise<string> {
  const metadata = await readFile(
    join(root, 'python/generator/openapi-generator.sha256'),
    'utf8',
  );
  const match = metadata.match(
    /^([a-f0-9]{64})\s+openapi-generator-cli-7\.24\.0\.jar\s*$/u,
  );
  if (!match) throw new Error('Invalid OpenAPI Generator checksum metadata');
  return match[1];
}

async function verifiedJar(root: string, expected: string): Promise<string> {
  const configured = process.env.OPENAPI_GENERATOR_JAR;
  const cacheDirectory =
    process.env.OPENAPI_GENERATOR_CACHE_DIR ??
    join(homedir(), '.cache/anycloud/openapi-generator');
  const jar = configured ?? join(cacheDirectory, GENERATOR_ARTIFACT);

  const isValid = async () => {
    try {
      return (await checksum(jar)) === expected;
    } catch {
      return false;
    }
  };
  if (await isValid()) return jar;
  if (configured) {
    throw new Error(`Configured OpenAPI Generator JAR failed SHA-256: ${jar}`);
  }

  await mkdir(cacheDirectory, { recursive: true });
  const download = `${jar}.${process.pid}.download`;
  await rm(download, { force: true });
  try {
    await execFileAsync('curl', [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--output',
      download,
      GENERATOR_URL,
    ]);
    if ((await checksum(download)) !== expected) {
      throw new Error('Downloaded OpenAPI Generator JAR failed SHA-256');
    }
    await rename(download, jar);
  } finally {
    await rm(download, { force: true });
  }
  return jar;
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) {
  try {
    await execFileAsync(command, args, { cwd, env });
  } catch (error) {
    const detail = error as {
      stderr?: string;
      stdout?: string;
      message: string;
    };
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${detail.stderr ?? detail.stdout ?? detail.message}`,
    );
  }
}

async function files(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(root, entry.name);
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unexpected generated filesystem entry: ${name}`);
  }
  return result;
}

async function assertSameTree(left: string, right: string): Promise<void> {
  const [leftFiles, rightFiles] = await Promise.all([
    files(left),
    files(right),
  ]);
  if (leftFiles.join('\n') !== rightFiles.join('\n')) {
    throw new Error('Generated Python SDK paths are not deterministic');
  }
  for (const file of leftFiles) {
    const [first, second] = await Promise.all([
      readFile(join(left, file)),
      readFile(join(right, file)),
    ]);
    if (!first.equals(second)) {
      throw new Error(`Generated Python SDK is not deterministic: ${file}`);
    }
  }
}

async function assertGeneratedPackage(output: string): Promise<string> {
  const entries = await readdir(output, { withFileTypes: true });
  const expected = new Set([
    '.openapi-generator',
    '.openapi-generator-ignore',
    'anycloud',
    'anycloud_README.md',
  ]);
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !expected.has(entry.name)) ||
    !entries.find((entry) => entry.name === 'anycloud')?.isDirectory()
  ) {
    throw new Error(
      `Unexpected OpenAPI Generator output: ${entries.map((entry) => entry.name).join(', ')}`,
    );
  }
  const packageDirectory = join(output, 'anycloud');
  if (!(await stat(join(packageDirectory, '__init__.py'))).isFile()) {
    throw new Error('Generated package does not contain anycloud/__init__.py');
  }
  return packageDirectory;
}

async function qualifyPython(
  packageRoot: string,
  temporaryRoot: string,
  cwd: string,
): Promise<void> {
  const qualification = [
    'import importlib, inspect, pathlib, pkgutil, py_compile, tempfile, typing',
    'import anycloud',
    'root = pathlib.Path(anycloud.__path__[0])',
    'with tempfile.TemporaryDirectory() as compiled:',
    '    for source in root.rglob("*.py"):',
    '        target = pathlib.Path(compiled, source.relative_to(root)).with_suffix(".pyc")',
    '        target.parent.mkdir(parents=True, exist_ok=True)',
    '        py_compile.compile(str(source), cfile=str(target), doraise=True)',
    'failed = []',
    'for module in pkgutil.walk_packages(anycloud.__path__, "anycloud."):',
    '    try:',
    '        imported = importlib.import_module(module.name)',
    '        for _, value in inspect.getmembers(imported):',
    '            if getattr(value, "__module__", None) != module.name:',
    '                continue',
    '            if inspect.isclass(value):',
    '                typing.get_type_hints(value, include_extras=True)',
    '                for _, method in inspect.getmembers(value):',
    '                    if (',
    '                        getattr(method, "__module__", None) == module.name',
    '                        and (inspect.isfunction(method) or inspect.ismethod(method))',
    '                    ):',
    '                        typing.get_type_hints(method, include_extras=True)',
    '            elif inspect.isfunction(value):',
    '                typing.get_type_hints(value, include_extras=True)',
    '    except Exception as error:',
    '        failed.append(f"{module.name}: {error}")',
    'if failed:',
    '    raise RuntimeError("\\n".join(failed))',
  ].join('\n');
  const venv = join(temporaryRoot, 'python-qualification');
  const python = join(venv, 'bin/python');
  await run(PYTHON, ['-m', 'venv', venv], cwd);
  await run(python, ['-m', 'pip', 'install', ...PYTHON_DEPENDENCIES], cwd);
  await run(python, ['-c', qualification], cwd, {
    ...process.env,
    PYTHONPATH: dirname(packageRoot),
    PYTHONDONTWRITEBYTECODE: '1',
  });
}

async function replacePackage(source: string, target: string): Promise<void> {
  const parent = dirname(target);
  const backup = join(parent, `.anycloud-${process.pid}.backup`);
  await mkdir(parent, { recursive: true });
  await rm(backup, { recursive: true, force: true });
  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (exists) await rename(target, backup);
  try {
    await cp(source, target, { recursive: true, force: false });
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    if (exists) await rename(backup, target);
    throw error;
  }
}

async function main(): Promise<void> {
  assertNoArguments(process.argv.slice(2));
  const root = repositoryRoot();
  const version = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ).version;
  if (typeof version !== 'string')
    throw new Error('package.json has no string version');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'anycloud-python-sdk-'));
  try {
    const openapiPath = join(temporaryRoot, 'openapi.json');
    const configPath = join(temporaryRoot, 'openapi-generator.yaml');
    const templateDirectory = join(root, 'python/generator/templates');
    const firstOutput = join(temporaryRoot, 'first');
    const secondOutput = join(temporaryRoot, 'second');
    const document = await generateApiOpenApiDocument({ version });
    await writeFile(openapiPath, `${canonicalJson(document)}\n`);

    await run('yarn', ['vitest', 'run', 'test/unit/rpc/openapi.spec.ts'], root);
    const expectedChecksum = await readExpectedChecksum(root);
    const jar = await verifiedJar(root, expectedChecksum);
    await run('java', ['-jar', jar, 'validate', '-i', openapiPath], root);
    const configured = (
      await readFile(
        join(root, 'python/generator/openapi-generator.yaml'),
        'utf8',
      )
    ).replaceAll('${PACKAGE_VERSION}', version);
    await writeFile(configPath, configured);
    const generationArguments = (output: string) => [
      '-jar',
      jar,
      'generate',
      '-c',
      configPath,
      '-i',
      openapiPath,
      '-o',
      output,
      '--template-dir',
      templateDirectory,
      '--global-property',
      'apiTests=false,modelTests=false,apiDocs=false,modelDocs=false',
    ];
    await run('java', generationArguments(firstOutput), root);
    await run('java', generationArguments(secondOutput), root);
    const [firstPackage, secondPackage] = await Promise.all([
      assertGeneratedPackage(firstOutput),
      assertGeneratedPackage(secondOutput),
    ]);
    await assertSameTree(firstPackage, secondPackage);
    await qualifyPython(firstPackage, temporaryRoot, root);

    await replacePackage(firstPackage, join(root, 'python/generated/anycloud'));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
