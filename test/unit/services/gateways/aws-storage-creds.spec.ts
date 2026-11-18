import { describe, it, expect, vi, beforeEach } from 'vitest';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { CloudType } from '../../../../src/shared/cloud.js';

// Mock the STS client so minting makes no network call.
const sendMock = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  GetFederationTokenCommand: vi.fn().mockImplementation(function (input) {
    return { input };
  }),
}));

// Keep the gateway's logger quiet.
vi.mock('../../../../src/api/services/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GetFederationTokenCommand, STSClient } from '@aws-sdk/client-sts';
import {
  AWS,
  SCOPED_STORAGE_CRED_TTL_SECONDS,
} from '../../../../src/api/services/gateways/aws';
import {
  canMintScopedStorageToken,
  ScopedStoragePolicyTooLargeError,
} from '../../../../src/api/services/gateways/cloud';
import { DeployError } from '../../../../src/shared/errors';

// Construct AWS storage from explicit storage creds. Scoped token minting is
// exposed through the branded CloudStorage capability, the same way per-bucket
// storage providers are built (createInputStorageProvider, etc.).
function awsGateway(
  region = 'us-east-1',
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } = {
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
  },
) {
  return new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      credentials: { ...credentials },
      region,
    }),
  );
}

function awsScopedStorage(
  region = 'us-east-1',
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } = {
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
  },
) {
  const storage = awsGateway(region, credentials).storage();
  if (!canMintScopedStorageToken(storage)) {
    throw new Error('AWS storage should expose scoped token minting');
  }
  return storage;
}

function lastPolicy() {
  return JSON.parse(
    vi.mocked(GetFederationTokenCommand).mock.calls.at(-1)![0].Policy!,
  );
}

/** Every action the last policy allows. */
function lastActions(): string[] {
  return lastPolicy().Statement.flatMap(
    (statement: { Action: string | string[] }) => statement.Action,
  );
}

describe('AWS storage scoped token minting', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(STSClient).mockClear();
    vi.mocked(GetFederationTokenCommand).mockClear();
  });

  it('returns undefined for an empty grant list without calling STS', async () => {
    const out = await awsScopedStorage().mintScopedStorageToken([]);
    expect(out).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('mints a scoped, short-lived token (incl. session token), policy scoped to the bucket', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA-minted',
        SecretAccessKey: 'minted-secret',
        SessionToken: 'minted-session',
        Expiration: new Date(3_600_000),
      },
    });

    const out = await awsScopedStorage().mintScopedStorageToken([
      { bucket: 'my-bucket', mode: 'read' },
    ]);

    expect(out).toEqual({
      credentials: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'ASIA-minted',
        secretAccessKey: 'minted-secret',
        sessionToken: 'minted-session',
      },
      expiresAt: 3_600_000,
    });

    const cmdInput = vi.mocked(GetFederationTokenCommand).mock.calls.at(-1)![0];
    expect(cmdInput.DurationSeconds).toBe(SCOPED_STORAGE_CRED_TTL_SECONDS);
    expect(
      lastPolicy().Statement.map((s: { Resource: string }) => s.Resource),
    ).toEqual(['arn:aws:s3:::my-bucket', 'arn:aws:s3:::my-bucket/*']);
  });

  it('rejects a source AWS session token before calling STS', async () => {
    await expect(
      awsScopedStorage('us-west-2', {
        accessKeyId: 'ASIA-source',
        secretAccessKey: 'source-secret',
        sessionToken: 'source-session',
      }).mintScopedStorageToken([{ bucket: 'my-bucket', mode: 'read' }]),
    ).rejects.toMatchObject({
      name: 'DeployError',
      statusCode: 400,
      message: expect.stringContaining(
        'GetFederationToken requires long-term IAM user credentials',
      ),
    } satisfies Partial<DeployError>);

    expect(sendMock).not.toHaveBeenCalled();
    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
    expect(vi.mocked(GetFederationTokenCommand)).not.toHaveBeenCalled();
  });

  it('accepts long-term source AWS credentials when constructing the STS client', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA-minted',
        SecretAccessKey: 'minted-secret',
        SessionToken: 'minted-session',
        Expiration: new Date(3_600_000),
      },
    });

    await awsScopedStorage('us-west-2', {
      accessKeyId: 'ASIA-source',
      secretAccessKey: 'source-secret',
    }).mintScopedStorageToken([{ bucket: 'my-bucket', mode: 'read' }]);

    const [stsConfig] = vi.mocked(STSClient).mock.calls.at(-1) ?? [];
    expect(stsConfig).toMatchObject({
      region: 'us-west-2',
      credentials: {
        accessKeyId: 'ASIA-source',
        secretAccessKey: 'source-secret',
      },
    });
    expect(stsConfig?.credentials).not.toHaveProperty('sessionToken');
  });

  it('mints input read-only (no Put/Delete) and output read-write', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
        SessionToken: 't',
        Expiration: new Date(3_600_000),
      },
    });
    const storage = awsScopedStorage();

    await storage.mintScopedStorageToken([{ bucket: 'in', mode: 'read' }]);
    const inAct = lastActions();
    expect(inAct).toContain('s3:GetObject');
    expect(inAct).not.toContain('s3:PutObject');
    expect(inAct).not.toContain('s3:DeleteObject');

    await storage.mintScopedStorageToken([
      { bucket: 'out', mode: 'readwrite' },
    ]);
    const outAct = lastActions();
    expect(outAct).toContain('s3:PutObject');
    expect(outAct).toContain('s3:DeleteObject');
  });

  it('can mint one token covering multiple bucket grants', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
        SessionToken: 't',
        Expiration: new Date(3_600_000),
      },
    });

    const out = await awsScopedStorage().mintScopedStorageToken([
      { bucket: 'in-b', mode: 'read' },
      { bucket: 'out-b', mode: 'readwrite' },
    ]);

    expect(out).toEqual({
      credentials: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'ASIA',
        secretAccessKey: 's',
        sessionToken: 't',
      },
      expiresAt: 3_600_000,
    });
    // ONE token, not one per grant (rclone's [s3] env_auth uses one cred for every op).
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, inStmt, , outStmt] = lastPolicy().Statement;
    expect(inStmt.Resource).toContain('arn:aws:s3:::in-b/*');
    expect(inStmt.Action).not.toContain('s3:DeleteObject');
    expect(outStmt.Resource).toContain('arn:aws:s3:::out-b/*');
    expect(outStmt.Action).toContain('s3:PutObject');
  });

  it('0043/S18 scopes a pool Job grant to its prefix, with no delete, and asks for its lifetime', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
        SessionToken: 't',
        Expiration: new Date(3_600_000),
      },
    });
    const storage = awsScopedStorage();
    await storage.mintScopedStorageToken(
      [{ bucket: 'out', prefix: 'job-a/', mode: 'readwrite', noDelete: true }],
      { lifetimeMs: 900_000 },
    );
    expect(lastPolicy().Statement).toEqual([
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: 'arn:aws:s3:::out',
        Condition: { StringLike: { 's3:prefix': ['job-a/', 'job-a/*'] } },
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'],
        Resource: 'arn:aws:s3:::out/job-a/*',
      },
    ]);
    expect(
      vi.mocked(GetFederationTokenCommand).mock.calls.at(-1)![0]
        .DurationSeconds,
    ).toBe(900);

    // A managed bucket: the whole bucket, still without delete.
    await storage.mintScopedStorageToken([
      { bucket: 'job-a', mode: 'readwrite', noDelete: true },
    ]);
    expect(lastActions()).not.toContain('s3:DeleteObject');
    expect(lastPolicy().Statement[1].Resource).toBe('arn:aws:s3:::job-a/*');
  });

  it('refuses a session policy over 2,048 characters before calling STS', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
        SessionToken: 't',
        Expiration: new Date(3_600_000),
      },
    });
    const storage = awsScopedStorage();
    const grant = (prefix: string) => ({
      bucket: 'b',
      prefix: `${prefix}/`,
      mode: 'readwrite' as const,
      noDelete: true as const,
    });
    // Each prefix character appears three times in the policy.
    await storage.mintScopedStorageToken([grant('p')]);
    const base = vi.mocked(GetFederationTokenCommand).mock.calls.at(-1)![0]
      .Policy!.length;
    const prefixFor = (length: number) => 'p'.repeat(1 + (length - base) / 3);
    // The longest policy this grant can make within STS's 2,048, and one
    // character of prefix more.
    const at = 2_048 - ((2_048 - base) % 3);
    sendMock.mockClear();
    await storage.mintScopedStorageToken([grant(prefixFor(at))]);
    expect(
      vi.mocked(GetFederationTokenCommand).mock.calls.at(-1)![0].Policy!,
    ).toHaveLength(at);
    sendMock.mockClear();
    await expect(
      storage.mintScopedStorageToken([grant(prefixFor(at + 3))]),
    ).rejects.toBeInstanceOf(ScopedStoragePolicyTooLargeError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('0047 invariant 8: a key token lasts at most 12 hours, whatever is asked', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
        SessionToken: 't',
        Expiration: new Date(3_600_000),
      },
    });
    await awsScopedStorage().mintScopedStorageToken(
      [{ bucket: 'b', mode: 'read' }],
      { lifetimeMs: 36 * 3_600_000 },
    );
    expect(
      vi.mocked(GetFederationTokenCommand).mock.calls.at(-1)![0]
        .DurationSeconds,
    ).toBe(43_200);
  });

  it('throws if STS returns credentials without a session token', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
      },
    });
    await expect(
      awsScopedStorage().mintScopedStorageToken([
        { bucket: 'b', mode: 'read' },
      ]),
    ).rejects.toThrow('incomplete credentials');
  });

  it.each([undefined, new Date(NaN)])(
    'rejects a token with unusable expiration %s',
    async (expiration) => {
      sendMock.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'ASIA',
          SecretAccessKey: 's',
          SessionToken: 't',
          Expiration: expiration,
        },
      });
      await expect(
        awsScopedStorage().mintScopedStorageToken([
          { bucket: 'b', mode: 'read' },
        ]),
      ).rejects.toThrow('incomplete credentials');
    },
  );

  it('reports a denied mint as a permission denial naming the action', async () => {
    const denial = Object.assign(
      new Error('not authorized to perform: sts:GetFederationToken'),
      { name: 'AccessDenied' },
    );
    sendMock.mockRejectedValue(denial);
    await expect(
      awsScopedStorage().mintScopedStorageToken([
        { bucket: 'b', mode: 'readwrite' },
      ]),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'sts:GetFederationToken',
      cause: denial,
    });
  });

  it('wraps invalid AWS credential signatures as a user error', async () => {
    sendMock.mockRejectedValue(
      Object.assign(
        new Error('The security token included in the request is invalid'),
        { code: 'InvalidClientTokenId' },
      ),
    );
    await expect(
      awsScopedStorage().mintScopedStorageToken([
        { bucket: 'b', mode: 'read' },
      ]),
    ).rejects.toMatchObject({
      name: 'DeployError',
      statusCode: 400,
      message: expect.stringContaining('Failed to mint scoped S3 credentials'),
    } satisfies Partial<DeployError>);
  });

  it('leaves transient STS failures retryable', async () => {
    const error = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
    });
    sendMock.mockRejectedValue(error);
    await expect(
      awsScopedStorage().mintScopedStorageToken([
        { bucket: 'b', mode: 'readwrite' },
      ]),
    ).rejects.toBe(error);
  });
});
