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
  const listThrottles = vi.fn();
  const setThrottle = vi.fn();
  const unsetThrottle = vi.fn();
  return {
    listThrottles,
    setThrottle,
    unsetThrottle,
    createApiClient: vi.fn(() => ({
      spend: {
        throttles: {
          list: listThrottles,
          set: setThrottle,
          unset: unsetThrottle,
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

import { createThrottleCommand } from '../../../src/cli/commands/throttle.js';

describe('createThrottleCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    prompts.inject([]);
  });

  describe('set', () => {
    it('sets account-wide cap by default', async () => {
      await createThrottleCommand().parseAsync(['node', 'test', 'set', '20']);
      expect(rpcMocks.createApiClient).toHaveBeenCalledWith('test-token');
      expect(rpcMocks.setThrottle).toHaveBeenCalledWith({
        params: { scope: 'account' },
        body: { capUsd: 20 },
      });
    });

    it('--agent-session switches scope', async () => {
      await createThrottleCommand().parseAsync([
        'node',
        'test',
        'set',
        '5',
        '--agent-session',
      ]);
      expect(rpcMocks.setThrottle).toHaveBeenCalledWith({
        params: { scope: 'agent-session' },
        body: { capUsd: 5 },
      });
    });

    it('rejects zero', async () => {
      await expect(
        createThrottleCommand().parseAsync(['node', 'test', 'set', '0']),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setThrottle).not.toHaveBeenCalled();
    });

    it('rejects non-integer', async () => {
      await expect(
        createThrottleCommand().parseAsync(['node', 'test', 'set', '20.5']),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setThrottle).not.toHaveBeenCalled();
    });

    it('rejects negative', async () => {
      await expect(
        createThrottleCommand().parseAsync(['node', 'test', 'set', '-5']),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setThrottle).not.toHaveBeenCalled();
    });

    it('exits in non-TTY when cap is missing', async () => {
      await expect(
        createThrottleCommand().parseAsync(['node', 'test', 'set']),
      ).rejects.toThrow(/process.exit:1/);
      expect(rpcMocks.setThrottle).not.toHaveBeenCalled();
    });

    it('prompts for cap in TTY', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      prompts.inject([20]);
      await createThrottleCommand().parseAsync(['node', 'test', 'set']);
      expect(rpcMocks.setThrottle).toHaveBeenCalledWith({
        params: { scope: 'account' },
        body: { capUsd: 20 },
      });
    });
  });

  describe('show', () => {
    it('prints helpful hint when no throttles are set', async () => {
      rpcMocks.listThrottles.mockResolvedValue({
        entries: [],
        burnRate: { account: { currentUsd: 0 } },
      });
      await createThrottleCommand().parseAsync(['node', 'test', 'show']);
      const out = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(out).toContain('No throttles set');
      expect(out).toContain('anycloud throttle set 20');
    });

    it('renders account entry with current burn rate', async () => {
      rpcMocks.listThrottles.mockResolvedValue({
        entries: [{ scope: 'account', capUsd: 20, createdAt: 0, updatedAt: 0 }],
        burnRate: { account: { currentUsd: 12.5 } },
      });
      await createThrottleCommand().parseAsync(['node', 'test', 'show']);
      const out = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(out).toContain('account');
      expect(out).toContain('$12.50/hr current');
      expect(out).toContain('$20/hr cap');
    });

    it('renders agent-session entry without per-session burn rate (open-ended)', async () => {
      rpcMocks.listThrottles.mockResolvedValue({
        entries: [
          { scope: 'agent-session', capUsd: 5, createdAt: 0, updatedAt: 0 },
        ],
        burnRate: { account: { currentUsd: 0 } },
      });
      await createThrottleCommand().parseAsync(['node', 'test', 'show']);
      const out = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(out).toContain('agent-session');
      expect(out).toContain('$5/hr per session');
    });
  });

  describe('unset', () => {
    it('removes account-wide by default', async () => {
      await createThrottleCommand().parseAsync(['node', 'test', 'unset']);
      expect(rpcMocks.unsetThrottle).toHaveBeenCalledWith({
        params: { scope: 'account' },
      });
    });

    it('--agent-session removes per-session', async () => {
      await createThrottleCommand().parseAsync([
        'node',
        'test',
        'unset',
        '--agent-session',
      ]);
      expect(rpcMocks.unsetThrottle).toHaveBeenCalledWith({
        params: { scope: 'agent-session' },
      });
    });
  });
});
