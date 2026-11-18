import type { RoleCheckPolicy } from '../../contracts/role-connections.js';
import { LIVE_CHECKS, type LiveCheck } from '../../contracts/cluster-cloud.js';

/**
 * The live cluster member's dispatch inputs, resolved and validated before any
 * cloud resource is admitted: where the management VM lives (`cluster_provider`)
 * and the VM type of the hosted API's VM Services and Jobs (`vm_type`).
 */

export type CloudProvider = 'aws' | 'gcp' | 'azure';

export interface ClusterCloudConfiguration {
  /** The cloud `cluster create` uses for the management VM and its checkpoint bucket. */
  readonly clusterProvider: CloudProvider;
  readonly clusterRegion: string;
  readonly managementVmType: string;
  /** The hosted stage's VM Service and recursive VM Jobs, on the cluster's cloud and region. */
  readonly vmType: string;
  /** The default journey deletes the cluster as from a second machine, with its API gone (`dead_api_delete`). */
  readonly deadApiDelete: boolean;
  /** The default journey restores from the kept bucket, then deletes it (`restore_stage`). */
  readonly restoreStage: boolean;
  readonly hostedStage: boolean;
  /** The published release the hosted stage bootstraps and upgrades from (`from_release`). */
  readonly fromRelease: string | null;
  /** `live_checks`, each refused up front where the dispatch can't run it. */
  readonly liveChecks: readonly LiveCheck[];
}

function liveChecksOf(
  value: string,
  hostedStage: boolean,
): readonly LiveCheck[] {
  const names = value.split(/[\s,]+/u).filter(Boolean);
  const unknown = names.filter(
    (name) => !(LIVE_CHECKS as readonly string[]).includes(name),
  );
  if (unknown.length) {
    throw new Error(
      `E2E_CLUSTER_LIVE_CHECKS names unknown checks ${unknown.join(', ')}; choose from ${LIVE_CHECKS.join(', ')}`,
    );
  }
  const checks = LIVE_CHECKS.filter((check) => names.includes(check));
  if (checks.length && !hostedStage) {
    throw new Error(
      'E2E_CLUSTER_LIVE_CHECKS run on hosted_stage; set E2E_CLUSTER_HOSTED_STAGE=true',
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

/** The hosted stage's VM type per cloud, unless `vm_type` names one. */
const WORKLOAD_VM: Record<CloudProvider, string> = {
  aws: 't3.small',
  gcp: 'e2-standard-2',
  azure: 'Standard_D2s_v5',
};

function provider(name: string, value: string): CloudProvider {
  if (value !== 'aws' && value !== 'gcp' && value !== 'azure') {
    throw new Error(`${name} must be aws, gcp or azure, not ${value}`);
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
  const hostedStage = flag('E2E_CLUSTER_HOSTED_STAGE');
  const deadApiDelete = flag('E2E_CLUSTER_DEAD_API_DELETE');
  const restoreStage = flag('E2E_CLUSTER_RESTORE_STAGE');
  if (
    restoreStage &&
    (hostedStage || deadApiDelete || read('E2E_CLUSTER_FROM_RELEASE'))
  ) {
    throw new Error(
      'E2E_CLUSTER_RESTORE_STAGE runs on the default journey only, without hosted_stage, dead_api_delete or from_release',
    );
  }
  if (deadApiDelete && hostedStage) {
    throw new Error(
      'E2E_CLUSTER_DEAD_API_DELETE runs on the default journey only, without hosted_stage',
    );
  }
  const fromRelease = read('E2E_CLUSTER_FROM_RELEASE') || null;
  if (fromRelease && !hostedStage) {
    throw new Error(
      'E2E_CLUSTER_FROM_RELEASE upgrades the hosted API; set E2E_CLUSTER_HOSTED_STAGE=true',
    );
  }
  // Only the default journey is qualified on a management VM outside AWS:
  // the native sweep covers the hosted API's VMs by their owner tag on AWS.
  if (clusterProvider !== 'aws' && hostedStage) {
    throw new Error(
      `E2E_CLUSTER_PROVIDER=${clusterProvider} runs only the default journey until E2E_CLUSTER_HOSTED_STAGE is qualified on it`,
    );
  }
  return {
    liveChecks: liveChecksOf(read('E2E_CLUSTER_LIVE_CHECKS'), hostedStage),
    clusterProvider,
    clusterRegion,
    managementVmType:
      read('E2E_CLUSTER_MANAGEMENT_VM_TYPE') ||
      MANAGEMENT_VM[clusterProvider].vmType,
    vmType: read('E2E_CLUSTER_VM_TYPE') || WORKLOAD_VM[clusterProvider],
    deadApiDelete,
    restoreStage,
    hostedStage,
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
