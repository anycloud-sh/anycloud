import { Readable, Writable } from 'node:stream';
import { beforeEach, describe, it, expect, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import {
  clearCatalogCache,
  writeCatalog,
} from '../../../../src/shared/catalog/index.js';
import {
  GCP_PERMISSION_DENIED,
  GCP_UNAUTHENTICATED,
} from '../../../integration/credentials-onboarding/personas.js';
import {
  BucketAccessDeniedError,
  BucketNameTakenError,
  BucketNotFoundError,
  BucketThrottledError,
  ObjectNotFoundError,
} from '../../../../src/shared/errors.js';
import {
  BucketCredentialNotReadyError,
  throughBucketStorage,
} from '../../../../src/api/services/bucket-storage-operation.js';
import { fakeSdkClient } from '../../helpers/sdk-client';
import { internalsOf } from '../../helpers/internals';
import {
  InstancesClient,
  type MachineTypesClient,
} from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import { DownscopedClient } from 'google-auth-library';
import {
  GCP,
  generateUUIDFromString,
  isGCPNotFound,
  resetGcpCandidatePreflightCache,
  sanitizeGCPLabel,
} from '../../../../src/api/services/gateways/gcp';
import {
  CandidateEligibilityExhaustedError,
  canFilterCandidateRegions,
  canClassifyTerminalAuthError,
  canListBuckets,
  canMintScopedStorageToken,
  canListObjects,
  canManageCloudResources,
  canObserveStoppedVms,
  type CandidateRegion,
} from '../../../../src/api/services/gateways/cloud';
import {
  type CloudConfig,
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
} from '../../../../src/shared/cloud.js';
import { InvalidAnycloudConfigError } from '../../../../src/shared/errors';
import { GpuRuntime } from '../../../../src/shared/cloud';
import {
  buildJobIngressSpec,
  buildServeIngressSpec,
} from '../../../../src/api/services/network';
import type { IngressSpec } from '../../../../src/api/services/entities';
import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
} from '../../../../src/shared/cloudflare-ips';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../../../helpers/resource-sweep-policy';
import { installationSweepPolicy } from '../../../../src/api/services/gateways/resource-sweeper';
import { hostedApiIdentity } from '../../../../src/shared/hosted-api-identity.js';
import { requirePrepareNetwork } from '../../helpers/fixtures';

// Mock the logger
vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock GCP SDK clients
vi.mock('@google-cloud/compute', () => ({
  InstancesClient: vi.fn(),
  NetworksClient: vi.fn(),
  FirewallsClient: vi.fn(),
  GlobalOperationsClient: vi.fn(),
  ZoneOperationsClient: vi.fn(),
  ImagesClient: vi.fn(),
  DisksClient: vi.fn(),
  MachineTypesClient: vi.fn(),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn(),
}));

const { exchange, jwtRequest } = vi.hoisted(() => ({
  exchange: vi.fn(),
  jwtRequest: vi.fn(),
}));
vi.mock('google-auth-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  JWT: vi.fn(function (this: object, options: object) {
    Object.assign(this, { options, request: jwtRequest });
  }),
  DownscopedClient: vi.fn(function (
    this: object,
    source: object,
    boundary: object,
  ) {
    Object.assign(this, { getAccessToken: () => exchange(source, boundary) });
  }),
}));

function buildMockMachineTypesClient(
  get: MachineTypesClient['get'],
): MachineTypesClient {
  const machineTypesClient = { get };
  return machineTypesClient as MachineTypesClient;
}

function filterCandidateRegions(
  provider: GCP,
  candidates: CandidateRegion[],
  spot: boolean,
  workloadId: string,
): Promise<CandidateRegion[]> {
  const compute = provider.compute();
  if (!canFilterCandidateRegions(compute)) {
    throw new Error('GCP compute provider did not expose candidate filtering');
  }
  return compute.filterCandidateRegions(candidates, spot, workloadId);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetGcpCandidatePreflightCache();
});

describe('sanitizeGCPLabel', () => {
  describe('uppercase letters', () => {
    it('should convert uppercase to lowercase', () => {
      expect(sanitizeGCPLabel('UPPERCASE')).toBe('uppercase');
      expect(sanitizeGCPLabel('MixedCase')).toBe('mixedcase');
      expect(sanitizeGCPLabel('Test-ID-123')).toBe('test-id-123');
    });
  });

  describe('special characters', () => {
    it('should replace dots with underscores', () => {
      expect(sanitizeGCPLabel('1.2.3')).toBe('1_2_3');
      expect(sanitizeGCPLabel('v0.3.2')).toBe('v0_3_2');
    });

    it('should replace spaces with underscores', () => {
      expect(sanitizeGCPLabel('user name')).toBe('user_name');
      expect(sanitizeGCPLabel('test workload id')).toBe('test_workload_id');
    });

    it('should replace multiple consecutive invalid chars with underscores', () => {
      expect(sanitizeGCPLabel('test@#$id')).toBe('test___id');
      expect(sanitizeGCPLabel('user...id')).toBe('user___id');
    });

    it('should replace various special characters with underscores', () => {
      expect(sanitizeGCPLabel('user@example.com')).toBe('user_example_com');
      expect(sanitizeGCPLabel('test/path/id')).toBe('test_path_id');
      expect(sanitizeGCPLabel('id:value')).toBe('id_value');
      expect(sanitizeGCPLabel('test+value')).toBe('test_value');
    });
  });

  describe('valid characters', () => {
    it('should preserve lowercase alphanumeric characters', () => {
      expect(sanitizeGCPLabel('abc123')).toBe('abc123');
      expect(sanitizeGCPLabel('test')).toBe('test');
      expect(sanitizeGCPLabel('0123456789')).toBe('0123456789');
    });

    it('should preserve hyphens', () => {
      expect(sanitizeGCPLabel('test-id-123')).toBe('test-id-123');
      expect(sanitizeGCPLabel('my-workload')).toBe('my-workload');
    });

    it('should preserve underscores', () => {
      expect(sanitizeGCPLabel('test_id_123')).toBe('test_id_123');
      expect(sanitizeGCPLabel('my_workload')).toBe('my_workload');
    });

    it('should preserve valid mixed chars', () => {
      expect(sanitizeGCPLabel('test-id_123')).toBe('test-id_123');
      expect(sanitizeGCPLabel('my-app_v1-beta')).toBe('my-app_v1-beta');
    });
  });

  describe('real-world scenarios', () => {
    it('should sanitize workload IDs', () => {
      expect(sanitizeGCPLabel('fw-12345')).toBe('fw-12345');
      expect(sanitizeGCPLabel('Workload.ID')).toBe('workload_id');
      expect(sanitizeGCPLabel('TEST-DEPLOY-123')).toBe('test-deploy-123');
    });

    it('should sanitize version strings', () => {
      expect(sanitizeGCPLabel('1.2.3')).toBe('1_2_3');
      expect(sanitizeGCPLabel('0.3.2-beta')).toBe('0_3_2-beta');
      expect(sanitizeGCPLabel('v2.1.0')).toBe('v2_1_0');
      expect(sanitizeGCPLabel('1.2.3-beta.4')).toBe('1_2_3-beta_4');
    });

    it('should sanitize user IDs', () => {
      expect(sanitizeGCPLabel('user@example.com')).toBe('user_example_com');
      expect(sanitizeGCPLabel('John Doe')).toBe('john_doe');
      expect(sanitizeGCPLabel('USER123')).toBe('user123');
      expect(sanitizeGCPLabel('test.user+tag@domain.com')).toBe(
        'test_user_tag_domain_com',
      );
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(sanitizeGCPLabel('')).toBe('');
    });

    it('should handle strings with only invalid chars', () => {
      expect(sanitizeGCPLabel('...')).toBe('___');
      expect(sanitizeGCPLabel('@#$')).toBe('___');
    });

    it('should handle strings starting/ending with invalid chars', () => {
      expect(sanitizeGCPLabel('.test')).toBe('_test');
      expect(sanitizeGCPLabel('test.')).toBe('test_');
      expect(sanitizeGCPLabel('.test.')).toBe('_test_');
    });

    it('should handle already valid labels', () => {
      expect(sanitizeGCPLabel('valid-label_123')).toBe('valid-label_123');
      expect(sanitizeGCPLabel('lowercase')).toBe('lowercase');
    });
  });
});

describe('isGCPNotFound', () => {
  it('should return true for gRPC NOT_FOUND status code (5)', () => {
    const error = { code: 5 };
    expect(isGCPNotFound(error)).toBe(true);
  });

  it('should return true for HTTP 404 in code field', () => {
    const error = { code: 404 };
    expect(isGCPNotFound(error)).toBe(true);
  });

  it('should return true for HTTP 404 in statusCode field', () => {
    const error = { statusCode: 404 };
    expect(isGCPNotFound(error)).toBe(true);
  });

  it('should return true when message includes "not found"', () => {
    const error = { message: 'Resource not found in project' };
    expect(isGCPNotFound(error)).toBe(true);
  });

  it('should return true when message includes "NotFound"', () => {
    const error = { message: 'NotFound: Instance does not exist' };
    expect(isGCPNotFound(error)).toBe(true);
  });

  it('should return false for other error codes', () => {
    const error = { code: 3, message: 'Invalid argument' };
    expect(isGCPNotFound(error)).toBe(false);
  });

  it('should return false for 403 Forbidden', () => {
    const error = { statusCode: 403, code: 403 };
    expect(isGCPNotFound(error)).toBe(false);
  });

  it('should return false for 500 Internal Server Error', () => {
    const error = { statusCode: 500 };
    expect(isGCPNotFound(error)).toBe(false);
  });

  it('should return false for permission denied errors', () => {
    const error = { code: 7, message: 'Permission denied' };
    expect(isGCPNotFound(error)).toBe(false);
  });

  it('should return false for quota exceeded errors', () => {
    const error = { code: 8, message: 'Quota exceeded' };
    expect(isGCPNotFound(error)).toBe(false);
  });
});

describe('GCP.newVM cleanup behavior', () => {
  // Note: Full integration testing requires real GCP credentials.
  // These tests verify expected behavior through isGCPNotFound which is used
  // by deleteVM during cleanup.

  it('isGCPNotFound should handle cleanup scenarios correctly', () => {
    // During cleanup, if resource already deleted (404), treat as success
    expect(isGCPNotFound({ code: 5 })).toBe(true);
    expect(isGCPNotFound({ statusCode: 404 })).toBe(true);

    // Other errors are not "not found" (they will be thrown)
    expect(isGCPNotFound({ code: 7 })).toBe(false); // Permission denied
    expect(isGCPNotFound({ code: 8 })).toBe(false); // Quota exceeded
  });
});

describe('GCP class', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-micro',
    diskTier: DiskTier.Medium,
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  describe('isTerminalAuthError', () => {
    it('does not durably mark — UNAUTHENTICATED is too broad to be invalid-secret', () => {
      // GCP deliberately omits the capability, so a broad UNAUTHENTICATED never
      // strands a valid credential; it follows the ordinary retry policy.
      expect(
        canClassifyTerminalAuthError(new GCP(completeCloudConfig(mockConfig))),
      ).toBe(false);
    });
  });

  describe('credential validation', () => {
    it('rejects malformed PEM locally before contacting Compute', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const listAsync = vi.fn();
      gcp.instancesClient = fakeSdkClient<InstancesClient>({ listAsync });

      await expect(gcp.compute().validateCredentials()).rejects.toThrow(
        'GCP service-account private key is not a valid PEM private key',
      );
      expect(listAsync).not.toHaveBeenCalled();
    });
  });

  describe('stopped VM observation', () => {
    it('reports a stop only once GCP settles it: STOPPING also precedes a delete', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const get = vi.fn();
      gcp.instancesClient = fakeSdkClient<InstancesClient>({ get });
      const compute = gcp.compute();
      if (!canObserveStoppedVms(compute)) {
        throw new Error('Expected stopped-VM observation');
      }
      const observe = async (status: string) => {
        get.mockResolvedValueOnce([{ status }]);
        return compute.observeStoppedVm('vm-1');
      };

      await expect(observe('STOPPING')).resolves.toBe(false);
      await expect(observe('TERMINATED')).resolves.toBe(true);
      await expect(observe('RUNNING')).resolves.toBe(false);
    });
  });

  describe('resource-scoped VM lookup', () => {
    it('finds instances in any zone by the scope label, stopped ones included', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const aggregatedListAsync = vi.fn(async function* () {
        yield [
          'zones/us-central1-a',
          {
            instances: [
              {
                name: 'anycloud-cluster-c1',
                status: 'TERMINATED',
                labels: { anycloud_resource: 'anycloud-cluster-c1' },
              },
              {
                name: 'anycloud-cluster-c1-b',
                status: 'RUNNING',
                labels: { anycloud_resource: 'anycloud-cluster-c1' },
              },
              { name: 'other', labels: { anycloud_resource: 'other' } },
            ],
          },
        ];
        yield ['zones/us-east1-b', {}];
      });
      gcp.instancesClient = fakeSdkClient<InstancesClient>({
        aggregatedListAsync,
      });
      const compute = gcp.compute();
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
      expect(aggregatedListAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: 'labels.anycloud_resource = "anycloud-cluster-c1"',
        }),
      );
    });
  });

  describe('classifyError', () => {
    it('classifies the REST 401 unauthorized envelope as BadCredential', () => {
      // The REST transport reports UNAUTHENTICATED as a numeric 401 with
      // errors[].reason 'unauthorized', not the gRPC code string.
      const gcp = new GCP(completeCloudConfig(mockConfig));
      expect(
        gcp.compute().classifyError(
          Object.assign(new Error('Request had invalid authentication'), {
            code: 401,
            errors: [
              {
                message: 'Request had invalid authentication credentials.',
                domain: 'global',
                reason: 'unauthorized',
              },
            ],
          }),
        ),
      ).toBe(CloudFailureDiagnosis.BadCredential);
    });

    const restEnvelope = {
      code: 403,
      message: 'Permission compute.instances.list denied',
      errors: [
        { message: 'Permission denied', domain: 'global', reason: 'forbidden' },
      ],
      status: 'PERMISSION_DENIED',
    };

    it.each([
      [
        'the REST 403 envelope',
        Object.assign(new Error(JSON.stringify({ error: restEnvelope })), {
          code: 403,
          status: 403,
          response: { status: 403, data: { error: restEnvelope } },
        }),
        'compute.instances.list',
      ],
      [
        'a wrapped 403 whose body survives only as message text',
        Object.assign(
          new Error(
            'Invalid GCP credentials for region us-east4: {"error":{"code":403,"status":"PERMISSION_DENIED"}}',
          ),
          { code: 403 },
        ),
        null,
      ],
      [
        // google-gax's REST transport maps Compute's 403 to the numeric gRPC
        // PERMISSION_DENIED code and drops errors[] and status.
        'the SDK 403',
        Object.assign(new Error(GCP_PERMISSION_DENIED.message), { code: 7 }),
        GCP_PERMISSION_DENIED.action,
      ],
      [
        'the recorded REST 403',
        Object.assign(new Error(GCP_PERMISSION_DENIED.message), {
          code: GCP_PERMISSION_DENIED.httpStatus,
          errors: [
            { message: GCP_PERMISSION_DENIED.message, reason: 'forbidden' },
          ],
        }),
        GCP_PERMISSION_DENIED.action,
      ],
    ])(
      '0047 invariant 3: classifies %s as PermissionDenied naming its action',
      (_shape, error, action) => {
        const compute = new GCP(completeCloudConfig(mockConfig)).compute();
        expect(compute.classifyError(error)).toBe(
          CloudFailureDiagnosis.PermissionDenied,
        );
        expect(compute.permissionDenial?.(error)).toEqual({
          action,
          regional: false,
        });
      },
    );

    it.each([
      [
        'an unrecognized key',
        Object.assign(new Error(GCP_UNAUTHENTICATED.body.error.message), {
          code: 401,
          errors: GCP_UNAUTHENTICATED.body.error.errors,
        }),
        CloudFailureDiagnosis.BadCredential,
      ],
      [
        'a disabled API',
        Object.assign(
          new Error(
            'Compute Engine API has not been used in project 1 before or it is disabled.',
          ),
          {
            code: 403,
            errors: [{ reason: 'accessNotConfigured' }],
            error: { status: 'PERMISSION_DENIED' },
          },
        ),
        CloudFailureDiagnosis.InvalidRequest,
      ],
      [
        'a project without billing',
        Object.assign(
          new Error('This API method requires billing to be enabled.'),
          {
            code: 403,
            errors: [
              { errorDetails: [{ errorInfo: { reason: 'BILLING_DISABLED' } }] },
            ],
            error: { status: 'PERMISSION_DENIED' },
          },
        ),
        CloudFailureDiagnosis.InvalidRequest,
      ],
    ])(
      'does not report %s as a permission denial',
      (_shape, error, diagnosis) => {
        const compute = new GCP(completeCloudConfig(mockConfig)).compute();
        expect(compute.classifyError(error)).toBe(diagnosis);
        expect(compute.permissionDenial?.(error)).toBeUndefined();
      },
    );

    it('classifies the wrapped 401 whose body survives only as message text', () => {
      // validateCredentials wraps the rejection with the raw body after the
      // response stream is consumed, so errors[] is gone and only the
      // UNAUTHENTICATED envelope text remains.
      const gcp = new GCP(completeCloudConfig(mockConfig));
      expect(
        gcp
          .compute()
          .classifyError(
            Object.assign(
              new Error(
                'Invalid GCP credentials for region us-east4: {"error":{"code":401,"status":"UNAUTHENTICATED"}}',
              ),
              { code: 401 },
            ),
          ),
      ).toBe(CloudFailureDiagnosis.BadCredential);
    });
  });

  describe('constructor', () => {
    it('should create GCP instance with correct properties', () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));

      expect(gcp.type).toBe(CloudType.GCP);
      expect(gcp.region).toBe('us-central1');
      expect(gcp.vmType).toBe('e2-micro');
    });

    it('should set optional properties', () => {
      const configWithOptional = {
        ...mockConfig,
        spot: true,
        diskSizeGb: 50,
      };

      const gcp = new GCP(completeCloudConfig(configWithOptional));

      expect(gcp.spot).toBe(true);
      expect(gcp.diskSizeGb).toBe(50);
    });

    it('binds stored keys when the API host points at different GCP credentials', () => {
      vi.stubEnv(
        'GOOGLE_APPLICATION_CREDENTIALS',
        '/host/ambient/application-default.json',
      );
      try {
        new GCP(completeCloudConfig(mockConfig));

        const explicitOptions = expect.objectContaining({
          projectId: mockConfig.credentials.projectId,
          credentials: {
            private_key: mockConfig.credentials.privateKey,
            client_email: mockConfig.credentials.clientEmail,
          },
        });
        expect(vi.mocked(InstancesClient)).toHaveBeenCalledWith(
          explicitOptions,
        );
        expect(vi.mocked(Storage)).toHaveBeenCalledWith(explicitOptions);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('candidate region filter', () => {
    it('implements the candidate-region filter capability', () => {
      expect(
        canFilterCandidateRegions(
          new GCP(completeCloudConfig(mockConfig)).compute(),
        ),
      ).toBe(true);
    });

    it('removes a disk-incompatible fallback before remote availability checks', async () => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType: 'c4-standard-16',
          diskTier: DiskTier.High,
          diskSizeGb: 15,
        }),
      );
      const get = vi.fn().mockResolvedValue([{ name: 'e2-standard-4' }]);
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));
      const fallback = {
        vmType: 'e2-standard-4',
        region: 'us-central1',
        availabilityZone: 'a',
      };

      await expect(
        filterCandidateRegions(
          gcp,
          [
            {
              vmType: 'c4-standard-16',
              region: 'us-central1',
              availabilityZone: 'a',
            },
            fallback,
          ],
          false,
          'disk-compatible-fallback',
        ),
      ).resolves.toEqual([fallback]);
      expect(get).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith({
        project: 'test-project',
        zone: 'us-central1-a',
        machineType: 'e2-standard-4',
      });
    });

    it.each([
      [DiskTier.High, 16],
      [DiskTier.Ultra, 32],
    ])(
      'keeps a boundary-valid %s Hyperdisk candidate eligible for remote availability',
      async (diskTier, diskSizeGb) => {
        const gcp = new GCP(
          completeCloudConfig({
            ...mockConfig,
            vmType: 'c4-standard-16',
            diskTier,
            diskSizeGb,
          }),
        );
        const get = vi.fn().mockResolvedValue([{ name: 'c4-standard-16' }]);
        gcp.machineTypesClient = fakeSdkClient(
          buildMockMachineTypesClient(get),
        );
        const candidate = {
          vmType: 'c4-standard-16',
          region: 'us-central1',
          availabilityZone: 'a',
        };

        await expect(
          filterCandidateRegions(
            gcp,
            [candidate],
            false,
            `disk-compatible-${diskTier}`,
          ),
        ).resolves.toEqual([candidate]);
        expect(get).toHaveBeenCalledOnce();
        expect(get).toHaveBeenCalledWith({
          project: 'test-project',
          zone: 'us-central1-a',
          machineType: 'c4-standard-16',
        });
      },
    );

    it('reports the disk reason when every fallback is locally incompatible', async () => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType: 'c4-standard-16',
          diskTier: DiskTier.High,
          diskSizeGb: 15,
        }),
      );
      const get = vi.fn();
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));

      const error = await filterCandidateRegions(
        gcp,
        [
          {
            vmType: 'c4-standard-16',
            region: 'us-central1',
            availabilityZone: 'a',
          },
        ],
        false,
        'disk-incompatible-fallback',
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CandidateEligibilityExhaustedError);
      expect(error).toMatchObject({
        message:
          'GCP --disk-tier high on Hyperdisk Balanced requires --disk-size of at least 16 GB for VM type "c4-standard-16" (got 15 GB).',
      });
      expect(get).not.toHaveBeenCalled();
    });

    it('drops an exact zone where the machine type is unavailable', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const get = vi.fn().mockImplementation(({ zone }) => {
        if (zone === 'us-central1-a')
          return Promise.resolve([{ name: 'e2-micro' }]);
        const err = new Error(`machine type not found in ${zone}`) as Error & {
          code: number;
        };
        err.code = 404;
        return Promise.reject(err);
      });
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));

      const filtered = await filterCandidateRegions(
        gcp,
        [
          {
            vmType: 'e2-micro',
            region: 'us-central1',
            availabilityZone: 'a',
          },
          {
            vmType: 'e2-micro',
            region: 'us-west1',
            availabilityZone: 'c',
          },
        ],
        true,
        'dep-1',
      );

      expect(filtered).toEqual([
        {
          vmType: 'e2-micro',
          region: 'us-central1',
          availabilityZone: 'a',
        },
      ]);
      expect(get).toHaveBeenCalledWith({
        project: 'test-project',
        zone: 'us-central1-a',
        machineType: 'e2-micro',
      });
      expect(get).toHaveBeenCalledWith({
        project: 'test-project',
        zone: 'us-west1-c',
        machineType: 'e2-micro',
      });
    });

    it('exposes structured candidate availability facts for unavailable machine types', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const get = vi.fn().mockImplementation(({ zone }) => {
        if (zone === 'us-central1-a')
          return Promise.resolve([{ name: 'e2-micro' }]);
        const err = new Error(`machine type not found in ${zone}`) as Error & {
          code: number;
        };
        err.code = 404;
        return Promise.reject(err);
      });
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));

      const filtered = await filterCandidateRegions(
        gcp,
        [
          {
            vmType: 'e2-micro',
            region: 'us-central1',
            availabilityZone: 'a',
          },
          {
            vmType: 'e2-micro',
            region: 'us-west1',
            availabilityZone: 'c',
          },
        ],
        true,
        'dep-1',
      );

      expect(filtered).toEqual([
        {
          vmType: 'e2-micro',
          region: 'us-central1',
          availabilityZone: 'a',
        },
      ]);
    });

    it('probes sparse fallback coverage as exact pairs, not a Cartesian product', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const get = vi.fn().mockResolvedValue([{ name: 'available' }]);
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));
      const candidates = [
        {
          vmType: 'e2-micro',
          region: 'us-central1',
          availabilityZone: 'a',
        },
        {
          vmType: 'a2-highgpu-1g',
          region: 'us-west1',
          availabilityZone: 'b',
        },
      ];

      await expect(
        filterCandidateRegions(gcp, candidates, true, 'sparse-pairs'),
      ).resolves.toEqual(candidates);

      expect(get).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenCalledWith({
        project: 'test-project',
        zone: 'us-central1-a',
        machineType: 'e2-micro',
      });
      expect(get).toHaveBeenCalledWith({
        project: 'test-project',
        zone: 'us-west1-b',
        machineType: 'a2-highgpu-1g',
      });
      expect(get).not.toHaveBeenCalledWith(
        expect.objectContaining({
          zone: 'us-west1-b',
          machineType: 'e2-micro',
        }),
      );
      expect(get).not.toHaveBeenCalledWith(
        expect.objectContaining({
          zone: 'us-central1-a',
          machineType: 'a2-highgpu-1g',
        }),
      );
    });

    it('keeps failed machine-type reads unknown and does not cache them', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const get = vi.fn().mockImplementation(({ zone }) => {
        if (zone === 'us-central1-a')
          return Promise.resolve([{ name: 'e2-micro' }]);
        throw new Error(`GCP control plane unavailable for ${zone}`);
      });
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));
      const candidates = [
        {
          vmType: 'e2-micro',
          region: 'us-central1',
          availabilityZone: 'a',
        },
        {
          vmType: 'e2-micro',
          region: 'us-west1',
          availabilityZone: 'c',
        },
      ];

      await expect(
        filterCandidateRegions(gcp, candidates, true, 'dep-1'),
      ).resolves.toEqual(candidates);
      await expect(
        filterCandidateRegions(gcp, candidates, true, 'dep-2'),
      ).resolves.toEqual(candidates);

      expect(
        get.mock.calls.filter(([arg]) => arg.zone === 'us-west1-c'),
      ).toHaveLength(2);
    });

    it('fails open when every machine-type region read fails', async () => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const get = vi
        .fn()
        .mockRejectedValue(new Error('GCP control plane unavailable'));
      gcp.machineTypesClient = fakeSdkClient(buildMockMachineTypesClient(get));
      const candidates = [
        {
          vmType: 'e2-micro',
          region: 'us-central1',
          availabilityZone: 'a',
        },
        {
          vmType: 'e2-micro',
          region: 'us-west1',
          availabilityZone: 'c',
        },
      ];

      await expect(
        filterCandidateRegions(gcp, candidates, true, 'dep-1'),
      ).resolves.toEqual(candidates);
    });

    it('fails open a wide exact-pair sweep before the scheduler deadline', async () => {
      vi.useFakeTimers();
      try {
        const gcp = new GCP(completeCloudConfig(mockConfig));
        const get = vi.fn(() => new Promise<never>(() => {}));
        gcp.machineTypesClient = fakeSdkClient(
          buildMockMachineTypesClient(get),
        );
        const candidates = Array.from({ length: 44 }, (_, index) => ({
          vmType: 'e2-micro',
          region: `region-${index}`,
          availabilityZone: 'a',
        }));

        const filtered = filterCandidateRegions(
          gcp,
          candidates,
          true,
          'wide-gcp-sweep',
        );
        let settled = false;
        void filtered.then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(22_999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        await expect(filtered).resolves.toEqual(candidates);
        expect(get.mock.calls.length).toBeGreaterThan(0);
        expect(get.mock.calls.length).toBeLessThanOrEqual(44);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('prepares firewall rules for server SSH and Cloudflare HTTP ingress', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const insert = vi.fn().mockResolvedValue([{}]);
    gcp.firewallsClient = fakeSdkClient({ insert });
    const waitForOperation = vi
      .spyOn(gcp as any, 'waitForOperation')
      .mockResolvedValue(undefined);

    await requirePrepareNetwork(gcp.compute())(
      buildServeIngressSpec(['10.0.0.0/8']),
      'server-1',
      '0.0.0-test',
      'test-user',
    );

    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenCalledWith({
      project: 'test-project',
      firewallResource: {
        name: 'server-122',
        targetTags: ['server-1'],
        sourceRanges: ['10.0.0.0/8'],
        allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      },
    });
    expect(insert).toHaveBeenCalledWith({
      project: 'test-project',
      firewallResource: {
        name: 'server-180',
        targetTags: ['server-1'],
        sourceRanges: [...CLOUDFLARE_IPV4_RANGES],
        allowed: [{ IPProtocol: 'tcp', ports: ['80'] }],
      },
    });
    expect(insert).toHaveBeenCalledWith({
      project: 'test-project',
      firewallResource: {
        name: 'server-180-ipv6',
        targetTags: ['server-1'],
        sourceRanges: [...CLOUDFLARE_IPV6_RANGES],
        allowed: [{ IPProtocol: 'tcp', ports: ['80'] }],
      },
    });
    // A Service keeps its network's internal traffic: no deny of its own.
    expect(
      insert.mock.calls.some(([request]) =>
        request.firewallResource.name.includes('deny'),
      ),
    ).toBe(false);
    expect(waitForOperation).toHaveBeenCalledTimes(3);
    expect(waitForOperation).toHaveBeenCalledWith({}, 'global');
  });

  it('shares one public-SSH rule set across Jobs, as a 409 after the first', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const insert = vi
      .fn()
      .mockResolvedValueOnce([{}])
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce([{}])
      .mockRejectedValueOnce({ code: 409 });
    gcp.firewallsClient = fakeSdkClient({ insert });
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);

    await requirePrepareNetwork(gcp.compute())(
      buildJobIngressSpec(),
      'job-1',
      '0.0.0-test',
      'test-user',
    );

    expect(insert).toHaveBeenCalledWith({
      project: 'test-project',
      firewallResource: {
        name: 'anycloud-shared-vm22',
        targetTags: ['anycloud-shared-vm'],
        sourceRanges: ['0.0.0.0/0'],
        allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      },
    });
    // A dev box's spec: the shared SSH rules only, and no deny.
    expect(
      insert.mock.calls.every(
        ([request]) =>
          request.firewallResource.targetTags[0] === 'anycloud-shared-vm' &&
          !request.firewallResource.denied,
      ),
    ).toBe(true);
  });

  /** A gateway on its own project, so the process-wide network lock starts empty. */
  let projects = 0;
  /** The Jobs network once auto mode has made this region's subnet. */
  const regional = {
    subnetworks: [
      'https://www.googleapis.com/compute/v1/projects/p/regions/us-central1/subnetworks/anycloud-jobs',
    ],
  };
  const jobsGateway = (network: Record<string, unknown>) => {
    const gcp = new GCP(
      completeCloudConfig({
        ...mockConfig,
        credentials: {
          ...mockConfig.credentials,
          projectId: `jobs-project-${++projects}`,
        },
      }),
    );
    const insert = vi.fn().mockResolvedValue([{}]);
    gcp.firewallsClient = fakeSdkClient({ insert });
    gcp.networksClient = fakeSdkClient(network);
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);
    const prepare = () =>
      requirePrepareNetwork(gcp.compute())(
        buildJobIngressSpec([], true),
        'job-1',
        '0.0.0-test',
        'test-user',
      );
    return { gcp, insert, prepare };
  };

  it("0053/S1 makes the Jobs network and puts a VM Job's SSH rules in it", async () => {
    const notFound = Object.assign(new Error('not found'), { code: 404 });
    const network = {
      get: vi
        .fn()
        .mockRejectedValueOnce(notFound)
        .mockResolvedValue([regional]),
      insert: vi.fn().mockResolvedValue([{}]),
    };
    const { gcp, insert, prepare } = jobsGateway(network);

    await prepare();

    expect(network.insert).toHaveBeenCalledWith({
      project: gcp.projectId,
      networkResource: {
        name: 'anycloud-jobs',
        description: 'anycloud VM Jobs',
        autoCreateSubnetworks: true,
      },
    });
    expect(insert).toHaveBeenCalledWith({
      project: gcp.projectId,
      firewallResource: {
        name: 'anycloud-jobs22',
        network: 'global/networks/anycloud-jobs',
        targetTags: ['anycloud-jobs'],
        sourceRanges: ['0.0.0.0/0'],
        allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      },
    });
    // A new network admits nothing else, so no deny rule is needed.
    expect(
      insert.mock.calls.every(
        ([request]) =>
          request.firewallResource.network ===
            'global/networks/anycloud-jobs' && !request.firewallResource.denied,
      ),
    ).toBe(true);
  });

  it('0053/S4 makes the Jobs network once for concurrent Jobs', async () => {
    const network = {
      get: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 404 }))
        .mockResolvedValue([regional]),
      insert: vi.fn().mockResolvedValue([{}]),
    };
    const { gcp, prepare } = jobsGateway(network);
    const second = new GCP(
      completeCloudConfig({
        ...mockConfig,
        credentials: { ...mockConfig.credentials, projectId: gcp.projectId },
      }),
    );
    second.firewallsClient = gcp.firewallsClient;
    second.networksClient = gcp.networksClient;
    vi.spyOn(second as any, 'waitForOperation').mockResolvedValue(undefined);

    await Promise.all([
      prepare(),
      prepare(),
      requirePrepareNetwork(second.compute())(
        buildJobIngressSpec([], true),
        'job-2',
        '0.0.0-test',
        'test-user',
      ),
    ]);

    expect(network.get).toHaveBeenCalledTimes(2);
    expect(network.insert).toHaveBeenCalledTimes(1);
  });

  it('re-checks the Jobs network after 15 minutes, so a deleted one is made again', async () => {
    vi.useFakeTimers();
    try {
      const notFound = Object.assign(new Error('x'), { code: 404 });
      const network = {
        get: vi.fn().mockResolvedValue([regional]),
        insert: vi.fn().mockResolvedValue([{}]),
      };
      const { prepare } = jobsGateway(network);
      await prepare();
      await prepare();
      expect(network.get).toHaveBeenCalledTimes(1);

      network.get.mockRejectedValueOnce(notFound);
      vi.advanceTimersByTime(15 * 60_000 + 1);
      await prepare();
      // Missing, made again, then read back.
      expect(network.get).toHaveBeenCalledTimes(3);
      expect(network.insert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a Jobs network another API process is still making, and this region's subnet", async () => {
    vi.useFakeTimers();
    try {
      const notFound = Object.assign(new Error('x'), { code: 404 });
      const network = {
        get: vi
          .fn()
          .mockRejectedValueOnce(notFound)
          // Readable before auto mode has made this region's subnet.
          .mockResolvedValueOnce([{ subnetworks: [] }])
          .mockResolvedValue([regional]),
        insert: vi.fn().mockRejectedValue({ code: 409 }),
      };
      const { insert, prepare } = jobsGateway(network);
      const prepared = prepare();
      await vi.advanceTimersByTimeAsync(10_000);
      await prepared;
      expect(network.get).toHaveBeenCalledTimes(3);
      // The rules wait for the network to be readable.
      expect(insert.mock.invocationCallOrder[0]).toBeGreaterThan(
        network.get.mock.invocationCallOrder[2],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('0053/I3 fails the Job when the Jobs network cannot be made, with no rule in default', async () => {
    const denied = Object.assign(
      new Error("Required 'compute.networks.create' permission"),
      { code: 403 },
    );
    const { insert, prepare } = jobsGateway({
      get: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { code: 404 })),
      insert: vi.fn().mockRejectedValue(denied),
    });

    await expect(prepare()).rejects.toBe(denied);
    expect(insert).not.toHaveBeenCalled();
  });

  it('maps a scoped ingress-free spec to IP-family deny rules only', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const insert = vi.fn().mockResolvedValue([{}]);
    gcp.firewallsClient = fakeSdkClient({ insert });
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);
    const compute = gcp.compute();
    expect(canManageCloudResources(compute)).toBe(true);
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await compute.prepareResourceNetwork(
      { ingress: [], denyPublicIngress: true },
      { id: 'scope-a', tags: { anycloud_user: 'owner-1' } },
      'test-version',
    );

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenNthCalledWith(1, {
      project: 'test-project',
      firewallResource: {
        name: 'scope-a-peer-deny',
        targetTags: ['scope-a'],
        sourceRanges: ['0.0.0.0/0'],
        priority: 1,
        denied: [{ IPProtocol: 'all' }],
      },
    });
    expect(insert).toHaveBeenNthCalledWith(2, {
      project: 'test-project',
      firewallResource: {
        name: 'scope-a-peer-deny-ipv6',
        targetTags: ['scope-a'],
        sourceRanges: ['::/0'],
        priority: 1,
        denied: [{ IPProtocol: 'all' }],
      },
    });
  });

  it('gives a cluster scope no Job-host deny, now that Jobs have their own network', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const insert = vi.fn().mockResolvedValue([{}]);
    gcp.firewallsClient = fakeSdkClient({ insert });
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);
    const compute = gcp.compute();
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await compute.prepareResourceNetwork(
      {
        ingress: [22, 6443].map((port) => ({
          protocol: 'tcp' as const,
          port,
          sourceRanges: ['0.0.0.0/0'],
        })),
      },
      { id: 'scope-a', tags: { anycloud_user: 'owner-1' } },
      'test-version',
    );

    expect(
      insert.mock.calls.map(([request]) => request.firewallResource.name),
    ).toEqual(['scope-a22', 'scope-a6443']);
  });

  it('names the missing default network when firewall creation cannot find it', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const message =
      "The resource 'projects/test-project/global/networks/default' was not found";
    const notFound = Object.assign(new Error(message), {
      code: 404,
      errors: [{ message, reason: 'notFound' }],
    });
    gcp.firewallsClient = fakeSdkClient({
      insert: vi.fn().mockRejectedValue(notFound),
    });
    const compute = gcp.compute();
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await expect(
      compute.prepareResourceNetwork(
        { ingress: [], denyPublicIngress: true },
        { id: 'scope-a', tags: { anycloud_user: 'owner-1' } },
        'test-version',
      ),
    ).rejects.toMatchObject({
      code: 404,
      message: expect.stringContaining(
        'gcloud compute networks create default --subnet-mode=auto --project test-project',
      ),
      errors: [
        {
          message: expect.stringContaining('has no `default` network'),
          reason: 'notFound',
        },
      ],
    });
  });

  it("names the missing default network on a Job's first launch too", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const message =
      "The resource 'projects/test-project/global/networks/default' was not found";
    gcp.firewallsClient = fakeSdkClient({
      insert: vi.fn().mockImplementation(async () => {
        throw Object.assign(new Error(message), { code: 404 });
      }),
    });
    await expect(
      requirePrepareNetwork(gcp.compute())(
        buildJobIngressSpec(),
        'job-1',
        '0.0.0-test',
        'test-user',
      ),
    ).rejects.toThrow('has no `default` network');
  });

  it('takes the standing rules on a second Job, and surfaces a real failure', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);
    const prepare = () =>
      requirePrepareNetwork(gcp.compute())(
        buildJobIngressSpec(),
        'job-2',
        '0.0.0-test',
        'test-user',
      );
    // A second Job: every standing rule exists.
    gcp.firewallsClient = fakeSdkClient({
      insert: vi.fn().mockRejectedValue({ code: 409 }),
    });
    await expect(prepare()).resolves.toBeUndefined();
    gcp.firewallsClient = fakeSdkClient({
      insert: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('backend error'), { code: 500 }),
        ),
    });
    await expect(prepare()).rejects.toThrow('backend error');
  });

  it('keeps ordinary scope ingress ahead of the scope deny', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const insert = vi.fn().mockResolvedValue([{}]);
    gcp.firewallsClient = fakeSdkClient({ insert });
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);
    const compute = gcp.compute();
    expect(canManageCloudResources(compute)).toBe(true);
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await compute.prepareResourceNetwork(
      {
        ingress: [
          {
            protocol: 'tcp',
            port: 443,
            sourceRanges: ['203.0.113.0/24'],
          },
        ],
        denyPublicIngress: true,
      },
      { id: 'scope-a', tags: { anycloud_user: 'owner-1' } },
      'test-version',
    );

    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert).toHaveBeenNthCalledWith(1, {
      project: 'test-project',
      firewallResource: {
        name: 'scope-a443',
        targetTags: ['scope-a'],
        sourceRanges: ['203.0.113.0/24'],
        priority: 0,
        allowed: [{ IPProtocol: 'tcp', ports: ['443'] }],
      },
    });
    expect(insert).toHaveBeenNthCalledWith(2, {
      project: 'test-project',
      firewallResource: {
        name: 'scope-a-peer-deny',
        targetTags: ['scope-a'],
        sourceRanges: ['0.0.0.0/0'],
        priority: 1,
        denied: [{ IPProtocol: 'all' }],
      },
    });
    expect(insert).toHaveBeenNthCalledWith(3, {
      project: 'test-project',
      firewallResource: {
        name: 'scope-a-peer-deny-ipv6',
        targetTags: ['scope-a'],
        sourceRanges: ['::/0'],
        priority: 1,
        denied: [{ IPProtocol: 'all' }],
      },
    });
  });
});

describe('GCP GPU image selection by gpuRuntime', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'a2-highgpu-1g',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  function newVMProps(gpuRuntime: GpuRuntime | null) {
    return {
      vmId: 'gpu-vm',
      workloadId: 'gpu-deploy',
      ipWhitelist: [],
      startupScript: '#!/bin/bash',
      version: '1.0.0',
      userId: 'u1',
      gpuRuntime,
    };
  }

  it("selects the NVIDIA Deep Learning VM image for gpuRuntime='cuda'", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const getFromFamily = vi
      .fn()
      .mockResolvedValue([{ selfLink: 'projects/dlvm/images/cu128' }]);
    const imagesClient: any = { getFromFamily };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.projectId = 'test-project';
    let inserted: any;
    const instancesClient: any = {
      insert: vi.fn().mockImplementation(async (req: any) => {
        inserted = req.instanceResource;
        return [{ name: 'op' }];
      }),
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await gcp.compute().newVM(newVMProps(GpuRuntime.Cuda));

    // Must request the NVIDIA Deep Learning VM family, not Ubuntu.
    expect(getFromFamily).toHaveBeenCalledWith({
      family: 'common-cu129-ubuntu-2404-nvidia-580',
      project: 'deeplearning-platform-release',
    });
    // GPU instances pin onHostMaintenance=TERMINATE.
    expect(inserted.scheduling?.onHostMaintenance).toBe('TERMINATE');
    expect(inserted).not.toHaveProperty('guestAccelerators');
    expect(inserted.disks[0].initializeParams).toEqual({
      sourceImage: 'projects/dlvm/images/cu128',
      diskType: 'zones/us-central1-a/diskTypes/pd-ssd',
      labels: {
        anycloud_owner_api: '00000000000000000000000000000001',
        anycloud_deployment: 'gpu-deploy',
        anycloud_version: '1_0_0',
        anycloud_user: 'u1',
      },
    });
  });

  it.each([
    ['a Job VM stops', undefined, 'STOP'],
    ['a node pool VM is deleted', { id: 'node-pool-1', tags: {} }, 'DELETE'],
  ])(
    'preempts a spot VM by its owner: %s',
    async (_, resourceScope, action) => {
      const gcp = new GCP(completeCloudConfig({ ...mockConfig, spot: true }));
      const imagesClient: any = {
        getFromFamily: vi.fn().mockResolvedValue([{ selfLink: 'image' }]),
      };
      gcp.imagesClient = fakeSdkClient(imagesClient);
      gcp.projectId = 'test-project';
      let inserted: any;
      const instancesClient: any = {
        insert: vi.fn().mockImplementation(async (req: any) => {
          inserted = req.instanceResource;
          return [{ name: 'op' }];
        }),
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
            ],
          },
        ]),
      };
      gcp.instancesClient = fakeSdkClient(instancesClient);
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

      await gcp
        .compute()
        .newVM({ ...newVMProps(GpuRuntime.Cuda), resourceScope });

      expect(inserted.scheduling).toMatchObject({
        provisioningModel: 'SPOT',
        instanceTerminationAction: action,
      });
    },
  );

  it.each([
    ['g4-standard-48', DiskTier.Medium, 'hyperdisk-balanced', 'GVNIC'],
    ['a4-highgpu-8g', DiskTier.Medium, 'hyperdisk-balanced', 'GVNIC'],
    ['a3-ultragpu-8g', DiskTier.Medium, 'hyperdisk-balanced', 'GVNIC'],
    ['a3-highgpu-8g', DiskTier.Medium, 'pd-balanced', null],
    ['g2-standard-4', DiskTier.Medium, 'pd-balanced', 'GVNIC'],
    ['c4-standard-16', DiskTier.Medium, 'hyperdisk-balanced', null],
    ['h3-standard-88', DiskTier.Medium, 'pd-balanced', null],
    ['h3-standard-88', DiskTier.High, 'hyperdisk-balanced', null],
    ['c3-standard-192-metal', DiskTier.High, 'hyperdisk-balanced', null],
    ['n1-standard-4', DiskTier.Medium, null, null],
  ])(
    'applies the launch hardware translation for %s at %s',
    async (vmType, diskTier, diskType, nicType) => {
      const gcp = new GCP(
        completeCloudConfig({ ...mockConfig, vmType, diskTier }),
      );
      const imagesClient: any = {
        getFromFamily: vi
          .fn()
          .mockResolvedValue([{ selfLink: 'projects/dlvm/images/cu129' }]),
      };
      gcp.imagesClient = fakeSdkClient(imagesClient);
      let inserted: any;
      const instancesClient: any = {
        insert: vi.fn().mockImplementation(async (request: any) => {
          inserted = request.instanceResource;
          return [{ name: 'op' }];
        }),
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
            ],
          },
        ]),
      };
      gcp.instancesClient = fakeSdkClient(instancesClient);
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

      await gcp.compute().newVM(newVMProps(GpuRuntime.Cuda));

      if (diskType) {
        expect(inserted.disks[0].initializeParams.diskType).toBe(
          `zones/us-central1-a/diskTypes/${diskType}`,
        );
      } else {
        expect(inserted.disks[0].initializeParams).not.toHaveProperty(
          'diskType',
        );
      }
      if (nicType) {
        expect(inserted.networkInterfaces[0].nicType).toBe(nicType);
      } else {
        expect(inserted.networkInterfaces[0]).not.toHaveProperty('nicType');
      }
      expect(inserted).not.toHaveProperty('guestAccelerators');
    },
  );

  it.each([
    [false, undefined],
    [true, { enableNestedVirtualization: true }],
  ])(
    'launches a CPU Job host on Ubuntu minimal from user data, nested only when asked (%s)',
    async (nested, features) => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType: 'n2-standard-4',
          diskTier: DiskTier.High,
          nestedVirtualization: nested,
        }),
      );
      const getFromFamily = vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/minimal' }]);
      gcp.imagesClient = fakeSdkClient({ getFromFamily });
      const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
      gcp.instancesClient = fakeSdkClient({
        insert,
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
            ],
          },
        ]),
      });
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

      await gcp.compute().newVM({
        ...newVMProps(null),
        startupScript: '#cloud-config',
        jobHost: true,
      });

      expect(getFromFamily).toHaveBeenCalledWith({
        family: 'ubuntu-minimal-2404-lts-amd64',
        project: 'ubuntu-os-cloud',
      });
      const inserted = insert.mock.calls[0]![0].instanceResource;
      expect(inserted.metadata.items).toEqual([
        { key: 'user-data', value: '#cloud-config' },
      ]);
      expect(inserted.disks[0].initializeParams).toMatchObject({
        diskType: 'zones/us-central1-a/diskTypes/pd-ssd',
        diskSizeGb: 30,
      });
      // A plain VM Job launches as before, so an organization policy that
      // forbids nested virtualization doesn't refuse it.
      expect(inserted.advancedMachineFeatures).toEqual(features);
    },
  );

  it("launches a C4A Job host on its catalog architecture's minimal image and Hyperdisk", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcp-arm64-'));
    vi.stubEnv('ANYCLOUD_DIR', dir);
    clearCatalogCache();
    writeCatalog(
      CloudType.GCP,
      'InstanceType,Region,AvailabilityZone,vCPUs,MemoryGiB,Price,SpotPrice,Arch\n' +
        'c4a-standard-4,us-central1,us-central1-a,4,16,0.18,0.07,arm64\n',
    );
    onTestFinished(() => {
      vi.unstubAllEnvs();
      clearCatalogCache();
      rmSync(dir, { recursive: true, force: true });
    });
    const gcp = new GCP(
      completeCloudConfig({
        ...mockConfig,
        vmType: 'c4a-standard-4',
        diskTier: DiskTier.Medium,
      }),
    );
    const getFromFamily = vi
      .fn()
      .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/arm64' }]);
    gcp.imagesClient = fakeSdkClient({ getFromFamily });
    const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
    gcp.instancesClient = fakeSdkClient({
      insert,
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    });
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await gcp.compute().newVM({ ...newVMProps(null), jobHost: true });

    expect(getFromFamily).toHaveBeenCalledWith({
      family: 'ubuntu-minimal-2404-lts-arm64',
      project: 'ubuntu-os-cloud',
    });
    expect(
      insert.mock.calls[0]![0].instanceResource.disks[0].initializeParams,
    ).toMatchObject({
      sourceImage: 'projects/ubuntu/images/arm64',
      diskType: 'zones/us-central1-a/diskTypes/hyperdisk-balanced',
    });
  });

  it.each([
    ['n1-standard-4', DiskTier.High, 'pd-ssd', 25],
    ['c4-standard-16', DiskTier.Ultra, 'hyperdisk-balanced', 100],
  ])(
    'raises a %s %s boot disk with no size to at least the pool minimum',
    async (vmType, diskTier, diskType, diskSizeGb) => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType,
          diskTier,
          minimumDiskSizeGb: 25,
        }),
      );
      gcp.imagesClient = fakeSdkClient({
        getFromFamily: vi
          .fn()
          .mockResolvedValue([{ selfLink: 'projects/dlvm/images/cu129' }]),
      });
      const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
      gcp.instancesClient = fakeSdkClient({
        insert,
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
            ],
          },
        ]),
      });
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

      await gcp.compute().newVM(newVMProps(GpuRuntime.Cuda));

      expect(
        insert.mock.calls[0]![0].instanceResource.disks[0].initializeParams,
      ).toMatchObject({
        diskType: `zones/us-central1-a/diskTypes/${diskType}`,
        diskSizeGb,
      });
    },
  );

  it("puts only a VM Job's VM in the Jobs network", async () => {
    const tags = async (ingressSpec?: IngressSpec) => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      gcp.imagesClient = fakeSdkClient({
        getFromFamily: vi
          .fn()
          .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
      });
      const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
      gcp.instancesClient = fakeSdkClient({
        insert,
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
            ],
          },
        ]),
      });
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);
      await gcp.compute().newVM({ ...newVMProps(null), ingressSpec });
      const { tags, networkInterfaces } =
        insert.mock.calls[0]![0].instanceResource;
      return [networkInterfaces[0].network, tags.items];
    };
    expect(await tags(buildJobIngressSpec([], true))).toEqual([
      'projects/test-project/global/networks/anycloud-jobs',
      ['gpu-deploy', 'anycloud-jobs'],
    ]);
    // A dev box and a Service stay in the default network.
    expect(await tags(buildJobIngressSpec())).toEqual([
      undefined,
      ['gpu-deploy', 'anycloud-shared-vm'],
    ]);
    expect(await tags(buildServeIngressSpec())).toEqual([
      undefined,
      ['gpu-deploy'],
    ]);
  });

  it('sends the exact pd-ssd initialization policy for G2 high', async () => {
    const gcp = new GCP(
      completeCloudConfig({
        ...mockConfig,
        vmType: 'g2-standard-4',
        diskTier: DiskTier.High,
        diskSizeGb: 81,
      }),
    );
    const imagesClient: any = {
      getFromFamily: vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/dlvm/images/cu129' }]),
    };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
    const instancesClient: any = {
      insert,
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await gcp.compute().newVM(newVMProps(GpuRuntime.Cuda));

    const request = insert.mock.calls[0]?.[0];
    expect(request).toEqual({
      project: 'test-project',
      zone: 'us-central1-a',
      requestId: generateUUIDFromString('gpu-vm'),
      instanceResource: {
        name: 'gpu-vm',
        machineType: 'zones/us-central1-a/machineTypes/g2-standard-4',
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: 'projects/dlvm/images/cu129',
              diskSizeGb: 81,
              diskType: 'zones/us-central1-a/diskTypes/pd-ssd',
              labels: {
                anycloud_owner_api: '00000000000000000000000000000001',
                anycloud_deployment: 'gpu-deploy',
                anycloud_version: '1_0_0',
                anycloud_user: 'u1',
              },
            },
          },
        ],
        networkInterfaces: [
          {
            nicType: 'GVNIC',
            accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
          },
        ],
        metadata: {
          items: [{ key: 'startup-script', value: '#!/bin/bash' }],
        },
        tags: {
          items: ['gpu-deploy', 'anycloud-shared-vm'],
        },
        labels: {
          anycloud_owner_api: '00000000000000000000000000000001',
          anycloud_deployment: 'gpu-deploy',
          anycloud_version: '1_0_0',
          anycloud_user: 'u1',
        },
        scheduling: {
          onHostMaintenance: 'TERMINATE',
          automaticRestart: false,
        },
      },
    });
  });

  it.each([
    ['n2-standard-4', true, undefined],
    ['n2-standard-4', false, undefined],
    ['n1-standard-4', true, 'Intel Haswell'],
    ['n1-standard-4', false, undefined],
  ])(
    'C10: launches %s with nested virtualization only when asked (%s)',
    async (vmType, nestedVirtualization, minCpuPlatform) => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType,
          nestedVirtualization,
        }),
      );
      const imagesClient: any = {
        getFromFamily: vi
          .fn()
          .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
      };
      gcp.imagesClient = fakeSdkClient(imagesClient);
      const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
      const instancesClient: any = {
        insert,
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
            ],
          },
        ]),
      };
      gcp.instancesClient = fakeSdkClient(instancesClient);
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

      await gcp.compute().newVM(newVMProps(null));

      const { instanceResource } = insert.mock.calls[0]![0];
      expect(instanceResource.advancedMachineFeatures).toEqual(
        nestedVirtualization ? { enableNestedVirtualization: true } : undefined,
      );
      expect(instanceResource.minCpuPlatform).toBe(minCpuPlatform);
    },
  );

  it.each([
    [DiskTier.High, '8000'],
    [DiskTier.Ultra, '16000'],
  ])(
    'sends the exact Hyperdisk initialization policy for C4 %s',
    async (diskTier, provisionedIops) => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType: 'c4-standard-16',
          diskTier,
        }),
      );
      const imagesClient: any = {
        getFromFamily: vi
          .fn()
          .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
      };
      gcp.imagesClient = fakeSdkClient(imagesClient);
      const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
      const instancesClient: any = {
        insert,
        get: vi.fn().mockResolvedValue([
          {
            status: 'RUNNING',
            networkInterfaces: [
              {
                networkIP: '10.0.0.2',
                accessConfigs: [{ natIP: '1.2.3.4' }],
              },
            ],
          },
        ]),
      };
      gcp.instancesClient = fakeSdkClient(instancesClient);
      gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

      await gcp.compute().newVM(newVMProps(null));

      const request = insert.mock.calls[0]?.[0];
      expect(request).toEqual({
        project: 'test-project',
        zone: 'us-central1-a',
        requestId: generateUUIDFromString('gpu-vm'),
        instanceResource: {
          name: 'gpu-vm',
          machineType: 'zones/us-central1-a/machineTypes/c4-standard-16',
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: 'projects/ubuntu/images/noble',
                diskSizeGb: 100,
                diskType: 'zones/us-central1-a/diskTypes/hyperdisk-balanced',
                provisionedIops,
                provisionedThroughput: '1000',
                labels: {
                  anycloud_owner_api: '00000000000000000000000000000001',
                  anycloud_deployment: 'gpu-deploy',
                  anycloud_version: '1_0_0',
                  anycloud_user: 'u1',
                },
              },
            },
          ],
          networkInterfaces: [
            {
              accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
            },
          ],
          metadata: {
            items: [{ key: 'startup-script', value: '#!/bin/bash' }],
          },
          tags: {
            items: ['gpu-deploy', 'anycloud-shared-vm'],
          },
          labels: {
            anycloud_owner_api: '00000000000000000000000000000001',
            anycloud_deployment: 'gpu-deploy',
            anycloud_version: '1_0_0',
            anycloud_user: 'u1',
          },
        },
      });
    },
  );

  it.each([
    [DiskTier.High, 15, 16],
    [DiskTier.Ultra, 31, 32],
  ])(
    'rejects a %s Hyperdisk smaller than %i GB',
    async (diskTier, diskSizeGb, minimumSizeGb) => {
      const gcp = new GCP(
        completeCloudConfig({
          ...mockConfig,
          vmType: 'c4-standard-16',
          diskTier,
          diskSizeGb,
        }),
      );
      const imagesClient: any = {
        getFromFamily: vi
          .fn()
          .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
      };
      gcp.imagesClient = fakeSdkClient(imagesClient);
      const insert = vi.fn();
      const instancesClient: any = { insert };
      gcp.instancesClient = fakeSdkClient(instancesClient);

      const error = await gcp
        .compute()
        .newVM(newVMProps(null))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(InvalidAnycloudConfigError);
      expect(error).toMatchObject({
        message: expect.stringContaining(
          `requires --disk-size of at least ${minimumSizeGb} GB`,
        ),
      });
      expect(gcp.compute().classifyError(error)).toBe(
        CloudFailureDiagnosis.InvalidRequest,
      );
      expect(insert).not.toHaveBeenCalled();
    },
  );

  function ownDiskGcp(vmType: string, own: Partial<CloudConfig>) {
    const gcp = new GCP(
      completeCloudConfig({ ...mockConfig, vmType, spot: true, ...own }),
    );
    const imagesClient: any = {
      getFromFamily: vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
    };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
    const instancesClient: any = {
      insert,
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);
    return { gcp, insert };
  }

  it.each([
    [{ diskIops: 3000, diskThroughputMibps: 750 }, '3000', '750'],
    // --disk-iops alone keeps the tier's throughput, down to a quarter of it.
    [{ diskIops: 3000 }, '3000', '750'],
    [{ diskThroughputMibps: 500 }, '8000', '500'],
  ])(
    "sends a Job's own Hyperdisk Balanced performance %j",
    async (own, provisionedIops, provisionedThroughput) => {
      const { gcp, insert } = ownDiskGcp('c4d-standard-4', own);

      await gcp.compute().newVM(newVMProps(null));

      expect(
        insert.mock.calls[0]?.[0].instanceResource.disks[0].initializeParams,
      ).toMatchObject({
        diskSizeGb: 100,
        diskType: 'zones/us-central1-a/diskTypes/hyperdisk-balanced',
        provisionedIops,
        provisionedThroughput,
      });
    },
  );

  it("keeps a Persistent Disk type's tier disk under the Job's own Hyperdisk performance, so its fallback types launch", async () => {
    const { gcp, insert } = ownDiskGcp('n2-standard-4', {
      diskIops: 3000,
      diskThroughputMibps: 750,
    });

    await gcp.compute().newVM(newVMProps(null));

    const params =
      insert.mock.calls[0]?.[0].instanceResource.disks[0].initializeParams;
    expect(params.diskType).toBe('zones/us-central1-a/diskTypes/pd-ssd');
    expect(params.provisionedIops).toBeUndefined();
    expect(params.provisionedThroughput).toBeUndefined();
  });

  it("refuses a Job's own IOPS its explicit Hyperdisk size can't carry as invalid", async () => {
    const { gcp, insert } = ownDiskGcp('c4d-standard-4', {
      diskIops: 20000,
      diskSizeGb: 39,
    });

    const error = await gcp
      .compute()
      .newVM(newVMProps(null))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(InvalidAnycloudConfigError);
    expect(error).toMatchObject({
      message:
        'GCP --disk-iops 20000 on Hyperdisk Balanced requires --disk-size of at least 40 GB for VM type "c4d-standard-4" (got 39 GB).',
    });
    expect(gcp.compute().classifyError(error)).toBe(
      CloudFailureDiagnosis.InvalidRequest,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('uses pd-ssd for an unknown-family high tier', async () => {
    const gcp = new GCP(
      completeCloudConfig({
        ...mockConfig,
        vmType: 'future-standard-4',
        diskTier: DiskTier.High,
      }),
    );
    const imagesClient: any = {
      getFromFamily: vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
    };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    const insert = vi.fn().mockResolvedValue([{ name: 'op' }]);
    const instancesClient: any = {
      insert,
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await gcp.compute().newVM(newVMProps(null));

    expect(
      insert.mock.calls[0]?.[0].instanceResource.disks[0].initializeParams
        .diskType,
    ).toBe('zones/us-central1-a/diskTypes/pd-ssd');
  });

  it('rejects a known machine series that is not launch-qualified', async () => {
    const gcp = new GCP(
      completeCloudConfig({ ...mockConfig, vmType: 'a4x-highgpu-4g' }),
    );
    const getFromFamily = vi.fn();
    const insert = vi.fn();
    const imagesClient: any = { getFromFamily };
    const instancesClient: any = { insert };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.instancesClient = fakeSdkClient(instancesClient);

    await expect(
      gcp.compute().newVM(newVMProps(GpuRuntime.Cuda)),
    ).rejects.toThrow(/a4x-highgpu.*not supported/);
    expect(getFromFamily).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('selects the Ubuntu image (no NVIDIA family) for gpuRuntime=null', async () => {
    const gcp = new GCP(
      completeCloudConfig({ ...mockConfig, vmType: 'n1-standard-4' }),
    );
    const getFromFamily = vi
      .fn()
      .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]);
    const imagesClient: any = { getFromFamily };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.projectId = 'test-project';
    const instancesClient: any = {
      insert: vi.fn().mockResolvedValue([{ name: 'op' }]),
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await gcp.compute().newVM(newVMProps(null));

    expect(getFromFamily).toHaveBeenCalledWith({
      family: 'ubuntu-2404-lts-amd64',
      project: 'ubuntu-os-cloud',
    });
  });

  it('0047/S8 launches a VM without a service account', async () => {
    const gcp = new GCP(
      completeCloudConfig({ ...mockConfig, vmType: 'n1-standard-4' }),
    );
    const imagesClient: any = {
      getFromFamily: vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/noble' }]),
    };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.projectId = 'test-project';
    let inserted: any;
    const instancesClient: any = {
      insert: vi.fn().mockImplementation(async (request: any) => {
        inserted = request.instanceResource;
        return [{ name: 'op' }];
      }),
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await gcp.compute().newVM(newVMProps(null));

    expect(inserted.serviceAccounts).toBeUndefined();
  });

  it('returns the provider instance creation timestamp in milliseconds', async () => {
    const gcp = new GCP(
      completeCloudConfig({ ...mockConfig, vmType: 'n1-standard-4' }),
    );
    const imagesClient: any = {
      getFromFamily: vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/jammy' }]),
    };
    const instancesClient: any = {
      insert: vi.fn().mockResolvedValue([{ name: 'op' }]),
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          creationTimestamp: '2023-11-14T22:13:20.123Z',
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    const vm = await gcp.compute().newVM(newVMProps(null));

    expect(vm.createdAt).toBe(1700000000123);
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-timestamp'],
  ])('omits createdAt when creationTimestamp is %s', async (_, timestamp) => {
    const gcp = new GCP(
      completeCloudConfig({ ...mockConfig, vmType: 'n1-standard-4' }),
    );
    const imagesClient: any = {
      getFromFamily: vi
        .fn()
        .mockResolvedValue([{ selfLink: 'projects/ubuntu/images/jammy' }]),
    };
    const instancesClient: any = {
      insert: vi.fn().mockResolvedValue([{ name: 'op' }]),
      get: vi.fn().mockResolvedValue([
        {
          status: 'RUNNING',
          ...(timestamp !== undefined && { creationTimestamp: timestamp }),
          networkInterfaces: [
            { networkIP: '10.0.0.2', accessConfigs: [{ natIP: '1.2.3.4' }] },
          ],
        },
      ]),
    };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.instancesClient = fakeSdkClient(instancesClient);
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    const vm = await gcp.compute().newVM(newVMProps(null));

    expect(vm).not.toHaveProperty('createdAt');
  });

  it("throws DeployError(400) for gpuRuntime='rocm' — never boots the NVIDIA image", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const getFromFamily = vi.fn();
    const insert = vi.fn();
    const imagesClient: any = { getFromFamily };
    const instancesClient: any = { insert };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.instancesClient = fakeSdkClient(instancesClient);

    await expect(
      gcp.compute().newVM(newVMProps(GpuRuntime.Rocm)),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      gcp.compute().newVM(newVMProps(GpuRuntime.Rocm)),
    ).rejects.toThrow(/AMD|ROCm/);
    // No image lookup and no instance creation — fail before any cloud call.
    expect(getFromFamily).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("throws DeployError(400) for gpuRuntime='unsupported' — never boots the NVIDIA image", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const getFromFamily = vi.fn();
    const insert = vi.fn();
    const imagesClient: any = { getFromFamily };
    const instancesClient: any = { insert };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.instancesClient = fakeSdkClient(instancesClient);

    await expect(
      gcp.compute().newVM(newVMProps(GpuRuntime.Unsupported)),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(getFromFamily).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("throws DeployError(400) for gpuRuntime='neuron' — never boots a GCP image", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const getFromFamily = vi.fn();
    const insert = vi.fn();
    const imagesClient: any = { getFromFamily };
    const instancesClient: any = { insert };
    gcp.imagesClient = fakeSdkClient(imagesClient);
    gcp.instancesClient = fakeSdkClient(instancesClient);

    await expect(
      gcp.compute().newVM(newVMProps(GpuRuntime.Neuron)),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      gcp.compute().newVM(newVMProps(GpuRuntime.Neuron)),
    ).rejects.toThrow(/Neuron.*not supported/i);
    expect(getFromFamily).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('GCP spot instance support', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-micro',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  it('should set spot flag when spot is true', () => {
    const spotConfig = {
      ...mockConfig,
      spot: true,
    };
    const gcp = new GCP(completeCloudConfig(spotConfig));

    expect(gcp.spot).toBe(true);
  });

  it('should not set spot flag when spot is false', () => {
    const regularConfig = {
      ...mockConfig,
      spot: false,
    };
    const gcp = new GCP(completeCloudConfig(regularConfig));

    expect(gcp.spot).toBe(false);
  });

  it('should handle undefined spot flag', () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));

    expect(gcp.spot).toBeUndefined();
  });
});

describe('generateUUIDFromString', () => {
  it('should generate valid UUID v4 format', () => {
    const uuid = generateUUIDFromString('test-vm-id');

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });

  it('should be deterministic (same input = same UUID)', () => {
    const uuid1 = generateUUIDFromString('test-vm-id');
    const uuid2 = generateUUIDFromString('test-vm-id');

    expect(uuid1).toBe(uuid2);
  });

  it('should generate different UUIDs for different inputs', () => {
    const uuid1 = generateUUIDFromString('test-vm-1');
    const uuid2 = generateUUIDFromString('test-vm-2');

    expect(uuid1).not.toBe(uuid2);
  });
});

describe('GCP.hasBucket', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-micro',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  it('should return true when bucket exists', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    gcp.storageClient = fakeSdkClient({
      bucket: vi.fn().mockReturnValue({
        exists: vi.fn().mockResolvedValue([true]),
      }),
    });

    expect(await gcp.storage().hasBucket('my-bucket')).toBe(true);
  });

  it('should return false when bucket does not exist', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    gcp.storageClient = fakeSdkClient({
      bucket: vi.fn().mockReturnValue({
        exists: vi.fn().mockResolvedValue([false]),
      }),
    });

    expect(await gcp.storage().hasBucket('missing-bucket')).toBe(false);
  });
});

describe('GCP.deleteBucket', () => {
  it('deletes every object version before the bucket', async () => {
    const gcp = new GCP(
      completeCloudConfig({
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        availabilityZone: 'a',
        credentials: {
          projectId: 'test-project',
          privateKey: 'test-private-key',
          clientEmail: 'test@test-project.iam.gserviceaccount.com',
        },
      }),
    );
    const deleteFiles = vi.fn().mockResolvedValue(undefined);
    const deleteBucket = vi.fn().mockResolvedValue(undefined);
    const bucket = vi.fn().mockReturnValue({
      exists: vi.fn(async () => [deleteBucket.mock.calls.length === 0]),
      getMetadata: vi.fn().mockResolvedValue([{ labels: {} }]),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      deleteFiles,
      delete: deleteBucket,
    });
    gcp.storageClient = fakeSdkClient({ bucket });

    await gcp.storage().deleteBucket('ckpt-bucket');

    expect(bucket).toHaveBeenCalledWith('ckpt-bucket');
    expect(deleteFiles).toHaveBeenCalledWith({ force: true, versions: true });
    expect(deleteBucket).toHaveBeenCalledOnce();
    expect(deleteFiles.mock.invocationCallOrder[0]).toBeLessThan(
      deleteBucket.mock.invocationCallOrder[0],
    );
  });
});

describe('GCP bucket listing', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  it('maps native bucket metadata and page tokens without tag filtering', async () => {
    const getBuckets = vi.fn().mockResolvedValue([
      [
        {
          name: 'customer-data',
          metadata: {
            location: 'EU',
            timeCreated: '2025-03-04T05:06:07Z',
          },
        },
        { name: 'metadata-unknown', metadata: {} },
      ],
      { pageToken: 'bucket-page-2' },
    ]);
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const storageClient = { getBuckets };
    gcp.storageClient = fakeSdkClient(storageClient as never);
    const storage = gcp.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    await expect(
      storage.listBuckets({ pageSize: 75, cursor: 'bucket-page-1' }),
    ).resolves.toEqual({
      buckets: [
        {
          name: 'customer-data',
          region: 'EU',
          createdAt: new Date('2025-03-04T05:06:07Z').getTime(),
        },
        { name: 'metadata-unknown', region: null, createdAt: null },
      ],
      nextCursor: 'bucket-page-2',
    });
    expect(getBuckets).toHaveBeenCalledWith({
      autoPaginate: false,
      maxResults: 75,
      pageToken: 'bucket-page-1',
    });
  });

  it('maps delimiter prefixes and sends recursive object requests without one', async () => {
    const modified = '2025-04-05T06:07:08Z';
    const getFiles = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            name: 'models/config.json',
            metadata: { size: '8', updated: modified },
          },
          { name: 'models/unknown.bin', metadata: {} },
        ],
        { pageToken: 'object-page-2' },
        { prefixes: ['models/checkpoints/'] },
      ])
      .mockResolvedValueOnce([[], null, {}]);
    const bucket = vi.fn().mockReturnValue({ getFiles });
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const storageClient = { bucket };
    gcp.storageClient = fakeSdkClient(storageClient as never);
    const storage = gcp.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects('models-bucket', {
        prefix: 'models/',
        recursive: false,
        pageSize: 80,
        cursor: 'object-page-1',
      }),
    ).resolves.toEqual({
      entries: [
        { kind: 'prefix', key: 'models/checkpoints/' },
        {
          kind: 'object',
          key: 'models/config.json',
          sizeBytes: 8,
          lastModifiedAt: new Date(modified).getTime(),
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
    expect(getFiles).toHaveBeenNthCalledWith(1, {
      autoPaginate: false,
      prefix: 'models/',
      delimiter: '/',
      maxResults: 80,
      pageToken: 'object-page-1',
    });

    await storage.listObjects('models-bucket', {
      prefix: '',
      recursive: true,
      pageSize: 1000,
    });
    expect(getFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ delimiter: undefined }),
    );
  });

  it('reports a missing bucket listing as BucketNotFoundError without a bucket check', async () => {
    const notFound = Object.assign(
      new Error('The specified bucket does not exist.'),
      { code: 404 },
    );
    const getFiles = vi.fn().mockRejectedValue(notFound);
    // A listing 404 is the bucket; a failing existence check must not matter.
    const exists = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 403 }));
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const storageClient = {
      bucket: vi.fn().mockReturnValue({ getFiles, exists }),
    };
    gcp.storageClient = fakeSdkClient(storageClient as never);
    const storage = gcp.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects('gone', { prefix: '', recursive: true, pageSize: 1 }),
    ).rejects.toEqual(new BucketNotFoundError('gone', notFound));
    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(exists).not.toHaveBeenCalled();
  });

  // GCS answers 404 for a missing bucket and a missing object alike.
  function gcpWithBucket(exists: ReturnType<typeof vi.fn>) {
    const getMetadata = vi.fn();
    const gcp = new GCP(completeCloudConfig(mockConfig));
    gcp.storageClient = fakeSdkClient({
      bucket: vi.fn().mockReturnValue({
        exists,
        file: vi.fn().mockReturnValue({ getMetadata }),
      }),
    });
    return { gcp, getMetadata };
  }

  const notFound = () =>
    Object.assign(new Error('GCS not found'), { code: 404 });

  it.each([
    [false, BucketNotFoundError],
    [true, ObjectNotFoundError],
  ])(
    'classifies a 404 download by whether the bucket exists (%s)',
    async (bucketExists, expected) => {
      const exists = vi.fn().mockResolvedValue([bucketExists]);
      const { gcp, getMetadata } = gcpWithBucket(exists);
      getMetadata.mockRejectedValue(notFound());

      await expect(
        gcp.storage().downloadObject('gone', 'k'),
      ).rejects.toBeInstanceOf(expected);
      expect(getMetadata).toHaveBeenCalledTimes(1);
      expect(exists).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a 404 download whose bucket check fails, and never classifies OAuth "account not found"', async () => {
    const exists = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 403 }));
    const { gcp, getMetadata } = gcpWithBucket(exists);
    const failure = notFound();
    getMetadata.mockRejectedValueOnce(failure);
    await expect(gcp.storage().downloadObject('b', 'k')).rejects.toBe(failure);

    const invalidGrant = Object.assign(
      new Error('invalid_grant: Invalid grant: account not found'),
      { response: { status: 400 } },
    );
    getMetadata.mockRejectedValueOnce(invalidGrant);
    await expect(gcp.storage().downloadObject('b', 'k')).rejects.toBe(
      invalidGrant,
    );
    expect(exists).toHaveBeenCalledTimes(1);
  });

  // @google-cloud/storage 7.17 throws its ApiError with a numeric code for a
  // JSON API failure, and a resumable upload rejects with a GaxiosError that
  // carries the status as `status` instead.
  const apiError = async (code: number) => {
    const { ApiError } = await vi.importActual<
      typeof import('@google-cloud/storage')
    >('@google-cloud/storage');
    return Object.assign(
      new ApiError(
        "alice@proj-123.iam.gserviceaccount.com does not have storage.objects.get access to the Google Cloud Storage object. Permission 'storage.objects.get' denied on resource (or it may not exist).",
      ),
      { code },
    );
  };
  const gaxiosError = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      status,
    });

  it.each([
    [() => apiError(403), 'denied'],
    [async () => gaxiosError(403), 'denied'],
    [() => apiError(429), 'throttled'],
    [async () => gaxiosError(429), 'throttled'],
    [() => apiError(500), undefined],
    [() => apiError(400), undefined],
    // Message text never classifies.
    [async () => new Error('Permission storage.objects.get denied'), undefined],
    [
      async () =>
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      undefined,
    ],
  ])('classifies failure %# as %s', async (makeError, kind) => {
    const { gcp } = gcpWithBucket(vi.fn());
    const failure = await gcp.storage().classifyStorageFailure!(
      await makeError(),
      'b',
      'k',
    );
    expect(failure?.kind).toBe(kind);
  });

  // The JSON API's ApiError gets the response, with lowercase headers, as
  // `response` (nodejs-common's handleResp); so does a GaxiosError.
  it.each([
    [
      'an ApiError',
      async (headers: Record<string, string>) => {
        const { ApiError } = await vi.importActual<
          typeof import('@google-cloud/storage')
        >('@google-cloud/storage');
        // handleResp assigns the response to the error it parsed.
        return Object.assign(new ApiError('rateLimitExceeded'), {
          code: 429,
          response: { statusCode: 429, headers },
        });
      },
    ],
    [
      // gaxios 6's GaxiosError keeps the status and the response, with its
      // headers as a lowercase record; gaxios is not a direct dependency.
      'a GaxiosError',
      async (headers: Record<string, string>) =>
        Object.assign(new Error('Request failed with status code 429'), {
          status: 429,
          response: { status: 429, statusText: 'Too Many Requests', headers },
        }),
    ],
  ])(
    'answers a throttled call from %s with its Retry-After',
    async (_name, throttled) => {
      vi.useFakeTimers({ now: Date.UTC(2026, 9, 8, 12), toFake: ['Date'] });
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => {
        vi.useRealTimers();
        warnLog.mockRestore();
      });
      const storage = gcpWithBucket(vi.fn()).gcp.storage();
      const retryAfter = async (headers: Record<string, string>) => {
        const rejection = await throughBucketStorage(
          storage,
          { credentialName: 'prod-gcp', action: 'list buckets' },
          undefined,
          async () => Promise.reject(await throttled(headers)),
        ).catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(BucketThrottledError);
        return (rejection as BucketThrottledError).retryAfterSeconds;
      };

      expect(await retryAfter({ 'retry-after': '4' })).toBe(4);
      expect(
        await retryAfter({
          'retry-after': new Date(Date.now() + 9_000).toUTCString(),
        }),
      ).toBe(9);
      expect(await retryAfter({})).toBe(1);
    },
  );

  it('reports a denied download as BucketAccessDeniedError from one request, without the principal', async () => {
    const exists = vi.fn();
    const { gcp, getMetadata } = gcpWithBucket(exists);
    getMetadata.mockRejectedValue(await apiError(403));
    const storage = gcp.storage();

    const rejection = await throughBucketStorage(
      storage,
      {
        credentialName: 'prod-gcp',
        action: 'download',
        bucketName: 'b',
        remotePath: 'k',
      },
      undefined,
      () => storage.downloadObject('b', 'k'),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BucketAccessDeniedError);
    expect((rejection as Error).message).toBe(
      'Access denied: credential "prod-gcp" cannot download b/k (GCP HTTP 403). Check the credential and its GCP permissions.',
    );
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(exists).not.toHaveBeenCalled();
  });

  it('reports a resumable upload 404 to a missing bucket as BucketNotFoundError without a bucket check', async () => {
    const exists = vi.fn().mockResolvedValue([true]);
    const { gcp } = gcpWithBucket(exists);
    // gaxios carries the HTTP status as `status`, not `code`.
    const failure = Object.assign(new Error('Not Found'), { status: 404 });
    vi.spyOn(
      internalsOf<{ uploadObject: () => Promise<void> }>(gcp),
      'uploadObject',
    ).mockRejectedValue(failure);

    await expect(
      gcp.storage().uploadObject('gone', 'k', {
        kind: 'buffer',
        bytes: Buffer.from('x'),
        contentLength: 1,
      }),
    ).rejects.toEqual(new BucketNotFoundError('gone', failure));
    expect(exists).not.toHaveBeenCalled();
  });

  it('stops the first-use listing retry when the caller aborts', async () => {
    const invalidGrant = Object.assign(new Error('invalid_grant'), {
      response: {
        status: 400,
        data: {
          error: 'invalid_grant',
          error_description: 'Invalid grant: account not found',
        },
      },
    });
    const controller = new AbortController();
    const getFiles = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw invalidGrant;
    });
    const gcp = new GCP(completeCloudConfig(mockConfig));
    gcp.storageClient = fakeSdkClient({
      bucket: vi.fn().mockReturnValue({ getFiles }),
    });
    const storage = gcp.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects(
        'b',
        { prefix: '', recursive: true, pageSize: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  it('retries an unpropagated key and never reads its "account not found" as a missing bucket', async () => {
    vi.useFakeTimers();
    try {
      const invalidGrant = Object.assign(
        new Error('invalid_grant: Invalid grant: account not found'),
        {
          response: {
            status: 400,
            data: {
              error: 'invalid_grant',
              error_description: 'Invalid grant: account not found',
            },
          },
        },
      );
      const getFiles = vi.fn().mockRejectedValue(invalidGrant);
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const storageClient = {
        bucket: vi.fn().mockReturnValue({ getFiles }),
      };
      gcp.storageClient = fakeSdkClient(storageClient as never);
      const storage = gcp.storage();
      if (!canListObjects(storage)) throw new Error('Expected object listing');

      const listing = storage
        .listObjects('b', { prefix: '', recursive: true, pageSize: 1 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await vi.runAllTimersAsync();

      await expect(listing).resolves.toBe(invalidGrant);
      expect(getFiles).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  // gtoken's shape for a key Google has not accepted everywhere yet (run
  // 37776021622): a 400 whose body names the grant failure.
  const unacceptedKey = () =>
    Object.assign(new Error('invalid_grant: Invalid JWT Signature.'), {
      response: {
        status: 400,
        data: {
          error: 'invalid_grant',
          error_description: 'Invalid JWT Signature.',
        },
      },
    });

  it('retries a download until Google accepts a new key', async () => {
    vi.useFakeTimers();
    try {
      const getMetadata = vi
        .fn()
        .mockRejectedValueOnce(unacceptedKey())
        .mockResolvedValue([{ size: '3' }]);
      const gcp = new GCP(completeCloudConfig(mockConfig));
      gcp.storageClient = fakeSdkClient({
        bucket: vi.fn().mockReturnValue({
          file: vi.fn().mockReturnValue({
            getMetadata,
            createReadStream: () => Readable.from(['abc']),
          }),
        }),
      });
      const download = gcp.storage().downloadObject('b', 'k');
      await vi.runAllTimersAsync();

      await expect(download).resolves.toMatchObject({ contentLength: 3 });
      expect(getMetadata).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an upload with a reopened source until Google accepts a new key', async () => {
    vi.useFakeTimers();
    try {
      const written: string[] = [];
      const createWriteStream = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Writable({
              write: (_chunk, _encoding, done) => done(unacceptedKey()),
            }),
        )
        .mockImplementation(
          () =>
            new Writable({
              write: (chunk: Buffer, _encoding, done) => {
                written.push(chunk.toString());
                done();
              },
            }),
        );
      const gcp = new GCP(completeCloudConfig(mockConfig));
      gcp.storageClient = fakeSdkClient({
        bucket: vi.fn().mockReturnValue({
          file: vi.fn().mockReturnValue({ createWriteStream }),
        }),
      });
      const upload = gcp.storage().uploadObject('b', 'k', {
        kind: 'buffer',
        bytes: Buffer.from('abc'),
        contentLength: 3,
      });
      await vi.runAllTimersAsync();

      await expect(upload).resolves.toBeUndefined();
      expect(createWriteStream).toHaveBeenCalledTimes(2);
      expect(written.join('')).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read a deleted account as an already-deleted object', async () => {
    vi.useFakeTimers();
    try {
      const accountGone = Object.assign(
        new Error('invalid_grant: Invalid grant: account not found'),
        {
          response: {
            status: 400,
            data: {
              error: 'invalid_grant',
              error_description: 'Invalid grant: account not found',
            },
          },
        },
      );
      const remove = vi.fn().mockRejectedValue(accountGone);
      const gcp = new GCP(completeCloudConfig(mockConfig));
      gcp.storageClient = fakeSdkClient({
        bucket: vi.fn().mockReturnValue({
          file: vi.fn().mockReturnValue({ delete: remove }),
        }),
      });
      const deletion = gcp
        .storage()
        .deleteObject('b', 'k')
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await deletion).toBe(accountGone);
      expect(remove).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a key Google still refuses as not ready, not an uncategorized failure', async () => {
    vi.useFakeTimers();
    try {
      const { gcp, getMetadata } = gcpWithBucket(vi.fn());
      getMetadata.mockRejectedValue(unacceptedKey());
      const storage = gcp.storage();
      const rejection = throughBucketStorage(
        storage,
        {
          credentialName: 'new-gcp',
          action: 'download',
          bucketName: 'b',
          remotePath: 'k',
        },
        undefined,
        () => storage.downloadObject('b', 'k'),
      ).catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await rejection).toBeInstanceOf(BucketCredentialNotReadyError);
      expect(getMetadata).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GCP.upsertBucket', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-micro',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  it('should create bucket with labels when it does not exist', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const mockBucket = {
      exists: vi.fn().mockResolvedValue([false]),
    };
    const mockStorageClient = {
      bucket: vi.fn().mockReturnValue(mockBucket),
      createBucket: vi.fn().mockResolvedValue([mockBucket]),
    };
    gcp.storageClient = fakeSdkClient(mockStorageClient);

    await gcp.storage().upsertBucket('new-bucket', '0.3.2', 'test-deploy', '');

    expect(mockStorageClient.createBucket).toHaveBeenCalledWith(
      'new-bucket',
      expect.objectContaining({
        labels: expect.objectContaining({
          anycloud_version: '0_3_2',
        }),
      }),
    );
  });

  it('should skip creation when bucket already exists', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const mockStorageClient = {
      bucket: vi.fn().mockReturnValue({
        exists: vi.fn().mockResolvedValue([true]),
      }),
      createBucket: vi.fn(),
    };
    gcp.storageClient = fakeSdkClient(mockStorageClient);

    await gcp
      .storage()
      .upsertBucket('existing-bucket', '0.3.2', 'test-deploy', '');

    expect(mockStorageClient.createBucket).not.toHaveBeenCalled();
  });

  it('should format version label correctly (replace dots with underscores)', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const mockBucket = {
      exists: vi.fn().mockResolvedValue([false]),
    };
    const mockStorageClient = {
      bucket: vi.fn().mockReturnValue(mockBucket),
      createBucket: vi.fn().mockResolvedValue([mockBucket]),
    };
    gcp.storageClient = fakeSdkClient(mockStorageClient);

    await gcp
      .storage()
      .upsertBucket('test-bucket', '1.2.3-beta.4', 'test-deploy', '');

    expect(mockStorageClient.createBucket).toHaveBeenCalledWith(
      'test-bucket',
      expect.objectContaining({
        labels: expect.objectContaining({
          anycloud_version: '1_2_3-beta_4',
        }),
      }),
    );
  });

  it('reuses the bucket when createBucket loses the race (409 "you already own it")', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const createBucket = vi.fn().mockRejectedValue({
      code: 409,
      message: 'You already own this bucket. Please select another name.',
    });
    gcp.storageClient = fakeSdkClient({
      bucket: vi.fn().mockReturnValue({
        exists: vi.fn().mockResolvedValue([false]),
      }),
      createBucket,
    });

    await expect(
      gcp.storage().upsertBucket('raced-bucket', '0.3.2', 'test-deploy', ''),
    ).resolves.toBeUndefined();
  });

  describe('0043/S22 create-first for a managed bucket', () => {
    beforeEach(() => {
      jwtRequest.mockResolvedValue({ data: { name: 'projects/42' } });
    });
    const create = (createBucket: unknown, projectNumber = '42') => {
      const gcp = new GCP(completeCloudConfig(mockConfig));
      const client = {
        createBucket,
        bucket: vi.fn().mockReturnValue({
          getMetadata: vi.fn().mockResolvedValue([{ projectNumber }]),
        }),
      };
      gcp.storageClient = fakeSdkClient(client as never);
      return gcp.storage().createOwnedBucket('job-1', '0.1.71', 'job-1', 'u');
    };
    const rejecting = (code: number, message: string) =>
      vi.fn().mockRejectedValue(Object.assign(new Error(message), { code }));

    it('creates the bucket with soft delete off, never probing first', async () => {
      const createBucket = vi.fn().mockResolvedValue([{}]);
      await expect(create(createBucket)).resolves.toBe('us-central1');
      expect(createBucket).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          softDeletePolicy: { retentionDurationSeconds: 0 },
        }),
      );
    });

    it("reuses a 409 bucket only when its project is the key's", async () => {
      const owned = rejecting(409, 'You already own this bucket.');
      await expect(create(owned)).resolves.toBe('us-central1');
      expect(jwtRequest).toHaveBeenCalledWith({
        url: 'https://cloudresourcemanager.googleapis.com/v3/projects/test-project',
      });
      await expect(create(owned, '7')).rejects.toBeInstanceOf(
        BucketNameTakenError,
      );
      await expect(
        create(rejecting(409, 'Sorry, that name is not available.')),
      ).rejects.toBeInstanceOf(BucketNameTakenError);
    });

    it('names the permission a refused create or owner check needs', async () => {
      await expect(
        create(rejecting(403, 'The billing account is disabled')),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(
          /storage\.buckets\.create: .*The billing account/,
        ),
      });
      // A 403 that no role fixes still names its reason.
      jwtRequest.mockRejectedValue(
        Object.assign(new Error('SERVICE_DISABLED: Cloud Resource Manager'), {
          status: 403,
        }),
      );
      await expect(
        create(vi.fn().mockResolvedValue([{}])),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(
          /resourcemanager\.projects\.get .*gcp-anycloud-role\.json\): SERVICE_DISABLED/,
        ),
      });
    });
  });

  it('throws on a 409 whose name is taken by another project (not our race)', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const createBucket = vi.fn().mockRejectedValue({
      code: 409,
      message: 'Sorry, that name is not available. Please try a different one.',
    });
    gcp.storageClient = fakeSdkClient({
      bucket: vi.fn().mockReturnValue({
        exists: vi.fn().mockResolvedValue([false]),
      }),
      createBucket,
    });

    await expect(
      gcp.storage().upsertBucket('taken-globally', '0.3.2', 'test-deploy', ''),
    ).rejects.toMatchObject({ code: 409 });
  });
});

describe('GCP.terminateVMs / terminateNetworking', () => {
  const mockConfig = {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-micro',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  };

  it('backfills controller ownership on an exact matching VM', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const setLabels = vi.fn().mockResolvedValue([{ status: 'DONE' }]);
    gcp.instancesClient = fakeSdkClient({
      get: vi.fn().mockResolvedValue([
        {
          labels: {
            anycloud_deployment: 'workload-1',
            anycloud_user: 'user-1',
          },
          labelFingerprint: 'fingerprint',
        },
      ]),
      setLabels,
    });
    gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);

    await expect(
      gcp.apiOwnership().backfillExactVM({
        cloudId: 'vm-1',
        apiIdentity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ownerKind: 'workload',
        ownerId: 'workload-1',
        userId: 'user-1',
      }),
    ).resolves.toBe('updated');
    expect(setLabels).toHaveBeenCalledWith({
      project: 'test-project',
      zone: 'us-central1-a',
      instance: 'vm-1',
      instancesSetLabelsRequestResource: {
        labels: {
          anycloud_deployment: 'workload-1',
          anycloud_user: 'user-1',
          anycloud_owner_api: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        labelFingerprint: 'fingerprint',
      },
    });
  });

  it('should delete instances and firewall rules', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    vi.spyOn(gcp as any, 'tagInstanceForDeletion').mockResolvedValue(undefined);
    vi.spyOn(gcp as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const mockDelete = vi.fn().mockResolvedValue([{ status: 'DONE' }]);
    const mockFirewallDelete = vi.fn(async (request: { firewall: string }) => [
      { name: `global/operations/${request.firewall}-op`, status: 'PENDING' },
    ]);
    const globalWait = vi.fn().mockResolvedValue([{ status: 'DONE' }]);
    const zoneWait = vi.fn().mockResolvedValue([{ status: 'DONE' }]);

    gcp.instancesClient = fakeSdkClient({
      delete: mockDelete,
    });
    gcp.firewallsClient = fakeSdkClient({
      // Teardown matches firewalls by targetTags (set to the workload id at
      // creation), so it reaps the port-suffixed rules and ignores rules owned
      // by other workloads.
      listAsync: vi.fn().mockImplementation(async function* () {
        yield { name: 'test-workload22', targetTags: ['test-workload'] };
        yield { name: 'test-workload80', targetTags: ['test-workload'] };
        yield { name: 'other-dep22', targetTags: ['other-dep'] };
      }),
      delete: mockFirewallDelete,
    });
    gcp.globalOperationsClient = fakeSdkClient({
      wait: globalWait,
    });
    gcp.zoneOperationsClient = fakeSdkClient({
      wait: zoneWait,
    });

    await gcp.compute().terminateVMs(['vm-1', 'vm-2']);
    await gcp.compute().terminateNetworking('test-workload');

    // Should delete both VMs
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith({
      project: 'test-project',
      zone: 'us-central1-a',
      instance: 'vm-1',
    });
    expect(mockDelete).toHaveBeenCalledWith({
      project: 'test-project',
      zone: 'us-central1-a',
      instance: 'vm-2',
    });

    // Deletes exactly this workload's firewall rules, matched by targetTags —
    // including the port-suffixed names the create path uses. Regression guard:
    // the old teardown deleted hardcoded `${id}ssh`/`${id}http` names, which
    // never match the real rules and silently leaked them.
    expect(mockFirewallDelete).toHaveBeenCalledWith({
      project: 'test-project',
      firewall: 'test-workload22',
    });
    expect(mockFirewallDelete).toHaveBeenCalledWith({
      project: 'test-project',
      firewall: 'test-workload80',
    });
    expect(mockFirewallDelete).toHaveBeenCalledTimes(2);
    expect(mockFirewallDelete).not.toHaveBeenCalledWith({
      project: 'test-project',
      firewall: 'other-dep22',
    });
    expect(globalWait).toHaveBeenCalledWith({
      project: 'test-project',
      operation: 'test-workload22-op',
    });
    expect(globalWait).toHaveBeenCalledWith({
      project: 'test-project',
      operation: 'test-workload80-op',
    });
    expect(zoneWait).not.toHaveBeenCalled();
  });

  it('waits for global operations with the global operations client', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const globalWait = vi.fn().mockResolvedValue([{ status: 'DONE' }]);
    const zoneWait = vi.fn().mockResolvedValue([{ status: 'DONE' }]);

    gcp.globalOperationsClient = fakeSdkClient({
      wait: globalWait,
    });
    gcp.zoneOperationsClient = fakeSdkClient({
      wait: zoneWait,
    });

    await gcp.waitForOperation(
      {
        name: 'https://www.googleapis.com/compute/v1/projects/test-project/global/operations/firewall-op',
        status: 'PENDING',
      },
      'global',
    );

    expect(globalWait).toHaveBeenCalledWith({
      operation: 'firewall-op',
      project: 'test-project',
    });
    expect(zoneWait).not.toHaveBeenCalled();
  });

  it('preserves structured errors from a failed Compute operation', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const operationErrors = [
      {
        code: 'ZONE_RESOURCE_POOL_EXHAUSTED',
        message:
          "The zone 'projects/test-project/zones/us-central1-a' does not have enough resources available to fulfill the request. Try a different zone, or try again later.",
      },
    ];
    gcp.zoneOperationsClient = fakeSdkClient({
      wait: vi.fn().mockResolvedValue([
        {
          status: 'DONE',
          error: { errors: operationErrors },
        },
      ]),
    });

    const error = await gcp
      .waitForOperation({ name: 'create-vm-op', status: 'PENDING' })
      .then(
        () => undefined,
        (caught) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ errors: operationErrors });
    expect(gcp.compute().classifyError(error)).toBe(
      CloudFailureDiagnosis.CapacityExhausted,
    );
  });

  it('should handle already deleted VMs gracefully', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    vi.spyOn(gcp as any, 'tagInstanceForDeletion').mockResolvedValue(undefined);
    vi.spyOn(gcp as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const mockDelete = vi.fn().mockRejectedValue({ code: 5 }); // NOT_FOUND
    const mockFirewallDelete = vi.fn().mockResolvedValue([{ status: 'DONE' }]);

    gcp.instancesClient = fakeSdkClient({
      delete: mockDelete,
    });
    gcp.firewallsClient = fakeSdkClient({
      delete: mockFirewallDelete,
    });
    gcp.zoneOperationsClient = fakeSdkClient({
      wait: vi.fn().mockResolvedValue([{ status: 'DONE' }]),
    });

    // Should not throw even though VM is already deleted; 404 is success.
    const deleted = await gcp.compute().terminateVMs(['vm-1']);
    expect(deleted).toEqual(['vm-1']);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('returns only the subset of vmIds the cloud confirmed deleted', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));

    // Stub the per-VM helper so we control which IDs succeed without driving
    // the deleteWithRetry timer chain.
    vi.spyOn(gcp as any, 'terminateVM').mockImplementation(
      async (vmId: unknown) => {
        if (vmId === 'vm-b') throw new Error('quota exceeded');
      },
    );
    vi.spyOn(gcp as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const deleted = await gcp.compute().terminateVMs(['vm-a', 'vm-b', 'vm-c']);

    expect(deleted).toEqual(['vm-a', 'vm-c']);
  });

  it('reports a denied delete after one attempt instead of retrying it', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    vi.spyOn(gcp as any, 'tagInstanceForDeletion').mockResolvedValue(undefined);
    const denied = Object.assign(
      new Error("Required 'compute.instances.delete' permission for vm-1"),
      { code: 7 },
    );
    const deleteInstance = vi.fn().mockRejectedValue(denied);
    gcp.instancesClient = fakeSdkClient({ delete: deleteInstance });
    const onUnconfirmed = vi.fn();

    await expect(
      gcp.compute().terminateVMs(['vm-1'], onUnconfirmed),
    ).resolves.toEqual([]);

    expect(deleteInstance).toHaveBeenCalledTimes(1);
    expect(onUnconfirmed).toHaveBeenCalledExactlyOnceWith('vm-1', denied);
  });

  it('tags instances before deleting them', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const tagInstanceForDeletion = vi
      .spyOn(gcp as any, 'tagInstanceForDeletion')
      .mockResolvedValue(undefined);
    vi.spyOn(gcp as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });
    const deleteInstance = vi.fn().mockResolvedValue([{ status: 'DONE' }]);
    gcp.instancesClient = fakeSdkClient({
      delete: deleteInstance,
    });

    const deleted = await gcp.compute().terminateVMs(['vm-1']);

    expect(deleted).toEqual(['vm-1']);
    expect(tagInstanceForDeletion).toHaveBeenCalledWith('vm-1');
    expect(deleteInstance).toHaveBeenCalledWith({
      project: 'test-project',
      zone: 'us-central1-a',
      instance: 'vm-1',
    });
    expect(tagInstanceForDeletion.mock.invocationCallOrder[0]!).toBeLessThan(
      deleteInstance.mock.invocationCallOrder[0]!,
    );
  });

  it('sweeps through the shared zone delete without targeted tagging', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const deleteInstanceInZone = vi
      .spyOn(gcp as any, 'deleteInstanceInZone')
      .mockResolvedValue(undefined);
    const tagInstanceForDeletion = vi.spyOn(
      gcp as any,
      'tagInstanceForDeletion',
    );
    const instancesClient = {
      listAsync: vi.fn().mockImplementation(async function* () {
        yield {
          name: 'vm-sweep',
          labels: {
            anycloud_deployment: 'sweep-owner',
            anycloud_user: 'anycloud-test',
            anycloud_ended_at: Date.now().toString(),
          },
        };
      }),
    };
    const firewallsClient = {
      listAsync: vi.fn().mockImplementation(async function* () {}),
    };
    const disksClient = {
      listAsync: vi.fn().mockImplementation(async function* () {}),
    };
    const storageClient = {
      getBuckets: vi.fn().mockResolvedValue([[]]),
    };
    gcp.instancesClient = fakeSdkClient(instancesClient as any);
    gcp.firewallsClient = fakeSdkClient(firewallsClient as any);
    gcp.disksClient = fakeSdkClient(disksClient as any);
    gcp.storageClient = fakeSdkClient(storageClient as any);

    const result = await gcp
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toEqual(['vm-sweep']);
    expect(result.errors).toEqual([]);
    expect(deleteInstanceInZone).toHaveBeenCalledWith(
      'vm-sweep',
      'us-central1-a',
    );
    expect(tagInstanceForDeletion).not.toHaveBeenCalled();
  });

  it('never tears down the standing SSH or legacy Job-host rules as a workload', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const listAsync = vi.fn();
    const del = vi.fn();
    gcp.firewallsClient = fakeSdkClient({ listAsync, delete: del });
    for (const tag of [
      'anycloud-shared-vm',
      'anycloud-jobs',
      'anycloud-job-host',
    ])
      await (gcp as any).removeFirewalls(tag);
    expect(listAsync).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('sweeps only the firewalls of workloads whose instances it reclaims', async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const old = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    gcp.instancesClient = fakeSdkClient({
      listAsync: vi.fn().mockImplementation(async function* () {
        yield {
          name: 'vm-ci',
          labels: {
            anycloud_deployment: 'ci-workload',
            anycloud_user: 'anycloud-test',
            anycloud_ended_at: Date.now().toString(),
          },
        };
      }),
    });
    // `customer-svc` runs in another zone, so this zone's sweep can't see it;
    // `ssh` isn't anycloud's at all.
    gcp.firewallsClient = fakeSdkClient({
      listAsync: vi.fn().mockImplementation(async function* () {
        for (const [name, tag] of [
          ['ci-workload22', 'ci-workload'],
          ['customer-svc80', 'customer-svc'],
          ['allow-ssh', 'ssh'],
        ]) {
          yield { name, targetTags: [tag], creationTimestamp: old };
        }
      }),
    });
    gcp.disksClient = fakeSdkClient({
      listAsync: vi.fn().mockImplementation(async function* () {}),
    });

    const result = await gcp
      .sweeper()
      .sweepResources({ ...TEST_RESOURCE_SWEEP_OPTIONS, dryRun: true });

    expect(result.otherResources).toEqual([
      { type: 'firewall', id: 'ci-workload22' },
    ]);
  });

  it("sweeps an installation across zones: its VMs, disks and scope rules, sparing a running workload's", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const hosted = hostedApiIdentity('prod-1');
    const deleteInstanceInZone = vi
      .spyOn(gcp as any, 'deleteInstanceInZone')
      .mockResolvedValue(undefined);
    vi.spyOn(gcp, 'waitForOperation').mockResolvedValue(undefined);
    const listAsync = vi.fn();
    gcp.instancesClient = fakeSdkClient({
      listAsync,
      aggregatedListAsync: vi.fn().mockImplementation(async function* () {
        yield [
          'zones/us-east1-b',
          {
            instances: [
              {
                name: 'anycloud-cluster-prod-1',
                status: 'TERMINATED',
                labels: {
                  anycloud_resource: 'anycloud-cluster-prod-1',
                  anycloud_cluster: 'prod-1',
                },
              },
              {
                name: 'svc-1',
                status: 'RUNNING',
                labels: {
                  anycloud_deployment: 'svc-1',
                  anycloud_owner_api: hosted,
                },
              },
            ],
          },
        ];
        yield [
          'zones/europe-west1-c',
          {
            instances: [
              {
                name: 'pool-a-vm-0',
                status: 'RUNNING',
                labels: {
                  anycloud_resource: 'pool-a',
                  anycloud_cluster: 'prod-1',
                  anycloud_owner_api: hosted,
                },
              },
              {
                name: 'pool-z-vm-0',
                status: 'RUNNING',
                labels: {
                  anycloud_resource: 'pool-z',
                  anycloud_cluster: 'prod-2',
                },
              },
            ],
          },
        ];
      }),
    });
    const deleteFirewall = vi.fn().mockResolvedValue([{}]);
    gcp.firewallsClient = fakeSdkClient({
      delete: deleteFirewall,
      listAsync: vi.fn().mockImplementation(async function* () {
        for (const [name, tag] of [
          ['anycloud-cluster-prod-16443', 'anycloud-cluster-prod-1'],
          ['pool-a22', 'pool-a'],
          // A pool whose VMs are gone, named by the backup manifest.
          ['pool-gone22', 'pool-gone'],
          ['svc-180', 'svc-1'],
          ['pool-z22', 'pool-z'],
          ['allow-ssh', 'pool-a-but-not-named-for-it'],
        ]) {
          yield { name, targetTags: [tag] };
        }
      }),
    });
    const deleteDisk = vi.fn().mockResolvedValue([{}]);
    gcp.disksClient = fakeSdkClient({
      delete: deleteDisk,
      listAsync,
      aggregatedListAsync: vi.fn().mockImplementation(async function* () {
        yield [
          'zones/europe-west1-c',
          {
            disks: [
              {
                name: 'pool-a-vm-0',
                labels: {
                  anycloud_resource: 'pool-a',
                  anycloud_cluster: 'prod-1',
                },
                users: [],
              },
              {
                name: 'svc-1',
                labels: {
                  anycloud_deployment: 'svc-1',
                  anycloud_owner_api: hosted,
                },
              },
            ],
          },
        ];
      }),
    });
    const getBuckets = vi.fn();
    gcp.storageClient = fakeSdkClient({ getBuckets });

    const result = await gcp.sweeper().sweepResources({
      policy: installationSweepPolicy('prod-1', {
        resourceOwnerIds: ['pool-a', 'pool-gone'],
        spareRunningWorkloads: true,
        spareWorkloadIds: ['svc-1'],
      }),
    });

    expect(result.errors).toEqual([]);
    expect(result.vmIds.sort()).toEqual([
      'anycloud-cluster-prod-1',
      'pool-a-vm-0',
    ]);
    expect(deleteInstanceInZone).toHaveBeenCalledWith(
      'anycloud-cluster-prod-1',
      'us-east1-b',
    );
    expect(deleteInstanceInZone).toHaveBeenCalledWith(
      'pool-a-vm-0',
      'europe-west1-c',
    );
    expect(
      deleteFirewall.mock.calls.map(([req]) => req.firewall).sort(),
    ).toEqual(['anycloud-cluster-prod-16443', 'pool-a22', 'pool-gone22']);
    expect(deleteDisk).toHaveBeenCalledWith(
      expect.objectContaining({ zone: 'europe-west1-c', disk: 'pool-a-vm-0' }),
    );
    expect(result.spared).toEqual(
      expect.arrayContaining([
        { type: 'vm', id: 'svc-1', workloadId: 'svc-1' },
        { type: 'firewall', id: 'svc-180', workloadId: 'svc-1' },
        { type: 'disk', id: 'svc-1', workloadId: 'svc-1' },
      ]),
    );
    // One aggregated listing, not this zone's; buckets wait for storage.
    expect(listAsync).not.toHaveBeenCalled();
    expect(getBuckets).not.toHaveBeenCalled();
  });

  it("sweeps an installation's buckets in the storage pass, the managed one by name", async () => {
    const gcp = new GCP(completeCloudConfig(mockConfig));
    const bucket = (name: string, labels?: Record<string, string>) => ({
      name,
      getMetadata: vi.fn().mockResolvedValue([{ labels }]),
    });
    gcp.storageClient = fakeSdkClient({
      getBuckets: vi.fn().mockResolvedValue([
        [
          bucket('prod-1'),
          bucket('job-1', {
            anycloud_deployment: 'job-1',
            anycloud_owner_api: hostedApiIdentity('prod-1'),
          }),
          bucket('other', { anycloud_deployment: 'other' }),
        ],
      ]),
    });

    const result = await gcp.sweeper().sweepStorage!({
      dryRun: true,
      policy: installationSweepPolicy('prod-1', {
        spareRunningWorkloads: true,
      }),
    });

    expect(result.otherResources).toEqual([
      { type: 'bucket', id: 'prod-1' },
      { type: 'bucket', id: 'job-1' },
    ]);
  });

  it('caps concurrent terminate fan-out', async () => {
    // Mirror of the Azure cap test — at 100s+ of vmIds, unbounded
    // Promise.allSettled would exhaust the container's ephemeral socket budget.
    const gcp = new GCP(completeCloudConfig(mockConfig));

    let inflight = 0;
    let peak = 0;
    vi.spyOn(gcp as any, 'terminateVM').mockImplementation(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
    });
    vi.spyOn(gcp as any, 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const vmIds = Array.from({ length: 100 }, (_, i) => `vm-${i}`);
    await gcp.compute().terminateVMs(vmIds);

    // GCP_TERMINATE_CONCURRENCY is 20 — keep this in sync if the constant moves.
    expect(peak).toBeLessThanOrEqual(20);
    expect(peak).toBeGreaterThanOrEqual(15);
  });
});

describe('GCP.newVM availability zone tracking', () => {
  it('should extract availability zone from instance metadata', () => {
    const zoneUrl =
      'https://www.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a';
    const zone = zoneUrl.split('/').pop();
    expect(zone).toBe('us-central1-a');
  });

  it('should handle zone extraction for different regions', () => {
    const testCases = [
      {
        url: 'https://www.googleapis.com/compute/v1/projects/proj/zones/us-east1-b',
        expected: 'us-east1-b',
      },
      {
        url: 'https://www.googleapis.com/compute/v1/projects/proj/zones/europe-west1-c',
        expected: 'europe-west1-c',
      },
      {
        url: 'https://www.googleapis.com/compute/v1/projects/proj/zones/asia-southeast1-a',
        expected: 'asia-southeast1-a',
      },
    ];

    testCases.forEach(({ url, expected }) => {
      const zone = url.split('/').pop();
      expect(zone).toBe(expected);
    });
  });

  describe('Timestamp tagging', () => {
    describe('ended_at tag', () => {
      it('should add anycloud_ended_at label to instance before termination', async () => {
        const mockConfig = {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          availabilityZone: 'a',
          vmType: 'e2-micro',
          credentials: {
            projectId: 'test-project',
            privateKey: 'test-key',
            clientEmail: 'test@test.com',
          },
        };

        const gcp = new GCP(completeCloudConfig(mockConfig));

        const mockInstance = [
          {
            name: 'test-vm',
            labels: {
              anycloud_deployment: 'test-workload',
              anycloud_version: '1_0_0',
            },
            labelFingerprint: 'test-fingerprint',
          },
        ];

        const mockOperation = {
          name: 'operation-123',
          status: 'DONE',
        };

        const mockInstancesClient = {
          get: vi.fn().mockResolvedValue(mockInstance),
          setLabels: vi.fn().mockResolvedValue([mockOperation]),
          delete: vi.fn().mockResolvedValue([mockOperation]),
        };

        // Mock waitForOperation to resolve immediately
        gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);
        gcp.instancesClient = fakeSdkClient(mockInstancesClient as any);
        gcp.projectId = 'test-project';

        await gcp['terminateVM']('test-vm');

        // Verify instance was tagged before deletion
        expect(mockInstancesClient.get).toHaveBeenCalledWith({
          project: 'test-project',
          zone: 'us-central1-a',
          instance: 'test-vm',
        });
        expect(mockInstancesClient.setLabels).toHaveBeenCalled();

        const setLabelsCall = mockInstancesClient.setLabels.mock.calls[0][0];
        expect(
          setLabelsCall.instancesSetLabelsRequestResource.labels
            .anycloud_ended_at,
        ).toBeDefined();
        expect(
          setLabelsCall.instancesSetLabelsRequestResource.labels
            .anycloud_ended_at,
        ).toMatch(/^\d+$/);
        expect(
          Number(
            setLabelsCall.instancesSetLabelsRequestResource.labels
              .anycloud_ended_at,
          ),
        ).toBeGreaterThan(0);
        expect(
          setLabelsCall.instancesSetLabelsRequestResource.labelFingerprint,
        ).toBe('test-fingerprint');
      });

      it('should not block deletion if tagging fails', async () => {
        const mockConfig = {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          availabilityZone: 'a',
          vmType: 'e2-micro',
          credentials: {
            projectId: 'test-project',
            privateKey: 'test-key',
            clientEmail: 'test@test.com',
          },
        };

        const gcp = new GCP(completeCloudConfig(mockConfig));

        const mockOperation = {
          name: 'operation-123',
          status: 'DONE',
        };

        const mockInstancesClient = {
          get: vi.fn().mockRejectedValue(new Error('Tagging failed')),
          delete: vi.fn().mockResolvedValue([mockOperation]),
        };

        // Mock waitForOperation to resolve immediately
        gcp.waitForOperation = vi.fn().mockResolvedValue(undefined);
        gcp.instancesClient = fakeSdkClient(mockInstancesClient as any);
        gcp.projectId = 'test-project';

        vi.useFakeTimers();
        try {
          const termination = gcp['terminateVM']('test-vm');
          await vi.runAllTimersAsync();

          // Should not throw even though tagging failed
          await expect(termination).resolves.toBeUndefined();
        } finally {
          vi.useRealTimers();
        }

        // Verify deletion still proceeded
        expect(mockInstancesClient.delete).toHaveBeenCalled();
      });
    });
  });

  describe('classifyError', () => {
    const instance = new GCP(
      completeCloudConfig({
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        availabilityZone: 'a',
        vmType: 'e2-micro',
        credentials: {
          projectId: 'test-project',
          privateKey: 'test-key',
          clientEmail: 'test@test.iam.gserviceaccount.com',
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

    it('classifies a local disk-policy validation error as InvalidRequest', () => {
      expect(
        instance
          .compute()
          .classifyError(new InvalidAnycloudConfigError('bad disk policy')),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it.each(['INVALID_FIELD_VALUE', 'INVALID_RESOURCE_USAGE'])(
      'classifies disk-specific %s as InvalidRequest',
      (code) => {
        expect(
          instance.compute().classifyError({
            errors: [
              {
                code,
                message:
                  "Invalid value for field 'resource.disks[0].initializeParams.diskType'",
              },
            ],
          }),
        ).toBe(CloudFailureDiagnosis.InvalidRequest);
      },
    );

    it('classifies a gRPC INVALID_ARGUMENT disk error as InvalidRequest', () => {
      expect(
        instance.compute().classifyError({
          code: 3,
          message:
            "Invalid value for field 'resource.disks[0].initializeParams.provisionedIops'",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('does not terminally classify an unrelated INVALID_FIELD_VALUE', () => {
      expect(
        instance.compute().classifyError({
          errors: [
            {
              code: 'INVALID_FIELD_VALUE',
              message: "Invalid value for field 'resource.hostname'",
            },
          ],
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies RESOURCE_EXHAUSTED as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({ code: 'RESOURCE_EXHAUSTED' }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies quota message as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'SOME_CODE',
          message: 'Quota exceeded for resource',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies an account-wide (ALL_REGIONS) quota as QuotaExhaustedAccount', () => {
      expect(
        instance.compute().classifyError({
          code: 'RESOURCE_EXHAUSTED',
          message: "Quota 'CPUS_ALL_REGIONS' exceeded. Limit: 32.0 globally.",
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedAccount);
    });

    it('classifies a per-region quota as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'RESOURCE_EXHAUSTED',
          message: "Quota 'CPUS' exceeded. Limit: 24.0 in region us-central1.",
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies ZONE_RESOURCE_POOL_EXHAUSTED as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          errors: [{ reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' }],
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          errors: [{ reason: 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS' }],
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies Compute operation capacity codes as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED' }],
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies nested Compute operation capacity codes as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          error: {
            errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS' }],
          },
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies the real GCP zone-capacity message as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({
          message:
            "GCP operation failed: The zone 'projects/test-project/zones/us-central1-a' does not have enough resources available to fulfill the request. Try a different zone, or try again later.",
        }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('keeps generic zone unavailability as TemporaryProviderFailure', () => {
      expect(
        instance.compute().classifyError({
          message: 'The zone is temporarily unavailable. Try again later.',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies invalid machineType as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          message: "Invalid value for field 'resource.machineType'",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies VPC_NOT_FOUND as Transient', () => {
      expect(
        instance.compute().classifyError({
          errors: [{ reason: 'VPC_NOT_FOUND' }],
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies SUBNET_NOT_FOUND_FOR_VPC as Transient', () => {
      expect(
        instance.compute().classifyError({
          errors: [{ reason: 'SUBNET_NOT_FOUND_FOR_VPC' }],
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies VPC_NOT_FOUND in message as Transient', () => {
      expect(
        instance.compute().classifyError({
          message: 'VPC_NOT_FOUND for network default',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it.each([
      ['PERMISSION_DENIED', CloudFailureDiagnosis.PermissionDenied],
      ['UNAUTHENTICATED', CloudFailureDiagnosis.BadCredential],
    ])('classifies %s as %s', (code, diagnosis) => {
      expect(instance.compute().classifyError({ code })).toBe(diagnosis);
    });

    it('classifies Storage invalid reason as UserError', () => {
      expect(
        instance.compute().classifyError({ errors: [{ reason: 'invalid' }] }),
      ).toBe(CloudFailureDiagnosis.InvalidRequest);
    });

    it('classifies unknown errors as Transient', () => {
      expect(instance.compute().classifyError({ code: 'SOMETHING_ELSE' })).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });
  });
});

// (transient-transport retry now lives in cloud.ts; tested in cloud.spec.ts)

describe('GCP scoped storage tokens', () => {
  const key = {
    projectId: 'test-project',
    privateKey: 'test-private-key',
    clientEmail: 'test@test-project.iam.gserviceaccount.com',
  };
  const mint = (grants: { bucket: string; mode: 'read' | 'readwrite' }[]) => {
    const storage = new GCP(
      completeCloudConfig({
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'e2-micro',
        credentials: key,
      }),
    ).storage();
    if (!canMintScopedStorageToken(storage))
      throw new Error('Expected GCP storage to mint scoped tokens');
    return storage.mintScopedStorageToken(grants);
  };

  it('0047/S11 exchanges a fresh source token for one bounded to the granted buckets', async () => {
    exchange.mockResolvedValue({
      token: 'downscoped',
      expirationTime: 3_600_000,
    });
    const grants = [
      { bucket: 'inputs', mode: 'read' as const },
      { bucket: 'results', mode: 'readwrite' as const },
    ];

    await expect(mint(grants)).resolves.toEqual({
      credentials: { cloudProvider: CloudType.GCP, accessToken: 'downscoped' },
      expiresAt: 3_600_000,
    });
    await mint(grants);

    // The source client carries every option; the third argument is deprecated.
    expect(
      vi.mocked(DownscopedClient).mock.calls.map((call) => call.length),
    ).toEqual([2, 2]);
    // A new source token per mint gives the downscoped one its full hour.
    const [[first, boundary], [second]] = exchange.mock.calls;
    expect(first).not.toBe(second);
    expect(first.options).toMatchObject({
      email: key.clientEmail,
      key: key.privateKey,
    });
    expect(boundary.accessBoundary.accessBoundaryRules).toEqual([
      {
        availableResource: '//storage.googleapis.com/projects/_/buckets/inputs',
        availablePermissions: ['inRole:roles/storage.objectViewer'],
      },
      {
        availableResource:
          '//storage.googleapis.com/projects/_/buckets/results',
        availablePermissions: ['inRole:roles/storage.objectUser'],
      },
    ]);
  });

  it('0043/S18 limits a prefix grant to its objects and its listings', async () => {
    exchange.mockResolvedValue({ token: 't', expirationTime: 3_600_000 });
    const storage = new GCP(
      completeCloudConfig({
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        vmType: 'e2-micro',
        credentials: key,
      }),
    ).storage();
    if (!canMintScopedStorageToken(storage)) throw new Error('cannot mint');
    await storage.mintScopedStorageToken([
      {
        bucket: 'results',
        prefix: 'job-a/',
        mode: 'readwrite',
        noDelete: true,
      },
    ]);
    const [, boundary] = exchange.mock.calls.at(-1)!;
    expect(boundary.accessBoundary.accessBoundaryRules).toEqual([
      {
        availableResource:
          '//storage.googleapis.com/projects/_/buckets/results',
        availablePermissions: ['inRole:roles/storage.objectUser'],
        availabilityCondition: {
          expression:
            "resource.name.startsWith('projects/_/buckets/results/objects/job-a/') || api.getAttribute('storage.googleapis.com/objectListPrefix', '').startsWith('job-a/')",
        },
      },
    ]);
  });

  it('names the Security Token Service API when the project has it disabled', async () => {
    exchange.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: {
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message:
                'Security Token Service API has not been used in project 123 before or it is disabled.',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'SERVICE_DISABLED',
                  metadata: { service: 'sts.googleapis.com' },
                },
              ],
            },
          },
        },
      }),
    );
    await expect(
      mint([{ bucket: 'results', mode: 'readwrite' }]),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('sts.googleapis.com'),
    });
  });

  it('refuses a downscoped token without an expiry', async () => {
    exchange.mockResolvedValue({ token: 'downscoped', expirationTime: null });
    await expect(
      mint([{ bucket: 'results', mode: 'readwrite' }]),
    ).rejects.toThrow(/expiry/);
  });
});
