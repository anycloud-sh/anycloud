import { Command } from 'commander';
import { describe, expect, test } from 'vitest';

import {
  cliSurfaceFromCommands,
  optionSpec,
  renderCliSurface,
} from '../../../scripts/generate-cli-surface.ts';

describe('CLI surface generator', () => {
  const tree = () => {
    const cluster = new Command('cluster');
    cluster
      .command('create')
      .argument('<name>')
      .requiredOption('--credentials <name>', 'c')
      .option('--zone <zone>', 'z')
      .option('--no-wait', 'w')
      .option('--json', 'j')
      .option('--secret-hidden', 'h', undefined)
      .action(() => undefined);
    cluster.commands[0].options.at(-1).hideHelp();
    const del = cluster
      .command('delete')
      .aliases(['rm'])
      .argument('<id-or-name>')
      .argument('[extra...]');
    del.action(() => undefined);
    return [cluster];
  };

  test('walks every command, keyed by path, with aliases and option specs', () => {
    expect(cliSurfaceFromCommands(tree())).toEqual({
      cluster: { args: [], options: [] },
      'cluster create': {
        args: ['<name>'],
        options: ['credentials=!', 'zone=', 'no-wait', 'json'],
      },
      'cluster delete': { args: ['<id-or-name>', '[extra...]'], options: [] },
      'cluster rm': { args: ['<id-or-name>', '[extra...]'], options: [] },
    });
    expect(() => optionSpec({ flags: '-x', long: undefined })).toThrow(
      'without a long flag',
    );
  });

  test('renders one command per line as a const object', () => {
    const rendered = renderCliSurface(cliSurfaceFromCommands(tree()));
    expect(rendered).toContain(
      "  'cluster create': { args: ['<name>'], options: ['credentials=!', 'zone=', 'no-wait', 'json'] },",
    );
    expect(rendered).toMatch(/\} as const;\n\nexport type CliSurface/u);
  });
});
