import type { VmProvider } from '../profiles.js';
import type { LocalSmolvmPersistentVmAdapter } from './local-smolvm.js';
import type {
  PersistentVmRunningContext,
  PersistentVmRunningObservationAttempt,
  PersistentVmTarget,
  PersistentVmTargetProfile,
  PersistentVmTerminatedObservationAttempt,
} from './persistent-vm-types.js';
import { PublicCloudPersistentVmAdapter } from './public-cloud-vm.js';

interface PublicCloudTargetFactory {
  create(provider: VmProvider): PublicCloudPersistentVmAdapter;
}

function isPublicVmProvider(target: PersistentVmTarget): target is VmProvider {
  return target !== 'local-smolvm';
}

export class PersistentVmTargetFactory {
  readonly #localTarget: LocalSmolvmPersistentVmAdapter;
  readonly #publicTargets = new Map<
    VmProvider,
    PublicCloudPersistentVmAdapter
  >();
  readonly #targetFactory: PublicCloudTargetFactory;

  constructor(
    localTarget: LocalSmolvmPersistentVmAdapter,
    targetFactory: PublicCloudTargetFactory,
  ) {
    this.#localTarget = localTarget;
    this.#targetFactory = targetFactory;
  }

  profile(target: PersistentVmTarget): PersistentVmTargetProfile {
    return this.#target(target).profile;
  }

  observeRunning(
    target: PersistentVmTarget,
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt> {
    return this.#target(target).observeRunning(context);
  }

  observeTerminated(
    target: PersistentVmTarget,
    context: PersistentVmRunningContext,
    deadlineAt?: number,
  ): Promise<PersistentVmTerminatedObservationAttempt> {
    return this.#target(target).observeTerminated(context, deadlineAt);
  }

  deleteHost(
    target: PersistentVmTarget,
    context: PersistentVmRunningContext,
  ): Promise<void> {
    return this.#target(target).deleteHost(context);
  }

  #target(
    target: PersistentVmTarget,
  ): LocalSmolvmPersistentVmAdapter | PublicCloudPersistentVmAdapter {
    return isPublicVmProvider(target)
      ? this.#publicTarget(target)
      : this.#localTarget;
  }

  #publicTarget(provider: VmProvider): PublicCloudPersistentVmAdapter {
    const existing = this.#publicTargets.get(provider);
    if (existing) return existing;
    const target = this.#targetFactory.create(provider);
    this.#publicTargets.set(provider, target);
    return target;
  }
}
