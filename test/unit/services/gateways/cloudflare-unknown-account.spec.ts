import { S3Client } from '@aws-sdk/client-s3';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudType } from '../../../../src/shared/cloud.js';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';

// R2 has no TLS certificate for an account that doesn't exist, so the request
// fails in the handshake. A real S3Client whose request handler fails that
// way drives the error through the SDK's middleware stack.
vi.mock('../../../../src/api/services/provider-clients/cloudflare.js', () => ({
  createR2S3Client: (credentials: unknown, endpoint: string) =>
    new S3Client({
      region: 'auto',
      endpoint,
      credentials: credentials as never,
      maxAttempts: 1,
      requestHandler: {
        handle: async () => {
          throw Object.assign(new Error('write EPROTO handshake failure'), {
            code: 'EPROTO',
          });
        },
      },
    }),
}));

const { createCloudflareStorage } = await import(
  '../../../../src/api/services/gateways/cloudflare.js'
);

afterEach(() => nock.cleanAll());

describe('Cloudflare R2 storage for an unknown account', () => {
  it('names the account instead of reporting a TLS error', async () => {
    nock('https://api.cloudflare.com')
      .get('/client/v4/accounts/typo/tokens/verify')
      .reply(200, {
        success: true,
        result: { id: 'token-id', status: 'active' },
      });
    const storage = createCloudflareStorage(
      completeCloudConfig({
        cloudProvider: CloudType.Cloudflare,
        credentials: { accountId: 'typo', apiToken: 'cf-token' },
      }),
    );

    await expect(storage.hasBucket('data')).rejects.toThrow(
      'The TLS handshake with R2 for account typo failed',
    );
  });
});
