// Prints the Data model: Before / After section CONTRIBUTING.md requires: the
// schema at the merge base with `--base` and on this branch, each built by
// running that tree's startup migration runner on an empty in-memory
// database, as mermaid erDiagrams, plus the change table. Run through tsx
// (`yarn schema:diagram [--base <ref>] [--tables a,b]`).

import BetterSqlite3 from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runMigrations } from '../src/api/services/repositories/migrations.js';

interface Column {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  definition: string;
}
interface ForeignKey {
  from: string[];
  table: string;
  to: string[];
  onDelete: string;
}
interface Table {
  columns: Column[];
  foreignKeys: ForeignKey[];
  uniqueSets: string[][];
  extras: string[];
}
export type Schema = Record<string, Table>;
/** One change-table row: table, column, change, constraint or trigger. */
export type Change = [string, string, string, string];

/** Splits a CREATE TABLE body into its top-level comma-separated definitions. */
function definitions(sql: string): string[] {
  sql = sql.replace(/--[^\n]*/g, '');
  const parts = [''];
  let depth = 0;
  for (const char of sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'))) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (char === ',' && depth === 0) parts.push('');
    else parts[parts.length - 1] += char;
  }
  return parts.map((part) => part.replace(/\s+/g, ' ').trim());
}

export function readSchema(db: BetterSqlite3.Database): Schema {
  const all = <T>(sql: string) => db.prepare(sql).all() as T[];
  const schema: Schema = {};
  const tables = all<{ name: string; type: string }>('PRAGMA table_list');
  for (const { name } of tables.filter(
    (t) => t.type === 'table' && !/^(sqlite_|_)/.test(t.name),
  )) {
    const objects = all<{ type: string; name: string; sql: string | null }>(
      `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = '${name}' ORDER BY name`,
    );
    const parts = definitions(objects.find((o) => o.type === 'table')!.sql!);
    const columns = all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>(`PRAGMA table_info("${name}")`).map((c) => ({
      name: c.name,
      type: (c.type || 'any').toLowerCase().split('(')[0].replace(/\W+/g, '_'),
      notnull: c.notnull === 1,
      pk: c.pk > 0,
      definition:
        parts.find((p) => p.split(' ')[0].replace(/["`[\]]/g, '') === c.name) ??
        '',
    }));
    const foreignKeys: ForeignKey[] = [];
    for (const fk of all<{
      id: number;
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>(`PRAGMA foreign_key_list("${name}")`)) {
      foreignKeys[fk.id] ??= {
        from: [],
        table: fk.table,
        to: [],
        onDelete: fk.on_delete,
      };
      foreignKeys[fk.id].from.push(fk.from);
      foreignKeys[fk.id].to.push(fk.to ?? '');
    }
    const uniqueSets = [columns.filter((c) => c.pk).map((c) => c.name)];
    for (const index of all<{ name: string; unique: number; partial: number }>(
      `PRAGMA index_list("${name}")`,
    )) {
      if (index.unique && !index.partial)
        uniqueSets.push(
          all<{ name: string }>(`PRAGMA index_info("${index.name}")`).map(
            (c) => c.name,
          ),
        );
    }
    const extras = [
      ...parts.filter((p) => !columns.some((c) => c.definition === p)),
      ...objects
        // Automatic indexes have no SQL; their UNIQUE or PRIMARY KEY clause shows.
        .filter((o) => o.type !== 'table' && o.sql)
        .map((o) => o.sql!.replace(/\s+/g, ' ')),
    ];
    schema[name] = { columns, foreignKeys, uniqueSets, extras };
  }
  // A foreign key that names no target column references the target's key.
  for (const fk of Object.values(schema).flatMap((t) => t.foreignKeys)) {
    if (fk.to.includes('')) fk.to = schema[fk.table]?.uniqueSets[0] ?? fk.to;
  }
  return schema;
}

/** Builds the schema the migrations in this checkout produce. */
export async function buildSchema(): Promise<Schema> {
  const sqlite = new BetterSqlite3(':memory:');
  const log = console.log;
  console.log = () => {};
  try {
    await runMigrations({
      get inTransaction() {
        return sqlite.inTransaction;
      },
      exec: (sql) => void sqlite.exec(sql),
      query<T>(sql: string, params: unknown[] = []): T[] {
        const statement = sqlite.prepare(sql);
        return statement.reader
          ? (statement.all(...params) as T[])
          : ([{ rowsAffected: statement.run(...params).changes }] as T[]);
      },
    });
  } finally {
    console.log = log;
  }
  return readSchema(sqlite);
}

/** `<col> → <table>.<col> <ON DELETE rule>`, leaving out NO ACTION. */
const fkLabel = (fk: ForeignKey) =>
  `${fk.from.join(', ')} → ${fk.table}.${fk.to.join(', ')}${fk.onDelete === 'NO ACTION' ? '' : ` ${fk.onDelete}`}`;
const fkKey = (table: string, fk: ForeignKey) => `${table}: ${fkLabel(fk)}`;
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The named tables plus their direct foreign-key neighbours, in either schema. */
export function selectTables(schemas: Schema[], tables?: string[]): string[] {
  const names = [...new Set(schemas.flatMap((s) => Object.keys(s)))].sort();
  if (!tables) return names;
  const selected = new Set(tables);
  for (const s of schemas)
    for (const [name, t] of Object.entries(s))
      for (const fk of t.foreignKeys)
        if (tables.includes(name) || tables.includes(fk.table)) {
          selected.add(name);
          selected.add(fk.table);
        }
  return names.filter((name) => selected.has(name));
}

/** Draws `names`; tables outside `focus` show only their key and tagged columns. */
export function renderDiagram(
  schema: Schema,
  names: string[],
  focus = names,
  tags = new Map<string, string>(),
): string {
  const shown = names.filter((name) => schema[name]);
  const lines = ['erDiagram'];
  for (const name of shown) {
    for (const fk of schema[name].foreignKeys.filter((f) =>
      shown.includes(f.table),
    )) {
      const required = fk.from.every((col) => {
        const column = schema[name].columns.find((c) => c.name === col);
        return column?.notnull || column?.pk;
      });
      const single = schema[name].uniqueSets.some((set) =>
        sameSet(set, fk.from),
      );
      const tag = tags.get(fkKey(name, fk));
      const label = `${fkLabel(fk)}${tag ? `, ${tag}` : ''}`;
      lines.push(
        `  ${fk.table} ${required ? '||' : '|o'}--${single ? 'o|' : 'o{'} ${name} : "${label}"`,
      );
    }
  }
  for (const name of shown) {
    const { columns, foreignKeys, uniqueSets } = schema[name];
    const referenced = shown.flatMap((other) =>
      schema[other].foreignKeys
        .filter((fk) => fk.table === name)
        .flatMap((fk) => fk.to),
    );
    lines.push(`  ${name} {`);
    for (const c of columns) {
      const keys = [
        c.pk && 'PK',
        foreignKeys.some((fk) => fk.from.includes(c.name)) && 'FK',
        !c.pk && uniqueSets.some((set) => sameSet(set, [c.name])) && 'UK',
      ].filter(Boolean);
      const tag = tags.get(`${name}.${c.name}`) ?? tags.get(name);
      const notes = [c.notnull && 'NOT NULL', tag].filter(Boolean).join(', ');
      const key = c.pk || foreignKeys.some((fk) => fk.from.includes(c.name));
      if (focus.includes(name) || key || referenced.includes(c.name) || tag)
        lines.push(
          `    ${c.type} ${c.name}${keys.length ? ` ${keys.join(', ')}` : ''}${notes ? ` "${notes}"` : ''}`,
        );
    }
    if (!focus.includes(name))
      lines.push(`    text _more "${columns.length} columns; keys only"`);
    lines.push('  }');
  }
  return lines.join('\n');
}

/** Lists what changed from `before` to `after`, and the tags each side's diagram carries. */
export function diffSchemas(before: Schema, after: Schema, names: string[]) {
  const changes: Change[] = [];
  const tags = {
    added: new Map<string, string>(),
    removed: new Map<string, string>(),
  };
  for (const name of names) {
    const [b, a] = [before[name], after[name]];
    if (!b || !a) {
      const side = a ? 'added' : 'removed';
      tags[side].set(name, side);
      changes.push([name, '', `table ${side}`, '']);
      for (const extra of (a ?? b).extras)
        changes.push([name, '', side, extra]);
      continue;
    }
    for (const [side, from, to] of [
      ['removed', a, b],
      ['added', b, a],
    ] as const) {
      for (const c of to.columns.filter(
        (c) => !from.columns.some((x) => x.name === c.name),
      )) {
        tags[side].set(`${name}.${c.name}`, side);
        changes.push([name, c.name, `column ${side}`, c.definition]);
      }
      for (const fk of to.foreignKeys.filter(
        (f) => !from.foreignKeys.some((x) => fkKey(name, x) === fkKey(name, f)),
      )) {
        tags[side].set(fkKey(name, fk), side);
        changes.push([
          name,
          fk.from.join(', '),
          `foreign key ${side}`,
          fkLabel(fk),
        ]);
      }
      for (const extra of to.extras.filter((x) => !from.extras.includes(x)))
        changes.push([name, '', side, extra]);
    }
    for (const c of a.columns) {
      const old = b.columns.find((x) => x.name === c.name);
      if (!old || old.definition === c.definition) continue;
      tags.added.set(`${name}.${c.name}`, 'changed');
      changes.push([
        name,
        c.name,
        `column changed from \`${old.definition}\``,
        c.definition,
      ]);
    }
  }
  return { changes, tags };
}

export function renderChangeTable(changes: Change[]): string {
  if (!changes.length) return 'No schema change in these tables.';
  const code = (text: string) =>
    text ? `\`${text.replace(/\|/g, '\\|')}\`` : '';
  return [
    '| Table | Column | Change | Constraint or trigger | Writer |',
    '| --- | --- | --- | --- | --- |',
    ...changes.map(
      ([table, column, change, constraint]) =>
        `| ${code(table)} | ${code(column)} | ${change} | ${code(constraint)} | _fill in_ |`,
    ),
    '',
    'The schema cannot show which module writes a table, so fill in the Writer column.',
  ].join('\n');
}

/** Builds the schema at `commit` with that commit's own runner, from an extracted copy of its tree. */
function buildBaseSchema(repoRoot: string, commit: string): Schema {
  const tree = mkdtempSync(join(tmpdir(), 'schema-diagram-'));
  try {
    const archive = execFileSync(
      'git',
      ['archive', commit, 'src', 'migrations', 'package.json'],
      { cwd: repoRoot, maxBuffer: 1 << 30 },
    );
    execFileSync('tar', ['-x', '-C', tree], { input: archive });
    symlinkSync(join(repoRoot, 'node_modules'), join(tree, 'node_modules'));
    cpSync(
      fileURLToPath(import.meta.url),
      join(tree, 'scripts/schema-diagram.ts'),
    );
    const json = execFileSync(
      join(repoRoot, 'node_modules/.bin/tsx'),
      ['scripts/schema-diagram.ts', '--json'],
      { cwd: tree, maxBuffer: 1 << 30 },
    );
    return JSON.parse(json.toString()) as Schema;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

async function main() {
  const options = {
    base: { type: 'string', default: 'origin/main' },
    tables: { type: 'string' },
    json: { type: 'boolean' },
  } as const;
  const { values } = parseArgs({ options });
  const after = await buildSchema();
  if (values.json) return void process.stdout.write(JSON.stringify(after));
  const focus = values.tables?.split(',').map((t) => t.trim());
  const fence = (diagram: string) => `\`\`\`mermaid\n${diagram}\n\`\`\``;
  // Like a PR diff, compare against the merge base, not the base ref's tip.
  const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repoRoot }).toString().trim();
  const mergeBase = git('merge-base', values.base, 'HEAD');
  const before = buildBaseSchema(repoRoot, mergeBase);
  const names = selectTables([before, after], focus);
  const { changes, tags } = diffSchemas(before, after, names);
  console.log(
    [
      '### Data model: Before / After',
      `Before (merge base with \`${values.base}\`, ${mergeBase.slice(0, 9)}):\n\n${fence(renderDiagram(before, names, focus, tags.removed))}`,
      `After (this branch):\n\n${fence(renderDiagram(after, names, focus, tags.added))}`,
      renderChangeTable(changes),
    ].join('\n\n'),
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  await main();
