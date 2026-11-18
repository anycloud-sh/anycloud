import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ORPCError } from '@orpc/client';
import { CloudType } from '../../../../src/shared/cloud.js';

const api = vi.hoisted(() => ({ getCredential: vi.fn() }));

vi.mock('../../../../src/cli/utils/output.js', () => ({
  exitWithError: (msg: string) => {
    throw new Error(msg);
  },
}));

vi.mock('../../../../src/cli/services/auth.js', async () =>
  (await import('../cli-auth-mock.js')).cliAuthMock('token'),
);

vi.mock('../../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    credentials: { get: api.getCredential },
  }),
}));

import {
  getCredentialCloudProvider,
  getCredentialMetadata,
} from '../../../../src/cli/services/credentials.js';

describe('getCredentialCloudProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns validated metadata for a named credential', async () => {
    api.getCredential.mockResolvedValue({
      name: 'aws-prod',
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA...',
    });

    await expect(getCredentialMetadata('aws-prod')).resolves.toEqual({
      name: 'aws-prod',
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIA...',
    });
  });

  it('returns the cloud provider for a named credential', async () => {
    api.getCredential.mockResolvedValue({
      name: 'aws-prod',
      cloudProvider: CloudType.AWS,
    });

    await expect(getCredentialCloudProvider('aws-prod')).resolves.toBe(
      CloudType.AWS,
    );
  });

  it('rejects credentials with an unknown cloud provider', async () => {
    api.getCredential.mockResolvedValue({
      name: 'unknown-prod',
      cloudProvider: 'not-a-cloud',
    });

    await expect(getCredentialMetadata('unknown-prod')).rejects.toThrow(
      'Unknown cloud provider "not-a-cloud".',
    );
  });

  it('prints not found only for HTTP 404', async () => {
    api.getCredential.mockRejectedValue(
      new ORPCError('CREDENTIAL_NOT_FOUND', {
        status: 404,
        message: 'Credential "missing" not found',
      }),
    );

    await expect(getCredentialCloudProvider('missing')).rejects.toThrow(
      /Credential "missing" not found/,
    );
  });

  it('preserves HTTP 500 messages instead of masking them as not found', async () => {
    api.getCredential.mockRejectedValue(
      new ORPCError('INTERNAL_SERVER_ERROR', {
        status: 500,
        message: 'anycloud API is temporarily unavailable',
      }),
    );

    await expect(getCredentialCloudProvider('gcp-test')).rejects.toThrow(
      'anycloud API is temporarily unavailable',
    );
  });

  it('preserves timeout errors instead of masking them as not found', async () => {
    api.getCredential.mockRejectedValue(
      new Error(
        'API request to /v1/credentials/gcp-test timed out after 6000ms',
      ),
    );

    await expect(getCredentialCloudProvider('gcp-test')).rejects.toThrow(
      'API request to /v1/credentials/gcp-test timed out after 6000ms',
    );
  });
});
