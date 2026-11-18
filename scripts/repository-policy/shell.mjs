import Parser from 'tree-sitter';
import Bash from 'tree-sitter-bash';

const parser = new Parser().setLanguage(Bash);

export function parseShell(source) {
  return parser.parse(source).rootNode;
}

function shellWord(node) {
  if (!node) return '';
  if (node.type === 'raw_string') return node.text.slice(1, -1);
  if (['string', 'concatenation', 'command_name'].includes(node.type)) {
    return node.namedChildren.map(shellWord).join('');
  }
  return node.text.replace(/\\\r?\n/g, '').replace(/\\([ \\"'])/g, '$1');
}

// Parse Bash without executing it. Tree-sitter keeps commands distinct from
// comments, quoted data, here-documents, and nested command substitutions.
export function shellCommands(source) {
  const root = parseShell(source);
  const commands = [];
  for (const node of root.descendantsOfType([
    'command',
    'variable_assignment',
  ])) {
    if (node.type === 'variable_assignment' && node.parent?.type === 'command')
      continue;
    const tokens =
      node.type === 'variable_assignment'
        ? [
            shellWord(node.childForFieldName('name')) +
              '=' +
              shellWord(node.childForFieldName('value')),
          ]
        : node.namedChildren
            .filter((child) => child.type !== 'comment')
            .map((child) =>
              child.type === 'variable_assignment'
                ? shellWord(child.childForFieldName('name')) +
                  '=' +
                  shellWord(child.childForFieldName('value'))
                : shellWord(child),
            );
    let owner = node.parent;
    while (owner && owner.type !== 'function_definition') owner = owner.parent;
    tokens.functionName = owner?.childForFieldName('name')?.text;
    tokens.scopes = ['root'];
    const scopes = [];
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (
        ['function_definition', 'subshell', 'command_substitution'].includes(
          ancestor.type,
        )
      )
        scopes.unshift(String(ancestor.startIndex));
    }
    tokens.scopes.push(...scopes);
    commands.push(tokens);
  }
  for (const error of root.descendantsOfType('ERROR')) {
    if (
      /test\/integration\/|experiments\/|\b(?:yarn|npx|tsx|node|bash)\b/.test(
        error.text,
      )
    ) {
      throw new Error(
        'Unparsed shell launcher at line ' +
          (error.startPosition.row + 1) +
          '; use a literal command.',
      );
    }
  }
  return commands;
}
