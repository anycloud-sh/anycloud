import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { randomBytes } from 'node:crypto';
import config from '../../../src/api/config.js';
import { DockerManager } from '../../../src/api/services/docker.js';
import { deliverLiveSecretFiles } from '../../../src/api/services/live-secret-files.js';
import { writeAdoptedSecretFiles } from '../../../src/api/services/host-runtime/host-startup.js';
import type { CloudConfig } from '../../../src/shared/cloud.js';
import { log } from '../../../src/api/services/logger.js';
import {
  getCredentialSecretStore as secrets,
  getWorkloadQueryStore as queries,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import {
  drainWorkloadWork,
  trackWorkloadWork,
} from '../../../src/api/services/workload-work-registry.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';
import {
  provisionTestVm,
  releaseTestVms,
  walkToState,
} from '../../helpers/workload-store.js';

const ID = 'live-secret-job';

async function workload() {
  const row = await queries().getWorkload(ID);
  if (!row) throw new Error('Missing fixture');
  return row;
}

describe('live Secret file delivery', () => {
  let held: Map<string, string | null>;
  let read: MockInstance<DockerManager['readSecretFileRevisions']>;
  let write: MockInstance<DockerManager['writeSecretFiles']>;

  beforeEach(async () => {
    resetPersistence();
    config.cipherKey = randomBytes(32).toString('hex');
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES ('compute', '', 'AWS')`,
    );
    await secrets().saveSecret('hf', { HF_TOKEN: 'old' });
    await createWorkload(getDB(), {
      id: ID,
      userId: 'test-user',
      workloadType: WorkloadType.Job,
      image: 'alpine',
      dockerCommand: '',
      sshPrivateKey: 'test-key',
      credentialId: 'compute',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.small',
      spot: false,
      secretNames: ['hf'],
    });
    await provisionTestVm(ID, { cloudId: 'vm-1', ip: '192.0.2.1' });
    await walkToState(ID, WorkloadState.Running);
    held = new Map([['hf', null]]);
    read = vi
      .spyOn(DockerManager.prototype, 'readSecretFileRevisions')
      .mockImplementation(async () => new Map(held));
    write = vi
      .spyOn(DockerManager.prototype, 'writeSecretFiles')
      .mockImplementation(async (secret) => {
        held.set(secret.name, secret.revision);
      });
  });

  afterEach(async () => {
    await drainWorkloadWork(ID);
    vi.restoreAllMocks();
  });

  it('writes the newest revision to a host that lacks it, then nothing', async () => {
    await deliverLiveSecretFiles(await workload());
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({
      name: 'hf',
      revision: await secrets().getSecretRevision('hf'),
      values: { HF_TOKEN: 'old' },
    });

    await deliverLiveSecretFiles(await workload());
    expect(write).toHaveBeenCalledTimes(1);

    await secrets().saveSecret('hf', { HF_TOKEN: 'new' });
    await deliverLiveSecretFiles(await workload());
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0].values).toEqual({ HF_TOKEN: 'new' });
    expect(held.get('hf')).toBe(await secrets().getSecretRevision('hf'));

    // A rebooted host lost /run: the symlink is missing, so it is rewritten.
    held.set('hf', null);
    await deliverLiveSecretFiles(await workload());
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('keeps the last files of a force-deleted Secret and logs once', async () => {
    const warn = vi.spyOn(log, 'warn');
    await secrets().deleteSecretIfNotReferenced('hf', true);
    await deliverLiveSecretFiles(await workload());
    await deliverLiveSecretFiles(await workload());
    expect(write).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([message]) => message.includes('is deleted')),
    ).toHaveLength(1);
  });

  it('retries an unreachable host on the next poll without a state change', async () => {
    const warn = vi.spyOn(log, 'warn');
    write.mockRejectedValueOnce(
      new Error('Failed to write files for Secret "hf" on 192.0.2.1'),
    );
    await expect(deliverLiveSecretFiles(await workload())).resolves.toBe(
      undefined,
    );
    expect(warn).toHaveBeenCalledWith(
      'Secret file delivery failed',
      expect.objectContaining({ id: ID }),
    );
    expect((await workload()).state).toBe(WorkloadState.Running);

    await deliverLiveSecretFiles(await workload());
    expect(write).toHaveBeenCalledTimes(2);
    expect(held.get('hf')).toBe(await secrets().getSecretRevision('hf'));
  });

  it('writes nothing when the VMs changed before the write', async () => {
    read.mockImplementationOnce(async () => {
      await releaseTestVms(ID, 'vm-1');
      return new Map(held);
    });
    await deliverLiveSecretFiles(await workload());
    expect(write).not.toHaveBeenCalled();
  });

  it('skips SSH once the poll moved the Workload out of Running', async () => {
    // The poll's snapshot still says Running, as after an unreachable Job
    // moved to Recovering: no probe reaches the host.
    const row = await workload();
    await walkToState(ID, WorkloadState.Recovering);
    await deliverLiveSecretFiles(row);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves pool Jobs, non-Running Workloads and busy Workloads alone', async () => {
    const row = await workload();
    await deliverLiveSecretFiles({ ...row, deploymentId: 'deployment' });
    await deliverLiveSecretFiles({ ...row, state: WorkloadState.Finalizing });
    let release!: () => void;
    trackWorkloadWork(ID, new Promise<void>((resolve) => (release = resolve)));
    await deliverLiveSecretFiles(row);
    release();
    expect(read).not.toHaveBeenCalled();

    // The Workload left Running between the poll and the write.
    read.mockImplementationOnce(async () => {
      await walkToState(ID, WorkloadState.Finalizing);
      return new Map(held);
    });
    await deliverLiveSecretFiles(row);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the files for a container a start step adopted', async () => {
    const config: Pick<CloudConfig, 'cloudProvider' | 'vmType'> = {
      cloudProvider: CloudType.AWS,
      vmType: 't3.small',
    };
    const vms = await queries().getVMs(ID);
    await writeAdoptedSecretFiles(vms, await workload(), config);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].values).toEqual({ HF_TOKEN: 'old' });
    await writeAdoptedSecretFiles([], await workload(), config);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
