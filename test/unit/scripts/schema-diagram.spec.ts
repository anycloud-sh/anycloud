import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  diffSchemas,
  readSchema,
  renderChangeTable,
  renderDiagram,
  selectTables,
} from '../../../scripts/schema-diagram.js';

// owners 1:N items (NOT NULL, CASCADE); items 1:1 item_details (PK is the FK).
const BASE = `
  CREATE TABLE owners (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    note TEXT
  );
  CREATE TABLE item_details (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    body TEXT
  );
  CREATE TABLE unrelated (id TEXT PRIMARY KEY);
`;

const schemaOf = (sql: string) => {
  const db = new BetterSqlite3(':memory:');
  db.exec(sql);
  return readSchema(db);
};
const lines = (...rows: string[]) => rows.join('\n');

describe('schema-diagram', () => {
  const before = schemaOf(BASE);

  it('draws every foreign key as a labelled edge with cardinality from NOT NULL, PK and UNIQUE', () => {
    expect(renderDiagram(before, selectTables([before]))).toBe(
      lines(
        'erDiagram',
        '  items ||--o| item_details : "item_id → items.id CASCADE"',
        '  owners ||--o{ items : "owner_id → owners.id CASCADE"',
        '  item_details {',
        '    text item_id PK, FK',
        '    text body',
        '  }',
        '  items {',
        '    text id PK',
        '    text owner_id FK "NOT NULL"',
        '    text note',
        '  }',
        '  owners {',
        '    text id PK',
        '    text email UK "NOT NULL"',
        '  }',
        '  unrelated {',
        '    text id PK',
        '  }',
      ),
    );
  });

  it('shows focus tables in full and their direct neighbours by keys only', () => {
    const names = selectTables([before], ['items']);
    expect(names).toEqual(['item_details', 'items', 'owners']);
    const diagram = renderDiagram(before, names, ['items']);
    expect(diagram).toContain('    text note\n');
    expect(diagram).toContain(
      '  owners {\n    text id PK\n    text _more "2 columns; keys only"\n  }',
    );
    expect(diagram).not.toContain('body');
  });

  it('tags added tables, columns and foreign keys, and lists them in the change table', () => {
    const after = schemaOf(
      BASE.replace('note TEXT', 'note TEXT NOT NULL').replace(
        'body TEXT',
        "body TEXT, reviewer_id TEXT REFERENCES owners(id) CHECK (reviewer_id <> '')",
      ) + 'CREATE TABLE tags (item_id TEXT REFERENCES items);',
    );
    const names = selectTables([before, after]);
    const { changes, tags } = diffSchemas(before, after, names);
    const diagram = renderDiagram(after, names, names, tags.added);
    expect(diagram).toContain(
      '  owners |o--o{ item_details : "reviewer_id → owners.id, added"',
    );
    expect(diagram).toContain('  items |o--o{ tags : "item_id → items.id"');
    expect(diagram).toContain('    text reviewer_id FK "added"');
    expect(diagram).toContain('    text note "NOT NULL, changed"');
    expect(diagram).toContain('  tags {\n    text item_id FK "added"\n  }');
    expect(changes).toEqual([
      [
        'item_details',
        'reviewer_id',
        'column added',
        "reviewer_id TEXT REFERENCES owners(id) CHECK (reviewer_id <> '')",
      ],
      [
        'item_details',
        'reviewer_id',
        'foreign key added',
        'reviewer_id → owners.id',
      ],
      [
        'items',
        'note',
        'column changed from `note TEXT`',
        'note TEXT NOT NULL',
      ],
      ['tags', '', 'table added', ''],
    ]);
    expect(renderChangeTable(changes)).toContain(
      '| `tags` |  | table added |  | _fill in_ |',
    );
    expect(renderChangeTable([])).toBe('No schema change in these tables.');
  });

  it('reads a column that follows a -- comment as a column, not a constraint', () => {
    const sql = (type: string) => `CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      -- the body, kept short, with commas
      body ${type}
    );`;
    const names = ['notes'];
    const { changes } = diffSchemas(
      schemaOf(sql('TEXT')),
      schemaOf(sql('TEXT NOT NULL')),
      names,
    );
    expect(changes).toEqual([
      [
        'notes',
        'body',
        'column changed from `body TEXT`',
        'body TEXT NOT NULL',
      ],
    ]);
  });
});
