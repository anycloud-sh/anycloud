import { describe, expect, it, vi } from 'vitest';
import {
  mintStorageTokensBodySchema,
  type MintStorageTokensQuery,
} from '../../../src/shared/api-contract/storage-token-schemas.js';
import {
  mintStorageTokens,
  StorageTokenForbiddenError,
  StorageTokenRequestInvalidError,
  StorageTokenUnsupportedError,
  type StorageTokenDependencies,
} from '../../../src/api/services/storage-token-domain.js';
import {
  ScopedStoragePolicyTooLargeError,
  type ScopedStorageGrant,
} from '../../../src/api/services/gateways/cloud.js';
import { makeMockCloudStorage } from '../helpers/fixtures.js';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';
import { BucketAccessDeniedError } from '../../../src/shared/errors.js';
import { PermissionDeniedError } from '../../../src/shared/permission-denied.js';

const MEMBER = { id: '42', username: 'octocat', token: null };
const LOCAL = { id: 'local:abc', username: 'local', token: null };
const DEPLOYMENT = {
  id: 'serviceaccount:signer',
  username: 'signer',
  token: null,
};
const EXPIRES_AT = 1_800_000_000_000;

const CREDENTIALS: Record<string, CloudCredentials> = {
  'prod-aws': {
    cloudProvider: CloudType.AWS,
    accessKeyId: 'AKIA',
    secretAccessKey: 'source-secret',
  },
  'session-aws': {
    cloudProvider: CloudType.AWS,
    accessKeyId: 'ASIA',
    secretAccessKey: 's',
    sessionToken: 'source-session',
  },
  'prod-gcp': {
    cloudProvider: CloudType.GCP,
    projectId: 'p',
    clientEmail: 'e@p.iam.gserviceaccount.com',
    privateKey: 'k',
  },
  'prod-azure': {
    cloudProvider: CloudType.Azure,
    applicationId: 'a',
    secret: 's',
    directoryId: 'd',
    subscriptionId: 's',
  },
  r2: { cloudProvider: CloudType.Cloudflare, accountId: 'a', apiToken: 't' },
  lambda: { cloudProvider: CloudType.Lambda, apiKey: 'k' },
};

const MINTED = {
  [CloudType.AWS]: {
    cloudProvider: CloudType.AWS,
    accessKeyId: 'ASIA-minted',
    secretAccessKey: 'minted-secret',
    sessionToken: 'minted-session',
  },
  [CloudType.GCP]: { cloudProvider: CloudType.GCP, accessToken: 'ya29.minted' },
  [CloudType.Azure]: { cloudProvider: CloudType.Azure, sasToken: 'sig=minted' },
} as const;

function setup(
  options: {
    backup?: string;
    mint?: (grants: ScopedStorageGrant[]) => Promise<unknown>;
  } = {},
) {
  const audit: Record<string, unknown>[] = [];
  const mint = vi.fn(
    async (
      grants: ScopedStorageGrant[],
      _options?: { lifetimeMs?: number },
    ) => {
      await options.mint?.(grants);
      return { credentials: MINTED[cloud], expiresAt: EXPIRES_AT };
    },
  );
  let cloud: CloudType.AWS | CloudType.GCP | CloudType.Azure = CloudType.AWS;
  const dependencies: StorageTokenDependencies = {
    resolveCredential: vi.fn(async (name: string) => {
      const creds = CREDENTIALS[name];
      return creds ? { cloudProvider: creds.cloudProvider, creds } : null;
    }),
    createStorage: vi.fn((config) => {
      cloud = config.cloudProvider as typeof cloud;
      return makeMockCloudStorage({
        type: config.cloudProvider,
        region: config.region ?? 'us-east-1',
        storageAccountName: 'acme',
        validateScopedStorageTokenSource: () => undefined,
        mintScopedStorageToken: mint,
      });
    }),
    isApiBackupBucket: (bucket) => bucket === options.backup,
    audit: (line) => audit.push(line),
  };
  return { dependencies, mint, audit };
}

function request(
  credentialName: string,
  grants: Partial<MintStorageTokensQuery['grants'][number]>[],
  lifetimeSeconds = 900,
): MintStorageTokensQuery {
  return {
    credentialName,
    lifetimeSeconds,
    grants: grants.map((grant) => ({
      bucket: 'cache',
      prefix: '',
      mode: 'read',
      noDelete: true,
      ...grant,
    })),
  };
}

const THREE_GRANTS = [
  { prefix: 'read-a/' },
  { prefix: 'read-b/' },
  { prefix: 'rw/', mode: 'readwrite' as const },
];

describe('storage token request schema', () => {
  const body = (grant: object, lifetimeSeconds?: number, count = 1) =>
    mintStorageTokensBodySchema.safeParse({
      lifetimeSeconds,
      grants: Array.from({ length: count }, () => ({
        bucket: 'cache',
        mode: 'read',
        ...grant,
      })),
    });

  it.each([
    ['', true],
    ['a/', true],
    ['a/b.c/', true],
    ['ünï/', true],
    ['a', false],
    ['/a/', false],
    ['a//b/', false],
    ['./', false],
    ['a/../', false],
    ['a/./', false],
    ['a\\b/', false],
    ['a\nb/', false],
    ['a\u007f/', false],
    ['a*/', false],
    ['a?/', false],
    ['${aws:username}/', false],
    ["a') || true || ('/", false],
    ['a"/', false],
    ['a%2e%2e/', false],
    ['a#/', false],
    [`${'x'.repeat(1_023)}/`, true],
    [`${'x'.repeat(1_024)}/`, false],
    [`${'é'.repeat(512)}/`, false],
  ])('prefix %j valid: %s', (prefix, valid) => {
    expect(body({ prefix }).success).toBe(valid);
  });

  it('bounds the lifetime and the grant count, and defaults noDelete to true', () => {
    expect(body({}, 59).success).toBe(false);
    expect(body({}, 60).success).toBe(true);
    expect(body({}, 3_600).success).toBe(true);
    expect(body({}, 3_601).success).toBe(false);
    expect(body({}, undefined, 0).success).toBe(false);
    expect(body({}, undefined, 10).success).toBe(true);
    expect(body({}, undefined, 11).success).toBe(false);
    expect(body({}).data).toEqual({
      lifetimeSeconds: 900,
      grants: [{ bucket: 'cache', prefix: '', mode: 'read', noDelete: true }],
    });
  });
});

describe('mintStorageTokens', () => {
  it('passes a member’s grants to one AWS minter call and returns one token for all of them', async () => {
    const { dependencies, mint } = setup();
    const response = await mintStorageTokens(
      MEMBER,
      { ...request('prod-aws', THREE_GRANTS, 120), region: 'eu-west-1' },
      dependencies,
    );
    expect(mint).toHaveBeenCalledOnce();
    expect(mint).toHaveBeenCalledWith(
      [
        { bucket: 'cache', prefix: 'read-a/', mode: 'read', noDelete: true },
        { bucket: 'cache', prefix: 'read-b/', mode: 'read', noDelete: true },
        { bucket: 'cache', prefix: 'rw/', mode: 'readwrite', noDelete: true },
      ],
      { lifetimeMs: 120_000 },
    );
    expect(response).toEqual({
      cloud: CloudType.AWS,
      region: 'eu-west-1',
      tokens: [
        {
          grants: [0, 1, 2],
          // The cloud's expiry, not the request's.
          expiresAt: EXPIRES_AT,
          credentials: {
            accessKeyId: 'ASIA-minted',
            secretAccessKey: 'minted-secret',
            sessionToken: 'minted-session',
          },
        },
      ],
    });
  });

  it('returns one GCP token for every grant', async () => {
    const { dependencies, mint } = setup();
    const response = await mintStorageTokens(
      MEMBER,
      request('prod-gcp', THREE_GRANTS),
      dependencies,
    );
    expect(mint).toHaveBeenCalledOnce();
    expect(response).toEqual({
      cloud: CloudType.GCP,
      tokens: [
        {
          grants: [0, 1, 2],
          expiresAt: EXPIRES_AT,
          credentials: { accessToken: 'ya29.minted' },
        },
      ],
    });
  });

  it('mints one Azure SAS per grant, each naming its grant', async () => {
    const { dependencies, mint } = setup();
    const response = await mintStorageTokens(
      MEMBER,
      request('prod-azure', THREE_GRANTS, 60),
      dependencies,
    );
    expect(mint.mock.calls.map(([grants]) => grants)).toEqual(
      THREE_GRANTS.map((grant) => [
        { bucket: 'cache', mode: 'read', noDelete: true, ...grant },
      ]),
    );
    expect(mint).toHaveBeenCalledWith(expect.anything(), {
      lifetimeMs: 60_000,
    });
    expect(response).toMatchObject({
      cloud: CloudType.Azure,
      accountUrl: 'https://acme.blob.core.windows.net',
      tokens: [{ grants: [0] }, { grants: [1] }, { grants: [2] }],
    });
  });

  it('lets every peer, a registered Deployment included, mint any grant, one that may delete too', async () => {
    const deleting = request('prod-aws', [
      { mode: 'readwrite', noDelete: false },
    ]);
    for (const actor of [MEMBER, LOCAL, DEPLOYMENT]) {
      const { dependencies, mint } = setup();
      await mintStorageTokens(actor, deleting, dependencies);
      expect(mint).toHaveBeenLastCalledWith(
        [{ bucket: 'cache', mode: 'readwrite' }],
        { lifetimeMs: 900_000 },
      );
    }
  });

  it('refuses the API’s own backup bucket to every principal', async () => {
    for (const actor of [MEMBER, LOCAL, DEPLOYMENT]) {
      const { dependencies, mint } = setup({ backup: 'api-backup' });
      await expect(
        mintStorageTokens(
          actor,
          request('prod-aws', [{ bucket: 'api-backup' }]),
          dependencies,
        ),
      ).rejects.toBeInstanceOf(StorageTokenForbiddenError);
      expect(mint).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['r2', StorageTokenUnsupportedError],
    ['lambda', StorageTokenUnsupportedError],
    ['session-aws', StorageTokenUnsupportedError],
    ['missing', StorageTokenRequestInvalidError],
  ])(
    'refuses %s before any provider call',
    async (credentialName, ErrorClass) => {
      const { dependencies } = setup();
      await expect(
        mintStorageTokens(MEMBER, request(credentialName, [{}]), dependencies),
      ).rejects.toBeInstanceOf(ErrorClass);
      expect(dependencies.createStorage).not.toHaveBeenCalled();
    },
  );

  it('refuses a bucket name the cloud would not accept, such as an AWS wildcard', async () => {
    const { dependencies } = setup();
    await expect(
      mintStorageTokens(
        MEMBER,
        request('prod-aws', [{ bucket: '*' }]),
        dependencies,
      ),
    ).rejects.toBeInstanceOf(StorageTokenRequestInvalidError);
    expect(dependencies.createStorage).not.toHaveBeenCalled();
  });

  it('answers an AWS policy over 2,048 characters as an invalid request', async () => {
    const { dependencies } = setup({
      mint: async () => {
        throw new ScopedStoragePolicyTooLargeError(2_100);
      },
    });
    await expect(
      mintStorageTokens(MEMBER, request('prod-aws', [{}]), dependencies),
    ).rejects.toBeInstanceOf(StorageTokenRequestInvalidError);
  });

  it('answers a cloud that denies the mint as BUCKET_ACCESS_DENIED', async () => {
    const { dependencies } = setup({
      mint: async () => {
        throw new PermissionDeniedError(
          CloudType.AWS,
          'sts:GetFederationToken',
          new Error('AccessDenied'),
        );
      },
    });
    await expect(
      mintStorageTokens(MEMBER, request('prod-aws', [{}]), dependencies),
    ).rejects.toBeInstanceOf(BucketAccessDeniedError);
  });

  it('audits each request once, minted or refused, and never logs a credential', async () => {
    const { dependencies, audit } = setup({ backup: 'api-backup' });
    const minted = await mintStorageTokens(
      DEPLOYMENT,
      request('prod-aws', [{ prefix: 'x/' }]),
      dependencies,
    );
    await mintStorageTokens(
      MEMBER,
      request('prod-azure', [{}, { prefix: 'y/' }]),
      dependencies,
    );
    await mintStorageTokens(
      DEPLOYMENT,
      request('prod-aws', [{ bucket: 'api-backup' }]),
      dependencies,
    ).catch(() => undefined);
    expect(audit).toMatchObject([
      {
        principal: 'serviceaccount:signer',
        credentialName: 'prod-aws',
        grants: [
          { bucket: 'cache', prefix: 'x/', mode: 'read', noDelete: true },
        ],
        lifetimeSeconds: 900,
        outcome: 'minted',
        tokens: [{ grants: [0], expiresAt: EXPIRES_AT }],
      },
      {
        principal: '42',
        outcome: 'minted',
        tokens: [{ grants: [0] }, { grants: [1] }],
      },
      {
        principal: 'serviceaccount:signer',
        outcome: 'refused',
        reason: expect.stringContaining('backup bucket'),
      },
    ]);
    const logged = JSON.stringify(audit);
    expect(minted.tokens).toHaveLength(1);
    for (const secret of [
      'minted-secret',
      'minted-session',
      'sig=minted',
      'source-secret',
    ])
      expect(logged).not.toContain(secret);
  });
});
