import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectSession,
  resolveSessionScope,
} from '../../../src/cli/session/detect';
import { sessionTitleAgents } from '../helpers/agent-session-title';

const nonInteractive = () => false;

describe.each(sessionTitleAgents)('$agent session detection', (fixture) => {
  const id = 'abc-123-def';

  it('uses the native session identifier', () => {
    expect(
      detectSession({
        env: fixture.env(id),
        ppid: 4242,
        isInteractive: nonInteractive,
        readTitle: () => null,
      }),
    ).toEqual({ session: id, agent: fixture.agent });
  });

  it('trims a native session id and passes it to the title reader', () => {
    const readTitle = vi.fn(() => 'Make sessions readable');
    expect(
      detectSession({
        env: fixture.env(`  ${id}  `),
        isInteractive: nonInteractive,
        readTitle,
      }),
    ).toEqual({
      session: id,
      agent: fixture.agent,
      label: 'Make sessions readable',
    });
    expect(readTitle).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('omits the label when no title is available', () => {
    expect(
      detectSession({
        env: fixture.env(id),
        isInteractive: nonInteractive,
        readTitle: () => null,
      })?.label,
    ).toBeUndefined();
  });

  it('clamps the session id and label to 64 characters', () => {
    const readTitle = vi.fn(() => 'y'.repeat(100));
    expect(
      detectSession({
        env: fixture.env('x'.repeat(100)),
        isInteractive: nonInteractive,
        readTitle,
      }),
    ).toEqual({
      session: 'x'.repeat(64),
      agent: fixture.agent,
      label: 'y'.repeat(64),
    });
    expect(readTitle).toHaveBeenCalledWith('x'.repeat(64));
  });

  it.each([undefined, '', '   '])(
    'falls back to the parent process with a marker and no native id (%j)',
    (nativeId) => {
      expect(
        detectSession({
          env: {
            [fixture.markerEnv]: '1',
            [fixture.sessionEnv]: nativeId,
          },
          ppid: 99,
          isInteractive: nonInteractive,
          readTitle: () => null,
        }),
      ).toEqual({ session: `${fixture.agent}-99`, agent: fixture.agent });
    },
  );

  it('does not read a title when the interactive guard suppresses detection', () => {
    const readTitle = vi.fn(() => 'unused');
    expect(
      detectSession({
        env: fixture.env(id),
        isInteractive: () => true,
        readTitle,
      }),
    ).toBeNull();
    expect(readTitle).not.toHaveBeenCalled();
  });

  describe('production TTY guard', () => {
    const originalIn = process.stdin.isTTY;
    const originalOut = process.stdout.isTTY;

    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIn,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalOut,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      process.stdin.isTTY = originalIn;
      process.stdout.isTTY = originalOut;
    });

    it.each([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ])('checks both streams (stdin=%s, stdout=%s)', (stdin, stdout) => {
      process.stdin.isTTY = stdin;
      process.stdout.isTTY = stdout;
      const result = detectSession({
        env: fixture.env(id),
        readTitle: () => null,
      });
      expect(result).toEqual(
        stdin || stdout ? null : { session: id, agent: fixture.agent },
      );
    });

    it('uses the production reader without a title for an unknown session', () => {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;
      expect(
        detectSession({ env: fixture.env('no-such-session-9f3a2b7c4d') }),
      ).toEqual({
        session: 'no-such-session-9f3a2b7c4d',
        agent: fixture.agent,
      });
    });
  });

  describe('read scope', () => {
    const detected = () => ({ session: id, agent: fixture.agent });

    it('defaults to the detected native session', () => {
      expect(resolveSessionScope({}, detected)).toEqual({
        session: id,
        autoScoped: true,
      });
    });

    it('explicit --session selects historical process-based sessions', () => {
      const detect = vi.fn(detected);
      expect(resolveSessionScope({ session: 'codex-4242' }, detect)).toEqual({
        session: 'codex-4242',
        agent: undefined,
        autoScoped: false,
      });
      expect(detect).not.toHaveBeenCalled();
    });

    it('explicit --agent overrides automatic scope', () => {
      expect(resolveSessionScope({ agent: 'codex' }, detected)).toEqual({
        session: undefined,
        agent: 'codex',
        autoScoped: false,
      });
    });
  });
});

describe('agent recognition and precedence', () => {
  it.each([true, false])(
    'returns null without a signal (interactive=%s)',
    (tty) => {
      expect(detectSession({ env: {}, isInteractive: () => tty })).toBeNull();
    },
  );

  it('preserves Claude marker requirements', () => {
    expect(
      detectSession({
        env: { CLAUDE_CODE_SESSION_ID: 'claude-session' },
        isInteractive: nonInteractive,
      }),
    ).toBeNull();
  });

  it.each([undefined, '', '   '])(
    'ignores a blank Codex thread without a marker (%j)',
    (id) => {
      expect(
        detectSession({
          env: { CODEX_THREAD_ID: id },
          isInteractive: nonInteractive,
        }),
      ).toBeNull();
    },
  );

  it('prefers Codex native identity when CODEX_BIN_PATH is also present', () => {
    expect(
      detectSession({
        env: {
          CODEX_BIN_PATH: '/usr/bin/codex',
          CODEX_THREAD_ID: 'native-thread',
        },
        ppid: 4242,
        isInteractive: nonInteractive,
        readTitle: () => null,
      }),
    ).toEqual({ session: 'native-thread', agent: 'codex' });
  });

  it.each([
    { env: { AIDER_MODEL: 'gpt-4' }, session: 'aider-4242', agent: 'aider' },
    {
      env: { CURSOR_TRACE_ID: 'trace-xyz' },
      session: 'trace-xyz',
      agent: 'cursor',
    },
    {
      env: { CODEX_BIN_PATH: '/usr/bin/codex' },
      session: 'codex-4242',
      agent: 'codex',
    },
  ])(
    'preserves $agent fallback and never reads an unsupported title',
    ({ env, session, agent }) => {
      const readTitle = vi.fn(() => 'unused');
      expect(
        detectSession({
          env,
          ppid: 4242,
          isInteractive: nonInteractive,
          readTitle,
        }),
      ).toEqual({ session, agent });
      expect(readTitle).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      env: {
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'claude-session',
        CODEX_THREAD_ID: 'codex-thread',
        CURSOR_TRACE_ID: 'cursor-trace',
      },
      session: 'claude-session',
      agent: 'claude',
    },
    {
      env: { CODEX_THREAD_ID: 'codex-thread', CURSOR_TRACE_ID: 'cursor-trace' },
      session: 'codex-thread',
      agent: 'codex',
    },
    {
      env: { CURSOR_TRACE_ID: 'cursor-trace', AIDER_MODEL: 'gpt-4' },
      session: 'cursor-trace',
      agent: 'cursor',
    },
  ])('keeps $agent precedence over later agents', ({ env, session, agent }) => {
    expect(
      detectSession({
        env,
        isInteractive: nonInteractive,
        readTitle: () => null,
      }),
    ).toEqual({ session, agent });
  });

  it('does not scope an untagged invocation', () => {
    expect(resolveSessionScope({}, () => null)).toEqual({ autoScoped: false });
  });
});
