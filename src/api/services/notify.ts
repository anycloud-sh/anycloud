import { log } from './logger.js';
import { NotificationRateLimitError } from '../../shared/notifications/contracts.js';
import type {
  NotificationContent,
  Notifier,
} from '../../shared/notifications/contracts.js';

/**
 * Send a message to every configured notifier, swallowing per-channel failures
 * so one bad webhook never blocks the others. Returns true if at least one
 * channel accepted the message — callers use that to decide whether to record a
 * debounce timestamp (so a failed send retries instead of silently going quiet).
 */
export async function sendToNotifiers(
  notifiers: Notifier[],
  message: NotificationContent,
): Promise<boolean> {
  let anySent = false;
  for (const notifier of notifiers) {
    try {
      await notifier.send(message);
      anySent = true;
    } catch (e) {
      if (e instanceof NotificationRateLimitError) {
        if (e.newlyObserved) {
          log.warn('Notification send rate limited', {
            id: 'system',
            channel: notifier.name,
            retryAt: e.retryAt,
            error: e,
          });
        }
        continue;
      }
      log.warn('Notification send failed', {
        id: 'system',
        channel: notifier.name,
        error: e,
      });
    }
  }
  return anySent;
}
