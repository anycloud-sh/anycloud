import {
  CloudFailureDiagnosis,
  type CloudConfig,
  type CloudType,
} from '../../shared/cloud.js';
import {
  PermissionDeniedError,
  permissionDeniedMessage,
} from '../../shared/permission-denied.js';
import { usesAvailabilityZoneTargets } from '../../shared/providers.js';
import type { CloudCompute } from './gateways/cloud.js';

export type FailureDisposition =
  | 'failover-target'
  | 'retry-same-target'
  | 'terminal-invalid'
  | 'terminal-failed';

export const FailureDisposition = {
  FailoverTarget: 'failover-target',
  RetrySameTarget: 'retry-same-target',
  TerminalInvalid: 'terminal-invalid',
  TerminalFailed: 'terminal-failed',
} as const satisfies Record<string, FailureDisposition>;

export interface StepFailureClassification {
  diagnosis: CloudFailureDiagnosis;
  disposition: FailureDisposition;
  metadata?: Record<string, unknown>;
}

/**
 * One failed provisioning attempt, scoped to the credential that made it.
 * Failure diagnosis and disposition retain the classifier's retry semantics;
 * null values come from unclassified VM-ledger rows: preemptions, and launches
 * that failed before classification was recorded.
 */
export interface ProvisioningFailure {
  credentialId: string | null;
  vmType: string;
  region: string;
  availabilityZone: string | null;
  diagnosis: CloudFailureDiagnosis | null;
  disposition: FailureDisposition | null;
  spot: boolean | null;
  /**
   * The action the credential may not perform in this region (empty when the
   * provider names none); null when the region was not denied.
   */
  regionDenied: string | null;
}

/** The classification a failed launch records on its VM-ledger row. */
export interface LaunchFailure {
  diagnosis: CloudFailureDiagnosis;
  /** The action denied in this region to an unpinned owner ('' if unnamed). */
  regionDenied: string | null;
}

function defaultFailureDisposition(
  diagnosis: CloudFailureDiagnosis,
): FailureDisposition {
  switch (diagnosis) {
    case CloudFailureDiagnosis.InvalidRequest:
    case CloudFailureDiagnosis.BadCredential:
    case CloudFailureDiagnosis.PermissionDenied:
      return FailureDisposition.TerminalInvalid;
    case CloudFailureDiagnosis.InvalidTarget:
    case CloudFailureDiagnosis.QuotaExhaustedRegion:
    case CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted:
    case CloudFailureDiagnosis.QuotaExhaustedAccount:
    case CloudFailureDiagnosis.CapacityExhausted:
    case CloudFailureDiagnosis.TemporaryProviderFailure:
    case CloudFailureDiagnosis.ProvisioningRejected:
      return FailureDisposition.RetrySameTarget;
    default:
      diagnosis satisfies never;
      return FailureDisposition.RetrySameTarget;
  }
}

export function classifyStepFailure(
  diagnosis: CloudFailureDiagnosis,
  disposition: FailureDisposition = defaultFailureDisposition(diagnosis),
  metadata?: Record<string, unknown>,
): StepFailureClassification {
  return { diagnosis, disposition, ...(metadata && { metadata }) };
}

export function resolveProvisioningFailureDisposition(
  diagnosis: CloudFailureDiagnosis,
  pinnedRegion: string | null | undefined,
  canFailoverWithinPinnedRegion = false,
  /** A permission denial another region may not share (RFC 0047). */
  regionalDenial = false,
): FailureDisposition {
  const pinned = !!pinnedRegion;
  switch (diagnosis) {
    case CloudFailureDiagnosis.PermissionDenied:
      return regionalDenial && !pinned
        ? FailureDisposition.FailoverTarget
        : FailureDisposition.TerminalInvalid;
    case CloudFailureDiagnosis.InvalidTarget:
      return pinned && !canFailoverWithinPinnedRegion
        ? FailureDisposition.TerminalInvalid
        : FailureDisposition.FailoverTarget;
    case CloudFailureDiagnosis.ProvisioningRejected:
      return pinned && !canFailoverWithinPinnedRegion
        ? FailureDisposition.RetrySameTarget
        : FailureDisposition.FailoverTarget;
    case CloudFailureDiagnosis.QuotaExhaustedRegion:
    case CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted:
      return pinned
        ? FailureDisposition.RetrySameTarget
        : FailureDisposition.FailoverTarget;
    case CloudFailureDiagnosis.CapacityExhausted:
      return pinned && !canFailoverWithinPinnedRegion
        ? FailureDisposition.RetrySameTarget
        : FailureDisposition.FailoverTarget;
    case CloudFailureDiagnosis.QuotaExhaustedAccount:
    case CloudFailureDiagnosis.TemporaryProviderFailure:
      return FailureDisposition.RetrySameTarget;
    case CloudFailureDiagnosis.InvalidRequest:
    case CloudFailureDiagnosis.BadCredential:
      return FailureDisposition.TerminalInvalid;
    default:
      diagnosis satisfies never;
      return FailureDisposition.RetrySameTarget;
  }
}

/**
 * The disposition of a launch failure for an owner with these immutable pins.
 * A zone-targeted provider can fail over between the zones of a pinned region
 * unless the zone is pinned too.
 */
export function launchFailureDisposition(
  diagnosis: CloudFailureDiagnosis,
  cloud: CloudType,
  pinnedRegion: string | null | undefined,
  pinnedZone: string | null | undefined,
  /** Other VM types remain in a pinned region the credential may use. */
  otherVmTypes = false,
  /** A permission denial another region may not share (RFC 0047). */
  regionalDenial = false,
): FailureDisposition {
  return resolveProvisioningFailureDisposition(
    diagnosis,
    pinnedRegion,
    (usesAvailabilityZoneTargets(cloud) && !!pinnedRegion && !pinnedZone) ||
      otherVmTypes,
    regionalDenial,
  );
}

/**
 * The provider's diagnosis of a deploy-step failure, with the step's
 * disposition. A terminal permission denial carries the reason the Workload
 * status shows: the denied action and region, and where to ask for it (RFC
 * 0047). A failover is automatic, so it carries only the denied region.
 */
export function classifyComputeFailure(
  {
    compute,
    cloudConfig: { cloudProvider, region },
  }: {
    compute: CloudCompute;
    cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'region'>;
  },
  error: unknown,
  dispose: (
    diagnosis: CloudFailureDiagnosis,
    regionalDenial: boolean,
  ) => FailureDisposition = defaultFailureDisposition,
): StepFailureClassification {
  if (error instanceof PermissionDeniedError)
    return classifyStepFailure(
      CloudFailureDiagnosis.PermissionDenied,
      FailureDisposition.TerminalInvalid,
      { message: permissionDeniedMessage(error) },
    );
  const diagnosis = compute.classifyError(error);
  if (diagnosis !== CloudFailureDiagnosis.PermissionDenied)
    return classifyStepFailure(diagnosis, dispose(diagnosis, false));
  const denial = compute.permissionDenial?.(error);
  const disposition = dispose(diagnosis, denial?.regional ?? false);
  const action = denial?.action ?? null;
  return classifyStepFailure(
    diagnosis,
    disposition,
    disposition === FailureDisposition.FailoverTarget
      ? { targetRegionDenied: action ?? '' }
      : {
          message: permissionDeniedMessage({
            cloud: cloudProvider,
            region,
            action,
          }),
        },
  );
}
