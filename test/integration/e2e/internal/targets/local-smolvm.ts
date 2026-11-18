import { CloudType } from '../../../../../src/shared/cloud.js';

import type {
  PersistentVmRunningContext,
  PersistentVmRunningObservationAttempt,
  PersistentVmTargetProfile,
  PersistentVmTargetTransport,
  PersistentVmTerminatedObservationAttempt,
} from './persistent-vm-types.js';

export class LocalSmolvmPersistentVmAdapter {
  readonly profile: PersistentVmTargetProfile = {
    provider: CloudType.Local,
    target: 'local-smolvm',
  };
  readonly #transport: PersistentVmTargetTransport;

  constructor(transport: PersistentVmTargetTransport) {
    this.#transport = transport;
  }

  observeRunning(
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt> {
    return this.#transport.observeRunning(context);
  }

  observeTerminated(
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmTerminatedObservationAttempt> {
    return this.#transport.observeTerminated(context);
  }

  deleteHost(context: PersistentVmRunningContext): Promise<void> {
    return this.#transport.deleteHost(context);
  }
}
