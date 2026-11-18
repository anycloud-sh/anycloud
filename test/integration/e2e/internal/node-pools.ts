import path from 'node:path';

import { WorkloadState } from '../../../../src/shared/workload.js';
import type { DeploymentSummary } from '../../../../src/shared/api-contract/deployments-schemas.js';

import type { ApiClient } from './api.js';
import type { CleanupRegistration, CleanupStack } from './cleanup.js';
import { CleanupManifest } from './cleanup-manifest.js';
import type { NodePoolStatusLookup, NodePoolSummary } from './types.js';
import { errorMessage, isRecord } from './types.js';
import type { Waiter } from './wait.js';

const trackedNodePoolBrand: unique symbol = Symbol('TrackedNodePoolRef');
const nodePoolDeletionRecordedBrand: unique symbol = Symbol(
  'NodePoolDeletionRecorded',
);

export type TrackedNodePoolRef = Readonly<{
  readonly name: string;
  readonly [trackedNodePoolBrand]: true;
}>;

export type NodePoolDeletionRecorded = Readonly<{
  readonly ref: TrackedNodePoolRef;
  readonly nodePool: NodePoolSummary;
  readonly [nodePoolDeletionRecordedBrand]: true;
}>;

interface TrackedNodePool {
  readonly deployments: Set<object>;
  readonly ref: TrackedNodePoolRef;
  readonly registration: CleanupRegistration;
  createAuthorized: boolean;
  generation: number;
  id?: string;
}

interface NodePoolDeletionProofMetadata {
  readonly generation: number;
  readonly id: string;
  readonly ref: TrackedNodePoolRef;
}

interface NodePoolCleanupDependencies {
  readonly api: Pick<
    ApiClient,
    | 'deleteNodePool'
    | 'listNodePools'
    | 'lookupNodePool'
    | 'listDeployments'
    | 'deleteDeployment'
  >;
  readonly wait: Pick<Waiter, 'for'>;
}

function fixtureSafeName(name: string): void {
  if (name.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
    throw new Error(`Node pool name is not fixture-safe: ${name}`);
  }
}

function nodePoolIdentity(
  expectedName: string,
  nodePool: NodePoolSummary,
  expectedId?: string,
): NodePoolSummary {
  if (nodePool.name !== expectedName) {
    throw new Error(
      `Node pool response for ${expectedName} identified nodePool name ${nodePool.name}`,
    );
  }
  if (expectedId && nodePool.id !== expectedId) {
    throw new Error(
      `Node pool response for ${expectedName} identified nodePool ID ${nodePool.id}, expected ${expectedId}`,
    );
  }
  return nodePool;
}

/** A terminated pool is deleted once its VMs are released. */
function isDeleted(nodePool: NodePoolSummary): boolean {
  return reached(nodePool, WorkloadState.Terminated);
}

function reached(
  nodePool: NodePoolSummary,
  state: NodePoolSummary['state'],
): boolean {
  return nodePool.state === state && !nodePool.releasing;
}

export interface NodePoolKernel {
  assertActive(ref: TrackedNodePoolRef): void;
  boundId(ref: TrackedNodePoolRef): string;
  reserve(name: string, cleanupTimeoutMs: number): Promise<TrackedNodePoolRef>;
  resolveCreated(ref: TrackedNodePoolRef): Promise<NodePoolSummary>;
  status(ref: TrackedNodePoolRef): Promise<NodePoolSummary>;
  waitForState(
    ref: TrackedNodePoolRef,
    state: NodePoolSummary['state'],
    timeoutMs: number,
  ): Promise<NodePoolSummary>;
  waitForDeletionRecorded(
    ref: TrackedNodePoolRef,
    timeoutMs: number,
  ): Promise<NodePoolDeletionRecorded>;
  registerDeployment(ref: TrackedNodePoolRef, deployment: object): void;
  unregisterDeployment(ref: TrackedNodePoolRef, deployment: object): void;
  release(deletion: NodePoolDeletionRecorded): Promise<void>;
}

export class TrackedNodePoolKernel implements NodePoolKernel {
  readonly #api: Pick<ApiClient, 'listNodePools' | 'lookupNodePool'>;
  readonly #cleanup: CleanupStack;
  readonly #cleanupApi: NodePoolCleanupDependencies['api'];
  readonly #cleanupWait: Pick<Waiter, 'for'>;
  readonly #manifest: CleanupManifest;
  readonly #proofs = new WeakMap<object, NodePoolDeletionProofMetadata>();
  readonly #tracked = new Map<string, TrackedNodePool>();
  readonly #usedProofs = new WeakSet<object>();
  readonly #wait: Pick<Waiter, 'for'>;

  constructor(
    api: Pick<ApiClient, 'listNodePools' | 'lookupNodePool'>,
    cleanup: CleanupStack,
    wait: Pick<Waiter, 'for'>,
    resultsDirectory: string | undefined,
    cleanupDependencies: NodePoolCleanupDependencies,
  ) {
    this.#api = api;
    this.#cleanup = cleanup;
    this.#cleanupApi = cleanupDependencies.api;
    this.#cleanupWait = cleanupDependencies.wait;
    this.#wait = wait;
    this.#manifest = new CleanupManifest(
      resultsDirectory
        ? path.join(resultsDirectory, 'node-pools-to-clean')
        : undefined,
    );
  }

  async reserve(
    name: string,
    cleanupTimeoutMs: number,
  ): Promise<TrackedNodePoolRef> {
    fixtureSafeName(name);
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
      throw new Error('Node pool cleanup timeout must be a positive integer');
    }
    if (this.#tracked.has(name)) {
      throw new Error(`Node pool is already registered for cleanup: ${name}`);
    }

    const ref = Object.freeze({
      name,
      [trackedNodePoolBrand]: true as const,
    });
    const registration = this.#cleanup.defer(`node pool ${name}`, async () => {
      await this.#fallbackCleanup(ref, cleanupTimeoutMs);
      const tracked = this.#active(ref);
      // The Node pool backstop can reduce leaks without proving child cleanup.
      if (tracked.deployments.size > 0) {
        throw new Error(
          `Node pool ${name} still has ${String(tracked.deployments.size)} tracked Deployment children`,
        );
      }
      await this.#manifest.remove(name);
      this.#tracked.delete(name);
    });
    this.#tracked.set(name, {
      createAuthorized: false,
      deployments: new Set(),
      generation: 0,
      ref,
      registration,
    });
    try {
      await this.#manifest.add(name);
    } catch (error) {
      registration.complete();
      this.#tracked.delete(name);
      throw error;
    }
    return ref;
  }

  assertActive(ref: TrackedNodePoolRef): void {
    const candidate: unknown = ref;
    const name =
      isRecord(candidate) && typeof candidate.name === 'string'
        ? candidate.name
        : '<invalid>';
    const tracked = this.#tracked.get(name);
    if (!tracked || tracked.ref !== ref) {
      throw new Error(
        `Node pool reference is forged, stale, or released: ${name}`,
      );
    }
  }

  authorizeCreate(ref: TrackedNodePoolRef, outgoingName: string): void {
    const tracked = this.#active(ref);
    if (outgoingName !== ref.name) {
      throw new Error(
        `Tracked node pool ${ref.name} cannot authorize creation of ${outgoingName}`,
      );
    }
    if (tracked.createAuthorized) {
      throw new Error(`Node pool creation was already authorized: ${ref.name}`);
    }
    tracked.createAuthorized = true;
    tracked.generation += 1;
  }

  registerDeployment(ref: TrackedNodePoolRef, deployment: object): void {
    const tracked = this.#active(ref);
    if (tracked.deployments.has(deployment)) {
      throw new Error(
        `Deployment is already registered against node pool ${ref.name}`,
      );
    }
    tracked.deployments.add(deployment);
    tracked.generation += 1;
  }

  unregisterDeployment(ref: TrackedNodePoolRef, deployment: object): void {
    const tracked = this.#active(ref);
    if (!tracked.deployments.delete(deployment)) {
      throw new Error(
        `Deployment is not registered against node pool ${ref.name}`,
      );
    }
    tracked.generation += 1;
  }

  bindCreated(
    ref: TrackedNodePoolRef,
    nodePool: NodePoolSummary,
  ): NodePoolSummary {
    const tracked = this.#active(ref);
    if (!tracked.createAuthorized) {
      throw new Error(`Node pool creation was not authorized: ${ref.name}`);
    }
    return this.#bind(tracked, nodePool);
  }

  async resolveCreated(ref: TrackedNodePoolRef): Promise<NodePoolSummary> {
    const tracked = this.#active(ref);
    if (!tracked.createAuthorized) {
      throw new Error(`Node pool creation was not authorized: ${ref.name}`);
    }
    const matches = (await this.#api.listNodePools()).filter(
      (nodePool) => nodePool.name === ref.name,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Node pool ${ref.name} resolved to ${matches.length} active records; expected exactly one`,
      );
    }
    const nodePool = matches[0];
    if (!nodePool) throw new Error(`Node pool ${ref.name} was not found`);
    return this.#bind(tracked, nodePool);
  }

  boundId(ref: TrackedNodePoolRef): string {
    const tracked = this.#active(ref);
    if (!tracked.id) {
      throw new Error(
        `Node pool reference is not bound to a server ID: ${ref.name}`,
      );
    }
    return tracked.id;
  }

  authorizeDeletion(ref: TrackedNodePoolRef, outgoingId: string): void {
    const tracked = this.#active(ref);
    if (!tracked.id) {
      throw new Error(
        `Node pool reference is not bound to a server ID: ${ref.name}`,
      );
    }
    if (outgoingId !== tracked.id) {
      throw new Error(
        `Tracked node pool ${ref.name} (${tracked.id}) cannot authorize deletion of ${outgoingId}`,
      );
    }
    tracked.generation += 1;
  }

  validateBoundNodePool(
    ref: TrackedNodePoolRef,
    nodePool: NodePoolSummary,
  ): NodePoolSummary {
    return nodePoolIdentity(ref.name, nodePool, this.boundId(ref));
  }

  async status(ref: TrackedNodePoolRef): Promise<NodePoolSummary> {
    const id = this.boundId(ref);
    const lookup = await this.#api.lookupNodePool(id);
    if (lookup.kind === 'absent') {
      throw new Error(`Node pool ${ref.name} (${id}) was not found`);
    }
    return nodePoolIdentity(ref.name, lookup.nodePool, id);
  }

  async waitForState(
    ref: TrackedNodePoolRef,
    targetState: NodePoolSummary['state'],
    timeoutMs: number,
  ): Promise<NodePoolSummary> {
    const id = this.boundId(ref);
    const observed = await this.#wait.for<NodePoolStatusLookup>(
      `node pool ${ref.name} (${id}) to reach ${targetState}`,
      async () => {
        this.assertActive(ref);
        const lookup = await this.#api.lookupNodePool(id);
        if (lookup.kind === 'found') {
          nodePoolIdentity(ref.name, lookup.nodePool, id);
        }
        return lookup;
      },
      {
        timeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (lookup) => {
          if (lookup.kind !== 'found') return 'not found';
          if (reached(lookup.nodePool, targetState)) return undefined;
          return lookup.nodePool.lastError
            ? `${lookup.nodePool.state}: ${lookup.nodePool.lastError}`
            : lookup.nodePool.state;
        },
        // The controller retries failed node pools and may move them back
        // to running. Deleted is the only irreversible state; a read by id
        // still returns the deleted row, only name lookups hide it.
        reject: (lookup) =>
          lookup.kind === 'found' &&
          isDeleted(lookup.nodePool) &&
          targetState !== WorkloadState.Terminated
            ? 'reached terminal state terminated'
            : undefined,
      },
    );
    if (observed.kind !== 'found' || !reached(observed.nodePool, targetState)) {
      throw new Error(
        `Node pool ${ref.name} did not produce an observed ${targetState} state`,
      );
    }
    return observed.nodePool;
  }

  /** The durable deleted row read by id is the deletion record. */
  async waitForDeletionRecorded(
    ref: TrackedNodePoolRef,
    timeoutMs: number,
  ): Promise<NodePoolDeletionRecorded> {
    const nodePool = await this.waitForState(
      ref,
      WorkloadState.Terminated,
      timeoutMs,
    );
    const tracked = this.#active(ref);
    if (!tracked.id) {
      throw new Error(`Node pool reference became unbound: ${ref.name}`);
    }
    const proof = Object.freeze({
      ref,
      nodePool,
      [nodePoolDeletionRecordedBrand]: true as const,
    });
    this.#proofs.set(proof, {
      generation: tracked.generation,
      id: tracked.id,
      ref,
    });
    return proof;
  }

  async release(deletion: NodePoolDeletionRecorded): Promise<void> {
    const candidate: unknown = deletion;
    if (!isRecord(candidate)) {
      throw new Error(
        'Persisted node-pool-deletion proof was forged or belongs elsewhere',
      );
    }
    const proof = candidate;
    if (this.#usedProofs.has(proof)) {
      throw new Error('Persisted node-pool-deletion proof was already used');
    }
    const metadata = this.#proofs.get(proof);
    if (!metadata) {
      throw new Error(
        'Persisted node-pool-deletion proof was forged or belongs elsewhere',
      );
    }
    const tracked = this.#tracked.get(metadata.ref.name);
    if (
      !tracked ||
      tracked.ref !== metadata.ref ||
      tracked.id !== metadata.id
    ) {
      throw new Error(
        `Persisted node-pool-deletion proof refers to an inactive node pool: ${metadata.ref.name}`,
      );
    }
    if (tracked.generation !== metadata.generation) {
      throw new Error(
        `Persisted node-pool-deletion proof is stale for node pool ${metadata.ref.name}`,
      );
    }
    if (tracked.deployments.size > 0) {
      throw new Error(
        `Node pool ${metadata.ref.name} still has ${String(tracked.deployments.size)} tracked Deployment children`,
      );
    }

    await this.#manifest.remove(metadata.ref.name);
    tracked.registration.complete();
    this.#tracked.delete(metadata.ref.name);
    this.#proofs.delete(proof);
    this.#usedProofs.add(proof);
  }

  #active(ref: TrackedNodePoolRef): TrackedNodePool {
    this.assertActive(ref);
    const tracked = this.#tracked.get(ref.name);
    if (!tracked)
      throw new Error(`Node pool reference is inactive: ${ref.name}`);
    return tracked;
  }

  #bind(tracked: TrackedNodePool, nodePool: NodePoolSummary): NodePoolSummary {
    nodePoolIdentity(tracked.ref.name, nodePool, tracked.id);
    tracked.id = nodePool.id;
    return nodePool;
  }

  async #fallbackCleanup(
    ref: TrackedNodePoolRef,
    timeoutMs: number,
  ): Promise<void> {
    const tracked = this.#active(ref);
    if (!tracked.createAuthorized) return;
    const nodePool = await this.#resolveCleanupNodePool(tracked);
    if (!nodePool || isDeleted(nodePool)) return;

    // This exact disposable node pool was registered before creation. Its
    // Deployments belong to the same cleanup scope, including Deployments whose create
    // responses were lost or whose readiness assertions never completed.
    await this.#deleteNodePoolDeployments(nodePool.id, timeoutMs);

    let identityFailure: Error | undefined;
    const deleted = await this.#cleanupApi.deleteNodePool(nodePool.id);
    try {
      nodePoolIdentity(ref.name, deleted, nodePool.id);
    } catch (error) {
      identityFailure =
        error instanceof Error
          ? error
          : new Error('Node pool deletion returned invalid identity', {
              cause: error,
            });
    }
    await this.#cleanupWait.for<NodePoolStatusLookup>(
      `fallback cleanup for node pool ${ref.name} (${nodePool.id})`,
      async () => {
        const lookup = await this.#cleanupApi.lookupNodePool(nodePool.id);
        if (lookup.kind === 'found') {
          nodePoolIdentity(ref.name, lookup.nodePool, nodePool.id);
        }
        return lookup;
      },
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (lookup) =>
          lookup.kind === 'absent' || isDeleted(lookup.nodePool)
            ? undefined
            : lookup.nodePool.state,
      },
    );
    if (identityFailure) throw identityFailure;
  }

  async #deleteNodePoolDeployments(
    nodePoolId: string,
    timeoutMs: number,
  ): Promise<void> {
    // Managed Deployments run pool Jobs; the API refuses to delete them and
    // removes them with their node pool (RFC 0044 decision 29).
    const deployments = (await this.#cleanupApi.listDeployments()).filter(
      (deployment) =>
        deployment.nodePoolId === nodePoolId && !deployment.managed,
    );
    const deletions = await Promise.allSettled(
      deployments.map(async (deployment) => {
        const validate = (observed: DeploymentSummary): DeploymentSummary => {
          if (
            observed.id !== deployment.id ||
            observed.name !== deployment.name ||
            observed.nodePoolId !== nodePoolId
          ) {
            throw new Error(
              `Deployment ${deployment.id} cleanup response did not match its identity in node pool ${nodePoolId}`,
            );
          }
          return observed;
        };
        validate(await this.#cleanupApi.deleteDeployment(deployment.id));
        await this.#cleanupWait.for(
          `fallback cleanup for Deployment ${deployment.id} in node pool ${nodePoolId}`,
          async () => {
            // Listing uses durable rows; Deployment status also probes Kubernetes
            // and can fail while the runtime that needs cleanup is recovering.
            const active = (await this.#cleanupApi.listDeployments()).filter(
              (candidate) => candidate.id === deployment.id,
            );
            if (active.length > 1) {
              throw new Error(
                `Deployment ${deployment.id} has ambiguous cleanup identity`,
              );
            }
            return active[0] ? validate(active[0]) : undefined;
          },
          {
            timeoutMs,
            intervalMs: 2_000,
            probeError: 'fail',
            unmet: (observed) =>
              observed === undefined || observed.deletedAt !== null
                ? undefined
                : 'Deployment deletion is not recorded',
          },
        );
      }),
    );
    const failures = deletions.flatMap((result) =>
      result.status === 'rejected'
        ? [new Error(errorMessage(result.reason), { cause: result.reason })]
        : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Deployment cleanup failed for node pool ${nodePoolId}: ${failures.map(errorMessage).join('; ')}`,
      );
    }
  }

  async #resolveCleanupNodePool(
    tracked: TrackedNodePool,
  ): Promise<NodePoolSummary | undefined> {
    if (tracked.id) {
      const lookup = await this.#cleanupApi.lookupNodePool(tracked.id);
      return lookup.kind === 'absent'
        ? undefined
        : nodePoolIdentity(tracked.ref.name, lookup.nodePool, tracked.id);
    }

    const matches = (await this.#cleanupApi.listNodePools()).filter(
      (nodePool) => nodePool.name === tracked.ref.name,
    );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(
        `Fallback cleanup for node pool ${tracked.ref.name} found ${matches.length} active records`,
      );
    }
    const nodePool = matches[0];
    if (!nodePool) return undefined;
    return this.#bind(tracked, nodePool);
  }
}
