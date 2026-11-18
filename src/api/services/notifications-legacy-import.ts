/**
 * One-time migration of notification state off the pre-database config files.
 *
 * Before this, channel config and the two dedup receipts were files under the
 * API process home directory. That works on a local API, whose home directory
 * is bind-mounted from the host, but a hosted API keeps durable state in the
 * checkpoint mount — so the files sat on the ephemeral container layer and were
 * destroyed by every upgrade.
 *
 * Importing on boot keeps local upgrades silent: existing config keeps working
 * and the receipts carry over, so nobody receives a duplicate release
 * announcement. The files are left in place, so rolling back to an older API
 * still finds them.
 *
 * Delete this module once the release that introduced it is far enough back
 * that no one upgrades across it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as semver from 'semver';
import { isValidSlackWebhookUrl } from '../../shared/notifications/slack.js';
import { log } from './logger.js';
import { getNotificationsStore } from './persistence.js';

function legacyPath(name: string): string {
  return join(homedir(), '.anycloud', name);
}

function readTrimmed(name: string): string | null {
  try {
    const value = readFileSync(legacyPath(name), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readLegacyWebhook(): string | null {
  const raw = readTrimmed('notifications.json');
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'slack' in parsed &&
      typeof parsed.slack === 'object' &&
      parsed.slack !== null &&
      'webhook' in parsed.slack &&
      typeof parsed.slack.webhook === 'string' &&
      isValidSlackWebhookUrl(parsed.slack.webhook)
    ) {
      return parsed.slack.webhook;
    }
  } catch {
    // A corrupt file is indistinguishable from no file for import purposes.
  }
  return null;
}

export async function importLegacyNotificationsConfig(): Promise<void> {
  const store = getNotificationsStore();
  if (await store.hasImportedLegacyConfig()) return;

  const webhook = readLegacyWebhook();
  if (webhook) await store.saveChannel('slack', { webhook });

  const digest = readTrimmed('notifications-digest-last-posted');
  if (digest && /^\d{4}-\d{2}-\d{2}$/.test(digest)) {
    await store.writeReceipt('digest', digest);
  }

  // A receipt is only imported when it parses as a version. The
  // newer-than-any-release check in the release monitor still applies, so a
  // corrupt value cannot suppress announcements forever.
  const release = readTrimmed('notifications-release-last-posted');
  if (release && semver.valid(release)) {
    await store.writeReceipt('release', release);
  }

  await store.markLegacyConfigImported();
  if (webhook || digest || release) {
    log.info('Imported notification settings from legacy config files', {
      id: 'system',
      channel: webhook ? 'slack' : undefined,
      digest: digest ?? undefined,
      release: release ?? undefined,
    });
  }
}
