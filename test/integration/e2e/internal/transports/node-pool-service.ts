import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { CliClient, CliRunOptions } from '../cli.js';
import { waitReadyByCli } from '../cli-observations.js';
import { cliArgs } from '../cli-surface.js';
import type { CommandResult } from '../types.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import type { NodePoolServiceTransport } from '../targets/cluster-node-pool.js';
import type { WorkloadMutationTransport } from '../workload-mutations.js';
import type {
  CleanupRecorded,
  TrackedWorkloadKernel,
  TrackedWorkloadRef,
} from '../workloads.js';

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

/**
 * Drives the public Service CLI against a node pool while the tracked
 * workload kernel keeps its reference fence, cleanup registration and release
 * proofs. VM facts come from the ledger probe, never from raw status.
 */
type NodePoolServiceKernel = Pick<
  TrackedWorkloadKernel,
  | 'reserve'
  | 'waitForState'
  | 'status'
  | 'requestTermination'
  | 'waitForCleanupRecorded'
  | 'recordLedgerCleared'
  | 'recordSubstrateAbsence'
  | 'release'
>;

type PublicEndpointSummary = {
  readonly publicEndpoint?: {
    readonly ip: string | null;
    readonly state: 'published' | 'repointing' | 'stale';
    readonly error: string | null;
  } | null;
};

export class CliNodePoolServiceTransport implements NodePoolServiceTransport {
  readonly #kernel: NodePoolServiceKernel;
  readonly #mutations: Pick<WorkloadMutationTransport, 'runCliCreate'>;
  readonly #vmLedger: Pick<VmLedgerProbe, 'liveVmCount'>;
  readonly #cli: Pick<CliClient, 'run'>;

  constructor(dependencies: {
    readonly kernel: NodePoolServiceKernel;
    readonly mutations: Pick<WorkloadMutationTransport, 'runCliCreate'>;
    readonly vmLedger: Pick<VmLedgerProbe, 'liveVmCount'>;
    readonly cli: Pick<CliClient, 'run'>;
  }) {
    this.#kernel = dependencies.kernel;
    this.#mutations = dependencies.mutations;
    this.#vmLedger = dependencies.vmLedger;
    this.#cli = dependencies.cli;
  }

  async logs(ref: TrackedWorkloadRef): Promise<string> {
    const result = await this.#cli.run(cliArgs('logs', {}, [ref.id]), {
      timeoutMs: 60_000,
      label: 'node-pool-service-logs',
    });
    successful(result, 'Node pool Service logs');
    return result.stdout;
  }

  reserve(workloadId: string, timeoutMs: number): Promise<TrackedWorkloadRef> {
    return this.#kernel.reserve(workloadId, timeoutMs);
  }

  async createAndAwaitRunning(
    ref: TrackedWorkloadRef,
    input: {
      readonly image: string;
      readonly port: number;
      readonly nodePoolId: string;
    },
    timeoutMs: number,
  ) {
    const options: CliRunOptions = {
      timeoutMs: 120_000,
      label: 'node-pool-service-create',
    };
    // `anycloud service` has no machine-readable output; it prints `ID: <id>`
    // for the created workload, and the id was chosen here.
    const created = await this.#mutations.runCliCreate(
      ref,
      cliArgs(
        'service',
        {
          'node-pool': input.nodePoolId,
          id: ref.id,
          // The product probes `$PORT`; the image must be told where it listens.
          env: `PORT=${String(input.port)}`,
        },
        [input.image],
      ),
      options,
    );
    successful(created, 'Node pool Service create');
    if (!created.combined.includes(`ID: ${ref.id}`)) {
      throw new Error(
        `Node pool Service create did not acknowledge ${ref.id}: ${created.combined}`,
      );
    }
    const running = await this.#kernel.waitForState(
      ref,
      WorkloadState.Running,
      timeoutMs,
    );
    const runningEventAt = running.events.find(
      (event) => event.state === WorkloadState.Running,
    )?.createdAt;
    if (runningEventAt === undefined) {
      throw new Error(
        'Node pool Service running status carries no running event',
      );
    }
    // `anycloud wait` must agree: a Service on a node pool is ready at Running.
    if (!(await waitReadyByCli(this.#cli, ref.id, 60_000))) {
      throw new Error(
        'anycloud wait did not report the node pool Service ready',
      );
    }
    return {
      nodePoolId: running.workload.nodePoolId ?? null,
      liveVmCount: await this.#vmLedger.liveVmCount(ref),
      runningEventAt,
    };
  }

  async publicEndpoint(ref: TrackedWorkloadRef) {
    const { workload, events } = await this.#kernel.status(ref);
    // The newest event's reason/message is the block or failure the product
    // recorded (status metadata itself omits the latest message).
    const latest = events.at(-1)?.metadata;
    const message = [latest?.reason, latest?.message]
      .filter((value): value is string => typeof value === 'string')
      .join(': ');
    // Services slice 2b adds `publicEndpoint` to the summary (always present,
    // null until published); a product without it publishes no URL for pool
    // Services and the route steps are skipped rather than failed.
    const summary: PublicEndpointSummary & { id: string } = workload;
    return {
      supported: 'publicEndpoint' in summary,
      state: workload.state,
      message: message || null,
      url: workload.dnsRecordId ? `https://${ref.id}.anycloud.sh` : null,
      endpoint: summary.publicEndpoint ?? null,
    };
  }

  async terminate(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<CleanupRecorded> {
    await this.#kernel.requestTermination(ref, timeoutMs);
    return this.#kernel.waitForCleanupRecorded(ref, timeoutMs);
  }

  async release(
    ref: TrackedWorkloadRef,
    cleanup: CleanupRecorded,
  ): Promise<void> {
    await this.#kernel.release({
      cleanup,
      ledger: this.#kernel.recordLedgerCleared(
        ref,
        await this.#vmLedger.liveVmCount(ref),
      ),
      substrate: this.#kernel.recordSubstrateAbsence(ref),
    });
  }
}
