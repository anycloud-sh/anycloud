import path from 'node:path';

import { type WorkloadEvent } from '../../../../src/shared/api-contract/workload-management-schemas.js';
import { WorkloadState } from '../../../../src/shared/workload.js';

import type { ApiClient } from './api.js';
import type { CleanupRegistration, CleanupStack } from './cleanup.js';
import { CleanupManifest } from './cleanup-manifest.js';
import type { CliClient } from './cli.js';
import { cliArgs } from './cli-surface.js';
import type { StatusResponse } from './types.js';
import { isRecord } from './types.js';
import type { Waiter } from './wait.js';

const trackedWorkloadBrand: unique symbol = Symbol('TrackedWorkloadRef');
const cleanupRecordedBrand: unique symbol = Symbol('CleanupRecorded');
const ledgerClearedBrand: unique symbol = Symbol('VmLedgerCleared');
const substrateAbsentBrand: unique symbol = Symbol('SubstrateAbsent');

export type TrackedWorkloadRef = Readonly<{
  readonly id: string;
  readonly [trackedWorkloadBrand]: true;
}>;

export type CleanupRecorded = Readonly<{
  readonly ref: TrackedWorkloadRef;
  readonly status: StatusResponse;
  readonly [cleanupRecordedBrand]: true;
}>;

export type VmLedgerCleared = Readonly<{
  readonly ref: TrackedWorkloadRef;
  readonly [ledgerClearedBrand]: true;
}>;

export type SubstrateAbsent = Readonly<{
  readonly ref: TrackedWorkloadRef;
  readonly [substrateAbsentBrand]: true;
}>;

/**
 * The three observations invariant 12 keeps separate. Requiring all of them to
 * release fallback cleanup is what stops one standing in for another: a
 * contract that forgets the ledger or the substrate no longer compiles, rather
 * than releasing on a persisted record alone.
 */
export interface WorkloadReleaseEvidence {
  readonly cleanup: CleanupRecorded;
  readonly ledger: VmLedgerCleared;
  readonly substrate: SubstrateAbsent;
}

interface TrackedWorkload {
  readonly controller: ApiClient['controller'] | undefined;
  readonly cleanupTimeoutMs: number;
  readonly ref: TrackedWorkloadRef;
  readonly registration: CleanupRegistration;
  readonly requiresCleanupVerification: boolean;
  generation: number;
  fallbackVerificationStarted: boolean;
  releaseInFlight: Promise<void> | undefined;
}

interface CleanupProofMetadata {
  readonly kind: 'cleanup' | 'substrate';
  readonly generation: number;
  readonly ref: TrackedWorkloadRef;
}

type WorkloadStatusClient = Pick<ApiClient, 'lookupStatus'> &
  Partial<Pick<ApiClient, 'controller'>>;

interface WorkloadCleanupDependencies {
  readonly api: WorkloadStatusClient;
  readonly cli: Pick<CliClient, 'run'>;
  readonly wait: Pick<Waiter, 'for'>;
}

const TERMINAL_FAILURE_STATES = new Set([
  WorkloadState.Errored,
  WorkloadState.Failed,
  WorkloadState.Invalid,
]);

const FALLBACK_TERMINAL_STATES = new Set([
  ...TERMINAL_FAILURE_STATES,
  WorkloadState.Completed,
  WorkloadState.Terminated,
]);

function fixtureSafeId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) {
    throw new Error(`Workload ID is not fixture-safe: ${id}`);
  }
}

function assertOriginalController(
  client: WorkloadStatusClient,
  original: ApiClient['controller'],
): void {
  const current = client.controller;
  if (
    !current ||
    current.url !== original.url ||
    current.generation !== original.generation
  )
    throw new Error('Workload requires its original controller');
}

function statusBody(id: string, body: StatusResponse): StatusResponse {
  if (body.workload.id !== id) {
    throw new Error(
      `Status response for ${id} identified workload ${body.workload.id}`,
    );
  }
  return body;
}

export interface WorkloadKernel {
  reserve(id: string, cleanupTimeoutMs: number): Promise<TrackedWorkloadRef>;
  status(ref: TrackedWorkloadRef, verbose?: boolean): Promise<StatusResponse>;
  eventsSince(
    ref: TrackedWorkloadRef,
    baseline: number,
  ): Promise<readonly WorkloadEvent[]>;
  waitForState(
    ref: TrackedWorkloadRef,
    targetState: WorkloadState,
    timeoutMs: number,
  ): Promise<StatusResponse>;
  requestTermination(ref: TrackedWorkloadRef, timeoutMs: number): Promise<void>;
  waitForCleanupRecorded(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<CleanupRecorded>;
  recordLedgerCleared(
    ref: TrackedWorkloadRef,
    liveVmCount: number,
  ): VmLedgerCleared;
  recordSubstrateAbsence(ref: TrackedWorkloadRef): SubstrateAbsent;
  release(evidence: WorkloadReleaseEvidence): Promise<void>;
}

export class TrackedWorkloadKernel implements WorkloadKernel {
  readonly #api: WorkloadStatusClient;
  readonly #cli: Pick<CliClient, 'run'>;
  readonly #cleanup: CleanupStack;
  readonly #cleanupApi: WorkloadStatusClient;
  readonly #cleanupCli: Pick<CliClient, 'run'>;
  readonly #cleanupWait: Pick<Waiter, 'for'>;
  readonly #wait: Pick<Waiter, 'for'>;
  readonly #manifest: CleanupManifest;
  readonly #tracked = new Map<string, TrackedWorkload>();
  readonly #proofs = new WeakMap<object, CleanupProofMetadata>();
  readonly #usedProofs = new WeakSet<object>();

  constructor(
    api: WorkloadStatusClient,
    cli: Pick<CliClient, 'run'>,
    cleanup: CleanupStack,
    wait: Pick<Waiter, 'for'>,
    resultsDirectory: string | undefined,
    cleanupDependencies: WorkloadCleanupDependencies = { api, cli, wait },
  ) {
    this.#api = api;
    this.#cli = cli;
    this.#cleanup = cleanup;
    this.#cleanupApi = cleanupDependencies.api;
    this.#cleanupCli = cleanupDependencies.cli;
    this.#cleanupWait = cleanupDependencies.wait;
    this.#wait = wait;
    this.#manifest = new CleanupManifest(
      resultsDirectory
        ? path.join(resultsDirectory, 'workloads-to-clean')
        : undefined,
    );
  }

  reserve(id: string, cleanupTimeoutMs: number): Promise<TrackedWorkloadRef> {
    return this.#reserve(id, cleanupTimeoutMs);
  }

  /**
   * Private fixture composition registers a native cleanup requirement before
   * the reference can authorize creation. Contracts cannot install, replace or
   * bypass it through the outcome-neutral WorkloadKernel interface.
   */
  reserveWithCleanupVerification(
    id: string,
    cleanupTimeoutMs: number,
    verify: (ref: TrackedWorkloadRef, timeoutMs: number) => Promise<void>,
    controller?: ApiClient['controller'],
  ): Promise<TrackedWorkloadRef> {
    if (typeof verify !== 'function') {
      throw new Error('Workload cleanup verification must be a function');
    }
    return this.#reserve(id, cleanupTimeoutMs, verify, controller);
  }

  async #reserve(
    id: string,
    cleanupTimeoutMs: number,
    verify?: (ref: TrackedWorkloadRef, timeoutMs: number) => Promise<void>,
    controller?: ApiClient['controller'],
  ): Promise<TrackedWorkloadRef> {
    fixtureSafeId(id);
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
      throw new Error('Workload cleanup timeout must be a positive integer');
    }
    if (this.#tracked.has(id)) {
      throw new Error(`Workload is already registered for cleanup: ${id}`);
    }
    const originalController =
      controller === undefined
        ? undefined
        : Object.freeze({
            url: controller.url,
            generation: controller.generation,
          });
    if (originalController) {
      if (
        !originalController.url.trim() ||
        !Number.isSafeInteger(originalController.generation) ||
        originalController.generation < 0
      )
        throw new Error('Workload controller binding is invalid');
      assertOriginalController(this.#api, originalController);
      assertOriginalController(this.#cleanupApi, originalController);
    }

    const ref = Object.freeze({
      id,
      [trackedWorkloadBrand]: true as const,
    });
    const registration = this.#cleanup.defer(`workload ${id}`, async () => {
      const tracked = this.#tracked.get(id);
      if (!tracked || tracked.ref !== ref) {
        throw new Error(`Workload cleanup reference is inactive: ${id}`);
      }
      // An explicit release already owns all three proofs. Join that operation
      // instead of starting a verifier which could lose tracking beneath it.
      if (verify && tracked.releaseInFlight) {
        await tracked.releaseInFlight;
        return;
      }
      const generation = tracked.generation;
      // Only opted-in reservations acquire this fence. Existing families keep
      // their reviewed fallback behavior until their own cleanup owners opt in.
      if (verify) tracked.fallbackVerificationStarted = true;
      await this.#fallbackCleanup(ref, cleanupTimeoutMs);
      if (verify) {
        await verify(ref, cleanupTimeoutMs);
        if (
          this.#tracked.get(id) !== tracked ||
          tracked.ref !== ref ||
          tracked.generation !== generation
        ) {
          throw new Error(
            `Workload changed during cleanup verification: ${id}`,
          );
        }
      }
      this.#assertController(ref, true);
      await this.#manifest.remove(id);
      this.#tracked.delete(id);
    });
    this.#tracked.set(id, {
      controller: originalController,
      cleanupTimeoutMs,
      requiresCleanupVerification: verify !== undefined,
      generation: 0,
      fallbackVerificationStarted: false,
      releaseInFlight: undefined,
      ref,
      registration,
    });
    try {
      await this.#manifest.add(id);
    } catch (error) {
      registration.complete();
      this.#tracked.delete(id);
      throw error;
    }
    return ref;
  }

  assertActive(ref: TrackedWorkloadRef): void {
    const candidate: unknown = ref;
    const id =
      isRecord(candidate) && typeof candidate.id === 'string'
        ? candidate.id
        : '<invalid>';
    const tracked = this.#tracked.get(id);
    if (!tracked || tracked.ref !== ref) {
      throw new Error(
        `Workload reference is forged, stale, or released: ${id}`,
      );
    }
  }

  activeReference(id: string): TrackedWorkloadRef | undefined {
    return this.#tracked.get(id)?.ref;
  }

  trackedWorkloadIds(): readonly string[] {
    return [...this.#tracked.keys()];
  }

  authorizeMutation(ref: TrackedWorkloadRef, outgoingId: string): void {
    this.assertActive(ref);
    this.#assertController(ref);
    if (outgoingId !== ref.id) {
      throw new Error(
        `Tracked workload ${ref.id} cannot authorize mutation of ${outgoingId}`,
      );
    }
    const tracked = this.#tracked.get(ref.id);
    if (!tracked) throw new Error(`Workload reference is inactive: ${ref.id}`);
    if (tracked.fallbackVerificationStarted) {
      throw new Error(`Workload cleanup verification has started: ${ref.id}`);
    }
    if (tracked.releaseInFlight) {
      throw new Error(`Workload release has started: ${ref.id}`);
    }
    tracked.generation += 1;
  }

  async status(
    ref: TrackedWorkloadRef,
    verbose = false,
  ): Promise<StatusResponse> {
    this.assertActive(ref);
    this.#assertController(ref);
    const lookup = await this.#api.lookupStatus(ref.id, verbose);
    this.#assertController(ref);
    if (lookup.kind === 'absent') {
      throw new Error(`Workload ${ref.id} was not found`);
    }
    return statusBody(ref.id, lookup.status);
  }

  async eventsSince(
    ref: TrackedWorkloadRef,
    baseline: number,
  ): Promise<readonly WorkloadEvent[]> {
    const status = await this.status(ref, true);
    return status.events.filter((event) => event.createdAt > baseline);
  }

  async waitForState(
    ref: TrackedWorkloadRef,
    targetState: WorkloadState,
    timeoutMs: number,
  ): Promise<StatusResponse> {
    this.assertActive(ref);
    const observed = await this.#wait.for<StatusResponse | undefined>(
      `workload ${ref.id} to reach ${targetState}`,
      async () => {
        this.assertActive(ref);
        this.#assertController(ref);
        const lookup = await this.#api.lookupStatus(ref.id, false);
        this.#assertController(ref);
        return lookup.kind === 'absent'
          ? undefined
          : statusBody(ref.id, lookup.status);
      },
      {
        timeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (status) =>
          status?.workload.state === targetState
            ? undefined
            : (status?.workload.state ?? 'not found'),
        reject: (status) => {
          if (!status) return undefined;
          const state = status.workload.state;
          return TERMINAL_FAILURE_STATES.has(state) && state !== targetState
            ? `reached terminal state ${state}`
            : undefined;
        },
      },
    );
    this.#assertController(ref);
    if (!observed || observed.workload.state !== targetState) {
      throw new Error(
        `Workload ${ref.id} did not produce an observed ${targetState} state`,
      );
    }
    return observed;
  }

  async requestTermination(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<void> {
    this.assertActive(ref);
    await this.#sendTermination(ref, timeoutMs, false);
  }

  async waitForCleanupRecorded(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<CleanupRecorded> {
    this.assertActive(ref);
    const status = await this.#wait.for<StatusResponse | undefined>(
      `persisted cleanup for workload ${ref.id}`,
      async () => {
        this.assertActive(ref);
        this.#assertController(ref);
        const lookup = await this.#api.lookupStatus(ref.id, true);
        this.#assertController(ref);
        return lookup.kind === 'absent'
          ? undefined
          : statusBody(ref.id, lookup.status);
      },
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (candidate) =>
          typeof candidate?.workload.cleanedAt === 'number'
            ? undefined
            : candidate
              ? `${candidate.workload.state}, cleanup pending`
              : 'not found',
      },
    );
    this.#assertController(ref);
    if (!status || typeof status.workload.cleanedAt !== 'number') {
      throw new Error(
        `Workload ${ref.id} did not produce a persisted cleanup record`,
      );
    }

    const tracked = this.#tracked.get(ref.id);
    if (!tracked || tracked.ref !== ref) {
      throw new Error(`Workload reference became inactive: ${ref.id}`);
    }
    const proof = Object.freeze({
      ref,
      status,
      [cleanupRecordedBrand]: true as const,
    });
    this.#proofs.set(proof, {
      kind: 'cleanup',
      generation: tracked.generation,
      ref,
    });
    return proof;
  }

  /**
   * Minted from the observed row count rather than asserted, so the value
   * cannot exist without the query that produced it.
   */
  recordLedgerCleared(
    ref: TrackedWorkloadRef,
    liveVmCount: number,
  ): VmLedgerCleared {
    this.assertActive(ref);
    if (liveVmCount !== 0) {
      throw new Error(
        `Workload ${ref.id} still has ${String(liveVmCount)} live VM rows`,
      );
    }
    return Object.freeze({ ref, [ledgerClearedBrand]: true as const });
  }

  recordSubstrateAbsence(ref: TrackedWorkloadRef): SubstrateAbsent {
    this.assertActive(ref);
    const proof = Object.freeze({ ref, [substrateAbsentBrand]: true as const });
    this.#proofs.set(proof, {
      kind: 'substrate',
      ref,
      generation: this.#tracked.get(ref.id)!.generation,
    });
    return proof;
  }

  /** Rejected admission has no persisted row from which to obtain cleanedAt. */
  async releaseUncreated(
    ref: TrackedWorkloadRef,
    substrate: SubstrateAbsent,
  ): Promise<void> {
    this.assertActive(ref);
    const tracked = this.#tracked.get(ref.id)!;
    const metadata = this.#proofs.get(substrate);
    if (
      !metadata ||
      metadata.kind !== 'substrate' ||
      metadata.ref !== ref ||
      substrate.ref !== ref ||
      metadata.generation !== tracked.generation ||
      tracked.generation !== 1 ||
      !tracked.controller ||
      !tracked.requiresCleanupVerification ||
      this.#usedProofs.has(substrate)
    )
      throw new Error('Uncreated Workload requires its original native proof');
    if (tracked.fallbackVerificationStarted || tracked.releaseInFlight)
      throw new Error(`Workload cleanup or release has started: ${ref.id}`);
    // Claim before yielding, so fallback cannot discard this reference during
    // the final same-controller API read or manifest write.
    const release = Promise.resolve().then(async () => {
      this.#assertController(ref);
      const lookup = await this.#api.lookupStatus(ref.id, true);
      this.#assertController(ref);
      if (lookup.kind !== 'absent')
        throw new Error(`Rejected Workload still has an API record: ${ref.id}`);
      if (
        this.#tracked.get(ref.id) !== tracked ||
        tracked.generation !== metadata.generation
      )
        throw new Error(`Uncreated Workload changed before release: ${ref.id}`);
      await this.#commitRelease(tracked, metadata, substrate);
    });
    tracked.releaseInFlight = release;
    await release;
  }

  async release(evidence: WorkloadReleaseEvidence): Promise<void> {
    const { cleanup, ledger, substrate } = evidence;
    for (const [name, proof] of [
      ['VM-ledger', ledger],
      ['substrate absence', substrate],
    ] as const) {
      if (proof.ref !== cleanup.ref) {
        throw new Error(
          `Workload release evidence mixes workloads: ${name} proof does not belong to ${cleanup.ref.id}`,
        );
      }
    }
    const candidate: unknown = cleanup;
    if (!isRecord(candidate)) {
      throw new Error(
        'Persisted cleanup proof was forged or belongs elsewhere',
      );
    }
    const proof = candidate;
    if (this.#usedProofs.has(proof)) {
      throw new Error('Persisted cleanup proof was already used');
    }
    const metadata = this.#proofs.get(proof);
    if (!metadata || metadata.kind !== 'cleanup') {
      throw new Error(
        'Persisted cleanup proof was forged or belongs elsewhere',
      );
    }
    const tracked = this.#tracked.get(metadata.ref.id);
    if (!tracked || tracked.ref !== metadata.ref) {
      throw new Error(
        `Persisted cleanup proof refers to an inactive workload: ${metadata.ref.id}`,
      );
    }
    this.#assertController(metadata.ref);
    if (tracked.fallbackVerificationStarted) {
      throw new Error(
        `Workload cleanup verification has started: ${metadata.ref.id}`,
      );
    }
    if (tracked.releaseInFlight) {
      throw new Error(`Workload release has started: ${metadata.ref.id}`);
    }
    if (tracked.generation !== metadata.generation) {
      throw new Error(
        `Persisted cleanup proof is stale for workload ${metadata.ref.id}`,
      );
    }

    if (tracked.requiresCleanupVerification) {
      // Claim ownership synchronously, before either asynchronous path can
      // resume. Failed writes leave this rejected operation and tracking intact.
      const release = Promise.resolve().then(() =>
        this.#commitRelease(tracked, metadata, proof),
      );
      tracked.releaseInFlight = release;
      await release;
      return;
    }
    await this.#commitRelease(tracked, metadata, proof);
  }

  async #commitRelease(
    tracked: TrackedWorkload,
    metadata: CleanupProofMetadata,
    proof: object,
  ): Promise<void> {
    this.#assertController(metadata.ref);
    await this.#manifest.remove(metadata.ref.id);
    tracked.registration.complete();
    this.#tracked.delete(metadata.ref.id);
    this.#proofs.delete(proof);
    this.#usedProofs.add(proof);
  }

  async #fallbackCleanup(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<void> {
    this.assertActive(ref);
    await this.#sendTermination(ref, timeoutMs, true);
    await this.#cleanupWait.for<StatusResponse | 'absent'>(
      `fallback cleanup for workload ${ref.id}`,
      async () => {
        this.#assertController(ref, true);
        const lookup = await this.#cleanupApi.lookupStatus(ref.id, true);
        this.#assertController(ref, true);
        return lookup.kind === 'absent'
          ? 'absent'
          : statusBody(ref.id, lookup.status);
      },
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (candidate) =>
          candidate === 'absent' ||
          typeof candidate.workload.cleanedAt === 'number'
            ? undefined
            : `${candidate.workload.state}, cleanup pending`,
      },
    );
  }

  async #sendTermination(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
    fallback: boolean,
  ): Promise<void> {
    const cli = fallback ? this.#cleanupCli : this.#cli;
    const api = fallback ? this.#cleanupApi : this.#api;
    const { id } = ref;
    this.#assertController(ref, fallback);
    const termination = await cli.run(cliArgs('terminate', {}, [id]), {
      timeoutMs: Math.min(timeoutMs, 120_000),
      label: `terminate-${id}`,
    });
    this.#assertController(ref, fallback);
    if (!termination.timedOut && termination.exitCode === 0) return;

    const lookup = await api.lookupStatus(id, false);
    this.#assertController(ref, fallback);
    if (lookup.kind === 'absent') return;
    const status = statusBody(id, lookup.status);
    if (
      status.workload.state === WorkloadState.Terminated ||
      (fallback && FALLBACK_TERMINAL_STATES.has(status.workload.state))
    ) {
      return;
    }
    throw new Error(
      `Terminate failed for ${id} (exit ${String(termination.exitCode)}, timeout ${String(termination.timedOut)}): ${termination.combined}`,
    );
  }

  #assertController(ref: TrackedWorkloadRef, fallback = false): void {
    const tracked = this.#tracked.get(ref.id);
    const original = tracked?.ref === ref ? tracked.controller : undefined;
    if (original)
      assertOriginalController(
        fallback ? this.#cleanupApi : this.#api,
        original,
      );
  }
}
