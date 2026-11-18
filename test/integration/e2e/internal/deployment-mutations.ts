import type { DockerOptions } from '../../../../src/shared/runtime.js';
import type {
  DeploymentSummary,
  DeploymentReadinessProbe,
} from '../../../../src/shared/api-contract/deployments-schemas.js';

import type { DeploymentKernel, TrackedDeploymentRef } from './deployments.js';

export interface DeploymentCreateInput {
  readonly readinessProbe?: DeploymentReadinessProbe | null;
  readonly dockerOptions?: DockerOptions;
  readonly image: string;
  readonly maxConcurrentJobsPerReplica?: number;
  readonly minReplicas?: number;
  readonly maxReplicas?: number;
  readonly secrets?: readonly string[];
}

export interface DeploymentUpdateInput {
  readonly readinessProbe?: DeploymentReadinessProbe | null;
  readonly env?: Record<string, string>;
  readonly image?: string;
}

export interface DeploymentWireTransport {
  createDeployment(input: {
    readonly readinessProbe?: DeploymentReadinessProbe | null;
    readonly nodePoolId: string;
    readonly dockerOptions?: DockerOptions;
    readonly image: string;
    readonly maxConcurrentJobsPerReplica?: number;
    readonly minReplicas?: number;
    readonly maxReplicas?: number;
    readonly name: string;
    readonly secrets?: readonly string[];
  }): Promise<DeploymentSummary>;
  deleteDeployment(id: string): Promise<DeploymentSummary>;
  deploymentStatus(id: string): Promise<DeploymentSummary>;
  updateDeployment(
    id: string,
    input: DeploymentUpdateInput,
  ): Promise<DeploymentSummary>;
}

type DeploymentMutationKernel = Pick<
  DeploymentKernel,
  | 'authorizeCreate'
  | 'authorizeDeletion'
  | 'authorizeUpdate'
  | 'bindCreated'
  | 'coordinates'
  | 'parentId'
  | 'validateBound'
>;

export interface DeploymentCreateTransport {
  create(
    ref: TrackedDeploymentRef,
    input: DeploymentCreateInput,
  ): Promise<DeploymentSummary>;
}

export interface DeploymentReadTransport {
  status(ref: TrackedDeploymentRef): Promise<DeploymentSummary>;
}

export interface DeploymentUpdateTransport {
  update(
    ref: TrackedDeploymentRef,
    input: DeploymentUpdateInput,
  ): Promise<DeploymentSummary>;
}

export interface DeploymentDeleteTransport {
  delete(ref: TrackedDeploymentRef): Promise<DeploymentSummary>;
}

export class DeploymentMutationTransport
  implements
    DeploymentCreateTransport,
    DeploymentReadTransport,
    DeploymentUpdateTransport,
    DeploymentDeleteTransport
{
  readonly #kernel: DeploymentMutationKernel;
  readonly #wire: DeploymentWireTransport;

  constructor(kernel: DeploymentMutationKernel, wire: DeploymentWireTransport) {
    this.#kernel = kernel;
    this.#wire = wire;
  }

  async create(
    ref: TrackedDeploymentRef,
    input: DeploymentCreateInput,
  ): Promise<DeploymentSummary> {
    const payload = {
      nodePoolId: this.#kernel.parentId(ref),
      dockerOptions: input.dockerOptions,
      image: input.image,
      ...(input.readinessProbe === undefined
        ? {}
        : { readinessProbe: input.readinessProbe }),
      maxConcurrentJobsPerReplica: input.maxConcurrentJobsPerReplica,
      minReplicas: input.minReplicas,
      maxReplicas: input.maxReplicas,
      name: ref.name,
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    };
    this.#kernel.authorizeCreate(ref, payload);
    const deployment = await this.#wire.createDeployment(payload);
    return this.#kernel.bindCreated(ref, deployment);
  }

  async status(ref: TrackedDeploymentRef): Promise<DeploymentSummary> {
    const { id } = this.#kernel.coordinates(ref);
    return this.#kernel.validateBound(
      ref,
      await this.#wire.deploymentStatus(id),
    );
  }

  async update(
    ref: TrackedDeploymentRef,
    input: DeploymentUpdateInput,
  ): Promise<DeploymentSummary> {
    const { id } = this.#kernel.coordinates(ref);
    this.#kernel.authorizeUpdate(ref, id);
    return this.#kernel.validateBound(
      ref,
      await this.#wire.updateDeployment(id, input),
    );
  }

  async delete(ref: TrackedDeploymentRef): Promise<DeploymentSummary> {
    const { id } = this.#kernel.coordinates(ref);
    this.#kernel.authorizeDeletion(ref, id);
    return this.#kernel.validateBound(
      ref,
      await this.#wire.deleteDeployment(id),
    );
  }
}
