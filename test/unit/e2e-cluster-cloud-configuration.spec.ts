import { describe, expect, test } from 'vitest';
import {
  clusterCloudConfiguration,
  releaseHasRunnerFeatures,
  poolJobStorageClouds,
} from '../integration/e2e/internal/substrates/cloud-cluster/configuration.js';
import { assertHostedStageConfiguration } from '../integration/e2e/internal/substrates/cloud-cluster/hosted-stage.js';

const resolve = (env: Record<string, string>) =>
  clusterCloudConfiguration((name) => env[name] ?? '');

describe('e2e-cluster-cloud dispatch configuration', () => {
  test('C11, C12 and C22 ship in every release after 0.1.72', () => {
    expect(releaseHasRunnerFeatures('0.1.72')).toBe(false);
    expect(releaseHasRunnerFeatures('0.1.73')).toBe(true);
  });

  test.each([
    // S20: hosted_stage on a Lambda pool, each role on its own backend.
    [
      { E2E_CLUSTER_POOL_PROVIDER: 'lambda', E2E_CLUSTER_HOSTED_STAGE: 'true' },
      { input: 'gcp', output: 'aws', checkpoint: 'azure' },
    ],
    // S16: gpu_pool on an AWS spot pool.
    [
      { E2E_CLUSTER_GPU_POOL: 'true', E2E_CLUSTER_POOL_SPOT: 'true' },
      { checkpoint: 'azure' },
    ],
  ])(
    '0043/S16 and S20: %j runs a journey whose bucketed Job names storage credentials',
    (env, clouds) => {
      const configuration = resolve(env);
      expect(poolJobStorageClouds(configuration)).toEqual(clouds);
      expect(
        assertHostedStageConfiguration({
          ...configuration,
          alternateImage: configuration.hostedStage ? 'image-b' : undefined,
          poolVmType: configuration.poolVmTypes[0]!,
        }),
      ).toBeDefined();
    },
  );
  test.each([
    [{ E2E_CLUSTER_GPU_POOL: 'true' }],
    [
      {
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'azure',
        E2E_CLUSTER_POOL_SPOT: 'true',
      },
    ],
    // S17 and S21: hosted_stage on AWS and GCP spot pools.
    [{ E2E_CLUSTER_HOSTED_STAGE: 'true', E2E_CLUSTER_POOL_SPOT: 'true' }],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'gcp',
        E2E_CLUSTER_POOL_SPOT: 'true',
      },
    ],
  ])("%j signs every role with the pool's own credential", (env) => {
    expect(poolJobStorageClouds(resolve(env))).toEqual({});
  });

  test('restore_stage runs on the default journey only', () => {
    expect(resolve({ E2E_CLUSTER_RESTORE_STAGE: 'true' }).restoreStage).toBe(
      true,
    );
    for (const env of [
      { E2E_CLUSTER_HOSTED_STAGE: 'true' },
      { E2E_CLUSTER_GPU_POOL: 'true' },
      { E2E_CLUSTER_DEAD_API_DELETE: 'true' },
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
    for (const env of [
      { E2E_CLUSTER_DEAD_API_DELETE: 'true', E2E_CLUSTER_HOSTED_STAGE: 'true' },
      { E2E_CLUSTER_DEAD_API_DELETE: 'true', E2E_CLUSTER_GPU_POOL: 'true' },
    ] as Record<string, string>[])
      expect(() => resolve(env)).toThrow('default journey only');
  });

  test('two GPU replicas require the voice journey before provisioning', () => {
    expect(() => resolve({ E2E_CLUSTER_GPU_REPLICAS: '2' })).toThrow();
    expect(() =>
      resolve({
        E2E_CLUSTER_GPU_REPLICAS: '3',
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_GPU_WORKLOAD: 'voice',
      }),
    ).toThrow();
    expect(
      resolve({
        E2E_CLUSTER_GPU_REPLICAS: '2',
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_GPU_WORKLOAD: 'voice',
      }).gpuReplicas,
    ).toBe(2);
  });
  test.each([
    [
      'an AWS cluster by default',
      {},
      {
        clusterProvider: 'aws',
        clusterRegion: 'us-east-2',
        managementVmType: 't3.medium',
        poolProvider: 'aws',
        poolRegion: 'us-east-2',
        poolVmTypes: ['t3.small'],
      },
    ],
    [
      'a GCP cluster and, by default, its pool',
      { E2E_CLUSTER_PROVIDER: 'gcp' },
      {
        clusterProvider: 'gcp',
        clusterRegion: 'us-central1',
        managementVmType: 'e2-standard-2',
        poolProvider: 'gcp',
        poolRegion: 'us-central1',
        poolVmTypes: ['e2-standard-2'],
      },
    ],
    [
      'an Azure cluster and a CPU pool in its region',
      { E2E_CLUSTER_PROVIDER: 'azure', E2E_CLUSTER_REGION: 'eastus' },
      {
        clusterProvider: 'azure',
        clusterRegion: 'eastus',
        managementVmType: 'Standard_D2s_v5',
        poolProvider: 'azure',
        poolRegion: 'eastus',
        poolVmTypes: ['Standard_D2s_v5'],
      },
    ],
    [
      'an Azure CPU pool in westus2 against an AWS cluster',
      { E2E_CLUSTER_POOL_PROVIDER: 'azure', E2E_CLUSTER_HOSTED_STAGE: 'true' },
      {
        clusterProvider: 'aws',
        poolProvider: 'azure',
        poolRegion: 'westus2',
        poolVmTypes: ['Standard_D2s_v5'],
      },
    ],
    [
      'an unpinned Lambda pool rotating 1-GPU types against an AWS cluster',
      { E2E_CLUSTER_POOL_PROVIDER: 'lambda' },
      {
        clusterProvider: 'aws',
        poolProvider: 'lambda',
        poolRegion: null,
        poolVmTypes: ['gpu_1x_a10', 'gpu_1x_a100_sxm4'],
      },
    ],
    [
      "the hosted stage's unpinned Lambda GPU pool",
      { E2E_CLUSTER_POOL_PROVIDER: 'lambda', E2E_CLUSTER_HOSTED_STAGE: 'true' },
      {
        hostedStage: true,
        poolRegion: null,
        poolVmTypes: ['gpu_1x_a10', 'gpu_1x_a100_sxm4'],
      },
    ],
    [
      'a Lambda pool pinned by pool_region',
      {
        E2E_CLUSTER_POOL_PROVIDER: 'lambda',
        E2E_CLUSTER_POOL_REGION: 'us-east-3',
      },
      { poolProvider: 'lambda', poolRegion: 'us-east-3' },
    ],
    [
      'a Lambda GPU pool on the same 1-GPU types',
      { E2E_CLUSTER_POOL_PROVIDER: 'lambda', E2E_CLUSTER_GPU_POOL: 'true' },
      {
        gpuPool: true,
        poolRegion: null,
        poolVmTypes: ['gpu_1x_a10', 'gpu_1x_a100_sxm4'],
      },
    ],
    [
      'a GCP pool against an AWS cluster in its own default region',
      { E2E_CLUSTER_POOL_PROVIDER: 'gcp' },
      {
        clusterProvider: 'aws',
        poolProvider: 'gcp',
        poolRegion: 'us-central1',
      },
    ],
    [
      "the Azure GPU journey's T4 against an AWS cluster",
      { E2E_CLUSTER_POOL_PROVIDER: 'azure', E2E_CLUSTER_GPU_POOL: 'true' },
      {
        gpuPool: true,
        poolRegion: 'westus2',
        poolVmTypes: ['Standard_NC4as_T4_v3'],
        gpuWorkload: 'mace',
      },
    ],
    [
      "the GCP GPU journey on e2e-gpu's L4 leg against an AWS cluster",
      { E2E_CLUSTER_POOL_PROVIDER: 'gcp', E2E_CLUSTER_GPU_POOL: 'true' },
      { gpuPool: true, poolRegion: 'us-east4', poolVmTypes: ['g2-standard-4'] },
    ],
    [
      'the hosted release journey on an AWS cluster',
      { E2E_CLUSTER_HOSTED_STAGE: 'true' },
      { hostedStage: true, poolRegion: 'us-east-2', poolVmTypes: ['t3.small'] },
    ],
    [
      'the hosted journey upgrading from a published release',
      { E2E_CLUSTER_HOSTED_STAGE: 'true', E2E_CLUSTER_FROM_RELEASE: '0.1.65' },
      { hostedStage: true, fromRelease: '0.1.65' },
    ],
    [
      "the AWS GPU journey's T4",
      { E2E_CLUSTER_GPU_POOL: 'true' },
      { gpuPool: true, poolRegion: 'us-east-2', poolVmTypes: ['g4dn.xlarge'] },
    ],
    [
      'explicit management VM and pool choices',
      {
        E2E_CLUSTER_MANAGEMENT_VM_TYPE: 't3.large',
        E2E_CLUSTER_POOL_REGION: 'us-west-2',
        E2E_CLUSTER_POOL_VM_TYPE: 't3.medium',
      },
      {
        managementVmType: 't3.large',
        poolRegion: 'us-west-2',
        poolVmTypes: ['t3.medium'],
      },
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
      { E2E_CLUSTER_POOL_PROVIDER: 'vast' },
      'E2E_CLUSTER_POOL_PROVIDER must be aws, gcp, azure or lambda, not vast',
    ],
    [
      { E2E_CLUSTER_PROVIDER: 'gcp', E2E_CLUSTER_POOL_PROVIDER: 'lambda' },
      'E2E_CLUSTER_POOL_PROVIDER=lambda against a gcp cluster is not qualified',
    ],
    [
      { E2E_CLUSTER_FROM_RELEASE: '0.1.65' },
      'E2E_CLUSTER_FROM_RELEASE upgrades the hosted API; set E2E_CLUSTER_HOSTED_STAGE or E2E_CLUSTER_GPU_POOL=true',
    ],
    [
      { E2E_CLUSTER_PROVIDER: 'gcp', E2E_CLUSTER_HOSTED_STAGE: 'true' },
      'E2E_CLUSTER_PROVIDER=gcp runs only the default journey until E2E_CLUSTER_HOSTED_STAGE is qualified on it',
    ],
    [
      { E2E_CLUSTER_PROVIDER: 'azure', E2E_CLUSTER_GPU_POOL: 'true' },
      'E2E_CLUSTER_PROVIDER=azure runs only the default journey until E2E_CLUSTER_GPU_POOL is qualified on it',
    ],
    [
      { E2E_CLUSTER_PROVIDER: 'gcp', E2E_CLUSTER_POOL_PROVIDER: 'azure' },
      'E2E_CLUSTER_POOL_PROVIDER=azure against a gcp cluster is not qualified',
    ],
    [
      { E2E_CLUSTER_PROVIDER: 'azure', E2E_CLUSTER_POOL_PROVIDER: 'gcp' },
      'E2E_CLUSTER_POOL_PROVIDER=gcp against a azure cluster is not qualified',
    ],
    [
      { E2E_CLUSTER_POOL_PROVIDER: 'azure' },
      'E2E_CLUSTER_POOL_PROVIDER=azure with an AWS cluster runs with E2E_CLUSTER_HOSTED_STAGE or E2E_CLUSTER_GPU_POOL=true',
    ],
    [
      { E2E_CLUSTER_POOL_PROVIDER: 'lambda', E2E_CLUSTER_POOL_SPOT: 'true' },
      'E2E_CLUSTER_POOL_SPOT needs an AWS, GCP or Azure pool',
    ],
    [
      { E2E_CLUSTER_GPU_WORKLOAD: 'voice' },
      "E2E_CLUSTER_GPU_WORKLOAD selects the GPU pool journey's workload",
    ],
    [
      { E2E_CLUSTER_GPU_POOL: 'true', E2E_CLUSTER_GPU_WORKLOAD: 'video' },
      'E2E_CLUSTER_GPU_WORKLOAD must be mace or voice, not video',
    ],
    // The live checks, each where the dispatch can run it.
    [
      { E2E_CLUSTER_LIVE_CHECKS: 'agent-restart' },
      'E2E_CLUSTER_LIVE_CHECKS run on a hosted journey',
    ],
    [
      { E2E_CLUSTER_HOSTED_STAGE: 'true', E2E_CLUSTER_LIVE_CHECKS: 'reboot' },
      'E2E_CLUSTER_LIVE_CHECKS names unknown checks reboot',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_LIVE_CHECKS: 'entry-handoff',
      },
      'entry-handoff runs across the upgrade; set E2E_CLUSTER_FROM_RELEASE',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_FROM_RELEASE: '0.1.71',
        E2E_CLUSTER_LIVE_CHECKS: 'pool-job-upgrade',
      },
      'pool-job-upgrade runs across the upgrade from a release whose pool Jobs run through it',
    ],
    [
      {
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_GPU_WORKLOAD: 'voice',
        E2E_CLUSTER_GPU_REPLICAS: '2',
        E2E_CLUSTER_POOL_PROVIDER: 'azure',
        E2E_CLUSTER_FROM_RELEASE: '0.1.72',
        E2E_CLUSTER_LIVE_CHECKS: 'pool-job-upgrade',
      },
      'pool-job-upgrade needs a one-Node pool',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_POOL_VM_TYPE: 'g4dn.xlarge',
        E2E_CLUSTER_FROM_RELEASE: '0.1.72',
        E2E_CLUSTER_LIVE_CHECKS: 'pool-job-upgrade',
      },
      'pool-job-upgrade needs a one-Node pool',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'lambda',
        E2E_CLUSTER_FROM_RELEASE: '0.1.72',
        E2E_CLUSTER_LIVE_CHECKS: 'pool-job-upgrade',
      },
      'pool-job-upgrade needs a one-Node pool',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'lambda',
        E2E_CLUSTER_LIVE_CHECKS: 'cpu-defaults',
      },
      'cpu-defaults needs an AWS, GCP or Azure pool',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'lambda',
        E2E_CLUSTER_LIVE_CHECKS: 'cpu-cold-start',
      },
      'cpu-cold-start needs an AWS, GCP or Azure pool',
    ],
    [
      {
        E2E_CLUSTER_HOSTED_STAGE: 'true',
        E2E_CLUSTER_LIVE_CHECKS: 'user-namespace',
      },
      'user-namespace needs E2E_USER_NAMESPACE_IMAGES',
    ],
    // GCP_GPU_QUOTA: the upgrade's surge Node or a second replica would be a second L4.
    [
      {
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'gcp',
        E2E_CLUSTER_FROM_RELEASE: '0.1.70',
      },
      'E2E_CLUSTER_FROM_RELEASE on a GCP GPU pool needs a second GPU; the GCP project allows 1',
    ],
    [
      {
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_GPU_WORKLOAD: 'voice',
        E2E_CLUSTER_GPU_REPLICAS: '2',
        E2E_CLUSTER_POOL_PROVIDER: 'gcp',
      },
      'E2E_CLUSTER_GPU_REPLICAS=2 on a GCP GPU pool needs a second GPU; the GCP project allows 1',
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
        E2E_CLUSTER_GPU_POOL: 'true',
        E2E_CLUSTER_POOL_PROVIDER: 'azure',
        E2E_CLUSTER_FROM_RELEASE: '0.1.70',
        E2E_CLUSTER_LIVE_CHECKS:
          'pool-gpu-probe, cpu-defaults,entry-handoff agent-restart',
      }).liveChecks,
    ).toEqual([
      'agent-restart',
      'entry-handoff',
      'cpu-defaults',
      'pool-gpu-probe',
    ]);
  });
});
