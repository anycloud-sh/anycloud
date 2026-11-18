import { ClientSecretCredential } from '@azure/identity';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorText,
  requireAzureAuthentication,
} from '../../integration/helpers/external-errors';

afterEach(() => vi.restoreAllMocks());

describe('Azure test authentication prerequisite', () => {
  const credentials = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    clientId: '00000000-0000-0000-0000-000000000002',
    clientSecret: 'fixture-secret',
  };
  it.each([
    'invalid_client AADSTS7000215',
    'AADSTS7000222 expired secret',
    'network timeout',
    'TooManyRequests',
  ])(
    'fails the fixture on %s instead of returning a skip reason',
    async (message) => {
      const error = new Error(message);
      vi.spyOn(ClientSecretCredential.prototype, 'getToken').mockRejectedValue(
        error,
      );
      await expect(requireAzureAuthentication(credentials)).rejects.toBe(error);
    },
  );
  it('waits for successful authentication before allowing assertions', async () => {
    const getToken = vi
      .spyOn(ClientSecretCredential.prototype, 'getToken')
      .mockResolvedValue({
        token: 'fixture-token',
        expiresOnTimestamp: Date.now() + 60_000,
      });
    await expect(
      requireAzureAuthentication(credentials),
    ).resolves.toBeUndefined();
    expect(getToken).toHaveBeenCalledWith(
      'https://management.azure.com/.default',
    );
  });
});

describe('errorText', () => {
  it('includes SDK metadata and decoded command output', () => {
    const error = Object.assign(new Error('request failed'), {
      Code: 'NoSuchEntity',
      stdout: Buffer.from('command output'),
    });

    const text = errorText(error);

    expect(text).toContain('request failed');
    expect(text).toContain('NoSuchEntity');
    expect(text).toContain('command output');
  });

  it('formats primitive and circular non-Error values', () => {
    expect(errorText(42)).toBe('42');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorText(circular)).toMatch(/Circular/);
  });
});
