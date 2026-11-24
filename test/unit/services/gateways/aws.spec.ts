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
import {
  AWS_EC2_REGION_DENIED,
  AWS_ECR_ACCESS_DENIED,
  AWS_S3_ACCESS_DENIED,
} from '../../../integration/credentials-onboarding/personas.js';
import {
  BucketAccessDeniedError,
  BucketNameTakenError,
  BucketNotFoundError,
  BucketThrottledError,
  ObjectNotFoundError,
} from '../../../../src/shared/errors.js';
import { throughBucketStorage } from '../../../../src/api/services/bucket-storage-operation.js';
import { internalsOf } from '../../helpers/internals';
import {
  makeNewVMProps,
  requirePreemptible,
  requirePrepareNetwork,
} from '../../helpers/fixtures';
import {
  AWS,
  isAWSNotFound,
  AWS_SHARED_SERVICE_SG_NAME,
  resetAwsCandidatePreflightCache,
} from '../../../../src/api/services/gateways/aws';
import {
  canFilterCandidateRegions,
  canListBuckets,
  canListObjects,
  canManageCloudResources,
  type CandidateRegion,
} from '../../../../src/api/services/gateways/cloud';
import {
  CloudFailureDiagnosis,
  CloudType,
  DiskTier,
} from '../../../../src/shared/cloud.js';
import { GpuRuntime } from '../../../../src/shared/cloud';
import { buildServeIngressSpec } from '../../../../src/api/services/network';
import {
  CLOUDFLARE_IP_RANGES,
  CLOUDFLARE_IPV6_RANGES,
} from '../../../../src/shared/cloudflare-ips';
import {
  CancelSpotInstanceRequestsCommand,
  CreateTagsCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSpotInstanceRequestsCommand,
  EC2Client,
  MarketType,
  RunInstancesCommand,
  TerminateInstancesCommand,
  VolumeType,
} from '@aws-sdk/client-ec2';
import { S3Client, waitUntilBucketExists } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { selectLocallyValidTargets } from '../../../../src/api/services/compute-validation';
import { WaiterState } from '@aws-sdk/util-waiter';
import { resetStorageCoordinatorForTests } from '../../../../src/api/services/gateways/storage-coordinator';
import {
  InvalidAnycloudConfigError,
  ResourceStateIndeterminateError,
} from '../../../../src/shared/errors';
import { VMCreationError } from '../../../../src/api/services/codes';
import {
  pickTarget,
  withoutDeniedRegions,
} from '../../../../src/api/services/launch-targets';
import { launchFailureDisposition } from '../../../../src/api/services/provisioning-failure';
import { log } from '../../../../src/api/services/logger';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../../../helpers/resource-sweep-policy';
import { installationSweepPolicy } from '../../../../src/api/services/gateways/resource-sweeper';
import { hostedApiIdentity } from '../../../../src/shared/hosted-api-identity.js';

// Empty AWS SDK send response — the cast erases the union of overload return
// types when tests only care about call args, not response shape.
const EMPTY_AWS_RESPONSE = {};
const SUCCESSFUL_AWS_WAITER_RESULT: Awaited<
  ReturnType<typeof waitUntilBucketExists>
> = {
  state: WaiterState.SUCCESS,
  reason: {},
};
function sweepAwsStorage(aws: AWS, dryRun = false) {
  return aws.sweeper().sweepStorage!({
    ...TEST_RESOURCE_SWEEP_OPTIONS,
    dryRun,
  });
}

function resolvedAmi(
  imageId: string,
  rootVolumeSizeGb = 8,
  rootDeviceName = '/dev/sda1',
) {
  return { imageId, rootDeviceName, rootVolumeSizeGb };
}

function amiRoot(rootVolumeSizeGb = 8, rootDeviceName = '/dev/sda1') {
  return {
    RootDeviceName: rootDeviceName,
    BlockDeviceMappings: [
      { DeviceName: rootDeviceName, Ebs: { VolumeSize: rootVolumeSizeGb } },
    ],
  };
}

const { getEnabledRegionsMock, getZeroQuotaRegionsMock, stsSend } = vi.hoisted(
  () => ({
    getEnabledRegionsMock: vi.fn(),
    getZeroQuotaRegionsMock: vi.fn(),
    stsSend: vi.fn(),
  }),
);

/**
 * The provider-facing calls these tests stub behind the public compute API.
 *
 * They are private on the gateway because nothing outside it should call them
 * in production. Each entry borrows the class's own type rather than restating
 * a signature, so a spy stays honest when the real call changes shape.
 */
type AwsProviderCalls = {
  terminateVM: AWS['terminateVM'];
  observeVMReleaseOnce: AWS['observeVMReleaseOnce'];
  resolveAmi: AWS['resolveAmi'];
  removeFirewalls: AWS['removeFirewalls'];
  requestInstanceTermination: AWS['requestInstanceTermination'];
  tagResourcesForDeletion: AWS['tagResourcesForDeletion'];
  describeInstanceForTermination: AWS['describeInstanceForTermination'];
  cancelSpotRequestOf: AWS['cancelSpotRequestOf'];
};

function providerCalls(aws: AWS): AwsProviderCalls {
  return internalsOf<AwsProviderCalls>(aws);
}

function mockedS3Client(send: ReturnType<typeof vi.fn>, config: unknown) {
  const client = { send, config };
  return client as any;
}

function filterCandidateRegions(
  provider: AWS,
  candidates: CandidateRegion[],
  spot: boolean,
  workloadId: string,
): Promise<CandidateRegion[]> {
  const compute = provider.compute();
  if (!canFilterCandidateRegions(compute)) {
    throw new Error('AWS compute provider did not expose candidate filtering');
  }
  return compute.filterCandidateRegions(candidates, spot, workloadId);
}

// Mock the logger
vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock AWS SDK clients
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(function () {
    return { send: vi.fn() };
  }),
  DescribeVpcsCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DescribeInstancesCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DescribeSpotInstanceRequestsCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  CancelSpotInstanceRequestsCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DescribeSecurityGroupsCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  CreateSecurityGroupCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  CreateTagsCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  AuthorizeSecurityGroupIngressCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  RevokeSecurityGroupIngressCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DeleteSecurityGroupCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DescribeNetworkInterfacesCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DeleteNetworkInterfaceCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DescribeVolumesCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DeleteVolumeCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  DescribeImagesCommand: vi.fn(),
  RunInstancesCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  TerminateInstancesCommand: vi.fn().mockImplementation(function (
    this: { input: unknown },
    input: unknown,
  ) {
    this.input = input;
  }),
  ResourceType: 'instance',
  VolumeType: { gp3: 'gp3' },
  MarketType: { spot: 'spot' },
  SpotInstanceType: { one_time: 'one-time', persistent: 'persistent' },
  InstanceInterruptionBehavior: {
    hibernate: 'hibernate',
    stop: 'stop',
    terminate: 'terminate',
  },
}));

vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    vi.fn().mockImplementation(function (
      this: { input: unknown; _cmd: string },
      input: unknown,
    ) {
      this.input = input;
      this._cmd = name;
    });
  return {
    S3Client: vi.fn().mockImplementation(function (config?) {
      return { send: vi.fn(), config };
    }),
    CreateBucketCommand: command('CreateBucket'),
    HeadBucketCommand: command('HeadBucket'),
    PutBucketVersioningCommand: command('PutBucketVersioning'),
    PutPublicAccessBlockCommand: command('PutPublicAccessBlock'),
    GetBucketTaggingCommand: command('GetBucketTagging'),
    PutBucketTaggingCommand: command('PutBucketTagging'),
    ListBucketsCommand: command('ListBuckets'),
    GetBucketLocationCommand: command('GetBucketLocation'),
    DeleteBucketCommand: command('DeleteBucket'),
    DeleteObjectsCommand: command('DeleteObjects'),
    ListObjectsV2Command: command('ListObjectsV2'),
    ListObjectVersionsCommand: command('ListObjectVersions'),
    GetObjectCommand: command('GetObject'),
    waitUntilBucketExists: vi.fn(),
  };
});

vi.mock('@aws-sdk/client-sts', () => {
  const command = (name: string) =>
    vi.fn().mockImplementation(function (
      this: { input: unknown; _cmd: string },
      input: unknown,
    ) {
      this.input = input;
      this._cmd = name;
    });
  return {
    STSClient: vi.fn().mockImplementation(function (config?: unknown) {
      return { send: stsSend, config };
    }),
    GetCallerIdentityCommand: command('GetCallerIdentity'),
    GetFederationTokenCommand: command('GetFederationToken'),
  };
});

vi.mock('@aws-sdk/util-waiter', () => ({
  createWaiter: vi.fn(),
  WaiterState: {
    SUCCESS: 'SUCCESS',
    RETRY: 'RETRY',
    FAILURE: 'FAILURE',
  },
}));

vi.mock('../../../../src/api/services/quota/aws', () => ({
  AwsQuotaProvider: vi.fn().mockImplementation(function () {
    return {
      getEnabledRegions: getEnabledRegionsMock,
      getZeroQuotaRegions: getZeroQuotaRegionsMock,
    };
  }),
}));

beforeEach(() => {
  resetStorageCoordinatorForTests();
  vi.mocked(waitUntilBucketExists).mockReset();
  vi.mocked(waitUntilBucketExists).mockResolvedValue(
    SUCCESSFUL_AWS_WAITER_RESULT,
  );
});

/** Node pools and the cluster installer own a scoped AWS security group. */
function terminateResourceNetwork(aws: AWS, id: string): Promise<void> {
  const compute = aws.compute();
  if (!canManageCloudResources(compute)) throw new Error('not scoped');
  return compute.terminateResourceNetwork({ id, tags: {} });
}

describe('isAWSNotFound', () => {
  it('should return true for ResourceNotFoundException', () => {
    const error = { name: 'ResourceNotFoundException' };
    expect(isAWSNotFound(error)).toBe(true);
  });

  it('should return true for InvalidInstanceID.NotFound', () => {
    const error = { Code: 'InvalidInstanceID.NotFound' };
    expect(isAWSNotFound(error)).toBe(true);
  });

  it('should return true for InvalidInstanceID.NotFound name', () => {
    const error = { name: 'InvalidInstanceID.NotFound' };
    expect(isAWSNotFound(error)).toBe(true);
  });

  it('should return true for InvalidGroup.NotFound', () => {
    const error = { Code: 'InvalidGroup.NotFound' };
    expect(isAWSNotFound(error)).toBe(true);
  });

  it('should return true for InvalidGroup.NotFound name', () => {
    const error = { name: 'InvalidGroup.NotFound' };
    expect(isAWSNotFound(error)).toBe(true);
  });

  it('should return true for 404 status code', () => {
    const error = { $metadata: { httpStatusCode: 404 } };
    expect(isAWSNotFound(error)).toBe(true);
  });

  it('should return false for other error codes', () => {
    const error = { Code: 'InternalError' };
    expect(isAWSNotFound(error)).toBe(false);
  });

  it('should return false for 500 status code', () => {
    const error = { $metadata: { httpStatusCode: 500 } };
    expect(isAWSNotFound(error)).toBe(false);
  });

  it('should return false for InvalidParameterValue', () => {
    const error = { Code: 'InvalidParameterValue' };
    expect(isAWSNotFound(error)).toBe(false);
  });

  it('should return false for QuotaExceeded', () => {
    const error = { Code: 'QuotaExceeded' };
    expect(isAWSNotFound(error)).toBe(false);
  });

  it('should return true for InvalidAMIID.NotFound', () => {
    expect(isAWSNotFound({ Code: 'InvalidAMIID.NotFound' })).toBe(true);
  });

  it('should return true for InvalidAMIID.NotFound name', () => {
    expect(isAWSNotFound({ name: 'InvalidAMIID.NotFound' })).toBe(true);
  });
});

describe('AWS.newVM cleanup behavior', () => {
  // Note: Full integration testing of the cleanup behavior requires real AWS credentials.
  // These tests verify the expected behavior through isAWSNotFound which is used
  // by deleteWithRetry during cleanup.

  it('isAWSNotFound should handle cleanup scenarios correctly', () => {
    // During cleanup, if resource already deleted (404), treat as success
    expect(isAWSNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isAWSNotFound({ Code: 'InvalidInstanceID.NotFound' })).toBe(true);
    expect(isAWSNotFound({ Code: 'InvalidGroup.NotFound' })).toBe(true);

    // Other errors are not "not found" (they will be retried by withRetry)
    expect(isAWSNotFound({ Code: 'DependencyViolation' })).toBe(false);
    expect(isAWSNotFound({ Code: 'QuotaExceeded' })).toBe(false);
  });
});

describe('AWS resource-scoped VM lookup', () => {
  const scope = { id: 'anycloud-cluster-c1', tags: { anycloud_cluster: 'c1' } };
  function lookup(sends: Record<string, ReturnType<typeof vi.fn>>) {
    getEnabledRegionsMock.mockResolvedValue(new Set(Object.keys(sends)));
    vi.mocked(EC2Client).mockImplementation(function (
      this: EC2Client,
      ...args
    ) {
      Object.assign(this, { send: sends[String(args[0]?.region)] ?? vi.fn() });
    });
    const aws = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.micro',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      }),
    );
    const compute = aws.compute();
    if (!canManageCloudResources(compute)) throw new Error('not scoped');
    return compute.listResourceVMs!(scope);
  }

  it('finds live and stopped instances by the scope tag in every enabled region, across pages', async () => {
    const home = vi.fn().mockResolvedValue({ Reservations: [] });
    const other = vi
      .fn()
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: 'i-running', State: { Name: 'running' } },
              { InstanceId: 'i-stopping', State: { Name: 'stopping' } },
            ],
          },
        ],
        NextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: 'i-stopped', State: { Name: 'stopped' } },
            ],
          },
        ],
      });
    await expect(
      lookup({ 'us-east-1': home, 'eu-west-1': other }),
    ).resolves.toEqual([
      { id: 'i-running', stopped: false },
      { id: 'i-stopping', stopped: false },
      { id: 'i-stopped', stopped: true },
    ]);
    expect(home.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Filters: [
          { Name: 'tag:anycloud_resource', Values: ['anycloud-cluster-c1'] },
          {
            Name: 'instance-state-name',
            Values: ['pending', 'running', 'stopping', 'stopped'],
          },
        ],
      },
    });
    expect(other.mock.calls[1]?.[0]).toMatchObject({
      input: { NextToken: 'page-2' },
    });
  });

  it('fails the whole lookup when one region cannot be read', async () => {
    await expect(
      lookup({
        'us-east-1': vi.fn().mockResolvedValue({ Reservations: [] }),
        'eu-west-1': vi
          .fn()
          .mockRejectedValue(new Error('UnauthorizedOperation')),
      }),
    ).rejects.toThrow('UnauthorizedOperation');
  });
});

describe('AWS controller ownership backfill', () => {
  it('tags only an exact VM whose durable workload owner matches', async () => {
    const aws = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.micro',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        },
      }),
    );
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                Tags: [
                  { Key: 'anycloud_deployment', Value: 'workload-1' },
                  { Key: 'anycloud_user', Value: 'user-1' },
                ],
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({});
    const ec2Client = { send };
    aws.ec2client = ec2Client as unknown as typeof aws.ec2client;

    await expect(
      aws.apiOwnership().backfillExactVM({
        cloudId: 'i-123',
        apiIdentity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ownerKind: 'workload',
        ownerId: 'workload-1',
        userId: 'user-1',
      }),
    ).resolves.toBe('updated');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeInstancesCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CreateTagsCommand);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: {
        Resources: ['i-123'],
        Tags: [
          {
            Key: 'anycloud_owner_api',
            Value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      },
    });
  });
});

describe('AWS class', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't2.micro',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  describe('isTerminalAuthError', () => {
    it('flags an unrecognized access key id as terminal', () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      expect(aws.isTerminalAuthError({ Code: 'InvalidClientTokenId' })).toBe(
        true,
      );
      expect(aws.isTerminalAuthError({ Code: 'InvalidClientToken' })).toBe(
        true,
      );
    });

    it('does not flag clock-skew, expired-session, permission, or AuthFailure', () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      for (const code of [
        'SignatureDoesNotMatch',
        'RequestExpired',
        'ExpiredToken',
        'ExpiredTokenException',
        'AccessDenied',
        'UnauthorizedOperation',
        'AuthFailure',
        'Blocked',
      ]) {
        expect(aws.isTerminalAuthError({ Code: code })).toBe(false);
      }
    });
  });

  describe('constructor', () => {
    it('should create AWS instance with correct properties', () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      expect(aws.type).toBe(CloudType.AWS);
      expect(aws.region).toBe('us-east-1');
      expect(aws.vmType).toBe('t2.micro');
    });

    it('should set optional properties', () => {
      const configWithOptional = {
        ...mockConfig,
        spot: true,
        diskSizeGb: 50,
        diskTier: DiskTier.High,
      };

      const aws = new AWS(completeCloudConfig(configWithOptional));

      expect(aws.spot).toBe(true);
      expect(aws.diskSizeGb).toBe(50);
      expect(aws.diskTier).toBe(DiskTier.High);
    });

    it('binds stored keys when the API host has different ambient AWS credentials', () => {
      const clientConstructor = vi.mocked(EC2Client);
      clientConstructor.mockClear();
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'AMBIENT-ACCESS-KEY');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'AMBIENT-SECRET-KEY');
      try {
        new AWS(completeCloudConfig(mockConfig));

        expect(clientConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ credentials: mockConfig.credentials }),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('bucket storage', () => {
    it('should not store bucket names on the class (buckets now passed via params)', () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      // Bucket names are no longer on CloudConfig or the AWS class;
      // they flow through CloudConfig → provisionParams.bucketNames
      expect((aws as any).inputBucket).toBeUndefined();
      expect((aws as any).outputBucket).toBeUndefined();
    });
  });
});

describe('AWS credential validation', () => {
  // A pilot credential is denied EC2 outside three US regions; the catalog's
  // cheapest c6i.xlarge region is outside them.
  const target = {
    name: 'pilot-aws',
    config: {
      cloudProvider: CloudType.AWS,
      region: 'ap-south-1',
      vmType: 'c6i.xlarge',
      credentials: {
        accessKeyId: 'AKIA-PILOT',
        secretAccessKey: 'pilot-secret',
      },
    },
  };
  const unrecognizedKey = {
    name: 'InvalidClientTokenId',
    Code: 'InvalidClientTokenId',
    message: 'The security token included in the request is invalid.',
    $metadata: { httpStatusCode: 403 },
  };

  beforeEach(() => {
    stsSend.mockReset();
    vi.mocked(STSClient).mockClear();
    vi.mocked(EC2Client).mockClear();
  });

  function ec2Calls(): number {
    return vi
      .mocked(EC2Client)
      .mock.results.reduce(
        (count, result) =>
          count +
          (result.value as { send: ReturnType<typeof vi.fn> }).send.mock.calls
            .length,
        0,
      );
  }

  it('0047/S13 admits a new key once STS recognizes it, with no EC2 call in the placement region', async () => {
    vi.useFakeTimers();
    try {
      stsSend
        .mockRejectedValueOnce(unrecognizedKey)
        .mockRejectedValueOnce(unrecognizedKey)
        .mockResolvedValue({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:user/pilot',
        });
      const result = selectLocallyValidTargets([target]);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual([target]);
      expect(stsSend).toHaveBeenCalledTimes(3);
      for (const [command] of stsSend.mock.calls)
        expect(command).toMatchObject({ _cmd: 'GetCallerIdentity' });
      for (const [options] of vi.mocked(STSClient).mock.calls)
        expect(options).toMatchObject({ region: 'us-east-1' });
      expect(ec2Calls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('0047/S5 reports a deleted key as invalid after the bounded backoff, not as retryable', async () => {
    vi.useFakeTimers();
    try {
      stsSend.mockRejectedValue(unrecognizedKey);
      const started = Date.now();
      const result = selectLocallyValidTargets([target]).catch(
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await result;
      expect(error).toBeInstanceOf(InvalidAnycloudConfigError);
      expect((error as Error).message).not.toContain('Please retry');
      expect(stsSend).toHaveBeenCalledTimes(6);
      expect(Date.now() - started).toBeGreaterThanOrEqual(20_000);
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AWS bucket listing', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  function storageWithSend(send: ReturnType<typeof vi.fn>) {
    const aws = new AWS(completeCloudConfig(mockConfig));
    aws.s3client = mockedS3Client(send, {
      credentials: mockConfig.credentials,
    });
    const storage = aws.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');
    return storage;
  }

  it.each(['Code', 'code', 'name'])(
    '0038/S2 retries structured %s=InvalidAccessKeyId for the first bucket read',
    async (field) => {
      vi.useFakeTimers();
      try {
        const failure = { name: 'Error', [field]: 'InvalidAccessKeyId' };
        const send = vi
          .fn()
          .mockRejectedValueOnce(failure)
          .mockResolvedValue({ Buckets: [] });
        const result = storageWithSend(send).listBuckets({ pageSize: 50 });
        await vi.runAllTimersAsync();
        await expect(result).resolves.toEqual({
          buckets: [],
          nextCursor: null,
        });
        expect(send).toHaveBeenCalledTimes(2);
        for (const [command] of send.mock.calls) {
          expect(command).toMatchObject({
            _cmd: 'ListBuckets',
            input: { MaxBuckets: 50 },
          });
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { Code: 'AccessDenied' },
    { Code: 'SignatureDoesNotMatch' },
    { Code: 'InvalidClientTokenId' },
    { $metadata: { httpStatusCode: 403 } },
    new Error('InvalidAccessKeyId appears only in this message'),
  ])(
    '0038/S2 keeps other bucket-list failures terminal: %j',
    async (failure) => {
      const send = vi.fn().mockRejectedValue(failure);
      await expect(
        storageWithSend(send).listBuckets({ pageSize: 50 }),
      ).rejects.toBe(failure);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('0038/S2 bounds unrecognized-key reads and preserves the final structured error', async () => {
    vi.useFakeTimers();
    try {
      const failure = {
        Code: 'InvalidAccessKeyId',
        $metadata: { httpStatusCode: 403, requestId: 'last-request' },
      };
      const send = vi.fn().mockRejectedValue(failure);
      const started = Date.now();
      const result = expect(
        storageWithSend(send).listBuckets({ pageSize: 50 }),
      ).rejects.toBe(failure);
      await vi.runAllTimersAsync();
      await result;
      expect(send).toHaveBeenCalledTimes(6);
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('0038/S2 cancels first-use backoff and passes the existing signal to the SDK', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const stopped = new Error('request deadline exceeded');
      const send = vi.fn().mockRejectedValue({ Code: 'InvalidAccessKeyId' });
      const result = expect(
        storageWithSend(send).listBuckets(
          { pageSize: 50 },
          { signal: controller.signal },
        ),
      ).rejects.toBe(stopped);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(stopped);
      await vi.runAllTimersAsync();
      await result;
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a native bucket page and forwards the opaque cursor', async () => {
    const created = new Date('2025-01-02T03:04:05Z');
    const send = vi.fn().mockResolvedValue({
      Buckets: [
        {
          Name: 'models',
          BucketRegion: 'us-west-2',
          CreationDate: created,
        },
        { Name: 'metadata-unknown' },
        { CreationDate: created },
      ],
      ContinuationToken: 'bucket-page-2',
    });
    const aws = new AWS(completeCloudConfig(mockConfig));
    aws.s3client = mockedS3Client(send, {
      credentials: mockConfig.credentials,
    });
    const storage = aws.storage();
    if (!canListBuckets(storage)) throw new Error('Expected bucket listing');

    await expect(
      storage.listBuckets({ pageSize: 50, cursor: 'bucket-page-1' }),
    ).resolves.toEqual({
      buckets: [
        {
          name: 'models',
          region: 'us-west-2',
          createdAt: created.getTime(),
        },
        { name: 'metadata-unknown', region: null, createdAt: null },
      ],
      nextCursor: 'bucket-page-2',
    });
    expect(send.mock.calls[0][0]).toMatchObject({
      _cmd: 'ListBuckets',
      input: { MaxBuckets: 50, ContinuationToken: 'bucket-page-1' },
    });
  });

  it('uses common prefixes for hierarchy and omits the delimiter recursively', async () => {
    const modified = new Date('2025-02-03T04:05:06Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ LocationConstraint: 'us-east-1' })
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'models/checkpoints/' }],
        Contents: [
          {
            Key: 'models/config.json',
            Size: 42,
            LastModified: modified,
          },
          { Key: 'models/unknown.bin' },
        ],
        NextContinuationToken: 'object-page-2',
      })
      .mockResolvedValueOnce({ LocationConstraint: 'us-east-1' })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const aws = new AWS(completeCloudConfig(mockConfig));
    aws.s3client = mockedS3Client(send, {
      credentials: mockConfig.credentials,
    });
    const storage = aws.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects('models-bucket', {
        prefix: 'models/',
        recursive: false,
        pageSize: 100,
        cursor: 'object-page-1',
      }),
    ).resolves.toEqual({
      entries: [
        { kind: 'prefix', key: 'models/checkpoints/' },
        {
          kind: 'object',
          key: 'models/config.json',
          sizeBytes: 42,
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
    expect(send.mock.calls[1][0]).toMatchObject({
      _cmd: 'ListObjectsV2',
      input: {
        Bucket: 'models-bucket',
        Prefix: 'models/',
        Delimiter: '/',
        MaxKeys: 100,
        ContinuationToken: 'object-page-1',
      },
    });

    await storage.listObjects('models-bucket', {
      prefix: '',
      recursive: true,
      pageSize: 1000,
    });
    expect(send.mock.calls[3][0].input.Delimiter).toBeUndefined();
  });

  it('reports a missing bucket listing as BucketNotFoundError', async () => {
    const noSuchBucket = {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    };
    const send = vi.fn().mockRejectedValue(noSuchBucket);
    const aws = new AWS(completeCloudConfig(mockConfig));
    aws.s3client = mockedS3Client(send, {
      credentials: mockConfig.credentials,
    });
    const storage = aws.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects('gone', { prefix: '', recursive: true, pageSize: 1 }),
    ).rejects.toEqual(new BucketNotFoundError('gone', noSuchBucket));
    // The region lookup treats the absent bucket as default-region, then
    // ListObjectsV2 reports it: two sends, no retry.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps an access denial on a listing as the provider error', async () => {
    const accessDenied = {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ LocationConstraint: 'us-east-1' })
      .mockRejectedValueOnce(accessDenied);
    const aws = new AWS(completeCloudConfig(mockConfig));
    aws.s3client = mockedS3Client(send, {
      credentials: mockConfig.credentials,
    });
    const storage = aws.storage();
    if (!canListObjects(storage)) throw new Error('Expected object listing');

    await expect(
      storage.listObjects('b', { prefix: '', recursive: true, pageSize: 1 }),
    ).rejects.toBe(accessDenied);
  });

  it.each([
    ['NoSuchBucket', 404, new BucketNotFoundError('gone', expect.anything())],
    ['NoSuchKey', 404, new ObjectNotFoundError('gone', 'k', expect.anything())],
    [
      'AccessDenied',
      403,
      { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
    ],
  ])(
    'maps a %s object download from one request',
    async (name, httpStatusCode, expected) => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ LocationConstraint: 'us-east-1' })
        .mockRejectedValueOnce({ name, $metadata: { httpStatusCode } });
      const aws = new AWS(completeCloudConfig(mockConfig));
      aws.s3client = mockedS3Client(send, {
        credentials: mockConfig.credentials,
      });

      await expect(aws.storage().downloadObject('gone', 'k')).rejects.toEqual(
        expected,
      );
      expect(send).toHaveBeenCalledTimes(2);
    },
  );
});

describe('AWS storage failure classification', () => {
  // The shape @aws-sdk/client-s3 3.937 throws for an S3 XML error body: the
  // schema base error, with the wire code in Code and the status in $metadata.
  const s3Error = (Code: string, httpStatusCode: number) =>
    Object.assign(new Error(Code), {
      Code,
      $metadata: { httpStatusCode, requestId: 'REQ123', attempts: 1 },
    });
  const gatewayCredentials = { accessKeyId: 'gateway', secretAccessKey: 's' };
  const awsStorage = (send: ReturnType<typeof vi.fn>) => {
    const aws = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      }),
    );
    aws.s3client = mockedS3Client(send, { credentials: gatewayCredentials });
    return aws.storage();
  };

  it.each([
    [s3Error('AccessDenied', 403), 'denied'],
    [s3Error('InvalidAccessKeyId', 403), 'denied'],
    [s3Error('ExpiredToken', 400), 'denied'],
    [s3Error('SlowDown', 503), 'throttled'],
    [s3Error('TooManyRequests', 429), 'throttled'],
    [s3Error('NoSuchBucket', 404), 'bucket-missing'],
    [s3Error('NoSuchKey', 404), 'object-missing'],
    [s3Error('InternalError', 500), undefined],
    [s3Error('PermanentRedirect', 301), undefined],
    // Message text never classifies.
    [new Error('Access Denied'), undefined],
    [
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      undefined,
    ],
  ])('classifies %o as %s', async (error, kind) => {
    const failure = await awsStorage(vi.fn()).classifyStorageFailure!(
      error,
      'b',
      'k',
    );
    expect(failure?.kind).toBe(kind);
  });

  // Smithy keeps the raw HttpResponse (statusCode, headers, body) on a hidden
  // `$response`; @smithy/protocol-http is not a direct dependency.
  it.each([
    ['its Retry-After', { 'retry-after': '7' }, 7],
    ['1 s without one', {}, 1],
    ['1 s for an invalid one', { 'retry-after': 'soon' }, 1],
    ['at most 30 s', { 'retry-after': '120' }, 30],
  ])('answers a throttled S3 call with %s', async (_name, headers, seconds) => {
    const { S3ServiceException } =
      await vi.importActual<typeof import('@aws-sdk/client-s3')>(
        '@aws-sdk/client-s3',
      );
    const slowDown = new S3ServiceException({
      name: 'SlowDown',
      // service-terminology-ok: smithy's fault side, not a workload
      $fault: 'server',
      $metadata: { httpStatusCode: 503 },
    });
    Object.defineProperty(slowDown, '$response', {
      value: { statusCode: 503, headers, body: undefined },
      enumerable: false,
    });
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnLog.mockRestore());

    const rejection = await throughBucketStorage(
      awsStorage(vi.fn()),
      { credentialName: 'prod-aws', action: 'list buckets' },
      undefined,
      () => Promise.reject(slowDown),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BucketThrottledError);
    expect((rejection as BucketThrottledError).retryAfterSeconds).toBe(seconds);
  });

  it('reports a denied download after one object request, past a denied region lookup', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(s3Error('AccessDenied', 403))
      .mockRejectedValueOnce(s3Error('AccessDenied', 403));
    const storage = awsStorage(send);
    // The fallback is its own redirect-following client (a redirect rewrites
    // a client's region in place); route its sends through the same mock.
    const fallbackClient = { send };
    vi.mocked(S3Client).mockImplementationOnce(function () {
      return fallbackClient as never;
    });

    const rejection = await throughBucketStorage(
      storage,
      {
        credentialName: 'prod-aws',
        action: 'download',
        bucketName: 'b',
        remotePath: 'k',
      },
      undefined,
      () => storage.downloadObject('b', 'k'),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BucketAccessDeniedError);
    expect((rejection as Error).message).toBe(
      'Access denied: credential "prod-aws" cannot download b/k (AWS AccessDenied). Check the credential and its AWS permissions.',
    );
    // An object-only credential cannot read the bucket's region; the object
    // call itself decides, and is not retried.
    expect(send.mock.calls.map(([command]) => command._cmd)).toEqual([
      'GetBucketLocation',
      'GetObject',
    ]);
    expect(S3Client).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credentials: gatewayCredentials,
        region: 'us-east-1',
        maxAttempts: 10,
        followRegionRedirects: true,
      }),
    );
  });
});

describe('AWS candidate region filter', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 'g6e.48xlarge',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };
  const candidates = [
    { vmType: 'g6e.48xlarge', region: 'us-east-1' },
    { vmType: 'g6e.48xlarge', region: 'us-west-2' },
    { vmType: 'g6e.48xlarge', region: 'eu-west-1' },
  ];
  const zeroQuotaResult = (regions: string[], complete = true) => ({
    zeroRegions: new Set(regions),
    unknownRegions: new Set<string>(),
    complete,
  });

  beforeEach(() => {
    resetAwsCandidatePreflightCache();
    getEnabledRegionsMock.mockReset();
    getZeroQuotaRegionsMock.mockReset();
  });

  it('reuses a settled candidate preflight until the short TTL expires', async () => {
    vi.useFakeTimers();
    try {
      getEnabledRegionsMock.mockResolvedValue(
        new Set(['us-east-1', 'us-west-2']),
      );
      getZeroQuotaRegionsMock.mockResolvedValue(zeroQuotaResult(['us-west-2']));

      const aws = new AWS(completeCloudConfig(mockConfig));
      await expect(
        filterCandidateRegions(aws, candidates, true, 'deploy-1'),
      ).resolves.toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);
      await expect(
        filterCandidateRegions(aws, candidates, true, 'deploy-2'),
      ).resolves.toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);

      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(1);
      expect(getZeroQuotaRegionsMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
      await expect(
        filterCandidateRegions(aws, candidates, true, 'deploy-3'),
      ).resolves.toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);

      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(2);
      expect(getZeroQuotaRegionsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops regions the account hasn't enabled when the quota reads are denied, so run 42568226202 fails over to us-east-1", async () => {
    // The restricted key: account:ListRegions and the quota reads are denied,
    // so the enabled set is EC2's (AwsQuotaProvider's fallback), without
    // ap-south-2.
    getEnabledRegionsMock.mockResolvedValue(
      new Set(['ap-south-1', 'us-east-1', 'us-east-2', 'us-west-2']),
    );
    getZeroQuotaRegionsMock.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    // The catalog's tie at $0.17, in its order.
    const tied = ['ap-south-1', 'ap-south-2', 'us-east-1'].map((region) => ({
      vmType: 'c6i.xlarge',
      region,
    }));

    const filtered = await filterCandidateRegions(
      new AWS(completeCloudConfig({ ...mockConfig, region: undefined })),
      tied,
      false,
      'd-j-rc-u',
    );
    expect(filtered).toEqual([tied[0], tied[2]]);

    // ap-south-1 then denies the key, and the next pick is us-east-1.
    const denied = {
      credentialId: 'cred',
      vmType: 'c6i.xlarge',
      region: 'ap-south-1',
      availabilityZone: null,
      diagnosis: CloudFailureDiagnosis.PermissionDenied,
      disposition: launchFailureDisposition(
        CloudFailureDiagnosis.PermissionDenied,
        CloudType.AWS,
        null,
        null,
        false,
        true,
      ),
      spot: false,
      regionDenied: 'ec2:DescribeVpcs',
    };
    const remaining = withoutDeniedRegions(
      filtered,
      [denied],
      false,
      CloudType.AWS,
    );
    expect(remaining).toEqual({ candidates: [tied[2]] });
    expect(pickTarget([tied[2]!], [denied], CloudType.AWS)).toBe(tied[2]);
  });

  it('filters candidates using current opt-in and quota checks', async () => {
    getEnabledRegionsMock.mockResolvedValue(
      new Set(['us-east-1', 'us-west-2']),
    );
    getZeroQuotaRegionsMock.mockResolvedValue(zeroQuotaResult(['us-west-2']));

    const aws = new AWS(completeCloudConfig(mockConfig));
    const filtered = await filterCandidateRegions(
      aws,
      candidates,
      true,
      'deploy-snapshot',
    );

    expect(filtered).toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);
  });

  it('does not cache fail-open candidate preflight results', async () => {
    vi.useFakeTimers();
    try {
      getEnabledRegionsMock
        .mockRejectedValueOnce(new Error('account unavailable'))
        .mockRejectedValueOnce(new Error('account unavailable'))
        .mockRejectedValueOnce(new Error('account unavailable'))
        .mockResolvedValue(new Set(['us-east-1', 'us-west-2']));
      getZeroQuotaRegionsMock.mockResolvedValue(zeroQuotaResult(['us-west-2']));

      const aws = new AWS(completeCloudConfig(mockConfig));
      const first = filterCandidateRegions(aws, candidates, true, 'deploy-1');
      await vi.runAllTimersAsync();
      await expect(first).resolves.toEqual(candidates);
      await expect(
        filterCandidateRegions(aws, candidates, true, 'deploy-2'),
      ).resolves.toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);

      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(4);
      expect(getZeroQuotaRegionsMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets callers fail open independently and replaces work after the fixed share window', async () => {
    vi.useFakeTimers();
    try {
      getEnabledRegionsMock
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue(new Set(['us-east-1', 'us-west-2', 'eu-west-1']));
      getZeroQuotaRegionsMock.mockResolvedValue(zeroQuotaResult([]));

      const aws = new AWS(completeCloudConfig(mockConfig));
      const first = filterCandidateRegions(aws, candidates, true, 'deploy-1');
      const second = filterCandidateRegions(aws, candidates, true, 'deploy-2');

      await vi.advanceTimersByTimeAsync(0);
      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25_001);
      await expect(first).resolves.toEqual(candidates);
      await expect(second).resolves.toEqual(candidates);
      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(1);

      // Shared work has a fixed 30-second lifetime plus a five-second grace
      // window, independent of either caller's shorter wait.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(
        filterCandidateRegions(aws, candidates, true, 'deploy-3'),
      ).resolves.toEqual(candidates);
      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache partial quota preflight results', async () => {
    getEnabledRegionsMock.mockResolvedValue(
      new Set(['us-east-1', 'us-west-2']),
    );
    getZeroQuotaRegionsMock
      .mockResolvedValueOnce(zeroQuotaResult(['us-west-2'], false))
      .mockResolvedValueOnce(zeroQuotaResult(['us-west-2']));

    const aws = new AWS(completeCloudConfig(mockConfig));
    await expect(
      filterCandidateRegions(aws, candidates, true, 'deploy-1'),
    ).resolves.toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);
    await expect(
      filterCandidateRegions(aws, candidates, true, 'deploy-2'),
    ).resolves.toEqual([{ vmType: 'g6e.48xlarge', region: 'us-east-1' }]);

    expect(getEnabledRegionsMock).toHaveBeenCalledTimes(2);
    expect(getZeroQuotaRegionsMock).toHaveBeenCalledTimes(2);
  });

  it('keeps opt-in filtering when quota preflight fails', async () => {
    vi.useFakeTimers();
    try {
      getEnabledRegionsMock.mockResolvedValue(new Set(['us-east-1']));
      getZeroQuotaRegionsMock.mockRejectedValue(
        new Error('service quotas unavailable'),
      );

      const aws = new AWS(completeCloudConfig(mockConfig));
      const filtered = filterCandidateRegions(
        aws,
        candidates,
        true,
        'deploy-1',
      );

      await vi.runAllTimersAsync();
      await expect(filtered).resolves.toEqual([
        { vmType: 'g6e.48xlarge', region: 'us-east-1' },
      ]);
      expect(getEnabledRegionsMock).toHaveBeenCalledTimes(1);
      expect(getZeroQuotaRegionsMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AWS.hasBucket', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't2.micro',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  it('recovers from opaque S3 Unknown by discovering the bucket region and retrying HeadBucket', async () => {
    vi.mocked(S3Client).mockClear();
    const initialSend = vi
      .fn()
      .mockRejectedValueOnce({
        name: 'Error',
        message: 'Unknown',
        $metadata: { httpStatusCode: 400 },
      })
      .mockResolvedValueOnce({ LocationConstraint: 'us-east-1' });
    const regionalSend = vi.fn().mockResolvedValueOnce(EMPTY_AWS_RESPONSE);
    vi.mocked(S3Client)
      .mockImplementationOnce(function (config?) {
        return mockedS3Client(initialSend, config);
      })
      .mockImplementationOnce(function (config?) {
        return mockedS3Client(regionalSend, config);
      });

    const aws = new AWS(
      completeCloudConfig({ ...mockConfig, region: 'eu-south-1' }),
    );

    await expect(aws.storage().hasBucket('existing-bucket')).resolves.toBe(
      true,
    );
    expect(initialSend).toHaveBeenCalledTimes(2);
    expect(initialSend.mock.calls[0][0]).toMatchObject({
      _cmd: 'HeadBucket',
      input: { Bucket: 'existing-bucket' },
    });
    expect(initialSend.mock.calls[1][0]).toMatchObject({
      _cmd: 'GetBucketLocation',
      input: { Bucket: 'existing-bucket' },
    });
    expect(vi.mocked(S3Client).mock.calls[1][0]).toMatchObject({
      region: 'us-east-1',
    });
    expect(regionalSend.mock.calls[0][0]).toMatchObject({
      _cmd: 'HeadBucket',
      input: { Bucket: 'existing-bucket' },
    });
  });

  it.each([null, undefined, ''])(
    'maps GetBucketLocation %s to us-east-1',
    async (locationConstraint) => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const locationResponse = {
        LocationConstraint: locationConstraint,
      };
      vi.mocked(aws.s3client.send).mockResolvedValueOnce(
        locationResponse as never,
      );

      await expect(
        aws.storage().getBucketRegion!('classic-bucket'),
      ).resolves.toBe('us-east-1');
    },
  );

  it('should return true when bucket exists', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.mocked(aws.s3client.send).mockResolvedValueOnce(
      EMPTY_AWS_RESPONSE as never,
    );

    expect(await aws.storage().hasBucket('my-bucket')).toBe(true);
  });

  it('should return false when bucket does not exist', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.mocked(aws.s3client.send).mockRejectedValueOnce({
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });

    expect(await aws.storage().hasBucket('missing-bucket')).toBe(false);
  });

  it('should return true when bucket exists in different region (301)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.mocked(aws.s3client.send).mockRejectedValueOnce({
      $metadata: { httpStatusCode: 301 },
    });

    expect(await aws.storage().hasBucket('cross-region-bucket')).toBe(true);
  });

  it('should throw on access denied errors', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.mocked(aws.s3client.send).mockRejectedValue({
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });

    await expect(aws.storage().hasBucket('forbidden-bucket')).rejects.toEqual({
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
  });

  it('throws the original opaque S3 Unknown when bucket region cannot be discovered', async () => {
    const aws = new AWS(
      completeCloudConfig({ ...mockConfig, region: 'eu-south-1' }),
    );
    const unknown = {
      name: 'Error',
      message: 'Unknown',
      $metadata: { httpStatusCode: 400 },
    };
    const noSuchBucket = {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    };
    vi.mocked(aws.s3client.send)
      .mockRejectedValueOnce(unknown as never)
      .mockRejectedValueOnce(noSuchBucket as never);

    await expect(aws.storage().hasBucket('undiscoverable-bucket')).rejects.toBe(
      unknown,
    );
  });
});

describe('AWS.upsertBucket', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't2.micro',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  it('should create bucket when it does not exist', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send
      .mockRejectedValueOnce({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      })
      .mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never) // CreateBucket
      .mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never) // PutPublicAccessBlock
      .mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never); // PutBucketTagging

    await aws.storage().upsertBucket('new-bucket', '0.3.2', 'test-deploy', '');
    expect(send).toHaveBeenCalledTimes(4);
    expect(waitUntilBucketExists).toHaveBeenCalledWith(
      {
        client: aws.s3client,
        maxWaitTime: 30,
        minDelay: 1,
        maxDelay: 5,
      },
      { Bucket: 'new-bucket' },
    );
    expect(send.mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(waitUntilBucketExists).mock.invocationCallOrder[0],
    );
  });

  it('fails bucket creation when the post-create readiness barrier times out', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send
      .mockRejectedValueOnce({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      })
      .mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never) // CreateBucket
      .mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never) // PutPublicAccessBlock
      .mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never); // PutBucketTagging
    vi.mocked(waitUntilBucketExists).mockRejectedValueOnce(
      Object.assign(new Error('BucketExists waiter timed out'), {
        name: 'TimeoutError',
      }),
    );

    await expect(
      aws.storage().upsertBucket('slow-bucket', '0.3.2', 'test-deploy', ''),
    ).rejects.toThrow(
      'Failed to create S3 bucket slow-bucket: BucketExists waiter timed out',
    );
    expect(waitUntilBucketExists).toHaveBeenCalledOnce();
  });

  it('keeps the AWS code and status when the SDK gives no message', async () => {
    // A failure whose message is "Unknown" is what CI actually saw three times
    // running, and prefixing it alone left nothing to diagnose. The code and
    // HTTP status distinguish a denied credential from a hit limit.
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send
      .mockRejectedValueOnce({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Unknown'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403, requestId: 'req-abc' },
        }),
      );

    const failure = await aws
      .storage()
      .upsertBucket('opaque-bucket', '0.3.2', 'test-deploy', '')
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(failure?.message).toContain('AccessDenied');
    expect(failure?.message).toContain('403');
  });

  it('should skip creation when bucket already exists', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send.mockResolvedValueOnce(EMPTY_AWS_RESPONSE as never); // HeadBucket succeeds

    await aws
      .storage()
      .upsertBucket('existing-bucket', '0.3.2', 'test-deploy', '');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('should skip creation when bucket exists in different region (301)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 301 } });

    await aws
      .storage()
      .upsertBucket('cross-region-bucket', '0.3.2', 'test-deploy', '');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing bucket after opaque S3 Unknown by retrying in the discovered region', async () => {
    vi.mocked(S3Client).mockClear();
    const initialSend = vi
      .fn()
      .mockRejectedValueOnce({
        name: 'Error',
        message: 'Unknown',
        $metadata: { httpStatusCode: 400 },
      })
      .mockResolvedValueOnce({ LocationConstraint: 'us-east-1' });
    const regionalSend = vi.fn().mockResolvedValueOnce(EMPTY_AWS_RESPONSE);
    vi.mocked(S3Client)
      .mockImplementationOnce(function (config?) {
        return mockedS3Client(initialSend, config);
      })
      .mockImplementationOnce(function (config?) {
        return mockedS3Client(regionalSend, config);
      });

    const aws = new AWS(
      completeCloudConfig({ ...mockConfig, region: 'eu-south-1' }),
    );

    await aws
      .storage()
      .upsertBucket('existing-bucket', '0.3.2', 'test-deploy', '');
    expect(initialSend).toHaveBeenCalledTimes(2);
    expect(regionalSend).toHaveBeenCalledTimes(1);
    expect(regionalSend.mock.calls[0][0]).toMatchObject({
      _cmd: 'HeadBucket',
      input: { Bucket: 'existing-bucket' },
    });
  });

  it('reuses the bucket when CreateBucket loses the race (BucketAlreadyOwnedByYou)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send
      .mockRejectedValueOnce({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }) // HeadBucket: not there yet
      .mockRejectedValueOnce({
        name: 'Error',
        Code: 'BucketAlreadyOwnedByYou',
        $metadata: { httpStatusCode: 409 },
      }); // CreateBucket: another deploy won the race

    await expect(
      aws.storage().upsertBucket('raced-bucket', '0.3.2', 'test-deploy', ''),
    ).resolves.toBeUndefined();
    // Swallowed + early return — no access-block / tagging calls follow.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws on BucketAlreadyExists (name owned by another account, not our race)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send
      .mockRejectedValueOnce({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }) // HeadBucket: 404 in our account
      .mockRejectedValueOnce({
        name: 'BucketAlreadyExists',
        $metadata: { httpStatusCode: 409 },
      }); // CreateBucket: globally taken by a different account

    await expect(
      aws.storage().upsertBucket('taken-globally', '0.3.2', 'test-deploy', ''),
    ).rejects.toMatchObject({ name: 'BucketAlreadyExists' });
  });

  it('0043/S22 creates a managed bucket first and classifies the answer, never adopting a taken name', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    const create = () =>
      aws.storage().createOwnedBucket('job-1', '0.1.71', 'job-1', 'u');
    send.mockRejectedValueOnce({
      name: 'BucketAlreadyExists',
      $metadata: { httpStatusCode: 409 },
    });
    await expect(create()).rejects.toBeInstanceOf(BucketNameTakenError);
    // No HEAD first: its 403 or 301 can't tell another owner's bucket.
    expect(send.mock.calls[0]![0]).toMatchObject({ _cmd: 'CreateBucket' });

    // Ours, in another region: reused there.
    const located = { LocationConstraint: 'eu-west-1' };
    send
      .mockRejectedValueOnce({
        name: 'Error',
        Code: 'BucketAlreadyOwnedByYou',
        $metadata: { httpStatusCode: 409 },
      })
      .mockResolvedValueOnce(located as never);
    await expect(create()).resolves.toBe('eu-west-1');

    send.mockRejectedValueOnce({
      name: 'AccessDenied',
      message: 'Access Denied',
      $metadata: { httpStatusCode: 403 },
    });
    await expect(create()).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/s3:CreateBucket.*: Access Denied$/),
    });
  });
});

describe('AWS storage sweep', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't2.micro',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  const ONE_UNTAGGED_BUCKET = {
    Buckets: [{ Name: 'untagged-bucket', CreationDate: new Date(0) }],
  };

  // AWS SDK v3 surfaces the classifier as `Code`, not `name`.
  // The storage sweep must skip NoSuchTagSet via either field — checking
  // only `name === 'NoSuchTagSet'` was a latent bug from the original
  // per-region cleanup.
  it('skips a bucket whose tagging call throws NoSuchTagSet via Code (SDK v3 shape)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send.mockResolvedValueOnce(ONE_UNTAGGED_BUCKET as never); // 1. ListBuckets
    // 2. GetBucketTagging throws NoSuchTagSet with the SDK v3 shape:
    //    { name: 'Error', Code: 'NoSuchTagSet' }.
    send.mockRejectedValueOnce({
      name: 'Error',
      Code: 'NoSuchTagSet',
      $metadata: { httpStatusCode: 404 },
    });

    const result = await sweepAwsStorage(aws);
    expect(result.otherResources).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('skips a bucket whose tagging call throws NoSuchTagSet via name (legacy shape)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send.mockResolvedValueOnce(ONE_UNTAGGED_BUCKET as never);
    send.mockRejectedValueOnce({
      name: 'NoSuchTagSet',
      $metadata: { httpStatusCode: 404 },
    });

    const result = await sweepAwsStorage(aws);
    expect(result.otherResources).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  // On PermanentRedirect (bucket lives in another region), the cleanup loop
  // must fall back to GetBucketLocation + retry against a region-correct
  // client. Verify the redirect actually triggers the location lookup;
  // the retry itself runs on a freshly constructed S3Client whose `send` is
  // a separate mock — for that follow-on we only need the loop not to crash.
  it('falls back to GetBucketLocation when tagging throws PermanentRedirect', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    send.mockResolvedValueOnce(ONE_UNTAGGED_BUCKET as never); // 1. ListBuckets
    send.mockRejectedValueOnce({
      // 2. GetBucketTagging on default client → cross-region redirect
      Code: 'PermanentRedirect',
      $metadata: { httpStatusCode: 301 },
    });
    // 3. GetBucketLocation → bucket is in eu-west-1
    const EU_WEST_LOCATION = { LocationConstraint: 'eu-west-1' };
    send.mockResolvedValueOnce(EU_WEST_LOCATION as never);

    await sweepAwsStorage(aws);

    // Three calls on the default client: ListBuckets, the failed tagging
    // attempt, and the GetBucketLocation. The retry uses a separate client.
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("takes an installation's managed bucket by name, untagged too, and its per-Job buckets by the hosted stamp", async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi.mocked(aws.s3client.send);
    const hosted = hostedApiIdentity('prod-1');
    const tags: Record<string, Array<{ Key: string; Value: string }>> = {
      'job-1-out': [
        { Key: 'anycloud_deployment', Value: 'job-1' },
        { Key: 'anycloud_owner_api', Value: hosted },
      ],
      'svc-1-out': [
        { Key: 'anycloud_deployment', Value: 'svc-1' },
        { Key: 'anycloud_owner_api', Value: hosted },
      ],
      'other-out': [{ Key: 'anycloud_deployment', Value: 'other' }],
    };
    send.mockImplementation((async (command: any) => {
      if (command._cmd === 'ListBuckets') {
        return {
          Buckets: [
            'prod-1',
            'job-1-out',
            'svc-1-out',
            'other-out',
            'mine',
          ].map((Name) => ({ Name, CreationDate: new Date() })),
        };
      }
      const set = tags[command.input.Bucket];
      if (!set) throw { Code: 'NoSuchTagSet' };
      return { TagSet: set };
    }) as never);

    const result = await aws.sweeper().sweepStorage!({
      dryRun: true,
      policy: installationSweepPolicy('prod-1', {
        spareRunningWorkloads: true,
        spareWorkloadIds: ['svc-1'],
      }),
    });

    expect(result.otherResources.map(({ id }) => id).sort()).toEqual([
      'job-1-out',
      'prod-1',
    ]);
    expect(result.spared).toEqual([
      { type: 'bucket', id: 'svc-1-out', workloadId: 'svc-1' },
    ]);
    expect(result.errors).toEqual([]);
  });
});

describe('AWS installation sweep', () => {
  const tagged = (tags: Record<string, string>) =>
    Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

  it('takes the stopped management VM and its pools, spares a running VM Service and its security group', async () => {
    const aws = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.micro',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      }),
    );
    const hosted = hostedApiIdentity('prod-1');
    let describeInstances = 0;
    const ec2Client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof DescribeInstancesCommand) {
          // The second listing is the untagged-instance recovery pass.
          if (describeInstances++ > 0) return { Reservations: [] };
          return {
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-mgmt',
                    State: { Name: 'stopped' },
                    Tags: tagged({
                      anycloud_resource: 'anycloud-cluster-prod-1',
                      anycloud_cluster: 'prod-1',
                      anycloud_owner_api: 'local-api',
                    }),
                  },
                  {
                    InstanceId: 'i-pool',
                    State: { Name: 'running' },
                    Tags: tagged({
                      anycloud_resource: 'pool-a',
                      anycloud_cluster: 'prod-1',
                      anycloud_owner_api: hosted,
                    }),
                  },
                  {
                    InstanceId: 'i-svc',
                    State: { Name: 'running' },
                    Tags: tagged({
                      anycloud_deployment: 'svc-1',
                      anycloud_owner_api: hosted,
                    }),
                  },
                  {
                    InstanceId: 'i-other',
                    State: { Name: 'stopped' },
                    Tags: tagged({
                      anycloud_resource: 'anycloud-cluster-prod-2',
                      anycloud_cluster: 'prod-2',
                    }),
                  },
                ],
              },
            ],
          };
        }
        if (command instanceof DescribeSecurityGroupsCommand) {
          return {
            SecurityGroups: [
              {
                GroupId: 'sg-cluster',
                Tags: tagged({
                  anycloud_resource: 'anycloud-cluster-prod-1',
                  anycloud_cluster: 'prod-1',
                }),
              },
              {
                GroupId: 'sg-svc',
                Tags: tagged({
                  anycloud_deployment: 'svc-1',
                  anycloud_owner_api: hosted,
                }),
              },
            ],
          };
        }
        return {};
      }),
    };
    aws.ec2client = ec2Client as any;
    const policy = installationSweepPolicy('prod-1', {
      spareRunningWorkloads: true,
    });

    const discovery = await aws
      .sweeper()
      .sweepResources({ dryRun: true, policy });
    expect(discovery.vmIds).toEqual(['i-mgmt', 'i-pool']);
    expect(discovery.spared).toEqual([
      { type: 'vm', id: 'i-svc', workloadId: 'svc-1' },
    ]);

    describeInstances = 0;
    const pass = await aws.sweeper().sweepResources({
      dryRun: true,
      policy: installationSweepPolicy('prod-1', {
        spareRunningWorkloads: true,
        spareWorkloadIds: ['svc-1'],
      }),
    });
    expect(pass.otherResources).toContainEqual({
      type: 'securityGroup',
      id: 'sg-cluster',
    });
    expect(pass.spared).toContainEqual({
      type: 'securityGroup',
      id: 'sg-svc',
      workloadId: 'svc-1',
    });
    expect(pass.otherResources).not.toContainEqual(
      expect.objectContaining({ id: 'sg-svc' }),
    );
  });
});

describe('AWS.deleteBucket', () => {
  it('deletes every object version and delete marker before the bucket', async () => {
    const pages = [
      {
        Versions: [
          { Key: 'ckpt/a', VersionId: 'a1' },
          { Key: 'ckpt/a', VersionId: 'a2' },
        ],
        IsTruncated: true,
        NextKeyMarker: 'ckpt/a',
        NextVersionIdMarker: 'a2',
      },
      {
        Versions: [{ Key: 'ckpt/b', VersionId: 'b1' }],
        DeleteMarkers: [{ Key: 'ckpt/a', VersionId: 'm1' }],
        IsTruncated: false,
      },
    ];
    const send = vi.fn(async (cmd: { _cmd: string }) => {
      if (cmd._cmd === 'GetBucketLocation') return { LocationConstraint: null };
      if (cmd._cmd === 'GetBucketTagging') return { TagSet: [] };
      if (cmd._cmd === 'ListObjectVersions') return pages.shift();
      if (cmd._cmd === 'HeadBucket') throw { name: 'NoSuchBucket' };
      return {};
    });
    const aws = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    );
    aws.s3client = mockedS3Client(send, {});

    await aws.storage().deleteBucket('ckpt-bucket');

    const calls = send.mock.calls.map(([cmd]) => cmd as any);
    const lists = calls.filter((c) => c._cmd === 'ListObjectVersions');
    expect(lists[1].input).toMatchObject({
      KeyMarker: 'ckpt/a',
      VersionIdMarker: 'a2',
    });
    const deleted = calls
      .filter((c) => c._cmd === 'DeleteObjects')
      .flatMap((c) => c.input.Delete.Objects);
    expect(deleted).toEqual([
      { Key: 'ckpt/a', VersionId: 'a1' },
      { Key: 'ckpt/a', VersionId: 'a2' },
      { Key: 'ckpt/b', VersionId: 'b1' },
      { Key: 'ckpt/a', VersionId: 'm1' },
    ]);
    const lastDelete = calls.findLastIndex((c) => c._cmd === 'DeleteObjects');
    const bucketDelete = calls.findIndex((c) => c._cmd === 'DeleteBucket');
    expect(bucketDelete).toBeGreaterThan(lastDelete);
    expect(calls[bucketDelete].input).toEqual({ Bucket: 'ckpt-bucket' });
  });
});

describe('AWS.terminateVMs / terminateNetworking', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't2.micro',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  it('should call terminateVM for each provided instance ID', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));

    const terminateVMSpy = vi
      .spyOn(providerCalls(aws), 'terminateVM')
      .mockResolvedValue(undefined);
    vi.spyOn(providerCalls(aws), 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    const instanceIds = ['i-1234567890abcdef0', 'i-0987654321fedcba0'];
    await aws.compute().terminateVMs(instanceIds);

    expect(terminateVMSpy).toHaveBeenCalledTimes(2);
    expect(terminateVMSpy).toHaveBeenNthCalledWith(1, instanceIds[0]);
    expect(terminateVMSpy).toHaveBeenNthCalledWith(2, instanceIds[1]);
  });

  it('should not call getInstance (no Name tag lookups)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));

    // Spy on getInstance to ensure it's NOT called
    const getInstanceSpy = vi.spyOn(aws, 'getInstance');

    // Mock terminateVM to avoid EC2 calls
    vi.spyOn(providerCalls(aws), 'terminateVM').mockResolvedValue(undefined);
    vi.spyOn(providerCalls(aws), 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });

    await aws.compute().terminateVMs(['i-1234567890abcdef0']);

    // Verify getInstance was never called
    expect(getInstanceSpy).not.toHaveBeenCalled();
  });

  it('Job/Service networking teardown sends no EC2 command', async () => {
    // Jobs and Services attach the shared security group, so teardown owns
    // nothing — not even a lookup a regionally scoped credential could deny.
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = { send: vi.fn().mockResolvedValue({}) };
    aws.ec2client = mockEC2Client as any;

    await aws.compute().terminateNetworking('fw-test-workload');

    expect(mockEC2Client.send).not.toHaveBeenCalled();
  });

  it('should not call terminateVM with empty vmIds array', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));

    const terminateVMSpy = vi
      .spyOn(providerCalls(aws), 'terminateVM')
      .mockResolvedValue(undefined);

    await aws.compute().terminateVMs([]);

    expect(terminateVMSpy).not.toHaveBeenCalled();
  });

  it('returns the subset of vmIds the cloud confirmed deleted', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.spyOn(providerCalls(aws), 'terminateVM').mockImplementation(
      async (vmId: string) => {
        if (vmId === 'i-b') throw new Error('still attached');
      },
    );
    vi.spyOn(providerCalls(aws), 'observeVMReleaseOnce').mockResolvedValue({
      state: 'release-candidate',
    });
    const result = await aws.compute().terminateVMs(['i-a', 'i-b']);
    expect(result).toEqual(['i-a']);
  });

  it('reports a denied terminate after one attempt instead of retrying it', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.spyOn(providerCalls(aws), 'tagResourcesForDeletion').mockResolvedValue(
      undefined,
    );
    vi.spyOn(
      providerCalls(aws),
      'describeInstanceForTermination',
    ).mockResolvedValue(undefined);
    const denied = Object.assign(
      new Error(
        'You are not authorized to perform: ec2:TerminateInstances on resource',
      ),
      { name: 'UnauthorizedOperation' },
    );
    const send = vi.fn().mockRejectedValue(denied);
    const mockEC2Client = { send };
    aws.ec2client = mockEC2Client as any;
    const onUnconfirmed = vi.fn();

    await expect(
      aws.compute().terminateVMs(['i-denied'], onUnconfirmed),
    ).resolves.toEqual([]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(TerminateInstancesCommand);
    expect(onUnconfirmed).toHaveBeenCalledExactlyOnceWith('i-denied', denied);
  });

  it('reports no error for a VM still shutting down when confirmation ends', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    vi.spyOn(providerCalls(aws), 'terminateVM').mockResolvedValue(undefined);
    vi.spyOn(providerCalls(aws), 'observeVMReleaseOnce').mockResolvedValue({
      state: 'present',
    });
    const onUnconfirmed = vi.fn();

    await expect(
      aws.compute().terminateVMs(['i-slow'], onUnconfirmed),
    ).resolves.toEqual([]);
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  // A spot instance as DescribeInstances reports it by ID.
  const spotInstance = (requestId?: string) => ({
    Reservations: [
      {
        Instances: [
          {
            InstanceId: 'i-spot',
            InstanceLifecycle: 'spot',
            SpotInstanceRequestId: requestId,
            State: { Code: 16, Name: 'running' },
          },
        ],
      },
    ],
  });

  it('race: cancels the request a fresh spot instance names, which the filtered lookup misses, before terminating it', async () => {
    // Read seconds after launch, the instance-id filter on spot requests
    // finds nothing; the instance itself already names its request.
    const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: true }));
    let terminated = false;
    const send = vi.fn().mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeSpotInstanceRequestsCommand) {
        return { SpotInstanceRequests: [] };
      }
      if (command instanceof DescribeInstancesCommand) {
        return terminated ? { Reservations: [] } : spotInstance('sir-fresh');
      }
      if (command instanceof TerminateInstancesCommand) terminated = true;
      return EMPTY_AWS_RESPONSE;
    });
    const mockEC2Client = { send };
    aws.ec2client = mockEC2Client as any;

    const deleted = await aws.compute().terminateVMs(['i-spot']);

    expect(deleted).toEqual(['i-spot']);
    const commands = send.mock.calls.map(([command]) => command);
    const tagIndex = commands.findIndex(
      (command) => command instanceof CreateTagsCommand,
    );
    const cancelIndex = commands.findIndex(
      (command) => command instanceof CancelSpotInstanceRequestsCommand,
    );
    const terminateIndex = commands.findIndex(
      (command) => command instanceof TerminateInstancesCommand,
    );
    expect((commands[tagIndex] as any).input.Resources).toEqual([
      'i-spot',
      'sir-fresh',
    ]);
    expect((commands[cancelIndex] as any).input).toEqual({
      SpotInstanceRequestIds: ['sir-fresh'],
    });
    expect(tagIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeGreaterThan(tagIndex);
    expect(terminateIndex).toBeGreaterThan(cancelIndex);
  });

  const instanceNotFound = () =>
    Object.assign(new Error('The instance ID does not exist'), {
      name: 'InvalidInstanceID.NotFound',
    });

  it('race: cancels and terminates a fresh spot instance DescribeInstances does not list yet', async () => {
    // A launch-time failure hands cleanup an instance AWS lists only seconds
    // later. Reading NotFound as gone would skip the cancel and the
    // termination and leave the instance running.
    vi.useFakeTimers();
    try {
      const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: true }));
      let lookups = 0;
      let terminated = false;
      const send = vi.fn().mockImplementation(async (command: unknown) => {
        if (command instanceof DescribeInstancesCommand) {
          if (terminated) return { Reservations: [] };
          if (++lookups <= 2) throw instanceNotFound();
          return spotInstance('sir-fresh');
        }
        if (command instanceof TerminateInstancesCommand) {
          if (lookups <= 2) throw instanceNotFound();
          terminated = true;
        }
        return EMPTY_AWS_RESPONSE;
      });
      const mockEC2Client = { send };
      aws.ec2client = mockEC2Client as any;

      const deleted = aws.compute().terminateVMs(['i-spot']);
      await vi.runAllTimersAsync();

      expect(await deleted).toEqual(['i-spot']);
      const commands = send.mock.calls.map(([command]) => command);
      const cancel = commands.find(
        (command) => command instanceof CancelSpotInstanceRequestsCommand,
      );
      expect((cancel as any)?.input).toEqual({
        SpotInstanceRequestIds: ['sir-fresh'],
      });
      expect(terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an instance DescribeInstances never lists within about 30 s as gone', async () => {
    vi.useFakeTimers();
    try {
      const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: true }));
      const send = vi.fn().mockImplementation(async (command: unknown) => {
        if (
          command instanceof DescribeInstancesCommand ||
          command instanceof TerminateInstancesCommand
        ) {
          throw instanceNotFound();
        }
        return EMPTY_AWS_RESPONSE;
      });
      const mockEC2Client = { send };
      aws.ec2client = mockEC2Client as any;
      const started = Date.now();

      const deleted = aws.compute().terminateVMs(['i-gone']);
      await vi.runAllTimersAsync();

      expect(await deleted).toEqual(['i-gone']);
      const lookups = send.mock.calls.filter(
        ([command]) => command instanceof DescribeInstancesCommand,
      );
      expect(lookups.length).toBeGreaterThan(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(
        send.mock.calls.some(
          ([command]) => command instanceof CancelSpotInstanceRequestsCommand,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a spot instance request by lifecycle even when the gateway is not spot', async () => {
    const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: false }));
    let terminated = false;
    const send = vi.fn().mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return terminated
          ? { Reservations: [] }
          : spotInstance('sir-lifecycle');
      }
      if (command instanceof TerminateInstancesCommand) terminated = true;
      return EMPTY_AWS_RESPONSE;
    });
    const mockEC2Client = { send };
    aws.ec2client = mockEC2Client as any;

    expect(await aws.compute().terminateVMs(['i-spot'])).toEqual(['i-spot']);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof CancelSpotInstanceRequestsCommand,
      ),
    ).toBe(true);
  });

  it.each([
    ['its request cannot be cancelled', 'sir-active'],
    ['it names no request', undefined],
  ])('does not terminate a spot instance when %s', async (_case, requestId) => {
    const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: true }));
    const send = vi.fn().mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return spotInstance(requestId);
      }
      if (command instanceof CancelSpotInstanceRequestsCommand) {
        throw new Error('cancel denied');
      }
      return EMPTY_AWS_RESPONSE;
    });
    const mockEC2Client = { send };
    aws.ec2client = mockEC2Client as any;

    const deleted = await aws.compute().terminateVMs(['i-spot']);

    expect(deleted).toEqual([]);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TerminateInstancesCommand,
      ),
    ).toBe(false);
  });

  describe('spot request sweep', () => {
    const request = (id: string, instanceId: string, ended: boolean) => ({
      SpotInstanceRequestId: id,
      InstanceId: instanceId,
      State: 'active',
      CreateTime: new Date(),
      Tags: [
        { Key: 'anycloud_deployment', Value: `job-${id}` },
        { Key: 'anycloud_user', Value: 'anycloud-test' },
        ...(ended
          ? [{ Key: 'anycloud_ended_at', Value: Date.now().toString() }]
          : []),
      ],
    });
    type Request = ReturnType<typeof request>;

    // The listing returns `listed`; a read by ID returns `current` (EC2 may
    // have filled the request since), else the listed request.
    function sweepClient(
      listed: Request[],
      options: {
        current?: Request[];
        instances?: unknown[];
        terminate?: (id: string) => void;
      } = {},
    ) {
      const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: true }));
      const send = vi.fn().mockImplementation(async (command: unknown) => {
        if (command instanceof DescribeInstancesCommand) {
          return {
            Reservations: [{ Instances: options.instances ?? [] }],
          };
        }
        if (command instanceof DescribeSpotInstanceRequestsCommand) {
          const ids = command.input.SpotInstanceRequestIds;
          if (!ids?.length) return { SpotInstanceRequests: listed };
          const byId = (rows: Request[]) =>
            rows.find((row) => row.SpotInstanceRequestId === ids[0]);
          const row = byId(options.current ?? []) ?? byId(listed);
          return { SpotInstanceRequests: row ? [row] : [] };
        }
        if (command instanceof TerminateInstancesCommand) {
          options.terminate?.(command.input.InstanceIds![0]!);
        }
        return EMPTY_AWS_RESPONSE;
      });
      const mockEC2Client = { send };
      aws.ec2client = mockEC2Client as any;
      const commands = () => send.mock.calls.map(([command]) => command);
      const terminateIndex = (id: string) =>
        commands().findIndex(
          (command) =>
            command instanceof TerminateInstancesCommand &&
            command.input.InstanceIds?.[0] === id,
        );
      return { aws, commands, terminateIndex };
    }

    it('cancels a leaked request, then terminates the instance it names', async () => {
      const { aws, commands, terminateIndex } = sweepClient(
        [
          request('sir-leak', 'i-refilled', true),
          request('sir-gone', 'i-gone', true),
          // A live Job's request is not a sweep candidate.
          request('sir-live', 'i-live', false),
        ],
        {
          terminate: (id) => {
            if (id === 'i-gone') {
              throw Object.assign(new Error('gone'), {
                name: 'InvalidInstanceID.NotFound',
              });
            }
          },
        },
      );

      const result = await aws.sweeper().sweepResources({
        ...TEST_RESOURCE_SWEEP_OPTIONS,
      });

      expect(result.errors).toEqual([]);
      expect(result.vmIds).toEqual(
        expect.arrayContaining(['i-refilled', 'i-gone']),
      );
      expect(result.vmIds).not.toContain('i-live');
      const cancelIndex = commands().findIndex(
        (command) =>
          command instanceof CancelSpotInstanceRequestsCommand &&
          command.input.SpotInstanceRequestIds?.[0] === 'sir-leak',
      );
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(terminateIndex('i-refilled')).toBeGreaterThan(cancelIndex);
      expect(terminateIndex('i-live')).toBe(-1);
    });

    it('terminates the instance the request names after the cancel, not the listed one', async () => {
      const { aws, terminateIndex } = sweepClient(
        [request('sir-filled', 'i-old', true)],
        { current: [request('sir-filled', 'i-new', true)] },
      );

      const result = await aws.sweeper().sweepResources({
        ...TEST_RESOURCE_SWEEP_OPTIONS,
      });

      expect(terminateIndex('i-new')).toBeGreaterThanOrEqual(0);
      expect(result.vmIds).toContain('i-new');
    });

    it('reports an instance the instance sweep also found once in a dry run', async () => {
      const { aws } = sweepClient([request('sir-leak', 'i-both', true)], {
        instances: [
          {
            InstanceId: 'i-both',
            InstanceLifecycle: 'spot',
            SpotInstanceRequestId: 'sir-leak',
            Tags: request('sir-leak', 'i-both', true).Tags,
          },
        ],
      });

      const result = await aws.sweeper().sweepResources({
        ...TEST_RESOURCE_SWEEP_OPTIONS,
        dryRun: true,
      });

      expect(result.vmIds.filter((id) => id === 'i-both')).toHaveLength(1);
    });

    it('reports a denied terminate once instead of retrying it', async () => {
      const { aws, commands } = sweepClient(
        [request('sir-denied', 'i-denied', true)],
        {
          terminate: () => {
            throw Object.assign(
              new Error('not authorized to perform: ec2:TerminateInstances'),
              { name: 'UnauthorizedOperation' },
            );
          },
        },
      );

      const result = await aws.sweeper().sweepResources({
        ...TEST_RESOURCE_SWEEP_OPTIONS,
      });

      expect(
        commands().filter(
          (command) => command instanceof TerminateInstancesCommand,
        ),
      ).toHaveLength(1);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ resourceId: 'sir-denied' }),
      );
    });
  });

  it('sweeps lifecycle Spot instances through the shared termination request without targeted tagging', async () => {
    const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: false }));
    let describeInstancesCalls = 0;
    const send = vi.fn().mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        describeInstancesCalls++;
        if (describeInstancesCalls === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-sweep-spot',
                    InstanceLifecycle: 'spot',
                    Tags: [
                      { Key: 'anycloud_deployment', Value: 'sweep-owner' },
                      { Key: 'anycloud_user', Value: 'anycloud-test' },
                      {
                        Key: 'anycloud_ended_at',
                        Value: Date.now().toString(),
                      },
                    ],
                  },
                ],
              },
            ],
          };
        }
        return { Reservations: [] };
      }
      return EMPTY_AWS_RESPONSE;
    });
    const ec2Client = { send };
    aws.ec2client = ec2Client as any;
    const requestInstanceTermination = vi
      .spyOn(providerCalls(aws), 'requestInstanceTermination')
      .mockResolvedValue(undefined);
    const cancelSpotRequestOf = vi
      .spyOn(providerCalls(aws), 'cancelSpotRequestOf')
      .mockResolvedValue(undefined);
    const tagResourcesForDeletion = vi.spyOn(
      aws as any,
      'tagResourcesForDeletion',
    );

    const result = await aws.sweeper().sweepResources({
      ...TEST_RESOURCE_SWEEP_OPTIONS,
    });

    expect(result.vmIds).toEqual(['i-sweep-spot']);
    expect(result.errors).toEqual([]);
    expect(cancelSpotRequestOf).toHaveBeenCalledWith(
      expect.objectContaining({ InstanceId: 'i-sweep-spot' }),
    );
    expect(requestInstanceTermination).toHaveBeenCalledWith('i-sweep-spot');
    expect(tagResourcesForDeletion).not.toHaveBeenCalled();
  });

  it('returns [] for empty input without calling the cloud', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const spy = vi
      .spyOn(providerCalls(aws), 'terminateVM')
      .mockResolvedValue(undefined);
    const result = await aws.compute().terminateVMs([]);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AWS security group networking', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'eu-west-1',
    vmType: 't2.micro',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses an existing shared security group instead of creating one', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }],
        })
        .mockResolvedValueOnce({ SecurityGroups: [{ GroupId: 'sg-existing' }] })
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-existing');

    // Looked up by group-name AND vpc-id (VPC-scoped — no cross-VPC reuse).
    const describe = mockEC2Client.send.mock.calls[1][0];
    expect(describe.input).toEqual({
      Filters: [
        { Name: 'group-name', Values: ['anycloud-vm'] },
        { Name: 'vpc-id', Values: ['vpc-default'] },
      ],
    });
    // No CreateSecurityGroup — 3 calls: DescribeVpcs, DescribeSG, Authorize.
    // Authorize always runs even on reuse; it is idempotent and swallows
    // InvalidPermission.Duplicate / IdempotentParameterMismatch.
    expect(mockEC2Client.send).toHaveBeenCalledTimes(3);
  });

  it('falls back to the first VPC when none is flagged default', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [
            { VpcId: 'vpc-first', IsDefault: false },
            { VpcId: 'vpc-second', IsDefault: false },
          ],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] })
        .mockResolvedValueOnce({ GroupId: 'sg-vm' })
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-vm');

    const create = mockEC2Client.send.mock.calls[2][0];
    expect(create.input).toMatchObject({ VpcId: 'vpc-first' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('using the first listed VPC vpc-first'),
      { region: 'eu-west-1', vpcId: 'vpc-first' },
    );
  });

  // Regression for the reported AWS provisioning failure. The SG was created in
  // DescribeVpcs's first VPC, which on a multi-VPC account is not the default
  // VPC. newVM launches with no SubnetId, so AWS auto-selects a subnet in the
  // DEFAULT VPC; an SG in any other VPC makes the launch die with "security
  // group ... and subnet ... belong to different networks". The invariant: the
  // shared SG must land in the default VPC even when it is not listed first.
  // Fails on the old `Vpcs[0]` selection, passes on `find(IsDefault) ?? [0]`.
  it('regression: creates the shared SG in the default VPC, not the first listed', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [
            { VpcId: 'vpc-nondefault', IsDefault: false },
            { VpcId: 'vpc-default', IsDefault: true },
          ],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] })
        .mockResolvedValueOnce({ GroupId: 'sg-vm' })
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-vm');

    const create = mockEC2Client.send.mock.calls[2][0];
    expect(create.input).toMatchObject({ VpcId: 'vpc-default' });
  });

  it('authorizes SSH only on the shared VM SG (jobs)', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] })
        .mockResolvedValueOnce({ GroupId: 'sg-vm' })
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-vm');

    const create = mockEC2Client.send.mock.calls[2][0];
    expect(create.input).toMatchObject({ GroupName: 'anycloud-vm' });

    const authorize = mockEC2Client.send.mock.calls[3][0];
    expect(authorize.input.IpPermissions.map((p: any) => p.FromPort)).toEqual([
      22,
    ]);
  });

  it('prepareNetwork uses the shared server SG for Cloudflare HTTP ingress', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] })
        .mockResolvedValueOnce({ GroupId: 'sg-server' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(
      requirePrepareNetwork(aws.compute())(
        buildServeIngressSpec(['10.0.0.0/8']),
        'server-1',
        '0.0.0-test',
        'test-user',
      ),
    ).resolves.toEqual({ securityGroupId: 'sg-server' });

    const create = mockEC2Client.send.mock.calls[2][0];
    expect(create.input).toMatchObject({
      GroupName: AWS_SHARED_SERVICE_SG_NAME,
      VpcId: 'vpc-default',
    });

    const permissions = mockEC2Client.send.mock.calls
      .slice(3)
      .map((call) => call[0].input.IpPermissions[0]);
    expect(permissions).toHaveLength(1 + CLOUDFLARE_IP_RANGES.length);
    expect(permissions[0]).toEqual({
      IpProtocol: 'tcp',
      FromPort: 22,
      ToPort: 22,
      IpRanges: [{ CidrIp: '10.0.0.0/8' }],
    });
    expect(
      permissions
        .slice(1)
        .map(
          (p: any) => p.IpRanges?.[0]?.CidrIp ?? p.Ipv6Ranges?.[0]?.CidrIpv6,
        ),
    ).toEqual([...CLOUDFLARE_IP_RANGES]);
    const firstIpv6 = permissions.find(
      (p: any) => p.Ipv6Ranges?.[0]?.CidrIpv6 === CLOUDFLARE_IPV6_RANGES[0],
    );
    expect(firstIpv6).toEqual({
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      Ipv6Ranges: [{ CidrIpv6: CLOUDFLARE_IPV6_RANGES[0] }],
    });
  });

  // Listing a non-default VPC first also guards the scoped group against the
  // multi-VPC regression above.
  it('maps a scoped ingress-free spec to an empty scope-local security group', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Vpcs: [
          { VpcId: 'vpc-nondefault', IsDefault: false },
          { VpcId: 'vpc-default', IsDefault: true },
        ],
      })
      .mockResolvedValueOnce({ SecurityGroups: [] })
      .mockResolvedValueOnce({ GroupId: 'sg-scope-a' })
      .mockResolvedValue({});
    const ec2Client = { send };
    aws.ec2client = ec2Client as any;
    const compute = aws.compute();
    expect(canManageCloudResources(compute)).toBe(true);
    if (!canManageCloudResources(compute))
      throw new Error('missing capability');

    await expect(
      compute.prepareResourceNetwork(
        { ingress: [], denyPublicIngress: true },
        { id: 'scope-a', tags: { anycloud_user: 'owner-1' } },
        'test-version',
      ),
    ).resolves.toEqual({ securityGroupId: 'sg-scope-a' });

    expect(send.mock.calls[2]?.[0].input).toMatchObject({
      GroupName: 'scope-a',
      VpcId: 'vpc-default',
      TagSpecifications: [
        expect.objectContaining({
          Tags: expect.arrayContaining([
            { Key: 'anycloud_resource', Value: 'scope-a' },
            {
              Key: 'anycloud_owner_api',
              Value: '00000000000000000000000000000001',
            },
          ]),
        }),
      ],
    });
    // No allow rules are authorized: the empty scoped group is AWS
    // "no public ingress", and the scoped group must be used instead of the
    // shared VM group that carries public SSH.
    expect(send.mock.calls.length).toBe(3);
  });

  it('removes stale public HTTP ingress from the shared server SG', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }],
        })
        .mockResolvedValueOnce({
          SecurityGroups: [
            {
              GroupId: 'sg-server',
              IpPermissions: [
                {
                  IpProtocol: 'tcp',
                  FromPort: 80,
                  ToPort: 80,
                  IpRanges: [{ CidrIp: '0.0.0.0/0' }],
                  Ipv6Ranges: [{ CidrIpv6: '::/0' }],
                },
                {
                  IpProtocol: 'tcp',
                  FromPort: 22,
                  ToPort: 22,
                  IpRanges: [{ CidrIp: '0.0.0.0/0' }],
                },
              ],
            },
          ],
        })
        .mockResolvedValue({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(
      requirePrepareNetwork(aws.compute())(
        buildServeIngressSpec(['10.0.0.0/8']),
        'server-1',
        '0.0.0-test',
        'test-user',
      ),
    ).resolves.toEqual({ securityGroupId: 'sg-server' });

    const revoke = mockEC2Client.send.mock.calls[2][0];
    expect(revoke.input).toEqual({
      GroupId: 'sg-server',
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          Ipv6Ranges: [{ CidrIpv6: '::/0' }],
        },
      ],
    });
  });

  it('memoizes the shared SG per gateway', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] })
        .mockResolvedValueOnce({ GroupId: 'sg-vm' })
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-vm');
    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-vm');

    // Second call is served from the memo — no extra EC2 calls beyond the
    // initial upsert (DescribeVpcs, DescribeSG, Create, Authorize).
    expect(mockEC2Client.send).toHaveBeenCalledTimes(4);
  });

  it('refetches the shared SG by name+vpc on a create race', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] })
        .mockRejectedValueOnce({ name: 'InvalidGroup.Duplicate' })
        .mockResolvedValueOnce({ SecurityGroups: [{ GroupId: 'sg-raced' }] })
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).resolves.toBe('sg-raced');

    const refetch = mockEC2Client.send.mock.calls[3][0];
    expect(refetch.input).toEqual({
      Filters: [
        { Name: 'group-name', Values: ['anycloud-vm'] },
        { Name: 'vpc-id', Values: ['vpc-default'] },
      ],
    });
  });

  it('deletes security groups by GroupId instead of GroupName', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          SecurityGroups: [{ GroupId: 'sg-delete-me' }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    aws.ec2client = mockEC2Client as any;

    await terminateResourceNetwork(aws, 'fw-test');

    const describeCommand = mockEC2Client.send.mock.calls[0][0];
    expect(describeCommand.input).toEqual({
      Filters: [{ Name: 'group-name', Values: ['fw-test'] }],
    });

    const deleteCommand = mockEC2Client.send.mock.calls[2][0];
    expect(deleteCommand.input).toEqual({ GroupId: 'sg-delete-me' });
    expect(deleteCommand.input.GroupName).toBeUndefined();
  });

  it('does not delete when the security group is already absent', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi.fn().mockResolvedValueOnce({ SecurityGroups: [] }),
    };
    aws.ec2client = mockEC2Client as any;

    await terminateResourceNetwork(aws, 'fw-test');

    expect(mockEC2Client.send).toHaveBeenCalledTimes(1);
  });

  it('throws a classifiable target error when the account has no VPCs in region', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi.fn().mockResolvedValueOnce({ Vpcs: [] }),
    };
    aws.ec2client = mockEC2Client as any;

    await expect(aws.ensureSharedSecurityGroup()).rejects.toMatchObject({
      name: 'VPCIdNotSpecified',
      Code: 'VPCIdNotSpecified',
      message: expect.stringContaining(
        'aws ec2 create-default-vpc --region eu-west-1',
      ),
    });
  });

  it('never deletes a shared anycloud security group on teardown', async () => {
    const aws = new AWS(completeCloudConfig(mockConfig));
    const mockEC2Client = {
      send: vi.fn().mockResolvedValueOnce({
        SecurityGroups: [{ GroupId: 'sg-shared', GroupName: 'anycloud-vm' }],
      }),
    };
    aws.ec2client = mockEC2Client as any;

    await terminateResourceNetwork(aws, 'anycloud-vm');

    // Only the lookup ran — no tag-for-deletion, no DeleteSecurityGroup.
    expect(mockEC2Client.send).toHaveBeenCalledTimes(1);
  });
});

describe('AWS GPU image support', () => {
  const mockConfig = {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 'g4dn.xlarge',
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
  };

  describe('resolveAmi GPU selection', () => {
    it('should select Deep Learning AMI for the cuda runtime', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: 'ami-gpu123',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
              ...amiRoot(75),
            },
            {
              ImageId: 'ami-gpu456',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20241201',
              CreationDate: '2024-12-01T00:00:00.000Z',
              ...amiRoot(75),
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      const result = await aws.resolveAmi(GpuRuntime.Cuda);

      expect(result).toEqual(resolvedAmi('ami-gpu123', 75));
      expect(mockEC2Client.send).toHaveBeenCalled();
    });

    it('throws DeployError(400) for the rocm runtime — no NVIDIA fall-through', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const mockEC2Client = { send: vi.fn() };
      aws.ec2client = mockEC2Client as any;

      await expect(aws.resolveAmi(GpuRuntime.Rocm)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(aws.resolveAmi(GpuRuntime.Rocm)).rejects.toThrow(/AMD|ROCm/);
      // Must not probe for any AMI (never reaches the NVIDIA/CPU describe call).
      expect(mockEC2Client.send).not.toHaveBeenCalled();
    });

    it('reports recognized Neuron instances without probing an AMI', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const mockEC2Client = { send: vi.fn() };
      aws.ec2client = mockEC2Client as any;

      await expect(aws.resolveAmi(GpuRuntime.Neuron)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(aws.resolveAmi(GpuRuntime.Neuron)).rejects.toThrow(
        /Neuron.*recognized.*not supported/i,
      );
      expect(mockEC2Client.send).not.toHaveBeenCalled();
    });

    it('throws DeployError(400) for an unsupported runtime — no NVIDIA fall-through', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const mockEC2Client = { send: vi.fn() };
      aws.ec2client = mockEC2Client as any;

      await expect(
        aws.resolveAmi(GpuRuntime.Unsupported),
      ).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockEC2Client.send).not.toHaveBeenCalled();
    });

    it('should select Ubuntu 24.04 LTS AMI for the null (CPU) runtime', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: 'ami-ubuntu123',
              Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
              ...amiRoot(),
            },
            {
              ImageId: 'ami-ubuntu456',
              Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20241201',
              CreationDate: '2024-12-01T00:00:00.000Z',
              ...amiRoot(),
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      const result = await aws.resolveAmi(null);

      expect(result).toEqual(resolvedAmi('ami-ubuntu123'));
      expect(mockEC2Client.send).toHaveBeenCalled();
    });

    it('selects Ubuntu 24.04 minimal for a Job host', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const send = vi.fn().mockResolvedValue({
        Images: [
          {
            ImageId: 'ami-minimal',
            Name: 'ubuntu-minimal/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-minimal-20261028',
            CreationDate: '2026-10-28T00:00:00.000Z',
            ...amiRoot(),
          },
          {
            ImageId: 'ami-server',
            Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261029',
            CreationDate: '2026-10-29T00:00:00.000Z',
            ...amiRoot(),
          },
        ],
      });
      const client = { send };
      aws.ec2client = client as any;

      // The newer server image doesn't match the minimal name.
      await expect(aws.resolveAmi(null, true)).resolves.toEqual(
        resolvedAmi('ami-minimal'),
      );
    });

    it('should select Ubuntu 24.04 LTS AMI when runtime is undefined', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: 'ami-ubuntu123',
              Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
              ...amiRoot(),
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      const result = await aws.resolveAmi(undefined);

      expect(result).toEqual(resolvedAmi('ami-ubuntu123'));
    });

    it('should filter GPU AMIs with correct date format', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: 'ami-valid',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
              ...amiRoot(75),
            },
            {
              ImageId: 'ami-invalid-format',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) extra-text',
              CreationDate: '2024-12-01T00:00:00.000Z',
              ...amiRoot(75),
            },
            {
              ImageId: 'ami-invalid-short',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 2024',
              CreationDate: '2024-11-01T00:00:00.000Z',
              ...amiRoot(75),
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      const result = await aws.resolveAmi(GpuRuntime.Cuda);

      expect(result).toEqual(resolvedAmi('ami-valid', 75));
    });

    it('should select most recent GPU AMI by creation date', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: 'ami-old',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20240101',
              CreationDate: '2024-01-01T00:00:00.000Z',
              ...amiRoot(75),
            },
            {
              ImageId: 'ami-newest',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20250301',
              CreationDate: '2025-03-01T00:00:00.000Z',
              ...amiRoot(75),
            },
            {
              ImageId: 'ami-middle',
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
              ...amiRoot(75),
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      const result = await aws.resolveAmi(GpuRuntime.Cuda);

      expect(result).toEqual(resolvedAmi('ami-newest', 75));
    });

    it('should throw error when no GPU AMIs are found', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [], // No images found
        }),
      };

      aws.ec2client = mockEC2Client as any;

      await expect(aws.resolveAmi(GpuRuntime.Cuda)).rejects.toThrow(
        /No GPU AMI found in region us-east-1/,
      );
    });

    it('should throw error when no Ubuntu AMIs are found', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [], // No images found
        }),
      };

      aws.ec2client = mockEC2Client as any;

      await expect(aws.resolveAmi(null)).rejects.toThrow(
        /No Ubuntu 24\.04 LTS AMI found in region us-east-1/,
      );
    });

    it('should throw error when GPU AMI ImageId is missing', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: undefined, // Missing ImageId
              Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      await expect(aws.resolveAmi(GpuRuntime.Cuda)).rejects.toThrow(
        /Found GPU AMI in region us-east-1 but ImageId is missing/,
      );
    });

    it('should throw error when Ubuntu AMI ImageId is missing', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const mockEC2Client = {
        send: vi.fn().mockResolvedValue({
          Images: [
            {
              ImageId: undefined, // Missing ImageId
              Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20250101',
              CreationDate: '2025-01-01T00:00:00.000Z',
            },
          ],
        }),
      };

      aws.ec2client = mockEC2Client as any;

      await expect(aws.resolveAmi(null)).rejects.toThrow(
        /Found Ubuntu AMI in region us-east-1 but ImageId is missing/,
      );
    });
  });

  describe('newVM GPU integration', () => {
    it("should pass gpuRuntime='cuda' to resolveAmi", async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const resolveAmiSpy = vi
        .spyOn(providerCalls(aws), 'resolveAmi')
        .mockResolvedValue(resolvedAmi('ami-gpu123'));

      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          gpuRuntime: GpuRuntime.Cuda,
        }),
      );

      expect(resolveAmiSpy).toHaveBeenCalledWith('cuda', undefined);
    });

    it('should pass gpuRuntime=null to resolveAmi', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const resolveAmiSpy = vi
        .spyOn(providerCalls(aws), 'resolveAmi')
        .mockResolvedValue(resolvedAmi('ami-ubuntu123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          gpuRuntime: null,
        }),
      );

      expect(resolveAmiSpy).toHaveBeenCalledWith(null, undefined);
    });

    it('should pass gpuRuntime=undefined to resolveAmi when not specified', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      const resolveAmiSpy = vi
        .spyOn(providerCalls(aws), 'resolveAmi')
        .mockResolvedValue(resolvedAmi('ami-ubuntu123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          // gpuRuntime not specified
        }),
      );

      expect(resolveAmiSpy).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('newVM host credential policy', () => {
    it('0047 invariant 1: launches a managed Job with no instance profile', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };
      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          gpuRuntime: null,
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls[0][0];
      expect(runInstancesCommand.input.IamInstanceProfile).toBeUndefined();
    });

    it.each([false, true])(
      'launches a user-controlled VM with durable ENI ownership and no instance profile (scoped: %s)',
      async (scoped) => {
        const aws = new AWS(completeCloudConfig(mockConfig));
        vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
        vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
        const mockEC2Client = {
          send: vi
            .fn()
            .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
            .mockResolvedValueOnce({
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: 'i-123',
                      PublicIpAddress: '1.2.3.4',
                      PrivateIpAddress: '10.0.0.1',
                    },
                  ],
                },
              ],
            }),
        };
        aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

        await aws.compute().newVM(
          makeNewVMProps({
            vmId: 'test-vm',
            workloadId: 'test-workload',
            ipWhitelist: [],
            startupScript: '#!/bin/bash',
            gpuRuntime: null,
            userId: 'owner-1',
            ...(scoped
              ? {
                  resourceScope: {
                    id: 'cluster-1',
                    tags: { anycloud_user: 'owner-1' },
                  },
                }
              : {}),
          }),
        );

        const runInstancesCommand = mockEC2Client.send.mock.calls[0][0];
        expect(runInstancesCommand.input.IamInstanceProfile).toBeUndefined();
        const specifications = runInstancesCommand.input
          .TagSpecifications as NonNullable<
          InstanceType<typeof RunInstancesCommand>['input']['TagSpecifications']
        >;
        const eniTags = specifications.find(
          (spec) => spec.ResourceType === 'network-interface',
        )?.Tags;
        expect(eniTags).toEqual(
          specifications.find((spec) => spec.ResourceType === 'volume')?.Tags,
        );
        expect(eniTags).toEqual(
          expect.arrayContaining([
            {
              Key: scoped ? 'anycloud_resource' : 'anycloud_deployment',
              Value: scoped ? 'cluster-1' : 'test-workload',
            },
            { Key: 'anycloud_user', Value: 'owner-1' },
            {
              Key: 'anycloud_owner_api',
              Value: '00000000000000000000000000000001',
            },
          ]),
        );
      },
    );
  });

  describe('newVM creation timestamp', () => {
    async function launchVM(launchTime?: Date) {
      const aws = new AWS(completeCloudConfig(mockConfig));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    LaunchTime: launchTime,
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      return aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );
    }

    it('returns the EC2 launch time in milliseconds', async () => {
      const launchTime = new Date('2025-01-02T03:04:05.678Z');

      const vm = await launchVM(launchTime);

      expect(vm.createdAt).toBe(launchTime.getTime());
    });

    it.each([undefined, new Date(Number.NaN)])(
      'omits createdAt when the EC2 launch time is unavailable or invalid',
      async (launchTime) => {
        const vm = await launchVM(launchTime);

        expect(vm).not.toHaveProperty('createdAt');
      },
    );
  });

  describe('newVM attempt adoption', () => {
    it.each(['stopping', 'stopped', 'shutting-down'] as const)(
      'retargets a %s EC2 attempt for cleanup instead of launching a duplicate',
      async (state) => {
        const aws = new AWS(completeCloudConfig(mockConfig));
        vi.mocked(RunInstancesCommand).mockClear();
        const mockEC2Client = {
          send: vi.fn().mockResolvedValue({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: `i-${state}`,
                    State: { Name: state },
                  },
                ],
              },
            ],
          }),
        };
        aws.ec2client = mockEC2Client as any;

        const error = await aws.compute().adoptProvisioningAttempt!({
          vmId: 'test-workload-0',
          workloadId: 'test-workload',
          userId: 'test-user',
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(VMCreationError);
        expect(error).toMatchObject({
          attemptedVmIds: [`i-${state}`],
        });
        expect(RunInstancesCommand).not.toHaveBeenCalled();
      },
    );

    it('inspects the client token and skips RunInstances when the attempt exists', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
      vi.mocked(DescribeInstancesCommand).mockClear();
      vi.mocked(RunInstancesCommand).mockClear();

      const existing = {
        InstanceId: 'i-existing',
        PublicIpAddress: '1.2.3.4',
        PrivateIpAddress: '10.0.0.4',
      };
      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            Reservations: [{ Instances: [existing] }],
          })
          .mockResolvedValueOnce({
            Reservations: [{ Instances: [existing] }],
          }),
      };
      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      const vm = await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-workload-0',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          adoptExistingAttempt: true,
        }),
      );

      expect(DescribeInstancesCommand).toHaveBeenNthCalledWith(1, {
        Filters: [
          {
            Name: 'client-token',
            Values: ['test-workload-0', 'test-workload-0.*'],
          },
          {
            Name: 'instance-state-name',
            Values: [
              'pending',
              'running',
              'stopping',
              'stopped',
              'shutting-down',
            ],
          },
        ],
      });
      expect(RunInstancesCommand).not.toHaveBeenCalled();
      expect(vm).toMatchObject({
        cloudId: 'i-existing',
        ip: '1.2.3.4',
      });
    });

    it('does not launch when the adoption lookup is inconclusive', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
      vi.mocked(RunInstancesCommand).mockClear();
      const mockEC2Client = {
        send: vi.fn().mockRejectedValue(new Error('EC2 lookup timed out')),
      };
      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await expect(
        aws.compute().newVM(
          makeNewVMProps({
            vmId: 'test-workload-0',
            workloadId: 'test-workload',
            ipWhitelist: [],
            startupScript: '#!/bin/bash',
            adoptExistingAttempt: true,
          }),
        ),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(RunInstancesCommand).not.toHaveBeenCalled();
    });

    it('preserves the real instance ID when connection observation fails', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-existing',
                    State: { Name: 'running' },
                  },
                ],
              },
            ],
          })
          .mockRejectedValueOnce(new Error('EC2 describe timed out')),
      };
      aws.ec2client = mockEC2Client as any;

      const error = await aws.compute().adoptProvisioningAttempt!({
        vmId: 'test-workload-0',
        workloadId: 'test-workload',
        userId: 'test-user',
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(VMCreationError);
      expect(error).toMatchObject({
        attemptedVmIds: ['i-existing'],
      });
    });
  });

  describe('newVM launch validation', () => {
    const newVmParams = {
      vmId: 'test-vm',
      workloadId: 'test-workload',
      ipWhitelist: [],
      startupScript: '#!/bin/bash',
      version: '0.0.0-test',
      userId: 'test-user',
    };

    it('names the missing default VPC when the launch is rejected for it', async () => {
      vi.useFakeTimers();
      try {
        const aws = new AWS(completeCloudConfig(mockConfig));
        vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
        vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
        const noDefaultVpc = Object.assign(
          new Error('No default VPC for this user'),
          { name: 'VPCIdNotSpecified', Code: 'VPCIdNotSpecified' },
        );
        const mockEC2Client = {
          send: vi.fn().mockRejectedValue(noDefaultVpc),
        };
        aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

        const launch = expect(
          aws.compute().newVM(newVmParams),
        ).rejects.toMatchObject({
          Code: 'VPCIdNotSpecified',
          message: expect.stringContaining(
            'No default VPC for this user Anycloud launches instances into',
          ),
        });
        await vi.runAllTimersAsync();
        await launch;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('AWS spot instance support', () => {
    it('should not add InstanceMarketOptions when spot=false', async () => {
      const configWithoutSpot = {
        ...mockConfig,
        spot: false,
      };

      const aws = new AWS(completeCloudConfig(configWithoutSpot));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls[0][0];

      expect(runInstancesCommand.input.InstanceMarketOptions).toBeUndefined();
    });

    it('should not add InstanceMarketOptions when spot=undefined (default)', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls[0][0];

      expect(runInstancesCommand.input.InstanceMarketOptions).toBeUndefined();
      const ebs = runInstancesCommand.input.BlockDeviceMappings[0].Ebs;
      expect(ebs.VolumeType).toBe(VolumeType.gp3);
      // completeCloudConfig stamps the High disk-tier default, whose IOPS
      // floor implies a minimum volume size; without an explicit size the
      // gateway ships that floor rather than the AMI default alone.
      expect(ebs.VolumeSize).toBe(16);
    });

    it('should add both spot and custom disk size when both specified', async () => {
      const configWithBoth = {
        ...mockConfig,
        spot: true,
        diskSizeGb: 50,
      };

      const aws = new AWS(completeCloudConfig(configWithBoth));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls[0][0];

      expect(runInstancesCommand.input.InstanceMarketOptions).toBeDefined();
      expect(runInstancesCommand.input.InstanceMarketOptions.MarketType).toBe(
        MarketType.spot,
      );
      expect(runInstancesCommand.input.BlockDeviceMappings).toBeDefined();
      expect(
        runInstancesCommand.input.BlockDeviceMappings[0].Ebs.VolumeSize,
      ).toBe(50);
    });

    it.each([
      ['a Job VM stops and keeps its request', undefined, 'persistent', 'stop'],
      [
        'a node pool VM is terminated',
        { id: 'node-pool-1', tags: {} },
        'one-time',
        'terminate',
      ],
    ])(
      'interrupts a spot VM by its owner: %s',
      async (_, resourceScope, requestType, interruption) => {
        const aws = new AWS(completeCloudConfig({ ...mockConfig, spot: true }));
        vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-123'));
        vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
        const send = vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  { InstanceId: 'i-123', PublicIpAddress: '1.2.3.4' },
                ],
              },
            ],
          });
        const ec2client = { send };
        aws.ec2client = aws.ec2LaunchClient = ec2client as any;

        await aws.compute().newVM(makeNewVMProps({ resourceScope }));

        expect(send.mock.calls[0][0].input.InstanceMarketOptions).toEqual({
          MarketType: MarketType.spot,
          SpotOptions: {
            SpotInstanceType: requestType,
            InstanceInterruptionBehavior: interruption,
          },
        });
      },
    );

    it('should work with spot and GPU image together', async () => {
      const configWithSpot = {
        ...mockConfig,
        spot: true,
      };

      const aws = new AWS(completeCloudConfig(configWithSpot));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi('ami-gpu123'));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          gpuRuntime: GpuRuntime.Cuda,
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls[0][0];

      expect(runInstancesCommand.input.InstanceMarketOptions).toBeDefined();
      expect(runInstancesCommand.input.InstanceMarketOptions.MarketType).toBe(
        MarketType.spot,
      );
    });

    it("lowers the tier's throughput to fit --disk-iops alone, and refuses own IOPS the root can't carry without growing it", async () => {
      const launch = async (diskIops: number, rootGb: number) => {
        const aws = new AWS(
          completeCloudConfig({
            ...mockConfig,
            diskTier: DiskTier.High,
            diskIops,
          }),
        );
        vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
          resolvedAmi('ami-own-gp3', rootGb),
        );
        vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
        const send = vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                    Placement: { AvailabilityZone: 'us-east-1a' },
                  },
                ],
              },
            ],
          });
        const mockEC2Client = { send };
        aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;
        await aws.compute().newVM(
          makeNewVMProps({
            vmId: 'test-vm',
            workloadId: 'test-workload',
            ipWhitelist: [],
            startupScript: '#!/bin/bash',
            gpuRuntime: GpuRuntime.Cuda,
            version: '5.3.0',
            userId: 'test-user',
          }),
        );
        return send.mock.calls.find(
          ([command]) => command instanceof RunInstancesCommand,
        )?.[0].input.BlockDeviceMappings[0].Ebs;
      };
      await expect(launch(3000, 75)).resolves.toMatchObject({
        Iops: 3000,
        Throughput: 750,
      });
      await expect(launch(60000, 75)).rejects.toThrow(
        '60000 IOPS needs a root volume of at least 120 GiB',
      );
    });

    it("launches a VM Job's own gp3 IOPS and MiB/s, overriding its disk tier's", async () => {
      const aws = new AWS(
        completeCloudConfig({
          ...mockConfig,
          diskTier: DiskTier.High,
          diskIops: 3000,
          diskThroughputMibps: 500,
        }),
      );
      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-own-gp3', 8),
      );
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                    Placement: { AvailabilityZone: 'us-east-1a' },
                  },
                ],
              },
            ],
          }),
      };
      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;
      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          version: '5.3.0',
          userId: 'test-user',
        }),
      );
      const runInstances = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      expect(runInstances.input.BlockDeviceMappings[0].Ebs).toMatchObject({
        Iops: 3000,
        Throughput: 500,
        VolumeType: 'gp3',
      });
    });

    it('does not shrink a CUDA AMI whose root already exceeds the tier minimum', async () => {
      const aws = new AWS(
        completeCloudConfig({ ...mockConfig, diskTier: DiskTier.High }),
      );

      const BASE_AMI = 'ami-base-gpu-123';

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(resolvedAmi(BASE_AMI, 75));
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                    Placement: { AvailabilityZone: 'us-east-1a' },
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      const vm = await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
          gpuRuntime: GpuRuntime.Cuda,
          version: '5.3.0',
          userId: 'test-user',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      expect(runInstancesCommand).toBeDefined();
      expect(runInstancesCommand.input.ImageId).toBe(BASE_AMI);
      expect(
        runInstancesCommand.input.BlockDeviceMappings[0].Ebs.VolumeSize,
      ).toBeUndefined();
      expect(vm.baseImageId).toBe(BASE_AMI);
    });
  });

  describe('AWS root volume configuration', () => {
    it('should force a gp3 root volume with no size or performance overrides', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-base-123', 8, '/dev/xvda'),
      );
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      // The override always ships so the root volume is explicitly gp3
      // (Canonical's noble AMIs are already gp3-rooted; jammy's were gp2).
      expect(runInstancesCommand.input.BlockDeviceMappings[0].DeviceName).toBe(
        '/dev/xvda',
      );
      const ebs = runInstancesCommand.input.BlockDeviceMappings[0].Ebs;
      expect(ebs.VolumeType).toBe(VolumeType.gp3);
      // completeCloudConfig stamps the High disk-tier default, whose IOPS
      // floor implies a minimum volume size; without an explicit size the
      // gateway ships that floor rather than the AMI default alone.
      expect(ebs.VolumeSize).toBe(16); // High's IOPS floor; no diskSizeGb set
      expect(ebs.Iops).toBe(8000);
      expect(ebs.Throughput).toBe(1000);
      expect(ebs.VolumeInitializationRate).toBeUndefined();
    });

    it.each([
      [DiskTier.Medium, 25],
      [DiskTier.High, 25],
      [DiskTier.Ultra, 32],
    ])(
      'raises a %s root with no size to at least the pool minimum',
      async (diskTier, volumeSize) => {
        const aws = new AWS(
          completeCloudConfig({
            ...mockConfig,
            diskTier,
            minimumDiskSizeGb: 25,
          }),
        );
        vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
          resolvedAmi('ami-base-123'),
        );
        vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');
        const mockEC2Client = {
          send: vi
            .fn()
            .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
            .mockResolvedValueOnce({
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: 'i-123',
                      PublicIpAddress: '1.2.3.4',
                      PrivateIpAddress: '10.0.0.1',
                    },
                  ],
                },
              ],
            }),
        };
        aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

        await aws.compute().newVM(
          makeNewVMProps({
            vmId: 'test-vm',
            workloadId: 'test-workload',
            ipWhitelist: [],
            startupScript: '#!/bin/bash',
          }),
        );

        const runInstances = mockEC2Client.send.mock.calls.find(
          ([command]) => command instanceof RunInstancesCommand,
        )![0];
        expect(runInstances.input.BlockDeviceMappings[0].Ebs.VolumeSize).toBe(
          volumeSize,
        );
      },
    );

    it('should preserve a valid explicit size with high-tier performance', async () => {
      const configWithDiskSize = {
        ...mockConfig,
        diskSizeGb: 50,
        diskTier: DiskTier.High,
      };
      const aws = new AWS(completeCloudConfig(configWithDiskSize));

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-base-123'),
      );
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      const ebs = runInstancesCommand.input.BlockDeviceMappings[0].Ebs;
      expect(ebs.VolumeSize).toBe(50);
      expect(ebs.Iops).toBe(8000);
      expect(ebs.Throughput).toBe(1000);
      expect(ebs.VolumeInitializationRate).toBeUndefined();
    });

    it('should omit explicit performance fields for the medium disk tier', async () => {
      const aws = new AWS(
        completeCloudConfig({ ...mockConfig, diskTier: DiskTier.Medium }),
      );

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-base-123'),
      );
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      const ebs = runInstancesCommand.input.BlockDeviceMappings[0].Ebs;
      expect(ebs.VolumeType).toBe(VolumeType.gp3);
      expect(ebs.Iops).toBeUndefined();
      expect(ebs.Throughput).toBeUndefined();
      expect(ebs.VolumeInitializationRate).toBeUndefined();
    });

    it('should grow an 8 GB AMI root to the high-tier minimum', async () => {
      const aws = new AWS(
        completeCloudConfig({ ...mockConfig, diskTier: DiskTier.High }),
      );

      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-base-123'),
      );
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      const ebs = runInstancesCommand.input.BlockDeviceMappings[0].Ebs;
      expect(ebs.VolumeSize).toBe(16);
      expect(ebs.VolumeType).toBe(VolumeType.gp3);
      expect(ebs.Iops).toBe(8000);
      expect(ebs.Throughput).toBe(1000);
      expect(ebs.VolumeInitializationRate).toBeUndefined();
    });

    it('should grow an 8 GB AMI root to the ultra-tier minimum', async () => {
      const aws = new AWS(
        completeCloudConfig({
          ...mockConfig,
          diskTier: DiskTier.Ultra,
        }),
      );
      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-base-123'),
      );
      vi.spyOn(aws, 'ensureSharedSecurityGroup').mockResolvedValue('sg-123');

      const mockEC2Client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-123' }] })
          .mockResolvedValueOnce({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-123',
                    PublicIpAddress: '1.2.3.4',
                    PrivateIpAddress: '10.0.0.1',
                    Placement: { AvailabilityZone: 'us-east-1a' },
                  },
                ],
              },
            ],
          }),
      };

      aws.ec2client = aws.ec2LaunchClient = mockEC2Client as any;

      await aws.compute().newVM(
        makeNewVMProps({
          vmId: 'test-vm',
          workloadId: 'test-workload',
          ipWhitelist: [],
          startupScript: '#!/bin/bash',
        }),
      );

      const runInstancesCommand = mockEC2Client.send.mock.calls.find(
        ([command]) => command instanceof RunInstancesCommand,
      )?.[0];
      const ebs = runInstancesCommand.input.BlockDeviceMappings[0].Ebs;
      expect(ebs.VolumeSize).toBe(32);
      expect(ebs.VolumeType).toBe(VolumeType.gp3);
      expect(ebs.Iops).toBe(16000);
      expect(ebs.Throughput).toBe(1000);
      expect(ebs.VolumeInitializationRate).toBeUndefined();
    });

    it('rejects an explicit size below the AMI and tier minimum', async () => {
      const aws = new AWS(
        completeCloudConfig({
          ...mockConfig,
          diskTier: DiskTier.High,
          diskSizeGb: 8,
        }),
      );
      vi.spyOn(aws, 'resolveAmi').mockResolvedValue(
        resolvedAmi('ami-base-123'),
      );
      const securityGroupSpy = vi.spyOn(aws, 'ensureSharedSecurityGroup');

      const error = await aws
        .compute()
        .newVM(
          makeNewVMProps({
            vmId: 'test-vm',
            workloadId: 'test-workload',
            ipWhitelist: [],
            startupScript: '#!/bin/bash',
          }),
        )
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(InvalidAnycloudConfigError);
      expect(error.message).toMatch(/at least 16 GB.*got 8 GB/);
      expect(aws.compute().classifyError(error)).toBe(
        CloudFailureDiagnosis.InvalidRequest,
      );
      expect(securityGroupSpy).not.toHaveBeenCalled();
    });
  });

  describe('AWS.verifyVMPreemption', () => {
    const mockConfig = {
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't2.micro',
      credentials: {
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
    };

    const makeEC2Response = (stateCode: number) => ({
      Reservations: [
        { Instances: [{ State: { Code: stateCode, Name: 'state-name' } }] },
      ],
    });

    it.each([
      [64, 'stopping'],
      [80, 'stopped'],
    ])(
      'returns true for state %i (%s) — spot interrupted',
      async (stateCode) => {
        const aws = new AWS(completeCloudConfig(mockConfig));
        vi.spyOn(aws.ec2client, 'send').mockResolvedValue(
          makeEC2Response(stateCode) as any,
        );
        expect(
          await requirePreemptible(aws.compute()).verifyVMPreemption(
            'i-abc123',
          ),
        ).toBe(true);
      },
    );

    it.each([
      [32, 'shutting-down'],
      [48, 'terminated'],
    ])(
      'returns false for state %i (%s) — deleted, not spot interrupted',
      async (stateCode) => {
        const aws = new AWS(completeCloudConfig(mockConfig));
        vi.spyOn(aws.ec2client, 'send').mockResolvedValue(
          makeEC2Response(stateCode) as any,
        );
        expect(
          await requirePreemptible(aws.compute()).verifyVMPreemption(
            'i-abc123',
          ),
        ).toBe(false);
      },
    );

    it('returns false when instance is not found', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      const noReservations = { Reservations: [] };
      vi.spyOn(aws.ec2client, 'send').mockResolvedValue(noReservations as any);
      expect(
        await requirePreemptible(aws.compute()).verifyVMPreemption('i-abc123'),
      ).toBe(false);
    });

    it('returns false when VM state check retries are exhausted', async () => {
      const aws = new AWS(completeCloudConfig(mockConfig));
      vi.spyOn(aws.ec2client, 'send').mockRejectedValue(
        new Error('AWS VM state check failed'),
      );

      vi.useFakeTimers();
      try {
        const verification = requirePreemptible(
          aws.compute(),
        ).verifyVMPreemption('i-abc123');
        await vi.runAllTimersAsync();
        expect(await verification).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Timestamp tagging', () => {
    describe('ended_at tag', () => {
      it('should add anycloud_ended_at tag to instances before termination', async () => {
        const mockConfig = {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.medium',
          credentials: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
          },
          userId: 'test-user',
          version: '1.0.0',
        };

        const aws = new AWS(completeCloudConfig(mockConfig));

        const mockEC2Client = {
          send: vi
            .fn()
            .mockResolvedValueOnce({ Reservations: [] }) // DescribeInstancesCommand
            .mockResolvedValueOnce({}) // CreateTagsCommand for ended_at
            .mockResolvedValueOnce({}) // TerminateInstancesCommand
            .mockResolvedValueOnce({
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: 'i-123',
                      State: { Code: 48 },
                    },
                  ],
                },
              ],
            }),
        };

        aws.ec2client = mockEC2Client as any;

        await aws.compute().terminateVMs(['i-123']);

        const createTagsCommand = mockEC2Client.send.mock.calls[1][0];

        expect(createTagsCommand.input.Resources).toEqual(['i-123']);
        expect(createTagsCommand.input.Tags).toContainEqual({
          Key: 'anycloud_ended_at',
          Value: expect.any(String),
        });

        // Verify timestamp format
        const endedAtTag = createTagsCommand.input.Tags.find(
          (t: any) => t.Key === 'anycloud_ended_at',
        );
        expect(endedAtTag.Value).toMatch(/^\d+$/);
        expect(Number(endedAtTag.Value)).toBeGreaterThan(0);
      });

      it('should add anycloud_ended_at tag to security groups before deletion', async () => {
        const mockConfig = {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.medium',
          credentials: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
          },
          userId: 'test-user',
          version: '1.0.0',
        };

        const aws = new AWS(completeCloudConfig(mockConfig));

        const mockEC2Client = {
          send: vi
            .fn()
            .mockResolvedValueOnce({
              SecurityGroups: [{ GroupId: 'sg-123' }],
            })
            .mockResolvedValueOnce({}) // CreateTagsCommand for ended_at
            .mockResolvedValueOnce({}), // DeleteSecurityGroupCommand
        };

        aws.ec2client = mockEC2Client as any;

        await terminateResourceNetwork(aws, 'test-workload');

        const createTagsCommand = mockEC2Client.send.mock.calls[1][0];

        expect(createTagsCommand.input.Resources).toEqual(['sg-123']);
        expect(createTagsCommand.input.Tags).toContainEqual({
          Key: 'anycloud_ended_at',
          Value: expect.any(String),
        });

        // Verify timestamp format
        const endedAtTag = createTagsCommand.input.Tags.find(
          (t: any) => t.Key === 'anycloud_ended_at',
        );
        expect(endedAtTag.Value).toMatch(/^\d+$/);
        expect(Number(endedAtTag.Value)).toBeGreaterThan(0);
      });

      it('should not block deletion if tagging fails', async () => {
        const mockConfig = {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          vmType: 't3.medium',
          credentials: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
          },
          userId: 'test-user',
          version: '1.0.0',
        };

        const aws = new AWS(completeCloudConfig(mockConfig));

        const mockEC2Client = {
          send: vi
            .fn()
            .mockResolvedValueOnce({ Reservations: [] }) // DescribeInstancesCommand
            .mockRejectedValueOnce(new Error('Tagging failed')) // 1st tag attempt
            .mockRejectedValueOnce(new Error('Tagging failed')) // 2nd tag attempt
            .mockRejectedValueOnce(new Error('Tagging failed')) // 3rd tag attempt
            .mockRejectedValueOnce(new Error('Tagging failed')) // 4th tag attempt
            .mockRejectedValueOnce(new Error('Tagging failed')) // 5th tag attempt (last retry)
            .mockResolvedValueOnce({}) // TerminateInstancesCommand should still succeed
            .mockResolvedValueOnce({ Reservations: [] }), // termination-status confirmation poll: not found = terminated
        };

        aws.ec2client = mockEC2Client as any;

        vi.useFakeTimers();
        try {
          const termination = aws.compute().terminateVMs(['i-123']);
          await vi.runAllTimersAsync();

          // Should not throw even though tagging failed
          await expect(termination).resolves.not.toThrow();
        } finally {
          vi.useRealTimers();
        }

        // Verify tagging (failed with retries), termination, and confirmation were attempted
        // 1 describe + 5 tag retry attempts + 1 terminate + 1 termination-status confirmation
        expect(mockEC2Client.send).toHaveBeenCalledTimes(8);
      });
    });
  });

  describe('classifyError', () => {
    const instance = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't2.micro',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
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

    it('reads Code field (capitalized)', () => {
      expect(
        instance.compute().classifyError({ Code: 'VcpuLimitExceeded' }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('reads name field as fallback', () => {
      expect(
        instance.compute().classifyError({ name: 'VcpuLimitExceeded' }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies Unsupported as InvalidTarget', () => {
      expect(instance.compute().classifyError({ code: 'Unsupported' })).toBe(
        CloudFailureDiagnosis.InvalidTarget,
      );
    });

    it('classifies VcpuLimitExceeded as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({ code: 'VcpuLimitExceeded' }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies InstanceLimitExceeded as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({ code: 'InstanceLimitExceeded' }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies SpotInstanceCountExceeded as AccountRegionalSpotQuotaExhausted', () => {
      expect(
        instance.compute().classifyError({ code: 'SpotInstanceCountExceeded' }),
      ).toBe(CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted);
    });

    it('classifies MaxSpotInstanceCountExceeded as AccountRegionalSpotQuotaExhausted', () => {
      expect(
        instance
          .compute()
          .classifyError({ code: 'MaxSpotInstanceCountExceeded' }),
      ).toBe(CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted);
    });

    it('classifies NetworkInterfaceLimitExceeded as QuotaExhaustedRegion', () => {
      expect(
        instance
          .compute()
          .classifyError({ code: 'NetworkInterfaceLimitExceeded' }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies InsufficientInstanceCapacity as CapacityExhausted', () => {
      expect(
        instance
          .compute()
          .classifyError({ code: 'InsufficientInstanceCapacity' }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies InsufficientSpotCapacity as CapacityExhausted', () => {
      expect(
        instance.compute().classifyError({ code: 'InsufficientSpotCapacity' }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies InsufficientFreeAddressesInSubnet as CapacityExhausted', () => {
      expect(
        instance
          .compute()
          .classifyError({ code: 'InsufficientFreeAddressesInSubnet' }),
      ).toBe(CloudFailureDiagnosis.CapacityExhausted);
    });

    it('classifies RequestExpired as BadCredential', () => {
      expect(instance.compute().classifyError({ code: 'RequestExpired' })).toBe(
        CloudFailureDiagnosis.BadCredential,
      );
    });

    it('classifies InvalidClientToken as BadCredential', () => {
      expect(
        instance.compute().classifyError({ code: 'InvalidClientToken' }),
      ).toBe(CloudFailureDiagnosis.BadCredential);
    });

    it('classifies InvalidInstanceType as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({ code: 'InvalidInstanceType' }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies InvalidParameterValue InstanceType message as InvalidTarget', () => {
      // A nonexistent/typo'd instance type comes back under the generic
      // InvalidParameterValue code, not InvalidInstanceType. A pinned region
      // escalates this to terminal Invalid (see classifier comment).
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameterValue',
          message:
            "Invalid value 'totally_fake_nonexistent_vm' for InstanceType.",
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies VPCIdNotSpecified as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({ code: 'VPCIdNotSpecified' }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies InvalidParameterValue + "not available in the Availability Zone" as InvalidTarget', () => {
      // AWS reuses InvalidParameterValue for instance-type/region mismatches.
      // Message-pattern fast-path must rotate regions instead of failing
      // terminal (see classifier comment).
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameterValue',
          message:
            'The requested instance type p5.48xlarge is not available in the Availability Zone us-east-1a.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies "region does not support" message as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'Unsupported',
          message: 'The region us-west-1 does not support this instance type.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('does not match unrelated "does not support" phrasing', () => {
      // Regex must not fire when "does not support" has no adjacent zone
      // token — see the inline guardrails in aws.ts classifyError.
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameterValue',
          message:
            'This operation does not support tagging. Retry in us-east-1 without tags.',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it('classifies generic InvalidParameterValue as Transient (fail-open)', () => {
      // Mirrors Azure InvalidParameter handling: too-generic to be terminal.
      // Missed region-phrase regex degrades to bounded retry, not terminal
      // Invalid. Do NOT re-add to userErrors without the reasoning in the
      // classifier comment.
      expect(
        instance.compute().classifyError({
          code: 'InvalidParameterValue',
          message: 'Value (foo) for parameter is invalid.',
        }),
      ).toBe(CloudFailureDiagnosis.TemporaryProviderFailure);
    });

    it.each([
      'InvalidClientTokenId',
      'SignatureDoesNotMatch',
      'ExpiredToken',
      'ExpiredTokenException',
      'AuthFailure',
      'Blocked',
    ])('classifies %s as BadCredential', (code) => {
      expect(instance.compute().classifyError({ code })).toBe(
        CloudFailureDiagnosis.BadCredential,
      );
    });

    it('classifies AWS account Blocked SDK shape as BadCredential', () => {
      expect(
        instance.compute().classifyError({
          Code: 'Blocked',
          name: 'Blocked',
          message:
            'This account is currently blocked and not recognized as a valid account.',
          $metadata: { httpStatusCode: 400 },
        }),
      ).toBe(CloudFailureDiagnosis.BadCredential);
    });

    it.each([
      'InvalidBucketName',
      'BucketAlreadyExists',
      'MarketplacePurchaseEligibilityFailed',
    ])('classifies %s as UserError', (code) => {
      expect(instance.compute().classifyError({ code })).toBe(
        CloudFailureDiagnosis.InvalidRequest,
      );
    });

    it('classifies OptInRequired as InvalidTarget (region not opted in)', () => {
      expect(instance.compute().classifyError({ code: 'OptInRequired' })).toBe(
        CloudFailureDiagnosis.InvalidTarget,
      );
    });

    it('classifies UnauthorizedOperation with opt-in message as InvalidTarget', () => {
      const optIn = {
        code: 'UnauthorizedOperation',
        message:
          'You are not subscribed to this service. Please see http://aws.amazon.com/opt-in to subscribe.',
      };
      expect(instance.compute().classifyError(optIn)).toBe(
        CloudFailureDiagnosis.InvalidTarget,
      );
      expect(instance.compute().permissionDenial?.(optIn)).toBeUndefined();
    });

    it.each([
      { persona: AWS_EC2_REGION_DENIED, regional: true },
      { persona: AWS_S3_ACCESS_DENIED, regional: false },
      { persona: AWS_ECR_ACCESS_DENIED, regional: false },
    ])(
      '0047 invariant 3: $persona.code is PermissionDenied naming $persona.action',
      ({ persona, regional }) => {
        const error = Object.assign(new Error(persona.message), {
          name: persona.code,
          Code: persona.code,
          $metadata: { httpStatusCode: persona.httpStatus },
        });
        const compute = instance.compute();
        expect(compute.classifyError(error)).toBe(
          CloudFailureDiagnosis.PermissionDenied,
        );
        expect(compute.permissionDenial?.(error)).toEqual({
          action: persona.action,
          regional,
        });
      },
    );

    it('reads no action from a denial that names none', () => {
      const error = { name: 'AccessDenied', message: 'Access Denied' };
      expect(instance.compute().permissionDenial?.(error)).toEqual({
        action: null,
        regional: false,
      });
      expect(
        instance.compute().permissionDenial?.({
          code: 'InvalidClientTokenId',
          message: 'The security token included in the request is invalid.',
        }),
      ).toBeUndefined();
    });

    it('classifies VcpuLimitExceeded with "limit of 0" message as InvalidTarget', () => {
      expect(
        instance.compute().classifyError({
          code: 'VcpuLimitExceeded',
          message:
            'You have requested more vCPU capacity than your current vCPU limit of 0 allows for the instance bucket.',
        }),
      ).toBe(CloudFailureDiagnosis.InvalidTarget);
    });

    it('classifies VcpuLimitExceeded with "limit of 32" message as QuotaExhaustedRegion', () => {
      expect(
        instance.compute().classifyError({
          code: 'VcpuLimitExceeded',
          message:
            'You have requested more vCPU capacity than your current vCPU limit of 32 allows for the instance bucket.',
        }),
      ).toBe(CloudFailureDiagnosis.QuotaExhaustedRegion);
    });

    it('classifies unknown errors as temporary-provider-failure', () => {
      expect(instance.compute().classifyError({ code: 'SomethingElse' })).toBe(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
    });

    it('classifies S3 Unknown HTTP 400 as ProvisioningRejected', () => {
      // Real shape from a customer workload that ping-ponged 47x each
      // between eu-south-2 and me-central-1: AWS SDK couldn't parse the
      // S3 response body, so it threw with name: "Unknown" and no Code.
      expect(
        instance.compute().classifyError({
          name: 'Unknown',
          message: 'UnknownError',
          $fault: 'client',
          $metadata: { httpStatusCode: 400, requestId: '733MDV2NBYHJ2T45' },
        }),
      ).toBe(CloudFailureDiagnosis.ProvisioningRejected);
    });

    it('classifies the name:"Error" / message:"Unknown" 400 variant as ProvisioningRejected', () => {
      // Same opt-in-region S3 parse failure, but the SDK surfaces it with
      // name "Error" (so code falls back to "Error") and the "Unknown" marker
      // in the message instead of the name. Must still rotate, not retry.
      expect(
        instance.compute().classifyError({
          name: 'Error',
          message: 'Unknown',
          $metadata: { httpStatusCode: 400 },
        }),
      ).toBe(CloudFailureDiagnosis.ProvisioningRejected);
    });

    it('does not upgrade plain HTTP 400 with a known code to ProvisioningRejected', () => {
      // Sanity: only the Unknown-shaped 400 is treated as ProvisioningRejected;
      // codes like MaxSpotInstanceCountExceeded keep their existing routing.
      expect(
        instance.compute().classifyError({
          name: 'MaxSpotInstanceCountExceeded',
          Code: 'MaxSpotInstanceCountExceeded',
          $metadata: { httpStatusCode: 400 },
        }),
      ).toBe(CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted);
    });
  });
});
