import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCloudCli } from '../../../../src/cli/seed/cloud-cli.js';
import {
  QuotaRightsError,
  readCloudQuotaStatus,
} from '../../../../src/cli/seed/quota.js';
import {
  SeedUnavailableError,
  type SeedCloud,
} from '../../../../src/cli/seed/types.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { AWS_QUOTA_CODES } from '../../../../src/shared/quota-resolvers/aws.js';
import {
  installFakeCloudClis,
  type FakeCliResponder,
  type FakeCloudClis,
} from '../../../helpers/fake-cloud-cli.js';

let clis: FakeCloudClis | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  clis?.cleanup();
  clis = undefined;
});

const SIGNED_IN: Record<SeedCloud, FakeCliResponder[]> = {
  aws: [
    {
      match: ['sts', 'get-caller-identity'],
      stdout: {
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/me',
      },
    },
  ],
  gcp: [
    { match: ['config', 'get', 'project'], stdout: 'acme-prod\n' },
    { match: ['auth', 'print-access-token'], stdout: 'tok\n' },
    { match: ['config', 'get', 'account'], stdout: 'me@acme.com\n' },
  ],
  azure: [
    {
      match: ['account', 'show'],
      stdout: { id: 'sub-1', user: { name: 'me@acme.com' } },
    },
  ],
};

function read(
  cloud: SeedCloud,
  responders: FakeCliResponder[],
  region: string,
) {
  const executable = { aws: 'aws', gcp: 'gcloud', azure: 'az' }[cloud];
  clis = installFakeCloudClis({ [executable]: responders });
  vi.stubEnv('PATH', clis.env.PATH);
  return readCloudQuotaStatus(cloud, region, createCloudCli(cloud));
}

describe('quota status through the cloud CLI', () => {
  it('reads AWS current limits, falling back to the default and then unavailable', async () => {
    const noSuch = {
      stderr:
        'An error occurred (NoSuchResourceException) when calling the GetServiceQuota operation',
      exitCode: 254,
    };
    const entries = await read(
      'aws',
      [
        ...SIGNED_IN.aws,
        // The account changed only the Standard on-demand quota.
        {
          match: /^service-quotas get-service-quota .*L-1216C47A/,
          stdout: { Quota: { Value: 640 } },
        },
        { match: ['service-quotas', 'get-service-quota'], ...noSuch },
        // AWS has no default for Trn spot.
        {
          match: /^service-quotas get-aws-default-service-quota .*L-6B0D517C/,
          ...noSuch,
        },
        {
          match: ['service-quotas', 'get-aws-default-service-quota'],
          stdout: { Quota: { Value: 5 } },
        },
      ],
      'us-east-1',
    );
    expect(entries).toHaveLength(Object.keys(AWS_QUOTA_CODES).length * 2);
    expect(entries).toContainEqual({
      kind: 'current',
      cloud: CloudType.AWS,
      region: 'us-east-1',
      resourceName: 'Running On-Demand Standard instances',
      resourceKey: expect.any(String),
      status: 'CURRENT',
      currentLimit: 640,
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        resourceName: 'All G and VT Spot Instance Requests',
        currentLimit: 5,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'unavailable',
        resourceName: 'All Trn Spot Instance Requests',
      }),
    );
    expect(clis!.calls().map(({ args }) => args.join(' '))).toContain(
      'service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --region us-east-1 --output json',
    );
  });

  it('reads GCP CPU and GPU metrics, with preemptible ones as spot', async () => {
    const entries = await read(
      'gcp',
      [
        ...SIGNED_IN.gcp,
        {
          match: ['compute', 'regions', 'describe'],
          stdout: {
            quotas: [
              { metric: 'CPUS', limit: 24, usage: 2 },
              { metric: 'N2_CPUS', limit: 8 },
              { metric: 'PREEMPTIBLE_NVIDIA_T4_GPUS', limit: 1 },
              { metric: 'DISKS_TOTAL_GB', limit: 4096 },
              { metric: 'COMMITTED_N2_CPUS', limit: 0 },
            ],
          },
        },
      ],
      'us-central1',
    );
    expect(entries).toEqual([
      expect.objectContaining({
        resourceName: 'CPUS',
        currentLimit: 24,
      }),
      expect.objectContaining({
        resourceName: 'N2_CPUS',
        currentLimit: 8,
      }),
      expect.objectContaining({
        cloud: CloudType.GCP,
        region: 'us-central1',
        resourceName: 'PREEMPTIBLE_NVIDIA_T4_GPUS',
        currentLimit: 1,
        spot: true,
      }),
    ]);
    expect(clis!.calls().at(-1)!.args).toEqual([
      'compute',
      'regions',
      'describe',
      'us-central1',
      '--project=acme-prod',
      '--format=json(quotas)',
    ]);
  });

  it('reads the Azure vCPU and GPU-family usages the API status shows', async () => {
    const entries = await read(
      'azure',
      [
        ...SIGNED_IN.azure,
        {
          match: ['vm', 'list-usage'],
          stdout: [
            {
              limit: '100',
              name: { value: 'cores', localizedValue: 'Total Regional vCPUs' },
            },
            {
              limit: '0',
              name: {
                value: 'standardNCASv3_T4Family',
                localizedValue: 'Standard NCASv3_T4 Family vCPUs',
              },
            },
            {
              limit: '10',
              name: {
                value: 'lowPriorityCores',
                localizedValue: 'Total Regional Low-priority vCPUs',
              },
            },
            // Not a launch blocker the API's status shows: dropped.
            {
              limit: '350',
              name: {
                value: 'standardDSv3Family',
                localizedValue: 'Standard DSv3 Family vCPUs',
              },
            },
            {
              limit: '25000',
              name: {
                value: 'virtualMachines',
                localizedValue: 'Virtual Machines',
              },
            },
          ],
        },
      ],
      'westus2',
    );
    expect(entries).toEqual([
      expect.objectContaining({
        cloud: CloudType.Azure,
        resourceName: 'Total Regional vCPUs',
        resourceKey: 'azure:cores',
        currentLimit: 100,
      }),
      expect.objectContaining({
        resourceName: 'Standard NCASv3_T4 Family vCPUs',
        resourceKey: 'azure:standardncasv3_t4family',
        currentLimit: 0,
      }),
      expect.objectContaining({
        resourceKey: 'azure:lowprioritycores',
        currentLimit: 10,
      }),
    ]);
    expect(clis!.calls().at(-1)!.args).toEqual([
      'vm',
      'list-usage',
      '--location',
      'westus2',
      '--output',
      'json',
    ]);
  });

  it('reports a read that fails for another reason as an unavailable row', async () => {
    const failing: [SeedCloud, FakeCliResponder[], string, RegExp][] = [
      [
        'aws',
        [
          {
            match: /^service-quotas get-service-quota .*L-1216C47A/,
            stderr:
              'An error occurred (TooManyRequestsException) when calling the GetServiceQuota operation: Rate exceeded',
            exitCode: 254,
          },
          { match: ['service-quotas'], stdout: { Quota: { Value: 5 } } },
        ],
        'Running On-Demand Standard instances',
        /Rate exceeded/,
      ],
      [
        'gcp',
        [
          {
            match: ['compute', 'regions', 'describe'],
            stderr:
              "ERROR: (gcloud.compute.regions.describe) Could not fetch resource:\n - The resource 'projects/acme-prod/regions/nowhere1' was not found\n",
            exitCode: 1,
          },
        ],
        'Compute region quotas',
        /nowhere1' was not found/,
      ],
      [
        'azure',
        [
          {
            match: ['vm', 'list-usage'],
            stderr:
              "ERROR: (NoRegisteredProviderFound) No registered resource provider found for location 'nowhere1'",
            exitCode: 1,
          },
        ],
        'Compute usages',
        /NoRegisteredProviderFound/,
      ],
    ];
    for (const [cloud, responders, resourceName, message] of failing) {
      const entries = await read(
        cloud,
        [...SIGNED_IN[cloud], ...responders],
        'nowhere1',
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          kind: 'unavailable',
          region: 'nowhere1',
          resourceName,
          status: 'UNAVAILABLE',
          message: expect.stringMatching(message),
        }),
      );
      clis?.cleanup();
    }
  });

  it('says how to sign in when the CLI is signed out', async () => {
    await expect(
      read(
        'azure',
        [
          {
            match: ['account', 'show'],
            stderr: 'Please run az login',
            exitCode: 1,
          },
        ],
        'westus2',
      ),
    ).rejects.toBeInstanceOf(SeedUnavailableError);
  });

  it('names the missing right when the cloud denies the read', async () => {
    // Each CLI's real denial text.
    const denials: [SeedCloud, FakeCliResponder][] = [
      [
        'aws',
        {
          match: ['service-quotas'],
          stderr:
            'An error occurred (AccessDeniedException) when calling the GetServiceQuota operation: User: arn:aws:iam::123456789012:user/me is not authorized to perform: servicequotas:GetServiceQuota',
          exitCode: 254,
        },
      ],
      [
        'gcp',
        {
          match: ['compute', 'regions', 'describe'],
          stderr:
            "ERROR: (gcloud.compute.regions.describe) Could not fetch resource:\n - Required 'compute.regions.get' permission for 'projects/acme-prod/regions/us-central1'\n",
          exitCode: 1,
        },
      ],
      [
        'azure',
        {
          match: ['vm', 'list-usage'],
          stderr:
            "ERROR: (AuthorizationFailed) The client 'me@acme.com' with object id 'x' does not have authorization to perform action 'Microsoft.Compute/locations/usages/read'",
          exitCode: 1,
        },
      ],
    ];
    for (const [cloud, denial] of denials) {
      await expect(
        read(cloud, [...SIGNED_IN[cloud], denial], 'us-central1'),
      ).rejects.toBeInstanceOf(QuotaRightsError);
      clis?.cleanup();
    }
  });
});
