import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildComputeValidationTargets,
  resolveAvailableImplicitComputeProvider,
  selectIngressSupportedTargets,
  selectLocallyValidTargets,
  selectRequestShapeValidTargets,
  selectStorageValidTargets,
  targetsPublishPublicEndpoint,
  type ComputeValidationTarget,
} from '../../../src/api/services/compute-validation.js';
import * as admissionChecks from '../../../src/api/services/workload-admission-checks.js';
import { CloudType, type CloudConfig } from '../../../src/shared/cloud.js';
import {
  CatalogUnavailableError,
  InvalidAnycloudConfigError,
  TransientInfraError,
} from '../../../src/shared/errors.js';
import * as catalogReadiness from '../../../src/api/services/catalog-readiness.js';
import { buildServeIngressSpec } from '../../../src/api/services/network.js';
import {
  AZURE_AUTHORIZATION_FAILED,
  GCP_PERMISSION_DENIED,
} from '../../integration/credentials-onboarding/personas.js';
import {
  makeMockCloudCompute,
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
  TEST_GCP_CRED,
} from '../helpers/fixtures.js';

const awsConfig: CloudConfig = {
  cloudProvider: CloudType.AWS,
  credentials: {
    accessKeyId: TEST_AWS_CRED.accessKeyId,
    secretAccessKey: TEST_AWS_CRED.secretAccessKey,
  },
  region: 'us-east-1',
  vmType: 't3.small',
};

function target(
  name: string | null,
  targetConfig: CloudConfig,
): ComputeValidationTarget {
  return {
    name,
    config: targetConfig,
  };
}

describe('compute validation orchestration', () => {
  beforeEach(() => {
    vi.spyOn(catalogReadiness, 'ensureCatalogReady').mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('implicit compute provider resolution', () => {
    it('returns Local only after its ordinary provider validation succeeds', async () => {
      const localCompute = makeMockCloudCompute({
        type: CloudType.Local,
        region: 'local',
        vmType: 'local',
      });
      const validate = vi
        .spyOn(admissionChecks, 'validateCredentials')
        .mockResolvedValue(localCompute);

      await expect(resolveAvailableImplicitComputeProvider()).resolves.toBe(
        CloudType.Local,
      );
      expect(validate).toHaveBeenCalledWith({
        cloudProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
      });
    });

    it('returns no fallback when the Local capability is unavailable', async () => {
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        new Error('smolvm is not running'),
      );

      await expect(
        resolveAvailableImplicitComputeProvider(),
      ).resolves.toBeUndefined();
    });
  });

  describe('targetsPublishPublicEndpoint', () => {
    const localConfig: CloudConfig = {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    };
    it('is true when every target substrate publishes an endpoint', () => {
      expect(targetsPublishPublicEndpoint([target('aws', awsConfig)])).toBe(
        true,
      );
    });

    it('is false when any target substrate publishes none', () => {
      expect(targetsPublishPublicEndpoint([target(null, localConfig)])).toBe(
        false,
      );
      expect(
        targetsPublishPublicEndpoint([
          target('aws', awsConfig),
          target(null, localConfig),
        ]),
      ).toBe(false);
    });

    it('is false with no targets', () => {
      expect(targetsPublishPublicEndpoint([])).toBe(false);
    });
  });

  describe('selectIngressSupportedTargets', () => {
    const ingressSpec = buildServeIngressSpec();

    it('accepts targets whose compute substrate supports the requested ingress', () => {
      const configs: CloudConfig[] = [
        awsConfig,
        {
          cloudProvider: CloudType.Local,
          region: 'local',
          vmType: 'local',
        },
      ];

      for (const config of configs) {
        const candidate = target(null, config);
        expect(selectIngressSupportedTargets([candidate], ingressSpec)).toEqual(
          [candidate],
        );
      }
    });
  });

  describe('buildComputeValidationTargets', () => {
    it('turns a resolved named compute credential into a validating target', async () => {
      const targets = await buildComputeValidationTargets(
        {
          ...awsConfig,
          cloudProvider: CloudType.GCP,
          credentials: {
            projectId: TEST_GCP_CRED.projectId,
            privateKey: TEST_GCP_CRED.privateKey,
            clientEmail: TEST_GCP_CRED.clientEmail,
          },
        },
        {
          id: 'aws-id',
          name: 'aws-main',
          creds: TEST_AWS_CRED,
          cloudProvider: CloudType.AWS,
        },
        false,
      );

      expect(targets).toEqual([
        {
          name: 'aws-main',
          config: {
            ...awsConfig,
            cloudProvider: CloudType.AWS,
          },
        },
      ]);
    });

    it('rejects remote compute without a selected credential', async () => {
      await expect(
        buildComputeValidationTargets(
          { ...awsConfig, credentials: undefined },
          undefined,
          false,
        ),
      ).rejects.toThrow('Remote compute requires a selected credential');
    });

    it('builds credentialless Local as a validating target', async () => {
      const localConfig: CloudConfig = {
        cloudProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
      };

      const targets = await buildComputeValidationTargets(
        localConfig,
        undefined,
        false,
      );

      expect(targets).toEqual([
        {
          name: null,
          config: localConfig,
        },
      ]);
    });
  });

  describe('selectRequestShapeValidTargets', () => {
    it('bootstraps a selected target catalog before availability validation', async () => {
      const awsTarget = target('aws-main', awsConfig);

      await expect(
        selectRequestShapeValidTargets(
          [awsTarget],
          { vmTypes: ['t3.small'], gpuTypes: [] },
          undefined,
        ),
      ).resolves.toEqual([awsTarget]);

      expect(catalogReadiness.ensureCatalogReady).toHaveBeenCalledWith(
        CloudType.AWS,
      );
    });

    it('surfaces selected catalog failures as catalog-unavailable', async () => {
      vi.mocked(catalogReadiness.ensureCatalogReady).mockRejectedValueOnce(
        new CatalogUnavailableError(
          'Catalog for AWS is temporarily unavailable; retry shortly.',
        ),
      );

      await expect(
        selectRequestShapeValidTargets(
          [target('aws-main', awsConfig)],
          { vmTypes: ['t3.small'], gpuTypes: [] },
          undefined,
        ),
      ).rejects.toThrow(CatalogUnavailableError);
    });

    it('returns catalog-unavailable when the selected target catalog is unavailable', async () => {
      vi.mocked(catalogReadiness.ensureCatalogReady).mockRejectedValue(
        new CatalogUnavailableError(
          'Catalog for AWS is temporarily unavailable; retry shortly.',
        ),
      );

      await expect(
        selectRequestShapeValidTargets(
          [target('aws-main', awsConfig)],
          { vmTypes: ['t3.small'], gpuTypes: [] },
          undefined,
        ),
      ).rejects.toThrow(CatalogUnavailableError);
    });
  });

  describe('selectLocallyValidTargets', () => {
    it('validates inline or selected targets through conduct credential validation', async () => {
      const gateway = { type: CloudType.AWS, region: 'us-east-1' };
      vi.spyOn(admissionChecks, 'validateCredentials').mockResolvedValue(
        gateway as any,
      );
      await expect(
        selectLocallyValidTargets([target('aws-main', awsConfig)]),
      ).resolves.toEqual([target('aws-main', awsConfig)]);

      expect(admissionChecks.validateCredentials).toHaveBeenCalledWith(
        awsConfig,
      );
    });

    it('maps a positively terminal credential rejection to a 400 admission error', async () => {
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(
          new Error(
            'Invalid AWS credentials for region us-east-1: The security token included in the request is invalid.',
          ),
          { Code: 'InvalidClientTokenId' },
        ),
      );
      const failure = await selectLocallyValidTargets([
        target('aws-main', awsConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(InvalidAnycloudConfigError);
      expect((failure as InvalidAnycloudConfigError).statusCode).toBe(400);
      expect((failure as Error).message).toContain(
        'Cloud credential "aws-main" failed AWS validation: Invalid AWS credentials for region us-east-1',
      );
    });

    it('maps a nonexistent Azure directory to a 400 admission error', async () => {
      const azureConfig: CloudConfig = {
        cloudProvider: CloudType.Azure,
        credentials: {
          subscriptionId: '12345678-1234-1234-1234-123456789012',
          directoryId: 'not-a-real-directory',
          applicationId: '87654321-4321-4321-4321-210987654321',
          secret: 'test-secret',
        },
        region: 'eastus2',
        vmType: 'Standard_B1s',
      };
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(
          new Error(
            "invalid_request: AADSTS90002: Tenant 'not-a-real-directory' not found.",
          ),
          { name: 'AuthenticationRequiredError' },
        ),
      );

      const failure = await selectLocallyValidTargets([
        target('azure-main', azureConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(InvalidAnycloudConfigError);
      expect((failure as InvalidAnycloudConfigError).statusCode).toBe(400);
      expect((failure as Error).message).toContain(
        'Cloud credential "azure-main" failed Azure validation',
      );
    });

    it('maps a nonexistent Azure subscription to a 400 admission error', async () => {
      const azureConfig: CloudConfig = {
        cloudProvider: CloudType.Azure,
        credentials: {
          subscriptionId: '00000000-0000-0000-0000-000000000000',
          directoryId: '12345678-1234-1234-1234-123456789012',
          applicationId: '87654321-4321-4321-4321-210987654321',
          secret: 'test-secret',
        },
        region: 'eastus2',
        vmType: 'Standard_B1s',
      };
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(
          new Error(
            "The subscription '00000000-0000-0000-0000-000000000000' could not be found.",
          ),
          { code: 'SubscriptionNotFound', statusCode: 404 },
        ),
      );

      const failure = await selectLocallyValidTargets([
        target('azure-main', azureConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(InvalidAnycloudConfigError);
      expect((failure as InvalidAnycloudConfigError).statusCode).toBe(400);
      expect((failure as Error).message).toContain(
        'Cloud credential "azure-main" failed Azure validation',
      );
    });

    it('keeps AWS AuthFailure retryable because it is not a terminal-secret signal', async () => {
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(
          new Error(
            'Invalid AWS credentials for region us-east-1: AWS was not able to validate the provided access credentials',
          ),
          { Code: 'AuthFailure' },
        ),
      );
      const failure = await selectLocallyValidTargets([
        target('aws-main', awsConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransientInfraError);
      expect((failure as TransientInfraError).statusCode).toBe(503);
      expect((failure as Error).message).toContain(
        'AWS could not conclusively validate cloud credential "aws-main"',
      );
    });

    it('keeps GCP UNAUTHENTICATED retryable without a terminal-secret classifier', async () => {
      const gcpConfig: CloudConfig = {
        cloudProvider: CloudType.GCP,
        credentials: {
          projectId: TEST_GCP_CRED.projectId,
          privateKey: TEST_GCP_CRED.privateKey,
          clientEmail: TEST_GCP_CRED.clientEmail,
        },
        region: 'us-east4',
        availabilityZone: 'a',
        vmType: 'f1-micro',
      };
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(new Error('UNAUTHENTICATED'), {
          code: 401,
          errors: [{ reason: 'unauthorized' }],
        }),
      );
      const failure = await selectLocallyValidTargets([
        target('gcp-main', gcpConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransientInfraError);
      expect((failure as TransientInfraError).statusCode).toBe(503);
      expect((failure as Error).message).toContain(
        'GCP could not conclusively validate cloud credential "gcp-main"',
      );
    });

    it.each([
      {
        config: {
          cloudProvider: CloudType.Azure,
          credentials: TEST_AZURE_CRED,
          region: 'eastus2',
          vmType: 'Standard_B1s',
        } satisfies CloudConfig,
        persona: AZURE_AUTHORIZATION_FAILED,
        error: {
          name: 'RestError',
          code: AZURE_AUTHORIZATION_FAILED.code,
          statusCode: AZURE_AUTHORIZATION_FAILED.httpStatus,
        },
      },
      {
        config: {
          cloudProvider: CloudType.GCP,
          credentials: TEST_GCP_CRED,
          region: 'us-east4',
          vmType: 'f1-micro',
        } satisfies CloudConfig,
        persona: GCP_PERMISSION_DENIED,
        error: { code: 403, errors: [{ reason: 'forbidden' }] },
      },
    ])(
      '0047: rejects a $config.cloudProvider permission denial with a 400 naming the action',
      async ({ config, persona, error }) => {
        vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
          Object.assign(new Error(persona.message), error),
        );
        const failure = await selectLocallyValidTargets([
          target('scoped', config),
        ]).catch((rejection: unknown) => rejection);

        expect(failure).toBeInstanceOf(InvalidAnycloudConfigError);
        expect((failure as InvalidAnycloudConfigError).statusCode).toBe(400);
        const message = (failure as Error).message;
        expect(message).toContain(persona.action);
        expect(message).toContain(config.region);
        expect(message).toContain(
          'https://anycloud.sh/reference/cli/credentials#ask-an-administrator',
        );
        expect(message).not.toMatch(/arn:|\/subscriptions\/|projects\//);
      },
    );

    it('maps a provider outage to a declared retryable admission error', async () => {
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        new Error('connect ETIMEDOUT 52.94.233.129:443'),
      );
      const rejection = expect(
        selectLocallyValidTargets([target('aws-main', awsConfig)]),
      ).rejects;
      await rejection.toBeInstanceOf(TransientInfraError);
      await rejection.toThrow(
        'AWS is temporarily unavailable while validating cloud credentials — please retry.',
      );
      await rejection.not.toThrow('failed AWS validation');
    });

    it('maps a standard fetch deadline timeout to a retryable admission error', async () => {
      const lambdaConfig: CloudConfig = {
        cloudProvider: CloudType.Lambda,
        credentials: { apiKey: 'lambda-key' },
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
      };
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );

      const failure = await selectLocallyValidTargets([
        target('lambda-main', lambdaConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransientInfraError);
      expect((failure as TransientInfraError).statusCode).toBe(503);
      expect((failure as Error).message).toBe(
        'Lambda is temporarily unavailable while validating cloud credentials — please retry.',
      );
    });

    it('maps a wrapped connection refusal to a declared retryable admission error', async () => {
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(new Error('AWS SDK request failed'), {
          cause: Object.assign(new Error('connect failed'), {
            code: 'ECONNREFUSED',
          }),
        }),
      );

      const failure = await selectLocallyValidTargets([
        target('aws-main', awsConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransientInfraError);
      expect((failure as TransientInfraError).statusCode).toBe(503);
    });

    it('maps an explicit provider 5xx to a declared retryable admission error', async () => {
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(new Error('Service unavailable'), {
          $metadata: { httpStatusCode: 503 },
        }),
      );
      const failure = await selectLocallyValidTargets([
        target('aws-main', awsConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransientInfraError);
      expect((failure as TransientInfraError).statusCode).toBe(503);
      expect((failure as Error).message).toBe(
        'AWS is temporarily unavailable while validating cloud credentials — please retry.',
      );
    });

    it('lets an HTTP 429 override a provisioning-oriented quota diagnosis', async () => {
      const lambdaConfig: CloudConfig = {
        cloudProvider: CloudType.Lambda,
        credentials: { apiKey: 'lambda-key' },
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
      };
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        Object.assign(
          new Error(
            'Lambda API GET /ssh-keys: [global/quota-exceeded] Quota exceeded',
          ),
          { statusCode: 429 },
        ),
      );
      const failure = await selectLocallyValidTargets([
        target('lambda-main', lambdaConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransientInfraError);
      expect((failure as TransientInfraError).statusCode).toBe(503);
    });

    it('does not turn an unclassified local failure into a provider outage', async () => {
      const parserFailure = new Error('unexpected local credential parser bug');
      vi.spyOn(admissionChecks, 'validateCredentials').mockRejectedValue(
        parserFailure,
      );

      const failure = await selectLocallyValidTargets([
        target('aws-main', awsConfig),
      ]).catch((error: unknown) => error);

      expect(failure).toBe(parserFailure);
      expect(failure).not.toBeInstanceOf(TransientInfraError);
    });
  });

  describe('selectStorageValidTargets', () => {
    it('rejects storage independently of compute validation', () => {
      const validateCredentials = vi.spyOn(
        admissionChecks,
        'validateCredentials',
      );
      const lambdaConfig: CloudConfig = {
        cloudProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
        inputBucket: 'lambda-input',
      };

      expect(() =>
        selectStorageValidTargets([target('lambda-a', lambdaConfig)]),
      ).toThrow('Lambda does not provide storage');
      expect(validateCredentials).not.toHaveBeenCalled();
    });

    it('accepts storage with scoped-token credentials', () => {
      const lambdaConfig: CloudConfig = {
        cloudProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
        inputBucket: 'lambda-input',
        inputStorageCredentials: TEST_AWS_CRED,
        inputStorageRegion: 'us-east-1',
      };
      const targets = [target('lambda-a', lambdaConfig)];

      expect(selectStorageValidTargets(targets)).toBe(targets);
    });
  });
});
