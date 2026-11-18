/**
 * Chart initContainer for a cluster created from an existing backup: runs
 * before the API's first start and fills its empty state volume from the
 * bucket, which it reads with the management VM's own identity (RFC 0049
 * C26 (e)), checked against `backup.json`'s hash.
 */
import { errorMessage } from '../shared/log-diagnostics.js';
import { getAnycloudDir } from '../shared/utils.js';
import { getApiBackupConfig } from './config.js';
import { restoreApiState } from './services/api-state-restore.js';
import { backupStorage } from './services/gateways/instance-backup-storage.js';

async function main(): Promise<void> {
  const target = getApiBackupConfig();
  if (!target) throw new Error('Restore requires ANYCLOUD_BACKUP_CONFIG');
  // Through the management VM's own identity on a seeded cluster.
  const storage = backupStorage(target);
  const result = await restoreApiState({
    dir: getAnycloudDir(),
    bucket: target.bucket,
    storage,
  });
  console.log(
    result === 'restored'
      ? `Restored the API state from ${target.bucket}`
      : 'The API state volume already has a database; nothing restored',
  );
}

// Exit explicitly either way: a cloud SDK's lingering keep-alive socket must
// not hold the initContainer, and on failure only the message is written (it
// becomes the Pod's termination message that bootstrap reports).
main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  },
);
