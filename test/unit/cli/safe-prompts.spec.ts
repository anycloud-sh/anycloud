import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import {
  requireOrPrompt,
  shouldAllowPrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import prompts from 'prompts';

describe('shouldAllowPrompts', () => {
  const originalCI = process.env.CI;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('returns true when TTY and CI unset', () => {
    expect(shouldAllowPrompts()).toBe(true);
  });

  it('returns false when CI=true', () => {
    process.env.CI = 'true';
    expect(shouldAllowPrompts()).toBe(false);
  });

  it('returns false when CI=1', () => {
    process.env.CI = '1';
    expect(shouldAllowPrompts()).toBe(false);
  });

  it('returns true when CI=false', () => {
    process.env.CI = 'false';
    expect(shouldAllowPrompts()).toBe(true);
  });

  it('returns false when stdin is not a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    expect(shouldAllowPrompts()).toBe(false);
  });

  it('returns false when CI=true even if TTY', () => {
    process.env.CI = 'true';
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    expect(shouldAllowPrompts()).toBe(false);
  });
});

describe('requireOrPrompt', () => {
  const originalCI = process.env.CI;
  const originalIsTTY = process.stdin.isTTY;
  let exitSpy: MockInstance<typeof process.exit>;
  let consoleErrSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
    prompts.inject([]);
  });

  it('returns parsed value when provided is set (no prompt)', async () => {
    // Inject would block the prompt path; leaving it empty proves it isn't hit.
    const result = await requireOrPrompt('42', {
      parse: (raw) => Number(raw),
      missingError: 'missing',
      prompt: { type: 'number', name: 'value', message: 'x' },
    });
    expect(result).toBe(42);
  });

  it('exits with missingError when provided is undefined in non-TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    await expect(
      requireOrPrompt(undefined, {
        parse: (raw) => raw,
        missingError: 'need value!',
        prompt: { type: 'text', name: 'value', message: 'x' },
      }),
    ).rejects.toThrow(/process.exit:1/);
    const errOutput = consoleErrSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .join('');
    expect(errOutput).toContain('need value!');
  });

  it('prompts and returns parsed value in TTY when provided is undefined', async () => {
    prompts.inject(['100']);
    const result = await requireOrPrompt(undefined, {
      parse: (raw) => Number(raw) * 2,
      missingError: 'missing',
      prompt: { type: 'text', name: 'value', message: 'x' },
    });
    expect(result).toBe(200);
  });

  it('propagates parse errors so the caller can surface them', async () => {
    await expect(
      requireOrPrompt('bad', {
        parse: () => {
          throw new Error('parse failed');
        },
        missingError: 'missing',
        prompt: { type: 'text', name: 'value', message: 'x' },
      }),
    ).rejects.toThrow('parse failed');
  });
});
