import type {
  ServeSubmission,
  ServeUpgradeContractResult,
  VmProvider,
} from '../targets/serve-types.js';
import {
  serveContractPolicy,
  serveStageBudget,
  type ServeContractPolicy,
} from './serve-policy.js';
import {
  provisionReadyServe,
  serveInvariant,
  observeServeTermination,
  serviceCleanupFault,
  upgradeServe,
  type ReadyServe,
  type ServeMemberDependencies,
  type ServeUpgradeStageDependencies,
} from './serve.js';
import { WorkloadState } from '../../../../../src/shared/workload.js';
import {
  SERVICE_CHECKPOINT_MARKER_FILE,
  type ServiceUpgradeRecoveryProbe,
} from '../probes/serve-upgrade-recovery.js';
import type { PublicCloudServeAdapter } from '../targets/public-cloud-serve.js';
import type { ControlPlaneRestartFault } from './serve-local-recovery.js';
import type { StatusResponse } from '../types.js';

interface ServeUpgradeDependencies extends ServeMemberDependencies {
  recovery: Pick<ServiceUpgradeRecoveryProbe, 'create'>;
  faults: ControlPlaneRestartFault;
}

/** A plain upgrade changes the image as well as the command. */
const PLAIN_UPGRADE_IMAGE = 'python:3.13-alpine';

function serveMarker(marker: string, checkpoint = false): readonly string[] {
  return [
    'sh',
    '-c',
    `set -e; mkdir -p /srv; echo ${marker} > /srv/index.html; printf '%s\\n' "$SERVICE_RESTART_MARKER" >> /srv/index.html; ${checkpoint ? `cat /mnt/checkpoint/${SERVICE_CHECKPOINT_MARKER_FILE} >> /srv/index.html; ` : ''}cd /srv; exec python -m http.server "$PORT" --bind 0.0.0.0`,
  ];
}

/**
 * A Service keeps its logical identity and public URL across a
 * capacity-replacing upgrade. The member starts from the shared ready journey,
 * accepts one upgrade, and requires the durable transition, a replacement
 * host, and the new marker at the unchanged URL before taking the common
 * terminal path. The member runs both journeys: `plain` upgrades a Service
 * with no checkpoint bucket to a new image; `checkpointed` holds a checkpoint
 * and restarts the API mid-upgrade.
 */
export class ServeUpgradeContract {
  readonly #dependencies: ServeUpgradeDependencies;

  constructor(dependencies: ServeUpgradeDependencies) {
    this.#dependencies = dependencies;
  }

  #stages(target: VmProvider) {
    const policy = serveContractPolicy(this.#dependencies.environment);
    const adapter = this.#dependencies.targets.adapter(target);
    serveInvariant(
      adapter.profile.provider === target,
      'Serve target factory returned the wrong adapter',
    );
    const stages: ServeUpgradeStageDependencies = {
      nativeCleanup: this.#dependencies.nativeCleanup,
      kernel: this.#dependencies.kernel,
      names: this.#dependencies.names,
      targets: adapter,
      vmLedger: this.#dependencies.vmLedger,
      wait: this.#dependencies.wait,
      now: this.#dependencies.now,
    };
    return { adapter, policy, stages };
  }

  async run(target: VmProvider): Promise<ServeUpgradeContractResult> {
    await this.plain(target);
    return this.checkpointed(target);
  }

  /**
   * The ordinary upgrade: a Service without a checkpoint bucket moves to a new
   * image on replacement capacity, and its old VM is gone before teardown.
   */
  async plain(target: VmProvider): Promise<ServeUpgradeContractResult> {
    const { adapter, policy, stages } = this.#stages(target);
    const scope = `svpl-${target}`;
    const firstMarker = `anycloud-serve-upgrade-${scope}-v1`;
    const replacementMarker = `anycloud-serve-upgrade-${scope}-v2`;
    const environmentMarker = `environment-${scope}`;
    const submission: ServeSubmission = {
      command: serveMarker(firstMarker),
      environment: { SERVICE_RESTART_MARKER: environmentMarker },
      image: policy.image,
      target: { kind: 'public-cloud', provider: target },
    };
    const service = await provisionReadyServe(
      stages,
      scope,
      submission,
      [firstMarker, environmentMarker],
      serveStageBudget(policy),
    );
    serveInvariant(
      !service.readyStatus.workload.checkpointBucket,
      'the plain upgrade journey must start without a checkpoint bucket',
    );
    const upgraded = await upgradeServe(
      stages,
      service,
      {
        ...submission,
        image: PLAIN_UPGRADE_IMAGE,
        command: serveMarker(replacementMarker),
      },
      [replacementMarker, environmentMarker],
      serveStageBudget(policy, policy.upgradeTimeoutMs),
    );
    await awaitOldHostAbsent(
      stages,
      adapter,
      service,
      upgraded,
      service.hosts[0]?.cloudId,
      policy.upgradeTimeoutMs,
    );
    return this.#finish(
      target,
      stages,
      upgraded,
      policy,
      'serve-upgrade-plain',
    );
  }

  async checkpointed(target: VmProvider): Promise<ServeUpgradeContractResult> {
    const { adapter, policy, stages } = this.#stages(target);
    const scope = `svup-${target}`;
    const recovery = await this.#dependencies.recovery.create(target, scope);
    const firstMarker = `anycloud-serve-upgrade-${scope}-v1`;
    const replacementMarker = `anycloud-serve-upgrade-${scope}-v2`;
    const environmentMarker = `environment-${scope}`;
    const submission: ServeSubmission = {
      command: serveMarker(firstMarker),
      environment: { SERVICE_RESTART_MARKER: environmentMarker },
      checkpointBucket: recovery.bucketName,
      checkpointStorageRegion: recovery.region,
      image: policy.image,
      target: { kind: 'public-cloud', provider: target },
    };

    const service = await provisionReadyServe(
      stages,
      scope,
      submission,
      [firstMarker, environmentMarker],
      serveStageBudget(policy),
    );
    const replacement = {
      ...submission,
      command: serveMarker(replacementMarker, true),
    };
    const hold = await recovery.hold(service);
    let upgraded;
    try {
      upgraded = await upgradeServe(
        stages,
        service,
        replacement,
        [replacementMarker, environmentMarker, recovery.marker],
        serveStageBudget(policy, policy.upgradeTimeoutMs),
        async () => {
          const capture = async (phase: string) => {
            await hold.assertHeld();
            const current = await stages.kernel.status(service.ref, true);
            const facts = acceptedUpgradeCheckpoint(current, {
              previous: service.readyStatus,
              replacement,
              cloudId: hold.cloudId,
              vmId: hold.vmId,
            });
            await this.#dependencies.artifacts.json(`serve-upgrade-${phase}`, {
              ...facts,
              checkpointHostPath: hold.checkpointHostPath,
            });
            return facts;
          };
          const before = await capture('before-restart');
          const restart = await this.#dependencies.faults.restart();
          serveInvariant(
            restart.identityBefore === restart.identityAfter,
            'Service recovery replaced the API container instead of restarting it',
          );
          const after = await capture('after-restart');
          serveInvariant(
            JSON.stringify(after) === JSON.stringify(before),
            'restart changed the accepted upgrade or old attempt checkpoint authority',
          );
          await hold.release();
        },
      );
    } catch (error) {
      // Even a failed assertion must unblock exact-host teardown before fallback cleanup.
      try {
        await hold.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Service upgrade and checkpoint hold release failed',
        );
      }
      throw error;
    }
    await hold.release();
    await awaitOldHostAbsent(
      stages,
      adapter,
      service,
      upgraded,
      hold.cloudId,
      policy.upgradeTimeoutMs,
    );
    return this.#finish(target, stages, upgraded, policy, undefined, () =>
      recovery.releaseBucket(),
    );
  }

  async #finish(
    target: VmProvider,
    stages: ServeUpgradeStageDependencies,
    upgraded: ReadyServe,
    policy: ServeContractPolicy,
    /** Undefined keeps the checkpointed journey's established artifact names. */
    prefix: string | undefined,
    beforeRelease?: () => Promise<void>,
  ): Promise<ServeUpgradeContractResult> {
    await serviceCleanupFault(this.#dependencies, upgraded, prefix);
    const proofs = await observeServeTermination(
      stages,
      upgraded,
      serveStageBudget(policy),
    );
    await beforeRelease?.();
    await stages.kernel.release(proofs);

    const result: ServeUpgradeContractResult = {
      contract: 'serve-upgrade',
      qualification: 'conclusive',
      satisfied: true,
      target,
    };
    await this.#dependencies.artifacts.json(
      `${prefix ?? 'serve-upgrade'}-result`,
      result,
    );
    return result;
  }
}

/** Prove the exact old provider capacity is gone before terminating the replacement. */
async function awaitOldHostAbsent(
  stages: ServeUpgradeStageDependencies,
  adapter: Pick<PublicCloudServeAdapter, 'observeHosts'>,
  service: ReadyServe,
  upgraded: ReadyServe,
  cloudId: string | undefined,
  timeoutMs: number,
): Promise<void> {
  serveInvariant(
    upgraded.hosts.length === service.hosts.length + 1,
    'upgrade did not record a replacement backing host',
  );
  await stages.wait.for(
    'Service upgrade released the exact old VM',
    (deadlineAt) =>
      adapter.observeHosts(
        service.submission.target,
        service.hosts,
        deadlineAt,
      ),
    {
      timeoutMs,
      intervalMs: 5_000,
      probeError: 'fail',
      unmet: (hosts) =>
        hosts.length === 1 &&
        hosts[0]?.cloudId === cloudId &&
        hosts[0].presence === 'absent'
          ? undefined
          : 'original VM absence is not confirmed',
    },
  );
}

/** Only current accepted configuration and real prior attempt/event identities are evidence. */
export function acceptedUpgradeCheckpoint(
  current: StatusResponse,
  expected: {
    previous: StatusResponse;
    replacement: ServeSubmission;
    cloudId: string;
    vmId: number;
  },
) {
  const { previous, replacement, cloudId, vmId } = expected;
  const latest = current.events.at(-1);
  const eventId = (status: StatusResponse, state: WorkloadState) =>
    status.events.filter((event) => event.state === state).at(-1)?.id ?? null;
  serveInvariant(
    current.workload.id === previous.workload.id &&
      current.workload.workloadType === 'service' &&
      current.workload.state === WorkloadState.Recovering,
    'restart boundary must be the accepted Service in Recovering',
  );
  serveInvariant(
    current.workload.image === replacement.image &&
      JSON.stringify(current.workload.command) ===
        JSON.stringify(replacement.command),
    'restart boundary does not contain the accepted replacement configuration',
  );
  serveInvariant(
    current.workload.checkpointBucket === replacement.checkpointBucket &&
      current.workload.checkpointStorageRegion ===
        replacement.checkpointStorageRegion &&
      current.workload.dnsRecordId === previous.workload.dnsRecordId &&
      !!current.workload.dnsRecordId,
    'restart boundary changed checkpoint or public URL ownership',
  );
  serveInvariant(
    latest?.state === WorkloadState.Recovering &&
      latest.metadata?.reason === 'serve-upgrade',
    'restart boundary is missing its durable serve-upgrade transition',
  );
  for (const state of [WorkloadState.Running, WorkloadState.Provisioning]) {
    serveInvariant(
      eventId(current, state) === eventId(previous, state),
      'replacement started before the restart checkpoint',
    );
  }
  return {
    workloadId: current.workload.id,
    vmId,
    cloudId,
    image: current.workload.image,
    command: current.workload.command,
    imageDigest: current.workload.imageDigest,
    checkpointBucket: current.workload.checkpointBucket,
    checkpointStorageRegion: current.workload.checkpointStorageRegion,
    dnsRecordId: current.workload.dnsRecordId,
    upgradeEventId: latest.id,
    runningEventId: eventId(current, WorkloadState.Running),
    provisioningEventId: eventId(current, WorkloadState.Provisioning),
  };
}
