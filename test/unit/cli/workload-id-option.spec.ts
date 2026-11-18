import { describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { createSubmitCommand } from '../../../src/cli/commands/submit.js';
import { createServeCommand } from '../../../src/cli/commands/serve.js';
import { createVmCommand } from '../../../src/cli/commands/vm.js';

// The `--id` parser runs while Commander parses flags, before the action
// that resolves credentials and calls the API.
describe.each([
  ['job', createSubmitCommand],
  ['service', createServeCommand],
  ['vm', createVmCommand],
])('%s --id', (_name, create: () => Command) => {
  function parse(id: string) {
    const action = vi.fn();
    const command = create()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined })
      .action(action);
    return {
      action,
      run: command.parseAsync(['--id', id, 'nginx:latest'], { from: 'user' }),
    };
  }

  it('refuses a 29-character ID before the action runs', async () => {
    const { action, run } = parse('cpm-41698254719-1-aws-cold-10');
    // Commander names the ID once; the reason doesn't repeat it.
    await expect(run).rejects.toThrow(
      "error: option '-i, --id <id>' argument 'cpm-41698254719-1-aws-cold-10' is invalid. It is 29 characters; the limit is 28.",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('passes a trimmed 28-character ID to the action', async () => {
    const { action, run } = parse(' cpm-41698254719-1-aws-cold-9 ');
    await run;
    // Commander passes the options before the command itself.
    expect(action.mock.calls[0].at(-2)).toMatchObject({
      id: 'cpm-41698254719-1-aws-cold-9',
    });
  });
});
