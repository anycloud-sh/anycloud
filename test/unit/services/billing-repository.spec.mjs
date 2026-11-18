import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../../src/api/config.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  listVmCostGroupsPage,
  listVmsNeedingCost,
  settleVmCostGroup,
} from '../../../src/api/services/repositories/billing.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  seedBillingCredential as credential,
  seedBillingGroup as seedGroup,
} from '../../helpers/billing-groups.mjs';
import { walkToState } from '../../helpers/workload-store.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';

const DAY_MS = 24 * 3600_000;
const NOW = Date.now();
const cutoffMs = NOW - DAY_MS;
const groupKey = (row) =>
  JSON.stringify([row.resource_tag, row.resource_id, row.credential_id]);

beforeEach(() => {
  resetPersistence();
  config.cipherKey = 'a'.repeat(64);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

async function drainPages(pageSize, onPage = async () => {}) {
  const groups = [];
  const seen = new Set();
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await listVmCostGroupsPage({
      pageSize,
      oldestEndedMs: 0,
      cutoffMs,
      cursor,
    });
    expect(page.examinedGroups).toBeLessThanOrEqual(pageSize);
    groups.push(...page.groups);
    await onPage(page);
    if (page.finished) return groups;
    const key = JSON.stringify(page.cursor);
    expect(
      seen.has(key),
      'Cursor must advance even without eligible rows',
    ).toBe(false);
    seen.add(key);
    cursor = page.cursor;
  }
  throw new Error('Billing discovery did not finish');
}

describe('bounded billing repository discovery', () => {
  it.each([1, 7, 20])(
    'preserves complete resource/account groups with a %i-candidate page',
    async (pageSize) => {
      const db = getDB();
      const accountA = await credential('account-a');
      const accountB = await credential('account-b');
      const [{ encrypted_data: encrypted }] = await db.query(
        'SELECT encrypted_data FROM credentials WHERE id=?',
        [accountA],
      );
      await upsertCredential(getDB(), '', encrypted, CloudType.AWS);
      for (let index = 0; index < 23; index++) {
        await seedGroup({
          id: 'owner-' + String(index).padStart(2, '0'),
          credentialId: accountA,
          state:
            index === 0 ? WorkloadState.Provisioning : WorkloadState.Completed,
        });
      }
      // NULL and empty are distinct keys. The NULL group is discoverable via
      // the owner's credential; the billing identity loader still skips it.
      for (const [suffix, selected] of [
        ['override', accountB],
        ['null', null],
        ['empty', ''],
      ]) {
        await seedGroup({
          id: 'owner-00',
          credentialId: accountA,
          vmCredentialId: selected,
          suffix,
          state:
            suffix === 'empty'
              ? WorkloadState.Completed
              : WorkloadState.Provisioning,
        });
      }
      const persistence = getPersistence();
      await persistence.clusters.recordSelf({
        id: 'billing-cluster',
        ownerUserId: 'test-user',
        name: 'billing-cluster',
        kubernetesIdentity: 'uid-billing-cluster',
        connection: '{"stored":true}',
      });
      await persistence.nodePools.create({
        id: 'owner-00',
        clusterId: 'billing-cluster',
        ownerUserId: 'test-user',
        name: 'billing-fixture',
        computeCredentialId: accountA,
        region: 'us-east-1',
        zone: null,
        vmTypes: ['t3.medium'],
        minVmCount: 1,
        maxVmCount: 1,
      });
      await db.query('UPDATE node_pools SET state=? WHERE id=?', [
        NodePoolState.Deleted,
        'owner-00',
      ]);
      await db.query(
        `INSERT INTO vms
         (cloud_id, node_pool_id, credential_id, created_at, ended_at, region, vm_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          'node-pool-vm',
          'owner-00',
          accountB,
          NOW - 4 * DAY_MS,
          NOW - 3 * DAY_MS,
          'us-east-1',
          't3.medium',
        ],
      );
      const bulk = await listVmsNeedingCost(getDB(), cutoffMs);
      const groups = await drainPages(pageSize);
      expect(groups).toHaveLength(27);
      expect(new Set(groups.map((group) => groupKey(group[0]))).size).toBe(27);
      for (const group of groups) {
        expect(group.every((row) => groupKey(row) === groupKey(group[0]))).toBe(
          true,
        );
        expect(group).toHaveLength(
          group[0].resource_tag === 'anycloud_resource' ? 1 : 3,
        );
      }
      const rows = groups.flat();
      expect(new Set(rows.map((row) => row.id)).size).toBe(bulk.length);
      const canonical = (values) =>
        values.toSorted((a, b) => a.cloud_id.localeCompare(b.cloud_id));
      expect(
        canonical(
          rows.map(({ id: _id, billable_at: _billableAt, ...row }) => row),
        ),
      ).toEqual(canonical(bulk));
    },
  );

  it('budgets ineligible candidates and finds the tail using indexed scalar seeks', async () => {
    const db = getDB();
    const account = await credential('account-a');
    for (let index = 0; index < 30; index++) {
      const id = 'skip-' + String(index).padStart(2, '0');
      await seedGroup({
        id,
        credentialId: account,
        weights: [1],
        state:
          index % 3 === 0 ? WorkloadState.Running : WorkloadState.Completed,
      });
      if (index % 3 === 1) {
        await db.query('UPDATE vms SET ended_at=? WHERE workload_id=?', [
          NOW,
          id,
        ]);
      } else {
        await db.query('UPDATE workloads SET credential_id=NULL WHERE id=?', [
          id,
        ]);
        await db.query(
          'UPDATE vms SET credential_id=NULL WHERE workload_id=?',
          [id],
        );
      }
    }
    await seedGroup({ id: 'z-eligible', credentialId: account });
    const original = db.query.bind(db);
    const queries = [];
    vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
      const rows = await original(sql, params);
      queries.push({ sql, params, returned: rows.length });
      return rows;
    });
    const pages = [];
    const groups = await drainPages(7, async (page) => pages.push(page));
    vi.mocked(db.query).mockRestore();
    expect(pages.map((page) => page.examinedGroups)).toEqual([7, 7, 7, 7, 3]);
    expect(pages.slice(0, 4).every((page) => page.groups.length === 0)).toBe(
      true,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
    expect(groups[0][0].resource_id).toBe('z-eligible');
    expect(queries.length).toBeLessThanOrEqual(31 * 5 + 4);
    const plans = await Promise.all(
      queries.map(async ({ sql, params, returned }, index) => {
        expect(sql).not.toMatch(/\b(OFFSET|DISTINCT|GROUP BY)\b/i);
        if (/LIMIT 1/.test(sql)) expect(returned).toBeLessThanOrEqual(1);
        const details = (await db.query('EXPLAIN QUERY PLAN ' + sql, params))
          .map((row) => row.detail)
          .join('\n');
        expect(details).not.toMatch(/TEMP B-TREE/);
        expect(details).toContain('idx_vms_pending_cost_group');
        if (index > 0) {
          expect(details).toContain(
            'SEARCH v USING INDEX idx_vms_pending_cost_group',
          );
          expect(details).not.toMatch(/SCAN v /);
        }
        return details;
      }),
    );
    expect(plans[0]).toContain('SCAN v USING INDEX idx_vms_pending_cost_group');
  });

  it('discovers node pool and cluster attempts once their owner is gone', async () => {
    const db = getDB();
    const account = await credential('account-a');
    // One cluster record: the installer's bootstrap facts and the cluster identity.
    await db.query(
      `INSERT INTO clusters (
         id, owner_user_id, name, state, step, compute_credential_id, region,
         vm_type, k3s_version, k3s_sha256, helm_job_image, api_version,
         api_image, chart_version, chart_sha256, encrypted_server_token,
         ssh_public_key, encrypted_ssh_private_key, kubernetes_identity,
         encrypted_connection, created_at, updated_at
       ) VALUES ('install-a', 'test-user', 'production', 'ready', 'release', ?,
         'us-east-1', 't3.medium', 'v1.35.5+k3s1', ?, 'helm@sha256:' || ?,
         '0.1.64', 'api@sha256:' || ?, '0.1.0', ?, 'enc', 'pub', 'enc',
         'uid-a', 'enc', 1, 1)`,
      [account, '0'.repeat(64), '0'.repeat(64), '0'.repeat(64), '0'.repeat(64)],
    );
    await db.query(
      `INSERT INTO node_pools (
         id, cluster_id, owner_user_id, name, state, compute_credential_id,
         region, vm_type, min_vm_count, max_vm_count, created_at, updated_at
       ) VALUES ('node-pool-a', 'install-a', 'test-user', 'aws-east', 'ready', ?,
         'us-east-1', 't3.small', 1, 1, 1, 1)`,
      [account],
    );
    for (const [column, owner, cloudId] of [
      ['node_pool_id', 'node-pool-a', 'node-pool-vm'],
      ['cluster_id', 'install-a', 'management-vm'],
    ]) {
      await db.query(
        `INSERT INTO vms
         (cloud_id, ${column}, credential_id, created_at, ended_at, region, vm_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          cloudId,
          owner,
          account,
          NOW - 4 * DAY_MS,
          NOW - 3 * DAY_MS,
          'us-east-1',
          't3.medium',
        ],
      );
    }

    // Live owners are not eligible yet.
    expect(await listVmsNeedingCost(getDB(), cutoffMs)).toEqual([]);
    expect(await drainPages(5)).toEqual([]);

    await db.query(
      `UPDATE node_pools SET state='deleted' WHERE id='node-pool-a'`,
    );
    await db.query(
      `UPDATE clusters SET state='destroyed', encrypted_connection=NULL WHERE id='install-a'`,
    );
    const bulk = await listVmsNeedingCost(getDB(), cutoffMs);
    expect(
      bulk.map(
        ({
          cloud_id,
          resource_tag,
          resource_id,
          node_pool_id,
          cluster_id,
        }) => ({
          cloud_id,
          resource_tag,
          resource_id,
          node_pool_id,
          cluster_id,
        }),
      ),
    ).toEqual([
      {
        cloud_id: 'management-vm',
        resource_tag: 'anycloud_resource',
        resource_id: 'install-a',
        node_pool_id: null,
        cluster_id: 'install-a',
      },
      {
        cloud_id: 'node-pool-vm',
        resource_tag: 'anycloud_resource',
        resource_id: 'node-pool-a',
        node_pool_id: 'node-pool-a',
        cluster_id: null,
      },
    ]);
    const groups = await drainPages(1);
    expect(groups.map((group) => group.map((row) => row.cloud_id))).toEqual([
      ['management-vm'],
      ['node-pool-vm'],
    ]);
  });

  it('advances after settled groups leave the index and revisits earlier eligibility next sweep', async () => {
    const account = await credential('account-a');
    for (const id of ['a-earlier', 'b-middle', 'c-tail']) {
      await seedGroup({
        id,
        credentialId: account,
        weights: [1],
        state:
          id === 'a-earlier' ? WorkloadState.Running : WorkloadState.Completed,
      });
    }
    let pageNumber = 0;
    const firstSweep = await drainPages(1, async (page) => {
      pageNumber++;
      if (pageNumber === 1) {
        await walkToState('a-earlier', WorkloadState.Completed);
      }
      for (const group of page.groups) {
        await settleVmCostGroup(
          group.map((row) => ({ vmId: row.id, costUsd: 137 })),
        );
      }
    });
    expect(firstSweep.map((group) => group[0].resource_id)).toEqual([
      'b-middle',
      'c-tail',
    ]);
    expect((await drainPages(1)).map((group) => group[0].resource_id)).toEqual([
      'a-earlier',
    ]);
  });
});

describe('atomic billing repository settlement', () => {
  it.each(['settled', 'missing'])(
    'rolls back earlier writes if a later VM is %s',
    async (state) => {
      const db = getDB();
      const account = await credential('account-a');
      await seedGroup({ id: 'owner', credentialId: account, weights: [1, 2] });
      const rows = await db.query('SELECT id FROM vms ORDER BY id');
      const laterId = rows[1].id;
      if (state === 'settled') {
        await db.query('UPDATE vms SET cost=17 WHERE id=?', [laterId]);
      } else {
        await db.query('DELETE FROM vms WHERE id=?', [laterId]);
      }
      await expect(
        settleVmCostGroup([
          { vmId: rows[0].id, costUsd: 11 },
          { vmId: laterId, costUsd: 22 },
        ]),
      ).rejects.toThrow('Billing group changed');
      expect(
        await db.query('SELECT cost FROM vms WHERE id=?', [rows[0].id]),
      ).toEqual([{ cost: null }]);
      expect(
        await db.query('SELECT cost FROM vms WHERE id=?', [laterId]),
      ).toEqual(state === 'settled' ? [{ cost: 17 }] : []);
    },
  );
});
