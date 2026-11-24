import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  type RunInstancesCommandInput,
} from '@aws-sdk/client-ec2';

// The published catalogs carry no capability column until the publisher runs;
// vm-details.spec covers the query against catalog data.
vi.mock('../../../../src/shared/cloud-config.js', async (importActual) => ({
  ...(await importActual<
    typeof import('../../../../src/shared/cloud-config.js')
  >()),
  nestedVirtualizationSupport: vi.fn(),
}));

import { AWS } from '../../../../src/api/services/gateways/aws.js';
import {
  completeCloudConfig,
  nestedVirtualizationSupport,
} from '../../../../src/shared/cloud-config.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { makeNewVMProps } from '../../helpers/fixtures.js';
import { internalsOf } from '../../helpers/internals.js';

afterEach(() => vi.restoreAllMocks());

async function launch(support: boolean | null) {
  vi.mocked(nestedVirtualizationSupport).mockReturnValue(support);
  const aws = new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 'r7i.4xlarge',
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    }),
  );
  const internal = internalsOf<{
    resolveAmi: AWS['resolveAmi'];
    ensureSharedSecurityGroup: AWS['ensureSharedSecurityGroup'];
  }>(aws);
  vi.spyOn(internal, 'resolveAmi').mockResolvedValue({
    imageId: 'ami-test',
    rootDeviceName: '/dev/sda1',
    rootVolumeSizeGb: 8,
  });
  vi.spyOn(internal, 'ensureSharedSecurityGroup').mockResolvedValue('sg-test');
  const launches: RunInstancesCommandInput[] = [];
  const instance = { InstanceId: 'i-test', PublicIpAddress: '192.0.2.1' };
  aws.ec2LaunchClient = aws.ec2client;
  vi.spyOn(aws.ec2client, 'send').mockImplementation(async (command: any) => {
    if (command instanceof RunInstancesCommand) {
      launches.push(command.input);
      return { Instances: [instance] };
    }
    if (command instanceof DescribeInstancesCommand)
      return { Reservations: [{ Instances: [instance] }] };
    throw new Error(`Unexpected AWS command ${command.constructor.name}`);
  });
  await aws.compute().newVM(
    makeNewVMProps({
      vmId: 'runner-attempt-1',
      workloadId: 'runner-host-1',
      startupScript: '#!/bin/bash\ntrue',
      ipWhitelist: [],
    }),
  );
  expect(nestedVirtualizationSupport).toHaveBeenCalledWith(
    CloudType.AWS,
    'r7i.4xlarge',
    'us-east-1',
  );
  return launches;
}

describe('AWS nested virtualization launch', () => {
  it('enables nested virtualization when the catalog reports support, with no extra AWS call', async () => {
    const [launch1, ...rest] = await launch(true);
    expect(rest).toEqual([]);
    expect(launch1.CpuOptions).toEqual({ NestedVirtualization: 'enabled' });
  });

  it.each([false, null])(
    'launches unchanged when catalog support is %s',
    async (support) => {
      const [launch1] = await launch(support);
      expect(launch1).not.toHaveProperty('CpuOptions');
    },
  );

  it('serializes NestedVirtualization onto the actual EC2 query wire', async () => {
    const handle = vi.fn().mockResolvedValue({
      response: {
        statusCode: 200,
        headers: {},
        body: new TextEncoder().encode(
          '<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>test</requestId><instancesSet/></RunInstancesResponse>',
        ),
      },
    });
    const client = new EC2Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: { handle },
    });
    try {
      await client.send(
        new RunInstancesCommand({
          ImageId: 'ami-test',
          InstanceType: 'r7i.4xlarge',
          MinCount: 1,
          MaxCount: 1,
          CpuOptions: { NestedVirtualization: 'enabled' },
        }),
      );
      expect(
        new URLSearchParams(handle.mock.calls[0][0].body).get(
          'CpuOptions.NestedVirtualization',
        ),
      ).toBe('enabled');
    } finally {
      client.destroy();
    }
  });
});
