import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BootstrapGcloudContext,
  deleteServiceAccountWithStaleListRecovery,
  managedCredentialName,
  readGCPOnboardingSecrets,
  retryIamPolicyMutation,
  retryServiceAccountIamMutation,
  retryServiceAccountPropagation,
  runAdminGcloud,
  selectManagedServiceAccounts,
  stripManagedIamMembers,
  waitForGCPImportFixtureReadiness,
} from '../../integration/credentials-onboarding/gcp/admin.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GCP onboarding bootstrap configuration', () => {
  it('reads and validates the existing repository credentials', () => {
    vi.stubEnv('GCP_PROJECT_ID', 'onboarding-project');
    vi.stubEnv(
      'GCP_CLIENT_EMAIL',
      'bootstrap@onboarding-project.iam.gserviceaccount.com',
    );
    vi.stubEnv(
      'GCP_PRIVATE_KEY',
      '-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----',
    );

    expect(readGCPOnboardingSecrets()).toEqual({
      projectId: 'onboarding-project',
      clientEmail: 'bootstrap@onboarding-project.iam.gserviceaccount.com',
      privateKey:
        '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    });
  });

  it('removes identity overrides while preserving unrelated gcloud settings', async () => {
    const identityVariables = [
      'CLOUDSDK_AUTH_ACCESS_TOKEN',
      'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
      'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
      'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
      'CLOUDSDK_AUTH_LOGIN_CONFIG_FILE',
      'CLOUDSDK_CORE_ACCOUNT',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GHA_CREDS_PATH',
      'GCP_PRIVATE_KEY',
    ];
    for (const name of identityVariables) vi.stubEnv(name, 'ambient-identity');
    vi.stubEnv('CLOUDSDK_PROXY_ADDRESS', 'proxy.internal');
    vi.stubEnv('CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE', '/etc/test-ca.pem');
    let childEnvironment: NodeJS.ProcessEnv | undefined;

    await runAdminGcloud(
      {
        configDir: '/tmp/isolated-gcloud',
        run: vi.fn(async (_args, environment) => {
          childEnvironment = environment;
          return '';
        }),
      },
      ['projects', 'describe', 'onboarding-project'],
    );

    expect(childEnvironment).toBeDefined();
    for (const name of identityVariables) {
      expect(childEnvironment).not.toHaveProperty(name);
    }
    expect(childEnvironment).toMatchObject({
      CLOUDSDK_CONFIG: '/tmp/isolated-gcloud',
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      CLOUDSDK_PROXY_ADDRESS: 'proxy.internal',
      CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: '/etc/test-ca.pem',
    });
  });
});

describe('GCP onboarding cleanup guards', () => {
  it('limits exact-account cleanup to its original UID while preserving other tombstones', () => {
    const email = 'anycloud-bkt-123@onboarding-project.iam.gserviceaccount.com';
    const other = 'anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com';
    const policy = {
      etag: 'original-policy-version',
      bindings: [
        {
          role: 'roles/storage.admin',
          members: [
            `serviceAccount:${email}`,
            `deleted:serviceAccount:${email}?uid=12345`,
            `deleted:serviceAccount:${email}?uid=99999`,
            `deleted:serviceAccount:${other}?uid=77777`,
          ],
        },
      ],
    };
    const result = stripManagedIamMembers(
      policy,
      'onboarding-project',
      new Set([email]),
      'bucket',
      { email, uniqueId: '12345' },
    );
    expect(result.changed).toBe(true);
    expect(result.policy).toEqual({
      etag: 'original-policy-version',
      bindings: [
        {
          role: 'roles/storage.admin',
          members: [
            `deleted:serviceAccount:${email}?uid=99999`,
            `deleted:serviceAccount:${other}?uid=77777`,
          ],
        },
      ],
    });
    expect(policy.bindings[0].members).toHaveLength(4);
  });
  const projectId = 'onboarding-project';
  const bootstrapEmail =
    'onboarding-bootstrap@onboarding-project.iam.gserviceaccount.com';
  const fixtureEmail =
    'anycloud-onb-123@onboarding-project.iam.gserviceaccount.com';
  const successfulReadinessRun = () =>
    vi.fn(async (args: string[]) =>
      args.slice(0, 2).join(' ') === 'auth list' ? fixtureEmail : '',
    );
  const readinessContext = (
    overrides: Partial<BootstrapGcloudContext> = {},
  ): BootstrapGcloudContext => ({
    projectId,
    bootstrapEmail,
    configDir: '/tmp/fake-gcloud',
    keyPath: '/tmp/fake-bootstrap-key.json',
    rootDir: '/tmp/fake-gcp-admin',
    now: () => 0,
    random: () => 1,
    wait: vi.fn(async () => undefined),
    run: successfulReadinessRun(),
    ...overrides,
  });
  const waitForReadiness = (context: BootstrapGcloudContext) =>
    waitForGCPImportFixtureReadiness(
      context,
      '/tmp/fake-validation',
      fixtureEmail,
      '/tmp/fake-import-key.json',
    );

  it('retries key and project-role readiness while immediate use fails', async () => {
    let currentTime = 0;
    const calls: string[][] = [];
    const context = readinessContext({
      now: () => currentTime,
      wait: vi.fn(async (milliseconds: number) => {
        currentTime += milliseconds;
      }),
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (
          args.slice(0, 2).join(' ') === 'auth activate-service-account' &&
          currentTime < 60_000
        ) {
          throw new Error('new key is still propagating');
        }
        if (args.slice(0, 2).join(' ') === 'auth list') return fixtureEmail;
        return '';
      }),
    });

    await waitForReadiness(context);

    expect(currentTime).toBeGreaterThanOrEqual(60_000);
    expect(currentTime).toBeLessThanOrEqual(90_000);
    expect(
      calls.some(
        (args) => args.slice(0, 3).join(' ') === 'compute instances list',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) => args.slice(0, 3).join(' ') === 'compute firewall-rules list',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) => args.slice(0, 3).join(' ') === 'storage buckets list',
      ),
    ).toBe(true);
    const pinnedCalls = calls.filter(
      (command) =>
        command.slice(0, 2).join(' ') === 'compute instances' ||
        command.slice(0, 2).join(' ') === 'compute firewall-rules' ||
        command.slice(0, 2).join(' ') === 'storage buckets',
    );
    expect(pinnedCalls).toHaveLength(3);
    for (const args of pinnedCalls) {
      expect(args).toContain(`--account=${fixtureEmail}`);
    }
  });

  it('returns immediately when the exact fixture identity succeeds', async () => {
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const context = readinessContext({
      now: () => currentTime,
      wait,
    });

    await waitForReadiness(context);

    expect(currentTime).toBe(0);
    expect(wait).not.toHaveBeenCalled();
  });

  it('rejects an unexpected active principal without retrying', async () => {
    const wait = vi.fn(async () => undefined);
    const run = vi.fn(async (args: string[]) =>
      args.slice(0, 2).join(' ') === 'auth list' ? bootstrapEmail : '',
    );
    const context = readinessContext({ wait, run });

    const failure = (await waitForReadiness(context).catch(
      (error: unknown) => error,
    )) as Error & { cause?: Error };

    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause?.message).toContain(
      `Expected the active GCP fixture principal to be ${fixtureEmail}`,
    );
    expect(wait).not.toHaveBeenCalled();
    expect(
      run.mock.calls.filter(
        ([args]) =>
          args.slice(0, 2).join(' ') === 'auth activate-service-account',
      ),
    ).toHaveLength(1);
  });

  it('builds distinct numeric credential names for each suite', () => {
    expect(managedCredentialName('onboarding', '123')).toBe('onb-123');
    expect(managedCredentialName('bucket', '123')).toBe('bkt-123');
    expect(() => managedCredentialName('bucket', 'abc')).toThrow(/numeric/);
  });

  it('accepts an ambiguous repeated delete only after listing confirms absence', async () => {
    const deleteAccount = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "PERMISSION_DENIED: Permission 'iam.serviceAccounts.delete' denied on resource (or it may not exist).",
        ),
      );
    const listAccounts = vi
      .fn()
      .mockResolvedValueOnce([{ email: 'anycloud-e2e-123@example.com' }])
      .mockResolvedValueOnce([]);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteServiceAccountWithStaleListRecovery(
        'anycloud-e2e-123@example.com',
        deleteAccount,
        listAccounts,
        { waits: [1], wait },
      ),
    ).resolves.toBeUndefined();
    expect(wait).toHaveBeenCalledOnce();
  });

  it('does not hide a permission failure while the account remains listed', async () => {
    const error = new Error(
      "PERMISSION_DENIED: Permission 'iam.serviceAccounts.delete' denied on resource (or it may not exist).",
    );
    await expect(
      deleteServiceAccountWithStaleListRecovery(
        'anycloud-e2e-123@example.com',
        vi.fn().mockRejectedValue(error),
        vi.fn().mockResolvedValue([{ email: 'anycloud-e2e-123@example.com' }]),
        { waits: [], wait: vi.fn() },
      ),
    ).rejects.toBe(error);
  });

  it('selects only numeric accounts owned by the requested suite', () => {
    expect(
      selectManagedServiceAccounts(
        [
          {
            email:
              'anycloud-onb-123@onboarding-project.iam.gserviceaccount.com',
            displayName: 'Anycloud Service Account - onb-123',
          },
          {
            email:
              'anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com',
            displayName: 'Anycloud Service Account - bkt-456',
          },
          {
            email:
              'anycloud-onb-456@onboarding-project.iam.gserviceaccount.com',
            displayName: 'Human-managed account',
          },
          {
            email:
              'anycloud-onb-abc@onboarding-project.iam.gserviceaccount.com',
            displayName: 'Anycloud Service Account - onb-abc',
          },
          {
            email: bootstrapEmail,
            displayName: 'Anycloud Service Account - onb-999',
          },
        ],
        projectId,
        bootstrapEmail,
        'onboarding',
      ),
    ).toEqual([
      {
        email: 'anycloud-onb-123@onboarding-project.iam.gserviceaccount.com',
        displayName: 'Anycloud Service Account - onb-123',
      },
    ]);

    expect(
      selectManagedServiceAccounts(
        [
          {
            email:
              'anycloud-onb-123@onboarding-project.iam.gserviceaccount.com',
            displayName: 'Anycloud Service Account - onb-123',
          },
          {
            email:
              'anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com',
            displayName: 'Anycloud Service Account - bkt-456',
          },
        ],
        projectId,
        bootstrapEmail,
        'bucket',
      ),
    ).toEqual([
      {
        email: 'anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com',
        displayName: 'Anycloud Service Account - bkt-456',
      },
    ]);
  });

  it('removes only selected members and tombstones owned by the suite', () => {
    const result = stripManagedIamMembers(
      {
        etag: 'etag-value',
        bindings: [
          {
            role: 'roles/editor',
            members: [
              'serviceAccount:anycloud-onb-123@onboarding-project.iam.gserviceaccount.com',
              'serviceAccount:anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com',
              'user:owner@example.com',
            ],
          },
          {
            role: 'roles/viewer',
            members: [
              'deleted:serviceAccount:anycloud-onb-999@onboarding-project.iam.gserviceaccount.com?uid=10001',
              'deleted:serviceAccount:anycloud-bkt-888@onboarding-project.iam.gserviceaccount.com?uid=10002',
              'deleted:serviceAccount:anycloud-onb-abc@onboarding-project.iam.gserviceaccount.com?uid=10003',
            ],
          },
        ],
      },
      projectId,
      new Set([
        'anycloud-onb-123@onboarding-project.iam.gserviceaccount.com',
        'anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com',
      ]),
      'onboarding',
    );

    expect(result.changed).toBe(true);
    expect(result.policy.bindings).toEqual([
      {
        role: 'roles/editor',
        members: [
          'serviceAccount:anycloud-bkt-456@onboarding-project.iam.gserviceaccount.com',
          'user:owner@example.com',
        ],
      },
      {
        role: 'roles/viewer',
        members: [
          'deleted:serviceAccount:anycloud-bkt-888@onboarding-project.iam.gserviceaccount.com?uid=10002',
          'deleted:serviceAccount:anycloud-onb-abc@onboarding-project.iam.gserviceaccount.com?uid=10003',
        ],
      },
    ]);
  });

  it('0038/S3 before/after sweeps preserve generation identities and grants', () => {
    const generatedEmail = `anycloud-onb-gen-abcdef123456@${projectId}.iam.gserviceaccount.com`;
    const markedImportEmail = `anycloud-onb-456@${projectId}.iam.gserviceaccount.com`;
    const accounts = [
      {
        email: generatedEmail,
        displayName: 'Anycloud Service Account - onb-gen-abcdef123456',
      },
      {
        email: markedImportEmail,
        displayName: 'Anycloud Service Account - onb-456',
        description:
          'AnyCloud credential generation 00000000-0000-4000-8000-000000000001',
      },
    ];
    const selected = selectManagedServiceAccounts(
      accounts,
      projectId,
      bootstrapEmail,
      'onboarding',
    );
    expect(selected).toEqual([]);
    const policy = {
      bindings: [
        {
          role: 'roles/storage.admin',
          members: [
            `serviceAccount:${generatedEmail}`,
            `deleted:serviceAccount:${generatedEmail}?uid=12345`,
            `serviceAccount:${markedImportEmail}`,
          ],
        },
      ],
    };
    expect(
      stripManagedIamMembers(
        policy,
        projectId,
        new Set(selected.map((account) => account.email)),
        'onboarding',
      ),
    ).toEqual({ policy, changed: false });
  });

  it('retries the complete IAM mutation after a concurrent policy write', async () => {
    const operation = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(
        new Error(
          'ABORTED: There were concurrent policy changes. Please retry the whole read-modify-write with exponential backoff.',
        ),
      )
      .mockResolvedValueOnce(1);
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });

    await expect(
      retryIamPolicyMutation(operation, {
        deadline: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        now: () => currentTime,
        random: () => 1,
        wait,
      }),
    ).resolves.toBe(1);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1);
  });

  it.each([
    'INVALID_ARGUMENT: Service account fixture@example.com does not exist.',
    // CI run 40364079185 failed on this keys.create refusal.
    "ERROR: (gcloud.iam.service-accounts.keys.create) PERMISSION_DENIED: Permission 'iam.serviceAccountKeys.create' denied on resource (or it may not exist).",
  ])(
    'retries while a newly created service account propagates: %s',
    async (message) => {
      const operation = vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(new Error(message))
        .mockResolvedValueOnce(1);
      let currentTime = 0;
      const wait = vi.fn(async (milliseconds: number) => {
        currentTime += milliseconds;
      });

      await expect(
        retryServiceAccountPropagation(operation, {
          deadline: 500,
          initialDelayMs: 500,
          maxDelayMs: 500,
          now: () => currentTime,
          random: () => 1,
          wait,
        }),
      ).resolves.toBe(1);
      expect(operation).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledWith(500);
    },
  );

  it('does not retry an unrelated GCP permission failure', async () => {
    const error = new Error('PERMISSION_DENIED: setIamPolicy denied');
    const operation = vi.fn<() => Promise<number>>().mockRejectedValue(error);

    await expect(
      retryServiceAccountPropagation(operation, {
        deadline: 500,
        now: () => 0,
        wait: vi.fn(),
      }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not retry a non-conflict IAM failure', async () => {
    const error = new Error('PERMISSION_DENIED: setIamPolicy denied');
    const operation = vi.fn<() => Promise<number>>().mockRejectedValue(error);

    await expect(
      retryIamPolicyMutation(operation, {
        deadline: 1,
        now: () => 0,
        wait: vi.fn(),
      }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('retries created-account IAM writes for either propagation or conflicts', async () => {
    const operation = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(
        new Error('Service account fixture@example.com does not exist.'),
      )
      .mockRejectedValueOnce(new Error('ABORTED: concurrent policy change'))
      .mockResolvedValueOnce(1);
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });

    await expect(
      retryServiceAccountIamMutation(operation, {
        deadline: 1_500,
        initialDelayMs: 500,
        maxDelayMs: 1_000,
        now: () => currentTime,
        random: () => 1,
        wait,
      }),
    ).resolves.toBe(1);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 500);
    expect(wait).toHaveBeenNthCalledWith(2, 1_000);
  });

  it('makes a final retry at the absolute IAM deadline', async () => {
    const error = new Error('ABORTED: concurrent policy change');
    const operation = vi.fn<() => Promise<number>>().mockRejectedValue(error);
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });

    await expect(
      retryIamPolicyMutation(operation, {
        deadline: 1_000,
        initialDelayMs: 800,
        maxDelayMs: 800,
        now: () => currentTime,
        random: () => 1,
        wait,
      }),
    ).rejects.toBe(error);
    expect(wait.mock.calls).toEqual([[800], [200]]);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
