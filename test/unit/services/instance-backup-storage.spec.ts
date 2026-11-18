import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';

const calls: string[] = [];
const s3Commands: { name: string; input: Record<string, unknown> }[] = [];

vi.mock(
  '../../../src/api/services/provider-clients/aws.js',
  async (actual) => ({
    ...(await actual<object>()),
    createAwsS3Client: (credentials: unknown, options: { region: string }) => {
      calls.push(`s3 ${options.region} ${typeof credentials}`);
      return {
        send: async (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          s3Commands.push({
            name: command.constructor.name,
            input: command.input,
          });
          switch (command.constructor.name) {
            case 'GetBucketVersioningCommand':
              return { Status: 'Enabled' };
            case 'GetObjectCommand':
              return { Body: Readable.from([Buffer.from('db')]) };
            case 'ListObjectsV2Command':
              return { Contents: [{ Key: 'anycloud-api/backup.json' }] };
            default:
              return {};
          }
        },
      };
    },
  }),
);

const gcsSaved: { bucket: string; key: string; body: string }[] = [];
vi.mock('../../../src/api/services/provider-clients/gcp.js', () => ({
  createGcpGatewayClients: (credentials: { kind: string }) => {
    calls.push(`gcs ${credentials.kind}`);
    return {
      storage: {
        bucket: (bucket: string) => ({
          file: (key: string) => ({
            save: async (body: Buffer) =>
              void gcsSaved.push({ bucket, key, body: body.toString() }),
            createReadStream: () => Readable.from([Buffer.from('db')]),
          }),
          getMetadata: async () => [{ versioning: { enabled: true } }],
          getFiles: async () => [[{ name: 'anycloud-api/backup.json' }]],
        }),
      },
    };
  },
}));

const blobs: { account: string; container: string; key: string }[] = [];
vi.mock('../../../src/api/services/provider-clients/azure.js', () => ({
  createAzureInstanceCredential: () => ({ managed: 'identity' }),
  createAzureTokenBlobServiceClient: (
    account: string,
    credential: { managed: string },
  ) => {
    calls.push(`blob ${account} as ${credential.managed}`);
    return {
      getContainerClient: (container: string) => ({
        getBlockBlobClient: (key: string) => ({
          uploadStream: async () =>
            void blobs.push({ account, container, key }),
        }),
        getBlobClient: () => ({
          download: async () => ({
            readableStreamBody: Readable.from([Buffer.from('db')]),
          }),
        }),
        listBlobsFlat: async function* () {
          yield { name: 'anycloud-api/backup.json' };
        },
      }),
    };
  },
  createAzureStorageManagementClient: (
    _credential: unknown,
    subscription: string,
  ) => ({
    blobServices: {
      getServiceProperties: async (group: string, account: string) => {
        calls.push(`versioning ${subscription}/${group}/${account}`);
        return { isVersioningEnabled: false };
      },
    },
  }),
}));

const storedProviders: unknown[] = [];
vi.mock('../../../src/api/services/cloud-config.js', () => ({
  createStorageProvider: (config: unknown) => {
    storedProviders.push(config);
    return { type: 'stored' };
  },
}));

const { backupStorage, instanceBackupStorage } = await import(
  '../../../src/api/services/gateways/instance-backup-storage.js'
);

const upload = {
  kind: 'buffer' as const,
  bytes: Buffer.from('db'),
  contentLength: 2,
};
const read = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
};
const listing = { prefix: 'anycloud-api/', recursive: false, pageSize: 100 };

describe('backup storage through the management VM’s identity', () => {
  it('reaches S3 as the instance profile, for backup and first-start restore', async () => {
    const storage = backupStorage({
      cloudProvider: CloudType.AWS,
      region: 'us-east-2',
      credentials: { cloudProvider: CloudType.AWS, kind: 'instance' },
    });
    await storage.uploadObject('prod-1', 'anycloud-api/backup.json', upload);
    await expect(storage.getBucketVersioning!('prod-1')).resolves.toBe(
      'enabled',
    );
    await expect(
      read((await storage.downloadObject('prod-1', 'k')).stream),
    ).resolves.toBe('db');
    await expect(storage.listObjects('prod-1', listing)).resolves.toEqual({
      entries: [
        {
          kind: 'object',
          key: 'anycloud-api/backup.json',
          sizeBytes: null,
          lastModifiedAt: null,
        },
      ],
      nextCursor: null,
    });
    // A credential provider, not a stored key.
    expect(calls).toContain('s3 us-east-2 function');
    expect(s3Commands[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: { Bucket: 'prod-1', Key: 'anycloud-api/backup.json' },
    });
  });

  it('reaches GCS as the attached service account', async () => {
    const storage = backupStorage({
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      credentials: {
        cloudProvider: CloudType.GCP,
        kind: 'instance',
        projectId: 'proj',
      },
    });
    await storage.uploadObject('prod-1', 'anycloud-api/backup.json', upload);
    expect(gcsSaved).toEqual([
      { bucket: 'prod-1', key: 'anycloud-api/backup.json', body: 'db' },
    ]);
    await expect(storage.getBucketVersioning!('prod-1')).resolves.toBe(
      'enabled',
    );
    await expect(
      read((await storage.downloadObject('prod-1', 'k')).stream),
    ).resolves.toBe('db');
    expect(calls).toContain('gcs instance');
  });

  it('reaches the Azure container as the managed identity on the data plane, and reads versioning from its account', async () => {
    const storage = backupStorage({
      cloudProvider: CloudType.Azure,
      region: 'eastus',
      credentials: {
        cloudProvider: CloudType.Azure,
        kind: 'instance',
        subscriptionId: '0123abcd-0000-0000-0000-000000000000',
        directoryId: 'tenant-1',
      },
    });
    await storage.uploadObject('prod-1', 'anycloud-api/backup.json', upload);
    expect(blobs).toEqual([
      {
        account: 'anycloud0123abcd',
        container: 'prod-1',
        key: 'anycloud-api/backup.json',
      },
    ]);
    expect(calls).toContain('blob anycloud0123abcd as identity');
    await expect(storage.getBucketVersioning!('prod-1')).resolves.toBe(
      'disabled',
    );
    expect(calls).toContain(
      'versioning 0123abcd-0000-0000-0000-000000000000/anycloud-storage/anycloud0123abcd',
    );
    await expect(storage.listObjects('prod-1', listing)).resolves.toMatchObject(
      { entries: [{ key: 'anycloud-api/backup.json' }] },
    );
    expect(() => instanceBackupStorage(CloudType.Azure, 'eastus')).toThrow(
      'names its subscription',
    );
  });

  it.each<[CloudCredentials]>([
    [
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA',
        secretAccessKey: 's',
      },
    ],
    [
      {
        cloudProvider: CloudType.GCP,
        projectId: 'p',
        clientEmail: 'e',
        privateKey: 'k',
      },
    ],
    [
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'a',
        secret: 's',
        directoryId: 'd',
        subscriptionId: 'sub',
      },
    ],
  ])(
    'keeps a 0.1.73 cluster’s stored key on the gateway’s storage, unchanged (%o)',
    (credentials) => {
      storedProviders.length = 0;
      const storage = backupStorage({
        cloudProvider: credentials.cloudProvider,
        region: 'r',
        credentials,
      });
      expect(storage).toEqual({ type: 'stored' });
      expect(storedProviders).toEqual([
        { cloudProvider: credentials.cloudProvider, credentials, region: 'r' },
      ]);
    },
  );

  it('has no identity on a cloud without a management VM', () => {
    expect(() => instanceBackupStorage(CloudType.Lambda, 'us')).toThrow(
      'has no management VM identity',
    );
  });
});
