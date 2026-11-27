import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  onTestFinished,
} from 'vitest';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { AZURE_AUTHORIZATION_FAILED } from '../../../integration/credentials-onboarding/personas.js';
import {
  createHttpHeaders,
  createPipelineRequest,
  RestError,
} from '@azure/core-rest-pipeline';
import { log } from '../../../../src/api/services/logger.js';
import {
  BucketAccessDeniedError,
  BucketNotFoundError,
  BucketThrottledError,
  ObjectNotFoundError,
} from '../../../../src/shared/errors.js';
import {
  BucketCredentialNotReadyError,
  throughBucketStorage,
} from '../../../../src/api/services/bucket-storage-operation.js';
import { fakeSdkClient } from '../../helpers/sdk-client';
import { generateKeyPairSync } from 'crypto';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { StorageManagementClient } from '@azure/arm-storage';
import { ClientSecretCredential } from '@azure/identity';
import type { VirtualMachine } from '@azure/arm-compute';
import {
  Azure,
  isAzureAuthorizationPropagationError,
  isAzureNotFound,
  isAzureTerminalAuthError,
  resetAzurePreflightSweeps,
  resetAzureStorageAccountCacheForTests,
} from '../../../../src/api/services/gateways/azure';
import {
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  CandidateRegionAvailability,
  canFilterCandidateRegions,
  canListBuckets,
  canListObjects,
  canManageCloudResources,
  type CandidateRegion,
} from '../../../../src/api/services/gateways/cloud.js';
import { FailureDisposition } from '../../../../src/api/services/provisioning-failure.js';
import { resolveProvisioningFailureDisposition } from '../../../../src/api/services/provisioning-failure';
import {
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
} from '../../../../src/shared/cloud.js';
import { GpuRuntime } from '../../../../src/shared/cloud';
import {
  AZURE_CUDA_COMMUNITY_IMAGE_ID,
  AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
  AZURE_GRID_COMMUNITY_IMAGE_ID,
} from '../../../../src/shared/catalog/azure-gpu-map';
import {
  buildJobIngressSpec,
  buildServeIngressSpec,
} from '../../../../src/api/services/network';
import { resetStorageCoordinatorForTests } from '../../../../src/api/services/gateways/storage-coordinator';
import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
} from '../../../../src/shared/cloudflare-ips';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../../../helpers/resource-sweep-policy';
import { installationSweepPolicy } from '../../../../src/api/services/gateways/resource-sweeper';
import { hostedApiIdentity } from '../../../../src/shared/hosted-api-identity.js';
import { makeNewVMProps, requirePreemptible } from '../../helpers/fixtures';

const {
  ensureProviderRegisteredMock,
  getInsufficientQuotaRegionsMock,
  catalogOverlayReadMock,
  catalogOverlayRefreshMock,
  catalogOverlayInvalidateMock,
} = vi.hoisted(() => ({
  ensureProviderRegisteredMock: vi.fn(),
  getInsufficientQuotaRegionsMock: vi.fn(),
  catalogOverlayReadMock: vi.fn(),
  catalogOverlayRefreshMock: vi.fn(),
  catalogOverlayInvalidateMock: vi.fn(),
}));

function sweepAzureResources(azure: Azure, dryRun = false) {
  return azure.sweeper().sweepResources({
    ...TEST_RESOURCE_SWEEP_OPTIONS,
    dryRun,
  });
}

function sweepAzureStorage(azure: Azure, dryRun = false) {
  return azure.sweeper().sweepStorage!({
    ...TEST_RESOURCE_SWEEP_OPTIONS,
    dryRun,
  });
}

const insufficientQuotaResult = (
  regions: string[],
  complete = true,
  unknownRegions: string[] = [],
) => ({
  insufficientRegions: new Set(regions),
  unknownRegions: new Set(unknownRegions),
  complete,
});

function filterCandidateRegions(
  provider: Azure,
  candidates: CandidateRegion[],
  spot: boolean,
  workloadId: string,
): Promise<CandidateRegion[]> {
  const compute = provider.compute();
  if (!canFilterCandidateRegions(compute)) {
    throw new Error(
      'Azure compute provider did not expose candidate filtering',
    );
  }
  return compute.filterCandidateRegions(candidates, spot, workloadId);
}

const { vmArchitecture } = vi.hoisted(() => ({ vmArchitecture: vi.fn() }));
vi.mock('../../../../src/shared/cloud-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/shared/cloud-config.js')
    >();
  vmArchitecture.mockImplementation(actual.vmArchitecture);
  return { ...actual, vmArchitecture };
});

// Mock the logger
vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/api/services/quota/azure', () => ({
  AzureQuotaProvider: vi.fn().mockImplementation(function () {
    return {
      ensureProviderRegistered: ensureProviderRegisteredMock,
      getInsufficientQuotaRegions: getInsufficientQuotaRegionsMock,
    };
  }),
}));

vi.mock('../../../../src/api/services/catalog-overlays/azure', () => ({
  createAzureCatalogOverlayProvider: vi.fn().mockImplementation(() => ({
    cloud: 'Azure',
    read: catalogOverlayReadMock,
    refresh: catalogOverlayRefreshMock,
    invalidate: catalogOverlayInvalidateMock,
  })),
}));

// Mock Azure SDK clients
vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: vi.fn(),
}));

beforeEach(() => {
  resetStorageCoordinatorForTests();
  resetAzureStorageAccountCacheForTests();
  catalogOverlayReadMock.mockReset();
  catalogOverlayRefreshMock.mockReset();
  catalogOverlayInvalidateMock.mockReset();
  catalogOverlayRefreshMock.mockResolvedValue(undefined);
});

// Storage, resource-provider and identity setup all go through these
// clients; a VM needs none of them (RFC 0047), so any use fails the test.
const untouched: string[] = [];
const untouchable = (client: string) =>
  new Proxy(
    {},
    {
      get: (_target, key) => {
        untouched.push(`${client}.${String(key)}`);
        throw new Error(`newVM used the ${client} client (${String(key)})`);
      },
    },
  ) as never;

/** A VM's provisioning stubs: regional setup only, nothing else. */
function stubVmOnlySetup(azure: Azure): void {
  vi.spyOn(azure as any, 'ensureRegionalInfrastructure').mockResolvedValue(
    undefined,
  );
  azure.storageClient = untouchable('storage');
  (azure as any).resourcesClient = untouchable('resources');
}

function stubComputeClient(
  azure: Azure,
  vmGet: ReturnType<typeof vi.fn>,
): void {
  const stub = { virtualMachines: { get: vmGet } };
  azure.computeClient = fakeSdkClient(
    stub as unknown as typeof azure.computeClient,
  );
}

vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: vi.fn(),
}));

vi.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: vi.fn().mockImplementation(function () {
    return {
      resourceGroups: {
        get: vi.fn().mockResolvedValue({}),
        createOrUpdate: vi.fn().mockResolvedValue({}),
      },
      providers: {
        get: vi.fn().mockResolvedValue({ registrationState: 'Registered' }),
        register: vi.fn().mockResolvedValue({}),
      },
    };
  }),
}));

vi.mock('@azure/arm-storage', () => ({
  StorageManagementClient: vi.fn(),
  StorageAccount: vi.fn(),
}));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: vi.fn(),
  StorageSharedKeyCredential: vi.fn(),
}));

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: vi.fn(),
}));

describe('stored credential API boundary', () => {
  it('binds stored service-principal fields when the API host has different Azure credentials', () => {
    const credentialConstructor = vi.mocked(ClientSecretCredential);
    credentialConstructor.mockClear();
    vi.stubEnv('AZURE_CLIENT_ID', 'ambient-client');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'ambient-secret');
    vi.stubEnv('AZURE_TENANT_ID', 'ambient-tenant');
    try {
      const azure = new Azure(
        completeCloudConfig({
          cloudProvider: CloudType.Azure,
          region: 'eastus2',
          vmType: 'Standard_B1s',
          credentials: {
            subscriptionId: 'stored-subscription',
            directoryId: 'stored-directory',
            applicationId: 'stored-application',
            secret: 'stored-secret',
          },
        }),
      );

      (azure as any).initializeClients();

      expect(credentialConstructor).toHaveBeenCalledWith(
        'stored-directory',
        'stored-application',
        'stored-secret',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('finds scope-tagged VMs across the subscription, deallocated ones included', async () => {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus2',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'secret',
        },
      }),
    );
    (azure as any).initializeClients();
    const stub = {
      virtualMachines: {
        listAll: async function* () {
          yield {
            name: 'anycloud-cluster-c1',
            id: '/subscriptions/s/resourceGroups/anycloud-westus/providers/Microsoft.Compute/virtualMachines/anycloud-cluster-c1',
            tags: { anycloud_resource: 'anycloud-cluster-c1' },
          };
          yield {
            name: 'anycloud-cluster-c1-b',
            tags: { anycloud_resource: 'anycloud-cluster-c1' },
          };
          yield { name: 'other', tags: { anycloud_resource: 'other' } };
          yield { name: 'untagged' };
        },
        get: vi.fn(async (_group: string, name: string) => ({
          instanceView: {
            statuses: [
              { code: 'ProvisioningState/succeeded' },
              {
                code:
                  name === 'anycloud-cluster-c1'
                    ? 'PowerState/deallocated'
                    : 'PowerState/running',
              },
            ],
          },
        })),
      },
    };
    azure.computeClient = fakeSdkClient(
      stub as unknown as typeof azure.computeClient,
    );
    const compute = azure.compute();
    if (!canManageCloudResources(compute)) throw new Error('not scoped');
    await expect(
      compute.listResourceVMs!({
        id: 'anycloud-cluster-c1',
        tags: { anycloud_cluster: 'c1' },
      }),
    ).resolves.toEqual([
      { id: 'anycloud-cluster-c1', stopped: true },
      { id: 'anycloud-cluster-c1-b', stopped: false },
    ]);
    // The power state is read from each VM's own resource group.
    expect(stub.virtualMachines.get).toHaveBeenCalledWith(
      'anycloud-westus',
      'anycloud-cluster-c1',
      { expand: 'instanceView' },
    );
  });

  it('offers bounded compute recovery only for propagation-shaped failures', () => {
    const compute = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus2',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'stored-subscription',
          directoryId: 'stored-directory',
          applicationId: 'stored-application',
          secret: 'stored-secret',
        },
      }),
    ).compute();
    const policy = compute.credentialValidationRetryPolicy;

    expect(policy).toMatchObject({
      maxAttempts: 9,
      waitMs: 500,
      maxWaitMs: 8_000,
    });
    expect(
      policy?.shouldRetry(
        new Error('AADSTS7000215: Invalid client secret provided.'),
      ),
    ).toBe(true);
    expect(
      policy?.shouldRetry({
        code: 'AuthorizationFailed',
        statusCode: 403,
      }),
    ).toBe(true);
    expect(
      policy?.shouldRetry(
        new Error('AADSTS7000222: The provided client secret is expired.'),
      ),
    ).toBe(false);
    expect(
      policy?.shouldRetry(
        Object.assign(new Error('policy denied'), {
          code: 'Forbidden',
          statusCode: 403,
        }),
      ),
    ).toBe(false);
  });
});

describe('isAzureNotFound', () => {
  it('should return true for 404 status code', () => {
    const error = { statusCode: 404 };
    expect(isAzureNotFound(error)).toBe(true);
  });

  it('should return true for ResourceNotFound error code', () => {
    const error = { code: 'ResourceNotFound' };
    expect(isAzureNotFound(error)).toBe(true);
  });

  it('should return true for ResourceGroupNotFound error code', () => {
    const error = { code: 'ResourceGroupNotFound' };
    expect(isAzureNotFound(error)).toBe(true);
  });

  it('should return false for other errors', () => {
    const error = { statusCode: 500, code: 'InternalError' };
    expect(isAzureNotFound(error)).toBe(false);
  });

  it('should return false for 400 status code', () => {
    const error = { statusCode: 400, code: 'BadRequest' };
    expect(isAzureNotFound(error)).toBe(false);
  });
});

describe('isAzureTerminalAuthError', () => {
  it.each([
    {
      name: 'AuthorizationFailed code',
      error: { code: 'AuthorizationFailed' },
    },
    {
      name: 'AuthorizationPermissionMismatch code',
      error: { code: 'AuthorizationPermissionMismatch', statusCode: 403 },
    },
    {
      name: 'rotated/expired client secret message',
      error: {
        name: 'RestError',
        message: 'AADSTS7000215: Invalid client secret provided.',
      },
    },
    {
      name: 'invalid_client message',
      error: new Error('invalid_client returned from token endpoint'),
    },
    {
      name: 'AuthorizationPermissionMismatch in rclone exec message',
      error: new Error(
        'Command exited with code 1: AuthorizationPermissionMismatch (example-outputs/.rclone-keep)',
      ),
    },
  ])('treats $name as terminal', ({ error }) => {
    expect(isAzureTerminalAuthError(error)).toBe(true);
  });

  it.each([
    { name: 'not-found', error: { statusCode: 404 } },
    { name: 'transient throttle', error: { code: 'TooManyRequests' } },
    { name: 'capacity', error: { code: 'AllocationFailed' } },
    { name: 'null', error: null },
    { name: 'string', error: 'boom' },
  ])('does not treat $name as terminal', ({ error }) => {
    expect(isAzureTerminalAuthError(error)).toBe(false);
  });
});

describe('isAzureAuthorizationPropagationError', () => {
  it('matches Azure ARM AuthorizationFailed responses', () => {
    expect(
      isAzureAuthorizationPropagationError({
        code: 'AuthorizationFailed',
        statusCode: 403,
        message:
          "The client 'app' does not have authorization to perform action 'Microsoft.Storage/storageAccounts/read'.",
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: 'generic forbidden response',
      error: { code: 'Forbidden', statusCode: 403, message: 'Forbidden' },
    },
    {
      name: 'bad client secret',
      error: {
        statusCode: 401,
        message: 'AADSTS7000215: Invalid client secret provided.',
      },
    },
    {
      name: 'missing blob data-plane permission',
      error: {
        code: 'AuthorizationPermissionMismatch',
        statusCode: 403,
      },
    },
  ])('does not match a $name', ({ error }) => {
    expect(isAzureAuthorizationPropagationError(error)).toBe(false);
  });
});

describe('Azure.newVM cleanup behavior', () => {
  // Note: Full integration testing of the cleanup behavior requires real Azure credentials.
  // These tests verify the expected behavior through isAzureNotFound which is used
  // by deleteWithRetry during cleanup.

  it('isAzureNotFound should handle cleanup scenarios correctly', () => {
    // During cleanup, if resource already deleted (404), treat as success
    expect(isAzureNotFound({ statusCode: 404 })).toBe(true);
    expect(isAzureNotFound({ code: 'ResourceNotFound' })).toBe(true);

    // Other errors are not "not found" (they will be retried by withRetry)
    expect(isAzureNotFound({ code: 'NicReservedForAnotherVm' })).toBe(false);
    expect(isAzureNotFound({ code: 'QuotaExceeded' })).toBe(false);
  });

  // Tag helpers must short-circuit on 404. Without this, retroactively
  // unflipping `ended_at` on thousands of old failed-attempt placeholder rows
  // (whose Azure resources are already long gone) makes each tag .get() throw
  // and the raw withRetry chain burns 5 retries × 2s linear backoff per dead
  // resource, exhausting the container's ephemeral socket budget before any
  // terminateStep can complete (storm reproduced 2026-05-21 on prod).
  describe.each([
    {
      name: 'tagVMForDeletion',
      method: 'tagVMForDeletion',
      stub: (azure: Azure) => {
        const get = vi.fn().mockRejectedValue({ code: 'ResourceNotFound' });
        const beginUpdate = vi.fn();
        azure.computeClient = fakeSdkClient({
          virtualMachines: { get, beginUpdate },
        });
        return { get, write: beginUpdate };
      },
    },
    {
      name: 'tagNICForDeletion',
      method: 'tagNICForDeletion',
      stub: (azure: Azure) => {
        const get = vi.fn().mockRejectedValue({ statusCode: 404 });
        const updateTags = vi.fn();
        azure.networkClient = fakeSdkClient({
          networkInterfaces: { get, updateTags },
        });
        return { get, write: updateTags };
      },
    },
    {
      name: 'tagPublicIPForDeletion',
      method: 'tagPublicIPForDeletion',
      stub: (azure: Azure) => {
        const get = vi.fn().mockRejectedValue({ code: 'ResourceNotFound' });
        const updateTags = vi.fn();
        azure.networkClient = fakeSdkClient({
          publicIPAddresses: { get, updateTags },
        });
        return { get, write: updateTags };
      },
    },
    {
      name: 'tagVNetForDeletion',
      method: 'tagVNetForDeletion',
      stub: (azure: Azure) => {
        const get = vi.fn().mockRejectedValue({ code: 'ResourceNotFound' });
        const updateTags = vi.fn();
        azure.networkClient = fakeSdkClient({
          virtualNetworks: { get, updateTags },
        });
        return { get, write: updateTags };
      },
    },
    {
      name: 'tagNSGForDeletion',
      method: 'tagNSGForDeletion',
      stub: (azure: Azure) => {
        const get = vi.fn().mockRejectedValue({ statusCode: 404 });
        const updateTags = vi.fn();
        azure.networkClient = fakeSdkClient({
          networkSecurityGroups: { get, updateTags },
        });
        return { get, write: updateTags };
      },
    },
  ])('$name 404 fast-path', ({ method, stub }) => {
    it('returns immediately without retrying or writing', async () => {
      const azure = new Azure(
        completeCloudConfig({
          cloudProvider: CloudType.Azure,
          region: 'eastus',
          vmType: 'Standard_B1s',
          credentials: {
            subscriptionId: 'sub',
            directoryId: 'dir',
            applicationId: 'app',
            secret: 'sec',
          },
        }),
      );
      const { get, write } = stub(azure);

      await (azure as any)[method]('resource-already-gone');

      // .get() called exactly once — no withRetry attempts after 404
      expect(get).toHaveBeenCalledTimes(1);
      // The actual tag write must not run when the resource is gone
      expect(write).not.toHaveBeenCalled();
    });
  });

  it('terminateVMs caps concurrent terminate fan-out', async () => {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'sec',
        },
      }),
    );
    azure.computeClient = fakeSdkClient({});

    let inflight = 0;
    let peak = 0;
    const tally = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
    };
    vi.spyOn(azure as any, 'terminateVM').mockImplementation(tally);
    vi.spyOn(azure as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const vmIds = Array.from({ length: 100 }, (_, i) => `vm-${i}`);
    await azure.compute().terminateVMs(vmIds);

    // AZURE_TERMINATE_CONCURRENCY is 20 — keep this in sync if the constant moves.
    expect(peak).toBeLessThanOrEqual(20);
    // Sanity: the cap is actually saturated for a 100-item batch.
    expect(peak).toBeGreaterThanOrEqual(15);
  });

  it('terminateVMs returns only the subset whose full sub-delete chain succeeded', async () => {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'sec',
        },
      }),
    );
    // Skip Azure SDK init — every internal call is stubbed below.
    azure.computeClient = fakeSdkClient({});

    // Tagging is best-effort (catches internally); stub to no-op.
    vi.spyOn(azure as any, 'tagVMForDeletion').mockResolvedValue(undefined);
    vi.spyOn(azure as any, 'tagNICForDeletion').mockResolvedValue(undefined);

    // Stub per-VM helper so we drive which IDs succeed without exercising
    // deleteWithRetry's full timer chain. A throw means at least one of the
    // four sub-deletes (VM/disk/NIC/IP) failed — that vmId must be omitted
    // from the returned set so cleanup reconciliation will retry it.
    vi.spyOn(azure as any, 'terminateVM').mockImplementation(
      async (vmId: unknown) => {
        if (vmId === 'vm-nic-stuck')
          throw new Error('Nic in request is reserved for another VM');
      },
    );
    vi.spyOn(azure as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const deleted = await azure
      .compute()
      .terminateVMs(['vm-ok-1', 'vm-nic-stuck', 'vm-ok-2']);

    expect(deleted).toEqual(['vm-ok-1', 'vm-ok-2']);
  });

  it('tags NICs before VM deletion so partial failures remain sweepable', async () => {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'sec',
        },
      }),
    );
    azure.computeClient = fakeSdkClient({});

    const getVirtualMachine = vi
      .spyOn(azure as any, 'getVirtualMachine')
      .mockResolvedValue({});
    const tagVMForDeletion = vi
      .spyOn(azure as any, 'tagVMForDeletion')
      .mockResolvedValue(undefined);
    const tagNICForDeletion = vi
      .spyOn(azure as any, 'tagNICForDeletion')
      .mockResolvedValue(undefined);
    const deleteVirtualMachine = vi
      .spyOn(azure as any, 'deleteVirtualMachine')
      .mockRejectedValue({ code: 'AuthorizationFailed' });
    vi.spyOn(azure as any, 'shutDownGuest').mockResolvedValue(undefined);
    const deleteNICAndPublicIP = vi.spyOn(azure as any, 'deleteNICAndPublicIP');

    await expect((azure as any).terminateVM('vm-stuck')).rejects.toMatchObject({
      code: 'AuthorizationFailed',
    });

    expect(getVirtualMachine).toHaveBeenCalledWith('vm-stuck');
    expect(tagVMForDeletion).toHaveBeenCalledWith('vm-stuck');
    expect(tagNICForDeletion).toHaveBeenCalledWith('vm-stuck');
    expect(deleteVirtualMachine).toHaveBeenCalledOnce();
    expect(deleteNICAndPublicIP).not.toHaveBeenCalled();
    const deleteOrder = deleteVirtualMachine.mock.invocationCallOrder[0]!;
    expect(tagVMForDeletion.mock.invocationCallOrder[0]!).toBeLessThan(
      deleteOrder,
    );
    expect(tagNICForDeletion.mock.invocationCallOrder[0]!).toBeLessThan(
      deleteOrder,
    );
  });
});

describe('Azure VM termination', () => {
  function terminate(
    vmRead: Promise<unknown>,
    diskError?: unknown,
    powerOff: () => Promise<unknown> = async () => undefined,
  ) {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'sec',
        },
      }),
    );
    const order: string[] = [];
    const beginPowerOff = vi.fn(async () => ({
      pollUntilDone: async () => {
        order.push('power-off');
        await powerOff();
      },
    }));
    azure.computeClient = fakeSdkClient({
      virtualMachines: { get: vi.fn().mockReturnValue(vmRead), beginPowerOff },
    });
    vi.spyOn(azure as any, 'tagVMForDeletion').mockResolvedValue(undefined);
    vi.spyOn(azure as any, 'tagNICForDeletion').mockResolvedValue(undefined);
    vi.spyOn(azure as any, 'deleteVirtualMachine').mockImplementation(
      async () => order.push('vm'),
    );
    vi.spyOn(azure as any, 'deleteDisk').mockImplementation(async (name) => {
      order.push(`disk ${String(name)}`);
      if (diskError) throw diskError;
    });
    vi.spyOn(azure as any, 'deleteNICAndPublicIP').mockImplementation(
      async () => order.push('network'),
    );
    return {
      order,
      beginPowerOff,
      resourceGroup: azure.resourceGroup,
      result: azure['terminateVM']('vm-owned'),
    };
  }
  const vm = Promise.resolve({
    storageProfile: { osDisk: { name: 'vm-owned_OsDisk_1_0123abcd' } },
  });

  // A new VM's disk goes with it (deleteOption: Delete), so the explicit
  // delete finds nothing; a pre-upgrade VM detaches it, so the delete removes it.
  it.each([
    ['deleted with its VM', { statusCode: 404 }],
    ['detached by a pre-upgrade VM', undefined],
  ])(
    'deletes the VM, then its OS disk %s, then its network',
    async (_case, diskError) => {
      const { order, result } = terminate(vm, diskError);
      await result;
      expect(order).toEqual([
        'power-off',
        'vm',
        'disk vm-owned_OsDisk_1_0123abcd',
        'network',
      ]);
    },
  );

  // Azure's delete skips the guest shutdown that stops containers on AWS and GCP.
  it('shuts the guest down before deleting the VM', async () => {
    const { beginPowerOff, resourceGroup, result } = terminate(vm);
    await result;
    expect(beginPowerOff).toHaveBeenCalledWith(resourceGroup, 'vm-owned', {
      skipShutdown: false,
    });
  });

  it('deletes no disk and shuts nothing down when the VM is already gone', async () => {
    const { order, beginPowerOff, result } = terminate(
      Promise.reject({ statusCode: 404 }),
    );
    await result;
    expect(order).toEqual(['vm', 'network']);
    expect(beginPowerOff).not.toHaveBeenCalled();
  });

  it.each([
    ['vanishes', { statusCode: 404 }, false],
    ['conflicts with a deallocated VM', { statusCode: 409 }, false],
    ['is forbidden', { statusCode: 403, code: 'AuthorizationFailed' }, true],
  ])('deletes the VM when its power-off %s', async (_case, error, warns) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { order, result } = terminate(vm, { statusCode: 404 }, async () => {
      throw error;
    });
    await result;
    expect(order).toEqual([
      'power-off',
      'vm',
      'disk vm-owned_OsDisk_1_0123abcd',
      'network',
    ]);
    const reported = warn.mock.calls.filter(
      ([, context]) => (context as { error?: unknown })?.error === error,
    );
    expect(reported).toHaveLength(warns ? 1 : 0);
  });

  it('deletes the VM when the guest does not stop within 30 s', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { order, result } = terminate(
      vm,
      { statusCode: 404 },
      () => new Promise(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(order).toEqual(['power-off']);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(order).toEqual([
      'power-off',
      'vm',
      'disk vm-owned_OsDisk_1_0123abcd',
      'network',
    ]);
  });

  it('logs the orphaned disk when its delete fails after the VM is gone', async () => {
    const error = { statusCode: 403, code: 'AuthorizationFailed' };
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { order, result } = terminate(vm, error);
    await expect(result).rejects.toBe(error);
    expect(order).toEqual([
      'power-off',
      'vm',
      'disk vm-owned_OsDisk_1_0123abcd',
    ]);
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ diskName: 'vm-owned_OsDisk_1_0123abcd' }),
    );
  });

  it('deletes the VM when tagging it never finishes', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: 'sub',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'sec',
        },
      }),
    );
    // Azure holds the tag PATCH behind a create that never finishes.
    const beginUpdate = vi.fn().mockResolvedValue({
      pollUntilDone: () => new Promise(() => undefined),
    });
    azure.computeClient = fakeSdkClient({
      virtualMachines: { get: vi.fn().mockResolvedValue({}), beginUpdate },
    });
    vi.spyOn(azure as any, 'shutDownGuest').mockResolvedValue(undefined);
    vi.spyOn(azure as any, 'tagNICForDeletion').mockResolvedValue(undefined);
    const deleteVirtualMachine = vi
      .spyOn(azure as any, 'deleteVirtualMachine')
      .mockResolvedValue(undefined);
    vi.spyOn(azure as any, 'deleteNICAndPublicIP').mockResolvedValue(undefined);

    const result = azure['terminateVM']('vm-stuck');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(beginUpdate).toHaveBeenCalledOnce();
    expect(deleteVirtualMachine).toHaveBeenCalledWith('vm-stuck');
    await result;
  });
});

describe('Azure network security groups', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus2',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  it("gives every public-SSH Job the region's shared NSG", async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const shared = { id: '/test/shared-nsg', name: 'anycloud-shared-vm' };
    const get = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValue(shared);
    const beginCreateOrUpdate = vi
      .fn()
      .mockResolvedValue({ pollUntilDone: vi.fn().mockResolvedValue(shared) });
    azure.networkClient = fakeSdkClient({
      networkSecurityGroups: { get, beginCreateOrUpdate },
    });

    for (const job of ['job-1', 'job-2']) {
      await expect(
        azure.upsertNetworkSecurityGroup(
          [],
          job,
          '0.0.0-test',
          'test-user',
          buildJobIngressSpec(),
        ),
      ).resolves.toBe(shared);
    }

    expect(get).toHaveBeenCalledWith('anycloud-eastus2', 'anycloud-shared-vm');
    // Made once, without the ownership tags teardown and the sweep delete by.
    expect(beginCreateOrUpdate).toHaveBeenCalledTimes(1);
    expect(beginCreateOrUpdate).toHaveBeenCalledWith(
      'anycloud-eastus2',
      'anycloud-shared-vm',
      expect.objectContaining({ tags: { anycloud_managed: 'shared' } }),
    );
  });

  it('creates NSG rules for server SSH and Cloudflare HTTP ingress', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const pollUntilDone = vi.fn().mockResolvedValue({ id: '/test/nsg' });
    const beginCreateOrUpdate = vi.fn().mockResolvedValue({ pollUntilDone });
    azure.networkClient = fakeSdkClient({
      networkSecurityGroups: {
        get: vi.fn().mockRejectedValue({ statusCode: 404 }),
        beginCreateOrUpdate,
      },
    });

    await azure.upsertNetworkSecurityGroup(
      [],
      'server-1',
      '0.0.0-test',
      'test-user',
      buildServeIngressSpec(['10.0.0.0/8']),
    );

    expect(beginCreateOrUpdate).toHaveBeenCalledWith(
      'anycloud-eastus2',
      'server-1',
      expect.objectContaining({
        location: 'eastus2',
        securityRules: [
          {
            description: 'Allow SSH inbound traffic',
            protocol: 'Tcp',
            sourcePortRange: '*',
            destinationPortRange: '22',
            sourceAddressPrefix: '10.0.0.0/8',
            destinationAddressPrefix: '*',
            access: 'Allow',
            priority: 101,
            direction: 'Inbound',
            name: 'Allow22InBound',
          },
          {
            description: 'Allow HTTP inbound traffic',
            protocol: 'Tcp',
            sourcePortRange: '*',
            destinationPortRange: '80',
            sourceAddressPrefixes: [...CLOUDFLARE_IPV4_RANGES],
            destinationAddressPrefix: '*',
            access: 'Allow',
            priority: 102,
            direction: 'Inbound',
            name: 'Allow80InBound',
          },
          {
            description: 'Allow HTTP inbound traffic',
            protocol: 'Tcp',
            sourcePortRange: '*',
            destinationPortRange: '80',
            sourceAddressPrefixes: [...CLOUDFLARE_IPV6_RANGES],
            destinationAddressPrefix: '*',
            access: 'Allow',
            priority: 103,
            direction: 'Inbound',
            name: 'Allow80InBoundIpv6',
          },
        ],
      }),
    );
    expect(pollUntilDone).toHaveBeenCalled();
  });

  it('maps a scoped ingress-free spec to an NSG with no allow rules', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const nsgPoll = vi.fn().mockResolvedValue({ id: '/test/nsg' });
    const vnetPoll = vi.fn().mockResolvedValue({ id: '/test/vnet' });
    const nsgCreate = vi.fn().mockResolvedValue({ pollUntilDone: nsgPoll });
    azure.networkClient = fakeSdkClient({
      networkSecurityGroups: {
        get: vi.fn().mockRejectedValue({ statusCode: 404 }),
        beginCreateOrUpdate: nsgCreate,
      },
      virtualNetworks: {
        get: vi.fn().mockRejectedValue({ statusCode: 404 }),
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vnetPoll,
        }),
      },
      subnets: { get: vi.fn().mockResolvedValue({}) },
    });
    const compute = azure.compute();
    expect(canManageCloudResources(compute)).toBe(true);
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await compute.prepareResourceNetwork(
      { ingress: [], denyPublicIngress: true },
      { id: 'scope-a', tags: { anycloud_user: 'owner-1' } },
      'test-version',
    );

    const params = nsgCreate.mock.calls[0]?.[2];
    expect(params.tags).toMatchObject({ anycloud_resource: 'scope-a' });
    // The NSG substrate is default-deny, so an empty rule list is Azure
    // "no public ingress".
    expect(params.securityRules).toEqual([]);
  });

  it('deletes orphan NICs and public IPs of the scope before the NSG', async () => {
    // A pool VM deleted outside terminateVM (host loss) leaves its NIC and
    // public IP; the NSG delete fails while the NIC still references it.
    const azure = new Azure(completeCloudConfig(mockConfig));
    const nics = [
      { name: 'scope-a-vm-lost', tags: { anycloud_resource: 'scope-a' } },
      { name: 'scope-b-vm-0', tags: { anycloud_resource: 'scope-b' } },
      { name: 'scope-a-untagged' },
    ];
    const ips = [
      // Its NIC already gone: terminateVM failed after deleting the NIC.
      { name: 'scope-a-vm-half', tags: { anycloud_resource: 'scope-a' } },
      { name: 'scope-b-vm-0', tags: { anycloud_resource: 'scope-b' } },
    ];
    azure.networkClient = fakeSdkClient({
      networkInterfaces: {
        list: vi.fn(async function* () {
          yield* nics;
        }),
      },
      publicIPAddresses: {
        list: vi.fn(async function* () {
          yield* ips;
        }),
      },
    });
    const deleteIp = vi
      .spyOn(azure as any, 'deletePublicIP')
      .mockResolvedValue(undefined);
    const deleteNic = vi
      .spyOn(azure as any, 'deleteNICAndPublicIP')
      .mockResolvedValue(undefined);
    const terminateNetworking = vi
      .spyOn(azure as any, 'terminateNetworking')
      .mockResolvedValue(undefined);
    const compute = azure.compute();
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await compute.terminateResourceNetwork({
      id: 'scope-a',
      tags: { anycloud_user: 'owner-1' },
    });

    expect(deleteNic.mock.calls).toEqual([['scope-a-vm-lost']]);
    expect(deleteIp.mock.calls).toEqual([['scope-a-vm-half']]);
    expect(terminateNetworking).toHaveBeenCalledWith('scope-a');
    expect(deleteNic.mock.invocationCallOrder[0]!).toBeLessThan(
      terminateNetworking.mock.invocationCallOrder[0]!,
    );

    // A second pass with nothing left, or a group already gone, still
    // tears the network down.
    nics.splice(0);
    ips.splice(0);
    await compute.terminateResourceNetwork({ id: 'scope-a', tags: {} });
    azure.networkClient = fakeSdkClient({
      networkInterfaces: {
        list: vi.fn(async function* () {
          yield* [];
          throw { code: 'ResourceGroupNotFound' };
        }),
      },
      publicIPAddresses: {
        list: vi.fn(async function* () {
          yield* [];
          throw { code: 'ResourceGroupNotFound' };
        }),
      },
    });
    await compute.terminateResourceNetwork({ id: 'scope-a', tags: {} });
    expect(deleteNic).toHaveBeenCalledOnce();
    expect(deleteIp).toHaveBeenCalledOnce();
    expect(terminateNetworking).toHaveBeenCalledTimes(3);

    // A scope VM gone outside terminateVM: Azure deleted its NIC with it,
    // so only the public IP is still there to delete.
    deleteNic.mockRestore();
    deleteIp.mockClear();
    const steps: string[] = [];
    vi.spyOn(azure as any, 'tagNICForDeletion').mockResolvedValue(undefined);
    vi.spyOn(azure as any, 'tagPublicIPForDeletion').mockResolvedValue(
      undefined,
    );
    vi.spyOn(azure as any, 'deleteNetworkInterfaces').mockImplementation(
      async (name) => {
        steps.push(`nic ${String(name)}`);
        throw { statusCode: 404, code: 'NotFound' };
      },
    );
    deleteIp.mockImplementation(async (name) => {
      steps.push(`ip ${String(name)}`);
    });
    await compute.terminateResourceVMLeftovers!('scope-a-vm-evicted');
    expect(steps).toEqual(['nic scope-a-vm-evicted', 'ip scope-a-vm-evicted']);
  });

  it('creates a scope VM against the prepared NSG without adding public SSH', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const scope = { id: 'scope-a', tags: { anycloud_user: 'owner-1' } };
    const ingressSpec = { ingress: [], denyPublicIngress: true };
    // Serve the NSG that prepareResourceNetwork actually wrote, so the VM-time
    // upsert sees the same rule set a real second reconcile pass would.
    let preparedNsg:
      | { id: string; securityRules?: { name?: string }[] }
      | undefined;
    const nsgCreate = vi.fn().mockImplementation((_group, _name, params) => {
      preparedNsg = { id: '/test/nsg', ...params };
      return { pollUntilDone: vi.fn().mockResolvedValue(preparedNsg) };
    });
    azure.networkClient = fakeSdkClient({
      networkSecurityGroups: {
        get: vi.fn().mockImplementation(async () => {
          if (!preparedNsg) throw { statusCode: 404 };
          return preparedNsg;
        }),
        beginCreateOrUpdate: nsgCreate,
      },
      virtualNetworks: {
        get: vi.fn().mockResolvedValue({ id: '/test/vnet' }),
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({ id: '/test/vnet' }),
        }),
      },
      subnets: { get: vi.fn().mockResolvedValue({ id: '/test/subnet' }) },
      publicIPAddresses: {
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({ id: '/test/ip' }),
        }),
        get: vi.fn().mockResolvedValue({ ipAddress: '1.2.3.4' }),
      },
      networkInterfaces: {
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({
            id: '/test/nic',
            ipConfigurations: [{ privateIPAddress: '10.0.0.1' }],
          }),
        }),
      },
    });
    azure.computeClient = fakeSdkClient({
      virtualMachines: {
        beginCreateOrUpdate: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({
          instanceView: { statuses: [{ code: 'PowerState/running' }] },
        }),
      },
      virtualMachineImages: {
        list: vi
          .fn()
          .mockImplementation(async () => [{ name: '22.04.202501010' }]),
      },
    });
    stubVmOnlySetup(azure);
    const compute = azure.compute();
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    const network = await compute.prepareResourceNetwork(
      ingressSpec,
      scope,
      'test-version',
    );
    expect(nsgCreate).toHaveBeenCalledTimes(1);

    await compute.newResourceVM({
      scope,
      vmId: 'scope-a-vm-0',
      ipWhitelist: [],
      startupScript: '#!/bin/sh\ntrue',
      gpuRuntime: null,
      version: 'test-version',
      network,
      ingressSpec,
    });

    // The prepared NSG already carries the scope's whole ingress intent, so VM
    // creation must not rewrite it. Re-deriving the default job spec here
    // would append Allow22InBound from 0.0.0.0/0, and the scope VM would gain
    // the public SSH its prepared, rule-free NSG deliberately excludes.
    expect(nsgCreate).toHaveBeenCalledTimes(1);
    expect(preparedNsg?.securityRules).toEqual([]);
  });
});

describe('Azure.findStorageAccount', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus2',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  it('should find storage account by direct lookup', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const expectedStorageAccountName = 'anycloud12345678';

    const mockAccount = {
      name: expectedStorageAccountName,
      id: `/subscriptions/sub/resourceGroups/anycloud-storage/providers/Microsoft.Storage/storageAccounts/${expectedStorageAccountName}`,
    };

    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: async () => mockAccount,
      },
    });

    const result = await azure.findStorageAccount();

    expect(result).not.toBeNull();
    expect(result?.resourceGroup).toBe('anycloud-storage');
    expect(result?.account.name).toBe(expectedStorageAccountName);
  });

  it('should return null when storage account not found (404)', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));

    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: async () => {
          const error: any = new Error('Not found');
          error.statusCode = 404;
          throw error;
        },
      },
    });

    const result = await azure.findStorageAccount();

    expect(result).toBeNull();
  });

  it('should return null when storage account not found (ResourceNotFound)', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));

    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: async () => {
          const error: any = new Error('Not found');
          error.code = 'ResourceNotFound';
          throw error;
        },
      },
    });

    const result = await azure.findStorageAccount();

    expect(result).toBeNull();
  });

  it('should return null when the storage resource group is absent', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));

    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: async () => {
          throw Object.assign(new Error('Resource group not found'), {
            code: 'ResourceGroupNotFound',
          });
        },
      },
    });

    await expect(azure.findStorageAccount()).resolves.toBeNull();
  });

  it('should rethrow unexpected errors', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));

    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: async () => {
          throw new Error('Network timeout');
        },
      },
    });

    await expect(azure.findStorageAccount()).rejects.toThrow('Network timeout');
  });
});

describe('Azure bucket listing', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    credentials: {
      subscriptionId: '11111111-2222-3333-4444-555555555555',
      directoryId: 'tenant',
      applicationId: 'app',
      secret: 'secret',
    },
  };
  const storageInfo = {
    resourceGroup: 'anycloud-storage',
    account: { id: 'storage-account-id', location: 'eastus2' },
  };

  function pageablePage(value: unknown) {
    const next = vi.fn().mockResolvedValue({ done: false, value });
    const byPage = vi.fn().mockReturnValue({ next });
    return { byPage, next };
  }

  function authorizationFailed(): Error {
    return Object.assign(
      new Error(
        "The client 'app' with object id 'object' does not have authorization " +
          "to perform action 'Microsoft.Storage/storageAccounts/read' over " +
          "scope '/subscriptions/sub/resourceGroups/anycloud-storage'.",
      ),
      { code: 'AuthorizationFailed', statusCode: 403 },
    );
  }

  function stubInitializedClients(azure: Azure): void {
    azure.computeClient = fakeSdkClient({});
    azure.networkClient = fakeSdkClient({});
    azure.storageClient = fakeSdkClient({});
    (azure as any).resourcesClient = fakeSdkClient({});
  }

  it('returns an empty bucket page without creating missing infrastructure', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({});
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(null);
    vi.mocked(BlobServiceClient).mockClear();
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    await expect(storage.listBuckets({ pageSize: 1000 })).resolves.toEqual({
      buckets: [],
      nextCursor: null,
    });
    expect(BlobServiceClient).not.toHaveBeenCalled();
  });

  it('checks container existence with a freshly listed account key', async () => {
    vi.mocked(StorageSharedKeyCredential).mockClear();
    const azure = new Azure(completeCloudConfig(mockConfig));
    const listKeys = vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] });
    azure.storageClient = fakeSdkClient({ storageAccounts: { listKeys } });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    const exists = vi.fn().mockResolvedValue(true);
    const blobServiceClient = {
      getContainerClient: vi.fn().mockReturnValue({ exists }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });

    await expect(azure.storage().hasBucket('models')).resolves.toBe(true);

    expect(exists).toHaveBeenCalledOnce();
    expect(listKeys).toHaveBeenCalledWith(
      'anycloud-storage',
      'anycloud11111111',
    );
    expect(StorageSharedKeyCredential).toHaveBeenCalledWith(
      'anycloud11111111',
      'key-1',
    );
  });

  it('reads the storage account and its key once per credential across instances', async () => {
    const getProperties = vi.fn().mockResolvedValue(storageInfo.account);
    const listKeys = vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] });
    const exists = vi.fn().mockResolvedValue(true);
    const blobServiceClient = { getContainerClient: () => ({ exists }) };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    // The API builds a gateway for every bucket request.
    const burst = async (prefix: string, secret = 'secret') => {
      const azure = new Azure(
        completeCloudConfig({
          ...mockConfig,
          credentials: { ...mockConfig.credentials, secret },
        }),
      );
      azure.storageClient = fakeSdkClient({
        storageAccounts: { getProperties, listKeys },
      });
      const storage = azure.storage();
      await Promise.all(
        ['a', 'b', 'c', 'd'].map((n) => storage.hasBucket(`${prefix}-${n}`)),
      );
      await storage.hasBucket(`${prefix}-e`);
    };

    await burst('first');
    expect(exists).toHaveBeenCalledTimes(5);
    expect(getProperties).toHaveBeenCalledOnce();
    expect(listKeys).toHaveBeenCalledOnce();

    await burst('second');
    expect(exists).toHaveBeenCalledTimes(10);
    expect(getProperties).toHaveBeenCalledOnce();
    expect(listKeys).toHaveBeenCalledOnce();

    // A wrong secret for the same application proves nothing.
    await burst('other', 'other-secret');
    expect(getProperties).toHaveBeenCalledTimes(2);
    expect(listKeys).toHaveBeenCalledTimes(2);
  });

  it('logs each Storage resource provider 429 the SDK retries', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    const azure = new Azure(completeCloudConfig(mockConfig));
    const { additionalPolicies } = (azure as any).storageClientOptions();
    const { policy, position } = additionalPolicies.find(
      ({ policy }: { policy: { name: string } }) =>
        policy.name === 'anycloudStorageRpThrottleLog',
    );
    const request = createPipelineRequest({
      url: 'https://management.azure.com/subscriptions/s/listKeys',
      method: 'POST',
    });
    const respond = (status: number) => async () => ({
      status,
      request,
      headers: createHttpHeaders({ 'retry-after': '17' }),
    });

    await policy.sendRequest(request, respond(200));
    expect(warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'AZURE_STORAGE_RP_THROTTLED' }),
    );
    await policy.sendRequest(request, respond(429));

    expect(position).toBe('perRetry');
    expect(warn).toHaveBeenCalledWith(
      'Azure Storage resource provider throttled a request for storage account anycloud11111111',
      {
        code: 'AZURE_STORAGE_RP_THROTTLED',
        retryAfterMs: 17000,
      },
    );
  });

  it.each([
    ['AuthenticationFailed', 'hasBucket'],
    ['AuthenticationFailed', 'uploadObject'],
  ] as const)(
    'lists the key again after the data plane rejects it with %s (%s)',
    async (code, operation) => {
      vi.mocked(StorageSharedKeyCredential).mockClear();
      const azure = new Azure(completeCloudConfig(mockConfig));
      const getProperties = vi.fn().mockResolvedValue(storageInfo.account);
      const listKeys = vi
        .fn()
        .mockResolvedValueOnce({ keys: [{ value: 'key-1' }] })
        .mockResolvedValue({ keys: [{ value: 'key-2' }] });
      azure.storageClient = fakeSdkClient({
        storageAccounts: { getProperties, listKeys },
      });
      vi.spyOn(azure as any, 'ensureStorageInfrastructure').mockResolvedValue(
        undefined,
      );
      const call = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('Server failed to authenticate'), {
            statusCode: 403,
            code,
          }),
        )
        .mockResolvedValue(true);
      const blobServiceClient = {
        getContainerClient: () => ({
          exists: call,
          getBlockBlobClient: () => ({ uploadStream: call }),
        }),
      };
      vi.mocked(BlobServiceClient).mockImplementation(function () {
        return blobServiceClient as never;
      });
      const storage = azure.storage();
      const run = (bucket: string) =>
        operation === 'hasBucket'
          ? storage.hasBucket(bucket)
          : storage.uploadObject(bucket, 'backup.db', {
              kind: 'buffer',
              bytes: Buffer.from('x'),
              contentLength: 1,
            });

      await expect(run(`rotated-${operation}-a`)).rejects.toMatchObject({
        code,
      });
      await run(`rotated-${operation}-b`);

      expect(call).toHaveBeenCalledTimes(2);
      expect(listKeys).toHaveBeenCalledTimes(2);
      expect(StorageSharedKeyCredential).toHaveBeenLastCalledWith(
        'anycloud11111111',
        'key-2',
      );
    },
  );

  it('reads the account again and reports a disabled shared key after KeyBasedAuthenticationNotPermitted', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const getProperties = vi
      .fn()
      .mockResolvedValueOnce(storageInfo.account)
      .mockResolvedValue({
        ...storageInfo.account,
        allowSharedKeyAccess: false,
      });
    const listKeys = vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] });
    azure.storageClient = fakeSdkClient({
      storageAccounts: { getProperties, listKeys },
    });
    const exists = vi.fn().mockRejectedValue(
      Object.assign(new Error('Key based authentication is not permitted'), {
        statusCode: 403,
        code: 'KeyBasedAuthenticationNotPermitted',
      }),
    );
    const blobServiceClient = { getContainerClient: () => ({ exists }) };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const storage = azure.storage();

    await expect(storage.hasBucket('disabled-a')).rejects.toMatchObject({
      code: 'KeyBasedAuthenticationNotPermitted',
    });
    await expect(storage.hasBucket('disabled-b')).rejects.toMatchObject({
      code: 'AZURE_SHARED_KEY_DISABLED',
    });

    expect(getProperties).toHaveBeenCalledTimes(2);
    expect(listKeys).toHaveBeenCalledOnce();
    expect(exists).toHaveBeenCalledOnce();
  });

  it('reads the storage account and its key again once the cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const azure = new Azure(completeCloudConfig(mockConfig));
      const getProperties = vi.fn().mockResolvedValue(storageInfo.account);
      const listKeys = vi
        .fn()
        .mockResolvedValue({ keys: [{ value: 'key-1' }] });
      azure.storageClient = fakeSdkClient({
        storageAccounts: { getProperties, listKeys },
      });
      const exists = vi.fn().mockResolvedValue(true);
      const blobServiceClient = { getContainerClient: () => ({ exists }) };
      vi.mocked(BlobServiceClient).mockImplementation(function () {
        return blobServiceClient as never;
      });
      const storage = azure.storage();

      await storage.hasBucket('ttl-a');
      vi.advanceTimersByTime(14 * 60_000);
      await storage.hasBucket('ttl-b');
      expect(getProperties).toHaveBeenCalledOnce();
      expect(listKeys).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(2 * 60_000);
      await storage.hasBucket('ttl-c');
      expect(getProperties).toHaveBeenCalledTimes(2);
      expect(listKeys).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a missing storage account again on the next lookup', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const getProperties = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 }),
      )
      .mockResolvedValue(storageInfo.account);
    azure.storageClient = fakeSdkClient({ storageAccounts: { getProperties } });

    await expect(azure.findStorageAccount()).resolves.toBeNull();
    await expect(azure.findStorageAccount()).resolves.toMatchObject({
      account: storageInfo.account,
    });
    await azure.findStorageAccount();
    expect(getProperties).toHaveBeenCalledTimes(2);
  });

  it('lists containers through shared-key paging and maps nullable metadata', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const listKeys = vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] });
    azure.storageClient = fakeSdkClient({ storageAccounts: { listKeys } });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    const page = pageablePage({
      containerItems: [
        {
          name: 'models',
          metadata: { anycloud_created_at: '1735689600000' },
        },
        {
          name: 'customer-data',
          metadata: { anycloud_created_at: 'invalid' },
        },
      ],
      continuationToken: 'bucket-page-2',
    });
    const listContainers = vi.fn().mockReturnValue(page);
    const blobServiceClient = { listContainers };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    await expect(
      storage.listBuckets({ pageSize: 60, cursor: 'bucket-page-1' }),
    ).resolves.toEqual({
      buckets: [
        {
          name: 'models',
          region: 'eastus2',
          createdAt: 1735689600000,
        },
        { name: 'customer-data', region: 'eastus2', createdAt: null },
      ],
      nextCursor: 'bucket-page-2',
    });
    expect(listContainers).toHaveBeenCalledWith({ includeMetadata: true });
    expect(page.byPage).toHaveBeenCalledWith({
      continuationToken: 'bucket-page-1',
      maxPageSize: 60,
    });
    expect(listKeys).toHaveBeenCalledWith(
      'anycloud-storage',
      'anycloud11111111',
    );
    expect(StorageSharedKeyCredential).toHaveBeenCalledWith(
      'anycloud11111111',
      'key-1',
    );
  });

  it('reports how to enable Shared Key before a container request', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const listKeys = vi.fn();
    azure.storageClient = fakeSdkClient({ storageAccounts: { listKeys } });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue({
      ...storageInfo,
      account: { ...storageInfo.account, allowSharedKeyAccess: false },
    });

    await expect(azure.storage().hasBucket('models')).rejects.toMatchObject({
      code: 'AZURE_SHARED_KEY_DISABLED',
      message: expect.stringMatching(
        /requires Shared Key.*Allow storage account key access/i,
      ),
    });
    expect(listKeys).not.toHaveBeenCalled();
  });

  it('enables Shared Key when creating the managed storage account', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const beginCreateAndWait = vi.fn().mockResolvedValue({});
    azure.storageClient = fakeSdkClient({
      storageAccounts: { beginCreateAndWait },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(null);
    vi.spyOn(azure as any, 'ensureStorageResourceGroup').mockResolvedValue(
      undefined,
    );

    await (azure as any).ensureStorageAccount();

    expect(beginCreateAndWait).toHaveBeenCalledWith(
      'anycloud-storage',
      'anycloud11111111',
      expect.objectContaining({ allowSharedKeyAccess: true }),
    );
  });

  it('deletes a checkpoint container with all its blob versions', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    // Deleting the container removes every blob and blob version in it.
    const deleteContainer = vi.fn().mockResolvedValue(undefined);
    const containerClient = {
      exists: vi.fn(async () => deleteContainer.mock.calls.length === 0),
      getProperties: vi.fn().mockResolvedValue({ metadata: {} }),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      delete: deleteContainer,
    };
    const getContainerClient = vi.fn().mockReturnValue(containerClient);
    const blobServiceClient = { getContainerClient };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });

    await azure.storage().deleteBucket('ckpt-bucket');

    expect(getContainerClient).toHaveBeenCalledWith('ckpt-bucket');
    expect(deleteContainer).toHaveBeenCalledOnce();
    // The propagation wait probes again after the delete.
    expect(
      containerClient.exists.mock.invocationCallOrder.at(-1),
    ).toBeGreaterThan(deleteContainer.mock.invocationCallOrder[0]);
  });

  it('uses hierarchy prefixes by default and flat object pages recursively', async () => {
    const modified = new Date('2025-05-06T07:08:09Z');
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    const hierarchyPage = pageablePage({
      segment: {
        blobPrefixes: [{ name: 'models/checkpoints/' }],
        blobItems: [
          {
            name: 'models/config.json',
            properties: { contentLength: 9, lastModified: modified },
          },
          { name: 'models/unknown.bin', properties: {} },
        ],
      },
      continuationToken: 'object-page-2',
    });
    const flatPage = pageablePage({
      segment: { blobItems: [] },
      continuationToken: undefined,
    });
    const listBlobsByHierarchy = vi.fn().mockReturnValue(hierarchyPage);
    const listBlobsFlat = vi.fn().mockReturnValue(flatPage);
    const getContainerClient = vi.fn().mockReturnValue({
      listBlobsByHierarchy,
      listBlobsFlat,
    });
    const blobServiceClient = { getContainerClient };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const storage = azure.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects('models-bucket', {
        prefix: 'models/',
        recursive: false,
        pageSize: 90,
        cursor: 'object-page-1',
      }),
    ).resolves.toEqual({
      entries: [
        { kind: 'prefix', key: 'models/checkpoints/' },
        {
          kind: 'object',
          key: 'models/config.json',
          sizeBytes: 9,
          lastModifiedAt: modified.getTime(),
        },
        {
          kind: 'object',
          key: 'models/unknown.bin',
          sizeBytes: null,
          lastModifiedAt: null,
        },
      ],
      nextCursor: 'object-page-2',
    });
    expect(listBlobsByHierarchy).toHaveBeenCalledWith('/', {
      prefix: 'models/',
    });
    expect(hierarchyPage.byPage).toHaveBeenCalledWith({
      continuationToken: 'object-page-1',
      maxPageSize: 90,
    });

    await storage.listObjects('models-bucket', {
      prefix: '',
      recursive: true,
      pageSize: 1000,
    });
    expect(listBlobsFlat).toHaveBeenCalledWith({ prefix: undefined });
  });

  async function listingFailure(failure: Error): Promise<unknown> {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    const page = pageablePage(undefined);
    page.next.mockRejectedValue(failure);
    const blobServiceClient = {
      getContainerClient: () => ({ listBlobsFlat: () => page }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const storage = azure.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');
    const rejection = await storage
      .listObjects('gone', { prefix: '', recursive: true, pageSize: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(page.next).toHaveBeenCalledTimes(1);
    return rejection;
  }

  it('reports a missing container listing as BucketNotFoundError', async () => {
    const containerNotFound = Object.assign(new Error('container missing'), {
      code: 'ContainerNotFound',
      statusCode: 404,
    });

    await expect(listingFailure(containerNotFound)).resolves.toEqual(
      new BucketNotFoundError('gone', containerNotFound),
    );
  });

  it('keeps a data-plane authorization failure as the provider error', async () => {
    const authorizationFailure = Object.assign(
      new Error('This request is not authorized to perform this operation.'),
      { code: 'AuthorizationFailure', statusCode: 403 },
    );

    await expect(listingFailure(authorizationFailure)).resolves.toBe(
      authorizationFailure,
    );
  });

  function blobFailure(code: string, statusCode: number): Error {
    return Object.assign(new Error(`${code || statusCode} from Azure`), {
      code: code || undefined,
      statusCode,
    });
  }

  it.each([
    ['ContainerNotFound', 404, BucketNotFoundError],
    ['BlobNotFound', 404, ObjectNotFoundError],
    ['AuthorizationFailure', 403, undefined],
    ['', 404, undefined],
  ])(
    'maps a download failure coded "%s" from one request',
    async (code, statusCode, expected) => {
      const azure = new Azure(completeCloudConfig(mockConfig));
      azure.storageClient = fakeSdkClient({
        storageAccounts: {
          listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
        },
      });
      vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
      const failure = blobFailure(code, statusCode);
      const download = vi.fn().mockRejectedValue(failure);
      const blobServiceClient = {
        getContainerClient: () => ({
          getBlockBlobClient: () => ({ download }),
        }),
      };
      vi.mocked(BlobServiceClient).mockImplementation(function () {
        return blobServiceClient as never;
      });

      const rejection = await azure
        .storage()
        .downloadObject('gone', 'k')
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      if (expected) expect(rejection).toBeInstanceOf(expected);
      else expect(rejection).toBe(failure);
      expect(download).toHaveBeenCalledTimes(1);
    },
  );

  // @azure/storage-blob 12.29 and @azure/arm-storage throw RestError with the
  // service error code in code and the HTTP status in statusCode.
  const restError = (code: string | undefined, statusCode: number) =>
    new RestError(
      'This request is not authorized to perform this operation.\nRequestId:aaaa-bbbb',
      { code, statusCode },
    );

  it.each([
    [restError('AuthorizationFailure', 403), 'denied'],
    [restError('AuthorizationPermissionMismatch', 403), 'denied'],
    [restError('AuthorizationFailed', 403), 'denied'],
    [restError('ServerBusy', 503), 'throttled'],
    [restError('TooManyRequests', 429), 'throttled'],
    [restError('ContainerNotFound', 404), 'bucket-missing'],
    [restError('BlobNotFound', 404), 'object-missing'],
    [restError('ResourceNotFound', 404), undefined],
    [restError('InternalError', 500), undefined],
    [restError('OperationTimedOut', 500), undefined],
    // Message text never classifies.
    [new Error('This request is not authorized'), undefined],
  ])('classifies %o as %s', async (error, kind) => {
    const failure = await new Azure(completeCloudConfig(mockConfig)).storage()
      .classifyStorageFailure!(error, 'b', 'k');
    expect(failure?.kind).toBe(kind);
  });

  // RestError keeps the PipelineResponse, with HttpHeaders, on `response`.
  // An earlier throttle was an ARM 429 that carried no error code.
  it.each([
    ['its Retry-After', { 'retry-after': '12' }, 12],
    ['retry-after-ms, rounded up', { 'retry-after-ms': '2500' }, 3],
    ['at least 1 s', { 'x-ms-retry-after-ms': '400' }, 1],
    ['1 s without one', {}, 1],
  ])(
    'answers a throttled Azure call with %s',
    async (_name, headers, seconds) => {
      const request = createPipelineRequest({
        url: 'https://management.azure.com/subscriptions',
      });
      const throttled = new RestError('Too many requests', {
        statusCode: 429,
        request,
        response: { status: 429, request, headers: createHttpHeaders(headers) },
      });
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => warnLog.mockRestore());

      const rejection = await throughBucketStorage(
        new Azure(completeCloudConfig(mockConfig)).storage(),
        { credentialName: 'prod-azure', action: 'list buckets' },
        undefined,
        () => Promise.reject(throttled),
      ).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(BucketThrottledError);
      expect((rejection as BucketThrottledError).retryAfterSeconds).toBe(
        seconds,
      );
    },
  );

  it('reports a denied blob download as BucketAccessDeniedError from one request', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    const download = vi
      .fn()
      .mockRejectedValue(restError('AuthorizationFailure', 403));
    const blobServiceClient = {
      getContainerClient: () => ({
        getBlockBlobClient: () => ({ download }),
      }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const storage = azure.storage();

    const rejection = await throughBucketStorage(
      storage,
      {
        credentialName: 'prod-azure',
        action: 'download',
        bucketName: 'b',
        remotePath: 'k',
      },
      undefined,
      () => storage.downloadObject('b', 'k'),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BucketAccessDeniedError);
    expect((rejection as Error).message).toBe(
      'Access denied: credential "prod-azure" cannot download b/k (Azure AuthorizationFailure). Check the credential and its Azure permissions.',
    );
    expect((rejection as Error).message).not.toContain('RequestId');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('reports an exhausted listing as a null cursor', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    // Azure closes a listing with an empty NextMarker, not a missing one.
    const containerPage = pageablePage({
      containerItems: [{ name: 'models', metadata: {} }],
      continuationToken: '',
    });
    const blobPage = pageablePage({
      segment: { blobItems: [{ name: 'a.bin', properties: {} }] },
      continuationToken: '',
    });
    const blobServiceClient = {
      listContainers: vi.fn().mockReturnValue(containerPage),
      getContainerClient: vi.fn().mockReturnValue({
        listBlobsFlat: vi.fn().mockReturnValue(blobPage),
      }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listBuckets({ pageSize: 1000 }),
    ).resolves.toMatchObject({ nextCursor: null });
    await expect(
      storage.listObjects('models', {
        prefix: '',
        recursive: true,
        pageSize: 1000,
      }),
    ).resolves.toMatchObject({ nextCursor: null });
  });

  it('refreshes Azure authentication and retries an unpropagated ARM grant', async () => {
    vi.useFakeTimers();
    const credentialConstructor = vi.mocked(ClientSecretCredential);
    const storageConstructor = vi.mocked(StorageManagementClient);
    credentialConstructor.mockClear();
    storageConstructor.mockReset();

    const firstStorageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: vi.fn().mockRejectedValue(authorizationFailed()),
      },
    });
    const secondStorageClient = fakeSdkClient({
      storageAccounts: {
        getProperties: vi.fn().mockResolvedValue(storageInfo.account),
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    storageConstructor
      .mockImplementationOnce(function () {
        return firstStorageClient as never;
      })
      .mockImplementationOnce(function () {
        return secondStorageClient as never;
      });

    const page = pageablePage({ containerItems: [], continuationToken: '' });
    const blobServiceClient = {
      listContainers: vi.fn().mockReturnValue(page),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.computeClient = fakeSdkClient({});
    azure.networkClient = fakeSdkClient({});
    (azure as any).resourcesClient = fakeSdkClient({});
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    try {
      const listing = storage.listBuckets({ pageSize: 1000 });
      await vi.advanceTimersByTimeAsync(500);

      await expect(listing).resolves.toEqual({
        buckets: [],
        nextCursor: null,
      });
      expect(credentialConstructor).toHaveBeenCalledTimes(2);
      expect(credentialConstructor).toHaveBeenNthCalledWith(
        2,
        'tenant',
        'app',
        'secret',
      );
      expect(storageConstructor).toHaveBeenCalledTimes(2);
    } finally {
      storageConstructor.mockReset();
      vi.mocked(BlobServiceClient).mockReset();
      vi.useRealTimers();
    }
  });

  it('retries AADSTS7000215 without separate readiness evidence', async () => {
    vi.useFakeTimers();
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = Object.assign(
      new Error('AADSTS7000215: Invalid client secret provided.'),
      { name: 'AuthenticationRequiredError' },
    );
    const findStorageAccount = vi.spyOn(azure, 'findStorageAccount');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      findStorageAccount.mockRejectedValueOnce(failure);
    }
    findStorageAccount.mockResolvedValueOnce(null);
    const refresh = vi
      .spyOn(azure as any, 'refreshStorageAuthentication')
      .mockImplementation(() => undefined);
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');
    expect(storage.isCredentialNotReady?.(failure)).toBe(true);

    try {
      const startedAt = Date.now();
      const listing = storage.listBuckets({ pageSize: 1000 });
      await vi.runAllTimersAsync();

      await expect(listing).resolves.toEqual({
        buckets: [],
        nextCursor: null,
      });
      expect(findStorageAccount).toHaveBeenCalledTimes(7);
      expect(refresh).toHaveBeenCalledTimes(6);
      expect(Date.now() - startedAt).toBe(23_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying a broken secret after the bounded budget', async () => {
    vi.useFakeTimers();
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = new Error('AADSTS7000215: Invalid client secret provided.');
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(failure);
    const refresh = vi
      .spyOn(azure as any, 'refreshStorageAuthentication')
      .mockImplementation(() => undefined);
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    try {
      const startedAt = Date.now();
      const rejected = storage
        .listBuckets({ pageSize: 1000 })
        .catch((error) => error);
      await vi.runAllTimersAsync();

      await expect(rejected).resolves.toBe(failure);
      expect(findStorageAccount).toHaveBeenCalledTimes(9);
      expect(refresh).toHaveBeenCalledTimes(8);
      expect(Date.now() - startedAt).toBe(39_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'AADSTS7000222: The provided client secret is expired.',
    'invalid_client returned from token endpoint',
  ])('does not retry the terminal secret error %s', async (message) => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = new Error(message);
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(failure);
    const refresh = vi.spyOn(azure as any, 'refreshStorageAuthentication');
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');
    expect(storage.isCredentialNotReady?.(failure)).toBe(false);

    await expect(storage.listBuckets({ pageSize: 1000 })).rejects.toBe(failure);
    expect(findStorageAccount).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('exhausts a bounded retry budget for an unpropagated ARM grant', async () => {
    vi.useFakeTimers();
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = authorizationFailed();
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(failure);
    const refresh = vi
      .spyOn(azure as any, 'refreshStorageAuthentication')
      .mockImplementation(() => undefined);
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    try {
      const startedAt = Date.now();
      const listing = storage.listBuckets({ pageSize: 1000 });
      const rejected = listing.catch((error) => error);
      await vi.runAllTimersAsync();

      await expect(rejected).resolves.toBe(failure);
      expect(findStorageAccount).toHaveBeenCalledTimes(9);
      expect(refresh).toHaveBeenCalledTimes(8);
      expect(Date.now() - startedAt).toBe(39_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an ARM grant that outlasts the propagation retries as denied', async () => {
    vi.useFakeTimers();
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(authorizationFailed());
    vi.spyOn(azure as any, 'refreshStorageAuthentication').mockImplementation(
      () => undefined,
    );
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    try {
      const rejected = throughBucketStorage(
        storage,
        { credentialName: 'prod-azure', action: 'list buckets' },
        undefined,
        (options) => storage.listBuckets({ pageSize: 1000 }, options),
      ).catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      const error = await rejected;
      expect(error).toBeInstanceOf(BucketAccessDeniedError);
      expect((error as Error).message).toBe(
        'Access denied: credential "prod-azure" cannot list buckets (Azure AuthorizationFailed). Check the credential and its Azure permissions.',
      );
      expect(findStorageAccount).toHaveBeenCalledTimes(9);
    } finally {
      vi.useRealTimers();
    }
  });

  // @azure/identity's shape when an Entra replica has not seen a new secret
  // yet (paid run 37762370054).
  const unreplicatedSecret = () =>
    Object.assign(
      new Error(
        'invalid_client: Error(s): 7000215 - Timestamp: 2026-10-08 10:37:51Z - ' +
          'Description: AADSTS7000215: Invalid client secret provided.',
      ),
      { name: 'AuthenticationRequiredError' },
    );

  async function deniedOrNotReady(failures: readonly Error[]) {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const findStorageAccount = vi.spyOn(azure, 'findStorageAccount');
    for (const failure of failures)
      findStorageAccount.mockRejectedValueOnce(failure);
    vi.spyOn(azure as any, 'refreshStorageAuthentication').mockImplementation(
      () => undefined,
    );
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');
    const rejected = throughBucketStorage(
      storage,
      { credentialName: 'new-azure', action: 'list buckets' },
      undefined,
      (options) => storage.listBuckets({ pageSize: 1000 }, options),
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    return { error: await rejected, findStorageAccount };
  }

  it('reports a secret that reached ARM as denied when its last sign-in hits an unreplicated replica', async () => {
    vi.useFakeTimers();
    try {
      const refusals = Array.from({ length: 8 }, authorizationFailed);
      const { error, findStorageAccount } = await deniedOrNotReady([
        ...refusals,
        unreplicatedSecret(),
      ]);

      expect(error).toBeInstanceOf(BucketAccessDeniedError);
      // The latest ARM refusal, not the final sign-in failure.
      expect((error as BucketAccessDeniedError).cause).toBe(refusals[7]);
      expect(findStorageAccount).toHaveBeenCalledTimes(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a secret that never reached ARM as not ready', async () => {
    vi.useFakeTimers();
    try {
      const { error, findStorageAccount } = await deniedOrNotReady(
        Array.from({ length: 9 }, unreplicatedSecret),
      );

      expect(error).toBeInstanceOf(BucketCredentialNotReadyError);
      expect(findStorageAccount).toHaveBeenCalledTimes(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains jitter for transient storage failures', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = new Error('Premature close');
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(failure);
    const refresh = vi
      .spyOn(azure as any, 'refreshStorageAuthentication')
      .mockImplementation(() => undefined);
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    try {
      const startedAt = Date.now();
      const listing = storage.listBuckets({ pageSize: 1000 });
      const rejected = listing.catch((error) => error);
      await vi.runAllTimersAsync();

      await expect(rejected).resolves.toBe(failure);
      expect(findStorageAccount).toHaveBeenCalledTimes(9);
      expect(refresh).not.toHaveBeenCalled();
      expect(random).toHaveBeenCalledTimes(8);
      expect(Date.now() - startedAt).toBe(19_750);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps coordinated bucket creation inside the same bounded authorization budget', async () => {
    vi.useFakeTimers();
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = authorizationFailed();
    const rawUpsert = vi
      .spyOn(azure as any, 'upsertBucketUncoordinated')
      .mockRejectedValue(failure);
    vi.spyOn(azure as any, 'refreshStorageAuthentication').mockImplementation(
      () => undefined,
    );

    try {
      const startedAt = Date.now();
      const upsert = azure
        .storage()
        .upsertBucket('models', '1.0.0', 'workload', 'user');
      const rejected = upsert.catch((error) => error);
      await vi.runAllTimersAsync();

      await expect(rejected).resolves.toBe(failure);
      expect(rawUpsert).toHaveBeenCalledTimes(9);
      expect(Date.now() - startedAt).toBe(39_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels only one caller while shared authorization recovery continues', async () => {
    vi.useFakeTimers();
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const rawUpsert = vi
      .spyOn(azure as any, 'upsertBucketUncoordinated')
      .mockRejectedValueOnce(authorizationFailed())
      .mockResolvedValueOnce(undefined);
    const refresh = vi
      .spyOn(azure as any, 'refreshStorageAuthentication')
      .mockImplementation(() => undefined);
    const storage = azure.storage();
    const controller = new AbortController();
    const cancellation = new DOMException('request stopped', 'AbortError');

    try {
      const cancelled = storage.upsertBucket(
        'models',
        '1.0.0',
        'cancelled-workload',
        'user',
        { signal: controller.signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      const surviving = storage.upsertBucket(
        'models',
        '1.0.0',
        'surviving-workload',
        'user',
      );
      const survivingAssertion = expect(surviving).resolves.toBeUndefined();
      controller.abort(cancellation);

      await expect(cancelled).rejects.toBe(cancellation);
      await vi.advanceTimersByTimeAsync(500);
      await survivingAssertion;
      expect(rawUpsert).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry an unrelated Azure 403', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubInitializedClients(azure);
    const failure = Object.assign(new Error('Request forbidden by policy'), {
      code: 'Forbidden',
      statusCode: 403,
    });
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockRejectedValue(failure);
    const refresh = vi.spyOn(azure as any, 'refreshStorageAuthentication');
    const storage = azure.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    await expect(storage.listBuckets({ pageSize: 1000 })).rejects.toBe(failure);
    expect(findStorageAccount).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Azure GPU image support', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_NC6s_v3',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  // Generate a real RSA key pair for testing
  const { publicKey: testPublicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  describe('getVmParams marketplace plan', () => {
    // Azure GPU deploys use dstack community-gallery images (not marketplace
    // offers, so no purchase plan); CPU uses a canonical marketplace image that
    // also carries no plan. getVmParams therefore never sets vmParams.plan.
    it('never sets a marketplace plan', () => {
      const azure = new Azure(completeCloudConfig(mockConfig));
      const vmParams = azure.getVmParams(
        'test-vm',
        '#!/bin/bash\necho hello',
        {
          // service-terminology-ok: Azure owns this marketplace SKU spelling
          publisher: 'canonical',
          offer: 'ubuntu-24_04-lts',
          sku: 'server',
        },
        '24.04.202501010',
        { nic: { id: '/test/nic/id' } },
        testPublicKey,
        'test-workload', // workloadId
        '0.3.2', // version
        'testuser', // userId
        false, // spot
      );

      expect(vmParams.plan).toBeUndefined();
      expect(vmParams.identity).toBeUndefined();
    });
  });

  describe('getVmParams disk tier -> OS-disk storageAccountType', () => {
    const baseImageProps = {
      // service-terminology-ok: Azure owns this marketplace SKU spelling
      publisher: 'canonical',
      offer: 'ubuntu-24_04-lts',
      sku: 'server',
    };

    function osDiskSkuFor(diskTier?: DiskTier, diskSizeGb?: number): string {
      const azure = new Azure(
        completeCloudConfig({ ...mockConfig, diskTier, diskSizeGb }),
      );
      const vmParams = azure.getVmParams(
        'test-vm',
        '#!/bin/bash\necho hello',
        baseImageProps,
        '22.04.202501010',
        { nic: { id: '/test/nic/id' } },
        testPublicKey,
        'test-workload',
        '0.3.2',
        'testuser',
        false,
      );
      return vmParams.storageProfile.osDisk.managedDisk.storageAccountType;
    }

    it('fills the default tier before the gateway, so the boundary never sees unresolved', () => {
      // completeCloudConfig stamps DEFAULT_DISK_TIER (High); the pre-brand
      // "unresolved tier at the gateway" state is no longer representable.
      expect(osDiskSkuFor(undefined)).toBe('Premium_LRS');
    });

    it('maps medium to Standard_LRS', () => {
      expect(osDiskSkuFor(DiskTier.Medium)).toBe('Standard_LRS');
    });

    it('maps high to Premium_LRS', () => {
      expect(osDiskSkuFor(DiskTier.High)).toBe('Premium_LRS');
    });

    it('collapses ultra onto Premium_LRS (UltraSSD/PremiumV2 are illegal OS-disk SKUs)', () => {
      expect(osDiskSkuFor(DiskTier.Ultra)).toBe('Premium_LRS');
    });

    it.each([false, true])(
      'has Azure delete the OS disk with the VM however it is deleted (spot: %s)',
      (spot) => {
        const vmParams = new Azure(completeCloudConfig(mockConfig)).getVmParams(
          'test-vm',
          '#!/bin/bash\necho hello',
          baseImageProps,
          '22.04.202501010',
          { nic: { id: '/test/nic/id' } },
          testPublicKey,
          'test-workload',
          '0.3.2',
          'testuser',
          spot,
        );
        expect(vmParams.storageProfile.osDisk.deleteOption).toBe('Delete');
        // Eviction deallocates in place, so the disk survives for the restart.
        expect(vmParams.evictionPolicy).toBe(spot ? 'Deallocate' : undefined);
      },
    );

    it.each([false, true])(
      'deletes a node pool VM on eviction, with its NIC and public IP (spot: %s)',
      (spot) => {
        const vmParams = new Azure(completeCloudConfig(mockConfig)).getVmParams(
          'test-vm',
          '#!/bin/bash\necho hello',
          baseImageProps,
          '22.04.202501010',
          { nic: { id: '/test/nic/id' } },
          testPublicKey,
          'test-workload',
          '0.3.2',
          'testuser',
          spot,
          { id: 'node-pool-1', tags: {} },
        );
        expect(vmParams.evictionPolicy).toBe(spot ? 'Delete' : undefined);
        expect(vmParams.networkProfile.networkInterfaces[0].deleteOption).toBe(
          'Delete',
        );
      },
    );

    it('coexists with an explicit disk size', () => {
      const azure = new Azure(
        completeCloudConfig({
          ...mockConfig,
          diskTier: DiskTier.High,
          diskSizeGb: 200,
        }),
      );
      const vmParams = azure.getVmParams(
        'test-vm',
        '#!/bin/bash\necho hello',
        baseImageProps,
        '22.04.202501010',
        { nic: { id: '/test/nic/id' } },
        testPublicKey,
        'test-workload',
        '0.3.2',
        'testuser',
        false,
      );
      expect(vmParams.storageProfile.osDisk.diskSizeGB).toBe(200);
      expect(
        vmParams.storageProfile.osDisk.managedDisk.storageAccountType,
      ).toBe('Premium_LRS');
    });
  });

  describe('GPU image selection by gpuRuntime', () => {
    // The shared CloudCompute capability rejects unsupported runtimes before
    // raw Azure compute/network code, so only CUDA reaches image selection.
    function stubIdentity(azure: Azure): { beginCreateOrUpdate: any } {
      const beginCreateOrUpdate = vi.fn();
      stubVmOnlySetup(azure);
      const computeClient: any = {
        virtualMachines: { beginCreateOrUpdate },
        virtualMachineImages: { list: vi.fn() },
      };
      azure.computeClient = fakeSdkClient(computeClient);
      return { beginCreateOrUpdate };
    }

    function newVMProps(
      gpuRuntime:
        | GpuRuntime.Cuda
        | GpuRuntime.Rocm
        | GpuRuntime.Neuron
        | GpuRuntime.Unsupported,
    ) {
      return makeNewVMProps({
        vmId: 'amd-vm',
        workloadId: 'amd-deploy',
        startupScript: '#!/bin/bash',
        gpuRuntime,
      });
    }

    it.each(['eastus', 'East US'])(
      "accepts gpuRuntime='cuda' in supported region %s",
      async (region) => {
        const azure = new Azure(
          completeCloudConfig({
            ...mockConfig,
            region,
          }),
        );
        stubIdentity(azure);
        vi.spyOn(azure as any, 'getVnetInfo').mockRejectedValueOnce(
          new Error('continued past GPU region guard'),
        );

        await expect(
          azure.compute().newVM(newVMProps(GpuRuntime.Cuda)),
        ).rejects.toThrow('continued past GPU region guard');
      },
    );

    it("throws DeployError(400) for gpuRuntime='cuda' in display-name regions without the community GPU image", async () => {
      const azure = new Azure(
        completeCloudConfig({
          ...mockConfig,
          region: 'Australia Central',
        }),
      );
      const { beginCreateOrUpdate } = stubIdentity(azure);

      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Cuda)),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Cuda)),
      ).rejects.toThrow(/australiacentral|GPU base image/i);
      expect(beginCreateOrUpdate).not.toHaveBeenCalled();
    });

    it("throws DeployError(400) for gpuRuntime='rocm' (MI300X) — never boots the NVIDIA image", async () => {
      const azure = new Azure(
        completeCloudConfig({
          ...mockConfig,
          vmType: 'Standard_ND96isr_MI300X_v5',
        }),
      );
      const { beginCreateOrUpdate } = stubIdentity(azure);

      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Rocm)),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Rocm)),
      ).rejects.toThrow(/AMD|ROCm/);
      // No NVIDIA marketplace VM creation attempted.
      expect(beginCreateOrUpdate).not.toHaveBeenCalled();
    });

    it("throws DeployError(400) for gpuRuntime='unsupported' — never boots the NVIDIA image", async () => {
      const azure = new Azure(completeCloudConfig(mockConfig));
      const { beginCreateOrUpdate } = stubIdentity(azure);

      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Unsupported)),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(beginCreateOrUpdate).not.toHaveBeenCalled();
    });

    it("throws DeployError(400) for gpuRuntime='neuron' — never boots an Azure image", async () => {
      const azure = new Azure(completeCloudConfig(mockConfig));
      const { beginCreateOrUpdate } = stubIdentity(azure);

      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Neuron)),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        azure.compute().newVM(newVMProps(GpuRuntime.Neuron)),
      ).rejects.toThrow(/Neuron.*not supported/i);
      expect(beginCreateOrUpdate).not.toHaveBeenCalled();
    });
  });

  describe('marketplace terms error handling', () => {
    it('should rethrow other errors unchanged', async () => {
      const azure = new Azure(completeCloudConfig(mockConfig));

      const originalError = new Error('Some other Azure error');
      (originalError as any).code = 'SomeOtherError';

      stubVmOnlySetup(azure);
      azure.computeClient = fakeSdkClient({
        virtualMachines: {
          beginCreateOrUpdate: vi.fn().mockRejectedValue(originalError),
        },
        virtualMachineImages: {
          list: vi.fn().mockResolvedValue([{ name: '25.09.1' }]),
        },
      });
      azure.networkClient = fakeSdkClient({
        virtualNetworks: { get: vi.fn().mockResolvedValue({}) },
        subnets: { get: vi.fn().mockResolvedValue({}) },
        publicIPAddresses: {
          beginCreateOrUpdate: vi.fn().mockResolvedValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
        networkSecurityGroups: { get: vi.fn().mockResolvedValue({}) },
        networkInterfaces: {
          beginCreateOrUpdate: vi.fn().mockResolvedValue({
            pollUntilDone: vi.fn().mockResolvedValue({
              ipConfigurations: [{ privateIPAddress: '10.0.0.1' }],
            }),
          }),
        },
      });

      await expect(
        azure.compute().newVM(
          makeNewVMProps({
            vmId: 'test-vm',
            workloadId: 'test-workload',
            ipWhitelist: [],
            startupScript: '',
            gpuRuntime: GpuRuntime.Cuda,
          }),
        ),
      ).rejects.toThrow('Some other Azure error');
    });
  });
});

describe('Azure.newVM', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  // Wire up just enough of the compute + network clients for newVM to reach
  // beginCreateOrUpdate and then poll a ready VM. The caller supplies the
  // beginCreateOrUpdate mock so each test controls the failure sequence.
  function stubNewVMClients(
    azure: Azure,
    beginCreateOrUpdate: ReturnType<typeof vi.fn>,
    timeCreated?: Date,
  ): void {
    untouched.length = 0;
    stubVmOnlySetup(azure);
    azure.computeClient = fakeSdkClient({
      virtualMachines: {
        beginCreateOrUpdate,
        // checkVMStatus polls this — report running so the poll returns at once
        get: vi.fn().mockResolvedValue({
          timeCreated,
          instanceView: { statuses: [{ code: 'PowerState/running' }] },
        }),
      },
      virtualMachineImages: {
        // Fresh array per call: getImageId does imageInfo.pop(), which would
        // empty a shared mockResolvedValue array across concurrent creates.
        list: vi
          .fn()
          .mockImplementation(async () => [{ name: '22.04.202501010' }]),
      },
    });
    azure.networkClient = fakeSdkClient({
      virtualNetworks: { get: vi.fn().mockResolvedValue({ id: '/test/vnet' }) },
      subnets: { get: vi.fn().mockResolvedValue({ id: '/test/subnet' }) },
      publicIPAddresses: {
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({ id: '/test/ip' }),
        }),
        get: vi.fn().mockResolvedValue({ ipAddress: '1.2.3.4' }),
      },
      networkSecurityGroups: {
        get: vi.fn().mockResolvedValue({ id: '/test/nsg' }),
      },
      networkInterfaces: {
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({
            id: '/test/nic',
            ipConfigurations: [{ privateIPAddress: '10.0.0.1' }],
          }),
        }),
      },
    });
  }

  async function createReadyVM(timeCreated?: Date) {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubNewVMClients(azure, vi.fn().mockResolvedValue({}), timeCreated);

    return azure.compute().newVM(
      makeNewVMProps({
        vmId: 'test-vm',
        workloadId: 'test-workload',
        ipWhitelist: ['0.0.0.0/0'],
        startupScript: '#!/bin/bash\necho hi',
        gpuRuntime: null,
      }),
    );
  }

  it('0047/S4 provisions a VM with compute and network setup only, attaching no identity', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const beginCreateOrUpdate = vi.fn().mockResolvedValue({});
    stubNewVMClients(azure, beginCreateOrUpdate);

    await azure.compute().newVM(
      makeNewVMProps({
        vmId: 'vm-no-identity',
        workloadId: 'vm-no-identity',
        ipWhitelist: ['0.0.0.0/0'],
        startupScript: '#!/bin/bash\necho hi',
        gpuRuntime: null,
      }),
    );

    const vmParams = beginCreateOrUpdate.mock.calls[0][2];
    expect(vmParams.identity).toBeUndefined();
    expect(untouched).toEqual([]);
  });

  it.each([
    [true, 'minimal-arm64'],
    [false, 'server-arm64'],
  ])(
    "boots an Arm type's VM, Job host %s, on Ubuntu 24.04's %s SKU",
    async (jobHost, sku) => {
      // The published catalog marks Cobalt and Ampere arm64 once this fetcher
      // publishes it.
      vmArchitecture.mockReturnValueOnce('arm64');
      const vmType = 'Standard_D4ps_v6';
      const azure = new Azure(completeCloudConfig({ ...mockConfig, vmType }));
      const beginCreateOrUpdate = vi.fn().mockResolvedValue({});
      stubNewVMClients(azure, beginCreateOrUpdate);

      await azure.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: ['0.0.0.0/0'],
          startupScript: '#!/bin/bash\necho hi',
          gpuRuntime: null,
          jobHost,
        }),
      );

      expect(vmArchitecture).toHaveBeenCalledWith(CloudType.Azure, vmType);
      expect(
        beginCreateOrUpdate.mock.calls[0][2].storageProfile.imageReference,
      ).toMatchObject({
        publisher: 'canonical',
        offer: 'ubuntu-24_04-lts',
        sku,
      });
    },
  );

  // Drive a real GPU deploy through newVM and return the community-gallery image
  // id that landed in the create request. The accelerator name is resolved from
  // the seeded catalog (getCatalogs in global-setup), so vmType → image is the
  // real end-to-end path, not a stubbed selector.
  async function gpuImageIdFor(vmType: string): Promise<string> {
    const azure = new Azure(completeCloudConfig({ ...mockConfig, vmType }));
    const beginCreateOrUpdate = vi.fn().mockResolvedValue({});
    stubNewVMClients(azure, beginCreateOrUpdate);
    await azure.compute().newVM(
      makeNewVMProps({
        vmId: 'test-vm',
        workloadId: 'test-workload',
        ipWhitelist: ['0.0.0.0/0'],
        startupScript: '#!/bin/bash\necho hi',
        gpuRuntime: GpuRuntime.Cuda,
      }),
    );
    return beginCreateOrUpdate.mock.calls[0][2].storageProfile.imageReference
      .communityGalleryImageId;
  }

  it.each(['Standard_NC6s_v3', 'Standard_ND40rs_v2'])(
    'routes pre-Turing V100 SKU %s to the proprietary 0.10 image',
    async (vmType) => {
      expect(await gpuImageIdFor(vmType)).toBe(
        AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID,
      );
    },
  );

  it('routes a Turing+ SKU (T4) to the open-modules 0.14 image', async () => {
    expect(await gpuImageIdFor('Standard_NC4as_T4_v3')).toBe(
      AZURE_CUDA_COMMUNITY_IMAGE_ID,
    );
  });

  it('routes an NV-series A10 (vGPU) SKU to the GRID image', async () => {
    expect(await gpuImageIdFor('Standard_NV6ads_A10_v5')).toBe(
      AZURE_GRID_COMMUNITY_IMAGE_ID,
    );
  });

  it('rejects an NC/ND CUDA target whose GPU model is unresolvable', async () => {
    const azure = new Azure(
      completeCloudConfig({ ...mockConfig, vmType: 'Standard_NC_bogus_v9' }),
    );
    const beginCreateOrUpdate = vi.fn().mockResolvedValue({});
    stubNewVMClients(azure, beginCreateOrUpdate);
    await expect(
      azure.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: ['0.0.0.0/0'],
          startupScript: '#!/bin/bash\necho hi',
          gpuRuntime: GpuRuntime.Cuda,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(beginCreateOrUpdate).not.toHaveBeenCalled();
  });

  it('returns Azure timeCreated as createdAt in milliseconds', async () => {
    const timeCreated = new Date('2023-11-14T22:13:20.000Z');

    const vm = await createReadyVM(timeCreated);

    expect(vm.createdAt).toBe(1_700_000_000_000);
  });

  it.each([
    ['missing', undefined],
    ['invalid', new Date(Number.NaN)],
  ])('omits createdAt when Azure timeCreated is %s', async (_name, value) => {
    const vm = await createReadyVM(value);

    expect(vm.createdAt).toBeUndefined();
  });
});

describe('Azure candidate region filter', () => {
  const credentials = {
    subscriptionId: 'sub',
    directoryId: 'tenant',
    applicationId: 'app',
    secret: 'secret',
  };
  const makeAzure = () =>
    new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_D2s_v5',
        credentials,
      }),
    );
  const candidates = [
    { vmType: 'Standard_D2s_v5', region: 'eastus' },
    { vmType: 'Standard_D2s_v5', region: 'eastus2' },
    { vmType: 'Standard_D2s_v5', region: 'moonregion' },
  ];

  const overlaySnapshot = (
    version: string,
    assess: (candidate: CandidateRegion) => CandidateRegionAvailability = () =>
      CandidateRegionAvailability.Verified,
  ) => ({ version, observedAt: 1, assessCandidate: assess });

  beforeEach(() => {
    resetAzurePreflightSweeps();
    ensureProviderRegisteredMock.mockReset();
    getInsufficientQuotaRegionsMock.mockReset();
    ensureProviderRegisteredMock.mockResolvedValue(true);
    catalogOverlayReadMock.mockReturnValue(overlaySnapshot('overlay-v1'));
    getInsufficientQuotaRegionsMock.mockResolvedValue(
      insufficientQuotaResult([]),
    );
  });

  it('reads the overlay without waiting and retains restricted targets as fallback', async () => {
    catalogOverlayRefreshMock.mockReturnValue(new Promise(() => {}));
    catalogOverlayReadMock.mockReturnValue(
      overlaySnapshot('overlay-v1', (candidate) =>
        candidate.region === 'moonregion'
          ? CandidateRegionAvailability.Unknown
          : CandidateRegionAvailability.Verified,
      ),
    );
    getInsufficientQuotaRegionsMock.mockResolvedValue(
      insufficientQuotaResult(['eastus2']),
    );

    await expect(
      filterCandidateRegions(makeAzure(), candidates, false, 'workload-id'),
    ).resolves.toEqual([
      { vmType: 'Standard_D2s_v5', region: 'eastus' },
      { vmType: 'Standard_D2s_v5', region: 'moonregion' },
    ]);
    expect(catalogOverlayRefreshMock).toHaveBeenCalled();
    expect(getInsufficientQuotaRegionsMock).toHaveBeenCalledWith(
      'azure:standarddsv5family',
      2,
      false,
      ['eastus', 'eastus2', 'moonregion'],
      expect.any(AbortSignal),
    );
  });

  it('fails open when the overlay has not completed its first refresh', async () => {
    catalogOverlayReadMock.mockReturnValue(undefined);
    getInsufficientQuotaRegionsMock.mockResolvedValue(
      insufficientQuotaResult(['eastus2']),
    );

    await expect(
      filterCandidateRegions(makeAzure(), candidates, false, 'workload-id'),
    ).resolves.toEqual([
      { vmType: 'Standard_D2s_v5', region: 'eastus' },
      { vmType: 'Standard_D2s_v5', region: 'moonregion' },
    ]);
  });

  it('shares one quota sweep across concurrent gateways', async () => {
    let release!: (result: ReturnType<typeof insufficientQuotaResult>) => void;
    getInsufficientQuotaRegionsMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = filterCandidateRegions(
      makeAzure(),
      candidates,
      false,
      'deploy-1',
    );
    const second = filterCandidateRegions(
      makeAzure(),
      candidates,
      false,
      'deploy-2',
    );
    await Promise.resolve();
    release(insufficientQuotaResult(['eastus2']));

    await expect(first).resolves.toEqual([candidates[0], candidates[2]]);
    await expect(second).resolves.toEqual([candidates[0], candidates[2]]);
    expect(getInsufficientQuotaRegionsMock).toHaveBeenCalledOnce();
  });

  it('does not cache partial quota observations', async () => {
    getInsufficientQuotaRegionsMock
      .mockResolvedValueOnce(insufficientQuotaResult([], false, ['eastus2']))
      .mockResolvedValueOnce(insufficientQuotaResult(['eastus2']));

    await filterCandidateRegions(makeAzure(), candidates, false, 'deploy-1');
    await filterCandidateRegions(makeAzure(), candidates, false, 'deploy-2');

    expect(getInsufficientQuotaRegionsMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the quota sweep while sampling the latest overlay once per classification', async () => {
    let current = overlaySnapshot('overlay-v1');
    catalogOverlayReadMock.mockImplementation(() => current);
    const azure = makeAzure();

    await expect(
      filterCandidateRegions(azure, candidates, false, 'deploy-1'),
    ).resolves.toEqual(candidates);
    current = overlaySnapshot('overlay-v2', (candidate) =>
      candidate.region === 'eastus'
        ? CandidateRegionAvailability.Unknown
        : CandidateRegionAvailability.Verified,
    );
    await expect(
      filterCandidateRegions(azure, candidates, false, 'deploy-2'),
    ).resolves.toEqual([candidates[1], candidates[2], candidates[0]]);
    expect(getInsufficientQuotaRegionsMock).toHaveBeenCalledOnce();
    expect(catalogOverlayReadMock).toHaveBeenCalledTimes(2);
  });

  it('fails open before quota reads when Compute registration cannot be verified', async () => {
    ensureProviderRegisteredMock.mockRejectedValue(
      new Error('registration endpoint unavailable'),
    );

    await expect(
      filterCandidateRegions(makeAzure(), candidates, false, 'workload-id'),
    ).resolves.toEqual(candidates);
    expect(getInsufficientQuotaRegionsMock).not.toHaveBeenCalled();
  });
});

describe('Azure Timestamp tagging', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: 'test-sub-id',
      directoryId: 'test-tenant-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  describe('ended_at tag', () => {
    it('should add anycloud_ended_at tag to VM before termination', async () => {
      const azure = new Azure(completeCloudConfig(mockConfig));

      const mockVM = {
        id: 'test-vm-id',
        name: 'test-vm',
        location: 'eastus',
        tags: {
          anycloud_deployment: 'test-workload',
          anycloud_version: '1.0.0',
        },
      };

      const mockComputeClient = {
        virtualMachines: {
          beginPowerOff: vi.fn().mockResolvedValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          get: vi.fn().mockResolvedValue(mockVM),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const mockNetworkClient = {
        networkInterfaces: {
          get: vi.fn().mockResolvedValue({
            id: 'test-nic-id',
            name: 'test-vm',
            location: 'eastus',
            tags: {},
          }),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          updateTags: vi.fn().mockResolvedValue({}),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
        publicIPAddresses: {
          get: vi.fn().mockResolvedValue({
            id: 'test-ip-id',
            name: 'test-vm',
            location: 'eastus',
            tags: {},
          }),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          updateTags: vi.fn().mockResolvedValue({}),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      azure.computeClient = fakeSdkClient(mockComputeClient as any);
      azure.networkClient = fakeSdkClient(mockNetworkClient as any);

      await azure['terminateVM']('test-vm');

      // Verify VM was tagged before deletion using beginUpdate (PATCH)
      expect(mockComputeClient.virtualMachines.get).toHaveBeenCalledWith(
        azure.resourceGroup,
        'test-vm',
      );
      expect(mockComputeClient.virtualMachines.beginUpdate).toHaveBeenCalled();
      const vmUpdateCall =
        mockComputeClient.virtualMachines.beginUpdate.mock.calls[0];
      expect(vmUpdateCall[2].tags.anycloud_ended_at).toBeDefined();
      expect(vmUpdateCall[2].tags.anycloud_ended_at).toMatch(/^\d+$/);
    });

    it('should add anycloud_ended_at tag to NIC before deletion', async () => {
      const azure = new Azure(completeCloudConfig(mockConfig));

      const mockVM = {
        id: 'test-vm-id',
        name: 'test-vm',
        location: 'eastus',
        tags: {},
      };

      const mockNIC = {
        id: 'test-nic-id',
        name: 'test-vm',
        location: 'eastus',
        tags: {
          anycloud_deployment: 'test-workload',
        },
      };

      const mockComputeClient = {
        virtualMachines: {
          beginPowerOff: vi.fn().mockResolvedValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          get: vi.fn().mockResolvedValue(mockVM),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const mockNetworkClient = {
        networkInterfaces: {
          get: vi.fn().mockResolvedValue(mockNIC),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          updateTags: vi.fn().mockResolvedValue({}),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
        publicIPAddresses: {
          get: vi.fn().mockResolvedValue({
            id: 'test-ip-id',
            name: 'test-vm',
            location: 'eastus',
            tags: {},
          }),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          updateTags: vi.fn().mockResolvedValue({}),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      azure.computeClient = fakeSdkClient(mockComputeClient as any);
      azure.networkClient = fakeSdkClient(mockNetworkClient as any);

      await azure['terminateVM']('test-vm');

      // Verify NIC was tagged before deletion using updateTags (PATCH)
      expect(mockNetworkClient.networkInterfaces.get).toHaveBeenCalledWith(
        azure.resourceGroup,
        'test-vm',
      );
      expect(mockNetworkClient.networkInterfaces.updateTags).toHaveBeenCalled();
      const nicUpdateCall =
        mockNetworkClient.networkInterfaces.updateTags.mock.calls[0];
      expect(nicUpdateCall[2].tags.anycloud_ended_at).toBeDefined();
      expect(nicUpdateCall[2].tags.anycloud_ended_at).toMatch(/^\d+$/);
    });

    it('should add anycloud_ended_at tag to Public IP before deletion', async () => {
      const azure = new Azure(completeCloudConfig(mockConfig));

      const mockVM = {
        id: 'test-vm-id',
        name: 'test-vm',
        location: 'eastus',
        tags: {},
        storageProfile: {},
      };

      const mockPublicIP = {
        id: 'test-ip-id',
        name: 'test-vm',
        location: 'eastus',
        tags: {
          anycloud_deployment: 'test-workload',
        },
      };

      const mockComputeClient = {
        virtualMachines: {
          beginPowerOff: vi.fn().mockResolvedValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          get: vi.fn().mockResolvedValue(mockVM),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const mockNetworkClient = {
        networkInterfaces: {
          get: vi.fn().mockResolvedValue({
            id: 'test-nic-id',
            name: 'test-vm',
            location: 'eastus',
            tags: {},
          }),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          updateTags: vi.fn().mockResolvedValue({}),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
        publicIPAddresses: {
          get: vi.fn().mockResolvedValue(mockPublicIP),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          updateTags: vi.fn().mockResolvedValue({}),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      azure.computeClient = fakeSdkClient(mockComputeClient as any);
      azure.networkClient = fakeSdkClient(mockNetworkClient as any);

      await azure['terminateVM']('test-vm');

      // Verify Public IP was tagged before deletion using updateTags (PATCH)
      expect(mockNetworkClient.publicIPAddresses.get).toHaveBeenCalledWith(
        azure.resourceGroup,
        'test-vm',
      );
      expect(mockNetworkClient.publicIPAddresses.updateTags).toHaveBeenCalled();
      const ipUpdateCall =
        mockNetworkClient.publicIPAddresses.updateTags.mock.calls[0];
      expect(ipUpdateCall[2].tags.anycloud_ended_at).toBeDefined();
      expect(ipUpdateCall[2].tags.anycloud_ended_at).toMatch(/^\d+$/);
    });

    it('should not block deletion if tagging fails', async () => {
      vi.useFakeTimers();
      const azure = new Azure(completeCloudConfig(mockConfig));

      const mockComputeClient = {
        virtualMachines: {
          beginPowerOff: vi.fn().mockResolvedValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          get: vi
            .fn()
            .mockResolvedValueOnce({})
            .mockRejectedValue(new Error('Tagging failed')),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const mockNetworkClient = {
        networkInterfaces: {
          get: vi.fn().mockResolvedValue({
            id: 'test-nic-id',
            name: 'test-vm',
            location: 'eastus',
            tags: {},
          }),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
        publicIPAddresses: {
          get: vi.fn().mockResolvedValue({
            id: 'test-ip-id',
            name: 'test-vm',
            location: 'eastus',
            tags: {},
          }),
          beginCreateOrUpdate: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
          beginDelete: vi.fn().mockReturnValue({
            pollUntilDone: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      azure.computeClient = fakeSdkClient(mockComputeClient as any);
      azure.networkClient = fakeSdkClient(mockNetworkClient as any);

      // Should not throw even though VM tagging failed
      const terminatePromise = azure['terminateVM']('test-vm');

      // Fast-forward through all timers (retries with exponential backoff)
      await vi.runAllTimersAsync();

      await expect(terminatePromise).resolves.not.toThrow();

      // Verify deletion still proceeded
      expect(mockComputeClient.virtualMachines.beginDelete).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});

describe('Azure.checkVMStatus', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus2',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  function mockAzure(
    statuses: { code?: string; message?: string }[],
    ipAddress?: string,
    provisioningState?: string,
  ) {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const compute = {
      virtualMachines: {
        get: vi.fn().mockResolvedValue({
          provisioningState,
          instanceView: { statuses },
        }),
      },
    };
    azure.computeClient = fakeSdkClient(
      compute as unknown as typeof azure.computeClient,
    );
    const network = {
      publicIPAddresses: {
        get: vi.fn().mockResolvedValue({ ipAddress: ipAddress ?? '10.0.0.1' }),
      },
    };
    azure.networkClient = fakeSdkClient(
      network as unknown as typeof azure.networkClient,
    );
    return azure;
  }

  it('returns ready when ProvisioningState/succeeded + PowerState/running', async () => {
    const azure = mockAzure([
      { code: 'ProvisioningState/succeeded' },
      { code: 'PowerState/running' },
    ]);
    const result = await azure.checkVMStatus('test-vm');
    expect(result.status).toBe('ready');
    expect(result.ip).toBe('10.0.0.1');
  });

  it('returns ready when only PowerState/running (no ProvisioningState)', async () => {
    const azure = mockAzure([{ code: 'PowerState/running' }]);
    const result = await azure.checkVMStatus('test-vm');
    expect(result.status).toBe('ready');
  });

  it('returns waiting when no statuses yet', async () => {
    const azure = mockAzure([]);
    const result = await azure.checkVMStatus('test-vm');
    expect(result.status).toBe('waiting');
  });

  it('throws on ProvisioningState/failed', async () => {
    const azure = mockAzure([
      {
        code: 'ProvisioningState/failed',
        message: 'Allocation failed. OverconstrainedAllocationRequest.',
      },
    ]);
    await expect(azure.checkVMStatus('test-vm')).rejects.toThrow(
      'VM test-vm provisioning failed: Allocation failed',
    );
  });

  it('throws on a nested provisioning failure code returned by Azure', async () => {
    const azure = mockAzure([
      {
        code: 'ProvisioningState/failed/OverconstrainedAllocationRequest',
        message:
          'Allocation failed because the constraints are too restrictive.',
      },
    ]);
    await expect(azure.checkVMStatus('test-vm')).rejects.toMatchObject({
      name: 'AzureVMStatusError',
      code: 'AzureVMStatusError',
      provisioningState: 'failed',
      provisioningErrorCode: 'OverconstrainedAllocationRequest',
    });
  });

  it('falls back to the resource-level provisioning state', async () => {
    const azure = mockAzure([], undefined, 'Failed');
    await expect(azure.checkVMStatus('test-vm')).rejects.toMatchObject({
      name: 'AzureVMStatusError',
      provisioningState: 'failed',
    });
  });

  it('keeps a resource-level failure when the instance view still reads succeeded', async () => {
    const azure = mockAzure(
      [{ code: 'ProvisioningState/succeeded' }, { code: 'PowerState/running' }],
      undefined,
      'Failed',
    );
    await expect(azure.checkVMStatus('test-vm')).rejects.toMatchObject({
      name: 'AzureVMStatusError',
      provisioningState: 'failed',
      powerState: 'running',
    });
  });

  it('lets an instance-view failure override a succeeded resource state', async () => {
    const azure = mockAzure(
      [
        {
          code: 'ProvisioningState/failed/AllocationFailed',
          message: 'Allocation failed.',
        },
        { code: 'PowerState/running' },
      ],
      undefined,
      'Succeeded',
    );
    await expect(azure.checkVMStatus('test-vm')).rejects.toMatchObject({
      name: 'AzureVMStatusError',
      provisioningState: 'failed',
      provisioningErrorCode: 'AllocationFailed',
    });
  });

  it('throws on ProvisioningState/failed even with PowerState/running', async () => {
    const azure = mockAzure([
      { code: 'ProvisioningState/failed', message: 'Allocation failed.' },
      { code: 'PowerState/running' },
    ]);
    await expect(azure.checkVMStatus('test-vm')).rejects.toThrow(
      'VM test-vm provisioning failed',
    );
  });

  it('returns waiting when PowerState/unknown (transient during boot)', async () => {
    const azure = mockAzure([{ code: 'PowerState/unknown' }]);
    const result = await azure.checkVMStatus('test-vm');
    expect(result.status).toBe('waiting');
  });

  it('returns waiting when ProvisioningState/succeeded + PowerState/unknown', async () => {
    const azure = mockAzure([
      { code: 'ProvisioningState/succeeded' },
      { code: 'PowerState/unknown' },
    ]);
    const result = await azure.checkVMStatus('test-vm');
    expect(result.status).toBe('waiting');
  });

  it('throws on terminal PowerState (stopped)', async () => {
    const azure = mockAzure([{ code: 'PowerState/stopped' }]);
    await expect(azure.checkVMStatus('test-vm')).rejects.toMatchObject({
      name: 'AzureVMStatusError',
      code: 'AzureVMStatusError',
      powerState: 'stopped',
      vmStatus: 'failed',
    });
  });

  it('throws a structured status error when provisioning succeeds but VM is stopped', async () => {
    const azure = mockAzure([
      { code: 'ProvisioningState/succeeded' },
      { code: 'PowerState/stopped' },
    ]);
    await expect(azure.checkVMStatus('test-vm')).rejects.toMatchObject({
      name: 'AzureVMStatusError',
      code: 'AzureVMStatusError',
      powerState: 'stopped',
      provisioningState: 'succeeded',
      vmStatus: 'stopped',
    });
  });
});

describe('Azure.verifyVMPreemption', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus2',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  it.each([
    ['stopped'],
    ['stopping'],
    ['starting'],
    ['deallocated'],
    ['deallocating'],
    ['failed'],
    ['unknown'],
  ])(
    'returns true for power state "%s" (anything non-running is preempted)',
    async (powerState) => {
      const azure = new Azure(completeCloudConfig(mockConfig));
      stubComputeClient(
        azure,
        vi.fn().mockResolvedValue({
          instanceView: { statuses: [{ code: `PowerState/${powerState}` }] },
        }),
      );
      expect(
        await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
      ).toBe(true);
    },
  );

  it('returns false when VM is not found', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubComputeClient(azure, vi.fn().mockRejectedValue({ statusCode: 404 }));
    expect(
      await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
    ).toBe(false);
  });

  it('returns true when power state is null (Azure omits PowerState for deallocated VMs)', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubComputeClient(
      azure,
      vi.fn().mockResolvedValue({
        instanceView: { statuses: [{ code: 'ProvisioningState/succeeded' }] },
      }),
    );
    expect(
      await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
    ).toBe(true);
  });

  it('returns false when VM is running', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubComputeClient(
      azure,
      vi.fn().mockResolvedValue({
        instanceView: {
          statuses: [{ code: 'PowerState/running' }],
        },
      }),
    );
    expect(
      await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
    ).toBe(false);
  });

  it('returns true when provisioning failed (e.g. OverconstrainedAllocationRequest)', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubComputeClient(
      azure,
      vi.fn().mockResolvedValue({
        instanceView: {
          statuses: [
            {
              code: 'ProvisioningState/failed',
              message: 'Allocation failed.',
            },
          ],
        },
      }),
    );
    expect(
      await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
    ).toBe(true);
  });

  it('returns true when provisioning failed even with PowerState/running', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubComputeClient(
      azure,
      vi.fn().mockResolvedValue({
        instanceView: {
          statuses: [
            {
              code: 'ProvisioningState/failed',
              message: 'Allocation failed.',
            },
            { code: 'PowerState/running' },
          ],
        },
      }),
    );
    expect(
      await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
    ).toBe(true);
  });

  it('returns false when VM state check retry exhausts attempts', async () => {
    const utilsModule = await import('../../../../src/shared/utils');
    const withRetrySpy = vi
      .spyOn(utilsModule, 'withRetry')
      .mockRejectedValue(
        new Error('Azure VM state check for test-vm failed after 3 attempts'),
      );

    try {
      const azure = new Azure(completeCloudConfig(mockConfig));
      expect(
        await requirePreemptible(azure.compute()).verifyVMPreemption('test-vm'),
      ).toBe(false);
    } finally {
      withRetrySpy.mockRestore();
    }
  });
});

describe('Azure.startVM', () => {
  function vmState(
    powerState: string | null,
    provisioningState = 'succeeded',
    failureCode?: string,
  ): VirtualMachine {
    return {
      location: 'eastus2',
      provisioningState,
      instanceView: {
        statuses: [
          {
            code: `ProvisioningState/${provisioningState}${failureCode ? `/${failureCode}` : ''}`,
          },
          ...(powerState ? [{ code: `PowerState/${powerState}` }] : []),
        ],
      },
    };
  }

  // Model the lost start measured by the live probe: Azure accepts an early
  // request but eviction supersedes it. Only a request after eviction ends
  // changes the VM's power state. Observations depend on time and provider
  // state, not a prescribed sequence of SDK calls.
  function restartableAzure(
    options: {
      evictionMs?: number;
      observe?: (
        elapsedMs: number,
        sinceStartMs: number | null,
      ) => VirtualMachine;
      ip?: string | null;
    } = {},
  ) {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus2',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: '12345678-1234-1234-1234-123456789012',
          directoryId: 'test-directory-id',
          applicationId: 'test-app-id',
          secret: 'test-secret',
        },
      }),
    );
    const base = Date.now();
    const evictionMs = options.evictionMs ?? 0;
    const starts: number[] = [];
    let effectiveStartAt: number | null = null;
    const vmGet = vi.fn(
      async (
        _group: string,
        _id: string,
        _options?: { abortSignal?: AbortSignal },
      ) => {
        const elapsed = Date.now() - base;
        if (options.observe) {
          return options.observe(
            elapsed,
            effectiveStartAt === null ? null : elapsed - effectiveStartAt,
          );
        }
        return vmState(
          effectiveStartAt !== null
            ? 'running'
            : elapsed < evictionMs
              ? 'starting'
              : 'deallocated',
        );
      },
    );
    const ipGet = vi.fn(
      async (
        _group: string,
        _id: string,
        _options?: { abortSignal?: AbortSignal },
      ) => ({ ipAddress: options.ip === undefined ? '10.0.0.1' : options.ip }),
    );
    const pollUntilDone = vi.fn(
      async (_options?: { abortSignal?: AbortSignal }) => {},
    );
    const beginStart = vi.fn(
      async (
        _group: string,
        _id: string,
        _options?: { abortSignal?: AbortSignal },
      ) => {
        const elapsed = Date.now() - base;
        starts.push(elapsed);
        if (elapsed >= evictionMs) effectiveStartAt = elapsed;
        return { pollUntilDone };
      },
    );
    azure.computeClient = fakeSdkClient({
      virtualMachines: { get: vmGet, beginStart },
    });
    azure.networkClient = fakeSdkClient({
      publicIPAddresses: { get: ipGet },
    });
    return { azure, vmGet, ipGet, beginStart, pollUntilDone, starts };
  }

  async function recover(harness: ReturnType<typeof restartableAzure>) {
    const pending = requirePreemptible(harness.azure.compute()).startVM(
      'test-vm',
    );
    await vi.runAllTimersAsync();
    return pending;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers in place when Azure would discard a start during eviction', async () => {
    const harness = restartableAzure({ evictionMs: 12_000 });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.starts).toHaveLength(1);
    expect(harness.starts[0]).toBeGreaterThanOrEqual(22_000);
  });

  it('resets the three settled observations after a transient power state', async () => {
    const harness = restartableAzure({
      observe: (elapsed, started) =>
        vmState(
          started !== null
            ? 'running'
            : elapsed === 10_000
              ? 'deallocating'
              : 'deallocated',
        ),
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.starts).toEqual([25_000]);
  });

  it('does not mistake one stale running observation for completed recovery', async () => {
    const harness = restartableAzure({
      evictionMs: 12_000,
      observe: (elapsed, started) =>
        vmState(
          started !== null || elapsed < 5_000
            ? 'running'
            : elapsed < 12_000
              ? 'starting'
              : 'deallocated',
        ),
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.starts).toHaveLength(1);
    expect(harness.starts[0]).toBeGreaterThanOrEqual(22_000);
  });

  it('returns an already-running VM only after three ready observations without starting it', async () => {
    const harness = restartableAzure({ observe: () => vmState('running') });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.beginStart).not.toHaveBeenCalled();
    expect(Date.now()).toBe(10_000);
  });

  it('tolerates deallocated and stale failed provisioning reads after an accepted start', async () => {
    const harness = restartableAzure({
      observe: (_elapsed, started) => {
        if (started === null) return vmState('deallocated');
        if (started < 15_000)
          return vmState('deallocated', 'failed', 'AllocationFailed');
        return vmState('running');
      },
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.starts).toHaveLength(1);
    expect(Date.now() - harness.starts[0]).toBeGreaterThanOrEqual(25_000);
  });

  it('resets readiness after the VM briefly stops again', async () => {
    const harness = restartableAzure({
      observe: (_elapsed, started) =>
        vmState(
          started === null
            ? 'deallocated'
            : started === 10_000
              ? 'stopped'
              : 'running',
        ),
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(Date.now() - harness.starts[0]).toBe(25_000);
    expect(harness.starts).toHaveLength(1);
  });

  it.each([
    null,
    'unknown',
    'unrecognized',
    'starting',
    'stopping',
    'deallocating',
  ])(
    'does not authorize a start from persistently unsettled power state %s',
    async (powerState) => {
      const harness = restartableAzure({ observe: () => vmState(powerState) });
      await expect(recover(harness)).resolves.toBeNull();
      expect(harness.beginStart).not.toHaveBeenCalled();
      expect(Date.now()).toBe(180_000);
    },
  );

  it.each(
    [
      'AllocationFailed',
      'OverconstrainedAllocationRequest',
      'ZonalAllocationFailed',
      'OverconstrainedZonalAllocationRequest',
    ].flatMap((code) =>
      [null, 'deallocated'].map((powerState) => ({ code, powerState })),
    ),
  )(
    'restarts an existing VM after $code with power state $powerState',
    async ({ code, powerState }) => {
      const harness = restartableAzure({
        observe: (_elapsed, started) =>
          started === null
            ? vmState(powerState, 'failed', code)
            : vmState('running'),
      });
      await expect(recover(harness)).resolves.toBe('10.0.0.1');
      expect(harness.starts).toEqual([10_000]);
    },
  );

  it('does not start through an allocation failure while eviction is still transitioning', async () => {
    const harness = restartableAzure({
      evictionMs: 12_000,
      observe: (elapsed, started) =>
        started !== null
          ? vmState('running')
          : vmState(
              elapsed < 12_000 ? 'deallocating' : null,
              'failed',
              'AllocationFailed',
            ),
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.starts[0]).toBeGreaterThanOrEqual(22_000);
  });

  it('does not authorize a start from an unexplained failed provisioning state', async () => {
    const harness = restartableAzure({
      observe: () => vmState(null, 'failed'),
    });
    await expect(recover(harness)).resolves.toBeNull();
    expect(harness.beginStart).not.toHaveBeenCalled();
  });

  it('uses the stopped power state even when provisioning state is omitted', async () => {
    const harness = restartableAzure({
      observe: (_elapsed, started) => ({
        location: 'eastus2',
        instanceView: {
          statuses: [
            { code: `PowerState/${started === null ? 'stopped' : 'running'}` },
          ],
        },
      }),
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(harness.starts).toEqual([10_000]);
  });

  it.each([
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('rate limited'), { statusCode: 429 }),
    Object.assign(new Error('service unavailable'), { statusCode: 503 }),
  ])(
    'resets settled observations across a transient read error: %s',
    async (error) => {
      const harness = restartableAzure({
        observe: (elapsed, started) => {
          if (elapsed === 10_000) throw error;
          return vmState(started === null ? 'deallocated' : 'running');
        },
      });
      await expect(recover(harness)).resolves.toBe('10.0.0.1');
      expect(harness.starts).toEqual([25_000]);
    },
  );

  it.each([
    Object.assign(new Error('VM missing'), {
      code: 'ResourceNotFound',
      statusCode: 404,
    }),
    Object.assign(new Error('role removed'), {
      code: 'AuthorizationFailed',
      statusCode: 403,
    }),
    Object.assign(new Error('invalid request'), { statusCode: 400 }),
  ])(
    'falls back without starting on a durable read failure: %s',
    async (error) => {
      const harness = restartableAzure({
        observe: () => {
          throw error;
        },
      });
      await expect(recover(harness)).resolves.toBeNull();
      expect(harness.beginStart).not.toHaveBeenCalled();
      expect(harness.vmGet).toHaveBeenCalledTimes(1);
    },
  );

  it('falls back on an explicit start rejection without reissuing it', async () => {
    const harness = restartableAzure();
    harness.beginStart.mockRejectedValue(
      Object.assign(new Error('no capacity'), { code: 'AllocationFailed' }),
    );
    await expect(recover(harness)).resolves.toBeNull();
    expect(harness.beginStart).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(10_000);
  });

  it('does not turn repeated observation failures into permission to start', async () => {
    const harness = restartableAzure({
      observe: () => {
        throw Object.assign(new Error('unavailable'), { statusCode: 503 });
      },
    });
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(180_000);
    expect(harness.beginStart).not.toHaveBeenCalled();
  });

  it('falls back if the VM disappears after the start operation completes', async () => {
    const harness = restartableAzure({
      observe: (_elapsed, started) => {
        if (started !== null)
          throw Object.assign(new Error('VM missing'), { statusCode: 404 });
        return vmState('deallocated');
      },
    });
    await expect(recover(harness)).resolves.toBeNull();
    expect(harness.starts).toHaveLength(1);
    expect(Date.now()).toBe(10_000);
  });

  it('resets ready observations after a transient read failure', async () => {
    const harness = restartableAzure({
      observe: (_elapsed, started) => {
        if (started === 10_000)
          throw Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET',
          });
        return vmState(started === null ? 'deallocated' : 'running');
      },
    });
    await expect(recover(harness)).resolves.toBe('10.0.0.1');
    expect(Date.now() - harness.starts[0]).toBe(25_000);
  });

  it('bounds an accepted start that never becomes ready by the total five-minute deadline', async () => {
    const harness = restartableAzure({ observe: () => vmState('deallocated') });
    await expect(recover(harness)).resolves.toBeNull();
    expect(harness.starts).toHaveLength(1);
    expect(Date.now()).toBe(300_000);
  });

  it('requires a public IP as well as running power state after start', async () => {
    const harness = restartableAzure({ ip: null });
    await expect(recover(harness)).resolves.toBeNull();
    expect(harness.starts).toHaveLength(1);
    expect(Date.now()).toBe(300_000);
  });

  it('does not restart the readiness budget after a slow successful start operation', async () => {
    const harness = restartableAzure({ observe: () => vmState('deallocated') });
    harness.pollUntilDone.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 200_000);
        }),
    );
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(300_000);
    expect(harness.starts).toHaveLength(1);
  });

  it('aborts a hung observation at the settle deadline without issuing a late start', async () => {
    const harness = restartableAzure();
    let resolveRead!: (vm: VirtualMachine) => void;
    harness.vmGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(180_000);
    expect(harness.vmGet.mock.calls[0][2]?.abortSignal?.aborted).toBe(true);
    resolveRead(vmState('deallocated'));
    await vi.runAllTimersAsync();
    expect(harness.beginStart).not.toHaveBeenCalled();
    expect(harness.vmGet).toHaveBeenCalledTimes(1);
  });

  it('includes a hung start operation in the total deadline and aborts SDK polling', async () => {
    const harness = restartableAzure();
    let finishPoll!: () => void;
    harness.pollUntilDone.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPoll = resolve;
        }),
    );
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(300_000);
    expect(harness.pollUntilDone.mock.calls[0][0]?.abortSignal?.aborted).toBe(
      true,
    );
    const reads = harness.vmGet.mock.calls.length;
    finishPoll();
    await vi.runAllTimersAsync();
    expect(harness.vmGet).toHaveBeenCalledTimes(reads);
    expect(harness.starts).toHaveLength(1);
  });

  it('does not accept the last settled observation if it arrives at the settle deadline', async () => {
    const harness = restartableAzure({
      observe: (elapsed) =>
        vmState(elapsed < 165_000 ? 'starting' : 'deallocated'),
    });
    const read = harness.vmGet.getMockImplementation()!;
    harness.vmGet.mockImplementation(async (...args) => {
      const result = await read(...args);
      if (Date.now() === 175_000)
        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
      return result;
    });
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(180_000);
    expect(harness.beginStart).not.toHaveBeenCalled();
  });

  it('aborts a hung beginStart request without starting late SDK polling', async () => {
    const harness = restartableAzure();
    let acceptStart!: (poller: {
      pollUntilDone: typeof harness.pollUntilDone;
    }) => void;
    harness.beginStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          acceptStart = resolve;
        }),
    );
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(300_000);
    expect(harness.beginStart.mock.calls[0][2]?.abortSignal?.aborted).toBe(
      true,
    );
    acceptStart({ pollUntilDone: harness.pollUntilDone });
    await vi.runAllTimersAsync();
    expect(harness.pollUntilDone).not.toHaveBeenCalled();
    expect(harness.beginStart).toHaveBeenCalledTimes(1);
  });

  it('bounds and aborts a public-IP read that hangs after the VM starts', async () => {
    const harness = restartableAzure();
    harness.ipGet.mockImplementation(() => new Promise(() => {}));
    await expect(recover(harness)).resolves.toBeNull();
    expect(Date.now()).toBe(300_000);
    expect(harness.ipGet.mock.calls[0][2]?.abortSignal?.aborted).toBe(true);
    expect(harness.starts).toHaveLength(1);
  });
});

describe('Azure.observeVMReleaseOnce', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus2',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  };

  it('reports not-found as terminated without preparing infrastructure', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const get = vi.fn().mockRejectedValue({ statusCode: 404 });
    stubComputeClient(azure, get);
    const upsertResourceGroup = vi.spyOn(azure as any, 'upsertResourceGroup');
    const registerResourceProviders = vi.spyOn(
      azure as any,
      'registerResourceProviders',
    );
    const ensureStorageAccount = vi.spyOn(azure as any, 'ensureStorageAccount');

    await expect(azure.compute().observeVMReleaseOnce('test-vm')).resolves.toBe(
      VM_RELEASE_CANDIDATE,
    );

    expect(get).toHaveBeenCalledOnce();
    expect(upsertResourceGroup).not.toHaveBeenCalled();
    expect(registerResourceProviders).not.toHaveBeenCalled();
    expect(ensureStorageAccount).not.toHaveBeenCalled();
  });

  it('reports an existing VM as alive without preparing infrastructure', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    stubComputeClient(azure, vi.fn().mockResolvedValue({ id: 'test-vm' }));
    const ensureRegionalInfrastructure = vi.spyOn(
      azure as any,
      'ensureRegionalInfrastructure',
    );
    const ensureStorageInfrastructure = vi.spyOn(
      azure as any,
      'ensureStorageInfrastructure',
    );

    await expect(azure.compute().observeVMReleaseOnce('test-vm')).resolves.toBe(
      VM_PRESENT,
    );

    expect(ensureRegionalInfrastructure).not.toHaveBeenCalled();
    expect(ensureStorageInfrastructure).not.toHaveBeenCalled();
  });

  it('reports a canceled check as unknown', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const controller = new AbortController();
    controller.abort(new Error('status deadline exceeded'));

    await expect(
      azure
        .compute()
        .observeVMReleaseOnce('test-vm', { signal: controller.signal }),
    ).resolves.toEqual({
      state: 'unknown',
      error: 'status deadline exceeded',
    });
  });

  it('preserves a definitive not-found response that arrives during cancellation', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const controller = new AbortController();
    stubComputeClient(
      azure,
      vi.fn().mockImplementation(async () => {
        controller.abort(new Error('status deadline exceeded'));
        throw { statusCode: 404 };
      }),
    );

    await expect(
      azure
        .compute()
        .observeVMReleaseOnce('test-vm', { signal: controller.signal }),
    ).resolves.toBe(VM_RELEASE_CANDIDATE);
  });
});

describe('Azure error classification', () => {
  describe('classifyError', () => {
    const instance = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus2',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: '12345678-1234-1234-1234-123456789012',
          directoryId: 'test-dir',
          applicationId: 'test-app',
          secret: 'test-secret',
        },
      }),
    );

    it('returns Transient for null input', () => {
      expect(instance.compute().classifyError(null)).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });

    it('returns Transient for non-object input', () => {
      expect(instance.compute().classifyError('string')).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });

    it('returns Transient when code is missing', () => {
      expect(instance.compute().classifyError({})).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });

    it('returns Transient when code is non-string', () => {
      expect(instance.compute().classifyError({ code: 123 })).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });

    it('classifies QuotaExceeded code as QuotaExhaustedRegion', () => {
      expect(instance.compute().classifyError({ code: 'QuotaExceeded' })).toBe(
        CloudFailureDiagnosis.QuotaExhaustedRegion,
      );
    });

    it('classifies the LowPriorityCores spot-pool cap as AccountRegionalSpotQuotaExhausted', () => {
      expect(
        instance.compute().classifyError({
          code: 'OperationNotAllowed',
          message:
            'Operation could not be completed as it results in exceeding approved LowPriorityCores quota',
        }),
      ).toBe(CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted);
    });

    it('classifies a LowPriorityCores cap with Current Limit: 0 as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'OperationNotAllowed',
          message:
            'Operation could not be completed as it results in exceeding approved LowPriorityCores quota. Current Limit: 0.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('keeps per-family quota messages scoped to the region', () => {
      expect(
        instance.compute().classifyError({
          code: 'OperationNotAllowed',
          message:
            'Operation could not be completed as it results in exceeding approved standardNCASt4v3Family Cores quota',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies OperationNotAllowed with quota message as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'OperationNotAllowed',
          message: 'Operation results in exceeding quota limit',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies OperationNotAllowed with limit exceeded message as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'OperationNotAllowed',
          message: 'Regional vCPU limit exceeded for this subscription',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies OperationNotAllowed without quota message as Transient', () => {
      expect(
        instance.compute().classifyError({
          code: 'OperationNotAllowed',
          message: 'Some other operation error',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies public IP address limit as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'PublicIPCountLimitReached',
          message:
            'Cannot create more than 100 public IP addresses for this subscription in this region.',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('routes a captured public-IP quota failure to regional failover when unpinned', () => {
      const diagnosis = instance.compute().classifyError({
        code: 'PublicIPCountLimitReached',
        message:
          'Cannot create more than 100 public IP addresses for this subscription in this region.',
      });

      expect(resolveProvisioningFailureDisposition(diagnosis, undefined)).toBe(
        FailureDisposition.FailoverTarget,
      );
    });

    it('classifies SkuNotAvailable without capacity as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'SkuNotAvailable',
          message: 'not available',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
      expect(catalogOverlayInvalidateMock).toHaveBeenCalledWith(
        'SkuNotAvailable',
        'eastus2',
      );
    });

    it('classifies a premium-disk / VM-size mismatch as InvalidRequest (region-invariant config error, terminal, no target block)', () => {
      expect(
        instance.compute().classifyError({
          code: 'BadRequest',
          message:
            "Storage account type 'Premium_LRS' is not supported for VM size 'Standard_NC6'.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('classifies SkuNotAvailable with capacity as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          code: 'SkuNotAvailable',
          message: 'no capacity',
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies AllocationFailed as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({ code: 'AllocationFailed' }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies OverconstrainedAllocationRequest as CapacityExhausted', () => {
      expect(
        instance
          .compute()
          .classifyError({ code: 'OverconstrainedAllocationRequest' }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies a nested instance-view provisioning code as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          code: 'AzureVMStatusError',
          provisioningState: 'failed',
          provisioningErrorCode: 'OverconstrainedAllocationRequest',
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it.each(['stopped', 'deallocated', 'PowerState/stopped'])(
      'classifies structured Azure powerState %s as CapacityExhausted',
      (powerState) => {
        expect(
          instance.compute().classifyError({
            code: 'AzureVMStatusError',
            powerState,
            vmStatus: 'failed',
          }),
        ).toBe(CloudFailureDiagnosis.CapacityExhausted);
      },
    );

    it('does not classify message-only powerState text as CapacityExhausted', () => {
      expect(
        instance
          .compute()
          .classifyError(
            new Error(
              'VM mh1d3-bt-200t300-0 provisioning failed: powerState=stopped',
            ),
          ),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies LocationNotAvailableForResourceType as InvalidTarget', () => {
      expect(
        instance
          .compute()
          .classifyError({ code: 'LocationNotAvailableForResourceType' }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies InvalidParameter with "not available in current region" as InvalidTarget', () => {
      // Azure returns SKU/region mismatches under InvalidParameter, not just
      // SkuNotAvailable. Message-pattern matching keeps the optimizer retrying
      // other regions instead of terminating the workload.
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameter',
          message:
            'The requested VM size Standard_NC40ads_H100_v5 is not available in the current region. The sizes available in the current region are: ...',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies BadRequest "not supported in this location" as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'BadRequest',
          message: 'VM size is not supported in this location.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies "VM size is not valid" message as InvalidTarget', () => {
      // A nonexistent/typo'd VM size comes back under a generic code with this
      // distinct "...is not valid" shape (not "not available in <region>"). A
      // pinned region escalates it to terminal Invalid (see classifier comment).
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameter',
          message:
            'The value totally_fake_nonexistent_vm provided for the VM size is not valid. The valid sizes in the current region are: Standard_L...',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies generic InvalidParameter as Transient (fail-open)', () => {
      // InvalidParameter is too generic to be terminal — Azure uses it for
      // both real input errors AND region/SKU mismatches. Fall through to
      // Transient so a missed region-phrase regex (see above) doesn't send
      // the workload to terminal Invalid. Real config bugs still surface
      // after bounded retries exhaust.
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameter',
          message: 'The provided value is invalid.',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies exceeding approved quota message (non-OperationNotAllowed) as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'SomeOtherCode',
          message: 'exceeding approved StandardDSv3Family Cores quota',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it.each([
      'InvalidAuthenticationToken',
      'InvalidAuthenticationTokenTenant',
      'ExpiredAuthenticationToken',
    ])('classifies %s as BadCredential', (code) => {
      expect(instance.compute().classifyError({ code })).toBe(
        CloudFailureDiagnosis.BadCredential,
      );
    });

    it('0047 invariant 3: AuthorizationFailed is PermissionDenied naming the action', () => {
      const error = {
        name: 'RestError',
        code: AZURE_AUTHORIZATION_FAILED.code,
        statusCode: AZURE_AUTHORIZATION_FAILED.httpStatus,
        message: AZURE_AUTHORIZATION_FAILED.message,
      };
      const compute = instance.compute();
      expect(compute.classifyError(error)).toBe(
        CloudFailureDiagnosis.PermissionDenied,
      );
      expect(compute.permissionDenial?.(error)).toEqual({
        action: AZURE_AUTHORIZATION_FAILED.action,
        regional: false,
      });
      expect(
        compute.permissionDenial?.({
          name: 'RestError',
          message: 'AADSTS7000215: Invalid client secret provided.',
        }),
      ).toBeUndefined();
    });

    it('classifies a nonexistent Entra directory as InvalidRequest', () => {
      expect(
        instance.compute().classifyError({
          name: 'AuthenticationRequiredError',
          message:
            "invalid_request: AADSTS90002: Tenant 'not-a-real-directory' not found.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('classifies a nonexistent subscription as InvalidRequest', () => {
      expect(
        instance.compute().classifyError({
          code: 'SubscriptionNotFound',
          statusCode: 404,
          message:
            "The subscription '00000000-0000-0000-0000-000000000000' could not be found.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it.each([
      'AADSTS7000215: Invalid client secret provided.',
      'AADSTS7000222: The provided client secret keys for app are expired.',
      'invalid_client error returned from the token endpoint',
    ])(
      'classifies a rotated/expired client secret (%s) as BadCredential',
      (message) => {
        // @azure/identity throws with the AADSTS/invalid_client signal in the
        // message; `code` is the error name, not an ARM code.
        expect(
          instance.compute().classifyError({ name: 'RestError', message }),
        ).toBe(CloudFailureDiagnosis.BadCredential);
      },
    );

    it('classifies AuthorizationPermissionMismatch (code) as InvalidRequest', () => {
      // Storage data-plane RBAC gap → terminal config problem, NOT BadCredential
      // (must not report the selected compute credential as unhealthy).
      expect(
        instance.compute().classifyError({
          code: 'AuthorizationPermissionMismatch',
          statusCode: 403,
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('classifies AuthorizationPermissionMismatch in an rclone SSH-exec error message as InvalidRequest', () => {
      expect(
        instance
          .compute()
          .classifyError(
            new Error(
              'Command exited with code 1: AuthorizationPermissionMismatch: This request is not authorized to perform this operation using this permission. (example-outputs/.rclone-keep)',
            ),
          ),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('classifies NVIDIA runtime driver incompatibility as InvalidRequest', () => {
      const message = [
        'Failed to start container on 203.0.113.40: Command exited with code 125:',
        'docker: Error response from daemon: failed to create shim task:',
        'OCI runtime create failed: runc create failed:',
        'unable to start container process: error during container init:',
        "error running hook #0: error running hook: exit status 1, stdout: , stderr: Auto-detected mode as 'legacy'",
        'nvidia-container-cli: requirement error: unsatisfied condition: cuda>=12.4,',
        'please update your driver to a newer version, or use an earlier cuda container: unknown.',
      ].join('\n');

      expect(instance.compute().classifyError(new Error(message))).toBe(
        CloudFailureDiagnosis.InvalidRequest,
      );
    });

    it.each([
      'InvalidSubscriptionId',
      'InvalidStorageAccountName',
      'StorageAccountAlreadyExists',
      'InvalidResourceName',
      'ReadOnlyDisabledSubscription',
    ])('classifies %s as UserError', (code) => {
      expect(instance.compute().classifyError({ code })).toBe(
        CloudFailureDiagnosis.InvalidRequest,
      );
    });

    it('classifies Azure validation errors (is invalid + must conform to) as UserError', () => {
      expect(
        instance.compute().classifyError({
          code: 'WorkloadFailed',
          message:
            'The domain name label foo-BAR-0 is invalid. It must conform to the following regular expression: ^[a-z][a-z0-9-]{1,61}[a-z0-9]$.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('classifies Azure resource name validation errors as UserError', () => {
      expect(
        instance.compute().classifyError({
          code: 'SomeCode',
          message:
            'The value XYZ is invalid. It must conform to the following regular expression: ^[a-z0-9]+$.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('does not classify generic error messages as UserError', () => {
      expect(
        instance.compute().classifyError({
          code: 'InternalError',
          message: 'An internal server error occurred',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies ProvisioningDisabled as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'ProvisioningDisabled',
          message:
            'Provisioning is restricted in this region. Please choose a different region.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies LocationIsOfferRestricted as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'LocationIsOfferRestricted',
          message:
            "Subscription 'foo' is not allowed to provision in 'East US'.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies SubscriptionNotAllowedForAccessInLocation as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'SubscriptionNotAllowedForAccessInLocation',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies RequestDisallowedByAzure with region message as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'RequestDisallowedByAzure',
          message:
            'This policy maintains a set of best available regions. Please deploy to an allowed region.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies RequestDisallowedByAzure without region mention as Transient', () => {
      expect(
        instance.compute().classifyError({
          code: 'RequestDisallowedByAzure',
          message: 'This operation is blocked by policy.',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies DisallowedLocation as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'DisallowedLocation',
          message:
            "The provided location 'jioindiawest' is not permitted for subscription. Please contact support to change your supported regions.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies LocationNotAvailableForResourceGroup as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'LocationNotAvailableForResourceGroup',
          message:
            "The provided location 'jioindiacentral' is not available for resource group.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies QuotaExceeded with "Current Limit: 0" as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'QuotaExceeded',
          message:
            'Operation could not be completed as it results in exceeding approved standardNCADSA100v4Family quota. Current Limit: 0.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies QuotaExceeded with "Current Limit: 32" as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'QuotaExceeded',
          message:
            'Operation could not be completed as it results in exceeding approved standardNCADSA100v4Family quota. Current Limit: 32.',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies unknown errors as Transient', () => {
      expect(instance.compute().classifyError({ code: 'SomethingElse' })).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });
  });
});

describe('Azure storage sweep', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      cloudProvider: CloudType.Azure,
      subscriptionId: '11111111-2222-3333-4444-555555555555',
      directoryId: 'tenant',
      applicationId: 'app',
      secret: 'secret',
    },
  };

  // Build a fake async iterator over a fixed list of containers.
  function fakeListContainers(
    containers: Array<{
      name: string;
      metadata?: Record<string, string>;
      lastModified?: Date;
    }>,
  ) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of containers) {
          yield {
            name: c.name,
            metadata: c.metadata,
            properties: { lastModified: c.lastModified ?? new Date(0) },
          };
        }
      },
    };
  }

  function installFakeBlobService(
    containers: Array<{
      name: string;
      metadata?: Record<string, string>;
      lastModified?: Date;
    }>,
    options: { deleteFailures?: Record<string, Error> } = {},
  ) {
    const containerClients = new Map<
      string,
      {
        exists: ReturnType<typeof vi.fn>;
        getProperties: ReturnType<typeof vi.fn>;
        setMetadata: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
      }
    >();
    const getContainerClient = vi.fn((name: string) => {
      let client = containerClients.get(name);
      if (!client) {
        client = {
          exists: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
          getProperties: vi.fn().mockResolvedValue({ metadata: {} }),
          setMetadata: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockImplementation(async () => {
            const failure = options.deleteFailures?.[name];
            if (failure) throw failure;
          }),
        };
        containerClients.set(name, client);
      }
      return client;
    });
    const listContainers = vi
      .fn()
      .mockReturnValue(fakeListContainers(containers));
    const fakeBlobService = { listContainers, getContainerClient };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return fakeBlobService as never;
    });
    return { containerClients, getContainerClient, listContainers };
  }

  function markStoragePresent(azure: Azure): void {
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue({
      resourceGroup: 'anycloud-storage',
      account: { id: 'storage-account-id', location: 'eastus' },
    });
  }

  it('only deletes containers tagged anycloud_deployment AND orphan-eligible', async () => {
    vi.mocked(StorageSharedKeyCredential).mockClear();
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({}); // skip initializeAzure
    markStoragePresent(azure);

    const { containerClients } = installFakeBlobService([
      // Skip: no anycloud_deployment tag
      { name: 'no-tags', metadata: {} },
      // Skip: customer-owned (not in TEST_USERNAMES, not old enough heuristic)
      {
        name: 'customer-vol',
        metadata: {
          anycloud_deployment: 'cust-dep',
          anycloud_user: 'realuser',
          anycloud_created_at: String(Date.now()),
        },
      },
      // Delete: ended_at marker is set
      {
        name: 'ended-test-bucket',
        metadata: {
          anycloud_deployment: 'test-dep',
          anycloud_user: 'anycloud-test',
          anycloud_ended_at: '1234',
        },
      },
      // Delete: anycloud-test user + old created_at
      {
        name: 'old-test-bucket',
        metadata: {
          anycloud_deployment: 'old-dep',
          anycloud_user: 'anycloud-test',
          anycloud_created_at: '1', // ~Jan 1970, way older than 3h
        },
      },
    ]);

    const result = await sweepAzureStorage(azure);
    expect(
      containerClients.get('ended-test-bucket')?.delete,
    ).toHaveBeenCalledOnce();
    expect(
      containerClients.get('old-test-bucket')?.delete,
    ).toHaveBeenCalledOnce();
    expect(containerClients.has('no-tags')).toBe(false);
    expect(containerClients.has('customer-vol')).toBe(false);
    expect(result.otherResources.map((r) => r.id)).toEqual([
      'ended-test-bucket',
      'old-test-bucket',
    ]);
    expect(result.errors).toEqual([]);
    expect(StorageSharedKeyCredential).toHaveBeenCalledWith(
      'anycloud11111111',
      'key-1',
    );
  });

  it("finds an installation's containers by their metadata through the account listing", async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    markStoragePresent(azure);
    const hosted = hostedApiIdentity('prod-1');
    installFakeBlobService([
      // The managed checkpoint container, named for the cluster.
      { name: 'prod-1', metadata: {} },
      {
        name: 'job-1',
        metadata: { anycloud_deployment: 'job-1', anycloud_owner_api: hosted },
      },
      {
        name: 'svc-1',
        metadata: { anycloud_deployment: 'svc-1', anycloud_owner_api: hosted },
      },
      { name: 'other', metadata: { anycloud_deployment: 'other' } },
    ]);

    const result = await azure.sweeper().sweepStorage!({
      dryRun: true,
      policy: installationSweepPolicy('prod-1', {
        spareRunningWorkloads: true,
        spareWorkloadIds: ['svc-1'],
      }),
    });

    expect(result.otherResources.map((r) => r.id)).toEqual(['prod-1', 'job-1']);
    expect(result.spared).toEqual([
      { type: 'container', id: 'svc-1', workloadId: 'svc-1' },
    ]);
  });

  it('reports an error when deleteBucket throws but keeps iterating', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({});
    markStoragePresent(azure);

    installFakeBlobService(
      [
        {
          name: 'bucket-a',
          metadata: {
            anycloud_deployment: 'a',
            anycloud_user: 'anycloud-test',
            anycloud_ended_at: '1',
          },
        },
        {
          name: 'bucket-b',
          metadata: {
            anycloud_deployment: 'b',
            anycloud_user: 'anycloud-test',
            anycloud_ended_at: '1',
          },
        },
      ],
      { deleteFailures: { 'bucket-a': new Error('boom') } },
    );

    const result = await sweepAzureStorage(azure);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.resourceId).toBe('bucket-a');
    expect(result.otherResources.map((r) => r.id)).toEqual(['bucket-b']);
  });

  it('dryRun lists candidates without invoking deleteBucket', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({});
    markStoragePresent(azure);

    const { getContainerClient } = installFakeBlobService([
      {
        name: 'bucket-a',
        metadata: {
          anycloud_deployment: 'a',
          anycloud_user: 'anycloud-test',
          anycloud_ended_at: '1',
        },
      },
    ]);

    const result = await sweepAzureStorage(azure, true);
    expect(getContainerClient).not.toHaveBeenCalled();
    expect(result.otherResources.map((r) => r.id)).toEqual(['bucket-a']);
  });

  it('is a successful no-op when the shared storage account is absent', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({});
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(null);
    vi.mocked(BlobServiceClient).mockClear();

    await expect(sweepAzureStorage(azure)).resolves.toEqual({
      vmIds: [],
      otherResources: [],
      errors: [],
    });
    expect(BlobServiceClient).not.toHaveBeenCalled();
  });

  it('reports a storage-account probe failure without using the data plane', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({});
    vi.spyOn(azure, 'findStorageAccount').mockRejectedValue(
      new Error('ARM authorization failed'),
    );
    vi.mocked(BlobServiceClient).mockClear();

    const result = await sweepAzureStorage(azure);

    expect(result.errors).toEqual([
      {
        resourceType: 'container',
        resourceId: 'storage-account',
        error: 'ARM authorization failed',
      },
    ]);
    expect(BlobServiceClient).not.toHaveBeenCalled();
  });
});

describe('Azure storage deletion idempotency', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      cloudProvider: CloudType.Azure,
      subscriptionId: '11111111-2222-3333-4444-555555555555',
      directoryId: 'tenant',
      applicationId: 'app',
      secret: 'secret',
    },
  };

  it('treats bucket and object deletion as complete when storage is absent', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({});
    const findStorageAccount = vi
      .spyOn(azure, 'findStorageAccount')
      .mockResolvedValue(null);
    vi.mocked(BlobServiceClient).mockClear();

    await expect(
      azure.storage().deleteBucket('already-gone'),
    ).resolves.toBeUndefined();
    await expect(
      azure.storage().deleteObject('already-gone', 'object.txt'),
    ).resolves.toBeUndefined();

    expect(findStorageAccount).toHaveBeenCalledTimes(2);
    expect(BlobServiceClient).not.toHaveBeenCalled();
  });

  it('accepts a data-plane failure when ARM confirms the account disappeared', async () => {
    vi.mocked(StorageSharedKeyCredential).mockClear();
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    const storageInfo = {
      resourceGroup: 'anycloud-storage',
      account: { id: 'storage-account-id', location: 'eastus' },
    };
    // Through the real cache: the follow-up probe must not reuse the account.
    const getProperties = vi
      .fn()
      .mockResolvedValueOnce(storageInfo.account)
      .mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 }),
      );
    azure.storageClient.storageAccounts.getProperties = getProperties;
    vi.spyOn(azure as any, 'tagContainerForDeletion').mockResolvedValue(
      undefined,
    );
    const deleteContainer = vi.fn().mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      }),
    );
    const blobServiceClient = {
      getContainerClient: () => ({ delete: deleteContainer }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });

    await expect(
      azure.storage().deleteBucket('deleted-with-account'),
    ).resolves.toBeUndefined();

    expect(deleteContainer).toHaveBeenCalledOnce();
    expect(getProperties).toHaveBeenCalledTimes(2);
    expect(StorageSharedKeyCredential).toHaveBeenCalledWith(
      'anycloud11111111',
      'key-1',
    );
  });

  it('does not hide a deletion error while the account still exists', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    });
    const storageInfo = {
      resourceGroup: 'anycloud-storage',
      account: { id: 'storage-account-id', location: 'eastus' },
    };
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue(storageInfo);
    vi.spyOn(azure as any, 'tagContainerForDeletion').mockResolvedValue(
      undefined,
    );
    const authorizationError = Object.assign(
      new Error('not allowed to delete'),
      { code: 'AuthorizationFailed' },
    );
    const blobServiceClient = {
      getContainerClient: () => ({
        delete: vi.fn().mockRejectedValue(authorizationError),
      }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return blobServiceClient as never;
    });

    await expect((azure as any).deleteBucket('still-present')).rejects.toThrow(
      'Failed to delete Azure container still-present',
    );
  });
});

describe('Azure.upsertBucket', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      cloudProvider: CloudType.Azure,
      subscriptionId: '11111111-2222-3333-4444-555555555555',
      directoryId: 'tenant',
      applicationId: 'app',
      secret: 'secret',
    },
  };

  // Fake a fresh container (exists() === false) whose create() throws `createErr`,
  // so we land in the concurrent-create catch.
  function mockContainerCreate(createErr: unknown) {
    const create = vi.fn().mockRejectedValue(createErr);
    const fakeBlobService = {
      getContainerClient: () => ({
        exists: vi.fn().mockResolvedValue(false),
        create,
      }),
    };
    vi.mocked(BlobServiceClient).mockImplementation(function () {
      return fakeBlobService as never;
    });
    return create;
  }

  function makeAzure() {
    const azure = new Azure(completeCloudConfig(mockConfig));
    azure.storageClient = fakeSdkClient({
      storageAccounts: {
        listKeys: vi.fn().mockResolvedValue({ keys: [{ value: 'key-1' }] }),
      },
    }); // skip initializeAzure()
    vi.spyOn(azure, 'findStorageAccount').mockResolvedValue({
      resourceGroup: 'anycloud-storage',
      account: { id: 'storage-account-id', location: 'eastus' },
    });
    vi.spyOn(azure as any, 'ensureStorageAccount').mockResolvedValue(undefined);
    return azure;
  }

  it('swallows ContainerAlreadyExists (another deploy won the race)', async () => {
    vi.mocked(StorageSharedKeyCredential).mockClear();
    const azure = makeAzure();
    const create = mockContainerCreate({
      code: 'ContainerAlreadyExists',
      statusCode: 409,
    });

    await expect(
      azure.storage().upsertBucket('raced-bucket', '0.3.2', 'test-deploy', ''),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(StorageSharedKeyCredential).toHaveBeenCalledWith(
      'anycloud11111111',
      'key-1',
    );
  });

  it('throws on ContainerBeingDeleted (409, but the container is unusable)', async () => {
    const azure = makeAzure();
    mockContainerCreate({
      code: 'ContainerBeingDeleted',
      statusCode: 409,
      message: 'The specified container is being deleted. Try operation later.',
    });

    await expect(
      azure.storage().upsertBucket('reused-name', '0.3.2', 'test-deploy', ''),
    ).rejects.toMatchObject({ code: 'ContainerBeingDeleted' });
  });

  it('recovers shared upserts after repeated transient premature-close failures', async () => {
    vi.useFakeTimers();
    try {
      const transientClose = new Error(
        'Invalid response body while trying to fetch https://login.microsoftonline.com/token: Premature close',
      );
      const exists = vi
        .fn()
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockRejectedValueOnce(transientClose)
        .mockResolvedValueOnce(false);
      const create = vi.fn().mockResolvedValue(undefined);
      const getContainerClient = vi.fn().mockReturnValue({ exists, create });
      const fakeBlobService = { getContainerClient };
      vi.mocked(BlobServiceClient).mockImplementation(function () {
        return fakeBlobService as never;
      });
      const first = makeAzure();
      const second = makeAzure();

      const upserts = Promise.all([
        first.storage().upsertBucket('shared-output', '0.3.2', 'deploy-1', ''),
        second.storage().upsertBucket('shared-output', '0.3.2', 'deploy-2', ''),
      ]);
      await vi.runAllTimersAsync();

      await expect(upserts).resolves.toEqual([undefined, undefined]);
      expect(exists).toHaveBeenCalledTimes(5);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Azure installation sweep', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'dir',
      applicationId: 'app',
      secret: 'sec',
    },
  };
  const none = () => vi.fn().mockImplementation(async function* () {});

  it('sweeps each anycloud-<region> group, never the storage group', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    (azure as any).initializeClients();
    azure['resourcesClient'] = fakeSdkClient({
      resourceGroups: {
        list: vi.fn().mockImplementation(async function* () {
          yield { name: 'anycloud-eastus', location: 'eastus' };
          yield { name: 'anycloud-westeurope', location: 'westeurope' };
          yield { name: 'anycloud-storage', location: 'eastus' };
          // A user's own group in a region already listed.
          yield { name: 'anycloud-dev', location: 'eastus' };
          yield { name: 'customer-rg', location: 'eastus' };
        }),
      },
    });

    await expect(azure.sweeper().sweepLocations!()).resolves.toEqual([
      'eastus',
      'westeurope',
    ]);
  });

  it('takes the management VM, spares a running VM Service and its NSG', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    (azure as any).initializeClients();
    const hosted = hostedApiIdentity('prod-1');
    azure['resourcesClient'] = fakeSdkClient({
      resourceGroups: { get: vi.fn().mockResolvedValue({}) },
    });
    const instanceView = vi.fn(async () => ({
      instanceView: { statuses: [{ code: 'PowerState/running' }] },
    }));
    azure.computeClient = fakeSdkClient({
      virtualMachines: {
        get: instanceView,
        list: vi.fn().mockImplementation(async function* () {
          yield {
            name: 'anycloud-cluster-prod-1',
            tags: {
              anycloud_resource: 'anycloud-cluster-prod-1',
              anycloud_cluster: 'prod-1',
            },
          };
          yield {
            name: 'svc-1',
            tags: { anycloud_deployment: 'svc-1', anycloud_owner_api: hosted },
          };
          yield {
            name: 'other',
            tags: { anycloud_resource: 'x', anycloud_cluster: 'prod-2' },
          };
        }),
      },
      disks: { listByResourceGroup: none() },
    });
    azure.networkClient = fakeSdkClient({
      publicIPAddresses: { list: none() },
      networkInterfaces: { list: none() },
      networkSecurityGroups: {
        list: vi.fn().mockImplementation(async function* () {
          yield {
            name: 'anycloud-cluster-prod-1',
            tags: {
              anycloud_resource: 'anycloud-cluster-prod-1',
              anycloud_cluster: 'prod-1',
            },
          };
          yield {
            name: 'svc-1',
            tags: { anycloud_deployment: 'svc-1', anycloud_owner_api: hosted },
          };
        }),
      },
      virtualNetworks: { list: none() },
    });

    const result = await azure.sweeper().sweepResources({
      dryRun: true,
      policy: installationSweepPolicy('prod-1', {
        spareRunningWorkloads: true,
        spareWorkloadIds: ['svc-1'],
      }),
    });

    expect(result.errors).toEqual([]);
    expect(result.vmIds).toEqual(['anycloud-cluster-prod-1']);
    expect(result.otherResources).toEqual([
      { type: 'nsg', id: 'anycloud-cluster-prod-1' },
    ]);
    expect(result.spared).toEqual([
      { type: 'vm', id: 'svc-1', workloadId: 'svc-1' },
      { type: 'nsg', id: 'svc-1', workloadId: 'svc-1' },
    ]);
    // Only a VM-host workload's VM needs its power state.
    expect(instanceView).toHaveBeenCalledOnce();

    // A power state it can't read counts as running.
    instanceView.mockRejectedValueOnce(new Error('throttled'));
    const unread = await azure.sweeper().sweepResources({
      dryRun: true,
      policy: installationSweepPolicy('prod-1', {
        spareRunningWorkloads: true,
      }),
    });
    expect(unread.spared).toContainEqual({
      type: 'vm',
      id: 'svc-1',
      workloadId: 'svc-1',
    });
    expect(unread.vmIds).not.toContain('svc-1');
  });

  it('tags the OS disk with the VM’s tags once the VM runs', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    (azure as any).initializeClients();
    const beginUpdate = vi.fn().mockResolvedValue({});
    azure.computeClient = fakeSdkClient({
      virtualMachines: {
        get: vi.fn().mockResolvedValue({
          storageProfile: { osDisk: { name: 'vm-1_OsDisk_1' } },
        }),
      },
      disks: { beginUpdate },
    });

    await (azure as any).tagOsDisk('vm-1', { anycloud_cluster: 'prod-1' });

    expect(beginUpdate).toHaveBeenCalledWith(
      azure.resourceGroup,
      'vm-1_OsDisk_1',
      {
        tags: { anycloud_cluster: 'prod-1' },
      },
    );
  });
});

describe('Azure resource sweep with missing infrastructure', () => {
  const mockConfig = {
    cloudProvider: CloudType.Azure,
    region: 'eastus',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'dir',
      applicationId: 'app',
      secret: 'sec',
    },
  };

  function installClients(
    azure: Azure,
    resourceGroupGet: ReturnType<typeof vi.fn>,
    virtualMachinesList = vi.fn(),
  ) {
    const publicIpList = vi.fn();
    const nicList = vi.fn();
    const nsgList = vi.fn();
    const vnetList = vi.fn();
    azure['resourcesClient'] = fakeSdkClient({
      resourceGroups: { get: resourceGroupGet },
    });
    azure.computeClient = fakeSdkClient({
      virtualMachines: { list: virtualMachinesList },
    });
    azure.networkClient = fakeSdkClient({
      publicIPAddresses: { list: publicIpList },
      networkInterfaces: { list: nicList },
      networkSecurityGroups: { list: nsgList },
      virtualNetworks: { list: vnetList },
    });
    azure.storageClient = fakeSdkClient({});
    return { publicIpList, nicList, nsgList, vnetList };
  }

  it('returns an empty result without listing resources when the group is absent', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const resourceGroupGet = vi
      .fn()
      .mockRejectedValue({ code: 'ResourceGroupNotFound' });
    const virtualMachinesList = vi.fn();
    const networkLists = installClients(
      azure,
      resourceGroupGet,
      virtualMachinesList,
    );

    await expect(sweepAzureResources(azure)).resolves.toEqual({
      vmIds: [],
      otherResources: [],
      errors: [],
    });

    expect(resourceGroupGet).toHaveBeenCalledWith(azure.resourceGroup);
    expect(virtualMachinesList).not.toHaveBeenCalled();
    for (const list of Object.values(networkLists)) {
      expect(list).not.toHaveBeenCalled();
    }
  });

  it('reports an authorization failure from the read-only group probe', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const resourceGroupGet = vi
      .fn()
      .mockRejectedValue(new Error('ARM authorization failed'));
    const virtualMachinesList = vi.fn();
    installClients(azure, resourceGroupGet, virtualMachinesList);

    const result = await sweepAzureResources(azure);

    expect(result.errors).toEqual([
      {
        resourceType: 'resourceGroup',
        resourceId: azure.resourceGroup,
        error: 'ARM authorization failed',
      },
    ]);
    expect(virtualMachinesList).not.toHaveBeenCalled();
  });

  it('stops cleanly if the group disappears between the probe and first list', async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    const missingGroupIterator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: vi.fn().mockRejectedValue(
        Object.assign(new Error('group disappeared'), {
          code: 'ResourceGroupNotFound',
        }),
      ),
    };
    const virtualMachinesList = vi.fn().mockReturnValue(missingGroupIterator);
    const networkLists = installClients(
      azure,
      vi.fn().mockResolvedValue({}),
      virtualMachinesList,
    );

    await expect(sweepAzureResources(azure)).resolves.toEqual({
      vmIds: [],
      otherResources: [],
      errors: [],
    });
    expect(virtualMachinesList).toHaveBeenCalledOnce();
    for (const list of Object.values(networkLists)) {
      expect(list).not.toHaveBeenCalled();
    }
  });

  it("reclaims ended and detached resources of CI test users only, never another installation's", async () => {
    const azure = new Azure(completeCloudConfig(mockConfig));
    // `cluster` is a hosted cluster's management resource: stamped, no user.
    const endedTags = (owner: string) => ({
      anycloud_deployment: `job-${owner}`,
      ...(owner === 'cluster' ? {} : { anycloud_user: owner }),
      anycloud_owner_api: '0123456789abcdef0123456789abcdef',
      anycloud_created_at: Date.now().toString(),
      anycloud_ended_at: Date.now().toString(),
    });
    const list = (kind: string) =>
      vi.fn().mockImplementation(async function* () {
        for (const owner of ['anycloud-test', 'customer', 'cluster']) {
          yield { name: `${kind}-${owner}`, tags: endedTags(owner) };
        }
      });
    azure['resourcesClient'] = fakeSdkClient({
      resourceGroups: { get: vi.fn().mockResolvedValue({}) },
    });
    azure.computeClient = fakeSdkClient({
      virtualMachines: { list: list('vm') },
      disks: { listByResourceGroup: list('disk') },
    });
    azure.networkClient = fakeSdkClient({
      publicIPAddresses: { list: list('ip') },
      networkInterfaces: { list: list('nic') },
      networkSecurityGroups: { list: list('nsg') },
      virtualNetworks: { list: list('vnet') },
    });
    azure.storageClient = fakeSdkClient({});

    const result = await sweepAzureResources(azure, true);

    expect(result.vmIds).toEqual(['vm-anycloud-test']);
    expect(result.otherResources.map((r) => r.id).sort()).toEqual([
      'disk-anycloud-test',
      'ip-anycloud-test',
      'nic-anycloud-test',
      'nsg-anycloud-test',
      'vnet-anycloud-test',
    ]);
  });
});

describe('Azure controller ownership backfill', () => {
  it('patches tags on an exact matching legacy VM', async () => {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: {
          subscriptionId: '12345678-1234-1234-1234-123456789012',
          directoryId: 'dir',
          applicationId: 'app',
          secret: 'sec',
        },
      }),
    );
    const pollUntilDone = vi.fn().mockResolvedValue({});
    const beginUpdate = vi.fn().mockResolvedValue({ pollUntilDone });
    const computeClient = {
      virtualMachines: {
        get: vi.fn().mockResolvedValue({
          tags: {
            anycloud_deployment: 'workload-1',
            anycloud_user: 'user-1',
          },
        }),
        beginUpdate,
      },
    };
    azure.computeClient =
      computeClient as unknown as typeof azure.computeClient;
    const resourcesClient = {};
    const networkClient = {};
    const storageClient = {};
    azure['resourcesClient'] = fakeSdkClient(
      resourcesClient as (typeof azure)['resourcesClient'],
    );
    azure.networkClient = fakeSdkClient(
      networkClient as typeof azure.networkClient,
    );
    azure.storageClient = fakeSdkClient(
      storageClient as typeof azure.storageClient,
    );

    await expect(
      azure.apiOwnership().backfillExactVM({
        cloudId: 'vm-1',
        apiIdentity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ownerKind: 'workload',
        ownerId: 'workload-1',
        userId: 'user-1',
      }),
    ).resolves.toBe('updated');
    expect(beginUpdate).toHaveBeenCalledWith(azure.resourceGroup, 'vm-1', {
      tags: {
        anycloud_deployment: 'workload-1',
        anycloud_user: 'user-1',
        anycloud_owner_api: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    expect(pollUntilDone).toHaveBeenCalledOnce();
  });
});
