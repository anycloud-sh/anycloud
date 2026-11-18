import { afterEach, describe, expect, it, vi } from 'vitest';
import { AWS } from '../../../../src/api/services/gateways/aws.js';
import { Azure } from '../../../../src/api/services/gateways/azure.js';
import type { CloudCompute } from '../../../../src/api/services/gateways/cloud.js';
import { GCP } from '../../../../src/api/services/gateways/gcp.js';
import { bindVmCompute } from '../../../../src/api/services/vm-compute.js';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { CloudType, type CloudConfig } from '../../../../src/shared/cloud.js';
import { fakeSdkClient } from '../../helpers/sdk-client.js';

vi.mock('../../../../src/api/services/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => vi.restoreAllMocks());

const configs = {
  [CloudType.AWS]: {
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.medium',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  },
  [CloudType.GCP]: {
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'a',
    vmType: 'e2-standard-2',
    credentials: {
      projectId: 'test-project',
      privateKey: 'test-private-key',
      clientEmail: 'test@test-project.iam.gserviceaccount.com',
    },
  },
  [CloudType.Azure]: {
    cloudProvider: CloudType.Azure,
    region: 'eastus2',
    vmType: 'Standard_B1s',
    credentials: {
      subscriptionId: '12345678-1234-1234-1234-123456789012',
      directoryId: 'test-directory-id',
      applicationId: 'test-app-id',
      secret: 'test-secret',
    },
  },
} satisfies Record<string, CloudConfig>;

const gateways = {
  [CloudType.AWS]: () => new AWS(completeCloudConfig(configs[CloudType.AWS])),
  [CloudType.GCP]: () => new GCP(completeCloudConfig(configs[CloudType.GCP])),
  [CloudType.Azure]: () =>
    new Azure(completeCloudConfig(configs[CloudType.Azure])),
};

// Each gateway's private read behind VM spot Jobs' preemption check.
type JobRead = { verifyVMPreemption(cloudId: string): Promise<boolean> };
const spyJobRead = (gateway: object) =>
  vi.spyOn(gateway as JobRead, 'verifyVMPreemption');

function bind(compute: CloudCompute) {
  return bindVmCompute(compute, {
    cloudId: 'vm-1',
    provider: compute.type,
    credential: { source: 'attempt', credentialId: 'credential-1' },
    region: compute.region,
    availabilityZone: null,
  });
}

describe('stopped-VM reads', () => {
  it.each([CloudType.AWS, CloudType.GCP, CloudType.Azure] as const)(
    'VM spot Jobs on %s read through verifyVMPreemption',
    async (provider) => {
      const gateway = gateways[provider]();
      const read = spyJobRead(gateway).mockResolvedValue(true);
      const vm = bind(gateway.compute());

      await expect(vm.preemption?.observe()).resolves.toBe(true);
      expect(read).toHaveBeenCalledExactlyOnceWith('vm-1');
    },
  );

  it.each([CloudType.AWS, CloudType.GCP] as const)(
    'pools on %s share the VM spot Jobs read',
    async (provider) => {
      const gateway = gateways[provider]();
      const read = spyJobRead(gateway).mockResolvedValue(true);

      await expect(bind(gateway.compute()).observeStopped?.()).resolves.toBe(
        true,
      );
      expect(read).toHaveBeenCalledExactlyOnceWith('vm-1');
    },
  );

  describe('an Azure pool', () => {
    function azurePool(...results: unknown[]) {
      const gateway = gateways[CloudType.Azure]();
      const get = vi.fn();
      for (const result of results) {
        if (result instanceof Error) get.mockRejectedValueOnce(result);
        else get.mockResolvedValueOnce(result);
      }
      const stub = { virtualMachines: { get } };
      gateway.computeClient = fakeSdkClient(
        stub as unknown as typeof gateway.computeClient,
      );
      const jobRead = spyJobRead(gateway);
      return { vm: bind(gateway.compute()), get, jobRead };
    }
    const powerState = (state: string, provisioning = 'succeeded') => ({
      instanceView: {
        statuses: [
          { code: `ProvisioningState/${provisioning}` },
          { code: `PowerState/${state}` },
        ],
      },
    });

    it('keeps a VM that goes Ready, then Starting', async () => {
      const { vm, get, jobRead } = azurePool(
        powerState('running'),
        powerState('starting'),
      );

      await expect(vm.observeStopped?.()).resolves.toBe(false);
      await expect(vm.observeStopped?.()).resolves.toBe(false);
      expect(get).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenCalledWith(expect.any(String), 'vm-1', {
        expand: 'instanceView',
      });
      expect(jobRead).not.toHaveBeenCalled();
    });

    it.each(['stopping', 'stopped', 'deallocating', 'deallocated'])(
      'replaces a %s VM',
      async (state) => {
        const { vm } = azurePool(powerState(state));
        await expect(vm.observeStopped?.()).resolves.toBe(true);
      },
    );

    it.each([
      ['an unknown power state', powerState('unknown')],
      ['failed provisioning', powerState('running', 'failed')],
      [
        'failed provisioning with no power state',
        { provisioningState: 'Failed' },
      ],
      ['a missing VM', Object.assign(new Error('gone'), { statusCode: 404 })],
      ['a failed read', Object.assign(new Error('busy'), { statusCode: 500 })],
    ])('keeps a VM on %s', async (_case, result) => {
      const { vm } = azurePool(result);
      await expect(vm.observeStopped?.()).resolves.toBe(false);
    });
  });
});
