import type {
  WorkloadCliCreateTransport,
  WorkloadCliUpgradeTransport,
} from '../workload-mutations.js';
import { cliArgs } from '../cli-surface.js';
import type { TrackedWorkloadRef } from '../workloads.js';
import {
  publicServeUrl,
  type PublicCloudServeProfile,
  type PublicCloudServeTargetTransport,
  type ServeAbsenceObservationAttempt,
  type ServeBackingHost,
  type ServeHostAbsence,
  type ServeReadyObservationAttempt,
  type ServeSubmission,
  type ServeSubmissionAcceptance,
  type ServeTarget,
  type ServeUpgradeTargetAdapter,
} from './serve-types.js';

type PublicCloudServeMutationTransport = WorkloadCliCreateTransport &
  WorkloadCliUpgradeTransport;

const SUBMIT_TIMEOUT_MS = 300_000;

/**
 * Submits a Service through the public CLI and observes its endpoint,
 * recorded hosts, and authoritative DNS absence. It selects no lifecycle
 * policy and holds no credential material.
 */
export class PublicCloudServeAdapter implements ServeUpgradeTargetAdapter {
  readonly profile: PublicCloudServeProfile;
  readonly #mutations: PublicCloudServeMutationTransport;
  readonly #transport: PublicCloudServeTargetTransport;

  constructor(dependencies: {
    readonly mutations: PublicCloudServeMutationTransport;
    readonly profile: PublicCloudServeProfile;
    readonly transport: PublicCloudServeTargetTransport;
  }) {
    this.#mutations = dependencies.mutations;
    this.profile = Object.freeze({
      ...dependencies.profile,
      vmTypes: Object.freeze([...dependencies.profile.vmTypes]),
    });
    this.#transport = dependencies.transport;
  }

  async submit(
    ref: TrackedWorkloadRef,
    submission: ServeSubmission,
  ): Promise<ServeSubmissionAcceptance> {
    this.#assertTarget(submission.target);
    await this.#transport.ensureCredential();
    const args = cliArgs(
      'service',
      {
        id: ref.id,
        credentials: this.profile.credentialName,
        'vm-type': this.profile.vmTypes,
        region: this.profile.region,
        'disk-size':
          this.profile.diskSizeGb === undefined
            ? undefined
            : String(this.profile.diskSizeGb),
        gpus: this.profile.gpus,
        runtime: this.profile.runtime,
        'checkpoint-bucket': submission.checkpointBucket,
        'checkpoint-storage-region': submission.checkpointStorageRegion,
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
      label: `${this.profile.provider}-serve-submit`,
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
      label: `${this.profile.provider}-serve-upgrade`,
    });
  }

  async observeReady(
    ref: TrackedWorkloadRef,
    target: ServeTarget,
  ): Promise<ServeReadyObservationAttempt> {
    this.#assertTarget(target);
    const url = publicServeUrl(ref.id);
    const probe = await this.#transport.observeEndpoint(url);
    return {
      kind: 'observed',
      observation: {
        kind: 'public-cloud',
        error: probe.error,
        provider: this.profile.provider,
        responseBody: probe.responseBody,
        statusCode: probe.statusCode,
        url,
      },
    };
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
      observation: {
        kind: 'public-cloud',
        dns: await this.#transport.observeDns(
          new URL(publicServeUrl(ref.id)).hostname,
          deadlineAt,
        ),
        hosts: await this.observeHosts(target, hosts, deadlineAt),
        provider: this.profile.provider,
      },
    };
  }

  /** Upgrade retains ingress while proving that its former capacity is gone. */
  observeHosts(
    target: ServeTarget,
    hosts: readonly ServeBackingHost[],
    deadlineAt?: number,
  ): Promise<readonly ServeHostAbsence[]> {
    this.#assertTarget(target);
    return this.#transport.observeHosts(hosts, deadlineAt);
  }

  #assertTarget(target: ServeTarget): void {
    if (
      target.kind !== 'public-cloud' ||
      target.provider !== this.profile.provider
    ) {
      throw new Error(
        `${this.profile.provider} Serve adapter received a different target`,
      );
    }
  }
}
