import chalk from 'chalk';
import Table from 'cli-table3';
import { stripVTControlCharacters } from 'node:util';

/**
 * Builds a cli-table3 table that follows chalk's colour decision.
 *
 * cli-table3 styles heads and borders through `@colors/colors`, which never
 * checks whether stdout is a terminal, so piped tables would carry escape
 * codes. Dropping the styles when chalk is off keeps pipes and `NO_COLOR`
 * output plain while `FORCE_COLOR` and interactive terminals keep colour.
 */
export function newTable(options: Table.TableConstructorOptions = {}) {
  if (chalk.level > 0) return new Table(options);
  return new Table({
    ...options,
    style: { ...options.style, head: [], border: [] },
  });
}

function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      // Two spaces between columns, as `anycloud list` prints them (the
      // table pads one; the width adds the other).
      const width = stripVTControlCharacters(cell).length + 2;
      widths[index] = Math.max(widths[index] ?? 0, width);
    });
  }
  return widths;
}

/**
 * Borderless, space-aligned columns: the layout `anycloud list` uses, shared
 * by every resource list. Without widths, each column fits its widest cell.
 */
export function formatColumns(
  rows: string[][],
  colWidths: number[] = columnWidths(rows),
): string[] {
  const table = newTable({
    colWidths,
    rowHeights: rows.map(() => 1),
    wordWrap: false,
    chars: {
      top: '',
      'top-mid': '',
      'top-left': '',
      'top-right': '',
      bottom: '',
      'bottom-mid': '',
      'bottom-left': '',
      'bottom-right': '',
      left: '',
      'left-mid': '',
      mid: '',
      'mid-mid': '',
      right: '',
      'right-mid': '',
      middle: '',
    },
    style: {
      'padding-left': 0,
      'padding-right': 1,
      compact: true,
      head: [],
      border: [],
    },
  });
  table.push(
    ...rows.map((row) =>
      row.map((value) => stripVTControlCharacters(value).replace(/\s+/gu, ' ')),
    ),
  );
  return table
    .toString()
    .split('\n')
    .map((line) => line.trimEnd());
}
