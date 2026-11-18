import type { EC2Client } from '@aws-sdk/client-ec2';
import type { ImagesClient } from '@google-cloud/compute';
import { describe, expect, it, vi } from 'vitest';

import { createAwsBaseImageResolver } from '../../../../src/api/services/gateways/aws.js';
import { createGcpBaseImageResolver } from '../../../../src/api/services/gateways/gcp.js';
import { CloudType, GpuRuntime } from '../../../../src/shared/cloud.js';
import { fakeSdkClient } from '../../helpers/sdk-client.js';

describe('base-image resolvers', () => {
  it('resolves the AWS CUDA image without a compute placement config', async () => {
    const send = vi.fn().mockResolvedValue({
      Images: [
        {
          ImageId: 'ami-current',
          Name: 'Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20260901',
          CreationDate: '2026-09-01T00:00:00.000Z',
          RootDeviceName: '/dev/sda1',
          BlockDeviceMappings: [
            { DeviceName: '/dev/sda1', Ebs: { VolumeSize: 75 } },
          ],
        },
      ],
    });
    const resolver = createAwsBaseImageResolver(
      fakeSdkClient<EC2Client>({ send }),
      'us-east-1',
    );

    await expect(
      resolver.resolveBaseImage({ gpuRuntime: GpuRuntime.Cuda }),
    ).resolves.toEqual({
      imageId: 'ami-current',
      rootDeviceName: '/dev/sda1',
      rootVolumeSizeGb: 75,
    });
    expect(resolver.type).toBe(CloudType.AWS);
    expect(send).toHaveBeenCalledOnce();
  });

  it('resolves the default GCP CUDA family without a VM type or region', async () => {
    const getFromFamily = vi.fn().mockResolvedValue([
      {
        name: 'common-cu129-ubuntu-2404-nvidia-580-v20260901',
        selfLink: 'projects/dlvm/global/images/cu129-v20260901',
      },
    ]);
    const resolver = createGcpBaseImageResolver(
      fakeSdkClient<ImagesClient>({ getFromFamily }),
    );

    await expect(
      resolver.resolveBaseImage({ gpuRuntime: GpuRuntime.Cuda }),
    ).resolves.toEqual({
      imageId: 'projects/dlvm/global/images/cu129-v20260901',
      imageName: 'common-cu129-ubuntu-2404-nvidia-580-v20260901',
      family: 'common-cu129-ubuntu-2404-nvidia-580',
      project: 'deeplearning-platform-release',
    });
    expect(resolver.type).toBe(CloudType.GCP);
    expect(getFromFamily).toHaveBeenCalledWith({
      family: 'common-cu129-ubuntu-2404-nvidia-580',
      project: 'deeplearning-platform-release',
    });
  });
});
