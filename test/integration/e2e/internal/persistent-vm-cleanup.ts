import { CloudType, GpuRuntime } from '../../../../src/shared/cloud.js';
import { gpuRuntimeForVMType } from '../../../../src/shared/cloud-config.js';
import { ImageRuntime } from '../../../../src/shared/image.js';
import { LOCAL_SMOLVM_CONTRACT } from '../../../../src/api/services/gateways/local-smolvm-contract.js';
import { hashCredential } from '../../../../src/api/services/cloud-config.js';
import { cloudCredentialSchema } from '../../../../src/shared/api-contract/credentials-schemas.js';
import { WorkloadState } from '../../../../src/shared/workload.js';

import { declaredApiError } from './api.js';
import type { ArtifactStore } from './artifacts.js';
import type {
  ControllerEndpointSnapshot,
  ControllerEndpointSource,
} from './controller-session.js';
import { databaseInteger, escapedSql, type CliDatabase } from './database.js';
import type { ProviderProfiles, VmProfile } from './profiles.js';
import type { PersistentVmTarget } from './targets/persistent-vm-types.js';
import type {
  StatusResponse,
  WorkloadCreateBody,
  WorkloadCreateResponse,
} from './types.js';
import type { TargetHttpClient } from './transports/http.js';
import {
  observeLocalSmolvmHost,
  ownedSmolvmMachines,
} from './transports/local-smolvm.js';
import type {
  PublicCloudVmHostPresenceProbe,
  VmHostLocation,
  VmHostPresenceObservation,
  VmReservationPresenceObservation,
} from './transports/public-cloud-vm-host-presence.js';
import type { Waiter } from './wait.js';
import type {
  SubstrateAbsent,
  TrackedWorkloadKernel,
  TrackedWorkloadRef,
} from './workloads.js';

interface VmAttempt extends VmHostLocation {
  readonly rowId: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly ip: string | null;
  readonly vmType: string;
}

interface AdmissionScope {
  readonly workloadId: string;
  readonly endpoint: string;
  readonly provider: Exclude<CloudType, CloudType.Local>;
  readonly profileRowId: string;
  /** Live consumers bind an actual incarnation; retained Bash records omit it. */
  readonly controllerGeneration?: number;
}

interface AdmissionInventoryObservation extends AdmissionScope {
  readonly observedAt: number;
  readonly complete: boolean;
  readonly workloads: number;
  readonly vms: number;
}

interface AdmissionBaselineObservation extends AdmissionInventoryObservation {
  readonly credential: {
    readonly id: string;
    readonly name: string;
    readonly provider: CloudType;
  };
}

/** Sanitized observations, projected by the existing SDK and inventory owners. */
export interface AdmissionNonCreationEvidence {
  readonly original: AdmissionScope & {
    readonly credentialName: string;
    readonly materialHash: string;
  };
  readonly baseline: AdmissionBaselineObservation;
  /** Authorizes one request; it does not claim when a provider created anything. */
  readonly requestAuthorizedAt: number;
  readonly rejection: AdmissionScope & {
    readonly observedAt: number;
    readonly defined: boolean;
    readonly code: string | null;
    readonly status: number | null;
  };
  readonly afterRejection: AdmissionInventoryObservation;
  readonly recheck?: AdmissionInventoryObservation;
  readonly history: AdmissionScope & {
    readonly observedAt: number;
    readonly complete: boolean;
    readonly attempts: readonly unknown[];
    /** Includes a found Workload even if its native host list was empty. */
    readonly statusIdentities: readonly unknown[];
  };
  readonly evaluatedAt: number;
}

type AdmissionUnknownReason =
  | 'invalid-original-identity'
  | 'foreign-observation'
  | 'original-credential-mismatch'
  | 'undeclared-rejection'
  | 'incomplete-inventory'
  | 'nonempty-inventory'
  | 'incomplete-history'
  | 'contradictory-history'
  | 'invalid-observation-order';

type AdmissionNonCreationObservation =
  | { readonly kind: 'unknown'; readonly reason: AdmissionUnknownReason }
  | {
      readonly kind: 'rejection-observed' | 'proven-non-creation';
      readonly observedAt: number;
    };

function sameAdmissionScope(a: AdmissionScope, b: AdmissionScope): boolean {
  return (
    a.workloadId === b.workloadId &&
    a.endpoint === b.endpoint &&
    a.provider === b.provider &&
    a.profileRowId === b.profileRowId &&
    a.controllerGeneration === b.controllerGeneration
  );
}

function admissionInventoryProblem(
  original: AdmissionScope,
  inventory: AdmissionInventoryObservation,
): AdmissionUnknownReason | undefined {
  if (!sameAdmissionScope(original, inventory)) return 'foreign-observation';
  if (inventory.complete !== true) return 'incomplete-inventory';
  if (inventory.workloads !== 0 || inventory.vms !== 0)
    return 'nonempty-inventory';
}

function admissionBaselineProblem(
  original: AdmissionNonCreationEvidence['original'],
  baseline: AdmissionBaselineObservation,
): AdmissionUnknownReason | undefined {
  const problem = admissionInventoryProblem(original, baseline);
  if (problem) return problem;
  if (
    baseline.credential.id !== original.materialHash ||
    baseline.credential.id !== original.profileRowId ||
    baseline.credential.name !== original.credentialName ||
    baseline.credential.provider !== original.provider
  )
    return 'original-credential-mismatch';
}

function admissionOriginalProblem(
  original: AdmissionNonCreationEvidence['original'],
): AdmissionUnknownReason | undefined {
  let endpoint: URL;
  try {
    endpoint = new URL(original.endpoint);
  } catch {
    return 'invalid-original-identity';
  }
  if (
    !original.workloadId.trim() ||
    !original.credentialName.trim() ||
    ![CloudType.AWS, CloudType.GCP, CloudType.Azure, CloudType.Lambda].includes(
      original.provider,
    ) ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[a-f0-9]{64}$/u.test(original.materialHash) ||
    original.profileRowId !== original.materialHash ||
    (original.controllerGeneration !== undefined &&
      (!Number.isSafeInteger(original.controllerGeneration) ||
        original.controllerGeneration < 0))
  )
    return 'invalid-original-identity';
}

function orderedAdmissionTimes(values: readonly number[]): boolean {
  return values.every(
    (value, index) =>
      Number.isSafeInteger(value) &&
      value >= 0 &&
      (index === 0 || value >= values[index - 1]),
  );
}

/**
 * Delivery observation only. Callers retain the actual decoded response and
 * complete history; only the Workload kernel can release a cleanup obligation.
 * Live controller incarnation guards belong to the live owner, not these
 * persisted observations, which cannot invent an incarnation for Bash.
 */
export function evaluateAdmissionNonCreation(
  evidence: AdmissionNonCreationEvidence,
): AdmissionNonCreationObservation {
  const { original, baseline, rejection, afterRejection, recheck, history } =
    evidence;
  const originalProblem = admissionOriginalProblem(original);
  if (originalProblem) return { kind: 'unknown', reason: originalProblem };
  const baselineProblem = admissionBaselineProblem(original, baseline);
  if (baselineProblem) return { kind: 'unknown', reason: baselineProblem };
  if (
    !sameAdmissionScope(original, rejection) ||
    !sameAdmissionScope(original, history)
  )
    return { kind: 'unknown', reason: 'foreign-observation' };
  if (
    rejection.defined !== true ||
    rejection.code !== 'WORKLOAD_ADMISSION_REJECTED' ||
    rejection.status !== 400
  )
    return { kind: 'unknown', reason: 'undeclared-rejection' };
  for (const inventory of [afterRejection, ...(recheck ? [recheck] : [])]) {
    const problem = admissionInventoryProblem(original, inventory);
    if (problem) return { kind: 'unknown', reason: problem };
  }
  if (
    history.complete !== true ||
    !Array.isArray(history.attempts) ||
    !Array.isArray(history.statusIdentities)
  )
    return { kind: 'unknown', reason: 'incomplete-history' };
  if (history.attempts.length !== 0 || history.statusIdentities.length !== 0)
    return { kind: 'unknown', reason: 'contradictory-history' };
  const last = recheck ?? afterRejection;
  const ordered = [
    baseline.observedAt,
    evidence.requestAuthorizedAt,
    rejection.observedAt,
    afterRejection.observedAt,
    ...(recheck ? [recheck.observedAt] : []),
    evidence.evaluatedAt,
  ];
  if (
    !orderedAdmissionTimes(ordered) ||
    !Number.isSafeInteger(history.observedAt) ||
    history.observedAt < rejection.observedAt ||
    history.observedAt > last.observedAt ||
    (recheck && history.observedAt < afterRejection.observedAt)
  )
    return { kind: 'unknown', reason: 'invalid-observation-order' };
  return {
    kind: recheck ? 'proven-non-creation' : 'rejection-observed',
    observedAt: last.observedAt,
  };
}

interface AdmissionWorkloadHistory extends AdmissionScope {
  readonly observedAt: number;
  readonly complete: boolean;
  readonly workloads: readonly {
    readonly id: string;
    readonly credentialId: string;
    readonly provider: CloudType;
    readonly state: WorkloadState;
    readonly workloadType: string;
    readonly startedAt: number;
    readonly completedAt: number | null;
    readonly cleanedAt: number | null;
    readonly image: string | null;
    readonly imageRuntime: string | null;
    readonly vmType: string | null;
    readonly region: string | null;
  }[];
  readonly events: readonly {
    readonly id: number;
    readonly workloadId: string;
    readonly state: WorkloadState;
    readonly createdAt: number;
    /** Only the exact expected guard message is retained, never arbitrary metadata. */
    readonly guardMessage: string | null;
  }[];
  /** States retained from actual status reads, including before a later read fails. */
  readonly observedStates: readonly string[];
}

interface AdmissionInvalidEvidence {
  readonly original: AdmissionNonCreationEvidence['original'];
  readonly baseline: AdmissionNonCreationEvidence['baseline'];
  readonly requestAuthorizedAt: number;
  readonly request: AdmissionScope & {
    readonly observedAt: number;
    readonly image: string;
    readonly vmType: string;
    readonly vmRuntime: GpuRuntime;
    readonly region: string;
    readonly credentialName: string | null;
    readonly workloadType: string;
  };
  readonly acknowledgement: AdmissionScope & {
    readonly responseWorkloadId: string;
    readonly observedAt: number;
  };
  readonly afterInvalid: AdmissionInventoryObservation;
  readonly recheck?: AdmissionInventoryObservation;
  readonly history: AdmissionNonCreationEvidence['history'];
  readonly workloadHistory: AdmissionWorkloadHistory;
  readonly evaluatedAt: number;
}

export type PreProvisionAdmissionFailureObservation =
  | (AdmissionNonCreationEvidence & {
      readonly kind: 'rejected';
      readonly workloadHistory: AdmissionWorkloadHistory;
    })
  | (AdmissionInvalidEvidence & { readonly kind: 'invalid' });

function azureCudaGuardMessage(vmType: string): string {
  return `Image requires a CUDA GPU runtime but no compatible accelerator is available for VM type "${vmType}" on Azure`;
}

/** Validates observations only; the existing family/kernel still owns cleanup. */
export function assertPreProvisionAdmissionFailure(
  observation: PreProvisionAdmissionFailureObservation,
): void {
  const { original, workloadHistory } = observation;
  const invalid = (reason: string): never => {
    throw new Error(`Pre-provision admission remains unresolved: ${reason}`);
  };
  if (
    admissionOriginalProblem(original) ||
    original.controllerGeneration === undefined
  )
    invalid('original controller or credential identity');
  if (
    !sameAdmissionScope(original, workloadHistory) ||
    workloadHistory.complete !== true ||
    !Array.isArray(workloadHistory.workloads) ||
    !Array.isArray(workloadHistory.events) ||
    !Array.isArray(workloadHistory.observedStates)
  )
    invalid('Workload/event history is foreign or incomplete');
  const lastInventory =
    observation.recheck ??
    (observation.kind === 'rejected'
      ? observation.afterRejection
      : observation.afterInvalid);
  if (
    !orderedAdmissionTimes([
      observation.requestAuthorizedAt,
      workloadHistory.observedAt,
      lastInventory.observedAt,
      observation.evaluatedAt,
    ]) ||
    (observation.recheck &&
      workloadHistory.observedAt <
        (observation.kind === 'rejected'
          ? observation.afterRejection.observedAt
          : observation.afterInvalid.observedAt))
  )
    invalid('Workload/event history is stale');
  if (observation.kind === 'rejected') {
    const nonCreation = evaluateAdmissionNonCreation(observation);
    if (nonCreation.kind === 'unknown') invalid(nonCreation.reason);
    if (
      workloadHistory.workloads.length ||
      workloadHistory.events.length ||
      workloadHistory.observedStates.length
    )
      invalid('acknowledged rejection contradicts Workload/event history');
    return;
  }
  const {
    baseline,
    acknowledgement,
    afterInvalid,
    recheck,
    history,
    requestAuthorizedAt,
    request,
  } = observation;
  const baselineProblem = admissionBaselineProblem(original, baseline);
  if (baselineProblem) invalid(baselineProblem);
  if (
    !sameAdmissionScope(original, request) ||
    request.credentialName !== original.credentialName ||
    request.workloadType !== 'job' ||
    original.provider !== CloudType.Azure ||
    !/^\S+@sha256:[a-f0-9]{64}$/u.test(request.image) ||
    !request.region.trim() ||
    request.vmRuntime !== GpuRuntime.Rocm ||
    !orderedAdmissionTimes([request.observedAt, requestAuthorizedAt])
  )
    invalid('the accepted request is not the named Azure CUDA/runtime guard');
  if (
    !sameAdmissionScope(original, acknowledgement) ||
    acknowledgement.responseWorkloadId !== original.workloadId ||
    !sameAdmissionScope(original, history) ||
    history.complete !== true ||
    !Array.isArray(history.attempts) ||
    !Array.isArray(history.statusIdentities) ||
    history.attempts.length ||
    history.statusIdentities.length
  )
    invalid('create acknowledgement or retained native history');
  for (const inventory of [afterInvalid, ...(recheck ? [recheck] : [])]) {
    if (
      !sameAdmissionScope(original, inventory) ||
      inventory.complete !== true ||
      inventory.workloads !== 1 ||
      inventory.vms !== 0
    )
      invalid(
        'Invalid admission requires one original Workload and no VM rows',
      );
  }
  if (
    !orderedAdmissionTimes([
      baseline.observedAt,
      requestAuthorizedAt,
      acknowledgement.observedAt,
      afterInvalid.observedAt,
      ...(recheck ? [recheck.observedAt] : []),
      observation.evaluatedAt,
    ]) ||
    !orderedAdmissionTimes([
      acknowledgement.observedAt,
      history.observedAt,
      workloadHistory.observedAt,
    ]) ||
    (recheck && history.observedAt < afterInvalid.observedAt)
  )
    invalid('acknowledgement or native history is stale');
  const [workload] = workloadHistory.workloads;
  if (
    workloadHistory.workloads.length !== 1 ||
    !workload ||
    workload.id !== original.workloadId ||
    workload.credentialId !== original.profileRowId ||
    workload.provider !== original.provider ||
    workload.state !== WorkloadState.Invalid ||
    workload.workloadType !== request.workloadType ||
    workload.image !== request.image ||
    workload.imageRuntime !== ImageRuntime.Cuda ||
    workload.vmType !== request.vmType ||
    workload.region !== request.region ||
    workload.completedAt === null ||
    !orderedAdmissionTimes([
      requestAuthorizedAt,
      workload.startedAt,
      workload.completedAt,
      workloadHistory.observedAt,
    ]) ||
    (recheck &&
      (workload.cleanedAt === null ||
        !orderedAdmissionTimes([
          workload.completedAt,
          workload.cleanedAt,
          workloadHistory.observedAt,
        ])))
  )
    invalid('Invalid Workload identity, terminal outcome, or cleanup');
  const allowedStates: readonly string[] = [
    WorkloadState.Queued,
    WorkloadState.Invalid,
  ];
  if (
    workloadHistory.observedStates.some(
      (state) => !allowedStates.includes(state),
    )
  )
    invalid('an earlier status reached retry or runtime execution');
  const events = workloadHistory.events;
  const finalEvent = events.at(-1);
  if (
    // Dedicated admission stores Queued without emitting an initial event;
    // scheduler soft-block events may precede the exact terminal guard event.
    events.length === 0 ||
    finalEvent?.state !== WorkloadState.Invalid ||
    finalEvent?.createdAt !== workload.completedAt ||
    finalEvent.guardMessage !== azureCudaGuardMessage(request.vmType) ||
    events.some(
      (event, index) =>
        event.workloadId !== original.workloadId ||
        !Number.isSafeInteger(event.id) ||
        event.id < 1 ||
        (index > 0 && event.id <= events[index - 1].id) ||
        !allowedStates.includes(event.state) ||
        (index < events.length - 1 && event.state === WorkloadState.Invalid),
    ) ||
    !orderedAdmissionTimes([
      workload.startedAt,
      ...events.map((event) => event.createdAt),
      workloadHistory.observedAt,
    ])
  )
    invalid('Invalid event history is incomplete or reached retry/runtime');
}

function admissionUnknownMessage(reason: AdmissionUnknownReason): string {
  if (reason === 'undeclared-rejection')
    return 'VM non-creation requires a declared admission rejection';
  if (reason === 'nonempty-inventory')
    return 'VM rejected admission still has Workload or VM rows';
  if (reason === 'contradictory-history')
    return 'VM admission rejection contradicts its original identity history';
  return `VM admission non-creation remains unknown: ${reason}`;
}

interface LiveAdmissionObservation {
  readonly endpoint: ControllerEndpointSnapshot;
  readonly original: AdmissionNonCreationEvidence['original'];
  baseline: AdmissionBaselineObservation | undefined;
  requestAuthorizedAt: number | undefined;
  rejection: AdmissionNonCreationEvidence['rejection'] | undefined;
  afterRejection: AdmissionInventoryObservation | undefined;
  request: AdmissionInvalidEvidence['request'] | undefined;
  acknowledgement: AdmissionInvalidEvidence['acknowledgement'] | undefined;
  afterInvalid: AdmissionInventoryObservation | undefined;
  workloadHistory: AdmissionWorkloadHistory | undefined;
  readonly observedStates: Set<string>;
  historyObservedAt: number | undefined;
  historyIncomplete: boolean;
  statusWorkload:
    | { readonly workloadId: string; readonly observedAt: number }
    | undefined;
  controllerChanged: boolean;
}

interface OwnedVm {
  readonly target: PersistentVmTarget;
  readonly provider: CloudType;
  readonly profile: VmProfile | undefined;
  readonly native:
    | Pick<PublicCloudVmHostPresenceProbe, 'observe' | 'observeReservations'>
    | undefined;
  readonly attempts: Map<string, VmAttempt>;
  readonly statusLocations: Map<string, VmHostLocation>;
  latest: ReadonlyMap<number, VmAttempt>;
  credentialId: string | null | undefined;
  creationStarted: boolean;
  admissionObservation: LiveAdmissionObservation | undefined;
  admissionRejection:
    | {
        readonly code: 'WORKLOAD_ADMISSION_REJECTED';
        readonly status: 400;
        readonly observedAt: number;
        readonly workloads: 0;
        readonly vms: 0;
      }
    | undefined;
  authorizing: boolean;
  cleanup: Promise<SubstrateAbsent> | undefined;
  readonly verifyAdditional:
    | ((ref: TrackedWorkloadRef, deadlineAt: number) => Promise<void>)
    | undefined;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`VM cleanup ${label} is missing or invalid`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function admissionState(value: unknown): WorkloadState {
  const state = Object.values(WorkloadState).find((state) => state === value);
  if (!state) throw new Error('VM admission history contains an invalid state');
  return state;
}

function nativeKey(location: VmHostLocation): string {
  return JSON.stringify([
    location.cloudId,
    location.region,
    location.availabilityZone,
  ]);
}

/** Reservation tokens cannot be queried as provider resource IDs. */
function hasNativeCoordinates(
  provider: CloudType,
  attempt: VmAttempt,
): boolean {
  if (!attempt.region) return false;
  switch (provider) {
    case CloudType.AWS:
      return /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u.test(attempt.cloudId);
    case CloudType.Azure:
      return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(attempt.cloudId);
    case CloudType.GCP:
      return (
        /^[a-z][a-z0-9-]{0,62}$/u.test(attempt.cloudId) &&
        /^[a-z]$/u.test(attempt.availabilityZone ?? '')
      );
    case CloudType.Lambda:
      return /^[a-f0-9]{32}$/u.test(attempt.cloudId);
    // Storage-only: no Cloudflare VM is ever an attempt.
    case CloudType.Cloudflare:
      return false;
    case CloudType.Local:
      return (
        attempt.region === 'local' &&
        attempt.vmType === 'local' &&
        attempt.ip !== null &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(attempt.cloudId)
      );
  }
}

interface PersistentVmCleanupDependencies {
  readonly kernel: Pick<
    TrackedWorkloadKernel,
    | 'assertActive'
    | 'activeReference'
    | 'reserveWithCleanupVerification'
    | 'recordSubstrateAbsence'
  >;
  /** All I/O below uses teardown's independent cancellation scope. */
  readonly database: Pick<CliDatabase, 'queryComplete'>;
  readonly endpoint: ControllerEndpointSource;
  readonly profiles: Pick<ProviderProfiles, 'vm'>;
  readonly hosts: {
    create(
      profile: VmProfile,
    ): Pick<PublicCloudVmHostPresenceProbe, 'observe' | 'observeReservations'>;
  };
  readonly http: Pick<TargetHttpClient, 'get'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly signal: AbortSignal;
}

/**
 * Private native-capacity owner for VM and Service contracts. The Workload kernel
 * owns registration and release; existing transports own native observations.
 * This owner retains original coordinates and joins their cleanup evidence.
 */
export class PersistentVmCleanup {
  readonly #dependencies: PersistentVmCleanupDependencies;
  readonly #owned = new Map<TrackedWorkloadRef, OwnedVm>();

  constructor(dependencies: PersistentVmCleanupDependencies) {
    this.#dependencies = dependencies;
  }

  async reserve(
    target: PersistentVmTarget,
    id: string,
    cleanupTimeoutMs: number,
  ): Promise<TrackedWorkloadRef> {
    return this.#reserve(
      target,
      id,
      cleanupTimeoutMs,
      target === 'local-smolvm'
        ? undefined
        : this.#dependencies.profiles.vm(target),
    );
  }

  /**
   * Service capacity uses its selected CPU/GPU profile, not the VM smoke
   * profile. Its DNS/port proof joins the existing native verifier here, so
   * normal and fallback cleanup have the same before-creation registration.
   * This private composition capability is never exposed to a target or spec.
   */
  reserveWithProfile(
    target: PersistentVmTarget,
    id: string,
    cleanupTimeoutMs: number,
    profile: VmProfile | undefined,
    verifyAdditional: (
      ref: TrackedWorkloadRef,
      deadlineAt: number,
    ) => Promise<void>,
    controller?: Pick<ControllerEndpointSnapshot, 'url' | 'generation'>,
  ): Promise<TrackedWorkloadRef> {
    return this.#reserve(
      target,
      id,
      cleanupTimeoutMs,
      profile,
      verifyAdditional,
      controller,
    );
  }

  async #reserve(
    target: PersistentVmTarget,
    id: string,
    cleanupTimeoutMs: number,
    selectedProfile: VmProfile | undefined,
    verifyAdditional?: (
      ref: TrackedWorkloadRef,
      deadlineAt: number,
    ) => Promise<void>,
    controller?: Pick<ControllerEndpointSnapshot, 'url' | 'generation'>,
  ): Promise<TrackedWorkloadRef> {
    if (
      (target === 'local-smolvm') !== (selectedProfile === undefined) ||
      (selectedProfile && selectedProfile.slug !== target)
    )
      throw new Error('Native cleanup profile belongs to another target');
    const profile = selectedProfile && structuredClone(selectedProfile);
    const owned: OwnedVm = {
      target,
      provider: profile?.provider ?? CloudType.Local,
      profile,
      native: profile ? this.#dependencies.hosts.create(profile) : undefined,
      attempts: new Map(),
      statusLocations: new Map(),
      latest: new Map(),
      credentialId: profile ? undefined : null,
      creationStarted: false,
      admissionObservation: undefined,
      admissionRejection: undefined,
      authorizing: false,
      cleanup: undefined,
      verifyAdditional,
    };
    // Install the verifier before the reference can authorize any create.
    const ref = await this.#dependencies.kernel.reserveWithCleanupVerification(
      id,
      cleanupTimeoutMs,
      async (registered, timeoutMs) => {
        await this.#verifyOnce(registered, owned, timeoutMs);
      },
      controller,
    );
    this.#owned.set(ref, owned);
    return ref;
  }

  profile(ref: TrackedWorkloadRef): VmProfile {
    const profile = this.#require(ref).profile;
    if (!profile) throw new Error('Local VM cleanup has no cloud credential');
    return structuredClone(profile);
  }

  /** Also runs when API cleanup failed before it could call the native verifier. */
  async recordObservations(): Promise<void> {
    const failures: unknown[] = [];
    for (const [ref, owned] of this.#owned) {
      try {
        await this.#dependencies.artifacts.json(
          `vm-${ref.id}-native-identities`,
          {
            schemaVersion: 1,
            kind: 'persistent-vm-native-identities',
            workloadId: ref.id,
            target: owned.target,
            originalIdentity: {
              provider: owned.provider,
              profileRowId: owned.credentialId ?? null,
            },
            creationStarted: owned.creationStarted,
            admissionRejection: owned.admissionRejection ?? null,
            preProvisionAdmission: this.#retainedAdmission(owned),
            attemptHistory: [...owned.attempts.values()],
            statusIdentities: [...owned.statusLocations.values()],
            currentAttempts: [...owned.latest.values()],
            verificationStarted: owned.cleanup !== undefined,
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Retaining VM native identity observations failed',
      );
  }

  #retainedAdmission(owned: OwnedVm): unknown {
    const admission = owned.admissionObservation;
    if (!admission) return null;
    return {
      original: admission.original,
      baseline: admission.baseline ?? null,
      requestAuthorizedAt: admission.requestAuthorizedAt ?? null,
      request: admission.request ?? null,
      rejection: admission.rejection ?? null,
      acknowledgement: admission.acknowledgement ?? null,
      afterRejection: admission.afterRejection ?? null,
      afterInvalid: admission.afterInvalid ?? null,
      workloadHistory: admission.workloadHistory ?? null,
      observedStates: [...admission.observedStates],
      historyIncomplete: admission.historyIncomplete,
      controllerChanged: admission.controllerChanged,
    };
  }

  /** Called after saving the original credential and before the tracked create. */
  async creationStarted(
    ref: TrackedWorkloadRef,
    options?: {
      readonly observeAdmissionRejection: true;
      /** The actual single request, captured before sending the named Invalid case. */
      readonly invalidRequest?: WorkloadCreateBody;
    },
  ): Promise<void> {
    const owned = this.#require(ref);
    if (owned.creationStarted || owned.authorizing || owned.cleanup)
      throw new Error(`VM ${ref.id} creation or cleanup already started`);
    owned.authorizing = true;
    try {
      const deadlineAt = Date.now() + 60_000;
      if (options?.observeAdmissionRejection) {
        const endpoint = this.#dependencies.endpoint.snapshot();
        if (!endpoint || !owned.profile || owned.provider === CloudType.Local)
          throw new Error(
            'VM admission observation requires its original cloud controller',
          );
        const credential = cloudCredentialSchema.parse(
          owned.profile.credential,
        );
        if (credential.cloudProvider !== owned.provider)
          throw new Error('VM original credential provider is foreign');
        const materialHash = hashCredential(credential);
        owned.admissionObservation = {
          endpoint: { ...endpoint },
          original: {
            workloadId: ref.id,
            endpoint: endpoint.url,
            provider: owned.provider,
            credentialName: owned.profile.credentialName,
            profileRowId: materialHash,
            materialHash,
            controllerGeneration: endpoint.generation,
          },
          baseline: undefined,
          requestAuthorizedAt: undefined,
          rejection: undefined,
          afterRejection: undefined,
          request: undefined,
          acknowledgement: undefined,
          afterInvalid: undefined,
          workloadHistory: undefined,
          observedStates: new Set(),
          historyObservedAt: undefined,
          historyIncomplete: false,
          statusWorkload: undefined,
          controllerChanged: false,
        };
        if (options.invalidRequest) {
          const body = options.invalidRequest;
          const { vmType, region } = body.cloudConfig;
          const vmRuntime =
            typeof vmType === 'string'
              ? gpuRuntimeForVMType(CloudType.Azure, vmType)
              : undefined;
          if (
            body.id !== ref.id ||
            body.workloadType !== 'job' ||
            body.credentialName !== owned.profile.credentialName ||
            body.cloudConfig.credentials !== undefined ||
            (body.cloudConfig.cloudProvider !== undefined &&
              body.cloudConfig.cloudProvider !== owned.provider) ||
            owned.provider !== CloudType.Azure ||
            typeof vmType !== 'string' ||
            !owned.profile.vmTypes.includes(vmType) ||
            typeof region !== 'string' ||
            !region.trim() ||
            (owned.profile.region !== undefined &&
              owned.profile.region !== region) ||
            body.gpuType !== undefined ||
            body.dockerOptions !== undefined ||
            !/^\S+@sha256:[a-f0-9]{64}$/u.test(body.image) ||
            vmRuntime !== GpuRuntime.Rocm
          )
            throw new Error(
              'VM Invalid admission request is outside the named guard',
            );
          owned.admissionObservation.request = {
            ...owned.admissionObservation.original,
            observedAt: Date.now(),
            image: body.image,
            vmType,
            vmRuntime,
            region,
            credentialName: body.credentialName,
            workloadType: body.workloadType,
          };
        }
      }
      if (owned.profile) {
        const rows = await this.#queryComplete(
          ref,
          owned,
          `SELECT id, name, cloud_provider FROM credentials WHERE name = '${escapedSql(owned.profile.credentialName)}'`,
          `vm-${ref.id}-original-credential`,
          deadlineAt,
        );
        const [row] = rows;
        if (
          rows.length !== 1 ||
          row?.name !== owned.profile.credentialName ||
          row.cloud_provider !== owned.provider
        )
          throw new Error(
            'VM original credential identity is missing or foreign',
          );
        owned.credentialId = text(row.id, 'original credential ID');
        if (
          owned.admissionObservation &&
          owned.credentialId !==
            owned.admissionObservation.original.materialHash
        )
          throw new Error(
            'VM original credential material does not match its row',
          );
      }
      const baseline = await this.#capture(ref, owned, deadlineAt);
      if (baseline.length !== 0)
        throw new Error(`VM ${ref.id} already has provisioning attempts`);
      if (owned.admissionObservation) {
        const observation = await this.#admissionBaseline(
          ref,
          owned,
          deadlineAt,
        );
        const problem = admissionBaselineProblem(
          owned.admissionObservation.original,
          observation,
        );
        if (problem)
          throw new Error(`VM admission baseline is unknown: ${problem}`);
        owned.admissionObservation.baseline = observation;
      }
      this.#require(ref);
      if (owned.cleanup) throw new Error(`VM ${ref.id} cleanup has started`);
      this.#assertAdmissionController(ref, owned);
      if (owned.admissionObservation)
        owned.admissionObservation.requestAuthorizedAt = Date.now();
      owned.creationStarted = true;
    } finally {
      owned.authorizing = false;
    }
  }

  /** Retain a declared rejection; cleanup must still recheck complete history. */
  async recordAdmissionRejection(
    ref: TrackedWorkloadRef,
    error: unknown,
  ): Promise<void> {
    const owned = this.#require(ref);
    if (
      !owned.creationStarted ||
      owned.authorizing ||
      owned.cleanup ||
      owned.admissionRejection ||
      owned.admissionObservation?.rejection ||
      owned.admissionObservation?.acknowledgement ||
      !owned.admissionObservation?.baseline ||
      owned.admissionObservation.requestAuthorizedAt === undefined
    )
      throw new Error(`VM ${ref.id} cannot record an admission rejection`);
    this.#assertAdmissionController(ref, owned);
    const rejection = declaredApiError(error);
    if (!rejection) {
      owned.admissionObservation.historyIncomplete = true;
      throw new Error(
        'VM non-creation requires a declared admission rejection',
      );
    }
    const admission = owned.admissionObservation;
    admission.rejection = {
      ...admission.original,
      observedAt: Date.now(),
      defined: true,
      code: rejection.code,
      status: rejection.status,
    };
    const deadlineAt = Date.now() + 60_000;
    await this.#capture(ref, owned, deadlineAt);
    await this.#captureAdmissionWorkloadHistory(ref, owned, deadlineAt);
    admission.afterRejection = await this.#admissionInventory(
      ref,
      owned,
      deadlineAt,
    );
    const observation = this.#admissionNonCreation(ref, owned);
    if (observation.kind !== 'rejection-observed')
      throw new Error(
        observation.kind === 'unknown'
          ? admissionUnknownMessage(observation.reason)
          : 'VM admission rejection observation is missing',
      );
    this.#assertPreProvisionFailure(ref, owned);
    this.#require(ref);
    if (owned.cleanup) throw new Error(`VM ${ref.id} cleanup has started`);
    this.#assertAdmissionController(ref, owned);
    owned.admissionRejection = {
      code: 'WORKLOAD_ADMISSION_REJECTED',
      status: 400,
      observedAt: observation.observedAt,
      workloads: 0,
      vms: 0,
    };
  }

  /** The caller passes its actual SDK acknowledgement, never CLI text or a lost reply. */
  async recordAdmissionInvalid(
    ref: TrackedWorkloadRef,
    response: WorkloadCreateResponse,
  ): Promise<void> {
    const owned = this.#require(ref);
    const admission = owned.admissionObservation;
    if (
      !owned.creationStarted ||
      owned.authorizing ||
      owned.cleanup ||
      !admission?.request ||
      !admission.baseline ||
      admission.requestAuthorizedAt === undefined ||
      admission.rejection ||
      admission.acknowledgement ||
      response.id !== ref.id
    )
      throw new Error(
        'VM Invalid admission has no original acknowledged request',
      );
    this.#assertAdmissionController(ref, owned);
    admission.acknowledgement = {
      ...admission.original,
      observedAt: Date.now(),
      responseWorkloadId: response.id,
    };
    try {
      const deadlineAt = Date.now() + 60_000;
      await this.#capture(ref, owned, deadlineAt);
      await this.#captureAdmissionWorkloadHistory(ref, owned, deadlineAt);
      admission.afterInvalid = await this.#admissionInventory(
        ref,
        owned,
        deadlineAt,
      );
      this.#assertPreProvisionFailure(ref, owned);
    } catch (error) {
      admission.historyIncomplete = true;
      throw error;
    }
  }

  async #captureAdmissionWorkloadHistory(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    deadlineAt: number,
  ): Promise<void> {
    const admission = owned.admissionObservation;
    if (!admission) throw new Error('VM admission observation was not armed');
    const previous = admission.workloadHistory;
    const workloads: AdmissionWorkloadHistory['workloads'][number][] = [];
    const events = new Map(previous?.events.map((event) => [event.id, event]));
    const retain = (complete: boolean) => {
      admission.workloadHistory = {
        ...admission.original,
        observedAt: Date.now(),
        complete,
        workloads: workloads.length
          ? [...workloads]
          : (previous?.workloads ?? []),
        events: [...events.values()].sort((a, b) => a.id - b.id),
        observedStates: [...admission.observedStates],
      };
    };
    try {
      const rows = await this.#queryComplete(
        ref,
        owned,
        `SELECT w.id, w.credential_id, c.cloud_provider, w.workload_type, w.state, w.started_at, w.completed_at, w.cleaned_at, s.image, w.image_runtime, w.vm_type, w.region FROM workloads w LEFT JOIN credentials c ON c.id = w.credential_id LEFT JOIN container_specs s ON s.workload_id = w.id WHERE w.id = '${escapedSql(ref.id)}'`,
        `vm-${ref.id}-admission-workload-history`,
        deadlineAt,
      );
      for (const row of rows) {
        if (
          row.id !== ref.id ||
          row.credential_id !== owned.credentialId ||
          row.cloud_provider !== owned.provider
        )
          throw new Error(
            'VM admission Workload history has a foreign identity',
          );
        const state = admissionState(row.state);
        admission.observedStates.add(state);
        workloads.push({
          id: ref.id,
          credentialId: owned.credentialId!,
          provider: owned.provider,
          state,
          workloadType: text(row.workload_type, 'admission Workload type'),
          startedAt: databaseInteger(
            row.started_at,
            'Admission Workload start time',
          ),
          completedAt:
            row.completed_at === null
              ? null
              : databaseInteger(
                  row.completed_at,
                  'Admission Workload completion time',
                ),
          cleanedAt:
            row.cleaned_at === null
              ? null
              : databaseInteger(
                  row.cleaned_at,
                  'Admission Workload cleanup time',
                ),
          image: nullableText(row.image, 'admission image'),
          imageRuntime: nullableText(
            row.image_runtime,
            'admission image runtime',
          ),
          vmType: nullableText(row.vm_type, 'admission VM type'),
          region: nullableText(row.region, 'admission region'),
        });
        retain(false);
      }
      if (previous?.workloads.length && !workloads.length)
        throw new Error(
          'VM admission Workload disappeared from retained history',
        );
      const expectedMessage = admission.request
        ? azureCudaGuardMessage(admission.request.vmType)
        : '';
      const eventRows = await this.#queryComplete(
        ref,
        owned,
        `SELECT id, workload_id, state, created_at, CASE WHEN json_extract(metadata, '$.message') = '${escapedSql(expectedMessage)}' THEN 1 ELSE 0 END AS expected_guard_message FROM workload_events WHERE workload_id = '${escapedSql(ref.id)}' ORDER BY id`,
        `vm-${ref.id}-admission-event-history`,
        deadlineAt,
      );
      const currentIds = new Set<number>();
      for (const row of eventRows) {
        if (row.workload_id !== ref.id)
          throw new Error('VM admission event history has a foreign Workload');
        const id = databaseInteger(row.id, 'Admission event ID');
        const matches = databaseInteger(
          row.expected_guard_message,
          'Admission guard message match',
        );
        if (id < 1 || currentIds.has(id) || matches > 1)
          throw new Error(
            'VM admission event history is duplicated or malformed',
          );
        const state = admissionState(row.state);
        admission.observedStates.add(state);
        const event = {
          id,
          workloadId: ref.id,
          state,
          createdAt: databaseInteger(row.created_at, 'Admission event time'),
          guardMessage:
            matches === 1 && expectedMessage ? expectedMessage : null,
        };
        const prior = events.get(id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(event))
          throw new Error('VM admission event history was rewritten');
        currentIds.add(id);
        events.set(id, event);
        retain(false);
      }
      if ([...events.keys()].some((id) => !currentIds.has(id)))
        throw new Error('VM admission event history lost an earlier event');
      retain(true);
    } catch (error) {
      admission.historyIncomplete = true;
      retain(false);
      throw error;
    }
  }

  #assertPreProvisionFailure(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    recheck?: AdmissionInventoryObservation,
  ): void {
    this.#assertAdmissionController(ref, owned);
    const admission = owned.admissionObservation;
    if (
      !admission?.baseline ||
      !admission.workloadHistory ||
      admission.requestAuthorizedAt === undefined ||
      admission.historyObservedAt === undefined
    )
      throw new Error('VM pre-provision admission history is incomplete');
    const shared = {
      original: admission.original,
      baseline: admission.baseline,
      requestAuthorizedAt: admission.requestAuthorizedAt,
      ...(recheck ? { recheck } : {}),
      workloadHistory: {
        ...admission.workloadHistory,
        observedStates: [...admission.observedStates],
      },
      history: {
        ...admission.original,
        observedAt: admission.historyObservedAt,
        complete: !admission.historyIncomplete,
        attempts: [...owned.attempts.values()],
        statusIdentities: [...owned.statusLocations.values()],
      },
      evaluatedAt: Date.now(),
    };
    if (admission.rejection && admission.afterRejection) {
      assertPreProvisionAdmissionFailure({
        ...shared,
        kind: 'rejected',
        rejection: admission.rejection,
        afterRejection: admission.afterRejection,
        history: {
          ...shared.history,
          statusIdentities: [
            ...shared.history.statusIdentities,
            ...(admission.statusWorkload ? [admission.statusWorkload] : []),
          ],
        },
      });
    } else if (
      admission.request &&
      admission.acknowledgement &&
      admission.afterInvalid
    ) {
      assertPreProvisionAdmissionFailure({
        ...shared,
        kind: 'invalid',
        request: admission.request,
        acknowledgement: admission.acknowledgement,
        afterInvalid: admission.afterInvalid,
      });
    } else
      throw new Error('VM pre-provision admission has no acknowledged outcome');
  }

  async #admissionInventory(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    deadlineAt: number,
  ): Promise<AdmissionInventoryObservation> {
    this.#dependencies.signal.throwIfAborted();
    const rows = await this.#queryComplete(
      ref,
      owned,
      `SELECT '${escapedSql(ref.id)}' AS workload_id, (SELECT COUNT(*) FROM workloads WHERE id = '${escapedSql(ref.id)}') AS workloads, (SELECT COUNT(*) FROM vms WHERE workload_id = '${escapedSql(ref.id)}') AS vms`,
      `vm-${ref.id}-rejected-admission`,
      deadlineAt,
    );
    this.#require(ref);
    const [row] = rows;
    if (rows.length !== 1 || row?.workload_id !== ref.id)
      throw new Error('VM rejected admission inventory is missing or foreign');
    if (!owned.admissionObservation)
      throw new Error('VM admission observation was not armed before creation');
    return {
      ...owned.admissionObservation.original,
      observedAt: Date.now(),
      complete: true,
      workloads: databaseInteger(row.workloads, 'Rejected Workload count'),
      vms: databaseInteger(row.vms, 'Rejected VM count'),
    };
  }

  async #admissionBaseline(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    deadlineAt: number,
  ): Promise<AdmissionBaselineObservation> {
    const admission = owned.admissionObservation;
    if (!admission) throw new Error('VM admission observation was not armed');
    const rows = await this.#queryComplete(
      ref,
      owned,
      `SELECT id AS credential_id, name AS credential_name, cloud_provider, '${escapedSql(ref.id)}' AS workload_id, (SELECT COUNT(*) FROM workloads WHERE id = '${escapedSql(ref.id)}') AS workloads, (SELECT COUNT(*) FROM vms WHERE workload_id = '${escapedSql(ref.id)}') AS vms FROM credentials WHERE name = '${escapedSql(admission.original.credentialName)}'`,
      `vm-${ref.id}-admission-baseline`,
      deadlineAt,
    );
    const [row] = rows;
    if (
      rows.length !== 1 ||
      row?.workload_id !== ref.id ||
      row.cloud_provider !== owned.provider
    )
      throw new Error('VM admission baseline is missing or foreign');
    return {
      ...admission.original,
      observedAt: Date.now(),
      complete: true,
      workloads: databaseInteger(row.workloads, 'Baseline Workload count'),
      vms: databaseInteger(row.vms, 'Baseline VM count'),
      credential: {
        id: text(row.credential_id, 'baseline credential ID'),
        name: text(row.credential_name, 'baseline credential name'),
        provider: owned.provider,
      },
    };
  }

  #admissionNonCreation(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    recheck?: AdmissionInventoryObservation,
  ): AdmissionNonCreationObservation {
    this.#require(ref);
    this.#assertAdmissionController(ref, owned);
    const admission = owned.admissionObservation;
    if (
      !admission?.baseline ||
      admission.requestAuthorizedAt === undefined ||
      !admission.rejection ||
      !admission.afterRejection ||
      admission.historyObservedAt === undefined
    )
      return { kind: 'unknown', reason: 'incomplete-history' };
    return evaluateAdmissionNonCreation({
      original: admission.original,
      baseline: admission.baseline,
      requestAuthorizedAt: admission.requestAuthorizedAt,
      rejection: admission.rejection,
      afterRejection: admission.afterRejection,
      ...(recheck ? { recheck } : {}),
      history: {
        ...admission.original,
        observedAt: admission.historyObservedAt,
        complete: !admission.historyIncomplete,
        attempts: [...owned.attempts.values()],
        statusIdentities: [
          ...(admission.statusWorkload ? [admission.statusWorkload] : []),
          ...owned.statusLocations.values(),
        ],
      },
      evaluatedAt: Date.now(),
    });
  }

  #assertAdmissionController(ref: TrackedWorkloadRef, owned: OwnedVm): void {
    const admission = owned.admissionObservation;
    if (!admission) return;
    this.#require(ref);
    this.#dependencies.signal.throwIfAborted();
    const current = this.#dependencies.endpoint.snapshot();
    if (
      admission.controllerChanged ||
      !current ||
      current.url !== admission.endpoint.url ||
      current.generation !== admission.endpoint.generation ||
      current.fixtureProcess !== admission.endpoint.fixtureProcess
    ) {
      admission.controllerChanged = true;
      throw new Error('VM admission controller detached or changed generation');
    }
  }

  async #queryComplete(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    sql: string,
    label: string,
    deadlineAt: number,
  ): Promise<readonly Record<string, unknown>[]> {
    this.#assertAdmissionController(ref, owned);
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await this.#dependencies.database.queryComplete(
        sql,
        label,
        deadlineAt,
      );
    } catch (error) {
      try {
        this.#assertAdmissionController(ref, owned);
      } catch (controllerError) {
        throw new AggregateError(
          [error, controllerError],
          'VM admission inventory and controller continuity both failed',
        );
      }
      throw error;
    }
    this.#assertAdmissionController(ref, owned);
    return rows;
  }

  /** Retain actual cleanup responses without another inventory read. */
  recordAdmissionStatus(id: string, status: StatusResponse): void {
    const ref = this.#dependencies.kernel.activeReference(id);
    if (!ref) return;
    const owned = this.#owned.get(ref);
    if (!owned?.admissionObservation) return;
    try {
      this.#assertAdmissionController(ref, owned);
      this.#captureStatus(ref, owned, status);
    } catch (error) {
      owned.admissionObservation.historyIncomplete = true;
      throw error;
    }
  }

  #captureStatus(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    status: StatusResponse,
  ): void {
    if (
      status.workload.id !== ref.id ||
      status.workload.cloudProvider !== owned.provider
    )
      throw new Error(
        'VM cleanup status identified a foreign Workload or provider',
      );
    if (owned.admissionObservation) {
      this.#assertAdmissionController(ref, owned);
      owned.admissionObservation.observedStates.add(status.workload.state);
      owned.admissionObservation.statusWorkload ??= {
        workloadId: status.workload.id,
        observedAt: Date.now(),
      };
    }
    for (const vm of status.vms ?? []) {
      const location = Object.freeze({
        cloudId: text(vm.cloudId, 'observed native ID'),
        region: nullableText(
          vm.region ?? status.workload.region,
          'observed region',
        ),
        availabilityZone: nullableText(
          vm.availabilityZone ?? status.workload.availabilityZone,
          'observed zone',
        ),
      });
      // A later malformed identity cannot discard these validated coordinates.
      owned.statusLocations.set(nativeKey(location), location);
    }
  }

  async capture(
    ref: TrackedWorkloadRef,
    status?: StatusResponse,
  ): Promise<void> {
    const owned = this.#require(ref);
    try {
      if (status) this.#captureStatus(ref, owned, status);
      if (owned.credentialId === undefined && !owned.creationStarted) return;
      const deadlineAt = Date.now() + 60_000;
      await this.#capture(ref, owned, deadlineAt);
    } catch (error) {
      if (owned.admissionObservation)
        owned.admissionObservation.historyIncomplete = true;
      throw error;
    }
  }

  verify(ref: TrackedWorkloadRef, timeoutMs: number): Promise<SubstrateAbsent> {
    return this.#verifyOnce(ref, this.#require(ref), timeoutMs);
  }

  #verifyOnce(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    timeoutMs: number,
  ): Promise<SubstrateAbsent> {
    if (owned.authorizing)
      return Promise.reject(
        new Error(`VM ${ref.id} creation is still authorizing`),
      );
    owned.cleanup ??= Promise.resolve().then(() =>
      this.#verify(ref, owned, timeoutMs),
    );
    return owned.cleanup;
  }

  async #capture(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    deadlineAt: number,
  ): Promise<readonly VmAttempt[]> {
    try {
      this.#dependencies.kernel.assertActive(ref);
      this.#dependencies.signal.throwIfAborted();
      const rows = await this.#queryComplete(
        ref,
        owned,
        `SELECT v.id, v.workload_id, v.created_at, v.ended_at, v.cloud_id, v.ip, v.region, v.availability_zone, v.vm_type, v.credential_id, c.cloud_provider FROM vms v LEFT JOIN credentials c ON c.id = v.credential_id WHERE v.workload_id = '${escapedSql(ref.id)}' ORDER BY v.created_at, v.id`,
        `vm-${ref.id}-all-attempts`,
        deadlineAt,
      );
      this.#dependencies.kernel.assertActive(ref);
      const current = new Map<number, VmAttempt>();
      for (const row of rows) {
        if (
          row.workload_id !== ref.id ||
          row.credential_id !== owned.credentialId ||
          (owned.provider === CloudType.Local
            ? row.cloud_provider !== null
            : row.cloud_provider !== owned.provider)
        )
          throw new Error(
            'VM attempt belongs to a foreign Workload or original credential',
          );
        const rowId = databaseInteger(row.id, 'VM attempt row ID');
        const createdAt = databaseInteger(
          row.created_at,
          'VM attempt creation time',
        );
        const endedAt =
          row.ended_at === null
            ? null
            : databaseInteger(row.ended_at, 'VM attempt end time');
        if (
          rowId < 1 ||
          current.has(rowId) ||
          (endedAt !== null && endedAt < createdAt)
        )
          throw new Error(
            'VM inventory has duplicate identities or invalid timestamps',
          );
        const attempt: VmAttempt = Object.freeze({
          rowId,
          createdAt,
          endedAt,
          cloudId: text(row.cloud_id, 'native or reserved ID'),
          region: text(row.region, 'original region'),
          availabilityZone: nullableText(
            row.availability_zone,
            'original zone',
          ),
          ip: nullableText(row.ip, 'original IP'),
          vmType: text(row.vm_type, 'original VM type'),
        });
        if (owned.profile?.region && attempt.region !== owned.profile.region)
          throw new Error(
            'VM attempt differs from its original requested region',
          );
        const previous = owned.latest.get(rowId);
        const adoptingReservation =
          previous?.ip === null && attempt.ip !== null;
        if (
          previous &&
          (attempt.region !== previous.region ||
            attempt.vmType !== previous.vmType ||
            (!adoptingReservation &&
              attempt.createdAt !== previous.createdAt) ||
            (!adoptingReservation &&
              attempt.availabilityZone !== previous.availabilityZone) ||
            (adoptingReservation &&
              previous.availabilityZone !== null &&
              attempt.availabilityZone === null) ||
            (previous.ip !== null &&
              (attempt.cloudId !== previous.cloudId ||
                attempt.ip !== previous.ip ||
                (previous.endedAt !== null &&
                  attempt.endedAt !== previous.endedAt))))
        )
          throw new Error('VM ledger rewrote original native coordinates');
        current.set(rowId, attempt);
        // A later invalid row/read cannot discard the validated identities here.
        owned.attempts.set(JSON.stringify(attempt), attempt);
      }
      for (const rowId of owned.latest.keys())
        if (!current.has(rowId))
          throw new Error(
            'VM ledger lost a previously observed provisioning attempt',
          );
      owned.latest = current;
      if (owned.admissionObservation)
        owned.admissionObservation.historyObservedAt = Date.now();
      return [...current.values()];
    } catch (error) {
      if (owned.admissionObservation)
        owned.admissionObservation.historyIncomplete = true;
      throw error;
    }
  }

  async #verify(
    ref: TrackedWorkloadRef,
    owned: OwnedVm,
    timeoutMs: number,
  ): Promise<SubstrateAbsent> {
    const startedAt = Date.now();
    const observations: (VmHostPresenceObservation & VmHostLocation)[] = [];
    const reservationObservations: VmReservationPresenceObservation[] = [];
    const ownedLocalInventoryChecks: {
      observedAt: number;
      machineNames: readonly string[];
    }[] = [];
    let failure: unknown;
    let failed = false;
    let completed = false;
    let nonCreationVerifiedAt: number | undefined;
    try {
      await this.#dependencies.wait.for(
        `all native VM hosts absent for ${ref.id}`,
        async (deadlineAt) => {
          const latest = await this.#capture(ref, owned, deadlineAt);
          if (owned.admissionRejection) {
            await this.#captureAdmissionWorkloadHistory(ref, owned, deadlineAt);
            const recheck = await this.#admissionInventory(
              ref,
              owned,
              deadlineAt,
            );
            const observation = this.#admissionNonCreation(ref, owned, recheck);
            if (observation.kind !== 'proven-non-creation')
              throw new Error(
                observation.kind === 'unknown'
                  ? admissionUnknownMessage(observation.reason)
                  : 'VM admission cleanup recheck is missing',
              );
            this.#assertPreProvisionFailure(ref, owned, recheck);
            nonCreationVerifiedAt = observation.observedAt;
          } else if (owned.admissionObservation?.afterInvalid) {
            await this.#captureAdmissionWorkloadHistory(ref, owned, deadlineAt);
            const recheck = await this.#admissionInventory(
              ref,
              owned,
              deadlineAt,
            );
            this.#assertPreProvisionFailure(ref, owned, recheck);
            nonCreationVerifiedAt = recheck.observedAt;
          } else if (owned.creationStarted && latest.length === 0)
            throw new Error(
              'VM creation has no complete native identity inventory',
            );
          if (latest.some((attempt) => attempt.endedAt === null))
            return 'live VM attempt rows remain';
          const reservationHistory =
            owned.provider === CloudType.AWS
              ? [...owned.attempts.values()]
              : latest;
          const reservations = [
            ...new Map(
              reservationHistory
                .filter(
                  (attempt) => !hasNativeCoordinates(owned.provider, attempt),
                )
                .map((attempt) => [nativeKey(attempt), attempt]),
            ).values(),
          ];
          if (
            reservations.some(
              (attempt) =>
                owned.provider !== CloudType.AWS ||
                !owned.native ||
                attempt.ip !== null ||
                !attempt.cloudId.startsWith(`${ref.id}-`) ||
                !/^(?:0|[1-9][0-9]*)$/u.test(
                  attempt.cloudId.slice(ref.id.length + 1),
                ),
            )
          )
            throw new Error(
              'VM cleanup retains an unresolved native provisioning identity',
            );
          const native = new Map<string, VmHostLocation>();
          for (const attempt of owned.attempts.values())
            if (hasNativeCoordinates(owned.provider, attempt))
              native.set(nativeKey(attempt), attempt);
          for (const [key, location] of owned.statusLocations) {
            if (
              ![...native.values()].some(
                (attempt) =>
                  attempt.cloudId === location.cloudId &&
                  attempt.region === location.region &&
                  attempt.availabilityZone === location.availabilityZone,
              )
            )
              throw new Error(
                'VM status identity has no original credential-bound ledger coordinates',
              );
            native.set(key, location);
          }
          const current: VmHostPresenceObservation[] = [];
          for (const location of native.values()) {
            const options = { deadlineAt, signal: this.#dependencies.signal };
            const observation = owned.native
              ? await owned.native.observe(location, options)
              : await observeLocalSmolvmHost(
                  this.#dependencies.http,
                  new URL(LOCAL_SMOLVM_CONTRACT.baseUrl),
                  location.cloudId,
                  options,
                );
            if (
              observation.cloudId !== location.cloudId ||
              observation.provider !== owned.provider ||
              !['present', 'absent', 'unknown'].includes(observation.presence)
            )
              throw new Error(
                'VM cleanup received foreign or invalid native evidence',
              );
            // Append immediately; a later host or inventory failure keeps it.
            observations.push({
              cloudId: observation.cloudId,
              provider: observation.provider,
              presence: observation.presence,
              diagnostic: observation.diagnostic,
              region: location.region,
              availabilityZone: location.availabilityZone,
            });
            current.push(observation);
          }
          let unresolvedReservationPresence = false;
          if (reservations.length > 0 && owned.native) {
            const requested = new Map(
              reservations.map((attempt) => [nativeKey(attempt), attempt]),
            );
            const observationKey = (
              attempt: VmReservationPresenceObservation['attempts'][number],
            ) => nativeKey({ ...attempt, cloudId: attempt.attemptId });
            const retain = (observation: VmReservationPresenceObservation) => {
              if (
                observation.kind !== 'exact-attempt-current-presence' ||
                observation.provider !== owned.provider ||
                observation.credentialName !== owned.profile?.credentialName ||
                !Number.isSafeInteger(observation.observedAt) ||
                observation.observedAt < startedAt ||
                observation.observedAt > Date.now() ||
                (observation.inventory !== null &&
                  (!Number.isSafeInteger(observation.inventory.pages) ||
                    observation.inventory.pages < 1 ||
                    !Number.isSafeInteger(observation.inventory.instances) ||
                    observation.inventory.instances < 0 ||
                    typeof observation.inventory.complete !== 'boolean')) ||
                observation.attempts.length !== requested.size ||
                new Set(observation.attempts.map(observationKey)).size !==
                  requested.size ||
                observation.attempts.some(
                  (attempt) =>
                    !requested.has(observationKey(attempt)) ||
                    !['present', 'absent', 'unknown'].includes(
                      attempt.presence,
                    ) ||
                    new Set(attempt.instanceIds).size !==
                      attempt.instanceIds.length ||
                    attempt.instanceIds.some(
                      (id) => !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u.test(id),
                    ) ||
                    (attempt.presence === 'present') !==
                      attempt.instanceIds.length > 0 ||
                    (attempt.presence === 'absent' &&
                      !observation.inventory?.complete),
                )
              )
                throw new Error(
                  'VM cleanup received foreign or incomplete reservation evidence',
                );
              reservationObservations.push(structuredClone(observation));
            };
            const observation = await owned.native.observeReservations(
              reservations.map(({ cloudId, region, availabilityZone }) => ({
                cloudId,
                region,
                availabilityZone,
              })),
              {
                deadlineAt,
                signal: this.#dependencies.signal,
                onPartialObservation: retain,
              },
            );
            retain(observation);
            for (const attempt of observation.attempts) {
              const reservation = requested.get(observationKey(attempt))!;
              for (const instanceId of attempt.instanceIds) {
                // EC2 keeps terminated instances in DescribeInstances. A match
                // is resolved only through the same recorded adoption and the
                // independent native-ID absence checks above, never its state alone.
                const adopted = [...owned.attempts.values()].some(
                  (nativeAttempt) =>
                    nativeAttempt.rowId === reservation.rowId &&
                    nativeAttempt.cloudId === instanceId &&
                    nativeAttempt.region === reservation.region &&
                    (reservation.availabilityZone === null ||
                      nativeAttempt.availabilityZone ===
                        reservation.availabilityZone) &&
                    hasNativeCoordinates(owned.provider, nativeAttempt),
                );
                if (!adopted)
                  throw new Error(
                    'Provisioning attempt has a native instance without ledger coordinates',
                  );
              }
            }
            unresolvedReservationPresence =
              !observation.inventory?.complete ||
              observation.attempts.some(
                (attempt) =>
                  attempt.instanceIds.length === 0 &&
                  attempt.presence !== 'absent',
              );
          }
          if (unresolvedReservationPresence)
            return 'Provisioning attempt presence remains present or unknown';
          if (owned.provider === CloudType.Local) {
            const machines = await ownedSmolvmMachines(
              this.#dependencies.http,
              new URL(LOCAL_SMOLVM_CONTRACT.baseUrl),
              ref.id,
              { deadlineAt, signal: this.#dependencies.signal },
            );
            // The legacy contract also owns guests missing from the API ledger.
            // Keep this complete inventory even if a later cleanup step fails.
            ownedLocalInventoryChecks.push({
              observedAt: Date.now(),
              machineNames: machines.map((machine) => machine.name),
            });
            if (machines.length > 0) return 'owned Local VM hosts remain';
          }
          return current.every(
            (observation) => observation.presence === 'absent',
          )
            ? undefined
            : 'native VM presence remains present or unknown';
        },
        {
          timeoutMs,
          intervalMs: Math.min(2_000, timeoutMs),
          probeError: 'fail',
          unmet: (unmet) => unmet,
        },
      );
      this.#dependencies.kernel.assertActive(ref);
      this.#assertAdmissionController(ref, owned);
      await owned.verifyAdditional?.(ref, startedAt + timeoutMs);
      this.#dependencies.kernel.assertActive(ref);
      this.#assertAdmissionController(ref, owned);
      completed = true;
    } catch (error) {
      failure = error;
      failed = true;
    }
    try {
      await this.#dependencies.artifacts.json(`vm-${ref.id}-native-cleanup`, {
        schemaVersion: 1,
        kind: 'persistent-vm-native-cleanup',
        workloadId: ref.id,
        target: owned.target,
        startedAt,
        completedAt: Date.now(),
        originalIdentity: {
          provider: owned.provider,
          profileRowId: owned.credentialId ?? null,
        },
        creationStarted: owned.creationStarted,
        admissionRejection: owned.admissionRejection ?? null,
        preProvisionAdmission: this.#retainedAdmission(owned),
        nonCreationVerifiedAt: nonCreationVerifiedAt ?? null,
        attemptHistory: [...owned.attempts.values()],
        statusIdentities: [...owned.statusLocations.values()],
        currentAttempts: [...owned.latest.values()],
        observations,
        ...(reservationObservations.length > 0
          ? { reservationObservations }
          : {}),
        ...(owned.provider === CloudType.Local
          ? { ownedLocalInventoryChecks }
          : {}),
        completed,
        ...(failed
          ? {
              failure:
                failure instanceof Error
                  ? failure.message
                  : 'Non-Error native cleanup failure',
            }
          : {}),
      });
    } catch (artifactError) {
      if (failed)
        throw new AggregateError(
          [failure, artifactError],
          'VM native cleanup and its evidence record both failed',
        );
      throw artifactError;
    }
    if (failed) throw failure;
    this.#assertAdmissionController(ref, owned);
    return this.#dependencies.kernel.recordSubstrateAbsence(ref);
  }

  #require(ref: TrackedWorkloadRef): OwnedVm {
    this.#dependencies.kernel.assertActive(ref);
    const owned = this.#owned.get(ref);
    if (!owned)
      throw new Error(
        `VM ${ref.id} has no original native cleanup registration`,
      );
    return owned;
  }
}
