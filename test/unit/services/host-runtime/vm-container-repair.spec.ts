import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { getDB } from '../../../../src/api/services/repositories/db.js';

vi.mock('../../../../src/api/services/host-runtime/image-delivery', () => ({
  pullImage: vi.fn(),
}));

import { reconcileRunningVmContainer } from '../../../../src/api/services/host-runtime/vm-container-repair';
import { TEST_AWS_CRED } from '../../helpers/fixtures';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { ContainerState } from '../../../../src/shared/runtime.js';
import {
  walkToState,
  provisionTestVm,
} from '../../../helpers/workload-store.js';
import { resetTestStore } from '../../utils';
import config from '../../../../src/api/config';
import {
  encryptCredential,
  hashCredential,
} from '../../../../src/api/services/cloud-config';
import { DockerManager } from '../../../../src/api/services/docker';
import { pullImage } from '../../../../src/api/services/host-runtime/image-delivery';
import {
  getProvisioningAttemptStore as ledger,
  getWorkloadQueryStore as queries,
} from '../../../../src/api/services/persistence.js';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import type { ProvisioningAttemptRef } from '../../../../src/api/services/entities.js';

describe('running VM container reconciliation', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetTestStore();
  });

  async function createRunningVm(
    id: string,
    liveVm = true,
    pendingCloudId?: string,
  ): Promise<ProvisioningAttemptRef | undefined> {
    const credentialId = hashCredential(TEST_AWS_CRED);
    await upsertCredential(
      getDB(),
      credentialId,
      await encryptCredential(TEST_AWS_CRED),
      CloudType.AWS,
    );
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'vm',
      image: 'ghcr.io/acme/dev:latest',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.large',
      spot: false,
      dockerCommand: 'docker run vm',
      sshPrivateKey: 'private-key',
      credentialId,
    });
    if (liveVm) {
      await provisionTestVm(
        id,
        { ip: '203.0.113.50', cloudId: 'i-vm' },
        {
          region: 'us-east-1',
          vmType: 't3.large',
          credentialId,
        },
      );
    }
    const pending =
      pendingCloudId === undefined
        ? undefined
        : await provisionTestVm(
            id,
            { cloudId: pendingCloudId },
            { region: 'us-east-1', vmType: 't3.large' },
          );
    await walkToState(id, WorkloadState.Running);
    return pending;
  }

  it('does nothing to a healthy running container', async () => {
    const id = 'vm-reconcile-healthy';
    await createRunningVm(id);
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer').mockResolvedValue({
      kind: 'managed',
      state: ContainerState.Running,
    });
    const create = vi.spyOn(DockerManager.prototype, 'createContainerIfAbsent');

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'healthy',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ContainerState.Exited,
    ContainerState.Paused,
    ContainerState.Restarting,
  ])('observes a %s container without mutating it', async (state) => {
    const id = `vm-reconcile-${state}`;
    await createRunningVm(id);
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer').mockResolvedValue({
      kind: 'managed',
      state,
    });
    const create = vi.spyOn(DockerManager.prototype, 'createContainerIfAbsent');

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'observed',
      state,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('defers when the live VM ledger row is missing', async () => {
    const id = 'vm-reconcile-no-host';
    await createRunningVm(id, false);
    const inspect = vi.spyOn(DockerManager.prototype, 'inspectVmContainer');

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'deferred',
      reason: 'expected one live VM ledger row, found 0',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('converges when the second inspection finds a running container', async () => {
    const id = 'vm-reconcile-second-inspect';
    await createRunningVm(id);
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer')
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({
        kind: 'managed',
        state: ContainerState.Running,
      });
    const imageCheck = vi.spyOn(DockerManager.prototype, 'hasWorkloadImage');
    const create = vi.spyOn(DockerManager.prototype, 'createContainerIfAbsent');

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'converged',
      repairAttempted: true,
    });
    expect(imageCheck).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('test:0036/S11 recreates NotFound on the same host from the immutable stored specification', async () => {
    const id = 'vm-reconcile-create';
    await createRunningVm(id);
    const specs = await getDB().query('SELECT * FROM container_specs');
    const vms = await queries().getVMs(id);
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer')
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'missing' });
    vi.spyOn(DockerManager.prototype, 'hasWorkloadImage').mockResolvedValue(
      true,
    );
    const pull = vi.mocked(pullImage);
    const create = vi
      .spyOn(DockerManager.prototype, 'createContainerIfAbsent')
      .mockImplementation(async (workload, _secrets, stillEligible) => {
        expect(workload.imageDigest).toBe(`sha256:${'a'.repeat(64)}`);
        expect(workload.registryUsername).toBe('x-access-token');
        expect(await stillEligible?.()).toBe(true);
        return { outcome: 'created' };
      });
    const ready = vi
      .spyOn(DockerManager.prototype, 'assertVmContainerReady')
      .mockResolvedValue(undefined);

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'created',
      repairAttempted: true,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledWith(id);
    expect(await getDB().query('SELECT * FROM container_specs')).toEqual(specs);
    expect(await queries().getVMs(id)).toEqual(vms);
  });

  it('pulls the stored image before creating when it is absent', async () => {
    const id = 'vm-reconcile-pull';
    await createRunningVm(id);
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer')
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'missing' });
    vi.spyOn(DockerManager.prototype, 'hasWorkloadImage').mockResolvedValue(
      false,
    );
    const pull = vi.mocked(pullImage).mockResolvedValueOnce({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      elapsedMs: 1,
    });
    vi.spyOn(
      DockerManager.prototype,
      'createContainerIfAbsent',
    ).mockResolvedValue({ outcome: 'already-running' });

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'converged',
      repairAttempted: true,
    });
    expect(pull).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id,
        imageDigest: `sha256:${'a'.repeat(64)}`,
      }),
      { preferContainerdTransfer: false },
    );
  });

  it('fences a termination race immediately before creation', async () => {
    const id = 'vm-reconcile-termination-race';
    await createRunningVm(id);
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer')
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'missing' });
    vi.spyOn(DockerManager.prototype, 'hasWorkloadImage').mockResolvedValue(
      true,
    );
    vi.spyOn(
      DockerManager.prototype,
      'createContainerIfAbsent',
    ).mockImplementation(async (_workload, _secrets, stillEligible) => {
      await walkToState(id, WorkloadState.Terminated);
      expect(await stillEligible?.()).toBe(false);
      return { outcome: 'aborted' };
    });
    const ready = vi.spyOn(DockerManager.prototype, 'assertVmContainerReady');

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'stale',
      repairAttempted: true,
    });
    expect(ready).not.toHaveBeenCalled();
  });

  it('fences a second live VM row that appears immediately before creation', async () => {
    const id = 'vm-reconcile-second-host';
    // An attempt begun while Provisioning resolves after the workload is Running.
    const pending = await createRunningVm(id, true, 'i-vm-second');
    vi.spyOn(DockerManager.prototype, 'inspectVmContainer')
      .mockResolvedValueOnce({ kind: 'missing' })
      .mockResolvedValueOnce({ kind: 'missing' });
    vi.spyOn(DockerManager.prototype, 'hasWorkloadImage').mockResolvedValue(
      true,
    );
    vi.spyOn(
      DockerManager.prototype,
      'createContainerIfAbsent',
    ).mockImplementation(async (_workload, _secrets, stillEligible) => {
      await ledger().completeProvisioningAttempt(id, pending!, {
        ip: '203.0.113.51',
        cloudId: 'i-vm-second',
      });
      expect(await stillEligible?.()).toBe(false);
      return { outcome: 'aborted' };
    });

    await expect(reconcileRunningVmContainer(id)).resolves.toEqual({
      outcome: 'stale',
      repairAttempted: true,
    });
  });
});
