import type {
  NotificationChannelName,
  NotificationChannelStatus,
} from '../../shared/api-contract/notifications-schemas.js';
import { truncateWebhook } from '../../shared/notifications/slack.js';
import { loadNotifiers } from '../../shared/notifications/index.js';
import {
  NotificationChannelNotConfiguredError,
  NotificationDeliveryError,
} from '../../shared/errors.js';
import type { NotificationsRepository } from './notifications-store.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

/** Sent by `anycloud notifications test`, from the API rather than the CLI. */
const TEST_MESSAGE =
  'anycloud: test notification. Notifications are configured correctly.';

export interface NotificationsDomain {
  list(signal?: AbortSignal): Promise<NotificationChannelStatus[]>;
  save(
    channel: NotificationChannelName,
    webhook: string,
    signal?: AbortSignal,
  ): Promise<void>;
  delete(
    channel: NotificationChannelName,
    signal?: AbortSignal,
  ): Promise<{ removed: boolean }>;
  /**
   * Post a test message. A candidate webhook is verified without being stored,
   * so `enable` can prove delivery before replacing a working channel.
   */
  test(
    channel: NotificationChannelName,
    webhook?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface NotificationsDomainDependencies {
  store: NotificationsRepository;
}

export function createNotificationsDomain(
  dependencies: NotificationsDomainDependencies,
): NotificationsDomain {
  return {
    async list(signal) {
      signal?.throwIfAborted();
      const channels = await dependencies.store.listChannels();
      signal?.throwIfAborted();
      return channels.map((entry) => ({
        channel: entry.channel,
        webhook: truncateWebhook(entry.config.webhook),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    },

    async save(channel, webhook, signal) {
      signal?.throwIfAborted();
      await dependencies.store.saveChannel(channel, { webhook });
      signal?.throwIfAborted();
    },

    async delete(channel, signal) {
      signal?.throwIfAborted();
      const removed = await dependencies.store.deleteChannel(channel);
      signal?.throwIfAborted();
      return { removed };
    },

    async test(channel, webhook, signal) {
      signal?.throwIfAborted();
      const config = webhook
        ? { slack: { webhook } }
        : await dependencies.store.loadConfig();
      signal?.throwIfAborted();
      const notifier = loadNotifiers(config).find(
        (entry) => entry.name === channel,
      );
      if (!notifier) throw new NotificationChannelNotConfiguredError(channel);
      try {
        await notifier.send(TEST_MESSAGE);
      } catch (error) {
        throw new NotificationDeliveryError(channel, errorMessage(error));
      }
    },
  };
}
