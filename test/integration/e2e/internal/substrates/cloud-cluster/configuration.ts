import {
  ROLE_CHECKS,
  type RoleCheckPolicy,
} from '../../contracts/role-connections.js';
import * as semver from 'semver';
import { CloudType } from '../../../../../../src/shared/cloud.js';
import { gpuCapabilityForVMType } from '../../../../../../src/shared/cloud-config.js';
import { POOL_CHECKS, type PoolCheck } from '../../contracts/pool-checks.js';

/**
 * The live cluster member's dispatch inputs, resolved and validated before any
 * cloud resource is admitted: where the management VM lives (`cluster_provider`)
 * and where the node pool's capacity lives (`pool_provider`, defaulting to it).
 */

export type CloudProvider = 'aws' | 'gcp' | 'azure';
/** Lambda hosts node pools only, against an AWS cluster. */
export type PoolProvider = CloudProvider | 'lambda';

type PoolDefault = { region: string | null; vmTypes: readonly string[] };

/**
 * The cloud of the storage credential the bucketed pool Job names for each
 * role (RFC 0043 O11); a role left out signs with the pool's own credential,
 * on its own cloud's storage (S17, S21). A Lambda pool has no storage, so
 * `hosted_stage` there puts each role on another backend (S20), and
 * `gpu_pool` on a spot pool off Azure keeps its managed checkpoint bucket in
 * Azure (S16).
 */
export function poolJobStorageClouds(
  configuration: Pick<
    ClusterCloudConfiguration,
    'poolProvider' | 'poolSpot' | 'gpuPool'
  >,
): Partial<Record<'input' | 'output' | 'checkpoint', CloudProvider>> {
  const { poolProvider, poolSpot, gpuPool } = configuration;
  if (poolProvider === 'lambda') {
    return { input: 'gcp', output: 'aws', checkpoint: 'azure' };
  }
  return gpuPool && poolSpot && poolProvider !== 'azure'
    ? { checkpoint: 'azure' }
    : {};
}

export interface ClusterCloudConfiguration {
  /** The cloud `cluster create` uses for the management VM and its checkpoint bucket. */
  readonly clusterProvider: CloudProvider;
  readonly clusterRegion: string;
  readonly managementVmType: string;
  readonly poolProvider: PoolProvider;
  /** Null leaves the pool unpinned: PRF-3 picks its region per VM. */
  readonly poolRegion: string | null;
  /** Ordered; every type shares one GPU kind and count. */
  readonly poolVmTypes: readonly string[];
  /** `node-pool create --spot`. */
  readonly poolSpot: boolean;
  /** The default journey deletes the cluster as from a second machine, with its API gone (`dead_api_delete`). */
  readonly deadApiDelete: boolean;
  /** The default journey restores from the kept bucket, then deletes it (`restore_stage`). */
  readonly restoreStage: boolean;
  readonly gpuPool: boolean;
  readonly hostedStage: boolean;
  readonly gpuWorkload: 'mace' | 'voice';
  readonly gpuReplicas: 1 | 2;
  /** The published release the hosted stage bootstraps and upgrades from (`from_release`). */
  readonly fromRelease: string | null;
  /** `live_checks`, each refused up front where the dispatch can't run it. */
  readonly liveChecks: readonly PoolCheck[];
  /** `user-namespace`'s root, sudo and no-sudo images, which e2e.sh pushes (RFC 0049 C32). */
  readonly userNamespaceImages: readonly string[];
}

/**
 * The live checks' own pool types: `cpu-defaults`' and `cpu-cold-start`'s CPU
 * type, 2 vCPUs and 8 GiB so two default replicas share a Node, and a 1 GiB
 * type; and
 * `pool-gpu-probe`'s GPU pool on a CPU journey, under that cloud's GPU lock:
 * four T4s on AWS, so the co-located case runs there, and one L4 on GCP
 * (`GCP_GPU_QUOTA`), in us-east4 like every GCP L4 leg. Azure has none: its
 * probe runs on `gpu_pool`.
 */
/**
 * The GCP project's GPUS_ALL_REGIONS quota (an increase was denied on
 * 2026-10-28): a GCP GPU pool can never hold a second GPU VM.
 */
export const GCP_GPU_QUOTA = 1;

/** The last release without RFC 0049 C11, C12 and C22 (`cpu-cold-start`). */
const BEFORE_RUNNER_FEATURES = '0.1.72';

/** Whether `fromRelease`'s API has C11, C12 and C22. */
export function releaseHasRunnerFeatures(fromRelease: string): boolean {
  return semver.gt(fromRelease, BEFORE_RUNNER_FEATURES);
}

export const LIVE_CHECK_POOLS: Record<
  CloudProvider,
  {
    readonly cpu: string;
    readonly small: string;
    readonly gpu: string;
    readonly gpuRegion?: string;
  }
> = {
  aws: { cpu: 't3.large', small: 't2.micro', gpu: 'g4dn.12xlarge' },
  gcp: {
    cpu: 'e2-standard-2',
    small: 'f1-micro',
    gpu: 'g2-standard-4',
    gpuRegion: 'us-east4',
  },
  azure: { cpu: 'Standard_D2s_v5', small: 'Standard_B1s', gpu: '' },
};

/** `user-namespace`'s pool: 4 vCPUs and 16 GiB with nested virtualization (C10). */
export const USER_NAMESPACE_CHECK_VM: Record<CloudProvider, string> = {
  aws: 'm7i.xlarge',
  gcp: 'n2-standard-4',
  azure: 'Standard_D4s_v5',
};

function liveChecksOf(
  value: string,
  journey: Pick<
    ClusterCloudConfiguration,
    | 'hostedStage'
    | 'gpuPool'
    | 'fromRelease'
    | 'poolProvider'
    | 'gpuReplicas'
    | 'poolVmTypes'
  >,
): readonly PoolCheck[] {
  const names = value.split(/[\s,]+/u).filter(Boolean);
  const unknown = names.filter(
    (name) => !(POOL_CHECKS as readonly string[]).includes(name),
  );
  if (unknown.length) {
    throw new Error(
      `E2E_CLUSTER_LIVE_CHECKS names unknown checks ${unknown.join(', ')}; choose from ${POOL_CHECKS.join(', ')}`,
    );
  }
  const checks = POOL_CHECKS.filter((check) => names.includes(check));
  if (checks.length && !journey.hostedStage && !journey.gpuPool) {
    throw new Error(
      'E2E_CLUSTER_LIVE_CHECKS run on a hosted journey; set E2E_CLUSTER_HOSTED_STAGE or E2E_CLUSTER_GPU_POOL=true',
    );
  }
  if (checks.includes('entry-handoff') && !journey.fromRelease) {
    throw new Error(
      'entry-handoff runs across the upgrade; set E2E_CLUSTER_FROM_RELEASE',
    );
  }
  // C27 ships after 0.1.71: an older release records no runner release, so
  // its pool Jobs drain and its Deployments roll. The CI stamp makes
  // from_release the candidate's predecessor, so its runner is in the window.
  if (
    checks.includes('pool-job-upgrade') &&
    !(journey.fromRelease && semver.gt(journey.fromRelease, '0.1.71'))
  ) {
    throw new Error(
      'pool-job-upgrade runs across the upgrade from a release whose pool Jobs run through it; set E2E_CLUSTER_FROM_RELEASE to a release after 0.1.71',
    );
  }
  // Its second Job queues only on a one-Node pool: the hosted stage buys two
  // Nodes of a GPU type (`#poolVms`), and Lambda's types rotate.
  if (
    checks.includes('pool-job-upgrade') &&
    (journey.poolProvider === 'lambda' ||
      (journey.gpuPool
        ? journey.gpuReplicas === 2
        : gpuCapabilityForVMType(
            {
              aws: CloudType.AWS,
              gcp: CloudType.GCP,
              azure: CloudType.Azure,
            }[journey.poolProvider],
            journey.poolVmTypes[0],
          ).kind === 'nvidia'))
  ) {
    throw new Error(
      'pool-job-upgrade needs a one-Node pool: an AWS, GCP or Azure pool of a CPU type, or gpu_pool with one replica',
    );
  }
  for (const check of [
    'cpu-defaults',
    'cpu-cold-start',
    'user-namespace',
  ] as const) {
    if (checks.includes(check) && journey.poolProvider === 'lambda') {
      throw new Error(
        `${check} needs an AWS, GCP or Azure pool: Lambda has no CPU types`,
      );
    }
  }
  // Their output Job takes a CPU share of the journey pool.
  if (
    checks.some((check) =>
      (ROLE_CHECKS as readonly string[]).includes(check),
    ) &&
    (!journey.hostedStage || journey.poolProvider === 'lambda')
  ) {
    throw new Error(
      'the role-connection checks run on hosted_stage with an AWS, GCP or Azure pool',
    );
  }
  if (
    checks.includes('pool-gpu-probe') &&
    journey.hostedStage &&
    journey.poolProvider !== 'lambda' &&
    !LIVE_CHECK_POOLS[journey.poolProvider].gpu
  ) {
    throw new Error(
      `pool-gpu-probe has no GPU pool type on the ${journey.poolProvider} CPU journey; use E2E_CLUSTER_GPU_POOL=true there`,
    );
  }
  return checks;
}

/** Management VM defaults per cloud (owner decision). */
const MANAGEMENT_VM: Record<CloudProvider, { region: string; vmType: string }> =
  {
    aws: { region: 'us-east-2', vmType: 't3.medium' },
    gcp: { region: 'us-central1', vmType: 'e2-standard-2' },
    azure: { region: 'westus2', vmType: 'Standard_D2s_v5' },
  };

function provider(name: string, value: string): CloudProvider {
  if (value !== 'aws' && value !== 'gcp' && value !== 'azure') {
    throw new Error(`${name} must be aws, gcp or azure, not ${value}`);
  }
  return value;
}

function poolProviderOf(value: string): PoolProvider {
  if (value === 'lambda') return value;
  if (value !== 'aws' && value !== 'gcp' && value !== 'azure') {
    throw new Error(
      `E2E_CLUSTER_POOL_PROVIDER must be aws, gcp, azure or lambda, not ${value}`,
    );
  }
  return value;
}

export function clusterCloudConfiguration(
  read: (name: string) => string,
): ClusterCloudConfiguration {
  const flag = (name: string) => read(name) === 'true';
  const clusterProvider = provider(
    'E2E_CLUSTER_PROVIDER',
    read('E2E_CLUSTER_PROVIDER') || 'aws',
  );
  const clusterRegion =
    read('E2E_CLUSTER_REGION') || MANAGEMENT_VM[clusterProvider].region;
  const poolProvider = poolProviderOf(
    read('E2E_CLUSTER_POOL_PROVIDER') || clusterProvider,
  );
  const gpuPool = flag('E2E_CLUSTER_GPU_POOL');
  const hostedStage = flag('E2E_CLUSTER_HOSTED_STAGE');
  const poolSpot = flag('E2E_CLUSTER_POOL_SPOT');
  const deadApiDelete = flag('E2E_CLUSTER_DEAD_API_DELETE');
  const restoreStage = flag('E2E_CLUSTER_RESTORE_STAGE');
  if (
    restoreStage &&
    (hostedStage ||
      gpuPool ||
      deadApiDelete ||
      read('E2E_CLUSTER_FROM_RELEASE'))
  ) {
    throw new Error(
      'E2E_CLUSTER_RESTORE_STAGE runs on the default journey only, without hosted_stage, gpu_pool, dead_api_delete or from_release',
    );
  }
  if (deadApiDelete && (hostedStage || gpuPool)) {
    throw new Error(
      'E2E_CLUSTER_DEAD_API_DELETE runs on the default journey only, without hosted_stage or gpu_pool',
    );
  }
  if (poolSpot && poolProvider === 'lambda') {
    throw new Error('E2E_CLUSTER_POOL_SPOT needs an AWS, GCP or Azure pool');
  }
  const gpuWorkload = read('E2E_CLUSTER_GPU_WORKLOAD') || 'mace';
  if (gpuWorkload !== 'mace' && gpuWorkload !== 'voice') {
    throw new Error(
      `E2E_CLUSTER_GPU_WORKLOAD must be mace or voice, not ${gpuWorkload}`,
    );
  }
  if (gpuWorkload !== 'mace' && !gpuPool) {
    throw new Error(
      "E2E_CLUSTER_GPU_WORKLOAD selects the GPU pool journey's workload; set E2E_CLUSTER_GPU_POOL=true",
    );
  }
  const replicaInput = read('E2E_CLUSTER_GPU_REPLICAS') || '1';
  if (
    !['1', '2'].includes(replicaInput) ||
    (replicaInput === '2' && (!gpuPool || gpuWorkload !== 'voice'))
  ) {
    throw new Error(
      'E2E_CLUSTER_GPU_REPLICAS must be 1, or 2 with the voice GPU pool journey',
    );
  }
  const gpuReplicas = replicaInput === '2' ? 2 : 1;
  const fromRelease = read('E2E_CLUSTER_FROM_RELEASE') || null;
  if (fromRelease && !hostedStage && !gpuPool) {
    throw new Error(
      'E2E_CLUSTER_FROM_RELEASE upgrades the hosted API; set E2E_CLUSTER_HOSTED_STAGE or E2E_CLUSTER_GPU_POOL=true',
    );
  }
  // GCP_GPU_QUOTA: the upgrade's surge Node or a second replica would be a second GPU.
  if ((fromRelease || gpuReplicas === 2) && gpuPool && poolProvider === 'gcp') {
    throw new Error(
      `${fromRelease ? 'E2E_CLUSTER_FROM_RELEASE' : 'E2E_CLUSTER_GPU_REPLICAS=2'} on a GCP GPU pool needs a second GPU; the GCP project allows ${String(GCP_GPU_QUOTA)}`,
    );
  }
  // A non-AWS cluster's pool is qualified on its own cloud only.
  if (clusterProvider !== 'aws' && poolProvider !== clusterProvider) {
    throw new Error(
      `E2E_CLUSTER_POOL_PROVIDER=${poolProvider} against a ${clusterProvider} cluster is not qualified; use its own cloud`,
    );
  }
  // Only the default journey is qualified on a management VM outside AWS.
  const journeys = [
    hostedStage && 'E2E_CLUSTER_HOSTED_STAGE',
    gpuPool && 'E2E_CLUSTER_GPU_POOL',
  ].filter(Boolean);
  if (clusterProvider !== 'aws' && journeys.length) {
    throw new Error(
      `E2E_CLUSTER_PROVIDER=${clusterProvider} runs only the default journey until ${journeys.join(' and ')} is qualified on it`,
    );
  }
  // A cross-cloud Azure pool is qualified on the hosted journeys only.
  if (
    clusterProvider === 'aws' &&
    poolProvider === 'azure' &&
    !gpuPool &&
    !hostedStage
  ) {
    throw new Error(
      'E2E_CLUSTER_POOL_PROVIDER=azure with an AWS cluster runs with E2E_CLUSTER_HOSTED_STAGE or E2E_CLUSTER_GPU_POOL=true',
    );
  }
  // A pool on the cluster's own cloud shares its region.
  const poolDefaults: Record<PoolProvider, PoolDefault> = {
    aws: {
      region: clusterRegion, // an AWS pool runs only under an AWS cluster
      vmTypes: [gpuPool ? 'g4dn.xlarge' : 't3.small'],
    },
    // A GPU pool takes e2e-gpu's GCP L4 leg's type and region.
    gcp: {
      region:
        clusterProvider === 'gcp'
          ? clusterRegion
          : gpuPool
            ? 'us-east4'
            : 'us-central1',
      vmTypes: [gpuPool ? 'g2-standard-4' : 'e2-standard-2'],
    },
    // e2e-gpu's Azure region, and its NC-series T4 type for the GPU journey.
    azure: {
      region: clusterProvider === 'azure' ? clusterRegion : 'westus2',
      vmTypes: [gpuPool ? 'Standard_NC4as_T4_v3' : 'Standard_D2s_v5'],
    },
    // Unpinned, so a region without Lambda capacity is skipped. Both stages
    // rotate the VM legs' 1-GPU types (owner: "GPU list for Lambda leg"; the
    // hosted stage too, option b, as cpu_4x_general had no capacity).
    lambda: {
      region: null,
      vmTypes: ['gpu_1x_a10', 'gpu_1x_a100_sxm4'],
    },
  };
  const poolVmTypes = read('E2E_CLUSTER_POOL_VM_TYPE')
    ? [read('E2E_CLUSTER_POOL_VM_TYPE')]
    : poolDefaults[poolProvider].vmTypes;
  const liveChecks = liveChecksOf(read('E2E_CLUSTER_LIVE_CHECKS'), {
    hostedStage,
    gpuPool,
    fromRelease,
    poolProvider,
    gpuReplicas,
    poolVmTypes,
  });
  const userNamespaceImages = liveChecks.includes('user-namespace')
    ? read('E2E_USER_NAMESPACE_IMAGES').split(' ').filter(Boolean)
    : [];
  if (
    liveChecks.includes('user-namespace') &&
    userNamespaceImages.length !== 3
  ) {
    throw new Error(
      'user-namespace needs E2E_USER_NAMESPACE_IMAGES, which e2e.sh pushes with the API image',
    );
  }
  return {
    liveChecks,
    userNamespaceImages,
    clusterProvider,
    clusterRegion,
    managementVmType:
      read('E2E_CLUSTER_MANAGEMENT_VM_TYPE') ||
      MANAGEMENT_VM[clusterProvider].vmType,
    poolProvider,
    poolRegion:
      read('E2E_CLUSTER_POOL_REGION') || poolDefaults[poolProvider].region,
    poolVmTypes,
    poolSpot,
    deadApiDelete,
    restoreStage,
    gpuPool,
    hostedStage,
    gpuWorkload,
    gpuReplicas,
    fromRelease,
  };
}

/**
 * The role-connection checks' bounds. A trust change reaches GCP IAM in about
 * 1.5 minutes and Azure RBAC in up to 10; a retired key was refused
 * within 60 s on AWS and at once on Azure (C26, run 41957954716). GCP's
 * refusal is recorded unless `E2E_ROLE_GCP_RETIRE=assert` (owner,
 * 2026-11-06: recorded).
 */
export function roleCheckPolicy(
  runId: string,
  gcpRetire: string,
): RoleCheckPolicy {
  if (gcpRetire !== 'record' && gcpRetire !== 'assert') {
    throw new Error(
      `E2E_ROLE_GCP_RETIRE is ${JSON.stringify(gcpRetire)}; choose record or assert`,
    );
  }
  return {
    runId,
    propagationMs: 15 * 60_000,
    retiredRefusalMs: { aws: 5 * 60_000, azure: 2 * 60_000 },
    gcpRetire,
    gcpRetireWindowMs: 20 * 60_000,
  };
}
