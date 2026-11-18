import { errorMessage } from '../../shared/log-diagnostics.js';

/**
 * How long a new cluster's API keeps trying its first backup through the
 * management VM's identity (RFC 0049 C26 (e)). IAM is eventually consistent:
 * AWS settles in seconds, while a new GCP binding or Azure role assignment
 * can take minutes to reach the data plane (RFC 0047 § Known limits).
 * Unmeasured for a VM identity; the three-cloud live round measures it.
 */
export const FIRST_BACKUP_BUDGET_MS = {
  AWS: 2 * 60_000,
  GCP: 10 * 60_000,
  Azure: 15 * 60_000,
} as const;
const FIRST_BACKUP_INTERVAL_MS = 15_000;

/** What `api status` reports; `api create` waits for `landed`. */
export type FirstBackupStatus =
  | { state: 'pending'; attempts: number; lastError: string | null }
  | { state: 'landed'; backedUpAt: string }
  | { state: 'failed'; lastError: string };

export interface FirstBackupCheck {
  /** Runs once, in the background; retries until a backup lands or the budget ends. */
  start(): Promise<void>;
  status(): FirstBackupStatus;
}

export function createFirstBackupCheck(deps: {
  budgetMs: number;
  backup: { run(reason: string): Promise<string | void> };
  now(): number;
  sleep(ms: number): Promise<void>;
  log: { warn(message: string, metadata?: Record<string, unknown>): void };
}): FirstBackupCheck {
  let status: FirstBackupStatus = {
    state: 'pending',
    attempts: 0,
    lastError: null,
  };
  let running: Promise<void> | undefined;
  return {
    status: () => status,
    start() {
      running ??= (async () => {
        const deadline = deps.now() + deps.budgetMs;
        for (let attempts = 1; ; attempts += 1) {
          try {
            const backedUpAt =
              (await deps.backup.run('first backup')) ??
              new Date(deps.now()).toISOString();
            status = { state: 'landed', backedUpAt };
            return;
          } catch (error) {
            const lastError = errorMessage(error);
            if (deps.now() + FIRST_BACKUP_INTERVAL_MS > deadline) {
              status = { state: 'failed', lastError };
              deps.log.warn('The first API database backup did not land', {
                id: 'system',
                attempts,
                error: lastError,
              });
              return;
            }
            status = { state: 'pending', attempts, lastError };
            await deps.sleep(FIRST_BACKUP_INTERVAL_MS);
          }
        }
      })();
      return running;
    },
  };
}

/**
 * The first backup, then the hourly timer: the timer's versioning check
 * fails as early as the first backup does while IAM propagates, so it waits
 * for the first backup to settle, landed or failed.
 */
export async function startBackups(
  firstBackup: FirstBackupCheck | null,
  backup: { start(): Promise<boolean> },
): Promise<boolean> {
  // Settled either way: the timer's own versioning check refuses storage it
  // still can't reach, and a later hour may succeed where the first failed.
  await firstBackup?.start();
  return backup.start();
}
