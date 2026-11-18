import { describe, expect, test } from 'vitest';
import { clusterCloudConfiguration } from '../integration/e2e/internal/substrates/cloud-cluster/configuration.js';

const resolve = (env: Record<string, string>) =>
  clusterCloudConfiguration((name) => env[name] ?? '');

describe('e2e-cluster-cloud dispatch configuration', () => {
  test('restore_stage runs on the default journey only', () => {
    expect(resolve({ E2E_CLUSTER_RESTORE_STAGE: 'true' }).restoreStage).toBe(
      true,
    );
    for (const env of [
      { E2E_CLUSTER_HOSTED_STAGE: 'true' },
      { E2E_CLUSTER_DEAD_API_DELETE: 'true' },
      { E2E_CLUSTER_FROM_RELEASE: '0.1.65' },
    ] as Record<string, string>[])
      expect(() =>
        resolve({ ...env, E2E_CLUSTER_RESTORE_STAGE: 'true' }),
      ).toThrow('E2E_CLUSTER_RESTORE_STAGE runs on the default journey only');
  });

  test('dead_api_delete runs on the default journey only', () => {
    expect(resolve({ E2E_CLUSTER_DEAD_API_DELETE: 'true' }).deadApiDelete).toBe(
      true,
    );
    expect(resolve({}).deadApiDelete).toBe(false);
    expect(() =>
      resolve({
        E2E_CLUSTER_DEAD_API_DELETE: 'true',
        E2E_CLUSTER_HOSTED_STAGE: 'true',
      }),
    ).toThrow('default journey only');
  });

  test.each([
    [
      'an AWS cluster by default',
      {},
      {
        clusterProvider: 'aws',
        clusterRegion: 'us-east-2',
        managementVmType: 't3.medium',
        vmType: 't3.small',
        hostedStage: false,
        fromRelease: null,
      },
    ],
    [
      'a GCP cluster',
      { E2E_CLUSTER_PROVIDER: 'gcp' },
      {
        clusterProvider: 'gcp',
        clusterRegion: 'us-central1',
        managementVmType: 'e2-standard-2',
        vmType: 'e2-standard-2',
      },
    ],
    [
      'an Azure cluster in its region',
      { E2E_CLUSTER_PROVIDER: 'azure', E2E_CLUSTER_REGION: 'eastus' },
      {
        clusterProvider: 'azure',
        clusterRegion: 'eastus',
        managementVmType: 'Standard_D2s_v5',
        vmType: 'Standard_D2s_v5',
      },
    ],
    [
      'the hosted journey upgrading from a published release',
      { E2E_CLUSTER_HOSTED_STAGE: 'true', E2E_CLUSTER_FROM_RELEASE: '0.1.65' },
      { hostedStage: true, fromRelease: '0.1.65' },
    ],
    [
      'explicit management VM and workload VM types',
      {
        E2E_CLUSTER_MANAGEMENT_VM_TYPE: 't3.large',
        E2E_CLUSTER_VM_TYPE: 't3.medium',
      },
      { managementVmType: 't3.large', vmType: 't3.medium' },
    ],
  ])('resolves %s', (_name, env, expected) => {
    expect(resolve(env)).toMatchObject(expected);
  });

  test.each([
    [
      { E2E_CLUSTER_PROVIDER: 'lambda' },
      'E2E_CLUSTER_PROVIDER must be aws, gcp or azure, not lambda',
    ],
    [
      { E2E_CLUSTER_FROM_RELEASE: '0.1.65' },
      'E2E_CLUSTER_FROM_RELEASE upgrades the hosted API; set E2E_CLUSTER_HOSTED_STAGE=true',
    ],
    [
      { E2E_CLUSTER_PROVIDER: 'gcp', E2E_CLUSTER_HOSTED_STAGE: 'true' },
      'E2E_CLUSTER_PROVIDER=gcp runs only the default journey until E2E_CLUSTER_HOSTED_STAGE is qualified on it',
    ],
    [
      { E2E_CLUSTER_LIVE_CHECKS: 'role-apply' },
      'E2E_CLUSTER_LIVE_CHECKS run on hosted_stage',
    ],
    [
      { E2E_CLUSTER_HOSTED_STAGE: 'true', E2E_CLUSTER_LIVE_CHECKS: 'reboot' },
      'E2E_CLUSTER_LIVE_CHECKS names unknown checks reboot',
    ],
    // A removed pool check is now unknown.
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_LIVE_CHECKS: 'agent-restart',
      },
      'E2E_CLUSTER_LIVE_CHECKS names unknown checks agent-restart',
    ],
  ])('refuses %j', (env, error) => {
    expect(() => resolve(env)).toThrow(error);
  });

  test('selects the live checks in their fixed order, none by default', () => {
    expect(resolve({ E2E_CLUSTER_HOSTED_STAGE: 'true' }).liveChecks).toEqual(
      [],
    );
    expect(
      resolve({
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_LIVE_CHECKS:
          'role-storage-tokens, role-connections,role-apply role-key-rotation',
      }).liveChecks,
    ).toEqual([
      'role-apply',
      'role-connections',
      'role-key-rotation',
      'role-storage-tokens',
    ]);
  });
});
