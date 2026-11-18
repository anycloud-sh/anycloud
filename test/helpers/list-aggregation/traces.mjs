import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';

export function requestJournal(file) {
  let sequence = 0;
  return (event, record) =>
    appendFileSync(
      file,
      JSON.stringify({ sequence: sequence++, event, ...record }) + '\n',
    );
}

export function readRequestJournal(file, complete = true) {
  const rows = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const records = new Map();
  const settled = new Set();
  for (const [index, row] of rows.entries()) {
    assert.equal(row.sequence, index, 'Missing or duplicate trace sequence');
    assert(['offered', 'settled'].includes(row.event), 'Unknown request event');
    if (row.event === 'offered') {
      assert(!records.has(row.id), 'Duplicate offered request');
      records.set(row.id, row);
    } else {
      assert(
        records.has(row.id) && !settled.has(row.id),
        'Unexpected request settlement',
      );
      settled.add(row.id);
      records.set(row.id, row);
    }
  }
  if (complete)
    assert.equal(settled.size, records.size, 'Unfinished request trace');
  return [...records.values()].map(
    ({ sequence: _sequence, event: _event, ...record }) => record,
  );
}
