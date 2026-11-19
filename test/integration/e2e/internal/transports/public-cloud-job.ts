import {
  completedJobByCli,
  logsStopWithTheirReader,
  statusCheckpoint,
} from '../cli-observations.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { CloudType } from '../../../../../src/shared/cloud.js';
import { declaredApiError, type ApiClient } from '../api.js';
import { WorkloadState } from '../../../../../src/shared/workload.js';
import type { PersistentVmCleanup } from '../persistent-vm-cleanup.js';
import type { ArtifactStore, Redactor } from '../artifacts.js';
import type { CleanupStack } from '../cleanup.js';
import type { CliClient } from '../cli.js';
import { escapedSql, type CliDatabase } from '../database.js';
import type { FixtureFiles } from '../files.js';
import {
  JobAuthorization,
  type JobAuthorizationRef,
} from '../job-authorization.js';
import { JobCloudStorage, type JobBucketRef } from '../job-cloud-storage.js';
import {
  assertJobController,
  jobControllerBinding,
  type JobControllerBinding,
} from '../job-controller.js';
import type { JobNativeCleanup } from '../job-native-cleanup.js';
import { submitJob } from '../job-submission.js';
import type { ProcessRunner } from '../process.js';
import type { ProviderProfiles, VmProfile } from '../profiles.js';
import type { RemoteExecutor } from '../remote.js';
import type { SecretManager } from '../secrets.js';
import type {
  CloudJobFixture,
  CloudJobTransport,
  JobMemberProfile,
  JobStageBudget,
  JobTransferFacts,
  JobFixture,
  JobNativeAttempt,
  JobRecoveryIdentity,
  JobRuntimeSecretFacts,
  JobRuntimeSecretFile,
  JobAdmissionCase,
  JobAdmissionObservation,
  JobDiskTierCase,
  JobRestrictedCredentialCase,
} from '../targets/job-types.js';
import { jobGroupSize, JobResultNotJson } from '../targets/job-types.js';
import {
  isRecord,
  type CommandResult,
  type StatusResponse,
  type WorkloadCreateBody,
  type WorkloadCreateResponse,
} from '../types.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import type { Waiter } from '../wait.js';
import type { WorkloadMutationTransport } from '../workload-mutations.js';
import type {
  SubstrateAbsent,
  TrackedWorkloadKernel,
  TrackedWorkloadRef,
} from '../workloads.js';
import type { TargetHttpClient } from './http.js';
import { JobBucketNativeReader } from './job-bucket-native.js';
import { JobCloudSession } from './job-cloud-session.js';
import {
  JobPrivateCommands,
  jobOperationTimeout,
  privateJobOutput,
  quote,
} from './job-command.js';
import { gcpQuotaLimits, JobRecoveryTransport } from './job-recovery.js';
import { JobHydrationTransport } from './job-hydration.js';
import { JobSpotTransport } from './job-spot.js';
import { JobMaceTransport } from './job-mace.js';
import { JobGhcrTransport } from './job-ghcr.js';
import {
  PRIVATE_GIT_SCRIPT,
  privateGitMarkers,
  privateGitPassed,
} from '../probes/private-git.js';
import {
  gpuHealthFaultCommand,
  gpuHealthFaultLine,
  gpuHealthFaultNeedle,
} from '../probes/gpu-health-fault.js';
import type { LocalApiRestarter } from './local-api-restart.js';
import { prepareJobTransfers } from './job-transfers.js';
import type { PublicCloudVmHostPresenceProbeFactory } from './public-cloud-vm-host-presence.js';

export interface PublicCloudJobDependencies {
  readonly api: ApiClient;
  readonly cleanupApi: ApiClient;
  readonly database: Pick<CliDatabase, 'queryComplete'>;
  readonly cleanupDatabase: Pick<CliDatabase, 'queryComplete'>;
  readonly commands: JobPrivateCommands;
  readonly cleanupCommands: JobPrivateCommands;
  readonly cli: Pick<
    CliClient,
    'run' | 'runToFirstMatch' | 'runWithTransientRetries'
  >;
  readonly cleanupCli: Pick<CliClient, 'run'>;
  readonly profiles: Pick<ProviderProfiles, 'vm'>;
  readonly files: Pick<
    FixtureFiles,
    'directory' | 'text' | 'privateText' | 'remove'
  >;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly artifacts: Pick<ArtifactStore, 'json' | 'text'>;
  readonly redactor: Pick<Redactor, 'add'>;
  readonly kernel: Pick<
    TrackedWorkloadKernel,
    | 'reserveWithCleanupVerification'
    | 'assertActive'
    | 'recordSubstrateAbsence'
    | 'status'
  >;
  readonly native: Pick<
    JobNativeCleanup,
    'register' | 'creationStarted' | 'capture' | 'verify'
  >;
  readonly mutations: Pick<WorkloadMutationTransport, 'runCliCreate'>;
  readonly hosts: Pick<PublicCloudVmHostPresenceProbeFactory, 'create'>;
  readonly remote: Pick<RemoteExecutor, 'run'>;
  readonly cleanupRemote?: Pick<RemoteExecutor, 'pinHost'>;
  readonly secrets: Pick<SecretManager, 'create' | 'delete'>;
  readonly wait: Pick<Waiter, 'for'>;
  readonly cleanupWait: Pick<Waiter, 'for'>;
  readonly vmLedger: Pick<VmLedgerProbe, 'liveVmMetadata'>;
  readonly http: Pick<TargetHttpClient, 'get'>;
  readonly cleanupSignal: AbortSignal;
  /** Reads the private fixture repository; required by the runtime-secret member. */
  readonly privateRepoToken?: string;
  readonly maceObserver?: {
    readonly runner: Pick<ProcessRunner, 'run'>;
    readonly bearer: (url: string) => string;
  };
  readonly apiRestarter?: Pick<LocalApiRestarter, 'restart'>;
  readonly cleanupHttp?: Pick<TargetHttpClient, 'get'>;
  readonly admission?: {
    readonly native: Pick<
      PersistentVmCleanup,
      | 'reserveWithProfile'
      | 'creationStarted'
      | 'recordAdmissionRejection'
      | 'recordAdmissionInvalid'
      | 'recordAdmissionStatus'
      | 'verify'
    >;
    readonly mutations: Pick<WorkloadMutationTransport, 'createWithApi'>;
    readonly kernel: Pick<TrackedWorkloadKernel, 'releaseUncreated' | 'status'>;
  };
}

interface OwnedAdmission {
  readonly admissionCase: JobAdmissionCase;
  readonly request: WorkloadCreateBody;
  started: boolean;
  response?: WorkloadCreateResponse;
  status?: StatusResponse;
  observation?: JobAdmissionObservation;
}

interface OwnedChild {
  nativeAbsent: boolean;
  released: boolean;
  substrate?: SubstrateAbsent;
}
interface OwnedGroup {
  readonly controller: JobControllerBinding;
  readonly startedAt: number;
  readonly children: Map<string, OwnedChild>;
  readonly authorizations: {
    owner: JobAuthorization;
    binding: JobAuthorizationRef;
  }[];
  readonly cleanupMs: number;
  storage?: JobCloudStorage;
  input?: JobBucketRef;
  output?: JobBucketRef;
  checkpoint?: JobBucketRef;
  transfers?: JobTransferFacts;
  recovery?: JobRecoveryTransport;
  hydration?: JobHydrationTransport;
  /** One per child: each Job has its own persistent request. */
  spot?: Map<string, JobSpotTransport>;
  mace?: JobMaceTransport;
  ghcr?: JobGhcrTransport;
  hydrationFixture?: NonNullable<CloudJobFixture['hydration']>;
  originalCompute?: VmProfile;
  admissions?: Map<TrackedWorkloadRef, OwnedAdmission>;
  runtimeSecrets?: {
    readonly names: readonly [string, string, string, string];
    readonly expected: readonly Readonly<Record<string, string>>[];
    /** The newest saved HF_TOKEN, which the first Job's file must hold. */
    fileDigest: string;
    forceDeleted: boolean;
  };
  arming?: Promise<void>;
  released: boolean;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The profile one child's native host probe observes its attempts with. A
 * restricted credential cannot read regions it is denied, though its Job may
 * have attempted one, so the account's own credential proves those absent.
 */
export function jobHostProbeProfile(
  original: VmProfile,
  originalCompute: VmProfile,
  diskTierCase?: JobDiskTierCase,
  restrictedCredentialCase?: JobRestrictedCredentialCase,
): VmProfile {
  if (diskTierCase)
    return { ...originalCompute, vmTypes: [diskTierCase.vmType] };
  if (restrictedCredentialCase)
    return {
      ...originalCompute,
      credential: original.credential,
      vmTypes: [restrictedCredentialCase.vmType],
      region: restrictedCredentialCase.region,
    };
  return originalCompute;
}

/** Concrete cloud resources share one dependency owner across all concurrent children. */
export class PublicCloudJobTransport implements CloudJobTransport {
  readonly #dependencies: PublicCloudJobDependencies;
  readonly #owned = new WeakMap<JobFixture, OwnedGroup>();

  constructor(dependencies: PublicCloudJobDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(
    ids: readonly string[],
    profile: JobMemberProfile,
    budget: JobStageBudget,
  ): Promise<readonly CloudJobFixture[]> {
    const childCount = jobGroupSize(profile);
    if (
      profile.member.target === 'local-smolvm' ||
      profile.storageProvider === 'local' ||
      profile.credentialMode === 'credentialless' ||
      ids.length !== childCount ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[a-z0-9-]{1,48}$/u.test(id))
    )
      throw new Error('Cloud Job group has an invalid member or identity');
    const d = this.#dependencies;
    if (profile.mace && !d.maceObserver)
      throw new Error('MACE Job lacks its timing observer composition');
    if (profile.ghcr && !d.cleanupRemote)
      throw new Error('GHCR Job lacks its independent pinned SSH transport');
    const maceCommand = profile.mace
      ? await readFile(
          new URL(
            '../../../../docker/mace-first-inference.py',
            import.meta.url,
          ),
          'utf8',
        )
      : undefined;
    const group: OwnedGroup = {
      controller: jobControllerBinding(d.api),
      startedAt: Date.now(),
      children: new Map(
        ids.map((id) => [id, { nativeAbsent: true, released: false }]),
      ),
      authorizations: [],
      cleanupMs: budget.cleanupMs,
      released: false,
    };
    assertJobController(d.cleanupApi, group.controller);
    const childrenAbsent = (): void => {
      if ([...group.children.values()].some((child) => !child.nativeAbsent))
        throw new Error('Job group still owns an unresolved native child');
    };
    const dependentsAbsent = (): void => {
      childrenAbsent();
      group.storage?.assertAbsent();
      for (const spot of group.spot?.values() ?? []) spot.assertAbsent();
    };
    const deadlineAt = Date.now() + 1_200_000;
    const original = d.profiles.vm(profile.member.target);
    const name = [
      'aws-import',
      'aws-restricted',
      'azure-restricted',
      'gcp-import',
      'azure-generate',
    ].includes(profile.credentialMode)
      ? `bkt-${BigInt(`0x${digest(ids.join(',')).slice(0, 14)}`).toString()}`
      : original.credentialName;
    const compute = new JobAuthorization(d, {
      name,
      profile: original,
      mode: profile.credentialMode,
      // The pilot credential reaches only the bucket this member's Job writes.
      restrictedBuckets:
        profile.credentialMode === 'aws-restricted'
          ? [`j-output-${ids[0]}`]
          : undefined,
      cleanupMs: budget.cleanupMs,
      dependentsAbsent,
    });
    const binding = await compute.create(deadlineAt);
    group.authorizations.push({ owner: compute, binding });
    assertJobController(d.api, group.controller);
    const originalCompute: VmProfile = Object.freeze({
      ...original,
      credentialName: name,
      credential: compute.material(binding),
      vmTypes: profile.vmTypes,
      region: profile.computeRegion,
    });
    group.originalCompute = originalCompute;
    if (profile.member.kind === 'invalid-admission') {
      const owner = d.admission;
      if (!owner || !profile.admissionCases?.length)
        throw new Error('Job admission lacks its shared native owner or cases');
      group.admissions = new Map();
      const fixtures: CloudJobFixture[] = [];
      for (const [index, admissionCase] of profile.admissionCases.entries()) {
        const child = this.#child(group, ids[index]);
        child.nativeAbsent = false;
        const ref = await owner.native.reserveWithProfile(
          profile.member.target,
          ids[index],
          budget.cleanupMs,
          {
            ...originalCompute,
            vmTypes: [admissionCase.vmType],
            region: admissionCase.region,
          },
          (originalRef) => {
            d.kernel.assertActive(originalRef);
            assertJobController(d.cleanupApi, group.controller);
            child.nativeAbsent = true;
            return Promise.resolve();
          },
          d.api.controller,
        );
        const inputBucket = admissionCase.bucketPrefix
          ? `${admissionCase.bucketPrefix}${ref.id}`
          : undefined;
        if (inputBucket && inputBucket.length > 63)
          throw new Error('Reserved bucket fixture exceeds its naming limit');
        const request: WorkloadCreateBody = {
          id: ref.id,
          workloadType: 'job',
          credentialName: name,
          image: admissionCase.image,
          cloudConfig: {
            vmType: admissionCase.vmType,
            ...(admissionCase.region ? { region: admissionCase.region } : {}),
            ...(inputBucket ? { inputBucket } : {}),
          },
          ...(admissionCase.dockerOptions
            ? { dockerOptions: { ...admissionCase.dockerOptions } }
            : {}),
        };
        const fixture: CloudJobFixture = Object.freeze({
          ref,
          profile,
          admissionCase,
          credentialName: name,
          storageCredentialName: name,
          inputBucket,
          runLabel: ids[0],
          concurrentIndex: index,
          concurrentWrites: [],
        });
        group.admissions.set(ref, { admissionCase, request, started: false });
        this.#owned.set(fixture, group);
        fixtures.push(fixture);
      }
      return fixtures;
    }
    const storageName = profile.crossCloudStorageCredential ?? name;
    let launchFailover: CloudJobFixture['launchFailover'];
    // MACE and image probes have no bucket consumers. In particular Lambda
    // must not acquire an unrelated AWS storage authorization for these Jobs.
    if (profile.storageProvider !== 'none') {
      const storageProfile = profile.crossCloudStorageCredential
        ? d.profiles.vm(profile.storageProvider)
        : original;
      if (profile.crossCloudStorageCredential) {
        const storageAuthorization = new JobAuthorization(d, {
          name: storageName,
          profile: storageProfile,
          mode: 'bootstrap',
          cleanupMs: budget.cleanupMs,
          dependentsAbsent,
        });
        const storageBinding = await storageAuthorization.create(deadlineAt);
        group.authorizations.push({
          owner: storageAuthorization,
          binding: storageBinding,
        });
        assertJobController(d.api, group.controller);
      }
      const nativeCredential = storageProfile.credential;
      if (
        nativeCredential.cloudProvider !== CloudType.AWS &&
        nativeCredential.cloudProvider !== CloudType.GCP &&
        nativeCredential.cloudProvider !== CloudType.Azure
      )
        throw new Error(
          'Job storage registration lacks a native storage authorization',
        );
      if (
        profile.crossCloudStorageCredential &&
        nativeCredential.cloudProvider === CloudType.AWS &&
        nativeCredential.sessionToken
      )
        throw new Error(
          'Cross-cloud Job storage requires its long-term AWS fixture',
        );
      const session = new JobCloudSession({
        ...d,
        name: ids[0],
        credential: nativeCredential,
      });
      if (
        profile.requiredExtensions.some((extension) =>
          [
            'in-place-recovery',
            'host-recovery',
            'input-hydration-recovery',
            'disk-tier',
            'spot-eviction',
            'gpu-spot-eviction',
          ].includes(extension),
        ) ||
        // Native reads of a region-listed VM and a gp3 root.
        profile.computeRegions !== undefined ||
        profile.diskIops !== undefined
      ) {
        if (original.provider !== nativeCredential.cloudProvider)
          throw new Error(
            'Job recovery session has another compute authorization scope',
          );
        group.recovery = new JobRecoveryTransport(session, d.artifacts);
      }
      if (profile.launchFailover) {
        // The head type launches only where its quota is 0, so it is
        // always refused; with any quota the Job could run on an A100.
        const quotas = await gcpQuotaLimits(
          session,
          profile.computeRegions ?? [],
          /A100/u,
          deadlineAt,
        );
        launchFailover = Object.freeze({
          quotas,
          armed: Object.values(quotas).every((byMetric) =>
            Object.values(byMetric).every((limit) => limit === 0),
          ),
        });
      }
      const ownerApi = await this.#apiOwner(group, deadlineAt);
      const storage = new JobCloudStorage(
        {
          ...d,
          native: new JobBucketNativeReader(session, profile.storageRegion),
        },
        {
          credentialName: storageName,
          region: profile.storageRegion,
          ownerApi,
          storageFollowsCompute: profile.storageFollowsCompute,
          childrenAbsent,
          cleanupMs: budget.cleanupMs,
        },
      );
      group.storage = storage;
      if (
        ['bucket-sync', 'input-hydration-recovery'].includes(
          profile.member.kind,
        )
      )
        group.input = await storage.reserve(
          `j-input-${ids[0]}`,
          'explicit',
          ids,
          deadlineAt,
        );
      if (
        [
          'bucket-sync',
          'concurrent-output',
          'input-hydration-recovery',
          'restricted-credential',
          'spot-eviction',
          'gpu-spot-eviction',
        ].includes(profile.member.kind)
      )
        group.output = await storage.reserve(
          `j-output-${ids[0]}`,
          'automatic',
          ids,
          deadlineAt,
        );
      if (profile.explicitCheckpoint) {
        group.checkpoint = await storage.reserve(
          `ckpt-${ids[0]}-host`,
          'explicit',
          ids,
          deadlineAt,
        );
        await storage.create(group.checkpoint, deadlineAt);
      }
      if (profile.spot)
        group.checkpoint = await storage.reserve(
          ids[0],
          'automatic',
          ids,
          deadlineAt,
        );
      if (profile.requiredExtensions.includes('spot-request-cleanup')) {
        await session.initialize(deadlineAt);
        group.spot = new Map(
          ids.map((id) => [
            id,
            new JobSpotTransport({
              ...d,
              session,
              id,
              credentialId: binding.recordId,
              ownerApi,
              vmTypes: profile.vmTypes,
              cleanupMs: budget.cleanupMs,
              assertController: () => {
                assertJobController(d.api, group.controller);
                assertJobController(d.cleanupApi, group.controller);
              },
              nativeAbsent: () =>
                [...group.children.values()].every(
                  (child) => child.nativeAbsent,
                ),
            }),
          ]),
        );
      }
      if (group.input) {
        await storage.create(group.input, deadlineAt);
        if (profile.member.kind === 'input-hydration-recovery') {
          if (!d.apiRestarter || !d.cleanupHttp || !group.output)
            throw new Error(
              'Job hydration requires its existing API restarter and independent cleanup transport',
            );
          group.hydration = new JobHydrationTransport({
            ...d,
            apiRestarter: d.apiRestarter,
            cleanupHttp: d.cleanupHttp,
            id: ids[0],
            region: profile.storageRegion,
            apiUrl: group.controller.url,
            assertController: () => {
              assertJobController(d.api, group.controller);
              assertJobController(d.cleanupApi, group.controller);
            },
            session,
            storage,
            input: group.input,
            output: group.output,
          });
          group.hydrationFixture =
            await group.hydration.prepareInput(deadlineAt);
        } else
          group.transfers = await prepareJobTransfers(
            storage,
            group.input,
            d.files,
            ids[0],
            profile.recursiveTransfers,
            deadlineAt,
          );
      }
    }
    if (profile.requiredExtensions.includes('runtime-secrets')) {
      if (!d.privateRepoToken)
        throw new Error(
          'Runtime-secret Jobs need E2E_PRIVATE_REPO_TOKEN with read access to the private fixture repository',
        );
      const names = [
        `job-hf-${ids[0]}`,
        `job-wandb-${ids[0]}`,
        `job-gh-${ids[0]}`,
        `job-dup-${ids[0]}`,
      ] as const;
      const values = [
        { HF_TOKEN: `xyz-original-${ids[0]}` },
        {
          WANDB_API_KEY: `wandb-${ids[0]}`,
          WANDB_ENTITY: `team-${ids[0]}`,
        },
        // The documented `github` Secret; only the first Job carries it.
        { GITHUB_TOKEN: d.privateRepoToken },
        { K: 'from-secret' },
      ] as const;
      for (const bundle of values)
        for (const value of Object.values(bundle)) d.redactor.add(value);
      group.runtimeSecrets = {
        names: Object.freeze(names),
        expected: Object.freeze([
          Object.freeze({
            HF_TOKEN: digest(values[0].HF_TOKEN),
            WANDB_API_KEY: digest(values[1].WANDB_API_KEY),
            WANDB_ENTITY: digest(values[1].WANDB_ENTITY),
          }),
          Object.freeze({ K: digest('from-env') }),
        ]),
        fileDigest: digest(values[0].HF_TOKEN),
        forceDeleted: false,
      };
      for (const [index, name] of names.entries()) {
        assertJobController(d.api, group.controller);
        // SecretManager registers its independent cleanup before each save.
        await d.secrets.create(name, values[index]);
        assertJobController(d.api, group.controller);
      }
    }
    const writes = Object.freeze(
      ids.map((id, index) =>
        Object.freeze({
          key: `job-${index + 1}/output.txt`,
          contents: `concurrent-output-${index + 1}-${id}`,
        }),
      ),
    );
    const fixtures: CloudJobFixture[] = [];
    for (const [index, id] of ids.entries()) {
      const diskTierCase = profile.diskTierCases?.[index];
      const restrictedCredentialCase =
        profile.restrictedCredential?.cases[index];
      const native = d.hosts.create(
        jobHostProbeProfile(
          original,
          originalCompute,
          diskTierCase,
          restrictedCredentialCase,
        ),
      );
      const child = this.#child(group, id);
      const ref = await d.kernel.reserveWithCleanupVerification(
        id,
        budget.cleanupMs,
        async (registered, timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          await d.native.verify(registered, timeoutMs);
          group.spot
            ?.get(id)
            ?.remember(await d.native.capture(registered, deadline));
          child.nativeAbsent = true;
        },
        group.controller,
      );
      d.native.register(
        ref,
        {
          provider: originalCompute.provider,
          credentialId: binding.recordId,
          controller: group.controller,
        },
        {
          ...(profile.reservationInventory
            ? {
                reservations: {
                  credentialName: originalCompute.credentialName,
                  observe: (attempts, deadlineAt, onPartialObservation) =>
                    native.observeReservations(attempts, {
                      deadlineAt,
                      signal: d.cleanupSignal,
                      onPartialObservation,
                    }),
                  observeMatch: (location, timeoutMs, deadlineAt) =>
                    native.observe(location, {
                      deadlineAt: Math.min(deadlineAt, Date.now() + timeoutMs),
                      signal: d.cleanupSignal,
                    }),
                },
              }
            : {}),
          observe: (attempt, timeoutMs, deadline) =>
            native.observe(
              {
                cloudId: attempt.cloudId,
                region: attempt.region,
                availabilityZone: attempt.availabilityZone,
              },
              {
                deadlineAt: Math.min(deadline, Date.now() + timeoutMs),
                signal: d.cleanupSignal,
                bootDiskOwner: ref.id,
              },
            ),
        },
      );
      const fixture: CloudJobFixture = Object.freeze({
        ref,
        profile,
        diskTierCase,
        restrictedCredentialCase,
        launchFailover,
        credentialName: name,
        storageCredentialName: storageName,
        inputBucket: group.input?.name,
        outputBucket:
          restrictedCredentialCase && restrictedCredentialCase.key !== 'output'
            ? undefined
            : group.output?.name,
        checkpointBucket: group.checkpoint?.name,
        runtimeSecretNames: group.runtimeSecrets
          ? Object.freeze(
              index === 0
                ? group.runtimeSecrets.names.slice(0, 3)
                : [group.runtimeSecrets.names[3]],
            )
          : undefined,
        hydration: group.hydrationFixture,
        maceCommand,
        runLabel: ids[0],
        concurrentIndex: index,
        concurrentWrites: writes,
      });
      this.#owned.set(fixture, group);
      fixtures.push(fixture);
      if (profile.mace)
        group.mace = new JobMaceTransport({
          profile,
          ...d,
          ...d.maceObserver!,
          id,
          apiUrl: group.controller.url,
          assertController: () => {
            assertJobController(d.api, group.controller);
            assertJobController(d.cleanupApi, group.controller);
          },
        });
      if (profile.ghcr)
        group.ghcr = new JobGhcrTransport({
          ...d,
          fixture,
          cleanupRemote: d.cleanupRemote!,
          assertController: () => {
            assertJobController(d.api, group.controller);
            assertJobController(d.cleanupApi, group.controller);
          },
          assertAttempt: async (attempt) => {
            this.#require(fixture);
            const rows = await d.native.capture(ref, Date.now() + 60_000);
            this.#require(fixture);
            const live = rows.filter((row) => row.endedAt === null);
            const current = live[0];
            if (
              live.length !== 1 ||
              attempt.ref !== ref ||
              !current ||
              current.rowId !== attempt.rowId ||
              current.cloudId !== attempt.cloudId ||
              current.credentialId !== attempt.credentialId ||
              current.ip !== attempt.ip ||
              current.region !== attempt.region ||
              current.availabilityZone !== attempt.availabilityZone ||
              current.vmType !== attempt.vmType ||
              current.cloudProvider !== attempt.cloudProvider
            )
              throw new Error(
                'GHCR probe lost its original active native attempt',
              );
          },
        });
      group.spot
        ?.get(id)
        ?.arm(ref, (deadline) => d.native.capture(ref, deadline));
      group.hydration?.armApiRescue(d.cleanup, budget.cleanupMs);
      await d.artifacts.json(`job-${id}-profile`, {
        controller: group.controller,
        member: profile.member,
        profile,
        diskTierCase,
        workloadId: id,
        generation: 1,
        startedAt: group.startedAt,
        computeCredential: binding,
        storageCredentialName: storageName,
        inputBucket: group.input?.name,
        outputBucket: group.output?.name,
        checkpointBucket: group.checkpoint?.name,
        concurrentIndex: index,
        concurrentWrites: writes,
      });
    }
    return Object.freeze(fixtures);
  }

  async submit(
    fixture: CloudJobFixture,
    args: readonly string[],
  ): Promise<void> {
    const group = this.#require(fixture);
    group.arming ??= Promise.resolve().then(async () => {
      const deadlineAt = Date.now() + 60_000;
      if (group.output)
        await this.#storage(group).beginAutomatic(group.output, deadlineAt);
      if (group.checkpoint && !fixture.profile.explicitCheckpoint)
        await this.#storage(group).beginAutomatic(group.checkpoint, deadlineAt);
    });
    await group.arming;
    this.#require(fixture);
    this.#child(group, fixture.ref.id).nativeAbsent = false;
    await submitJob(fixture.ref, args, {
      native: this.#dependencies.native,
      mutations: {
        runCliCreate: (ref, command, options) => {
          // creationStarted awaits inventory; recheck directly at the send boundary.
          this.#require(fixture);
          group.spot?.get(fixture.ref.id)?.sent();
          return this.#dependencies.mutations.runCliCreate(
            ref,
            command,
            options,
          );
        },
      },
    });
    await this.#credentialBinding(fixture, group, Date.now() + 60_000);
  }

  async attempts(
    fixture: JobFixture,
    deadlineAt?: number,
  ): ReturnType<CloudJobTransport['attempts']> {
    const group = this.#require(fixture);
    const attempts = await this.#dependencies.native.capture(
      fixture.ref,
      deadlineAt,
    );
    group.spot?.get(fixture.ref.id)?.remember(attempts);
    return attempts;
  }
  ghcr(fixture: CloudJobFixture): ReturnType<CloudJobTransport['ghcr']> {
    const transport = this.#require(fixture).ghcr;
    if (!transport) throw new Error('Job has no GHCR probe capability');
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      this.#require(fixture);
      const result = await operation();
      this.#require(fixture);
      return result;
    };
    return Object.freeze({
      prepare: () => owned(() => transport.prepare()),
      bind: (attempt: JobNativeAttempt) => owned(() => transport.bind(attempt)),
      throughput: (deadline: number) =>
        owned(() => transport.throughput(deadline)),
      startPull: () => owned(() => transport.startPull()),
      poll: (deadline: number) => owned(() => transport.poll(deadline)),
      capture: () => owned(() => transport.capture()),
      finish: (deadline: number) => owned(() => transport.finish(deadline)),
    });
  }
  mace(fixture: CloudJobFixture): ReturnType<CloudJobTransport['mace']> {
    const transport = this.#require(fixture).mace;
    if (!transport) throw new Error('Job has no MACE full-pull capability');
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      this.#require(fixture);
      const result = await operation();
      this.#require(fixture);
      return result;
    };
    return Object.freeze({
      start: (timeoutMs: number) => owned(() => transport.start(timeoutMs)),
      observation: () => owned(() => transport.observation()),
      finish: () => owned(() => transport.finish()),
      pullLogMessages: () => owned(() => transport.pullLogMessages()),
      writeReport: (...args: Parameters<typeof transport.writeReport>) =>
        owned(() => transport.writeReport(...args)),
    });
  }
  spot(fixture: CloudJobFixture): ReturnType<CloudJobTransport['spot']> {
    const transport = this.#require(fixture).spot?.get(fixture.ref.id);
    if (!transport)
      throw new Error('Job has no persistent Spot cleanup capability');
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      this.#require(fixture);
      const result = await operation();
      this.#require(fixture);
      return result;
    };
    return Object.freeze({
      now: () => {
        this.#require(fixture);
        return Date.now();
      },
      active: (attempt: JobNativeAttempt, deadline: number) =>
        owned(() => transport.active(attempt, deadline)),
      launched: (attempt: JobNativeAttempt, deadline: number) =>
        owned(() => transport.launched(attempt, deadline)),
      request: (deadline: number) => owned(() => transport.request(deadline)),
      instanceFilter: (deadline: number) =>
        owned(() => transport.instanceFilter(deadline)),
      liveInstances: (deadline: number) =>
        owned(() => transport.liveInstances(deadline)),
      pause: (milliseconds: number, deadline: number) =>
        owned(() => this.#dependencies.commands.wait(milliseconds, deadline)),
    });
  }
  hydration(
    fixture: CloudJobFixture,
  ): ReturnType<CloudJobTransport['hydration']> {
    const transport = this.#require(fixture).hydration;
    if (!transport) throw new Error('Job has no input-hydration capability');
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      this.#require(fixture);
      const result = await operation();
      this.#require(fixture);
      return result;
    };
    return Object.freeze({
      snapshot: (deadlineAt: number) =>
        owned(() => transport.snapshot(deadlineAt)),
      apiLogs: (deadlineAt: number) =>
        owned(() => transport.apiLogs(deadlineAt)),
      restart: () => owned(() => transport.restart()),
      disk: (identity: JobRecoveryIdentity, deadlineAt: number) =>
        owned(() => transport.disk(identity, deadlineAt)),
      hideActivity: () => owned(() => transport.hideActivity()),
      activity: (deadlineAt: number) =>
        owned(() => transport.activity(deadlineAt)),
      pause: (milliseconds: number) =>
        owned(() => transport.pause(milliseconds)),
      manifest: (deadlineAt: number) =>
        owned(() => transport.manifest(deadlineAt)),
    });
  }
  transfers(fixture: CloudJobFixture): Promise<JobTransferFacts> {
    const facts = this.#require(fixture).transfers;
    if (!facts) throw new Error('Job has no prepared transfer observations');
    return Promise.resolve(facts);
  }

  async imageConfigDigest(fixture: CloudJobFixture): Promise<string> {
    this.#require(fixture);
    let command = `docker inspect --format '{{.Image}}' ${quote(fixture.ref.id)}`;
    if (
      fixture.profile.requiredExtensions.includes('input-hydration-recovery')
    ) {
      // Before the container exists only the image is on the host, and the
      // product pulls `repo@digest` when admission resolved one: a digest pull
      // leaves no tag, so the tag lookup would report "No such image".
      const { workload } = await this.#dependencies.kernel.status(fixture.ref);
      const image = workload.imageDigest
        ? `${fixture.profile.image.replace(/[@:][^/]*$/u, '')}@${workload.imageDigest}`
        : fixture.profile.image;
      command = `docker image inspect --format '{{.Id}}' ${quote(image)}`;
    }
    const result = await this.#dependencies.remote.run(
      fixture.ref.id,
      'vm',
      command,
      { recordArtifact: false, timeoutMs: 90_000 },
    );
    const digest = privateJobOutput(result).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error('Job container image configuration digest is malformed');
    return digest;
  }
  async bucketReady(
    fixture: CloudJobFixture,
    role: 'output' | 'checkpoint',
    deadlineAt: number,
  ): Promise<boolean> {
    const group = this.#require(fixture);
    return (
      (
        await this.#storage(group).observe(
          this.#bucket(group, role),
          deadlineAt,
        )
      ).presence === 'present'
    );
  }
  async results(
    fixture: CloudJobFixture,
    role: 'output' | 'checkpoint',
    deadlineAt: number,
  ): Promise<unknown> {
    const group = this.#require(fixture);
    const storage = this.#storage(group);
    const bucket = this.#bucket(group, role);
    if ((await storage.observe(bucket, deadlineAt)).presence === 'absent')
      return undefined;
    const text = await storage.readText(bucket, 'results.json', deadlineAt);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new JobResultNotJson(text.length);
    }
  }
  async runtimeSecretFacts(
    fixture: CloudJobFixture,
  ): Promise<JobRuntimeSecretFacts> {
    const { group, secrets } = this.#runtimeSecretScope(fixture);
    const expected = secrets.expected[fixture.concurrentIndex];
    const keys = Object.keys(expected);
    const deadlineAt = Date.now() + 90_000;
    // Only one-way comparisons leave the container. Raw env/file contents are
    // never requested, and all SSH output remains private before validation.
    const hashes = privateJobOutput(
      await this.#guest(
        fixture,
        keys
          .map((key) => `printf '%s' "\${${key}-}" | sha256sum | cut -d' ' -f1`)
          .join('; '),
        deadlineAt,
      ),
    )
      .trim()
      .split('\n');
    if (
      hashes.length !== keys.length ||
      hashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))
    )
      throw new Error('Job runtime-secret digest response is incomplete');
    this.#runtimeSecretScope(fixture);
    const identity = privateJobOutput(
      await this.#dependencies.remote.run(
        fixture.ref.id,
        'vm',
        `docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.State.Running}}' ${quote(fixture.ref.id)}`,
        {
          recordArtifact: false,
          timeoutMs: jobOperationTimeout(deadlineAt, 90_000),
        },
      ),
    )
      .trim()
      .split(/\s+/u);
    if (
      identity.length !== 3 ||
      !/^[a-f0-9]{64}$/u.test(identity[0]) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(identity[1]) ||
      !Number.isFinite(Date.parse(identity[1])) ||
      identity[2] !== 'true'
    )
      throw new Error('Job runtime secrets lack an exact running container');
    this.#runtimeSecretScope(fixture);
    let file: Pick<JobRuntimeSecretFacts, 'mode' | 'uid' | 'fileSystem'> = {};
    if (fixture.concurrentIndex === 0) {
      const lines = privateJobOutput(
        await this.#dependencies.remote.run(
          fixture.ref.id,
          'vm',
          "set -e; sudo stat -c '%a %u' /run/anycloud-secrets/env; findmnt -n -o FSTYPE --target /run/anycloud-secrets/env",
          {
            recordArtifact: false,
            timeoutMs: jobOperationTimeout(deadlineAt, 90_000),
          },
        ),
      )
        .trim()
        .split('\n');
      const stat = /^([0-7]{3,4}) (\d+)$/u.exec(lines[0]);
      if (
        lines.length !== 2 ||
        !stat ||
        !Number.isSafeInteger(Number(stat[2])) ||
        !/^[a-z0-9_+-]+$/u.test(lines[1])
      )
        throw new Error('Job runtime-secret file response is incomplete');
      file = { mode: stat[1], uid: Number(stat[2]), fileSystem: lines[1] };
    }
    // Before the deletion only: the first Job carries the `github` Secret,
    // the second is the control without it.
    let git: Record<string, string> | undefined;
    if (!secrets.forceDeleted) {
      git = privateGitMarkers(
        privateJobOutput(await this.#guest(fixture, PRIVATE_GIT_SCRIPT)),
      );
      this.#runtimeSecretScope(fixture);
    }
    const facts: JobRuntimeSecretFacts = Object.freeze({
      environment: keys.every((key, index) => hashes[index] === expected[key]),
      containerId: identity[0],
      startedAt: identity[1],
      ...file,
      ...(git && {
        privateGit: privateGitPassed(git, fixture.concurrentIndex === 0),
      }),
    });
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-runtime-secrets-${secrets.forceDeleted ? 'after-delete' : 'before-delete'}`,
      {
        workloadId: fixture.ref.id,
        controller: group.controller,
        generation: 1,
        observedAt: Date.now(),
        bundleNames: fixture.runtimeSecretNames,
        keys,
        facts,
        privateGitMarkers: git,
      },
    );
    return facts;
  }

  async runtimeSecretFile(
    fixture: CloudJobFixture,
  ): Promise<JobRuntimeSecretFile> {
    const { secrets } = this.#primaryRuntimeSecret(fixture, true);
    const name = secrets.names[0];
    const path = `/run/anycloud-secrets/${name}/HF_TOKEN`;
    // Only the digest leaves the container, as for the environment.
    const guest = [
      `f=${quote(path)}`,
      '[ -e "$f" ] || { echo missing; exit 0; }',
      `sha256sum < "$f" | cut -d' ' -f1`,
      `stat -c '%a %u' "$f"`,
      `su -s /bin/sh nobody -c 'cat "$1"' sh "$f" >/dev/null 2>&1 && echo readable || echo denied`,
    ].join('; ');
    const lines = privateJobOutput(
      await this.#dependencies.remote.run(
        fixture.ref.id,
        'vm',
        `set -e; sudo findmnt -n -o FSTYPE --target /run/anycloud-secrets/files; docker exec ${quote(fixture.ref.id)} sh -c ${quote(guest)}`,
        { recordArtifact: false, timeoutMs: 90_000 },
      ),
    )
      .trim()
      .split('\n');
    this.#primaryRuntimeSecret(fixture, true);
    const [fileSystem, fileDigest, stat, access] = lines;
    if (!/^[a-z0-9_+-]+$/u.test(fileSystem ?? ''))
      throw new Error('Job runtime-secret file response is incomplete');
    if (fileDigest === 'missing') return { value: 'missing', fileSystem };
    const owner = /^([0-7]{3,4}) (\d+)$/u.exec(stat ?? '');
    if (
      lines.length !== 4 ||
      !/^[a-f0-9]{64}$/u.test(fileDigest) ||
      !owner ||
      !['readable', 'denied'].includes(access)
    )
      throw new Error('Job runtime-secret file response is incomplete');
    return {
      value: fileDigest === secrets.fileDigest ? 'newest' : 'stale',
      mode: owner[1],
      uid: Number(owner[2]),
      nobodyReads: access === 'readable',
      fileSystem,
    };
  }

  async updateRuntimeSecret(fixture: CloudJobFixture): Promise<void> {
    const { secrets } = this.#primaryRuntimeSecret(fixture);
    const value = `xyz-updated-${fixture.ref.id}`;
    this.#dependencies.redactor.add(value);
    await this.#dependencies.secrets.create(secrets.names[0], {
      HF_TOKEN: value,
    });
    this.#primaryRuntimeSecret(fixture);
    secrets.fileDigest = digest(value);
  }

  async clearRuntimeSecretFiles(fixture: CloudJobFixture): Promise<void> {
    const { secrets } = this.#primaryRuntimeSecret(fixture);
    const dir = '/run/anycloud-secrets/files';
    const files = `${dir}/${secrets.names[0]}`;
    privateJobOutput(
      await this.#dependencies.remote.run(
        fixture.ref.id,
        'vm',
        `sudo find ${quote(dir)} -maxdepth 1 \\( -name ${quote(secrets.names[0])} -o -name ${quote(`.${secrets.names[0]}.*`)} \\) -exec rm -rf -- {} + && ! sudo test -e ${quote(files)}`,
        { recordArtifact: false, timeoutMs: 90_000 },
      ),
    );
    this.#primaryRuntimeSecret(fixture);
  }

  /** The first Job's Secret; only reads continue after its deletion. */
  #primaryRuntimeSecret(
    fixture: CloudJobFixture,
    afterDeletion = false,
  ): {
    group: OwnedGroup;
    secrets: NonNullable<OwnedGroup['runtimeSecrets']>;
  } {
    const scope = this.#runtimeSecretScope(fixture);
    if (
      fixture.concurrentIndex !== 0 ||
      (scope.secrets.forceDeleted && !afterDeletion)
    )
      throw new Error('Job runtime-secret file change is foreign or late');
    return scope;
  }

  async forceDeleteRuntimeSecret(fixture: CloudJobFixture): Promise<void> {
    const { group, secrets } = this.#runtimeSecretScope(fixture);
    if (fixture.concurrentIndex !== 0 || secrets.forceDeleted)
      throw new Error('Job runtime-secret deletion is foreign or repeated');
    // The API owner performs the force delete and exact-name absence readback.
    // CRUD/privacy and rejected missing/deleted-name admissions stay API-owned.
    await this.#dependencies.secrets.delete(secrets.names[0]);
    this.#runtimeSecretScope(fixture);
    secrets.forceDeleted = true;
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-runtime-secret-deleted`,
      {
        workloadId: fixture.ref.id,
        controller: group.controller,
        generation: 1,
        name: secrets.names[0],
        absent: true,
      },
    );
  }

  #runtimeSecretScope(fixture: CloudJobFixture): {
    group: OwnedGroup;
    secrets: NonNullable<OwnedGroup['runtimeSecrets']>;
  } {
    const group = this.#require(fixture);
    if (
      fixture.profile.member.kind !== 'runtime-secrets' ||
      !group.runtimeSecrets ||
      ![0, 1].includes(fixture.concurrentIndex)
    )
      throw new Error('Job has no original runtime-secret member');
    return { group, secrets: group.runtimeSecrets };
  }

  async runtime(
    fixture: CloudJobFixture,
  ): ReturnType<CloudJobTransport['runtime']> {
    const group = this.#require(fixture);
    const input = group.input;
    if (!input) throw new Error('Job runtime extension lacks its input bucket');
    const d = this.#dependencies;
    const readonly = await this.#guest(
      fixture,
      `if printf test > /mnt/input/readonly-test.txt; then exit 41; else test -r /mnt/input/molecules.json && printf READ_ONLY; fi`,
    );
    const key = `no-sync-${fixture.ref.id}.txt`;
    const file = await d.files.text(
      `job-${fixture.ref.id}/late-input.txt`,
      `late-${fixture.ref.id}`,
    );
    const storage = this.#storage(group);
    await storage.transfer(input, 'upload', [file, key], Date.now() + 90_000);
    await d.commands.wait(15_000, Date.now() + 20_000);
    const absent = await this.#guest(
      fixture,
      `test ! -e ${quote(`/mnt/input/${key}`)} && printf ABSENT`,
    );
    await storage.transfer(input, 'rm', [key], Date.now() + 90_000);
    const environment = await this.#guest(
      fixture,
      'printf %s "$ANYCLOUD_TEST_ENV"',
    );
    const follower = await d.remote.run(
      fixture.ref.id,
      'vm',
      'systemctl is-active docker-logs',
      { recordArtifact: false },
    );
    const gpus = await d.remote.run(
      fixture.ref.id,
      'vm',
      'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || true',
      { recordArtifact: false },
    );
    return {
      gpus: privateJobOutput(gpus)
        .split('\n')
        .filter((name) => name.trim()),
      inputReadOnly: privateJobOutput(readonly).trim() === 'READ_ONLY',
      lateInputAbsent: privateJobOutput(absent).trim() === 'ABSENT',
      environment: privateJobOutput(environment) === fixture.runLabel,
      logsFollower: privateJobOutput(follower).trim() === 'active',
    };
  }
  statusCheckpoint(
    fixture: CloudJobFixture,
  ): ReturnType<CloudJobTransport['statusCheckpoint']> {
    this.#require(fixture);
    return statusCheckpoint(this.#dependencies.cli, fixture.ref.id);
  }

  logsStopWithTheirReader(
    fixture: CloudJobFixture,
    pattern: string,
  ): ReturnType<CloudJobTransport['logsStopWithTheirReader']> {
    this.#require(fixture);
    return logsStopWithTheirReader(
      this.#dependencies.cli,
      fixture.ref.id,
      pattern,
    );
  }

  async completedByCli(
    fixture: CloudJobFixture,
  ): ReturnType<CloudJobTransport['completedByCli']> {
    this.#require(fixture);
    const facts = await completedJobByCli(
      this.#dependencies.cli,
      fixture.ref.id,
    );
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-cli-completion`,
      facts,
    );
    return facts;
  }

  async logs(
    fixture: CloudJobFixture,
    originalIp: string,
    deadlineAt: number,
  ): Promise<string | undefined> {
    const group = this.#require(fixture);
    if (!/^[a-zA-Z0-9.:-]+$/u.test(originalIp))
      throw new Error('Job persisted log IP is invalid');
    return this.#storage(group).readText(
      this.#bucket(group, 'output'),
      `.anycloud/logs/${fixture.ref.id}-${originalIp}.log`,
      deadlineAt,
    );
  }
  async writeConcurrent(fixture: CloudJobFixture): Promise<void> {
    this.#require(fixture);
    const write = fixture.concurrentWrites[fixture.concurrentIndex];
    if (!write)
      throw new Error('Concurrent Job has no original output assignment');
    privateJobOutput(
      await this.#guest(
        fixture,
        `mkdir -p ${quote(`/mnt/output/job-${fixture.concurrentIndex + 1}`)} && printf %s ${quote(write.contents)} > ${quote(`/mnt/output/${write.key}`)}`,
      ),
    );
  }
  async concurrentContents(
    fixture: CloudJobFixture,
    deadlineAt = Date.now() + 90_000,
  ): ReturnType<CloudJobTransport['concurrentContents']> {
    const group = this.#require(fixture);
    const output = this.#bucket(group, 'output');
    const storage = this.#storage(group);
    if ((await storage.observe(output, deadlineAt)).presence === 'absent')
      return fixture.concurrentWrites.map(() => undefined);
    const contents: (string | undefined)[] = [];
    for (const write of fixture.concurrentWrites)
      contents.push(await storage.readText(output, write.key, deadlineAt));
    return contents;
  }
  async evictionOutput(
    fixture: CloudJobFixture,
    deadlineAt: number,
  ): ReturnType<CloudJobTransport['evictionOutput']> {
    const group = this.#require(fixture);
    const output = this.#bucket(group, 'output');
    const storage = this.#storage(group);
    const payload = (
      await storage.entries(output, 'payload.bin', true, deadlineAt)
    ).find((entry) => entry.key === 'payload.bin');
    return {
      marker: await storage.readText(output, 'marker.txt', deadlineAt),
      payloadBytes: payload?.kind === 'object' ? payload.sizeBytes : undefined,
    };
  }
  syncCycle(): Promise<void> {
    return this.#dependencies.commands.wait(70_000, Date.now() + 75_000);
  }
  verificationRetry(): Promise<void> {
    return this.#dependencies.commands.wait(30_000, Date.now() + 35_000);
  }
  recoveryIdentity(
    ...[fixture, attempt]: Parameters<CloudJobTransport['recoveryIdentity']>
  ): ReturnType<CloudJobTransport['recoveryIdentity']> {
    if (attempt.ref !== fixture.ref)
      throw new Error('Job recovery attempt belongs to another Workload');
    const recovery = this.#require(fixture).recovery;
    if (!recovery)
      throw new Error('Job has no native in-place recovery capability');
    return recovery.identity(attempt, Date.now() + 60_000);
  }
  diskTier(
    ...[fixture, attempt]: Parameters<CloudJobTransport['diskTier']>
  ): ReturnType<CloudJobTransport['diskTier']> {
    const group = this.#require(fixture);
    if (
      (!fixture.diskTierCase && fixture.profile.diskIops === undefined) ||
      attempt.ref !== fixture.ref ||
      (fixture.diskTierCase &&
        attempt.vmType !== fixture.diskTierCase.vmType) ||
      !group.recovery
    )
      throw new Error(
        'Disk-tier observation lost its original Job, case or native owner',
      );
    return group.recovery.diskTier(attempt, Date.now() + 60_000);
  }
  stop(
    ...[fixture, attempt, identity]: Parameters<CloudJobTransport['stop']>
  ): Promise<void> {
    if (attempt.ref !== fixture.ref)
      throw new Error('Job fault attempt belongs to another Workload');
    const recovery = this.#require(fixture).recovery;
    if (!recovery)
      throw new Error('Job has no native in-place recovery capability');
    return recovery.stop(attempt, identity);
  }
  async injectGpuXid(
    fixture: CloudJobFixture,
    pci: string,
    code: number,
  ): ReturnType<CloudJobTransport['injectGpuXid']> {
    this.#require(fixture);
    const result = await this.#dependencies.remote.run(
      fixture.ref.id,
      'vm',
      gpuHealthFaultCommand(pci, code),
      { timeoutMs: 30_000 },
    );
    return {
      line: gpuHealthFaultLine(pci, code),
      journalConfirmed:
        result.exitCode === 0 &&
        result.stdout.includes(gpuHealthFaultNeedle(pci, code)),
    };
  }
  deleteHost(
    ...[fixture, attempt, identity]: Parameters<CloudJobTransport['deleteHost']>
  ): Promise<void> {
    if (
      attempt.ref !== fixture.ref ||
      !fixture.profile.requiredExtensions.includes('host-recovery')
    )
      throw new Error('Job deletion lacks its original host-recovery member');
    const recovery = this.#require(fixture).recovery;
    if (!recovery)
      throw new Error('Job has no native host-recovery capability');
    return recovery.deleteHost(attempt, identity);
  }
  async writeHostCheckpoint(fixture: CloudJobFixture): Promise<void> {
    this.#hostCheckpoint(fixture);
    privateJobOutput(
      await this.#guest(
        fixture,
        `printf %s ${quote(`checkpoint-${fixture.ref.id}`)} > /mnt/checkpoint/recovery-marker.txt`,
      ),
    );
  }
  async hostCheckpoint(
    fixture: CloudJobFixture,
    source: 'bucket' | 'container',
    deadlineAt: number,
  ): Promise<string | undefined> {
    const { group, bucket } = this.#hostCheckpoint(fixture);
    if (source === 'container')
      return privateJobOutput(
        await this.#guest(
          fixture,
          'cat /mnt/checkpoint/recovery-marker.txt',
          deadlineAt,
        ),
      );
    const storage = this.#storage(group);
    if ((await storage.observe(bucket, deadlineAt)).presence === 'absent')
      return undefined;
    return storage.readText(bucket, 'recovery-marker.txt', deadlineAt);
  }
  #hostCheckpoint(fixture: CloudJobFixture): {
    group: OwnedGroup;
    bucket: JobBucketRef;
  } {
    const group = this.#require(fixture);
    if (
      !fixture.profile.explicitCheckpoint ||
      !fixture.profile.requiredExtensions.includes('host-recovery')
    )
      throw new Error('Job has no explicit host-recovery checkpoint');
    return { group, bucket: this.#bucket(group, 'checkpoint') };
  }
  async submitAdmission(
    fixture: CloudJobFixture,
  ): Promise<'rejected' | 'accepted'> {
    const { admission, owner } = this.#admission(fixture);
    if (admission.started)
      throw new Error('Job admission submission is single use');
    admission.started = true;
    await owner.native.creationStarted(fixture.ref, {
      observeAdmissionRejection: true,
      ...(admission.admissionCase.outcome === 'invalid'
        ? { invalidRequest: admission.request }
        : {}),
    });
    try {
      const response = await owner.mutations.createWithApi(
        fixture.ref,
        admission.request,
      );
      if (response.id !== fixture.ref.id)
        throw new Error('Job admission acknowledged another Workload');
      admission.response = response;
      return 'accepted';
    } catch (error) {
      const rejection = declaredApiError(error);
      if (
        rejection?.code !== 'WORKLOAD_ADMISSION_REJECTED' ||
        rejection.status !== 400
      )
        throw error;
      try {
        await owner.native.recordAdmissionRejection(fixture.ref, error);
      } catch (observationError) {
        throw new AggregateError(
          [error, observationError],
          'Job admission rejection and its observation failed',
        );
      }
      admission.observation = Object.freeze({
        ref: fixture.ref,
        kind: 'rejected',
        message: rejection.message,
      });
      return 'rejected';
    }
  }

  async admissionStatus(fixture: CloudJobFixture): Promise<WorkloadState> {
    const { admission, owner } = this.#admission(fixture);
    if (!admission.response || admission.observation)
      throw new Error('Job admission status has no pending acknowledgement');
    const status = await owner.kernel.status(fixture.ref, true);
    owner.native.recordAdmissionStatus(fixture.ref.id, status);
    admission.status = structuredClone(status);
    return status.workload.state;
  }

  async admissionOutcome(
    fixture: CloudJobFixture,
  ): Promise<JobAdmissionObservation> {
    const { admission, owner } = this.#admission(fixture);
    if (admission.observation) return admission.observation;
    if (
      !admission.response ||
      admission.status?.workload.state !== WorkloadState.Invalid
    )
      throw new Error('Job admission has no acknowledged Invalid outcome');
    const metadata = admission.status.events.findLast(
      (event) => event.state === WorkloadState.Invalid,
    )?.metadata;
    if (!isRecord(metadata) || typeof metadata.message !== 'string')
      throw new Error('Job Invalid outcome has no exact guard message');
    await owner.native.recordAdmissionInvalid(fixture.ref, admission.response);
    admission.observation = Object.freeze({
      ref: fixture.ref,
      kind: 'invalid',
      message: metadata.message,
    });
    return admission.observation;
  }

  async releaseUncreated(
    fixture: CloudJobFixture,
    substrate: SubstrateAbsent,
  ): Promise<void> {
    const { group, admission, owner } = this.#admission(fixture);
    const child = this.#child(group, fixture.ref.id);
    if (
      admission.observation?.kind !== 'rejected' ||
      !child.nativeAbsent ||
      child.substrate !== substrate
    )
      throw new Error(
        'Job non-creation release lacks its original verification',
      );
    await owner.kernel.releaseUncreated(fixture.ref, substrate);
  }

  #admission(fixture: CloudJobFixture) {
    const group = this.#require(fixture);
    const admission = group.admissions?.get(fixture.ref);
    const owner = this.#dependencies.admission;
    if (
      !admission ||
      !owner ||
      admission.admissionCase !== fixture.admissionCase
    )
      throw new Error('Job admission fixture is foreign or unsupported');
    return { group, admission, owner };
  }

  async nativeAbsence(
    fixture: JobFixture,
    timeoutMs: number,
  ): Promise<SubstrateAbsent> {
    const group = this.#require(fixture);
    const child = this.#child(group, fixture.ref.id);
    if (group.admissions) {
      const owner = this.#dependencies.admission;
      if (!owner)
        throw new Error('Job admission lost its native cleanup owner');
      await owner.native.verify(fixture.ref, timeoutMs);
    } else await this.#dependencies.native.verify(fixture.ref, timeoutMs);
    child.nativeAbsent = true;
    child.substrate ??= this.#dependencies.kernel.recordSubstrateAbsence(
      fixture.ref,
    );
    return child.substrate;
  }
  async automaticCheckpointAbsence(fixture: JobFixture): Promise<void> {
    const group = this.#require(fixture);
    if (group.checkpoint)
      await this.#storage(group).requireAutomaticAbsence(
        group.checkpoint,
        60_000,
      );
  }
  async releaseResources(fixture: JobFixture): Promise<void> {
    const group = this.#require(fixture, false);
    const child = this.#child(group, fixture.ref.id);
    if (child.released || !child.nativeAbsent)
      throw new Error(
        'Job resource release is repeated or precedes native absence',
      );
    child.released = true;
    if ([...group.children.values()].every((candidate) => candidate.released)) {
      const deadlineAt = Date.now() + group.cleanupMs;
      await group.hydration?.finish(deadlineAt);
      for (const spot of group.spot?.values() ?? [])
        await spot.release(deadlineAt);
      if (!group.admissions && fixture.profile.storageProvider !== 'none')
        await this.#storage(group).release(deadlineAt);
      if (group.runtimeSecrets)
        for (const name of group.runtimeSecrets.names) {
          assertJobController(this.#dependencies.api, group.controller);
          await this.#dependencies.secrets.delete(name);
          assertJobController(this.#dependencies.api, group.controller);
        }
      for (const authorization of [...group.authorizations].reverse())
        await authorization.owner.release(authorization.binding, deadlineAt);
      group.released = true;
    }
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-resources-released`,
      {
        workloadId: fixture.ref.id,
        controller: group.controller,
        generation: 1,
        startedAt: group.startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - group.startedAt,
        groupResourcesReleased: group.released,
        children: [...group.children].map(([id, state]) => ({
          id,
          nativeAbsent: state.nativeAbsent,
          released: state.released,
        })),
      },
    );
  }

  async #apiOwner(group: OwnedGroup, deadlineAt: number): Promise<string> {
    assertJobController(this.#dependencies.api, group.controller);
    const rows = await this.#dependencies.database.queryComplete(
      "SELECT value FROM _metadata WHERE key = 'api_identity'",
      'job-storage-api-owner',
      deadlineAt,
    );
    assertJobController(this.#dependencies.api, group.controller);
    if (
      rows.length !== 1 ||
      Object.keys(rows[0]).length !== 1 ||
      typeof rows[0].value !== 'string' ||
      !/^(?:v1:)?[a-f0-9]{32}$/u.test(rows[0].value)
    )
      throw new Error('Job storage has no exact API ownership identity');
    return rows[0].value.replace(/^v1:/u, '');
  }
  async #credentialBinding(
    fixture: CloudJobFixture,
    group: OwnedGroup,
    deadlineAt: number,
  ): Promise<void> {
    this.#require(fixture);
    const rows = await this.#dependencies.database.queryComplete(
      `SELECT c.id, c.name FROM workloads w JOIN credentials c ON c.id = w.credential_id WHERE w.id = '${escapedSql(fixture.ref.id)}'`,
      `job-${fixture.ref.id}-credential-binding`,
      deadlineAt,
    );
    this.#require(fixture);
    const original = group.authorizations[0].binding;
    if (
      rows.length !== 1 ||
      Object.keys(rows[0]).length !== 2 ||
      rows[0].id !== original.recordId ||
      rows[0].name !== original.name
    )
      throw new Error(
        'Job submission did not use its original named credential',
      );
    await this.#dependencies.artifacts.json(
      `job-${fixture.ref.id}-credential-binding`,
      {
        workloadId: fixture.ref.id,
        generation: 1,
        controller: group.controller,
        credential: original,
      },
    );
  }
  #guest(
    fixture: CloudJobFixture,
    command: string,
    deadlineAt = Date.now() + 90_000,
  ): Promise<CommandResult> {
    this.#require(fixture);
    return this.#dependencies.remote.run(
      fixture.ref.id,
      'vm',
      `docker exec ${quote(fixture.ref.id)} sh -c ${quote(command)}`,
      {
        recordArtifact: false,
        timeoutMs: jobOperationTimeout(deadlineAt, 90_000),
      },
    );
  }
  #require(fixture: JobFixture, active = true): OwnedGroup {
    const group = this.#owned.get(fixture);
    if (!group || group.released)
      throw new Error('Cloud Job fixture is foreign, copied or released');
    assertJobController(this.#dependencies.api, group.controller);
    assertJobController(this.#dependencies.cleanupApi, group.controller);
    if (active) this.#dependencies.kernel.assertActive(fixture.ref);
    return group;
  }
  #storage(group: OwnedGroup): JobCloudStorage {
    if (!group.storage)
      throw new Error('Job storage owner has not been prepared');
    return group.storage;
  }
  #bucket(group: OwnedGroup, role: 'output' | 'checkpoint'): JobBucketRef {
    const bucket = group[role];
    if (!bucket) throw new Error(`Job has no ${role} bucket registration`);
    return bucket;
  }
  #child(group: OwnedGroup, id: string): OwnedChild {
    const child = group.children.get(id);
    if (!child) throw new Error('Job child belongs to another group');
    return child;
  }
}
