import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageJson from '../../../../package.json' with { type: 'json' };

import { ApiClient } from './api.js';
import { ApiAuthScenarios, type ApiAuthResult } from './api-auth.js';
import {
  BucketAccessDeniedScenario,
  type BucketAccessDeniedResult,
  type DeniedBucketProvider,
} from './bucket-access-denied.js';
import { ArtifactStore, Redactor, safeName } from './artifacts.js';
import { CleanupStack } from './cleanup.js';
import { CliClient, type CliRunOptions } from './cli.js';
import { vmReadyByCli } from './cli-observations.js';
import { ControllerEndpoint } from './controller-session.js';
import {
  ClusterCloudContract,
  type ClusterCloudContractResult,
} from './contracts/cluster-cloud.js';
import {
  ClusterLocalContract,
  type ClusterLocalContractResult,
} from './contracts/cluster-local.js';
import { CloudClusterEnvironment } from './substrates/cloud-cluster/environment.js';
import {
  RoleConnectionChecks,
  ROLE_CHECKS,
} from './contracts/role-connections.js';
import { CloudRoleConnections } from './substrates/cloud-cluster/role-connections.js';
import { AZURE_ROLE_REGION } from './substrates/cloud-cluster/role-trusts.js';
import {
  HostedApiStage,
  assertHostedStageConfiguration,
} from './substrates/cloud-cluster/hosted-stage.js';
import {
  clusterCloudConfiguration,
  roleCheckPolicy,
} from './substrates/cloud-cluster/configuration.js';
import { ClusterLocalEnvironment } from './substrates/local-cluster/environment.js';
import { PersistentVmHostLossContract } from './contracts/persistent-vm-host-loss.js';
import {
  StorageTokensContract,
  type StorageTokensContractResult,
  type StorageTokenTarget,
} from './contracts/storage-tokens.js';
import { StorageTokensTransport } from './transports/storage-tokens.js';
import { persistentVmContractPolicy } from './contracts/persistent-vm-policy.js';
import { PersistentVmContract } from './contracts/persistent-vm.js';
import { ServeBaselineContract } from './contracts/serve-baseline.js';
import { ServeLocalRecoveryContract } from './contracts/serve-local-recovery.js';
import { ServeUpgradeContract } from './contracts/serve-upgrade.js';
import { DedicatedJobContract } from './contracts/dedicated-job.js';
import { JobAttemptLedger } from './job-attempt-ledger.js';
import { JobNativeCleanup } from './job-native-cleanup.js';
import { LocalSmolvmJobAdapter } from './targets/local-smolvm-job.js';
import { LocalSmolvmJobTransport } from './transports/local-smolvm-job.js';
import { PublicCloudJobAdapter } from './targets/public-cloud-job.js';
import { PublicCloudJobTransport } from './transports/public-cloud-job.js';
import { JobPrivateCommands } from './transports/job-command.js';
import type {
  DeliveredJobMember,
  JobContractResult,
} from './targets/job-types.js';
import { CredentialManager } from './credentials.js';
import {
  WorkloadMutationTransport,
  trackedCliMutations,
  optionValue,
} from './workload-mutations.js';
import { FailureDiagnostics } from './diagnostics.js';
import { TrackedWorkloadKernel, type TrackedWorkloadRef } from './workloads.js';
import { Environment } from './environment.js';
import { FixtureFiles } from './files.js';
import {
  HostIdentityHarness,
  OpenSshHostIdentityTransport,
} from './host-identity.js';
import {
  kubernetesE2EServeImage,
  kubernetesE2EServePort,
} from './kubernetes-constants.js';
import { FixtureNames, RUN_ID_LENGTH } from './names.js';
import { submitPersistentVm } from './persistent-vm-submission.js';
import { PersistentVmCleanup } from './persistent-vm-cleanup.js';
import { CliDatabase } from './database.js';
import { EnvironmentProbeFixture } from './probes/environment.js';
import { NamedSecretProbeFixture } from './probes/named-secret.js';
import { ProcessRunner } from './process.js';
import {
  ProviderProfiles,
  type VmProfile,
  type VmProvider,
} from './profiles.js';
import { RemoteExecutor } from './remote.js';
import { SecretManager } from './secrets.js';
import { ServiceCleanup } from './service-cleanup.js';
import { LocalSmolvmPersistentVmAdapter } from './targets/local-smolvm.js';
import { PersistentVmTargetFactory } from './targets/persistent-vm.js';
import { PublicCloudPersistentVmAdapter } from './targets/public-cloud-vm.js';
import { LocalSmolvmServeAdapter } from './targets/local-smolvm-serve.js';
import { PublicCloudServeAdapter } from './targets/public-cloud-serve.js';
import { ServeTargetFactory } from './targets/serve.js';
import type {
  GpuServeContractResult,
  PublicCloudServeProfile,
  ServeContractResult,
  ServeLocalRecoveryContractResult,
  ServeUpgradeContractResult,
} from './targets/serve-types.js';
import type {
  PersistentVmContractResult,
  PersistentVmHostLossContractResult,
  PersistentVmTarget,
} from './targets/persistent-vm-types.js';
import {
  errorMessage,
  type CloudCredentialInput,
  type CommandResult,
} from './types.js';
import { TargetHttpClient } from './transports/http.js';
import { LocalSmolvmPersistentVmTransport } from './transports/local-smolvm.js';
import { LocalApiRestarter } from './transports/local-api-restart.js';
import { ServiceUpgradeRecoveryProbe } from './probes/serve-upgrade-recovery.js';
import { LocalSmolvmServeTransport } from './transports/local-smolvm-serve.js';
import { PublicCloudServeTransportFactory } from './transports/public-cloud-serve.js';
import {
  ServiceDnsProbe,
  ServiceDnsTransport,
} from './transports/service-dns.js';
import { PublicCloudPersistentVmTransportFactory } from './transports/public-cloud-vm.js';
import { PublicCloudVmHostPresenceProbeFactory } from './transports/public-cloud-vm-host-presence.js';
import { VmHarness } from './vm.js';
import { VmLedgerProbe } from './vm-ledger.js';
import { StageProgress } from './progress.js';
import { Waiter } from './wait.js';
import {
  ReadModelProofs,
  type BillingSettlementResult,
  type LongHistoryResult,
} from './read-models/owner.js';
import { getLoopbackApiPort } from '../../../../src/shared/config.js';

export type CommandShimBehavior =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'hang'; readonly milliseconds: number };

export interface E2EWorld {
  readonly runId: string;
  readonly readModels: {
    billingSettlement(): Promise<BillingSettlementResult>;
    longHistory(): Promise<LongHistoryResult>;
  };
  readonly apiAuth: {
    accessPolicy(): Promise<ApiAuthResult>;
    secretCrudPrivacy(): Promise<ApiAuthResult>;
  };
  readonly bucketAccess: {
    denied(provider: DeniedBucketProvider): Promise<BucketAccessDeniedResult>;
  };
  readonly contracts: {
    dedicatedJob(member: DeliveredJobMember): Promise<JobContractResult>;
    clusterCloud(): Promise<Omit<ClusterCloudContractResult, 'records'>>;
    clusterLocal(
      target: 'e2e-cluster-local',
    ): Promise<Omit<ClusterLocalContractResult, 'records'>>;
    persistentVm(
      target: PersistentVmTarget,
    ): Promise<PersistentVmContractResult>;
    persistentVmHostLoss(
      target: PersistentVmTarget,
    ): Promise<PersistentVmHostLossContractResult>;
    serve(target: VmProvider): Promise<ServeContractResult>;
    gpuServe(target: VmProvider): Promise<GpuServeContractResult>;
    serveLocalRecovery(
      target: 'local-smolvm',
    ): Promise<ServeLocalRecoveryContractResult>;
    serveUpgrade(target: VmProvider): Promise<ServeUpgradeContractResult>;
    storageTokens(
      target: StorageTokenTarget,
    ): Promise<StorageTokensContractResult>;
  };
  readonly api: {
    saveCredential(
      name: string,
      credential: CloudCredentialInput,
    ): Promise<void>;
  };
  readonly cli: {
    run(
      args: readonly string[],
      options?: CliRunOptions,
    ): Promise<CommandResult>;
    runWithTransientRetries(
      args: readonly string[],
      options?: CliRunOptions,
    ): Promise<CommandResult>;
  };
  readonly workloadFacts: {
    provisioningRecordCounts(id: string): Promise<{
      readonly workloadRows: number;
      readonly vmRows: number;
    }>;
    liveVmCount(id: string): Promise<number>;
  };
  readonly env: {
    optional(name: string, fallback?: string): string;
  };
  readonly files: {
    directory(name: string): Promise<string>;
    commandShim(
      directoryName: string,
      executableName: string,
      behavior: CommandShimBehavior,
    ): Promise<string>;
  };
  readonly names: Pick<FixtureNames, 'workload' | 'secret'>;
}

export interface E2ELifecycle {
  readonly e2e: E2EWorld;
  /**
   * Writes the fixture's triage record and, when the test failed, the
   * diagnostics behind it. Always runs, so a missing record means the fixture
   * never finalized rather than that the test passed.
   */
  recordOutcome(errors: readonly unknown[]): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateE2EOptions {
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly testName: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

function validateShim(behavior: CommandShimBehavior): string {
  if (behavior.kind === 'exit') {
    if (
      !Number.isSafeInteger(behavior.code) ||
      behavior.code < 0 ||
      behavior.code > 255
    ) {
      throw new Error('Shim exit code must be an integer from 0 through 255');
    }
    return `#!/bin/sh\nexit ${behavior.code}\n`;
  }
  if (
    !Number.isSafeInteger(behavior.milliseconds) ||
    behavior.milliseconds <= 0 ||
    behavior.milliseconds > 300_000
  ) {
    throw new Error('Shim hang duration must be between 1 and 300000ms');
  }
  return `#!/bin/sh\nexec sleep ${Math.ceil(behavior.milliseconds / 1_000)}\n`;
}

function safeAllocatorValidation(args: readonly string[]): boolean {
  if (args.includes('--help') || args.includes('-h') || args.length === 1) {
    return true;
  }
  return (
    args[0] === 'job' &&
    !args.includes('--vm-type') &&
    !args.includes('--gpu-type')
  );
}

function safeDirectCliReadOrValidation(args: readonly string[]): boolean {
  const [command, subcommand] = args;
  if (command === 'list' || command === 'status' || command === 'wait') {
    return true;
  }
  if ((command === 'config' || command === 'worker') && args.length === 1)
    return true;
  if (command === 'terminate' && args.length === 1) return true;
  return (
    command === 'credentials' &&
    subcommand === 'new' &&
    args.length === 3 &&
    typeof args[2] === 'string' &&
    !args[2].startsWith('-')
  );
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function flattenedErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  const children: unknown = error.errors;
  return Array.isArray(children)
    ? children.map((child: unknown) => child)
    : [error];
}

async function captureEveryDiagnostic(
  actions: readonly (() => Promise<void>)[],
): Promise<void> {
  const results = await Promise.allSettled(actions.map((action) => action()));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? flattenedErrors(result.reason) : [],
  );
  if (failures.length === 1) {
    throw asError(failures[0], 'E2E diagnostics failed');
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'E2E diagnostics failed');
  }
}

export async function finalizeE2ELifecycle(
  lifecycle: E2ELifecycle,
  primaryErrors: readonly unknown[],
): Promise<void> {
  const secondaryErrors: unknown[] = [];
  try {
    await lifecycle.recordOutcome(primaryErrors);
  } catch (error) {
    secondaryErrors.push(...flattenedErrors(error));
  }
  try {
    await lifecycle.dispose();
  } catch (error) {
    secondaryErrors.push(...flattenedErrors(error));
  }

  if (primaryErrors.length > 0 && secondaryErrors.length > 0) {
    throw new AggregateError(
      [...primaryErrors, ...secondaryErrors],
      'E2E test failed and its diagnostics or cleanup also failed',
    );
  }
  if (primaryErrors.length === 0 && secondaryErrors.length === 1) {
    throw secondaryErrors[0];
  }
  if (primaryErrors.length === 0 && secondaryErrors.length > 1) {
    throw new AggregateError(secondaryErrors, 'E2E teardown failed');
  }
}

interface DirectCliDependencies {
  readonly cli: CliClient;
  readonly directRefs: Map<string, TrackedWorkloadRef>;
  readonly kernel: TrackedWorkloadKernel;
  readonly mutations: WorkloadMutationTransport;
}

async function runDirectCli(
  args: readonly string[],
  options: CliRunOptions | undefined,
  dependencies: DirectCliDependencies,
  transientRetries: boolean,
): Promise<CommandResult> {
  const [command, subcommand] = args;
  const rawRun = (): Promise<CommandResult> =>
    transientRetries
      ? dependencies.cli.runWithTransientRetries(args, options)
      : dependencies.cli.run(args, options);
  if (!command || args.includes('--help') || args.includes('-h')) {
    return rawRun();
  }

  if (command === 'service' && subcommand === 'upgrade') {
    const id = args[2];
    if (!id) return rawRun();
    const ref =
      dependencies.kernel.activeReference(id) ??
      (await dependencies.kernel.reserve(id, 600_000));
    dependencies.directRefs.set(id, ref);
    if (transientRetries) {
      throw new Error(
        'Direct service upgrades do not use the create-retry transport',
      );
    }
    return dependencies.mutations.runCliUpgrade(ref, args, options);
  }

  if (['job', 'service', 'vm'].includes(command)) {
    const id = optionValue(args, '--id');
    if (!id) {
      if (safeAllocatorValidation(args)) return rawRun();
      throw new Error(
        `${command} E2E commands require an explicit --id so the automatic fixture can register cleanup`,
      );
    }
    const ref = await dependencies.kernel.reserve(id, 600_000);
    dependencies.directRefs.set(id, ref);
    return transientRetries
      ? dependencies.mutations.runCliCreateWithTransientRetries(
          ref,
          args,
          options,
        )
      : dependencies.mutations.runCliCreate(ref, args, options);
  }

  if (command === 'resubmit') {
    const id = args[1];
    if (!id) return rawRun();
    const ref =
      dependencies.kernel.activeReference(id) ??
      (await dependencies.kernel.reserve(id, 600_000));
    dependencies.directRefs.set(id, ref);
    if (transientRetries) {
      throw new Error('Direct resubmits do not use the create-retry transport');
    }
    return dependencies.mutations.runCliResubmit(ref, args, options);
  }

  if (command === 'terminate' && args[1]) {
    throw new Error(
      'Direct E2E termination requires a named fixture operation or behavioral contract',
    );
  }

  if (safeDirectCliReadOrValidation(args)) return rawRun();
  throw new Error(
    `Direct CLI command "${command} ${subcommand ?? ''}" is not an explicitly safe read or validation path; resource mutations need a named fixture capability with automatic cleanup`,
  );
}

/**
 * The token `api start` wrote for the installer in `apiDirectory`. A
 * from_release run's installer may predate it (G0, 0.1.68) and take the
 * GitHub sign-in, `preTokenBearer`, until `api upgrade` writes the token.
 */
export function readInstallerToken(
  apiDirectory: string,
  preTokenBearer?: string,
): string {
  const file = path.join(apiDirectory, 'local-api-token');
  let value: string;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (missing && preTokenBearer) return preTokenBearer;
    throw new Error(
      `Cannot read the local API token at ${file}: ${(error as Error).message}`,
    );
  }
  if (!value) throw new Error(`The local API token at ${file} is empty`);
  return value;
}

export async function createE2ELifecycle(
  options: CreateE2EOptions,
): Promise<E2ELifecycle> {
  const sourceEnvironment = options.environment ?? process.env;
  const runId = randomUUID().replaceAll('-', '').slice(0, RUN_ID_LENGTH);
  const redactor = new Redactor();
  const environment = new Environment(sourceEnvironment, redactor);
  const candidateBinary =
    environment.optional('E2E_CANDIDATE_CLI') || undefined;
  const teardownTimeoutMs = environment.milliseconds(
    'E2E_TEARDOWN_TIMEOUT_SECONDS',
    3_600,
  );
  // Only a run that supplies GITHUB_TOKEN signs the CLI in to GitHub; every
  // other run proves a local API needs no GitHub sign-in.
  const githubToken = environment.optionalSecret('GITHUB_TOKEN');
  const token = githubToken ?? 'dummy-token-for-test';
  // The local API e2e.sh started reads the token `api start` wrote in its
  // ANYCLOUD_DIR. The harness presents it, and its CLI reads a copy, as a
  // user's CLI on that machine would. Both are read when used, since an
  // `api upgrade` replaces the API that wrote it.
  const apiDirectory = environment.optional('ANYCLOUD_DIR') || undefined;
  const localApiToken = (): string => {
    // No `api start` here: the controller is an in-process API (the local
    // cluster lane's) that authenticates the GitHub stub, which takes this.
    if (!apiDirectory) return 'in-process-api';
    const value = readInstallerToken(
      apiDirectory,
      environment.optional('E2E_CLUSTER_FROM_RELEASE') ? token : undefined,
    );
    redactor.add(value);
    return value;
  };
  const bearerFor = (url: string): string =>
    getLoopbackApiPort(url) === undefined ? token : localApiToken();
  const apiUrl = environment.optional('API_URL') || undefined;
  const manifestDirectory = environment.optional('RESULTS_DIR') || undefined;
  const workspace = await mkdtemp(path.join(tmpdir(), 'anycloud-e2e-'));
  const anycloudDirectory = path.join(workspace, 'anycloud');

  const artifactBase =
    sourceEnvironment.E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), 'anycloud-e2e-artifacts');
  const artifactDirectory = path.join(
    artifactBase,
    `${safeName(options.testName)}-${runId}`,
  );
  const artifacts = new ArtifactStore(artifactDirectory, redactor);
  try {
    await mkdir(anycloudDirectory, { recursive: true });
    await artifacts.initialize({
      testName: options.testName,
      runId,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    await rm(workspace, { force: true, recursive: true }).catch(
      () => undefined,
    );
    throw error;
  }

  const progress = new StageProgress();
  const cleanup = new CleanupStack((message) => progress.mark(message));
  const cleanupController = new AbortController();
  const files = new FixtureFiles(workspace);
  const waiter = new Waiter(options.signal);
  const cleanupWaiter = new Waiter(cleanupController.signal);
  const serviceDns = new ServiceDnsProbe(
    new ServiceDnsTransport(cleanupController.signal),
  );
  const runner = new ProcessRunner(
    artifacts,
    options.signal,
    options.projectRoot,
  );
  const cleanupRunner = new ProcessRunner(
    artifacts,
    cleanupController.signal,
    options.projectRoot,
  );
  const controllerEndpoint = new ControllerEndpoint(apiUrl);
  const cli = new CliClient(
    runner,
    options.projectRoot,
    anycloudDirectory,
    controllerEndpoint,
    githubToken,
    options.signal,
    candidateBinary,
    localApiToken,
  );
  const cleanupCli = new CliClient(
    cleanupRunner,
    options.projectRoot,
    anycloudDirectory,
    controllerEndpoint,
    githubToken,
    cleanupController.signal,
    candidateBinary,
    localApiToken,
  );
  const api = new ApiClient(
    controllerEndpoint,
    bearerFor,
    artifacts,
    redactor,
    options.signal,
  );
  const cleanupApi = new ApiClient(
    controllerEndpoint,
    bearerFor,
    artifacts,
    redactor,
    cleanupController.signal,
    'cleanup-api',
  );
  const kernel = new TrackedWorkloadKernel(
    api,
    cli,
    cleanup,
    waiter,
    manifestDirectory,
    { api: cleanupApi, cli: cleanupCli, wait: cleanupWaiter },
  );
  const credentials = new CredentialManager(api);
  const mutations = new WorkloadMutationTransport(kernel, api, cli);
  // Contract families get the strict surface; only the direct-spec path below
  // keeps raw command results, because asserting on them is its whole purpose.
  const trackedMutations = trackedCliMutations(mutations);
  const vmLedger = new VmLedgerProbe(cli, kernel);
  const directRefs = new Map<string, TrackedWorkloadRef>();
  const remote = new RemoteExecutor(api, files, runner, redactor);
  const cleanupRemote = new RemoteExecutor(
    cleanupApi,
    files,
    cleanupRunner,
    redactor,
  );
  const diagnostics = new FailureDiagnostics({
    api: cleanupApi,
    artifacts,
    kernel,
    remote: cleanupRemote,
    runId,
    testName: options.testName,
  });
  const secrets = new SecretManager(api, cleanup, cleanupApi);
  const vm = new VmHarness(remote, waiter);
  const hostIdentity = new HostIdentityHarness(
    new OpenSshHostIdentityTransport(runner),
    waiter,
    artifacts,
  );
  const providers = new ProviderProfiles(environment);
  const names = new FixtureNames(runId);
  const targetHttp = new TargetHttpClient(artifacts, redactor, options.signal);
  const apiFixtureRuntime = {
    artifacts,
    cleanup,
    cleanupRunner,
    cleanupSignal: cleanupController.signal,
    files,
    http: targetHttp,
    projectRoot: options.projectRoot,
    redactor,
    runner,
    signal: options.signal,
  };
  const apiAuth = new ApiAuthScenarios(
    apiFixtureRuntime,
    names,
    packageJson.version,
  );
  const bucketAccess = new BucketAccessDeniedScenario({
    api,
    cli,
    runner,
    cleanup,
    files,
    profiles: providers,
    runId,
    bearer: bearerFor,
  });
  // Local cluster member: the substrate starts only when the contract runs,
  // so every other member keeps its zero-cost startup; the cleanup stack
  // still owns the K3s cluster and the API child.
  const clusterLocalEnvironment = new ClusterLocalEnvironment({
    api,
    artifacts,
    cleanup,
    endpoint: controllerEndpoint,
    projectRoot: options.projectRoot,
    redactor,
    runId,
    stateRoot: path.join(workspace, 'e2e-cluster-local'),
    wait: waiter,
  });
  const sha256 = (value: string): string =>
    createHash('sha256').update(value).digest('hex');
  const clusterLocal = new ClusterLocalContract({
    progress,
    cluster: {
      prepare: () => clusterLocalEnvironment.prepare(),
      registered: () => clusterLocalEnvironment.recordedCluster(),
      intact: () => clusterLocalEnvironment.clusterIntact(),
      replaceController: () => clusterLocalEnvironment.replaceController(),
      hostedChartRepair: () => clusterLocalEnvironment.hostedChartRepair(),
    },
  });
  // The cluster member reads cloud secrets, so it is composed only when run.
  const clusterCloud = (): ClusterCloudContract => {
    const {
      clusterProvider,
      clusterRegion,
      managementVmType,
      vmType,
      hostedStage,
      fromRelease,
      deadApiDelete,
      restoreStage,
      liveChecks,
    } = clusterCloudConfiguration((name) => environment.optional(name));
    const clusterProfile = providers.vm(clusterProvider);
    // `from_release`: the workflow installs that release's CLI, and e2e.sh
    // starts the installer (data in its ANYCLOUD_DIR) with it.
    const released = fromRelease
      ? {
          version: fromRelease,
          installerDirectory: environment.required('ANYCLOUD_DIR'),
          cli: new CliClient(
            runner,
            options.projectRoot,
            anycloudDirectory,
            controllerEndpoint,
            githubToken,
            options.signal,
            environment.required('E2E_CLUSTER_FROM_RELEASE_CLI'),
            localApiToken,
          ),
        }
      : undefined;
    const cloudCluster = new CloudClusterEnvironment({
      artifacts,
      cleanup,
      cli,
      ...(released ? { fromRelease: released } : {}),
      database: new CliDatabase(cli),
      installerDirectory: environment.optional('ANYCLOUD_DIR') || undefined,
      http: targetHttp,
      profile: clusterProfile,
      region: clusterRegion,
      managementVmType,
      runId,
      runner,
      wait: waiter,
      dns: { token },
    });
    // The hosted journeys drive the API on the cluster itself; the release
    // journey's first release is the alternate image (`b`, built by the
    // workflow from this tree).
    const journey = assertHostedStageConfiguration({
      hostedStage,
      alternateImage: environment.optional('E2E_CLUSTER_ALTERNATE_IMAGE'),
    });
    const hostedApi = new HostedApiStage(
      {
        artifacts,
        cleanup,
        cli,
        runner,
        http: targetHttp,
        dns: serviceDns,
        wait: waiter,
        names,
        redactor,
        token,
        ...(released ? { fromRelease: { cli: released.cli } } : {}),
        credential: {
          name: clusterProfile.credentialName,
          material: clusterProfile.credential,
        },
        vm: { region: clusterRegion, vmType },
        service: {
          image: kubernetesE2EServeImage,
          port: kubernetesE2EServePort,
        },
        timeouts: {
          workloadMs: 600_000,
          releaseMs: 900_000,
          recursionMs: 1_500_000,
        },
      },
      {
        url: () => cloudCluster.hostedUrl,
        // Read by the release journey, which runs on an AWS management VM.
        backupVersions: async () => {
          const versions = await cloudCluster.backupObjectVersions();
          if (versions === null) {
            throw new Error('backup versions are read on AWS only');
          }
          return versions;
        },
        bucket: () => cloudCluster.bucket,
        upgradeRequested: () => cloudCluster.noteHostedUpgrade(),
      },
    );
    const checks = liveChecks.length
      ? {
          selected: liveChecks,
          ...(liveChecks.some((check) =>
            (ROLE_CHECKS as readonly string[]).includes(check),
          )
            ? {
                roles: new RoleConnectionChecks({
                  port: new CloudRoleConnections({
                    hosted: hostedApi,
                    hostedUrl: () => cloudCluster.hostedUrl,
                    cli,
                    issuer: () => cloudCluster.serviceAccountIssuer(),
                    kubeConfig: () => cloudCluster.hostedKubeConfig(),
                    credentials: {
                      aws: providers.vm('aws').credential,
                      gcp: providers.vm('gcp').credential,
                      azure: providers.vm('azure').credential,
                    },
                    regions: {
                      aws:
                        clusterProvider === 'aws' ? clusterRegion : 'us-east-2',
                      gcp: 'us-central1',
                      azure: AZURE_ROLE_REGION,
                    },
                    runner,
                    artifacts,
                    cleanup,
                    wait: waiter,
                    workloadMs: 600_000,
                  }),
                  policy: roleCheckPolicy(
                    runId,
                    environment.optional('E2E_ROLE_GCP_RETIRE', 'record'),
                  ),
                  wait: waiter,
                  progress,
                  clock: { now: () => Date.now() },
                }),
              }
            : {}),
        }
      : undefined;
    return new ClusterCloudContract({
      cliVersion: packageJson.version,
      ...(fromRelease ? { fromRelease } : {}),
      ...(checks ? { checks } : {}),
      progress,
      hosted: { ...journey, stage: hostedApi },
      policy: {
        bootstrapTimeoutMs: 2_400_000,
        destroyTimeoutMs: 900_000,
        keepOnFailure:
          environment.optional('E2E_CLUSTER_KEEP_ON_FAILURE', 'false') ===
          'true',
        deadApiDelete,
        restoreStage,
      },
      substrate: cloudCluster,
    });
  };
  const localTarget = new LocalSmolvmPersistentVmAdapter(
    new LocalSmolvmPersistentVmTransport(artifacts, targetHttp),
  );
  const publicTransports = new PublicCloudPersistentVmTransportFactory(
    artifacts,
    files,
    targetHttp,
    runner,
  );
  let targets: PersistentVmTargetFactory;
  try {
    targets = new PersistentVmTargetFactory(localTarget, {
      create: (provider) => {
        const profile = providers.vm(provider);
        return new PublicCloudPersistentVmAdapter(
          {
            credentialName: profile.credentialName,
            provider: profile.provider,
            target: profile.slug,
          },
          publicTransports.create(profile),
        );
      },
    });
  } catch (error) {
    await rm(workspace, { force: true, recursive: true }).catch(
      () => undefined,
    );
    throw error;
  }
  const cleanupHttp = new TargetHttpClient(
    artifacts,
    redactor,
    cleanupController.signal,
    'cleanup-target',
  );
  const cleanupHostPresence = new PublicCloudVmHostPresenceProbeFactory(
    cleanupRunner,
    files,
    cleanupHttp,
    artifacts,
  );
  const nativeVmCleanup = new PersistentVmCleanup({
    kernel,
    endpoint: controllerEndpoint,
    database: new CliDatabase(cleanupCli),
    profiles: providers,
    hosts: cleanupHostPresence,
    http: cleanupHttp,
    wait: cleanupWaiter,
    artifacts,
    signal: cleanupController.signal,
  });
  const captureNativeMutation = async (
    ref: TrackedWorkloadRef,
    mutation: () => Promise<unknown>,
  ): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await mutation();
    } catch (error) {
      failures.push(error);
    }
    try {
      await nativeVmCleanup.capture(ref);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'Workload mutation and native identity capture failed',
      );
  };
  const nativeTrackedMutations = {
    runCliCreateWithTransientRetries: async (
      ...args: Parameters<
        typeof trackedMutations.runCliCreateWithTransientRetries
      >
    ): Promise<void> => {
      await nativeVmCleanup.creationStarted(args[0]);
      await captureNativeMutation(args[0], () =>
        trackedMutations.runCliCreateWithTransientRetries(...args),
      );
    },
    runCliUpgrade: async (
      ...args: Parameters<typeof trackedMutations.runCliUpgrade>
    ): Promise<void> => {
      await captureNativeMutation(args[0], () =>
        trackedMutations.runCliUpgrade(...args),
      );
    },
  };
  const jobNativeCleanup = new JobNativeCleanup({
    kernel,
    ledger: new JobAttemptLedger({
      api: cleanupApi,
      kernel,
      database: new CliDatabase(cleanupCli),
    }),
    wait: cleanupWaiter,
    artifacts,
  });
  const dedicatedJob = new DedicatedJobContract({
    now: Date.now,
    artifacts,
    environment,
    names,
    kernel,
    wait: waiter,
    vmLedger,
    cloud: new PublicCloudJobAdapter(
      new PublicCloudJobTransport({
        privateRepoToken: environment.optionalSecret('E2E_PRIVATE_REPO_TOKEN'),
        maceObserver: { runner, bearer: bearerFor },
        cleanupRemote,
        admission: { native: nativeVmCleanup, mutations, kernel },
        api,
        cleanupApi,
        apiRestarter: new LocalApiRestarter({
          artifacts,
          commands: runner,
          endpoint: controllerEndpoint,
          http: targetHttp,
        }),
        cleanupHttp,
        database: new CliDatabase(cli),
        cleanupDatabase: new CliDatabase(cleanupCli),
        commands: new JobPrivateCommands(runner, options.signal),
        cleanupCommands: new JobPrivateCommands(
          cleanupRunner,
          cleanupController.signal,
        ),
        cli,
        cleanupCli,
        profiles: providers,
        files,
        cleanup,
        artifacts,
        redactor,
        kernel,
        native: jobNativeCleanup,
        mutations,
        remote,
        secrets,
        wait: waiter,
        cleanupWait: cleanupWaiter,
        vmLedger,
        http: targetHttp,
        cleanupSignal: cleanupController.signal,
        hosts: new PublicCloudVmHostPresenceProbeFactory(
          cleanupRunner,
          files,
          cleanupHttp,
          artifacts,
        ),
      }),
    ),
    target: new LocalSmolvmJobAdapter(
      new LocalSmolvmJobTransport({
        api,
        kernel,
        native: jobNativeCleanup,
        mutations,
        cli,
        remote,
        files,
        secrets,
        cleanup,
        artifacts,
        redactor,
        http: targetHttp,
        cleanupHttp,
        wait: waiter,
        cleanupWait: cleanupWaiter,
        signal: options.signal,
        cleanupSignal: cleanupController.signal,
        apiRestarter: new LocalApiRestarter({
          artifacts,
          commands: runner,
          endpoint: controllerEndpoint,
          http: targetHttp,
        }),
      }),
    ),
  });
  const submitPersistentVmRequest = (
    target: PersistentVmTarget,
    request: Parameters<typeof submitPersistentVm>[1],
  ): Promise<void> =>
    submitPersistentVm(target, request, {
      credentials,
      profiles: { vm: () => nativeVmCleanup.profile(request.ref) },
      mutations: nativeTrackedMutations,
    });
  const serveTransports = new PublicCloudServeTransportFactory(
    credentials,
    targetHttp,
    cleanupHostPresence,
    serviceDns,
  );
  const createServeAdapter = (
    provider: VmProvider,
    profile: VmProfile & Pick<PublicCloudServeProfile, 'gpus' | 'runtime'>,
  ): PublicCloudServeAdapter =>
    new PublicCloudServeAdapter({
      mutations: nativeTrackedMutations,
      profile: {
        credentialName: profile.credentialName,
        provider,
        vmTypes: profile.vmTypes,
        ...(profile.region ? { region: profile.region } : {}),
        ...(profile.diskSizeGb === undefined
          ? {}
          : { diskSizeGb: profile.diskSizeGb }),
        ...(profile.gpus ? { gpus: profile.gpus } : {}),
        ...(profile.runtime ? { runtime: profile.runtime } : {}),
      },
      transport: serveTransports.create(profile),
    });
  const serveTargets = new ServeTargetFactory({
    create: (provider) =>
      createServeAdapter(provider, providers.serve(provider)),
    createGpu: (provider) =>
      createServeAdapter(provider, providers.gpuServe(provider)),
  });
  const localServeTarget = new LocalSmolvmServeAdapter({
    mutations: nativeTrackedMutations,
    transport: new LocalSmolvmServeTransport(artifacts, targetHttp),
    cleanupTransport: new LocalSmolvmServeTransport(artifacts, cleanupHttp),
  });
  const serviceCleanup = new ServiceCleanup({
    cleanupApi,
    native: nativeVmCleanup,
    profiles: providers,
    dns: serviceDns,
    local: localServeTarget,
    wait: cleanupWaiter,
    artifacts,
    namedBundles: secrets,
  });
  const serviceNativeCleanup = {
    reserve: (...args: Parameters<ServiceCleanup['reserve']>) =>
      serviceCleanup.reserve(...args),
    capture: (...args: Parameters<PersistentVmCleanup['capture']>) =>
      nativeVmCleanup.capture(...args),
    verify: (...args: Parameters<PersistentVmCleanup['verify']>) =>
      nativeVmCleanup.verify(...args),
  };
  const persistentVm = new PersistentVmContract({
    artifacts,
    vmReadyByCli: (id, timeoutMs) => vmReadyByCli(cli, id, timeoutMs),
    environment,
    hostIdentity,
    kernel,
    nativeCleanup: nativeVmCleanup,
    secrets,
    sshAccess: {
      summary: (workloadId, mode) => api.sshAccessSummary(workloadId, mode),
      rejection: (workloadId, mode) => api.sshAccessRejection(workloadId, mode),
    },
    targets,
    vm,
    vmLedger,
    wait: waiter,
    names,
    policy: (target) => persistentVmContractPolicy(environment, target),
    sha256,
    submitPersistentVm: submitPersistentVmRequest,
  });
  const serveMembers = {
    nativeCleanup: serviceNativeCleanup,
    artifacts,
    environment,
    kernel,
    names,
    targets: serveTargets,
    vmLedger,
    wait: waiter,
    now: Date.now,
  };
  const serveUpgrade = new ServeUpgradeContract({
    ...serveMembers,
    recovery: new ServiceUpgradeRecoveryProbe({
      cleanup,
      cleanupApi,
      cleanupCli,
      cleanupRemote,
      cli,
      credentials,
      names,
      profiles: providers,
    }),
    faults: new LocalApiRestarter({
      artifacts,
      commands: runner,
      endpoint: controllerEndpoint,
      http: targetHttp,
    }),
  });
  const serveLocalRecovery = new ServeLocalRecoveryContract({
    artifacts,
    environment,
    faults: new LocalApiRestarter({
      artifacts,
      commands: runner,
      endpoint: controllerEndpoint,
      http: targetHttp,
    }),
    probes: {
      namedSecret: new NamedSecretProbeFixture({
        names,
        redactor,
        secrets,
        sha256,
      }),
    },
    stages: {
      nativeCleanup: serviceNativeCleanup,
      kernel,
      names,
      targets: localServeTarget,
      vmLedger,
      wait: waiter,
      now: Date.now,
    },
  });
  const serve = new ServeBaselineContract({
    ...serveMembers,
    probes: {
      environment: new EnvironmentProbeFixture(cleanup, files),
      namedSecret: new NamedSecretProbeFixture({
        names,
        redactor,
        secrets,
        sha256,
      }),
    },
  });
  const storageTokens = new StorageTokensContract({
    port: new StorageTokensTransport({
      api,
      bearer: bearerFor,
      cli,
      cleanup,
      files,
      profiles: providers,
      artifacts,
      runId,
    }),
    wait: waiter,
    clock: { now: Date.now },
  });
  const persistentVmHostLoss = new PersistentVmHostLossContract({
    artifacts,
    vmReadyByCli: (id, timeoutMs) => vmReadyByCli(cli, id, timeoutMs),
    environment,
    kernel,
    nativeCleanup: nativeVmCleanup,
    secrets,
    sshAccess: {
      summary: (workloadId, mode) => api.sshAccessSummary(workloadId, mode),
      rejection: (workloadId, mode) => api.sshAccessRejection(workloadId, mode),
    },
    targets,
    vm,
    vmLedger,
    wait: waiter,
    names,
    policy: (target) => persistentVmContractPolicy(environment, target),
    sha256,
    submitPersistentVm: submitPersistentVmRequest,
  });

  const readModels = new ReadModelProofs({
    artifacts,
    cleanup,
    commands: runner,
    files,
    http: targetHttp,
    projectRoot: options.projectRoot,
    signal: options.signal,
  });
  const e2e: E2EWorld = {
    runId,
    readModels: {
      billingSettlement: () => readModels.billingSettlement(),
      longHistory: () => readModels.longHistory(),
    },
    apiAuth: {
      accessPolicy: () => apiAuth.accessPolicy(),
      secretCrudPrivacy: () => apiAuth.secretCrudPrivacy(),
    },
    bucketAccess: {
      denied: (provider) => bucketAccess.run(provider),
    },
    contracts: {
      dedicatedJob: (member) => dedicatedJob.run(member),
      clusterCloud: async () => {
        const result = await clusterCloud().run();
        await artifacts.json('e2e-cluster-cloud-contract', result);
        return {
          contract: result.contract,
          qualification: result.qualification,
          target: result.target,
          satisfied: result.satisfied,
        };
      },
      clusterLocal: async (target) => {
        const result = await clusterLocal.run(target);
        await artifacts.json('e2e-cluster-local-contract', result);
        return {
          contract: result.contract,
          qualification: result.qualification,
          target: result.target,
          satisfied: result.satisfied,
        };
      },
      persistentVm: (target) => persistentVm.run(target),
      persistentVmHostLoss: (target) => persistentVmHostLoss.run(target),
      storageTokens: (target) => storageTokens.run(target),
      serve: (target) => serve.run(target),
      gpuServe: (target) => serve.runGpu(target),
      serveLocalRecovery: (target) => serveLocalRecovery.run(target),
      serveUpgrade: (target) => serveUpgrade.run(target),
    },
    api: {
      saveCredential: (name, credential) =>
        api.saveCredential(name, credential),
    },
    cli: {
      run: (args, cliOptions) =>
        runDirectCli(
          args,
          cliOptions,
          { cli, directRefs, kernel, mutations },
          false,
        ),
      runWithTransientRetries: (args, cliOptions) =>
        runDirectCli(
          args,
          cliOptions,
          { cli, directRefs, kernel, mutations },
          true,
        ),
    },
    workloadFacts: {
      provisioningRecordCounts: async (workloadId) => {
        const ref = directRefs.get(workloadId);
        if (!ref) {
          throw new Error(
            `No direct-spec workload is tracked with ID ${workloadId}`,
          );
        }
        return vmLedger.provisioningRecordCounts(ref);
      },
      liveVmCount: async (workloadId) => {
        const ref = directRefs.get(workloadId);
        if (!ref) {
          throw new Error(
            `No direct-spec workload is tracked with ID ${workloadId}`,
          );
        }
        return vmLedger.liveVmCount(ref);
      },
    },
    env: {
      optional: (name, fallback) => environment.optional(name, fallback),
    },
    files: {
      directory: (name) => files.directory(name),
      commandShim: (directoryName, executableName, behavior) =>
        files.executableDirectory(
          directoryName,
          executableName,
          validateShim(behavior),
        ),
    },
    names,
  };

  let teardownTimer: NodeJS.Timeout | undefined;
  const beginTeardown = (): void => {
    if (teardownTimer) return;
    teardownTimer = setTimeout(() => {
      cleanupController.abort(
        new Error(`E2E teardown exceeded ${teardownTimeoutMs}ms`),
      );
    }, teardownTimeoutMs);
    teardownTimer.unref();
  };

  return {
    e2e,
    recordOutcome: async (errors) => {
      beginTeardown();
      await captureEveryDiagnostic([
        () => diagnostics.capture(errors),
        () =>
          errors.length > 0
            ? clusterLocalEnvironment.captureDiagnostics(
                errors.map(errorMessage),
              )
            : Promise.resolve(),
      ]);
    },
    dispose: async () => {
      beginTeardown();
      const failures: Error[] = [];
      try {
        await cleanup.run();
      } catch (error) {
        const cleanupFailure = asError(
          error,
          'E2E cleanup threw a non-Error value',
        );
        failures.push(cleanupFailure);
        await artifacts
          .text('cleanup-failure', cleanupFailure.message)
          .catch((artifactError: unknown) => {
            failures.push(
              asError(
                artifactError,
                'Writing the cleanup failure artifact threw a non-Error value',
              ),
            );
          });
      }
      try {
        await nativeVmCleanup.recordObservations();
      } catch (error) {
        failures.push(asError(error, 'Retaining native VM identities failed'));
      }
      try {
        await jobNativeCleanup.recordObservations();
      } catch (error) {
        failures.push(asError(error, 'Retaining native Job identities failed'));
      }
      try {
        const registrations = cleanup.observations();
        await artifacts.json('cleanup-observations', {
          schemaVersion: 1,
          runId,
          registrations,
          outstandingWorkloads: kernel.trackedWorkloadIds(),
          completed:
            failures.length === 0 &&
            registrations.every((registration) => registration.completed),
          failures: failures.map((failure) => failure.message),
        });
      } catch (error) {
        failures.push(asError(error, 'Writing cleanup observations failed'));
      }
      try {
        await rm(workspace, { force: true, recursive: true });
      } catch (error) {
        failures.push(
          asError(error, 'Removing the E2E workspace threw a non-Error value'),
        );
      } finally {
        if (teardownTimer) clearTimeout(teardownTimer);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'E2E cleanup failed');
      }
    },
  };
}
