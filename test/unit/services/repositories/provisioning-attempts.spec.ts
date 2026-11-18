import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import config from '../../../../src/api/config.js';
import {
  getProvisioningAttemptStore as ledger,
  getWorkloadLifecycle as lifecycle,
  resetPersistence,
  getWorkloadQueryStore as queries,
} from '../../../../src/api/services/persistence.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import {
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';

const CREDENTIAL_ID = 'test-credential-id';

const baseInput = {
  userId: 'test-user',
  workloadType: 'job' as const,
  image: 'alpine:latest',
  cloudProvider: CloudType.AWS,
  region: 'us-east-1',
  vmType: 't3.medium',
  dockerCommand: 'docker run alpine',
  sshPrivateKey: 'ssh-ed25519-test-private-key',
  credentialId: 'test-credential-id',
};

describe('ProvisioningAttemptStore', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
      [CREDENTIAL_ID],
    );
  });

  describe('provisioning attempt ledger', () => {
    async function claimProvisioning(id: string): Promise<number> {
      const eventId = await lifecycle().claimStep(
        id,
        WorkloadState.Provisioning,
      );
      expect(eventId).not.toBeNull();
      return eventId!;
    }

    it('registers a fresh attempt only while the workload is Provisioning', async () => {
      const id = 'attempt-active-state';
      await createWorkload(getDB(), { ...baseInput, id });

      await expect(
        ledger().beginProvisioningAttempt(id, `${id}-0`),
      ).resolves.toBeNull();
      await expect(ledger().getProvisioningAttempts(id)).resolves.toHaveLength(
        0,
      );

      await claimProvisioning(id);
      await expect(
        ledger().beginProvisioningAttempt(id, `${id}-0`),
      ).resolves.toMatchObject({ cloudId: `${id}-0` });
    });

    it('completes provider facts without replacing pre-registered intent', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'attempt-complete' });
      const bucketHostPaths = {
        input: '/attempt/input',
        output: '/attempt/output',
        checkpoint: '/attempt/checkpoint',
      };
      await claimProvisioning('attempt-complete');
      const ref = await ledger().beginProvisioningAttempt(
        'attempt-complete',
        'attempt-complete-0',
        {
          region: 'us-east-1',
          availabilityZone: 'us-east-1b',
          vmType: 't3.medium',
          credentialId: 'test-credential-id',
          pricePerHour: 1.25,
          bucketHostPaths,
        },
      );
      expect(ref).not.toBeNull();
      const providerCreatedAt = ref!.createdAt + 100;

      const completed = await ledger().completeProvisioningAttempt(
        'attempt-complete',
        ref!,
        {
          cloudId: 'i-provider-id',
          ip: '1.2.3.4',
          createdAt: providerCreatedAt,
        },
      );

      expect(completed).toEqual({
        vmRowId: ref!.vmRowId,
        cloudId: 'i-provider-id',
        createdAt: providerCreatedAt,
      });
      expect(await ledger().countAllVMs('attempt-complete')).toBe(1);
      expect(
        await ledger().getProvisioningAttempts('attempt-complete'),
      ).toMatchObject([
        {
          cloud_id: 'i-provider-id',
          ip: '1.2.3.4',
          created_at: providerCreatedAt,
          ended_at: null,
          region: 'us-east-1',
          availability_zone: 'us-east-1b',
          vm_type: 't3.medium',
          credential_id: 'test-credential-id',
          price_per_hour: 1.25,
          input_host_path: bucketHostPaths.input,
          output_host_path: bucketHostPaths.output,
          checkpoint_host_path: bucketHostPaths.checkpoint,
        },
      ]);
      await expect(
        queries().getLatestProvisioningConfig('attempt-complete'),
      ).resolves.toMatchObject({
        region: 'us-east-1',
        availabilityZone: 'us-east-1b',
        vmType: 't3.medium',
        credentialId: 'test-credential-id',
      });
    });

    it('retargets and reopens a placeholder when cleanup races provider launch', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'attempt-race' });
      await claimProvisioning('attempt-race');
      const ref = await ledger().beginProvisioningAttempt(
        'attempt-race',
        'attempt-race-0',
        {
          region: 'us-east-1',
          vmType: 't3.medium',
          credentialId: 'test-credential-id',
        },
      );

      // Cleanup can confirm the synthetic name absent just before a gateway
      // exposes the actual provider ID. Retargeting must make it discoverable
      // again instead of trusting the stale ended_at decision.
      expect(ref).not.toBeNull();
      await releaseTestVms('attempt-race', ref!.cloudId);
      await ledger().retargetProvisioningAttempt(
        'attempt-race',
        ref!,
        'i-actual-provider-id',
      );

      expect(
        await ledger().getProvisioningAttempts('attempt-race'),
      ).toMatchObject([
        {
          cloud_id: 'i-actual-provider-id',
          ip: null,
          ended_at: null,
        },
      ]);
    });

    it('does not retire a retargeted attempt from stale native-absence confirmation', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attempt-stale-release',
      });
      await claimProvisioning('attempt-stale-release');
      const before = await ledger().beginProvisioningAttempt(
        'attempt-stale-release',
        'provisional-id',
        { region: 'us-east-1' },
      );
      expect(before).not.toBeNull();
      const after = await ledger().retargetProvisioningAttempt(
        'attempt-stale-release',
        before!,
        'provider-native-id',
      );
      await ledger().endProvisioningAttempt('attempt-stale-release', before!);
      expect(
        await ledger().getProvisioningAttempts('attempt-stale-release'),
      ).toMatchObject([
        { id: before!.vmRowId, cloud_id: 'provider-native-id', ended_at: null },
      ]);
      await ledger().endProvisioningAttempt('different-workload', after);
      await ledger().endProvisioningAttempt('attempt-stale-release', {
        ...after,
        createdAt: after.createdAt - 1,
      });
      expect(
        (await ledger().getProvisioningAttempts('attempt-stale-release'))[0]
          ?.ended_at,
      ).toBeNull();
      await ledger().endProvisioningAttempt('attempt-stale-release', after);
      expect(
        (await ledger().getProvisioningAttempts('attempt-stale-release'))[0]
          ?.ended_at,
      ).toEqual(expect.any(Number));
    });
  });

  describe('completed attempts', () => {
    it('persists the catalog price on the vms row', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-1' });
      await provisionTestVm(
        'tc-1',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        { region: 'us-east-1', pricePerHour: 1.5 },
      );
      const [row] = await getDB().query<{ price_per_hour: number | null }>(
        `SELECT price_per_hour FROM vms WHERE workload_id = ?`,
        ['tc-1'],
      );
      expect(row.price_per_hour).toBe(1.5);
    });

    it('preserves the provider-reported VM creation timestamp', async () => {
      const providerCreatedAt = 1_700_000_000_000;
      await createWorkload(getDB(), { ...baseInput, id: 'tc-created-at' });
      await provisionTestVm('tc-created-at', {
        ip: '1.2.3.4',
        cloudId: 'vm-created-at',
        createdAt: providerCreatedAt,
      });

      const [row] = await getDB().query<{ created_at: number }>(
        `SELECT created_at FROM vms WHERE workload_id = ?`,
        ['tc-created-at'],
      );
      expect(row.created_at).toBe(providerCreatedAt);
    });
  });

  describe('claimVmRemoval', () => {
    it('claimVmRemoval keeps the first stamp across cleanup retries', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'ar-idempotent' });
      await provisionTestVm('ar-idempotent', {
        ip: '1.2.3.4',
        cloudId: 'vm-1',
      });

      await ledger().claimVmRemoval('ar-idempotent', ['vm-1']);
      const [first] = await getDB().query<{ removal_requested_at: number }>(
        `SELECT removal_requested_at FROM vms WHERE cloud_id = ?`,
        ['vm-1'],
      );
      await new Promise((r) => setTimeout(r, 5));
      await ledger().claimVmRemoval('ar-idempotent', ['vm-1']);

      const [second] = await getDB().query<{ removal_requested_at: number }>(
        `SELECT removal_requested_at FROM vms WHERE cloud_id = ?`,
        ['vm-1'],
      );
      expect(second.removal_requested_at).toBe(first.removal_requested_at);
    });

    it('claimVmRemoval leaves a row the provider already released alone', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'ar-ended' });
      // An ownership conflict retires the attempt without a removal request.
      const ref = await provisionTestVm('ar-ended', { cloudId: 'vm-gone' });
      await ledger().endProvisioningAttempt('ar-ended', ref);

      await ledger().claimVmRemoval('ar-ended', ['vm-gone']);

      const [row] = await getDB().query<{
        removal_requested_at: number | null;
      }>(`SELECT removal_requested_at FROM vms WHERE cloud_id = ?`, [
        'vm-gone',
      ]);
      expect(row.removal_requested_at).toBeNull();
    });

    it("reopening a retargeted attempt drops the previous life's request", async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'ar-retarget' });
      await lifecycle().claimStep('ar-retarget', WorkloadState.Provisioning);
      const ref = await ledger().beginProvisioningAttempt(
        'ar-retarget',
        'synthetic-id',
        { region: 'us-east-1' },
      );
      await ledger().claimVmRemoval('ar-retarget', ['synthetic-id']);

      await ledger().retargetProvisioningAttempt(
        'ar-retarget',
        ref!,
        'real-id',
      );

      const [row] = await getDB().query<{
        removal_requested_at: number | null;
      }>(`SELECT removal_requested_at FROM vms WHERE cloud_id = ?`, [
        'real-id',
      ]);
      expect(row.removal_requested_at).toBeNull();
    });
  });

  describe('vm_type persistence', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'e2-standard-2',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('persists the resolved vmType on a completed attempt', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vt-success' });
      await provisionTestVm(
        'vt-success',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        { vmType: 'e2-standard-2', region: 'us-central1' },
      );
      const [row] = await getDB().query<{ vm_type: string | null }>(
        `SELECT vm_type FROM vms WHERE workload_id = ?`,
        ['vt-success'],
      );
      expect(row.vm_type).toBe('e2-standard-2');
    });

    it('persists the resolved vmType on an unresolved attempt', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vt-failed' });
      await provisionTestVm(
        'vt-failed',
        { cloudId: 'vm-1' },
        { region: 'us-central1', vmType: 'e2-standard-4' },
      );
      const [row] = await getDB().query<{ vm_type: string | null }>(
        `SELECT vm_type FROM vms WHERE workload_id = ?`,
        ['vt-failed'],
      );
      expect(row.vm_type).toBe('e2-standard-4');
    });
  });
});
