import config, { getApiBackupConfig } from '../config.js';
import {
  createApiDatabaseBackup,
  type ApiDatabaseBackup,
} from './api-database-backup.js';
import { readApiBackupInventory } from './api-backup-inventory.js';
import { decryptCredential } from './cloud-config.js';
import { backupStorage } from './gateways/instance-backup-storage.js';
import {
  FIRST_BACKUP_BUDGET_MS,
  createFirstBackupCheck,
  type FirstBackupCheck,
} from './first-backup.js';
import { log } from './logger.js';
import {
  backupDatabase,
  getCredentialSecretStore,
  getSchemaAppVersion,
} from './persistence.js';

let backup: ApiDatabaseBackup | null | undefined;
let firstBackup: FirstBackupCheck | null | undefined;

/**
 * The first backup through the management VM's identity, retried through
 * IAM propagation and reported in `api status`; null without a backup.
 */
export function getDefaultFirstBackupCheck(
  installationId: string,
): FirstBackupCheck | null {
  if (firstBackup === undefined) {
    const target = getApiBackupConfig();
    const databaseBackup = getDefaultApiDatabaseBackup(installationId);
    firstBackup =
      target && databaseBackup
        ? createFirstBackupCheck({
            budgetMs:
              FIRST_BACKUP_BUDGET_MS[
                target.cloudProvider as keyof typeof FIRST_BACKUP_BUDGET_MS
              ] ?? FIRST_BACKUP_BUDGET_MS.AWS,
            backup: databaseBackup,
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            log: { warn: (message, metadata) => log.warn(message, metadata) },
          })
        : null;
  }
  return firstBackup;
}

/**
 * Run a backup after a change `backup.json` lists (a pool or credential),
 * where the hosted API's backup is configured; a failure waits for the hourly
 * one.
 */
export function requestApiDatabaseBackup(reason: string): void {
  void backup
    ?.run(reason)
    .catch((error: unknown) =>
      log.warn('API database backup failed', { id: 'system', reason, error }),
    );
}

/** The Helm-managed API's database backup; null where none is configured. */
export function getDefaultApiDatabaseBackup(
  installationId: string,
): ApiDatabaseBackup | null {
  if (backup === undefined) {
    const target = getApiBackupConfig();
    backup = target
      ? createApiDatabaseBackup({
          db: { backup: backupDatabase },
          storage: backupStorage(target),
          ...(target.account && {
            location: {
              cloud: target.cloudProvider.toLowerCase(),
              account: target.account,
            },
          }),
          ...(target.target && { target: target.target }),
          bucket: target.bucket,
          cipherKey: config.cipherKey,
          clusterId: installationId,
          schemaAppVersion: getSchemaAppVersion,
          inventory: () =>
            readApiBackupInventory({
              credentials: getCredentialSecretStore(),
              decrypt: decryptCredential,
            }),
          log: {
            info: (message, metadata) => log.info(message, metadata),
            warn: (message, metadata) => log.warn(message, metadata),
          },
        })
      : null;
  }
  return backup;
}
