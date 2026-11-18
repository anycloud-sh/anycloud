import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fake, compute } = await vi.hoisted(async () => {
  const { createFakeTransport } = await import('../helpers/mock-transport');
  return {
    fake: createFakeTransport(),
    compute: {
      terminateVMs: vi.fn(),
      terminateNetworking: vi.fn(),
      releaseConfirmationPolicy: {
        requiredReleaseObservations: 1,
        minObservationIntervalMs: 0,
      },
      observeVMReleaseOnce: vi.fn(),
    },
  };
});

vi.mock('../../../src/api/services/gateways/transport', () => ({
  createTransport: vi.fn(() => fake),
}));

vi.mock('../../../src/api/services/cloud-config', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../src/api/services/cloud-config')
    >();
  return {
    ...real,
    createComputeProvider: vi.fn((config: CloudConfig) => ({
      ...compute,
      type: config.cloudProvider,
      region: config.region ?? '',
    })),
    // Same-account AWS checkpoints flush with a freshly minted token.
    createCheckpointStorageProvider: vi.fn(() => ({
      type: 'AWS',
      region: 'us-east-1',
      validateScopedStorageTokenSource: vi.fn(),
      mintScopedStorageToken: vi.fn(async () => ({
        credentials: {
          cloudProvider: 'AWS',
          accessKeyId: 'scoped',
          secretAccessKey: 'scoped',
          sessionToken: 'scoped',
        },
        expiresAt: Date.now() + 3_600_000,
      })),
    })),
  };
});

import {
  teardownServiceVMs,
  terminateServiceStep,
} from '../../../src/api/services/host-runtime/termination';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { resetTestStore } from '../utils';
import { CloudType, type CloudConfig } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import {
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
} from '../../../src/api/services/gateways/cloud';
import config from '../../../src/api/config';
import { getWorkloadQueryStore as queries } from '../../../src/api/services/persistence.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../../src/api/services/repositories/db.js';

const cloudConfig = {
  cloudProvider: CloudType.AWS,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
  region: 'us-east-1',
  vmType: 't3.small',
  checkpointBucket: 'server-state',
};

async function createService(
  id: string,
  state = WorkloadState.Running,
): Promise<void> {
  await createWorkload(getDB(), {
    id,
    userId: 'test-user',
    workloadType: WorkloadType.Service,
    image: 'api:latest',
    region: 'us-east-1',
    vmType: 't3.small',
    checkpointBucket: 'server-state',
    dockerCommand: 'docker run api:latest',
    sshPrivateKey: 'private-key',
  });
  if (state !== WorkloadState.Running) {
    await walkToState(id, WorkloadState.Running);
    await walkToState(id, state);
  }
  await provisionTestVm(id, {
    ip: '203.0.113.10',
    cloudId: 'i-server',
  });
  if (state === WorkloadState.Running) await walkToState(id, state);
}

function configureSuccessfulFlush(): void {
  fake
    .on("docker inspect --format '{{.State.Running}}'", 'true\n')
    .on('ps -p 1 -o comm=', '')
    .on('ac-final-checkpoint', 'DONE 0\n')
    .default('');
}

describe('Service checkpoint teardown', () => {
  beforeEach(async () => {
    await resetTestStore();
    config.cipherKey = 'a'.repeat(64);
    fake.reset();
    vi.clearAllMocks();
    compute.terminateVMs.mockImplementation(async (ids: string[]) => ids);
    compute.terminateNetworking.mockResolvedValue(undefined);
    compute.observeVMReleaseOnce.mockResolvedValue(VM_PRESENT);
  });

  it('stops the container, stops continuous sync, flushes, then replaces the VM', async () => {
    const id = 'server-upgrade-flush';
    await createService(id);
    configureSuccessfulFlush();

    await teardownServiceVMs(cloudConfig, id);

    const stopIndex = fake.commands.findIndex((command) =>
      command.includes('docker stop --time 30'),
    );
    const stopSyncIndex = fake.commands.findIndex((command) =>
      command.includes('pkill -x rclone'),
    );
    const flushIndex = fake.commands.findIndex((command) =>
      command.includes('rclone copy /mnt/checkpoint s3:server-state'),
    );
    const tokenIndex = fake.commands.findIndex((command) =>
      command.includes("AWS_SESSION_TOKEN='scoped'"),
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(stopSyncIndex).toBeGreaterThan(stopIndex);
    expect(tokenIndex).toBeGreaterThan(stopSyncIndex);
    expect(flushIndex).toBeGreaterThan(tokenIndex);
    expect(compute.terminateVMs).toHaveBeenCalledWith(['i-server']);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('keeps a live VM registered when the final checkpoint flush fails', async () => {
    const id = 'server-terminate-flush-fails';
    await createService(id);
    fake
      .on("docker inspect --format '{{.State.Running}}'", 'true\n')
      .on('ps -p 1 -o comm=', '')
      .on('nohup sh -c', new Error('storage unavailable'))
      .default('');

    await expect(terminateServiceStep(cloudConfig, id)).rejects.toThrow(
      'storage unavailable',
    );

    expect(compute.terminateVMs).not.toHaveBeenCalled();
    expect(compute.terminateNetworking).not.toHaveBeenCalled();
    expect(await queries().getVMs(id)).toHaveLength(1);
  });

  it('continues cleanup when the provider confirms the VM is already gone', async () => {
    const id = 'server-terminate-vm-gone';
    await createService(id);
    compute.observeVMReleaseOnce.mockResolvedValue(VM_RELEASE_CANDIDATE);
    fake
      .on("docker inspect --format '{{.State.Running}}'", {
        code: 1,
        stderr: 'connection closed',
      })
      .on('docker info', { code: 1 })
      .default('');

    await terminateServiceStep(cloudConfig, id);

    expect(compute.terminateVMs).toHaveBeenCalledWith(['i-server']);
    expect(compute.terminateNetworking).toHaveBeenCalledWith(id);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });

  it('never races two live Service VMs into the same checkpoint bucket', async () => {
    const id = 'server-ambiguous-vms';
    await createService(id, WorkloadState.Provisioning);
    await provisionTestVm(id, {
      ip: '203.0.113.11',
      cloudId: 'i-server-2',
    });
    await walkToState(id, WorkloadState.Running);
    configureSuccessfulFlush();

    await expect(teardownServiceVMs(cloudConfig, id)).rejects.toThrow(
      `Refusing to checkpoint Service ${id}: expected at most one live VM, found 2`,
    );

    expect(fake.exec).not.toHaveBeenCalled();
    expect(compute.terminateVMs).not.toHaveBeenCalled();
    expect(await queries().getVMs(id)).toHaveLength(2);
  });

  it('does not upload a replacement VM that has not reached Running', async () => {
    const id = 'server-partial-replacement';
    await createService(id, WorkloadState.Provisioning);
    configureSuccessfulFlush();

    await teardownServiceVMs(cloudConfig, id);

    expect(fake.exec).not.toHaveBeenCalled();
    expect(compute.terminateVMs).toHaveBeenCalledWith(['i-server']);
    expect(await queries().getVMs(id)).toHaveLength(0);
  });
});
