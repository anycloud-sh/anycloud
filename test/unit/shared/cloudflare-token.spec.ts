import { describe, expect, it, vi } from 'vitest';
import { verifyCloudflareToken } from '../../../src/shared/cloudflare-token.js';
import { CloudType } from '../../../src/shared/cloud.js';

const credential = {
  cloudProvider: CloudType.Cloudflare,
  accountId: 'cf-account',
  apiToken: 'cf-token',
} as const;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('verifyCloudflareToken', () => {
  it('accepts an account token without asking the user endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      reply(200, {
        success: true,
        result: { id: 'token-id', status: 'active' },
      }),
    );
    await expect(verifyCloudflareToken(credential, fetchImpl)).resolves.toEqual(
      {
        id: 'token-id',
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/cf-account/tokens/verify',
    );
  });

  it('accepts a user token after the account endpoint refuses it', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply(401, {
          success: false,
          errors: [{ code: 1000, message: 'Invalid API Token' }],
        }),
      )
      .mockResolvedValueOnce(
        reply(200, {
          success: true,
          result: { id: 'token-id', status: 'active' },
        }),
      );
    await verifyCloudflareToken(credential, fetchImpl);
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
    );
  });

  it("rejects an inactive or invalid token with Cloudflare's reason", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply(200, { success: true, result: { status: 'expired' } }),
      )
      .mockResolvedValueOnce(
        reply(401, {
          success: false,
          errors: [{ code: 1000, message: 'Invalid API Token' }],
        }),
      );
    const verifying = verifyCloudflareToken(credential, fetchImpl);
    await expect(verifying).rejects.toThrow(
      'Cloudflare rejected the API token: token is expired; Invalid API Token',
    );
  });
});
