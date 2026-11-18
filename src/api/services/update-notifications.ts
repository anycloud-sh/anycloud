import * as semver from 'semver';
import config from '../config.js';
import { loadNotifiers } from '../../shared/notifications/index.js';
import {
  fetchLatestRelease,
  updateVersionCache,
} from '../../shared/releases.js';
import { formatReleaseUpdateNotification } from '../../shared/release-notes.js';
import { log } from './logger.js';
import { sendToNotifiers } from './notify.js';
import { getNotificationsStore } from './persistence.js';

export const UPDATE_NOTIFICATION_INTERVAL_MS = 60 * 60_000;

/**
 * Last version announced, or null when there is nothing trustworthy stored.
 *
 * A receipt newer than the newest release that exists cannot have been written
 * by a real delivery, and trusting it suppresses every future announcement.
 * Note the comparison is against the latest release rather than the running
 * version: announcing 0.1.61 from a 0.1.60 API is the normal case.
 */
async function readReleaseNotificationReceipt(
  latestVersion: string,
): Promise<string | null> {
  const stored = await getNotificationsStore().readReceipt('release');
  const valid = stored ? semver.valid(stored) : null;
  if (!valid) return null;
  if (semver.gt(valid, latestVersion)) {
    log.warn('Ignoring release notification receipt newer than any release', {
      id: 'system',
      receipt: valid,
      latestVersion,
    });
    return null;
  }
  return valid;
}

async function writeReleaseNotificationReceipt(version: string): Promise<void> {
  try {
    await getNotificationsStore().writeReceipt('release', version);
  } catch (error) {
    log.warn('Failed to record release notification receipt', {
      id: 'system',
      version,
      error: error,
    });
  }
}

async function cacheRelease(
  version: string,
  checkedAt: number,
  notified: boolean,
): Promise<void> {
  try {
    await updateVersionCache({
      latestVersion: version,
      lastCheck: checkedAt,
      ...(notified ? { lastNotifiedVersion: version } : {}),
    });
  } catch (error) {
    log.warn(
      notified
        ? 'Failed to record release notification'
        : 'Failed to update release cache',
      {
        id: 'system',
        version,
        error: error,
      },
    );
  }
}

export async function runUpdateNotificationOnce(): Promise<void> {
  const notifiers = loadNotifiers(await getNotificationsStore().loadConfig());
  if (notifiers.length === 0) {
    log.debug('No notification channels configured; skipping release check', {
      id: 'system',
    });
    return;
  }

  const release = await fetchLatestRelease();
  if (!release) return;

  const checkedAt = Date.now();
  await cacheRelease(release.version, checkedAt, false);

  if (!semver.gt(release.version, config.currVersion)) return;
  const lastNotified = await readReleaseNotificationReceipt(release.version);
  if (lastNotified && !semver.gt(release.version, lastNotified)) {
    return;
  }

  const message = formatReleaseUpdateNotification(release.version, release.url);
  const anySent = await sendToNotifiers(notifiers, message);
  if (!anySent) return;
  await writeReleaseNotificationReceipt(release.version);
  // Keep writing the legacy field so a rollback to an older API retains the
  // delivery history. New APIs deduplicate exclusively against the receipt.
  await cacheRelease(release.version, checkedAt, true);
}
