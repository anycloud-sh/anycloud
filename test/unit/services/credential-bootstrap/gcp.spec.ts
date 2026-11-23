import { generateKeyPairSync } from 'crypto';
import anycloudRole from '../../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gcpOperator,
  gcpOperatorEnvironment,
} from '../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import {
  createGCPTransport,
  GCPBootstrapError,
  type GCPTransport,
} from '../../../../src/cli/services/credential-bootstrap/gcp-transport.js';
import {
  generateGCPCredentials,
  getGCPGenerationPreview,
  GCP_CONTROLLER_PROJECT_ROLES,
  GCP_GENERATION_DESCRIPTION_PREFIX,
  validateGCPGenerationName,
} from '../../../../src/cli/services/credential-bootstrap/gcp.js';

vi.mock(
  '../../../../src/cli/services/credential-bootstrap/gcp-transport.js',
  async (original) => ({
    ...(await original<
      typeof import('../../../../src/cli/services/credential-bootstrap/gcp-transport.js')
    >()),
    createGCPTransport: vi.fn(),
  }),
);

const operator = gcpOperator('operator@example.com', 'selected-project', {});
const project = {
  projectId: operator.projectId,
  projectNumber: '123456789012',
  lifecycleState: 'ACTIVE',
};
const vmAccount = {
  projectId: project.projectId,
  uniqueId: '111111111111111111111',
  email: `${project.projectNumber}-compute@developer.gserviceaccount.com`,
};
const accountId = '222222222222222222222';
const keyId = 'abc123';
const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
let account:
  | { projectId: string; email: string; uniqueId: string; description: string }
  | undefined;
let keys: string[];
let projectNumber: string;
type Policy = {
  etag: string;
  version: number;
  bindings: Array<{
    role: string;
    members: string[];
    condition?: { expression: string };
  }>;
};
let policies: Record<string, Policy>;
type CustomRole = typeof anycloudRole & { name: string; deleted?: boolean };
let customRoles: Record<string, CustomRole>;
const request = vi.fn<GCPTransport['request']>();
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.resetAllMocks();
  account = undefined;
  keys = [];
  projectNumber = project.projectNumber;
  customRoles = {};
  policies = Object.fromEntries(
    ['iam', 'projects'].map((service) => [
      service,
      {
        etag: 'original-etag',
        version: 3,
        bindings: [
          {
            role: 'roles/viewer',
            members: ['user:somebody@example.com'],
            condition: { expression: 'true' },
          },
        ],
      },
    ]),
  );
  vi.mocked(createGCPTransport).mockResolvedValue({ request });
  request.mockImplementation(async (service, path, method = 'GET', body) => {
    if (service === 'projects' && method === 'GET')
      return { ...project, projectNumber };
    if (path.includes('/roles')) {
      const roles = `/v1/projects/${project.projectId}/roles`;
      if (path === roles && method === 'POST') {
        const { roleId, role } = body as { roleId: string; role: CustomRole };
        const name = `projects/${project.projectId}/roles/${roleId}`;
        if (customRoles[name])
          throw new GCPBootstrapError('Exists', 409, 'ALREADY_EXISTS');
        customRoles[name] = { ...role, name };
      }
      const name = path.slice(4).split('?')[0]!;
      const role = customRoles[name];
      if (!role) throw new GCPBootstrapError('Missing role', 404, 'NOT_FOUND');
      if (method === 'PATCH') Object.assign(role, body);
      return structuredClone(role);
    }
    if (path.endsWith(':getIamPolicy'))
      return structuredClone(policies[service]);
    if (path.endsWith(':setIamPolicy')) {
      const { policy } = body as { policy: Policy };
      expect(policy.etag).toBe('original-etag');
      policies[service] = structuredClone(policy);
      return structuredClone(policy);
    }
    if (path.endsWith('/serviceAccounts') && method === 'POST') {
      if (account) throw new GCPBootstrapError('Already exists', 409);
      const input = body as {
        accountId: string;
        serviceAccount: { description: string };
      };
      account = {
        projectId: project.projectId,
        email: `${input.accountId}@${project.projectId}.iam.gserviceaccount.com`,
        uniqueId: accountId,
        description: input.serviceAccount.description,
      };
      return { ...account };
    }
    if (path.includes('/keys?'))
      return {
        keys: keys.map((key) => ({
          name: `${path.split('/keys')[0]}/keys/${key}`,
        })),
      };
    if (path.endsWith('/keys') && method === 'POST') {
      keys.push(keyId);
      return {
        name: `projects/${project.projectId}/serviceAccounts/${accountId}/keys/${keyId}`,
        privateKeyData: Buffer.from(
          JSON.stringify({
            type: 'service_account',
            project_id: project.projectId,
            client_email: account!.email,
            client_id: accountId,
            private_key_id: keyId,
            private_key: privateKey,
          }),
        ).toString('base64'),
      };
    }
    if (path.includes('/keys/') && method === 'DELETE') {
      keys = keys.filter((key) => key !== path.split('/').pop());
      return {};
    }
    if (method === 'DELETE') {
      account = undefined;
      return {};
    }
    if (
      path.endsWith(vmAccount.uniqueId) ||
      path.endsWith(encodeURIComponent(vmAccount.email))
    )
      return { ...vmAccount };
    if (account && path.endsWith(accountId)) return { ...account };
    throw new GCPBootstrapError('Missing account', 404);
  });
});

/** Every permission the project's IAM policy grants `email` through roles. */
const grantedPermissions = (email: string) =>
  policies.projects.bindings
    .filter(
      ({ members, condition }) =>
        !condition && members.includes(`serviceAccount:${email}`),
    )
    .flatMap(({ role }) => customRoles[role]?.includedPermissions ?? []);

const mutations = () =>
  request.mock.calls.filter(
    ([, path, method]) =>
      method !== undefined && !path.endsWith(':getIamPolicy'),
  );

describe('0038/S3 GCP generation ownership', () => {
  it.each([1, 6])(
    'bounds missing reads of the new immutable identity (%i rejections)',
    async (rejections) => {
      vi.useFakeTimers();
      const preview = await getGCPGenerationPreview(operator, 'test');
      const implementation = request.getMockImplementation()!;
      let missingReads = 0;
      request.mockImplementation(async (...args) => {
        if (
          args[1].endsWith(accountId) &&
          args[2] === undefined &&
          missingReads < rejections
        ) {
          missingReads++;
          throw new GCPBootstrapError('Not visible', 404, 'NOT_FOUND');
        }
        return implementation(...args);
      });
      const outcome = generateGCPCredentials(preview).catch(
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const result = await outcome;
      expect(missingReads).toBe(rejections);
      expect(
        mutations().filter(([, path]) => path.endsWith('/serviceAccounts')),
      ).toHaveLength(1);
      if (rejections === 6) {
        expect(String(result)).toContain('resources were retained');
        expect(keys).toEqual([]);
        expect(mutations()).toHaveLength(1);
      } else {
        expect(result).toHaveProperty('privateKey', privateKey);
        expect(keys).toEqual([keyId]);
      }
    },
  );

  it('re-reads the policy only after the exact new-account grant rejection', async () => {
    vi.useFakeTimers();
    const preview = await getGCPGenerationPreview(operator, 'test');
    const implementation = request.getMockImplementation()!;
    let rejected = false;
    request.mockImplementation(async (...args) => {
      if (args[1].endsWith(':setIamPolicy') && !rejected) {
        rejected = true;
        throw new GCPBootstrapError(
          'New service account not visible',
          400,
          'INVALID_ARGUMENT',
          preview.email,
        );
      }
      return implementation(...args);
    });
    const pending = generateGCPCredentials(preview);
    await vi.runAllTimersAsync();
    const generated = await pending;
    expect(generated.ownership.keyIds).toEqual([keyId]);
    expect(
      request.mock.calls.filter(([, path]) => path.endsWith(':getIamPolicy')),
    ).toHaveLength(2);
    expect(
      request.mock.calls.filter(([, path]) => path.endsWith(':setIamPolicy')),
    ).toHaveLength(2);
    expect(
      mutations().filter(([, path]) => path.endsWith('/keys')),
    ).toHaveLength(1);
  });

  it('bounds persistent new-account visibility rejection at six grant attempts', async () => {
    vi.useFakeTimers();
    const preview = await getGCPGenerationPreview(operator, 'test');
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      if (args[1].endsWith(':setIamPolicy'))
        throw new GCPBootstrapError(
          'Not visible',
          400,
          'INVALID_ARGUMENT',
          preview.email,
        );
      return implementation(...args);
    });
    const outcome = generateGCPCredentials(preview).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(String(await outcome)).toContain('resources were retained');
    expect(
      request.mock.calls.filter(([, path]) => path.endsWith(':setIamPolicy')),
    ).toHaveLength(6);
    expect(keys).toEqual([]);
  });

  it.each([
    new GCPBootstrapError('Permission denied', 403),
    new GCPBootstrapError('Concurrent policy update', 409, 'ABORTED'),
    new GCPBootstrapError(
      'Other identity missing',
      400,
      'INVALID_ARGUMENT',
      'another@selected-project.iam.gserviceaccount.com',
    ),
  ])('never retries an unrelated grant failure: %s', async (failure) => {
    const preview = await getGCPGenerationPreview(operator, 'test');
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      if (args[1].endsWith(':setIamPolicy')) throw failure;
      return implementation(...args);
    });
    const rejection = generateGCPCredentials(preview);
    await expect(rejection).rejects.toThrow('resources were retained');
    // Onboarding reads the cause to turn a denial into an administrator request.
    await expect(rejection).rejects.toHaveProperty('cause', failure);
    expect(
      request.mock.calls.filter(([, path]) => path.endsWith(':setIamPolicy')),
    ).toHaveLength(1);
  });

  it('preserves the grant baseline and existing conditional policy while issuing one fresh key', async () => {
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    expect(generated.privateKey === privateKey).toBe(true);
    expect(generated.ownership).toMatchObject({
      uniqueId: accountId,
      keyIds: [keyId],
      projectRoles: [...GCP_CONTROLLER_PROJECT_ROLES],
    });
    expect(account?.description).toBe(
      `${GCP_GENERATION_DESCRIPTION_PREFIX}${generated.ownership.invocationId}`,
    );
    expect(policies.projects.bindings[0]).toEqual({
      role: 'roles/viewer',
      members: ['user:somebody@example.com'],
      condition: { expression: 'true' },
    });
    expect(
      mutations().filter(([, path]) => path.endsWith('/keys')),
    ).toHaveLength(1);
    await generated.cleanup();
    expect(account).toBeUndefined();
    expect(keys).toEqual([]);
    expect(policies.projects.bindings).toHaveLength(1);
    expect(policies.iam.bindings).toHaveLength(1);
    expect(
      mutations()
        .filter(([, , method]) => method === 'DELETE')
        .map(([, path]) => path),
    ).toEqual([
      `/v1/projects/${project.projectId}/serviceAccounts/${accountId}/keys/${keyId}`,
      `/v1/projects/${project.projectId}/serviceAccounts/${accountId}`,
    ]);
  });

  it.each([
    ['a project without the role', undefined],
    [
      'a role from an older release',
      { includedPermissions: ['compute.instances.get'] },
    ],
  ])(
    'grants a generated key every permission the published role names, in %s',
    async (_case, existing) => {
      const name = `projects/${project.projectId}/roles/anycloud`;
      if (existing) customRoles[name] = { ...anycloudRole, ...existing, name };
      const generated = await generateGCPCredentials(
        await getGCPGenerationPreview(operator, 'test'),
      );
      // VM Jobs make their own network on first use (RFC 0053), so a key
      // missing compute.networks.create can't launch one.
      expect(new Set(grantedPermissions(generated.clientEmail))).toEqual(
        new Set(anycloudRole.includedPermissions),
      );
      await generated.cleanup();
      expect(grantedPermissions(generated.clientEmail)).toEqual([]);
      // Other credentials and role connections may share the role.
      expect(customRoles[name]?.deleted).toBeUndefined();
    },
  );

  it('0047/S8 never reads or grants on the default Compute service account', async () => {
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    await generated.cleanup();
    expect(
      request.mock.calls.filter(
        ([service, path]) =>
          service === 'iam' &&
          (path.includes(vmAccount.uniqueId) ||
            path.includes(encodeURIComponent(vmAccount.email))),
      ),
    ).toEqual([]);
  });

  it.each(['uniqueId', 'email', 'description'] as const)(
    'does not clean up a replaced account or changed %s',
    async (field) => {
      const generated = await generateGCPCredentials(
        await getGCPGenerationPreview(operator, 'test'),
      );
      account![field] =
        field === 'uniqueId' ? '333333333333333333333' : 'replacement';
      request.mockClear();
      await expect(generated.cleanup()).rejects.toThrow('ownership changed');
      expect(mutations()).toEqual([]);
    },
  );

  it('checks ownership again between destructive phases', async () => {
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const result = await implementation(...args);
      if (args[2] === 'DELETE') account!.description = 'replacement';
      return result;
    });
    request.mockClear();
    await expect(generated.cleanup()).rejects.toThrow('ownership changed');
    expect(mutations()).toHaveLength(1);
  });

  it('rejects a different project identity before generation or cleanup', async () => {
    const preview = await getGCPGenerationPreview(operator, 'test');
    projectNumber = '999999999999';
    await expect(generateGCPCredentials(preview)).rejects.toThrow(
      'project changed',
    );
    expect(mutations()).toEqual([]);
    projectNumber = project.projectNumber;
    const generated = await generateGCPCredentials(preview);
    projectNumber = '999999999999';
    request.mockClear();
    await expect(generated.cleanup()).rejects.toThrow(
      'project identity changed',
    );
    expect(mutations()).toEqual([]);
  });

  it('refuses to remove an identity with an unattributed key', async () => {
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    keys.push('another-invocations-key');
    request.mockClear();
    await expect(generated.cleanup()).rejects.toThrow('unattributed keys');
    expect(mutations()).toEqual([]);
  });

  it('deletes an issued key even when the initial key list omits it', async () => {
    vi.useFakeTimers();
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    const implementation = request.getMockImplementation()!;
    let firstKeyList = true;
    request.mockImplementation(async (...args) => {
      if (args[1].includes('/keys?') && firstKeyList) {
        firstKeyList = false;
        return { keys: [] };
      }
      return implementation(...args);
    });
    request.mockClear();
    const outcome = generated.cleanup().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeUndefined();
    expect(keys).toEqual([]);
    expect(account).toBeUndefined();
    expect(
      mutations().filter(([, path]) => path.includes('/keys/')),
    ).toHaveLength(1);
  });

  it('accepts definitive absence of a previously deleted owned key', async () => {
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    keys = [];
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      if (args[1].includes('/keys/') && args[2] === 'DELETE')
        throw new GCPBootstrapError('Key not found', 404, 'NOT_FOUND');
      return implementation(...args);
    });
    request.mockClear();
    await generated.cleanup();
    expect(account).toBeUndefined();
    expect(
      mutations().filter(([, path]) => path.includes('/keys/')),
    ).toHaveLength(1);
  });

  it('retains the identity after an uncertain key deletion without repeating the write', async () => {
    const generated = await generateGCPCredentials(
      await getGCPGenerationPreview(operator, 'test'),
    );
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const result = await implementation(...args);
      if (args[1].includes('/keys/') && args[2] === 'DELETE')
        throw new GCPBootstrapError('Response lost');
      return result;
    });
    request.mockClear();
    await expect(generated.cleanup()).rejects.toThrow('Response lost');
    expect(keys).toEqual([]);
    expect(account).toBeDefined();
    expect(mutations()).toHaveLength(1);
  });

  it.each([1, 5, 6])(
    'bounds reads of a deleted owned key without repeating cleanup writes (%i stale reads)',
    async (staleReads) => {
      vi.useFakeTimers();
      const generated = await generateGCPCredentials(
        await getGCPGenerationPreview(operator, 'test'),
      );
      const implementation = request.getMockImplementation()!;
      let postDeletionReads = 0;
      request.mockImplementation(async (...args) => {
        if (args[1].includes('/keys?') && keys.length === 0) {
          postDeletionReads++;
          if (postDeletionReads <= staleReads)
            return {
              keys: [{ name: `${args[1].split('/keys')[0]}/keys/${keyId}` }],
            };
        }
        return implementation(...args);
      });
      request.mockClear();
      const outcome = generated.cleanup().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const result = await outcome;
      expect(postDeletionReads).toBe(Math.min(staleReads + 1, 6));
      expect(
        mutations().filter(([, path]) => path.includes('/keys/')),
      ).toHaveLength(1);
      expect(
        mutations().filter(([, path]) => path.endsWith(':setIamPolicy')),
      ).toHaveLength(1);
      const accountDeletions = mutations().filter(
        ([, path, method]) => path.endsWith(accountId) && method === 'DELETE',
      );
      if (staleReads === 6) {
        expect(String(result)).toContain('GCP identity still has keys');
        expect(account).toBeDefined();
        expect(accountDeletions).toHaveLength(0);
      } else {
        expect(result).toBeUndefined();
        expect(account).toBeUndefined();
        expect(accountDeletions).toHaveLength(1);
      }
    },
  );

  it.each(['unattributed key', 'changed ownership', 'read failure'])(
    'stops waiting for key deletion on %s',
    async (failure) => {
      vi.useFakeTimers();
      const generated = await generateGCPCredentials(
        await getGCPGenerationPreview(operator, 'test'),
      );
      const implementation = request.getMockImplementation()!;
      let postDeletionReads = 0;
      request.mockImplementation(async (...args) => {
        if (postDeletionReads > 0 && failure === 'changed ownership')
          account!.description = 'replacement';
        if (args[1].includes('/keys?') && keys.length === 0) {
          postDeletionReads++;
          if (postDeletionReads === 1)
            return {
              keys: [{ name: `${args[1].split('/keys')[0]}/keys/${keyId}` }],
            };
          if (failure === 'unattributed key')
            return {
              keys: [{ name: `${args[1].split('/keys')[0]}/keys/another-key` }],
            };
          throw new GCPBootstrapError('Permission denied', 403);
        }
        return implementation(...args);
      });
      request.mockClear();
      const outcome = generated.cleanup().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(String(await outcome)).toContain(
        failure === 'unattributed key'
          ? 'unattributed keys'
          : failure === 'changed ownership'
            ? 'ownership changed'
            : 'Permission denied',
      );
      expect(postDeletionReads).toBe(failure === 'changed ownership' ? 1 : 2);
      expect(account).toBeDefined();
      expect(mutations()).toHaveLength(2);
      expect(
        mutations().filter(([, , method]) => method === 'DELETE'),
      ).toHaveLength(1);
    },
  );

  it('does not adopt an existing name', async () => {
    const preview = await getGCPGenerationPreview(operator, 'test');
    account = {
      projectId: project.projectId,
      email: preview.email,
      uniqueId: accountId,
      description: 'pre-existing',
    };
    await expect(generateGCPCredentials(preview)).rejects.toThrow(
      'resources were retained',
    );
    expect(mutations()).toHaveLength(1);
    expect(keys).toEqual([]);
  });

  it.each(['create', 'policy', 'key'])(
    'retains uncertain %s without replay or speculative cleanup',
    async (stage) => {
      const preview = await getGCPGenerationPreview(operator, 'test');
      const implementation = request.getMockImplementation()!;
      request.mockImplementation(async (...args) => {
        const result = await implementation(...args);
        const path = args[1];
        if (
          (stage === 'create' && path.endsWith('/serviceAccounts')) ||
          (stage === 'policy' && path.endsWith(':setIamPolicy')) ||
          (stage === 'key' && path.endsWith('/keys'))
        )
          throw new GCPBootstrapError('Response lost');
        return result;
      });
      await expect(generateGCPCredentials(preview)).rejects.toThrow(
        'no uncertain mutation was retried',
      );
      expect(mutations().some(([, , method]) => method === 'DELETE')).toBe(
        false,
      );
      expect(
        mutations().filter(([, path]) => path.endsWith('/serviceAccounts')),
      ).toHaveLength(1);
      expect(
        mutations().filter(([, path]) => path.endsWith('/keys')),
      ).toHaveLength(stage === 'key' ? 1 : 0);
    },
  );

  it('ignores poisoned ambient identity and overrides identity properties in gcloud configuration', () => {
    const environment = gcpOperatorEnvironment({
      HOME: '/chosen/home',
      CLOUDSDK_CONFIG: '/chosen/config',
      CLOUDSDK_CORE_ACCOUNT: 'wrong@example.com',
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'secret-token',
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '/secret',
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/wrong/key',
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'wrong@example.com',
      GOOGLE_APPLICATION_CREDENTIALS: '/wrong/adc',
      GCP_PRIVATE_KEY: 'secret-key',
      CLOUDSDK_CORE_LOG_HTTP: 'true',
    });
    expect(environment).toMatchObject({
      HOME: '/chosen/home',
      CLOUDSDK_CONFIG: '/chosen/config',
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '',
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '',
      CLOUDSDK_CORE_LOG_HTTP: 'false',
      CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true',
    });
    expect(JSON.stringify(environment)).not.toMatch(/secret|wrong/);
  });

  it.each(['', 'a'.repeat(22), 'Uppercase', 'trailing-', 'slash/name'])(
    'rejects invalid name %j before mutation',
    (name) => {
      expect(() => validateGCPGenerationName(name)).toThrow(
        'GCP generation requires',
      );
      expect(mutations()).toEqual([]);
    },
  );
});
