import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '../../../../src/cli/services/credential-bootstrap/azure-cli-runner',
  () => ({
    AzureCliCommandError: class AzureCliCommandError extends Error {
      readonly code?: string;
      readonly mayHaveSucceeded: boolean;

      constructor(
        message: string,
        details: { code?: string; mayHaveSucceeded?: boolean } = {},
      ) {
        super(message);
        this.name = 'AzureCliCommandError';
        this.code = details.code;
        this.mayHaveSucceeded = details.mayHaveSucceeded ?? false;
      }
    },
    runAzureCli: vi.fn(),
  }),
);
vi.mock('../../../../src/cli/services/slurp/cli-exec', () => ({
  execAsync: vi.fn(() => {
    throw new Error('Azure generation must not use the legacy shell runner.');
  }),
}));

import { runAzureCli } from '../../../../src/cli/services/credential-bootstrap/azure-cli-runner';
import { azureCliTransport } from '../../../../src/cli/services/credential-bootstrap/azure-transport';

describe('Azure CLI credential generation transport', () => {
  beforeEach(() => {
    vi.mocked(runAzureCli).mockReset();
  });

  it('executes directory-object operations with exact argument arrays', async () => {
    vi.mocked(runAzureCli)
      .mockResolvedValueOnce('[]')
      .mockResolvedValueOnce('[]')
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'app-object-123',
          appId: 'app-123',
          displayName: 'anycloud-test',
          tags: ['AnycloudManaged'],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'sp-object-123',
          appId: 'app-123',
          tags: ['AnycloudManaged'],
        }),
      )
      .mockResolvedValue('');

    await expect(
      azureCliTransport.listDirectoryObjects({
        kind: 'application',
        displayName: 'anycloud-test',
        subscriptionId: 'sub-123',
      }),
    ).resolves.toEqual([]);
    await azureCliTransport.listDirectoryObjects({
      kind: 'servicePrincipal',
      displayName: 'anycloud-test',
      subscriptionId: 'sub-123',
    });
    await expect(
      azureCliTransport.createDirectoryObject({
        kind: 'application',
        body: {
          displayName: 'anycloud-test',
          signInAudience: 'AzureADMyOrg',
          tags: ['AnycloudManaged'],
        },
        subscriptionId: 'sub-123',
      }),
    ).resolves.toMatchObject({ id: 'app-object-123', appId: 'app-123' });
    await azureCliTransport.createDirectoryObject({
      kind: 'servicePrincipal',
      body: { appId: 'app-123', tags: ['AnycloudManaged'] },
      subscriptionId: 'sub-123',
    });
    await azureCliTransport.deleteDirectoryObject({
      kind: 'servicePrincipal',
      objectId: 'sp-object-123',
      subscriptionId: 'sub-123',
    });
    await azureCliTransport.deleteDirectoryObject({
      kind: 'application',
      objectId: 'app-object-123',
      subscriptionId: 'sub-123',
    });

    expect(vi.mocked(runAzureCli).mock.calls).toEqual([
      [
        [
          'rest',
          '--method',
          'GET',
          '--url',
          "https://graph.microsoft.com/v1.0/applications?$filter=displayName%20eq%20'anycloud-test'&$select=id,appId,displayName,tags",
          '--subscription',
          'sub-123',
          '--query',
          'value',
          '--output',
          'json',
          '--only-show-errors',
        ],
      ],
      [
        [
          'rest',
          '--method',
          'GET',
          '--url',
          "https://graph.microsoft.com/v1.0/servicePrincipals?$filter=displayName%20eq%20'anycloud-test'&$select=id,appId,displayName,tags",
          '--subscription',
          'sub-123',
          '--query',
          'value',
          '--output',
          'json',
          '--only-show-errors',
        ],
      ],
      [
        [
          'rest',
          '--method',
          'POST',
          '--url',
          'https://graph.microsoft.com/v1.0/applications',
          '--body',
          '{"displayName":"anycloud-test","signInAudience":"AzureADMyOrg","tags":["AnycloudManaged"]}',
          '--subscription',
          'sub-123',
          '--output',
          'json',
          '--only-show-errors',
        ],
      ],
      [
        [
          'rest',
          '--method',
          'POST',
          '--url',
          'https://graph.microsoft.com/v1.0/servicePrincipals',
          '--body',
          '{"appId":"app-123","tags":["AnycloudManaged"]}',
          '--subscription',
          'sub-123',
          '--output',
          'json',
          '--only-show-errors',
        ],
      ],
      [
        [
          'rest',
          '--method',
          'DELETE',
          '--url',
          'https://graph.microsoft.com/v1.0/servicePrincipals/sp-object-123',
          '--subscription',
          'sub-123',
          '--output',
          'none',
          '--only-show-errors',
        ],
      ],
      [
        [
          'rest',
          '--method',
          'DELETE',
          '--url',
          'https://graph.microsoft.com/v1.0/applications/app-object-123',
          '--subscription',
          'sub-123',
          '--output',
          'none',
          '--only-show-errors',
        ],
      ],
    ]);
  });

  it('executes password, role, and tenant operations with exact argument arrays', async () => {
    const controller = new AbortController();
    vi.mocked(runAzureCli)
      .mockResolvedValueOnce(
        JSON.stringify({
          secretText: 'generated-secret',
          endDateTime: '2028-08-13T15:00:00Z',
        }),
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('"tenant-123"');

    await expect(
      azureCliTransport.addApplicationPassword(
        {
          applicationObjectId: 'app-object-123',
          body: {
            passwordCredential: {
              displayName: 'Anycloud generated credential operation-123',
            },
          },
          subscriptionId: 'sub-123',
        },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({
      secretText: 'generated-secret',
      endDateTime: '2028-08-13T15:00:00Z',
    });
    await azureCliTransport.createRoleAssignment({
      assignmentId: 'assignment-123',
      principalObjectId: 'sp-object-123',
      roleId: 'role-123',
      scope: '/subscriptions/sub-123',
      subscriptionId: 'sub-123',
    });
    await azureCliTransport.deleteRoleAssignment({
      assignmentResourceId:
        '/subscriptions/sub-123/providers/Microsoft.Authorization/roleAssignments/assignment-123',
      subscriptionId: 'sub-123',
    });
    await expect(
      azureCliTransport.getSubscriptionTenant('sub-123'),
    ).resolves.toBe('tenant-123');

    expect(vi.mocked(runAzureCli).mock.calls).toEqual([
      [
        [
          'rest',
          '--method',
          'POST',
          '--url',
          'https://graph.microsoft.com/v1.0/applications/app-object-123/addPassword',
          '--body',
          '{"passwordCredential":{"displayName":"Anycloud generated credential operation-123"}}',
          '--subscription',
          'sub-123',
          '--output',
          'json',
          '--only-show-errors',
        ],
        { signal: controller.signal },
      ],
      [
        [
          'role',
          'assignment',
          'create',
          '--name',
          'assignment-123',
          '--assignee-object-id',
          'sp-object-123',
          '--assignee-principal-type',
          'ServicePrincipal',
          '--role',
          'role-123',
          '--scope',
          '/subscriptions/sub-123',
          '--subscription',
          'sub-123',
          '--output',
          'none',
          '--only-show-errors',
        ],
      ],
      [
        [
          'role',
          'assignment',
          'delete',
          '--ids',
          '/subscriptions/sub-123/providers/Microsoft.Authorization/roleAssignments/assignment-123',
          '--subscription',
          'sub-123',
          '--output',
          'none',
          '--only-show-errors',
        ],
      ],
      [
        [
          'account',
          'show',
          '--subscription',
          'sub-123',
          '--query',
          'tenantId',
          '--output',
          'json',
          '--only-show-errors',
        ],
      ],
    ]);
  });

  it.each([
    {
      label: 'directory-object list',
      invoke: () =>
        azureCliTransport.listDirectoryObjects({
          kind: 'application' as const,
          displayName: 'anycloud-test',
          subscriptionId: 'sub-123',
        }),
      output: '{"marker":"directory-list-sensitive-marker"}',
      marker: 'directory-list-sensitive-marker',
      mayHaveSucceeded: false,
    },
    {
      label: 'created directory object',
      invoke: () =>
        azureCliTransport.createDirectoryObject({
          kind: 'application' as const,
          body: { displayName: 'anycloud-test' },
          subscriptionId: 'sub-123',
        }),
      output:
        '{"id":"app-object-123","appId":42,"marker":"create-sensitive-marker"}',
      marker: 'create-sensitive-marker',
      mayHaveSucceeded: true,
    },
    {
      label: 'generated application password',
      invoke: () =>
        azureCliTransport.addApplicationPassword({
          applicationObjectId: 'app-object-123',
          body: { passwordCredential: {} },
          subscriptionId: 'sub-123',
        }),
      output: '{"secretText":42,"marker":"password-sensitive-marker"}',
      marker: 'password-sensitive-marker',
      mayHaveSucceeded: true,
    },
    {
      label: 'subscription tenant',
      invoke: () => azureCliTransport.getSubscriptionTenant('sub-123'),
      output: '{"marker":"tenant-sensitive-marker"}',
      marker: 'tenant-sensitive-marker',
      mayHaveSucceeded: false,
    },
  ])(
    'rejects invalid $label output without echoing provider data',
    async ({ invoke, output, marker, mayHaveSucceeded }) => {
      vi.mocked(runAzureCli).mockResolvedValue(output);

      const error = await invoke().catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'AZURE_CLI_INVALID_OUTPUT',
        mayHaveSucceeded,
      });
      expect((error as Error).message).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
    },
  );
});
