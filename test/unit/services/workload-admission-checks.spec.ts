import { describe, it, expect, beforeEach, vi } from 'vitest';

// Terminal states now always release the VM, so completion runs teardown. These
// tests are about the completion decision, not the provider call, so stub the
// compute provider rather than letting teardown reach a real cloud SDK.
vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...actual,
    createComputeProvider: vi.fn(
      (cloudConfig: import('../../../src/shared/cloud.js').CloudConfig) => ({
        type: cloudConfig.cloudProvider,
        region: cloudConfig.region ?? '',
        terminateVMs: vi.fn(async (vmIds: string[]) => vmIds),
        terminateNetworking: vi.fn(async () => undefined),
        classifyError: vi.fn(() => undefined),
        isTerminalAuthError: vi.fn(() => false),
      }),
    ),
  };
});

import {
  validateCredentials,
  validateId,
} from '../../../src/api/services/workload-admission-checks';
import {
  TEST_AWS_CRED,
  TEST_AZURE_CRED,
  TEST_GCP_CRED,
} from '../helpers/fixtures';
import { CloudFailureDiagnosis } from '../../../src/shared/cloud.js';
import { createCloudCompute } from '../../../src/api/services/gateways/cloud';
import { CloudType } from '../../../src/shared/cloud.js';
import { resetTestStore } from '../utils';
import {
  DeployError,
  InvalidAnycloudConfigError,
  InvalidWorkloadIdError,
  WorkloadIdExistsError,
} from '../../../src/shared/errors';
import { createComputeProvider } from '../../../src/api/services/cloud-config';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../../src/api/services/repositories/db.js';

describe('credential validation recovery', () => {
  it('uses the provider recovery budget for a propagation failure', async () => {
    vi.useFakeTimers();
    const failure = new Error('AADSTS7000215: Invalid client secret provided.');
    const validate = vi.fn();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      validate.mockRejectedValueOnce(failure);
    }
    validate.mockResolvedValueOnce(undefined);
    vi.mocked(createComputeProvider).mockReturnValueOnce(
      createCloudCompute({
        type: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        rawValidateCredentials: validate,
        credentialValidationRetryPolicy: {
          maxAttempts: 9,
          waitMs: 500,
          maxWaitMs: 8_000,
          shouldRetry: (error: unknown) => error === failure,
        },
        rawClassifyError: vi.fn(() => CloudFailureDiagnosis.BadCredential),
        rawNewVM: vi.fn(),
        rawRequestVMTermination: vi.fn(),
        rawTerminateNetworking: vi.fn(),
        rawGetAllVMs: vi.fn(),
        rawUpsertFirewall: vi.fn(),
        observeVMReleaseOnce: vi.fn(),
        terminalAuthErrorClassifier: {
          isTerminalAuthError: () => true,
        },
      }),
    );

    try {
      const startedAt = Date.now();
      const validation = validateCredentials({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: TEST_AZURE_CRED,
      });
      await vi.runAllTimersAsync();

      await expect(validation).resolves.toMatchObject({
        type: CloudType.Azure,
      });
      expect(validate).toHaveBeenCalledTimes(7);
      expect(Date.now() - startedAt).toBe(23_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the ordinary three-attempt budget for other failures', async () => {
    vi.useFakeTimers();
    const failure = new Error('unrelated credential failure');
    const validate = vi.fn().mockRejectedValue(failure);
    vi.mocked(createComputeProvider).mockReturnValueOnce(
      createCloudCompute({
        type: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        rawValidateCredentials: validate,
        credentialValidationRetryPolicy: {
          maxAttempts: 9,
          waitMs: 500,
          maxWaitMs: 8_000,
          shouldRetry: () => false,
        },
        rawClassifyError: vi.fn(),
        rawNewVM: vi.fn(),
        rawRequestVMTermination: vi.fn(),
        rawTerminateNetworking: vi.fn(),
        rawGetAllVMs: vi.fn(),
        rawUpsertFirewall: vi.fn(),
        observeVMReleaseOnce: vi.fn(),
      }),
    );

    try {
      const rejected = validateCredentials({
        cloudProvider: CloudType.Azure,
        region: 'eastus',
        vmType: 'Standard_B1s',
        credentials: TEST_AZURE_CRED,
      }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      await expect(rejected).resolves.toBe(failure);
      expect(validate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a standard fetch timeout when adding credential context', async () => {
    vi.useFakeTimers();
    const failure = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    const validate = vi.fn().mockRejectedValue(failure);
    vi.mocked(createComputeProvider).mockReturnValueOnce(
      createCloudCompute({
        type: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
        rawValidateCredentials: validate,
        rawClassifyError: vi.fn(
          () => CloudFailureDiagnosis.TemporaryProviderFailure,
        ),
        rawNewVM: vi.fn(),
        rawRequestVMTermination: vi.fn(),
        rawTerminateNetworking: vi.fn(),
        rawGetAllVMs: vi.fn(),
        rawUpsertFirewall: vi.fn(),
        observeVMReleaseOnce: vi.fn(),
      }),
    );

    try {
      const rejected = validateCredentials({
        cloudProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a100_sxm4',
        credentials: { apiKey: 'lambda-key' },
      }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      const error = await rejected;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        'Invalid Lambda credentials for region us-east-1: The operation was aborted due to timeout',
      );
      expect((error as Error).cause).toBe(failure);
      expect(validate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'a declared local credential configuration failure',
      failure: new InvalidAnycloudConfigError('malformed private key'),
      diagnosis: CloudFailureDiagnosis.InvalidRequest,
    },
    {
      name: 'a permission denial',
      failure: Object.assign(new Error('Permission denied'), { code: 403 }),
      diagnosis: CloudFailureDiagnosis.PermissionDenied,
    },
  ])('does not retry $name', async ({ failure, diagnosis }) => {
    const validate = vi.fn().mockRejectedValue(failure);
    vi.mocked(createComputeProvider).mockReturnValueOnce(
      createCloudCompute({
        type: CloudType.GCP,
        region: 'us-east4',
        vmType: 'f1-micro',
        rawValidateCredentials: validate,
        rawClassifyError: vi.fn(() => diagnosis),
        rawNewVM: vi.fn(),
        rawRequestVMTermination: vi.fn(),
        rawTerminateNetworking: vi.fn(),
        rawGetAllVMs: vi.fn(),
        rawUpsertFirewall: vi.fn(),
        observeVMReleaseOnce: vi.fn(),
      }),
    );

    await expect(
      validateCredentials({
        cloudProvider: CloudType.GCP,
        region: 'us-east4',
        vmType: 'f1-micro',
        credentials: TEST_GCP_CRED,
      }),
    ).rejects.toBe(failure);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('does not retry a positively terminal credential rejection', async () => {
    const failure = Object.assign(new Error('invalid client token'), {
      code: 'InvalidClientTokenId',
    });
    const validate = vi.fn().mockRejectedValue(failure);
    vi.mocked(createComputeProvider).mockReturnValueOnce(
      createCloudCompute({
        type: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
        rawValidateCredentials: validate,
        rawClassifyError: vi.fn(() => CloudFailureDiagnosis.BadCredential),
        rawNewVM: vi.fn(),
        rawRequestVMTermination: vi.fn(),
        rawTerminateNetworking: vi.fn(),
        rawGetAllVMs: vi.fn(),
        rawUpsertFirewall: vi.fn(),
        observeVMReleaseOnce: vi.fn(),
        terminalAuthErrorClassifier: {
          isTerminalAuthError: (error) => error === failure,
        },
      }),
    );

    await expect(
      validateCredentials({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.small',
        credentials: TEST_AWS_CRED,
      }),
    ).rejects.toBe(failure);
    expect(validate).toHaveBeenCalledTimes(1);
  });
});

describe('validateId', () => {
  beforeEach(async () => {
    // Migrations auto-run on fresh SQLiteDatabase in LOCAL mode
    await resetTestStore();
  });

  describe('workload IDs - validation', () => {
    it('should accept valid custom workload ID with letters and numbers', async () => {
      const id = await validateId('my-workload-123');

      expect(id).toBe('my-workload-123');
    });

    it('should accept workload ID with only letters', async () => {
      const id = await validateId('myapp');

      expect(id).toBe('myapp');
    });

    it('should accept workload ID with only numbers', async () => {
      const id = await validateId('123456');

      expect(id).toBe('123456');
    });

    it('should accept workload ID with hyphens', async () => {
      const id = await validateId('my-awesome-app-v2');

      expect(id).toBe('my-awesome-app-v2');
    });

    it('should reject workload ID with uppercase letters', async () => {
      await expect(validateId('MyApp-123')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('myAPP')).rejects.toThrow(InvalidWorkloadIdError);
      await expect(validateId('ALLCAPS')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('myAPP')).rejects.toThrow(
        'Workload ID "myAPP" must contain only lowercase letters, numbers and hyphens, and must start and end with a letter or number.',
      );
    });

    it('should accept workload ID at maximum length (28 chars)', async () => {
      const maxLengthId = 'a'.repeat(28);
      const id = await validateId(maxLengthId);

      expect(id).toBe(maxLengthId);
      expect(id.length).toBe(28);
    });

    it('should accept workload ID at minimum length (1 char)', async () => {
      const id = await validateId('a');

      expect(id).toBe('a');
    });
  });

  describe('workload IDs - invalid format errors', () => {
    it('should reject workload ID with underscores', async () => {
      await expect(validateId('my_app')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('my_app')).rejects.toThrow(
        /must contain only lowercase letters, numbers and hyphens/,
      );

      try {
        await validateId('my_app');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidWorkloadIdError);
        expect((error as DeployError).statusCode).toBe(400);
      }
    });

    it('should reject workload ID with spaces', async () => {
      await expect(validateId('my workload')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('my workload')).rejects.toThrow(
        /must contain only lowercase letters, numbers and hyphens/,
      );
    });

    it('should reject workload ID with special characters', async () => {
      await expect(validateId('my-workload!')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('my-workload@domain')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('my.app')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId('my$app')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
    });

    it('should reject undefined workload ID', async () => {
      await expect(validateId(undefined as unknown as string)).rejects.toThrow(
        InvalidWorkloadIdError,
      );
    });

    it('should reject empty string workload ID', async () => {
      await expect(validateId('')).rejects.toThrow(InvalidWorkloadIdError);
    });

    it('should reject workload ID exceeding max length (29+ chars)', async () => {
      const tooLongId = 'a'.repeat(29);

      await expect(validateId(tooLongId)).rejects.toThrow(
        InvalidWorkloadIdError,
      );
      await expect(validateId(tooLongId)).rejects.toThrow(
        `Workload ID "${tooLongId}" is 29 characters; the limit is 28.`,
      );

      const wayTooLongId = 'a'.repeat(100);
      await expect(validateId(wayTooLongId)).rejects.toThrow(
        InvalidWorkloadIdError,
      );
    });
  });

  describe('workload IDs - collision detection', () => {
    it('should reject workload ID that already exists', async () => {
      // Create a workload in the store to simulate existing workload
      await createWorkload(getDB(), {
        id: 'existing-app',
        userId: 'test-user',
        workloadType: 'job',
        image: 'test:latest',
        dockerCommand: 'test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });

      await expect(validateId('existing-app')).rejects.toThrow(
        WorkloadIdExistsError,
      );
      await expect(validateId('existing-app')).rejects.toThrow(
        /already exists/,
      );

      try {
        await validateId('existing-app');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkloadIdExistsError);
        expect((error as DeployError).statusCode).toBe(409);
        expect((error as DeployError).isWarning).toBe(true);
      }
    });

    it('should accept workload ID that does not exist', async () => {
      // Store already initialized empty in beforeEach
      const id = await validateId('new-unique-app');

      expect(id).toBe('new-unique-app');
    });
  });

  describe('edge cases', () => {
    it('should handle workload ID with consecutive hyphens', async () => {
      const id = await validateId('my--app');

      expect(id).toBe('my--app');
    });

    it('should reject workload ID starting with hyphen', async () => {
      await expect(validateId('-myapp')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
    });

    it('should reject workload ID ending with hyphen', async () => {
      await expect(validateId('myapp-')).rejects.toThrow(
        InvalidWorkloadIdError,
      );
    });

    it('should reject workload ID with all hyphens', async () => {
      await expect(validateId('---')).rejects.toThrow(InvalidWorkloadIdError);
    });
  });
});
