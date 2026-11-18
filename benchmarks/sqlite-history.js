#!/usr/bin/env node

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const defaults = {
  iterations: 11,
  rows: 300_000,
  sparseVms: 200,
};
const COST_LIMIT = 1_001;
const EXACT_SESSION_MATCHES = 50;
const WINDOW_END = 2_000_000_000_000;
const WINDOW_START = WINDOW_END - 3_600_000;
const PERIOD_MS = WINDOW_END - WINDOW_START;
const USER_ID = 'bench-user';
const TARGET_AGENT = 'codex';
const TARGET_SESSION = 'target-session';

function parseArgs(args) {
  const options = { ...defaults, json: false, plans: false };
  const values = new Map([
    ['--rows', 'rows'],
    ['--iterations', 'iterations'],
    ['--sparse-vms', 'sparseVms'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--plans') options.plans = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (values.has(arg)) {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${arg} must be a positive integer`);
      }
      options[values.get(arg)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.sparseVms > options.rows) {
    throw new Error('--sparse-vms cannot exceed --rows');
  }
  return options;
}

function createDatabase(scenario, options) {
  const db = new Database(':memory:');
  const vmMatches = scenario === 'sparse' ? options.sparseVms : options.rows;
  const liveVms = Math.min(20, vmMatches);

  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.exec(`
    CREATE TABLE workloads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      workload_type TEXT NOT NULL,
      requested_compute_provider TEXT,
      credential_id TEXT,
      agent TEXT,
      session TEXT,
      spot INTEGER NOT NULL
    );
    CREATE TABLE vms (
      id INTEGER PRIMARY KEY,
      workload_id TEXT NOT NULL,
      ip TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      price_per_hour REAL,
      cost REAL,
      credential_id TEXT
    );
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      cloud_provider TEXT NOT NULL
    );
    INSERT INTO credentials VALUES
      ('cred-aws', 'AWS'), ('cred-gcp', 'GCP'), ('cred-azure', 'Azure');
    WITH RECURSIVE seq(i) AS (
      VALUES(0) UNION ALL SELECT i + 1 FROM seq WHERE i < ${options.rows - 1}
    )
    INSERT INTO workloads
    SELECT printf('d%09d', i), '${USER_ID}', 'completed', i,
           CASE i % 10 WHEN 0 THEN 'service' WHEN 1 THEN 'vm' ELSE 'job' END,
           NULL,
           NULL,
           CASE i % 4
             WHEN 0 THEN 'codex' WHEN 1 THEN 'claude'
             WHEN 2 THEN 'cursor' ELSE NULL END,
           CASE WHEN i < ${EXACT_SESSION_MATCHES}
             THEN '${TARGET_SESSION}' ELSE printf('session-%09d', i) END,
           CASE WHEN i % 5 = 0 THEN 1 ELSE 0 END
    FROM seq;
    INSERT INTO vms (
      workload_id, ip, created_at, ended_at, price_per_hour, cost,
      credential_id
    )
    SELECT id, '192.0.2.1',
           CASE WHEN started_at < ${vmMatches}
             THEN ${WINDOW_START} + (started_at % 1000)
             ELSE ${WINDOW_START} - 172800000 - started_at END,
           CASE WHEN started_at < ${liveVms} THEN NULL
             WHEN started_at < ${vmMatches}
               THEN ${WINDOW_END} - (started_at % 1000)
             ELSE ${WINDOW_START} - 86400000 - started_at END,
           1.0,
           NULL,
           CASE started_at % 3
             WHEN 0 THEN 'cred-aws'
             WHEN 1 THEN 'cred-gcp'
             ELSE 'cred-azure'
           END
    FROM workloads;
    CREATE INDEX idx_workloads_user
      ON workloads(user_id, started_at DESC);
    CREATE INDEX idx_workloads_agent
      ON workloads(agent) WHERE agent IS NOT NULL;
    CREATE INDEX idx_workloads_session
      ON workloads(session) WHERE session IS NOT NULL;
    CREATE INDEX idx_vms_workload_id ON vms(workload_id);
    CREATE INDEX idx_vms_spend_window
      ON vms(ended_at, created_at, workload_id)
      WHERE ip IS NOT NULL;
    ANALYZE;
  `);
  return db;
}

function overlap(alias) {
  return `${alias}.ip IS NOT NULL
    AND ${alias}.created_at < ${WINDOW_END}
    AND COALESCE(${alias}.ended_at, ${WINDOW_END}) > ${WINDOW_START}`;
}

function aggregateColumns(alias) {
  const overlapEnd = `(CASE
    WHEN COALESCE(${alias}.ended_at, ${WINDOW_END}) < ${WINDOW_END}
      THEN COALESCE(${alias}.ended_at, ${WINDOW_END})
    ELSE ${WINDOW_END}
  END)`;
  const overlapStart = `(CASE
    WHEN ${alias}.created_at > ${WINDOW_START}
      THEN ${alias}.created_at
    ELSE ${WINDOW_START}
  END)`;
  const overlapMs = `(${overlapEnd} - ${overlapStart})`;
  return {
    duration: `SUM(CASE WHEN ${overlap(alias)} THEN ${overlapMs} ELSE 0 END)`,
    cost: `SUM(CASE
      WHEN ${overlap(alias)} AND ${alias}.cost IS NOT NULL
        THEN ${alias}.cost * ${overlapMs}
          / NULLIF(COALESCE(${alias}.ended_at, ${WINDOW_END}) - ${alias}.created_at, 0)
      WHEN ${overlap(alias)} AND ${alias}.price_per_hour IS NOT NULL
        THEN ${alias}.price_per_hour * ${overlapMs} / 3600000.0
      ELSE 0
    END)`,
  };
}

function indexedWorkloadIds() {
  return `SELECT live.workload_id
    FROM vms live
    WHERE live.ip IS NOT NULL
      AND live.ended_at IS NULL
      AND live.created_at < ${WINDOW_END}
    UNION
    SELECT ended.workload_id
    FROM vms ended
    WHERE ended.ip IS NOT NULL
      AND ended.ended_at IS NOT NULL
      AND ended.ended_at > ${WINDOW_START}
      AND ended.created_at < ${WINDOW_END}`;
}

function indexedOverlappingVms() {
  return `SELECT live.workload_id, live.ip, live.created_at, live.ended_at,
      live.price_per_hour, live.cost
    FROM vms live
    WHERE live.ip IS NOT NULL
      AND live.ended_at IS NULL
      AND live.created_at < ${WINDOW_END}
    UNION ALL
    SELECT ended.workload_id, ended.ip, ended.created_at, ended.ended_at,
      ended.price_per_hour, ended.cost
    FROM vms ended
    WHERE ended.ip IS NOT NULL
      AND ended.ended_at IS NOT NULL
      AND ended.ended_at > ${WINDOW_START}
      AND ended.created_at < ${WINDOW_END}`;
}

function filterSql(mode) {
  if (mode === 'agent')
    return { clause: ' AND d.agent = ?', value: TARGET_AGENT };
  if (mode === 'session') {
    return { clause: ' AND d.session = ?', value: TARGET_SESSION };
  }
  return { clause: '', value: undefined };
}

function computedProvider(alias) {
  return `COALESCE(
    ${alias}.requested_compute_provider,
    (
      SELECT c.cloud_provider
      FROM vms provider_vm
      JOIN credentials c ON c.id = provider_vm.credential_id
      WHERE provider_vm.workload_id = ${alias}.id
        AND provider_vm.credential_id IS NOT NULL
      ORDER BY
        CASE WHEN provider_vm.ip IS NOT NULL
          AND provider_vm.ended_at IS NULL THEN 0 ELSE 1 END,
        provider_vm.created_at DESC,
        provider_vm.rowid DESC
      LIMIT 1
    ),
    (
      SELECT c.cloud_provider
      FROM credentials c
      WHERE c.id = ${alias}.credential_id
      LIMIT 1
    )
  )`;
}

function previousRowsQuery(mode) {
  const filter = filterSql(mode);
  const { duration, cost } = aggregateColumns('v');
  const workloadDriven = mode === 'session';
  const selected = workloadDriven
    ? `SELECT d.id
       FROM workloads d
       WHERE d.user_id = ?${filter.clause}
         AND EXISTS (
           SELECT 1 FROM vms vw
           WHERE vw.workload_id = d.id AND ${overlap('vw')}
         )
       ORDER BY d.started_at DESC, d.id DESC
       LIMIT ${COST_LIMIT}`
    : `SELECT d.id
       FROM overlapping_workload_ids overlapping
       CROSS JOIN workloads d
       WHERE d.id = overlapping.workload_id
         AND d.user_id = ?${filter.clause}
       ORDER BY d.started_at DESC, d.id DESC
       LIMIT ${COST_LIMIT}`;
  return {
    sql: `WITH ${
      workloadDriven
        ? ''
        : `overlapping_workload_ids AS (
       ${indexedWorkloadIds()}
     ),`
    }
     selected_ids AS (
       ${selected}
     )
     SELECT d.id, d.workload_type,
            ${computedProvider('d')} AS cloud_provider, d.agent, d.spot,
            ${duration} AS duration_ms,
            ${cost} AS total_cost
     FROM selected_ids selected
     CROSS JOIN workloads d
     LEFT JOIN vms v ON v.workload_id = d.id
     WHERE d.id = selected.id
     GROUP BY d.id
     ORDER BY d.started_at DESC, d.id DESC`,
    params: filter.value === undefined ? [USER_ID] : [USER_ID, filter.value],
  };
}

function reportQuery(mode) {
  const filter = filterSql(mode);
  const workloadDriven = mode === 'session';
  const { duration, cost } = aggregateColumns('v');
  const source = workloadDriven
    ? 'workloads d CROSS JOIN vms v'
    : 'overlapping_vms v CROSS JOIN workloads d';
  const where = workloadDriven
    ? `d.user_id = ?${filter.clause}
       AND v.workload_id = d.id
       AND ${overlap('v')}`
    : `d.id = v.workload_id
       AND d.user_id = ?${filter.clause}`;
  return {
    sql: `WITH ${
      workloadDriven
        ? ''
        : `overlapping_vms AS NOT MATERIALIZED (
       ${indexedOverlappingVms()}
     ),`
    }
     workload_costs AS MATERIALIZED (
       SELECT d.id, d.workload_type,
              ${computedProvider('d')} AS cloud_provider, d.agent, d.spot,
              ${duration} AS duration_ms,
              ${cost} AS total_cost
       FROM ${source}
       WHERE ${where}
       GROUP BY d.id
     )
     SELECT 'total' AS dimension, NULL AS key,
            COALESCE(SUM(CASE WHEN total_cost > 0 THEN total_cost ELSE 0 END), 0) AS total_cost,
            COALESCE(SUM(CASE WHEN total_cost > 0 THEN duration_ms ELSE 0 END), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN total_cost > 0 AND workload_type = 'job' THEN 1 ELSE 0 END), 0) AS jobs,
            COALESCE(SUM(CASE WHEN total_cost > 0 AND workload_type = 'service' THEN 1 ELSE 0 END), 0) AS services,
            COALESCE(SUM(CASE WHEN total_cost > 0 AND workload_type = 'vm' THEN 1 ELSE 0 END), 0) AS vms,
            COALESCE(SUM(CASE WHEN COALESCE(total_cost, 0) = 0 AND duration_ms > 0 THEN 1 ELSE 0 END), 0) AS unpriced,
            0 AS has_spot
     FROM workload_costs
     UNION ALL
     SELECT 'provider', COALESCE(cloud_provider, 'Unknown'),
            SUM(total_cost), SUM(duration_ms),
            SUM(CASE WHEN workload_type = 'job' THEN 1 ELSE 0 END),
            SUM(CASE WHEN workload_type = 'service' THEN 1 ELSE 0 END),
            SUM(CASE WHEN workload_type = 'vm' THEN 1 ELSE 0 END),
            0, MAX(CASE WHEN spot = 1 THEN 1 ELSE 0 END)
     FROM workload_costs
     WHERE total_cost > 0
     GROUP BY COALESCE(cloud_provider, 'Unknown')
     UNION ALL
     SELECT 'agent', agent, SUM(total_cost), SUM(duration_ms),
            SUM(CASE WHEN workload_type = 'job' THEN 1 ELSE 0 END),
            SUM(CASE WHEN workload_type = 'service' THEN 1 ELSE 0 END),
            SUM(CASE WHEN workload_type = 'vm' THEN 1 ELSE 0 END),
            0, 0
     FROM workload_costs
     WHERE total_cost > 0 AND agent IS NOT NULL AND agent != ''
     GROUP BY agent`,
    params: filter.value === undefined ? [USER_ID] : [USER_ID, filter.value],
  };
}

function emptyReport() {
  return {
    periodMs: PERIOD_MS,
    totalCost: 0,
    totalDurationMs: 0,
    totalJobs: 0,
    totalServices: 0,
    totalVms: 0,
    workloadsWithoutPrice: 0,
    byProvider: {},
    byAgent: {},
  };
}

function aggregateRows(rows) {
  const report = emptyReport();
  for (const row of rows) {
    const cost = Number(row.total_cost ?? 0);
    const durationMs = Number(row.duration_ms ?? 0);
    if (cost <= 0) {
      if (durationMs > 0) report.workloadsWithoutPrice += 1;
      continue;
    }
    report.totalCost += cost;
    report.totalDurationMs += durationMs;
    if (row.workload_type === 'service') report.totalServices += 1;
    else if (row.workload_type === 'vm') report.totalVms += 1;
    else report.totalJobs += 1;
    const provider = row.cloud_provider ?? 'Unknown';
    const providerBucket = report.byProvider[provider] ?? {
      cost: 0,
      durationMs: 0,
      jobs: 0,
      services: 0,
      vms: 0,
      hasSpot: false,
    };
    providerBucket.cost += cost;
    providerBucket.durationMs += durationMs;
    if (row.workload_type === 'service') providerBucket.services += 1;
    else if (row.workload_type === 'vm') providerBucket.vms += 1;
    else providerBucket.jobs += 1;
    if (row.spot === 1) providerBucket.hasSpot = true;
    report.byProvider[provider] = providerBucket;
    if (row.agent) {
      const agentBucket = report.byAgent[row.agent] ?? {
        cost: 0,
        durationMs: 0,
        jobs: 0,
        services: 0,
        vms: 0,
      };
      agentBucket.cost += cost;
      agentBucket.durationMs += durationMs;
      if (row.workload_type === 'service') agentBucket.services += 1;
      else if (row.workload_type === 'vm') agentBucket.vms += 1;
      else agentBucket.jobs += 1;
      report.byAgent[row.agent] = agentBucket;
    }
  }
  return report;
}

function reportFromRows(rows) {
  const report = emptyReport();
  for (const row of rows) {
    if (row.dimension === 'total') {
      report.totalCost = Number(row.total_cost);
      report.totalDurationMs = Number(row.duration_ms);
      report.totalJobs = Number(row.jobs);
      report.totalServices = Number(row.services);
      report.totalVms = Number(row.vms);
      report.workloadsWithoutPrice = Number(row.unpriced);
    } else if (row.dimension === 'provider') {
      report.byProvider[row.key] = {
        cost: Number(row.total_cost),
        durationMs: Number(row.duration_ms),
        jobs: Number(row.jobs),
        services: Number(row.services),
        vms: Number(row.vms),
        hasSpot: row.has_spot === 1,
      };
    } else if (row.dimension === 'agent') {
      report.byAgent[row.key] = {
        cost: Number(row.total_cost),
        durationMs: Number(row.duration_ms),
        jobs: Number(row.jobs),
        services: Number(row.services),
        vms: Number(row.vms),
      };
    }
  }
  return report;
}

function prepareRuns(db, mode) {
  const previousQuery = previousRowsQuery(mode);
  const aggregateQuery = reportQuery(mode);
  const previous = db.prepare(previousQuery.sql);
  const aggregate = db.prepare(aggregateQuery.sql);
  return {
    previous: () => {
      const rows = previous.all(...previousQuery.params);
      if (rows.length >= COST_LIMIT) {
        return {
          outcome: 'rejected',
          workloads: rows.length,
          wireBytes: null,
        };
      }
      const wire = JSON.stringify(rows);
      const report = aggregateRows(JSON.parse(wire));
      JSON.stringify(report);
      return {
        outcome: 'complete',
        workloads: rows.length,
        wireBytes: Buffer.byteLength(wire),
        report,
      };
    },
    aggregate: () => {
      const report = reportFromRows(aggregate.all(...aggregateQuery.params));
      const wire = JSON.stringify(report);
      JSON.parse(wire);
      return {
        outcome: 'complete',
        workloads:
          report.totalJobs +
          report.totalServices +
          report.totalVms +
          report.workloadsWithoutPrice,
        wireBytes: Buffer.byteLength(wire),
        report,
      };
    },
    previousPlan: explain(db, previousQuery.sql, previousQuery.params),
    aggregatePlan: explain(db, aggregateQuery.sql, aggregateQuery.params),
  };
}

function expectedMatches(mode, vmMatches) {
  if (mode === 'agent') return Math.floor((vmMatches - 1) / 4) + 1;
  if (mode === 'session') return Math.min(vmMatches, EXACT_SESSION_MATCHES);
  return vmMatches;
}

function runScenario(name, options) {
  const db = createDatabase(name, options);
  try {
    const vmMatches = name === 'sparse' ? options.sparseVms : options.rows;
    const results = ['broad', 'agent', 'session'].map((mode) => {
      const runs = prepareRuns(db, mode);
      const previous = runs.previous();
      const aggregate = runs.aggregate();
      const eligible = expectedMatches(mode, vmMatches);
      assert.equal(aggregate.workloads, eligible, `${mode} aggregate count`);
      if (eligible < COST_LIMIT) {
        assert.equal(previous.outcome, 'complete');
        assert.deepEqual(
          normalizeReport(aggregate.report),
          normalizeReport(previous.report),
          `${mode} aggregate report differs`,
        );
      } else {
        assert.equal(previous.outcome, 'rejected');
      }
      const timing = measureRuns(runs, options.iterations);
      return {
        mode,
        eligible,
        previousOutcome: previous.outcome,
        aggregateOutcome: aggregate.outcome,
        previousMs: timing.previous,
        aggregateMs: timing.aggregate,
        previousWireBytes: previous.wireBytes,
        aggregateWireBytes: aggregate.wireBytes,
        previousPlan: runs.previousPlan,
        aggregatePlan: runs.aggregatePlan,
      };
    });

    if (name === 'sparse' && options.rows >= 10_000) {
      for (const mode of ['broad', 'agent']) {
        requireSearch(
          results,
          mode,
          'aggregatePlan',
          'idx_vms_spend_window',
          2,
        );
      }
      requireSearch(
        results,
        'session',
        'aggregatePlan',
        'idx_workloads_session',
        1,
      );
      requireSearch(
        results,
        'session',
        'aggregatePlan',
        'idx_vms_workload_id',
        1,
      );
    }
    return {
      name,
      sqliteVersion: db.prepare('SELECT sqlite_version() version').get()
        .version,
      results,
    };
  } finally {
    db.close();
  }
}

function normalizeReport(report) {
  return JSON.parse(
    JSON.stringify(report, (_key, value) =>
      typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value,
    ),
  );
}

function measureRuns(runs, iterations) {
  for (let index = 0; index < 3; index += 1) {
    runs.previous();
    runs.aggregate();
  }
  const samples = { previous: [], aggregate: [] };
  for (let index = 0; index < iterations; index += 1) {
    const order =
      index % 2 === 0 ? ['previous', 'aggregate'] : ['aggregate', 'previous'];
    for (const name of order) {
      const started = performance.now();
      runs[name]();
      samples[name].push(performance.now() - started);
    }
  }
  return {
    previous: median(samples.previous),
    aggregate: median(samples.aggregate),
  };
}

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function explain(db, sql, params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => String(row.detail));
}

function requireSearch(results, mode, planName, index, count) {
  const result = results.find((candidate) => candidate.mode === mode);
  const plan = result[planName];
  const actual = plan.filter(
    (line) => line.includes('SEARCH') && line.includes(index),
  ).length;
  assert.ok(
    actual >= count,
    `${mode} expected ${count} SEARCH operations using ${index}:\n${plan.join('\n')}`,
  );
}

function formatMs(value) {
  if (value < 0.1) return value.toFixed(3);
  if (value < 10) return value.toFixed(2);
  return value.toFixed(1);
}

function formatBytes(value) {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function printReport(report, plans) {
  console.log(
    `SQLite ${report.sqliteVersion}; ${report.rows.toLocaleString()} rows; ` +
      `median of ${report.iterations} warm-cache complete-report runs`,
  );
  console.table(
    report.scenarios.flatMap((scenario) =>
      scenario.results.map((result) => ({
        scenario: scenario.name,
        filter: result.mode,
        matches: result.eligible,
        'previous result': result.previousOutcome,
        'previous ms': formatMs(result.previousMs),
        'aggregate result': result.aggregateOutcome,
        'aggregate ms': formatMs(result.aggregateMs),
        'time change':
          result.previousMs >= result.aggregateMs
            ? `${(result.previousMs / result.aggregateMs).toFixed(1)}x faster`
            : `${(result.aggregateMs / result.previousMs).toFixed(1)}x slower`,
        'previous wire': formatBytes(result.previousWireBytes),
        'aggregate wire': formatBytes(result.aggregateWireBytes),
      })),
    ),
  );
  console.log(
    'Dense rows compare a rejected partial read with a complete aggregate; ' +
      'their latency ratio is not an equal-work speedup.',
  );
  if (!plans) return;
  for (const scenario of report.scenarios) {
    for (const result of scenario.results) {
      console.log(`\n${scenario.name}/${result.mode} previous plan:`);
      console.log(result.previousPlan.join('\n'));
      console.log(`${scenario.name}/${result.mode} aggregate plan:`);
      console.log(result.aggregatePlan.join('\n'));
    }
  }
}

function usage() {
  return `Usage: yarn probe:sqlite-history [options]

Compares the previous capped per-workload response with the complete server-side
aggregate on identical sparse and dense histories. Timings include SQL,
serialization, parsing, and client aggregation where applicable; setup is
excluded and timings never gate CI.

  --rows N          rows per scenario (default ${defaults.rows})
  --iterations N    timed runs (default ${defaults.iterations})
  --sparse-vms N    sparse VM matches (default ${defaults.sparseVms})
  --plans           print query plans
  --json            print JSON
  -h, --help        show help`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(usage());
  else {
    const scenarios = ['sparse', 'dense'].map((name) =>
      runScenario(name, options),
    );
    const report = {
      rows: options.rows,
      iterations: options.iterations,
      model:
        'in-memory, warm-cache complete cost report; database setup excluded',
      sqliteVersion: scenarios[0].sqliteVersion,
      scenarios: scenarios.map(({ name, results }) => ({ name, results })),
    };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, options.plans);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
