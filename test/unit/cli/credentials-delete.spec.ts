import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

const api = vi.hoisted(() => ({
  deleteCredential: vi.fn(),
  listCredentials: vi.fn(),
}));

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  safePrompts: vi.fn(),
  shouldAllowPrompts: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    printError: vi.fn(),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
  };
});

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    credentials: {
      delete: api.deleteCredential,
      list: api.listCredentials,
    },
  }),
}));

import { createDeleteCommand } from '../../../src/cli/commands/credentials/delete.js';
import {
  safePrompts,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';

describe('credentials delete command', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    api.listCredentials.mockResolvedValue([
      { name: 'prod-aws', cloudProvider: 'AWS' },
      { name: 'staging-azure', cloudProvider: 'Azure' },
    ]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('deletes the provided credential name without prompting', async () => {
    await createDeleteCommand().parseAsync(['node', 'test', 'prod-aws']);

    expect(safePrompts).not.toHaveBeenCalled();
    expect(api.deleteCredential).toHaveBeenCalledWith({
      params: { name: 'prod-aws' },
      query: { force: 'false' },
    });
  });

  it('opens a picker when no credential name is provided', async () => {
    vi.mocked(safePrompts).mockResolvedValueOnce({
      credential: 'staging-azure',
    });

    await createDeleteCommand().parseAsync(['node', 'test', '--force']);

    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'autocomplete',
        name: 'credential',
        message: 'Pick credentials to delete',
      }),
    );
    expect(api.deleteCredential).toHaveBeenCalledWith({
      params: { name: 'staging-azure' },
      query: { force: 'true' },
    });
  });

  it('exits instead of prompting when no name is provided non-interactively', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);

    await expect(
      createDeleteCommand().parseAsync(['node', 'test']),
    ).rejects.toThrow(/process\.exit:1/);

    expect(safePrompts).not.toHaveBeenCalled();
    expect(api.deleteCredential).not.toHaveBeenCalled();
  });
});
