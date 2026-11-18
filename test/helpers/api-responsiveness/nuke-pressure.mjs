// Preloaded only into the isolated Local nuke API, never into its SSH helper.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

assert.equal(process.platform, 'linux');
assert.equal(process.env.IS_TEST, 'true');
const directory = '/fixture/nuke';
const mode = process.env.NUKE_SSH_PRESSURE_MODE ?? 'helper';
assert.ok(['helper', 'direct'].includes(mode));
const { runSshProcess } = await import(
  '/app/dist/api/services/gateways/ssh-process.js'
);

// Touch every page and retain it throughout the real workload lifecycle.
globalThis.nukeResidentMemory = Array.from({ length: 2048 }, () =>
  Buffer.alloc(1024 ** 2, 1),
);
const report = {
  mode,
  state: 'ready',
  pid: process.pid,
  minRssBytes: process.memoryUsage().rss,
  startedAt: null,
  durationMs: 0,
  offered: 0,
  launched: 0,
  completed: 0,
  failures: 0,
  peakPending: 0,
  pending: 0,
};
assert.ok(report.minRssBytes >= 2048 * 1024 ** 2);
const pending = new Set();
let started;

function snapshot() {
  report.pending = pending.size;
  const file = `${directory}/nuke-ssh-pressure.json`;
  writeFileSync(`${file}.tmp`, JSON.stringify(report) + '\n');
  renameSync(`${file}.tmp`, file);
}

function launch() {
  report.offered++;
  // Bound the fixture itself when exercising the original failure mechanism.
  if (pending.size >= 120) {
    report.failures++;
    return;
  }
  const onSpawn = () => report.launched++;
  const operation =
    mode === 'helper'
      ? runSshProcess(['-V'], {
          ignoreStdin: true,
          deadlineAt: performance.now() + 6000,
          onSpawn,
        })
      : new Promise((resolve, reject) => {
          const child = spawn('ssh', ['-V'], {
            env: {},
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 6000,
          });
          child.once('spawn', onSpawn);
          child.once('error', reject);
          child.once('close', (code) => resolve({ code }));
          child.stdout.resume();
          child.stderr.resume();
        });
  const settled = operation
    .then(
      ({ code }) => {
        report.completed++;
        if (code !== 0) report.failures++;
      },
      () => {
        report.failures++;
      },
    )
    .finally(() => pending.delete(settled));
  pending.add(settled);
  report.peakPending = Math.max(report.peakPending, pending.size);
}

snapshot();
const timer = setInterval(() => {
  if (existsSync(`${directory}/nuke-ssh-stop`)) {
    clearInterval(timer);
    report.durationMs = started === undefined ? 0 : performance.now() - started;
    report.state = 'draining';
    snapshot();
    void Promise.all([...pending]).then(() => {
      report.state = 'stopped';
      snapshot();
    });
    return;
  }
  if (started === undefined) {
    if (!existsSync(`${directory}/nuke-ssh-start`)) return;
    started = performance.now();
    report.startedAt = Date.now();
    report.state = 'running';
  }
  report.minRssBytes = Math.min(report.minRssBytes, process.memoryUsage().rss);
  // Fixed offers preserve the observed 40-command bursts at 24 launches/s.
  // Late ticks still owe work; throttling must fail the coverage gate.
  const due =
    (Math.floor((performance.now() - started) / ((40 / 24) * 1000)) + 1) * 40;
  const missing = due - report.offered;
  for (let i = 0; i < missing; i++) launch();
  report.durationMs = performance.now() - started;
  snapshot();
}, 100);
timer.unref();
