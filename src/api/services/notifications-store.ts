/**
 * Notifications Store
 *
 * Channel configuration and scheduled-delivery receipts. Both are tiny lookup
 * tables — one row per channel, one row per receipt kind.
 *
 * Config payloads are encrypted at rest with the same key as secrets and
 * credentials: a Slack webhook is a bearer token, and anyone holding it can
 * post to the channel.
 */

import { decryptSecret, encryptSecret } from './secret-crypto.js';
import type { DB } from './repositories/db.js';
import type {
  NotificationsConfig,
  SlackChannelConfig,
} from '../../shared/notifications/contracts.js';

export type NotificationChannel = 'slack';
export type NotificationReceiptKind = 'digest' | 'release' | 'vm-release-alert';

export interface NotificationChannelRecord {
  channel: NotificationChannel;
  config: SlackChannelConfig;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationsRepository {
  listChannels(): Promise<NotificationChannelRecord[]>;
  loadConfig(): Promise<NotificationsConfig>;
  saveChannel(
    channel: NotificationChannel,
    config: SlackChannelConfig,
  ): Promise<void>;
  deleteChannel(channel: NotificationChannel): Promise<boolean>;
  readReceipt(kind: NotificationReceiptKind): Promise<string | null>;
  writeReceipt(kind: NotificationReceiptKind, value: string): Promise<void>;
  deleteReceipt(kind: NotificationReceiptKind): Promise<boolean>;
  hasImportedLegacyConfig(): Promise<boolean>;
  markLegacyConfigImported(): Promise<void>;
}

/**
 * One-shot marker for the migration off the pre-database config files.
 *
 * This deliberately does not key off "the channels table is empty". The local
 * API bind-mounts the directory holding the legacy file, so the file outlives
 * `notifications disable` — an emptiness check would re-import it on the next
 * restart and silently resurrect a channel the operator turned off.
 */
const LEGACY_IMPORT_KEY = 'notifications_legacy_import';

interface ChannelRow {
  channel: string;
  encrypted_config: string;
  created_at: number;
  updated_at: number;
}

export class NotificationsStore implements NotificationsRepository {
  constructor(private readonly db: DB) {}

  async listChannels(): Promise<NotificationChannelRecord[]> {
    const rows = await this.db.query<ChannelRow>(
      `SELECT channel, encrypted_config, created_at, updated_at
       FROM notification_channels
       ORDER BY channel`,
    );
    const records: NotificationChannelRecord[] = [];
    for (const row of rows) {
      // Skip rows a newer version wrote for a channel this build does not know
      // about, so a downgrade degrades to "that channel is off" rather than
      // failing every read.
      if (row.channel !== 'slack') continue;
      // One unreadable row must not hide the others. This happens when the
      // cipher key is replaced without clearing the table, and the operator's
      // recovery is to re-enable the channel.
      const config = await this.decodeConfig(row);
      if (config) {
        records.push({
          channel: row.channel,
          config,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    }
    return records;
  }

  /** Shape the monitors consume, matching the historical config file. */
  async loadConfig(): Promise<NotificationsConfig> {
    const channels = await this.listChannels();
    const slack = channels.find((entry) => entry.channel === 'slack');
    return slack ? { slack: slack.config } : {};
  }

  async saveChannel(
    channel: NotificationChannel,
    config: SlackChannelConfig,
  ): Promise<void> {
    const encrypted = await encryptSecret(JSON.stringify(config));
    const now = Math.floor(Date.now() / 1000);
    await this.db.query(
      `INSERT INTO notification_channels (channel, encrypted_config, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         encrypted_config = excluded.encrypted_config,
         updated_at = excluded.updated_at`,
      [channel, encrypted, now, now],
    );
  }

  /** Returns false when the channel was not configured. */
  async deleteChannel(channel: NotificationChannel): Promise<boolean> {
    const existing = await this.db.query<{ channel: string }>(
      `SELECT channel FROM notification_channels WHERE channel = ?`,
      [channel],
    );
    if (existing.length === 0) return false;
    await this.db.query(`DELETE FROM notification_channels WHERE channel = ?`, [
      channel,
    ]);
    return true;
  }

  async readReceipt(kind: NotificationReceiptKind): Promise<string | null> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM notification_receipts WHERE kind = ?`,
      [kind],
    );
    return rows[0]?.value ?? null;
  }

  async writeReceipt(
    kind: NotificationReceiptKind,
    value: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.query(
      `INSERT INTO notification_receipts (kind, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [kind, value, now],
    );
  }

  async deleteReceipt(kind: NotificationReceiptKind): Promise<boolean> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `DELETE FROM notification_receipts WHERE kind = ?`,
      [kind],
    );
    return (result[0]?.rowsAffected ?? 0) > 0;
  }

  async hasImportedLegacyConfig(): Promise<boolean> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM _metadata WHERE key = ?`,
      [LEGACY_IMPORT_KEY],
    );
    return rows.length > 0;
  }

  async markLegacyConfigImported(): Promise<void> {
    await this.db.query(
      `INSERT INTO _metadata (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [LEGACY_IMPORT_KEY, new Date().toISOString()],
    );
  }

  private async decodeConfig(
    row: ChannelRow,
  ): Promise<SlackChannelConfig | null> {
    try {
      const parsed: unknown = JSON.parse(
        await decryptSecret(row.encrypted_config),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'webhook' in parsed &&
        typeof parsed.webhook === 'string'
      ) {
        return { webhook: parsed.webhook };
      }
      return null;
    } catch {
      return null;
    }
  }
}
