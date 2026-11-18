import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../../src/api/services/repositories/db.js';
import { runChild } from '../../helpers/api-responsiveness/run-child.mjs';
import {
  measureIndexCreation,
  storageSnapshot,
} from '../../helpers/api-responsiveness/database-costs.mjs';
import {
  summarizeHealth,
  median,
  instrumentDatabase,
} from '../../helpers/api-responsiveness/metrics.mjs';
import {
  combineCaseReports,
  markdownMatrixReport,
  pairedOrder,
  revisionMetadata,
  summarizeRuns,
} from '../../helpers/api-responsiveness/report.mjs';
import {
  assertBillingCosts,
  billingGroups,
  fixtureFingerprint,
  inspectBillingSettlement,
} from '../../helpers/api-responsiveness/billing-fixture.mjs';
import {
  configureBillingProvider,
  recordBillingGroups,
  billingProviderSnapshot,
} from '../../helpers/api-responsiveness/billing-provider.mjs';

const sample = (overrides = {}) => ({
  phase: 'work',
  elapsedMs: 20,
  offerDelayMs: 0,
  ok: true,
  status: 200,
  ...overrides,
});

describe('API responsiveness measurement validity', () => {
  it('counts commit and rollback overhead once, including nested synchronous transactions', async () => {
    const db = createDatabase();
    let timing;
    try {
      await db.init();
      await db.query('CREATE TABLE transaction_probe (id INTEGER)');
      let clock = 0;
      const execute = db.execute;
      db.execute = function (...args) {
        clock += 3;
        return execute.apply(this, args);
      };
      const transaction = db.db.transaction;
      db.db.transaction = function (callback) {
        return transaction.call(this, function (...args) {
          clock += 2;
          try {
            return callback.apply(this, args);
          } finally {
            clock += 5;
          }
        });
      };
      const before = { execute: db.execute, transaction: db.db.transaction };
      timing = instrumentDatabase(db, { now: () => clock });
      await db.transaction((tx) => {
        tx.query('INSERT INTO transaction_probe VALUES (1)');
        db.db
          .transaction(function (id) {
            expect(this).toEqual({ receiver: 'preserved' });
            tx.query('INSERT INTO transaction_probe VALUES (?)', [id]);
          })
          .immediate.call({ receiver: 'preserved' }, 2);
      });
      // Two 3ms statements, plus 2ms begin + 5ms commit per transaction.
      expect(timing.metrics).toMatchObject({
        statements: 2,
        transactions: 2,
        totalMs: 20,
        transactionOverheadMs: 14,
        maxTransactionMs: 20,
      });
      // Time outside a synchronous transaction must never enter SQL totals.
      await Promise.resolve();
      clock += 1000;
      await expect(
        db.transaction((tx) => {
          tx.query('INSERT INTO transaction_probe VALUES (3)');
          throw new Error('Synthetic rollback');
        }),
      ).rejects.toThrow('Synthetic rollback');
      expect(timing.metrics).toMatchObject({
        statements: 3,
        transactions: 3,
        totalMs: 30,
        transactionOverheadMs: 21,
        maxTransactionMs: 20,
      });
      timing.restore();
      expect(db.execute).toBe(before.execute);
      expect(db.db.transaction).toBe(before.transaction);
      expect(
        await db.query('SELECT id FROM transaction_probe ORDER BY id'),
      ).toEqual([{ id: 1 }, { id: 2 }]);
      expect(timing.metrics.statements).toBe(3);
    } finally {
      timing?.restore();
      db.close();
    }
  });

  it.each(['added', 'edited', 'deleted'])(
    'tracks %s migrations without rebuilding',
    (change) => {
      const checkout = mkdtempSync(path.join(tmpdir(), 'api-revision-'));
      const migration = path.join(checkout, 'migrations/0001_fixture.sql');
      const addedMigration = path.join(checkout, 'migrations/0002_index.sql');
      const git = (...args) =>
        execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
      try {
        mkdirSync(path.join(checkout, 'dist/api'), { recursive: true });
        mkdirSync(path.join(checkout, 'migrations'));
        writeFileSync(
          path.join(checkout, 'dist/api/server.js'),
          'export {};\n',
        );
        writeFileSync(
          path.join(checkout, 'package.json'),
          '{"version":"1.0.0"}\n',
        );
        writeFileSync(path.join(checkout, 'yarn.lock'), '# fixture\n');
        writeFileSync(migration, 'CREATE TABLE fixture (id INTEGER);\n');
        git('init');
        git('add', '.');
        git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=' + path.join(checkout, 'empty-hooks'),
          'commit',
          '-m',
          'Fixture',
        );
        const baseline = revisionMetadata(checkout);
        expect(baseline.sourceDirty).toBe(false);
        expect(baseline.migrationsSha256).toMatch(/^[a-f0-9]{64}$/);

        // Keep the checkout dirty before changing migrations, so a dirty flag
        // alone cannot detect that the measured inputs changed again.
        mkdirSync(path.join(checkout, 'src'));
        writeFileSync(path.join(checkout, 'src/fixture.js'), 'export {};\n');
        const before = revisionMetadata(checkout);
        expect(before.sourceDirty).toBe(true);
        expect(before.migrationsSha256).toBe(baseline.migrationsSha256);

        if (change === 'added') {
          writeFileSync(
            addedMigration,
            'CREATE INDEX fixture_id ON fixture(id);\n',
          );
        } else if (change === 'edited') {
          writeFileSync(
            migration,
            'CREATE TABLE fixture (id INTEGER PRIMARY KEY);\n',
          );
        } else {
          rmSync(migration);
        }
        rmSync(path.join(checkout, 'src'), { recursive: true });
        const after = revisionMetadata(checkout);
        expect(after.sourceDirty).toBe(true);
        expect(after.sourceSha).toBe(before.sourceSha);
        expect(after.buildSha256).toBe(before.buildSha256);
        expect(after.migrationsSha256).not.toBe(before.migrationsSha256);
        expect(revisionMetadata(checkout)).toEqual(after);
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    },
  );

  it('counts late HTTP 200s and aborted requests as deadline misses', () => {
    const result = summarizeHealth([
      sample(),
      sample({ elapsedMs: 1001 }),
      sample({
        ok: false,
        status: undefined,
        error: 'timeout',
        elapsedMs: 1000,
      }),
    ]);
    expect(result.offered).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.deadlineMisses).toBe(2);
    expect(result.responsive).toBe(false);
    expect(result.p99Ms).toBe(1001);
  });

  it('cannot turn missing work-phase samples into a passing health claim', () => {
    const result = summarizeHealth([sample({ phase: 'warmup' })]);
    expect(result.offered).toBe(0);
    expect(result.responsive).toBeNull();
    expect(result.p95Ms).toBeNull();
    expect(result.p99Ms).toBeNull();
    expect(() =>
      summarizeHealth([
        sample(),
        sample({ ok: undefined, elapsedMs: undefined }),
      ]),
    ).toThrow('Incomplete health sample');
  });

  it('rejects a missing source database before starting a child', async () => {
    const output = mkdtempSync(path.join(tmpdir(), 'api-missing-seed-'));
    const runDir = path.join(output, 'trial');
    const copyFrom = path.join(output, 'missing.db');
    try {
      await expect(
        runChild({
          runDir,
          copyFrom,
          buildDir: fileURLToPath(new URL('../../../', import.meta.url)),
          action: 'measure',
          childEntry: new URL(
            '../../fixtures/api-responsiveness-health-child.mjs',
            import.meta.url,
          ),
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ code: 'ENOENT', path: copyFrom });
      expect(existsSync(path.join(runDir, 'child.log'))).toBe(false);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('drains health requests before closing the measured process', async () => {
    const output = mkdtempSync(path.join(tmpdir(), 'api-health-drain-'));
    const runDir = path.join(output, 'trial');
    try {
      const result = await runChild({
        runDir,
        buildDir: fileURLToPath(new URL('../../../', import.meta.url)),
        action: 'measure',
        childEntry: new URL(
          '../../fixtures/api-responsiveness-health-child.mjs',
          import.meta.url,
        ),
        healthTimeoutMs: 6000,
        timeoutMs: 10_000,
      });
      expect(result.health.offered).toBeGreaterThanOrEqual(2);
      expect(result.health.otherFailures).toBe(0);
      expect(result.healthCoarse.responsive).toBe(true);
      expect(readFileSync(path.join(runDir, 'child.log'), 'utf8')).toContain(
        'Health drained before shutdown',
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps transport failures distinct from timing and supports the coarse gate', () => {
    expect(summarizeHealth([sample({ ok: false, status: 500 })])).toMatchObject(
      {
        otherFailures: 1,
        deadlineMisses: 0,
        responsive: false,
      },
    );
    const samples = [sample({ elapsedMs: 2000 })];
    expect(summarizeHealth(samples).responsive).toBe(false);
    expect(summarizeHealth(samples, 6000).responsive).toBe(true);
  });

  it('reports a slow HTTP tail even when most requests stay fast', () => {
    const samples = [
      ...Array.from({ length: 98 }, () => sample()),
      sample({ elapsedMs: 1200 }),
      sample({ elapsedMs: 2000 }),
    ];
    expect(summarizeHealth(samples)).toMatchObject({
      p95Ms: 20,
      p99Ms: 1200,
      maxMs: 2000,
    });
  });

  it('balances which revision runs first across the six paired trials', () => {
    const orders = Array.from({ length: 6 }, (_, index) => pairedOrder(index));
    expect(orders.filter(([first]) => first === 'baseline')).toHaveLength(3);
    expect(orders.filter(([first]) => first === 'candidate')).toHaveLength(3);
    expect(orders.every((order) => new Set(order).size === 2)).toBe(true);
    expect(median([100, 1, 20, 10])).toBe(15);
  });

  it('measures added index creation while restoring the migrated database', async () => {
    const db = createDatabase();
    try {
      await db.init();
      await db.query('CREATE TABLE index_probe_fixture (cost REAL)');
      await db.query(
        'INSERT INTO index_probe_fixture (cost) VALUES (1),(2),(NULL)',
      );
      const baseline = await storageSnapshot(db);
      await db.query(
        'CREATE INDEX index_probe_cost ON index_probe_fixture (cost)',
      );
      const migrated = await storageSnapshot(db);
      const result = await measureIndexCreation(db, baseline.indexes);
      expect(result.indexes).toHaveLength(1);
      expect(result.indexes[0].name).toBe('index_probe_cost');
      expect(result.totalCreateMs).toBeGreaterThanOrEqual(0);
      expect(result.committed).toBe(false);
      expect((await storageSnapshot(db)).indexes).toEqual(migrated.indexes);
      expect(
        await db.query('SELECT cost FROM index_probe_fixture ORDER BY rowid'),
      ).toEqual([{ cost: 1 }, { cost: 2 }, { cost: null }]);
      expect(
        (await measureIndexCreation(db, migrated.indexes)).indexes,
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('retains failed and unsampled trials in aggregate reports', () => {
    const run = {
      profile: 'smoke',
      case: 'empty-immediate',
      arm: 'candidate',
      elapsedMs: 50,
      cpuMs: 40,
      eventLoopMaxMs: 0,
      initialTimerDelayMs: 45,
      sql: { maxMs: 30, maxReturnedRows: 100 },
    };
    const [result] = summarizeRuns([
      { ...run, health: summarizeHealth([]) },
      { ...run, health: summarizeHealth([sample({ elapsedMs: 1200 })]) },
    ]);
    expect(result.candidate).toMatchObject({
      trials: 2,
      healthOffers: 1,
      healthMisses: 1,
      unsampledTrials: 1,
      maxEventLoopMs: 45,
    });
    expect(result.baseline.trials).toBe(0);
  });
});

describe('CI comparison completeness', () => {
  function caseReports() {
    return [
      'empty-immediate',
      'empty-yield',
      'mixed-immediate',
      'mixed-yield',
    ].map((caseName, index) => ({
      name: 'smoke-' + caseName,
      report: {
        formatVersion: 1,
        scenario: 'billing',
        status: 'complete',
        repetitions: 6,
        profiles: ['smoke'],
        harnessSha256: 'one-harness',
        revisions: {
          baseline: {
            sourceSha: 'base',
            buildSha256: 'base-build',
            sourceDirty: false,
          },
          candidate: {
            sourceSha: 'merge',
            buildSha256: 'merge-build',
            sourceDirty: false,
          },
        },
        runtime: {
          node: 'v22.14.0',
          platform: 'linux',
          arch: 'x64',
          cpuModel: 'Fixture CPU ' + index,
        },
        fixtures: { smoke: { logicalSha256: 'independent-seed-' + index } },
        preparation: {
          smoke: Object.fromEntries(
            ['baseline', 'candidate'].map((arm) => [
              arm,
              {
                initMs: 10,
                indexCreation: { totalCreateMs: 0 },
                storage: { bytes: 1024 },
                writeProbe: { insertMs: 2, updateMs: 1 },
              },
            ]),
          ),
        },
        runs: Array.from({ length: 6 }, (_, repetition) =>
          pairedOrder(repetition).map((arm) => ({
            profile: 'smoke',
            case: caseName,
            repetition: repetition + 1,
            arm,
            elapsedMs: 2000,
            cpuMs: 1000,
            eventLoopMaxMs: 1500,
            initialTimerDelayMs: 1000,
            sql: { maxMs: 1500, maxReturnedRows: 1119 },
            health: summarizeHealth(
              repetition % 2 ? [] : [sample({ elapsedMs: 1200 })],
            ),
          })),
        ).flat(),
      },
    }));
  }

  const options = { profiles: ['smoke'], repetitions: 6 };

  it('reports all cases without turning health misses or unsampled trials into CI failures', () => {
    const matrix = combineCaseReports(caseReports(), options);
    expect(matrix.status).toBe('complete');
    expect(matrix.failures).toEqual([]);
    const markdown = markdownMatrixReport(matrix);
    expect(markdown).toContain('Fixture CPU 0');
    expect(markdown).toContain('Fixture CPU 3');
    expect(markdown).toContain('3/3; 0 errors; 3 unsampled');
  });

  it.each([
    { responses: ['empty'], boundaries: ['yield'] },
    { responses: ['mixed'], boundaries: ['immediate', 'yield'] },
  ])('validates only explicitly requested cases: %j', (selection) => {
    const entries = caseReports().filter((entry) =>
      selection.responses.some((response) =>
        selection.boundaries.some(
          (boundary) => entry.name === `smoke-${response}-${boundary}`,
        ),
      ),
    );
    const matrix = combineCaseReports(entries, { ...options, ...selection });
    expect(matrix.status).toBe('complete');
    expect(matrix.cases.map((item) => item.name)).toEqual(
      entries.map((entry) => entry.name),
    );
    expect(matrix).toMatchObject(selection);
    // A partial report must never satisfy the default full qualification.
    expect(combineCaseReports(entries, options).status).toBe('failed');
    expect(
      combineCaseReports(caseReports(), { ...options, ...selection }).status,
    ).toBe('failed');
    expect(
      combineCaseReports(entries.slice(1), { ...options, ...selection }).status,
    ).toBe('failed');
  });

  it.each([
    ['profiles', 'smoke'],
    ['responses', 'empty'],
    ['boundaries', 'yield'],
  ])(
    'rejects an empty or invalid %s selection instead of claiming completeness',
    (axis, valid) => {
      for (const values of [[], ['unknown'], [valid, valid]]) {
        expect(() =>
          combineCaseReports([], { ...options, [axis]: values }),
        ).toThrow('Invalid comparison ' + axis);
      }
    },
  );

  it.each([
    ['missing case', (entries) => entries.pop()],
    ['duplicate case', (entries) => entries.push(entries[0])],
    [
      'unreadable artifact',
      (entries) => {
        entries[0] = { name: entries[0].name, failure: 'Invalid JSON' };
      },
    ],
    [
      'failed case',
      (entries) => {
        entries[0].report.status = 'failed';
      },
    ],
    [
      'interrupted case',
      (entries) => {
        entries[0].report.status = 'running';
      },
    ],
    ['missing trial', (entries) => entries[0].report.runs.pop()],
    [
      'wrong alternating order',
      (entries) => {
        entries[0].report.runs[2].arm = 'baseline';
      },
    ],
    [
      'wrong repetition',
      (entries) => {
        entries[0].report.runs[2].repetition = 1;
      },
    ],
    [
      'wrong build',
      (entries) => {
        entries[0].report.revisions.candidate.buildSha256 = 'another-build';
      },
    ],
    [
      'wrong source',
      (entries) => {
        entries[0].report.revisions.baseline.sourceSha = 'another-base';
      },
    ],
    [
      'wrong harness',
      (entries) => {
        entries[0].report.harnessSha256 = 'another-harness';
      },
    ],
    [
      'dirty source',
      (entries) => {
        entries[0].report.revisions.candidate.sourceDirty = true;
      },
    ],
    [
      'wrong Node major',
      (entries) => {
        entries[0].report.runtime.node = 'v24.0.0';
      },
    ],
  ])('fails visibly for %s', (_, corrupt) => {
    const entries = caseReports();
    corrupt(entries);
    const matrix = combineCaseReports(entries, options);
    expect(matrix.status).toBe('failed');
    expect(matrix.failures.length).toBeGreaterThan(0);
    expect(markdownMatrixReport(matrix)).toContain('Status: failed');
  });
});

describe('independent billing oracle', () => {
  const accounts = [{ credentialId: 'account-a', accessKeyId: 'synthetic-a' }];
  const rows = [
    {
      cloud_id: 'short',
      workload_id: 'owner',
      node_pool_id: null,
      cluster_id: null,
      credential_id: 'account-a',
      created_at: 0,
      ended_at: 1,
      cost: 137 / 3,
    },
    {
      cloud_id: 'long',
      workload_id: 'owner',
      node_pool_id: null,
      cluster_id: null,
      credential_id: 'account-a',
      created_at: 0,
      ended_at: 2,
      cost: (137 * 2) / 3,
    },
  ];
  const groups = billingGroups(rows, accounts);

  it('verifies unequal-runtime shares and the fixed group total', () => {
    expect(assertBillingCosts(rows, groups, 'settled')).toEqual({
      settledRows: 2,
      settledGroups: 1,
    });
  });

  it('detects repeated allocation from splitting one tagged bill', () => {
    expect(() =>
      assertBillingCosts(
        rows.map((row) => ({ ...row, cost: 137 })),
        groups,
        'settled',
      ),
    ).toThrow('Incorrect allocation');
  });

  it('detects missing members, partial settlement and unexpected writes', () => {
    expect(() =>
      assertBillingCosts(rows.slice(1), groups, 'settled'),
    ).toThrow();
    expect(() =>
      assertBillingCosts(
        [{ ...rows[0], cost: null }, rows[1]],
        groups,
        'settled',
      ),
    ).toThrow('Eligible VM was not settled');
    expect(() => assertBillingCosts(rows, groups, 'empty')).toThrow(
      'Missing bill',
    );
  });

  it('detects missing group inputs even when the provider returns an empty bill', () => {
    configureBillingProvider(groups, {
      response: 'empty',
      boundary: 'immediate',
    });
    const input = rows.map((row) => ({
      ...row,
      resource_id: 'owner',
      resource_tag: 'anycloud_deployment',
    }));
    expect(() =>
      recordBillingGroups({ credentials: { accessKeyId: 'synthetic-a' } }, [
        input.slice(1),
      ]),
    ).toThrow('Incomplete billing group');
    expect(billingProviderSnapshot().failures).toHaveLength(1);
  });

  it('distinguishes complete rollback or commit from a durable partial group', () => {
    expect(inspectBillingSettlement(rows, groups).atomic).toBe(true);
    expect(
      inspectBillingSettlement(
        rows.map((row) => ({ ...row, cost: null })),
        groups,
      ).atomic,
    ).toBe(true);
    expect(
      inspectBillingSettlement([{ ...rows[0], cost: null }, rows[1]], groups),
    ).toMatchObject({
      atomic: false,
      settledRows: 1,
      partialGroups: [{ settled: 1, members: 2 }],
    });
  });
});

describe('API responsiveness fixture fingerprint', () => {
  it('ignores an added nullable container spec column but not a spec change', async () => {
    const db = createDatabase();
    try {
      await db.init();
      await db.query(
        "INSERT INTO credentials (id,encrypted_data,cloud_provider) VALUES ('account-a','sealed','aws')",
      );
      await db.query(
        "INSERT INTO workloads (id,user_id,workload_type,state,started_at,docker_command,credential_id) VALUES ('owner','user','service','completed',1,'true','account-a')",
      );
      await db.query(
        "INSERT INTO container_specs (workload_id,image,env,registry_username) VALUES ('owner','fixture:synthetic','{}','anycloud')",
      );
      await db.query(
        "INSERT INTO vms (workload_id,cloud_id,created_at,ended_at,credential_id) VALUES ('owner','billing-vm-0',0,1,'account-a')",
      );
      const seeded = await fixtureFingerprint(db);

      await db.query('ALTER TABLE container_specs ADD COLUMN probe TEXT');
      expect(await fixtureFingerprint(db)).toBe(seeded);

      await db.query("UPDATE container_specs SET image='fixture:changed'");
      expect(await fixtureFingerprint(db)).not.toBe(seeded);
    } finally {
      db.close();
    }
  });

  it('hashes legacy-layout container specs like the current layout, in owner order', async () => {
    const fingerprintOf = async (owner, specOwners, vmOwner) => {
      const raw = new BetterSqlite3(':memory:');
      try {
        raw.exec(`
          CREATE TABLE ${owner.table} (id TEXT, user_id TEXT, owner_user_id TEXT,
            state TEXT, credential_id TEXT, requested_compute_provider TEXT,
            started_at INTEGER, completed_at INTEGER);
          CREATE TABLE container_specs (${specOwners}, image TEXT,
            image_digest TEXT, command TEXT, docker_options TEXT, env TEXT,
            registry_username TEXT, registry_token TEXT);
          CREATE TABLE credentials (id TEXT, encrypted_data TEXT, cloud_provider TEXT);
          CREATE TABLE vms (id INTEGER PRIMARY KEY, cloud_id TEXT, ${vmOwner},
            cluster_id TEXT, credential_id TEXT, created_at INTEGER,
            ended_at INTEGER, region TEXT, vm_type TEXT, ip TEXT, cost REAL);
        `);
        // Inserted out of owner order, so only an owner sort aligns the rows.
        for (const id of ['owner-b', 'owner-a']) {
          raw
            .prepare(
              `INSERT INTO container_specs (${owner.column}, image, registry_username) VALUES (?, ?, 'anycloud')`,
            )
            .run(id, 'image-' + id);
        }
        return await fixtureFingerprint({
          query: async (sql) => raw.prepare(sql).all(),
        });
      } finally {
        raw.close();
      }
    };

    const current = await fingerprintOf(
      { table: 'workloads', column: 'workload_id' },
      'workload_id TEXT',
      'workload_id TEXT',
    );
    expect(
      await fingerprintOf(
        { table: 'deployments', column: 'deployment_id' },
        'deployment_id TEXT, worker_id TEXT',
        'deployment_id TEXT',
      ),
    ).toBe(current);
    expect(
      await fingerprintOf(
        { table: 'workloads', column: 'workload_id' },
        'workload_id TEXT, deployment_id TEXT',
        'workload_id TEXT, node_pool_id TEXT',
      ),
    ).toBe(current);
  });
});
