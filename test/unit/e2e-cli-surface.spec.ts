import { describe, expect, test } from 'vitest';

import { cliArgs } from '../integration/e2e/internal/cli-surface.js';
import { cliSurface } from '../integration/e2e/internal/cli-surface.generated.js';

describe('checked-in CLI surface', () => {
  test('names the commands the harness drives as the CLI defines them', () => {
    expect(cliSurface['service'].options).not.toContain('json');
    expect(cliSurface['cluster list'].options).toEqual(['json']);
    expect(cliSurface['db query'].args).toEqual(['<sql>']);
  });
});

describe('cliArgs', () => {
  test('builds path, flags (repeated for arrays), positionals and the -- command', () => {
    expect(
      cliArgs(
        'service',
        { 'vm-type': 't3.small', id: 'd-1', env: ['PORT=80', 'A=b'] },
        ['nginx'],
      ),
    ).toEqual([
      'service',
      '--vm-type',
      't3.small',
      '--id',
      'd-1',
      '--env',
      'PORT=80',
      '--env',
      'A=b',
      'nginx',
    ]);
    expect(
      cliArgs('service upgrade', {}, ['d-1', 'nginx'], ['sh', '-c', 'x']),
    ).toEqual(['service', 'upgrade', 'd-1', 'nginx', '--', 'sh', '-c', 'x']);
    expect(cliArgs('cluster list', { json: true })).toEqual([
      'cluster',
      'list',
      '--json',
    ]);
    expect(cliArgs('db query', { json: true }, ['SELECT 1'])).toEqual([
      'db',
      'query',
      '--json',
      'SELECT 1',
    ]);
  });

  test('rejects unknown flags and wrong shapes at compile time', () => {
    // @ts-expect-error `service` has no --json (what tonight's run found live).
    expect(() => cliArgs('service', { json: true }, ['nginx'])).toThrow(
      'has no --json option',
    );
    // @ts-expect-error a switch takes a boolean, not a string.
    expect(() => cliArgs('cluster list', { json: 'yes' })).toThrow(
      'is a switch',
    );
    // Positional arity is a runtime check: the type does not count them.
    expect(() => cliArgs('service upgrade', {}, [])).toThrow(
      'takes <id> <image>',
    );
    // @ts-expect-error no such command path.
    expect(() => cliArgs('cluster creates', {})).toThrow();
  });
});
