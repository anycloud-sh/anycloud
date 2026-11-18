import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  vi,
  onTestFinished,
} from 'vitest';
import { randomBytes } from 'crypto';
import {
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../../src/api/services/persistence.js';
import {
  walkToState,
  provisionTestVm,
  releaseTestVms,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import {
  encryptCredential,
  hashCredential,
  loadWorkloadConfigs,
} from '../../../../src/api/services/cloud-config';
import {
  decryptSecret,
  encryptSecret,
} from '../../../../src/api/services/secret-crypto.js';
import { CloudType, DiskTier } from '../../../../src/shared/cloud.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import { MAX_LIST_LIMIT } from '../../../../src/shared/workload-list';

import { errorForDiagnosticMetadata } from '../../../../src/shared/log-diagnostics.js';
import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

describe('createWorkload', () => {
  beforeAll(() => {
    // Set up cipher key for encryption tests
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    // Reset the store for each test (creates fresh SQLite database)
    resetPersistence();

    // Seed the credential IDs used by the various baseInput fixtures so FK
    // enforcement (migration 0042) doesn't reject the workload inserts.
    for (const id of [
      'test-credential-id',
      'test-cred',
      'test-cred-id',
      'checkpoint-cred-id',
    ]) {
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
        [id],
      );
    }
  });

  describe('bucket validation', () => {
    const baseInput = {
      id: 'test-workload-123',
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

    // The backup bucket holds the API's cipher key and database.
    it.each(['inputBucket', 'outputBucket', 'checkpointBucket'])(
      'refuses the API backup bucket as the %s',
      async (role) => {
        vi.stubEnv(
          'ANYCLOUD_BACKUP_CONFIG',
          JSON.stringify({
            bucket: 'api-backups',
            region: 'us-east-1',
            cloudProvider: 'AWS',
            credentials: { cloudProvider: 'AWS' },
          }),
        );
        onTestFinished(() => {
          vi.unstubAllEnvs();
        });

        await expect(
          createWorkload(getDB(), { ...baseInput, [role]: 'api-backups' }),
        ).rejects.toThrow("API's own backup bucket");
      },
    );

    it('refuses a Spot workload whose implicit checkpoint is the API backup bucket', async () => {
      vi.stubEnv(
        'ANYCLOUD_BACKUP_CONFIG',
        JSON.stringify({
          bucket: baseInput.id,
          region: 'us-east-1',
          cloudProvider: 'AWS',
          credentials: { cloudProvider: 'AWS' },
        }),
      );
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });

      await expect(
        createWorkload(getDB(), { ...baseInput, spot: true }),
      ).rejects.toThrow("API's own backup bucket");
    });

    it('should reject input bucket that conflicts with checkpoint bucket for spot instances', async () => {
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          spot: true,
          inputBucket: 'test-workload-123', // Same as workload ID
        }),
      ).rejects.toThrow(
        'Input bucket name cannot be "test-workload-123" (conflicts with checkpoint bucket)',
      );
    });

    it('should reject output bucket that conflicts with checkpoint bucket for spot instances', async () => {
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          spot: true,
          outputBucket: 'test-workload-123', // Same as workload ID
        }),
      ).rejects.toThrow(
        'Output bucket name cannot be "test-workload-123" (conflicts with checkpoint bucket)',
      );
    });

    it('should reject bucket roles that conflict with an explicit checkpoint bucket', async () => {
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          inputBucket: 'shared-state',
          checkpointBucket: 'shared-state',
        }),
      ).rejects.toThrow(
        'Input bucket name cannot be "shared-state" (conflicts with checkpoint bucket)',
      );
    });

    it('should persist an explicit checkpoint bucket independently of spot', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        spot: false,
        checkpointBucket: 'service-state',
      });

      const workload = await queries().getWorkload(baseInput.id);
      expect(workload?.checkpointBucket).toBe('service-state');
      expect(workload?.spot).toBe(false);
    });

    it('should allow input bucket that matches workload ID for non-spot instances', async () => {
      // Non-spot instances don't have checkpoint buckets, so no conflict
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          spot: false,
          inputBucket: 'test-workload-123', // Same as workload ID, but OK for non-spot
        }),
      ).resolves.not.toThrow();
    });

    it('should allow output bucket that matches workload ID for non-spot instances', async () => {
      // Non-spot instances don't have checkpoint buckets, so no conflict
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          spot: false,
          outputBucket: 'test-workload-123', // Same as workload ID, but OK for non-spot
        }),
      ).resolves.not.toThrow();
    });

    it('should reject when input and output buckets are the same', async () => {
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          inputBucket: 'same-bucket',
          outputBucket: 'same-bucket',
        }),
      ).rejects.toThrow(
        'Input and output buckets must be different (conflicting sync strategies)',
      );
    });

    it('should allow valid bucket configuration for spot instances', async () => {
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          spot: true,
          inputBucket: 'my-input-bucket',
          outputBucket: 'my-output-bucket',
          // Checkpoint bucket will be auto-created as workload ID
        }),
      ).resolves.not.toThrow();
    });

    it('should allow spot instance with no user buckets configured', async () => {
      // Spot instance with only checkpoint bucket (no input/output)
      await expect(
        createWorkload(getDB(), {
          ...baseInput,
          spot: true,
          // No buckets configured - checkpoint will be auto-created
        }),
      ).resolves.not.toThrow();
    });

    it('persists checkpoint storage credential and region fields', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'checkpoint-storage-test',
        spot: true,
        checkpointStorageCredentialId: 'checkpoint-cred-id',
        checkpointStorageRegion: 'us-west-2',
      });

      const workload = await queries().getWorkload('checkpoint-storage-test');
      expect(workload?.checkpointStorageCredentialId).toBe(
        'checkpoint-cred-id',
      );
      expect(workload?.checkpointStorageRegion).toBe('us-west-2');
    });

    it('persists disk tier and reconstructs it into CloudConfig', async () => {
      const computeCred = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIADISKTIER',
        secretAccessKey: 'disk-tier-secret',
      } as const;
      const computeId = await upsertCredential(
        getDB(),
        hashCredential(computeCred),
        await encryptCredential(computeCred),
        CloudType.AWS,
      );

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'disk-tier-test',
        credentialId: computeId,
        diskSizeGb: 100,
        diskTier: DiskTier.High,
      });

      const workload = await queries().getWorkload('disk-tier-test');
      expect(workload?.diskSizeGb).toBe(100);
      expect(workload?.diskTier).toBe(DiskTier.High);

      const cloudConfig = await loadWorkloadConfigs(workload!);
      expect(cloudConfig?.diskSizeGb).toBe(100);
      expect(cloudConfig?.diskTier).toBe(DiskTier.High);
    });

    it('keeps a NULL disk tier unresolved while hydrating CloudConfig', async () => {
      const computeCred = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIADISKNULL',
        secretAccessKey: 'disk-tier-null-secret',
      } as const;
      const computeId = await upsertCredential(
        getDB(),
        hashCredential(computeCred),
        await encryptCredential(computeCred),
        CloudType.AWS,
      );

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'disk-tier-null-test',
        credentialId: computeId,
      });

      const workload = await queries().getWorkload('disk-tier-null-test');
      expect(workload?.diskTier).toBeNull();

      const cloudConfig = await loadWorkloadConfigs(workload!);
      expect(cloudConfig?.diskTier).toBeUndefined();
    });

    it('reconstructs checkpoint storage credentials into CloudConfig', async () => {
      const computeCred = {
        cloudProvider: CloudType.Lambda,
        apiKey: 'lambda-key',
      } as const;
      const checkpointCred = {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIACHECKPOINT',
        secretAccessKey: 'checkpoint-secret',
      } as const;
      const computeId = await upsertCredential(
        getDB(),
        hashCredential(computeCred),
        await encryptCredential(computeCred),
        CloudType.Lambda,
      );
      const checkpointId = await upsertCredential(
        getDB(),
        hashCredential(checkpointCred),
        await encryptCredential(checkpointCred),
        CloudType.AWS,
      );

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'checkpoint-config-test',
        requestedComputeProvider: CloudType.Lambda,
        region: 'us-east-1',
        vmType: 'gpu_1x_a100',
        spot: true,
        credentialId: computeId,
        checkpointStorageCredentialId: checkpointId,
        checkpointStorageRegion: 'us-west-2',
      });

      const workload = await queries().getWorkload('checkpoint-config-test');
      const cloudConfig = await loadWorkloadConfigs(workload!);

      expect(cloudConfig?.checkpointStorageCredentials).toEqual(checkpointCred);
      expect(cloudConfig?.checkpointStorageRegion).toBe('us-west-2');
    });

    it('persists credentialless Local compute provider identity', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'local-credentialless-test',
        region: 'local',
        vmType: 'local',
        credentialId: null,
        requestedComputeProvider: CloudType.Local,
      });

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'aws-credentialed-test',
      });

      const workload = await queries().getWorkload('local-credentialless-test');
      expect(workload?.credentialId).toBeNull();
      expect(workload?.cloudProvider).toBe(CloudType.Local);

      // `search` is what reaches the computed provider column; listWorkloads
      // has no provider filter of its own.
      const localWorkloads = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          search: CloudType.Local,
        },
      );
      expect(localWorkloads.map((d) => d.id)).toEqual([
        'local-credentialless-test',
      ]);
    });
  });

  describe('provisioning attempt ledger', () => {
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

    it('records outcome diagnostics at T1 and marks cleanup at T3 without another event', async () => {
      const id = 'cleanup-outcome-time';
      await createWorkload(getDB(), { ...baseInput, id });
      await provisionTestVm(id, { ip: '1.2.3.4', cloudId: `${id}-vm` });
      await walkToState(id, WorkloadState.Running);

      const outcomeAt = Date.now() + 1_000;
      const cleanupFinishedAt = outcomeAt + 60_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(outcomeAt);
      try {
        const outcome = await outcomes().publishTerminalOutcome(
          id,
          WorkloadState.Completed,
          WorkloadState.Running,
          { metadata: { exitCode: 0, logs: 'workload complete' } },
        );
        expect(outcome).toBe(true);

        expect((await queries().getWorkload(id))?.cleanedAt).toBeNull();
        expect((await queries().getWorkload(id))?.completedAt).toBe(outcomeAt);

        nowSpy.mockReturnValue(cleanupFinishedAt);
        await expect(outcomes().markCleanupComplete(id)).resolves.toBe(false);
        await releaseTestVms(id, `${id}-vm`);
        await expect(outcomes().markCleanupComplete(id)).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const workload = await queries().getWorkload(id);
      expect(workload?.state).toBe(WorkloadState.Completed);
      expect(workload?.completedAt).toBe(outcomeAt);
      expect(workload?.cleanedAt).toBe(cleanupFinishedAt);

      const events = await eventLog().getWorkloadEvents(id);
      const terminalEvent = events.at(-1)!;
      expect(terminalEvent).toMatchObject({
        state: WorkloadState.Completed,
        created_at: outcomeAt,
      });
      expect(JSON.parse(terminalEvent.metadata!)).toMatchObject({
        exitCode: 0,
        logs: 'workload complete',
      });
      const rows = await getDB().query<{ cleaned_at: number | null }>(
        'SELECT cleaned_at FROM workloads WHERE id = ?',
        [id],
      );
      expect(rows[0].cleaned_at).toBe(cleanupFinishedAt);
    });
  });

  describe('vmType / gpuType array round-trip', () => {
    const baseInput = {
      id: 'arr-test',
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('stores a scalar vmType verbatim and reads it back as a string', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'arr-scalar',
        vmType: 't3.medium',
      });
      const d = await queries().getWorkload('arr-scalar');
      expect(d?.vmType).toBe('t3.medium');
    });

    it('stores a vmType array as JSON and reads it back as an array', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'arr-vm',
        vmType: ['t3.medium', 't3.small', 't3.micro'],
      });
      const d = await queries().getWorkload('arr-vm');
      expect(d?.vmType).toEqual(['t3.medium', 't3.small', 't3.micro']);
    });

    it('stores a gpuType array as JSON and reads it back as an array', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'arr-gpu',
        gpuType: ['h100:8', 'a100:8'],
      });
      const d = await queries().getWorkload('arr-gpu');
      expect(d?.gpuType).toEqual(['h100:8', 'a100:8']);
    });

    it('round-trips a single-element array as an array (no implicit collapse)', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'arr-single',
        vmType: ['t3.medium'],
      });
      const d = await queries().getWorkload('arr-single');
      expect(d?.vmType).toEqual(['t3.medium']);
    });
  });

  describe('query rowsAffected', () => {
    it('returns [{ rowsAffected: 0 }] for UPDATE that matches no rows', async () => {
      const result = await getDB().query(
        'UPDATE workloads SET state = ? WHERE id = ?',
        [WorkloadState.Running, 'nonexistent-id'],
      );
      expect(result).toEqual([{ rowsAffected: 0 }]);
    });

    it('returns [{ rowsAffected: 1 }] for UPDATE that matches one row', async () => {
      await createWorkload(getDB(), {
        id: 'rows-affected-test',
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.GCP,
        dockerCommand: 'echo hello',
        sshPrivateKey: 'test-key',
        credentialId: 'test-cred',
      });
      const result = await getDB().query(
        'UPDATE workloads SET state = ? WHERE id = ?',
        [WorkloadState.Running, 'rows-affected-test'],
      );
      expect(result).toEqual([{ rowsAffected: 1 }]);
    });
  });

  describe('error metadata serialization', () => {
    const baseWorkload = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
    };

    it('preserves error message in workload event metadata', async () => {
      await createWorkload(getDB(), { ...baseWorkload, id: 'err-meta-1' });

      const error = errorForDiagnosticMetadata(
        new Error(
          'SSH command stalled (no output for 600000ms): docker pull ghcr.io/org/image:latest',
        ),
      );
      // Force to Provisioning first so Provisioning → Retrying is a valid FSM transition
      await walkToState('err-meta-1', WorkloadState.Provisioning);
      await lifecycle().updateState('err-meta-1', WorkloadState.Retrying, {
        metadata: { error },
      });

      const events = await eventLog().getWorkloadEvents('err-meta-1');
      const retryEvent = events.find((e) => e.state === WorkloadState.Retrying);
      const metadata = JSON.parse(retryEvent!.metadata!);
      expect(metadata.error).toMatchObject({
        message: expect.stringContaining('SSH command stalled'),
      });
    });
  });

  describe('SSH key storage', () => {
    it('should store and retrieve SSH private key in workload', async () => {
      const sshPrivateKey =
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest anycloud';

      await createWorkload(getDB(), {
        id: 'ssh-test-deploy',
        userId: 'test-user',
        workloadType: 'job',
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.AWS,
        dockerCommand: 'echo hello',
        sshPrivateKey,
        credentialId: 'test-cred-id',
      });

      const workload = await queries().getWorkload('ssh-test-deploy');
      expect(workload?.sshPrivateKey).toBe(sshPrivateKey);
    });
  });

  describe('encryptSecret / decryptSecret round-trip', () => {
    it('should round-trip a plain string', async () => {
      const plaintext = 'ghp_abc123TokenValue';
      const encrypted = await encryptSecret(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(await decryptSecret(encrypted)).toBe(plaintext);
    });

    it('should throw on invalid ciphertext', async () => {
      await expect(decryptSecret('not-valid')).rejects.toThrow(
        'Failed to decrypt secret',
      );
    });
  });

  describe('env and githubToken storage', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-ssh-key',
      credentialId: 'test-cred',
    };

    it('should store and retrieve env vars', async () => {
      const env = { FOO: 'bar', SECRET: 'hunter2' };

      await createWorkload(getDB(), { ...baseInput, id: 'env-test', env });

      const workload = await queries().getWorkload('env-test');
      expect(workload?.env).toEqual(env);
    });

    it('should store and retrieve githubToken', async () => {
      const githubToken = 'ghp_testtoken123';

      await createWorkload(getDB(), {
        ...baseInput,
        id: 'token-test',
        githubToken,
      });

      const workload = await queries().getWorkload('token-test');
      expect(workload?.githubToken).toBe(githubToken);
    });

    it('should return null for env and githubToken when not provided', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'no-extras-test' });

      const workload = await queries().getWorkload('no-extras-test');
      expect(workload?.env).toBeNull();
      expect(workload?.githubToken).toBeNull();
    });
  });

  // Round-trip for the agent session display label (migration 0052). The CLI
  // captures it at submit and it must survive the INSERT column/value alignment
  // and the listWorkloads `SELECT d.*` → camelCase mapping. Verified here so a
  // dropped or misaligned column can't silently revert agent rows to the raw
  // `<agent>:<hash>` fallback in `anycloud list`.
  describe('session label round-trip', () => {
    const labelInput = {
      userId: 'label-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
      spot: false,
    };

    it('persists session, agent and sessionLabel and returns them from listWorkloads', async () => {
      await createWorkload(getDB(), {
        ...labelInput,
        id: 'label-dep-1',
        session: 'da4330df-741b-4285-ae06-72846a51536b',
        agent: 'claude',
        sessionLabel: 'Debug Claude session naming',
      });

      const rows = await queries().listWorkloads(scope('label-user'), 20);
      const row = rows.find((d) => d.id === 'label-dep-1');
      expect(row).toBeDefined();
      expect(row?.session).toBe('da4330df-741b-4285-ae06-72846a51536b');
      expect(row?.agent).toBe('claude');
      expect(row?.sessionLabel).toBe('Debug Claude session naming');
    });

    it('leaves sessionLabel null when the agent submitted before a title existed', async () => {
      await createWorkload(getDB(), {
        ...labelInput,
        id: 'label-dep-2',
        session: '11111111-2222-3333-4444-555555555555',
        agent: 'claude',
        // sessionLabel omitted — Claude had not titled the session yet.
      });

      const rows = await queries().listWorkloads(scope('label-user'), 20);
      const row = rows.find((d) => d.id === 'label-dep-2');
      expect(row?.agent).toBe('claude');
      expect(row?.sessionLabel).toBeNull();
    });
  });
});
