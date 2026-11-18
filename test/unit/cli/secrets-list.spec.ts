import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn());

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);
vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({ secrets: { list } }),
}));
vi.mock('../../../src/cli/utils/output.js', () => ({
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
}));

import { createListCommand } from '../../../src/cli/commands/secrets/list.js';

describe('secrets list command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    list.mockResolvedValue(
      ['hf', '_job-1-token'].map((name) => ({
        name,
        createdAt: 0,
        updatedAt: 0,
      })),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const rendered = () =>
    vi
      .mocked(console.log)
      .mock.calls.flatMap((args) => args)
      .join('\n');

  it('hides Secrets whose names start with _ unless --all is passed', async () => {
    await createListCommand().parseAsync(['node', 'test']);
    expect(rendered()).toContain('hf');
    expect(rendered()).not.toContain('_job-1-token');

    await createListCommand().parseAsync(['node', 'test', '--all']);
    expect(rendered()).toContain('_job-1-token');
  });
});
