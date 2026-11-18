import { nodePoolSummarySchema } from '../../../../src/shared/api-contract/node-pools-schemas.js';

import { declaredApiError, type ApiClient } from './api.js';
import type { CliClient } from './cli.js';
import { cliArgs } from './cli-surface.js';
import type {
  TrackedNodePoolKernel,
  TrackedNodePoolRef,
} from './node-pools.js';
import type {
  CommandResult,
  NodePoolCreateRequest,
  NodePoolSummary,
} from './types.js';

type NodePoolMutationKernel = Pick<
  TrackedNodePoolKernel,
  | 'authorizeCreate'
  | 'authorizeDeletion'
  | 'bindCreated'
  | 'boundId'
  | 'validateBoundNodePool'
>;

export interface NodePoolCreateTransport {
  create(
    ref: TrackedNodePoolRef,
    request: NodePoolCreateRequest,
  ): Promise<NodePoolSummary>;
}

export interface NodePoolDeleteTransport {
  delete(ref: TrackedNodePoolRef): Promise<NodePoolSummary>;
}

export interface NodePoolDeleteAttemptTransport {
  attemptDelete(ref: TrackedNodePoolRef): Promise<
    | { readonly kind: 'deleted'; readonly nodePool: NodePoolSummary }
    | {
        readonly kind: 'rejected';
        readonly code: 'NODE_POOL_REFERENCED';
        readonly message: string;
      }
  >;
}

export interface NodePoolReadTransport {
  list(): Promise<readonly NodePoolSummary[]>;
  status(id: string): Promise<NodePoolSummary>;
}

function successful(result: CommandResult, operation: string): void {
  if (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted &&
    !result.spawnError
  ) {
    return;
  }
  throw new Error(
    `${operation} failed (exit ${String(result.exitCode)}, timeout ${String(result.timedOut)}): ${result.combined}`,
  );
}

function parseNodePool(
  result: CommandResult,
  operation: string,
): NodePoolSummary {
  successful(result, operation);
  try {
    return nodePoolSummarySchema.parse(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw new Error(`${operation} returned an invalid node pool record`, {
      cause: error,
    });
  }
}

function parseNodePools(
  result: CommandResult,
  operation: string,
): readonly NodePoolSummary[] {
  successful(result, operation);
  try {
    return nodePoolSummarySchema
      .array()
      .parse(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw new Error(`${operation} returned an invalid node pool list`, {
      cause: error,
    });
  }
}

export class NodePoolMutationTransport
  implements
    NodePoolCreateTransport,
    NodePoolDeleteTransport,
    NodePoolDeleteAttemptTransport
{
  readonly #api: Pick<ApiClient, 'createNodePool' | 'deleteNodePool'>;
  readonly #kernel: NodePoolMutationKernel;

  constructor(
    kernel: NodePoolMutationKernel,
    api: Pick<ApiClient, 'createNodePool' | 'deleteNodePool'>,
  ) {
    this.#api = api;
    this.#kernel = kernel;
  }

  async create(
    ref: TrackedNodePoolRef,
    request: NodePoolCreateRequest,
  ): Promise<NodePoolSummary> {
    this.#kernel.authorizeCreate(ref, request.name);
    const nodePool = await this.#api.createNodePool(request);
    return this.#kernel.bindCreated(ref, nodePool);
  }

  async delete(ref: TrackedNodePoolRef): Promise<NodePoolSummary> {
    const id = this.#kernel.boundId(ref);
    this.#kernel.authorizeDeletion(ref, id);
    const nodePool = await this.#api.deleteNodePool(id);
    return this.#kernel.validateBoundNodePool(ref, nodePool);
  }

  async attemptDelete(ref: TrackedNodePoolRef): Promise<
    | { readonly kind: 'deleted'; readonly nodePool: NodePoolSummary }
    | {
        readonly kind: 'rejected';
        readonly code: 'NODE_POOL_REFERENCED';
        readonly message: string;
      }
  > {
    const id = this.#kernel.boundId(ref);
    this.#kernel.authorizeDeletion(ref, id);
    try {
      const nodePool = await this.#api.deleteNodePool(id);
      return {
        kind: 'deleted',
        nodePool: this.#kernel.validateBoundNodePool(ref, nodePool),
      };
    } catch (error) {
      const declared = declaredApiError(error);
      if (declared?.code !== 'NODE_POOL_REFERENCED') throw error;
      return {
        kind: 'rejected',
        code: 'NODE_POOL_REFERENCED',
        message: declared.message,
      };
    }
  }
}

/** Drives the public node-pool CLI while retaining the tracked-reference fence. */
export class NodePoolCliTransport
  implements
    NodePoolCreateTransport,
    NodePoolDeleteTransport,
    NodePoolReadTransport
{
  readonly #cli: Pick<CliClient, 'run'>;
  readonly #kernel: NodePoolMutationKernel;

  constructor(kernel: NodePoolMutationKernel, cli: Pick<CliClient, 'run'>) {
    this.#kernel = kernel;
    this.#cli = cli;
  }

  async create(
    ref: TrackedNodePoolRef,
    request: NodePoolCreateRequest,
  ): Promise<NodePoolSummary> {
    this.#kernel.authorizeCreate(ref, request.name);
    const result = await this.#cli.run(
      cliArgs(
        'node-pool create',
        {
          credentials: request.credentialName,
          ...(request.region ? { region: request.region } : {}),
          'vm-type': request.vmTypes,
          'min-vms': String(request.minVmCount),
          'max-vms': String(request.maxVmCount),
          ...(request.spot ? { spot: true } : {}),
          ...(request.allowPrivilegedJobs
            ? { 'allow-privileged-jobs': true }
            : {}),
          ...(request.userNamespaceJobs ? { 'user-namespace-jobs': true } : {}),
          ...(request.osDiskSizeGb
            ? { 'disk-size': String(request.osDiskSizeGb) }
            : {}),
          json: true,
        },
        [request.name],
      ),
      { timeoutMs: 120_000, label: 'node-pool-create' },
    );
    return this.#kernel.bindCreated(
      ref,
      parseNodePool(result, 'Node pool create'),
    );
  }

  async delete(ref: TrackedNodePoolRef): Promise<NodePoolSummary> {
    const id = this.#kernel.boundId(ref);
    this.#kernel.authorizeDeletion(ref, id);
    const result = await this.#cli.run(
      cliArgs('node-pool delete', { json: true }, [id]),
      {
        timeoutMs: 120_000,
        label: 'node-pool-delete',
      },
    );
    return this.#kernel.validateBoundNodePool(
      ref,
      parseNodePool(result, 'Node pool delete'),
    );
  }

  async list(): Promise<readonly NodePoolSummary[]> {
    return parseNodePools(
      await this.#cli.run(cliArgs('node-pool list', { json: true }), {
        timeoutMs: 120_000,
        label: 'node-pool-list',
      }),
      'Node pool list',
    );
  }

  async status(id: string): Promise<NodePoolSummary> {
    return parseNodePool(
      await this.#cli.run(cliArgs('node-pool status', { json: true }, [id]), {
        timeoutMs: 120_000,
        label: 'node-pool-status',
      }),
      'Node pool status',
    );
  }
}
