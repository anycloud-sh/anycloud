import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { provisionVMs } from '../../../src/api/services/vm-provisioner';
import { generateStartupScript } from '../../../src/api/services/vm-startup-script';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { walkToState, releaseTestVms } from '../../helpers/workload-store.js';
import { resetTestStore } from '../utils';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { makeMockCloud, makeMockVM } from '../helpers/fixtures';
import {
  buildJobIngressSpec,
  buildServeIngressSpec,
} from '../../../src/api/services/network';
import { VMCreationError } from '../../../src/api/services/codes';
import { KubernetesResourceOwnershipError } from '../../../src/api/services/kubernetes/managed-resources';
import { ResourceStateIndeterminateError } from '../../../src/shared/errors';
import { StateConflictError } from '../../../src/api/services/task';
import {
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../src/api/services/persistence.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

// Mock logger to avoid noise
vi.mock('../../../src/api/services/logger', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock config — cipherKey needed for createWorkload encryption
vi.mock('../../../src/api/config', () => ({
  default: { cipherKey: 'a'.repeat(64) },
  getApiBackupConfig: () => undefined,
}));

function provisionWithStorage(
  cloud: ReturnType<typeof makeMockCloud>,
  params: Parameters<typeof provisionVMs>[1],
) {
  return provisionVMs(cloud, params, {
    input: () => cloud,
    output: () => cloud,
    checkpoint: () => cloud,
  });
}

describe('vm-provisioner', () => {
  beforeEach(async () => {
    await resetTestStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('provisionVMs', () => {
    const baseParams = {
      cloudConfig: {
        cloudProvider: CloudType.AWS,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        region: 'us-east-1',
        availabilityZone: 'us-east-1b',
        vmType: 't3.medium',
      },
      workloadId: 'test-deploy',
      sshKeys: {
        publicKey: 'ssh-rsa AAAA...',
        privateKey: '-----BEGIN PRIVATE KEY-----\n...',
      },
      ipWhitelist: ['10.0.0.0/8'],
      version: '0.3.2',
      userId: 'testuser',
      credentialId: 'test-credential-id',
    };

    // Create the workload record so attempt rows don't hit the FK constraint
    beforeEach(async () => {
      await createWorkload(getDB(), {
        id: baseParams.workloadId,
        userId: baseParams.userId,
        workloadType: 'job',
        image: 'test:latest',
        region: baseParams.cloudConfig.region,
        vmType: [baseParams.cloudConfig.vmType, 't3.large'],
        dockerCommand: 'docker run test',
        sshPrivateKey: 'test-ssh-key',
        credentialId: 'test-credential-id',
      });
      const eventId = await lifecycle().claimStep(
        baseParams.workloadId,
        WorkloadState.Provisioning,
      );
      expect(eventId).not.toBeNull();
    });

    it('does not mutate the provider after a terminal outcome supersedes its claim', async () => {
      const outcome = await outcomes().publishTerminalOutcome(
        baseParams.workloadId,
        WorkloadState.Terminated,
        WorkloadState.Provisioning,
      );
      expect(outcome).not.toBeNull();
      const cloud = makeMockCloud();

      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        StateConflictError,
      );

      expect(cloud.upsertBucket).not.toHaveBeenCalled();
      expect(cloud.upsertFirewall).not.toHaveBeenCalled();
      expect(cloud.newVM).not.toHaveBeenCalled();
      await expect(
        ledger().getProvisioningAttempts(baseParams.workloadId),
      ).resolves.toHaveLength(0);
    });

    it('should create VMs and set up firewall using workloadId', async () => {
      const cloud = makeMockCloud();

      const result = await provisionWithStorage(cloud, baseParams);

      // firewallName is always workloadId
      expect(cloud.upsertFirewall).toHaveBeenCalledWith(
        baseParams.ipWhitelist,
        baseParams.workloadId,
        baseParams.version,
        baseParams.userId,
      );
      expect(cloud.newVM).toHaveBeenCalledTimes(1);
      expect(cloud.newVM).toHaveBeenCalledWith(
        expect.objectContaining({
          ingressSpec: buildJobIngressSpec(baseParams.ipWhitelist),
        }),
      );
      expect(result.vms).toHaveLength(1);

      // Provisioning completes the row it registered before cloud mutation;
      // the caller does not insert a second post-launch VM row.
      expect(
        await ledger().getProvisioningAttempts(baseParams.workloadId),
      ).toMatchObject([{ cloud_id: 'vm-123', ip: '1.2.3.4' }]);
      expect(await ledger().countAllVMs(baseParams.workloadId)).toBe(1);
    });

    it('records the attempt before network provider mutations', async () => {
      const assertDurablePlaceholder = async () => {
        expect(
          await ledger().getProvisioningAttempts(baseParams.workloadId),
        ).toMatchObject([
          {
            cloud_id: `${baseParams.workloadId}-0`,
            ip: null,
            ended_at: null,
            region: baseParams.cloudConfig.region,
            availability_zone: baseParams.cloudConfig.availabilityZone,
            vm_type: baseParams.cloudConfig.vmType,
            credential_id: baseParams.credentialId,
          },
        ]);
      };
      const prepareNetwork = vi.fn(async () => {
        await assertDurablePlaceholder();
        return { securityGroupId: 'sg-durable' };
      });
      const cloud = makeMockCloud({ prepareNetwork });

      await provisionWithStorage(cloud, baseParams);

      expect(prepareNetwork).toHaveBeenCalledOnce();
    });

    it('should pass prepared network handles into VM creation', async () => {
      const network = { securityGroupId: 'sg-server' };
      const prepareNetwork = vi.fn().mockResolvedValue(network);
      const cloud = makeMockCloud({ prepareNetwork });
      const ingressSpec = buildServeIngressSpec(baseParams.ipWhitelist);

      await provisionWithStorage(cloud, {
        ...baseParams,
        ingressSpec,
      });

      expect(prepareNetwork).toHaveBeenCalledWith(
        ingressSpec,
        baseParams.workloadId,
        baseParams.version,
        baseParams.userId,
      );
      expect(cloud.upsertFirewall).not.toHaveBeenCalled();
      expect(cloud.newVM).toHaveBeenCalledWith(
        expect.objectContaining({ network, ingressSpec }),
      );
    });

    it('should reject non-SSH ingress when a provider lacks prepareNetwork', async () => {
      const cloud = makeMockCloud();

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          ingressSpec: buildServeIngressSpec(baseParams.ipWhitelist),
        }),
      ).rejects.toThrow('does not support the requested ingress rules');

      expect(cloud.upsertFirewall).not.toHaveBeenCalled();
      expect(cloud.newVM).not.toHaveBeenCalled();
    });

    it('should verify user buckets and create the output bucket for spot', async () => {
      const cloud = makeMockCloud();

      await provisionWithStorage(cloud, {
        ...baseParams,
        cloudConfig: {
          ...baseParams.cloudConfig,
          spot: true, // Enable spot to test checkpoint bucket
          inputBucket: 'input-bucket',
          outputBucket: 'output-bucket',
        },
      });

      // Input bucket verified via hasBucket
      expect(cloud.hasBucket).toHaveBeenCalledWith('input-bucket');
      expect(cloud.hasBucket).toHaveBeenCalledTimes(1);

      // Output bucket auto-created via upsertBucket
      expect(cloud.upsertBucket).toHaveBeenCalledWith(
        'output-bucket',
        '0.3.2',
        'test-deploy',
        'testuser',
      );
      // Managed checkpoint creation follows durable VM attempt completion.
      expect(cloud.upsertBucket).toHaveBeenCalledWith(
        'test-deploy',
        '0.3.2',
        'test-deploy',
        'testuser',
      );
      expect(cloud.upsertBucket).toHaveBeenCalledTimes(2);
    });

    it('should NOT create checkpoint bucket for non-spot instances', async () => {
      const cloud = makeMockCloud();

      await provisionWithStorage(cloud, {
        ...baseParams,
        cloudConfig: {
          ...baseParams.cloudConfig,
          spot: false, // Non-spot instance
          inputBucket: 'input-bucket',
          outputBucket: 'output-bucket',
        },
      });

      // Input bucket verified
      expect(cloud.hasBucket).toHaveBeenCalledTimes(1);
      expect(cloud.hasBucket).toHaveBeenCalledWith('input-bucket');

      // Output bucket auto-created via upsertBucket (no checkpoint bucket for non-spot)
      expect(cloud.upsertBucket).toHaveBeenCalledWith(
        'output-bucket',
        '0.3.2',
        'test-deploy',
        'testuser',
      );
      expect(cloud.upsertBucket).toHaveBeenCalledTimes(1);
    });

    it('should verify but never create an explicit checkpoint bucket', async () => {
      const cloud = makeMockCloud();

      await provisionWithStorage(cloud, {
        ...baseParams,
        cloudConfig: {
          ...baseParams.cloudConfig,
          checkpointBucket: 'server-state',
        },
      });

      expect(cloud.hasBucket).toHaveBeenCalledWith('server-state');
      expect(cloud.upsertBucket).not.toHaveBeenCalledWith(
        'server-state',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should reject a missing explicit checkpoint bucket before creating a VM', async () => {
      const cloud = makeMockCloud({
        hasBucket: vi.fn().mockResolvedValue(false),
      });

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          cloudConfig: {
            ...baseParams.cloudConfig,
            checkpointBucket: 'missing-state',
          },
        }),
      ).rejects.toThrow(
        "Checkpoint bucket 'missing-state' does not exist. Please create it before deploying.",
      );

      expect(cloud.newVM).not.toHaveBeenCalled();
      expect(
        await ledger().getProvisioningAttempts(baseParams.workloadId),
      ).toHaveLength(0);
    });

    it('does not create a VM after firewall setup fails', async () => {
      const cloud = makeMockCloud();
      cloud.upsertFirewall = vi
        .fn()
        .mockRejectedValue(new Error('firewall error'));

      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        'firewall error',
      );

      // Should not have tried to create VMs after firewall failure
      expect(cloud.newVM).not.toHaveBeenCalled();
    });

    it('test:0036/S21 leaves a failed VM creation attempt for reconciler cleanup without rewriting its spec', async () => {
      const specs = await getDB().query('SELECT * FROM container_specs');
      const cloud = makeMockCloud();
      cloud.newVM = vi.fn().mockRejectedValue(new Error('VM creation failed'));

      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        'VM creation failed',
      );

      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      await expect(
        ledger().getUnresolvedProvisioningAttempts(baseParams.workloadId),
      ).resolves.toMatchObject([{ cloud_id: 'test-deploy-0', ended_at: null }]);
      expect(await getDB().query('SELECT * FROM container_specs')).toEqual(
        specs,
      );
    });

    it('test:0036/S1 keeps one admitted specification through provider failure, retry and resubmission', async () => {
      const store = queries();
      const specs = await getDB().query('SELECT * FROM container_specs');
      const original = await store.getWorkload(baseParams.workloadId);
      const cloud = makeMockCloud();
      cloud.newVM = vi
        .fn()
        .mockRejectedValueOnce(new Error('provider failure'))
        .mockResolvedValueOnce(makeMockVM({ cloudId: 'retry-vm' }))
        .mockResolvedValueOnce(makeMockVM({ cloudId: 'resubmitted-vm' }));
      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        'provider failure',
      );
      const [failedAttempt] = await ledger().getProvisioningAttempts(
        baseParams.workloadId,
      );
      await releaseTestVms(baseParams.workloadId, failedAttempt.cloud_id);
      await walkToState(baseParams.workloadId, WorkloadState.Retrying);
      await walkToState(baseParams.workloadId, WorkloadState.Queued);
      await lifecycle().claimStep(
        baseParams.workloadId,
        WorkloadState.Provisioning,
      );
      await provisionWithStorage(cloud, { ...baseParams, startIndex: 1 });
      await lifecycle().updateState(
        baseParams.workloadId,
        WorkloadState.Retrying,
      );
      expect(
        await outcomes().publishTerminalOutcome(
          baseParams.workloadId,
          WorkloadState.Failed,
          WorkloadState.Retrying,
        ),
      ).toBe(true);
      await releaseTestVms(baseParams.workloadId);
      expect(await outcomes().markCleanupComplete(baseParams.workloadId)).toBe(
        true,
      );
      expect(await outcomes().resubmitWorkload(baseParams.workloadId)).toBe(
        true,
      );
      await lifecycle().claimStep(
        baseParams.workloadId,
        WorkloadState.Provisioning,
      );
      await provisionWithStorage(cloud, { ...baseParams, startIndex: 2 });
      expect(await getDB().query('SELECT * FROM container_specs')).toEqual(
        specs,
      );
      const attempts = await ledger().getProvisioningAttempts(
        baseParams.workloadId,
      );
      expect(new Set(attempts.map((row) => row.id)).size).toBe(3);
      expect(attempts.map((row) => row.cloud_id)).toEqual(
        expect.arrayContaining(['test-deploy-0', 'retry-vm', 'resubmitted-vm']),
      );
      expect(await store.getWorkload(baseParams.workloadId)).toMatchObject({
        image: original!.image,
        command: original!.command,
        env: original!.env,
        registryUsername: original!.registryUsername,
        githubToken: original!.githubToken,
        region: original!.region,
        vmType: original!.vmType,
        gpuType: original!.gpuType,
      });
    });

    it('preserves a provider cleanup ID exposed by a post-launch failure', async () => {
      const providerId = 'aaaaaaaa11111111bbbbbbbb22222222';
      const cloud = makeMockCloud();
      cloud.newVM = vi
        .fn()
        .mockRejectedValue(
          new VMCreationError(new Error('instance failed during boot'), [
            providerId,
          ]),
        );
      cloud.terminateVMs = vi.fn().mockResolvedValue([]);

      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        'instance failed during boot',
      );

      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      const attempts = await ledger().getProvisioningAttempts(
        baseParams.workloadId,
      );
      expect(attempts.map((attempt) => attempt.cloud_id)).toEqual([providerId]);
    });

    it('retires an ownership-conflict attempt without deleting the foreign resource', async () => {
      const cloud = makeMockCloud();
      cloud.newVM = vi
        .fn()
        .mockRejectedValue(
          new KubernetesResourceOwnershipError(
            'resource belongs to another owner',
          ),
        );

      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        'resource belongs to another owner',
      );

      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      expect(
        await ledger().getUnresolvedProvisioningAttempts(baseParams.workloadId),
      ).toHaveLength(0);
    });

    it('preserves an unresolved attempt when provider adoption is inconclusive', async () => {
      const attempt = await ledger().beginProvisioningAttempt(
        baseParams.workloadId,
        `${baseParams.workloadId}-0`,
        {
          region: baseParams.cloudConfig.region,
          vmType: baseParams.cloudConfig.vmType,
          credentialId: baseParams.credentialId,
        },
      );
      if (!attempt) throw new Error('the store refused the attempt');
      const adoptProvisioningAttempt = vi
        .fn()
        .mockRejectedValue(
          new ResourceStateIndeterminateError(
            'Could not inspect the existing provisioning attempt',
            new Error('provider timeout'),
          ),
        );
      const cloud = makeMockCloud({ adoptProvisioningAttempt });

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          existingAttempt: attempt,
        }),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(adoptProvisioningAttempt).toHaveBeenCalledWith({
        workloadId: baseParams.workloadId,
        vmId: attempt.cloudId,
        userId: baseParams.userId,
      });
      expect(cloud.upsertFirewall).not.toHaveBeenCalled();
      expect(cloud.newVM).not.toHaveBeenCalled();
      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      const unresolved = await ledger().getUnresolvedProvisioningAttempts(
        baseParams.workloadId,
      );
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({
        cloud_id: attempt.cloudId,
        ended_at: null,
      });
    });

    it('completes an existing attempt without replacing its original intent', async () => {
      const attempt = await ledger().beginProvisioningAttempt(
        baseParams.workloadId,
        `${baseParams.workloadId}-0`,
        {
          region: baseParams.cloudConfig.region,
          vmType: baseParams.cloudConfig.vmType,
          credentialId: baseParams.credentialId,
          pricePerHour: 1.25,
        },
      );
      if (!attempt) throw new Error('the store refused the attempt');
      const adopted = makeMockVM({
        cloudId: 'provider-instance-123',
        ip: '203.0.113.42',
      });
      const adoptProvisioningAttempt = vi.fn().mockResolvedValue(adopted);
      const prepareNetwork = vi.fn();
      const cloud = makeMockCloud({
        adoptProvisioningAttempt,
        prepareNetwork,
      });

      const result = await provisionWithStorage(cloud, {
        ...baseParams,
        cloudConfig: {
          ...baseParams.cloudConfig,
          region: 'us-west-2',
          vmType: 'm7i.large',
        },
        credentialId: 'replacement-credential',
        existingAttempt: attempt,
      });

      expect(result.vms).toEqual([adopted]);
      expect(prepareNetwork).not.toHaveBeenCalled();
      expect(cloud.upsertFirewall).not.toHaveBeenCalled();
      expect(cloud.newVM).not.toHaveBeenCalled();
      expect(
        await ledger().getProvisioningAttempts(baseParams.workloadId),
      ).toMatchObject([
        {
          cloud_id: adopted.cloudId,
          ip: adopted.ip,
          ended_at: null,
          region: baseParams.cloudConfig.region,
          vm_type: baseParams.cloudConfig.vmType,
          credential_id: baseParams.credentialId,
          price_per_hour: 1.25,
        },
      ]);
      expect(await ledger().countAllVMs(baseParams.workloadId)).toBe(1);
    });

    it('reuses the attempt identity after provider observation confirms absence', async () => {
      const attempt = await ledger().beginProvisioningAttempt(
        baseParams.workloadId,
        `${baseParams.workloadId}-0`,
        {
          region: baseParams.cloudConfig.region,
          vmType: baseParams.cloudConfig.vmType,
          credentialId: baseParams.credentialId,
        },
      );
      if (!attempt) throw new Error('the store refused the attempt');
      const adoptProvisioningAttempt = vi.fn().mockResolvedValue(null);
      const cloud = makeMockCloud({ adoptProvisioningAttempt });

      await provisionWithStorage(cloud, {
        ...baseParams,
        startIndex: 1,
        existingAttempt: attempt,
      });

      expect(adoptProvisioningAttempt).toHaveBeenCalledOnce();
      expect(cloud.upsertFirewall).toHaveBeenCalledOnce();
      expect(cloud.newVM).toHaveBeenCalledWith(
        expect.objectContaining({
          vmId: attempt.cloudId,
          adoptExistingAttempt: true,
        }),
      );
      expect(
        await ledger().getProvisioningAttempts(baseParams.workloadId),
      ).toHaveLength(1);
    });

    it('observes an existing attempt before a fallible bucket check', async () => {
      const attempt = await ledger().beginProvisioningAttempt(
        baseParams.workloadId,
        `${baseParams.workloadId}-0`,
        {
          region: baseParams.cloudConfig.region,
          vmType: baseParams.cloudConfig.vmType,
          credentialId: baseParams.credentialId,
        },
      );
      if (!attempt) throw new Error('the store refused the attempt');
      const adoptProvisioningAttempt = vi.fn().mockResolvedValue(null);
      const cloud = makeMockCloud({ adoptProvisioningAttempt });
      vi.mocked(cloud.hasBucket).mockRejectedValueOnce(
        new Error('storage API unavailable'),
      );

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          cloudConfig: {
            ...baseParams.cloudConfig,
            inputBucket: 'input-bucket',
          },
          existingAttempt: attempt,
        }),
      ).rejects.toThrow('storage API unavailable');

      expect(adoptProvisioningAttempt.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(cloud.hasBucket).mock.invocationCallOrder[0]!,
      );
      expect(cloud.newVM).not.toHaveBeenCalled();
      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      expect(
        await ledger().getUnresolvedProvisioningAttempts(baseParams.workloadId),
      ).toMatchObject([{ cloud_id: attempt.cloudId, ended_at: null }]);
    });

    it('observes an existing attempt before fallible bucket-region discovery', async () => {
      const attempt = await ledger().beginProvisioningAttempt(
        baseParams.workloadId,
        `${baseParams.workloadId}-0`,
        {
          region: baseParams.cloudConfig.region,
          vmType: baseParams.cloudConfig.vmType,
          credentialId: baseParams.credentialId,
        },
      );
      if (!attempt) throw new Error('the store refused the attempt');
      const adoptProvisioningAttempt = vi.fn().mockResolvedValue(null);
      const cloud = makeMockCloud({ adoptProvisioningAttempt });
      const getBucketRegion = vi
        .fn()
        .mockRejectedValue(new Error('bucket region unavailable'));
      cloud.getBucketRegion = getBucketRegion;

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          cloudConfig: {
            ...baseParams.cloudConfig,
            inputBucket: 'input-bucket',
          },
          existingAttempt: attempt,
        }),
      ).rejects.toThrow('bucket region unavailable');

      expect(adoptProvisioningAttempt.mock.invocationCallOrder[0]).toBeLessThan(
        getBucketRegion.mock.invocationCallOrder[0]!,
      );
      expect(cloud.hasBucket).not.toHaveBeenCalled();
      expect(cloud.newVM).not.toHaveBeenCalled();
      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      expect(
        await ledger().getUnresolvedProvisioningAttempts(baseParams.workloadId),
      ).toMatchObject([{ cloud_id: attempt.cloudId, ended_at: null }]);
    });

    it('should pass startup script to newVM', async () => {
      const cloud = makeMockCloud();

      await provisionWithStorage(cloud, baseParams);

      const params = vi.mocked(cloud.newVM).mock.calls[0][0];
      expect(params.startupScript).toContain('#!/bin/bash');
      expect(params.startupScript).toContain(baseParams.sshKeys.publicKey);
      expect(params.startupScript).toContain('/root/.ssh/authorized_keys');
    });

    it("sends a Job host's cloud-config and asks for its image", async () => {
      const cloud = makeMockCloud();

      await provisionWithStorage(cloud, {
        ...baseParams,
        jobHost: { prePullImage: 'ghcr.io/acme/train:1', ubuntuMirror: null },
      });

      const params = vi.mocked(cloud.newVM).mock.calls[0][0];
      expect(params.startupScript.split('\n')[0]).toBe('#cloud-config');
      expect(params.startupScript).toContain(baseParams.sshKeys.publicKey);
      expect(params.jobHost).toBe(true);
    });

    it('should NOT create VMs when user bucket does not exist', async () => {
      const cloud = makeMockCloud();
      cloud.hasBucket = vi.fn().mockResolvedValue(false);

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          cloudConfig: {
            ...baseParams.cloudConfig,
            inputBucket: 'my-bucket',
          },
        }),
      ).rejects.toThrow('does not exist');

      // hasBucket returns false before VM creation — no VMs to clean up
      expect(cloud.newVM).not.toHaveBeenCalled();
      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      expect(await ledger().countAllVMs(baseParams.workloadId)).toBe(0);
    });

    it('persists the derived VM ID when creation fails', async () => {
      const cloud = makeMockCloud();
      // Firewall succeeds
      cloud.upsertFirewall = vi.fn().mockResolvedValue(undefined);
      // All VM creations fail (no partial success)
      cloud.newVM = vi.fn().mockRejectedValue(new Error('All VMs failed'));

      await expect(provisionWithStorage(cloud, baseParams)).rejects.toThrow(
        'All VMs failed',
      );

      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      await expect(
        ledger().getUnresolvedProvisioningAttempts(baseParams.workloadId),
      ).resolves.toMatchObject([{ cloud_id: 'test-deploy-0' }]);
    });

    it('should derive correct VM IDs with startIndex when all VM creations fail', async () => {
      const cloud = makeMockCloud();
      cloud.newVM = vi.fn().mockRejectedValue(new Error('provisioning failed'));

      await expect(
        provisionWithStorage(cloud, {
          ...baseParams,
          startIndex: 3,
        }),
      ).rejects.toThrow('provisioning failed');

      expect(cloud.terminateVMs).not.toHaveBeenCalled();
      await expect(
        ledger().getUnresolvedProvisioningAttempts(baseParams.workloadId),
      ).resolves.toMatchObject([{ cloud_id: 'test-deploy-3' }]);
    });

    it('re-enters an existing provisioning attempt with the same provider identity', async () => {
      const attempt = await ledger().beginProvisioningAttempt(
        baseParams.workloadId,
        `${baseParams.workloadId}-0`,
        {
          region: baseParams.cloudConfig.region,
          vmType: baseParams.cloudConfig.vmType,
          credentialId: baseParams.credentialId,
        },
      );
      if (!attempt) throw new Error('the store refused the attempt');
      const cloud = makeMockCloud();

      await provisionWithStorage(cloud, {
        ...baseParams,
        startIndex: 1,
        existingAttempt: attempt,
      });

      expect(cloud.newVM).toHaveBeenCalledWith(
        expect.objectContaining({
          vmId: `${baseParams.workloadId}-0`,
          adoptExistingAttempt: true,
        }),
      );
      expect(
        await ledger().getProvisioningAttempts(baseParams.workloadId),
      ).toHaveLength(1);
    });

    describe('durable provisioning attempt ledger', () => {
      beforeEach(async () => {
        await resetTestStore();
      });

      it('should record failed vmIds so next retry gets a unique startIndex', async () => {
        const workloadId = 'test-retry-index-' + Date.now();

        await createWorkload(getDB(), {
          id: workloadId,
          userId: 'test-user',
          workloadType: 'job',
          image: 'test:latest',
          dockerCommand: 'docker run test',
          sshPrivateKey: 'test-ssh-key',
          credentialId: 'test-credential-id',
        });
        const eventId = await lifecycle().claimStep(
          workloadId,
          WorkloadState.Provisioning,
        );
        expect(eventId).not.toBeNull();

        const cloud = makeMockCloud();
        cloud.newVM = vi
          .fn()
          .mockRejectedValue(new Error('OverconstrainedAllocationRequest'));

        const params = {
          ...baseParams,
          workloadId,
          vmCount: 1,
        };

        // First attempt fails — should record the attempted vmId in the DB
        await expect(provisionWithStorage(cloud, params)).rejects.toThrow(
          'OverconstrainedAllocationRequest',
        );

        // No active VMs (provisioning failed)
        const activeVMs = await queries().getVMs(workloadId);
        expect(activeVMs).toHaveLength(0);

        // But countAllVMs should include the failed attempt
        const count = await ledger().countAllVMs(workloadId);
        expect(count).toBe(1);

        // Second attempt should use startIndex=1, producing a different vmId
        cloud.newVM = vi
          .fn()
          .mockResolvedValue(makeMockVM({ cloudId: `${workloadId}-1` }));
        const secondCount = await ledger().countAllVMs(workloadId);

        const result = await provisionWithStorage(cloud, {
          ...params,
          startIndex: secondCount,
        });

        // Verify the second attempt used vmId with index 1, not 0
        expect(cloud.newVM).toHaveBeenCalledWith(
          expect.objectContaining({ vmId: `${workloadId}-1` }),
        );
        expect(result.vms).toHaveLength(1);
      });

      it('keeps a cleanup target when network mutation fails before VM creation', async () => {
        const workloadId = 'test-pre-vm-fail-' + Date.now();

        await createWorkload(getDB(), {
          id: workloadId,
          userId: 'test-user',
          workloadType: 'job',
          image: 'test:latest',
          dockerCommand: 'docker run test',
          sshPrivateKey: 'test-ssh-key',
          credentialId: 'test-credential-id',
        });
        const eventId = await lifecycle().claimStep(
          workloadId,
          WorkloadState.Provisioning,
        );
        expect(eventId).not.toBeNull();

        const cloud = makeMockCloud();
        cloud.upsertFirewall = vi
          .fn()
          .mockRejectedValue(new Error('firewall error'));

        await expect(
          provisionWithStorage(cloud, {
            ...baseParams,
            workloadId,
          }),
        ).rejects.toThrow('firewall error');

        // Firewall setup is a provider mutation that can partially succeed.
        // The pre-registered row lets terminal/retry reconciliation clean it
        // after a process crash without a separate cleanup-request marker.
        expect(await ledger().countAllVMs(workloadId)).toBe(1);
        expect(
          await ledger().getProvisioningAttempts(workloadId),
        ).toMatchObject([
          {
            cloud_id: `${workloadId}-0`,
            ip: null,
            ended_at: null,
            region: baseParams.cloudConfig.region,
            vm_type: baseParams.cloudConfig.vmType,
            credential_id: baseParams.credentialId,
          },
        ]);
      });

      it('advances the attempt count via startIndex across retries', async () => {
        const workloadId = 'test-retry-count-' + Date.now();

        await createWorkload(getDB(), {
          id: workloadId,
          userId: 'test-user',
          workloadType: 'job',
          image: 'test:latest',
          dockerCommand: 'docker run test',
          sshPrivateKey: 'test-ssh-key',
          credentialId: 'test-credential-id',
        });
        const eventId = await lifecycle().claimStep(
          workloadId,
          WorkloadState.Provisioning,
        );
        expect(eventId).not.toBeNull();

        const cloud = makeMockCloud();
        cloud.newVM = vi.fn().mockRejectedValue(new Error('capacity'));

        // First attempt fails — records the attempted vmId at index 0.
        await expect(
          provisionWithStorage(cloud, {
            ...baseParams,
            workloadId,
          }),
        ).rejects.toThrow('capacity');

        expect(await ledger().countAllVMs(workloadId)).toBe(1);

        // Second attempt starts at index 1.
        await expect(
          provisionWithStorage(cloud, {
            ...baseParams,
            workloadId,
            startIndex: 1,
          }),
        ).rejects.toThrow('capacity');

        expect(await ledger().countAllVMs(workloadId)).toBe(2);
      });
    });
  });

  describe('generateStartupScript', () => {
    const sshKeys = {
      publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB test@example.com',
      privateKey:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
    };
    const generateManagedStartupScript = () => generateStartupScript(sshKeys);

    it('should include shebang', () => {
      const script = generateManagedStartupScript();
      expect(script).toMatch(/^#!/);
    });

    it('should set up SSH directory with correct permissions', () => {
      const script = generateManagedStartupScript();

      expect(script).toContain('mkdir -p /root/.ssh');
      expect(script).toContain('chmod 700 /root/.ssh');
    });

    it('should add public key to authorized_keys', () => {
      const script = generateManagedStartupScript();

      expect(script).toContain(sshKeys.publicKey);
      expect(script).toContain('/root/.ssh/authorized_keys');
      expect(script).toContain('chmod 600 /root/.ssh/authorized_keys');
    });

    it('never embeds the private key, whatever the credential policy', () => {
      const script = generateStartupScript(sshKeys);

      expect(script).toContain(sshKeys.publicKey);
      expect(script).not.toContain(sshKeys.privateKey);
      expect(script).not.toContain('/etc/anycloud-key');
    });

    it('should create sshd run directory', () => {
      const script = generateManagedStartupScript();

      expect(script).toContain('mkdir -p /run/sshd');
    });

    it('mints machine identity and SSH host keys on first boot', () => {
      const script = generateManagedStartupScript();

      expect(script).toContain('if [ ! -s /etc/machine-id ]; then');
      expect(script).toContain('systemd-machine-id-setup');
      expect(script).toContain('/proc/sys/kernel/random/uuid');
      expect(script).toContain('ssh-keygen -A');
    });

    it('should handle both systemctl and direct sshd start', () => {
      const script = generateManagedStartupScript();

      // Should check for systemctl availability
      expect(script).toContain('systemctl');
      // Should have fallback to direct sshd
      expect(script).toContain('/usr/sbin/sshd');
    });

    it('should use heredoc for key content', () => {
      const script = generateManagedStartupScript();

      // Should use heredoc to avoid escaping issues
      expect(script).toContain('SSH_KEY_EOF');
    });
  });
});
