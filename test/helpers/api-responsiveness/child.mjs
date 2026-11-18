import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';
import path from 'node:path';
import {
  BUSINESS_TIME_MS,
  assertBillingCosts,
  billingGroups,
  fixtureFingerprint,
  importBuild,
  inspectBillingSettlement,
  readBillingRows,
  resourceIdOf,
  seedBillingFixture,
} from './billing-fixture.mjs';
import {
  configureBillingProvider,
  billingProviderSnapshot,
} from './billing-provider.mjs';
import { instrumentDatabase } from './metrics.mjs';
import { measureIndexCreation, storageSnapshot } from './database-costs.mjs';

const options = JSON.parse(process.argv[2]);
// Billing fixtures freeze business time; SSH process deadlines use real time.
if (options.scenario !== 'ssh') Date.now = () => BUSINESS_TIME_MS;
const { getDB } = await importBuild(
  options.buildDir,
  'api/services/repositories/db.js',
);
// Newest layout first: the admission insert as a free function, then the
// class-based Workload and Deployment stores of older baseline builds.
const legacyStore = 'api/services/deployment-store.js';
const storePath = [
  'api/services/repositories/workload-creation.js',
  'api/services/workload-store.js',
  legacyStore,
].find((candidate) =>
  existsSync(path.join(options.buildDir, 'dist', candidate)),
);
const storeModule = await importBuild(options.buildDir, storePath);
const Store = storeModule.WorkloadStore ?? storeModule.DeploymentStore;
const db = getDB();
let server;
let eventLoop;
let finished = false;
process.once('disconnect', () => {
  if (!finished) process.exit(1);
});
const assertGuard = () =>
  assert.deepEqual(globalThis.apiResponsivenessGuardFailures, []);
const send = (message) =>
  new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve())),
  );
const receive = () =>
  new Promise((resolve) => process.once('message', resolve));

try {
  const initStarted = performance.now();
  await db.init();
  const initMs = performance.now() - initStarted;
  const store = Store
    ? new Store(db)
    : { createWorkload: (input) => storeModule.createWorkload(db, input) };
  if (options.scenario === 'ssh') {
    assert.equal(options.action, 'measure');
    await send({ kind: 'result', result: await measureSshResponsiveness() });
  } else if (options.action === 'seed') {
    const seedStarted = performance.now();
    const fixture = await seedBillingFixture({
      buildDir: options.buildDir,
      db,
      store,
      profile: options.profile,
    });
    fixture.logicalSha256 = await fixtureFingerprint(db);
    fixture.seedMs = performance.now() - seedStarted;
    assertGuard();
    const { indexes } = await storageSnapshot(db);
    await send({ kind: 'result', result: { fixture, initMs, indexes } });
  } else {
    assert.equal(
      await fixtureFingerprint(db, {
        ignoreBillingCosts: ['audit', 'resume'].includes(options.action),
      }),
      options.fixture.logicalSha256,
      'Migration or trial changed the logical fixture',
    );
    if (options.action === 'prepare') {
      const storage = await storageSnapshot(db);
      const indexCreation = await measureIndexCreation(
        db,
        options.baselineIndexes,
      );
      const writeProbe = await measureWriteCost();
      assert.equal(
        await fixtureFingerprint(db),
        options.fixture.logicalSha256,
        'Write-cost probe did not roll back',
      );
      assertGuard();
      await send({
        kind: 'result',
        result: { initMs, storage, indexCreation, writeProbe },
      });
    } else if (options.action === 'audit') {
      const rows = await readBillingRows(db);
      const groups = billingGroups(rows, options.fixture.accounts);
      assertGuard();
      await send({
        kind: 'result',
        result: { settlement: inspectBillingSettlement(rows, groups) },
      });
    } else if (['measure', 'resume'].includes(options.action)) {
      let rows = await readBillingRows(db);
      const groups = billingGroups(rows, options.fixture.accounts);
      assert.equal(groups.length, options.fixture.groups);
      const pendingResources = new Set(
        rows
          .filter((row) => row.cost === null)
          .map((row) => JSON.stringify([resourceIdOf(row), row.credential_id])),
      );
      const pendingGroups = groups.filter((group) =>
        pendingResources.has(
          JSON.stringify([group.resourceId, group.credentialId]),
        ),
      );
      rows = undefined;
      configureBillingProvider(pendingGroups, options);
      const { runCostCalculationOnce } = await importBuild(
        options.buildDir,
        'api/services/cost-calculation/monitor.js',
      );
      const ownerTable =
        storePath === legacyStore ? 'deployments' : 'workloads';
      for (const table of ['vms', ownerTable, 'container_specs']) {
        await db.query(
          'SELECT COUNT(*) AS count FROM ' + table + ' NOT INDEXED',
        );
      }
      const loop = await startMeasurement();
      let delayedTransactions = 0;
      if (options.synchronousSettlementDelayMs !== undefined) {
        const delayMs = options.synchronousSettlementDelayMs;
        assert(Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= 1000);
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        const transaction = db.db.transaction;
        // Qualification-only storage stall, inside the real native transaction.
        // Keep it outside the measured callback so SQL overhead includes it.
        db.db.transaction = function (callback) {
          return transaction.call(this, function (...args) {
            const result = callback.apply(this, args);
            delayedTransactions++;
            Atomics.wait(waitCell, 0, 0, delayMs);
            return result;
          });
        };
      }
      const sql = instrumentDatabase(db);
      if (options.faultAfterWrites !== undefined) {
        assert(
          Number.isSafeInteger(options.faultAfterWrites) &&
            options.faultAfterWrites > 0,
        );
        assert(
          options.faultEvidencePath,
          'Interruption evidence path is required',
        );
        let writes = 0;
        const execute = db.execute;
        db.execute = function (statement, ...args) {
          const result = execute.call(this, statement, ...args);
          if (/^\s*UPDATE\s+vms\s+SET\s+cost\s*=/i.test(statement)) {
            writes += result[0]?.rowsAffected ?? 0;
            if (writes >= options.faultAfterWrites) {
              writeFileSync(
                options.faultEvidencePath,
                JSON.stringify(
                  {
                    vmCostWrites: writes,
                    inTransaction: db.db.inTransaction,
                  },
                  null,
                  2,
                ) + '\n',
              );
              process.stderr.write(
                'Injected process exit after ' + writes + ' VM cost writes\n',
              );
              process.exit(86);
            }
          }
          return result;
        };
      }
      let firstTimerDelayMs;
      const cpu = process.cpuUsage();
      const started = performance.now();
      const firstTimer = setTimeout(10).then(() => {
        firstTimerDelayMs = Math.max(0, performance.now() - started - 10);
      });
      try {
        await runCostCalculationOnce();
      } finally {
        sql.restore();
      }
      const elapsedMs = performance.now() - started;
      const cpuUsed = process.cpuUsage(cpu);
      const peakRssMiB = process.resourceUsage().maxRSS / 1024;
      const memoryAfter = process.memoryUsage();
      const healthDrained = receive();
      await send({ kind: 'work-finished' });
      await firstTimer;
      await setImmediate();
      loop.disable();
      assert.equal((await healthDrained).kind, 'health-drained');
      const billing = billingProviderSnapshot();
      assert.deepEqual(billing.failures, []);
      assert.equal(billing.groupVisits.length, pendingGroups.length);
      assert.equal(
        billing.calls,
        pendingGroups.length,
        'Every group must reach billing',
      );
      assert.equal(billing.distinctGroups, pendingGroups.length);
      assert(
        billing.groups.every(([, count]) => count === 1),
        'Group billed twice',
      );
      assert(billing.peak <= 20, 'Billing concurrency exceeded 20');
      const correctness = assertBillingCosts(
        await readBillingRows(db),
        groups,
        options.response,
      );
      assertGuard();
      const plans = await sql.explain();
      await send({
        kind: 'result',
        result: {
          elapsedMs,
          cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
          initialTimerDelayMs: firstTimerDelayMs,
          eventLoopMaxMs: loop.max / 1e6,
          eventLoopP99Ms: loop.percentile(99) / 1e6,
          peakRssMiB,
          memoryAfter,
          sql: sql.metrics,
          plans,
          // Keep individual account/resource identities out of IPC-sized reports.
          billing: {
            calls: billing.calls,
            distinctGroups: billing.distinctGroups,
            peak: billing.peak,
          },
          correctness,
          initMs,
          injectedSettlementDelay:
            options.synchronousSettlementDelayMs === undefined
              ? undefined
              : {
                  perTransactionMs: options.synchronousSettlementDelayMs,
                  transactions: delayedTransactions,
                },
        },
      });
    } else {
      throw new Error('Unknown child action: ' + options.action);
    }
  }
} catch (error) {
  await send({ kind: 'failure', error: error.stack ?? String(error) });
  process.exitCode = 1;
} finally {
  eventLoop?.disable();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();
  finished = true;
  process.disconnect();
}

async function startMeasurement() {
  const { createApp } = await importBuild(options.buildDir, 'api/server.js');
  const app = createApp({
    authenticate: () => {
      throw new Error('Responsiveness fixture exposes only /health');
    },
    resolveRpcDomains: () => {
      throw new Error('Responsiveness fixture exposes only /health');
    },
  });
  server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      app(request, response);
    } else {
      response.writeHead(403);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const start = receive();
  await send({ kind: 'ready', port: server.address().port });
  await start;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop = loop;
  loop.enable();
  // Arm the native sampler before entering the measured work phase.
  await setTimeout(30);
  const go = receive();
  await send({ kind: 'started' });
  await go;
  return loop;
}

async function measureSshResponsiveness() {
  assert.equal(
    process.platform,
    'linux',
    'Run the SSH workload in the API image',
  );
  const mode = options.sshLaunchMode ?? 'helper';
  assert.ok(['baseline', 'helper'].includes(mode));
  const transport =
    mode === 'baseline'
      ? undefined
      : await importBuild(
          options.buildDir,
          'api/services/gateways/ssh-process.js',
        );
  const residentMiB = options.sshResidentMiB ?? 2048;
  const launchRate = options.sshLaunchRate ?? 24;
  assert.ok(Number.isInteger(residentMiB) && residentMiB >= 2048);
  assert.ok(Number.isInteger(launchRate) && launchRate > 0);
  // Touch and retain every page; a virtual allocation misses Linux fork costs.
  const memory = Array.from({ length: residentMiB }, () =>
    Buffer.alloc(1024 * 1024, 1),
  );
  const rss = process.memoryUsage().rss;
  assert.ok(
    rss >= residentMiB * 1024 ** 2,
    `Resident allocation missing: ${rss}`,
  );
  const containerCpu = () => {
    try {
      return (
        Number(
          /^usage_usec (\d+)$/m.exec(
            readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'),
          )[1],
        ) / 1000
      );
    } catch {
      return (
        Number(readFileSync('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8')) /
        1e6
      );
    }
  };
  const processCounts = () => {
    const counts = { clients: 0, helpers: 0, zombies: 0 };
    let helperRssMiB = 0;
    let helperPeakRssMiB = 0;
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = readFileSync('/proc/' + name + '/status', 'utf8');
        if (/^Name:\s+ssh$/m.test(status)) counts.clients++;
        if (/^State:\s+Z/m.test(status)) counts.zombies++;
        const args = readFileSync('/proc/' + name + '/cmdline', 'utf8').split(
          '\0',
        );
        if (args.some((arg) => arg.endsWith('/ssh-process-helper.js'))) {
          counts.helpers++;
          helperRssMiB +=
            Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024;
          helperPeakRssMiB +=
            Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024;
        }
      } catch {
        /* A short-lived process exited during the snapshot. */
      }
    }
    return { counts, helperRssMiB, helperPeakRssMiB };
  };
  const loop = await startMeasurement();
  const work = [];
  const startWaits = [];
  const offerDelays = [];
  let offered = 0;
  let launched = 0;
  let completed = 0;
  let rejected = 0;
  let cancelled = 0;
  let failures = 0;
  let pending = 0;
  let peakPending = 0;
  const errors = {};
  const batchSize = 40;
  const target = launchRate * 30;
  const launch = (dueAt) => {
    offered++;
    pending++;
    peakPending = Math.max(peakPending, pending);
    offerDelays.push(Math.max(0, performance.now() - dueAt));
    let entered = false;
    const consume = (child) => {
      child.once('spawn', () => {
        entered = true;
        pending--;
        launched++;
        startWaits.push(performance.now() - dueAt);
      });
      return new Promise((resolve) => {
        let failed = false;
        child.once('error', () => {
          failed = true;
        });
        child.once('close', (code) => {
          completed++;
          if (failed || code !== 0) failures++;
          resolve();
        });
        child.stdout.resume();
        child.stderr.resume();
      });
    };
    // Direct API launches and helper launches receive the same fixed work.
    let operation;
    try {
      operation =
        mode === 'helper'
          ? transport
              .runSshProcess(['-V'], {
                ignoreStdin: true,
                onSpawn() {
                  entered = true;
                  pending--;
                  launched++;
                  startWaits.push(performance.now() - dueAt);
                },
              })
              .then((result) => {
                completed++;
                if (result.code !== 0) failures++;
              })
          : consume(
              spawn('ssh', ['-V'], {
                env: {},
                stdio: ['ignore', 'pipe', 'pipe'],
              }),
            );
    } catch (error) {
      operation = Promise.reject(error);
    }
    work.push(
      operation.catch((error) => {
        if (!entered) pending--;
        if (/aborted/i.test(error.message)) cancelled++;
        else rejected++;
        failures++;
        errors[error.message] = (errors[error.message] ?? 0) + 1;
      }),
    );
  };
  try {
    const cpu = process.cpuUsage();
    const totalCpu = containerCpu();
    const started = performance.now();
    // Precompute fixed offers, independent of active/queued starts. Delayed
    // timers still owe their work, and their delay is part of start latency.
    const offers = Array.from(
      { length: Math.ceil(target / batchSize) },
      async (_, batch) => {
        const dueAt = started + ((batch * batchSize) / launchRate) * 1000;
        await setTimeout(Math.max(0, dueAt - performance.now()));
        for (
          let index = 0;
          index < Math.min(batchSize, target - batch * batchSize);
          index++
        )
          launch(dueAt);
      },
    );
    await Promise.all(offers);
    await setTimeout(Math.max(0, 30_000 - (performance.now() - started)));
    await Promise.all(work);
    const elapsedMs = performance.now() - started;
    const cpuUsed = process.cpuUsage(cpu);
    const totalCpuMs = containerCpu() - totalCpu;
    const healthDrained = receive();
    await send({ kind: 'work-finished' });
    assert.equal((await healthDrained).kind, 'health-drained');
    loop.disable();
    assert.ok(memory.every((page) => page[0] === 1));
    startWaits.sort((a, b) => a - b);
    const processSnapshot = processCounts();
    return {
      mode,
      node: process.version,
      arch: process.arch,
      rss,
      residentMiB,
      elapsedMs,
      cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
      containerCpuMs: totalCpuMs,
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      target,
      offered,
      launched,
      completed,
      rejected,
      cancelled,
      failures,
      errors,
      peakPending,
      finalPending: pending,
      startWaitP99Ms:
        startWaits[Math.ceil(startWaits.length * 0.99) - 1] ?? null,
      startWaitMaxMs: Math.max(0, ...startWaits),
      offerDelayMaxMs: Math.max(0, ...offerDelays),
      processes: processSnapshot.counts,
      helperRssMiB: processSnapshot.helperRssMiB,
      helperPeakRssMiB: processSnapshot.helperPeakRssMiB,
      launchesPerSecond: launched / (elapsedMs / 1000),
    };
  } finally {
    await transport?.shutdownSshProcesses();
  }
}

async function measureWriteCost() {
  const records = await db.query(
    "SELECT * FROM vms WHERE cloud_id LIKE 'billing-vm-%' ORDER BY id LIMIT 256",
  );
  const columns = Object.keys(records[0]).filter((column) => column !== 'id');
  assert(columns.every((column) => /^[a-z_]+$/.test(column)));
  const insert =
    'INSERT INTO vms (' +
    columns.join(',') +
    ') VALUES (' +
    columns.map(() => '?').join(',') +
    ')';
  const rollback = new Error('Roll back write-cost probe');
  let insertMs;
  let updateMs;
  const started = performance.now();
  try {
    await db.transaction((tx) => {
      const insertStarted = performance.now();
      for (const record of records) {
        tx.query(
          insert,
          columns.map((column) =>
            column === 'cloud_id'
              ? 'write-probe-' + record.cloud_id
              : record[column],
          ),
        );
      }
      insertMs = performance.now() - insertStarted;
      const updateStarted = performance.now();
      for (const record of records) {
        tx.query('UPDATE vms SET cost=? WHERE id=?', [1, record.id]);
      }
      updateMs = performance.now() - updateStarted;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return {
    rows: records.length,
    insertMs,
    updateMs,
    totalIncludingRollbackMs: performance.now() - started,
    committed: false,
  };
}
