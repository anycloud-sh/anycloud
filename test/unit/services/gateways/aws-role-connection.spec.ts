import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssumeRoleWithWebIdentityCommand,
  GetFederationTokenCommand,
  IDPCommunicationErrorException,
  InvalidIdentityTokenException,
  STSClient,
  STSServiceException,
} from '@aws-sdk/client-sts';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { CloudType, type AWSRoleCreds } from '../../../../src/shared/cloud.js';
import { AWS } from '../../../../src/api/services/gateways/aws.js';
import { canMintScopedStorageToken } from '../../../../src/api/services/gateways/cloud.js';
import { awsClientCredentials } from '../../../../src/api/services/provider-clients/aws.js';

// Each exchange reads a new ServiceAccount token.
const tokens = vi.hoisted(() => ({ issued: [] as string[] }));
vi.mock(
  '../../../../src/api/services/kubernetes/service-account-token.js',
  () => ({
    apiServiceAccountToken: async (audience: string) => {
      const token = `token-${tokens.issued.length + 1}-${audience}`;
      tokens.issued.push(token);
      return token;
    },
  }),
);
vi.mock('../../../../src/api/services/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const role: AWSRoleCreds = {
  kind: 'role',
  roleArn: 'arn:aws:iam::123456789012:role/anycloud',
  issuer: 'https://issuer.example.com',
  audience: 'sts.amazonaws.com',
  subject: 'system:serviceaccount:anycloud-system:anycloud-api',
};

/** A role of its own, since sessions are shared for the whole process. */
function roleNamed(name: string): AWSRoleCreds {
  return { ...role, roleArn: `arn:aws:iam::123456789012:role/${name}` };
}

function session(expiresInMs: number, id = 'ASIAROLE') {
  return {
    Credentials: {
      AccessKeyId: id,
      SecretAccessKey: 'role-secret',
      SessionToken: 'role-session',
      Expiration: new Date(Date.now() + expiresInMs),
    },
  };
}

/** Every STS call, with its command, answered by `answer`. */
function stubSts(answer: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  vi.spyOn(STSClient.prototype, 'send').mockImplementation(
    async (command: unknown) => {
      sent.push(command);
      return answer(command);
    },
  );
  return sent;
}

function roleStorage() {
  const storage = new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      credentials: role,
      region: 'us-west-2',
    }),
  ).storage();
  if (!canMintScopedStorageToken(storage)) throw new Error('no minter');
  return storage;
}

beforeEach(() => {
  vi.restoreAllMocks();
  tokens.issued.length = 0;
});

describe('0047 amendment 8: AWS bucket tokens from a role connection', () => {
  it('assumes the role with a new token and the grant’s policy, for 12 hours, named after the grant', async () => {
    const sent = stubSts(async () => session(12 * 3_600_000));

    const token = await roleStorage().mintScopedStorageToken([
      { bucket: 'my-output', mode: 'readwrite' },
    ]);

    expect(sent).toHaveLength(1);
    const [assume] = sent as [AssumeRoleWithWebIdentityCommand];
    expect(assume).toBeInstanceOf(AssumeRoleWithWebIdentityCommand);
    expect(assume.input).toMatchObject({
      RoleArn: role.roleArn,
      WebIdentityToken: 'token-1-sts.amazonaws.com',
      RoleSessionName: 'anycloud-my-output',
      DurationSeconds: 43_200,
    });
    expect(JSON.parse(assume.input.Policy!).Statement).toContainEqual({
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: 'arn:aws:s3:::my-output/*',
    });
    expect(token).toMatchObject({
      credentials: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'ASIAROLE',
        sessionToken: 'role-session',
      },
    });

    // A second mint reads a second token: no role chaining, no reuse.
    await roleStorage().mintScopedStorageToken([
      { bucket: 'my-input', mode: 'read' },
    ]);
    expect(
      (sent[1] as AssumeRoleWithWebIdentityCommand).input.WebIdentityToken,
    ).toBe('token-2-sts.amazonaws.com');
    expect(sent.some((c) => c instanceof GetFederationTokenCommand)).toBe(
      false,
    );
  });

  it('0047 invariant 8: never asks for more than 12 hours, and keeps a session name STS accepts', async () => {
    const sent = stubSts(async () => session(3_600_000));
    const long = 'b'.repeat(63);

    await roleStorage().mintScopedStorageToken(
      [
        { bucket: long, mode: 'read' },
        { bucket: 'other', mode: 'read' },
      ],
      { lifetimeMs: 36 * 3_600_000 },
    );

    const { input } = sent[0] as AssumeRoleWithWebIdentityCommand;
    expect(input.DurationSeconds).toBe(43_200);
    expect(input.RoleSessionName).toHaveLength(64);
    expect(input.RoleSessionName).toMatch(/^[\w+=,.@-]+$/);

    // A pool Job's grant names its Job first, so truncation keeps it.
    await roleStorage().mintScopedStorageToken([
      { bucket: long, prefix: 'job-1/', mode: 'readwrite', noDelete: true },
    ]);
    const prefixed = (sent[1] as AssumeRoleWithWebIdentityCommand).input;
    expect(prefixed.RoleSessionName).toBe(
      `anycloud-job-1@${long}`.slice(0, 64),
    );

    // A caller's nested prefix, which STS would refuse as given.
    await roleStorage().mintScopedStorageToken([
      { bucket: 'cache', prefix: 'cache/main é/', mode: 'read' },
    ]);
    expect(
      (sent[2] as AssumeRoleWithWebIdentityCommand).input.RoleSessionName,
    ).toBe('anycloud-cache-main--@cache');
  });

  it('retries an issuer AWS could not reach, with a new token', async () => {
    let calls = 0;
    const sent = stubSts(async () => {
      calls++;
      if (calls === 1)
        throw new IDPCommunicationErrorException({
          message: 'Couldn’t retrieve verification key',
          $metadata: { httpStatusCode: 400 },
        });
      return session(3_600_000);
    });

    await expect(
      roleStorage().mintScopedStorageToken([{ bucket: 'b', mode: 'read' }]),
    ).resolves.toBeDefined();
    expect(sent).toHaveLength(2);
    expect(tokens.issued).toHaveLength(2);
  });

  it('reports a trust that refuses the token as a user error', async () => {
    stubSts(async () => {
      throw new InvalidIdentityTokenException({
        message:
          'The web identity token provided could not be validated. See the AssumeRoleWithWebIdentity documentation for requirements.',
        $metadata: { httpStatusCode: 400 },
      });
    });

    await expect(
      roleStorage().mintScopedStorageToken([{ bucket: 'b', mode: 'read' }]),
    ).rejects.toMatchObject({
      name: 'DeployError',
      statusCode: 400,
      message: expect.stringContaining('could not be validated'),
    });
  });

  it('refuses a role left below 12 hours as a user error, so renewal stops retrying', async () => {
    stubSts(async () => {
      throw new STSServiceException({
        name: 'ValidationError',
        message:
          'The requested DurationSeconds exceeds the MaxSessionDuration set for this role.',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      });
    });

    await expect(
      roleStorage().mintScopedStorageToken([{ bucket: 'b', mode: 'read' }]),
    ).rejects.toMatchObject({
      name: 'DeployError',
      statusCode: 400,
      message: expect.stringContaining(
        `role ${role.roleArn} allows sessions shorter than 12 hours. Set its MaxSessionDuration to 43200 seconds.`,
      ),
    });
  });

  it('classifies a refused token as a bad credential that re-fails until fixed', () => {
    const gateway = new AWS(
      completeCloudConfig({ cloudProvider: CloudType.AWS, credentials: role }),
    );
    const error = new InvalidIdentityTokenException({
      message:
        'The web identity token provided could not be validated. See the AssumeRoleWithWebIdentity documentation for requirements.',
      $metadata: { httpStatusCode: 400 },
    });
    expect(gateway.compute().classifyError(error)).toBe('bad-credential');
    expect(gateway.isTerminalAuthError(error)).toBe(true);
  });
});

describe('0047 amendment 8: AWS compute sessions from a role connection', () => {
  it('shares one session across clients and concurrent callers, and renews it 5 minutes before expiry', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let issued = 0;
      const sent = stubSts(async () => session(60 * 60_000, `ASIA${++issued}`));
      const credentials = awsClientCredentials(roleNamed('renewing'));
      if (typeof credentials !== 'function') throw new Error('not a provider');

      const [first, concurrent] = await Promise.all([
        credentials(),
        credentials(),
      ]);
      expect(first.accessKeyId).toBe('ASIA1');
      expect(concurrent).toBe(first);
      expect((sent[0] as AssumeRoleWithWebIdentityCommand).input).toMatchObject(
        {
          RoleArn: roleNamed('renewing').roleArn,
          RoleSessionName: 'anycloud-api',
          DurationSeconds: 3_600,
        },
      );

      vi.setSystemTime(54 * 60_000);
      expect((await credentials()).accessKeyId).toBe('ASIA1');
      vi.setSystemTime(56 * 60_000);
      expect((await credentials()).accessKeyId).toBe('ASIA2');
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries again after a failed exchange instead of keeping the failure', async () => {
    let calls = 0;
    stubSts(async () => {
      if (++calls === 1) throw new Error('socket hang up');
      return session(60 * 60_000);
    });
    const credentials = awsClientCredentials(roleNamed('failing'));
    if (typeof credentials !== 'function') throw new Error('not a provider');

    await expect(credentials()).rejects.toThrow('socket hang up');
    await expect(credentials()).resolves.toMatchObject({
      accessKeyId: 'ASIAROLE',
    });
  });

  it('shares one session per role and trust across gateways in this process', async () => {
    const sent = stubSts(async () => session(60 * 60_000));
    const shared = roleNamed('shared');
    const gateways = [1, 2].map(
      () =>
        new AWS(
          completeCloudConfig({
            cloudProvider: CloudType.AWS,
            credentials: shared,
            region: 'us-east-1',
          }),
        ),
    );
    for (const gateway of gateways)
      await gateway.ec2client.config.credentials();
    expect(sent).toHaveLength(1);

    // Another issuer is another trust, so another session.
    const other = awsClientCredentials({
      ...shared,
      issuer: 'https://other.example.com',
    });
    if (typeof other !== 'function') throw new Error('not a provider');
    await other();
    expect(sent).toHaveLength(2);
  });

  it('passes a key through unchanged', () => {
    const key = { accessKeyId: 'AKIA', secretAccessKey: 'secret' };
    expect(awsClientCredentials(key)).toBe(key);
  });
});
