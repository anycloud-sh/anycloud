import type { Environment } from '../environment.js';
import type {
  PublicVmCloudType,
  PersistentVmRunningObservation,
  PersistentVmTarget,
} from '../targets/persistent-vm-types.js';
import { CloudType } from '../../../../../src/shared/cloud.js';

export interface PersistentVmProbePolicy {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

/**
 * Which substrate observation a target owes while Running. The kind is typed
 * against the observation union, so a target cannot claim evidence no
 * observation shape exists for, and `null` states exactly that no such shape
 * exists for this target rather than that none is wanted.
 */
export interface PersistentVmRunningEvidence {
  readonly kind: PersistentVmRunningObservation['kind'];
}

const RUNNING_EVIDENCE = {
  aws: { kind: 'aws' },
  azure: null,
  gcp: null,
  lambda: null,
  'local-smolvm': { kind: 'local-smolvm' },
} as const satisfies Record<
  PersistentVmTarget,
  PersistentVmRunningEvidence | null
>;

/**
 * Which observation proves a target released its host. Every public cloud
 * answers a provider-direct query; the Local substrate answers for itself.
 * Carrying the provider here rather than in a parallel map keeps "is this
 * target public" and "which provider answers for it" a single fact.
 */
export type PersistentVmTerminatedEvidence =
  | { readonly kind: 'local-smolvm' }
  | { readonly kind: 'provider-api'; readonly provider: PublicVmCloudType };

const TERMINATED_EVIDENCE = {
  aws: { kind: 'provider-api', provider: CloudType.AWS },
  azure: { kind: 'provider-api', provider: CloudType.Azure },
  gcp: { kind: 'provider-api', provider: CloudType.GCP },
  lambda: { kind: 'provider-api', provider: CloudType.Lambda },
  'local-smolvm': { kind: 'local-smolvm' },
} as const satisfies Record<PersistentVmTarget, PersistentVmTerminatedEvidence>;

export function runningEvidence(
  target: PersistentVmTarget,
): PersistentVmRunningEvidence | null {
  return RUNNING_EVIDENCE[target];
}

export function terminatedEvidence(
  target: PersistentVmTarget,
): PersistentVmTerminatedEvidence {
  return TERMINATED_EVIDENCE[target];
}

export interface PersistentVmContractPolicy {
  readonly cleanupTimeoutMs: number;
  readonly hostLossFailureTimeoutMs: number;
  readonly hostReleaseTimeoutMs: number;
  readonly repairTimeoutMs: number;
  readonly runningTimeoutMs: number;
  /**
   * How long teardown may take, as opposed to cleanupTimeoutMs's ceiling on how
   * long the contract waits to observe it. An overrun is billed at the full VM
   * rate and holds the capacity the next run needs, so "cleaned up eventually"
   * is not the same as healthy.
   *
   * Measured from the workload's own completedAt to its cleanedAt rather than
   * wall clock, which is what makes it the same quantity across providers. That
   * span reaches past the VM to networking, DNS and storage teardown, so it is
   * stricter than the retired Lambda Bash leg's bound, which stopped at an
   * empty VM ledger.
   *
   * Absent means unasserted. Only Lambda opts in, as the retired Bash leg did:
   * Azure retries firewall and VNet deletion 180 x 10s each on the way to
   * cleanedAt, so a bound tight enough to catch a release regression there
   * would fail healthy runs instead.
   */
  readonly teardownMaxMs?: number;
  readonly terminatedObservation?: PersistentVmProbePolicy;
  readonly terminatedTimeoutMs: number;
}

export function persistentVmContractPolicy(
  environment: Pick<Environment, 'milliseconds'>,
  target: PersistentVmTarget,
): PersistentVmContractPolicy {
  const local = target === 'local-smolvm';
  return {
    cleanupTimeoutMs: environment.milliseconds(
      'VM_SMOKE_CLEANUP_TIMEOUT_SECONDS',
      local ? 180 : 2_700,
    ),
    hostLossFailureTimeoutMs: environment.milliseconds(
      'VM_HOST_LOSS_FAILURE_TIMEOUT_SECONDS',
      local ? 180 : 900,
    ),
    hostReleaseTimeoutMs: environment.milliseconds(
      'VM_SMOKE_HOST_RELEASE_TIMEOUT_SECONDS',
      local ? 60 : target === 'lambda' ? 600 : 120,
    ),
    repairTimeoutMs: environment.milliseconds(
      'VM_SMOKE_REPAIR_TIMEOUT_SECONDS',
      300,
    ),
    runningTimeoutMs: environment.milliseconds(
      'VM_SMOKE_RUNNING_TIMEOUT_SECONDS',
      local ? 300 : 1_200,
    ),
    ...(target === 'lambda'
      ? {
          teardownMaxMs: environment.milliseconds(
            'E2E_TEARDOWN_MAX_SECONDS',
            420,
          ),
        }
      : {}),
    // Every public VM host answers a provider-direct presence query. The
    // budgets differ because the provider decides how long a released host
    // lingers: an EC2 instance reports `terminated` immediately, while Azure
    // and GCP finish deleting the resource before it stops resolving.
    ...(TERMINATED_EVIDENCE[target].kind === 'local-smolvm'
      ? {}
      : {
          terminatedObservation: {
            intervalMs: 5_000,
            timeoutMs: environment.milliseconds(
              'VM_SMOKE_PROVIDER_TERMINATION_TIMEOUT_SECONDS',
              target === 'azure' || target === 'gcp' ? 300 : 60,
            ),
          },
        }),
    terminatedTimeoutMs: environment.milliseconds(
      'VM_SMOKE_TERMINATED_TIMEOUT_SECONDS',
      local ? 180 : 300,
    ),
  };
}
