import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cfnSend: vi.fn(),
  beginDelete: vi.fn(),
  instanceDelete: vi.fn(),
  order: [] as string[],
}));

vi.mock('../../../../src/api/services/provider-clients/aws.js', () => ({
  createAwsInstanceCloudFormationClient: (region: string) => ({
    send: (command: unknown) => mocks.cfnSend(region, command),
  }),
}));
vi.mock('../../../../src/api/services/provider-clients/azure.js', () => ({
  createAzureInstanceCredential: () => 'identity',
  createAzureResourceManagementClient: (
    credential: string,
    subscription: string,
  ) => ({
    resourceGroups: {
      beginDelete: (group: string) =>
        mocks.beginDelete(credential, subscription, group),
    },
  }),
}));
vi.mock('../../../../src/api/services/provider-clients/gcp.js', () => ({
  createGcpInstanceComputeClients: () => ({
    instances: {
      delete: async (request: unknown) => {
        mocks.order.push('instance');
        mocks.instanceDelete(request);
      },
    },
  }),
}));

import {
  parseSelfDeleteTarget,
  removeInstallation,
} from '../../../../src/api/services/gateways/self-delete';

const metadata = {
  awsRegion: async () => 'eu-west-1',
  azureSubscription: async () => 'sub-1',
  gcpProject: async () => 'proj-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
});

describe('the API removing its own installation', () => {
  it('on AWS deletes its stack in its own region through the CFN service role', async () => {
    await removeInstallation(
      {
        cloud: 'aws',
        stackName: 'anycloud-prod-1',
        roleArn: 'arn:aws:iam::1:role/anycloud-prod-1-cfn',
      },
      metadata,
    );
    const [region, command] = mocks.cfnSend.mock.calls[0]!;
    expect(region).toBe('eu-west-1');
    expect((command as { input: unknown }).input).toEqual({
      StackName: 'anycloud-prod-1',
      RoleARN: 'arn:aws:iam::1:role/anycloud-prod-1-cfn',
    });
  });

  it('on Azure deletes its group with the managed identity, without waiting', async () => {
    await removeInstallation(
      { cloud: 'azure', resourceGroup: 'anycloud-prod-1' },
      metadata,
    );
    expect(mocks.beginDelete).toHaveBeenCalledWith(
      'identity',
      'sub-1',
      'anycloud-prod-1',
    );
  });

  it('on GCP deletes only its own instance; the CLI deletes the rules after', async () => {
    await removeInstallation(
      {
        cloud: 'gcp',
        instanceName: 'anycloud-cluster-prod-1',
        zone: 'us-central1-a',
      },
      metadata,
    );
    expect(mocks.order).toEqual(['instance']);
    expect(mocks.instanceDelete).toHaveBeenCalledWith({
      project: 'proj-1',
      zone: 'us-central1-a',
      instance: 'anycloud-cluster-prod-1',
    });
  });

  it('reads the release values’ selfDelete, and refuses one naming nothing', () => {
    expect(parseSelfDeleteTarget(undefined)).toBeNull();
    expect(
      parseSelfDeleteTarget(
        JSON.stringify({ cloud: 'azure', resourceGroup: 'anycloud-prod-1' }),
      ),
    ).toEqual({ cloud: 'azure', resourceGroup: 'anycloud-prod-1' });
    expect(() =>
      parseSelfDeleteTarget(JSON.stringify({ cloud: 'aws', stackName: 'x' })),
    ).toThrow('ANYCLOUD_SELF_DELETE');
  });
});
