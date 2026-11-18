import type { TrackedWorkloadRef } from '../workloads.js';
import type { VmProvider } from '../profiles.js';

export type { VmProvider };

export interface PublicCloudServeTarget {
  readonly kind: 'public-cloud';
  readonly provider: VmProvider;
}

/** Local publishes no ingress, so its endpoint is a forwarded guest port. */
export interface LocalSmolvmServeTarget {
  readonly kind: 'local-smolvm';
}

export type ServeTarget = LocalSmolvmServeTarget | PublicCloudServeTarget;

/**
 * The placement facts a public-cloud Serve adapter may put on the wire. It
 * deliberately carries no credential material: the adapter names a stored
 * credential, and the composition root owns the secret behind that name.
 */
export interface PublicCloudServeProfile {
  readonly credentialName: string;
  readonly diskSizeGb?: number;
  readonly provider: VmProvider;
  readonly region?: string;
  readonly vmTypes: readonly string[];
  readonly gpus?: 'all';
  readonly runtime?: 'nvidia';
}

export interface ServeSubmission {
  readonly target: ServeTarget;
  readonly image: string;
  readonly command?: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentFile?: string;
  readonly secretNames?: readonly string[];
  readonly checkpointBucket?: string;
  readonly checkpointStorageRegion?: string;
}

export interface ServeSubmissionAcceptance {
  readonly id: string;
}

/**
 * The exact ledger-derived identity of one backing VM host. The contract
 * records these while the Service is ready so termination can prove every host
 * it actually paid for is gone, not merely that the ledger stopped listing it.
 */
export interface ServeBackingHost {
  readonly availabilityZone: string | null;
  readonly cloudId: string;
  readonly region: string | null;
}

/** A Service's public endpoint is derived from its ID, never discovered. */
export function publicServeUrl(workloadId: string): string {
  return `https://${workloadId}.anycloud.sh`;
}

export interface PublicCloudServeReadyObservation {
  readonly kind: 'public-cloud';
  readonly error?: string;
  readonly provider: VmProvider;
  readonly responseBody: string;
  readonly statusCode: number;
  readonly url: string;
}

export interface LocalSmolvmServeReadyObservation {
  readonly kind: 'local-smolvm';
  readonly guestContainerId: string;
  readonly httpHostPort: number;
  readonly machineCount: number;
  readonly machineName: string;
  readonly machineState: string;
  readonly responseBody: string;
  readonly sshHostPort: number;
}

export type ServeReadyObservation =
  | LocalSmolvmServeReadyObservation
  | PublicCloudServeReadyObservation;

export type ServeReadyObservationAttempt =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'observed';
      readonly observation: ServeReadyObservation;
    };

/** `unknown` never satisfies absence; only an answered `absent` does. */
export interface ServeHostAbsence {
  readonly cloudId: string;
  readonly diagnostic: string;
  readonly presence: 'absent' | 'present' | 'unknown';
}

export interface PublicCloudServeAbsenceObservation {
  readonly kind: 'public-cloud';
  readonly dns: ServeDnsAbsenceObservation;
  readonly hosts: readonly ServeHostAbsence[];
  readonly provider: VmProvider;
}

/** Every delegated nameserver must answer for this exact Service hostname. */
export interface ServeDnsAbsenceObservation {
  readonly hostname: string;
  readonly authorities: readonly string[];
  readonly answers: readonly {
    readonly authority: string;
    readonly address: string;
    readonly diagnostic: string;
    readonly presence: 'absent' | 'present' | 'unknown';
  }[];
}

export interface LocalSmolvmServeAbsenceObservation {
  readonly kind: 'local-smolvm';
  readonly hosts: readonly ServeHostAbsence[];
  /** Every host port the contract saw forwarded, and whether it still listens. */
  readonly openForwardedPorts: readonly number[];
}

export type ServeAbsenceObservation =
  | LocalSmolvmServeAbsenceObservation
  | PublicCloudServeAbsenceObservation;

export type ServeAbsenceObservationAttempt =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'observed';
      readonly observation: ServeAbsenceObservation;
    };

export interface ServeEndpointProbe {
  /** Why no HTTP answer reached the probe; set only with status 0. */
  readonly error?: string;
  readonly responseBody: string;
  readonly statusCode: number;
}

/**
 * The narrow provider surface a public-cloud Serve adapter is given. Each
 * method performs one operation and owns no lifecycle policy, deadline, or
 * cleanup.
 */
export interface PublicCloudServeTargetTransport {
  ensureCredential(): Promise<void>;
  observeEndpoint(url: string): Promise<ServeEndpointProbe>;
  observeHosts(
    hosts: readonly ServeBackingHost[],
    deadlineAt?: number,
  ): Promise<readonly ServeHostAbsence[]>;
  observeDns(
    hostname: string,
    deadlineAt?: number,
  ): Promise<ServeDnsAbsenceObservation>;
}

/**
 * The two facts the Local substrate owns. Declared here so the adapter depends
 * on the capability rather than on the module that implements it.
 */
export interface LocalSmolvmServeTargetTransport {
  observeReady(workloadId: string): Promise<LocalSmolvmServeReadyObservation>;
  observeAbsent(
    workloadId: string,
    hosts: readonly ServeBackingHost[],
    forwardedPorts: readonly number[],
    deadlineAt?: number,
  ): Promise<LocalSmolvmServeAbsenceObservation>;
}

export interface ServeTargetAdapter {
  readonly profile: PublicCloudServeProfile | { readonly kind: 'local-smolvm' };
  submit(
    ref: TrackedWorkloadRef,
    submission: ServeSubmission,
  ): Promise<ServeSubmissionAcceptance>;
  observeReady(
    ref: TrackedWorkloadRef,
    target: ServeTarget,
  ): Promise<ServeReadyObservationAttempt>;
  observeAbsent(
    ref: TrackedWorkloadRef,
    target: ServeTarget,
    hosts: readonly ServeBackingHost[],
    deadlineAt?: number,
  ): Promise<ServeAbsenceObservationAttempt>;
}

/** Upgrade is a named extension, so only its members implement it. */
export interface ServeUpgradeTargetAdapter extends ServeTargetAdapter {
  upgrade(ref: TrackedWorkloadRef, submission: ServeSubmission): Promise<void>;
}

export interface ServeContractResult {
  readonly contract: 'serve';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: VmProvider;
}

export interface GpuServeContractResult {
  readonly contract: 'gpu-serve';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: VmProvider;
}

export interface ServeLocalRecoveryContractResult {
  readonly contract: 'serve-local-recovery';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: 'local-smolvm';
}

export interface ServeUpgradeContractResult {
  readonly contract: 'serve-upgrade';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: VmProvider;
}
