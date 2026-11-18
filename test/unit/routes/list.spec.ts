import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { getWorkloadOutcomes } from '../../../src/api/services/persistence.js';
import { callApi } from '../helpers/api-test-helper';
import { createTestWorkload, getTestWorkload } from '../utils';
import { TEST_USER_ID } from '../../../src/api/services/test-identity.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { walkToState, provisionTestVm } from '../../helpers/workload-store.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { getDeploymentStore } from '../../../src/api/services/persistence.js';
import {
  upsertApiAccessOwner,
  upsertApiAccessUser,
} from '../../../src/api/services/repositories/api-access-policy.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

function listRequest(
  query: Record<string, unknown> = {},
  authenticated = true,
): Promise<Response> {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) search.set(name, String(value));
  }
  const suffix = search.size === 0 ? '' : `?${search}`;
  return callApi(`https://example.com/v1/workloads${suffix}`, {
    headers: authenticated
      ? { Authorization: 'Bearer mock-github-token' }
      : undefined,
  });
}

describe('GET /v1/workloads', () => {
  // Test user is "test-user" based on mock in test/unit/setup.ts
  const testUsername = 'test-user';

  it('should return empty array when no workloads', async () => {
    const response = await listRequest();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('should return workloads for authenticated user', async () => {
    // Setup test workloads in SQLite
    await createTestWorkload(
      'deploy-abc123',
      testUsername,
      WorkloadState.Running,
    );
    await createTestWorkload(
      'deploy-xyz789',
      testUsername,
      WorkloadState.Provisioning,
    );

    const response = await listRequest();

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);

    // Find our test workloads
    const abc = data.find((d: any) => d.id === 'deploy-abc123');
    const xyz = data.find((d: any) => d.id === 'deploy-xyz789');

    expect(abc).toBeDefined();
    expect(abc.state).toBe(WorkloadState.Running);

    expect(xyz).toBeDefined();
    expect(xyz.state).toBe(WorkloadState.Provisioning);
  });

  it('should include full StoredWorkload fields in response', async () => {
    // Setup workload with specific state in SQLite
    await createTestWorkload(
      'deploy-full-fields',
      testUsername,
      WorkloadState.Running,
    );

    const response = await listRequest();

    expect(response.status).toBe(200);
    const data = await response.json();

    const deploy = data.find((d: any) => d.id === 'deploy-full-fields');
    expect(deploy).toBeDefined();

    // Verify StoredWorkload fields are present
    expect(deploy.id).toBe('deploy-full-fields');
    expect(deploy.userId).toBe(testUsername);
    expect(deploy.isOwnedByCaller).toBe(true);
    expect(deploy.state).toBe(WorkloadState.Running);
    expect(deploy.workloadType).toBe('job');
    expect(deploy.image).toBe('test-image');
    expect(typeof deploy.spot).toBe('boolean');
    expect(typeof deploy.startedAt).toBe('number');
    expect(typeof deploy.vmCount).toBe('number');
    expect(deploy).not.toHaveProperty('clusterId');
  });

  it('should return vmCount=0 for workloads without VMs', async () => {
    const deployId = `deploy-no-vms-${Date.now()}`;
    await createTestWorkload(deployId, testUsername, WorkloadState.Running);

    const response = await listRequest();

    expect(response.status).toBe(200);
    const data = await response.json();
    const deploy = data.find((d: any) => d.id === deployId);
    expect(deploy).toBeDefined();
    expect(deploy.vmCount).toBe(0);
  });

  it('should return correct vmCount for workloads with VMs', async () => {
    const deployId = `deploy-with-vms-${Date.now()}`;
    await createTestWorkload(
      deployId,
      testUsername,
      WorkloadState.Provisioning,
    );
    await provisionTestVm(deployId, { ip: '10.0.0.1', cloudId: 'vm-1' });
    await provisionTestVm(deployId, { ip: '10.0.0.2', cloudId: 'vm-2' });
    await walkToState(deployId, WorkloadState.Running);

    const response = await listRequest();

    expect(response.status).toBe(200);
    const data = await response.json();
    const deploy = data.find((d: any) => d.id === deployId);
    expect(deploy).toBeDefined();
    expect(deploy.vmCount).toBe(2);
  });

  it.each([
    WorkloadState.Terminated,
    WorkloadState.Failed,
    WorkloadState.Completed,
    WorkloadState.Errored,
  ])(
    'should return %s workloads (terminal states persist in SQLite)',
    async (state) => {
      const deployId = `deploy-terminal-${state}-${Date.now()}`;
      await createTestWorkload(deployId, testUsername, state);

      const response = await listRequest();

      expect(response.status).toBe(200);
      const data = await response.json();
      const deploy = data.find((d: any) => d.id === deployId);
      expect(deploy).toBeDefined();
      expect(deploy.state).toBe(state);

      // Verify workload persists in SQLite (no longer deleted)
      const dbDeploy = await getTestWorkload(deployId);
      expect(dbDeploy).not.toBeNull();
      expect(dbDeploy!.state).toBe(state);
    },
  );

  it.each([
    WorkloadState.Provisioning,
    WorkloadState.Starting,
    WorkloadState.Running,
  ])('should return %s workloads (active states)', async (state) => {
    const deployId = `deploy-active-${state}-${Date.now()}`;
    await createTestWorkload(deployId, testUsername, state);

    const response = await listRequest();

    expect(response.status).toBe(200);
    const data = await response.json();
    const deploy = data.find((d: any) => d.id === deployId);
    expect(deploy).toBeDefined();
    expect(deploy.state).toBe(state);
  });

  describe('shared hosted API', () => {
    const listAs = async (query: Record<string, unknown>) => {
      const response = await listRequest(query);
      expect(response.status).toBe(200);
      const rows = (await response.json()) as Array<{ id: string }>;
      // Other tests in this file share the database; only these two fixtures
      // carry the durable owner ids this block is about.
      return rows
        .map((row) => row.id)
        .filter((id) => id.startsWith('shared-'))
        .sort();
    };

    beforeEach(async () => {
      await upsertApiAccessOwner('original-owner', '77');
      await upsertApiAccessUser({
        userId: TEST_USER_ID,
        username: testUsername,
      });
      await createTestWorkload(
        'shared-mine',
        testUsername,
        WorkloadState.Queued,
        false,
        TEST_USER_ID,
      );
      await createTestWorkload(
        'shared-teammates',
        'teammate',
        WorkloadState.Queued,
        false,
        '77',
      );
    });

    afterEach(async () => {
      const db = getDB();
      await db.query('DELETE FROM api_access_users');
      await db.query('DELETE FROM api_access_policy');
      await db.query(
        `DELETE FROM workloads WHERE id IN ('shared-mine', 'shared-teammates')`,
      );
    });

    it('lists every user’s workloads', async () => {
      await expect(listAs({})).resolves.toEqual([
        'shared-mine',
        'shared-teammates',
      ]);
    });

    it('marks caller-owned and teammate-owned workloads independently', async () => {
      const response = await listRequest();
      expect(response.status).toBe(200);
      const rows = (await response.json()) as Array<{
        id: string;
        isOwnedByCaller: boolean;
      }>;

      expect(rows.find(({ id }) => id === 'shared-mine')).toMatchObject({
        isOwnedByCaller: true,
      });
      expect(rows.find(({ id }) => id === 'shared-teammates')).toMatchObject({
        isOwnedByCaller: false,
      });
    });

    it('uses immutable owner ids when the caller has renamed', async () => {
      await getDB().query('DELETE FROM workloads WHERE id = ?', [
        'shared-mine',
      ]);
      await createTestWorkload(
        'shared-mine',
        'old-test-user',
        WorkloadState.Queued,
        false,
        TEST_USER_ID,
      );

      const response = await listRequest();
      expect(response.status).toBe(200);
      const rows = (await response.json()) as Array<{
        id: string;
        isOwnedByCaller: boolean;
      }>;
      expect(rows.find(({ id }) => id === 'shared-mine')).toMatchObject({
        isOwnedByCaller: true,
      });
    });

    it('narrows to one account by username or by immutable id', async () => {
      await expect(listAs({ user: 'teammate' })).resolves.toEqual([
        'shared-teammates',
      ]);
      await expect(listAs({ user: '77' })).resolves.toEqual([
        'shared-teammates',
      ]);
    });

    it('keeps teammate ownership visible after narrowing to one creator', async () => {
      const response = await listRequest({ user: 'teammate' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({
          id: 'shared-teammates',
          isOwnedByCaller: false,
        }),
      ]);
    });
  });

  it('requires bearer authentication', async () => {
    const response = await listRequest({}, false);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Missing access token',
    });
  });

  it('rejects obsolete request fields', async () => {
    const response = await listRequest({ version: 'legacy-body-version' });

    expect(response.status).toBe(400);
    const errorText = await response.text();
    expect(errorText).toContain('Unrecognized key');
  });

  describe('limit parameter', () => {
    it.each([0, -1])('rejects non-positive limit %d', async (limit) => {
      const response = await listRequest({ limit });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'BAD_REQUEST',
        data: {
          issues: [
            expect.objectContaining({
              code: 'too_small',
              path: ['query', 'limit'],
            }),
          ],
        },
      });
    });

    // Tests below tag their fixtures with a unique session and query with
    // sessionExact so ambient workloads left behind by earlier tests in
    // this file (which share one DB) can't affect the count.
    const tagSession = async (tag: string, ids: string[]) => {
      await getDB().query(
        `UPDATE workloads SET session = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [tag, ...ids],
      );
    };

    it('limit=1 caps terminal workloads to 1', async () => {
      const tag = `limit1-terminal-${Date.now()}`;
      const id1 = `deploy-${tag}-a`;
      const id2 = `deploy-${tag}-b`;
      await createTestWorkload(id1, testUsername, WorkloadState.Completed);
      await createTestWorkload(id2, testUsername, WorkloadState.Completed);
      await tagSession(tag, [id1, id2]);

      const response = await listRequest({
        limit: 1,
        session: tag,
        sessionExact: true,
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      // Only the more-recently-started of the two survives the cap.
      expect(data.map((d: any) => d.id)).toEqual([id2]);
    });

    it('limit=1 caps active workloads too, not exempt from it', async () => {
      // Regression test: an active-heavy filtered request (e.g. --status
      // running -n 1) must still respect the requested cap instead of
      // returning every active row regardless of what was asked.
      const tag = `limit1-active-cap-${Date.now()}`;
      const ids = [0, 1, 2].map((i) => `deploy-${tag}-${i}`);
      for (const id of ids) {
        await createTestWorkload(id, testUsername, WorkloadState.Running);
        await new Promise((r) => setTimeout(r, 5));
      }
      await tagSession(tag, ids);

      const response = await listRequest({
        limit: 1,
        session: tag,
        sessionExact: true,
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      // The newest of the three active rows survives; the other two —
      // still active and billing — are capped out like any other row.
      expect(data.map((d: any) => d.id)).toEqual([ids[2]]);
    });

    it('active rows fully survive when they fit within the limit', async () => {
      const tag = `limit-active-fits-${Date.now()}`;
      const id1 = `deploy-${tag}-a`;
      const id2 = `deploy-${tag}-b`;
      await createTestWorkload(id1, testUsername, WorkloadState.Running);
      await createTestWorkload(id2, testUsername, WorkloadState.Provisioning);
      await tagSession(tag, [id1, id2]);

      const response = await listRequest({
        limit: 2,
        session: tag,
        sessionExact: true,
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      // Both fit under the cap (still billing) — neither is evicted.
      expect(data.map((d: any) => d.id).sort()).toEqual([id1, id2].sort());
    });

    it('omitting limit (the real default view) never truncates active workloads, however many', async () => {
      // End-to-end version of the bug this whole fix targets: a bare
      // `anycloud list` (no -n at all) against an active-heavy account
      // (e.g. a large training fleet) must not silently drop live rows.
      const tag = `no-limit-active-${Date.now()}`;
      const ids = [0, 1, 2].map((i) => `deploy-${tag}-${i}`);
      for (const id of ids) {
        await createTestWorkload(id, testUsername, WorkloadState.Running);
      }
      await tagSession(tag, ids);

      const response = await listRequest({
        session: tag,
        sessionExact: true,
        // No `limit` field at all — the actual shape of a bare CLI call.
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.map((d: any) => d.id).sort()).toEqual([...ids].sort());
    });

    it('defaults to a bounded page when limit is omitted', async () => {
      const activeId = `deploy-default-limit-${Date.now()}`;
      await createTestWorkload(activeId, testUsername, WorkloadState.Running);

      const response = await listRequest();

      expect(response.status).toBe(200);
      const data = await response.json();
      const deploy = data.find((d: any) => d.id === activeId);
      expect(deploy).toBeDefined();
    });
  });
});

describe('GET /v1/workloads server-side filtering', () => {
  const u = 'test-user';
  const get = (query: Record<string, unknown>) => listRequest(query);
  const idsOf = async (res: Response): Promise<string[]> =>
    (await res.json()).map((d: { id: string }) => d.id);

  it('status filters to the exact state', async () => {
    const run = `f-status-run-${Date.now()}`;
    const done = `f-status-done-${Date.now()}`;
    await createTestWorkload(run, u, WorkloadState.Running);
    await createTestWorkload(done, u, WorkloadState.Completed);
    const res = await get({ status: 'running' });
    expect(res.status).toBe(200);
    const ids = await idsOf(res);
    expect(ids).toContain(run);
    expect(ids).not.toContain(done);
  });

  it('deploymentId filters to one exact Deployment target', async () => {
    const stamp = Date.now();
    const nodePoolId = `list-pool-${stamp}`;
    const firstDeploymentId = `list-deployment-${stamp}`;
    const secondDeploymentId = `${firstDeploymentId}-other`;
    await seedReadyNodePool({ nodePoolId, ownerUserId: TEST_USER_ID });
    for (const deploymentId of [firstDeploymentId, secondDeploymentId]) {
      await getDeploymentStore().create(
        {
          id: deploymentId,
          ownerUserId: TEST_USER_ID,
          name: deploymentId,
          nodePoolId,
          config: {
            image: 'example/deployment:latest',
            imageDigest: null,
            command: null,
            env: null,
            registryUsername: u,
            registryToken: null,
            dockerOptions: null,
          },
          gpuCount: 0,
          maxConcurrentJobsPerReplica: 1,
        },
        { kind: 'api' },
      );
    }
    const firstJob = `list-job-${stamp}`;
    const secondJob = `${firstJob}-other`;
    expect(
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id: firstJob,
        userId: u,
        ownerUserId: TEST_USER_ID,
        deploymentId: firstDeploymentId,
      }),
    ).toBe(true);
    expect(
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id: secondJob,
        userId: u,
        ownerUserId: TEST_USER_ID,
        deploymentId: secondDeploymentId,
      }),
    ).toBe(true);

    const response = await get({ deploymentId: firstDeploymentId });

    expect(response.status).toBe(200);
    const ids = await idsOf(response);
    expect(ids).toContain(firstJob);
    expect(ids).not.toContain(secondJob);
  });

  it('rejects an empty deploymentId filter', async () => {
    const response = await get({ deploymentId: ' ' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('deploymentId');
  });

  it('rejects an unknown status with 400', async () => {
    const res = await get({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('status');
  });

  it('rejects an unknown credential with 400', async () => {
    const res = await get({ credentialName: 'missing-credential' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
      message: 'Credential "missing-credential" not found',
    });
  });

  it('rejects an unknown stateClass with 400', async () => {
    const res = await get({ stateClass: 'whatever' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('stateClass');
  });

  it('stateClass=resubmittable returns terminal-but-not-completed', async () => {
    const failed = `f-resub-failed-${Date.now()}`;
    const completed = `f-resub-done-${Date.now()}`;
    const vm = `f-resub-vm-${Date.now()}`;
    await createTestWorkload(failed, u, WorkloadState.Failed);
    await createTestWorkload(completed, u, WorkloadState.Completed);
    expect(await getWorkloadOutcomes().markCleanupComplete(failed)).toBe(true);
    await createWorkload(getDB(), {
      id: vm,
      userId: u,
      workloadType: 'vm',
      image: 'test-image',
      dockerCommand: 'docker run vm',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(vm, WorkloadState.Failed);
    expect(await getWorkloadOutcomes().markCleanupComplete(vm)).toBe(true);
    const ids = await idsOf(await get({ stateClass: 'resubmittable' }));
    expect(ids).toContain(failed);
    expect(ids).not.toContain(completed);
    expect(ids).not.toContain(vm);
  });

  it('stateClass=terminatable includes cleanup-needed terminal workloads regardless of VM presence', async () => {
    const active = `f-term-active-${Date.now()}`;
    const termVm = `f-term-vm-${Date.now()}`;
    const termNoVm = `f-term-novm-${Date.now()}`;
    const termClean = `f-term-clean-${Date.now()}`;
    const termMalformed = `f-term-malformed-${Date.now()}`;
    await createTestWorkload(active, u, WorkloadState.Running);
    await createTestWorkload(termVm, u, WorkloadState.Provisioning);
    await provisionTestVm(termVm, { ip: '10.1.2.3', cloudId: 'cloud-term-vm' });
    await walkToState(termVm, WorkloadState.Completed);
    await createTestWorkload(termNoVm, u, WorkloadState.Completed);
    await createTestWorkload(termClean, u, WorkloadState.Completed);
    await createTestWorkload(termMalformed, u, WorkloadState.Completed);
    await getDB().query(
      'UPDATE workloads SET completed_at = NULL WHERE id = ?',
      [termMalformed],
    );
    expect(await getWorkloadOutcomes().markCleanupComplete(termClean)).toBe(
      true,
    );
    const ids = await idsOf(await get({ stateClass: 'terminatable' }));
    expect(ids).toContain(active);
    expect(ids).toContain(termVm);
    expect(ids).toContain(termNoVm);
    expect(ids).not.toContain(termClean);
    expect(ids).not.toContain(termMalformed);
  });

  it('filter substring matches, and LIKE metacharacters stay literal', async () => {
    const tagged = `f-search-zzqq-${Date.now()}`;
    await createTestWorkload(tagged, u, WorkloadState.Running);
    expect(await idsOf(await get({ filter: 'zzqq' }))).toContain(tagged);
    // `%` must be a literal char, not a match-everything wildcard.
    expect(await idsOf(await get({ filter: '%' }))).not.toContain(tagged);
  });

  it('filter substring matches the session label and agent columns', async () => {
    const stamp = Date.now();
    const labelled = `f-label-${stamp}`;
    const agented = `f-agent-${stamp}`;
    await createTestWorkload(labelled, u, WorkloadState.Running);
    await createTestWorkload(agented, u, WorkloadState.Running);
    // The search term appears only in the column under test, never in the id,
    // so a hit proves that column is searched.
    await getDB().query('UPDATE workloads SET session_label = ? WHERE id = ?', [
      `Refactor qqlabel${stamp}`,
      labelled,
    ]);
    await getDB().query('UPDATE workloads SET agent = ? WHERE id = ?', [
      `qqagent${stamp}`,
      agented,
    ]);

    const byLabel = await idsOf(await get({ filter: `qqlabel${stamp}` }));
    expect(byLabel).toContain(labelled);
    expect(byLabel).not.toContain(agented);

    const byAgent = await idsOf(await get({ filter: `qqagent${stamp}` }));
    expect(byAgent).toContain(agented);
    expect(byAgent).not.toContain(labelled);
  });

  it('filter substring matches the canonical Service type only', async () => {
    const id = `f-search-service-${Date.now()}`;
    await createWorkload(getDB(), {
      id,
      userId: u,
      workloadType: 'service',
      image: 'test-image',
      dockerCommand: 'docker run service',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(id, WorkloadState.Running);

    expect(await idsOf(await get({ filter: 'service' }))).toContain(id);
    // service-terminology-ok: prove free-text search has no removed alias
    expect(await idsOf(await get({ filter: 'server' }))).not.toContain(id);
  });

  it('status matches case-insensitively (canonical casing accepted)', async () => {
    const run = `f-status-upper-${Date.now()}`;
    await createTestWorkload(run, u, WorkloadState.Running);
    // `running` is the stored value; the handler lowercases the input, so an
    // uppercased flag value must still match.
    const ids = await idsOf(await get({ status: 'RUNNING' }));
    expect(ids).toContain(run);
  });

  it('workloadType filters Jobs, Services, and VMs by canonical value', async () => {
    const suffix = Date.now();
    const job = `f-type-job-${suffix}`;
    const service = `f-type-service-${suffix}`;
    const vm = `f-type-vm-${suffix}`;
    await createTestWorkload(job, u, WorkloadState.Running);
    await createWorkload(getDB(), {
      id: service,
      userId: u,
      workloadType: 'service',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(service, WorkloadState.Running);
    await createWorkload(getDB(), {
      id: vm,
      userId: u,
      workloadType: 'vm',
      image: 'test-image',
      dockerCommand: 'docker run vm',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: 'test-credential-id',
    });
    await walkToState(vm, WorkloadState.Running);

    const serviceIds = await idsOf(await get({ workloadType: 'service' }));
    expect(serviceIds).toContain(service);
    expect(serviceIds).not.toContain(job);
    expect(serviceIds).not.toContain(vm);

    // service-terminology-ok: prove the removed discriminator is rejected
    const unsupportedServerResponse = await get({ workloadType: 'server' });
    expect(unsupportedServerResponse.status).toBe(400);

    const jobIds = await idsOf(await get({ workloadType: 'job' }));
    expect(jobIds).toContain(job);
    expect(jobIds).not.toContain(service);
    expect(jobIds).not.toContain(vm);

    const vmIds = await idsOf(await get({ workloadType: 'vm' }));
    expect(vmIds).toContain(vm);
    expect(vmIds).not.toContain(job);
    expect(vmIds).not.toContain(service);
  });

  it('rejects an unknown workloadType with 400', async () => {
    const res = await get({ workloadType: 'app' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('workloadType');
  });

  it('credentialName matches selected workloads and historical VM credentials', async () => {
    const suffix = Date.now();
    const credentialId = `f-list-cred-main-${suffix}`;
    const otherCredentialId = `f-list-cred-other-${suffix}`;
    const selected = `f-cred-selected-${suffix}`;
    const historicalWithVm = `f-cred-vm-${suffix}`;
    const other = `f-cred-other-${suffix}`;
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name) VALUES (?, '', ?, ?)`,
      [credentialId, CloudType.AWS, 'prod-aws-list'],
    );
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name) VALUES (?, '', ?, ?)`,
      [otherCredentialId, CloudType.GCP, 'prod-gcp-list'],
    );

    await createWorkload(getDB(), {
      id: selected,
      userId: u,
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId,
    });
    await walkToState(selected, WorkloadState.Running);

    await createWorkload(getDB(), {
      id: historicalWithVm,
      userId: u,
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: null,
    });
    await provisionTestVm(
      historicalWithVm,
      { ip: '10.2.3.4', cloudId: `cloud-${historicalWithVm}` },
      { credentialId, region: 'us-east-1', vmType: 't3.medium' },
    );
    await walkToState(historicalWithVm, WorkloadState.Running);

    await createWorkload(getDB(), {
      id: other,
      userId: u,
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      region: 'us-central1',
      vmType: 'n1-standard-1',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: otherCredentialId,
    });
    await walkToState(other, WorkloadState.Running);

    const ids = await idsOf(await get({ credentialName: 'prod-aws-list' }));
    expect(ids).toContain(selected);
    expect(ids).toContain(historicalWithVm);
    expect(ids).not.toContain(other);
  });
});

describe('GET /v1/workloads secret redaction', () => {
  const testUsername = 'test-user';

  it('never ships decrypted secrets in the bulk listing', async () => {
    // Seed the credential FK row, then create a workload carrying every
    // secret class: ssh key, env vars, github token.
    await createTestWorkload(
      'deploy-cred-seed',
      testUsername,
      WorkloadState.Queued,
    );
    await createWorkload(getDB(), {
      id: 'deploy-secret-redaction',
      userId: testUsername,
      workloadType: 'job',
      image: 'test-image',
      dockerCommand: 'docker run -d --name test test-image',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      spot: false,
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: 'test-credential-id',
      env: { SECRET_TOKEN: 'super-secret-env-value' },
      githubToken: 'ghp-secret-token-value',
    });

    const response = await listRequest();

    expect(response.status).toBe(200);
    const text = await response.text();
    // No secret material anywhere in the payload, for any workload.
    expect(text).not.toContain('test-ssh-private-key');
    expect(text).not.toContain('super-secret-env-value');
    expect(text).not.toContain('ghp-secret-token-value');

    const data = JSON.parse(text);
    const deploy = data.find((d: any) => d.id === 'deploy-secret-redaction');
    expect(deploy).toBeDefined();
    for (const key of [
      'env',
      'githubToken',
      'registryUsername',
      'sshPrivateKey',
    ]) {
      expect(deploy).not.toHaveProperty(key);
    }
    // Non-secret fields survive redaction untouched.
    expect(deploy.state).toBe(WorkloadState.Queued);
    expect(deploy.image).toBe('test-image');
  });
});
