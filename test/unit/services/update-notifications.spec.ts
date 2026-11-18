import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchLatestReleaseMock, sendToNotifiersMock } = vi.hoisted(() => ({
  fetchLatestReleaseMock: vi.fn(),
  sendToNotifiersMock: vi.fn(),
}));

vi.mock('../../../src/shared/releases.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/shared/releases.js')>();
  return {
    ...actual,
    fetchLatestRelease: fetchLatestReleaseMock,
  };
});

vi.mock('../../../src/api/services/notify.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/api/services/notify.js')
    >();
  return {
    ...actual,
    sendToNotifiers: sendToNotifiersMock,
  };
});

import config from '../../../src/api/config.js';
import { runUpdateNotificationOnce } from '../../../src/api/services/update-notifications.js';
import { getNotificationsStore } from '../../../src/api/services/persistence.js';
import {
  readVersionCache,
  versionCachePath,
} from '../../../src/shared/releases.js';
import { resetTestStore } from '../utils.js';

const RELEASE_URL =
  'https://github.com/anycloud-sh/releases/releases/tag/v1.1.0';

function release(version = '1.1.0') {
  return {
    version,
    url: RELEASE_URL.replace('v1.1.0', `v${version}`),
  };
}

function readNotificationReceipt(): Promise<string | null> {
  return getNotificationsStore().readReceipt('release');
}

describe('runUpdateNotificationOnce', () => {
  let stateDir: string;
  let originalHome: string | undefined;
  let originalAnycloudDir: string | undefined;
  let originalVersion: string;

  beforeEach(async () => {
    await resetTestStore();
    stateDir = mkdtempSync(join(tmpdir(), 'anycloud-update-notifications-'));
    originalHome = process.env.HOME;
    originalAnycloudDir = process.env.ANYCLOUD_DIR;
    originalVersion = config.currVersion;
    process.env.HOME = stateDir;
    process.env.ANYCLOUD_DIR = stateDir;
    config.currVersion = '1.0.0';

    fetchLatestReleaseMock.mockReset();
    fetchLatestReleaseMock.mockResolvedValue(release());
    sendToNotifiersMock.mockReset();
    sendToNotifiersMock.mockResolvedValue(true);
  });

  afterEach(() => {
    config.currVersion = originalVersion;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAnycloudDir === undefined) delete process.env.ANYCLOUD_DIR;
    else process.env.ANYCLOUD_DIR = originalAnycloudDir;
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function enableSlack(): Promise<void> {
    await getNotificationsStore().saveChannel('slack', {
      webhook: 'https://hooks.slack.com/services/T/B/x',
    });
  }

  async function disableSlack(): Promise<void> {
    await getNotificationsStore().deleteChannel('slack');
  }

  it('does not fetch a release when no notifier is configured', async () => {
    await runUpdateNotificationOnce();

    expect(fetchLatestReleaseMock).not.toHaveBeenCalled();
    expect(sendToNotifiersMock).not.toHaveBeenCalled();
  });

  it.each(['1.0.0', '0.9.0'])(
    'records discovery but does not notify for release %s',
    async (version) => {
      await enableSlack();
      fetchLatestReleaseMock.mockResolvedValue(release(version));

      await runUpdateNotificationOnce();

      expect(sendToNotifiersMock).not.toHaveBeenCalled();
      expect(readVersionCache()).toMatchObject({ latestVersion: version });
    },
  );

  it('links the release and records successful delivery', async () => {
    await enableSlack();

    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).toHaveBeenCalledOnce();
    const [notifiers, message] = sendToNotifiersMock.mock.calls[0];
    expect(notifiers).toHaveLength(1);
    expect(message).toContain('*Anycloud v1.1.0 is available*');
    expect(message).toContain('`anycloud update`');
    expect(message).toContain(`<${RELEASE_URL}|What's new in v1.1.0>`);
    expect(readVersionCache()).toMatchObject({
      latestVersion: '1.1.0',
      lastNotifiedVersion: '1.1.0',
    });
    await expect(readNotificationReceipt()).resolves.toBe('1.1.0');
  });

  it('does not repeat a persisted version and sends the next newest version', async () => {
    await enableSlack();

    await runUpdateNotificationOnce();
    await runUpdateNotificationOnce();
    expect(sendToNotifiersMock).toHaveBeenCalledTimes(1);

    fetchLatestReleaseMock.mockResolvedValue(release('1.3.0'));
    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).toHaveBeenCalledTimes(2);
    expect(sendToNotifiersMock.mock.calls[1][1]).toContain(
      '*Anycloud v1.3.0 is available*',
    );
    expect(readVersionCache()?.lastNotifiedVersion).toBe('1.3.0');
    await expect(readNotificationReceipt()).resolves.toBe('1.3.0');
  });

  it('does not repeat a release when a host CLI refresh drops the shared cache marker', async () => {
    await enableSlack();
    await runUpdateNotificationOnce();

    // A Linux API container and its host CLI can own this shared file as
    // different users. Model a CLI refresh that could not preserve fields from
    // the unreadable API-owned cache.
    writeFileSync(
      versionCachePath(),
      JSON.stringify({ latestVersion: '1.1.0', lastCheck: Date.now() }),
    );

    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).toHaveBeenCalledOnce();
    await expect(readNotificationReceipt()).resolves.toBe('1.1.0');
  });

  it('honors a manually seeded delivery receipt', async () => {
    await enableSlack();
    await getNotificationsStore().writeReceipt('release', '1.1.0');

    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).not.toHaveBeenCalled();
    expect(readVersionCache()).toMatchObject({ latestVersion: '1.1.0' });
  });

  it('ignores a receipt claiming a version newer than any release', async () => {
    // A corrupt receipt above the newest release cannot have come from a real
    // delivery, and trusting it would silence every future announcement.
    await enableSlack();
    await getNotificationsStore().writeReceipt('release', '9.9.9');

    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).toHaveBeenCalledOnce();
    await expect(readNotificationReceipt()).resolves.toBe('1.1.0');
  });

  it('retries after complete delivery failure', async () => {
    await enableSlack();
    sendToNotifiersMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runUpdateNotificationOnce();
    expect(readVersionCache()?.lastNotifiedVersion).toBeUndefined();
    await expect(readNotificationReceipt()).resolves.toBeNull();

    await runUpdateNotificationOnce();
    expect(sendToNotifiersMock).toHaveBeenCalledTimes(2);
    expect(readVersionCache()?.lastNotifiedVersion).toBe('1.1.0');
    await expect(readNotificationReceipt()).resolves.toBe('1.1.0');
  });

  it('recovers from a malformed cache', async () => {
    await enableSlack();
    writeFileSync(versionCachePath(), 'not json');

    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).toHaveBeenCalledOnce();
    expect(readVersionCache()).toMatchObject({
      latestVersion: '1.1.0',
      lastNotifiedVersion: '1.1.0',
    });
  });

  it('keeps delivery history while Slack is disabled and re-enabled', async () => {
    await enableSlack();
    await runUpdateNotificationOnce();

    await disableSlack();
    await runUpdateNotificationOnce();
    expect(fetchLatestReleaseMock).toHaveBeenCalledTimes(1);

    await enableSlack();
    await runUpdateNotificationOnce();

    expect(sendToNotifiersMock).toHaveBeenCalledTimes(1);
    expect(readVersionCache()?.lastNotifiedVersion).toBe('1.1.0');
  });
});
