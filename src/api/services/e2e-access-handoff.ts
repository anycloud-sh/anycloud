import { access, readFile, rm } from 'node:fs/promises';
import type { InstanceBackupStorage } from './gateways/instance-backup-storage.js';

/**
 * Where the e2e harness reads its kubeconfig (test-only, RFC 0049 C26 (e)):
 * the checkpoint bucket, which its own credential reads.
 * @public (lane S7)
 */
export const E2E_ACCESS_KUBECONFIG_KEY = 'e2e/access-kubeconfig';

/**
 * Test-only (`ANYCLOUD_E2E_ACCESS`): the boot script left the e2e harness's
 * kubeconfig on the host, which the API's Pod mounts; copy it into the
 * checkpoint bucket through the VM identity, then delete the host's copy.
 * Nothing to do once it is gone, so a restart copies nothing.
 */
export async function handOffE2eAccess(deps: {
  path: string;
  bucket: string;
  storage: Pick<InstanceBackupStorage, 'uploadObject'>;
}): Promise<'copied' | 'absent'> {
  let kubeconfig: Buffer;
  try {
    kubeconfig = await readFile(deps.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  await deps.storage.uploadObject(deps.bucket, E2E_ACCESS_KUBECONFIG_KEY, {
    kind: 'buffer',
    bytes: kubeconfig,
    contentLength: kubeconfig.length,
  });
  await rm(deps.path, { force: true });
  return 'copied';
}

/** Until the boot script has written the file, which may follow the API's start. */
export async function waitForFile(
  path: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 120,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      if (attempt >= attempts) throw new Error(`${path} never appeared`);
      await sleep(5_000);
    }
  }
}
