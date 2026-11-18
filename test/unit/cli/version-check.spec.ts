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
  maybeShowVersionBanner,
  internals,
} from '../../../src/cli/utils/version-check';

describe('maybeShowVersionBanner', () => {
  let stderrWrite: MockInstance<typeof process.stderr.write>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(internals, 'fetchLatestVersion').mockResolvedValue(null);
    vi.spyOn(internals, 'writeCache').mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('shows the banner when cache says a newer release is available', () => {
    vi.spyOn(internals, 'readCache').mockReturnValue({
      latestVersion: '0.2.0',
      lastCheck: Date.now(),
    });

    maybeShowVersionBanner('0.1.8');

    expect(stderrWrite).toHaveBeenCalledOnce();
    const written = stderrWrite.mock.calls[0][0] as string;
    expect(written).toContain('0.1.8');
    expect(written).toContain('0.2.0');
    expect(written).toContain('anycloud update');
  });

  it('does not show the banner when the cached version matches', () => {
    vi.spyOn(internals, 'readCache').mockReturnValue({
      latestVersion: '0.1.8',
      lastCheck: Date.now(),
    });

    maybeShowVersionBanner('0.1.8');

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('does not show the banner when the local version is ahead of the cache', () => {
    vi.spyOn(internals, 'readCache').mockReturnValue({
      latestVersion: '0.1.0',
      lastCheck: Date.now(),
    });

    maybeShowVersionBanner('0.1.8');

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('skips when stdout is not a TTY (scripts, agents, CI)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    const readCache = vi.spyOn(internals, 'readCache');
    const fetchLatestVersion = vi.spyOn(internals, 'fetchLatestVersion');

    maybeShowVersionBanner('0.1.8');

    expect(readCache).not.toHaveBeenCalled();
    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('fires a refresh fetch when no cache is present', () => {
    vi.spyOn(internals, 'readCache').mockReturnValue(null);
    const fetchLatestVersion = vi.spyOn(internals, 'fetchLatestVersion');

    maybeShowVersionBanner('0.1.8');

    expect(fetchLatestVersion).toHaveBeenCalledOnce();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('shows the cached banner AND refreshes when the cache is stale', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    vi.spyOn(internals, 'readCache').mockReturnValue({
      latestVersion: '0.2.0',
      lastCheck: Date.now() - 2 * dayMs,
    });
    const fetchLatestVersion = vi.spyOn(internals, 'fetchLatestVersion');

    maybeShowVersionBanner('0.1.8');

    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(fetchLatestVersion).toHaveBeenCalledOnce();
  });

  it('does not refresh when the cache is fresh (within the check interval)', () => {
    vi.spyOn(internals, 'readCache').mockReturnValue({
      latestVersion: '0.1.8',
      lastCheck: Date.now() - 60 * 1000,
    });
    const fetchLatestVersion = vi.spyOn(internals, 'fetchLatestVersion');

    maybeShowVersionBanner('0.1.8');

    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });

  it('writes the cache after a successful fetch', async () => {
    vi.spyOn(internals, 'readCache').mockReturnValue(null);
    vi.spyOn(internals, 'fetchLatestVersion').mockResolvedValue('0.2.0');
    const writeCache = vi.spyOn(internals, 'writeCache');

    maybeShowVersionBanner('0.1.8');
    // Let the unawaited fetch promise resolve.
    await new Promise((resolve) => setImmediate(resolve));

    expect(writeCache).toHaveBeenCalledOnce();
    const cache = writeCache.mock.calls[0][0];
    expect(cache.latestVersion).toBe('0.2.0');
    expect(typeof cache.lastCheck).toBe('number');
  });

  it('does not write the cache when the fetch returns null', async () => {
    vi.spyOn(internals, 'readCache').mockReturnValue(null);
    vi.spyOn(internals, 'fetchLatestVersion').mockResolvedValue(null);
    const writeCache = vi.spyOn(internals, 'writeCache');

    maybeShowVersionBanner('0.1.8');
    await new Promise((resolve) => setImmediate(resolve));

    expect(writeCache).not.toHaveBeenCalled();
  });
});
