import type { ApiClient } from './api.js';
import type { CliClient, CliRunOptions } from './cli.js';
import type { TrackedWorkloadKernel, TrackedWorkloadRef } from './workloads.js';
import type {
  CommandResult,
  WorkloadCreateBody,
  WorkloadCreateResponse,
} from './types.js';

export function optionValue(
  args: readonly string[],
  name: string,
): string | undefined {
  const separateIndex = args.indexOf(name);
  if (separateIndex >= 0) return args[separateIndex + 1];
  const prefix = `${name}=`;
  return args
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function cliCreateId(args: readonly string[]): string {
  const [command, subcommand] = args;
  if (
    !['job', 'service', 'vm'].includes(command ?? '') ||
    (command === 'service' && subcommand === 'upgrade')
  ) {
    throw new Error(
      `Unsupported tracked CLI create: ${args.slice(0, 2).join(' ') || '<missing>'}`,
    );
  }
  const id = optionValue(args, '--id');
  if (!id) {
    throw new Error(
      `Tracked CLI create ${command ?? '<missing>'} requires an explicit workload ID`,
    );
  }
  return id;
}

function cliUpgradeId(args: readonly string[]): string {
  const [command, subcommand, id] = args;
  if (command !== 'service' || subcommand !== 'upgrade' || !id) {
    throw new Error('Tracked CLI upgrade requires: service upgrade <id>');
  }
  return id;
}

function cliResubmitId(args: readonly string[]): string {
  const [command, id] = args;
  if (command !== 'resubmit' || !id || args.length !== 2) {
    throw new Error(
      'A tracked resubmit transport requires exactly: resubmit <id>',
    );
  }
  return id;
}

export interface WorkloadApiCreateTransport {
  createWithApi(
    ref: TrackedWorkloadRef,
    body: WorkloadCreateBody,
  ): Promise<WorkloadCreateResponse>;
}

/**
 * A tracked mutation reports only whether the control plane accepted it.
 * Human-oriented command output is not evidence: it reaches the artifact trail
 * and the thrown diagnostic, never a contract or target adapter. A layer that
 * needs a fact about the workload reads it from status, the provider, or the
 * endpoint.
 */
export interface WorkloadCliCreateTransport {
  runCliCreateWithTransientRetries(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<void>;
}

export interface WorkloadCliUpgradeTransport {
  runCliUpgrade(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<void>;
}

export interface WorkloadCliResubmitTransport {
  runCliResubmit(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<void>;
}

/**
 * Raw command access for transports whose observation *is* the command outcome,
 * such as proving a request was rejected. The closed-layer lint allowlist names
 * only the strict interfaces above, so a contract or adapter cannot reach this.
 */
export interface WorkloadCliRawCreateTransport {
  runCliCreateWithTransientRetries(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<CommandResult>;
}

/**
 * Turns a raw tracked command result into the accepted/rejected outcome the
 * closed layers are allowed to see. The full output reaches the artifact trail
 * and this diagnostic; it never becomes a value a contract or adapter can read.
 */
export function assertMutationAccepted(
  result: CommandResult,
  operation: string,
): void {
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

export type TrackedCliMutations = WorkloadCliCreateTransport &
  WorkloadCliResubmitTransport &
  WorkloadCliUpgradeTransport;

/**
 * The only mutation surface a contract family may hold. Direct specs keep the
 * raw transport because their whole purpose is asserting on command outcomes.
 */
export function trackedCliMutations(
  transport: WorkloadMutationTransport,
): TrackedCliMutations {
  const accepted = async (
    operation: string | undefined,
    run: () => Promise<CommandResult>,
  ): Promise<void> => {
    assertMutationAccepted(await run(), operation ?? 'tracked mutation');
  };
  return {
    runCliCreateWithTransientRetries: (ref, args, options) =>
      accepted(options?.label, () =>
        transport.runCliCreateWithTransientRetries(ref, args, options),
      ),
    runCliResubmit: (ref, args, options) =>
      accepted(options?.label, () =>
        transport.runCliResubmit(ref, args, options),
      ),
    runCliUpgrade: (ref, args, options) =>
      accepted(options?.label, () =>
        transport.runCliUpgrade(ref, args, options),
      ),
  };
}

export class WorkloadMutationTransport implements WorkloadApiCreateTransport {
  readonly #api: Pick<ApiClient, 'createWorkload'>;
  readonly #cli: Pick<CliClient, 'run' | 'runWithTransientRetries'>;
  readonly #kernel: Pick<TrackedWorkloadKernel, 'authorizeMutation'>;

  constructor(
    kernel: Pick<TrackedWorkloadKernel, 'authorizeMutation'>,
    api: Pick<ApiClient, 'createWorkload'>,
    cli: Pick<CliClient, 'run' | 'runWithTransientRetries'>,
  ) {
    this.#api = api;
    this.#cli = cli;
    this.#kernel = kernel;
  }

  async createWithApi(
    ref: TrackedWorkloadRef,
    body: WorkloadCreateBody,
  ): Promise<WorkloadCreateResponse> {
    this.#kernel.authorizeMutation(ref, body.id);
    return this.#api.createWorkload(body);
  }

  async runCliCreate(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<CommandResult> {
    this.#kernel.authorizeMutation(ref, cliCreateId(args));
    return this.#cli.run(args, options);
  }

  async runCliCreateWithTransientRetries(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<CommandResult> {
    this.#kernel.authorizeMutation(ref, cliCreateId(args));
    return this.#cli.runWithTransientRetries(args, options);
  }

  async runCliUpgrade(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<CommandResult> {
    this.#kernel.authorizeMutation(ref, cliUpgradeId(args));
    return this.#cli.run(args, options);
  }

  async runCliResubmit(
    ref: TrackedWorkloadRef,
    args: readonly string[],
    options?: CliRunOptions,
  ): Promise<CommandResult> {
    this.#kernel.authorizeMutation(ref, cliResubmitId(args));
    return this.#cli.run(args, options);
  }
}
