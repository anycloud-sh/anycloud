import { vi } from 'vitest';
import type { ContainerSpec } from '../../../src/api/services/container-spec.js';
import {
  type StoredWorkload,
  type WorkloadEvent,
} from '../../../src/api/services/workload-record.js';
import {
  type WorkloadListRow,
  type StatusWorkloadMetadata,
} from '../../../src/shared/api-contract/workload-management-schemas.js';
import {
  type AWSCredentials,
  type GCPCredentials,
  type AzureCredentials,
  type CloudCredentials,
  type LambdaCredentials,
} from '../../../src/shared/cloud.js';
import { CloudFailureDiagnosis, CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import type { NodePoolSummary } from '../../../src/shared/api-contract/node-pools-schemas.js';
import type { DeploymentSummary } from '../../../src/shared/api-contract/deployments-schemas.js';
import type {
  CloudCompute,
  CloudStorage,
  CloudStorageOps,
  CloudComputeOps,
  CandidateRegionFilter,
  Preemptible,
} from '../../../src/api/services/gateways/cloud.js';
import type { ClusterKubernetesClient } from '../../../src/api/services/kubernetes/cluster-client.js';
import type { ReplicaPolicyDependencies } from '../../../src/api/services/deployment-replicas.js';
import type { ManagedDemand } from '../../../src/api/services/repositories/replica-demand.js';

// Composed locally: these exist only so unit fixtures can build combined
// mocks; production composes the primitives itself.
type Cloud = CloudCompute & CloudStorage;
type PreemptibleOps = Pick<Preemptible, 'verifyVMPreemption' | 'startVM'>;
import {
  createCloudCompute,
  createCloudStorage,
  isPreemptible,
  VM_PRESENT,
} from '../../../src/api/services/gateways/cloud.js';
import type {
  CloudVM,
  NewVMProps,
} from '../../../src/api/services/entities.js';

export const TEST_LAMBDA_CRED: LambdaCredentials = {
  cloudProvider: CloudType.Lambda,
  apiKey: 'test-key',
};

export const TEST_GCP_CRED: GCPCredentials = {
  cloudProvider: CloudType.GCP,
  projectId: 'test-project',
  privateKey: 'test-private-key',
  clientEmail: 'test@example.com',
};

export const TEST_AWS_CRED: AWSCredentials = {
  cloudProvider: CloudType.AWS,
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'test-secret',
};

export const TEST_AZURE_CRED: AzureCredentials = {
  cloudProvider: CloudType.Azure,
  applicationId: 'test-app-id',
  secret: 'test-secret',
  directoryId: 'test-dir-id',
  subscriptionId: 'test-sub-id',
};

/** Role connections (RFC 0047 amendments 8 and 9): identifiers only. */
const TRUST = {
  kind: 'role',
  issuer: 'https://issuer.example.com',
  subject: 'system:serviceaccount:anycloud-system:anycloud-api',
} as const;
type RoleConnection<C extends CloudType> = Extract<
  CloudCredentials,
  { kind: 'role'; cloudProvider: C }
>;
export const TEST_AWS_ROLE: RoleConnection<CloudType.AWS> = {
  ...TRUST,
  cloudProvider: CloudType.AWS,
  roleArn: 'arn:aws:iam::123456789012:role/anycloud',
  audience: 'sts.amazonaws.com',
};
const GCP_PROVIDER =
  'projects/123/locations/global/workloadIdentityPools/anycloud/providers/cluster';
export const TEST_GCP_ROLE: RoleConnection<CloudType.GCP> = {
  ...TRUST,
  cloudProvider: CloudType.GCP,
  workloadIdentityProvider: GCP_PROVIDER,
  serviceAccountEmail: 'anycloud@role-project.iam.gserviceaccount.com',
  audience: `https://iam.googleapis.com/${GCP_PROVIDER}`,
};
export const TEST_AZURE_ROLE: RoleConnection<CloudType.Azure> = {
  ...TRUST,
  cloudProvider: CloudType.Azure,
  applicationId: '00000000-0000-0000-0000-00000000000a',
  directoryId: '00000000-0000-0000-0000-00000000000d',
  subscriptionId: 'role0000-0000-0000-0000-00000000000e',
  audience: 'api://AzureADTokenExchange',
};

type ClusterKubernetesClientFixture = {
  [Key in keyof ClusterKubernetesClient]?: Partial<
    ClusterKubernetesClient[Key]
  >;
};

export function makeClusterKubernetesClientFixture(
  fixture: ClusterKubernetesClientFixture,
): ClusterKubernetesClient {
  return fixture as unknown as ClusterKubernetesClient;
}

export function makeContainerSpec(
  overrides: Partial<ContainerSpec> = {},
): ContainerSpec {
  return {
    image: 'example/image:latest',
    imageDigest: null,
    command: null,
    dockerOptions: null,
    env: null,
    registryUsername: 'test-user',
    registryToken: null,
    ...overrides,
  };
}

export function makeStoredWorkload(
  overrides: Partial<StoredWorkload> = {},
): StoredWorkload {
  return {
    id: 'test-deploy',
    userId: 'test-user',
    registryUsername: overrides.deploymentId
      ? null
      : (overrides.userId ?? 'test-user'),
    deploymentId: null,
    nodePoolId: null,
    nodePoolName: null,
    currentExecutionId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    firstClaimedAt: null,
    workloadType: 'job',
    image: 'alpine:latest',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.micro',
    gpuType: null,
    spot: false,
    state: WorkloadState.Running,
    startedAt: Date.now(),
    completedAt: null,
    cleanedAt: null,
    endReason: null,
    lastAttemptEndReason: null,
    maxRetries: null,
    noCheckpoint: false,
    requireNestedVirtualization: false,
    hostDocker: false,
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
    env: null,
    githubToken: null,
    vmCount: 0,
    sshPrivateKey: '',
    credentialId: 'cred-1',
    inputStorageCredentialId: null,
    inputStorageRegion: null,
    outputStorageCredentialId: null,
    outputStorageRegion: null,
    checkpointStorageCredentialId: null,
    checkpointStorageRegion: null,
    command: null,
    imageDigest: null,
    imageRuntime: null,
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
    latestMessage: null,
    ...overrides,
  };
}

/**
 * Build a row as the list endpoint returns it: the status fields plus whether
 * the calling user owns the workload, which is what the CLI renders on.
 */
export function makeWorkloadListRow(
  overrides: Partial<WorkloadListRow> = {},
): WorkloadListRow {
  // Object.assign rather than a spread: Partial<T> lets an override carry an
  // explicit undefined, which a required field like gpuType does not accept.
  return Object.assign(
    {
      ...makeStatusWorkloadMetadata(),
      isOwnedByCaller: true,
      credentialId: null,
      inputStorageCredentialId: null,
      outputStorageCredentialId: null,
      checkpointStorageCredentialId: null,
      imageRuntime: null,
      latestMessage: null,
    },
    overrides,
  );
}

export function makeStatusWorkloadMetadata(
  overrides: Partial<StatusWorkloadMetadata> = {},
): StatusWorkloadMetadata {
  return {
    id: 'test-deploy',
    userId: 'test-user',
    deploymentId: null,
    submissionRevision: 0,
    claimDeadlineAt: null,
    claimed: false,
    workloadType: 'job',
    image: 'alpine:latest',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.micro',
    gpuType: null,
    spot: false,
    state: WorkloadState.Running,
    startedAt: Date.now(),
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
    vmCount: 0,
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
    ...overrides,
  };
}

export function makeWorkloadEvent(
  overrides: Partial<WorkloadEvent> = {},
): WorkloadEvent {
  return {
    id: 1,
    workloadId: 'test-deploy',
    state: WorkloadState.Running,
    metadata: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

type MockCloudComputeOverrides = Partial<
  Omit<
    CloudComputeOps,
    'preemptible' | 'candidateRegionFilter' | 'terminalAuthErrorClassifier'
  >
> &
  Partial<PreemptibleOps> & {
    validateCredentials?: never;
    classifyError?: never;
    newVM?: never;
    terminateVM?: never;
    terminateVMs?: never;
    terminateNetworking?: never;
    getAllVMs?: never;
    upsertFirewall?: never;
    prepareNetwork?: never;
  };

export function makeMockCloudCompute(
  overrides: MockCloudComputeOverrides = {},
  options: {
    candidateRegionFilter?: CandidateRegionFilter;
  } = {},
): CloudCompute & Preemptible {
  const { verifyVMPreemption, startVM, ...computeOverrides } = overrides;
  const verify = verifyVMPreemption ?? vi.fn().mockResolvedValue(false);
  const compute = createCloudCompute({
    type: CloudType.GCP,
    region: 'us-central1',
    vmType: 'n2-standard-4',
    rawValidateCredentials: vi.fn().mockResolvedValue(undefined),
    rawNewVM: vi.fn(),
    rawRequestVMTermination: vi.fn().mockResolvedValue(undefined),
    rawTerminateNetworking: vi.fn().mockResolvedValue(undefined),
    rawGetAllVMs: vi.fn().mockResolvedValue([]),
    rawUpsertFirewall: vi.fn().mockResolvedValue(undefined),
    observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_PRESENT),
    rawClassifyError: vi
      .fn()
      .mockReturnValue(CloudFailureDiagnosis.TemporaryProviderFailure),
    ...computeOverrides,
    // One stopped read, as AWS and GCP wire it.
    stoppedVmObservation: { observeStoppedVm: verify },
    stoppedVmRestart: {
      verifyVMPreemption: verify,
      startVM: startVM ?? vi.fn().mockResolvedValue(null),
    },
    candidateRegionFilter: options.candidateRegionFilter,
  });

  vi.spyOn(compute, 'validateCredentials');
  vi.spyOn(compute, 'newVM');
  vi.spyOn(compute, 'terminateVMs');
  vi.spyOn(compute, 'terminateNetworking');
  vi.spyOn(compute, 'getAllVMs');
  vi.spyOn(compute, 'upsertFirewall');
  vi.spyOn(compute, 'observeVMReleaseOnce');
  vi.spyOn(compute, 'classifyError');

  // createCloudCompute types its return as the base contract even when given
  // preemptible operations, so the combined shape is asserted once here and
  // the two preemptible spies attach to the narrowed value.
  const preemptible = compute as CloudCompute & Preemptible;
  vi.spyOn(preemptible, 'verifyVMPreemption');
  vi.spyOn(preemptible, 'startVM');

  return preemptible;
}

export function makeMockVM(overrides: Partial<CloudVM> = {}): CloudVM {
  const ip = overrides.ip ?? '1.2.3.4';
  return {
    cloudId: 'vm-123',
    ip,
    privateIp: '10.0.0.1',
    ...overrides,
    sshHost: overrides.sshHost ?? ip,
    sshPort: overrides.sshPort ?? 22,
    sshUsername: overrides.sshUsername ?? 'root',
  };
}

/**
 * Build a cloud storage gateway from just the operations a test drives.
 *
 * It goes through createCloudStorage rather than being an object literal so it
 * carries the brand isCloudStorage checks for — a hand-built stand-in passes
 * every structural check and then fails that one.
 */
export function makeMockCloudStorage(
  overrides: Partial<CloudStorageOps> = {},
): CloudStorage {
  return createCloudStorage({
    type: CloudType.AWS,
    region: 'us-east-1',
    rawHasBucket: vi.fn().mockResolvedValue(true),
    rawUpsertBucketUncoordinated: vi.fn().mockResolvedValue(undefined),
    rawDeleteBucket: vi.fn().mockResolvedValue(undefined),
    rawDeleteObject: vi.fn().mockResolvedValue(undefined),
    rawUploadObject: vi.fn().mockResolvedValue(undefined),
    rawDownloadObject: vi.fn(),
    ...overrides,
  });
}

export function makeMockCloud(
  overrides: Partial<Cloud & Preemptible> = {},
): Cloud & Preemptible {
  const compute = makeMockCloudCompute({
    type: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.medium',
    spot: false,
    rawNewVM: vi.fn().mockResolvedValue(makeMockVM()),
    rawRequestVMTermination: vi.fn().mockResolvedValue(undefined),
  });
  const storage = makeMockCloudStorage();

  vi.spyOn(storage, 'hasBucket');
  vi.spyOn(storage, 'upsertBucket');
  vi.spyOn(storage, 'deleteBucket');
  vi.spyOn(storage, 'deleteObject');
  vi.spyOn(storage, 'uploadObject');
  vi.spyOn(storage, 'downloadObject');

  const cloud = Object.assign(compute, storage);
  for (const key of Object.getOwnPropertySymbols(storage)) {
    const descriptor = Object.getOwnPropertyDescriptor(storage, key);
    if (descriptor && !descriptor.enumerable) {
      Object.defineProperty(cloud, key, descriptor);
    }
  }

  return Object.assign(cloud, overrides);
}

/**
 * Build the arguments for a single-VM provision call.
 *
 * Only the fields a test is actually asserting on belong in the override; the
 * rest exist because `newVM` requires them, and a spec that spells them out
 * inline has to be revisited every time the call gains a field.
 */
export function makeNewVMProps(
  overrides: Partial<NewVMProps> = {},
): NewVMProps {
  return {
    workloadId: 'd-1',
    vmId: 'vm-1',
    userId: 'user-1',
    version: '0.0.0-test',
    ipWhitelist: [],
    startupScript: '#!/bin/bash\ntrue',
    ...overrides,
  };
}

/**
 * Narrow a gateway to its spot-instance operations.
 *
 * Preemption handling is an optional capability, so it is absent from the type
 * every gateway shares. A spec that drives it is asserting the gateway offers
 * it; if that ever stops being true, this says so where the test starts rather
 * than where the call fails.
 */
export function requirePreemptible(
  compute: CloudCompute,
): CloudCompute & Preemptible {
  if (!isPreemptible(compute)) {
    throw new Error('gateway does not support preemption');
  }
  return compute;
}

/**
 * Narrow a gateway to its network-preparation call.
 *
 * Clouds that provision no network of their own omit it, so it is optional on
 * the shared type. A spec that drives it is asserting the gateway has one.
 */
export function requirePrepareNetwork(
  compute: CloudCompute,
): NonNullable<CloudCompute['prepareNetwork']> {
  const prepareNetwork = compute.prepareNetwork;
  if (!prepareNetwork) {
    throw new Error('gateway does not prepare a network');
  }
  return prepareNetwork.bind(compute);
}

export function makeNodePoolSummary(
  overrides: Partial<NodePoolSummary> = {},
): NodePoolSummary {
  return Object.assign(
    {
      id: 'node-pool-a',
      name: 'training',
      clusterId: 'cluster-a',
      state: WorkloadState.Running,
      releasing: false,
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      zone: null,
      vmTypes: ['g5.xlarge'],
      minVmCount: 1,
      maxVmCount: 1,
      osDiskSizeGb: null,
      osDiskTier: null,
      spot: false,
      allowPrivilegedJobs: false,
      userNamespaceJobs: false,
      requireNestedVirtualization: false,
      capacity: {
        readyVmCount: 1,
        startingVmCount: 0,
        drainingVmCount: 0,
        locations: [],
      },
      liveReferences: 0,
      ingressEntryIp: null,
      ingress: { entryIp: null, release: null },
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    },
    overrides,
  );
}

export function makeDeploymentSummary(
  overrides: Partial<DeploymentSummary> = {},
): DeploymentSummary {
  return Object.assign(
    {
      id: 'deployment-a',
      name: 'model-deployment',
      nodePoolId: 'node-pool-a',
      managed: false,
      privileged: false,
      target: { kind: 'nodePool', nodePoolId: 'node-pool-a' },
      image: 'example/model-deployment:latest',
      command: null,
      readinessProbe: null,
      gracePeriodSeconds: 30,
      gpuCount: 1,
      envKeys: [],
      secretNames: [],
      maxConcurrentJobsPerReplica: 4,
      minReplicas: 1,
      maxReplicas: 1,
      generation: 1,
      deletionRequestedAt: null,
      deletedAt: null,
      createdAt: 2,
      updatedAt: 2,
      usage: null,
      jobs: {
        queued: 1,
        running: 1,
        retrying: 0,
        terminal: 2,
        unreleased: 1,
      },
      workload: {
        observedGeneration: 1,
        podName: 'model-deployment-abc',
        podUid: 'pod-uid',
        containerId: 'containerd://deployment',
        containerReady: true,
        pendingReason: null,
      },
      status: null,
    },
    overrides,
  );
}

/** RA's policy dependencies: idle replicas drain, no managed demand, no cap block. */
export function makeReplicaPolicyDependencies() {
  return {
    drainReplica: vi.fn(async (_deploymentId: string, _podUid: string) => true),
    reopenReplica: vi.fn((_podUid: string) => undefined),
    listManagedDemand: vi.fn(
      async (_clusterId: string): Promise<ManagedDemand[]> => [],
    ),
    managedRoom: vi.fn(async (_nodePoolId: string) => ({
      maxVms: 1,
      reservedGpus: 0,
      vmPrice: null as number | null,
    })),
    capBlocked: vi.fn(async (_nodePoolId: string) => false),
    demandAdmission: vi.fn(
      async () =>
        async (
          _session: string | null,
          _hourlyUsd?: number,
        ): Promise<unknown> =>
          null,
    ),
  } satisfies ReplicaPolicyDependencies;
}
