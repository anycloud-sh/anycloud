import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const sourceRoot = resolve(root, 'src');

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

const files = sourceFiles(sourceRoot);
const fileSet = new Set(files);
const imports = new Map(files.map((file) => [file, new Set()]));

function resolveImport(importer, source) {
  if (!source.startsWith('.')) return undefined;
  const base = resolve(dirname(importer), source.replace(/\.js$/, ''));
  return [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find(
    (candidate) => fileSet.has(candidate),
  );
}

for (const file of files) {
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const statement of parsed.statements) {
    const source =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (!source || !ts.isStringLiteral(source)) continue;
    const target = resolveImport(file, source.text);
    if (target) imports.get(file).add(target);
  }
}

let nextIndex = 0;
const indexes = new Map();
const lowLinks = new Map();
const stack = [];
const stacked = new Set();
const cycles = [];

function visit(file) {
  indexes.set(file, nextIndex);
  lowLinks.set(file, nextIndex);
  nextIndex += 1;
  stack.push(file);
  stacked.add(file);

  for (const imported of imports.get(file)) {
    if (!indexes.has(imported)) {
      visit(imported);
      lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(imported)));
    } else if (stacked.has(imported)) {
      lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(imported)));
    }
  }

  if (lowLinks.get(file) !== indexes.get(file)) return;
  const component = [];
  for (;;) {
    const member = stack.pop();
    stacked.delete(member);
    component.push(member);
    if (member === file) break;
  }
  if (
    component.length > 1 ||
    (component.length === 1 && imports.get(file).has(file))
  ) {
    cycles.push(component);
  }
}

for (const file of files) {
  if (!indexes.has(file)) visit(file);
}

if (cycles.length > 0) {
  const details = cycles
    .map(
      (cycle, index) =>
        `Cycle ${index + 1}:\n${cycle
          .map((file) => `  ${relative(root, file)}`)
          .sort()
          .join('\n')}`,
    )
    .join('\n');
  console.error(`Source module cycles are not allowed.\n${details}`);
  process.exit(1);
}

console.log(`Module cycle check passed (${files.length} source modules).`);
