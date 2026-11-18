/**
 * Launch targets for the VM owners, VM Jobs and node pools (RFC 0044 layer 9):
 * catalog candidates, the provider's preflight, denied-region filtering, the
 * picker over the owner's launch-failure history, and the classification a
 * failed launch records.
 *
 * Failures are read from the owner's own history, oldest first. The
 * least-tried target wins; ties go to the target that failed least recently,
 * then to catalog order, so retries rotate without sharing failure state
 * between owners or relying on time gates.
 */

import {
  CloudFailureDiagnosis,
  type CloudConfig,
  type CloudType,
} from '../../shared/cloud.js';
import {
  getRegionsForVMType,
  getZonesForVMType,
} from '../../shared/cloud-config.js';
import { accountRegionalSpotQuotaPoolKey } from '../../shared/quota-groups.js';
import {
  formatExhaustedCandidateFilterMessage,
  usesAvailabilityZoneTargets,
} from '../../shared/providers.js';
import {
  CandidateEligibilityExhaustedError,
  candidateRegionKey,
  canFilterCandidateRegions,
  type CandidateRegionFilterOptions,
  type CloudCompute,
} from './gateways/cloud.js';
import {
  classifyComputeFailure,
  FailureDisposition,
  launchFailureDisposition,
  type LaunchFailure,
  type ProvisioningFailure,
  type StepFailureClassification,
} from './provisioning-failure.js';
import { permissionDeniedMessage } from '../../shared/permission-denied.js';
import { markCredentialOnAuthFailure } from './credential-auth-failure.js';
import { PartialVMCreationError, VMCreationError } from './codes.js';
import { log } from './logger.js';

export interface TargetCandidate {
  vmType: string;
  region: string;
  availabilityZone?: string;
}

/** An owner's immutable placement pins. */
interface TargetPin {
  region?: string | null;
  availabilityZone?: string | null;
  /** A pinned region still has the owner's other VM types to fail over to. */
  otherVmTypes?: boolean;
}

/** Candidates left after a filter, or why none are. */
export type CandidateFilterResult =
  | { candidates: TargetCandidate[]; verifiedKeys?: ReadonlySet<string> }
  | { invalid: string };

/**
 * Pick the best candidate for one owner: verified live capacity first,
 * then least-tried, then least recently failed, then catalog order.
 *
 * Catalog order decides before any failure. After a complete pass, the target
 * whose last failure is oldest goes next, so a preempted Job returns to the
 * region that last had capacity before regions that just reported none.
 *
 * verifiedKeys only carries weight when a provider actually reported live
 * capacity. An empty or absent set means "no signal", not "nothing available",
 * and leaves selection exactly as it was, without the class tier. Without it,
 * least-tried outranks known-available as soon as a region has been tried
 * once, so a starved workload walks regions the provider already reported
 * empty while ignoring the one that has capacity.
 */
export function pickTarget(
  candidates: TargetCandidate[],
  priorFailures: readonly ProvisioningFailure[] = [],
  cloudProvider?: CloudType,
  spot = false,
  verifiedKeys?: ReadonlySet<string>,
): TargetCandidate {
  const preferVerified = verifiedKeys !== undefined && verifiedKeys.size > 0;
  const isVerified = (candidate: TargetCandidate): boolean =>
    preferVerified && verifiedKeys!.has(candidateRegionKey(candidate));

  let target = candidates[0]!;
  let targetVerified = isVerified(target);
  let best = targetFailures(target, priorFailures, cloudProvider, spot);
  for (const candidate of candidates.slice(1)) {
    const verified = isVerified(candidate);
    const failures = targetFailures(
      candidate,
      priorFailures,
      cloudProvider,
      spot,
    );
    if (verified !== targetVerified) {
      // Class dominates: an unverified candidate never displaces a verified
      // target no matter how much less it has been tried.
      if (!verified) continue;
    } else if (
      failures.count > best.count ||
      (failures.count === best.count && failures.last >= best.last)
    ) {
      continue;
    }
    target = candidate;
    targetVerified = verified;
    best = failures;
  }
  return target;
}

/**
 * Candidates besides the picked target that no prior failure applies to, in
 * the class pickTarget keeps to (verified, when the target is): a failover
 * from the picked target goes straight to one of them. Untried is per target;
 * another target's refusal in the same region doesn't count.
 */
export function untriedTargetCount(
  candidates: readonly TargetCandidate[],
  target: TargetCandidate,
  priorFailures: readonly ProvisioningFailure[],
  cloudProvider: CloudType,
  spot: boolean,
  verifiedKeys?: ReadonlySet<string>,
): number {
  const verified = (candidate: TargetCandidate) =>
    verifiedKeys?.has(candidateRegionKey(candidate)) ?? false;
  return candidates.filter(
    (candidate) =>
      candidate !== target &&
      (!verified(target) || verified(candidate)) &&
      targetFailures(candidate, priorFailures, cloudProvider, spot).count === 0,
  ).length;
}

/** How often a target failed, and the history index of its latest failure. */
function targetFailures(
  candidate: TargetCandidate,
  failures: readonly ProvisioningFailure[],
  cloudProvider: CloudType | undefined,
  spot: boolean,
): { count: number; last: number } {
  let count = 0;
  let last = -1;
  failures.forEach((failure, index) => {
    if (!failureAppliesToTarget(failure, candidate, cloudProvider, spot))
      return;
    count++;
    last = index;
  });
  return { count, last };
}

function failureAppliesToTarget(
  failure: ProvisioningFailure,
  candidate: TargetCandidate,
  cloudProvider: CloudType | undefined,
  spot: boolean,
): boolean {
  // A classified retry-same-target failure must not rotate the workload's
  // SKU/region list. Unclassified VM-ledger entries predate the disposition
  // field and retain exact-target rotation.
  if (
    failure.disposition !== null &&
    failure.disposition !== FailureDisposition.FailoverTarget
  ) {
    return false;
  }

  if (
    failure.diagnosis ===
      CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted &&
    failure.disposition === FailureDisposition.FailoverTarget
  ) {
    if (failure.region !== candidate.region) return false;
    if (failure.spot !== null && failure.spot !== spot) return false;
    if (cloudProvider !== undefined) {
      return (
        accountRegionalSpotQuotaPoolKey(cloudProvider, failure.vmType) ===
        accountRegionalSpotQuotaPoolKey(cloudProvider, candidate.vmType)
      );
    }
  }

  // Regional quota is shared by every zone in the region. A failure on one
  // GCP zone therefore penalizes the same VM type in its sibling zones too,
  // allowing a region-unpinned workload to move regions immediately.
  if (
    failure.diagnosis === CloudFailureDiagnosis.QuotaExhaustedRegion &&
    failure.disposition === FailureDisposition.FailoverTarget
  ) {
    return (
      failure.vmType === candidate.vmType &&
      failure.region === candidate.region &&
      (failure.spot === null || failure.spot === spot)
    );
  }

  const sameRegionalTarget =
    failure.vmType === candidate.vmType && failure.region === candidate.region;
  if (!sameRegionalTarget) return false;

  // Failures written before zone-aware placement have no zone. Preserve their
  // historical region-level meaning instead of pretending they came from one
  // particular zone. New failures apply only to their exact placement.
  return (
    failure.availabilityZone == null ||
    failure.availabilityZone === candidate.availabilityZone
  );
}

/**
 * Interleave types by region rank: every type's first eligible region, in
 * request order, before any type's second. Stable, so each type keeps its own
 * order.
 */
export function byRegionRank(candidates: TargetCandidate[]): TargetCandidate[] {
  const regionsByType = new Map<string, Set<string>>();
  return candidates
    .map((candidate) => {
      const regions = regionsByType.get(candidate.vmType) ?? new Set<string>();
      regionsByType.set(candidate.vmType, regions.add(candidate.region));
      return { rank: regions.size - 1, candidate };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ candidate }) => candidate);
}

/**
 * Expand VM types into catalog candidates, region × zone on providers that
 * target zones. A region or zone pin keeps only the matching candidates.
 */
export function buildTargetCandidates(
  cloud: CloudType,
  vmTypes: readonly string[],
  spot: boolean | undefined,
  pin: TargetPin,
): TargetCandidate[] {
  const targetsAvailabilityZones = usesAvailabilityZoneTargets(cloud);
  const result: TargetCandidate[] = [];
  for (const vt of vmTypes) {
    const catalogRegions = getRegionsForVMType(vt, cloud, spot);
    const regions = pin.region
      ? catalogRegions.filter((r) => r === pin.region)
      : catalogRegions;
    for (const r of regions) {
      if (targetsAvailabilityZones) {
        const compatibleZones = getZonesForVMType(r, vt);
        const zones = pin.availabilityZone
          ? compatibleZones.filter((zone) => zone === pin.availabilityZone)
          : compatibleZones;
        for (const availabilityZone of zones) {
          result.push({ vmType: vt, region: r, availabilityZone });
        }
      } else {
        result.push({ vmType: vt, region: r });
      }
    }
  }
  return result;
}

/**
 * Drop targets the account can't use (e.g. AWS: not opted in, or vCPU quota
 * literally 0) through the provider's optional preflight, which owns the
 * deadline, snapshot cache, fail-open behavior, and verified-before-unknown
 * ordering. Providers without it keep every candidate. The gateway is built
 * from a resolved candidate: the probe only uses its credentials plus the
 * candidate list.
 */
export async function preflightTargetCandidates(
  candidates: TargetCandidate[],
  makeGateway: (
    vmType: string,
    region: string,
    availabilityZone?: string,
  ) => CloudCompute,
  owner: { id: string; cloud: CloudType; spot: boolean; vmLabel: string },
  options: CandidateRegionFilterOptions,
): Promise<CandidateFilterResult> {
  const probe = candidates[0]!;
  const gateway = makeGateway(
    probe.vmType,
    probe.region,
    probe.availabilityZone,
  );
  if (!canFilterCandidateRegions(gateway))
    return { candidates: byRegionRank(candidates) };
  let verifiedKeys: ReadonlySet<string> | undefined;
  try {
    const before = candidates.length;
    const classified = await gateway.classifyCandidateRegions(
      candidates,
      owner.spot,
      owner.id,
      options,
    );
    candidates = classified.ordered;
    // Rank on the verified class only where Verified means capacity exists
    // right now. On entitlement-based signals (region enabled, quota above
    // zero, machine type in the catalog) it would promote regions with no
    // correlation to whether a launch succeeds.
    if (gateway.providesLiveCapacitySignal) {
      verifiedKeys = new Set(classified.verified.map(candidateRegionKey));
    }
    log.info('Candidate availability filter completed', {
      id: owner.id,
      before,
      after: candidates.length,
      verified: verifiedKeys?.size ?? 0,
    });
  } catch (err) {
    if (err instanceof CandidateEligibilityExhaustedError) {
      return { invalid: err.message };
    }
    log.warn(
      'Candidate availability filter failed — proceeding with unfiltered candidates',
      { id: owner.id, error: err },
    );
  }
  if (candidates.length === 0) {
    return {
      invalid: formatExhaustedCandidateFilterMessage(
        owner.cloud,
        owner.vmLabel,
      ),
    };
  }
  return {
    candidates: byRegionRank(candidates),
    ...(verifiedKeys ? { verifiedKeys } : {}),
  };
}

/**
 * Drop every region where the provider denied this credential, for any VM
 * type, unless the region is pinned. Other owners keep their own history.
 */
export function withoutDeniedRegions(
  candidates: TargetCandidate[],
  failures: readonly ProvisioningFailure[],
  pinned: boolean,
  cloud: CloudType,
): CandidateFilterResult {
  const deniedRegions = new Map(
    failures.flatMap((failure) =>
      failure.regionDenied !== null &&
      failure.disposition === FailureDisposition.FailoverTarget
        ? [[failure.region, failure.regionDenied] as const]
        : [],
    ),
  );
  if (pinned || deniedRegions.size === 0) return { candidates };
  const allowed = candidates.filter(
    (candidate) => !deniedRegions.has(candidate.region),
  );
  if (allowed.length > 0) return { candidates: allowed };
  return {
    invalid: permissionDeniedMessage({
      cloud,
      action: [...deniedRegions.values()].at(-1) || null,
      where: `in any of the ${deniedRegions.size} regions offering the requested VM types`,
    }),
  };
}

/**
 * Classify a failed launch and route it by the owner's pins. A region denied
 * to an unpinned owner is a target it never retries (RFC 0047).
 */
export function classifyLaunchFailure(
  compute: CloudCompute,
  target: Pick<CloudConfig, 'cloudProvider' | 'region'>,
  error: unknown,
  pin: TargetPin,
): LaunchFailure & StepFailureClassification {
  const failure = classifyComputeFailure(
    { compute, cloudConfig: target },
    error,
    (diagnosis, regional) =>
      launchFailureDisposition(
        diagnosis,
        target.cloudProvider,
        pin.region,
        pin.availabilityZone,
        pin.otherVmTypes,
        regional,
      ),
  );
  const denied = failure.metadata?.targetRegionDenied;
  return {
    ...failure,
    regionDenied: typeof denied === 'string' ? denied : null,
  };
}

/**
 * Durably mark the launch credential on a terminal auth failure (a genuinely
 * invalid or expired secret), so cleanup and new launches stop using it until
 * it is fixed. Transient auth errors follow the ordinary retry policy.
 */
export async function markLaunchCredential(
  compute: CloudCompute,
  cloud: CloudType,
  credentialId: string,
  error: unknown,
): Promise<void> {
  // Launch wrappers keep the raw provider error the classifier needs.
  const classifiable =
    error instanceof VMCreationError || error instanceof PartialVMCreationError
      ? error.originalError
      : error;
  await markCredentialOnAuthFailure(
    compute.classifyError(classifiable),
    classifiable,
    compute,
    credentialId,
    cloud,
  );
}
