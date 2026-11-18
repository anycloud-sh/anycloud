import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatColumns,
  newTable,
} from '../../../../src/cli/renderers/table.js';

const level = chalk.level;
afterEach(() => {
  chalk.level = level;
});

const styled = () =>
  newTable({ head: ['NAME'], style: { head: ['bold'], border: ['dim'] } });

describe('newTable', () => {
  it('renders without escape codes when chalk has colour off', () => {
    chalk.level = 0;
    const table = styled();
    table.push(['a']);

    expect(table.options.style).toMatchObject({ head: [], border: [] });
    expect(table.toString()).not.toContain('\x1b[');
  });

  it('keeps the requested styles when chalk has colour on', () => {
    chalk.level = 1;

    expect(styled().options.style).toMatchObject({
      head: ['bold'],
      border: ['dim'],
    });
  });
});

describe('formatColumns', () => {
  it('sizes each column to its widest cell, without borders', () => {
    expect(
      formatColumns([
        ['NAME', 'STATE'],
        ['production', 'ready'],
        ['dev', 'bootstrapping'],
      ]),
    ).toEqual([
      'NAME        STATE',
      'production  ready',
      'dev         bootstrapping',
    ]);
  });
});
