import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runApiOwnershipBackfillBatch } from '../../../src/api/services/api-ownership-backfill.js';
import {
  ApiOwnershipStore,
  ApiOwnershipTargetStatus,
  type ApiOwnershipBackfillTarget,
  type ApiOwnershipRepository,
} from '../../../src/api/services/api-ownership-store.js';
import {
  bindDatabaseApiIdentity,
  resetApiIdentityForTest,
} from '../../../src/api/services/api-identity.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { WorkloadQueryStore } from '../../../src/api/services/repositories/workload-queries.js';
import {
  ApiOwnershipBackfillResult,
  ApiOwnershipConflictError,
  apiOwnershipTagDecision,
  createCloudApiOwnership,
} from '../../../src/api/services/gateways/api-ownership.js';
import {
  createDatabase,
  type DB,
} from '../../../src/api/services/repositories/db.js';
import { ProvisioningAttemptStore } from '../../../src/api/services/repositories/provisioning-attempts.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../../src/shared/workload.js';

const API_IDENTITY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOSTED_API_IDENTITY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function target(
  vmRowId: number,
  overrides: Partial<ApiOwnershipBackfillTarget> = {},
): ApiOwnershipBackfillTarget {
  return {
    vmRowId,
    cloudId: `vm-${vmRowId}`,
    ownerKind: 'workload',
    ownerId: 'workload-1',
    userId: 'user-1',
    endedAt: null,
    credentialId: null,
    cloudProvider: CloudType.Local,
    region: 'local',
    availabilityZone: null,
    vmType: 'normal',
    ...overrides,
  };
}

async function addActiveLocalWorkload(
  db: DB,
  id: string,
  cloudId: string,
  ip: string,
): Promise<void> {
  await createWorkload(
    db,
    {
      id,
      userId: 'user-1',
      workloadType: WorkloadType.Job,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Local,
      region: 'local',
      availabilityZone: 'a',
      vmType: 'local',
      spot: false,
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'test-key',
      credentialId: null,
    },
    { initialState: WorkloadState.Provisioning },
  );
  await provisionVm(new ProvisioningAttemptStore(db), id, { cloudId, ip });
}

/** This spec's own database cannot use the getDB-bound fixture helpers. */
async function provisionVm(
  attempts: ProvisioningAttemptStore,
  workloadId: string,
  vm: { cloudId: string; ip: string },
): Promise<void> {
  const ref = await attempts.beginProvisioningAttempt(workloadId, vm.cloudId);
  await attempts.completeProvisioningAttempt(workloadId, ref!, vm);
}

describe('API ownership backfill', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `anycloud-api-backfill-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    resetApiIdentityForTest();
  });

  afterEach(() => {
    resetApiIdentityForTest();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('snapshots legacy VM rows once and excludes resources created afterward', async () => {
    vi.stubEnv('SQLITE_PATH', join(tempDir, 'api.db'));
    const db = createDatabase();
    await db.init?.();
    const attempts = new ProvisioningAttemptStore(db);
    await createWorkload(
      db,
      {
        id: 'workload-1',
        userId: 'user-1',
        workloadType: WorkloadType.Job,
        image: 'alpine:latest',
        requestedComputeProvider: CloudType.Local,
        region: 'local',
        availabilityZone: 'a',
        vmType: 'local',
        spot: false,
        dockerCommand: 'docker run alpine',
        sshPrivateKey: 'test-key',
        credentialId: null,
      },
      { initialState: WorkloadState.Provisioning },
    );
    await provisionVm(attempts, 'workload-1', {
      cloudId: 'legacy-vm',
      ip: '127.0.0.1',
    });

    const ownership = new ApiOwnershipStore(db);
    await expect(ownership.seedLegacyTargets(API_IDENTITY)).resolves.toBe(1);
    await provisionVm(attempts, 'workload-1', {
      cloudId: 'new-vm',
      ip: '127.0.0.2',
    });
    await expect(ownership.seedLegacyTargets(API_IDENTITY)).resolves.toBe(0);

    const targets = await ownership.listActionableTargets(10);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      cloudId: 'legacy-vm',
      ownerKind: 'workload',
      ownerId: 'workload-1',
      userId: 'user-1',
      cloudProvider: CloudType.Local,
      region: 'local',
      availabilityZone: 'a',
    });
    await ownership.recordTargetResult(
      targets[0]!.vmRowId,
      ApiOwnershipTargetStatus.Missing,
      'Provider resource was not found',
    );
    expect(await ownership.summarize()).toEqual({
      pending: 0,
      retry: 0,
      completed: 0,
      missing: 1,
      unsupported: 0,
      conflict: 0,
    });
    db.close();
  });

  it('preserves adopted forks while assigning divergent resources independently', async () => {
    // Each fork carries the source database's stamp. A local API has no second
    // opinion to weigh it against, so it takes the stamp it finds and the two
    // forks then tag their own resources independently.
    const sourcePath = join(tempDir, 'source.db');
    const localPath = join(tempDir, 'local.db');
    const hostedPath = join(tempDir, 'hosted.db');

    vi.stubEnv('SQLITE_PATH', sourcePath);
    const sourceDb = createDatabase();
    await sourceDb.init?.();
    await addActiveLocalWorkload(
      sourceDb,
      'shared-workload',
      'shared-vm',
      '127.0.0.1',
    );
    sourceDb.close();

    copyFileSync(sourcePath, localPath);
    copyFileSync(sourcePath, hostedPath);

    vi.stubEnv('SQLITE_PATH', localPath);
    const localDb = createDatabase();
    await localDb.init?.();
    const localWorkloads = new WorkloadQueryStore(localDb);
    await addActiveLocalWorkload(
      localDb,
      'local-workload',
      'local-vm',
      '127.0.0.2',
    );
    await expect(bindDatabaseApiIdentity(localDb)).resolves.toEqual({
      newlyBound: true,
    });
    const localOwnership = new ApiOwnershipStore(localDb);
    await expect(localOwnership.seedLegacyTargets(API_IDENTITY)).resolves.toBe(
      2,
    );

    resetApiIdentityForTest();
    vi.stubEnv('SQLITE_PATH', hostedPath);
    const hostedDb = createDatabase();
    await hostedDb.init?.();
    const hostedWorkloads = new WorkloadQueryStore(hostedDb);
    await addActiveLocalWorkload(
      hostedDb,
      'hosted-workload',
      'hosted-vm',
      '127.0.0.3',
    );
    await expect(bindDatabaseApiIdentity(hostedDb)).resolves.toEqual({
      newlyBound: true,
    });
    const hostedOwnership = new ApiOwnershipStore(hostedDb);
    await expect(
      hostedOwnership.seedLegacyTargets(HOSTED_API_IDENTITY),
    ).resolves.toBe(2);

    const resourceOwnerApis = new Map<string, string>();
    const provider = createCloudApiOwnership({
      type: CloudType.Local,
      region: 'local',
      rawBackfillExactVM: async (input) => {
        const tags: Record<string, string> = {
          anycloud_deployment: input.ownerId,
          anycloud_user: input.userId,
        };
        const current = resourceOwnerApis.get(input.cloudId);
        if (current) tags.anycloud_owner_api = current;
        const decision = apiOwnershipTagDecision(tags, input);
        if (decision === 'already-owned') return 'already-owned';
        resourceOwnerApis.set(input.cloudId, input.apiIdentity);
        return 'updated';
      },
    });
    const credentials = {
      getCredentialWithCloudProvider: vi.fn(),
    };

    await expect(
      runApiOwnershipBackfillBatch({
        store: localOwnership,
        credentials,
        apiIdentity: API_IDENTITY,
        createProvider: () => provider,
      }),
    ).resolves.toEqual({
      processed: 2,
      persistedResults: 2,
      summary: {
        pending: 0,
        retry: 0,
        completed: 2,
        missing: 0,
        unsupported: 0,
        conflict: 0,
      },
    });
    await expect(
      runApiOwnershipBackfillBatch({
        store: hostedOwnership,
        credentials,
        apiIdentity: HOSTED_API_IDENTITY,
        createProvider: () => provider,
      }),
    ).resolves.toEqual({
      processed: 2,
      persistedResults: 2,
      summary: {
        pending: 0,
        retry: 0,
        completed: 1,
        missing: 0,
        unsupported: 0,
        conflict: 1,
      },
    });

    expect(Object.fromEntries(resourceOwnerApis)).toEqual({
      'shared-vm': API_IDENTITY,
      'local-vm': API_IDENTITY,
      'hosted-vm': HOSTED_API_IDENTITY,
    });
    await expect(
      localWorkloads.getWorkload('shared-workload'),
    ).resolves.toMatchObject({ id: 'shared-workload' });
    await expect(
      hostedWorkloads.getWorkload('shared-workload'),
    ).resolves.toMatchObject({ id: 'shared-workload' });
    await expect(
      localWorkloads.getWorkload('local-workload'),
    ).resolves.toMatchObject({ id: 'local-workload' });
    await expect(
      hostedWorkloads.getWorkload('hosted-workload'),
    ).resolves.toMatchObject({ id: 'hosted-workload' });
    await expect(
      localWorkloads.getWorkload('hosted-workload'),
    ).resolves.toBeNull();
    await expect(
      hostedWorkloads.getWorkload('local-workload'),
    ).resolves.toBeNull();

    localDb.close();
    hostedDb.close();
  });

  it('persists completed, missing, unsupported, conflict, and retry outcomes independently', async () => {
    const targets = [
      target(1),
      target(2, { vmType: 'unsupported' }),
      target(3),
      target(4),
      target(5, { endedAt: Date.now() }),
      target(6, { cloudProvider: CloudType.AWS, region: null }),
      target(7),
    ];
    const recordTargetResult = vi.fn();
    const store: ApiOwnershipRepository = {
      seedLegacyTargets: vi.fn(),
      listActionableTargets: vi.fn().mockResolvedValue(targets),
      recordTargetResult,
      summarize: vi.fn().mockResolvedValue({
        pending: 0,
        retry: 1,
        completed: 2,
        missing: 1,
        unsupported: 2,
        conflict: 1,
      }),
    };
    const provider = createCloudApiOwnership({
      type: CloudType.Local,
      region: 'local',
      rawBackfillExactVM: async (input) => {
        if (input.cloudId === 'vm-3') {
          throw new ApiOwnershipConflictError('different API');
        }
        if (input.cloudId === 'vm-4') throw new Error('temporary outage');
        if (input.cloudId === 'vm-7') {
          return ApiOwnershipBackfillResult.Missing;
        }
        return 'updated';
      },
    });

    const result = await runApiOwnershipBackfillBatch({
      store,
      credentials: { getCredentialWithCloudProvider: vi.fn() },
      apiIdentity: API_IDENTITY,
      createProvider: (config) =>
        config.vmType === 'unsupported' ? null : provider,
    });

    expect(result).toMatchObject({ processed: 7, persistedResults: 7 });
    expect(recordTargetResult).toHaveBeenCalledWith(
      1,
      ApiOwnershipTargetStatus.Completed,
    );
    expect(recordTargetResult).toHaveBeenCalledWith(
      2,
      ApiOwnershipTargetStatus.Unsupported,
      expect.stringContaining('cannot mutate'),
    );
    expect(recordTargetResult).toHaveBeenCalledWith(
      3,
      ApiOwnershipTargetStatus.Conflict,
      'different API',
    );
    expect(recordTargetResult).toHaveBeenCalledWith(
      4,
      ApiOwnershipTargetStatus.Retry,
      'temporary outage',
    );
    expect(recordTargetResult).toHaveBeenCalledWith(
      5,
      ApiOwnershipTargetStatus.Completed,
    );
    expect(recordTargetResult).toHaveBeenCalledWith(
      6,
      ApiOwnershipTargetStatus.Unsupported,
      expect.stringContaining('region metadata is unavailable'),
    );
    expect(recordTargetResult).toHaveBeenCalledWith(
      7,
      ApiOwnershipTargetStatus.Missing,
      expect.stringContaining('not found'),
    );
  });
});
