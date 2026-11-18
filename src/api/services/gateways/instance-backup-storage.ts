import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  CloudType,
  type CloudCredentials,
  type InstanceCloudCredentials,
} from '../../../shared/cloud.js';
import type {
  CloudObjectLister,
  CloudStorage,
  CloudUploadSource,
} from './cloud.js';
import { openCloudUploadSource } from './cloud.js';
import {
  awsClientCredentials,
  createAwsS3Client,
} from '../provider-clients/aws.js';
import {
  createAzureInstanceCredential,
  createAzureStorageManagementClient,
  createAzureTokenBlobServiceClient,
} from '../provider-clients/azure.js';
import { createGcpGatewayClients } from '../provider-clients/gcp.js';
import { createStorageProvider } from '../cloud-config.js';
import { azureStorageAccount } from './azure.js';

/**
 * The checkpoint bucket as the backup and restore-state reach it: through
 * the VM's identity on a seeded cluster, or a stored credential (an API from
 * before the seed).
 */
export function backupStorage(target: {
  cloudProvider: CloudType;
  region: string;
  credentials: CloudCredentials | InstanceCloudCredentials;
}): InstanceBackupStorage {
  const { credentials } = target;
  if ('kind' in credentials && credentials.kind === 'instance')
    return instanceBackupStorage(target.cloudProvider, target.region, {
      subscriptionId:
        'subscriptionId' in credentials ? credentials.subscriptionId : '',
    });
  // A stored credential, as before the seed (a cluster from 0.1.73).
  return createStorageProvider({
    cloudProvider: target.cloudProvider,
    credentials: credentials as CloudCredentials,
    region: target.region,
  }) as unknown as InstanceBackupStorage;
}

/**
 * What the hosted API's backup and its first-start restore do with the
 * checkpoint bucket, through the management VM's own identity (RFC 0049 C26
 * (e), owner question 10): the instance profile, the attached service account
 * or the user-assigned managed identity, each granted only that bucket.
 */
export type InstanceBackupStorage = Pick<
  CloudStorage,
  'type' | 'uploadObject' | 'getBucketVersioning' | 'downloadObject'
> &
  CloudObjectLister;

type Entries = Awaited<ReturnType<CloudObjectLister['listObjects']>>;

const objects = (keys: (string | undefined)[]): Entries => ({
  entries: keys.flatMap((key) =>
    key
      ? [
          {
            kind: 'object' as const,
            key,
            sizeBytes: null,
            lastModifiedAt: null,
          },
        ]
      : [],
  ),
  nextCursor: null,
});

/** Its whole content, for SDKs that take a body rather than a stream. */
async function bytes(source: CloudUploadSource): Promise<Buffer> {
  if (source.kind === 'buffer') return source.bytes;
  const chunks: Buffer[] = [];
  for await (const chunk of openCloudUploadSource(source))
    chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export function instanceBackupStorage(
  cloud: CloudType,
  region: string,
  scope: { subscriptionId?: string } = {},
): InstanceBackupStorage {
  // cloudtype-boundary-ok: each cloud's own instance identity (owner question 10).
  switch (cloud) {
    case CloudType.AWS: {
      const s3 = createAwsS3Client(awsClientCredentials({ kind: 'instance' }), {
        region,
        followRegionRedirects: true,
      });
      return {
        type: cloud,
        async uploadObject(bucket, key, source) {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: await bytes(source),
            }),
          );
        },
        async getBucketVersioning(bucket) {
          const { Status } = await s3.send(
            new GetBucketVersioningCommand({ Bucket: bucket }),
          );
          return Status === 'Enabled' ? 'enabled' : 'disabled';
        },
        async downloadObject(bucket, key) {
          const { Body } = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
          );
          return { stream: Body as Readable };
        },
        async listObjects(bucket, options) {
          const { Contents = [] } = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: options.prefix,
              MaxKeys: options.pageSize,
            }),
          );
          return objects(Contents.map((entry) => entry.Key));
        },
      };
    }
    case CloudType.GCP: {
      // The project matters only to listings of buckets, which a backup never makes.
      const { storage } = createGcpGatewayClients(
        { kind: 'instance', projectId: '-' },
        {},
      );
      return {
        type: cloud,
        async uploadObject(bucket, key, source) {
          await storage
            .bucket(bucket)
            .file(key)
            .save(await bytes(source), { resumable: false });
        },
        async getBucketVersioning(bucket) {
          const [metadata] = await storage.bucket(bucket).getMetadata();
          return metadata.versioning?.enabled ? 'enabled' : 'disabled';
        },
        async downloadObject(bucket, key) {
          return {
            stream: storage.bucket(bucket).file(key).createReadStream(),
          };
        },
        async listObjects(bucket, options) {
          const [files] = await storage.bucket(bucket).getFiles({
            prefix: options.prefix,
            maxResults: options.pageSize,
            autoPaginate: false,
          });
          return objects(files.map((file) => file.name));
        },
      };
    }
    case CloudType.Azure: {
      if (!scope.subscriptionId)
        throw new Error(
          'An Azure backup through the VM identity names its subscription',
        );
      // The subscription's one bucket account, as the gateway derives it.
      const derived = azureStorageAccount(scope.subscriptionId);
      const storageAccount = {
        subscriptionId: scope.subscriptionId,
        resourceGroup: derived.resourceGroup,
        name: derived.account,
      };
      const credential = createAzureInstanceCredential();
      const container = (bucket: string) =>
        createAzureTokenBlobServiceClient(
          storageAccount.name,
          credential,
        ).getContainerClient(bucket);
      return {
        type: cloud,
        async uploadObject(bucket, key, source) {
          await container(bucket)
            .getBlockBlobClient(key)
            .uploadStream(openCloudUploadSource(source));
        },
        // Versioning is the account's: Reader on it reads the blob service.
        async getBucketVersioning() {
          const properties = await createAzureStorageManagementClient(
            credential,
            storageAccount.subscriptionId,
          ).blobServices.getServiceProperties(
            storageAccount.resourceGroup,
            storageAccount.name,
          );
          return properties.isVersioningEnabled ? 'enabled' : 'disabled';
        },
        async downloadObject(bucket, key) {
          const { readableStreamBody } = await container(bucket)
            .getBlobClient(key)
            .download();
          if (!readableStreamBody)
            throw new Error(`Blob ${key} in ${bucket} has no body`);
          return { stream: Readable.from(readableStreamBody) };
        },
        async listObjects(bucket, options) {
          const keys: string[] = [];
          for await (const blob of container(bucket).listBlobsFlat({
            prefix: options.prefix,
          })) {
            keys.push(blob.name);
            if (keys.length >= options.pageSize) break;
          }
          return objects(keys);
        },
      };
    }
    case CloudType.Lambda:
    case CloudType.Cloudflare:
    case CloudType.Local:
      throw new Error(`${cloud} has no management VM identity`);
  }
}
