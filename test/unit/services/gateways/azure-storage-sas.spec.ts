import {
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../../src/api/services/logger.js';
import { rcloneEnvVars } from '../../../../src/api/services/rclone-config.js';
import { SupervisorManager } from '../../../../src/api/services/supervisor.js';
import {
  Azure,
  resetAzureStorageAccountCacheForTests,
} from '../../../../src/api/services/gateways/azure.js';
import { canMintScopedStorageToken } from '../../../../src/api/services/gateways/cloud.js';
import { validateStorageCapabilities } from '../../../../src/api/services/cloud-config.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { fakeSdkClient } from '../../helpers/sdk-client.js';
import { TEST_AZURE_CRED, TEST_LAMBDA_CRED } from '../../helpers/fixtures.js';

/**
 * RFC 0047 S11 (Azure): same-account Buckets sync with a container SAS minted
 * from the compute credential's `listKeys`, never with a VM identity.
 */

const NOW = Date.UTC(2026, 9, 9, 12);
const HOUR = 3_600_000;
const ACCOUNT_KEY = Buffer.from('a'.repeat(64)).toString('base64');

function azureStorage(allowSharedKeyAccess?: boolean) {
  const azure = new Azure(
    completeCloudConfig({
      cloudProvider: CloudType.Azure,
      region: 'eastus',
      credentials: TEST_AZURE_CRED,
    }),
  );
  const listKeys = vi
    .fn()
    .mockResolvedValue({ keys: [{ value: ACCOUNT_KEY }] });
  azure.storageClient = fakeSdkClient({ storageAccounts: { listKeys } });
  vi.spyOn(azure, 'findStorageAccount').mockResolvedValue({
    resourceGroup: 'anycloud-storage',
    account: { location: 'eastus', allowSharedKeyAccess },
  });
  const storage = azure.storage();
  if (!canMintScopedStorageToken(storage))
    throw new Error('Azure storage must mint scoped tokens');
  return { storage, listKeys, account: azure.storageAccountName };
}

/** The SAS query, checked to be signed with the account key for the container. */
function sasOf(
  token: { credentials: unknown } | undefined,
  account: string,
  container: string,
): URLSearchParams {
  const credentials = token?.credentials as {
    cloudProvider?: CloudType;
    sasToken?: string;
  };
  expect(credentials.cloudProvider).toBe(CloudType.Azure);
  const query = new URLSearchParams(credentials.sasToken);
  expect(query.get('sr')).toBe('c');
  const expected = generateBlobSASQueryParameters(
    {
      containerName: container,
      permissions: ContainerSASPermissions.parse(query.get('sp')!),
      startsOn: new Date(query.get('st')!),
      expiresOn: new Date(query.get('se')!),
      protocol: SASProtocol.Https,
      version: query.get('sv')!,
    },
    new StorageSharedKeyCredential(account, ACCOUNT_KEY),
  );
  expect(query.get('sig')).toBe(expected.signature);
  return query;
}

describe('Azure container SAS minting', () => {
  beforeEach(() => {
    resetAzureStorageAccountCacheForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('0047/S11 mints a read-and-list SAS for one input container', async () => {
    const { storage, listKeys, account } = azureStorage(true);
    const token = await storage.mintScopedStorageToken([
      { bucket: 'inputs', mode: 'read' },
    ]);

    const query = sasOf(token, account, 'inputs');
    expect(query.get('sp')).toBe('rl');
    expect(query.get('spr')).toBe('https');
    expect(listKeys).toHaveBeenCalledWith('anycloud-storage', account);
  });

  it('0047/S11 mints a write SAS for an output container that expires in 36 hours', async () => {
    const { storage, account } = azureStorage();
    const token = await storage.mintScopedStorageToken([
      { bucket: 'results', mode: 'readwrite' },
    ]);

    const query = sasOf(token, account, 'results');
    expect(query.get('sp')).toBe('racwdl');
    expect(token?.expiresAt).toBe(NOW + 36 * HOUR);
    expect(Date.parse(query.get('se')!)).toBe(token?.expiresAt);
    // Starts a few minutes early so a VM clock behind Azure's still accepts it.
    expect(Date.parse(query.get('st')!)).toBeLessThan(NOW);
  });

  it('never logs the account key or writes it to the VM', async () => {
    const logged = (['info', 'debug', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(log, level),
    );
    const { storage, account } = azureStorage();
    const token = await storage.mintScopedStorageToken([
      { bucket: 'results', mode: 'readwrite' },
    ]);
    const bucket = {
      name: 'results',
      cloudType: CloudType.Azure,
      storageAccountName: account,
      credentials: token!.credentials,
      credentialExpiresAt: token!.expiresAt,
    };
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const ssh: Pick<
      ConstructorParameters<typeof SupervisorManager>[0],
      'exec'
    > = { exec };
    await new SupervisorManager(
      ssh as ConstructorParameters<typeof SupervisorManager>[0],
    ).refreshRcloneCredentials({ output: bucket });

    const written = JSON.stringify([
      token,
      rcloneEnvVars(bucket),
      exec.mock.calls,
      logged.map((spy) => spy.mock.calls),
    ]);
    expect(written).toContain('RCLONE_CONFIG_AZUREBLOB_SAS_URL');
    expect(written).not.toContain(ACCOUNT_KEY);
  });

  it('0043/S3 limits a prefix grant to its directory, with no delete', async () => {
    const { storage } = azureStorage();
    const token = await storage.mintScopedStorageToken([
      { bucket: 'results', prefix: 'job-1/', mode: 'readwrite' },
    ]);

    const query = new URLSearchParams(
      (token?.credentials as { sasToken: string }).sasToken,
    );
    expect(Object.fromEntries(query)).toMatchObject({
      sr: 'd',
      sdd: '1',
      sp: 'rcwl',
      spr: 'https',
    });
    expect(Date.parse(query.get('se')!)).toBe(token?.expiresAt);
    expect(token?.expiresAt).toBe(NOW + 36 * HOUR);
  });

  it('lasts exactly the requested lifetime, and a nested prefix sets its depth', async () => {
    const { storage } = azureStorage();
    const token = await storage.mintScopedStorageToken(
      [{ bucket: 'cache', prefix: 'a/b/', mode: 'read', noDelete: true }],
      { lifetimeMs: 60_000 },
    );
    const query = new URLSearchParams(
      (token?.credentials as { sasToken: string }).sasToken,
    );
    expect(token?.expiresAt).toBe(NOW + 60_000);
    expect(Date.parse(query.get('se')!)).toBe(NOW + 60_000);
    expect(Object.fromEntries(query)).toMatchObject({
      sr: 'd',
      sdd: '2',
      sp: 'rl',
    });
  });

  it('mints nothing for no grants and refuses more than one container', async () => {
    const { storage, listKeys } = azureStorage();
    await expect(storage.mintScopedStorageToken([])).resolves.toBeUndefined();
    await expect(
      storage.mintScopedStorageToken([
        { bucket: 'a', mode: 'read' },
        { bucket: 'b', mode: 'read' },
      ]),
    ).rejects.toThrow(/one container/);
    await expect(
      storage.mintScopedStorageToken([
        { bucket: 'a', prefix: 'job-1/', mode: 'readwrite' },
        { bucket: 'a', prefix: 'job-2/', mode: 'readwrite' },
      ]),
    ).rejects.toThrow(/one container or directory/);
    expect(listKeys).not.toHaveBeenCalled();
  });

  it('reports how to enable Shared Key when the account forbids it', async () => {
    const { storage, listKeys } = azureStorage(false);
    await expect(
      storage.mintScopedStorageToken([
        { bucket: 'results', mode: 'readwrite' },
      ]),
    ).rejects.toThrow(/Shared Key/);
    expect(listKeys).not.toHaveBeenCalled();
  });

  it('keeps refusing explicit Azure storage credentials for VM bucket sync, but not for pool Jobs, which mint at admission', () => {
    const lambda = completeCloudConfig({
      cloudProvider: CloudType.Lambda,
      region: 'us-east-1',
      credentials: TEST_LAMBDA_CRED,
      outputBucket: 'results',
      outputStorageCredentials: TEST_AZURE_CRED,
      outputStorageRegion: 'eastus',
    });
    expect(() => validateStorageCapabilities(lambda)).toThrow(
      /storage requires credentials that can mint/,
    );
    expect(() => validateStorageCapabilities(lambda, false)).not.toThrow();
  });
});
