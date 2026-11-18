#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadYaml } from '@kubernetes/client-node';
import { validateSharedProviderPredicates } from './repository-policy/shared-provider-predicates.mjs';
import { parseShell, shellCommands } from './repository-policy/shell.mjs';

const normalized = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const retiredExecutionSwitches = new Set([
  'E2E_FAIL_ON_SKIP',
  'REQUIRE_AZURE_QUOTA_CHECKS',
  'AZURE_QUOTA_CHECKS',
  'AZURE_PARITY_SKIPPED',
  'NUKE_MEMORY_GATES',
  'NUKE_FAIRNESS_ENABLED',
]);

export function validateShellTestExecution(
  source,
  { requireScenario = true } = {},
) {
  const errors = [];
  for (const command of shellCommands(source)) {
    const words = command[0] === 'builtin' ? command.slice(1) : command;
    if (['exit', 'return'].includes(words[0]) && Number(words[1]) === 77)
      errors.push(
        'Tests must fail when prerequisites are unavailable; exit 77 skips are forbidden.',
      );
    if (
      words.some(
        (word) =>
          word.includes('=') &&
          retiredExecutionSwitches.has(word.slice(0, word.indexOf('='))),
      )
    )
      errors.push(
        'Test execution and assertions are mandatory; remove optional execution switches.',
      );
  }
  const root = parseShell(source);
  const outsideFunction = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'function_definition') return false;
    }
    return true;
  };
  const externalCommands = root
    .descendantsOfType('command')
    .filter(outsideFunction)
    .map((node) => ({
      node,
      words: shellCommands(node.text)[0] ?? [],
    }));
  const setupOnly = new Set([
    '.',
    ':',
    'builtin',
    'cd',
    'declare',
    'exit',
    'export',
    'readonly',
    'return',
    'set',
    'source',
    'trap',
    'true',
    'typeset',
    'umask',
    'unset',
  ]);
  const diagnosticOnly = new Set([
    ...setupOnly,
    '[',
    'cat',
    'chmod',
    'dirname',
    'echo',
    'false',
    'head',
    'mkdir',
    'mktemp',
    'printf',
    'pwd',
    'tail',
    'test',
    'touch',
  ]);
  const functionDefinitions = new Map(
    root.descendantsOfType('function_definition').flatMap((node) => {
      const name = node.childForFieldName('name')?.text;
      return name ? [[name, node]] : [];
    }),
  );
  const normalizedCommandWords = (rawWords) => {
    const words = [...rawWords];
    if (words[0] === 'builtin') words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? '')) words.shift();
    while (['command', 'exec'].includes(words[0])) {
      words.shift();
      if (words[0] === '--') words.shift();
    }
    return words;
  };
  const commandProgram = (rawWords) => normalizedCommandWords(rawWords)[0];
  // Tree-sitter can recreate JavaScript wrappers for the same native node.
  const sameNode = (left, right) =>
    left?.tree === right.tree && left.id === right.id;
  const ownsCommand = (definition, node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'function_definition')
        return sameNode(current, definition);
    }
    return false;
  };
  const contains = (owner, node) =>
    owner.startIndex <= node.startIndex && owner.endIndex >= node.endIndex;
  // Count only commands reached whenever their containing program or invoked
  // function is entered. Scenario-looking calls hidden in a branch or after an
  // &&/|| operand cannot establish that a test actually ran.
  const isEntryExecution = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (['function_definition', 'program'].includes(current.type))
        return true;
      if (current.type === 'list') {
        const first = current.namedChildren[0];
        if (!first || !contains(first, node)) return false;
      }
      if (
        ['if_statement', 'elif_clause', 'while_statement'].includes(
          current.type,
        )
      ) {
        const condition = current.childForFieldName('condition');
        if (!condition || !contains(condition, node)) return false;
      }
      if (
        ['case_item', 'case_statement', 'do_group', 'for_statement'].includes(
          current.type,
        )
      )
        return false;
    }
    return true;
  };
  const shellScriptArgument = (words) => {
    const args = words.slice(1);
    while (args.length) {
      if (args[0] === '--') {
        args.shift();
        break;
      }
      if (['-o', '+o', '--init-file', '--rcfile'].includes(args[0])) {
        args.splice(0, 2);
        continue;
      }
      if (/^[-+]/u.test(args[0])) {
        args.shift();
        continue;
      }
      break;
    }
    return args[0];
  };
  const runtimeScope = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        [
          'command_substitution',
          'function_definition',
          'program',
          'subshell',
        ].includes(current.type)
      )
        return current;
    }
  };
  const successfulTerminationBefore = (definition, node) => {
    let subject = node;
    let scope = runtimeScope(subject);
    while (scope) {
      const exitsBefore = scope
        .descendantsOfType('command')
        .filter((command) => sameNode(runtimeScope(command), scope))
        .filter((command) => command.startIndex < subject.startIndex)
        .some((command) => {
          const [program, status] = normalizedCommandWords(
            shellCommands(command.text)[0] ?? [],
          );
          return (
            ['exit', 'return'].includes(program) &&
            (status === undefined || Number(status) === 0)
          );
        });
      if (exitsBefore) return true;
      if (sameNode(scope, definition)) return false;
      subject = scope;
      scope = runtimeScope(scope);
    }
    return false;
  };
  const provesScenario = (rawWords, seen = new Set()) => {
    const program = commandProgram(rawWords);
    if (!program || diagnosticOnly.has(program)) return false;
    const definition = functionDefinitions.get(program);
    if (definition) {
      if (seen.has(program)) return false;
      const nextSeen = new Set(seen).add(program);
      return definition
        .descendantsOfType('command')
        .filter((node) => ownsCommand(definition, node))
        .filter(isEntryExecution)
        .filter((node) => !successfulTerminationBefore(definition, node))
        .some((node) =>
          provesScenario(shellCommands(node.text)[0] ?? [], nextSeen),
        );
    }
    const programName = basename(program);
    if (['bash', 'sh'].includes(programName)) {
      const words = normalizedCommandWords(rawWords);
      if (
        words
          .slice(1)
          .some((word) => word === '--command' || /^-[^-]*c/u.test(word))
      )
        return false;
      const script = shellScriptArgument(words);
      return (
        Boolean(script) &&
        !diagnosticOnly.has(basename(script)) &&
        !['/dev/null', '/dev/zero'].includes(script)
      );
    }
    if (diagnosticOnly.has(programName)) return false;
    return (
      /^(?:assert|check|cli|create|delete|expect|fail|nuke|record|run|seed|start|submit|terminate|test_|verify|wait)(?:_|$)/u.test(
        program,
      ) ||
      /^(?:\.\/|\/)/u.test(program) ||
      /^(?:anycloud|aws|az|bash|curl|docker|gcloud|gh|grep|jq|node|npx|python3|sh|timeout|tsx|yarn)$/u.test(
        program,
      )
    );
  };
  if (
    requireScenario &&
    externalCommands.every(
      ({ node, words }) => !isEntryExecution(node) || !provesScenario(words),
    )
  ) {
    errors.push(
      'Shell tests must execute a top-level scenario command; definitions and setup alone cannot prove assertions ran.',
    );
  }
  for (const [index, { words }] of externalCommands.entries()) {
    const command = words[0] === 'builtin' ? words.slice(1) : words;
    if (
      requireScenario &&
      command[0] === 'exit' &&
      (command[1] === undefined || Number(command[1]) === 0) &&
      externalCommands.slice(index + 1).some(({ words: later }) => {
        return provesScenario(later);
      })
    ) {
      errors.push(
        'Shell tests must not exit successfully before a later scenario command.',
      );
    }
  }
  const literal = (value) => {
    const text = value.trim();
    const unquoted = /^(['"]).*\1$/u.test(text) ? text.slice(1, -1) : text;
    return /^[A-Za-z0-9_.-]+$/u.test(unquoted) ? unquoted : undefined;
  };
  const staticallyFalseCondition = (raw) => {
    const value = raw.replaceAll(/\s+/gu, ' ').trim();
    if (
      /^(?:false|! (?:true|:))$/u.test(value) ||
      /(?:^|[;&|()]\s*)(?:command\s+)?false(?:\s|[;&|()]|$)/u.test(value) ||
      /^\(\(\s*(?:0+|[+-]?0+\s*[+*-]\s*0+)\s*\)\)$/u.test(value)
    )
      return true;
    const equality = value.match(
      /^(?:test |\[\[? )(.+?) (==|=|!=|-eq|-ne) (.+?)(?: \]\]?)?$/u,
    );
    if (!equality) return false;
    const left = literal(equality[1]);
    const right = literal(equality[3]);
    if (left === undefined || right === undefined) return false;
    if (['=', '==', '-eq'].includes(equality[2])) return left !== right;
    return left === right;
  };
  for (const variable of root.descendantsOfType('variable_name')) {
    if (retiredExecutionSwitches.has(variable.text))
      errors.push(
        'Test execution and assertions are mandatory; remove optional execution switches.',
      );
  }
  for (const condition of root.descendantsOfType('if_statement')) {
    if (
      staticallyFalseCondition(
        condition.childForFieldName('condition')?.text ?? '',
      )
    )
      errors.push(
        'Do not disable test code with a statically false condition; give the scenario its required fixture.',
      );
  }
  return errors;
}

// Critical steps are direct invocations. Do not infer whether arbitrary shell
// branches or command chains would execute a test or preserve its exit status.
function invocation(step) {
  if (!step?.run) return [];
  const source = step.run.replace(
    /\$\{\{\s*matrix\.test\s*\}\}/g,
    'MATRIX_TEST',
  );
  const statements = parseShell(source).namedChildren.filter(
    (node) => node.type !== 'comment',
  );
  if (statements.length !== 1 || statements[0].type !== 'command') return [];
  const words = [...shellCommands(source)[0]];
  while (/^\w+=/.test(words[0] ?? '')) words.shift();
  if (['npx', 'yarn'].includes(words[0]) && words[1] === 'tsx')
    words.splice(0, 2);
  else if (['bash', 'tsx'].includes(words[0])) words.shift();
  if (words[0]) words[0] = words[0].replace(/^\.\//, '');
  return words;
}

function conditions(value) {
  return normalized(value)
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('"', "'")
    .replace(/\s/g, '')
    .split('&&')
    .sort()
    .join('&&');
}
const reportsFailure = (value) =>
  value && ['', 'false'].includes(conditions(value['continue-on-error']));

export function validateJobQualification(workflow) {
  const errors = [];
  const concurrency = workflow?.concurrency;
  if (
    typeof concurrency?.group !== 'string' ||
    !concurrency.group.trim() ||
    /\$\{\{/.test(concurrency.group) ||
    concurrency['cancel-in-progress'] !== false ||
    concurrency.queue !== 'max'
  )
    errors.push('Job qualification requires one shared, uncancelled queue.');

  for (const provider of ['aws', 'gcp', 'azure', 'lambda']) {
    const cleanup = workflow.jobs['post-cleanup-' + provider];
    const needs = [cleanup?.needs].flat();
    const commands = (cleanup?.steps ?? []).filter((step) => {
      const command = invocation(step);
      return (
        command.length === 1 && command[0] === 'ci/cleanup/' + provider + '.ts'
      );
    });
    const command = commands[0];
    if (
      !reportsFailure(cleanup) ||
      !needs.includes('e2e-job-vitest') ||
      conditions(cleanup?.if) !== '!cancelled()&&always()' ||
      commands.length !== 1 ||
      !reportsFailure(command) ||
      !['', 'true', 'always()', '!cancelled()'].includes(
        conditions(command?.if),
      )
    )
      errors.push(
        'Required post-matrix cleanup must execute and propagate failure for ' +
          provider +
          '.',
      );
  }
  return errors;
}

export function inspectShellPolicy(root) {
  const workflowPath = '.github/workflows/e2e-job.yml';
  const errors = validateJobQualification(
    loadYaml(readFileSync(join(root, workflowPath), 'utf8')),
  ).map((error) => workflowPath + ': ' + error);
  for (const name of readdirSync(join(root, 'test/integration/helpers'))) {
    if (!name.endsWith('.sh') || /^(?:aws|azure|gcp|lambda)-/.test(name))
      continue;
    const path = 'test/integration/helpers/' + name;
    errors.push(
      ...validateSharedProviderPredicates(
        readFileSync(join(root, path), 'utf8'),
      ).map((error) => path + ': ' + error),
    );
  }
  for (const name of readdirSync(join(root, 'test/integration'), {
    recursive: true,
  })) {
    if (!name.endsWith('.sh')) continue;
    const path = 'test/integration/' + name;
    errors.push(
      ...validateShellTestExecution(readFileSync(join(root, path), 'utf8'), {
        requireScenario: name.endsWith('.test.sh') && !name.includes('/'),
      }).map((error) => path + ': ' + error),
    );
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length > 3) {
    console.error('usage: check-shell-test-policy.mjs [repository-root]');
    process.exitCode = 1;
  }
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = inspectShellPolicy(root);
  if (errors.length) {
    console.error('E2E shell policy check failed.');
    for (const error of errors) console.error('- ' + error);
    process.exitCode = 1;
  }
}
