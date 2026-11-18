import type { StatusWorkloadMetadata } from '../../../src/shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import type { ArtifactStore } from '../../integration/e2e/internal/artifacts.js';
import {
  CleanupStack,
  type CleanupRegistration,
} from '../../integration/e2e/internal/cleanup.js';
import type { PersistentVmRunningDependencies } from '../../integration/e2e/internal/contracts/persistent-vm-running.js';
import type { SecretManager } from '../../integration/e2e/internal/secrets.js';
import type { PersistentVmRunningContext } from '../../integration/e2e/internal/targets/persistent-vm-types.js';
import type {
  SshAccessSummary,
  WorkloadFixtureObservation,
  WorkloadInspection,
} from '../../integration/e2e/internal/types.js';
import {
  liveStatusVmEntries,
  snapshotStatusVmLedger,
} from '../../integration/e2e/internal/vm-ledger.js';
import { Waiter } from '../../integration/e2e/internal/wait.js';
import type { WorkloadKernel } from '../../integration/e2e/internal/workloads.js';
import { substrateAbsentForTest, trackedWorkloadRefForTest } from './e2e.js';

interface FixtureDependencies
  extends Omit<
    PersistentVmRunningDependencies,
    'kernel' | 'secrets' | 'vmLedger'
  > {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly kernel: Pick<
    WorkloadKernel,
    'reserve' | 'recordSubstrateAbsence' | 'release'
  >;
  readonly secrets: Pick<SecretManager, 'create' | 'delete'>;
  readonly vmLedger: Omit<
    PersistentVmRunningDependencies['vmLedger'],
    'liveVmCount'
  >;
}

interface FixtureObservations {
  readonly sshHost?: string;
  readonly sshDefaults?: Pick<SshAccessSummary, 'port' | 'username'>;
  readonly inspection?: Partial<WorkloadInspection>;
  readonly fixtureObservation?: Partial<WorkloadFixtureObservation>;
  readonly liveVmMetadata?: Partial<
    Awaited<
      ReturnType<PersistentVmRunningDependencies['vmLedger']['liveVmMetadata']>
    >
  >;
}

export function persistentVmWorkload(
  id: string,
  overrides: Partial<StatusWorkloadMetadata> = {},
): StatusWorkloadMetadata {
  return {
    id,
    userId: 'e2e-user',
    deploymentId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    claimed: false,
    workloadType: WorkloadType.Vm,
    image: 'alpine:3.20',
    cloudProvider: CloudType.AWS,
    region: 'us-east-2',
    vmType: 't3.small',
    gpuType: null,
    spot: false,
    state: WorkloadState.Running,
    startedAt: 1,
    completedAt: null,
    cleanedAt: null,
    endReason: null,
    lastAttemptEndReason: null,
    version: '1.0.0',
    dockerCommand: '',
    inputBucket: null,
    outputBucket: null,
    checkpointBucket: null,
    diskSizeGb: null,
    diskTier: null,
    diskIops: null,
    diskThroughputMibps: null,
    regions: null,
    dockerOptions: null,
    availabilityZone: null,
    vmCount: 1,
    inputStorageRegion: null,
    outputStorageRegion: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    vmDurationMs: null,
    awaitingReleaseMs: null,
    totalCost: null,
    costSource: null,
    dnsRecordId: null,
    publicEndpoint: null,
    secretNames: null,
    session: null,
    agent: null,
    sessionLabel: null,
    ...structuredClone(overrides),
  };
}

export function createPersistentVmFixture(
  workloadId: string,
  observations: FixtureObservations = {},
) {
  const overrides = structuredClone(observations);
  const calls: string[] = [];
  const cleanup = new CleanupStack();
  const registrations = new Map<string, CleanupRegistration>();
  const observedRunningContexts: PersistentVmRunningContext[] = [];
  const sshDefaults = overrides.sshDefaults ?? {
    port: 2222,
    username: 'root',
  };
  const inspection: WorkloadInspection = {
    args: ['-c', 'while :; do sleep 3600; done'],
    dockerSocketGroupAdded: true,
    dockerSocketGid: '999',
    initEnabled: true,
    managedLabel: 'true',
    name: `/${workloadId}`,
    path: '/bin/sh',
    running: true,
    workloadIdLabel: workloadId,
    roleLabel: 'workload',
    workingDirectory: '/workspace',
    workspaceMode: '777',
    restartPolicy: 'unless-stopped',
    publishedPortCount: 0,
    writableWorkspaceMountCount: 1,
    writableDockerSocketMountCount: 1,
    runtimePathsAccessible: true,
    user: '',
    ...overrides.inspection,
  };
  const fixtureObservation: WorkloadFixtureObservation = {
    workingDirectoryMatches: true,
    environmentPresent: true,
    environmentMatches: true,
    secretPresent: true,
    secretDigestMatches: true,
    ...overrides.fixtureObservation,
  };
  const profile = {
    target: 'aws' as const,
    provider: CloudType.AWS,
    credentialName: 'aws-test',
  };
  const policy = {
    cleanupTimeoutMs: 1_000,
    hostLossFailureTimeoutMs: 1_000,
    hostReleaseTimeoutMs: 1_000,
    repairTimeoutMs: 1_000,
    runningTimeoutMs: 1_000,
    teardownMaxMs: 1_000,
    terminatedTimeoutMs: 1_000,
  };

  // Suites supply wait/state responses and live-VM counts because their
  // lifecycle, repair, and host-loss sequences have different observations.
  const dependencies: FixtureDependencies = {
    // `anycloud wait` reports the VM ready and `exec` straight after succeeds.
    vmReadyByCli: async () => {
      calls.push('cli-wait', 'cli-exec');
      return { waitReady: true, execAfterWait: true };
    },
    nativeCleanup: {
      reserve: (_target, id, timeoutMs) =>
        dependencies.kernel.reserve(id, timeoutMs),
      capture: async () => {
        calls.push('capture-native-identities');
      },
      verify: async (ref) => dependencies.kernel.recordSubstrateAbsence(ref),
    },
    sshAccess: {
      summary: async (id, mode) => {
        calls.push(`ssh-${mode}`);
        return {
          workloadId: id,
          host: overrides.sshHost ?? '127.0.0.1',
          ...sshDefaults,
          hasPrivateKey: true,
        };
      },
      rejection: async (_id, mode) => {
        calls.push(`ssh-${mode}`);
        return {
          code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
          message:
            'VMs do not support snapshot SSH; use container or host access.',
          status: 400,
        };
      },
    },
    artifacts: {
      json: async (name) => {
        calls.push(`artifact-${name}`);
        return `/tmp/${name}.json`;
      },
    },
    kernel: {
      recordSubstrateAbsence: (ref) => {
        calls.push('substrate-absence');
        return substrateAbsentForTest(ref);
      },
      release: async (evidence) => {
        calls.push('release');
        registrations.get(`workload:${evidence.cleanup.ref.id}`)?.complete();
      },
      reserve: async (id) => {
        calls.push('reserve');
        registrations.set(
          `workload:${id}`,
          cleanup.defer(`workload:${id}`, async () => {
            calls.push('cleanup-workload');
          }),
        );
        return trackedWorkloadRefForTest(id);
      },
    },
    vmLedger: {
      snapshot: (ref, status) => snapshotStatusVmLedger(ref.id, status),
      liveEntries: liveStatusVmEntries,
      credentialName: async () => {
        calls.push('credential');
        return 'aws-test';
      },
      liveVmMetadata: async () => {
        calls.push('live-metadata');
        return structuredClone({
          cloudId: 'cloud-vm-1',
          baseImageId: null,
          sshHost: overrides.sshHost ?? '127.0.0.1',
          sshPort: sshDefaults.port ?? 22,
          sshUsername: sshDefaults.username ?? 'root',
          ...overrides.liveVmMetadata,
        });
      },
    },
    environment: { optional: (_name, fallback = '') => fallback },
    secrets: {
      create: async (name) => {
        calls.push('secret-create');
        registrations.set(
          `secret:${name}`,
          cleanup.defer(`secret:${name}`, async () => {
            calls.push('cleanup-secret');
          }),
        );
      },
      delete: async (name) => {
        calls.push('secret-delete');
        registrations.get(`secret:${name}`)?.complete();
      },
    },
    targets: {
      profile: () => profile,
      observeRunning: async (_target, context) => {
        calls.push('observe-running');
        observedRunningContexts.push(context);
        return {
          kind: 'observed',
          observation: {
            kind: 'aws',
            rootVolumeIops: 8_000,
            rootVolumeThroughput: 1_000,
            rootVolumeType: 'gp3',
          },
        };
      },
    },
    submitPersistentVm: async () => {
      calls.push('submit');
    },
    vm: {
      inspectWorkload: async () => {
        calls.push('inspect');
        return structuredClone(inspection);
      },
      probeWorkloadFixture: async () => {
        calls.push('fixture-probe');
        return structuredClone(fixtureObservation);
      },
      verifyHostDocker: async (_id, marker) => {
        calls.push('host-docker');
        return marker;
      },
      writeWorkspaceMarker: async () => {
        calls.push('workspace-marker');
      },
    },
    names: {
      workload: (prefix) => `${prefix}-run`,
      secret: (prefix) => `${prefix}-secret-run`,
    },
    policy: () => policy,
    sha256: () => 'expected-secret-digest',
    wait: new Waiter(new AbortController().signal),
  };

  return { calls, cleanup, dependencies, observedRunningContexts };
}
