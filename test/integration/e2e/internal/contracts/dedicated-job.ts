import { WorkloadState } from '../../../../../src/shared/workload.js';

import type { ArtifactStore } from '../artifacts.js';
import type { Environment } from '../environment.js';
import type { FixtureNames } from '../names.js';
import type { LocalSmolvmJobAdapter } from '../targets/local-smolvm-job.js';
import type { PublicCloudJobAdapter } from '../targets/public-cloud-job.js';
import type {
  DeliveredJobMember,
  CloudJobFixture,
  JobContractResult,
  JobFixture,
  JobMemberProfile,
  JobMaceObservation,
  JobNativeAttempt,
  JobSpotRequest,
  JobStageBudget,
} from '../targets/job-types.js';
import {
  jobGroupSize,
  JobResultNotJson,
  submittedVmTypes,
} from '../targets/job-types.js';
import {
  JOB_EVICTION_PAYLOAD_MIB,
  JOB_SPOT_EXIT_SECONDS,
} from '../targets/job-profiles.js';
import { isRecord, type StatusResponse } from '../types.js';
import type { WorkloadKernel } from '../workloads.js';
import {
  MAX_WAIT_MS,
  type ProbeRetryPolicy,
  WaitTimeoutError,
  Waiter,
} from '../wait.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import {
  GPU_HEALTH_FAULT_XID,
  gpuHealthFaultHumanLine,
} from '../probes/gpu-health-fault.js';
import {
  FAKE_VM_TYPE,
  jobMemberProfile,
  jobStageBudget,
} from './job-policy.js';
import {
  jobMolecules,
  retainedJobMolecules,
  jobHydrationManifest,
  jobGhcrThroughput,
  jobGhcrPull,
} from './job-observations.js';
import {
  JOB_TERMINAL_STATES,
  JOB_RECOVERY_STATES,
  JobRecords,
  jobInvariant,
  jobEvictionRestarted,
  jobHydrationRetryEvent,
  type JobHydrationObservation,
  type JobExtensionRecord,
  type JobProgress,
  type JobProgressObservation,
  type JobRun,
} from './job-records.js';

export interface DedicatedJobDependencies {
  now(this: void): number;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly environment: Pick<Environment, 'optional' | 'milliseconds'>;
  readonly names: Pick<FixtureNames, 'workload'>;
  readonly kernel: Pick<
    WorkloadKernel,
    | 'status'
    | 'requestTermination'
    | 'waitForState'
    | 'waitForCleanupRecorded'
    | 'recordLedgerCleared'
    | 'release'
  >;
  readonly target: Pick<
    LocalSmolvmJobAdapter,
    | 'prepare'
    | 'submit'
    | 'prepareTerminal'
    | 'submitTerminal'
    | 'firstGenerationAbsence'
    | 'resubmit'
    | 'attempts'
    | 'configuration'
    | 'storage'
    | 'lateInputRemainsAbsent'
    | 'completedByCli'
    | 'nativeAbsence'
    | 'releaseResources'
  >;
  readonly cloud?: Pick<PublicCloudJobAdapter, keyof PublicCloudJobAdapter>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly vmLedger: Pick<VmLedgerProbe, 'snapshot' | 'liveEntries'>;
}

interface JobFinalization {
  readonly fixture: JobFixture;
  readonly run: JobRun;
  readonly progress: JobProgress;
  readonly extensions: readonly JobExtensionRecord[];
  readonly terminalStatus: StatusResponse;
}

// A results.json synced mid-write parses on a later poll within the deadline.
const retryJobResultNotJson: ProbeRetryPolicy = {
  retry: (error) => error instanceof JobResultNotJson,
};

/** The family alone decides progress, extension satisfaction, terminal outcome and release. */
export class DedicatedJobContract {
  readonly #dependencies: DedicatedJobDependencies;
  readonly #records: JobRecords;

  constructor(dependencies: DedicatedJobDependencies) {
    this.#dependencies = dependencies;
    this.#records = new JobRecords(dependencies.vmLedger);
  }

  async run(member: DeliveredJobMember): Promise<JobContractResult> {
    const { artifacts, environment, kernel, names, target, wait, vmLedger } =
      this.#dependencies;
    const profile = jobMemberProfile(member, environment);
    const budget = jobStageBudget(profile.member, environment);
    const forced = environment.optional('E2E_JOB_FORCE_CLEANUP');
    jobInvariant(
      ['', '0', '1'].includes(forced),
      'forced-cleanup input must be 0 or 1',
    );
    if (profile.member.kind === 'invalid-admission') {
      jobInvariant(
        forced !== '1',
        'no-provision forced cleanup is Not applicable',
      );
      return this.#invalidAdmissionMember(profile, budget);
    }
    if (profile.member.kind === 'host-recovery')
      return this.#hostRecoveryMember(profile, budget, forced === '1');
    if (profile.member.kind === 'input-hydration-recovery')
      return this.#hydrationMember(profile, budget, forced === '1');
    if (profile.member.kind === 'spot-request-cleanup')
      return this.#spotMember(profile, budget, forced === '1');
    if (profile.member.kind === 'spot-eviction')
      return this.#evictionMember(profile, budget, forced === '1');
    if (profile.member.kind === 'gpu-spot-eviction')
      return this.#gpuEvictionMember(profile, budget, forced === '1');
    if (profile.member.kind === 'gpu-probe-rerun')
      return this.#gpuProbeRerunMember(profile, budget, forced === '1');
    if (profile.member.kind === 'gpu-health-fault')
      return this.#gpuHealthFaultMember(profile, budget, forced === '1');
    if (profile.member.kind === 'runtime-secrets')
      return this.#runtimeSecretsMember(profile, budget, forced === '1');
    if (profile.member.kind === 'restricted-credential')
      return this.#restrictedCredentialMember(profile, budget, forced === '1');
    if (profile.member.kind === 'ghcr-probe')
      return this.#ghcrMember(profile, budget, forced === '1');
    if (profile.member.kind === 'host-docker')
      return this.#hostDockerMember(profile, budget, forced === '1');
    if (profile.member.kind === 'mace-full-pull')
      return this.#maceMember(profile, budget, forced === '1');
    if (profile.member.kind === 'disk-tier')
      return this.#diskTierMember(profile, budget, forced === '1');
    if (
      profile.member.kind === 'bucket-sync' ||
      profile.member.kind === 'concurrent-output'
    )
      return this.#cloudMember(profile, budget, forced === '1');
    if (profile.member.kind !== 'local-held')
      return this.#terminalMember(profile, budget, forced === '1');
    const fixture = await target.prepare(
      names.workload('j-held'),
      profile,
      budget.cleanupMs,
    );
    const { ref } = fixture;
    const run = this.#records.begin(ref, profile, 1);
    await target.submit(fixture);

    const observed = await wait.for<JobProgressObservation>(
      `Job ${ref.id} active baseline`,
      async (deadlineAt) => ({
        status: await kernel.status(ref, true),
        attempts: await target.attempts(fixture, deadlineAt),
      }),
      {
        timeoutMs: budget.runningMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (observation) =>
          observation.status.workload.state === WorkloadState.Running ||
          JOB_TERMINAL_STATES.includes(observation.status.workload.state)
            ? undefined
            : observation.status.workload.state,
      },
    );
    const progress = this.#records.progress(run, observed);
    jobInvariant(
      progress.kind === 'active',
      'Local held extensions require a live Job',
    );
    const { status } = observed;
    jobInvariant(
      status.workload.cloudProvider === profile.computeProvider &&
        status.workload.region === 'local' &&
        status.workload.vmType === 'local',
      'Local status lost its placement',
    );
    const live = vmLedger.liveEntries(vmLedger.snapshot(ref, status));
    jobInvariant(
      live.length === 1 &&
        live[0].cloudId === `ac-local-${ref.id}-0` &&
        live[0].sshHost === 'localhost' &&
        typeof live[0].sshPort === 'number' &&
        live[0].sshPort > 0,
      'Local status lost its exact native/SSH identity',
    );
    jobInvariant(
      status.events.some((event) => event.state === WorkloadState.Syncing),
      'input hydration did not record Syncing',
    );
    const dockerCommand = status.workload.dockerCommand;
    jobInvariant(
      typeof dockerCommand === 'string' &&
        dockerCommand.includes('--env-file /run/anycloud-secrets/env') &&
        !dockerCommand.includes('GITHUB_TOKEN='),
      'stored Docker command exposed or omitted runtime secret configuration',
    );

    const configuration = await target.configuration(fixture);
    for (const name of [
      'workloadExec',
      'environment',
      'runtimeSecretFile',
      'labels',
      'dockerOptions',
      'stdoutLogs',
      'stderrLogs',
      'hostExec',
      'liveSecretFile',
    ] as const)
      jobInvariant(
        configuration[name] === true,
        `Local configuration assertion failed: ${name}`,
      );
    const configurationRecord = this.#records.extension(
      run,
      progress,
      'local-configuration',
    );
    const storage = await wait.for(
      'Local Job output and checkpoint contents',
      () => target.storage(fixture),
      {
        timeoutMs: budget.storageMs,
        intervalMs: 1_000,
        probeError: 'fail',
        unmet: (observation) =>
          observation.output === `output-${ref.id}` &&
          observation.checkpoint === `checkpoint-${ref.id}`
            ? undefined
            : 'output/checkpoint markers missing',
      },
    );
    jobInvariant(
      await target.lateInputRemainsAbsent(fixture),
      'input continued synchronizing after hydration',
    );
    const storageRecord = this.#records.extension(
      run,
      progress,
      'local-storage',
    );
    await artifacts.json(`job-${ref.id}-active-extensions`, {
      member: profile.member,
      workloadId: ref.id,
      generation: run.generation,
      requestedImage: profile.image,
      resolvedManifestDigest: status.workload.imageDigest,
      progress,
      configuration,
      storage,
      lateInputAbsent: true,
    });

    if (forced === '1')
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: local-held after active extensions, before finalization',
      );
    await kernel.requestTermination(ref, 180_000);
    const terminalStatus = await kernel.waitForState(
      ref,
      profile.expectedTerminalState,
      180_000,
    );
    return this.#finalize(
      [
        {
          fixture,
          run,
          progress,
          extensions: [configurationRecord, storageRecord],
          terminalStatus,
        },
      ],
      budget.cleanupMs,
    );
  }

  async #ghcrMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts, now } = this.#dependencies;
    const target = this.#cloud();
    jobInvariant(profile.ghcr, 'GHCR lacks its original probe profile');
    const deadlineAt = now() + budget.storageMs;
    const id = names.workload('j-ghcr');
    const fixtures = await target.prepare([id], profile, budget);
    jobInvariant(
      fixtures.length === 1 &&
        fixtures[0].ref.id === id &&
        fixtures[0].profile === profile,
      'GHCR requires its original Job fixture and reference',
    );
    const fixture = fixtures[0];
    const run = this.#records.begin(fixture.ref, profile, 1);
    const probe = target.ghcr(fixture);
    const image = await probe.prepare();
    jobInvariant(
      image.image === profile.ghcr.image &&
        ((image.resolution === 'runner' &&
          /^sha256:[a-f0-9]{64}$/u.test(image.layerDigest) &&
          Number.isSafeInteger(image.imageBytes) &&
          image.imageBytes >= 0) ||
          (image.resolution === 'vm-auto' &&
            image.layerDigest === 'auto' &&
            image.imageBytes === 0)),
      'GHCR image facts do not identify the declared pinned payload',
    );
    await target.submit(fixture);
    const { progress, observation } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );
    const attempt = observation.attempts.find((row) => row.endedAt === null)!;
    await probe.bind(attempt);
    const throughput = jobGhcrThroughput(await probe.throughput(deadlineAt));
    await probe.startPull();
    if (forced)
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: azure ghcr-probe after detached pull launch, before pull finalization',
      );
    let executionError: Error | undefined;
    let terminalPolls = 0;
    try {
      const remaining = Math.min(
        profile.ghcr.pullTimeoutMs,
        deadlineAt - now(),
      );
      jobInvariant(
        remaining > 0,
        'GHCR exhausted its original runner deadline',
      );
      const exit = await wait.for(
        'GHCR detached containerd pull',
        async (deadline) => {
          const value = await probe.poll(deadline);
          terminalPolls =
            value.state === 'inactive' || value.state === 'failed'
              ? terminalPolls + 1
              : 0;
          return value;
        },
        {
          timeoutMs: remaining,
          intervalMs: profile.ghcr.pollMs,
          probeError: 'fail',
          unmet: (value) =>
            value.state === 'done'
              ? undefined
              : 'detached pull has no exit record',
          reject: () =>
            terminalPolls >= 3
              ? 'GHCR unit ended without its original exit record (125)'
              : undefined,
        },
      );
      jobInvariant(
        exit.exitCode === 0,
        'GHCR detached containerd pull exited nonzero',
      );
    } catch (error) {
      executionError =
        error instanceof Error
          ? error
          : new Error('GHCR pull failed', { cause: error });
    }
    let output: string;
    try {
      output = await probe.capture();
    } catch (error) {
      if (executionError)
        throw new AggregateError(
          [executionError, error],
          'GHCR pull and output capture failed',
        );
      throw error;
    }
    if (executionError) throw executionError;
    const pull = jobGhcrPull(output, profile.ghcr.measureBaseline);
    await probe.finish(deadlineAt);
    const extension = this.#records.extension(run, progress, 'ghcr-probe');
    await artifacts.json(`job-${id}-ghcr-extension`, {
      workloadId: id,
      generation: run.generation,
      profile,
      progress,
      attempt,
      image,
      throughput,
      pull,
      extension,
    });
    await kernel.requestTermination(fixture.ref, budget.cleanupMs);
    const terminalStatus = await kernel.waitForState(
      fixture.ref,
      profile.expectedTerminalState,
      budget.completionMs,
    );
    return this.#finalize(
      [{ fixture, run, progress, extensions: [extension], terminalStatus }],
      budget.cleanupMs,
    );
  }

  async #maceMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts, now } = this.#dependencies;
    const target = this.#cloud();
    jobInvariant(profile.mace, 'MACE lacks its original observer profile');
    const id = names.workload(
      `j-mace${profile.mace.runLabel ? `-${profile.mace.runLabel}` : ''}`,
    );
    const fixtures = await target.prepare([id], profile, budget);
    jobInvariant(
      fixtures.length === 1 &&
        fixtures[0].ref.id === id &&
        fixtures[0].profile === profile,
      'MACE requires its original fixture and reference',
    );
    const fixture = fixtures[0];
    const run = this.#records.begin(fixture.ref, profile, 1);
    const probe = target.mace(fixture);
    let observer: JobMaceObservation | undefined;
    let status: StatusResponse | undefined;
    let deliveryPath = 'unknown';
    const writeReport = () => probe.writeReport(status, observer, deliveryPath);
    try {
      const startedAt = now();
      await probe.start(profile.mace.observerTimeoutMs);
      observer = await wait.for(
        'MACE observer armed before submission',
        () => probe.observation(),
        {
          timeoutMs: 10_000,
          intervalMs: 100,
          probeError: 'fail',
          unmet: (value) =>
            value ? undefined : 'observer receipt not written',
          reject: (value) =>
            value && value.phase !== 'armed'
              ? 'observer ran before its Job submission'
              : undefined,
        },
      );
      jobInvariant(
        observer &&
          observer.phase === 'armed' &&
          observer.workloadId === id &&
          observer.runId === `${id}-run` &&
          observer.observerArmedAtMs >= startedAt &&
          observer.observerArmedAtMs <= now(),
        'MACE observer lacks its original pre-submission binding',
      );
      const armedAt = observer.observerArmedAtMs;
      const deadlineAt = armedAt + profile.mace.observerTimeoutMs;
      const submittedAt = now();
      await target.submit(fixture);
      const active = await this.#cloudProgress(fixture, run, budget.runningMs);
      status = active.observation.status;
      if (forced)
        throw new Error(
          `E2E_JOB_FORCED_CLEANUP: ${profile.member.target} mace-full-pull after active baseline, before inference finalization`,
        );
      jobInvariant(
        deadlineAt > now(),
        'MACE observer exhausted its original deadline',
      );
      observer = await wait.for(
        'MACE first CUDA inference',
        () => probe.observation(),
        {
          timeoutMs: deadlineAt - now(),
          intervalMs: 1_000,
          probeError: 'fail',
          unmet: (value) =>
            value?.phase === 'observed'
              ? undefined
              : 'first inference is not observed',
          reject: (value) =>
            value?.phase === 'failed'
              ? 'MACE observer failed before CUDA inference'
              : undefined,
        },
      );
      const marker = observer?.marker?.payload;
      jobInvariant(
        observer &&
          observer.schemaVersion === 2 &&
          observer.observationSource === 'ci-api-log-stream' &&
          observer.workloadId === id &&
          observer.runId === `${id}-run` &&
          observer.observerArmedAtMs === armedAt &&
          typeof observer.firstInferenceLogObservedAtMs === 'number' &&
          Number.isSafeInteger(observer.firstInferenceLogObservedAtMs) &&
          observer.firstInferenceLogObservedAtMs >= submittedAt &&
          observer.firstInferenceLogObservedAtMs <= now() &&
          marker?.name === 'first_inference_done' &&
          marker.runId === `${id}-run` &&
          marker.device === 'cuda' &&
          typeof marker.energy === 'number' &&
          Number.isFinite(marker.energy),
        'MACE inference is missing, non-CUDA, early or belongs to another run',
      );
      await probe.finish();
      status = await kernel.waitForState(
        fixture.ref,
        WorkloadState.Completed,
        budget.completionMs,
      );
      this.#assertExit(status, 0);
      jobInvariant(
        status.workload.imageDigest === profile.image.split('@')[1],
        'MACE did not retain its original pinned image digest',
      );
      const messages = await probe.pullLogMessages();
      if (
        messages.includes('Image pulled successfully with containerd transfer')
      )
        deliveryPath = 'containerd-transfer';
      // Docker is acceptable only where the host cannot transfer (containerd
      // older than 2.1); a transfer that ran and fell back is a failure.
      else if (
        messages.includes('Image pulled successfully') &&
        messages.includes('Containerd transfer unavailable; using Docker pull')
      )
        deliveryPath = 'docker-fallback';
      jobInvariant(
        deliveryPath !== 'unknown',
        'MACE lacks a successful declared image delivery path',
      );
      const extension = this.#records.extension(
        run,
        active.progress,
        'mace-full-pull',
      );
      await writeReport();
      await artifacts.json(`job-${id}-mace-extension`, {
        workloadId: id,
        generation: run.generation,
        profile,
        progress: active.progress,
        attempt: active.observation.attempts,
        observer,
        deliveryPath,
        extension,
      });
      return await this.#finalize(
        [
          {
            fixture,
            run,
            progress: active.progress,
            extensions: [extension],
            terminalStatus: status,
          },
        ],
        budget.cleanupMs,
      );
    } catch (error) {
      // Keep the existing report format on failure, without a new API read or
      // hiding the original failure behind diagnostics or rescue cleanup.
      try {
        await writeReport();
      } catch (reportError) {
        throw new AggregateError(
          [error, reportError],
          'MACE Job and report capture failed',
        );
      }
      throw error;
    }
  }

  async #diskTierMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const cases = profile.diskTierCases;
    jobInvariant(
      cases?.length === 6,
      'disk-tier requires all six original cases',
    );
    const ids = cases.map((diskCase) =>
      names.workload(`j-disk-${diskCase.key}`),
    );
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === cases.length &&
        new Set(fixtures.map((fixture) => fixture.ref)).size === cases.length &&
        fixtures.every(
          (fixture, index) =>
            fixture.ref.id === ids[index] &&
            fixture.profile === profile &&
            fixture.diskTierCase === cases[index] &&
            fixture.concurrentIndex === index,
        ),
      'disk-tier requires every original case and reference',
    );
    const children: JobFinalization[] = [];
    for (const fixture of fixtures) {
      const diskCase = fixture.diskTierCase!;
      const run = this.#records.begin(fixture.ref, profile, 1);
      await target.submit(fixture);
      const { progress, observation } = await this.#cloudProgress(
        fixture,
        run,
        budget.runningMs,
      );
      const attempt = observation.attempts.find(
        (candidate) => candidate.endedAt === null,
      )!;
      const disk = await target.diskTier(fixture, attempt);
      jobInvariant(
        disk.ref === fixture.ref &&
          disk.rowId === attempt.rowId &&
          disk.identity.cloudId === attempt.cloudId &&
          disk.identity.vmType === diskCase.vmType &&
          disk.identity.region === profile.computeRegion &&
          disk.identity.zone ===
            `${profile.computeRegion}-${profile.computeZone}` &&
          /^[1-9][0-9]*$/u.test(disk.identity.vmId) &&
          /^[1-9][0-9]*$/u.test(disk.identity.osDiskId),
        'disk-tier native observation lost its original VM, disk or placement',
      );
      jobInvariant(
        disk.diskType === diskCase.expectedType,
        'disk-tier created the wrong native boot-disk type',
      );
      if (diskCase.expectedIops !== undefined)
        jobInvariant(
          disk.sizeGb === 100 &&
            disk.provisionedIops === diskCase.expectedIops &&
            disk.provisionedThroughput === 1_000,
          'disk-tier lost its provisioned Hyperdisk size or performance',
        );
      const extension = this.#records.extension(run, progress, 'disk-tier');
      await artifacts.json(`job-${fixture.ref.id}-disk-tier`, {
        workloadId: fixture.ref.id,
        generation: run.generation,
        profile,
        diskCase,
        progress,
        attempt,
        disk,
      });
      if (forced && fixture.concurrentIndex === fixtures.length - 1)
        throw new Error(
          'E2E_JOB_FORCED_CLEANUP: disk-tier after all six native disk assertions, before final child termination',
        );
      await kernel.requestTermination(fixture.ref, budget.cleanupMs);
      const terminalStatus = await kernel.waitForState(
        fixture.ref,
        profile.expectedTerminalState,
        budget.completionMs,
      );
      // Preserve the legacy serial resource profile: the next case cannot
      // allocate until this case is actually absent. References stay armed;
      // only the finalizer can release them or complete the whole member.
      const cleanup = await kernel.waitForCleanupRecorded(
        fixture.ref,
        budget.cleanupMs,
      );
      jobInvariant(
        cleanup.status.workload.state === profile.expectedTerminalState,
        'disk-tier cleanup changed its terminal outcome',
      );
      await target.nativeAbsence(fixture, budget.cleanupMs);
      children.push({
        fixture,
        run,
        progress,
        extensions: [extension],
        terminalStatus,
      });
    }
    return this.#finalize(children, budget.cleanupMs);
  }

  async #invalidAdmissionMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, vmLedger, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const cases = profile.admissionCases;
    jobInvariant(cases?.length, 'invalid-admission cases are missing');
    const ids = cases.map((admissionCase) =>
      names.workload(`j-invalid-${admissionCase.kind}`),
    );
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === cases.length &&
        new Set(fixtures.map((fixture) => fixture.ref)).size === cases.length &&
        fixtures.every(
          (fixture, index) =>
            fixture.ref.id === ids[index] &&
            fixture.profile === profile &&
            fixture.admissionCase === cases[index] &&
            fixture.concurrentIndex === index,
        ),
      'admission requires every original case and reference',
    );
    const children: {
      fixture: CloudJobFixture;
      run: JobRun;
      record: JobExtensionRecord;
      kind: 'rejected' | 'invalid';
    }[] = [];
    for (const fixture of fixtures) {
      const admissionCase = fixture.admissionCase!;
      const run = this.#records.begin(fixture.ref, profile, 1);
      const acknowledgement = await target.submitAdmission(fixture);
      jobInvariant(
        acknowledgement ===
          (admissionCase.outcome === 'rejected' ? 'rejected' : 'accepted'),
        `admission ${admissionCase.kind} returned the wrong acknowledgement`,
      );
      if (acknowledgement === 'accepted')
        await wait.for(
          `Job ${fixture.ref.id} named Invalid guard`,
          async () => {
            const state = await target.admissionStatus(fixture);
            jobInvariant(
              [WorkloadState.Queued, WorkloadState.Invalid].includes(state),
              'Invalid admission entered provisioning, retry or runtime',
            );
            return state;
          },
          {
            timeoutMs: budget.runningMs,
            intervalMs: 2_000,
            probeError: 'fail',
            unmet: (state) =>
              state === WorkloadState.Invalid ? undefined : state,
          },
        );
      const outcome = await target.admissionOutcome(fixture);
      const record = this.#records.admission(run, admissionCase, outcome);
      children.push({ fixture, run, record, kind: outcome.kind });
    }
    // Claim every case before release; a partial member cannot emit completion.
    for (const { run, record } of children)
      this.#records.claimAdmission(run, record);
    for (const { fixture, kind } of children) {
      const cleanup =
        kind === 'invalid'
          ? await kernel.waitForCleanupRecorded(fixture.ref, budget.cleanupMs)
          : undefined;
      if (cleanup)
        jobInvariant(
          cleanup.status.workload.state === WorkloadState.Invalid,
          'Invalid cleanup changed the original terminal outcome',
        );
      const substrate = await target.nativeAbsence(fixture, budget.cleanupMs);
      if (cleanup) {
        const snapshot = vmLedger.snapshot(fixture.ref, cleanup.status);
        const entries = vmLedger.liveEntries(snapshot);
        jobInvariant(entries.length === 0, 'Invalid admission retained a VM');
        const ledger = kernel.recordLedgerCleared(fixture.ref, entries.length);
        await kernel.release({ cleanup, ledger, substrate });
      } else await target.releaseUncreated(fixture, substrate);
      await target.releaseResources(fixture);
    }
    const result: JobContractResult = {
      contract: 'dedicated-job',
      member: profile.member,
      target: profile.member.target,
      qualification: 'conclusive',
      satisfied: true,
    };
    await artifacts.json('dedicated-job-result', {
      ...result,
      failureCleanup: 'Not applicable',
      children: children.map(({ fixture, run, kind }) => ({
        workloadId: fixture.ref.id,
        generation: run.generation,
        admissionCase: fixture.admissionCase!.kind,
        outcome: kind,
        nativeResourcesCreated: false,
      })),
    });
    return result;
  }

  async #runtimeSecretsMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, artifacts, vmLedger, wait, now } =
      this.#dependencies;
    const target = this.#cloud();
    const ids = [names.workload('j-secret'), names.workload('j-override')];
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === 2 &&
        new Set(fixtures.map((fixture) => fixture.ref)).size === 2 &&
        fixtures.every(
          (fixture, index) =>
            fixture.ref.id === ids[index] &&
            fixture.concurrentIndex === index &&
            fixture.profile === profile,
        ),
      'runtime secrets require both original member children',
    );
    const runs = fixtures.map((fixture) =>
      this.#records.begin(fixture.ref, profile, 1),
    );
    await this.#settle(
      fixtures.map((fixture) => target.submit(fixture)),
      'Runtime-secret Job submission',
    );
    const active: {
      progress: JobProgress;
      observation: JobProgressObservation;
    }[] = [];
    for (const [index, fixture] of fixtures.entries())
      active.push(
        await this.#cloudProgress(fixture, runs[index], budget.runningMs),
      );
    const primary = fixtures[0];
    const original = active[0].observation.attempts.map((attempt) =>
      Object.freeze({ ...attempt }),
    );
    const before = await target.runtimeSecretFacts(primary);
    const override = await target.runtimeSecretFacts(fixtures[1]);
    jobInvariant(
      before.environment &&
        before.mode === '600' &&
        before.uid === 0 &&
        before.fileSystem === 'tmpfs',
      'runtime-secret injection or protected tmpfs file failed',
    );
    jobInvariant(
      before.privateGit === true && override.privateGit === true,
      'private Git did not clone through the github Secret, or cloned without it',
    );
    jobInvariant(
      override.environment && override.containerId !== before.containerId,
      'explicit environment did not override the second Job secret',
    );
    if (forced)
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: runtime-secrets after both active containers, before secret deletion/finalization',
      );

    // Live files: read-only on tmpfs, a save reaches the running container,
    // and the poll restores files a reboot's empty /run would lose.
    const file = await target.runtimeSecretFile(primary);
    jobInvariant(
      file.value === 'newest' &&
        file.mode === '444' &&
        file.uid === 0 &&
        file.nobodyReads === true &&
        file.fileSystem === 'tmpfs',
      'runtime-secret file is missing, writable, unreadable or not on tmpfs',
    );
    const arrival = async (label: string): Promise<number> => {
      const startedAt = now();
      await wait.for(label, () => target.runtimeSecretFile(primary), {
        timeoutMs: 60_000,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (observed) =>
          observed.value === 'newest' ? undefined : `file is ${observed.value}`,
      });
      return now() - startedAt;
    };
    await target.updateRuntimeSecret(primary);
    const updateMs = await arrival('Saved Secret reaching the running Job');
    await target.clearRuntimeSecretFiles(primary);
    const restoreMs = await arrival('Secret files restored after /run clears');

    await target.forceDeleteRuntimeSecret(primary);
    const after = await target.runtimeSecretFacts(primary);
    jobInvariant(
      (await target.runtimeSecretFile(primary)).value === 'newest',
      'force deletion removed the last Secret files',
    );
    const status = await kernel.status(primary.ref, true);
    const attempts = await target.attempts(primary);
    const live = vmLedger.liveEntries(vmLedger.snapshot(primary.ref, status));
    const originalLive = original.find((attempt) => attempt.endedAt === null);
    const requestedTypes = Array.isArray(status.workload.vmType)
      ? status.workload.vmType
      : [status.workload.vmType];
    const fields = [
      'ref',
      'rowId',
      'createdAt',
      'endedAt',
      'cloudId',
      'ip',
      'cloudProvider',
      'credentialId',
      'region',
      'availabilityZone',
      'vmType',
    ] as const;
    jobInvariant(
      after.environment &&
        after.containerId === before.containerId &&
        after.startedAt === before.startedAt &&
        status.workload.id === primary.ref.id &&
        status.workload.state === WorkloadState.Running &&
        status.workload.cloudProvider === profile.computeProvider &&
        status.workload.region === (profile.computeRegion || null) &&
        requestedTypes.length === profile.vmTypes.length &&
        requestedTypes.every(
          (type, index) => type === profile.vmTypes[index],
        ) &&
        originalLive &&
        attempts.length === original.length &&
        new Set(attempts.map((attempt) => attempt.rowId)).size ===
          attempts.length &&
        original.every((attempt) => {
          const retained = attempts.find((row) => row.rowId === attempt.rowId);
          return (
            retained && fields.every((key) => retained[key] === attempt[key])
          );
        }) &&
        live.length === 1 &&
        String(live[0].cloudId) === originalLive.cloudId &&
        live[0].region === originalLive.region &&
        (live[0].availabilityZone ?? null) === originalLive.availabilityZone,
      'force deletion changed the warm container or original running attempt',
    );
    const extensions = runs.map((run, index) =>
      this.#records.extension(run, active[index].progress, 'runtime-secrets'),
    );
    await artifacts.json('job-runtime-secrets', {
      member: profile.member,
      children: fixtures.map((fixture, index) => ({
        workloadId: fixture.ref.id,
        generation: runs[index].generation,
        progress: active[index].progress,
        extension: extensions[index],
      })),
      originalAttempts: original,
      retainedAttempts: attempts,
      before,
      override,
      after,
      file,
      updateMs,
      restoreMs,
    });
    await this.#settle(
      fixtures.map((fixture) =>
        kernel.requestTermination(fixture.ref, 180_000),
      ),
      'Runtime-secret Job termination',
    );
    const children: JobFinalization[] = [];
    for (const [index, fixture] of fixtures.entries())
      children.push({
        fixture,
        run: runs[index],
        progress: active[index].progress,
        extensions: [extensions[index]],
        terminalStatus: await kernel.waitForState(
          fixture.ref,
          WorkloadState.Terminated,
          budget.completionMs,
        ),
      });
    return this.#finalize(children, budget.cleanupMs);
  }

  /** RFC 0047 S1-S4, S11: a restricted credential runs every case. */
  async #restrictedCredentialMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const restricted = profile.restrictedCredential;
    jobInvariant(
      restricted !== undefined && restricted.cases.length > 0,
      'restricted-credential member lacks its original cases',
    );
    const ids = restricted.cases.map((restrictedCase) =>
      names.workload(`j-rc-${restrictedCase.key}`),
    );
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === restricted.cases.length &&
        fixtures.every(
          (fixture, index) =>
            fixture.ref.id === ids[index] &&
            fixture.profile === profile &&
            fixture.restrictedCredentialCase === restricted.cases[index] &&
            Boolean(fixture.outputBucket) ===
              (restricted.cases[index].key === 'output'),
        ),
      'restricted-credential preparation changed its original cases',
    );
    const runs = fixtures.map((fixture) =>
      this.#records.begin(fixture.ref, profile, 1),
    );
    // The cases run concurrently and independently, so one failing case
    // still reports the others. Each holds Running for minutes, so its
    // baseline is read before it completes.
    const outcomes = await Promise.allSettled(
      fixtures.map(async (fixture, index) => {
        const restrictedCase = restricted.cases[index];
        await target.submit(fixture);
        const active = await this.#cloudProgress(
          fixture,
          runs[index],
          budget.runningMs,
        );
        const region = active.observation.attempts.find(
          (attempt) => attempt.endedAt === null,
        )?.region;
        jobInvariant(
          region !== undefined &&
            (!restricted.regions || restricted.regions.includes(region)) &&
            (!restrictedCase.region || restrictedCase.region === region),
          'restricted-credential Job ran outside its allowed regions',
        );
        if (forced)
          throw new Error(
            'E2E_JOB_FORCED_CLEANUP: restricted-credential after an active baseline, before completion',
          );
        const terminalStatus = await kernel.waitForState(
          fixture.ref,
          WorkloadState.Completed,
          budget.completionMs,
        );
        this.#assertExit(terminalStatus, 0);
        const output = fixture.outputBucket
          ? await wait.for(
              'Restricted-credential Job output in its same-account bucket',
              (deadline) => target.results(fixture, 'output', deadline),
              {
                timeoutMs: budget.storageMs,
                intervalMs: 5_000,
                probeError: retryJobResultNotJson,
                unmet: (value) =>
                  JSON.stringify(value) ===
                  JSON.stringify({ marker: fixture.runLabel })
                    ? undefined
                    : 'output marker has not reached the bucket',
              },
            )
          : undefined;
        const child: JobFinalization = {
          fixture,
          run: runs[index],
          progress: active.progress,
          extensions: [
            this.#records.extension(
              runs[index],
              active.progress,
              'restricted-credential',
            ),
          ],
          terminalStatus,
        };
        return { child, region, output };
      }),
    );
    const report = outcomes.map((outcome, index) => ({
      scenario: restricted.cases[index].scenario,
      workloadId: fixtures[index].ref.id,
      case: restricted.cases[index],
      outputBucket: fixtures[index].outputBucket ?? null,
      ...(outcome.status === 'fulfilled'
        ? {
            satisfied: true,
            region: outcome.value.region,
            output: outcome.value.output ?? null,
          }
        : {
            satisfied: false,
            error:
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
          }),
    }));
    await artifacts.json('job-restricted-credential', {
      member: profile.member,
      allowedRegions: restricted.regions ?? null,
      children: report,
    });
    const failed = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [
            {
              scenario: report[index].scenario,
              reason: outcome.reason as unknown,
            },
          ]
        : [],
    );
    if (failed.length)
      throw new AggregateError(
        failed.map(({ reason }) => reason),
        `Restricted-credential cases failed: ${report
          .map((entry) =>
            entry.satisfied
              ? `${entry.scenario} passed`
              : `${entry.scenario} failed (${'error' in entry ? entry.error : ''})`,
          )
          .join('; ')}`,
      );
    const children = outcomes
      .map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.child : undefined,
      )
      .filter((child): child is JobFinalization => child !== undefined);
    return this.#finalize(children, budget.cleanupMs);
  }

  /**
   * `--host-docker` with nesting: the listener Job's probe
   * (host-docker-probe.ts) publishes a port on every interface, then runs
   * Docker, Compose, a bind mount and a KVM guest through the host. Where the
   * policy gives it one (AWS, GCP), a prober Job in the same region and
   * network, submitted once the listener runs, must find that port closed and
   * SSH open. Each exits 0 only when its checks pass.
   */
  async #hostDockerMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const ids = [names.workload('j-host-docker')];
    if (profile.hostDockerPeer) ids.push(names.workload('j-host-peer'));
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === ids.length &&
        fixtures.every(
          (fixture, index) =>
            fixture.profile === profile && fixture.concurrentIndex === index,
        ),
      'host-docker preparation changed its listener and prober',
    );
    const [listener, prober] = fixtures;
    const runs = fixtures.map((fixture) =>
      this.#records.begin(fixture.ref, profile, 1),
    );
    const privateIp = (observation: JobProgressObservation, role: string) => {
      const ip = observation.attempts.find(
        (attempt) => attempt.endedAt === null,
      )?.privateIp;
      jobInvariant(
        typeof ip === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(ip),
        `host-docker ${role} has no private IPv4 address`,
      );
      return ip;
    };
    await target.submit(listener);
    const listening = await this.#cloudProgress(
      listener,
      runs[0],
      budget.runningMs,
    );
    if (profile.diskIops !== undefined) {
      const attempt = listening.observation.attempts.find(
        (row) => row.endedAt === null,
      );
      jobInvariant(attempt, 'host-docker listener has no live attempt');
      const disk = await target.diskTier(listener, attempt);
      await artifacts.json(`job-${listener.ref.id}-root-disk`, disk);
      // The native volume carries the Job's own IOPS and MiB/s.
      jobInvariant(
        disk.diskType === 'gp3' &&
          disk.provisionedIops === profile.diskIops &&
          disk.provisionedThroughput === profile.diskThroughputMibps,
        `the listener's root volume lacks its requested gp3 performance: ${JSON.stringify(disk)}`,
      );
    }
    let probe:
      | { peer: string; progress: JobProgress; status: StatusResponse }
      | undefined;
    if (prober) {
      const peer = privateIp(listening.observation, 'listener');
      await target.submit(prober, peer);
      const probing = await this.#cloudProgress(
        prober,
        runs[1],
        budget.runningMs,
      );
      // A prober that reached its own address would prove nothing.
      jobInvariant(
        privateIp(probing.observation, 'prober') !== peer,
        'host-docker prober shares its peer address',
      );
      if (forced)
        throw new Error(
          'E2E_JOB_FORCED_CLEANUP: host-docker after both active baselines, before completion',
        );
      const status = await kernel.waitForState(
        prober.ref,
        WorkloadState.Completed,
        budget.completionMs,
      );
      this.#assertExit(status, 0);
      // Its port was still published: a closed verdict isn't a listener gone.
      const held = await kernel.status(listener.ref, true);
      const logs = held.events.findLast(
        (event) => typeof event.metadata?.logs === 'string',
      )?.metadata?.logs;
      jobInvariant(
        held.workload.state === WorkloadState.Running,
        `host-docker listener ended (${held.workload.state}) before its prober finished: ${typeof logs === 'string' ? logs.slice(-1500) : 'no logs'}`,
      );
      probe = { peer, progress: probing.progress, status };
    } else if (forced)
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: host-docker after an active baseline, before completion',
      );
    const listenerStatus = await kernel.waitForState(
      listener.ref,
      WorkloadState.Completed,
      budget.completionMs,
    );
    this.#assertExit(listenerStatus, 0);
    await artifacts.json(`job-${listener.ref.id}-host-docker`, {
      member: profile.member,
      listener: listener.ref.id,
      prober: prober?.ref.id ?? null,
      peer: probe?.peer ?? null,
      vmType: profile.vmTypes[0],
      region: profile.computeRegion,
    });
    const child = (
      index: number,
      fixture: CloudJobFixture,
      progress: JobProgress,
      terminalStatus: StatusResponse,
    ): JobFinalization => ({
      fixture,
      run: runs[index],
      progress,
      extensions: [
        this.#records.extension(runs[index], progress, 'host-docker'),
      ],
      terminalStatus,
    });
    return this.#finalize(
      [
        child(0, listener, listening.progress, listenerStatus),
        ...(prober && probe
          ? [child(1, prober, probe.progress, probe.status)]
          : []),
      ],
      budget.cleanupMs,
    );
  }

  async #spotMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-spot');
    // One group, one imported credential: the second Job is the
    // early-cancellation case, submitted only once the first Job's checks are done.
    const ids = [id, names.workload('j-spot-early')];
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === 2 &&
        fixtures.every(
          (child, index) =>
            child.ref.id === ids[index] && child.profile === profile,
        ),
      'Spot preparation changed its original member',
    );
    const [fixture, earlyFixture] = fixtures;
    const run = this.#records.begin(fixture.ref, profile, 1);
    await target.submit(fixture);
    const { progress, observation } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );
    const attempt = observation.attempts.find((row) => row.endedAt === null);
    jobInvariant(attempt, 'Spot baseline lacks its live original attempt');
    const spot = target.spot(fixture);
    const before = await wait.for(
      'Job persistent Spot request active',
      (deadline) => spot.active(attempt, deadline),
      {
        timeoutMs: 60_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (request) =>
          request.state === 'active'
            ? undefined
            : `request is ${request.state}`,
      },
    );
    jobInvariant(
      before.type === 'persistent' &&
        before.instanceId === attempt.cloudId &&
        before.region === attempt.region,
      'Spot request does not belong to the original active VM',
    );
    await artifacts.json(`job-${id}-spot-before-termination`, {
      workloadId: id,
      generation: run.generation,
      profile,
      progress,
      attempt,
      request: before,
    });
    if (forced)
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: spot-request-cleanup after original active request, before termination/finalization',
      );

    await kernel.requestTermination(fixture.ref, 180_000);
    const { cleanup, evidence } = await this.#spotCancelled(
      fixture,
      before,
      budget,
    );
    const extension = this.#records.extension(
      run,
      progress,
      'spot-request-cleanup',
    );
    await artifacts.json(`job-${id}-spot-after-termination`, {
      workloadId: id,
      generation: run.generation,
      ...evidence,
      extension,
    });
    const early = await this.#spotEarlyCancel(earlyFixture, budget);
    return this.#finalize(
      [
        {
          fixture,
          run,
          progress,
          extensions: [extension],
          terminalStatus: cleanup.status,
        },
        early,
      ],
      budget.cleanupMs,
    );
  }

  /**
   * A spot Job terminated as soon as it launches ends with its
   * request cancelled; the old `instance-id` lookup is recorded as evidence.
   */
  async #spotEarlyCancel(
    fixture: CloudJobFixture,
    budget: JobStageBudget,
  ): Promise<JobFinalization> {
    const { kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const id = fixture.ref.id;
    const run = this.#records.begin(fixture.ref, fixture.profile, 1);
    await target.submit(fixture);
    const attempt = await wait.for(
      'Job early Spot instance launched',
      async (deadline) =>
        // A provisioning attempt holds `<id>-<n>` until the launch returns.
        (await target.attempts(fixture, deadline)).find(
          (row) => row.endedAt === null && !row.cloudId.startsWith(`${id}-`),
        ),
      {
        timeoutMs: budget.runningMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (live) => (live ? undefined : 'no launched instance yet'),
      },
    );
    jobInvariant(attempt, 'early Spot Job has no launched instance');
    const spot = target.spot(fixture);
    await kernel.requestTermination(fixture.ref, 180_000);
    const terminatedAt = spot.now();
    const before = await spot.launched(attempt, terminatedAt + 60_000);
    // Read the product's cancellation as soon as it lands. The old
    // `instance-id` lookup's results around it are evidence only: on paid run
    // 42713961621 it already matched 10 s after launch, so that miss window
    // can't be produced on demand.
    const probe = () => spot.instanceFilter(spot.now() + 30_000);
    let lastActiveAt: number | undefined;
    let beforeCancel: readonly JobSpotRequest[] = [];
    const cancelled = await wait.for(
      'Job early Spot request cancelled',
      async (deadline) => {
        const readAt = spot.now();
        const request = await spot.request(deadline);
        if (request.state !== 'cancelled') {
          lastActiveAt = readAt;
          beforeCancel = await probe();
        }
        return request;
      },
      {
        timeoutMs: budget.cleanupMs,
        intervalMs: 1_000,
        probeError: 'fail',
        unmet: (request) =>
          request.state === 'cancelled'
            ? undefined
            : `request is ${request.state}`,
      },
    );
    const seenAt = spot.now();
    const atCancel = await probe();
    // Evidence only: EC2's time is the cancellation's only while its status
    // still says so; otherwise the polls bound it.
    const window: Record<string, unknown> = {
      launchedAt: before.launchedAt,
      terminatedAt,
      cancelledAt:
        cancelled.statusCode === 'request-canceled-and-instance-running'
          ? cancelled.updatedAt
          : { after: lastActiveAt ?? null, by: seenAt },
      instanceFilterBeforeCancel: beforeCancel,
      instanceFilterAtCancel: atCancel,
    };
    await artifacts.json(`job-${id}-spot-early-window`, window);
    // Evidence: when the old lookup first finds the request.
    let firstMatchAt: number | undefined;
    const { cleanup, evidence } = await this.#spotCancelled(
      fixture,
      before.request,
      budget,
      async () => {
        if (firstMatchAt === undefined && (await probe()).length > 0)
          firstMatchAt = spot.now();
      },
    );
    const control =
      firstMatchAt === undefined ? await probe() : [before.request];
    await artifacts.json(`job-${id}-spot-early-control`, {
      firstMatchAt: firstMatchAt ?? null,
      instanceFilterAfterGuard: control,
    });
    const progress = this.#records.progress(run, {
      status: cleanup.status,
      attempts: await target.attempts(fixture),
    });
    const extension = this.#records.spotEarlyCancel(run, progress);
    await artifacts.json(`job-${id}-spot-early-cancel`, {
      workloadId: id,
      attempt,
      window,
      control,
      ...evidence,
    });
    return {
      fixture,
      run,
      progress,
      extensions: [extension],
      terminalStatus: cleanup.status,
    };
  }

  /** After termination: persisted cleanup, the request cancelled, no replacement for 90 s. */
  async #spotCancelled(
    fixture: CloudJobFixture,
    before: JobSpotRequest,
    budget: JobStageBudget,
    /** Runs with each replacement read of the guard. */
    onGuardRead?: () => Promise<void>,
  ) {
    const { kernel, wait } = this.#dependencies;
    const spot = this.#cloud().spot(fixture);
    const cleanup = await kernel.waitForCleanupRecorded(
      fixture.ref,
      budget.cleanupMs,
    );
    jobInvariant(
      cleanup.status.workload.state === WorkloadState.Terminated,
      'Spot Workload did not retain its termination outcome',
    );
    const sameRequest = (request: typeof before): boolean =>
      request.id === before.id &&
      request.region === before.region &&
      request.type === 'persistent' &&
      (request.instanceId === undefined ||
        request.instanceId === before.instanceId);
    const cancelled = await wait.for(
      'Job persistent Spot request cancelled',
      (deadline) => spot.request(deadline),
      {
        timeoutMs: 120_000,
        intervalMs: 5_000,
        probeError: 'fail',
        reject: (request) =>
          sameRequest(request)
            ? undefined
            : 'original Spot request identity changed',
        unmet: (request) =>
          request.state === 'cancelled'
            ? undefined
            : `request is ${request.state}`,
      },
    );
    jobInvariant(
      sameRequest(cancelled) && cancelled.state === 'cancelled',
      'Spot termination lacks its original cancelled request',
    );
    const guardStartedAt = spot.now();
    const guardDeadline = guardStartedAt + 90_000;
    let checks = 0;
    while (spot.now() < guardDeadline) {
      // Each read gets its own budget: one started just before the guard ends
      // must still finish rather than be killed at the guard deadline.
      const live = await spot.liveInstances(spot.now() + 30_000);
      await onGuardRead?.();
      jobInvariant(
        live.length === 0,
        'AWS launched or retained a Spot replacement after cleanup',
      );
      checks++;
      const remaining = guardDeadline - spot.now();
      if (remaining > 0)
        // The final observation interval must finish before its sleep deadline.
        await spot.pause(Math.min(5_000, remaining), guardDeadline + 5_000);
    }
    jobInvariant(
      checks > 0 && spot.now() - guardStartedAt >= 90_000,
      'Spot replacement guard did not observe its full production interval',
    );
    const after = await spot.request(spot.now() + 60_000);
    jobInvariant(
      sameRequest(after) && after.state === 'cancelled',
      'Spot request reopened or changed after the replacement guard',
    );
    return {
      cleanup,
      evidence: {
        before,
        cancelled,
        after,
        guardStartedAt,
        guardEndedAt: spot.now(),
        checks,
        nativeSelectors: ['Workload tags', 'original request ID'],
      },
    };
  }

  async #hydrationMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-hydrate');
    const fixtures = await target.prepare([id], profile, budget);
    jobInvariant(
      fixtures.length === 1 &&
        fixtures[0].ref.id === id &&
        fixtures[0].profile === profile &&
        fixtures[0].hydration,
      'hydration preparation changed its original member or real fixture',
    );
    const fixture = fixtures[0];
    const data = fixture.hydration!;
    const run = this.#records.begin(fixture.ref, profile, 1);
    const hydration = target.hydration(fixture);
    await target.submit(fixture);
    const initial = await wait.for(
      'Job input hydration worker active',
      async (deadline) => {
        const status = await kernel.status(fixture.ref, true);
        const attempts = await target.attempts(fixture, deadline);
        return {
          status,
          attempts,
          worker:
            status.workload.state === WorkloadState.Syncing
              ? await hydration.snapshot(deadline)
              : undefined,
        };
      },
      {
        timeoutMs: budget.runningMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ status, worker }) =>
          JOB_TERMINAL_STATES.includes(status.workload.state) ||
          status.workload.state === WorkloadState.Running ||
          (worker?.active &&
            worker.invocation &&
            worker.pid > 0 &&
            worker.identity)
            ? undefined
            : 'active input worker has not reached Syncing',
      },
    );
    const progress = this.#records.progress(run, initial);
    jobInvariant(
      progress.kind === 'active' &&
        progress.state === WorkloadState.Syncing &&
        initial.worker,
      'hydration extensions require an observed live Syncing worker',
    );
    const pre: JobHydrationObservation = { ...initial, worker: initial.worker };
    const observe = async (
      deadline: number,
    ): Promise<JobHydrationObservation> => {
      const status = await kernel.status(fixture.ref, true);
      jobInvariant(
        !JOB_TERMINAL_STATES.includes(status.workload.state),
        'hydration fixture exhausted before its required recovery proof',
      );
      return {
        status,
        attempts: await target.attempts(fixture, deadline),
        worker: await hydration.snapshot(deadline),
      };
    };
    const sample = (label: string): Promise<JobHydrationObservation> =>
      wait.for(label, observe, {
        timeoutMs: 90_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: () => undefined,
      });
    const original = pre.attempts.find((attempt) => attempt.endedAt === null);
    jobInvariant(original, 'hydration has no original live VM');
    const identity = await target.recoveryIdentity(fixture, original);
    const baseline = await wait.for(
      'Job hydration native baseline',
      async (deadline) => ({
        logs: await hydration.apiLogs(deadline),
        disk: await hydration.disk(identity, deadline),
        imageConfigDigest: await target.imageConfigDigest(fixture),
      }),
      {
        timeoutMs: 90_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: () => undefined,
      },
    );
    const before = this.#records.beforeHydration(
      run,
      progress,
      pre,
      identity,
      baseline.logs,
      baseline.disk,
      data,
    );
    jobInvariant(
      /^sha256:[a-f0-9]{64}$/u.test(baseline.imageConfigDigest),
      'hydration image configuration digest is missing or invalid',
    );
    await artifacts.json(`job-${id}-pre-fault`, {
      workloadId: id,
      generation: run.generation,
      before,
      originalAttempt: original,
      worker: pre.worker,
      nativeIdentity: identity,
      ...baseline,
      requestedImage: profile.image,
      resolvedManifestDigest: pre.status.workload.imageDigest,
      inputObjects: data.objects,
      inputBytes: data.bytes,
      seedSha256: data.seedSha256,
    });
    const restart = await hydration.restart();
    const adoptedLogs = await wait.for(
      'Job API adopts detached hydration worker',
      (deadline) => hydration.apiLogs(deadline),
      {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (logs) =>
          logs.adopted > baseline.logs.adopted
            ? undefined
            : 'new adoption log not observed',
      },
    );
    const adopted = await sample('Job hydration worker after API restart');
    this.#records.hydrationAdopted(run, before, restart, adopted, adoptedLogs);
    await artifacts.json(`job-${id}-hydration-adoption`, {
      workloadId: id,
      generation: run.generation,
      before,
      restart,
      adopted,
      logs: adoptedLogs,
    });
    if (forced)
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: aws input-hydration-recovery after same-worker API adoption, before healthy and inactivity windows',
      );
    const samples: JobHydrationObservation[] = [];
    // Fifteen original 60-second observations cross the 870-second proof floor.
    for (let index = 0; index < 15; index++) {
      await hydration.pause(60_000);
      const observed = await sample(
        'Job healthy hydration beyond the legacy ceiling',
      );
      this.#records.hydrationAdopted(
        run,
        before,
        restart,
        observed,
        adoptedLogs,
      );
      samples.push(observed);
    }
    const healthy = this.#records.hydrationHealthy(
      run,
      before,
      restart,
      adopted,
      adoptedLogs,
      samples,
    );
    await artifacts.json(`job-${id}-hydration-healthy`, {
      workloadId: id,
      generation: run.generation,
      before,
      healthy,
      adopted,
      samples,
    });
    const preFault = await sample('Job hydration inactivity baseline');
    await artifacts.json(`job-${id}-hydration-inactivity-before`, {
      workloadId: id,
      generation: run.generation,
      healthy,
      observation: preFault,
    });
    const activity = await hydration.hideActivity();
    const fault = this.#records.hydrationFault(
      run,
      healthy,
      preFault,
      activity,
    );
    await artifacts.json(`job-${id}-recovery-fault`, {
      workloadId: id,
      generation: run.generation,
      kind: 'hydration-visible-activity-hidden',
      healthy,
      fault,
      activity,
    });
    await hydration.pause(75_000);
    const hidden = await wait.for(
      'Job hidden input worker activity',
      (deadline) => hydration.activity(deadline),
      {
        timeoutMs: 90_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: () => undefined,
      },
    );
    jobInvariant(
      hidden.visibleBytes === 0 && hidden.hiddenBytes > activity.hiddenBytes,
      'hydration fault did not preserve hidden progress behind an empty visible log',
    );
    const remainingMs = 1_080_000 - (hidden.observedAt - activity.observedAt);
    jobInvariant(
      Number.isSafeInteger(remainingMs) && remainingMs > 0,
      'hydration inactivity proof deadline expired',
    );
    const eventId = Math.max(
      0,
      ...preFault.status.events.map((event) => event.id),
    );
    const eventAt = Math.max(
      0,
      ...preFault.status.events.map((event) => event.createdAt),
    );
    const retry = await wait.for(
      'Job production inactivity watchdog',
      observe,
      {
        timeoutMs: remainingMs,
        intervalMs: 30_000,
        probeError: 'fail',
        unmet: ({ status }) =>
          jobHydrationRetryEvent(status, id, eventId, eventAt)
            ? undefined
            : 'production 15-minute inactivity retry not observed',
      },
    );
    jobInvariant(
      retry.worker.observedAt - activity.observedAt >= 900_000,
      'hydration inactivity retry was observed before the production 15-minute threshold',
    );
    const resumed = await wait.for(
      'Job same-VM hydration worker replacement',
      observe,
      {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ worker, status }) =>
          status.workload.state === WorkloadState.Syncing &&
          worker.active &&
          worker.invocation &&
          worker.invocation !== pre.worker.invocation
            ? undefined
            : 'fresh hydration invocation not observed',
      },
    );
    const current = resumed.attempts.find(
      (attempt) => attempt.endedAt === null,
    );
    jobInvariant(current, 'hydration retry has no original live VM');
    const afterIdentity = await target.recoveryIdentity(fixture, current);
    const terminalStatus = await kernel.waitForState(
      fixture.ref,
      profile.expectedTerminalState,
      budget.completionMs,
    );
    this.#assertExit(terminalStatus, 0);
    const manifest = await wait.for(
      'Job complete hydration manifest',
      async (deadline) =>
        jobHydrationManifest(await hydration.manifest(deadline)),
      {
        timeoutMs: 60_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (value) => (value ? undefined : 'output manifest not uploaded'),
      },
    );
    jobInvariant(manifest, 'hydration output manifest is missing');
    const extension = this.#records.hydrated(
      run,
      before,
      healthy,
      fault,
      hidden,
      retry,
      resumed,
      afterIdentity,
      manifest,
    );
    await artifacts.json(`job-${id}-post-fault`, {
      workloadId: id,
      generation: run.generation,
      before,
      healthy,
      fault,
      hidden,
      retry,
      resumed,
      nativeIdentity: afterIdentity,
      manifest,
    });
    return this.#finalize(
      [{ fixture, run, progress, extensions: [extension], terminalStatus }],
      budget.cleanupMs,
    );
  }

  async #hostRecoveryMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-host');
    const fixtures = await target.prepare([id], profile, budget);
    jobInvariant(
      fixtures.length === 1 &&
        fixtures[0].ref.id === id &&
        fixtures[0].profile === profile,
      'host recovery preparation changed its original member',
    );
    const fixture = fixtures[0];
    const run = this.#records.begin(fixture.ref, profile, 1);
    await target.submit(fixture);
    const { progress } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );
    let checkpoint: string | undefined;
    if (profile.explicitCheckpoint) {
      await target.writeHostCheckpoint(fixture);
      checkpoint = await wait.for(
        'Job checkpoint upload before host deletion',
        (deadline) => target.hostCheckpoint(fixture, 'bucket', deadline),
        {
          timeoutMs: budget.storageMs,
          intervalMs: 5_000,
          probeError: 'fail',
          unmet: (contents) =>
            contents === `checkpoint-${id}`
              ? undefined
              : 'exact checkpoint marker has not reached storage',
        },
      );
    }
    const pre = {
      status: await kernel.status(fixture.ref, true),
      attempts: await target.attempts(fixture),
    };
    const original = pre.attempts.find((attempt) => attempt.endedAt === null);
    jobInvariant(original, 'host recovery has no original live attempt');
    const identity = await target.recoveryIdentity(fixture, original);
    const before = this.#records.beforeHostRecovery(
      run,
      progress,
      pre,
      identity,
      checkpoint,
    );
    await artifacts.json(`job-${id}-pre-fault`, {
      workloadId: id,
      generation: run.generation,
      before,
      originalAttempt: original,
      nativeIdentity: identity,
      checkpointBucket: fixture.checkpointBucket,
      checkpointRegion: profile.explicitCheckpoint
        ? profile.storageRegion
        : undefined,
      checkpoint,
      eventIds: pre.status.events.map((event) => event.id),
    });
    await target.deleteHost(fixture, original, identity);
    const fault = this.#records.hostRecoveryFault(run, before);
    const eventId = Math.max(0, ...pre.status.events.map((event) => event.id));
    await wait.for(
      'Job host-loss recovery detection',
      async () => {
        const status = await kernel.status(fixture.ref, true);
        jobInvariant(
          !JOB_TERMINAL_STATES.includes(status.workload.state),
          'host loss reached terminal instead of recovering',
        );
        return status;
      },
      {
        timeoutMs: 180_000,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: (status) =>
          status.events.some(
            (event) =>
              event.workloadId === id &&
              event.id > eventId &&
              JOB_RECOVERY_STATES.includes(event.state),
          )
            ? undefined
            : 'new host-loss recovery event not observed',
      },
    );
    const post = await wait.for<JobProgressObservation>(
      'Job replacement host Running',
      async (deadline) => {
        const status = await kernel.status(fixture.ref, true);
        jobInvariant(
          !JOB_TERMINAL_STATES.includes(status.workload.state),
          'replacement host reached terminal instead of Running',
        );
        return { status, attempts: await target.attempts(fixture, deadline) };
      },
      {
        timeoutMs: budget.completionMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ status, attempts }) =>
          status.workload.state === WorkloadState.Running &&
          attempts.some(
            (attempt) =>
              attempt.rowId !== original.rowId &&
              attempt.cloudId !== original.cloudId &&
              attempt.endedAt === null,
          )
            ? undefined
            : 'distinct replacement host has not reached Running',
      },
    );
    const current = post.attempts.find((attempt) => attempt.endedAt === null);
    jobInvariant(current, 'host recovery lacks its replacement attempt');
    const afterIdentity = await target.recoveryIdentity(fixture, current);
    const restoredCheckpoint = profile.explicitCheckpoint
      ? await wait.for(
          'Job restored host checkpoint',
          (deadline) => target.hostCheckpoint(fixture, 'container', deadline),
          {
            timeoutMs: 90_000,
            intervalMs: 5_000,
            probeError: 'fail',
            unmet: (contents) =>
              contents === checkpoint
                ? undefined
                : 'host recovery lost its exact restored checkpoint contents',
          },
        )
      : undefined;
    const extension = this.#records.hostRecovered(
      run,
      before,
      fault,
      post,
      afterIdentity,
      restoredCheckpoint,
    );
    await artifacts.json(`job-${id}-post-fault`, {
      workloadId: id,
      generation: run.generation,
      before,
      fault,
      replacementAttempt: current,
      nativeIdentity: afterIdentity,
      checkpointBucket: fixture.checkpointBucket,
      checkpoint: restoredCheckpoint,
      events: post.status.events,
    });
    if (forced)
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${profile.member.target} host-recovery after replacement and checkpoint restoration, before finalization`,
      );
    await kernel.requestTermination(fixture.ref, 180_000);
    const terminalStatus = await kernel.waitForState(
      fixture.ref,
      profile.expectedTerminalState,
      budget.cleanupMs,
    );
    return this.#finalize(
      [{ fixture, run, progress, extensions: [extension], terminalStatus }],
      budget.cleanupMs,
    );
  }

  /**
   * Evicts the spot VM of an exit-0 Job during its final sync. A sync
   * that finishes before the eviction lands proves nothing, so that run fails
   * as inconclusive rather than passing.
   */
  async #evictionMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-evict');
    const ids = [id, names.workload('j-spot-exit')];
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === 2 &&
        fixtures.every(
          (child, index) =>
            child.ref.id === ids[index] && child.profile === profile,
        ),
      'eviction preparation changed its original member',
    );
    const [fixture, exit] = fixtures;
    const [run, exitRun] = fixtures.map((child) =>
      this.#records.begin(child.ref, profile, 1),
    );
    await this.#settle(
      fixtures.map((child) => target.submit(child)),
      'Spot Job submission',
    );
    // Read alongside the evicted child's waits, so neither delays the other.
    const exitBaseline = this.#cloudProgress(exit, exitRun, budget.runningMs);
    exitBaseline.catch(() => undefined);
    const { progress } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );
    const inconclusive =
      'inconclusive: the final sync finished before the eviction landed';
    const unrestarted = (status: StatusResponse, eventId: number): void => {
      const { state } = status.workload;
      if (jobEvictionRestarted(status, eventId)) return;
      jobInvariant(state !== WorkloadState.Completed, inconclusive);
      jobInvariant(
        !JOB_TERMINAL_STATES.includes(state),
        `Job reached ${state} without restarting its evicted VM`,
      );
    };
    const status = await wait.for(
      'Job final sync started',
      async () => {
        const current = await kernel.status(fixture.ref, true);
        unrestarted(current, Number.MAX_SAFE_INTEGER);
        return current;
      },
      {
        timeoutMs: budget.completionMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: ({ workload }) =>
          workload.state === WorkloadState.Finalizing
            ? undefined
            : workload.state,
      },
    );
    const pre = { status, attempts: await target.attempts(fixture) };
    const original = pre.attempts.find((attempt) => attempt.endedAt === null);
    jobInvariant(original, 'eviction has no live original attempt');
    const identity = await target.recoveryIdentity(fixture, original);
    const before = this.#records.beforeEviction(run, progress, pre, identity);
    await artifacts.json(`job-${id}-pre-fault`, {
      workloadId: id,
      generation: run.generation,
      before,
      originalAttempt: original,
      nativeIdentity: identity,
      eventIds: status.events.map((event) => event.id),
    });
    const eventId = Math.max(0, ...status.events.map((event) => event.id));
    try {
      await target.stop(fixture, original, identity);
    } catch (error) {
      unrestarted(await kernel.status(fixture.ref, true), eventId);
      throw error;
    }
    const fault = this.#records.evictionFault(run, before);
    const exitProgress = (await exitBaseline).progress;
    const post = await wait.for<JobProgressObservation>(
      'Job evicted finalizing VM restarted',
      async (deadline) => {
        const current = await kernel.status(fixture.ref, true);
        unrestarted(current, eventId);
        return {
          status: current,
          attempts: await target.attempts(fixture, deadline),
        };
      },
      {
        timeoutMs: budget.completionMs,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: ({ status: current }) =>
          jobEvictionRestarted(current, eventId)
            ? undefined
            : 'final-bucket-sync-vm-restarted not observed',
      },
    );
    const extension = this.#records.evicted(run, before, fault, post);
    await artifacts.json(`job-${id}-post-fault`, {
      workloadId: id,
      generation: run.generation,
      before,
      fault,
      extension,
      attempts: post.attempts,
      events: post.status.events,
    });
    if (forced)
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${profile.member.target} spot-eviction after the finalizing restart, before finalization`,
      );
    const terminalStatus = await kernel.waitForState(
      fixture.ref,
      profile.expectedTerminalState,
      budget.completionMs,
    );
    this.#assertExit(terminalStatus, 0);
    const output = await wait.for(
      'Job evicted final output',
      (deadline) => target.evictionOutput(fixture, deadline),
      {
        timeoutMs: budget.storageMs,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: ({ marker, payloadBytes }) =>
          marker === `spot-eviction-${id}` &&
          payloadBytes === JOB_EVICTION_PAYLOAD_MIB * 1024 * 1024
            ? undefined
            : 'final output is missing or incomplete',
      },
    );
    await artifacts.json(`job-${id}-final-contents`, {
      workloadId: id,
      generation: run.generation,
      output,
    });
    // With no retries left, the clean exit ends as `exited`.
    const exitStatus = await kernel.waitForState(
      exit.ref,
      profile.expectedTerminalState,
      budget.completionMs,
    );
    this.#assertExit(exitStatus, 0);
    // The container exits a fixed time after Running. Without that fix, a clean
    // spot exit waits out the 150 s preemption grace before it ends; AWS and
    // GCP read the reclaim notice and end it at once. Azure has no notice and
    // keeps the grace, so its time is recorded only.
    const exitRunning = exitStatus.events.find(
      (event) => event.state === WorkloadState.Running,
    );
    const exitToTerminalSeconds =
      exitRunning && exitStatus.workload.completedAt
        ? (exitStatus.workload.completedAt - exitRunning.createdAt) / 1000 -
          JOB_SPOT_EXIT_SECONDS
        : null;
    await artifacts.json(`job-${exit.ref.id}-spot-exit`, {
      endReason: exitStatus.workload.endReason,
      exitToTerminalSeconds,
    });
    if (profile.member.target !== 'azure')
      jobInvariant(
        exitToTerminalSeconds !== null &&
          exitToTerminalSeconds >= 0 &&
          exitToTerminalSeconds < SPOT_EXIT_GRACE_SECONDS,
        `the spot Job's clean exit took ${String(exitToTerminalSeconds)} s to end, not under the ${SPOT_EXIT_GRACE_SECONDS} s preemption grace`,
      );
    return this.#finalize(
      [
        { fixture, run, progress, extensions: [extension], terminalStatus },
        {
          fixture: exit,
          run: exitRun,
          progress: exitProgress,
          extensions: [
            this.#records.spotExit(exitRun, exitProgress, exitStatus),
          ],
          terminalStatus: exitStatus,
        },
      ],
      budget.cleanupMs,
    );
  }

  /**
   * A GPU Job's Spot VM evicted while Running must complete with a
   * passing GPU check after the resume, on the restarted VM or a fresh one.
   */
  async #gpuEvictionMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts, now } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-gpu-evict');
    const [fixture] = await target.prepare([id], profile, budget);
    jobInvariant(
      fixture.ref.id === id && fixture.profile === profile,
      'GPU eviction preparation changed its original member',
    );
    const run = this.#records.begin(fixture.ref, profile, 1);
    await target.submit(fixture);
    const { progress } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );
    const result = (role: 'output' | 'checkpoint', key: string) =>
      wait.for(
        `Job GPU check ${key}`,
        (d) => target.results(fixture, role, d),
        {
          timeoutMs: budget.storageMs,
          intervalMs: 10_000,
          probeError: retryJobResultNotJson,
          unmet: (value) =>
            isRecord(value) && value[key] === id ? undefined : 'not synced',
        },
      );
    await result('checkpoint', 'started');
    const original = (await target.attempts(fixture)).find(
      (attempt) => attempt.endedAt === null,
    );
    jobInvariant(original, 'GPU eviction has no live original attempt');
    const eventId = Math.max(
      0,
      ...(await kernel.status(fixture.ref, true)).events.map(({ id }) => id),
    );
    await target.stop(
      fixture,
      original,
      await target.recoveryIdentity(fixture, original),
    );
    const terminalStatus = await wait.for(
      'GPU Job terminal after its eviction',
      () => kernel.status(fixture.ref, true),
      {
        timeoutMs: budget.completionMs,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: ({ workload }) =>
          JOB_TERMINAL_STATES.includes(workload.state)
            ? undefined
            : workload.state,
      },
    );
    const attempts = await target.attempts(fixture);
    const logs = await Promise.all(
      [...new Set(attempts.map(({ ip }) => ip))].map(async (ip) =>
        ip ? await target.logs(fixture, ip, now() + 60_000) : undefined,
      ),
    );
    const events = terminalStatus.events.filter(({ id }) => id > eventId);
    const evidence = {
      state: terminalStatus.workload.state,
      finalVm:
        attempts.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
          .cloudId === original.cloudId
          ? 'restarted-vm'
          : 'fresh-vm',
      events,
      attempts,
      errorLines: logs.flatMap((text) =>
        (text ?? '')
          .split('\n')
          .filter((line) => /error|gpu-check-ok/iu.test(line)),
      ),
    };
    await artifacts.json(`job-${id}-gpu-eviction`, evidence);
    if (forced)
      throw new Error(
        'E2E_JOB_FORCED_CLEANUP: azure gpu-spot-eviction after the eviction, before finalization',
      );
    jobInvariant(
      events.some(({ state }) => JOB_RECOVERY_STATES.includes(state)) &&
        attempts.length > 1,
      `the eviction did not restart the GPU Job: ${JSON.stringify(evidence)}`,
    );
    jobInvariant(
      terminalStatus.workload.state === WorkloadState.Completed,
      `the evicted GPU Job ended ${terminalStatus.workload.state}: ${JSON.stringify(evidence)}`,
    );
    // The resumed start writes this only after its GPU check passed.
    await result('output', 'resumed');
    return this.#finalize(
      [
        {
          fixture,
          run,
          progress,
          extensions: [
            this.#records.extension(run, progress, 'gpu-spot-eviction'),
          ],
          terminalStatus,
        },
      ],
      budget.cleanupMs,
    );
  }

  /**
   * A GPU Job whose log reports no GPU on a healthy one. Its VM's GPU
   * probe passes, so it reruns once on the same VM (one Retrying with
   * `gpu-rerun-in-place` and the probe's output), and the rerun ends Errored
   * with the passed-probe message: one VM throughout, never a fresh one.
   */
  async #gpuProbeRerunMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts, vmLedger } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-gpu-rerun');
    const [fixture] = await target.prepare([id], profile, budget);
    jobInvariant(
      fixture.ref.id === id && fixture.profile === profile,
      'GPU probe rerun preparation changed its original member',
    );
    const run = this.#records.begin(fixture.ref, profile, 1);
    await target.submit(fixture);
    const { progress } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );
    // The Job runs 30 s before it fails; a status read meanwhile reports the
    // host's GPU health, which must read healthy.
    const gpuReads: Array<{ state: string; detail?: string }> = [];
    const terminalStatus = await wait.for(
      'GPU probe rerun Job terminal',
      async () => {
        const status = await kernel.status(fixture.ref, true);
        if (status.workload.state === WorkloadState.Running) {
          const live = vmLedger.liveEntries(
            vmLedger.snapshot(fixture.ref, status),
          );
          for (const vm of live) if (vm.gpu) gpuReads.push(vm.gpu);
        }
        return status;
      },
      {
        timeoutMs: budget.completionMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ workload }) =>
          JOB_TERMINAL_STATES.includes(workload.state)
            ? undefined
            : workload.state,
      },
    );
    const attempts = await target.attempts(fixture);
    const evidence = gpuProbeRerunEvidence(terminalStatus, attempts);
    await artifacts.json(`job-${id}-gpu-probe-rerun`, {
      ...evidence,
      events: terminalStatus.events,
      attempts,
      gpuReads,
    });
    if (forced)
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${profile.member.target} gpu-probe-rerun after its end, before finalization`,
      );
    jobInvariant(
      evidence.failures.length === 0,
      `the GPU probe rerun did not hold: ${evidence.failures.join('; ')}`,
    );
    jobInvariant(
      // The first read may find nvidia-smi still answering (unknown); none
      // may call the healthy GPU unhealthy.
      gpuReads.some((read) => read.state === 'healthy') &&
        !gpuReads.some((read) => read.state === 'unhealthy'),
      `status did not read the Running GPU VM healthy, or read it unhealthy: ${JSON.stringify(gpuReads)}`,
    );
    return this.#finalize(
      [
        {
          fixture,
          run,
          progress,
          extensions: [
            this.#records.extension(run, progress, 'gpu-probe-rerun'),
          ],
          terminalStatus,
        },
      ],
      budget.cleanupMs,
    );
  }

  /**
   * #2332: GPU health's unhealthy path. A long-sleep GPU Job's status reads
   * its host healthy, then an externally injected `NVRM: Xid 79` line ("GPU
   * has fallen off the bus") in the kernel journal turns it unhealthy with a
   * reset needed, named in the human status line. Report only: for the next
   * two minutes status only reports it, with no Retrying event and no change
   * of VM, before the Job's ordinary termination.
   */
  async #gpuHealthFaultMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, kernel, wait, artifacts, vmLedger } = this.#dependencies;
    const target = this.#cloud();
    const id = names.workload('j-gpu-fault');
    const [fixture] = await target.prepare([id], profile, budget);
    jobInvariant(
      fixture.ref.id === id && fixture.profile === profile,
      'GPU health fault preparation changed its original member',
    );
    const run = this.#records.begin(fixture.ref, profile, 1);
    await target.submit(fixture);
    const { progress } = await this.#cloudProgress(
      fixture,
      run,
      budget.runningMs,
    );

    const gpuRead = async (): Promise<{
      readonly status: StatusResponse;
      readonly vm: ReturnType<VmLedgerProbe['liveEntries']>[number] | undefined;
    }> => {
      const status = await kernel.status(fixture.ref, true);
      const live = vmLedger.liveEntries(vmLedger.snapshot(fixture.ref, status));
      return { status, vm: live.find((entry) => entry.gpu) };
    };
    const terminalReject = (status: StatusResponse): string | undefined =>
      JOB_TERMINAL_STATES.includes(status.workload.state)
        ? `the Job ended ${status.workload.state} before the fault sequence completed`
        : undefined;

    const healthy = await wait.for(
      'GPU health fault Job healthy GPU read',
      gpuRead,
      {
        timeoutMs: budget.runningMs,
        intervalMs: 5_000,
        probeError: 'fail',
        reject: ({ status }) => terminalReject(status),
        unmet: ({ vm }) =>
          vm?.gpu?.state === 'healthy' ? undefined : 'no healthy GPU read yet',
      },
    );
    const gpu = healthy.vm?.gpu;
    const originalCloudId = healthy.vm?.cloudId;
    jobInvariant(
      gpu?.state === 'healthy' &&
        gpu.gpus.length === 1 &&
        gpu.gpus[0].pci.length > 0 &&
        typeof originalCloudId === 'string' &&
        originalCloudId.length > 0,
      'GPU health fault requires one healthy listed GPU on its original VM before the fault',
    );
    const pci = gpu.gpus[0].pci;
    const faultEventId = Math.max(
      0,
      ...healthy.status.events.map((event) => event.id),
    );

    const injection = await target.injectGpuXid(
      fixture,
      pci,
      GPU_HEALTH_FAULT_XID,
    );
    jobInvariant(
      injection.journalConfirmed,
      `the injected Xid line did not land in the host's kernel journal: ${injection.line}`,
    );

    const unhealthy = await wait.for(
      'GPU health fault Job unhealthy GPU read',
      gpuRead,
      {
        timeoutMs: 180_000,
        intervalMs: 5_000,
        probeError: 'fail',
        reject: ({ status }) => terminalReject(status),
        unmet: ({ vm }) =>
          vm?.gpu?.state === 'unhealthy'
            ? undefined
            : 'no unhealthy GPU read yet',
      },
    );
    const faultedGpu = unhealthy.vm?.gpu;
    jobInvariant(
      faultedGpu?.state === 'unhealthy' &&
        unhealthy.vm?.cloudId === originalCloudId,
      'the unhealthy GPU read did not come from the original VM',
    );
    const xid = faultedGpu.gpus
      .flatMap((entry) => entry.xids)
      .find((entry) => entry.code === GPU_HEALTH_FAULT_XID);
    jobInvariant(
      xid?.resetNeeded === true,
      `the injected Xid did not read back as needing a reset: ${JSON.stringify(faultedGpu)}`,
    );
    const human = gpuHealthFaultHumanLine(faultedGpu);
    jobInvariant(
      human?.includes(`Xid ${GPU_HEALTH_FAULT_XID}`) === true,
      `the human status line did not name the fault: ${JSON.stringify(human)}`,
    );

    // Report only: for two minutes, status must keep reporting the fault on
    // the same live VM with no Retrying event; a timeout here is success.
    try {
      await wait.for('GPU health fault report-only window', gpuRead, {
        timeoutMs: 120_000,
        intervalMs: 10_000,
        probeError: 'fail',
        reject: ({ status, vm }) => {
          if (
            status.events.some(
              (event) =>
                event.id > faultEventId &&
                event.state === WorkloadState.Retrying,
            )
          )
            return 'a Retrying event arrived during the report-only window';
          if (status.workload.state !== WorkloadState.Running)
            return `the Job left Running: ${status.workload.state}`;
          if (vm?.cloudId !== originalCloudId)
            return 'the Job changed VM during the report-only window';
          if (vm?.gpu?.state !== 'unhealthy')
            return 'the GPU read stopped reporting unhealthy during the report-only window';
          return undefined;
        },
        unmet: () => 'report-only window still running',
      });
      throw new Error('report-only window ended without timing out');
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
    }

    await artifacts.json(`job-${id}-gpu-health-fault`, {
      workloadId: id,
      generation: run.generation,
      pci,
      injection,
      healthyGpu: gpu,
      unhealthyGpu: faultedGpu,
      humanLine: human,
      cloudId: originalCloudId,
    });
    if (forced)
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${profile.member.target} gpu-health-fault after its report-only window, before termination/finalization`,
      );
    const extension = this.#records.extension(
      run,
      progress,
      'gpu-health-fault',
    );
    await kernel.requestTermination(fixture.ref, budget.cleanupMs);
    const terminalStatus = await kernel.waitForState(
      fixture.ref,
      profile.expectedTerminalState,
      budget.completionMs,
    );
    const firstRunning = terminalStatus.events.find(
      (event) => event.state === WorkloadState.Running,
    );
    jobInvariant(
      !!firstRunning &&
        !terminalStatus.events.some(
          (event) =>
            event.id > firstRunning.id &&
            event.state === WorkloadState.Retrying,
        ),
      `a Retrying event followed the Job's first Running event: ${JSON.stringify(terminalStatus.events)}`,
    );
    return this.#finalize(
      [{ fixture, run, progress, extensions: [extension], terminalStatus }],
      budget.cleanupMs,
    );
  }

  async #cloudMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { names, artifacts, wait, kernel } = this.#dependencies;
    const target = this.#cloud();
    const concurrent = profile.member.kind === 'concurrent-output';
    const ids = concurrent
      ? [1, 2, 3].map((index) => names.workload(`j-output-${index}`))
      : [names.workload('j-bucket')];
    const fixtures = await target.prepare(ids, profile, budget);
    jobInvariant(
      fixtures.length === ids.length &&
        fixtures.every(
          (fixture, index) =>
            fixture.ref.id === ids[index] && fixture.profile === profile,
        ),
      'target preparation changed its requested members',
    );
    const runs = fixtures.map((fixture) =>
      this.#records.begin(fixture.ref, profile, 1),
    );
    if (!concurrent) {
      const transfers = await target.transfers(fixtures[0]);
      for (const kind of [
        'listedBucket',
        'rootObject',
        'nestedPrefix',
        'literalPrefix',
        'recursiveObjects',
      ] as const)
        jobInvariant(
          transfers[kind],
          `bucket transfer assertion failed: ${kind}`,
        );
      if (profile.recursiveTransfers) {
        jobInvariant(
          transfers.recursive,
          'recursive transfer observations are missing',
        );
        for (const kind of [
          'rootContents',
          'nestedContents',
          'hiddenContents',
          'existingMode',
          'newMode',
          'singleContents',
          'singleMode',
          'collisions',
          'deletedPrefix',
          'retainedSibling',
        ] as const)
          jobInvariant(
            transfers.recursive[kind],
            `recursive transfer assertion failed: ${kind}`,
          );
      }
      await artifacts.json(`job-${fixtures[0].ref.id}-transfers`, {
        member: profile.member,
        workloadId: fixtures[0].ref.id,
        generation: 1,
        transfers,
      });
    }
    await this.#settle(
      fixtures.map((fixture) => target.submit(fixture)),
      'Job group submission',
    );
    if (!concurrent && fixtures[0].checkpointBucket)
      await wait.for(
        'Job automatic checkpoint creation',
        (deadline) => target.bucketReady(fixtures[0], 'checkpoint', deadline),
        {
          timeoutMs: 300_000,
          intervalMs: 5_000,
          probeError: 'fail',
          unmet: (ready) =>
            ready ? undefined : 'checkpoint bucket not created',
        },
      );
    const active: {
      progress: JobProgress;
      observation: JobProgressObservation;
    }[] = [];
    // Every child receives its own complete Running budget after all sends settle.
    for (const [index, fixture] of fixtures.entries())
      active.push(
        await this.#cloudProgress(fixture, runs[index], budget.runningMs),
      );
    for (const [index, { observation }] of active.entries()) {
      const gate = fixtures[index].launchFailover;
      if (!gate) continue;
      const evidence = {
        ...gate,
        ...launchFailovers(observation.status.events),
        vms: this.#liveVms(fixtures[index], observation.status),
      };
      await artifacts.json(`job-${fixtures[index].ref.id}-launch-failover`, {
        ...evidence,
        ...(!gate.armed && { skipped: 'an A100 quota is above 0' }),
      });
      if (!gate.armed) continue;
      const { failovers, untried } = evidence;
      const live = observation.attempts.find((row) => row.endedAt === null);
      // Each refused target fails over to an untried one at once, and
      // the Job ends up on the type it can launch.
      jobInvariant(
        failovers.length > 0 &&
          failovers.every(({ claimAfterMs }) => claimAfterMs <= 15_000) &&
          untried.every((count, at) => at === 0 || count < untried[at - 1]) &&
          live !== undefined &&
          live.vmType === profile.vmTypes.at(-1) &&
          this.#reportsLaunchedType(fixtures[index], observation.status, live),
        `launch failover did not move on at once: ${JSON.stringify(evidence)}`,
      );
    }
    if (concurrent)
      return this.#concurrent(
        fixtures,
        runs,
        active.map((entry) => entry.progress),
        forced,
      );
    const fixture = fixtures[0];
    const run = runs[0];
    const { progress, observation } = active[0];
    const extensions: JobExtensionRecord[] = [];
    const organic = await this.#waitMolecules(
      fixture,
      'output',
      300_000,
      (molecules) => Object.keys(molecules).length > 0,
    );
    const runtime = await target.runtime(fixture);
    for (const key of [
      'inputReadOnly',
      'lateInputAbsent',
      'environment',
      'logsFollower',
    ] as const)
      jobInvariant(runtime[key], `bucket runtime assertion failed: ${key}`);
    // Status reports a listed type each VM launched as, never the
    // refused fake head of the list.
    const types = this.#liveVms(fixture, observation.status).map(
      ({ vmType }) => vmType,
    );
    jobInvariant(
      types.length > 0 &&
        types.every(
          (vmType) =>
            vmType !== undefined &&
            vmType !== FAKE_VM_TYPE &&
            profile.vmTypes.includes(vmType),
        ),
      `status reports a type no VM launched as: ${JSON.stringify(types)}`,
    );
    // `#recover` reads each VM's type natively. Without it (Lambda), the
    // host's GPUs show which listed type the VM launched as.
    if (!profile.requiredExtensions.includes('in-place-recovery')) {
      const attempt = observation.attempts.find((row) => row.endedAt === null);
      jobInvariant(
        attempt &&
          this.#reportsLaunchedType(fixture, observation.status, attempt) &&
          gpusMatchType(attempt.vmType, runtime.gpus),
        `status or the host's GPUs differ from the launched type: ${JSON.stringify({ vmType: attempt?.vmType, gpus: runtime.gpus })}`,
      );
    }
    const continuous = await this.#waitMolecules(
      fixture,
      'output',
      180_000,
      (molecules) =>
        Object.keys(molecules).length > Object.keys(organic).length,
    );
    const originalIp = observation.attempts.find(
      (attempt) => attempt.endedAt === null,
    )?.ip;
    jobInvariant(originalIp, 'persisted logs have no original VM IP');
    const logs = await wait.for(
      'Job persisted container logs',
      (deadline) => target.logs(fixture, originalIp, deadline),
      {
        timeoutMs: 120_000,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: (contents) =>
          contents?.trim() ? undefined : 'container logs not uploaded',
      },
    );
    jobInvariant(
      typeof logs === 'string' && logs.trim().length > 0,
      'persisted log contents are empty',
    );
    // The CLI views a user or agent relies on: checkpoint health read
    // from this cloud's storage, and `logs -f | grep -m1` ending with grep.
    const checkpoint = fixture.checkpointBucket
      ? await wait.for(
          'Job checkpoint health in CLI status',
          () => target.statusCheckpoint(fixture),
          {
            timeoutMs: 300_000,
            intervalMs: 20_000,
            probeError: 'fail',
            // The supervisor's zero-byte `.rclone-keep` probe is an object
            // too; wait for the Job's own checkpoint bytes.
            unmet: (facts) =>
              (facts?.health?.bytes ?? 0) > 0
                ? undefined
                : 'no checkpoint bytes reported yet',
          },
        )
      : undefined;
    // The pinned image prints this once at start; each later molecule line
    // is the write that tells the CLI its reader has gone.
    const logsPipe = await target.logsStopWithTheirReader(
      fixture,
      'existing results from',
    );
    // Record what the CLI showed before asserting it, so a failed paid leg
    // carries the observed values.
    await artifacts.json(`job-${fixture.ref.id}-cli-observations`, {
      checkpoint: checkpoint ?? null,
      logsPipe,
    });
    if (fixture.checkpointBucket) {
      jobInvariant(
        checkpoint?.bucket === fixture.checkpointBucket &&
          checkpoint.mount === '/mnt/checkpoint' &&
          checkpoint.retained === Boolean(profile.explicitCheckpoint) &&
          checkpoint.health !== undefined &&
          checkpoint.health.bytes > 0 &&
          checkpoint.health.lastModifiedAt !== null &&
          !checkpoint.health.truncated,
        'CLI status did not report the checkpoint bucket and its health',
      );
    }
    jobInvariant(
      logsPipe.matched && logsPipe.cliExitedZero,
      'logs --follow did not stop when its reader exited',
    );
    extensions.push(this.#records.extension(run, progress, 'bucket-storage'));
    await artifacts.json(`job-${fixture.ref.id}-bucket-active`, {
      workloadId: fixture.ref.id,
      generation: 1,
      runtime,
      requestedImage: profile.image,
      resolvedManifestDigest: observation.status.workload.imageDigest,
      organic,
      continuous,
      persistedLogIp: originalIp,
      persistedLogBytes: logs.length,
      cliCheckpoint: checkpoint ?? null,
      cliLogsPipe: logsPipe,
    });
    // Forced cleanup requires an actual provisioned baseline and the storage
    // extension. It ends before a recovery fault or completion can claim success.
    if (forced)
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${profile.member.target} bucket-sync after active extensions, before finalization`,
      );
    if (profile.requiredExtensions.includes('in-place-recovery'))
      extensions.push(await this.#recover(fixture, run, progress));
    const terminalStatus = await kernel.waitForState(
      fixture.ref,
      profile.expectedTerminalState,
      budget.completionMs,
    );
    this.#assertExit(terminalStatus, 0);
    const cliCompletion = await target.completedByCli(fixture);
    jobInvariant(
      cliCompletion.waitSucceeded && cliCompletion.statusFinished,
      'the CLI did not report the completed Job as succeeded',
    );
    const finalOutput = await this.#finalMolecules(fixture, 'output');
    const finalCheckpoint = fixture.checkpointBucket
      ? await this.#finalMolecules(fixture, 'checkpoint')
      : undefined;
    await artifacts.json(`job-${fixture.ref.id}-final-contents`, {
      workloadId: fixture.ref.id,
      generation: 1,
      finalOutput,
      finalCheckpoint,
    });
    return this.#finalize(
      [{ fixture, run, progress, extensions, terminalStatus }],
      240_000,
    );
  }

  async #cloudProgress(
    fixture: CloudJobFixture,
    run: JobRun,
    timeoutMs: number,
  ): Promise<{ progress: JobProgress; observation: JobProgressObservation }> {
    const { kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const observation = await wait.for<JobProgressObservation>(
      `Job ${fixture.ref.id} active baseline`,
      async (deadline) => ({
        status: await kernel.status(fixture.ref, true),
        attempts: await target.attempts(fixture, deadline),
      }),
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ status }) =>
          status.workload.state === WorkloadState.Running ||
          JOB_TERMINAL_STATES.includes(status.workload.state)
            ? undefined
            : status.workload.state,
      },
    );
    const progress = this.#records.progress(run, observation);
    jobInvariant(
      progress.kind === 'active',
      'cloud extensions require a live Job',
    );
    const attempt = observation.attempts.find(
      (candidate) => candidate.endedAt === null,
    );
    const live = this.#dependencies.vmLedger.liveEntries(
      this.#dependencies.vmLedger.snapshot(fixture.ref, observation.status),
    );
    const { workload } = observation.status;
    const requestedTypes = Array.isArray(workload.vmType)
      ? workload.vmType
      : [workload.vmType];
    const vmTypes = submittedVmTypes(fixture);
    const computeRegion = fixture.restrictedCredentialCase
      ? fixture.restrictedCredentialCase.region
      : fixture.profile.computeRegion;
    jobInvariant(
      attempt &&
        attempt.cloudProvider === fixture.profile.computeProvider &&
        attempt.region &&
        attempt.credentialId &&
        vmTypes.includes(attempt.vmType) &&
        workload.cloudProvider === attempt.cloudProvider &&
        workload.region === (computeRegion || null) &&
        requestedTypes.length === vmTypes.length &&
        requestedTypes.every((type, index) => type === vmTypes[index]) &&
        (!fixture.profile.computeZone ||
          workload.availabilityZone === fixture.profile.computeZone) &&
        live.length === 1 &&
        String(live[0].cloudId) === attempt.cloudId &&
        live[0].region === attempt.region &&
        (live[0].availabilityZone ?? null) === attempt.availabilityZone &&
        (!computeRegion || computeRegion === attempt.region),
      'cloud baseline lost its original placement or credential',
    );
    const regions =
      fixture.profile.member.kind === 'concurrent-output'
        ? fixture.profile.computeRegions
        : undefined;
    if (regions) {
      // The Job keeps its list, and the native read finds its VM
      // running, as the type status reports, in a listed region.
      await target.recoveryIdentity(fixture, attempt);
      jobInvariant(
        JSON.stringify(workload.regions) === JSON.stringify(regions) &&
          regions.includes(attempt.region) &&
          this.#reportsLaunchedType(fixture, observation.status, attempt),
        `Job left its region list: ${JSON.stringify({ regions: workload.regions, region: attempt.region })}`,
      );
    }
    const imageConfigDigest = await target.imageConfigDigest(fixture);
    jobInvariant(
      /^sha256:[a-f0-9]{64}$/u.test(imageConfigDigest),
      'cloud baseline lacks its observed image configuration digest',
    );
    await artifacts.json(`job-${fixture.ref.id}-active-baseline`, {
      workloadId: fixture.ref.id,
      generation: run.generation,
      profile: fixture.profile,
      progress,
      attempt,
      requestedImage: fixture.profile.image,
      resolvedManifestDigest: observation.status.workload.imageDigest,
      imageConfigDigest,
    });
    return { progress, observation };
  }

  async #waitMolecules(
    fixture: CloudJobFixture,
    role: 'output' | 'checkpoint',
    timeoutMs: number,
    accept: (molecules: Readonly<Record<string, number>>) => boolean,
  ): Promise<Readonly<Record<string, number>>> {
    const molecules = await this.#dependencies.wait.for(
      `Job ${fixture.ref.id} ${role} molecular contents`,
      async (deadline) =>
        jobMolecules(
          await this.#cloud().results(fixture, role, deadline),
          fixture.runLabel,
        ),
      {
        timeoutMs,
        intervalMs: 5_000,
        probeError: retryJobResultNotJson,
        unmet: (value) =>
          value && accept(value)
            ? undefined
            : 'molecular contents have not reached the required count',
      },
    );
    jobInvariant(molecules, 'molecular contents are missing');
    return molecules;
  }

  async #finalMolecules(
    fixture: CloudJobFixture,
    role: 'output' | 'checkpoint',
  ): Promise<Readonly<Record<string, number>>> {
    const value = await this.#dependencies.wait.for(
      `Job ${role} final read`,
      (deadline) => this.#cloud().results(fixture, role, deadline),
      {
        timeoutMs: 60_000,
        intervalMs: 5_000,
        probeError: retryJobResultNotJson,
        unmet: () => undefined,
      },
    );
    const molecules = jobMolecules(value, fixture.runLabel);
    jobInvariant(
      molecules && Object.keys(molecules).length === 10,
      `final ${role} must contain all ten molecules`,
    );
    return molecules;
  }

  /** The live VMs status reports, read through the VM ledger. */
  #liveVms(fixture: CloudJobFixture, status: StatusResponse) {
    const { vmLedger } = this.#dependencies;
    return vmLedger.liveEntries(vmLedger.snapshot(fixture.ref, status));
  }

  /** Status reports the type the attempt's VM launched as. */
  #reportsLaunchedType(
    fixture: CloudJobFixture,
    status: StatusResponse,
    attempt: JobNativeAttempt,
  ): boolean {
    return this.#liveVms(fixture, status).some(
      (vm) => vm.cloudId === attempt.cloudId && vm.vmType === attempt.vmType,
    );
  }

  async #recover(
    fixture: CloudJobFixture,
    run: JobRun,
    progress: JobProgress,
  ): Promise<JobExtensionRecord> {
    const { kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    const checkpoint = await this.#waitMolecules(
      fixture,
      'checkpoint',
      180_000,
      (molecules) => Object.keys(molecules).length > 0,
    );
    const pre = {
      status: await kernel.status(fixture.ref, true),
      attempts: await target.attempts(fixture),
    };
    const attempt = pre.attempts.find(
      (candidate) => candidate.endedAt === null,
    );
    jobInvariant(attempt, 'recovery has no original live attempt');
    const identity = await target.recoveryIdentity(fixture, attempt);
    // The native read above matched the VM's type to its attempt.
    jobInvariant(
      this.#reportsLaunchedType(fixture, pre.status, attempt),
      'status does not report the type the VM launched as',
    );
    const before = this.#records.beforeRecovery(
      run,
      progress,
      pre,
      identity,
      Object.keys(checkpoint).length,
    );
    await artifacts.json(`job-${fixture.ref.id}-pre-fault`, {
      workloadId: fixture.ref.id,
      generation: run.generation,
      before,
      originalAttempt: attempt,
      nativeIdentity: identity,
      checkpoint,
      eventIds: pre.status.events.map((event) => event.id),
    });
    await target.stop(fixture, attempt, identity);
    const fault = this.#records.recoveryFault(run, before);
    const eventId = Math.max(0, ...pre.status.events.map((event) => event.id));
    await wait.for(
      'Job recovery detection',
      () => kernel.status(fixture.ref, true),
      {
        timeoutMs: 600_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (status) =>
          status.events.some(
            (event) =>
              event.workloadId === fixture.ref.id &&
              event.id > eventId &&
              JOB_RECOVERY_STATES.includes(event.state),
          )
            ? undefined
            : 'new recovery event not observed',
      },
    );
    const post = await wait.for(
      'Job in-place recovery Running',
      async (deadline) => ({
        status: await kernel.status(fixture.ref, true),
        attempts: await target.attempts(fixture, deadline),
      }),
      {
        timeoutMs: 2_400_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ status, attempts }) =>
          status.workload.state === WorkloadState.Running &&
          attempts.some(
            (row) => row.rowId !== attempt.rowId && row.endedAt === null,
          )
            ? undefined
            : 'replacement attempt has not reached Running',
      },
    );
    const current = post.attempts.find((row) => row.endedAt === null);
    jobInvariant(current, 'recovery lacks its new live attempt');
    const afterIdentity = await target.recoveryIdentity(fixture, current);
    jobInvariant(
      this.#reportsLaunchedType(fixture, post.status, current),
      'status does not report the type the replacement VM launched as',
    );
    const after = await this.#waitMolecules(
      fixture,
      'checkpoint',
      180_000,
      () => true,
    );
    jobInvariant(
      retainedJobMolecules(checkpoint, after),
      'checkpoint values changed or disappeared across recovery',
    );
    const extension = this.#records.recovered(
      run,
      before,
      fault,
      post,
      afterIdentity,
      Object.keys(after).length,
    );
    const resumed = await this.#waitMolecules(
      fixture,
      'checkpoint',
      2_400_000,
      (molecules) => Object.keys(molecules).length > Object.keys(after).length,
    );
    jobInvariant(
      retainedJobMolecules(after, resumed),
      'resumed computation lost checkpoint values',
    );
    await artifacts.json(`job-${fixture.ref.id}-post-fault`, {
      workloadId: fixture.ref.id,
      generation: run.generation,
      before,
      fault,
      extension,
      nativeIdentity: afterIdentity,
      attempts: post.attempts,
      checkpoint: after,
      resumed,
    });
    return extension;
  }

  async #concurrent(
    fixtures: readonly CloudJobFixture[],
    runs: readonly JobRun[],
    progress: readonly JobProgress[],
    forced: boolean,
  ): Promise<JobContractResult> {
    const { kernel, wait, artifacts } = this.#dependencies;
    const target = this.#cloud();
    await this.#settle(
      fixtures.map((fixture) => target.writeConcurrent(fixture)),
      'Job parallel output writes',
    );
    const same = (contents: readonly (string | undefined)[]): boolean =>
      contents.length === 3 &&
      fixtures[0].concurrentWrites.every(
        (write, index) => contents[index] === write.contents,
      );
    const initial = await wait.for(
      'all three concurrent Job contents',
      (deadline) => target.concurrentContents(fixtures[0], deadline),
      {
        timeoutMs: 120_000,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: (contents) =>
          same(contents) ? undefined : 'a child output is missing or changed',
      },
    );
    await target.syncCycle();
    const erased = 'a concurrent child erased or changed another child output';
    // The target's own retry pause paces these rereads.
    const stable = await new Waiter(new AbortController().signal, () =>
      target.verificationRetry(),
    )
      .for(
        'concurrent Job contents after a sync cycle',
        () => target.concurrentContents(fixtures[0]),
        {
          timeoutMs: MAX_WAIT_MS,
          intervalMs: [0, 0],
          probeError: 'fail',
          unmet: (contents) => (same(contents) ? undefined : erased),
        },
      )
      .catch((error: unknown) => {
        jobInvariant(!(error instanceof WaitTimeoutError), erased);
        throw error;
      });
    const extensions = runs.map((run, index) =>
      this.#records.extension(run, progress[index], 'concurrent-output'),
    );
    await artifacts.json('job-concurrent-active', {
      workloadIds: fixtures.map((fixture) => fixture.ref.id),
      generation: 1,
      outputBucket: fixtures[0].outputBucket,
      initial,
      afterSyncCycle: stable,
      childCount: 3,
    });
    if (forced)
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${fixtures[0].profile.member.target} concurrent-output after three-child content assertions, before finalization`,
      );
    await this.#settle(
      fixtures.map((fixture) =>
        kernel.requestTermination(fixture.ref, 180_000),
      ),
      'Job group termination',
    );
    const terminal: StatusResponse[] = [];
    for (const fixture of fixtures) {
      terminal.push(
        await kernel.waitForState(
          fixture.ref,
          WorkloadState.Terminated,
          240_000,
        ),
      );
      await kernel.waitForCleanupRecorded(fixture.ref, 240_000);
      await target.nativeAbsence(fixture, 240_000);
    }
    const after = await target.concurrentContents(fixtures[0]);
    jobInvariant(
      same(after),
      'concurrent outputs changed after all three Jobs terminated',
    );
    await artifacts.json('job-concurrent-after-termination', {
      workloadIds: fixtures.map((fixture) => fixture.ref.id),
      generation: 1,
      contents: after,
    });
    return this.#finalize(
      fixtures.map((fixture, index) => ({
        fixture,
        run: runs[index],
        progress: progress[index],
        extensions: [extensions[index]],
        terminalStatus: terminal[index],
      })),
      240_000,
    );
  }

  async #settle(work: readonly Promise<void>[], stage: string): Promise<void> {
    const outcomes = await Promise.allSettled(work);
    const errors = outcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason as unknown);
    if (errors.length) throw new AggregateError(errors, `${stage} failed`);
  }

  #cloud(): Pick<PublicCloudJobAdapter, keyof PublicCloudJobAdapter> {
    const target = this.#dependencies.cloud;
    jobInvariant(target, 'cloud Job target composition is missing');
    return target;
  }

  async #terminalMember(
    profile: JobMemberProfile,
    budget: JobStageBudget,
    forced: boolean,
  ): Promise<JobContractResult> {
    const { target, names, kernel, artifacts, wait } = this.#dependencies;
    const resubmission = profile.member.kind === 'local-resubmitted';
    jobInvariant(
      resubmission || profile.member.kind === 'local-completed',
      'terminal member is not delivered',
    );
    const fixture = await target.prepareTerminal(
      names.workload(resubmission ? 'j-resubmit' : 'j-complete'),
      profile,
      budget.cleanupMs,
    );
    const { ref } = fixture;
    const first = this.#records.begin(ref, profile, 1);
    await target.submitTerminal(fixture);
    const firstProgress = await this.#progress(
      fixture,
      first,
      budget.runningMs,
    );
    if (forced && !resubmission) {
      jobInvariant(
        firstProgress.kind === 'active',
        'forced terminal-member cleanup requires a live Job',
      );
      throw new Error(
        `E2E_JOB_FORCED_CLEANUP: ${profile.member.kind} after active baseline, before terminal finalization`,
      );
    }
    const firstStatus = await kernel.waitForState(
      ref,
      profile.expectedTerminalState,
      240_000,
    );
    this.#assertExit(firstStatus, resubmission ? 3 : 0);
    if (!resubmission)
      return this.#finalize(
        [
          {
            fixture,
            run: first,
            progress: firstProgress,
            extensions: [],
            terminalStatus: firstStatus,
          },
        ],
        budget.cleanupMs,
      );

    const firstTerminal = this.#records.terminal(first, firstStatus);
    const cleanup = await kernel.waitForCleanupRecorded(ref, budget.cleanupMs);
    await target.firstGenerationAbsence(fixture, budget.cleanupMs);
    const firstAttempts = Object.freeze(
      (await target.attempts(fixture)).map((attempt) =>
        Object.freeze({ ...attempt }),
      ),
    );
    const previous = this.#records.prepareResubmission(
      first,
      firstProgress,
      firstTerminal,
      { status: cleanup.status, attempts: firstAttempts },
    );
    jobInvariant(
      cleanup.status.events.filter(
        (event) => event.metadata?.reason === 'resubmitted',
      ).length === 0,
      'first generation already contains a resubmission',
    );
    await artifacts.json(`job-${ref.id}-pre-resubmission`, {
      workloadId: ref.id,
      generation: 1,
      progress: firstProgress,
      terminal: firstTerminal,
      completedAt: cleanup.status.workload.completedAt,
      cleanedAt: cleanup.status.workload.cleanedAt,
      attempts: firstAttempts,
      referenceReleased: false,
    });
    await target.resubmit(fixture);
    const second = this.#records.begin(ref, profile, 2, previous);
    let secondProgress: JobProgress | undefined;
    // One wait owns the full second-generation budget, including startup.
    // A stale first-generation terminal observation cannot establish progress.
    const secondObservation = await wait.for<JobProgressObservation>(
      'same-ID Job second errored generation',
      async (deadlineAt) => {
        const observation = {
          status: await kernel.status(ref, true),
          attempts: await target.attempts(fixture, deadlineAt),
        };
        const newAttempt = observation.attempts.some(
          (attempt) =>
            !firstAttempts.some((first) => first.rowId === attempt.rowId),
        );
        const state = observation.status.workload.state;
        const secondTerminal =
          JOB_TERMINAL_STATES.includes(state) &&
          observation.status.events.filter(
            (event) => event.state === WorkloadState.Errored,
          ).length >= 2;
        if (
          !secondProgress &&
          newAttempt &&
          (state === WorkloadState.Running || secondTerminal)
        )
          secondProgress = this.#records.progress(second, observation);
        if (forced && (state === WorkloadState.Running || secondTerminal)) {
          jobInvariant(
            state === WorkloadState.Running &&
              secondProgress?.kind === 'active',
            'forced second-generation cleanup requires a live Job',
          );
          jobInvariant(
            this.#retainsAttempts(firstAttempts, observation.attempts),
            'forced second-generation cleanup lost its original ended history',
          );
          const live = observation.attempts.filter(
            (attempt) => attempt.endedAt === null,
          );
          jobInvariant(
            live.length === 1 &&
              !firstAttempts.some((first) => first.rowId === live[0].rowId) &&
              live[0].createdAt >=
                Math.max(...firstAttempts.map((first) => first.endedAt ?? 0)),
            'forced second-generation cleanup requires one new live attempt',
          );
          const resubmissions = observation.status.events.filter(
            (event) => event.metadata?.reason === 'resubmitted',
          );
          jobInvariant(
            resubmissions.length === 1 &&
              resubmissions[0].workloadId === ref.id &&
              resubmissions[0].createdAt >=
                (firstStatus.workload.completedAt ?? 0),
            'forced second-generation cleanup requires exactly one own resubmission event',
          );
          await artifacts.json(`job-${ref.id}-forced-resubmission`, {
            kind: 'job-forced-resubmission',
            point: 'second-generation-active-before-finalization',
            expectedFailure: true,
            member: profile.member,
            workloadId: ref.id,
            generation: 2,
            previousGeneration: 1,
            progress: secondProgress,
            firstGenerationAbsenceRecord: `job-${ref.id}-generation-1-native-absence`,
            originalAttempts: firstAttempts,
            currentAttempts: observation.attempts,
            liveAttempt: live[0],
            resubmissionEvent: {
              id: resubmissions[0].id,
              workloadId: resubmissions[0].workloadId,
              createdAt: resubmissions[0].createdAt,
            },
            requestedImage: profile.image,
            resolvedManifestDigest: observation.status.workload.imageDigest,
            referenceReleased: false,
          });
          throw new Error(
            'E2E_JOB_FORCED_CLEANUP: local-resubmitted after second-generation active baseline, before terminal finalization',
          );
        }
        return observation;
      },
      {
        timeoutMs: budget.completionMs,
        intervalMs: 5_000,
        probeError: 'fail',
        unmet: ({ status }) =>
          status.workload.state === WorkloadState.Errored &&
          status.events.filter((event) => event.state === WorkloadState.Errored)
            .length >= 2
            ? undefined
            : 'second errored event missing',
      },
    );
    const secondStatus = secondObservation.status;
    this.#assertExit(secondStatus, 3);
    jobInvariant(
      secondStatus.events.filter(
        (event) => event.metadata?.reason === 'resubmitted',
      ).length === 1,
      'same-ID Job did not record exactly one resubmission',
    );
    const attempts = secondObservation.attempts;
    jobInvariant(
      attempts.length >= 2 &&
        this.#retainsAttempts(firstAttempts, attempts) &&
        attempts.some(
          (attempt) =>
            !firstAttempts.some(
              (previousAttempt) => previousAttempt.rowId === attempt.rowId,
            ),
        ),
      'same-ID Job did not retain both native attempt generations',
    );
    jobInvariant(secondProgress, 'second generation progress is missing');
    const extension = this.#records.resubmitted(
      second,
      secondProgress,
      previous,
    );
    await artifacts.json(`job-${ref.id}-post-resubmission`, {
      workloadId: ref.id,
      generation: 2,
      previousGeneration: previous.generation,
      progress: secondProgress,
      resubmittedEvents: 1,
      erroredEvents: secondStatus.events.filter(
        (event) => event.state === WorkloadState.Errored,
      ).length,
      attempts,
    });
    return this.#finalize(
      [
        {
          fixture,
          run: second,
          progress: secondProgress,
          extensions: [extension],
          terminalStatus: secondStatus,
        },
      ],
      budget.cleanupMs,
    );
  }

  #retainsAttempts(
    original: readonly JobNativeAttempt[],
    current: readonly JobNativeAttempt[],
  ): boolean {
    return original.every(
      (previous) =>
        previous.endedAt !== null &&
        current.some((attempt) =>
          (Object.keys(previous) as (keyof JobNativeAttempt)[]).every(
            (key) => attempt[key] === previous[key],
          ),
        ),
    );
  }

  async #progress(
    fixture: JobFixture,
    run: JobRun,
    timeoutMs: number,
  ): Promise<JobProgress> {
    const { kernel, target, wait } = this.#dependencies;
    const observation = await wait.for<JobProgressObservation>(
      `Job ${fixture.ref.id} generation ${run.generation} progress`,
      async (deadlineAt) => ({
        status: await kernel.status(fixture.ref, true),
        attempts: await target.attempts(fixture, deadlineAt),
      }),
      {
        timeoutMs,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: ({ status }) =>
          status.workload.state === WorkloadState.Running ||
          JOB_TERMINAL_STATES.includes(status.workload.state)
            ? undefined
            : status.workload.state,
      },
    );
    return this.#records.progress(run, observation);
  }

  #assertExit(status: StatusResponse, expected: 0 | 3): void {
    const state =
      expected === 0 ? WorkloadState.Completed : WorkloadState.Errored;
    const event = status.events
      .filter((candidate) => candidate.state === state)
      .at(-1);
    jobInvariant(
      status.workload.state === state && event?.metadata?.exitCode === expected,
      `terminal Job did not record exitCode ${expected}`,
    );
    jobInvariant(
      typeof status.workload.completedAt === 'number' &&
        status.workload.completedAt > 0,
      'terminal Job did not retain its outcome timestamp',
    );
  }

  async #finalize(
    children: readonly JobFinalization[],
    cleanupMs: number,
  ): Promise<JobContractResult> {
    const { kernel, target, artifacts } = this.#dependencies;
    const profile = children[0]?.fixture.profile;
    jobInvariant(
      profile &&
        children.length === jobGroupSize(profile) &&
        new Set(children.map(({ fixture }) => fixture.ref)).size ===
          children.length &&
        children.every(({ fixture }) => fixture.profile === profile),
      'Job finalization requires every original member child',
    );
    const resources =
      profile.credentialMode === 'credentialless' ? target : this.#cloud();
    // Claim every child before releasing one; only the fully released member completes.
    for (const { run, progress, extensions, terminalStatus } of children) {
      const terminal = this.#records.terminal(run, terminalStatus);
      this.#records.claim(run, progress, extensions, terminal);
    }
    for (const { fixture, terminalStatus } of children) {
      const { ref } = fixture;
      const cleanup = await kernel.waitForCleanupRecorded(ref, cleanupMs);
      const substrate = await resources.nativeAbsence(fixture, cleanupMs);
      // A spot group's one automatic bucket is checked once, after every
      // child's native absence.
      if (profile.spot && fixture === children.at(-1)!.fixture)
        await this.#cloud().automaticCheckpointAbsence(fixture);
      if (profile.member.kind === 'local-completed') {
        const cli = await target.completedByCli(fixture);
        jobInvariant(
          cli.waitSucceeded && cli.statusFinished,
          'the CLI did not report the completed Job as succeeded',
        );
        await kernel.requestTermination(ref, 180_000);
        const after = await kernel.status(ref, true);
        this.#assertExit(after, 0);
        jobInvariant(
          after.workload.completedAt === terminalStatus.workload.completedAt,
          'termination overwrote the completed Job outcome',
        );
      }
      const attempts = await resources.attempts(fixture);
      const ledger = kernel.recordLedgerCleared(
        ref,
        attempts.filter((attempt) => attempt.endedAt === null).length,
      );
      await kernel.release({ cleanup, ledger, substrate });
      await resources.releaseResources(fixture);
    }
    const result: JobContractResult = {
      contract: 'dedicated-job',
      member: profile.member,
      target: profile.member.target,
      qualification: 'conclusive',
      satisfied: true,
    };
    await artifacts.json('dedicated-job-result', {
      ...result,
      ...(children.length === 1
        ? {
            workloadId: children[0].fixture.ref.id,
            generation: children[0].run.generation,
          }
        : {
            children: children.map(({ fixture, run }) => ({
              workloadId: fixture.ref.id,
              generation: run.generation,
            })),
          }),
    });
    return result;
  }
}

/** A Lambda type names its GPUs (`gpu_1x_a10`: one A10); other types have none. */
export function gpusMatchType(
  vmType: string,
  gpus: readonly string[],
): boolean {
  const named = /^gpu_(\d+)x_([a-z0-9]+)/u.exec(vmType);
  if (!named) return gpus.length === 0;
  const model = new RegExp(`\\b${named[2]}\\b`, 'iu');
  return (
    gpus.length === Number(named[1]) && gpus.every((gpu) => model.test(gpu))
  );
}

/**
 * Each launch failover with how soon the next target was claimed, and
 * the untried-target count each claim recorded.
 */
export function launchFailovers(events: StatusResponse['events']): {
  readonly failovers: readonly { id: number; claimAfterMs: number }[];
  readonly untried: readonly number[];
} {
  const claims = events.filter(
    (event) =>
      event.state === WorkloadState.Provisioning &&
      isRecord(event.metadata) &&
      typeof event.metadata.untriedTargets === 'number',
  );
  const failovers = events
    .filter(
      (event) =>
        event.state === WorkloadState.Retrying &&
        isRecord(event.metadata) &&
        event.metadata.disposition === 'failover-target' &&
        event.metadata.launchFailover === true,
    )
    .map((event) => {
      const claim = claims.find((next) => next.id > event.id);
      return {
        id: event.id,
        claimAfterMs: claim
          ? claim.createdAt - event.createdAt
          : Number.POSITIVE_INFINITY,
      };
    });
  return {
    failovers,
    untried: claims.map(({ metadata }) =>
      isRecord(metadata) ? Number(metadata.untriedTargets) : NaN,
    ),
  };
}

/** The preemption grace a clean spot exit waits out without that fix. */
const SPOT_EXIT_GRACE_SECONDS = 150;

/** The capped end and in-place rerun diagnosis; its spec builds on the product's. */
const GPU_PASSED_PROBE_TWICE = 'passed a CUDA check on its VM twice';
const GPU_RERUN_IN_PLACE = 'gpu-rerun-in-place';

/**
 * What the in-place rerun promises of a GPU Job that reports no GPU on a healthy one,
 * each unmet promise named: Errored with the passed-probe message after
 * exactly one in-place rerun whose probe listed a GPU and exited 0, no other
 * retry, and every attempt on the one VM.
 */
export function gpuProbeRerunEvidence(
  status: {
    readonly workload: Pick<StatusResponse['workload'], 'state'>;
    readonly events: StatusResponse['events'];
  },
  attempts: readonly {
    readonly cloudId: string | null;
    readonly endedAt?: number | null;
  }[],
): { readonly vms: readonly string[]; readonly failures: readonly string[] } {
  const text = (metadata: unknown, key: string) =>
    isRecord(metadata) && typeof metadata[key] === 'string'
      ? metadata[key]
      : '';
  // Launches refused for capacity before the VM ran fail over;
  // only those retries, and the attempts they ended, are left out.
  const ran = status.events.find(
    (event) => event.state === WorkloadState.Running,
  );
  const capacity = (event: StatusResponse['events'][number]) =>
    !!ran &&
    event.id < ran.id &&
    (text(event.metadata, 'disposition') === 'failover-target' ||
      text(event.metadata, 'diagnosis') === 'capacity-exhausted');
  const allRetries = status.events.filter(
    (event) => event.state === WorkloadState.Retrying,
  );
  const retries = allRetries.filter((event) => !capacity(event));
  const refusedOnly =
    !!ran &&
    retries.every((event) => event.id > ran.id) &&
    allRetries.length > retries.length;
  const reruns = retries.filter(
    (event) => text(event.metadata, 'diagnosis') === GPU_RERUN_IN_PLACE,
  );
  const probe = text(reruns[0]?.metadata, 'gpuProbe');
  const end = status.events.findLast(
    (event) => event.state === WorkloadState.Errored,
  );
  const vms = [
    ...new Set(
      attempts
        .filter(
          ({ endedAt }) =>
            !refusedOnly ||
            (endedAt ?? Number.POSITIVE_INFINITY) > ran.createdAt,
        )
        .map((attempt) => attempt.cloudId ?? ''),
    ),
  ];
  const failures = [
    status.workload.state !== WorkloadState.Errored &&
      `ended ${status.workload.state}, not errored`,
    (end?.state !== WorkloadState.Errored ||
      !text(end.metadata, 'message').includes(GPU_PASSED_PROBE_TWICE)) &&
      `the end does not say the GPU ${GPU_PASSED_PROBE_TWICE}: ${JSON.stringify(end?.metadata ?? null)}`,
    reruns.length !== 1 && `${String(reruns.length)} in-place reruns, not one`,
    retries.length !== reruns.length &&
      `${String(retries.length - reruns.length)} retries besides the in-place rerun`,
    (!/^GPU \d+:/mu.test(probe) || !probe.endsWith('exit=0')) &&
      `the rerun's probe did not pass: ${JSON.stringify(probe)}`,
    (vms.length !== 1 || !vms[0]) &&
      `ran on ${String(vms.length)} VMs: ${vms.join(', ')}`,
  ].filter((failure): failure is string => typeof failure === 'string');
  return { vms, failures };
}
