import path from 'node:path';

import type { DeploymentSummary } from '../../../../src/shared/api-contract/deployments-schemas.js';

import type { CleanupRegistration, CleanupStack } from './cleanup.js';
import { CleanupManifest } from './cleanup-manifest.js';
import type { NodePoolKernel, TrackedNodePoolRef } from './node-pools.js';
import { isRecord } from './types.js';
import type { Waiter } from './wait.js';
import { retryUnavailableApiRead } from './read-retry.js';

const trackedDeploymentBrand: unique symbol = Symbol('TrackedDeploymentRef');
const deploymentDeletionBrand: unique symbol = Symbol(
  'DeploymentDeletionRecorded',
);
const deploymentAbsenceBrand: unique symbol = Symbol(
  'DeploymentSubstrateAbsent',
);

export type TrackedDeploymentRef = Readonly<{
  readonly name: string;
  readonly parent: TrackedNodePoolRef;
  readonly [trackedDeploymentBrand]: true;
}>;

export type DeploymentDeletionRecorded = Readonly<{
  readonly ref: TrackedDeploymentRef;
  readonly deployment: DeploymentSummary;
  readonly [deploymentDeletionBrand]: true;
}>;

export interface DeploymentSubstrateAbsenceFacts {
  readonly pods: number;
  readonly replicaSets: number;
  readonly secrets: number;
  readonly serviceAccounts: number;
  readonly workloads: number;
}

export type DeploymentSubstrateAbsent = Readonly<{
  readonly ref: TrackedDeploymentRef;
  readonly facts: DeploymentSubstrateAbsenceFacts;
  readonly [deploymentAbsenceBrand]: true;
}>;

export interface DeploymentReleaseEvidence {
  readonly deletion: DeploymentDeletionRecorded;
  readonly substrate: DeploymentSubstrateAbsent;
}

export interface DeploymentReadTransport {
  deploymentStatus(id: string): Promise<DeploymentSummary>;
  listDeployments(): Promise<readonly DeploymentSummary[]>;
}

export interface DeploymentCleanupTransport extends DeploymentReadTransport {
  deleteDeployment(id: string): Promise<DeploymentSummary>;
  deploymentAbsent(nodePoolId: string, id: string): Promise<unknown>;
}

type DeploymentParentKernel = Pick<
  NodePoolKernel,
  'assertActive' | 'boundId' | 'registerDeployment' | 'unregisterDeployment'
>;

interface TrackedDeployment {
  createAuthorized: boolean;
  deletionAuthorized: boolean;
  generation: number;
  id?: string;
  readonly ref: TrackedDeploymentRef;
  readonly registration: CleanupRegistration;
}

interface DeploymentProofMetadata {
  readonly generation: number;
  readonly id: string;
  readonly ref: TrackedDeploymentRef;
}

function fixtureSafeName(name: string): void {
  if (name.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
    throw new Error(`Deployment name is not fixture-safe: ${name}`);
  }
}

function deploymentIdentity(
  ref: TrackedDeploymentRef,
  parentId: string,
  deployment: DeploymentSummary,
  expectedId?: string,
): DeploymentSummary {
  if (
    deployment.name !== ref.name ||
    deployment.target.kind !== 'nodePool' ||
    deployment.nodePoolId !== parentId
  ) {
    throw new Error(
      `Deployment response for ${ref.name} identified ${deployment.name} in node pool ${deployment.nodePoolId}, expected node pool ${parentId}`,
    );
  }
  if (expectedId && deployment.id !== expectedId) {
    throw new Error(
      `Deployment response for ${ref.name} identified ID ${deployment.id}, expected ${expectedId}`,
    );
  }
  return deployment;
}

const deploymentAbsenceKeys = [
  'pods',
  'replicaSets',
  'secrets',
  'serviceAccounts',
  'workloads',
] as const satisfies readonly (keyof DeploymentSubstrateAbsenceFacts)[];

function checkedSubstrateAbsenceFacts(
  value: unknown,
): DeploymentSubstrateAbsenceFacts {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...deploymentAbsenceKeys].sort())
  ) {
    throw new Error(
      `Deployment native absence must contain exactly ${deploymentAbsenceKeys.join(', ')}`,
    );
  }
  for (const key of deploymentAbsenceKeys) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      throw new Error(
        `Deployment native absence ${key} must be a nonnegative integer`,
      );
    }
  }
  return {
    pods: Number(value.pods),
    replicaSets: Number(value.replicaSets),
    secrets: Number(value.secrets),
    serviceAccounts: Number(value.serviceAccounts),
    workloads: Number(value.workloads),
  };
}

export function deploymentSubstrateAbsenceUnmet(
  value: unknown,
): string | undefined {
  let facts: DeploymentSubstrateAbsenceFacts;
  try {
    facts = checkedSubstrateAbsenceFacts(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return deploymentAbsenceKeys.every((key) => facts[key] === 0)
    ? undefined
    : JSON.stringify(facts);
}

export interface DeploymentKernel {
  assertActive(ref: TrackedDeploymentRef): void;
  authorizeCreate(
    ref: TrackedDeploymentRef,
    outgoing: { readonly nodePoolId: string; readonly name: string },
  ): void;
  authorizeDeletion(ref: TrackedDeploymentRef, outgoingId: string): void;
  authorizeUpdate(ref: TrackedDeploymentRef, outgoingId: string): void;
  bindCreated(
    ref: TrackedDeploymentRef,
    deployment: DeploymentSummary,
  ): DeploymentSummary;
  coordinates(ref: TrackedDeploymentRef): {
    readonly nodePoolId: string;
    readonly id: string;
  };
  parentId(ref: TrackedDeploymentRef): string;
  resolveCreated(ref: TrackedDeploymentRef): Promise<DeploymentSummary>;
  reserve(
    parent: TrackedNodePoolRef,
    name: string,
    cleanupTimeoutMs: number,
  ): Promise<TrackedDeploymentRef>;
  status(ref: TrackedDeploymentRef): Promise<DeploymentSummary>;
  waitForDeletionRecorded(
    ref: TrackedDeploymentRef,
    timeoutMs: number,
  ): Promise<DeploymentDeletionRecorded>;
  recordSubstrateAbsence(
    ref: TrackedDeploymentRef,
    facts: DeploymentSubstrateAbsenceFacts,
  ): DeploymentSubstrateAbsent;
  release(evidence: DeploymentReleaseEvidence): Promise<void>;
  validateBound(
    ref: TrackedDeploymentRef,
    deployment: DeploymentSummary,
  ): DeploymentSummary;
}

export class TrackedDeploymentKernel implements DeploymentKernel {
  readonly #cleanup: CleanupStack;
  readonly #cleanupTransport: DeploymentCleanupTransport;
  readonly #cleanupWait: Pick<Waiter, 'for'>;
  readonly #nodePools: DeploymentParentKernel;
  readonly #deletionProofs = new WeakMap<object, DeploymentProofMetadata>();
  readonly #absenceProofs = new WeakMap<object, DeploymentProofMetadata>();
  readonly #manifest: CleanupManifest;
  readonly #read: DeploymentReadTransport;
  readonly #tracked = new Map<string, TrackedDeployment>();
  readonly #usedProofs = new WeakSet<object>();
  readonly #wait: Pick<Waiter, 'for'>;

  constructor(
    read: DeploymentReadTransport,
    nodePools: DeploymentParentKernel,
    cleanup: CleanupStack,
    wait: Pick<Waiter, 'for'>,
    resultsDirectory: string | undefined,
    cleanupDependencies: {
      readonly transport: DeploymentCleanupTransport;
      readonly wait: Pick<Waiter, 'for'>;
    },
  ) {
    this.#read = read;
    this.#nodePools = nodePools;
    this.#cleanup = cleanup;
    this.#wait = wait;
    this.#cleanupTransport = cleanupDependencies.transport;
    this.#cleanupWait = cleanupDependencies.wait;
    this.#manifest = new CleanupManifest(
      resultsDirectory
        ? path.join(resultsDirectory, 'deployments-to-clean')
        : undefined,
    );
  }

  async reserve(
    parent: TrackedNodePoolRef,
    name: string,
    cleanupTimeoutMs: number,
  ): Promise<TrackedDeploymentRef> {
    this.#nodePools.assertActive(parent);
    this.#nodePools.boundId(parent);
    fixtureSafeName(name);
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
      throw new Error('Deployment cleanup timeout must be a positive integer');
    }
    if (this.#tracked.has(name)) {
      throw new Error(`Deployment is already registered for cleanup: ${name}`);
    }
    const ref = Object.freeze({
      name,
      parent,
      [trackedDeploymentBrand]: true as const,
    });
    const registration = this.#cleanup.defer(`deployment ${name}`, async () => {
      await this.#fallbackCleanup(ref, cleanupTimeoutMs);
      await this.#forget(ref);
    });
    this.#tracked.set(name, {
      createAuthorized: false,
      deletionAuthorized: false,
      generation: 0,
      ref,
      registration,
    });
    let parentRegistered = false;
    try {
      this.#nodePools.registerDeployment(parent, ref);
      parentRegistered = true;
      await this.#manifest.add(name);
    } catch (error) {
      if (parentRegistered) this.#nodePools.unregisterDeployment(parent, ref);
      registration.complete();
      this.#tracked.delete(name);
      throw error;
    }
    return ref;
  }

  assertActive(ref: TrackedDeploymentRef): void {
    const candidate: unknown = ref;
    const name =
      isRecord(candidate) && typeof candidate.name === 'string'
        ? candidate.name
        : '<invalid>';
    const tracked = this.#tracked.get(name);
    if (!tracked || tracked.ref !== ref) {
      throw new Error(
        `Deployment reference is forged, stale, or released: ${name}`,
      );
    }
    this.#nodePools.assertActive(ref.parent);
  }

  authorizeCreate(
    ref: TrackedDeploymentRef,
    outgoing: { readonly nodePoolId: string; readonly name: string },
  ): void {
    const tracked = this.#active(ref);
    const parentId = this.#nodePools.boundId(ref.parent);
    if (outgoing.name !== ref.name || outgoing.nodePoolId !== parentId) {
      throw new Error(
        `Tracked Deployment ${ref.name} cannot authorize creation of ${outgoing.name} in node pool ${outgoing.nodePoolId}`,
      );
    }
    if (tracked.createAuthorized) {
      throw new Error(
        `Deployment creation was already authorized: ${ref.name}`,
      );
    }
    tracked.createAuthorized = true;
    tracked.generation += 1;
  }

  bindCreated(
    ref: TrackedDeploymentRef,
    deployment: DeploymentSummary,
  ): DeploymentSummary {
    const tracked = this.#active(ref);
    if (!tracked.createAuthorized) {
      throw new Error(`Deployment creation was not authorized: ${ref.name}`);
    }
    return this.#bind(tracked, deployment);
  }

  async resolveCreated(ref: TrackedDeploymentRef): Promise<DeploymentSummary> {
    const tracked = this.#active(ref);
    if (!tracked.createAuthorized) {
      throw new Error(`Deployment creation was not authorized: ${ref.name}`);
    }
    const parentId = this.#nodePools.boundId(ref.parent);
    const matches = (await this.#read.listDeployments()).filter(
      (deployment) =>
        deployment.name === ref.name &&
        deployment.nodePoolId === parentId &&
        deployment.deletedAt === null,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Deployment ${ref.name} resolved to ${String(matches.length)} active records; expected exactly one`,
      );
    }
    return this.#bind(tracked, matches[0]);
  }

  coordinates(ref: TrackedDeploymentRef): {
    readonly nodePoolId: string;
    readonly id: string;
  } {
    const tracked = this.#active(ref);
    if (!tracked.id) {
      throw new Error(
        `Deployment reference is not bound to a server ID: ${ref.name}`,
      );
    }
    return {
      nodePoolId: this.#nodePools.boundId(ref.parent),
      id: tracked.id,
    };
  }

  parentId(ref: TrackedDeploymentRef): string {
    this.#active(ref);
    return this.#nodePools.boundId(ref.parent);
  }

  authorizeUpdate(ref: TrackedDeploymentRef, outgoingId: string): void {
    const tracked = this.#active(ref);
    const { id } = this.coordinates(ref);
    if (outgoingId !== id) {
      throw new Error(
        `Tracked Deployment ${ref.name} (${id}) cannot authorize mutation of ${outgoingId}`,
      );
    }
    if (tracked.deletionAuthorized) {
      throw new Error(
        `Deployment deletion was already authorized: ${ref.name}`,
      );
    }
    tracked.generation += 1;
  }

  authorizeDeletion(ref: TrackedDeploymentRef, outgoingId: string): void {
    const tracked = this.#active(ref);
    const { id } = this.coordinates(ref);
    if (outgoingId !== id) {
      throw new Error(
        `Tracked Deployment ${ref.name} (${id}) cannot authorize deletion of ${outgoingId}`,
      );
    }
    if (tracked.deletionAuthorized) {
      throw new Error(
        `Deployment deletion was already authorized: ${ref.name}`,
      );
    }
    tracked.deletionAuthorized = true;
    tracked.generation += 1;
  }

  validateBound(
    ref: TrackedDeploymentRef,
    deployment: DeploymentSummary,
  ): DeploymentSummary {
    const { nodePoolId, id } = this.coordinates(ref);
    return deploymentIdentity(ref, nodePoolId, deployment, id);
  }

  async status(ref: TrackedDeploymentRef): Promise<DeploymentSummary> {
    const { id } = this.coordinates(ref);
    return this.validateBound(ref, await this.#read.deploymentStatus(id));
  }

  async waitForDeletionRecorded(
    ref: TrackedDeploymentRef,
    timeoutMs: number,
  ): Promise<DeploymentDeletionRecorded> {
    const deployment = await this.#wait.for(
      `persisted deletion for Deployment ${ref.name}`,
      () => this.status(ref),
      {
        timeoutMs,
        intervalMs: 2_000,
        probeError: retryUnavailableApiRead,
        unmet: (candidate) =>
          candidate.deletedAt === null ? 'deletion is not recorded' : undefined,
      },
    );
    const tracked = this.#active(ref);
    const { id } = this.coordinates(ref);
    const proof = Object.freeze({
      ref,
      deployment,
      [deploymentDeletionBrand]: true as const,
    });
    this.#deletionProofs.set(proof, {
      generation: tracked.generation,
      id,
      ref,
    });
    return proof;
  }

  recordSubstrateAbsence(
    ref: TrackedDeploymentRef,
    facts: DeploymentSubstrateAbsenceFacts,
  ): DeploymentSubstrateAbsent {
    const checked = checkedSubstrateAbsenceFacts(facts);
    if (deploymentSubstrateAbsenceUnmet(checked) !== undefined) {
      throw new Error(
        `Deployment ${ref.name} still has native resources: ${JSON.stringify(checked)}`,
      );
    }
    const tracked = this.#active(ref);
    const { id } = this.coordinates(ref);
    const proof = Object.freeze({
      ref,
      facts: Object.freeze({ ...checked }),
      [deploymentAbsenceBrand]: true as const,
    });
    this.#absenceProofs.set(proof, {
      generation: tracked.generation,
      id,
      ref,
    });
    return proof;
  }

  async release(evidence: DeploymentReleaseEvidence): Promise<void> {
    const deletion = this.#proof(evidence.deletion, this.#deletionProofs);
    const substrate = this.#proof(evidence.substrate, this.#absenceProofs);
    if (deletion.ref !== substrate.ref || deletion.id !== substrate.id) {
      throw new Error(
        'Deployment release evidence belongs to different resources',
      );
    }
    if (deletion.generation !== substrate.generation) {
      throw new Error(
        `Deployment release evidence is stale for ${deletion.ref.name}`,
      );
    }
    const tracked = this.#active(deletion.ref);
    if (tracked.generation !== deletion.generation) {
      throw new Error(
        `Deployment release evidence is stale for ${deletion.ref.name}`,
      );
    }
    await this.#manifest.remove(deletion.ref.name);
    this.#nodePools.unregisterDeployment(deletion.ref.parent, deletion.ref);
    tracked.registration.complete();
    this.#tracked.delete(deletion.ref.name);
    this.#deletionProofs.delete(evidence.deletion);
    this.#absenceProofs.delete(evidence.substrate);
    this.#usedProofs.add(evidence.deletion);
    this.#usedProofs.add(evidence.substrate);
  }

  #proof(
    value: object,
    proofs: WeakMap<object, DeploymentProofMetadata>,
  ): DeploymentProofMetadata {
    if (this.#usedProofs.has(value)) {
      throw new Error('Deployment release proof was already used');
    }
    const proof = proofs.get(value);
    if (!proof) {
      throw new Error(
        'Deployment release proof was forged or belongs elsewhere',
      );
    }
    return proof;
  }

  #active(ref: TrackedDeploymentRef): TrackedDeployment {
    this.assertActive(ref);
    const tracked = this.#tracked.get(ref.name);
    if (!tracked)
      throw new Error(`Deployment reference is inactive: ${ref.name}`);
    return tracked;
  }

  #bind(
    tracked: TrackedDeployment,
    deployment: DeploymentSummary,
  ): DeploymentSummary {
    const parentId = this.#nodePools.boundId(tracked.ref.parent);
    deploymentIdentity(tracked.ref, parentId, deployment, tracked.id);
    tracked.id = deployment.id;
    return deployment;
  }

  async #fallbackCleanup(
    ref: TrackedDeploymentRef,
    timeoutMs: number,
  ): Promise<void> {
    const tracked = this.#active(ref);
    if (!tracked.createAuthorized) return;
    // The public list omits deleted rows. After an authorized create, a missing
    // name cannot prove either that creation failed or that native resources left.
    const deployment = await this.#cleanupWait.for(
      `fallback identity for Deployment ${ref.name}`,
      () => this.#resolveCleanupDeployment(tracked),
      {
        timeoutMs,
        intervalMs: 2_000,
        probeError: retryUnavailableApiRead,
        unmet: (candidate) =>
          candidate
            ? undefined
            : 'identity remains unresolved after authorized creation',
      },
    );
    if (!deployment) {
      throw new Error(`Deployment ${ref.name} identity remains unresolved`);
    }
    const nodePoolId = this.#nodePools.boundId(ref.parent);
    if (deployment.deletedAt === null) {
      const deleted = await this.#cleanupTransport.deleteDeployment(
        deployment.id,
      );
      deploymentIdentity(ref, nodePoolId, deleted, deployment.id);
      await this.#cleanupWait.for(
        `fallback deletion for Deployment ${ref.name} (${deployment.id})`,
        () => this.#cleanupTransport.deploymentStatus(deployment.id),
        {
          timeoutMs,
          intervalMs: 2_000,
          probeError: retryUnavailableApiRead,
          unmet: (candidate) =>
            deploymentIdentity(ref, nodePoolId, candidate, deployment.id)
              .deletedAt === null
              ? 'deletion is not recorded'
              : undefined,
        },
      );
    }
    await this.#cleanupWait.for(
      `fallback native absence for Deployment ${ref.name} (${deployment.id})`,
      () => this.#cleanupTransport.deploymentAbsent(nodePoolId, deployment.id),
      {
        timeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: deploymentSubstrateAbsenceUnmet,
      },
    );
  }

  async #resolveCleanupDeployment(
    tracked: TrackedDeployment,
  ): Promise<DeploymentSummary | undefined> {
    const parentId = this.#nodePools.boundId(tracked.ref.parent);
    if (tracked.id) {
      return deploymentIdentity(
        tracked.ref,
        parentId,
        await this.#cleanupTransport.deploymentStatus(tracked.id),
        tracked.id,
      );
    }
    const matches = (await this.#cleanupTransport.listDeployments()).filter(
      (deployment) =>
        deployment.name === tracked.ref.name &&
        deployment.nodePoolId === parentId,
    );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(
        `Fallback cleanup for Deployment ${tracked.ref.name} found ${String(matches.length)} active records`,
      );
    }
    return this.#bind(tracked, matches[0]);
  }

  async #forget(ref: TrackedDeploymentRef): Promise<void> {
    await this.#manifest.remove(ref.name);
    this.#nodePools.unregisterDeployment(ref.parent, ref);
    this.#tracked.delete(ref.name);
  }
}
