import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// `open()` resolves with a ChildProcess; the CLI only ever listens for its
// 'error' event. `Object.create` returns `any`, so an emitter stands in for the
// full ChildProcess surface without a cast.
function fakeChildProcess(): ChildProcess {
  return Object.create(new EventEmitter());
}

// Mock open before importing oauth
vi.mock('open', () => ({
  default: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', () => ({
  printSuccess: vi.fn(),
  printInfo: vi.fn(),
  printError: vi.fn(),
  printHighlight: vi.fn(),
  createSpinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
  })),
}));

vi.mock('../../../src/shared/config.js', () => ({
  githubTokenPath: () => '/tmp/test-token',
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import open from 'open';
import { printInfo } from '../../../src/cli/utils/output.js';
import { authenticateWithGitHub } from '../../../src/cli/services/oauth.js';

async function completeAuthentication(): Promise<string> {
  const promise = authenticateWithGitHub();
  await vi.advanceTimersByTimeAsync(6_000);
  return promise;
}

function mockFetch() {
  let fetchCall = 0;
  global.fetch = vi.fn(() => {
    fetchCall++;
    if (fetchCall === 1) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            device_code: 'test-device-code',
            user_code: 'TEST-CODE',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'test-token-123' }),
    });
  }) as any;
}

describe('authenticateWithGitHub', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalDisplay: string | undefined;
  let originalWayland: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    // vitest 4 narrowed restoreAllMocks to manually-created spies, so module
    // factory mocks (like `open`) keep their call history without this.
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalDisplay = process.env.DISPLAY;
    originalWayland = process.env.WAYLAND_DISPLAY;
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    if (originalDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = originalDisplay;
    }
    if (originalWayland === undefined) {
      delete process.env.WAYLAND_DISPLAY;
    } else {
      process.env.WAYLAND_DISPLAY = originalWayland;
    }
    vi.useRealTimers();
  });

  it('should not crash when open returns a subprocess that emits ENOENT error', async () => {
    // open() resolves once spawn is called and reports a failed spawn through
    // an 'error' event on the returned process. With no listener attached that
    // emit throws, terminating the CLI when xdg-open is missing.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const fakeSubprocess = fakeChildProcess();
    vi.mocked(open).mockResolvedValue(fakeSubprocess);

    setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error('spawn xdg-open ENOENT');
      err.code = 'ENOENT';
      fakeSubprocess.emit('error', err);
    }, 10);

    const token = await completeAuthentication();

    expect(token).toBe('test-token-123');
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('github.com/login/device'),
    );
    expect(printInfo).toHaveBeenCalledWith(
      'If the browser did not open, use the URL above',
    );
  });

  it('should auto-open the browser when a display is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(open).mockResolvedValue(fakeChildProcess());

    const token = await completeAuthentication();

    expect(token).toBe('test-token-123');
    expect(open).toHaveBeenCalled();
  });

  it('should not call open on headless Linux (no DISPLAY)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    const token = await completeAuthentication();

    expect(token).toBe('test-token-123');
    expect(open).not.toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(
      'Open the URL above in a browser to authenticate',
    );
  });

  it('should call open on Linux with DISPLAY set', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;

    vi.mocked(open).mockResolvedValue(fakeChildProcess());

    const token = await completeAuthentication();

    expect(token).toBe('test-token-123');
    expect(open).toHaveBeenCalled();
  });
});
