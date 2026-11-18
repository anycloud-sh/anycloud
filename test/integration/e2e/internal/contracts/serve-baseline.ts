import { CloudType } from '../../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { TrackedWorkloadRef } from '../workloads.js';
import type {
  EnvironmentProbe,
  EnvironmentProbeFixture,
} from '../probes/environment.js';
import type {
  NamedSecretProbe,
  NamedSecretProbeFixture,
} from '../probes/named-secret.js';
import type { ServeTargetFactory } from '../targets/serve.js';
import type {
  GpuServeContractResult,
  PublicCloudServeProfile,
  ServeContractResult,
  ServeSubmission,
  VmProvider,
} from '../targets/serve-types.js';
import { qualifyReadyGpuServe, type GpuServeEvidence } from './serve-gpu.js';
import { serveContractPolicy, serveStageBudget } from './serve-policy.js';
import {
  cpuServeCommand,
  gpuServeCommand,
  SERVE_EXPECTED_DIGEST_KEY,
  SERVE_SECRET_MARKER,
} from './serve-workload.js';
import {
  observeServeTermination,
  provisionReadyServe,
  serveBackingHosts,
  serveInvariant,
  serviceCleanupFault,
  type ReadyServe,
  type ServeMemberDependencies,
  type ServeStageBudget,
  type ServeStageDependencies,
} from './serve.js';

export interface ServeContractDependencies
  extends Omit<ServeMemberDependencies, 'targets'> {
  readonly targets: Pick<ServeTargetFactory, 'adapter' | 'gpuAdapter'>;
  readonly probes: {
    readonly environment: Pick<EnvironmentProbeFixture, 'create'>;
    readonly namedSecret: Pick<NamedSecretProbeFixture, 'create'>;
  };
}

/** The exact returned object identifies an owned, still-live baseline. */
export interface ActiveServeBaseline {
  readonly contract: 'serve-baseline';
  readonly profile: 'cpu' | 'gpu';
  readonly target: VmProvider;
  readonly ref: TrackedWorkloadRef;
}

interface OwnedBaseline {
  readonly baseline: ActiveServeBaseline;
  readonly service: ReadyServe;
  readonly budget: ServeStageBudget;
  readonly stages: ServeStageDependencies;
  readonly profile: PublicCloudServeProfile;
  readonly secret: NamedSecretProbe;
  readonly environment: EnvironmentProbe;
  phase:
    | 'ready'
    | 'qualifying'
    | 'qualified'
    | 'finalizing'
    | 'complete'
    | 'failed';
  gpu?: GpuServeEvidence;
}

const CLOUD_TYPES = {
  aws: CloudType.AWS,
  azure: CloudType.Azure,
  gcp: CloudType.GCP,
  lambda: CloudType.Lambda,
} satisfies Record<VmProvider, CloudType>;

function assertSelectedProfile(
  stored: ReadyServe['readyStatus']['workload'],
  target: VmProvider,
  profile: PublicCloudServeProfile,
): void {
  const vmTypes =
    typeof stored.vmType === 'string' ? [stored.vmType] : (stored.vmType ?? []);
  serveInvariant(
    stored.cloudProvider === CLOUD_TYPES[target] &&
      vmTypes.length > 0 &&
      vmTypes.every((vmType) => profile.vmTypes.includes(vmType)) &&
      (profile.region === undefined || stored.region === profile.region) &&
      (profile.diskSizeGb === undefined ||
        stored.diskSizeGb === profile.diskSizeGb),
    'ready Service differs from its selected provider or placement profile',
  );
}

/** Shared live baseline, named GPU extension, and one completion authority. */
export class ServeBaselineContract {
  readonly #dependencies: ServeContractDependencies;
  readonly #owned = new WeakMap<ActiveServeBaseline, OwnedBaseline>();

  constructor(dependencies: ServeContractDependencies) {
    this.#dependencies = dependencies;
  }

  async run(target: VmProvider): Promise<ServeContractResult> {
    const result = await this.finish(await this.begin(target));
    serveInvariant(
      result.contract === 'serve',
      'ordinary Service returned another completion',
    );
    return result;
  }

  async runGpu(target: VmProvider): Promise<GpuServeContractResult> {
    const baseline = await this.beginGpu(target);
    await this.qualifyGpu(baseline);
    const result = await this.finish(baseline);
    serveInvariant(
      result.contract === 'gpu-serve',
      'GPU Service returned another completion',
    );
    return result;
  }

  begin(target: VmProvider): Promise<ActiveServeBaseline> {
    return this.#begin(target, 'cpu');
  }

  beginGpu(target: VmProvider): Promise<ActiveServeBaseline> {
    return this.#begin(target, 'gpu');
  }

  async #begin(
    target: VmProvider,
    kind: ActiveServeBaseline['profile'],
  ): Promise<ActiveServeBaseline> {
    const policy = serveContractPolicy(this.#dependencies.environment);
    const adapter =
      kind === 'gpu'
        ? this.#dependencies.targets.gpuAdapter(target)
        : this.#dependencies.targets.adapter(target);
    serveInvariant(
      adapter.profile.provider === target,
      'Serve target factory returned the wrong adapter',
    );
    const stages: ServeStageDependencies = {
      nativeCleanup: this.#dependencies.nativeCleanup,
      kernel: this.#dependencies.kernel,
      names: this.#dependencies.names,
      targets: adapter,
      vmLedger: this.#dependencies.vmLedger,
      wait: this.#dependencies.wait,
      now: this.#dependencies.now,
    };
    const scope = kind === 'gpu' ? `gpu-serve-${target}` : `serve-${target}`;
    const secret = await this.#dependencies.probes.namedSecret.create(scope);
    const environment =
      await this.#dependencies.probes.environment.create(scope);
    const submission: ServeSubmission = {
      command: kind === 'gpu' ? gpuServeCommand() : cpuServeCommand(),
      environment: {
        ...environment.directEnvironment,
        [SERVE_EXPECTED_DIGEST_KEY]: secret.digest,
      },
      environmentFile: environment.environmentFile,
      image: kind === 'gpu' ? 'python:3.12-slim' : policy.image,
      secretNames: [secret.name],
      target: { kind: 'public-cloud', provider: target },
    };
    const budget = serveStageBudget(policy);
    const service = await provisionReadyServe(
      stages,
      scope,
      submission,
      [...environment.markers, SERVE_SECRET_MARKER],
      budget,
    );
    const profile = adapter.profile;
    assertSelectedProfile(service.readyStatus.workload, target, profile);
    const baseline: ActiveServeBaseline = Object.freeze({
      contract: 'serve-baseline',
      profile: kind,
      target,
      ref: service.ref,
    });
    this.#owned.set(baseline, {
      baseline,
      service,
      budget,
      stages,
      profile,
      secret,
      environment,
      phase: 'ready',
    });
    return baseline;
  }

  async qualifyGpu(baseline: ActiveServeBaseline): Promise<GpuServeEvidence> {
    const owned = this.#owned.get(baseline);
    serveInvariant(
      owned?.phase === 'ready' && owned.baseline.profile === 'gpu',
      'GPU extension requires its owned live baseline exactly once',
    );
    owned.phase = 'qualifying';
    try {
      const current = await owned.stages.kernel.status(owned.service.ref, true);
      await owned.stages.nativeCleanup.capture(owned.service.ref, current);
      serveInvariant(
        current.workload.id === owned.service.ref.id &&
          current.workload.workloadType === 'service' &&
          current.workload.state === WorkloadState.Running &&
          current.workload.cleanedAt === null,
        'GPU extension cannot consume a stopped or foreign Service',
      );
      serveInvariant(
        current.workload.dnsRecordId ===
          owned.service.readyStatus.workload.dnsRecordId,
        'GPU extension changed the active Service DNS identity',
      );
      const liveHosts = serveBackingHosts(
        owned.stages,
        owned.service.ref,
        current,
      );
      serveInvariant(
        JSON.stringify(liveHosts) === JSON.stringify(owned.service.hosts),
        'GPU extension replaced the active Service backing host',
      );
      assertSelectedProfile(
        current.workload,
        owned.baseline.target,
        owned.profile,
      );
      owned.gpu = qualifyReadyGpuServe(
        { ...owned.service, readyStatus: current },
        owned.profile,
      );
      await this.#dependencies.artifacts.json('gpu-serve-evidence', {
        workloadId: owned.service.ref.id,
        target: owned.baseline.target,
        profile: owned.profile,
        image: current.workload.image,
        imageDigest: current.workload.imageDigest,
        hosts: liveHosts,
        dnsRecordId: current.workload.dnsRecordId,
        url: owned.gpu.url,
        devices: owned.gpu.devices,
      });
      owned.phase = 'qualified';
      return owned.gpu;
    } catch (error) {
      owned.phase = 'failed';
      throw error;
    }
  }

  async finish(
    baseline: ActiveServeBaseline,
  ): Promise<ServeContractResult | GpuServeContractResult> {
    const owned = this.#owned.get(baseline);
    serveInvariant(
      owned && (owned.phase === 'ready' || owned.phase === 'qualified'),
      'Service finalizer requires its owned active baseline and cannot complete twice',
    );
    serveInvariant(
      owned.baseline.profile === 'cpu' ||
        (owned.phase === 'qualified' && owned.gpu?.ref === owned.service.ref),
      'Service finalizer omitted required GPU evidence',
    );
    owned.phase = 'finalizing';
    try {
      await serviceCleanupFault(this.#dependencies, owned.service);
      const proofs = await observeServeTermination(
        owned.stages,
        owned.service,
        owned.budget,
      );
      await owned.environment.release();
      await owned.secret.release();
      await owned.stages.kernel.release(proofs);
      const result: ServeContractResult | GpuServeContractResult = {
        contract: owned.baseline.profile === 'gpu' ? 'gpu-serve' : 'serve',
        qualification: 'conclusive',
        satisfied: true,
        target: owned.baseline.target,
      };
      await this.#dependencies.artifacts.json(`${result.contract}-result`, {
        ...result,
        workloadId: owned.service.ref.id,
        profile: owned.profile,
        image: owned.service.readyStatus.workload.image,
        imageDigest: owned.service.readyStatus.workload.imageDigest,
        dnsRecordId: owned.service.readyStatus.workload.dnsRecordId,
        gpu: owned.gpu,
        cleanup: {
          completedAt: proofs.cleanup.status.workload.completedAt,
          cleanedAt: proofs.cleanup.status.workload.cleanedAt,
          nativeAbsence: proofs.nativeAbsence,
          namedBundle: { name: owned.secret.name, absent: true },
        },
      });
      owned.phase = 'complete';
      return result;
    } catch (error) {
      owned.phase = 'failed';
      throw error;
    }
  }
}
