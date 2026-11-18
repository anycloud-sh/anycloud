import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import prompts from 'prompts';

const rpcMocks = vi.hoisted(() => {
  const listBudgets = vi.fn();
  const setBudget = vi.fn();
  const unsetBudget = vi.fn();
  return {
    listBudgets,
    setBudget,
    unsetBudget,
    createApiClient: vi.fn(() => ({
      spend: {
        budgets: {
          list: listBudgets,
          set: setBudget,
          unset: unsetBudget,
        },
      },
    })),
  };
});

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    printSuccess: vi.fn(),
    printError: vi.fn(),
    printInfo: vi.fn(),
  };
});

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: rpcMocks.createApiClient,
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

import { createBudgetCommand } from '../../../src/cli/commands/budget.js';

describe('createBudgetCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  const originalIsTTY = process.stdin.isTTY;
  let consoleErrSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default to non-TTY so missing-arg tests hit the exit path.
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    delete process.env.CI;
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    // exitWithError → real printError → console.error; the printError mock
    // above only catches direct printError calls from command code.
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleErrSpy.mockRestore();
    prompts.inject([]);
  });

  function enableTTY(): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
  }

  describe('set', () => {
    it('account-wide day cap', async () => {
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'set',
        '100',
        '--per',
        'day',
      ]);
      expect(rpcMocks.createApiClient).toHaveBeenCalledWith('test-token');
      expect(rpcMocks.setBudget).toHaveBeenCalledWith({
        params: { period: 'day', scope: 'account' },
        body: { capUsd: 100 },
      });
    });

    it('--agent-session scope', async () => {
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'set',
        '50',
        '--per',
        'day',
        '--agent-session',
      ]);
      expect(rpcMocks.setBudget).toHaveBeenCalledWith({
        params: { period: 'day', scope: 'agent-session' },
        body: { capUsd: 50 },
      });
    });

    it('accepts week and month', async () => {
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'set',
        '500',
        '--per',
        'week',
      ]);
      expect(rpcMocks.setBudget).toHaveBeenLastCalledWith({
        params: { period: 'week', scope: 'account' },
        body: { capUsd: 500 },
      });
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'set',
        '2000',
        '--per',
        'month',
      ]);
      expect(rpcMocks.setBudget).toHaveBeenLastCalledWith({
        params: { period: 'month', scope: 'account' },
        body: { capUsd: 2000 },
      });
    });

    it('exits in non-TTY when --per is missing', async () => {
      await expect(
        createBudgetCommand().parseAsync(['node', 'test', 'set', '100']),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setBudget).not.toHaveBeenCalled();
      const errOutput = consoleErrSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .join('');
      expect(errOutput).toContain('--per required');
    });

    it('exits in non-TTY when cap is missing', async () => {
      await expect(
        createBudgetCommand().parseAsync([
          'node',
          'test',
          'set',
          '--per',
          'day',
        ]),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setBudget).not.toHaveBeenCalled();
      const errOutput = consoleErrSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .join('');
      expect(errOutput).toContain('Cap required');
    });

    it('prompts for cap and period when both missing in TTY', async () => {
      enableTTY();
      prompts.inject([100, 'month']);
      await createBudgetCommand().parseAsync(['node', 'test', 'set']);
      expect(rpcMocks.setBudget).toHaveBeenCalledWith({
        params: { period: 'month', scope: 'account' },
        body: { capUsd: 100 },
      });
    });

    it('prompts only for cap when --per provided in TTY', async () => {
      enableTTY();
      prompts.inject([250]);
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'set',
        '--per',
        'week',
      ]);
      expect(rpcMocks.setBudget).toHaveBeenCalledWith({
        params: { period: 'week', scope: 'account' },
        body: { capUsd: 250 },
      });
    });

    it('rejects invalid period', async () => {
      await expect(
        createBudgetCommand().parseAsync([
          'node',
          'test',
          'set',
          '100',
          '--per',
          'yearly',
        ]),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setBudget).not.toHaveBeenCalled();
    });

    it('rejects non-integer cap', async () => {
      await expect(
        createBudgetCommand().parseAsync([
          'node',
          'test',
          'set',
          '100.5',
          '--per',
          'day',
        ]),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setBudget).not.toHaveBeenCalled();
    });
  });

  describe('show', () => {
    it('prints hint when no budgets are set', async () => {
      rpcMocks.listBudgets.mockResolvedValue({ entries: [], spend: [] });
      await createBudgetCommand().parseAsync(['node', 'test', 'show']);
      const out = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(out).toContain('No budgets set');
      expect(out).toContain('--per day');
    });

    it('renders account budget with spend + reset', async () => {
      const endMs = Date.UTC(2026, 4, 25);
      rpcMocks.listBudgets.mockResolvedValue({
        entries: [
          {
            period: 'day',
            scope: 'account',
            capUsd: 100,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        spend: [
          {
            period: 'day',
            scope: 'account',
            startMs: endMs - 86_400_000,
            endMs,
            actualUsd: 30,
            estimatedUsd: 10,
            totalUsd: 40,
          },
        ],
      });
      await createBudgetCommand().parseAsync(['node', 'test', 'show']);
      const out = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(out).toContain('day');
      expect(out).toContain('$40.00 / $100');
      expect(out).toContain('$30.00 actual');
      expect(out).toContain('$10.00 estimate');
    });
  });

  describe('unset', () => {
    it('account-wide day', async () => {
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'unset',
        '--per',
        'day',
      ]);
      expect(rpcMocks.unsetBudget).toHaveBeenCalledWith({
        params: { period: 'day', scope: 'account' },
      });
    });

    it('--agent-session', async () => {
      await createBudgetCommand().parseAsync([
        'node',
        'test',
        'unset',
        '--per',
        'month',
        '--agent-session',
      ]);
      expect(rpcMocks.unsetBudget).toHaveBeenCalledWith({
        params: { period: 'month', scope: 'agent-session' },
      });
    });

    it('exits in non-TTY when --per is missing', async () => {
      await expect(
        createBudgetCommand().parseAsync(['node', 'test', 'unset']),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.unsetBudget).not.toHaveBeenCalled();
    });

    it('prompts for period in TTY', async () => {
      enableTTY();
      prompts.inject(['day']);
      await createBudgetCommand().parseAsync(['node', 'test', 'unset']);
      expect(rpcMocks.unsetBudget).toHaveBeenCalledWith({
        params: { period: 'day', scope: 'account' },
      });
    });
  });
});
