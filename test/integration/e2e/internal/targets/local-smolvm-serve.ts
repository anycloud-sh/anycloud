import type {
  WorkloadCliCreateTransport,
  WorkloadCliUpgradeTransport,
} from '../workload-mutations.js';
import { cliArgs } from '../cli-surface.js';
import type { TrackedWorkloadRef } from '../workloads.js';
import type {
  LocalSmolvmServeTargetTransport,
  ServeAbsenceObservationAttempt,
  ServeBackingHost,
  ServeReadyObservationAttempt,
  ServeSubmission,
  ServeSubmissionAcceptance,
  ServeTarget,
  ServeUpgradeTargetAdapter,
} from './serve-types.js';

type LocalSmolvmServeMutationTransport = WorkloadCliCreateTransport &
  WorkloadCliUpgradeTransport;

const SUBMIT_TIMEOUT_MS = 300_000;

/**
 * Submits a Service to the Local substrate through the public CLI, with no
 * credential: the Local provider is reachable without one, and proving that
 * remains true is part of what this target exists to check.
 *
 * The forwarded host ports only exist while the microVM does, so the adapter
 * remembers the pair it observed while ready. That is the adapter's memory of
 * its own observation, not lifecycle policy: without it, teardown could only
 * show the microVM is gone and never that the ports it opened were closed.
 */
export class LocalSmolvmServeAdapter implements ServeUpgradeTargetAdapter {
  readonly profile = { kind: 'local-smolvm' } as const;
  readonly #forwardedPorts = new Map<string, readonly number[]>();
  readonly #mutations: LocalSmolvmServeMutationTransport;
  readonly #transport: LocalSmolvmServeTargetTransport;
  readonly #cleanupTransport: Pick<
    LocalSmolvmServeTargetTransport,
    'observeAbsent'
  >;

  constructor(dependencies: {
    readonly mutations: LocalSmolvmServeMutationTransport;
    readonly transport: LocalSmolvmServeTargetTransport;
    readonly cleanupTransport: Pick<
      LocalSmolvmServeTargetTransport,
      'observeAbsent'
    >;
  }) {
    this.#mutations = dependencies.mutations;
    this.#transport = dependencies.transport;
    this.#cleanupTransport = dependencies.cleanupTransport;
  }

  async submit(
    ref: TrackedWorkloadRef,
    submission: ServeSubmission,
  ): Promise<ServeSubmissionAcceptance> {
    this.#assertTarget(submission.target);
    const args = cliArgs(
      'service',
      {
        id: ref.id,
        'env-file': submission.environmentFile,
        env: Object.entries(submission.environment).map(
          ([name, value]) => `${name}=${value}`,
        ),
        secret: submission.secretNames,
      },
      [submission.image],
      submission.command ?? [],
    );

    await this.#mutations.runCliCreateWithTransientRetries(ref, args, {
      timeoutMs: SUBMIT_TIMEOUT_MS,
      label: 'local-smolvm-serve-submit',
    });
    return { id: ref.id };
  }

  async upgrade(
    ref: TrackedWorkloadRef,
    submission: ServeSubmission,
  ): Promise<void> {
    this.#assertTarget(submission.target);
    const args = cliArgs(
      'service upgrade',
      {},
      [ref.id, submission.image],
      submission.command ?? [],
    );
    await this.#mutations.runCliUpgrade(ref, args, {
      timeoutMs: SUBMIT_TIMEOUT_MS,
      label: 'local-smolvm-serve-upgrade',
    });
  }

  async observeReady(
    ref: TrackedWorkloadRef,
    target: ServeTarget,
  ): Promise<ServeReadyObservationAttempt> {
    this.#assertTarget(target);
    const observation = await this.#transport.observeReady(ref.id);
    if (observation.sshHostPort > 0 && observation.httpHostPort > 0) {
      this.#forwardedPorts.set(ref.id, [
        ...new Set([
          ...(this.#forwardedPorts.get(ref.id) ?? []),
          observation.sshHostPort,
          observation.httpHostPort,
        ]),
      ]);
    }
    return { kind: 'observed', observation };
  }

  async observeAbsent(
    ref: TrackedWorkloadRef,
    target: ServeTarget,
    hosts: readonly ServeBackingHost[],
    deadlineAt?: number,
  ): Promise<ServeAbsenceObservationAttempt> {
    this.#assertTarget(target);
    return {
      kind: 'observed',
      observation: await this.#cleanupTransport.observeAbsent(
        ref.id,
        hosts,
        this.#forwardedPorts.get(ref.id) ?? [],
        deadlineAt,
      ),
    };
  }

  #assertTarget(target: ServeTarget): void {
    if (target.kind !== 'local-smolvm') {
      throw new Error('Local Serve adapter received a different target');
    }
  }
}
