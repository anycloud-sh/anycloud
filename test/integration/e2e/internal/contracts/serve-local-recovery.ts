import { WorkloadState } from '../../../../../src/shared/workload.js';

import type { ArtifactStore } from '../artifacts.js';
import type { Environment } from '../environment.js';
import {
  NAMED_SECRET_PROBE_KEY,
  type NamedSecretProbeFixture,
} from '../probes/named-secret.js';
import type {
  LocalSmolvmServeReadyObservation,
  ServeLocalRecoveryContractResult,
  ServeReadyObservation,
  ServeSubmission,
} from '../targets/serve-types.js';
import { retryTransientProbeError } from '../wait.js';
import { serveLocalRecoveryPolicy, serveStageBudget } from './serve-policy.js';
import {
  awaitServeReady,
  serveInvariant,
  submitServe,
  observeServeTermination,
  serviceCleanupFault,
  upgradeServe,
  type ServeUpgradeStageDependencies,
} from './serve.js';

/**
 * Evidence that the control plane lost its memory and came back as itself. An
 * unchanged identity is what separates a restart from a replacement: only the
 * former forces recovery to read durable state.
 */
export interface ControlPlaneRestart {
  readonly identityAfter: string;
  readonly identityBefore: string;
}

export interface ControlPlaneRestartFault {
  restart(): Promise<ControlPlaneRestart>;
}

export interface ServeLocalRecoveryDependencies {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly environment: Pick<Environment, 'milliseconds' | 'optional'>;
  readonly faults: ControlPlaneRestartFault;
  readonly probes: {
    readonly namedSecret: Pick<NamedSecretProbeFixture, 'create'>;
  };
  readonly stages: ServeUpgradeStageDependencies;
}

/** States from which the restart checkpoint can no longer be taken. */
const PAST_CHECKPOINT: readonly WorkloadState[] = [
  WorkloadState.Running,
  WorkloadState.Completed,
  WorkloadState.Errored,
  WorkloadState.Failed,
  WorkloadState.Invalid,
  WorkloadState.Terminated,
];

/** Reported by the workload when the injected secret hashes as expected. */
const SECRET_MARKER = 'secret-ok';
const EXPECTED_DIGEST_KEY = 'SERVE_EXPECTED_SHA256';

/**
 * Writes the page once before serving, so the response is a fixed fact about
 * the container's startup environment rather than something a later request
 * could change. The digest comparison keeps the secret's value out of both the
 * page and the process table.
 */
function serveMarker(marker: string): readonly string[] {
  return [
    'sh',
    '-c',
    [
      'mkdir -p /www',
      `printf '%s\\n' "${marker}" > /www/index.html`,
      `if [ "$(printf %s "$${NAMED_SECRET_PROBE_KEY}" | sha256sum | cut -d" " -f1)" = "$${EXPECTED_DIGEST_KEY}" ]`,
      `then printf '%s\\n' '${SECRET_MARKER}' >> /www/index.html`,
      "else printf '%s\\n' 'secret-missing' >> /www/index.html",
      'fi',
      'exec busybox httpd -f -p "$PORT" -h /www',
    ].join('; '),
  ];
}

/**
 * What the Service holds at the moment the controller is killed. Recovery is
 * only meaningful against facts captured before the fault, so these are read
 * once and never refreshed.
 */
export interface StartingCheckpoint {
  readonly guestContainerId: string;
  readonly httpHostPort: number;
  readonly machineName: string;
  readonly sshHostPort: number;
}

interface CheckpointProbe {
  readonly latestState: WorkloadState;
  readonly observation: LocalSmolvmServeReadyObservation | undefined;
  readonly state: WorkloadState;
}

/**
 * Whether the microVM is already serving. Deliberately not the shared `ready`
 * predicate: that one describes a Service the control plane has recorded as
 * Running, and this one describes the opposite — a workload answering while
 * the control plane still has it Starting.
 */
export function servingUnmet(
  observation: LocalSmolvmServeReadyObservation | undefined,
  markers: readonly string[],
): string | undefined {
  if (!observation) return 'no Local observation yet';
  if (observation.machineCount !== 1) {
    return `expected exactly one owned microVM, saw ${String(observation.machineCount)}`;
  }
  if (observation.machineState !== 'running') {
    return `microVM is ${observation.machineState || 'absent'}`;
  }
  if (observation.sshHostPort <= 0 || observation.httpHostPort <= 0) {
    return 'microVM has not forwarded both guest ports';
  }
  if (observation.sshHostPort === observation.httpHostPort) {
    return 'microVM forwarded one host port for both guest ports';
  }
  if (!observation.guestContainerId)
    return 'guest workload container is absent';
  const missing = markers.filter(
    (marker) => !observation.responseBody.includes(marker),
  );
  if (missing.length > 0) {
    return `workload is not yet answering with ${missing.join(', ')}`;
  }
  return undefined;
}

/**
 * Why the recovered Service is not the one that was checkpointed, or
 * `undefined` if recovery adopted it whole. Identity is the entire point: an
 * equivalent replacement would satisfy every other Serve assertion.
 */
export function adoptionUnmet(
  checkpoint: StartingCheckpoint,
  recovered: ServeReadyObservation,
): string | undefined {
  if (recovered.kind !== 'local-smolvm') {
    return 'recovered Service did not report a Local observation';
  }
  if (recovered.machineName !== checkpoint.machineName) {
    return 'recovery replaced the microVM instead of adopting the one it checkpointed';
  }
  if (
    recovered.sshHostPort !== checkpoint.sshHostPort ||
    recovered.httpHostPort !== checkpoint.httpHostPort
  ) {
    return 'recovery changed the forwarded host ports';
  }
  if (recovered.guestContainerId !== checkpoint.guestContainerId) {
    return 'recovery replaced the guest workload container';
  }
  return undefined;
}

/**
 * A Local Service survives losing its control plane. The member takes the
 * shared submission stage, waits for the window in which the workload answers
 * but the control plane has not yet recorded `Running`, kills and restarts the
 * controller there, and then rejoins the shared ready stage — so recovery is
 * judged by exactly the same standard as a Service that was never disturbed.
 * It then requires that the recovered Service is the *same* microVM, ports,
 * and guest container, not an equivalent replacement.
 */
export class ServeLocalRecoveryContract {
  readonly #dependencies: ServeLocalRecoveryDependencies;

  constructor(dependencies: ServeLocalRecoveryDependencies) {
    this.#dependencies = dependencies;
  }

  async run(target: 'local-smolvm'): Promise<ServeLocalRecoveryContractResult> {
    const { artifacts, environment, faults, probes, stages } =
      this.#dependencies;
    const policy = serveLocalRecoveryPolicy(environment);
    const scope = 'lsrv';
    const firstMarker = `local-smolvm-serve-${scope}-v1`;
    const replacementMarker = `local-smolvm-serve-${scope}-v2`;
    const secret = await probes.namedSecret.create(scope);
    const submission: ServeSubmission = {
      command: serveMarker(firstMarker),
      environment: { [EXPECTED_DIGEST_KEY]: secret.digest },
      image: policy.image,
      secretNames: [secret.name],
      target: { kind: target },
    };

    const submitted = await submitServe(
      stages,
      scope,
      submission,
      serveStageBudget(policy),
    );
    const checkpoint = await this.#awaitStartingCheckpoint(
      submitted.ref,
      submission,
      [firstMarker, SECRET_MARKER],
      policy.checkpointTimeoutMs,
    );

    const restart = await faults.restart();
    serveInvariant(
      restart.identityBefore === restart.identityAfter,
      'the control plane was replaced rather than restarted, so recovery was not tested',
    );

    const recovered = await awaitServeReady(
      stages,
      submitted,
      [firstMarker, SECRET_MARKER],
      serveStageBudget(policy),
    );
    this.#assertAdopted(checkpoint, recovered.readyObservation);

    const upgraded = await upgradeServe(
      stages,
      recovered,
      { ...submission, command: serveMarker(replacementMarker) },
      [replacementMarker, SECRET_MARKER],
      serveStageBudget(policy, policy.upgradeTimeoutMs),
    );
    await serviceCleanupFault(this.#dependencies, upgraded);
    const proofs = await observeServeTermination(
      stages,
      upgraded,
      serveStageBudget(policy),
    );
    await secret.release();
    await stages.kernel.release(proofs);

    const result: ServeLocalRecoveryContractResult = {
      contract: 'serve-local-recovery',
      qualification: 'conclusive',
      satisfied: true,
      target,
    };
    await artifacts.json('serve-local-recovery-result', result);
    return result;
  }

  async #awaitStartingCheckpoint(
    ref: Parameters<
      ServeUpgradeStageDependencies['targets']['observeReady']
    >[0],
    submission: ServeSubmission,
    markers: readonly string[],
    timeoutMs: number,
  ): Promise<StartingCheckpoint> {
    const { stages } = this.#dependencies;
    const probed = await stages.wait.for<CheckpointProbe>(
      'local-serve-starting-checkpoint',
      async () => {
        const status = await stages.kernel.status(ref);
        const state = status.workload.state;
        if (state !== WorkloadState.Starting) {
          return { latestState: state, observation: undefined, state };
        }
        const attempt = await stages.targets.observeReady(
          ref,
          submission.target,
        );
        const observation =
          attempt.kind === 'observed' &&
          attempt.observation.kind === 'local-smolvm'
            ? attempt.observation
            : undefined;
        // Re-read after the slow guest and HTTP probes: the state that decides
        // whether this checkpoint is still valid must not predate them.
        const latest = await stages.kernel.status(ref);
        return {
          latestState: latest.workload.state,
          observation,
          state,
        };
      },
      {
        intervalMs: 1_000,
        probeError: retryTransientProbeError,
        reject: (probe) =>
          PAST_CHECKPOINT.includes(probe.latestState)
            ? `Service reached ${probe.latestState} before the restart checkpoint could be taken`
            : undefined,
        timeoutMs,
        unmet: (probe) =>
          probe.state === WorkloadState.Starting
            ? servingUnmet(probe.observation, markers)
            : `Service is ${probe.state}, not Starting`,
      },
    );

    const observation = probed.observation;
    serveInvariant(
      observation !== undefined,
      'starting checkpoint resolved without a Local observation',
    );
    const checkpoint: StartingCheckpoint = {
      guestContainerId: observation.guestContainerId,
      httpHostPort: observation.httpHostPort,
      machineName: observation.machineName,
      sshHostPort: observation.sshHostPort,
    };
    await this.#dependencies.artifacts.json(
      'local-serve-starting-checkpoint',
      checkpoint,
    );
    return checkpoint;
  }

  #assertAdopted(
    checkpoint: StartingCheckpoint,
    recovered: ServeReadyObservation,
  ): void {
    const unmet = adoptionUnmet(checkpoint, recovered);
    serveInvariant(unmet === undefined, unmet ?? '');
  }
}
