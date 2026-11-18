import { describe, expect, it, vi } from 'vitest';
import { awsInstanceCredentials } from '../../../src/api/services/provider-clients/aws.js';

describe('the management VM’s instance profile', () => {
  it('reads the role’s session through IMDSv2, with a token on every read', async () => {
    const seen: {
      url: string;
      method: string;
      headers: Record<string, string>;
    }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url.endsWith('/api/token')) return new Response('tok');
      if (url.endsWith('/iam/security-credentials/'))
        return new Response('anycloud-prod-1\n');
      return Response.json({
        AccessKeyId: 'ASIA1',
        SecretAccessKey: 's',
        Token: 'session',
        Expiration: '2026-11-07T12:00:00Z',
      });
    });
    const credentials = awsInstanceCredentials(
      fetchImpl as unknown as typeof fetch,
    );
    await expect((credentials as () => Promise<unknown>)()).resolves.toEqual({
      accessKeyId: 'ASIA1',
      secretAccessKey: 's',
      sessionToken: 'session',
      expiration: new Date('2026-11-07T12:00:00Z'),
    });
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      url: 'http://169.254.169.254/latest/api/token',
    });
    expect(
      seen
        .slice(1)
        .every((call) => call.headers['X-aws-ec2-metadata-token'] === 'tok'),
    ).toBe(true);
    expect(seen.at(-1)!.url).toBe(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/anycloud-prod-1',
    );
  });

  it('fails when the instance has no role', async () => {
    const fetchImpl = async (url: string) =>
      url.endsWith('/api/token')
        ? new Response('tok')
        : new Response('', { status: 404 });
    await expect(
      (
        awsInstanceCredentials(
          fetchImpl as unknown as typeof fetch,
        ) as () => Promise<unknown>
      )(),
    ).rejects.toThrow('answered 404');
  });
});
