import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import prompts from 'prompts';

// `open()` resolves with a ChildProcess; the CLI only ever listens for its
// 'error' event. `Object.create` returns `any`, so an emitter stands in for the
// full ChildProcess surface without a cast.
function fakeChildProcess(): ChildProcess {
  return Object.create(new EventEmitter());
}

vi.mock('open', () => ({
  default: vi.fn(),
}));

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

// Notification config lives on the API now, so the command surface is asserted
// against the client rather than against files on disk.
const { listMock, saveMock, deleteMock, testMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  saveMock: vi.fn(),
  deleteMock: vi.fn(),
  testMock: vi.fn(),
}));

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: vi.fn(() => ({
    notifications: {
      list: listMock,
      save: saveMock,
      delete: deleteMock,
      test: testMock,
    },
  })),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

import { createNotificationsCommand } from '../../../src/cli/commands/notifications.js';
import { truncateWebhook } from '../../../src/shared/notifications/slack.js';
import open from 'open';
import { printError, printInfo } from '../../../src/cli/utils/output.js';

describe('truncateWebhook', () => {
  it('masks the team/bot/token segments', () => {
    expect(
      truncateWebhook(
        'https://hooks.slack.com/services/T0123/B4567/xABCDEFGHIJKLMNOP',
      ),
    ).toBe('https://hooks.slack.com/services/T0…/B4…/xA…');
  });

  it('does not echo an unrecognized URL', () => {
    expect(truncateWebhook('https://example.com/secret')).toBe(
      'invalid webhook URL',
    );
  });

  it('does not reveal complete short path segments', () => {
    expect(truncateWebhook('https://hooks.slack.com/services/T/B/x')).toBe(
      'https://hooks.slack.com/services/T…/B…/x…',
    );
  });
});

describe('createNotificationsCommand: Slack setup', () => {
  let browserProcess: ChildProcess;
  let exitSpy: MockInstance<typeof process.exit>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let consoleErrSpy: MockInstance<typeof console.error>;
  const originalIsTTY = process.stdin.isTTY;
  let originalDisplay: string | undefined;

  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    saveMock.mockReset().mockResolvedValue(undefined);
    deleteMock.mockReset().mockResolvedValue({ removed: true });
    testMock.mockReset().mockResolvedValue(undefined);
    browserProcess = fakeChildProcess();
    vi.mocked(open).mockReset();
    vi.mocked(open).mockResolvedValue(browserProcess);
    vi.mocked(printInfo).mockClear();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    delete process.env.CI;
    originalDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ':0';
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    if (originalDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = originalDisplay;
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    consoleErrSpy.mockRestore();
    prompts.inject([]);
  });

  function savedWebhook(): string | undefined {
    return saveMock.mock.calls[0]?.[0]?.body?.webhook;
  }

  it('saves config when --webhook is provided', async () => {
    await createNotificationsCommand().parseAsync([
      'node',
      'test',
      'enable',
      'slack',
      '--webhook',
      'https://hooks.slack.com/services/T/B/x',
    ]);
    expect(testMock).toHaveBeenCalledOnce();
    expect(savedWebhook()).toBe('https://hooks.slack.com/services/T/B/x');
  });

  it('asks the API to verify the webhook before storing it', async () => {
    await createNotificationsCommand().parseAsync([
      'node',
      'test',
      'enable',
      'slack',
      '--webhook',
      'https://hooks.slack.com/services/T/B/x',
    ]);

    // The candidate webhook travels with the test so the API proves delivery
    // from where notifications actually originate.
    expect(testMock).toHaveBeenCalledWith({
      params: { channel: 'slack' },
      body: { webhook: 'https://hooks.slack.com/services/T/B/x' },
    });
    expect(testMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveMock.mock.invocationCallOrder[0],
    );
  });

  it('opens Slack and prompts when connect is run in a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    prompts.inject(['https://hooks.slack.com/services/T/B/connected']);

    await createNotificationsCommand().parseAsync([
      'node',
      'test',
      'connect',
      'slack',
    ]);

    expect(open).toHaveBeenCalledWith('https://slack.anycloud.sh/install');
    expect(printInfo).toHaveBeenCalledWith(
      'Slack installation: https://slack.anycloud.sh/install',
    );
    expect(testMock).toHaveBeenCalledOnce();
    expect(savedWebhook()).toBe(
      'https://hooks.slack.com/services/T/B/connected',
    );
  });

  it('does not open Slack when connect is run non-interactively', async () => {
    vi.mocked(printError).mockClear();

    await expect(
      createNotificationsCommand().parseAsync([
        'node',
        'test',
        'connect',
        'slack',
      ]),
    ).rejects.toThrow(/process.exit:1/);

    expect(open).not.toHaveBeenCalled();
    expect(testMock).not.toHaveBeenCalled();
    expect(vi.mocked(printError).mock.calls.flat().join(' ')).toContain(
      'requires an interactive terminal',
    );
  });

  it('still prompts when the browser launch rejects', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    vi.mocked(open).mockRejectedValue(new Error('no browser'));
    prompts.inject(['https://hooks.slack.com/services/T/B/manual']);

    await createNotificationsCommand().parseAsync([
      'node',
      'test',
      'connect',
      'slack',
    ]);

    expect(printInfo).toHaveBeenCalledWith(
      'The browser did not open; use the URL above.',
    );
    expect(savedWebhook()).toBe('https://hooks.slack.com/services/T/B/manual');
  });

  it('survives a browser process that fails to spawn', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    prompts.inject(['https://hooks.slack.com/services/T/B/spawnfail']);

    await createNotificationsCommand().parseAsync([
      'node',
      'test',
      'connect',
      'slack',
    ]);

    // `open()` resolves once spawn is called and reports a failed spawn through
    // an 'error' event on the returned process. With no listener attached this
    // emit throws instead of printing, which is how a missing `xdg-open` used
    // to terminate the CLI mid-flow.
    const spawnError: NodeJS.ErrnoException = new Error(
      'spawn xdg-open ENOENT',
    );
    spawnError.code = 'ENOENT';
    browserProcess.emit('error', spawnError);

    expect(printInfo).toHaveBeenCalledWith(
      'The browser did not open; use the URL above.',
    );
    expect(savedWebhook()).toBe(
      'https://hooks.slack.com/services/T/B/spawnfail',
    );
  });

  it('exits in non-TTY when --webhook is missing', async () => {
    await expect(
      createNotificationsCommand().parseAsync([
        'node',
        'test',
        'enable',
        'slack',
      ]),
    ).rejects.toThrow(/process.exit:1/);
    expect(testMock).not.toHaveBeenCalled();
    const errOutput = consoleErrSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .join('');
    expect(errOutput).toContain('--webhook required');
  });

  it('exits via printError when --webhook is malformed', async () => {
    vi.mocked(printError).mockClear();
    await expect(
      createNotificationsCommand().parseAsync([
        'node',
        'test',
        'enable',
        'slack',
        '--webhook',
        'not-a-slack-url',
      ]),
    ).rejects.toThrow(/process.exit:1/);
    expect(testMock).not.toHaveBeenCalled();
    const calls = vi.mocked(printError).mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.startsWith('invalid webhook:'))).toBe(true);
  });

  it('rejects a Slack-looking URL with query parameters', async () => {
    await expect(
      createNotificationsCommand().parseAsync([
        'node',
        'test',
        'enable',
        'slack',
        '--webhook',
        'https://hooks.slack.com/services/T/B/x?leak=true',
      ]),
    ).rejects.toThrow(/process.exit:1/);
    expect(testMock).not.toHaveBeenCalled();
  });

  it('does not save when the Slack test post fails', async () => {
    testMock.mockRejectedValueOnce(new Error('revoked'));

    await expect(
      createNotificationsCommand().parseAsync([
        'node',
        'test',
        'enable',
        'slack',
        '--webhook',
        'https://hooks.slack.com/services/T/B/revoked',
      ]),
    ).rejects.toThrow(/process.exit:1/);

    expect(saveMock).not.toHaveBeenCalled();
  });

  it('prompts for webhook in TTY when --webhook missing', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    prompts.inject(['https://hooks.slack.com/services/T/B/y']);
    await createNotificationsCommand().parseAsync([
      'node',
      'test',
      'enable',
      'slack',
    ]);
    expect(testMock).toHaveBeenCalledOnce();
    expect(savedWebhook()).toBe('https://hooks.slack.com/services/T/B/y');
  });
});

describe('createNotificationsCommand: status and disable', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    deleteMock.mockReset().mockResolvedValue({ removed: true });
    vi.mocked(printInfo).mockClear();
  });

  it('names the API it is describing when nothing is configured', async () => {
    await createNotificationsCommand().parseAsync(['node', 'test', 'status']);

    // Reporting local state without naming the API is what made a hosted API
    // look configured when it was not.
    const printed = vi.mocked(printInfo).mock.calls.flat().join(' ');
    expect(printed).toContain('no channels configured on');
    expect(listMock).toHaveBeenCalledOnce();
  });

  it('shows the masked webhook the API reports', async () => {
    listMock.mockResolvedValue([
      {
        channel: 'slack',
        webhook: 'https://hooks.slack.com/services/T0…/B4…/xA…',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    await createNotificationsCommand().parseAsync(['node', 'test', 'status']);

    const printed = vi.mocked(printInfo).mock.calls.flat().join(' ');
    expect(printed).toContain('slack: https://hooks.slack.com/services/T0…');
  });

  it('reports when there was nothing to disable', async () => {
    deleteMock.mockResolvedValue({ removed: false });

    await createNotificationsCommand().parseAsync(['node', 'test', 'disable']);

    const printed = vi.mocked(printInfo).mock.calls.flat().join(' ');
    expect(printed).toContain('no channels were configured.');
  });
});
