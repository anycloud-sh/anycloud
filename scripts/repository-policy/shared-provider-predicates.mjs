import { parseShell } from './shell.mjs';

const providerVariable =
  /\$\{?(?:\w*provider\w*|(?:\w*_)?cloud_type|cloudType|cloud)(?=[^a-zA-Z0-9_]|$)/i;
const providerLiteral =
  /(?:["'](?:AWS|Azure|GCP|Lambda)["']|(?:==?|!=|=~)\s*(?:AWS|Azure|GCP|Lambda)\s*\])/i;

export function sharedProviderPredicates(source) {
  const root = parseShell(source);
  const predicates = new Map();
  for (const node of root.descendantsOfType([
    'test_command',
    'case_statement',
    'command',
  ])) {
    if (
      node.type === 'command' &&
      node.childForFieldName('name')?.text !== 'test'
    )
      continue;
    const subject =
      node.type === 'case_statement'
        ? (node.childForFieldName('value')?.text ?? '')
        : node.text;
    const namedArms =
      node.type === 'case_statement' &&
      node.namedChildren
        .filter((child) => child.type === 'case_item')
        .some((child) =>
          /^(?:aws|azure|gcp|lambda|kubernetes)(?:\||\))/.test(
            child.text
              .replaceAll('"', '')
              .replaceAll("'", '')
              .trim()
              .toLowerCase(),
          ),
        );
    if (
      !(
        providerVariable.test(subject) ||
        providerLiteral.test(subject) ||
        namedArms
      ) ||
      (node.type !== 'case_statement' && !/(?:\s[=!~]=?\s|=~)/.test(subject))
    )
      continue;
    let predicate = node;
    let owner = node.parent;
    while (owner && owner.type !== 'function_definition') {
      if (
        node.type !== 'case_statement' &&
        ['if_statement', 'elif_clause', 'while_statement'].includes(owner.type)
      ) {
        const delimiter = owner.children.find((child) =>
          ['then', 'do'].includes(child.type),
        );
        if (delimiter && node.endIndex <= delimiter.startIndex) {
          predicate = {
            text: source.slice(owner.startIndex, delimiter.endIndex),
            startIndex: owner.startIndex,
            startPosition: owner.startPosition,
          };
        }
      }
      owner = owner.parent;
    }
    predicates.set(predicate.startIndex, {
      owner: owner?.childForFieldName('name')?.text ?? '<module>',
      line: predicate.startPosition.row + 1,
    });
  }
  return [...predicates.values()];
}

export function validateSharedProviderPredicates(source) {
  return sharedProviderPredicates(source).map(
    ({ owner, line }) =>
      'line ' +
      line +
      ': ' +
      owner +
      ' branches on a provider; move the decision to its provider fixture.',
  );
}
