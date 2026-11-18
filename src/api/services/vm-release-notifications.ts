import { log } from './logger.js';
import {
  getNotificationsStore,
  getProvisioningAttemptStore,
} from './persistence.js';
import { sendToNotifiers } from './notify.js';
import { loadNotifiers } from '../../shared/notifications/index.js';
import { formatNotificationNumber } from '../../shared/notifications/format.js';
import type { OverdueVmReleaseSummary } from './repositories/provisioning-attempts.js';

/** The overdue-release summary this alert reads. */
interface VmReleaseSummaries {
  summarizeOverdueVmReleases(
    cutoff: number,
    workloadSampleLimit: number,
  ): Promise<OverdueVmReleaseSummary | null>;
}

/** A provider release taking longer than this becomes an operator alert. */
export const VM_RELEASE_ALERT_THRESHOLD_MS = 5 * 60_000;

/** Repeat one aggregate warning sparingly while any release remains overdue. */
export const VM_RELEASE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/** Discovery is independent from cleanup work and survives process restarts. */
export const VM_RELEASE_NOTIFICATION_INTERVAL_MS = 60_000;

/** Keep the workload list useful while bounding the Slack payload. */
export const VM_RELEASE_WORKLOAD_SAMPLE_LIMIT = 10;

const VM_RELEASE_ALERT_RECEIPT = 'vm-release-alert' as const;
const MAX_DISPLAY_WORKLOAD_ID_LENGTH = 80;

function formatDuration(ms: number): string {
  const duration = Math.max(0, ms);
  if (duration < 60_000) {
    return `${formatNotificationNumber(Math.max(1, Math.round(duration / 1000)))}s`;
  }
  if (duration < 60 * 60_000) {
    return `${formatNotificationNumber(Math.round(duration / 60_000))}m`;
  }
  if (duration < 24 * 60 * 60_000) {
    return `${formatNotificationNumber(duration / (60 * 60_000), 1)}h`;
  }
  return `${formatNotificationNumber(duration / (24 * 60 * 60_000), 1)}d`;
}

function workloadCode(id: string): string {
  const escaped = id.replace(/`/g, "'");
  const clipped =
    escaped.length <= MAX_DISPLAY_WORKLOAD_ID_LENGTH
      ? escaped
      : `${escaped.slice(0, MAX_DISPLAY_WORKLOAD_ID_LENGTH - 1)}…`;
  return `\`${clipped}\``;
}

function workloadSample(summary: OverdueVmReleaseSummary): string {
  const listed = summary.workloadIds.map(workloadCode).join(', ');
  const omitted = summary.workloadCount - summary.workloadIds.length;
  if (omitted <= 0) return listed;
  const noun = omitted === 1 ? 'workload' : 'workloads';
  return `${listed}, and ${formatNotificationNumber(omitted)} more ${noun}`;
}

function formatVmReleaseAlert(
  summary: OverdueVmReleaseSummary,
  now: number,
  reminder: boolean,
): string {
  const vmCount = formatNotificationNumber(summary.vmCount);
  const workloadCount = formatNotificationNumber(summary.workloadCount);
  const vmNoun = summary.vmCount === 1 ? 'VM' : 'VMs';
  const workloadNoun = summary.workloadCount === 1 ? 'workload' : 'workloads';
  const title = reminder ? 'VM release still delayed' : 'VM release delayed';
  return [
    `*anycloud: ${title}*`,
    `• ${vmCount} ${vmNoun} across ${workloadCount} ${workloadNoun} remain unreleased; the oldest has been waiting ${formatDuration(now - summary.oldestRemovalRequestedAt)} since Anycloud requested removal.`,
    '• The provider may continue billing until release is confirmed. Anycloud will keep retrying cleanup.',
    `• Affected workloads: ${workloadSample(summary)}.`,
  ].join('\n');
}

function parseLastAlertAt(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp >= 0) return timestamp;
  log.warn('Ignoring invalid VM release alert receipt', {
    id: 'system',
    value,
  });
  return null;
}

/**
 * Notify only while provider release risk remains actionable.
 *
 * Every overdue VM participates in one aggregate incident. A successful first
 * alert opens it, reminders are globally cooled down, and observing no overdue
 * releases silently resets it so a later incident can alert immediately.
 */
export async function runVmReleaseNotificationsOnce(): Promise<void> {
  const now = Date.now();
  const notifications = getNotificationsStore();
  const releases: VmReleaseSummaries = getProvisioningAttemptStore();
  const [summary, receipt] = await Promise.all([
    releases.summarizeOverdueVmReleases(
      now - VM_RELEASE_ALERT_THRESHOLD_MS,
      VM_RELEASE_WORKLOAD_SAMPLE_LIMIT,
    ),
    notifications.readReceipt(VM_RELEASE_ALERT_RECEIPT),
  ]);

  if (!summary) {
    if (receipt !== null) {
      await notifications.deleteReceipt(VM_RELEASE_ALERT_RECEIPT);
    }
    return;
  }

  const lastAlertAt = parseLastAlertAt(receipt);
  if (
    lastAlertAt !== null &&
    lastAlertAt > now - VM_RELEASE_ALERT_COOLDOWN_MS
  ) {
    return;
  }

  const notifiers = loadNotifiers(await notifications.loadConfig());
  if (notifiers.length === 0) return;

  const sent = await sendToNotifiers(
    notifiers,
    formatVmReleaseAlert(summary, now, lastAlertAt !== null),
  );
  if (!sent) return;

  const sentAt = Date.now();
  await notifications.writeReceipt(VM_RELEASE_ALERT_RECEIPT, String(sentAt));
  log.warn(
    lastAlertAt === null ? 'VM releases overdue' : 'VM releases remain overdue',
    {
      id: 'system',
      vmCount: summary.vmCount,
      workloadCount: summary.workloadCount,
      oldestAwaitingReleaseMs: now - summary.oldestRemovalRequestedAt,
    },
  );
}
