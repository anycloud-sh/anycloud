import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotificationsDomain } from '../../../src/api/services/notifications-domain.js';
import { importLegacyNotificationsConfig } from '../../../src/api/services/notifications-legacy-import.js';
import { getNotificationsStore } from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { resetTestStore } from '../utils.js';

const WEBHOOK = 'https://hooks.slack.com/services/T0123/B4567/xABCDEFGH';

describe('NotificationsStore', () => {
  beforeEach(async () => {
    await resetTestStore();
  });

  it('round-trips a channel config', async () => {
    const store = getNotificationsStore();
    await store.saveChannel('slack', { webhook: WEBHOOK });

    await expect(store.loadConfig()).resolves.toEqual({
      slack: { webhook: WEBHOOK },
    });
  });

  it('never stores the webhook in the clear', async () => {
    // The webhook is a bearer token for the channel. On a hosted API this row
    // is synced to the operator's checkpoint bucket, so plaintext would put it
    // in object storage.
    await getNotificationsStore().saveChannel('slack', { webhook: WEBHOOK });

    const rows = await getDB().query<{ encrypted_config: string }>(
      `SELECT encrypted_config FROM notification_channels WHERE channel = 'slack'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].encrypted_config).not.toContain('hooks.slack.com');
    expect(rows[0].encrypted_config).not.toContain('xABCDEFGH');
  });

  it('replaces rather than duplicates on re-enable', async () => {
    const store = getNotificationsStore();
    await store.saveChannel('slack', { webhook: WEBHOOK });
    await store.saveChannel('slack', {
      webhook: 'https://hooks.slack.com/services/T/B/second',
    });

    const channels = await store.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].config.webhook).toBe(
      'https://hooks.slack.com/services/T/B/second',
    );
  });

  it('reports whether a delete removed anything', async () => {
    const store = getNotificationsStore();
    await expect(store.deleteChannel('slack')).resolves.toBe(false);

    await store.saveChannel('slack', { webhook: WEBHOOK });
    await expect(store.deleteChannel('slack')).resolves.toBe(true);
    await expect(store.loadConfig()).resolves.toEqual({});
  });

  it('treats an undecryptable row as an unconfigured channel', async () => {
    // Happens when the cipher key is replaced without clearing the table. The
    // operator's recovery is to re-enable, so this must not throw on every read.
    await getDB().query(
      `INSERT INTO notification_channels (channel, encrypted_config, created_at, updated_at)
       VALUES ('slack', 'not-a-ciphertext', 1, 1)`,
    );

    await expect(getNotificationsStore().loadConfig()).resolves.toEqual({});
  });

  it('round-trips receipts independently', async () => {
    const store = getNotificationsStore();
    await store.writeReceipt('digest', '2026-08-20');
    await store.writeReceipt('release', '0.1.60');
    await store.writeReceipt('vm-release-alert', '1234');

    await expect(store.readReceipt('digest')).resolves.toBe('2026-08-20');
    await expect(store.readReceipt('release')).resolves.toBe('0.1.60');
    await expect(store.readReceipt('vm-release-alert')).resolves.toBe('1234');

    await store.writeReceipt('digest', '2026-08-21');
    await expect(store.readReceipt('digest')).resolves.toBe('2026-08-21');
    await expect(store.readReceipt('release')).resolves.toBe('0.1.60');
    await expect(store.deleteReceipt('vm-release-alert')).resolves.toBe(true);
    await expect(store.deleteReceipt('vm-release-alert')).resolves.toBe(false);
    await expect(store.readReceipt('vm-release-alert')).resolves.toBeNull();
  });

  it('survives a container replacement, unlike the config file it replaces', async () => {
    // The whole point of the move: state lives in the database, which a hosted
    // API keeps in its checkpoint mount, instead of on the container layer that
    // every upgrade discards.
    const store = getNotificationsStore();
    await store.saveChannel('slack', { webhook: WEBHOOK });
    await store.writeReceipt('digest', '2026-08-20');

    // A fresh process against the same database.
    await expect(getNotificationsStore().loadConfig()).resolves.toEqual({
      slack: { webhook: WEBHOOK },
    });
    await expect(getNotificationsStore().readReceipt('digest')).resolves.toBe(
      '2026-08-20',
    );
  });
});

describe('notifications domain', () => {
  beforeEach(async () => {
    await resetTestStore();
  });

  it('masks the webhook it reports', async () => {
    const store = getNotificationsStore();
    await store.saveChannel('slack', { webhook: WEBHOOK });

    const [status] = await createNotificationsDomain({ store }).list();

    expect(status.webhook).toBe('https://hooks.slack.com/services/T0…/B4…/xA…');
    expect(status.webhook).not.toContain('xABCDEFGH');
  });

  it('rejects a test for a channel that is not configured', async () => {
    const domain = createNotificationsDomain({
      store: getNotificationsStore(),
    });

    await expect(domain.test('slack')).rejects.toThrow(/not configured/);
  });

  it('verifies a candidate webhook without storing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const store = getNotificationsStore();
    await createNotificationsDomain({ store }).test('slack', WEBHOOK);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(WEBHOOK);
    // Verification must not persist: `enable` tests before it saves so a dead
    // webhook never replaces a working one.
    await expect(store.loadConfig()).resolves.toEqual({});
    vi.unstubAllGlobals();
  });

  it('surfaces the channel rejection when a test post fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'nope',
      }),
    );

    const domain = createNotificationsDomain({
      store: getNotificationsStore(),
    });
    await expect(domain.test('slack', WEBHOOK)).rejects.toThrow(/403/);
    vi.unstubAllGlobals();
  });
});

describe('legacy config import', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    await resetTestStore();
    tempHome = mkdtempSync(join(tmpdir(), 'anycloud-notif-import-'));
    mkdirSync(join(tempHome, '.anycloud'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeLegacy(name: string, contents: string): void {
    writeFileSync(join(tempHome, '.anycloud', name), contents, {
      mode: 0o600,
    });
  }

  it('imports config and receipts so a local upgrade is silent', async () => {
    writeLegacy(
      'notifications.json',
      JSON.stringify({ slack: { webhook: WEBHOOK } }),
    );
    writeLegacy('notifications-digest-last-posted', '2026-08-17\n');
    writeLegacy('notifications-release-last-posted', '0.1.59\n');

    await importLegacyNotificationsConfig();

    const store = getNotificationsStore();
    await expect(store.loadConfig()).resolves.toEqual({
      slack: { webhook: WEBHOOK },
    });
    await expect(store.readReceipt('digest')).resolves.toBe('2026-08-17');
    await expect(store.readReceipt('release')).resolves.toBe('0.1.59');
  });

  it('does not resurrect a channel the operator disabled', async () => {
    // The local API bind-mounts the directory holding the legacy file, so it
    // outlives `notifications disable`. Keying the import off "table is empty"
    // would silently re-enable the channel on the next restart.
    writeLegacy(
      'notifications.json',
      JSON.stringify({ slack: { webhook: WEBHOOK } }),
    );

    await importLegacyNotificationsConfig();
    await getNotificationsStore().deleteChannel('slack');
    await importLegacyNotificationsConfig();

    await expect(getNotificationsStore().loadConfig()).resolves.toEqual({});
  });

  it('ignores a corrupt config file', async () => {
    writeLegacy('notifications.json', 'not json');

    await importLegacyNotificationsConfig();

    await expect(getNotificationsStore().loadConfig()).resolves.toEqual({});
  });

  it('ignores a config file holding a webhook it would refuse today', async () => {
    writeLegacy(
      'notifications.json',
      JSON.stringify({ slack: { webhook: 'https://example.com/hook' } }),
    );

    await importLegacyNotificationsConfig();

    await expect(getNotificationsStore().loadConfig()).resolves.toEqual({});
  });

  it('is a no-op when there is nothing to import', async () => {
    await importLegacyNotificationsConfig();

    const store = getNotificationsStore();
    await expect(store.loadConfig()).resolves.toEqual({});
    await expect(store.readReceipt('digest')).resolves.toBeNull();
    await expect(store.hasImportedLegacyConfig()).resolves.toBe(true);
  });
});
