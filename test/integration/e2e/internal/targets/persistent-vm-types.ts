import type { CloudType } from '../../../../../src/shared/cloud.js';

import type { TrackedWorkloadRef } from '../workloads.js';
import type { VmProvider } from '../profiles.js';

export type PersistentVmTarget = VmProvider | 'local-smolvm';

export type PublicVmTarget = Exclude<PersistentVmTarget, 'local-smolvm'>;

export type PublicVmCloudType =
  | CloudType.AWS
  | CloudType.Azure
  | CloudType.GCP
  | CloudType.Lambda;

export interface PersistentVmTargetProfile {
  readonly target: PersistentVmTarget;
  readonly provider: CloudType;
  readonly credentialName?: string;
}

export interface PersistentVmSubmission {
  readonly ref: TrackedWorkloadRef;
  readonly environmentMarker: string;
  readonly image: string;
  readonly secretName: string;
}

export interface PersistentVmRunningContext {
  readonly availabilityZone: string | null;
  readonly baseImageId: string;
  readonly cloudId: string;
  readonly ref: TrackedWorkloadRef;
  readonly region: string | null;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUsername: string;
}

export interface AwsRunningObservation {
  readonly kind: 'aws';
  readonly rootVolumeIops: number;
  readonly rootVolumeThroughput: number;
  readonly rootVolumeType: string;
}

export interface LocalSmolvmRunningObservation {
  readonly kind: 'local-smolvm';
  readonly machineCount: number;
  readonly machineName: string;
  readonly machineState: string;
  readonly portCount: number;
  readonly sshGuestPort: number;
  readonly sshHostPort: number;
}

export type PersistentVmRunningObservation =
  | AwsRunningObservation
  | LocalSmolvmRunningObservation;

export interface LocalSmolvmTerminatedObservation {
  readonly kind: 'local-smolvm';
  readonly remainingMachineCount: number;
}

export interface ProviderTerminatedObservation {
  readonly kind: 'provider-api';
  readonly outcome: 'inconclusive' | 'invalid' | 'present' | 'terminated';
  readonly provider: PublicVmCloudType;
}

export type PersistentVmTerminatedObservation =
  | LocalSmolvmTerminatedObservation
  | ProviderTerminatedObservation;

export type PersistentVmRunningObservationAttempt =
  | { readonly kind: 'not-required' }
  | {
      readonly kind: 'observed';
      readonly observation: PersistentVmRunningObservation;
    };

export interface PersistentVmTerminatedObservationAttempt {
  readonly kind: 'observed';
  readonly observation: PersistentVmTerminatedObservation;
}

export interface PersistentVmTargetTransport {
  deleteHost(context: PersistentVmRunningContext): Promise<void>;
  observeRunning(
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt>;
  observeTerminated(
    context: PersistentVmRunningContext,
    deadlineAt?: number,
  ): Promise<PersistentVmTerminatedObservationAttempt>;
}

export type ContractQualification = 'conclusive' | 'inconclusive';

export interface PersistentVmContractResult {
  readonly contract: 'persistent-vm';
  readonly qualification: ContractQualification;
  readonly target: PersistentVmTarget;
  readonly satisfied: true;
}

export interface PersistentVmHostLossContractResult {
  readonly contract: 'persistent-vm-host-loss';
  readonly qualification: 'conclusive';
  readonly target: PersistentVmTarget;
  readonly satisfied: true;
}
