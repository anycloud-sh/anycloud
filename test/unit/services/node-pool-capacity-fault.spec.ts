import { afterEach, describe, expect, it } from 'vitest';
import { createComputeProvider } from '../../../src/api/services/cloud-config.js';
import { e2eCapacityFault } from '../../../src/api/services/node-pool-controller.js';
import {
  CloudFailureDiagnosis,
  CloudType,
  type CloudConfig,
} from '../../../src/shared/cloud.js';

// Each provider's real classifier, built from placeholder credentials.
const targets = (
  [
    [CloudType.AWS, { accessKeyId: 'k', secretAccessKey: 's' }, 't3.small'],
    [
      CloudType.GCP,
      {
        projectId: 'p',
        clientEmail: 'e@p.iam.gserviceaccount.com',
        privateKey: 'k',
      },
      'e2-standard-2',
    ],
    [
      CloudType.Azure,
      {
        tenantId: 't',
        clientId: 'c',
        clientSecret: 's',
        subscriptionId: 'sub',
      },
      'Standard_D2s_v5',
    ],
    [CloudType.Lambda, { apiKey: 'k' }, 'cpu_4x_general'],
  ] as const
).map(([cloudProvider, credentials, vmType]) => ({
  cloudProvider,
  credentials,
  region: 'us-east-1',
  vmType,
}));

describe('E2E capacity fault', () => {
  afterEach(() => {
    delete process.env.ANYCLOUD_E2E_CAPACITY_FAULT;
  });

  it.each(targets)(
    'fails the first launch for its key as $cloudProvider capacity, and only that one',
    (target) => {
      const key = 'np-live-pool-0a1b2c-e2e';
      expect(e2eCapacityFault(key, false)).toBeNull();
      process.env.ANYCLOUD_E2E_CAPACITY_FAULT = key;
      const compute = createComputeProvider(target as unknown as CloudConfig);
      expect(compute.classifyError(e2eCapacityFault(key, false))).toBe(
        CloudFailureDiagnosis.CapacityExhausted,
      );
      expect(e2eCapacityFault('customer-pool', false)).toBeNull();
      expect(e2eCapacityFault(key, true)).toBeNull();
    },
  );
});
