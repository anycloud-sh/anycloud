import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createAwsGatewayClients,
  createAwsS3Client,
} from '../../../src/api/services/provider-clients/aws.js';

const credentials = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};

describe('S3 upload transport', () => {
  it.each(['gateway', 'regional'] as const)(
    'sends large %s uploads through a peer that cannot continue a handshake',
    async (kind) => {
      const client =
        kind === 'gateway'
          ? createAwsGatewayClients(credentials, { region: 'us-east-1' }).s3
          : createAwsS3Client(credentials, { region: 'us-east-1' });
      const body = Buffer.alloc(5 * 1024 * 1024, 'x');
      let received = 0;
      const transport = vi
        .spyOn(client.config.requestHandler, 'handle')
        .mockImplementation(async (request) => {
          const expectsContinue = Object.keys(request.headers).some(
            (name) => name.toLowerCase() === 'expect',
          );
          if (expectsContinue)
            throw new Error('Peer cannot forward 100 Continue');
          for await (const chunk of Readable.from(request.body)) {
            received += Buffer.byteLength(chunk);
          }
          return {
            response: {
              statusCode: 200,
              headers: {},
              body: Readable.from([]),
            },
          };
        });
      try {
        const result = await client.send(
          new PutObjectCommand({
            Bucket: 'migration-backup',
            Key: 'bundle',
            Body: body,
          }),
        );
        expect(result.$metadata.httpStatusCode).toBe(200);
        expect(received).toBe(body.length);
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        transport.mockRestore();
        client.destroy();
      }
    },
  );
});

describe('S3 region redirects', () => {
  it('reads an object in another region after S3 redirects the request', async () => {
    // The client the AWS gateway falls back to when a credential lacks
    // s3:GetBucketLocation reaches a bucket in eu-west-1 from us-east-1.
    const client = createAwsS3Client(credentials, {
      region: 'us-east-1',
      followRegionRedirects: true,
    });
    const signedRegions: string[] = [];
    const transport = vi
      .spyOn(client.config.requestHandler, 'handle')
      .mockImplementation(async (request) => {
        const region = /Credential=[^/]+\/\d+\/([^/]+)\//.exec(
          String(request.headers.authorization),
        )?.[1];
        signedRegions.push(String(region));
        if (region !== 'eu-west-1') {
          return {
            response: {
              statusCode: 301,
              headers: {
                'content-type': 'application/xml',
                'x-amz-bucket-region': 'eu-west-1',
              },
              body: Readable.from([
                '<?xml version="1.0"?><Error><Code>PermanentRedirect</Code><Message>Use the bucket region</Message></Error>',
              ]),
            },
          };
        }
        return {
          response: {
            statusCode: 200,
            headers: { 'content-length': '2' },
            body: Readable.from([Buffer.from('ok')]),
          },
        };
      });
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: 'eu-models', Key: 'weights.bin' }),
      );
      await expect(result.Body?.transformToString()).resolves.toBe('ok');
      expect(signedRegions).toEqual(['us-east-1', 'eu-west-1']);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      transport.mockRestore();
      client.destroy();
    }
  });
});
