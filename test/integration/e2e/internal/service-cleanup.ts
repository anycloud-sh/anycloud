import type { ArtifactStore } from './artifacts.js';
import type { ApiClient } from './api.js';
import { assertServeCleanupRecorded } from './contracts/serve.js';
import type { PersistentVmCleanup } from './persistent-vm-cleanup.js';
import type { ProviderProfiles, VmProfile } from './profiles.js';
import type { SecretManager } from './secrets.js';
import type { LocalSmolvmServeAdapter } from './targets/local-smolvm-serve.js';
import {
  publicServeUrl,
  type ServeAbsenceObservationAttempt,
  type ServeDnsAbsenceObservation,
  type ServeTarget,
  type ServeTargetAdapter,
} from './targets/serve-types.js';
import type { ServiceDnsProbe } from './transports/service-dns.js';
import type { Waiter } from './wait.js';
import type { TrackedWorkloadRef } from './workloads.js';

interface ServiceCleanupDependencies {
  readonly cleanupApi: Pick<ApiClient, 'lookupStatus'>;
  readonly native: Pick<PersistentVmCleanup, 'reserveWithProfile'>;
  readonly profiles: Pick<ProviderProfiles, 'serve' | 'gpuServe'>;
  readonly dns: Pick<ServiceDnsProbe, 'observe'>;
  readonly local: Pick<LocalSmolvmServeAdapter, 'observeAbsent'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly namedBundles: Pick<SecretManager, 'deleteForCleanup'>;
}

/** Service-owned DNS/ports join the existing VM-native cleanup registration. */
export class ServiceCleanup {
  readonly #dependencies: ServiceCleanupDependencies;

  constructor(dependencies: ServiceCleanupDependencies) {
    this.#dependencies = dependencies;
  }

  reserve(
    target: ServeTarget,
    profile: ServeTargetAdapter['profile'],
    id: string,
    timeoutMs: number,
    namedBundles: readonly string[] = [],
  ): Promise<TrackedWorkloadRef> {
    let selected: VmProfile | undefined;
    if (target.kind === 'public-cloud') {
      if ('kind' in profile || profile.provider !== target.provider)
        throw new Error('Service cleanup profile belongs to another target');
      selected =
        profile.gpus === 'all'
          ? this.#dependencies.profiles.gpuServe(target.provider)
          : this.#dependencies.profiles.serve(target.provider);
      if (
        selected.credentialName !== profile.credentialName ||
        JSON.stringify(selected.vmTypes) !== JSON.stringify(profile.vmTypes) ||
        selected.region !== profile.region ||
        selected.diskSizeGb !== profile.diskSizeGb
      )
        throw new Error('Service cleanup differs from its original profile');
    } else if (!('kind' in profile) || profile.kind !== 'local-smolvm') {
      throw new Error('Local Service cleanup received a cloud profile');
    }
    const bundles = [...namedBundles];
    return this.#dependencies.native.reserveWithProfile(
      target.kind === 'public-cloud' ? target.provider : 'local-smolvm',
      id,
      timeoutMs,
      selected,
      (ref, deadlineAt) => this.#verify(ref, target, bundles, deadlineAt),
    );
  }

  async #verify(
    ref: TrackedWorkloadRef,
    target: ServeTarget,
    namedBundles: readonly string[],
    deadlineAt: number,
  ): Promise<void> {
    const observations: (
      | ServeDnsAbsenceObservation
      | ServeAbsenceObservationAttempt
    )[] = [];
    const failures: unknown[] = [];
    const bundleAbsence: { name: string; absent: true }[] = [];
    let persistedWorkload:
      | {
          id: string;
          state: string;
          completedAt: number | null;
          cleanedAt: number | null | undefined;
        }
      | undefined;
    let completed = false;
    try {
      const lookup = await this.#dependencies.cleanupApi.lookupStatus(
        ref.id,
        true,
        deadlineAt,
      );
      if (lookup.kind !== 'found')
        throw new Error('Service cleanup has no persisted terminal record');
      const { id, state, completedAt, cleanedAt } = lookup.status.workload;
      persistedWorkload = { id, state, completedAt, cleanedAt };
      assertServeCleanupRecorded(ref, lookup.status);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error('Service cleanup deadline expired');
      await this.#dependencies.wait.for(
        `Service DNS and forwarded ports absent for ${ref.id}`,
        async (probeDeadlineAt) => {
          if (target.kind === 'public-cloud') {
            const hostname = new URL(publicServeUrl(ref.id)).hostname;
            const dns = await this.#dependencies.dns.observe(
              hostname,
              probeDeadlineAt,
            );
            observations.push(dns);
            if (
              dns.hostname !== hostname ||
              dns.authorities.length === 0 ||
              new Set(dns.authorities).size !== dns.authorities.length ||
              JSON.stringify([...dns.authorities].sort()) !==
                JSON.stringify(
                  dns.answers.map((answer) => answer.authority).sort(),
                )
            )
              throw new Error(
                'Service DNS cleanup omitted its hostname or an authority',
              );
            return dns.answers.every((answer) => answer.presence === 'absent')
              ? undefined
              : 'Service DNS remains present or unknown';
          }
          // Native cleanup already proved every historical VM and the complete
          // owned-machine inventory absent. The adapter retains observed ports.
          const attempt = await this.#dependencies.local.observeAbsent(
            ref,
            target,
            [],
            probeDeadlineAt,
          );
          observations.push(attempt);
          if (
            attempt.kind !== 'observed' ||
            attempt.observation.kind !== 'local-smolvm'
          )
            throw new Error(
              'Local Service cleanup did not observe its forwarded ports',
            );
          return attempt.observation.openForwardedPorts.length === 0
            ? undefined
            : 'Local Service forwarded ports remain open';
        },
        {
          timeoutMs: remaining,
          intervalMs: Math.min(2_000, remaining),
          probeError: 'fail',
          unmet: (reason) => reason,
        },
      );
      for (const name of namedBundles) {
        await this.#dependencies.namedBundles.deleteForCleanup(
          name,
          deadlineAt,
        );
        bundleAbsence.push({ name, absent: true });
      }
      if (Date.now() >= deadlineAt)
        throw new Error('Service cleanup deadline expired');
      completed = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#dependencies.artifacts.json(`service-${ref.id}-cleanup`, {
        schemaVersion: 1,
        workloadId: ref.id,
        target,
        completed,
        persistedWorkload,
        observations,
        namedBundles: bundleAbsence,
      });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'Service cleanup and evidence retention failed',
      );
  }
}
