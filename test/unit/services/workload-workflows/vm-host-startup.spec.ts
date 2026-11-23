import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as startup from '../../../../src/api/services/workload-workflows/vm-host-startup';
import { pickTarget } from '../../../../src/api/services/launch-targets';
import { vmHostStartupDeps } from '../../../../src/api/services/job/default-runtime';
import type { ProvisionParams } from '../../../../src/api/services/vm-provisioner';
import {
  ensureManagedWorkloadCheckpoint,
  resolveWorkloadStorage,
} from '../../../../src/api/services/workload-storage';
import { SupervisorManager } from '../../../../src/api/services/supervisor';
import config from '../../../../src/api/config';
import {
  INITIALIZATION_TIMEOUT_MS,
  PROVISIONING_TIMEOUT_MS,
  RCLONE_INIT_TIMEOUT_MS,
} from '../../../../src/api/config';
import { getDB } from '../../../../src/api/services/repositories/db';
import {
  walkToState,
  provisionTestVm,
} from '../../../helpers/workload-store.js';

const deployFlowMocks = vi.hoisted(() => ({
  assertVmContainerReady: vi.fn(),
  checkpointUpsertBucket: vi.fn(),
  classifyError: vi.fn(),
  dockerPing: vi.fn(),
  getContainerStatus: vi.fn(),
  initializeVM: vi.fn(),
  markCredentialOnAuthFailure: vi.fn(),
  pullImage: vi.fn(),
  publishServeEndpoint: vi.fn(),
  prepareExistingVmWorkloadStorage: vi.fn(),
  provisionVMs: vi.fn(),
  permissionDenial: vi.fn(),
  sshExec: vi.fn(),
  sshPing: vi.fn(),
  startContainer: vi.fn(),
}));

vi.mock('../../../../src/api/services/docker', () => ({
  DockerManager: vi.fn().mockImplementation(function () {
    return {
      assertVmContainerReady: deployFlowMocks.assertVmContainerReady,
      getContainerStatus: deployFlowMocks.getContainerStatus,
      startContainer: deployFlowMocks.startContainer,
      ping: deployFlowMocks.dockerPing,
    };
  }),
}));

vi.mock('../../../../src/api/services/host-runtime/image-delivery', () => ({
  pullImage: deployFlowMocks.pullImage,
}));

vi.mock('../../../../src/api/services/cloud-config', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../../src/api/services/cloud-config')
    >();
  return {
    ...actual,
    createComputeProvider: vi.fn((cloudConfig: CloudConfig) => ({
      classifyError: deployFlowMocks.classifyError,
      permissionDenial: deployFlowMocks.permissionDenial,
      getAllVMs: vi.fn().mockResolvedValue([]),
      newVM: vi.fn().mockResolvedValue({
        cloudId: 'vm-1',
        ip: '10.0.0.1',
      }),
      // Mirror the real capability: Local publishes no public endpoint.
      publishesPublicEndpoint: () => cloudConfig?.cloudProvider !== 'Local',
      terminateNetworking: vi.fn().mockResolvedValue(undefined),
      terminateVMs: vi.fn((cloudIds: string[]) => Promise.resolve(cloudIds)),
      type: cloudConfig.cloudProvider,
      region: cloudConfig.region ?? '',
      upsertFirewall: vi.fn().mockResolvedValue(undefined),
      validateCredentials: vi.fn().mockResolvedValue(undefined),
    })),
    createCheckpointStorageProvider: vi.fn(() => ({
      region: 'us-east-1',
      type: 'aws',
      upsertBucket: deployFlowMocks.checkpointUpsertBucket,
    })),
    resolveRuntimeBucketStorageRegions: vi.fn(
      async (cloudConfig: CloudConfig) => cloudConfig,
    ),
  };
});

vi.mock('../../../../src/api/services/gateways/ssh', () => {
  const SSHManager = Object.assign(
    vi.fn().mockImplementation(function () {
      return {
        exec: deployFlowMocks.sshExec,
        ping: deployFlowMocks.sshPing,
      };
    }),
    {
      derivePublicKey: vi.fn(() => 'ssh-rsa test-key'),
    },
  );
  return { SSHManager };
});

vi.mock('../../../../src/api/services/vm-initializer', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../../src/api/services/vm-initializer')
    >();
  return {
    ...actual,
    initializeVM: deployFlowMocks.initializeVM,
  };
});

vi.mock('../../../../src/api/services/vm-provisioner', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../../../src/api/services/vm-provisioner')
    >();
  return {
    ...actual,
    prepareExistingVmWorkloadStorage:
      deployFlowMocks.prepareExistingVmWorkloadStorage,
    provisionVMs: deployFlowMocks.provisionVMs,
  };
});

vi.mock('../../../../src/api/services/credential-auth-failure', () => ({
  markCredentialOnAuthFailure: deployFlowMocks.markCredentialOnAuthFailure,
}));

vi.mock('../../../../src/api/services/serve', () => ({
  publishServeEndpoint: deployFlowMocks.publishServeEndpoint,
}));

import { type StoredWorkload } from '../../../../src/api/services/workload-record.js';
import {
  CloudFailureDiagnosis,
  CloudConfig,
  CloudType,
} from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { ContainerState } from '../../../../src/shared/runtime.js';
import { DeployError } from '../../../../src/shared/errors.js';
import { FailureDisposition } from '../../../../src/api/services/provisioning-failure.js';
import { DNSAuthoritiesUnreachableError } from '../../../../src/api/services/dns-publication.js';
import { GpuRuntime } from '../../../../src/shared/cloud';
import { UNUSABLE_GPU_DIAGNOSIS } from '../../../../src/api/services/workload-workflows/missing-gpu';
import {
  getCredentialSecretStore,
  getWorkloadLifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../../src/api/services/persistence.js';
import { type CreateWorkloadInput } from '../../../../src/api/services/repositories/workload-creation.js';
import type { RuntimeContainerStatus } from '../../../../src/api/services/container-health';
import { encryptCredential } from '../../../../src/api/services/cloud-config';
import { resetTestStore, settleWithFakeTimers } from '../../utils';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import type { CloudCompute } from '../../../../src/api/services/gateways/cloud.js';

const { provisionVMs: realProvisionVMs } = await vi.importActual<
  typeof import('../../../../src/api/services/vm-provisioner')
>('../../../../src/api/services/vm-provisioner');

describe('workload image pull flow', () => {
  function readyServiceContainerStatus(): RuntimeContainerStatus {
    return {
      state: ContainerState.Running,
      exitCode: undefined,
      startedAt: '2000-01-01T00:00:00.000Z',
    };
  }

  const cloudConfig: CloudConfig = {
    cloudProvider: CloudType.AWS,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    region: 'us-east-1',
    vmType: 't3.micro',
  };

  beforeEach(async () => {
    await resetTestStore();
    config.cipherKey = 'a'.repeat(64);
    await getDB().query(
      'UPDATE credentials SET encrypted_data = ?, cloud_provider = ? WHERE id = ?',
      [
        await encryptCredential({
          cloudProvider: CloudType.AWS,
          accessKeyId: 'test',
          secretAccessKey: 'test',
        }),
        CloudType.AWS,
        'test-credential-id',
      ],
    );

    const { DockerManager } = await import(
      '../../../../src/api/services/docker'
    );
    const docker = {
      assertVmContainerReady: deployFlowMocks.assertVmContainerReady,
      getContainerStatus: deployFlowMocks.getContainerStatus,
      ping: deployFlowMocks.dockerPing,
      startContainer: deployFlowMocks.startContainer,
    };
    vi.mocked(DockerManager).mockImplementation(function () {
      return docker as any;
    });

    deployFlowMocks.assertVmContainerReady
      .mockReset()
      .mockResolvedValue(undefined);
    deployFlowMocks.classifyError.mockReset().mockReturnValue('transient');
    deployFlowMocks.permissionDenial.mockReset().mockReturnValue(undefined);
    deployFlowMocks.markCredentialOnAuthFailure
      .mockReset()
      .mockResolvedValue(undefined);
    deployFlowMocks.checkpointUpsertBucket
      .mockReset()
      .mockResolvedValue(undefined);
    deployFlowMocks.dockerPing.mockReset().mockResolvedValue(true);
    deployFlowMocks.getContainerStatus
      .mockReset()
      .mockResolvedValueOnce({ state: ContainerState.NotFound })
      .mockResolvedValue(readyServiceContainerStatus());
    deployFlowMocks.initializeVM
      .mockReset()
      .mockResolvedValue({ storageDriver: null });
    deployFlowMocks.pullImage.mockReset().mockResolvedValue(undefined);
    deployFlowMocks.publishServeEndpoint
      .mockReset()
      .mockResolvedValue('https://server.anycloud.sh');
    const storageProviders = {
      input: () => ({
        hasBucket: vi.fn().mockResolvedValue(true),
        region: 'us-east-1',
        type: CloudType.AWS,
      }),
      output: () => ({
        region: 'us-east-1',
        type: CloudType.AWS,
        upsertBucket: vi.fn().mockResolvedValue(undefined),
      }),
      checkpoint: () => ({
        hasBucket: vi.fn().mockResolvedValue(true),
        region: 'us-east-1',
        type: CloudType.AWS,
        upsertBucket: deployFlowMocks.checkpointUpsertBucket,
      }),
    };
    deployFlowMocks.prepareExistingVmWorkloadStorage
      .mockReset()
      .mockImplementation(
        async (
          selectedConfig: CloudConfig,
          workloadId: string,
          metadata: { version: string; userId: string },
        ) => {
          const storage = await resolveWorkloadStorage(
            selectedConfig,
            workloadId,
            undefined,
            storageProviders as any,
          );
          await ensureManagedWorkloadCheckpoint(storage, metadata);
          return storage;
        },
      );
    deployFlowMocks.provisionVMs
      .mockReset()
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[1] as ProvisionParams;
        const vm = {
          baseImageId: 'ami-base-1',
          cloudId: 'vm-1',
          ip: '10.0.0.1',
          name: 'anycloud-test',
        };
        // provisionVMs now owns the durable attempt-row side effect. Keep the
        // orchestration mock faithful so later steps load the provisioned VM.
        const ref =
          params.existingAttempt ??
          (await ledger().beginProvisioningAttempt(
            params.workloadId,
            `${params.workloadId}-${params.startIndex ?? 0}`,
            {
              region: params.cloudConfig.region,
              vmType: params.cloudConfig.vmType,
              credentialId: params.credentialId,
            },
          ));
        expect(ref).not.toBeNull();
        await ledger().completeProvisioningAttempt(params.workloadId, ref!, vm);
        const storage = await deployFlowMocks.prepareExistingVmWorkloadStorage(
          params.cloudConfig,
          params.workloadId,
          { version: params.version, userId: params.userId },
        );
        return { vms: [vm], storage };
      });
    deployFlowMocks.sshExec
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    deployFlowMocks.sshPing.mockReset().mockResolvedValue(true);
    deployFlowMocks.startContainer.mockReset().mockResolvedValue(undefined);
  });

  async function createDeployProps(
    id: string,
    overrides: Partial<CreateWorkloadInput> = {},
  ): Promise<StoredWorkload> {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.micro',
      dockerCommand: 'docker run alpine:latest',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-credential-id',
      imageDigest: 'sha256:test-digest',
      ...overrides,
    });
    const workload = await queries().getWorkload(id);
    expect(workload).not.toBeNull();
    return workload!;
  }

  async function deployWithVirtualClock(
    selectedConfig: CloudConfig,
    props: StoredWorkload,
    credentialId?: string,
    options?: startup.DeployOptions,
  ): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const workload = startup.deploy(
        vmHostStartupDeps(),
        selectedConfig,
        props,
        credentialId,
        options,
      );
      await settleWithFakeTimers(workload);
    } finally {
      vi.useRealTimers();
    }
  }

  it('persists the selected VM type on provisioning failures', async () => {
    const id = 'deploy-quota-target-' + Date.now();
    const props = await createDeployProps(id, {
      vmType: ['g6.xlarge', 'p5.48xlarge'],
    });
    deployFlowMocks.classifyError.mockReturnValue(
      CloudFailureDiagnosis.QuotaExhaustedRegion,
    );
    deployFlowMocks.provisionVMs.mockRejectedValueOnce(
      new Error('regional spot quota exceeded'),
    );

    await expect(
      startup.deploy(
        vmHostStartupDeps(),
        { ...cloudConfig, vmType: 'p5.48xlarge', availabilityZone: 'b' },
        props,
        'test-credential-id',
      ),
    ).rejects.toThrow('regional spot quota exceeded');

    const events = await eventLog().getWorkloadEvents(id);
    const retrying = events.find(
      (event) => event.state === WorkloadState.Retrying,
    );
    expect(JSON.parse(retrying!.metadata!)).toMatchObject({
      diagnosis: CloudFailureDiagnosis.QuotaExhaustedRegion,
      targetVmType: 'p5.48xlarge',
      targetRegion: cloudConfig.region,
      targetAvailabilityZone: 'b',
    });
  });

  // backmesh records capacity and quota refusals from these exact keys and
  // values: keep them stable.
  it.each([
    'quota-exhausted-region',
    'quota-exhausted-account',
    'account-regional-spot-quota-exhausted',
    'capacity-exhausted',
  ] as const)(
    "records %s and the launch's region on a --regions Job's Retrying event",
    async (diagnosis) => {
      const id = `deploy-regions-${diagnosis}-${Date.now()}`;
      const props = await createDeployProps(id, {
        region: undefined,
        regions: ['us-east-1', 'us-west-2'],
      });
      deployFlowMocks.classifyError.mockReturnValue(diagnosis);
      deployFlowMocks.provisionVMs.mockRejectedValueOnce(
        new Error(`refused: ${diagnosis}`),
      );
      await expect(
        startup.deploy(
          vmHostStartupDeps(),
          { ...cloudConfig, region: 'us-west-2' },
          props,
          'test-credential-id',
        ),
      ).rejects.toThrow(diagnosis);
      const retrying = (await eventLog().getWorkloadEvents(id)).find(
        (event) => event.state === WorkloadState.Retrying,
      );
      expect(JSON.parse(retrying!.metadata!)).toMatchObject({
        diagnosis,
        targetRegion: 'us-west-2',
      });
    },
  );

  describe('launch failure history', () => {
    const denial = 'ec2:RunInstances';
    beforeEach(() => {
      deployFlowMocks.classifyError.mockReturnValue(
        CloudFailureDiagnosis.PermissionDenied,
      );
      deployFlowMocks.permissionDenial.mockReturnValue({
        action: denial,
        regional: true,
      });
    });

    async function failedDeploy(
      props: StoredWorkload,
      message: string,
      inputBucket?: string,
    ) {
      await expect(
        startup.deploy(
          vmHostStartupDeps(),
          { ...cloudConfig, region: 'us-east-2', inputBucket },
          props,
          'test-credential-id',
        ),
      ).rejects.toThrow(message);
      return queries().getProvisioningFailures(
        props.id,
        'test-credential-id',
        CloudType.AWS,
      );
    }

    it('never turns a failure before the attempt row into a failover target or region denial', async () => {
      const props = await createDeployProps('pre-attempt-' + Date.now(), {
        region: undefined,
      });
      // Storage validation runs before beginProvisioningAttempt: the real
      // provisioner fails there and never reaches the provider launch.
      const hasBucket = vi.fn().mockRejectedValue(new Error(denial));
      const storageProviders = {
        input: () => ({ hasBucket, region: 'us-east-2', type: CloudType.AWS }),
      };
      deployFlowMocks.provisionVMs.mockImplementationOnce(
        (compute: CloudCompute, params: ProvisionParams) =>
          realProvisionVMs(compute, params, storageProviders as any),
      );

      expect(await failedDeploy(props, denial, 'input-bucket')).toEqual([]);
      expect(hasBucket).toHaveBeenCalledOnce();
      expect(await ledger().countAllVMs(props.id)).toBe(0);
      // Status still shows the classified failure.
      const retrying = (await eventLog().getWorkloadEvents(props.id)).find(
        (event) => event.state === WorkloadState.Retrying,
      );
      expect(JSON.parse(retrying!.metadata!)).toMatchObject({
        diagnosis: CloudFailureDiagnosis.PermissionDenied,
        targetRegionDenied: denial,
      });
      // With nothing recorded, the next claim can't skip this target.
      expect(JSON.parse(retrying!.metadata!)).not.toHaveProperty(
        'launchFailover',
      );
    });
  });

  describe('launch classification on the attempt row', () => {
    /** Begin this launch's attempt row, then hand control to `settle`. */
    function launchThen(settle: () => Promise<never>) {
      deployFlowMocks.provisionVMs.mockImplementationOnce(
        async (_compute: CloudCompute, params: ProvisionParams) => {
          const ref = await ledger().beginProvisioningAttempt(
            params.workloadId,
            `${params.workloadId}-0`,
            {
              region: params.cloudConfig.region,
              vmType: params.cloudConfig.vmType,
              credentialId: params.credentialId,
            },
          );
          params.onAttempt?.(ref!);
          return settle();
        },
      );
    }
    const failures = (props: StoredWorkload) =>
      queries().getProvisioningFailures(
        props.id,
        'test-credential-id',
        CloudType.AWS,
      );

    it('is durable when a timed-out launch reaches Retrying', async () => {
      const props = await createDeployProps('timeout-classified-' + Date.now());
      deployFlowMocks.classifyError.mockReturnValue(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
      let failLate!: (error: Error) => void;
      launchThen(
        () =>
          new Promise<never>((_, reject) => {
            failLate = reject;
          }),
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const deploying = expect(
          startup.deploy(
            vmHostStartupDeps(),
            cloudConfig,
            props,
            'test-credential-id',
          ),
        ).rejects.toThrow(/timed out/i);
        // The step deadline is armed once the launch is in flight.
        for (let turns = 0; !failLate; turns++) {
          if (turns > 1000) throw new Error('the launch never started');
          await new Promise((r) => setImmediate(r));
        }
        await vi.advanceTimersByTimeAsync(PROVISIONING_TIMEOUT_MS);
        await deploying;
      } finally {
        vi.useRealTimers();
      }

      // The abandoned launch is still running, so its deferred error
      // callback has not run; the picker must already see a classified row.
      expect((await queries().getWorkload(props.id))!.state).toBe(
        WorkloadState.Retrying,
      );
      // Unclassified, the row would read as an exact-target failover.
      expect(await failures(props)).toMatchObject([
        {
          diagnosis: CloudFailureDiagnosis.TemporaryProviderFailure,
          disposition: FailureDisposition.RetrySameTarget,
        },
      ]);
      failLate(new Error('late provider failure'));
    });

    it('marks a failover recorded on its attempt, for an immediate retry', async () => {
      const props = await createDeployProps('failover-marked-' + Date.now(), {
        region: undefined,
      });
      deployFlowMocks.classifyError.mockReturnValue(
        CloudFailureDiagnosis.CapacityExhausted,
      );
      launchThen(() => Promise.reject(new Error('capacity')));

      await expect(
        startup.deploy(
          vmHostStartupDeps(),
          cloudConfig,
          props,
          'test-credential-id',
        ),
      ).rejects.toThrow('capacity');

      const retrying = (await eventLog().getWorkloadEvents(props.id)).find(
        (event) => event.state === WorkloadState.Retrying,
      );
      expect(JSON.parse(retrying!.metadata!)).toMatchObject({
        disposition: FailureDisposition.FailoverTarget,
        launchFailover: true,
      });
      expect(await failures(props)).toHaveLength(1);
    });

    it.each([
      // The pinned region still offers the Job's other VM types.
      [['m6a.large', 'm7a.large'], FailureDisposition.FailoverTarget],
      [['m6a.large'], FailureDisposition.RetrySameTarget],
    ])(
      'routes a region-pinned capacity failure on VM types %j to %s',
      async (vmType, disposition) => {
        const props = await createDeployProps(
          'pinned-capacity-' + vmType.length + '-' + Date.now(),
          { region: 'us-east-1', vmType },
        );
        deployFlowMocks.classifyError.mockReturnValue(
          CloudFailureDiagnosis.CapacityExhausted,
        );
        launchThen(() => Promise.reject(new Error('capacity')));

        await expect(
          startup.deploy(
            vmHostStartupDeps(),
            // The claim's target is the Job's first type.
            { ...cloudConfig, vmType: vmType[0] },
            props,
            'test-credential-id',
          ),
        ).rejects.toThrow('capacity');

        const retrying = (await eventLog().getWorkloadEvents(props.id)).find(
          (event) => event.state === WorkloadState.Retrying,
        );
        expect(JSON.parse(retrying!.metadata!)).toMatchObject({ disposition });
        // The target picker reads the same disposition from the ledger.
        const ledgered = await failures(props);
        expect(ledgered).toMatchObject([{ disposition }]);
        // ...and so moves a multi-type Job on to its next type.
        const candidates = vmType.map((type) => ({
          vmType: type,
          region: 'us-east-1',
        }));
        expect(pickTarget(candidates, ledgered, CloudType.AWS).vmType).toBe(
          vmType.at(-1),
        );
      },
    );

    it('still moves to Retrying when the classification write fails', async () => {
      const props = await createDeployProps(
        'record-failure-throws-' + Date.now(),
      );
      deployFlowMocks.classifyError.mockReturnValue(
        CloudFailureDiagnosis.TemporaryProviderFailure,
      );
      const record = vi
        .spyOn(ledger(), 'recordLaunchFailure')
        .mockRejectedValueOnce(new Error('ledger unavailable'));
      launchThen(() => Promise.reject(new Error('capacity')));

      await expect(
        startup.deploy(
          vmHostStartupDeps(),
          cloudConfig,
          props,
          'test-credential-id',
        ),
      ).rejects.toThrow('capacity');

      expect(record).toHaveBeenCalledOnce();
      expect((await queries().getWorkload(props.id))!.state).toBe(
        WorkloadState.Retrying,
      );
      record.mockRestore();
    });

    it('survives a failed credential update', async () => {
      const props = await createDeployProps(
        'credential-mark-throws-' + Date.now(),
      );
      deployFlowMocks.classifyError.mockReturnValue(
        CloudFailureDiagnosis.BadCredential,
      );
      deployFlowMocks.markCredentialOnAuthFailure.mockRejectedValueOnce(
        new Error('credential store unavailable'),
      );
      launchThen(() => Promise.reject(new Error('AuthFailure')));

      await expect(
        startup.deploy(
          vmHostStartupDeps(),
          cloudConfig,
          props,
          'test-credential-id',
        ),
      ).rejects.toThrow('AuthFailure');

      expect(
        deployFlowMocks.markCredentialOnAuthFailure,
      ).toHaveBeenCalledOnce();
      expect(await failures(props)).toMatchObject([
        { diagnosis: CloudFailureDiagnosis.BadCredential },
      ]);
    });
  });

  it('always pulls the image and never enters the removed baking state', async () => {
    const id = 'deploy-pulls-image-' + Date.now();
    const props = await createDeployProps(id);
    deployFlowMocks.pullImage.mockResolvedValueOnce({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      elapsedMs: 12_345,
    });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    const store = queries();
    const workload = await store.getWorkload(id);
    const events = await eventLog().getWorkloadEvents(id);
    const states = events.map((event) => event.state);

    expect(workload?.state).toBe(WorkloadState.Running);
    expect(deployFlowMocks.pullImage).toHaveBeenCalledOnce();
    expect(deployFlowMocks.pullImage).toHaveBeenCalledWith(
      expect.anything(),
      props,
      // A CPU VM Job host's Docker is on containerd's parallel unpacks.
      { preferContainerdTransfer: true },
    );
    expect(states).toContain(WorkloadState.Downloading);
    expect(states).toContain(WorkloadState.Starting);
    expect(states).not.toContain('baking');
    const downloading = events.find(
      (event) => event.state === WorkloadState.Downloading,
    );
    expect(JSON.parse(downloading!.metadata!).imagePull).toMatchObject({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      elapsedMs: 12_345,
    });
  });

  it("keeps the host's boot marks, with its container's start, on the Running event", async () => {
    const id = 'deploy-boot-marks-' + Date.now();
    const props = await createDeployProps(id);
    deployFlowMocks.sshExec.mockImplementation(async (command: string) => ({
      stdout: command.startsWith('cat /run/anycloud/boot-marks')
        ? 'prepare-start 6.10\npull-end 14.52\ncontainer-started 19.87\n'
        : '',
      stderr: '',
      code: 0,
    }));

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    const running = (await eventLog().getWorkloadEvents(id)).find(
      (event) => event.state === WorkloadState.Running,
    );
    expect(JSON.parse(running!.metadata!).bootMarks).toEqual({
      'prepare-start': 6.1,
      'pull-end': 14.52,
      'container-started': 19.87,
    });
  });

  it('reaches Running without boot marks when the host has none', async () => {
    const id = 'deploy-no-boot-marks-' + Date.now();
    const props = await createDeployProps(id);

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Running,
    );
    const running = (await eventLog().getWorkloadEvents(id)).find(
      (event) => event.state === WorkloadState.Running,
    );
    expect(running?.metadata ?? null).toBeNull();
  });

  it('injects every named secret into the container environment', async () => {
    const id = 'deploy-secrets-' + Date.now();
    await getCredentialSecretStore().saveSecret('DB', {
      DB_URL: 'postgres://x',
    });
    await getCredentialSecretStore().saveSecret('API', { API_KEY: 'k-1' });
    const props = await createDeployProps(id, { secretNames: ['DB', 'API'] });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    expect(deployFlowMocks.startContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      expect.anything(),
      [
        expect.objectContaining({
          name: 'DB',
          values: { DB_URL: 'postgres://x' },
        }),
        expect.objectContaining({ name: 'API', values: { API_KEY: 'k-1' } }),
      ],
    );
  });

  it('refuses to start a container whose named secret was deleted', async () => {
    const id = 'deploy-missing-secret-' + Date.now();
    const props = await createDeployProps(id, { secretNames: ['GONE'] });

    await expect(
      deployWithVirtualClock(cloudConfig, props, 'test-credential-id'),
    ).rejects.toThrow('Secret "GONE" not found');
    expect(deployFlowMocks.startContainer).not.toHaveBeenCalled();
  });

  it('persists failed pull telemetry before transitioning to retrying', async () => {
    const id = 'deploy-pull-auth-failure-' + Date.now();
    const props = await createDeployProps(id);
    const imagePull = {
      schemaVersion: 1 as const,
      method: 'docker' as const,
      outcome: 'failed' as const,
      elapsedMs: 321,
      reason: 'registry_auth',
    };
    deployFlowMocks.pullImage.mockRejectedValueOnce(
      Object.assign(new Error('GHCR authentication failed'), { imagePull }),
    );

    await expect(
      deployWithVirtualClock(cloudConfig, props, 'test-credential-id'),
    ).rejects.toThrow('GHCR authentication failed');

    const store = queries();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Retrying);
    const downloading = (await eventLog().getWorkloadEvents(id)).find(
      (event) => event.state === WorkloadState.Downloading,
    );
    expect(JSON.parse(downloading!.metadata!).imagePull).toEqual(imagePull);
  });

  it('ends a full-root-disk pull as invalid without retrying', async () => {
    const id = 'deploy-pull-disk-full-' + Date.now();
    const props = await createDeployProps(id);
    deployFlowMocks.pullImage.mockRejectedValueOnce(
      new DeployError("the VM's root disk is full (193G)", 400),
    );

    await expect(
      deployWithVirtualClock(cloudConfig, props, 'test-credential-id'),
    ).rejects.toThrow('root disk is full');

    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Invalid,
    );
  });

  it('does not recycle a healthy input hydrate at the ordinary rclone setup deadline', async () => {
    const id = 'deploy-large-input-' + Date.now();
    const inputConfig: CloudConfig = {
      ...cloudConfig,
      inputBucket: 'large-input-bucket',
      inputStorageRegion: 'us-east-1',
    };
    const props = await createDeployProps(id, {
      inputBucket: 'large-input-bucket',
      inputStorageRegion: 'us-east-1',
    });
    let resolveHydrate!: () => void;
    const hydrate = new Promise<void>((resolve) => {
      resolveHydrate = resolve;
    });
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockReturnValue(hydrate);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const workload = startup.deploy(
        vmHostStartupDeps(),
        inputConfig,
        props,
        'test-credential-id',
      );
      void workload.catch(() => {});

      await vi.waitFor(() => expect(initRclone).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(RCLONE_INIT_TIMEOUT_MS + 1);

      expect(initRclone).toHaveBeenCalledOnce();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Syncing,
      );
      expect(deployFlowMocks.startContainer).not.toHaveBeenCalled();

      resolveHydrate();
      await expect(settleWithFakeTimers(workload)).resolves.toBeUndefined();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );
    } finally {
      resolveHydrate();
      initRclone.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves managed bucket data when retrying an in-place restart', async () => {
    const id = 'deploy-reuse-managed-' + Date.now();
    const bucketHostRoot = '/var/lib/anycloud/deployments';
    const bucketHostPaths = {
      input: `${bucketHostRoot}/input`,
      output: `${bucketHostRoot}/output`,
      checkpoint: `${bucketHostRoot}/checkpoint`,
    };
    const retryConfig: CloudConfig = {
      ...cloudConfig,
      cloudProvider: CloudType.Azure,
      credentials: {
        applicationId: 'test',
        secret: 'test',
        directoryId: 'test',
        subscriptionId: 'test',
      },
      region: 'eastus',
      vmType: 'Standard_B1s',
      outputBucket: 'results-bucket',
      outputStorageRegion: 'eastus',
    };
    const props = await createDeployProps(id, {
      requestedComputeProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_B1s',
      outputBucket: 'results-bucket',
      outputStorageRegion: 'eastus',
    });
    const initialVmCreatedAt = Date.now() - 1_000;
    const initialVmClock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(initialVmCreatedAt);
    try {
      await provisionTestVm(
        id,
        {
          baseImageId: 'ami-base-1',
          cloudId: 'vm-existing',
          ip: '10.0.0.8',
        },
        { region: 'eastus', bucketHostPaths },
      );
    } finally {
      initialVmClock.mockRestore();
    }
    await walkToState(id, WorkloadState.Running);
    expect(
      await getWorkloadLifecycle().claimRecovery(id, WorkloadState.Running, {
        vm: {
          cloudId: 'vm-existing',
          ip: '10.0.0.8',
          markPreempted: true,
        },
      }),
    ).toBe(true);
    expect(
      await getWorkloadLifecycle().finishPreemptionRecovery(
        id,
        WorkloadType.Job,
        'vm-existing',
        { cloudId: 'vm-existing', ip: '10.0.0.8' },
        { region: 'eastus' },
      ),
    ).toBe(true);
    await walkToState(id, WorkloadState.Queued);
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    try {
      await deployWithVirtualClock(retryConfig, props, 'test-credential-id');

      expect(deployFlowMocks.provisionVMs).not.toHaveBeenCalled();
      expect(initRclone).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({ name: 'results-bucket' }),
        }),
        id,
        '10.0.0.8',
        {
          preserveLocalBuckets: true,
          bucketHostPaths,
        },
      );
      expect(deployFlowMocks.startContainer).toHaveBeenCalledWith(
        props,
        expect.objectContaining({
          output: bucketHostPaths.output,
        }),
        [],
      );
    } finally {
      initRclone.mockRestore();
    }
  });

  it('does not trust managed bucket data before the workload ran', async () => {
    const id = 'deploy-reuse-partial-' + Date.now();
    const bucketHostRoot = '/var/lib/anycloud/deployments';
    const bucketHostPaths = {
      input: `${bucketHostRoot}/input`,
      output: `${bucketHostRoot}/output`,
      checkpoint: `${bucketHostRoot}/checkpoint`,
    };
    const retryConfig: CloudConfig = {
      ...cloudConfig,
      cloudProvider: CloudType.Azure,
      credentials: {
        applicationId: 'test',
        secret: 'test',
        directoryId: 'test',
        subscriptionId: 'test',
      },
      region: 'eastus',
      vmType: 'Standard_B1s',
      outputBucket: 'results-bucket',
      outputStorageRegion: 'eastus',
    };
    const props = await createDeployProps(id, {
      requestedComputeProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_B1s',
      outputBucket: 'results-bucket',
      outputStorageRegion: 'eastus',
    });
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.9',
      },
      { region: 'eastus', bucketHostPaths },
    );
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    try {
      await deployWithVirtualClock(retryConfig, props, 'test-credential-id');

      expect(deployFlowMocks.provisionVMs).not.toHaveBeenCalled();
      expect(initRclone).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({ name: 'results-bucket' }),
        }),
        id,
        '10.0.0.9',
        {
          preserveLocalBuckets: false,
          bucketHostPaths,
          // An ordinary workload image may run as a non-root user, so its
          // checkpoint mount stays readable.
        },
      );
    } finally {
      initRclone.mockRestore();
    }
  });

  it('derives the SSH key before reusing existing VMs', async () => {
    const id = 'deploy-reuse-bad-key-' + Date.now();
    const props = await createDeployProps(id);
    await provisionTestVm(
      id,
      { baseImageId: 'ami-base-1', cloudId: 'vm-existing', ip: '10.0.0.21' },
      { credentialId: 'test-credential-id' },
    );

    await expect(
      startup.deploy(
        {
          ...vmHostStartupDeps(),
          derivePublicKey: () => Promise.reject(new Error('bad key')),
        },
        cloudConfig,
        props,
        'test-credential-id',
      ),
    ).rejects.toThrow('bad key');

    expect(
      deployFlowMocks.prepareExistingVmWorkloadStorage,
    ).not.toHaveBeenCalled();
  });

  it('does not pass the workload digest into VM provisioning', async () => {
    const id = 'deploy-no-workload-image-lookup-' + Date.now();
    const props = await createDeployProps(id);

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    const params = deployFlowMocks.provisionVMs.mock.calls[0]?.[1];
    expect(params).not.toHaveProperty('imageDigest');
    expect(deployFlowMocks.pullImage).toHaveBeenCalledOnce();
  });

  it('fails a Service without retrying when the API cannot reach the DNS authorities', async () => {
    const id = 'deploy-server-dns-egress-' + Date.now();
    const props = await createDeployProps(id, {
      workloadType: WorkloadType.Service,
    });
    const blocked = new DNSAuthoritiesUnreachableError(`${id}.anycloud.sh`, [
      'one.ns.example',
      'two.ns.example',
    ]);
    deployFlowMocks.publishServeEndpoint.mockRejectedValueOnce(blocked);

    await expect(
      deployWithVirtualClock(cloudConfig, props, 'test-credential-id'),
    ).rejects.toBe(blocked);

    expect((await queries().getWorkload(id))?.state).toBe(WorkloadState.Failed);
    const failed = (await eventLog().getWorkloadEvents(id)).find(
      (event) => event.state === WorkloadState.Failed,
    );
    expect(JSON.parse(failed!.metadata!)).toMatchObject({
      disposition: FailureDisposition.TerminalFailed,
      error: { message: blocked.message },
    });
  });

  it('pulls a server image before publishing its endpoint', async () => {
    const id = 'deploy-server-pull-' + Date.now();
    const props = await createDeployProps(id, {
      workloadType: WorkloadType.Service,
    });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    expect(deployFlowMocks.pullImage).toHaveBeenCalledOnce();
    expect(deployFlowMocks.publishServeEndpoint).toHaveBeenCalledWith(id, null);
    expect(deployFlowMocks.pullImage.mock.invocationCallOrder[0]).toBeLessThan(
      deployFlowMocks.publishServeEndpoint.mock.invocationCallOrder[0],
    );
  });

  it('keeps a VM on SSH-only ingress', async () => {
    const id = 'deploy-vm-ssh-' + Date.now();
    const props = await createDeployProps(id, {
      workloadType: WorkloadType.Vm,
      image: 'ghcr.io/acme/dev:v1.0.0',
    });
    deployFlowMocks.getContainerStatus.mockReset().mockResolvedValue({
      state: ContainerState.Running,
      exitCode: undefined,
      startedAt: new Date().toISOString(),
    });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    expect(deployFlowMocks.getContainerStatus).toHaveBeenCalledOnce();
    expect(deployFlowMocks.assertVmContainerReady).toHaveBeenCalledWith(id);
    expect(deployFlowMocks.publishServeEndpoint).not.toHaveBeenCalled();
    const provisionParams = deployFlowMocks.provisionVMs.mock
      .calls[0]?.[1] as ProvisionParams;
    expect(
      provisionParams.ingressSpec?.ingress.map((rule) => rule.port),
    ).toEqual([22]);
    // A dev box stays in the default network.
    expect(provisionParams.ingressSpec?.jobNetwork).toBeUndefined();
  });

  it("0053/I1 puts a VM Job's VM in the Jobs network", async () => {
    const id = 'deploy-job-peers-' + Date.now();
    const props = await createDeployProps(id, {
      workloadType: WorkloadType.Job,
    });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    const provisionParams = deployFlowMocks.provisionVMs.mock
      .calls[0]?.[1] as ProvisionParams;
    expect(provisionParams.ingressSpec).toMatchObject({
      ingress: [expect.objectContaining({ port: 22 })],
      jobNetwork: true,
    });
  });

  it('skips endpoint publishing for Local service workloads', async () => {
    const id = 'deploy-server-local-no-dns-' + Date.now();
    const props = await createDeployProps(id, {
      workloadType: WorkloadType.Service,
    });
    const localCloudConfig: CloudConfig = {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    };

    await deployWithVirtualClock(localCloudConfig, props, 'test-credential-id');

    // The container still starts; only the public endpoint is skipped.
    expect(deployFlowMocks.startContainer).toHaveBeenCalled();
    expect(deployFlowMocks.publishServeEndpoint).not.toHaveBeenCalled();
    expect((await queries().getWorkload(id))?.dnsRecordId).toBeNull();
  });

  it('uses the CPU host image for CPU targets without Docker GPU access', async () => {
    const id = 'deploy-cpu-host-image-' + Date.now();
    const props = await createDeployProps(id);

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    const params = deployFlowMocks.provisionVMs.mock.calls[0]?.[1];
    expect(params?.gpuRuntime).toBeNull();
  });

  it('uses the GPU host image when Docker GPU access is explicitly requested', async () => {
    const id = 'deploy-docker-gpus-host-image-' + Date.now();
    const props = await createDeployProps(id, {
      dockerOptions: { gpus: 'all', runtime: 'nvidia' },
    });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id');

    const params = deployFlowMocks.provisionVMs.mock.calls[0]?.[1];
    expect(params?.gpuRuntime).toBe(GpuRuntime.Cuda);
    expect(deployFlowMocks.initializeVM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workloadId: id,
        gpuRuntime: GpuRuntime.Cuda,
        dockerRuntime: 'nvidia',
      }),
    );
    expect(deployFlowMocks.pullImage).toHaveBeenCalledWith(
      expect.anything(),
      props,
      {
        preferContainerdTransfer: true,
      },
    );
  });

  it('uses the GPU host image for resolved GPU VM types', async () => {
    const id = 'deploy-gpu-vm-host-image-' + Date.now();
    const gpuCloudConfig: CloudConfig = {
      ...cloudConfig,
      vmType: 'p5.48xlarge',
    };
    const props = await createDeployProps(id, {
      vmType: 'p5.48xlarge',
    });

    await deployWithVirtualClock(gpuCloudConfig, props, 'test-credential-id');

    const params = deployFlowMocks.provisionVMs.mock.calls[0]?.[1];
    expect(params?.gpuRuntime).toBe(GpuRuntime.Cuda);
    expect(deployFlowMocks.pullImage).toHaveBeenCalledWith(
      expect.anything(),
      props,
      {
        preferContainerdTransfer: true,
      },
    );
  });

  it('deploys Local without compute credentials', async () => {
    const id = 'deploy-local-' + Date.now();
    const localConfig: CloudConfig = {
      cloudProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    };
    const props = await createDeployProps(id, {
      credentialId: null,
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      vmType: 'local',
    });

    await deployWithVirtualClock(localConfig, props);

    const params = deployFlowMocks.provisionVMs.mock.calls[0]?.[1];
    expect(params).toMatchObject({
      cloudConfig: localConfig,
      credentialId: undefined,
    });
    expect((await queries().getWorkload(id))?.state).toBe(
      WorkloadState.Running,
    );
  });

  it('resumes Downloading without replaying completed deploy steps', async () => {
    const id = 'startup-resume-download-' + Date.now();
    const props = await createDeployProps(id);
    const store = queries();
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.11',
      },
      { credentialId: 'test-credential-id' },
    );
    await walkToState(id, WorkloadState.Downloading);

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Downloading,
      replayActiveStep: true,
    });

    expect(deployFlowMocks.provisionVMs).not.toHaveBeenCalled();
    expect(deployFlowMocks.initializeVM).not.toHaveBeenCalled();
    expect(deployFlowMocks.pullImage).toHaveBeenCalledOnce();
    expect(deployFlowMocks.startContainer).toHaveBeenCalledOnce();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
  });

  it('adopts a workload that already exists when Starting is replayed', async () => {
    const id = 'startup-resume-starting-' + Date.now();
    const props = await createDeployProps(id);
    const store = queries();
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.12',
      },
      { credentialId: 'test-credential-id' },
    );
    await walkToState(id, WorkloadState.Starting);
    deployFlowMocks.getContainerStatus
      .mockReset()
      .mockResolvedValue(readyServiceContainerStatus());

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Starting,
      replayActiveStep: true,
    });

    expect(deployFlowMocks.provisionVMs).not.toHaveBeenCalled();
    expect(deployFlowMocks.pullImage).not.toHaveBeenCalled();
    expect(deployFlowMocks.startContainer).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    const replayEvent = (await eventLog().getWorkloadEvents(id))
      .filter((event) => event.state === WorkloadState.Starting)
      .at(-1);
    expect(JSON.parse(replayEvent!.metadata!)).toMatchObject({
      reason: 'active-step-replay',
      resumeFrom: WorkloadState.Starting,
    });
  });

  it('recreates an existing workload during an ordinary retry', async () => {
    const id = 'ordinary-retry-starting-' + Date.now();
    const props = await createDeployProps(id);
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.17',
      },
      { credentialId: 'test-credential-id' },
    );
    await walkToState(id, WorkloadState.Starting);
    deployFlowMocks.getContainerStatus
      .mockReset()
      .mockResolvedValue(readyServiceContainerStatus());

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Starting,
    });

    expect(deployFlowMocks.startContainer).toHaveBeenCalledOnce();
    expect(deployFlowMocks.getContainerStatus).toHaveBeenCalledOnce();
    expect(
      deployFlowMocks.startContainer.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deployFlowMocks.getContainerStatus.mock.invocationCallOrder[0]!,
    );
    const retryEvent = (await eventLog().getWorkloadEvents(id))
      .filter((event) => event.state === WorkloadState.Starting)
      .at(-1);
    expect(retryEvent?.metadata).toBeNull();
  });

  it('starts a missing workload while resuming Starting', async () => {
    const id = 'startup-resume-missing-' + Date.now();
    const props = await createDeployProps(id);
    const store = queries();
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.13',
      },
      { credentialId: 'test-credential-id' },
    );
    await walkToState(id, WorkloadState.Starting);
    deployFlowMocks.getContainerStatus
      .mockResolvedValueOnce({ state: ContainerState.NotFound })
      .mockResolvedValue(readyServiceContainerStatus());

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Starting,
      replayActiveStep: true,
    });

    expect(deployFlowMocks.startContainer).toHaveBeenCalledOnce();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
  });

  it.each([
    ContainerState.Created,
    ContainerState.Paused,
    ContainerState.Dead,
    ContainerState.Exited,
    ContainerState.Restarting,
  ])(
    'recreates a %s Service workload while resuming Starting',
    async (state) => {
      const id = `startup-resume-server-${state}-${Date.now()}`;
      const props = await createDeployProps(id, {
        workloadType: WorkloadType.Service,
      });
      const store = queries();
      await provisionTestVm(
        id,
        {
          baseImageId: 'ami-base-1',
          cloudId: 'vm-existing',
          ip: '10.0.0.14',
        },
        { credentialId: 'test-credential-id' },
      );
      await walkToState(id, WorkloadState.Starting);
      deployFlowMocks.getContainerStatus
        .mockReset()
        .mockResolvedValueOnce({
          state,
          ...(state === ContainerState.Exited ? { exitCode: 1 } : {}),
        })
        .mockResolvedValue(readyServiceContainerStatus());

      await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
        resumeFrom: WorkloadState.Starting,
        replayActiveStep: true,
      });

      expect(deployFlowMocks.startContainer).toHaveBeenCalledOnce();
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    },
  );

  it('adopts a Job that exited successfully before Starting was persisted', async () => {
    const id = 'startup-resume-completed-job-' + Date.now();
    const props = await createDeployProps(id);
    const store = queries();
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.15',
      },
      { credentialId: 'test-credential-id' },
    );
    await walkToState(id, WorkloadState.Starting);
    deployFlowMocks.getContainerStatus.mockReset().mockResolvedValue({
      state: ContainerState.Exited,
      exitCode: 0,
    });

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Starting,
      replayActiveStep: true,
    });

    expect(deployFlowMocks.startContainer).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
  });

  it.each([1, undefined])(
    'reruns a Job that exited with code %s while resuming Starting',
    async (exitCode) => {
      const id = `startup-resume-failed-job-${exitCode}-${Date.now()}`;
      const props = await createDeployProps(id);
      const store = queries();
      await provisionTestVm(
        id,
        {
          baseImageId: 'ami-base-1',
          cloudId: 'vm-existing',
          ip: '10.0.0.20',
        },
        { credentialId: 'test-credential-id' },
      );
      await walkToState(id, WorkloadState.Starting);
      deployFlowMocks.getContainerStatus
        .mockReset()
        .mockResolvedValueOnce({ state: ContainerState.Exited, exitCode })
        .mockResolvedValue(readyServiceContainerStatus());

      await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
        resumeFrom: WorkloadState.Starting,
        replayActiveStep: true,
      });

      // Replay observes the exited container first, then recreates it.
      expect(deployFlowMocks.startContainer).toHaveBeenCalledOnce();
      expect(
        deployFlowMocks.getContainerStatus.mock.invocationCallOrder[0],
      ).toBeLessThan(
        deployFlowMocks.startContainer.mock.invocationCallOrder[0],
      );
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    },
  );

  it('waits for a restarting Job instead of duplicating it', async () => {
    const id = 'startup-resume-restarting-job-' + Date.now();
    const props = await createDeployProps(id);
    const store = queries();
    await provisionTestVm(
      id,
      {
        baseImageId: 'ami-base-1',
        cloudId: 'vm-existing',
        ip: '10.0.0.16',
      },
      { credentialId: 'test-credential-id' },
    );
    await walkToState(id, WorkloadState.Starting);
    deployFlowMocks.getContainerStatus
      .mockReset()
      .mockResolvedValueOnce({ state: ContainerState.Restarting })
      .mockResolvedValue(readyServiceContainerStatus());

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Starting,
      replayActiveStep: true,
    });

    expect(deployFlowMocks.startContainer).not.toHaveBeenCalled();
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
  });

  it('uses the exact unresolved provisioning attempt selected by recovery', async () => {
    const id = 'startup-resume-provision-' + Date.now();
    const props = await createDeployProps(id);
    const store = queries();
    await walkToState(id, WorkloadState.Provisioning);
    const attempt = await ledger().beginProvisioningAttempt(id, `${id}-0`, {
      region: cloudConfig.region,
      vmType: cloudConfig.vmType,
      credentialId: 'test-credential-id',
    });
    expect(attempt).not.toBeNull();

    await deployWithVirtualClock(cloudConfig, props, 'test-credential-id', {
      resumeFrom: WorkloadState.Provisioning,
      existingAttempt: attempt!,
      replayActiveStep: true,
    });

    expect(deployFlowMocks.provisionVMs.mock.calls[0]?.[1]).toMatchObject({
      existingAttempt: attempt!,
    });
    expect(
      deployFlowMocks.startContainer.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deployFlowMocks.getContainerStatus.mock.invocationCallOrder[0]!,
    );
    expect(await ledger().getProvisioningAttempts(id)).toHaveLength(1);
    expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    const provisioningEvent = (await eventLog().getWorkloadEvents(id))
      .filter((event) => event.state === WorkloadState.Provisioning)
      .at(-1)!;
    expect(JSON.parse(provisioningEvent.metadata!)).toMatchObject({
      reason: 'active-step-replay',
      resumeFrom: WorkloadState.Provisioning,
      provisioningIntent: {
        cloudProvider: CloudType.AWS,
        availabilityZone: null,
        region: 'us-east-1',
        vmType: 't3.micro',
        credentialId: 'test-credential-id',
      },
    });
  });

  it('runs the checkpoint postamble after fresh provisioning', async () => {
    const id = 'provision-postamble-fresh-' + Date.now();
    const spotConfig = { ...cloudConfig, spot: true };
    const props = await createDeployProps(id, { spot: true });
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    try {
      await deployWithVirtualClock(spotConfig, props, 'test-credential-id');

      expect(deployFlowMocks.provisionVMs).toHaveBeenCalledOnce();
      expect(deployFlowMocks.checkpointUpsertBucket).toHaveBeenCalledWith(
        id,
        config.currVersion,
        id,
        props.userId,
      );
      expect(deployFlowMocks.checkpointUpsertBucket).toHaveBeenCalledOnce();
    } finally {
      initRclone.mockRestore();
    }
  });

  it('does not create an implicit checkpoint bucket when an explicit bucket overrides spot during fresh provisioning', async () => {
    const id = 'provision-explicit-checkpoint-fresh-' + Date.now();
    const checkpointBucket = 'user-owned-checkpoint';
    const spotConfig = { ...cloudConfig, spot: true, checkpointBucket };
    const props = await createDeployProps(id, {
      spot: true,
      checkpointBucket,
    });
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    try {
      await deployWithVirtualClock(spotConfig, props, 'test-credential-id');

      expect(deployFlowMocks.provisionVMs).toHaveBeenCalledOnce();
      expect(deployFlowMocks.checkpointUpsertBucket).not.toHaveBeenCalled();
    } finally {
      initRclone.mockRestore();
    }
  });

  it('replays the checkpoint postamble before advancing a durable VM row', async () => {
    const id = 'provision-postamble-replay-' + Date.now();
    const spotConfig = { ...cloudConfig, spot: true };
    await createDeployProps(id, { spot: true });
    const store = queries();
    await provisionTestVm(
      id,
      { cloudId: 'vm-already-durable', ip: '10.0.0.18' },
      {
        region: spotConfig.region,
        vmType: spotConfig.vmType,
        credentialId: 'test-credential-id',
      },
    );
    await walkToState(id, WorkloadState.Provisioning);
    const props = (await store.getWorkload(id))!;
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    try {
      await deployWithVirtualClock(spotConfig, props, 'test-credential-id', {
        resumeFrom: WorkloadState.Provisioning,
        replayActiveStep: true,
      });

      expect(deployFlowMocks.provisionVMs).not.toHaveBeenCalled();
      expect(deployFlowMocks.checkpointUpsertBucket).toHaveBeenCalledWith(
        id,
        config.currVersion,
        id,
        props.userId,
      );
      expect(deployFlowMocks.checkpointUpsertBucket).toHaveBeenCalledOnce();
      const events = await eventLog().getWorkloadEvents(id);
      const replay = events
        .filter((event) => event.state === WorkloadState.Provisioning)
        .at(-1)!;
      expect(events.find((event) => event.id > replay.id)?.state).toBe(
        WorkloadState.Initializing,
      );
    } finally {
      initRclone.mockRestore();
    }
  });

  it('does not create an implicit checkpoint bucket when replaying spot with an explicit bucket', async () => {
    const id = 'provision-explicit-checkpoint-replay-' + Date.now();
    const checkpointBucket = 'user-owned-checkpoint';
    const spotConfig = { ...cloudConfig, spot: true, checkpointBucket };
    await createDeployProps(id, { spot: true, checkpointBucket });
    const store = queries();
    await provisionTestVm(
      id,
      { cloudId: 'vm-explicit-checkpoint-durable', ip: '10.0.0.19' },
      {
        region: spotConfig.region,
        vmType: spotConfig.vmType,
        credentialId: 'test-credential-id',
      },
    );
    await walkToState(id, WorkloadState.Provisioning);
    const props = (await store.getWorkload(id))!;
    const initRclone = vi
      .spyOn(SupervisorManager.prototype, 'initRclone')
      .mockResolvedValue(undefined);

    try {
      await deployWithVirtualClock(spotConfig, props, 'test-credential-id', {
        resumeFrom: WorkloadState.Provisioning,
        replayActiveStep: true,
      });

      expect(deployFlowMocks.provisionVMs).not.toHaveBeenCalled();
      expect(deployFlowMocks.checkpointUpsertBucket).not.toHaveBeenCalled();
      expect((await store.getWorkload(id))?.state).toBe(WorkloadState.Running);
    } finally {
      initRclone.mockRestore();
    }
  });

  it('waits for SSH and Docker before pulling on a restarted VM', async () => {
    const id = 'resume-pulls-image-' + Date.now();
    const props = await createDeployProps(id, { spot: true });
    await provisionTestVm(id, {
      baseImageId: 'ami-base-1',
      cloudId: 'vm-restarted',
      ip: '10.0.0.9',
    });
    await walkToState(id, WorkloadState.Starting);

    await startup.resumeOnExistingVM(vmHostStartupDeps(), cloudConfig, props);

    const readyCall = deployFlowMocks.sshExec.mock.calls.findIndex(
      ([command]) => String(command).includes('echo "ready"'),
    );
    expect(readyCall).toBeGreaterThanOrEqual(0);
    expect(deployFlowMocks.dockerPing).toHaveBeenCalledWith(1);
    expect(deployFlowMocks.dockerPing.mock.invocationCallOrder[0]).toBeLessThan(
      deployFlowMocks.pullImage.mock.invocationCallOrder[0],
    );
    expect(deployFlowMocks.pullImage.mock.invocationCallOrder[0]).toBeLessThan(
      deployFlowMocks.startContainer.mock.invocationCallOrder[0],
    );
  });

  it('bounds Docker readiness polling without leaving a background poll', async () => {
    const id = 'resume-docker-not-ready-' + Date.now();
    const props = await createDeployProps(id, { spot: true });
    await provisionTestVm(id, {
      baseImageId: 'ami-base-1',
      cloudId: 'vm-restarted',
      ip: '10.0.0.10',
    });
    await walkToState(id, WorkloadState.Starting);
    deployFlowMocks.dockerPing.mockResolvedValue(false);

    vi.useFakeTimers();
    try {
      const resume = startup.resumeOnExistingVM(
        vmHostStartupDeps(),
        cloudConfig,
        props,
      );
      void resume.catch(() => {});
      await vi.waitFor(() =>
        expect(deployFlowMocks.dockerPing).toHaveBeenCalled(),
      );
      await vi.advanceTimersByTimeAsync(INITIALIZATION_TIMEOUT_MS);
      await expect(resume).rejects.toThrow('Docker readiness timed out');

      const pollCount = deployFlowMocks.dockerPing.mock.calls.length;
      expect(pollCount).toBeGreaterThan(1);
      expect(deployFlowMocks.dockerPing).toHaveBeenLastCalledWith(1);
      expect(deployFlowMocks.pullImage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deployFlowMocks.dockerPing).toHaveBeenCalledTimes(pollCount);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('GPU check after an in-place restart', () => {
    const gpuConfig: CloudConfig = { ...cloudConfig, vmType: 'g6.xlarge' };

    const GONE = 'No devices were found\nexit=6';
    const LISTED = 'GPU 0: NVIDIA L4 (UUID: GPU-0f1e2d3c)\nCUresult 0\nexit=0';
    // When each probe ran; the last output repeats.
    let probedAt: number[];

    async function resumeGpuVm(id: string, ...probeOutputs: string[]) {
      const props = await createDeployProps(id, {
        spot: true,
        vmType: 'g6.xlarge',
      });
      await provisionTestVm(id, { cloudId: 'vm-restarted', ip: '10.0.0.11' });
      await walkToState(id, WorkloadState.Starting);
      probedAt = [];
      deployFlowMocks.sshExec.mockImplementation(async (command: string) => {
        if (!command.includes('nvidia-smi')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        probedAt.push(Date.now());
        const stdout =
          probeOutputs[Math.min(probedAt.length, probeOutputs.length) - 1];
        return { stdout, stderr: '', code: 0 };
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        await settleWithFakeTimers(
          startup.resumeOnExistingVM(vmHostStartupDeps(), gpuConfig, props),
        );
      } finally {
        vi.useRealTimers();
      }
    }

    it('releases a VM whose GPU is gone and never starts the command', async () => {
      const id = 'resume-gpu-gone-' + Date.now();
      await expect(resumeGpuVm(id, GONE)).rejects.toThrow(
        'No usable GPU on 10.0.0.11',
      );
      // Three tries, 20 s apart.
      expect(probedAt[1] - probedAt[0]).toBeGreaterThanOrEqual(20_000);
      expect(probedAt[2] - probedAt[1]).toBeGreaterThanOrEqual(20_000);
      expect(probedAt).toHaveLength(3);

      expect(deployFlowMocks.pullImage).not.toHaveBeenCalled();
      expect(deployFlowMocks.startContainer).not.toHaveBeenCalled();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Retrying,
      );
      // Counts toward UNUSABLE_GPU_MAX_RETRIES.
      expect(
        await eventLog().countFailureDiagnosis(id, UNUSABLE_GPU_DIAGNOSIS),
      ).toBe(1);
      // The retry provisions a fresh VM instead of reusing this one.
      const [revision] = (await eventLog().getWorkloadEvents(id)).slice(-1);
      expect(
        await getWorkloadLifecycle().getRetryVMEligibility(id, revision.id),
      ).toBe('ready');
    });

    it('resumes as before when the GPU is listed', async () => {
      const id = 'resume-gpu-ok-' + Date.now();
      await resumeGpuVm(id, LISTED);

      expect(probedAt).toHaveLength(1);
      expect(deployFlowMocks.startContainer).toHaveBeenCalled();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );
    });

    it('resumes when a GPU busy on the first try takes a context on the next', async () => {
      const id = 'resume-gpu-late-' + Date.now();
      const busy =
        'GPU 0: NVIDIA L4 (UUID: GPU-0f1e2d3c)\nCUresult 46\nexit=46';
      await resumeGpuVm(id, busy, LISTED);

      expect(probedAt).toHaveLength(2);
      expect(deployFlowMocks.startContainer).toHaveBeenCalled();
      expect((await queries().getWorkload(id))?.state).toBe(
        WorkloadState.Running,
      );
    });

    it('never reuses the VM when its teardown throws', async () => {
      const id = 'resume-gpu-teardown-' + Date.now();
      // Teardown's first read fails, before it would claim the VM's removal.
      const read = vi
        .spyOn(ledger(), 'getProvisioningAttempts')
        .mockRejectedValue(new Error('ledger unavailable'));
      try {
        await expect(resumeGpuVm(id, GONE)).rejects.toThrow('No usable GPU');
      } finally {
        read.mockRestore();
      }

      const [revision] = (await eventLog().getWorkloadEvents(id)).slice(-1);
      expect(
        await getWorkloadLifecycle().getRetryVMEligibility(id, revision.id),
      ).toBe('release-pending');
    });
  });
});
