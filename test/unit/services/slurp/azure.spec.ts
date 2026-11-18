import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getAzureCLIInstallCommand,
  getCurrentAzureSubscription,
  listAzureSubscriptions,
} from '../../../../src/cli/services/slurp/azure';
import {
  generateAzureServicePrincipal as generateAzureServicePrincipalWithTransport,
  type GenerateAzureServicePrincipalOptions,
} from '../../../../src/cli/services/credential-bootstrap/azure';
import type { AzureTransport } from '../../../../src/cli/services/credential-bootstrap/azure-transport';

vi.mock('../../../../src/cli/services/slurp/cli-exec', () => ({
  execAsync: vi.fn(),
  isCliInstalled: vi.fn(),
  spawnInteractive: vi.fn(),
}));

import { execAsync } from '../../../../src/cli/services/slurp/cli-exec';

const azureTransportMocks = {
  listDirectoryObjects: vi.fn<AzureTransport['listDirectoryObjects']>(),
  createDirectoryObject: vi.fn<AzureTransport['createDirectoryObject']>(),
  deleteDirectoryObject: vi.fn<AzureTransport['deleteDirectoryObject']>(),
  addApplicationPassword: vi.fn<AzureTransport['addApplicationPassword']>(),
  createRoleAssignment: vi.fn<AzureTransport['createRoleAssignment']>(),
  deleteRoleAssignment: vi.fn<AzureTransport['deleteRoleAssignment']>(),
  getSubscriptionTenant: vi.fn<AzureTransport['getSubscriptionTenant']>(),
} satisfies AzureTransport;

function generateAzureServicePrincipal(
  subscriptionId: string,
  name: string,
  options: Omit<GenerateAzureServicePrincipalOptions, 'transport'> = {},
) {
  return generateAzureServicePrincipalWithTransport(subscriptionId, name, {
    ...options,
    transport: azureTransportMocks,
  });
}

describe('Azure Slurp Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    azureTransportMocks.listDirectoryObjects.mockReset();
    azureTransportMocks.createDirectoryObject.mockReset();
    azureTransportMocks.deleteDirectoryObject.mockReset();
    azureTransportMocks.addApplicationPassword.mockReset();
    azureTransportMocks.createRoleAssignment.mockReset();
    azureTransportMocks.deleteRoleAssignment.mockReset();
    azureTransportMocks.getSubscriptionTenant.mockReset();
    delete process.env.AZURE_CONFIG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAzureCLIInstallCommand', () => {
    it.each([
      ['darwin', 'brew install azure-cli'],
      ['win32', 'winget install --exact --id Microsoft.AzureCLI'],
      [
        'linux',
        'https://learn.microsoft.com/cli/azure/install-azure-cli-linux (Linux packages need administrator rights)',
      ],
      ['freebsd', 'https://learn.microsoft.com/cli/azure/install-azure-cli'],
    ])('on %s prints a sudo-free hint: %s', (platform, expected) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        expect(getAzureCLIInstallCommand()).toBe(expected);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('Azure subscription discovery', () => {
    it('should return the active subscription from az account show', async () => {
      vi.mocked(execAsync).mockResolvedValue(
        JSON.stringify({
          id: 'sub-123',
          name: 'Production',
          tenantId: 'tenant-123',
          isDefault: true,
        }),
      );

      await expect(getCurrentAzureSubscription()).resolves.toEqual({
        id: 'sub-123',
        name: 'Production',
        tenantId: 'tenant-123',
        isDefault: true,
      });
    });

    it('should list subscriptions from az account list', async () => {
      vi.mocked(execAsync).mockResolvedValue(
        JSON.stringify([
          {
            id: 'sub-1',
            name: 'One',
            tenantId: 'tenant-1',
            isDefault: true,
          },
          {
            id: 'sub-2',
            name: 'Two',
            tenantId: 'tenant-2',
            isDefault: false,
          },
        ]),
      );

      await expect(listAzureSubscriptions()).resolves.toEqual([
        {
          id: 'sub-1',
          name: 'One',
          tenantId: 'tenant-1',
          isDefault: true,
        },
        {
          id: 'sub-2',
          name: 'Two',
          tenantId: 'tenant-2',
          isDefault: false,
        },
      ]);
    });
  });

  describe('generateAzureServicePrincipal', () => {
    it.each(['invalid\nname', 'x'.repeat(248)])(
      'rejects invalid generated name %s before calling Azure',
      async (name) => {
        await expect(
          generateAzureServicePrincipal('sub-123', name),
        ).rejects.toThrow(/Azure application/i);
        expect(azureTransportMocks.listDirectoryObjects).not.toHaveBeenCalled();
      },
    );

    function mockSuccessfulGeneration(
      overrides: {
        role?: (
          request: Parameters<AzureTransport['createRoleAssignment']>[0],
          attempt: number,
        ) => Promise<void> | void;
        account?: () => Promise<string> | string;
      } = {},
    ): void {
      let roleAttempt = 0;
      azureTransportMocks.listDirectoryObjects.mockResolvedValue([]);
      azureTransportMocks.createDirectoryObject.mockImplementation(
        async ({ kind, body }) => {
          if (kind === 'application') {
            return {
              id: 'app-object-123',
              appId: 'app-123',
              displayName: body.displayName as string,
              tags: body.tags as string[],
            };
          }
          return {
            id: 'sp-object-123',
            appId: 'app-123',
            displayName: 'anycloud-test',
            tags: body.tags as string[],
          };
        },
      );
      azureTransportMocks.addApplicationPassword.mockResolvedValue({
        secretText: 'secret-456',
        endDateTime: '2028-08-13T15:00:00Z',
      });
      azureTransportMocks.createRoleAssignment.mockImplementation(
        async (request) => {
          roleAttempt += 1;
          await overrides.role?.(request, roleAttempt);
        },
      );
      azureTransportMocks.getSubscriptionTenant.mockImplementation(
        async () => overrides.account?.() ?? 'tenant-789\n',
      );
      azureTransportMocks.deleteRoleAssignment.mockResolvedValue(undefined);
      azureTransportMocks.deleteDirectoryObject.mockResolvedValue(undefined);
    }

    it('creates tagged directory objects and a deterministic Contributor assignment', async () => {
      mockSuccessfulGeneration();

      const result = await generateAzureServicePrincipal('sub-123', 'test', {
        operationId: 'operation-123',
      });

      expect(result).toMatchObject({
        applicationId: 'app-123',
        secret: 'secret-456',
        secretExpiresAt: '2028-08-13T15:00:00Z',
        tenantId: 'tenant-789',
      });
      expect(result.cleanup).toEqual(expect.any(Function));
      expect(azureTransportMocks.createDirectoryObject).toHaveBeenNthCalledWith(
        1,
        {
          kind: 'application',
          body: {
            displayName: 'anycloud-test',
            signInAudience: 'AzureADMyOrg',
            tags: [
              'AnycloudManaged',
              'AnycloudCredentialName:test',
              'AnycloudOperation:operation-123',
            ],
          },
          subscriptionId: 'sub-123',
        },
      );
      expect(azureTransportMocks.createDirectoryObject).toHaveBeenNthCalledWith(
        2,
        {
          kind: 'servicePrincipal',
          body: {
            appId: 'app-123',
            tags: [
              'AnycloudManaged',
              'AnycloudCredentialName:test',
              'AnycloudOperation:operation-123',
            ],
          },
          subscriptionId: 'sub-123',
        },
      );
      const assignments = azureTransportMocks.createRoleAssignment.mock.calls;
      expect(assignments).toHaveLength(1);
      for (const [assignment] of assignments) {
        expect(assignment).toMatchObject({
          assignmentId: expect.any(String),
          principalObjectId: 'sp-object-123',
          scope: '/subscriptions/sub-123',
          subscriptionId: 'sub-123',
        });
      }
      expect(assignments.map(([assignment]) => assignment.roleId)).toEqual([
        'b24988ac-6180-42a0-ab88-20f7382dd24c',
      ]);
    });

    it('scopes every transport call to the target subscription', async () => {
      mockSuccessfulGeneration();

      const generated = await generateAzureServicePrincipal(
        'target-subscription',
        'test',
        {
          operationId: 'operation-123',
        },
      );
      await generated.cleanup?.();

      const requests = [
        ...azureTransportMocks.listDirectoryObjects.mock.calls,
        ...azureTransportMocks.createDirectoryObject.mock.calls,
        ...azureTransportMocks.deleteDirectoryObject.mock.calls,
        ...azureTransportMocks.addApplicationPassword.mock.calls,
        ...azureTransportMocks.createRoleAssignment.mock.calls,
        ...azureTransportMocks.deleteRoleAssignment.mock.calls,
      ];
      expect(requests.length).toBeGreaterThan(0);
      for (const [request] of requests) {
        expect(request.subscriptionId).toBe('target-subscription');
      }
      expect(azureTransportMocks.getSubscriptionTenant).toHaveBeenCalledWith(
        'target-subscription',
      );
    });

    it('rolls back exact assignments and directory object IDs after a required role fails', async () => {
      mockSuccessfulGeneration({
        role: () => {
          throw new Error('Role assignment failed');
        },
      });

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          roleAssignmentWaits: [],
        }),
      ).rejects.toThrow(/Role assignment failed/);

      expect(azureTransportMocks.deleteRoleAssignment).toHaveBeenCalledWith({
        assignmentResourceId: expect.stringMatching(
          /^\/subscriptions\/sub-123\/providers\/Microsoft\.Authorization\/roleAssignments\//,
        ),
        subscriptionId: 'sub-123',
      });
      expect(azureTransportMocks.deleteDirectoryObject.mock.calls).toEqual([
        [
          {
            kind: 'servicePrincipal',
            objectId: 'sp-object-123',
            subscriptionId: 'sub-123',
          },
        ],
        [
          {
            kind: 'application',
            objectId: 'app-object-123',
            subscriptionId: 'sub-123',
          },
        ],
      ]);
    });

    it('preserves directory objects and the original failure when role rollback is denied', async () => {
      const originalError = new Error(
        'AuthorizationFailed: Contributor grant denied',
      );
      mockSuccessfulGeneration({
        role: () => {
          throw originalError;
        },
      });
      azureTransportMocks.deleteRoleAssignment.mockRejectedValue(
        new Error('AuthorizationFailed while deleting assignment'),
      );

      const failure = await generateAzureServicePrincipal('sub-123', 'test', {
        operationId: 'operation-123',
        roleAssignmentWaits: [],
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        cause: originalError,
        message: expect.stringMatching(
          /Contributor grant denied.*Cleanup also failed.*AuthorizationFailed/,
        ),
      });
      expect(azureTransportMocks.deleteDirectoryObject).not.toHaveBeenCalled();
    });

    it('retains the application after principal deletion fails and permits idempotent retries', async () => {
      mockSuccessfulGeneration();
      const generated = await generateAzureServicePrincipal('sub-123', 'test');
      azureTransportMocks.deleteDirectoryObject.mockRejectedValueOnce(
        new Error('principal deletion denied'),
      );
      await expect(generated.cleanup!()).rejects.toThrow(
        'principal deletion denied',
      );
      expect(
        azureTransportMocks.deleteDirectoryObject.mock.calls.map(
          ([request]) => request.kind,
        ),
      ).toEqual(['servicePrincipal']);

      azureTransportMocks.deleteRoleAssignment.mockRejectedValue(
        new Error('RoleAssignmentNotFound'),
      );
      await expect(generated.cleanup!()).resolves.toBeUndefined();
      expect(
        azureTransportMocks.deleteDirectoryObject.mock.calls.map(
          ([request]) => request.kind,
        ),
      ).toEqual(['servicePrincipal', 'servicePrincipal', 'application']);
      azureTransportMocks.deleteDirectoryObject.mockRejectedValue(
        new Error('Request_ResourceNotFound'),
      );
      await expect(generated.cleanup!()).resolves.toBeUndefined();
    });

    it.each(['servicePrincipal', 'application'] as const)(
      'refuses a pre-existing %s with the same exact display name',
      async (kind) => {
        azureTransportMocks.listDirectoryObjects.mockImplementation(
          async (request) => {
            if (request.kind !== kind) return [];
            return [
              {
                id: 'existing-object',
                appId: 'existing-app',
                displayName: 'anycloud-test',
              },
            ];
          },
        );

        await expect(
          generateAzureServicePrincipal('sub-123', 'test'),
        ).rejects.toThrow('already exists');
        expect(
          azureTransportMocks.createDirectoryObject,
        ).not.toHaveBeenCalled();
      },
    );

    it('retries a transient principal propagation failure', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      mockSuccessfulGeneration({
        role: (_request, attempt) => {
          if (attempt === 1) {
            throw new Error('PrincipalNotFound: principal does not exist');
          }
        },
      });

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          roleAssignmentWaits: [1],
          wait,
        }),
      ).resolves.toMatchObject({ applicationId: 'app-123' });
      expect(wait).toHaveBeenCalledWith(1);
    });

    it('uses the directory propagation budget while application ownership propagates', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      let principalAttempts = 0;
      mockSuccessfulGeneration();
      const successfulImplementation =
        azureTransportMocks.createDirectoryObject.getMockImplementation()!;
      azureTransportMocks.createDirectoryObject.mockImplementation(
        async (request) => {
          if (request.kind !== 'servicePrincipal') {
            return successfulImplementation(request);
          }
          principalAttempts += 1;
          if (principalAttempts <= 4) {
            throw new Error(
              'Authorization_RequestDenied: Insufficient privileges',
            );
          }
          return successfulImplementation(request);
        },
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          reconciliationWaits: [],
          directoryPropagationWaits: [1, 2, 3, 4],
          wait,
        }),
      ).resolves.toMatchObject({ applicationId: 'app-123' });
      expect(principalAttempts).toBe(5);
      expect(wait.mock.calls).toEqual([[1], [2], [3], [4]]);
    });

    it.each([
      {
        failure:
          "Request_ResourceNotFound: Resource 'app-object-123' does not exist",
        scenario: 'the new application is not found',
      },
      {
        failure: 'Authorization_RequestDenied: Insufficient privileges',
        scenario: 'application ownership is not authorized yet',
      },
      {
        // Run 38191277600: Graph's addPassword answer for a just-created app.
        failure: 'Unable to read the company information from the directory.',
        scenario: 'the directory cannot read the new application yet',
      },
    ])('retries client secret creation when $scenario', async ({ failure }) => {
      const wait = vi.fn().mockResolvedValue(undefined);
      let addPasswordAttempts = 0;
      mockSuccessfulGeneration();
      const successfulImplementation =
        azureTransportMocks.addApplicationPassword.getMockImplementation()!;
      azureTransportMocks.addApplicationPassword.mockImplementation(
        async (request) => {
          addPasswordAttempts += 1;
          if (addPasswordAttempts === 1) {
            throw new Error(failure);
          }
          return successfulImplementation(request);
        },
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          directoryPropagationWaits: [1],
          wait,
        }),
      ).resolves.toMatchObject({
        applicationId: 'app-123',
        secret: 'secret-456',
      });
      expect(addPasswordAttempts).toBe(2);
      expect(wait).toHaveBeenCalledWith(1);
    });

    // Service principal creation retries propagation failures, so this fails
    // if the shared classifier, rather than addPassword alone, accepts it.
    it('does not retry the company-information failure outside client secret creation', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      mockSuccessfulGeneration();
      const successfulImplementation =
        azureTransportMocks.createDirectoryObject.getMockImplementation()!;
      azureTransportMocks.createDirectoryObject.mockImplementation(
        async (request) => {
          if (request.kind !== 'servicePrincipal')
            return successfulImplementation(request);
          throw new Error(
            'Unable to read the company information from the directory.',
          );
        },
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          reconciliationWaits: [],
          directoryPropagationWaits: [1],
          wait,
        }),
      ).rejects.toThrow(/creating the Entra service principal/);
      expect(
        azureTransportMocks.createDirectoryObject.mock.calls.filter(
          ([request]) => request.kind === 'servicePrincipal',
        ),
      ).toHaveLength(1);
      expect(wait).not.toHaveBeenCalled();
    });

    it('reports a persistent client secret permission failure after bounded retries', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      let addPasswordAttempts = 0;
      mockSuccessfulGeneration();
      azureTransportMocks.addApplicationPassword.mockImplementation(
        async () => {
          addPasswordAttempts += 1;
          throw new Error(
            'Authorization_RequestDenied: Insufficient privileges',
          );
        },
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          directoryPropagationWaits: [1, 2],
          wait,
        }),
      ).rejects.toThrow(
        /permission denied while creating the application client secret.*Application\.ReadWrite\.OwnedBy/i,
      );
      expect(addPasswordAttempts).toBe(3);
      expect(wait.mock.calls).toEqual([[1], [2]]);
      expect(azureTransportMocks.deleteDirectoryObject).toHaveBeenCalledWith({
        kind: 'application',
        objectId: 'app-object-123',
        subscriptionId: 'sub-123',
      });
    });

    it.each([
      ['owned', '', false],
      ['conflicting operation', 'AnycloudOperation:other', false],
      ['conflicting credential name', 'AnycloudCredentialName:other', false],
      ['duplicate managed marker', 'AnycloudManaged', false],
      ['exact-name lookalike', '', true],
    ] as const)(
      'reconciles only an unambiguous owned application (%s)',
      async (scenario, extraTag, lookalike) => {
        let applicationListCalls = 0;
        mockSuccessfulGeneration();
        const successfulList =
          azureTransportMocks.listDirectoryObjects.getMockImplementation()!;
        azureTransportMocks.listDirectoryObjects.mockImplementation(
          async (request) => {
            if (request.kind !== 'application') {
              return successfulList(request);
            }
            applicationListCalls += 1;
            if (applicationListCalls === 1) return [];
            const owned = {
              id: 'app-object-123',
              appId: 'app-123',
              displayName: 'anycloud-test',
              tags: [
                'AnycloudManaged',
                'AnycloudCredentialName:test',
                'AnycloudOperation:operation-123',
                ...(extraTag ? [extraTag] : []),
              ],
            };
            return lookalike
              ? [
                  owned,
                  {
                    ...owned,
                    id: 'unrelated-object',
                    appId: 'unrelated-app',
                    tags: [],
                  },
                ]
              : [owned];
          },
        );
        const successfulCreate =
          azureTransportMocks.createDirectoryObject.getMockImplementation()!;
        azureTransportMocks.createDirectoryObject.mockImplementation(
          async (request) => {
            if (request.kind !== 'application') {
              return successfulCreate(request);
            }
            throw new Error('connection reset after request');
          },
        );

        const generation = generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          reconciliationWaits: [],
        });
        if (scenario === 'owned') {
          await expect(generation).resolves.toMatchObject({
            applicationId: 'app-123',
          });
        } else {
          await expect(generation).rejects.toThrow(
            /ownership markers do not match|multiple applications/,
          );
          expect(
            azureTransportMocks.deleteDirectoryObject,
          ).not.toHaveBeenCalled();
        }
      },
    );

    it('uses structured ambiguity even when the transport message is opaque', async () => {
      let applicationListCalls = 0;
      mockSuccessfulGeneration();
      const successfulList =
        azureTransportMocks.listDirectoryObjects.getMockImplementation()!;
      azureTransportMocks.listDirectoryObjects.mockImplementation(
        async (request, options) => {
          if (request.kind !== 'application') {
            return successfulList(request, options);
          }
          applicationListCalls += 1;
          if (applicationListCalls === 1) return [];
          return [
            {
              id: 'app-object-123',
              appId: 'app-123',
              displayName: 'anycloud-test',
              tags: [
                'AnycloudManaged',
                'AnycloudCredentialName:test',
                'AnycloudOperation:operation-123',
              ],
            },
          ];
        },
      );
      const successfulCreate =
        azureTransportMocks.createDirectoryObject.getMockImplementation()!;
      azureTransportMocks.createDirectoryObject.mockImplementation(
        async (request, options) => {
          if (request.kind !== 'application') {
            return successfulCreate(request, options);
          }
          throw Object.assign(new Error('opaque transport failure'), {
            mayHaveSucceeded: true,
          });
        },
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
          reconciliationWaits: [],
        }),
      ).resolves.toMatchObject({ applicationId: 'app-123' });
    });

    it('does not pass an aborted foreground signal into rollback', async () => {
      const controller = new AbortController();
      const abortError = Object.assign(
        new Error('Azure CLI command was canceled.'),
        {
          aborted: true,
          mayHaveSucceeded: true,
        },
      );
      azureTransportMocks.listDirectoryObjects.mockImplementation(
        async ({ kind }, options) => {
          if (options?.signal?.aborted) throw abortError;
          if (kind === 'servicePrincipal') return [];
          if (!options) {
            return [
              {
                id: 'canceled-app-object',
                appId: 'canceled-app-id',
                displayName: 'anycloud-test',
                tags: [
                  'AnycloudManaged',
                  'AnycloudCredentialName:test',
                  'AnycloudOperation:canceled-operation',
                ],
              },
            ];
          }
          return [];
        },
      );
      azureTransportMocks.createDirectoryObject.mockImplementation(
        async (_request, options) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort();
          throw abortError;
        },
      );
      azureTransportMocks.deleteDirectoryObject.mockResolvedValue(undefined);

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          signal: controller.signal,
          operationId: 'canceled-operation',
          reconciliationWaits: [],
        }),
      ).rejects.toThrow('Azure CLI command was canceled');

      expect(azureTransportMocks.deleteDirectoryObject.mock.calls).toEqual([
        [
          {
            kind: 'application',
            objectId: 'canceled-app-object',
            subscriptionId: 'sub-123',
          },
        ],
      ]);
    });

    it('rolls back an application that becomes visible only after ambiguous-create reconciliation', async () => {
      let applicationListCalls = 0;
      azureTransportMocks.listDirectoryObjects.mockImplementation(
        async ({ kind }) => {
          if (kind === 'servicePrincipal') return [];
          applicationListCalls += 1;
          if (applicationListCalls <= 2) return [];
          return [
            {
              id: 'late-app-object',
              appId: 'late-app-id',
              displayName: 'anycloud-test',
              tags: [
                'AnycloudManaged',
                'AnycloudCredentialName:test',
                'AnycloudOperation:late-operation',
              ],
            },
          ];
        },
      );
      azureTransportMocks.createDirectoryObject.mockImplementation(
        async ({ kind }) => {
          if (kind === 'application') {
            throw new Error('connection reset after request');
          }
          return {};
        },
      );
      azureTransportMocks.deleteDirectoryObject.mockResolvedValue(undefined);

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'late-operation',
          reconciliationWaits: [],
        }),
      ).rejects.toThrow('connection reset after request');
      expect(azureTransportMocks.deleteDirectoryObject).toHaveBeenCalledWith({
        kind: 'application',
        objectId: 'late-app-object',
        subscriptionId: 'sub-123',
      });
    });

    it('reports the permission family and failing stage', async () => {
      azureTransportMocks.listDirectoryObjects.mockResolvedValue([]);
      azureTransportMocks.createDirectoryObject.mockRejectedValue(
        new Error('Authorization_RequestDenied: Insufficient privileges'),
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          reconciliationWaits: [],
        }),
      ).rejects.toThrow(
        /permission denied while creating the Entra application.*Application\.ReadWrite\.OwnedBy/i,
      );
    });

    it('reports a non-existent subscription after rolling back the identity', async () => {
      mockSuccessfulGeneration({
        account: () => {
          throw new Error('SubscriptionNotFound: subscription does not exist');
        },
      });

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          operationId: 'operation-123',
        }),
      ).rejects.toThrow('Subscription sub-123 not found');
      expect(azureTransportMocks.deleteDirectoryObject).toHaveBeenCalledWith({
        kind: 'application',
        objectId: 'app-object-123',
        subscriptionId: 'sub-123',
      });
    });

    it('preserves the exact stage for other failures', async () => {
      azureTransportMocks.listDirectoryObjects.mockResolvedValue([]);
      azureTransportMocks.createDirectoryObject.mockRejectedValue(
        new Error('Network error'),
      );

      await expect(
        generateAzureServicePrincipal('sub-123', 'test', {
          reconciliationWaits: [],
        }),
      ).rejects.toThrow(
        /Failed while creating the Entra application: Network error/,
      );
    });
  });
});
