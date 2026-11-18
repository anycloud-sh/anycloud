import type { PersistedError } from '../../shared/log-diagnostics.js';
import { redactValue } from './redact.js';
import { CloudFailureDiagnosis } from '../../shared/cloud.js';

/**
 * The Retrying diagnosis of a GPU Job whose GPU passed its probe: the Job reruns
 * once in a new container on the same VM.
 */
export const GPU_RERUN_DIAGNOSIS = 'gpu-rerun-in-place';

/** An Error must be serialized by the caller before it can be persisted. */
export interface WorkloadEventMetadataInput {
  error?: PersistedError | string;
  [key: string]: unknown;
}

/**
 * Redaction has one home so no workload-event writer can forget it. Two once
 * did, and the second survived review because the check matched the shape the
 * others used rather than enumerating writers.
 */
export function eventMetadataColumn(
  metadata: WorkloadEventMetadataInput | null | undefined,
): string | null {
  if (metadata === null || metadata === undefined) return null;
  return JSON.stringify(redactValue(metadata));
}

/** Decode stored workload-event metadata without exposing persistence damage. */
export function decodeWorkloadEventMetadata(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const RETRY_WAIT_REASONS: Readonly<Record<string, string>> = {
  [CloudFailureDiagnosis.CapacityExhausted]: 'waiting for capacity',
  [CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted]:
    'waiting for quota',
  [CloudFailureDiagnosis.QuotaExhaustedRegion]: 'waiting for quota',
  [CloudFailureDiagnosis.QuotaExhaustedAccount]: 'waiting for quota',
};

/** A list row's reason: the latest event's message, or why its retry waits. */
export function latestEventMessage(
  raw: string | null | undefined,
): string | null {
  const parsed = decodeWorkloadEventMetadata(raw);
  if (typeof parsed?.message === 'string') return parsed.message;
  const diagnosis = parsed?.diagnosis ?? parsed?.errorKind;
  return (
    (typeof diagnosis === 'string' && RETRY_WAIT_REASONS[diagnosis]) || null
  );
}
