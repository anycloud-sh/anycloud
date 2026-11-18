import type {
  WorkloadEvent,
  WorkloadStatusResponse,
  StatusWorkloadMetadata,
} from '../../shared/api-contract/workload-management-schemas.js';
import { CloudFailureDiagnosis, CloudType } from '../../shared/cloud.js';
import { WorkloadState } from '../../shared/workload.js';

/** Retry and quota guidance shared by `status` and `wait`. */

export const formatQuotaHint = (
  events: WorkloadEvent[],
  workload: StatusWorkloadMetadata,
): string | null => {
  // A quota-exhausted diagnosis only occurs on quota-capable clouds, so the
  // hint below is implicitly gated to them — no need to check capability here.
  const retryingEvents = events.filter(
    (event) => event.state === WorkloadState.Retrying,
  );
  const retryingDiagnoses = new Set(retryingEvents.map(eventDiagnosis));
  if (retryingDiagnoses.has(CloudFailureDiagnosis.QuotaExhaustedAccount)) {
    // cloudtype-boundary-ok: status presentation translates Lambda's
    // instance-count quota into accurate provider-specific recovery guidance.
    if (workload.cloudProvider === CloudType.Lambda) {
      return '→ Lambda account instance-launch limit reached. AnyCloud will retry; terminate another Lambda instance or contact Lambda support.';
    }
    // Account-wide vCPU quota (e.g. GCP CPUS_ALL_REGIONS) — not vmType-specific.
    return '→ Account-wide vCPU quota exhausted. Raise it (e.g. GCP CPUS_ALL_REGIONS) or free other VMs.';
  }
  const quotaEvent = [...retryingEvents]
    .reverse()
    .find((event) => REGIONAL_QUOTA_DIAGNOSES.has(eventDiagnosis(event)));
  if (!quotaEvent) return null;
  const eventRegion = quotaEvent.metadata?.targetRegion;
  const region =
    typeof eventRegion === 'string' && eventRegion
      ? eventRegion
      : workload.region;
  return `→ Run: anycloud quota status${region ? ` --region ${region}` : ''}${workload.spot ? ' --spot' : ''}`;
};

const REGIONAL_QUOTA_DIAGNOSES = new Set<unknown>([
  CloudFailureDiagnosis.QuotaExhaustedRegion,
  CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
]);

const RETRY_CAUSES = new Map<unknown, (spot: boolean) => string>([
  [
    CloudFailureDiagnosis.CapacityExhausted,
    (spot) => `${spot ? 'Spot capacity' : 'Capacity'} unavailable`,
  ],
  [
    CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
    () => 'Spot quota exhausted',
  ],
  [
    CloudFailureDiagnosis.QuotaExhaustedRegion,
    () => 'Regional quota exhausted',
  ],
  [
    CloudFailureDiagnosis.QuotaExhaustedAccount,
    () => 'Account quota exhausted',
  ],
]);

function eventDiagnosis(event: WorkloadEvent): unknown {
  return event.metadata?.diagnosis ?? event.metadata?.errorKind;
}

/** `HH:MM` in UTC, matching the event log's timestamps. */
function utcMinutes(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

/** The provider cause and target the latest retry recorded, when it is capacity or quota. */
export function retryCause(
  events: WorkloadEvent[],
  workload: StatusWorkloadMetadata,
): { diagnosis: string; label: string; target: string[] } | undefined {
  const latest = [...events]
    .reverse()
    .find((event) => event.state === WorkloadState.Retrying);
  const diagnosis = latest && eventDiagnosis(latest);
  const cause = RETRY_CAUSES.get(diagnosis);
  if (!latest || !cause || typeof diagnosis !== 'string') return undefined;
  const metadata = latest.metadata ?? {};
  return {
    diagnosis,
    label: cause(metadata.targetSpot === true || workload.spot === true),
    target: [
      metadata.targetVmType,
      metadata.targetAvailabilityZone ?? metadata.targetRegion,
    ].filter((part): part is string => typeof part === 'string' && part !== ''),
  };
}

/** `next HH:MM–HH:MM` (UTC), or `retry due now` once the window has passed. */
export function retryWhen(
  retry: NonNullable<WorkloadStatusResponse['retry']>,
  now: number,
): string {
  return now > retry.latestAt
    ? 'retry due now'
    : `next ${utcMinutes(retry.earliestAt)}–${utcMinutes(retry.latestAt)}`;
}

/** While Retrying: the attempt, when the next attempt is due, and its cause. */
export const formatRetryHint = (
  events: WorkloadEvent[],
  workload: StatusWorkloadMetadata,
  retry: WorkloadStatusResponse['retry'],
  now = Date.now(),
): string | null => {
  if (workload.state !== WorkloadState.Retrying || !retry) return null;
  const cause = retryCause(events, workload);
  const reason = cause
    ? `: ${cause.label}${cause.target.length > 0 ? ` (${cause.target.join(', ')})` : ''}`
    : '';
  return `→ Attempt ${retry.attempt}, ${retryWhen(retry, now)}${reason}. Automatic.`;
};

// Format events with error lines using box drawing
