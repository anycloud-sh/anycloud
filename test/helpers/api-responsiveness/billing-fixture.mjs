import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SYNTHETIC_BILL_USD,
  billingMemberDigest,
} from './billing-provider.mjs';

export const BUSINESS_TIME_MS = 2_000_000_000_000;
export const BILL_LAG_MS = 24 * 3600_000;
export const BILLING_PROFILES = {
  smoke: { owners: 40, groups: 45, scale: 1, largestGroup: 327, rows: 1119 },
  standard: {
    owners: 14218,
    groups: 15452,
    scale: 1,
    largestGroup: 327,
    rows: 268317,
  },
  backlog3: {
    owners: 14218,
    groups: 15452,
    scale: 3,
    largestGroup: 327,
    rows: 804951,
  },
  oversized: {
    owners: 40,
    groups: 45,
    scale: 1,
    largestGroup: 10000,
    rows: 10792,
  },
};

export function importBuild(buildDir, modulePath) {
  return import(pathToFileURL(path.join(buildDir, 'dist', modulePath)).href);
}

async function billingSchema(db) {
  const [workload] = await db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='workloads'",
  );
  // Before 0172 and 0173, a spec could belong to a Deployment and a VM to a
  // node pool; later layouts read those owners as NULL.
  const has = async (table, column) =>
    (
      await db.query(
        `SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${column}'`,
      )
    ).length > 0;
  return workload
    ? {
        specDeployment: (await has('container_specs', 'deployment_id'))
          ? 'deployment_id'
          : 'NULL AS deployment_id',
        vmNodePool: (await has('vms', 'node_pool_id'))
          ? 'node_pool_id'
          : 'NULL AS node_pool_id',
        ownerTable: 'workloads',
        ownerColumn: 'workload_id',
        ownerType: 'workloadType',
        eventTable: 'workload_events',
        statePath: 'shared/workload.js',
        stateName: 'WorkloadState',
      }
    : {
        specDeployment: 'worker_id AS deployment_id',
        vmNodePool: 'NULL AS node_pool_id',
        ownerTable: 'deployments',
        ownerColumn: 'deployment_id',
        ownerType: 'deploymentType',
        eventTable: 'deployment_events',
        statePath: 'shared/deployment.js',
        stateName: 'DeploymentState',
      };
}

function insertStatement(table, record) {
  const columns = Object.keys(record);
  assert(columns.every((column) => /^[a-z_]+$/.test(column)));
  return {
    sql:
      'INSERT INTO ' +
      table +
      ' (' +
      columns.join(',') +
      ') VALUES (' +
      columns.map(() => '?').join(',') +
      ')',
    values: (value) => columns.map((column) => value[column]),
  };
}

/** Seed with the baseline build's migrations and real parent/spec writer. */
export async function seedBillingFixture({ buildDir, db, store, profile }) {
  const shape = BILLING_PROFILES[profile];
  assert(shape, 'Unknown billing fixture profile: ' + profile);
  const schema = await billingSchema(db);
  const { encryptCredential, hashCredential } = await importBuild(
    buildDir,
    'api/services/cloud-config.js',
  );
  const { CloudType } = await importBuild(buildDir, 'shared/cloud.js');
  // Later builds keep the admission-only credential writer beside the other
  // credential persistence instead of on the store.
  const upsertCredential = store.upsertCredential
    ? store.upsertCredential.bind(store)
    : (
        await importBuild(
          buildDir,
          'api/services/repositories/credential-secrets.js',
        )
      ).upsertCredential.bind(null, db);
  const states = await importBuild(buildDir, schema.statePath);
  const completedState = states[schema.stateName].Completed;
  const accounts = [];
  for (let index = 0; index < 2; index++) {
    const credential = {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'SYNTHETIC_BILLING_' + index,
      secretAccessKey: 'synthetic-no-authority',
    };
    const credentialId = await upsertCredential(
      hashCredential(credential),
      await encryptCredential(credential),
      CloudType.AWS,
    );
    accounts.push({ credentialId, accessKeyId: credential.accessKeyId });
  }
  await store[
    schema.ownerTable === 'workloads' ? 'createWorkload' : 'createDeployment'
  ]({
    id: 'billing-template',
    userId: 'synthetic-billing-benchmark',
    [schema.ownerType]: 'job',
    image: 'fixture:synthetic',
    requestedComputeProvider: CloudType.AWS,
    region: 'us-east-1',
    vmType: 't3.medium',
    spot: false,
    dockerCommand: 'never-executed',
    sshPrivateKey: 'synthetic-unused-key',
    env: { SYNTHETIC: 'billing-benchmark' },
    githubToken: 'synthetic-unused-token',
    credentialId: accounts[0].credentialId,
  });
  const [template] = await db.query(
    'SELECT * FROM ' + schema.ownerTable + ' WHERE id=?',
    ['billing-template'],
  );
  const [spec] = await db.query(
    'SELECT * FROM container_specs WHERE ' + schema.ownerColumn + '=?',
    ['billing-template'],
  );
  await db.query('DELETE FROM ' + schema.ownerTable + ' WHERE id=?', [
    'billing-template',
  ]);
  const workloadInsert = insertStatement(schema.ownerTable, template);
  const specInsert = insertStatement('container_specs', spec);
  const endedAt = BUSINESS_TIME_MS - 3 * BILL_LAG_MS;
  let rows = 0;
  for (let scale = 0; scale < shape.scale; scale++) {
    const ownerId = (owner) =>
      'billing-' + scale + '-owner-' + String(owner).padStart(5, '0');
    await db.transaction((tx) => {
      for (let owner = 0; owner < shape.owners; owner++) {
        const id = ownerId(owner);
        tx.query(
          workloadInsert.sql,
          workloadInsert.values({
            ...template,
            id,
            state: completedState,
            submitted_at: endedAt - 3600_000,
            started_at: endedAt - 3600_000,
            completed_at: endedAt,
            cleaned_at: endedAt,
          }),
        );
        tx.query(
          specInsert.sql,
          specInsert.values({ ...spec, [schema.ownerColumn]: id }),
        );
        tx.query(
          'INSERT INTO ' +
            schema.eventTable +
            ' (' +
            schema.ownerColumn +
            ',state,metadata,created_at) VALUES (?,?,?,?)',
          [id, completedState, null, endedAt],
        );
      }
    });
    for (let offset = 0; offset < shape.groups; offset += 100) {
      await db.transaction((tx) => {
        for (
          let group = offset;
          group < Math.min(shape.groups, offset + 100);
          group++
        ) {
          const owner = group < shape.owners ? group : group - shape.owners;
          const members =
            group === 0 ? shape.largestGroup : group <= 5323 ? 18 : 17;
          for (let member = 0; member < members; member++) {
            tx.query(
              'INSERT INTO vms (' +
                schema.ownerColumn +
                ',cloud_id,created_at,ended_at,region,credential_id,vm_type,cost) VALUES (?,?,?,?,?,?,?,NULL)',
              [
                ownerId(owner),
                'billing-vm-' + scale + '-' + group + '-' + member,
                endedAt - ((member % 7) + 1) * 600_000,
                endedAt,
                'us-east-1',
                accounts[group < shape.owners ? 0 : 1].credentialId,
                't3.medium',
              ],
            );
            rows++;
          }
        }
      });
    }
  }
  assert.equal(rows, shape.rows);
  assert.deepEqual(
    await db.query('SELECT * FROM pragma_foreign_key_check'),
    [],
  );
  assert.deepEqual(await db.query('SELECT * FROM pragma_integrity_check'), [
    { integrity_check: 'ok' },
  ]);
  return {
    scenario: 'billing',
    profile,
    businessTimeMs: BUSINESS_TIME_MS,
    rows,
    owners: shape.owners * shape.scale,
    groups: shape.groups * shape.scale,
    largestGroup: shape.largestGroup,
    accounts,
  };
}

/** Mirrors the billing allocator's owner key: the node pool, cluster or Workload. */
export function resourceIdOf(row) {
  return row.node_pool_id ?? row.cluster_id ?? row.workload_id;
}

export async function readBillingRows(db) {
  const { ownerColumn, vmNodePool } = await billingSchema(db);
  return db.query(
    'SELECT id, cloud_id, ' +
      ownerColumn +
      ' AS workload_id, ' +
      vmNodePool +
      ', cluster_id, credential_id, ' +
      "created_at, ended_at, region, vm_type, ip, cost FROM vms WHERE cloud_id LIKE 'billing-vm-%' ORDER BY id",
  );
}

export function billingGroups(rows, accounts) {
  const accountByCredential = new Map(
    accounts.map((account) => [account.credentialId, account.accessKeyId]),
  );
  const grouped = new Map();
  for (const row of rows) {
    const key = JSON.stringify([
      row.workload_id !== null ? 'anycloud_deployment' : 'anycloud_resource',
      resourceIdOf(row),
      accountByCredential.get(row.credential_id),
    ]);
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        credentialId: row.credential_id,
        resourceId: resourceIdOf(row),
        members: 0,
        totalDurationMs: 0,
        earliestCreated: Infinity,
        latestEnded: -Infinity,
        memberRows: [],
      };
      grouped.set(key, group);
    }
    group.members++;
    group.memberRows.push(row);
    group.totalDurationMs += row.ended_at - row.created_at;
    group.earliestCreated = Math.min(group.earliestCreated, row.created_at);
    group.latestEnded = Math.max(group.latestEnded, row.ended_at);
  }
  return [...grouped.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ memberRows, ...group }, ordinal) => ({
      ...group,
      membersSha256: billingMemberDigest(memberRows),
      ordinal,
      timePeriod: {
        Start: new Date(group.earliestCreated).toISOString().slice(0, 10),
        End: new Date(group.latestEnded + BILL_LAG_MS)
          .toISOString()
          .slice(0, 10),
      },
    }));
}

/**
 * Stable logical input digest, independent of SQLite page layout or indexes.
 * Each table hashes named columns, so a candidate migration that only adds a
 * column leaves the digest unchanged.
 */
export async function fixtureFingerprint(
  db,
  { ignoreBillingCosts = false } = {},
) {
  const schema = await billingSchema(db);
  const hash = createHash('sha256');
  for (const [table, sql] of [
    [
      'workloads',
      'SELECT id,user_id,owner_user_id,state,credential_id,requested_compute_provider,started_at,completed_at FROM ' +
        schema.ownerTable +
        ' ORDER BY id',
    ],
    [
      'container_specs',
      'SELECT ' +
        schema.ownerColumn +
        ' AS workload_id,' +
        schema.specDeployment +
        ',image,image_digest,command,docker_options,env,registry_username,registry_token FROM container_specs ORDER BY workload_id',
    ],
    [
      'credentials',
      'SELECT id,encrypted_data,cloud_provider FROM credentials ORDER BY id',
    ],
    [
      'vms',
      'SELECT id,cloud_id,' +
        schema.ownerColumn +
        ' AS workload_id,' +
        schema.vmNodePool +
        ',cluster_id,credential_id,created_at,ended_at,region,vm_type,ip,cost FROM vms ORDER BY id',
    ],
  ]) {
    hash.update(table + '\n');
    for (let row of await db.query(sql)) {
      if (
        ignoreBillingCosts &&
        table === 'vms' &&
        row.cloud_id.startsWith('billing-vm-')
      ) {
        row = { ...row, cost: null };
      }
      hash.update(
        JSON.stringify(
          Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
        ) + '\n',
      );
    }
  }
  return hash.digest('hex');
}

export function inspectBillingSettlement(rows, groups) {
  const counts = new Map();
  for (const row of rows) {
    if (row.cost === null) continue;
    const key = JSON.stringify([resourceIdOf(row), row.credential_id]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const partialGroups = groups.flatMap((group) => {
    const settled =
      counts.get(JSON.stringify([group.resourceId, group.credentialId])) ?? 0;
    return settled > 0 && settled < group.members
      ? [
          {
            resourceId: group.resourceId,
            credentialId: group.credentialId,
            settled,
            members: group.members,
          },
        ]
      : [];
  });
  return {
    atomic: partialGroups.length === 0,
    settledRows: rows.filter((row) => row.cost !== null).length,
    partialGroups,
  };
}

/** Independent expected bill and original denominator, including unsettled rows. */
export function assertBillingCosts(rows, groups, response) {
  const expected = new Map(
    groups.map((group) => [
      JSON.stringify([group.resourceId, group.credentialId]),
      group,
    ]),
  );
  const totals = new Map();
  let settledRows = 0;
  for (const row of rows) {
    const key = JSON.stringify([resourceIdOf(row), row.credential_id]);
    const group = expected.get(key);
    assert(group, 'Unexpected persisted billing group');
    const settles =
      response === 'settled' ||
      (response === 'mixed' && group.ordinal % 3 === 0);
    if (!settles) {
      assert.equal(row.cost, null, 'Missing bill must retain NULL cost');
      continue;
    }
    assert.equal(typeof row.cost, 'number', 'Eligible VM was not settled');
    const expectedCost =
      (SYNTHETIC_BILL_USD * (row.ended_at - row.created_at)) /
      group.totalDurationMs;
    assert(
      Math.abs(row.cost - expectedCost) < 1e-9,
      'Incorrect allocation for ' + row.cloud_id,
    );
    settledRows++;
    totals.set(key, (totals.get(key) ?? 0) + row.cost);
  }
  for (const [key, cost] of totals) {
    assert(
      Math.abs(cost - SYNTHETIC_BILL_USD) < 1e-7,
      'Group bill allocated more or less than once: ' + key,
    );
  }
  const expectedSettledRows = groups
    .filter(
      (group) =>
        response === 'settled' ||
        (response === 'mixed' && group.ordinal % 3 === 0),
    )
    .reduce((sum, group) => sum + group.members, 0);
  assert.equal(settledRows, expectedSettledRows);
  assert.equal(
    rows.length,
    groups.reduce((sum, group) => sum + group.members, 0),
  );
  return { settledRows, settledGroups: totals.size };
}
