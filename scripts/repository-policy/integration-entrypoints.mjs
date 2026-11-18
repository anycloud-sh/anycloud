import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadYaml } from '@kubernetes/client-node';
import ts from 'typescript';
import { gitVisibleFiles } from './git-files.mjs';
import { shellCommands } from './shell.mjs';
import {
  destructiveBackstopTests,
  integrationUtilities,
  shellNativeQualificationTests,
} from './integration-entrypoint-owners.mjs';

const registeredShellTests = [
  ...shellNativeQualificationTests,
  ...destructiveBackstopTests,
];

const integrationRoot = 'test/integration/';
const constrainedRoot = integrationRoot + 'e2e/specs/';
const program = /\.(?:[cm]?[jt]sx?|sh|py)$/;
const dynamic = /[$*?{}\x60]/;
const testAlias = /^(?:test(?::|$)|spike:|cleanup:)/;
const interpreters =
  /^(?:node|tsx|bash|sh|zsh|python[23]?|\$PYTHON_BIN|\$\{PYTHON_BIN:-python3\})$/;
const runners = new Set([
  integrationRoot + 'e2e.sh',
  integrationRoot + 'run-constrained-vitest.sh',
]);

// The lint configuration already owns these suites; do not duplicate its list.
export function integrationTestOwners(eslintSource) {
  const source = ts.createSourceFile(
    'eslint.config.mjs',
    eslintSource,
    ts.ScriptTarget.Latest,
    true,
  );
  return [
    'grandfatheredIntegrationTests',
    'lowerLayerIntegrationTests',
  ].flatMap((name) => {
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
    const value = declaration?.initializer;
    if (
      !value ||
      !ts.isArrayLiteralExpression(value) ||
      value.elements.some((entry) => !ts.isStringLiteral(entry))
    ) {
      throw new Error(name + ' must remain an exact literal path list.');
    }
    return value.elements.map((entry) => entry.text);
  });
}

function workflowCommands(value, output = [], matrix = {}) {
  if (!value || typeof value !== 'object') return output;
  if (value.strategy?.matrix) {
    matrix = { ...value.strategy.matrix };
    for (const member of matrix.include ?? [])
      for (const [key, entry] of Object.entries(member))
        matrix[key] = [...new Set([...(matrix[key] ?? []), entry])];
  }
  if (typeof value.run === 'string') {
    let commands = [value.run];
    for (const [key, entries] of Object.entries(matrix)) {
      if (key === 'include' || key === 'exclude' || !Array.isArray(entries))
        continue;
      const expression = new RegExp(
        '\\$\\{\\{\\s*matrix\\.' + key + '\\s*\\}\\}',
        'g',
      );
      if (expression.test(value.run))
        commands = commands.flatMap((command) =>
          entries.map((entry) => command.replace(expression, String(entry))),
        );
    }
    output.push(...new Set(commands));
  }
  for (const child of Object.values(value))
    workflowCommands(child, output, matrix);
  return output;
}

export function validateIntegrationEntrypoints({
  files,
  packageScripts,
  testOwners = [],
  shellTests = registeredShellTests,
  utilities = integrationUtilities,
  toolingFiles = [],
}) {
  const errors = [];
  const owned = new Set([...testOwners, ...shellTests, ...utilities]);
  const typed = new Set(toolingFiles);
  const exists = (path) => Object.hasOwn(files, path);
  const fail = (caller, message) => errors.push(caller + ': ' + message);
  for (const path of owned)
    if (
      !path.startsWith(integrationRoot) ||
      !program.test(path) ||
      dynamic.test(path) ||
      !exists(path)
    )
      fail(
        path,
        'entrypoint ownership must name an existing exact file; remove stale or broad exemptions.',
      );
  for (const path of Object.keys(files))
    if (
      path.startsWith(integrationRoot) &&
      path.endsWith('.test.sh') &&
      !owned.has(path)
    )
      fail(
        path,
        'new workload tests belong in e2e/specs with the constrained fixture.',
      );

  const inspect = (source, caller) => {
    const packageName = caller.startsWith('package.json#')
      ? caller.slice('package.json#'.length)
      : '';
    const testScope =
      testAlias.test(packageName) ||
      /\.github\/.*(?:e2e|integration|qualification|probe|tests)/.test(caller);
    const checkPath = (raw, mode, args) => {
      const path = posix.normalize(raw).replace(/^\.\//, '');
      if (dynamic.test(path)) {
        if (testScope || /test\/integration\/|experiments\//.test(path))
          fail(
            caller,
            'unresolved test launcher ' +
              raw +
              '; use a literal repository-root entrypoint.',
          );
        return;
      }
      if (
        testScope &&
        program.test(path) &&
        !posix.isAbsolute(path) &&
        !exists(path)
      ) {
        fail(
          caller,
          'missing entrypoint ' +
            path +
            '; use a literal repository-root path.',
        );
        return;
      }
      if (!path.startsWith(integrationRoot) && !path.startsWith('experiments/'))
        return;
      if (!exists(path)) {
        fail(caller, 'missing executable ' + path);
      } else if (path.startsWith(constrainedRoot)) {
        if (
          !path.endsWith('.spec.ts') ||
          mode !== 'vitest' ||
          !args.includes('vitest.e2e.config.mts')
        )
          fail(
            caller,
            path +
              ' must run through vitest.e2e.config.mts and the constrained fixture.',
          );
      } else if (
        path.startsWith(integrationRoot) &&
        !owned.has(path) &&
        !runners.has(path)
      ) {
        fail(
          caller,
          path + ' is a helper library, not an owned integration entrypoint.',
        );
      } else if (path.startsWith('experiments/')) {
        const readme =
          files[path.split('/').slice(0, 2).join('/') + '/README.md'] ?? '';
        if (
          !readme.includes(path) &&
          !(packageName && readme.includes('yarn ' + packageName))
        )
          fail(
            caller,
            path + ' must have a documented experiment run command.',
          );
        if (/\.[cm]?tsx?$/.test(path) && !typed.has(path))
          fail(caller, path + ' is outside tsconfig.tooling.json coverage.');
      }
    };

    for (const command of shellCommands(source)) {
      const tokens = [...command];
      while (
        /^(?:export|local|readonly)$/.test(tokens[0] ?? '') ||
        /^\w+=/.test(tokens[0] ?? '')
      )
        tokens.shift();
      let raw = tokens.shift() ?? '';
      let executable = posix.basename(raw);
      if (!executable || ['source', '.', 'cd'].includes(executable)) continue;
      if (executable === 'command' && ['-v', '-V'].includes(tokens[0]))
        continue;
      const mentionsTest = tokens.some((word) =>
        /test\/integration\/|experiments\/|(?:test|spike):/.test(word),
      );
      if (/^(?:timeout|gtimeout|env|command|exec|time)$/.test(executable)) {
        if (mentionsTest || testAlias.test(packageName))
          fail(
            caller,
            'unsupported test command wrapper ' +
              executable +
              '; declare a direct entrypoint and use the workflow timeout.',
          );
        continue;
      }
      if (/^(?:yarn|npm|npx|pnpm)$/.test(executable)) {
        while (
          /^(?:-s|--silent|--no-install|--yes|run|exec)$/.test(tokens[0] ?? '')
        )
          tokens.shift();
        executable = tokens.shift() ?? '';
        raw = executable;
        // Each declaration is checked independently. Forwarded data cannot
        // become a program because a bare interpreter declaration is rejected.
        if (Object.hasOwn(packageScripts, executable)) continue;
        if (dynamic.test(executable) || testAlias.test(executable)) {
          fail(
            caller,
            'unresolved package launcher ' +
              executable +
              '; declare a literal package script.',
          );
          continue;
        }
      }
      if (executable === 'vitest') {
        for (const token of tokens.filter(
          (word) => word.includes(integrationRoot) && program.test(word),
        ))
          checkPath(token, 'vitest', tokens);
      } else if (interpreters.test(executable)) {
        let index = 0;
        for (
          ;
          index < tokens.length && tokens[index].startsWith('-');
          index++
        ) {
          const option = tokens[index];
          if (
            /^(?:--import|--require|-r|--loader|--experimental-loader)(?:=|$)/.test(
              option,
            )
          ) {
            const preload = option.includes('=')
              ? option.slice(option.indexOf('=') + 1)
              : tokens[++index];
            if (preload) checkPath(preload, 'execute', tokens);
          } else if (['--tsconfig', '--conditions', '-C'].includes(option)) {
            index++;
          } else if (
            /^-(?:[a-z]*c[a-z]*|e|p)$|^--(?:eval|print|input-type)(?:=|$)/.test(
              option,
            )
          ) {
            if (mentionsTest || testAlias.test(packageName))
              fail(
                caller,
                'unsupported inline test launcher; declare a direct entrypoint.',
              );
            index = tokens.length;
            break;
          }
        }
        if (tokens[index]) checkPath(tokens[index], 'execute', tokens);
        else if (testAlias.test(packageName))
          fail(
            caller,
            'a test package script must name its executable entrypoint; forwarded arguments are test data.',
          );
      } else if (program.test(raw)) {
        checkPath(raw, 'execute', tokens);
      } else if (dynamic.test(raw) && mentionsTest) {
        fail(
          caller,
          'unresolved test launcher ' + raw + '; declare a direct entrypoint.',
        );
      }
    }
  };

  // Inspect declarations only. Wrapper internals are reviewed code, not a
  // second language interpreter maintained by the repository-policy check.
  for (const [name, command] of Object.entries(packageScripts))
    inspect(command, 'package.json#' + name);
  for (const [path, source] of Object.entries(files))
    if (path.startsWith('.github/') && /\.ya?ml$/.test(path))
      for (const command of workflowCommands(loadYaml(source)))
        inspect(command, path);
  return [...new Set(errors)];
}

export function inspectIntegrationEntrypoints(root) {
  const files = Object.fromEntries(
    gitVisibleFiles(root)
      .filter((path) =>
        /\.(?:sh|ya?ml|[cm]?[jt]sx?|py)$|\/README\.md$/.test(path),
      )
      .map((path) => [
        path,
        /\.ya?ml$|\/README\.md$/.test(path)
          ? readFileSync(join(root, path), 'utf8')
          : '',
      ]),
  );
  const config = ts.readConfigFile(
    join(root, 'tsconfig.tooling.json'),
    ts.sys.readFile,
  );
  const tooling = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return validateIntegrationEntrypoints({
    files,
    packageScripts: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      .scripts,
    testOwners: integrationTestOwners(
      readFileSync(join(root, 'eslint.config.mjs'), 'utf8'),
    ),
    toolingFiles: tooling.fileNames.map((path) => posix.relative(root, path)),
  });
}
