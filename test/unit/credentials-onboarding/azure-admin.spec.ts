import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import anycloudRole from '../../../src/shared/cloud-policies/azure-anycloud-role.json' with { type: 'json' };
import {
  AzureTestPrincipal,
  publishedRoleId,
  azureCliPasswordArgument,
  cleanupAzureOnboardingContainer,
  cleanupAzureOnboardingIdentity,
  cleanupAzureOnboardingRun,
  createAzureOnboardingRunContainer,
  type ListedAzureDirectoryObject,
  azureGraphObjectUrl,
  createAzureManualCredentialFixture,
  managedCredentialName,
  readAzureOnboardingSecrets,
  runAdminAzure,
  selectManagedAzureIdentities,
  sweepAzureOnboardingIdentities,
} from '../../integration/credentials-onboarding/azure/admin.js';

import { azureOnboardingRunLocator } from '../../integration/credentials-onboarding/azure/run-authority.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Azure onboarding cleanup guards', () => {
  it('passes leading-hyphen secrets as one redacted Azure CLI argument', async () => {
    const secret = '-leading-hyphen-bootstrap-secret';
    const passwordArgument = azureCliPasswordArgument(secret);
    const run = vi.fn(async (args: string[]) => {
      expect(args).toContain(`--password=${secret}`);
      expect(args).not.toContain('--password');
      throw new Error(`Azure login rejected ${secret}`);
    });

    const error = await runAdminAzure(
      { configDir: '/tmp/fake-azure-config', run },
      ['login', '--service-principal', passwordArgument],
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Azure login rejected [REDACTED]');
    expect((error as Error).message).not.toContain(secret);
  });

  it('reads both canonical and compatibility bootstrap variable names', () => {
    vi.stubEnv('AZURE_SUBSCRIPTION_ID', 'sub-bootstrap');
    vi.stubEnv('AZURE_TENANT_ID', 'tenant-bootstrap');
    vi.stubEnv('AZURE_CLIENT_ID', 'app-bootstrap');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'secret-bootstrap');

    expect(readAzureOnboardingSecrets()).toEqual({
      subscriptionId: 'sub-bootstrap',
      tenantId: 'tenant-bootstrap',
      applicationId: 'app-bootstrap',
      secret: 'secret-bootstrap',
    });
  });

  it('waits for a new service principal to see its subscription', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-azure-admin-unit-'));
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    let passwordAttempts = 0;
    let persistentPasswordError: Error | undefined;
    let loginAttempts = 0;
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      const url = args[args.indexOf('--url') + 1] ?? '';
      if (args[0] === 'rest' && url.endsWith('/applications')) {
        return JSON.stringify({ id: 'app-object', appId: 'app-id' });
      }
      if (args[0] === 'rest' && url.endsWith('/servicePrincipals')) {
        return JSON.stringify({ id: 'principal-object', appId: 'app-id' });
      }
      if (args[0] === 'rest' && url.endsWith('/addPassword')) {
        passwordAttempts += 1;
        if (persistentPasswordError) throw persistentPasswordError;
        if (passwordAttempts === 1) {
          throw new Error('Request_ResourceNotFound: application not found');
        }
        if (passwordAttempts === 2) {
          throw new Error(
            'ERROR: Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}})',
          );
        }
        return JSON.stringify({ secretText: 'fixture-secret' });
      }
      if (args[0] === 'login') {
        loginAttempts += 1;
        if (loginAttempts < 3) throw new Error('No subscriptions found.');
      }
      if (args.slice(0, 4).join(' ') === 'storage account keys list') {
        throw new Error('manual fixture must not depend on shared storage');
      }
      return '';
    });
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: join(rootDir, 'bootstrap'),
      rootDir,
      run,
      wait,
      now: () => currentTime,
      random: () => 1,
    };

    try {
      await expect(
        createAzureManualCredentialFixture(
          context,
          'tenant-123',
          'onb-123',
          'onboarding',
        ),
      ).resolves.toMatchObject({
        applicationId: 'app-id',
        subscriptionId: 'sub-123',
        tenantId: 'tenant-123',
      });
      expect(passwordAttempts).toBe(3);
      expect(loginAttempts).toBe(3);
      expect(wait.mock.calls).toEqual([[500], [1_000], [500], [1_000]]);
      expect(
        calls.some(
          (args) =>
            args[0] === 'account' &&
            args[1] === 'set' &&
            args.includes('sub-123'),
        ),
      ).toBe(true);
      const contributorProbe = calls.find(
        (args) => args.slice(0, 3).join(' ') === 'deployment sub validate',
      );
      expect(contributorProbe).toEqual(
        expect.arrayContaining([
          '--validation-level',
          'Provider',
          '--no-prompt',
          'true',
        ]),
      );
      const templatePath =
        contributorProbe?.[contributorProbe.indexOf('--template-file') + 1];
      const template = JSON.parse(
        await readFile(String(templatePath), 'utf8'),
      ) as { $schema?: string; resources?: unknown[] };
      expect(template.$schema).toBe(
        'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
      );
      expect(template.resources).toEqual([
        expect.objectContaining({
          type: 'Microsoft.Resources/resourceGroups',
          name: 'anycloud-onb-123-readiness',
          tags: {
            AnycloudManaged: 'true',
            AnycloudCredentialName: 'onb-123',
          },
        }),
      ]);
      expect(
        calls.some(
          (args) => args.slice(0, 4).join(' ') === 'storage account keys list',
        ),
      ).toBe(false);
      // Contributor alone, under the name strict cleanup accepts.
      const grants = calls.filter(
        (args) => args.slice(0, 3).join(' ') === 'role assignment create',
      );
      expect(grants).toHaveLength(1);
      expect(grants[0]).toEqual(
        expect.arrayContaining([
          '--name',
          'b24988ac-6180-42a0-ab88-20f7382dd24c',
          'principal-object',
        ]),
      );

      persistentPasswordError = new Error(
        'ERROR: Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}})',
      );
      passwordAttempts = 0;
      wait.mockClear();
      await expect(
        createAzureManualCredentialFixture(
          context,
          'tenant-123',
          'onb-124',
          'onboarding',
        ),
      ).rejects.toHaveProperty('cause', persistentPasswordError);
      expect(passwordAttempts).toBe(8);
      expect(wait.mock.calls).toEqual([
        [500],
        [1_000],
        [2_000],
        [4_000],
        [8_000],
        [15_000],
        [30_000],
      ]);

      persistentPasswordError = new Error('Forbidden: unrelated policy denial');
      passwordAttempts = 0;
      wait.mockClear();
      await expect(
        createAzureManualCredentialFixture(
          context,
          'tenant-123',
          'onb-125',
          'onboarding',
        ),
      ).rejects.toThrow('unrelated policy denial');
      expect(passwordAttempts).toBe(1);
      expect(wait).not.toHaveBeenCalled();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'retries the Contributor probe until ARM honours the new grant',
      options: {},
      failing: 'deployment sub validate',
    },
    // Runs 38180463073 and 38191277600: Provider validation passed while the
    // principal's Microsoft.Storage reads stayed AuthorizationFailed.
    {
      name: 'holds a Contributor principal until its storage reads are authorized',
      options: {},
      failing: 'storage account list',
    },
    {
      name: 'holds a published-role principal until its storage reads are authorized',
      options: { publishedRole: true },
      failing: 'storage account list',
    },
  ])('$name', async ({ options, failing }) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-azure-admin-unit-'));
    let currentTime = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const calls: string[][] = [];
    let failures = 0;
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      const url = args[args.indexOf('--url') + 1] ?? '';
      if (args[0] === 'rest' && url.endsWith('/applications'))
        return JSON.stringify({ id: 'app-object', appId: 'app-id' });
      if (args[0] === 'rest' && url.endsWith('/servicePrincipals'))
        return JSON.stringify({ id: 'principal-object', appId: 'app-id' });
      if (args[0] === 'rest' && url.endsWith('/addPassword'))
        return JSON.stringify({ secretText: 'fixture-secret' });
      if (args.slice(0, 3).join(' ') === failing && ++failures < 3)
        throw new Error('AuthorizationFailed');
      return '';
    });
    try {
      await expect(
        createAzureManualCredentialFixture(
          {
            bootstrapAppId: 'bootstrap-app',
            subscriptionId: 'sub-123',
            configDir: join(rootDir, 'bootstrap'),
            rootDir,
            run,
            wait,
            now: () => currentTime,
            random: () => 1,
          },
          'tenant-123',
          'onb-123',
          'onboarding',
          options,
        ),
      ).resolves.toMatchObject({ applicationId: 'app-id' });
      expect(failures).toBe(3);
      expect(wait.mock.calls).toEqual([[500], [1_000]]);
      // The probe runs as the fixture principal, after its own login.
      const lastLogin = calls.findLastIndex((args) => args[0] === 'login');
      expect(calls[lastLogin]).toEqual(
        expect.arrayContaining(['--username', 'app-id']),
      );
      expect(
        calls.findLastIndex((args) => args.slice(0, 3).join(' ') === failing),
      ).toBeGreaterThan(lastLogin);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('creates a no-grant principal whose binding cleans up through strict az rest deletes', async () => {
    const appObject = '11111111-1111-4111-8111-111111111111';
    const principalObject = '22222222-2222-4222-8222-222222222222';
    const appId = '33333333-3333-4333-8333-333333333333';
    const tags = ['AnycloudManaged', 'AnycloudCredentialName:bkt-123'];
    const listed = new Map([
      [
        'sp',
        { id: principalObject, appId, displayName: 'anycloud-bkt-123', tags },
      ],
      ['app', { id: appObject, appId, displayName: 'anycloud-bkt-123', tags }],
    ]);
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      const url = args[args.indexOf('--url') + 1] ?? '';
      const method = args[args.indexOf('--method') + 1];
      if (args[0] === 'rest' && method === 'POST') {
        if (url.endsWith('/applications'))
          return JSON.stringify({ id: appObject, appId });
        if (url.endsWith('/servicePrincipals'))
          return JSON.stringify({ id: principalObject, appId });
        if (url.endsWith('/addPassword'))
          return JSON.stringify({ secretText: 'fixture-secret' });
      }
      if (args[0] === 'rest' && method === 'DELETE') {
        if (url === azureGraphObjectUrl('sp', principalObject))
          listed.delete('sp');
        if (url === azureGraphObjectUrl('app', appObject)) listed.delete('app');
        return '';
      }
      if (args[0] === 'ad' && args[2] === 'list') {
        const object = listed.get(args[1]);
        return JSON.stringify(object ? [object] : []);
      }
      if (args.slice(0, 3).join(' ') === 'role assignment list') return '[]';
      return '';
    });
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      run,
      wait: async () => undefined,
    };

    const fixture = await createAzureManualCredentialFixture(
      context,
      'tenant-123',
      'bkt-123',
      'bucket',
      { grants: false },
    );
    expect(
      calls.some((args) => args[0] === 'login' || args[1] === 'assignment'),
    ).toBe(false);

    await cleanupAzureOnboardingIdentity(
      context,
      'anycloud-bkt-123',
      'bucket',
      undefined,
      fixture.binding,
    );
    const deletes = calls.filter(
      (args) => args.includes('delete') || args.includes('DELETE'),
    );
    expect(deletes.map((args) => args[args.indexOf('--url') + 1])).toEqual(
      expect.arrayContaining([
        azureGraphObjectUrl('sp', principalObject),
        azureGraphObjectUrl('app', appObject),
      ]),
    );
    expect(deletes.some((args) => args[0] === 'ad')).toBe(false);
    expect(listed.size).toBe(0);
  });

  // Run 38064531855: Graph answered Request_ResourceNotFound to the strict
  // DELETE while every listing still returned the application, and a later
  // delete succeeded.
  it('re-deletes a listed application through a false not-found within its own window', async () => {
    const appObject = '11111111-1111-4111-8111-111111111111';
    const principalObject = '22222222-2222-4222-8222-222222222222';
    const appId = '33333333-3333-4333-8333-333333333333';
    const object = (id: string) => ({
      id,
      appId,
      displayName: 'anycloud-bkt-123',
      tags: ['AnycloudManaged', 'AnycloudCredentialName:bkt-123'],
    });
    const listed = new Map([
      ['sp', object(principalObject)],
      ['app', object(appObject)],
    ]);
    let appDeletes = 0;
    const waits: number[] = [];
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      run: vi.fn(async (args: string[]) => {
        const url = args[args.indexOf('--url') + 1] ?? '';
        if (
          args[0] === 'rest' &&
          url === azureGraphObjectUrl('sp', principalObject)
        )
          listed.delete('sp');
        if (
          args[0] === 'rest' &&
          url === azureGraphObjectUrl('app', appObject)
        ) {
          appDeletes += 1;
          // Longer than the shared cleanup schedule's ≈60 s of waits.
          if (appDeletes <= 10)
            throw new Error(
              'Job private command failed: Request_ResourceNotFound',
            );
          listed.delete('app');
        }
        if (args[0] === 'ad' && args[2] === 'list') {
          const found = listed.get(args[1]);
          return JSON.stringify(found ? [found] : []);
        }
        if (args.slice(0, 3).join(' ') === 'role assignment list') return '[]';
        return '';
      }),
      // As JobPrivateCommands.wait: a zero-length wait is an expired deadline.
      wait: async (milliseconds: number) => {
        if (milliseconds <= 0)
          throw new Error(
            'Job private operation deadline expired or is invalid',
          );
        waits.push(milliseconds);
      },
    };

    await cleanupAzureOnboardingIdentity(
      context,
      'anycloud-bkt-123',
      'bucket',
      undefined,
      {
        application: object(appObject),
        servicePrincipal: object(principalObject),
      },
    );

    expect(listed.size).toBe(0);
    expect(appDeletes).toBe(11);
    expect(waits.reduce((total, wait) => total + wait, 0)).toBeLessThan(
      10 * 60_000,
    );
  });

  /** An Azure subscription and directory that hold what the fakes create. */
  function fakeAzure(onAddPassword?: () => Promise<void>) {
    const scope = '/subscriptions/sub-123';
    const appObject = '11111111-1111-4111-8111-111111111111';
    const principalObject = '22222222-2222-4222-8222-222222222222';
    const appId = '33333333-3333-4333-8333-333333333333';
    const tags = ['AnycloudManaged', 'AnycloudCredentialName:bkt-123'];
    const object = (id: string) => ({
      id,
      appId,
      displayName: 'anycloud-bkt-123',
      tags,
    });
    const listed = new Map<string, object>();
    const definitions = new Map<string, Record<string, unknown>>();
    const assignments: Record<string, string>[] = [];
    const calls: string[][] = [];
    const value = (args: string[], flag: string) =>
      args[args.indexOf(flag) + 1] ?? '';
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      const url = value(args, '--url');
      const method = value(args, '--method');
      const definition = /roleDefinitions\/([^?]+)/u.exec(url)?.[1];
      const command = args.slice(0, 3).join(' ');
      if (args[0] === 'rest' && definition) {
        if (method !== 'PUT') throw new Error('runs never delete the role');
        definitions.set(definition, JSON.parse(value(args, '--body')));
        return '';
      }
      if (args[0] === 'rest' && method === 'POST') {
        if (url.endsWith('/applications')) {
          listed.set('app', object(appObject));
          return JSON.stringify({ id: appObject, appId });
        }
        if (url.endsWith('/servicePrincipals')) {
          listed.set('sp', object(principalObject));
          return JSON.stringify({ id: principalObject, appId });
        }
        if (url.endsWith('/addPassword')) {
          await onAddPassword?.();
          return JSON.stringify({ secretText: 'fixture-secret' });
        }
      }
      if (args[0] === 'rest' && method === 'DELETE') {
        if (url === azureGraphObjectUrl('sp', principalObject))
          listed.delete('sp');
        if (url === azureGraphObjectUrl('app', appObject)) listed.delete('app');
        return '';
      }
      if (args[0] === 'ad' && args[2] === 'list') {
        const found = listed.get(args[1]);
        return JSON.stringify(found ? [found] : []);
      }
      if (command === 'role assignment create')
        assignments.push({
          id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${value(args, '--name')}`,
          roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${value(args, '--role')}`,
          scope,
          principalId: principalObject,
        });
      if (command === 'role assignment list')
        return JSON.stringify(assignments);
      if (command === 'role assignment delete') {
        const index = assignments.findIndex(
          (row) => row.id === value(args, '--ids'),
        );
        if (index >= 0) assignments.splice(index, 1);
      }
      return '';
    });
    return { scope, run, calls, listed, definitions, assignments };
  }

  it.each([
    ['Contributor', { grants: true }],
    ['the published Anycloud role', { publishedRole: true }],
  ])(
    'creates a principal holding %s whose strict cleanup removes everything',
    async (_label, options) => {
      const azure = fakeAzure();
      const rootDir = await mkdtemp(
        join(tmpdir(), 'anycloud-azure-admin-unit-'),
      );
      const owner = new AzureTestPrincipal(
        {
          subscriptionId: 'sub-123',
          tenantId: 'tenant-123',
          applicationId: 'bootstrap-app',
          secret: 'bootstrap-secret',
        },
        'bkt-123',
        options,
        async () => ({
          bootstrapAppId: 'bootstrap-app',
          subscriptionId: 'sub-123',
          configDir: join(rootDir, 'azure'),
          rootDir,
          run: azure.run,
          wait: async () => undefined,
        }),
      );
      await owner.create();
      expect(azure.assignments).toHaveLength(1);
      if ('publishedRole' in options) {
        const [[roleId, definition]] = [...azure.definitions];
        expect(definition).toMatchObject({
          properties: {
            type: 'CustomRole',
            assignableScopes: [azure.scope],
            permissions: [{ actions: anycloudRole.Actions, dataActions: [] }],
          },
        });
        expect(azure.assignments.map((row) => row.roleDefinitionId)).toEqual([
          `${azure.scope}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
        ]);
      }

      await owner.remove(Date.now() + 60_000);

      expect(azure.assignments).toEqual([]);
      expect(azure.listed.size).toBe(0);
      const order = (match: (args: string[]) => boolean) =>
        azure.calls.findIndex(match);
      expect(
        order(
          (args) => args.slice(0, 3).join(' ') === 'role assignment delete',
        ),
      ).toBeLessThan(
        order(
          (args) =>
            args.includes('DELETE') &&
            args.join(' ').includes('/servicePrincipals/'),
        ),
      );
    },
  );

  it('shares one published-role definition across runs, renamed when the role changes', async () => {
    const azure = fakeAzure();
    const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-azure-admin-unit-'));
    const principal = (name: string) =>
      new AzureTestPrincipal(
        {
          subscriptionId: 'sub-123',
          tenantId: 'tenant-123',
          applicationId: 'bootstrap-app',
          secret: 'bootstrap-secret',
        },
        name,
        { publishedRole: true },
        async () => ({
          bootstrapAppId: 'bootstrap-app',
          subscriptionId: 'sub-123',
          configDir: join(rootDir, 'azure'),
          rootDir,
          run: azure.run,
          wait: async () => undefined,
        }),
      );
    await principal('bkt-123').create();
    await principal('bkt-124').create();
    expect([...azure.definitions.keys()]).toEqual([
      publishedRoleId(azure.scope, anycloudRole),
    ]);
    expect(
      publishedRoleId(azure.scope, {
        ...anycloudRole,
        Actions: [
          ...anycloudRole.Actions,
          'Microsoft.Compute/disks/beginGetAccess/action',
        ],
      }),
    ).not.toBe(publishedRoleId(azure.scope, anycloudRole));
  });

  it('removes a principal only after its in-flight creation settles', async () => {
    let release!: () => void;
    const azure = fakeAzure(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-azure-admin-unit-'));
    const owner = new AzureTestPrincipal(
      {
        subscriptionId: 'sub-123',
        tenantId: 'tenant-123',
        applicationId: 'bootstrap-app',
        secret: 'bootstrap-secret',
      },
      'bkt-123',
      { grants: false },
      async () => ({
        bootstrapAppId: 'bootstrap-app',
        subscriptionId: 'sub-123',
        configDir: join(rootDir, 'azure'),
        rootDir,
        run: azure.run,
        wait: async () => undefined,
      }),
    );
    const creation = owner.create();
    await vi.waitFor(() => expect(release).toBeDefined());
    const removal = owner.remove(Date.now() + 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(azure.calls.some((args) => args[0] === 'ad')).toBe(false);
    release();
    await creation;
    await removal;
    expect(azure.listed.size).toBe(0);
  });

  it('builds distinct numeric credential names for each suite', () => {
    expect(managedCredentialName('onboarding', '123')).toBe('onb-123');
    expect(managedCredentialName('bucket', '123')).toBe('bkt-123');
    expect(() => managedCredentialName('onboarding', 'abc')).toThrow(/numeric/);
  });

  it('cleans only an exact smoke container without putting the account key in arguments', async () => {
    const calls: Array<{ args: string[]; environment?: NodeJS.ProcessEnv }> =
      [];
    const accountKey = 'azure-storage-account-key';
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: '12345678-aaaa-bbbb-cccc-123456789012',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      run: vi.fn(async (args: string[], environment?: NodeJS.ProcessEnv) => {
        calls.push({ args, environment });
        if (args.slice(0, 4).join(' ') === 'storage account keys list') {
          return accountKey;
        }
        if (args.slice(0, 3).join(' ') === 'storage container exists') {
          return 'false';
        }
        return '';
      }),
    };
    const containerName = 'anycloud-onb-smoke-123-aabbccddeeff0011';

    await cleanupAzureOnboardingContainer(context, containerName);
    await expect(
      cleanupAzureOnboardingContainer(context, 'customer-production'),
    ).rejects.toThrow(/Refusing to clean unmanaged Azure container/);

    expect(calls).toHaveLength(3);
    expect(calls.flatMap(({ args }) => args)).not.toContain(accountKey);
    expect(calls.flatMap(({ args }) => args)).not.toContain('--yes');
    for (const call of calls.slice(1)) {
      expect(call.environment).toEqual({ AZURE_STORAGE_KEY: accountKey });
      expect(call.args).toEqual(expect.arrayContaining([containerName]));
    }
  });

  it('selects only exact numeric names whose surviving directory objects are marked', () => {
    const servicePrincipals = [
      {
        appId: 'managed-app',
        displayName: 'anycloud-onb-123',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
      },
      {
        appId: 'human-app',
        displayName: 'anycloud-onb-456',
        tags: [],
      },
      {
        appId: 'bucket-app',
        displayName: 'anycloud-bkt-789',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:bkt-789'],
      },
    ];
    const applications = [
      {
        appId: 'managed-app',
        displayName: 'anycloud-onb-123',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
      },
      {
        appId: 'human-app',
        displayName: 'anycloud-onb-456',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-456'],
      },
      {
        appId: 'orphan-app',
        displayName: 'anycloud-onb-999',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-999'],
      },
    ];

    expect(
      selectManagedAzureIdentities(
        servicePrincipals,
        applications,
        'bootstrap-app',
        'onboarding',
      ),
    ).toEqual([
      { appId: 'managed-app', displayName: 'anycloud-onb-123' },
      { appId: 'orphan-app', displayName: 'anycloud-onb-999' },
    ]);
    expect(
      selectManagedAzureIdentities(
        servicePrincipals,
        applications,
        'bucket-app',
        'bucket',
      ),
    ).toEqual([]);
  });

  it('cleans exact owned objects and assignments idempotently by object ID', async () => {
    const calls: string[][] = [];
    let servicePrincipalExists = true;
    let applicationExists = true;
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list') {
          return JSON.stringify(
            servicePrincipalExists
              ? [
                  {
                    id: 'sp-object-id',
                    appId: 'managed-app',
                    displayName: 'anycloud-onb-123',
                    tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
                  },
                ]
              : [],
          );
        }
        if (command === 'ad app list') {
          return JSON.stringify(
            applicationExists
              ? [
                  {
                    id: 'app-object-id',
                    appId: 'managed-app',
                    displayName: 'anycloud-onb-123',
                    tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
                  },
                ]
              : [],
          );
        }
        if (command === 'role assignment list') {
          return JSON.stringify([
            {
              id: '/subscriptions/sub-123/providers/Microsoft.Authorization/roleAssignments/assignment-id',
            },
          ]);
        }
        if (command === 'ad sp delete') servicePrincipalExists = false;
        if (command === 'ad app delete') applicationExists = false;
        return '';
      }),
    };

    await cleanupAzureOnboardingIdentity(
      context,
      'anycloud-onb-123',
      'onboarding',
    );
    await cleanupAzureOnboardingIdentity(
      context,
      'anycloud-onb-123',
      'onboarding',
    );

    expect(
      calls.some(
        (args) =>
          args[0] === 'role' &&
          args[2] === 'delete' &&
          args.includes('assignment-id') === false &&
          args.some((arg) => arg.endsWith('/assignment-id')),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args[0] === 'ad' && args[1] === 'sp' && args.includes('sp-object-id'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args[0] === 'ad' &&
          args[1] === 'app' &&
          args.includes('app-object-id'),
      ),
    ).toBe(true);
    expect(calls.filter((args) => args[2] === 'delete')).toHaveLength(3);
  });

  it('waits for a late-visible application before deleting the identity', async () => {
    const calls: string[][] = [];
    const wait = vi.fn().mockResolvedValue(undefined);
    let applicationLists = 0;
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [1],
      wait,
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list') {
          return JSON.stringify([
            {
              id: 'sp-object-id',
              appId: 'managed-app',
              displayName: 'anycloud-onb-123',
              tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
            },
          ]);
        }
        if (command === 'ad app list') {
          applicationLists += 1;
          return JSON.stringify(
            applicationLists === 1
              ? []
              : [
                  {
                    id: 'late-app-object-id',
                    appId: 'managed-app',
                    displayName: 'anycloud-onb-123',
                    tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
                  },
                ],
          );
        }
        if (command === 'role assignment list') return '[]';
        return '';
      }),
    };

    await cleanupAzureOnboardingIdentity(
      context,
      'anycloud-onb-123',
      'onboarding',
    );

    expect(wait).toHaveBeenCalledWith(1);
    expect(
      calls.some(
        (args) =>
          args[0] === 'ad' &&
          args[1] === 'app' &&
          args[2] === 'delete' &&
          args.includes('late-app-object-id'),
      ),
    ).toBe(true);
  });

  it('retries directory deletion when a new object is missing from the delete replica', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    let applicationDeletes = 0;
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [1],
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list' || command === 'ad app list') {
          return JSON.stringify([
            {
              id: command === 'ad sp list' ? 'sp-object-id' : 'app-object-id',
              appId: 'managed-app',
              displayName: 'anycloud-onb-123',
              tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
            },
          ]);
        }
        if (command === 'role assignment list') return '[]';
        if (command === 'ad app delete') {
          applicationDeletes += 1;
          if (applicationDeletes === 1) {
            throw new Error(
              'DirectoryObjectNotFoundException: Request_ResourceNotFound',
            );
          }
        }
        return '';
      }),
    };

    await cleanupAzureOnboardingIdentity(
      context,
      'anycloud-onb-123',
      'onboarding',
    );

    expect(applicationDeletes).toBe(2);
    expect(wait).toHaveBeenCalledWith(1);
  });

  it('accepts an object that remains absent from the delete replica after retries', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    let applicationDeletes = 0;
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [1],
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list' || command === 'ad app list') {
          return JSON.stringify([
            {
              id: command === 'ad sp list' ? 'sp-object-id' : 'app-object-id',
              appId: 'managed-app',
              displayName: 'anycloud-onb-123',
              tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
            },
          ]);
        }
        if (command === 'role assignment list') return '[]';
        if (command === 'ad app delete') {
          applicationDeletes += 1;
          throw new Error(
            "Resource 'app-object-id' does not exist or one of its queried reference-property objects are not present.",
          );
        }
        return '';
      }),
    };

    await expect(
      cleanupAzureOnboardingIdentity(context, 'anycloud-onb-123', 'onboarding'),
    ).resolves.toBeUndefined();

    expect(applicationDeletes).toBe(2);
    expect(wait).toHaveBeenCalledWith(1);
  });

  it('keeps directory objects when role cleanup cannot be completed', async () => {
    const calls: string[][] = [];
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list' || command === 'ad app list') {
          return JSON.stringify([
            {
              id: command === 'ad sp list' ? 'sp-object-id' : 'app-object-id',
              appId: 'managed-app',
              displayName: 'anycloud-onb-123',
              tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
            },
          ]);
        }
        if (command === 'role assignment list') {
          throw new Error('AuthorizationFailed');
        }
        return '';
      }),
    };

    await expect(
      cleanupAzureOnboardingIdentity(context, 'anycloud-onb-123', 'onboarding'),
    ).rejects.toThrow(/role cleanup.*AuthorizationFailed/i);
    expect(calls.some((args) => args[0] === 'ad' && args[2] === 'delete')).toBe(
      false,
    );
  });

  it.each([
    ['present', 'absent', 'absent'],
    ['throttled', 'absent', 'absent'],
    ['absent', 'throttled', 'absent', 'absent'],
  ])(
    'accepts a denied orphaned principal delete after consecutive absence: %j',
    async (...listings) => {
      const calls: string[][] = [];
      const wait = vi.fn().mockResolvedValue(undefined);
      let servicePrincipalDeletes = 0;
      let absenceListings = 0;
      const orphanedServicePrincipal = {
        id: 'sp-object-id',
        appId: 'managed-app',
        displayName: 'anycloud-onb-123',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
      };
      const context = {
        bootstrapAppId: 'bootstrap-app',
        subscriptionId: 'sub-123',
        configDir: '/tmp/fake-azure-config',
        rootDir: '/tmp/fake-azure-admin',
        cleanupDiscoveryWaits: [1, 1],
        wait,
        run: vi.fn(async (args: string[]) => {
          calls.push(args);
          const command = args.slice(0, 3).join(' ');
          if (command === 'ad sp list') {
            const filter = args[args.indexOf('--filter') + 1];
            if (filter.startsWith('startswith')) {
              return JSON.stringify([orphanedServicePrincipal]);
            }
            absenceListings += 1;
            const listing = listings[absenceListings - 1];
            if (listing === 'throttled')
              throw new Error('429: Graph throttled this request');
            return JSON.stringify(
              listing === 'present' ? [orphanedServicePrincipal] : [],
            );
          }
          if (command === 'ad app list') return '[]';
          if (command === 'role assignment list') return '[]';
          if (command === 'ad sp delete') {
            servicePrincipalDeletes += 1;
            throw new Error(
              'Command failed: az ad sp delete --id sp-object-id --output none\n' +
                'ERROR: Insufficient privileges to complete the operation.',
            );
          }
          return '';
        }),
      };

      await expect(
        sweepAzureOnboardingIdentities(context, 'onboarding'),
      ).resolves.toBe(1);

      expect(servicePrincipalDeletes).toBe(1);
      expect(absenceListings).toBe(listings.length);
      expect(wait.mock.calls).toEqual([[1], [1]]);
      expect(
        calls.some((args) => args.slice(0, 3).join(' ') === 'ad app delete'),
      ).toBe(false);
    },
  );

  it('confirms a cascade first observed absent on the final scheduled listing', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    let servicePrincipalDeletes = 0;
    let absenceListings = 0;
    const orphanedServicePrincipal = {
      id: 'sp-object-id',
      appId: 'managed-app',
      displayName: 'anycloud-onb-123',
      tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
    };
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [1],
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list') {
          const filter = args[args.indexOf('--filter') + 1];
          if (filter.startsWith('startswith')) {
            return JSON.stringify([orphanedServicePrincipal]);
          }
          absenceListings += 1;
          return JSON.stringify(
            absenceListings === 1 ? [orphanedServicePrincipal] : [],
          );
        }
        if (command === 'ad app list') return '[]';
        if (command === 'role assignment list') return '[]';
        if (command === 'ad sp delete') {
          servicePrincipalDeletes += 1;
          throw new Error(
            'Command failed: az ad sp delete --id sp-object-id --output none\n' +
              'ERROR: Insufficient privileges to complete the operation.',
          );
        }
        return '';
      }),
    };

    await expect(
      sweepAzureOnboardingIdentities(context, 'onboarding'),
    ).resolves.toBe(1);

    expect(servicePrincipalDeletes).toBe(1);
    expect(absenceListings).toBe(3);
    expect(wait.mock.calls).toEqual([[1]]);
  });

  it('stops after one confirmation listing when the object reappears', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    let servicePrincipalDeletes = 0;
    let absenceListings = 0;
    const orphanedServicePrincipal = {
      id: 'sp-object-id',
      appId: 'managed-app',
      displayName: 'anycloud-onb-123',
      tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
    };
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [1],
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list') {
          const filter = args[args.indexOf('--filter') + 1];
          if (filter.startsWith('startswith')) {
            return JSON.stringify([orphanedServicePrincipal]);
          }
          absenceListings += 1;
          return JSON.stringify(
            absenceListings === 2 ? [] : [orphanedServicePrincipal],
          );
        }
        if (command === 'ad app list') return '[]';
        if (command === 'role assignment list') return '[]';
        if (command === 'ad sp delete') {
          servicePrincipalDeletes += 1;
          throw new Error(
            'Command failed: az ad sp delete --id sp-object-id --output none\n' +
              'ERROR: Insufficient privileges to complete the operation.',
          );
        }
        return '';
      }),
    };

    await expect(
      sweepAzureOnboardingIdentities(context, 'onboarding'),
    ).rejects.toThrow(
      /ad sp delete: [\s\S]*Insufficient privileges to complete the operation/,
    );
    expect(servicePrincipalDeletes).toBe(1);
    expect(absenceListings).toBe(3);
    expect(wait.mock.calls).toEqual([[1]]);
  });

  it('does not certify absence from a single empty listing', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    let servicePrincipalDeletes = 0;
    let absenceListings = 0;
    const orphanedServicePrincipal = {
      id: 'sp-object-id',
      appId: 'managed-app',
      displayName: 'anycloud-onb-123',
      tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
    };
    const context = {
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [1, 1, 1],
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(' ');
        if (command === 'ad sp list') {
          const filter = args[args.indexOf('--filter') + 1];
          if (filter.startsWith('startswith')) {
            return JSON.stringify([orphanedServicePrincipal]);
          }
          absenceListings += 1;
          return JSON.stringify(
            absenceListings === 1 ? [] : [orphanedServicePrincipal],
          );
        }
        if (command === 'ad app list') return '[]';
        if (command === 'role assignment list') return '[]';
        if (command === 'ad sp delete') {
          servicePrincipalDeletes += 1;
          throw new Error(
            'Command failed: az ad sp delete --id sp-object-id --output none\n' +
              'ERROR: Insufficient privileges to complete the operation.',
          );
        }
        return '';
      }),
    };

    await expect(
      sweepAzureOnboardingIdentities(context, 'onboarding'),
    ).rejects.toThrow(
      /ad sp delete: [\s\S]*Insufficient privileges to complete the operation/,
    );
    expect(servicePrincipalDeletes).toBe(1);
    expect(absenceListings).toBeGreaterThan(1);
  });

  it.each(['the object remains listed', 'listing remains unavailable'])(
    'does not hide a directory delete denial when %s',
    async (failure) => {
      const wait = vi.fn().mockResolvedValue(undefined);
      let servicePrincipalDeletes = 0;
      let absenceListings = 0;
      const orphanedServicePrincipal = {
        id: 'sp-object-id',
        appId: 'managed-app',
        displayName: 'anycloud-onb-123',
        tags: ['AnycloudManaged', 'AnycloudCredentialName:onb-123'],
      };
      const context = {
        bootstrapAppId: 'bootstrap-app',
        subscriptionId: 'sub-123',
        configDir: '/tmp/fake-azure-config',
        rootDir: '/tmp/fake-azure-admin',
        cleanupDiscoveryWaits: [1],
        wait,
        run: vi.fn(async (args: string[]) => {
          const command = args.slice(0, 3).join(' ');
          if (command === 'ad sp list') {
            if (servicePrincipalDeletes > 0) {
              absenceListings += 1;
              if (failure === 'listing remains unavailable')
                throw new Error('429: Graph throttled this request');
            }
            return JSON.stringify([orphanedServicePrincipal]);
          }
          if (command === 'ad app list') return '[]';
          if (command === 'role assignment list') return '[]';
          if (command === 'ad sp delete') {
            servicePrincipalDeletes += 1;
            throw new Error(
              'Command failed: az ad sp delete --id sp-object-id --output none\n' +
                'ERROR: Insufficient privileges to complete the operation.',
            );
          }
          return '';
        }),
      };

      await expect(
        sweepAzureOnboardingIdentities(context, 'onboarding'),
      ).rejects.toThrow(
        /ad sp delete: [\s\S]*Insufficient privileges to complete the operation/,
      );
      expect(servicePrincipalDeletes).toBe(1);
      expect(absenceListings).toBe(3);
      expect(wait.mock.calls).toEqual([[1]]);
    },
  );
});

// A fixed inventory with the same CLI injection used by the existing cleanup tests.
function abandonedRun() {
  const locator = azureOnboardingRunLocator('anycloud-sh/anycloud', '123', '1');
  const appId = '11111111-1111-1111-1111-111111111111';
  const spId = '22222222-2222-2222-2222-222222222222';
  const applicationId = '33333333-3333-3333-3333-333333333333';
  const metadata = {
    AnycloudManaged: 'true',
    AnycloudCredentialName: locator.credentialName,
    AnycloudOperation: locator.operationId,
  };
  const directory = (id: string): ListedAzureDirectoryObject => ({
    id,
    appId,
    displayName: locator.displayName,
    tags: [
      'AnycloudManaged',
      `AnycloudCredentialName:${locator.credentialName}`,
      `AnycloudOperation:${locator.operationId}`,
    ],
  });
  const unrelated: ListedAzureDirectoryObject = {
    id: 'customer-principal',
    appId: 'customer-app',
    displayName: 'customer-identity',
  };
  const objects = {
    sp: [directory(spId), unrelated],
    app: [directory(applicationId)],
  };
  const scope = '/subscriptions/sub-123';
  const assignments = [
    {
      id: `${scope}/providers/Microsoft.Authorization/roleAssignments/bbe920c0-6cc8-556e-8f3b-3e81ee9a6b88`,
      principalId: spId,
      scope,
      roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c`,
    },
  ];
  const expectedIds = [
    locator.containerName,
    assignments[0].id,
    spId,
    applicationId,
  ];
  const containers = new Set([locator.containerName, 'customer-container']);
  const faults = {
    deletion: '',
    transientDeletion: '',
    // A rejected directory delete whose object is nonetheless gone.
    rejectAfterDeleting: false,
    absence: '',
    hidePrincipal: false,
  };
  const deleted: string[] = [];
  let principalLists = 0;
  const run = vi.fn(async (args: string[]) => {
    // Strict cleanup deletes directory objects through `az rest` Graph URLs.
    const graph =
      args[0] === 'rest' &&
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/(applications|servicePrincipals)\/([^/]+)$/u.exec(
        args[args.indexOf('--url') + 1],
      );
    const command = graph
      ? `ad ${graph[1] === 'applications' ? 'app' : 'sp'} delete`
      : args.slice(0, 3).join(' ');
    const target = graph
      ? graph[2]
      : args[
          args.findIndex((arg) => ['--name', '--id', '--ids'].includes(arg)) + 1
        ];
    if (command.endsWith(' delete')) deleted.push(target);
    if (command === faults.deletion) {
      if (faults.rejectAfterDeleting)
        for (const kind of ['sp', 'app'] as const)
          if (command === `ad ${kind} delete`)
            objects[kind] = objects[kind].filter(({ id }) => id !== target);
      throw new Error('delete denied');
    }
    if (command === faults.transientDeletion) {
      faults.transientDeletion = '';
      throw new Error('delete rejected once');
    }
    if (args.slice(0, 4).join(' ') === 'storage account keys list')
      return 'account-key';
    if (command === 'storage container exists') {
      if (deleted.length && faults.absence === 'read denied')
        throw new Error('read denied');
      if (deleted.length && faults.absence)
        return faults.absence === 'malformed read' ? '' : 'true';
      return String(containers.has(target));
    }
    if (command === 'storage container show')
      return JSON.stringify({ name: target, metadata });
    if (command === 'storage container delete') containers.delete(target);
    if (command === 'role assignment list') return JSON.stringify(assignments);
    if (command === 'role assignment delete') assignments.splice(0);
    for (const kind of ['sp', 'app'] as const) {
      if (command === `ad ${kind} delete`)
        objects[kind] = objects[kind].filter((object) => object.id !== target);
      if (command !== `ad ${kind} list`) continue;
      if (kind === 'sp' && ++principalLists === 2 && faults.hidePrincipal)
        return '[]';
      // Exact-name inventory may include a lookalike; appId queries must honor their filter.
      const filtered = args.some((arg) => arg.startsWith('appId eq'))
        ? objects[kind].filter((object) => object.appId === appId)
        : objects[kind];
      return JSON.stringify(filtered);
    }
    return '';
  });
  return {
    locator,
    objects,
    metadata,
    assignments,
    containers,
    faults,
    deleted,
    expectedIds,
    run,
    context: {
      run,
      bootstrapAppId: 'bootstrap-app',
      subscriptionId: 'sub-123',
      configDir: '/tmp/fake-azure-config',
      rootDir: '/tmp/fake-azure-admin',
      cleanupDiscoveryWaits: [0],
      wait: async () => {},
    },
  };
}

describe('abandoned Azure onboarding run', () => {
  it.each([false, true])(
    'deletes only exact owned IDs in order and repeats safely (replica omission: %s)',
    async (hidePrincipal) => {
      const fixture = abandonedRun();
      fixture.faults.hidePrincipal = hidePrincipal;
      await cleanupAzureOnboardingRun(fixture.context, fixture.locator);
      await cleanupAzureOnboardingRun(fixture.context, fixture.locator);
      expect(fixture.deleted).toEqual(fixture.expectedIds);
      expect([...fixture.containers]).toEqual(['customer-container']);
      expect(fixture.objects.sp.map((object) => object.id)).toEqual([
        'customer-principal',
      ]);
      expect(fixture.objects.app).toEqual([]);
    },
  );

  it.each(['delete denied', 'still present', 'malformed read', 'read denied'])(
    'retains identities when container absence is uncertain: %s',
    async (failure) => {
      const { locator, context, faults, deleted, expectedIds } = abandonedRun();
      if (failure === 'delete denied')
        faults.deletion = 'storage container delete';
      else faults.absence = failure;
      const error = await cleanupAzureOnboardingRun(context, locator).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      if (failure === 'delete denied') {
        expect(error).toMatchObject({
          errors: [
            expect.objectContaining({ message: 'delete denied' }),
            expect.any(Error),
          ],
        });
        expect((error as Error).message).toMatch(
          /^Azure deletion and absence confirmation failed after \d+ms: deletion: delete denied; confirmation: Azure dependent absence could not be confirmed/u,
        );
      }
      // A delete is re-issued once after a rejection and again on every
      // confirmation read that still finds the container.
      expect(deleted).toEqual(
        Array<string>(
          { 'delete denied': 4, 'still present': 3 }[failure] ?? 1,
        ).fill(expectedIds[0]),
      );
    },
  );

  it('reports the first rejected delete when later re-issues succeed but absence fails', async () => {
    const fixture = abandonedRun();
    fixture.faults.transientDeletion = 'storage container delete';
    fixture.faults.absence = 'still present';
    await expect(
      cleanupAzureOnboardingRun(fixture.context, fixture.locator),
    ).rejects.toThrow(/deletion: delete rejected once; confirmation:/u);
  });

  // Only the strict directory delete, where Entra's false not-found occurs,
  // gets the long absence window.
  it('confirms container absence on the shared cleanup schedule', async () => {
    const fixture = abandonedRun();
    fixture.faults.absence = 'still present';
    const waits: number[] = [];
    const context = {
      ...fixture.context,
      cleanupDiscoveryWaits: undefined,
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
    };
    await expect(
      cleanupAzureOnboardingRun(context, fixture.locator),
    ).rejects.toThrow(/absence could not be confirmed/u);
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
  });

  it('does not re-issue a rejected delete once the object is gone', async () => {
    const fixture = abandonedRun();
    fixture.faults.deletion = 'ad app delete';
    fixture.faults.rejectAfterDeleting = true;
    await cleanupAzureOnboardingRun(fixture.context, fixture.locator);
    expect(fixture.deleted).toEqual(fixture.expectedIds);
    expect(fixture.objects.app).toEqual([]);
  });

  it('re-issues a rejected delete once when its listing cannot be read', async () => {
    const fixture = abandonedRun();
    fixture.faults.transientDeletion = 'storage container delete';
    fixture.faults.absence = 'read denied';
    await expect(
      cleanupAzureOnboardingRun(fixture.context, fixture.locator),
    ).rejects.toThrow('read denied');
    expect(fixture.deleted).toEqual([
      fixture.expectedIds[0],
      fixture.expectedIds[0],
    ]);
  });

  it.each(['storage container delete', 'ad sp delete', 'ad app delete'])(
    're-issues a rejected delete once and completes cleanup: %s',
    async (command) => {
      const fixture = abandonedRun();
      fixture.faults.transientDeletion = command;
      await cleanupAzureOnboardingRun(fixture.context, fixture.locator);
      const retried =
        fixture.expectedIds[
          [
            'storage container delete',
            'role assignment delete',
            'ad sp delete',
            'ad app delete',
          ].indexOf(command)
        ];
      expect(fixture.deleted).toEqual(
        fixture.expectedIds.flatMap((id) => (id === retried ? [id, id] : [id])),
      );
      expect(fixture.objects.app).toEqual([]);
      expect([...fixture.containers]).toEqual(['customer-container']);
      expect(fixture.run).toHaveBeenCalledWith(
        [
          'rest',
          '--method',
          'DELETE',
          '--url',
          `https://graph.microsoft.com/v1.0/applications/${fixture.expectedIds[3]}`,
          '--output',
          'none',
        ],
        undefined,
      );
    },
  );

  it.each([
    'duplicate',
    'operation',
    'conflicting tag',
    'application link',
    'invalid ID',
    'container marker',
  ])('rejects ambiguous or lookalike resources: %s', async (failure) => {
    const { locator, context, objects, metadata, deleted } = abandonedRun();
    if (failure === 'duplicate') objects.sp.push({ ...objects.sp[0] });
    if (failure === 'operation') objects.app[0].tags!.pop();
    if (failure === 'conflicting tag')
      objects.sp[0].tags!.push('AnycloudOperation:other-run');
    if (failure === 'application link')
      objects.app[0].appId = '44444444-4444-4444-4444-444444444444';
    if (failure === 'invalid ID') objects.sp[0].id = 'lookalike';
    if (failure === 'container marker')
      metadata.AnycloudOperation = 'other-run';
    await expect(cleanupAzureOnboardingRun(context, locator)).rejects.toThrow(
      /ambiguous|ownership/,
    );
    expect(deleted).toEqual([]);
  });

  it.each([
    'unexpected grant',
    'grant denied',
    'principal denied',
    'missing principal',
  ])('retains the application after partial cleanup: %s', async (failure) => {
    const {
      locator,
      context,
      faults,
      objects,
      assignments,
      deleted,
      expectedIds,
    } = abandonedRun();
    if (failure === 'unexpected grant')
      assignments[0].scope = '/subscriptions/other';
    if (failure === 'missing principal') objects.sp.splice(0, 1);
    if (failure === 'grant denied') faults.deletion = 'role assignment delete';
    if (failure === 'principal denied') faults.deletion = 'ad sp delete';
    await expect(cleanupAzureOnboardingRun(context, locator)).rejects.toThrow();
    expect(objects.app[0].id).toBe(expectedIds[3]);
    expect(deleted).not.toContain(expectedIds[3]);
  });

  it('creates the container with atomic ownership metadata and no adoption', async () => {
    const { locator, context, run } = abandonedRun();
    await createAzureOnboardingRunContainer(context, locator);
    expect(run).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        'storage',
        'container',
        'create',
        '--fail-on-exist',
        '--metadata',
        `AnycloudOperation=${locator.operationId}`,
      ]),
      { AZURE_STORAGE_KEY: 'account-key' },
    );
    expect(run.mock.calls.flat(2)).not.toContain('account-key');
  });
});
