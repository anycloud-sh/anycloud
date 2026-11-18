import type {
  PersistentVmRunningContext,
  PersistentVmRunningObservationAttempt,
  PersistentVmTargetProfile,
  PersistentVmTargetTransport,
  PersistentVmTerminatedObservationAttempt,
} from './persistent-vm-types.js';

export class PublicCloudPersistentVmAdapter {
  readonly profile: PersistentVmTargetProfile;
  readonly #transport: PersistentVmTargetTransport;

  constructor(
    profile: PersistentVmTargetProfile,
    transport: PersistentVmTargetTransport,
  ) {
    this.profile = profile;
    this.#transport = transport;
  }

  observeRunning(
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt> {
    return this.#transport.observeRunning(context);
  }

  observeTerminated(
    context: PersistentVmRunningContext,
    deadlineAt?: number,
  ): Promise<PersistentVmTerminatedObservationAttempt> {
    return this.#transport.observeTerminated(context, deadlineAt);
  }

  deleteHost(context: PersistentVmRunningContext): Promise<void> {
    return this.#transport.deleteHost(context);
  }
}
