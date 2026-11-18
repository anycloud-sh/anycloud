import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const BUSINESS_NOW = Date.UTC(2026, 8, 10, 12);
export const PROFILES = [
  'sparse',
  'retry',
  'ip-heavy',
  'events',
  'history',
  'mixed',
];
export const PRIMARY = {
  id: '1',
  username: 'anycloud-test',
  token: 'test-token:anycloud-test',
};
export const HOUR = 3600_000;
const DAY = 24 * HOUR;

function insertRecord(database, table, example) {
  assert(/^[a-z_]+$/.test(table));
  const columns = Object.keys(example);
  assert(columns.every((column) => /^[a-z_]+$/.test(column)));
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  return (record) =>
    statement.run(...columns.map((column) => record[column] ?? null));
}

/** Obtain valid current-schema rows through the real parent/spec writer first. */
async function seedTools(db, store, encryptCredential) {
  const credentials = [
    {
      id: 'list-aws',
      name: 'list-aws',
      cloudProvider: 'AWS',
      accessKeyId: 'synthetic-no-authority',
      secretAccessKey: 'synthetic-no-authority',
    },
    {
      id: 'list-azure',
      name: 'list-azure',
      cloudProvider: 'Azure',
      subscriptionId: '00000000-0000-0000-0000-000000000001',
      directoryId: '00000000-0000-0000-0000-000000000002',
      applicationId: '00000000-0000-0000-0000-000000000003',
      secret: 'synthetic-no-authority',
    },
  ];
  for (const { id, name, ...credential } of credentials) {
    await store.upsertCredential(
      id,
      await encryptCredential(credential),
      credential.cloudProvider,
    );
    await db.query('UPDATE credentials SET name = ? WHERE id = ?', [name, id]);
  }
  await store.createWorkload({
    id: 'list-template',
    userId: PRIMARY.username,
    ownerUserId: PRIMARY.id,
    workloadType: 'job',
    image: 'fixture/list:synthetic',
    region: 'us-east-1',
    vmType: 't3.medium',
    dockerCommand: 'never-executed',
    sshPrivateKey: 'list-secret-key-canary',
    env: { CANARY: 'list-env-canary' },
    githubToken: 'list-registry-token-canary',
    command: ['sh', '-c', 'echo synthetic'],
    dockerOptions: { shmSize: '1g' },
    credentialId: 'list-aws',
  });
  const [workload] = await db.query('SELECT * FROM workloads WHERE id = ?', [
    'list-template',
  ]);
  const [spec] = await db.query(
    'SELECT * FROM container_specs WHERE workload_id = ?',
    ['list-template'],
  );
  await db.query('DELETE FROM workloads WHERE id = ?', ['list-template']);
  const native = db.db;
  assert.equal(
    typeof native.prepare,
    'function',
    'Synthetic bulk-seed boundary changed',
  );
  const insertWorkload = insertRecord(native, 'workloads', workload);
  const insertSpec = insertRecord(native, 'container_specs', spec);
  const vm =
    native.prepare(`INSERT INTO vms (workload_id, cloud_id, ip, created_at, ended_at,
    credential_id, region, vm_type, price_per_hour, cost, removal_requested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const event = native.prepare(
    'INSERT INTO workload_events (workload_id,state,metadata,created_at) VALUES (?,?,?,?)',
  );
  return {
    native,
    workload,
    spec,
    workloadRow(id, changes = {}, specChanges = {}) {
      const record = {
        ...workload,
        id,
        state: 'failed',
        started_at: BUSINESS_NOW - DAY,
        submitted_at: BUSINESS_NOW - DAY,
        completed_at: BUSINESS_NOW - HOUR,
        cleaned_at: BUSINESS_NOW - HOUR,
        requested_compute_provider: null,
        ...changes,
      };
      insertWorkload(record);
      if (!record.deployment_id)
        insertSpec({ ...spec, workload_id: id, ...specChanges });
      return record;
    },
    vm(id, index, changes = {}) {
      const row = {
        ip: '192.0.2.1',
        created_at: BUSINESS_NOW - 2 * HOUR,
        ended_at: BUSINESS_NOW - HOUR,
        credential_id: 'list-aws',
        price_per_hour: 1,
        cost: null,
        removal_requested_at: null,
        ...changes,
      };
      vm.run(
        id,
        `${id}-attempt-${index}`,
        row.ip,
        row.created_at,
        row.ended_at,
        row.credential_id,
        'us-east-1',
        't3.medium',
        row.price_per_hour,
        row.cost,
        row.removal_requested_at,
      );
    },
    event(id, state, metadata, createdAt) {
      event.run(
        id,
        state,
        metadata === null ? null : JSON.stringify(metadata),
        createdAt,
      );
    },
  };
}

async function finishFixture(db, manifest) {
  await db.query('PRAGMA optimize = 0x10002');
  assert.deepEqual(
    await db.query('SELECT * FROM pragma_foreign_key_check'),
    [],
  );
  assert.deepEqual(await db.query('SELECT * FROM pragma_integrity_check'), [
    { integrity_check: 'ok' },
  ]);
  const native = db.db;
  const hash = createHash('sha256');
  const counts = {};
  for (const table of [
    'workloads',
    'container_specs',
    'vms',
    'workload_events',
    'credentials',
    'deployments',
    'node_pools',
  ]) {
    counts[table] = native
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get().count;
    hash.update(table + '\0');
    for (const row of native
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .iterate())
      hash.update(JSON.stringify(row) + '\n');
  }
  const vmShape = native
    .prepare(
      `SELECT SUM(ip IS NULL) AS nullIp, SUM(ip IS NOT NULL) AS withIp,
    SUM(ip = '') AS emptyIp, SUM(ended_at IS NULL) AS live FROM vms`,
    )
    .get();
  return {
    ...manifest,
    now: BUSINESS_NOW,
    counts,
    vmShape,
    logicalSha256: hash.digest('hex'),
  };
}

export async function seedFixture({
  db,
  store,
  deploymentStore,
  encryptCredential,
  profile,
  small = false,
}) {
  const started = performance.now();
  const tools = await seedTools(db, store, encryptCredential);
  if (profile === 'correctness') {
    const result = await seedCorrectness(db, store, deploymentStore, tools);
    return finishFixture(db, {
      profile,
      ...result,
      seedMs: performance.now() - started,
    });
  }
  assert(PROFILES.includes(profile));
  const count = small
    ? 100
    : ['mixed', 'history'].includes(profile)
      ? 18664
      : 2400;
  const hot = small ? 80 : 2200;
  const exactVms = small ? 1200 : 285564;
  const exactEvents = small ? 4000 : 1994751;
  let vms = 0;
  let events = 0;
  tools.native.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `list-d-${String(i).padStart(6, '0')}`;
      const isHot = i < hot;
      const active = isHot && i % 10 === 0;
      const pending = isHot && !active && i % 3 === 0;
      const startedAt = BUSINESS_NOW - DAY - (Math.floor(i / 2) + 1) * 60_000;
      const finishedAt = BUSINESS_NOW - ((i % 30) + 1) * 60_000;
      const otherOwner = i % 7 === 6;
      const legacy = i % 3 === 1;
      tools.workloadRow(id, {
        owner_user_id: legacy
          ? null
          : otherOwner
            ? 'fixture-other-owner'
            : PRIMARY.id,
        user_id: otherOwner
          ? 'fixture-other'
          : legacy
            ? 'AnyCloud-Test'
            : i % 5 === 0
              ? 'old-account-name'
              : PRIMARY.username,
        state: active ? 'running' : 'completed',
        workload_type: i % 11 === 0 ? 'service' : i % 17 === 0 ? 'vm' : 'job',
        started_at: startedAt,
        submitted_at: startedAt,
        completed_at: active ? null : finishedAt,
        cleaned_at: active || pending ? null : finishedAt + 1000,
        session: i % 2 === 0 ? 'claude:list-session-a' : 'codex:list-session-b',
        agent: i % 2 === 0 ? 'claude' : 'codex',
        session_label: i % 2 === 0 ? 'List session A' : 'List session B',
        spot: i % 3 === 0 ? 1 : 0,
      });
      let vmCount = i % 3;
      if ((profile === 'retry' || profile === 'ip-heavy') && isHot)
        vmCount = small ? 12 : 128;
      if (profile === 'mixed') {
        // About 60% of attempts are in the selectable hot page; the rest are older history.
        const hotBudget = Math.floor(exactVms * 0.6);
        const budget = isHot ? hotBudget : exactVms - hotBudget;
        const owners = isHot ? hot : count - hot;
        const rank = isHot ? i : i - hot;
        vmCount =
          Math.floor(budget / owners) + (rank < budget % owners ? 1 : 0);
      }
      for (let j = 0; j < vmCount; j++) {
        const nullIp =
          profile === 'ip-heavy'
            ? j % 100 === 99
            : profile === 'retry'
              ? j !== vmCount - 1
              : profile === 'mixed'
                ? j % 5 !== 0
                : false;
        const live = (active || pending) && j === vmCount - 1;
        const slot = (finishedAt - startedAt - 60_000) / vmCount;
        const createdAt = Math.floor(startedAt + 60_000 + j * slot);
        const duration = Math.min(
          ((j % 4) + 1) * 300_000,
          Math.floor(slot * 0.9),
        );
        const end = live ? null : createdAt + duration;
        tools.vm(id, j, {
          ip: nullIp ? null : `192.0.2.${(j % 250) + 1}`,
          created_at: createdAt,
          ended_at: end,
          credential_id: j % 13 === 0 ? 'list-azure' : 'list-aws',
          price_per_hour: j % 11 === 0 ? null : (j % 7) / 2,
          cost: live || j % 3 !== 0 ? null : j % 19 === 0 ? -0.25 : (j % 9) / 4,
          removal_requested_at: pending && live ? BUSINESS_NOW - 60_000 : null,
        });
        vms++;
      }
      let eventCount = profile === 'events' && isHot ? (small ? 20 : 512) : 4;
      if (profile === 'mixed') {
        const hotBudget = Math.floor(exactEvents * 0.6);
        const budget = isHot ? hotBudget : exactEvents - hotBudget;
        const owners = isHot ? hot : count - hot;
        const rank = isHot ? i : i - hot;
        eventCount =
          Math.floor(budget / owners) + (rank < budget % owners ? 1 : 0);
      }
      for (let j = 0; j < eventCount; j++) {
        tools.event(
          id,
          active ? 'queued' : 'completed',
          {
            message: `synthetic attempt ${j}: ${j % 2 ? 'capacity unavailable' : 'completed fixture work'}`,
            attempt: j,
            details: 'local list responsiveness fixture',
          },
          startedAt +
            Math.floor(
              (Math.floor(j / 2) * (finishedAt - startedAt)) /
                Math.max(1, Math.ceil(eventCount / 2)),
            ),
        );
        events++;
      }
    }
  })();
  if (profile === 'mixed') {
    assert.equal(vms, exactVms);
    assert.equal(events, exactEvents);
  }
  const result = await finishFixture(db, {
    profile,
    small,
    hotRows: hot,
    statusId: 'list-d-000011',
    session: 'claude:list-session-a',
    seedMs: performance.now() - started,
  });
  assert.equal(result.counts.workloads, count);
  return result;
}

async function seedCorrectness(db, store, deploymentStore, tools) {
  const ids = [];
  const row = (suffix, changes = {}, spec = {}) => {
    const id = 'list-' + suffix;
    ids.push(id);
    return tools.workloadRow(id, { session: 'edges', ...changes }, spec);
  };
  tools.native.transaction(() => {
    row('no-vms');
    row('null-only', {
      state: 'running',
      completed_at: null,
      cleaned_at: null,
    });
    tools.vm('list-null-only', 0, {
      ip: null,
      ended_at: null,
      price_per_hour: 100,
      cost: 99,
      credential_id: 'list-azure',
    });
    row('empty-ip', { state: 'running', completed_at: null, cleaned_at: null });
    tools.vm('list-empty-ip', 0, {
      ip: '',
      created_at: BUSINESS_NOW - HOUR,
      ended_at: null,
      price_per_hour: 2,
    });
    row('mixed', { state: 'running', completed_at: null, cleaned_at: null });
    tools.vm('list-mixed', 0, {
      created_at: BUSINESS_NOW - 2 * HOUR,
      ended_at: null,
      removal_requested_at: BUSINESS_NOW - HOUR,
    });
    tools.vm('list-mixed', 1, { cost: 0 });
    tools.vm('list-mixed', 2, { cost: -1 });
    tools.vm('list-mixed', 3, { price_per_hour: null });
    tools.vm('list-mixed', 4, { cost: 5 });
    tools.vm('list-mixed', 5, {
      ip: null,
      ended_at: null,
      price_per_hour: 100,
      cost: 100,
    });
    row('unpriced');
    tools.vm('list-unpriced', 0, { price_per_hour: null });
    row('actual');
    tools.vm('list-actual', 0, { cost: 3 });
    row('refund');
    tools.vm('list-refund', 0, { cost: -2 });
    row('null-blocker');
    tools.vm('list-null-blocker', 0, { ip: null, ended_at: null });
    row('credential-null');
    tools.vm('list-credential-null', 0, {
      ip: null,
      credential_id: 'list-azure',
    });
    row('pending', { cleaned_at: null });
    tools.vm('list-pending', 0, {
      ended_at: null,
      removal_requested_at: BUSINESS_NOW - 30_000,
    });
    row('service', { workload_type: 'service' });
    row('vm', { workload_type: 'vm' });
    row('legacy', { owner_user_id: null, user_id: 'AnyCloud-Test' });
    row('renamed', { owner_user_id: PRIMARY.id, user_id: 'old-account-name' });
    row('other-id-same-name', { owner_user_id: 'fixture-other-owner' });
    row('other-user', {
      owner_user_id: 'fixture-other-owner',
      user_id: 'fixture-other',
    });
    row(
      'search',
      {
        session: 'claude:shared-111111',
        agent: 'claude',
        session_label: 'Literal label',
      },
      { image: 'fixture:%_canary' },
    );
    row('session-prefix', {
      session: 'claude:shared-111111-more',
      agent: 'codex',
    });
    row('event-tie-a', { started_at: BUSINESS_NOW - HOUR });
    row('event-tie-z', { started_at: BUSINESS_NOW - HOUR });
    tools.event(
      'list-event-tie-z',
      'queued',
      { message: 'old message' },
      BUSINESS_NOW - 1000,
    );
    tools.event(
      'list-event-tie-z',
      'queued',
      { message: 'winning message' },
      BUSINESS_NOW - 1000,
    );
    for (let i = 0; i < 225; i++)
      row(`headroom-${String(i).padStart(4, '0')}`, {
        session: 'headroom',
        state: 'running',
        completed_at: null,
        cleaned_at: null,
        started_at: BUSINESS_NOW - 2 * HOUR - i,
      });
    for (let i = 0; i < 1005; i++)
      row(`limit-${String(i).padStart(4, '0')}`, {
        session: 'limits',
        started_at: BUSINESS_NOW - 3 * HOUR - i,
      });
  })();
  await db.query(
    `INSERT INTO clusters (id,owner_user_id,name,state,step,kubernetes_identity,encrypted_connection,created_at,updated_at)
    VALUES ('list-root','1','list-root','ready','release','list-root-uid','synthetic',?,?)`,
    [BUSINESS_NOW, BUSINESS_NOW],
  );
  await db.query(
    `INSERT INTO node_pools (id,cluster_id,owner_user_id,name,state,compute_credential_id,region,vm_type,min_vm_count,max_vm_count,created_at,updated_at)
    VALUES ('list-pool','list-root','1','list-pool','ready','list-aws','us-east-1','["t3.medium"]',1,1,?,?)`,
    [BUSINESS_NOW, BUSINESS_NOW],
  );
  await deploymentStore.create(
    {
      id: 'list-worker',
      ownerUserId: '1',
      name: 'list-worker',
      nodePoolId: 'list-pool',
      config: {
        image: 'fixture/worker:synthetic',
        imageDigest: null,
        command: null,
        dockerOptions: null,
        env: null,
        registryUsername: PRIMARY.username,
        registryToken: null,
      },
      gpuCount: 0,
      maxConcurrentJobsPerReplica: 1,
    },
    { kind: 'api' },
  );
  await store.createTargetedWorkload({
    id: 'list-worker-job',
    userId: PRIMARY.username,
    ownerUserId: PRIMARY.id,
    deploymentId: 'list-worker',
    session: 'edges',
  });
  ids.push('list-worker-job');
  return { ids, statusId: 'list-actual', session: 'edges' };
}

export function fixtureDigest(db) {
  const hash = createHash('sha256');
  for (const table of [
    'workloads',
    'container_specs',
    'vms',
    'workload_events',
    'credentials',
    'deployments',
    'node_pools',
  ]) {
    hash.update(table + '\0');
    for (const row of db.db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .iterate())
      hash.update(JSON.stringify(row) + '\n');
  }
  return hash.digest('hex');
}
