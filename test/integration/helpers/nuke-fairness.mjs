#!/usr/bin/env node
// Queue-fairness gate for the nuke harness.
//
// The completion pass bar is invariant under dispatch order: a scheduler that
// serves one lane's backlog before another's still completes the same jobs
// and still passes. This measures the one thing that bar cannot see — how long
// a second lane's job, submitted last, waited for a provisioning slot.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const QUEUED_STATE = 'queued';

/**
 * Leaving the queue for one of these is not a dispatch — the workload never
 * competed for a slot. Without this, a witness rejected at submission reads as
 * a perfect zero-second pass.
 */
export const NON_DISPATCH_STATES = ['invalid', 'failed', 'errored'];

export function createWitnessTracker() {
  return {
    samples: 0,
    lastSampleSeconds: null,
    dispatchedAt: {},
    rejected: {},
  };
}

/**
 * Fold one poll snapshot into the tracker.
 *
 * A dispatch time is poll-resolution and therefore only ever OVER-stated, which
 * points away from false failures: a witness reported as late really was late.
 */
export function recordWitnessSample(tracker, sample) {
  const seconds = Number(sample.t);
  if (!Number.isFinite(seconds)) {
    throw new Error(`witness sample has a non-numeric t: ${sample.t}`);
  }
  const workloads = Array.isArray(sample.workloads) ? sample.workloads : [];
  for (const workload of workloads) {
    const id = workload?.id;
    const state = workload?.state;
    if (typeof id !== 'string' || typeof state !== 'string') continue;
    if (state === QUEUED_STATE) continue;
    if (NON_DISPATCH_STATES.includes(state)) {
      tracker.rejected[id] = state;
      continue;
    }
    if (tracker.dispatchedAt[id] === undefined) {
      tracker.dispatchedAt[id] = seconds;
    }
  }
  tracker.samples += 1;
  tracker.lastSampleSeconds = seconds;
  return tracker;
}

export function parseWitnessSamples(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(
          `witness sample ${index + 1} is not valid JSON: ${err.message}`,
        );
      }
    });
}

export function buildWitnessTracker(samples) {
  const tracker = createWitnessTracker();
  for (const sample of samples) recordWitnessSample(tracker, sample);
  return tracker;
}

/**
 * The witness jobs are submitted LAST, from a second lane, behind a backlog
 * deeper than the scheduler's dispatch window. They must still win a slot
 * promptly — that is the starvation property.
 */
export function evaluateFairness(tracker, options = {}) {
  const { witnessIds = [], maxDispatchSeconds } = options;
  const failures = [];

  if (witnessIds.length === 0) {
    failures.push('no witness ids were given, so nothing was measured');
  }

  for (const id of witnessIds) {
    const dispatchedAt = tracker.dispatchedAt[id];
    if (tracker.rejected[id] !== undefined && dispatchedAt === undefined) {
      failures.push(
        `witness ${id} went ${tracker.rejected[id]} without ever being dispatched, so this run measured nothing`,
      );
      continue;
    }
    if (dispatchedAt === undefined) {
      const seen =
        tracker.lastSampleSeconds === null
          ? 'no samples recorded'
          : `last sample t=${tracker.lastSampleSeconds}s`;
      failures.push(
        `witness ${id} never left ${QUEUED_STATE} (${seen}) — the backlog owned the dispatch window`,
      );
      continue;
    }
    if (
      Number.isFinite(maxDispatchSeconds) &&
      dispatchedAt > maxDispatchSeconds
    ) {
      failures.push(
        `witness ${id} waited ${dispatchedAt}s for a slot, over the ${maxDispatchSeconds}s bar`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

export function formatFairnessSummary(tracker, witnessIds = []) {
  const waits = witnessIds
    .map((id) => {
      const at = tracker.dispatchedAt[id];
      return `${id}=${at === undefined ? 'never' : `${at}s`}`;
    })
    .join(' ');
  return `samples=${tracker.samples}  witness dispatch: ${waits || 'none'}`;
}

function parseArgs(argv) {
  const options = { witnessIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--samples') options.samplesPath = next;
    else if (arg === '--max-dispatch-sec')
      options.maxDispatchSeconds = Number(next);
    else if (arg === '--witness')
      options.witnessIds = next ? next.split(',').filter(Boolean) : [];
    else continue;
    i += 1;
  }
  return options;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.samplesPath) {
    console.error('nuke-fairness: --samples <file> is required');
    process.exit(2);
  }
  const tracker = buildWitnessTracker(
    parseWitnessSamples(readFileSync(options.samplesPath, 'utf8')),
  );
  console.log(formatFairnessSummary(tracker, options.witnessIds));
  const { ok, failures } = evaluateFairness(tracker, options);
  if (!ok) {
    for (const failure of failures) console.error(`nuke-fairness: ${failure}`);
    process.exit(1);
  }
}
