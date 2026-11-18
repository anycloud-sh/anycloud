import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { transportError } from './errors.mjs';

export const HEALTH_INTERVAL_MS = 100;
export const HEALTH_DEADLINE_MS = 1000;

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeHealth(samples, deadlineMs = HEALTH_DEADLINE_MS) {
  const work = samples.filter((sample) => sample.phase === 'work');
  assert(
    work.every(
      (sample) =>
        typeof sample.ok === 'boolean' &&
        Number.isFinite(sample.elapsedMs) &&
        sample.elapsedMs >= 0 &&
        Number.isFinite(sample.offerDelayMs),
    ),
    'Incomplete health sample; every offered request needs an outcome',
  );
  const latencies = work
    .filter((sample) => sample.ok)
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b);
  const deadlineMisses = work.filter(
    (sample) => sample.error === 'timeout' || sample.elapsedMs > deadlineMs,
  ).length;
  const otherFailures = work.filter(
    (sample) => !sample.ok && sample.error !== 'timeout',
  ).length;
  return {
    offered: work.length,
    completed: latencies.length,
    deadlineMs,
    deadlineMisses,
    otherFailures,
    // A short sweep may have no overlapping probes. That is not a pass.
    responsive:
      work.length === 0 ? null : deadlineMisses === 0 && otherFailures === 0,
    maxMs: latencies.at(-1) ?? null,
    p95Ms:
      latencies.length === 0
        ? null
        : latencies[Math.ceil(latencies.length * 0.95) - 1],
    maxOfferDelayMs: work.length
      ? Math.max(...work.map((sample) => sample.offerDelayMs))
      : null,
  };
}

/** Runs in the driver process, independently of the API event loop. */
export function startHealthSampler(
  url,
  {
    timeoutMs = HEALTH_DEADLINE_MS,
    intervalMs = HEALTH_INTERVAL_MS,
    onSample,
  } = {},
) {
  const samples = [];
  const pending = new Set();
  const controllers = new Set();
  let phase = 'warmup';
  let stopped = false;
  let timer;
  let nextOffer = performance.now();
  function offer() {
    if (stopped) return;
    const offeredAt = performance.now();
    const sample = {
      phase,
      scheduledAt: nextOffer,
      offeredAt,
      offerDelayMs: Math.max(0, offeredAt - nextOffer),
    };
    // Record offers before completion, so a lost outcome cannot disappear
    // from the denominator and create a passing health result.
    samples.push(sample);
    onSample?.('offered', sample);
    nextOffer += intervalMs;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const request = fetch(url, { signal: controller.signal })
      .then(async (response) => {
        await response.arrayBuffer();
        return { ok: response.ok, status: response.status };
      })
      .catch((error) => ({
        ok: false,
        error: controller.signal.aborted ? 'timeout' : error.message,
        errorDetails: transportError(error),
      }))
      .then((outcome) => {
        Object.assign(sample, {
          ...outcome,
          elapsedMs: performance.now() - offeredAt,
        });
        onSample?.('settled', sample);
      })
      .finally(() => {
        clearTimeout(timeout);
        controllers.delete(controller);
        pending.delete(request);
      });
    pending.add(request);
    // Keep scheduled arrival times in the record even when the driver is late.
    timer = setTimeout(offer, Math.max(0, nextOffer - performance.now()));
  }
  offer();
  return {
    samples,
    setPhase(nextPhase) {
      phase = nextPhase;
    },
    async stop({ abort = false } = {}) {
      stopped = true;
      clearTimeout(timer);
      if (abort) for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
      return samples;
    },
  };
}

/** Wrap synchronous SQLite boundaries, never overlapping async query promises. */
export function instrumentDatabase(db, { now = () => performance.now() } = {}) {
  assert.equal(typeof db.execute, 'function', 'SQLite timing boundary changed');
  assert.equal(
    typeof db.db?.transaction,
    'function',
    'SQLite synchronous transaction boundary changed',
  );
  const original = db.execute;
  const originalTransaction = db.db.transaction;
  const queries = new Map();
  const metrics = {
    statements: 0,
    readStatements: 0,
    writeStatements: 0,
    totalMs: 0,
    maxMs: 0,
    transactions: 0,
    transactionOverheadMs: 0,
    maxTransactionMs: 0,
    maxReturnedRows: 0,
    returnedRows: 0,
    planCaptureLimit: 32,
    plansTruncated: false,
  };
  db.execute = function (sql, params, ...rest) {
    const read = /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql);
    const started = now();
    let result;
    try {
      result = original.call(this, sql, params, ...rest);
      return result;
    } finally {
      const elapsedMs = now() - started;
      metrics.statements++;
      metrics[read ? 'readStatements' : 'writeStatements']++;
      metrics.totalMs += elapsedMs;
      metrics.maxMs = Math.max(metrics.maxMs, elapsedMs);
      if (read && result) {
        metrics.returnedRows += result.length;
        metrics.maxReturnedRows = Math.max(
          metrics.maxReturnedRows,
          result.length,
        );
      }
      const key = sql.replace(/\s+/g, ' ').trim();
      if (read && !queries.has(key)) {
        if (queries.size < metrics.planCaptureLimit) {
          queries.set(key, { sql, params: params ?? [] });
        } else {
          metrics.plansTruncated = true;
        }
      }
    }
  };
  // execute includes baseline autocommit, but an explicit transaction commits
  // outside execute. Time the native transaction runner and subtract its whole
  // callback: statements are already counted above, and nested savepoints get
  // their own overhead. This includes BEGIN/COMMIT/rollback without counting
  // the callback's JS work, nested transactions, or async waits twice.
  db.db.transaction = function (callback) {
    const frames = [];
    const native = originalTransaction.call(this, function (...args) {
      const frame = frames.at(-1);
      const started = now();
      try {
        return callback.apply(this, args);
      } finally {
        frame.callbackMs += now() - started;
      }
    });
    const variants = Object.fromEntries(
      ['default', 'deferred', 'immediate', 'exclusive'].map((name) => {
        assert.equal(
          typeof native[name],
          'function',
          'SQLite transaction runner changed',
        );
        return [
          name,
          function (...args) {
            const frame = { callbackMs: 0 };
            frames.push(frame);
            const started = now();
            try {
              return native[name].apply(this, args);
            } finally {
              const elapsedMs = now() - started;
              frames.pop();
              const overheadMs = Math.max(0, elapsedMs - frame.callbackMs);
              metrics.transactions++;
              metrics.transactionOverheadMs += overheadMs;
              metrics.totalMs += overheadMs;
              metrics.maxTransactionMs = Math.max(
                metrics.maxTransactionMs,
                elapsedMs,
              );
            }
          },
        ];
      }),
    );
    const properties = {
      ...Object.fromEntries(
        Object.entries(variants).map(([name, value]) => [name, { value }]),
      ),
      database: { value: native.database, enumerable: true },
    };
    for (const variant of Object.values(variants)) {
      Object.defineProperties(variant, properties);
    }
    return variants.default;
  };
  return {
    metrics,
    restore() {
      db.execute = original;
      db.db.transaction = originalTransaction;
    },
    async explain() {
      const plans = [];
      for (const { sql, params } of queries.values()) {
        if (/^\s*EXPLAIN\b/i.test(sql)) continue;
        plans.push({
          sql,
          details: (await db.query('EXPLAIN QUERY PLAN ' + sql, params)).map(
            (row) => row.detail,
          ),
        });
      }
      return plans;
    },
  };
}
