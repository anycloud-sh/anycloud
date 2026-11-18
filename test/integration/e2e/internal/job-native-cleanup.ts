import { CloudType } from '../../../../src/shared/cloud.js';

import type { ArtifactStore } from './artifacts.js';
import type {
  JobAttemptIdentity,
  JobAttemptLedger,
} from './job-attempt-ledger.js';
import type { JobNativeAttempt } from './targets/job-types.js';
import type {
  VmHostLocation,
  VmHostPresenceObservation,
  VmReservationPresenceObservation,
} from './transports/public-cloud-vm-host-presence.js';
import type { Waiter } from './wait.js';
import type { TrackedWorkloadKernel, TrackedWorkloadRef } from './workloads.js';

/** Private transport facts; specs and Job extensions cannot mint cleanup. */
export interface JobNativeReader {
  observe(
    attempt: JobNativeAttempt,
    timeoutMs: number,
    deadlineAt: number,
  ): Promise<VmHostPresenceObservation>;
  readonly reservations?: {
    readonly credentialName: string;
    observe(
      attempts: readonly JobNativeAttempt[],
      deadlineAt: number,
      retainPartial: (observation: VmReservationPresenceObservation) => void,
    ): Promise<VmReservationPresenceObservation>;
    /** A discovered native ID is not a database adoption or a new attempt row. */
    observeMatch(
      location: VmHostLocation,
      timeoutMs: number,
      deadlineAt: number,
    ): Promise<VmHostPresenceObservation>;
  };
}

interface JobCreation {
  readonly ordinal: number;
  readonly startedAt: number;
  readonly baselineRowIds: readonly number[];
  readonly resolvedRowIds: Set<number>;
}

interface OwnedJob {
  readonly identity: JobAttemptIdentity;
  readonly native: JobNativeReader;
  readonly observed: Map<string, JobNativeAttempt>;
  readonly creations: JobCreation[];
  readonly checkedGenerations: Set<number>;
  readonly reservationObservations: VmReservationPresenceObservation[];
  readonly reservationMatches: Map<
    string,
    {
      readonly reservation: JobNativeAttempt;
      readonly location: VmHostLocation;
    }
  >;
  authorizing: boolean;
  checkingGeneration: boolean;
  cleanup: Promise<void> | undefined;
}

const generationAbsenceBrand: unique symbol = Symbol('JobGenerationAbsence');

/** Intermediate absence keeps the original Workload reference armed. */
export interface JobGenerationAbsence {
  readonly generation: number;
  readonly [generationAbsenceBrand]: true;
}

/**
 * The wait's deadline passed inside a probe. It ends the wait as a timeout, so
 * the report keeps the last unmet condition.
 */
class CleanupDeadlineExpired extends Error {}

function validateCleanupBudget(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2 * 60 * 60_000
  )
    throw new Error('Job native cleanup timeout must be positive and bounded');
}

function attemptKey(attempt: JobNativeAttempt): string {
  return JSON.stringify([
    attempt.rowId,
    attempt.createdAt,
    attempt.endedAt,
    attempt.cloudId,
    attempt.ip,
    attempt.credentialId,
    attempt.cloudProvider,
    attempt.region,
    attempt.availabilityZone,
    attempt.vmType,
  ]);
}

function nativeKey(attempt: JobNativeAttempt): string {
  return JSON.stringify([
    attempt.cloudProvider,
    attempt.credentialId,
    attempt.region,
    attempt.availabilityZone,
    attempt.cloudId,
  ]);
}

/** Stable database references are identifiers, never provider authorization values. */
function authorizationBindings(owned: OwnedJob) {
  return {
    original: {
      provider: owned.identity.provider,
      recordId: owned.identity.credentialId,
      controller: owned.identity.controller,
    },
    attempts: [...owned.observed.values()].map((attempt) => ({
      rowId: attempt.rowId,
      createdAt: attempt.createdAt,
      endedAt: attempt.endedAt,
      cloudId: attempt.cloudId,
      provider: attempt.cloudProvider,
      recordId: attempt.credentialId,
      region: attempt.region,
      availabilityZone: attempt.availabilityZone,
    })),
  };
}

/** A reserved client token is not an AWS/Lambda provider resource ID. */
export function hasJobNativeCoordinates(attempt: JobNativeAttempt): boolean {
  if (!attempt.region.trim()) return false;
  switch (attempt.cloudProvider) {
    case CloudType.AWS:
      return /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/u.test(attempt.cloudId);
    case CloudType.Azure:
      return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(attempt.cloudId);
    case CloudType.GCP:
      return (
        /^[a-z][a-z0-9-]{0,62}$/u.test(attempt.cloudId) &&
        typeof attempt.availabilityZone === 'string' &&
        /^[a-z]$/u.test(attempt.availabilityZone)
      );
    case CloudType.Lambda:
      return /^[0-9a-f]{32}$/u.test(attempt.cloudId);
    case CloudType.Local:
      return (
        attempt.region === 'local' &&
        attempt.vmType === 'local' &&
        (attempt.ip !== null ||
          (attempt.cloudId.startsWith('ac-local-') &&
            attempt.cloudId.length <= 63 &&
            /^[a-z0-9-]+$/u.test(attempt.cloudId) &&
            isReservation({
              ...attempt,
              cloudId: attempt.cloudId.slice('ac-local-'.length),
            }))) &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(attempt.cloudId)
      );
  }
}

function isReservation(attempt: JobNativeAttempt): boolean {
  const prefix = `${attempt.ref.id}-`;
  return (
    attempt.ip === null &&
    attempt.cloudId.startsWith(prefix) &&
    /^(?:0|[1-9][0-9]*)$/u.test(attempt.cloudId.slice(prefix.length)) &&
    Number.isSafeInteger(Number(attempt.cloudId.slice(prefix.length)))
  );
}

/** Provider protocols define which incomplete coordinates can be refined. */
function hasRecordedRefinement(
  original: JobNativeAttempt,
  history: readonly JobNativeAttempt[],
): boolean {
  if (original.ip !== null) return false;
  const sameRow = history.filter(
    (attempt) =>
      attempt.ref === original.ref &&
      attempt.rowId === original.rowId &&
      attempt.cloudProvider === original.cloudProvider &&
      attempt.credentialId === original.credentialId &&
      attempt.region === original.region &&
      attempt.vmType === original.vmType,
  );
  const later = sameRow.slice(sameRow.indexOf(original) + 1);
  switch (original.cloudProvider) {
    case CloudType.Local:
      // Fixture names are already lowercase and short enough that the existing
      // Local provider name is exactly this prefix plus the reserved token.
      // The Local transport still requires the complete owned-machine inventory.
      return (
        original.region === 'local' &&
        original.vmType === 'local' &&
        isReservation(original) &&
        /^[a-z0-9-]+$/u.test(original.cloudId) &&
        `ac-local-${original.cloudId}`.length <= 63 &&
        later.some(
          (attempt) =>
            hasJobNativeCoordinates(attempt) &&
            attempt.cloudId === `ac-local-${original.cloudId}` &&
            attempt.availabilityZone === original.availabilityZone &&
            (attempt.ip !== null || attempt.createdAt === original.createdAt),
        )
      );
    case CloudType.GCP:
      return (
        original.availabilityZone === null &&
        later.some(
          (attempt) =>
            hasJobNativeCoordinates(attempt) &&
            attempt.cloudId === original.cloudId &&
            attempt.ip !== null,
        )
      );
    case CloudType.Lambda:
      return (
        isReservation(original) &&
        new Set(
          sameRow
            .filter((attempt) => !hasJobNativeCoordinates(attempt))
            .map((attempt) => attempt.cloudId),
        ).size === 1 &&
        later.some(
          (attempt) =>
            hasJobNativeCoordinates(attempt) &&
            attempt.availabilityZone === original.availabilityZone &&
            (attempt.ip !== null || attempt.createdAt === original.createdAt),
        )
      );
    default:
      return false;
  }
}

function reservationKey(location: VmHostLocation): string {
  return JSON.stringify([
    location.cloudId,
    location.region,
    location.availabilityZone,
  ]);
}

/** Reuse the shared observer's format, while binding it to this owner's request. */
function retainReservationObservation(
  owned: OwnedJob,
  requested: readonly JobNativeAttempt[],
  observation: VmReservationPresenceObservation,
  startedAt: number,
  deadlineAt: number,
): void {
  const reader = owned.native.reservations;
  function invalid(): never {
    throw new Error(
      'Job reservation observation lost its original scope or inventory',
    );
  }
  if (
    !reader ||
    observation.kind !== 'exact-attempt-current-presence' ||
    observation.provider !== owned.identity.provider ||
    observation.credentialName !== reader.credentialName ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < startedAt ||
    observation.observedAt > Math.min(Date.now(), deadlineAt) ||
    observation.attempts.length !== requested.length
  )
    invalid();
  const inventory = observation.inventory;
  if (
    inventory &&
    (!Number.isSafeInteger(inventory.pages) ||
      inventory.pages < 1 ||
      !Number.isSafeInteger(inventory.instances) ||
      inventory.instances < 0 ||
      typeof inventory.complete !== 'boolean' ||
      (inventory.complete && inventory.pages < requested.length))
  )
    invalid();
  const originals = new Map(
    requested.map((attempt) => [reservationKey(attempt), attempt]),
  );
  const seen = new Set<string>();
  const nativeOwners = new Map<string, string>();
  let matchCount = 0;
  const matches: Array<{
    reservation: JobNativeAttempt;
    location: VmHostLocation;
  }> = [];
  for (const attempt of observation.attempts) {
    const key = reservationKey({
      cloudId: attempt.attemptId,
      region: attempt.region,
      availabilityZone: attempt.availabilityZone,
    });
    const original = originals.get(key);
    if (
      !original ||
      seen.has(key) ||
      !['absent', 'present', 'unknown'].includes(attempt.presence) ||
      new Set(attempt.instanceIds).size !== attempt.instanceIds.length ||
      (attempt.instanceIds.length > 0
        ? attempt.presence !== 'present' || !inventory
        : attempt.presence === 'present' ||
          (attempt.presence === 'absent' && !inventory?.complete))
    )
      invalid();
    seen.add(key);
    for (const cloudId of attempt.instanceIds) {
      if (!hasJobNativeCoordinates({ ...original, cloudId })) invalid();
      const identity = JSON.stringify([original.region, cloudId]);
      const previous = nativeOwners.get(identity);
      if (previous && previous !== original.cloudId) invalid();
      nativeOwners.set(identity, original.cloudId);
      matchCount++;
      matches.push({
        reservation: original,
        location: Object.freeze({
          cloudId,
          region: original.region,
          availabilityZone: original.availabilityZone,
        }),
      });
    }
  }
  if (
    (inventory && inventory.instances !== matchCount) ||
    (!inventory && matchCount !== 0)
  )
    invalid();
  // The callback is synchronous: valid identities survive a later page,
  // authentication, cancellation or artifact-write failure.
  owned.reservationObservations.push(structuredClone(observation));
  for (const match of matches) {
    owned.reservationMatches.set(
      JSON.stringify([
        nativeKey(match.reservation),
        reservationKey(match.location),
      ]),
      match,
    );
  }
}

/**
 * Keeps the reservation and every observed native identity until an independent
 * cleanup read proves absence. Product cleanup timestamps and zero live rows
 * are prerequisites, not substitutes for this native observation.
 */
export class JobNativeCleanup {
  readonly #kernel: Pick<TrackedWorkloadKernel, 'assertActive'>;
  readonly #ledger: Pick<JobAttemptLedger, 'read' | 'observations'>;
  readonly #wait: Pick<Waiter, 'for'>;
  readonly #artifacts: Pick<ArtifactStore, 'json'>;
  readonly #owned = new Map<TrackedWorkloadRef, OwnedJob>();
  readonly #generationAbsences = new WeakMap<
    JobGenerationAbsence,
    { readonly ref: TrackedWorkloadRef; readonly inventory: string }
  >();

  constructor(dependencies: {
    readonly kernel: Pick<TrackedWorkloadKernel, 'assertActive'>;
    /** This reader is composed with cleanup's independent CLI/process scope. */
    readonly ledger: Pick<JobAttemptLedger, 'read' | 'observations'>;
    readonly wait: Pick<Waiter, 'for'>;
    readonly artifacts: Pick<ArtifactStore, 'json'>;
  }) {
    this.#kernel = dependencies.kernel;
    this.#ledger = dependencies.ledger;
    this.#wait = dependencies.wait;
    this.#artifacts = dependencies.artifacts;
  }

  register(
    ref: TrackedWorkloadRef,
    identity: JobAttemptIdentity,
    native: JobNativeReader,
  ): void {
    this.#kernel.assertActive(ref);
    if (this.#owned.has(ref))
      throw new Error(
        `Job ${ref.id} already owns a native cleanup registration`,
      );
    this.#owned.set(ref, {
      identity: Object.freeze({
        provider: identity.provider,
        credentialId: identity.credentialId,
        controller: Object.freeze({ ...identity.controller }),
      }),
      native: Object.freeze({
        observe: native.observe.bind(native),
        ...(native.reservations
          ? {
              reservations: Object.freeze({
                credentialName: native.reservations.credentialName,
                observe: native.reservations.observe.bind(native.reservations),
                observeMatch: native.reservations.observeMatch.bind(
                  native.reservations,
                ),
              }),
            }
          : {}),
      }),
      observed: new Map(),
      creations: [],
      checkedGenerations: new Set(),
      reservationObservations: [],
      reservationMatches: new Map(),
      authorizing: false,
      checkingGeneration: false,
      cleanup: undefined,
    });
  }

  /** Await a fresh inventory before the tracked create/resubmit can send. */
  async creationStarted(
    ref: TrackedWorkloadRef,
    deadlineAt = Date.now() + 60_000,
    previousGeneration?: JobGenerationAbsence,
  ): Promise<void> {
    const owned = this.#require(ref);
    if (owned.cleanup) throw new Error(`Job ${ref.id} cleanup has started`);
    if (owned.authorizing)
      throw new Error(`Job ${ref.id} creation authorization is in progress`);
    if (owned.checkingGeneration)
      throw new Error(`Job ${ref.id} generation absence is in progress`);
    owned.authorizing = true;
    try {
      const baseline = await this.capture(ref, deadlineAt);
      this.#require(ref);
      if (owned.cleanup) throw new Error(`Job ${ref.id} cleanup has started`);
      if (
        owned.creations.some((creation) => creation.resolvedRowIds.size === 0)
      )
        throw new Error(
          `Job ${ref.id} cannot resubmit an unresolved provisioning identity`,
        );
      // Product resubmission requires every previous VM attempt to have ended.
      // Its next launch inserts a new row; old ended rows cannot prove that a
      // later submission whose reply was lost has no remaining native hosts.
      if (baseline.some((attempt) => attempt.endedAt === null))
        throw new Error(`Job ${ref.id} still has live provisioning attempts`);
      if (owned.creations.length > 0) {
        const binding = previousGeneration
          ? this.#generationAbsences.get(previousGeneration)
          : undefined;
        if (
          !previousGeneration ||
          binding?.ref !== ref ||
          previousGeneration.generation !== owned.creations.length ||
          binding.inventory !== JSON.stringify(baseline.map(attemptKey))
        )
          throw new Error(
            `Job ${ref.id} resubmission requires its unused original generation absence`,
          );
      } else if (previousGeneration) {
        throw new Error(`Job ${ref.id} first submission cannot reuse absence`);
      }
      owned.creations.push({
        ordinal: owned.creations.length + 1,
        startedAt: Date.now(),
        baselineRowIds: Object.freeze(baseline.map((attempt) => attempt.rowId)),
        resolvedRowIds: new Set(),
      });
    } finally {
      owned.authorizing = false;
    }
  }

  async capture(
    ref: TrackedWorkloadRef,
    deadlineAt = Date.now() + 60_000,
  ): Promise<readonly JobNativeAttempt[]> {
    const owned = this.#require(ref);
    // A failed fresh read must still leave every already-known native identity
    // available in the cleanup failure receipt.
    this.#remember(ref, owned, this.#ledger.observations(ref));
    let attempts: readonly JobNativeAttempt[];
    try {
      attempts = await this.#ledger.read(ref, owned.identity, deadlineAt);
    } finally {
      this.#remember(ref, owned, this.#ledger.observations(ref));
    }
    this.#require(ref);
    this.#remember(ref, owned, [
      ...this.#ledger.observations(ref),
      ...attempts,
    ]);
    const creation = owned.creations.at(-1);
    if (creation) {
      for (const attempt of attempts) {
        if (!creation.baselineRowIds.includes(attempt.rowId))
          creation.resolvedRowIds.add(attempt.rowId);
      }
    }
    return attempts;
  }

  #remember(
    ref: TrackedWorkloadRef,
    owned: OwnedJob,
    attempts: readonly JobNativeAttempt[],
  ): void {
    for (const attempt of attempts) {
      if (
        attempt.ref !== ref ||
        attempt.cloudProvider !== owned.identity.provider ||
        attempt.credentialId !== owned.identity.credentialId
      ) {
        throw new Error(
          `Job ${ref.id} native inventory changed its registered identity`,
        );
      }
      owned.observed.set(attemptKey(attempt), attempt);
    }
  }

  verify(ref: TrackedWorkloadRef, timeoutMs: number): Promise<void> {
    const owned = this.#require(ref);
    validateCleanupBudget(timeoutMs);
    if (owned.checkingGeneration)
      throw new Error(`Job ${ref.id} generation absence is in progress`);
    // Claim before any await. Fallback and explicit finalization share one
    // verifier; neither can restart mutations or replace its captured evidence.
    owned.cleanup ??= Promise.resolve().then(async () => {
      await this.#verify(ref, owned, timeoutMs);
    });
    return owned.cleanup;
  }

  /** Prove a terminal generation absent without claiming final cleanup/release. */
  async generationAbsence(
    ref: TrackedWorkloadRef,
    generation: number,
    timeoutMs: number,
  ): Promise<JobGenerationAbsence> {
    const owned = this.#require(ref);
    validateCleanupBudget(timeoutMs);
    if (
      owned.cleanup ||
      owned.authorizing ||
      owned.checkingGeneration ||
      generation < 1 ||
      generation !== owned.creations.length ||
      owned.checkedGenerations.has(generation)
    )
      throw new Error(
        `Job ${ref.id} generation absence is unavailable or reused`,
      );
    owned.checkedGenerations.add(generation);
    owned.checkingGeneration = true;
    try {
      const attempts = await this.#verify(ref, owned, timeoutMs, generation);
      const record: JobGenerationAbsence = Object.freeze({
        generation,
        [generationAbsenceBrand]: true as const,
      });
      this.#generationAbsences.set(record, {
        ref,
        inventory: JSON.stringify(attempts.map(attemptKey)),
      });
      return record;
    } finally {
      owned.checkingGeneration = false;
    }
  }

  async #verify(
    ref: TrackedWorkloadRef,
    owned: OwnedJob,
    timeoutMs: number,
    generation?: number,
  ): Promise<readonly JobNativeAttempt[]> {
    const startedAt = Date.now();
    let latest: readonly JobNativeAttempt[] = [];
    const observations: VmHostPresenceObservation[] = [];
    let failure: unknown;
    let failed = false;
    let completed = false;
    try {
      await this.#wait.for(
        `all native Job hosts absent for ${ref.id}`,
        async (deadline) => {
          latest = await this.capture(ref, deadline);
          if (
            owned.creations.some(
              (creation) => creation.resolvedRowIds.size === 0,
            )
          ) {
            throw new Error(
              `Job ${ref.id} has an authorized create but unresolved provisioning identity`,
            );
          }
          if (latest.some((attempt) => attempt.endedAt === null))
            return 'live provisioning attempts remain';
          const nativeAttempts = new Map<string, JobNativeAttempt>();
          const reservations = new Map<string, JobNativeAttempt>();
          const history = [...owned.observed.values()];
          for (const attempt of history) {
            if (hasJobNativeCoordinates(attempt))
              nativeAttempts.set(nativeKey(attempt), attempt);
            else if (owned.native.reservations && isReservation(attempt))
              reservations.set(nativeKey(attempt), attempt);
            else if (!hasRecordedRefinement(attempt, history))
              throw new Error(
                `Job ${ref.id} retains an unresolved native provisioning identity`,
              );
          }
          let reservationsAbsent = true;
          if (reservations.size > 0) {
            const reader = owned.native.reservations!;
            const requested = [...reservations.values()];
            const observedAt = Date.now();
            const retain = (observation: VmReservationPresenceObservation) => {
              retainReservationObservation(
                owned,
                requested,
                observation,
                observedAt,
                deadline,
              );
            };
            const observation = await reader.observe(
              requested,
              deadline,
              retain,
            );
            retain(observation);
            // Complete empty inventories need the shared observer's stability
            // proof. Matches instead require exact native-ID absence below;
            // terminated AWS instances can remain in client-token inventories.
            reservationsAbsent =
              observation.inventory?.complete === true &&
              observation.attempts.every(
                (attempt) =>
                  attempt.instanceIds.length > 0 ||
                  attempt.presence === 'absent',
              );
          }
          const current: VmHostPresenceObservation[] = [];
          const observe = async (
            location: VmHostLocation,
            read: (timeoutMs: number) => Promise<VmHostPresenceObservation>,
          ) => {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0)
              throw new CleanupDeadlineExpired(
                `Job ${ref.id} native cleanup deadline expired`,
              );
            const observation = await read(Math.min(60_000, remainingMs));
            if (
              observation.cloudId !== location.cloudId ||
              observation.provider !== owned.identity.provider ||
              !['absent', 'present', 'unknown'].includes(observation.presence)
            ) {
              throw new Error(
                `Job ${ref.id} received native absence for a different host`,
              );
            }
            current.push(observation);
            observations.push(observation);
          };
          for (const attempt of nativeAttempts.values()) {
            await observe(attempt, (remainingMs) =>
              owned.native.observe(attempt, remainingMs, deadline),
            );
          }
          // Keep matches independently of database adoption and later inventory
          // omissions. They never resolve a
          // creation or substitute for a later generation's fresh attempt row.
          const checkedMatches = new Set<string>();
          for (const { location } of owned.reservationMatches.values()) {
            const key = reservationKey(location);
            if (checkedMatches.has(key)) continue;
            checkedMatches.add(key);
            await observe(location, (remainingMs) =>
              owned.native.reservations!.observeMatch(
                location,
                remainingMs,
                deadline,
              ),
            );
          }
          if (Date.now() >= deadline)
            throw new CleanupDeadlineExpired(
              `Job ${ref.id} native cleanup deadline expired`,
            );
          if (!reservationsAbsent)
            return 'original reservation inventory is not absent';
          return current.every(
            (observation) => observation.presence === 'absent',
          )
            ? undefined
            : current
                .map(
                  (observation) =>
                    `${observation.cloudId}: ${observation.presence}`,
                )
                .join(', ');
        },
        {
          timeoutMs,
          intervalMs: Math.min(2_000, timeoutMs),
          probeError: {
            retry: (error) => error instanceof CleanupDeadlineExpired,
          },
          unmet: (unmet) => unmet,
        },
      );
      this.#require(ref);
      completed = true;
    } catch (error) {
      failure = error;
      failed = true;
    }
    try {
      await this.#artifacts.json(
        generation === undefined
          ? `job-${ref.id}-native-cleanup`
          : `job-${ref.id}-generation-${generation}-native-absence`,
        {
          kind:
            generation === undefined
              ? 'job-native-cleanup'
              : 'job-generation-absence',
          ...(generation === undefined ? {} : { generation }),
          workloadId: ref.id,
          startedAt,
          completedAt: Date.now(),
          authorizedCreates: owned.creations.length,
          creations: owned.creations.map((creation) => ({
            ordinal: creation.ordinal,
            startedAt: creation.startedAt,
            baselineRowIds: creation.baselineRowIds,
            resolvedRowIds: [...creation.resolvedRowIds],
          })),
          originalIdentity: owned.identity,
          authorizationBindings: authorizationBindings(owned),
          attemptHistory: [...owned.observed.values()],
          reservationObservations: [...owned.reservationObservations],
          reservationMatches: [...owned.reservationMatches.values()],
          currentAttempts: latest,
          observations,
          completed,
          ...(!failed
            ? {}
            : {
                failure:
                  failure instanceof Error
                    ? failure.message
                    : 'Non-Error cleanup failure',
              }),
        },
      );
    } catch (artifactError) {
      if (failed)
        throw new AggregateError(
          [failure, artifactError],
          'Job native cleanup and its failure record both failed',
        );
      throw artifactError;
    }
    if (failed) throw failure;
    return latest;
  }

  /** Retain registered intent/history even if product cleanup never reached verification. */
  async recordObservations(): Promise<void> {
    for (const [ref, owned] of this.#owned) {
      await this.#artifacts.json(`job-${ref.id}-attempt-history`, {
        kind: 'job-attempt-history',
        workloadId: ref.id,
        originalIdentity: owned.identity,
        authorizationBindings: authorizationBindings(owned),
        attemptHistory: [...owned.observed.values()],
        reservationObservations: [...owned.reservationObservations],
        reservationMatches: [...owned.reservationMatches.values()],
        creations: owned.creations.map((creation) => ({
          ordinal: creation.ordinal,
          startedAt: creation.startedAt,
          baselineRowIds: creation.baselineRowIds,
          resolvedRowIds: [...creation.resolvedRowIds],
        })),
      });
    }
  }

  #require(ref: TrackedWorkloadRef): OwnedJob {
    this.#kernel.assertActive(ref);
    const owned = this.#owned.get(ref);
    if (!owned)
      throw new Error(
        `Job ${ref.id} has no original native cleanup registration`,
      );
    return owned;
  }
}
