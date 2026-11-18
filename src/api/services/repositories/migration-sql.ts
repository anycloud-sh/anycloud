/** SQL inspection only: SQLite still parses and executes the complete body. */
interface SqlToken {
  text: string;
  keyword?: string;
  start: number;
  end: number;
}

interface SqlStatement {
  tokens: SqlToken[];
  start: number;
  end: number;
}

interface HistoricalEnvelope {
  before: readonly string[];
  after: readonly string[];
  disableForeignKeys: boolean;
}

const FOREIGN_KEYS_ENVELOPE: HistoricalEnvelope = {
  before: ['PRAGMA FOREIGN_KEYS = OFF'],
  after: ['PRAGMA FOREIGN_KEYS = ON'],
  disableForeignKeys: true,
};
const TRANSACTION_ENVELOPE: HistoricalEnvelope = {
  before: ['BEGIN TRANSACTION'],
  after: ['COMMIT'],
  disableForeignKeys: false,
};
const REBUILD_ENVELOPE: HistoricalEnvelope = {
  before: ['PRAGMA FOREIGN_KEYS = OFF', 'BEGIN TRANSACTION'],
  after: ['COMMIT', 'PRAGMA FOREIGN_KEYS = ON'],
  disableForeignKeys: true,
};

// Existing SQL stays immutable. Only these exact files delegate their known
// outer connection/transaction controls to the runner. New SQL has no envelope.
const HISTORICAL_ENVELOPES: Readonly<Record<string, HistoricalEnvelope>> = {
  '0010_add_panic_signals.sql': FOREIGN_KEYS_ENVELOPE,
  '0015_remove_panic_signals.sql': FOREIGN_KEYS_ENVELOPE,
  '0025_nullable_vm_ip.sql': FOREIGN_KEYS_ENVELOPE,
  '0042_enforce_credential_fks.sql': REBUILD_ENVELOPE,
  '0043_credential_id_array.sql': REBUILD_ENVELOPE,
  '0087_add_cluster_registry.sql': REBUILD_ENVELOPE,
  '0093_vm_release_alerts.sql': TRANSACTION_ENVELOPE,
  '0100_rename_cluster_deployments_to_workers.sql': TRANSACTION_ENVELOPE,
};

const CONNECTION_CONTROL = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'VACUUM',
]);

function tokenize(sql: string): SqlToken[] {
  if (sql.includes('\0')) throw new Error('Migration SQL contains a NUL byte');
  const tokens: SqlToken[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const start = offset;
    const char = sql[offset];
    if (/\s/.test(char)) {
      offset++;
      continue;
    }
    if (sql.startsWith('--', offset)) {
      const newline = sql.indexOf('\n', offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', offset)) {
      const end = sql.indexOf('*/', offset + 2);
      if (end === -1) throw new Error('Unterminated migration SQL comment');
      offset = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      offset++;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] !== closing) continue;
        if (char !== '[' && sql[offset] === closing) {
          offset++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated quoted migration SQL token');
      tokens.push({ text: sql.slice(start, offset), start, end: offset });
      continue;
    }
    if (/[a-z_]/i.test(char)) {
      while (offset < sql.length && /[a-z0-9_$]/i.test(sql[offset])) offset++;
      const text = sql.slice(start, offset);
      tokens.push({ text, keyword: text.toUpperCase(), start, end: offset });
      continue;
    }
    offset++;
    tokens.push({ text: char, start, end: offset });
  }
  return tokens;
}

/**
 * Locate outer statements without splitting trigger programs. A trigger's END
 * follows a complete semicolon-terminated step; CASE END and quoted/commented
 * words within a step do not end the trigger. Invalid SQL is left to SQLite.
 */
function statements(sql: string): SqlStatement[] {
  const result: SqlStatement[] = [];
  let current: SqlToken[] = [];
  let trigger = false;
  let triggerBody = false;
  let stepStart = false;
  let triggerEnd = false;
  for (const token of tokenize(sql)) {
    if (token.text === ';' && (!trigger || triggerEnd)) {
      if (current.length > 0) {
        result.push({
          tokens: current,
          start: current[0].start,
          end: token.end,
        });
      }
      current = [];
      trigger = triggerBody = stepStart = triggerEnd = false;
      continue;
    }
    current.push(token);
    const words = current.slice(0, 3).map((entry) => entry.keyword);
    trigger =
      trigger ||
      (words[0] === 'CREATE' &&
        (words[1] === 'TRIGGER' ||
          ((words[1] === 'TEMP' || words[1] === 'TEMPORARY') &&
            words[2] === 'TRIGGER')));
    if (!trigger) continue;
    if (!triggerBody) {
      if (token.keyword === 'BEGIN') {
        triggerBody = true;
        stepStart = true;
      }
    } else if (token.text === ';') {
      stepStart = true;
    } else {
      if (stepStart && token.keyword === 'END') triggerEnd = true;
      stepStart = false;
    }
  }
  if (current.length > 0) {
    result.push({
      tokens: current,
      start: current[0].start,
      end: current[current.length - 1].end,
    });
  }
  return result;
}

function normalized(statement: SqlStatement): string {
  return statement.tokens.map((token) => token.keyword ?? token.text).join(' ');
}

export function prepareMigrationSql(
  filename: string,
  sql: string,
): { sql: string; disableForeignKeys: boolean } {
  const parsed = statements(sql);
  const envelope = HISTORICAL_ENVELOPES[filename];
  const removed = new Set<SqlStatement>();
  if (envelope) {
    if (parsed.length <= envelope.before.length + envelope.after.length) {
      throw new Error(`Unexpected historical migration envelope: ${filename}`);
    }
    const outer = [
      ...envelope.before.map((expected, index) => ({
        expected,
        statement: parsed[index],
      })),
      ...envelope.after.map((expected, index) => ({
        expected,
        statement: parsed[parsed.length - envelope.after.length + index],
      })),
    ];
    for (const { expected, statement } of outer) {
      if (normalized(statement) !== expected) {
        throw new Error(
          `Unexpected historical migration envelope: ${filename}`,
        );
      }
      removed.add(statement);
    }
  }
  for (const statement of parsed) {
    if (removed.has(statement)) continue;
    const first = statement.tokens[0].keyword;
    if (first && CONNECTION_CONTROL.has(first)) {
      throw new Error(
        `Migration ${filename} contains runner-owned SQL control: ${first}`,
      );
    }
  }
  // Remove only token spans of the audited envelope, preserving body bytes,
  // comments, and compound trigger statements for native SQLite execution.
  let body = sql;
  for (const statement of [...removed].sort((a, b) => b.start - a.start)) {
    body = body.slice(0, statement.start) + body.slice(statement.end);
  }
  return {
    sql: body,
    disableForeignKeys: envelope?.disableForeignKeys ?? false,
  };
}
