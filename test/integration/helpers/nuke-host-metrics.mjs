#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  startHealthSampler,
  summarizeHealth,
} from '../../helpers/api-responsiveness/metrics.mjs';

const KB_PER_MB = 1024;

function die(message) {
  throw new Error(message);
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function sshHelpers(sample) {
  return sample.container.sshHelperProcesses ?? 0;
}

function nonHelperProcesses(sample) {
  return sample.container.processes - sshHelpers(sample);
}

function stateCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([state, count]) =>
        !/^[A-Za-z?]$/.test(state) || !Number.isFinite(count) || count < 0,
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries.map(([state, count]) => [state, count]));
}

function validHostSample(row) {
  return (
    Number.isFinite(row?.elapsedSec) &&
    Number.isFinite(row?.host?.load1) &&
    Number.isFinite(row?.host?.memoryAvailableKb) &&
    Number.isFinite(row?.container?.processes) &&
    (row.container.sshHelperProcesses === undefined ||
      (Number.isInteger(row.container.sshHelperProcesses) &&
        row.container.sshHelperProcesses >= 0 &&
        row.container.sshHelperProcesses <= row.container.processes)) &&
    Number.isFinite(row?.container?.fdCount) &&
    Number.isFinite(row?.container?.socketFds) &&
    Number.isFinite(row?.container?.maxProcessFds) &&
    stateCounts(row?.container?.stateCounts) !== null &&
    Number.isFinite(row?.container?.zombieProcesses) &&
    Number.isFinite(row?.container?.ppid1Processes) &&
    Number.isFinite(row?.container?.ppid1ZombieProcesses)
  );
}

function validHostSamples(rows) {
  return rows.filter(validHostSample);
}

export function parseHostRows(text, file = 'host metrics ndjson') {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        die(`Malformed host sample JSON in ${file}:${index + 1}: ${detail}`);
      }
    });
}

export function analyzeHostSamples(rows) {
  const errors = rows.filter((row) => row?.error);
  const samples = validHostSamples(rows);
  const machineSamples = samples.filter(
    (sample) =>
      Number.isFinite(sample?.machines?.total) &&
      Number.isFinite(sample?.machines?.running),
  );
  const localDiskSamples = samples.filter((sample) =>
    Number.isFinite(sample?.localDiskKb),
  );
  const failures = [];
  const warnings = [];

  if (samples.length === 0) failures.push('No valid runner host samples');
  if (rows.length > 0 && !validHostSample(rows.at(-1))) {
    failures.push('No valid final runner host sample');
  }
  if (errors.length > 0 && samples.length > 0) {
    warnings.push(
      `Runner host sampler errors=${errors.length}/${rows.length}; first=${JSON.stringify(errors[0])}`,
    );
  }

  const max = (selector, values = samples, empty = 0) =>
    values.length === 0 ? empty : Math.max(...values.map(selector));
  const min = (selector, values = samples, empty = 0) =>
    values.length === 0 ? empty : Math.min(...values.map(selector));
  const baseline = samples[0];
  const final = samples.at(-1);
  const allStates = new Set(
    samples.flatMap((sample) => Object.keys(sample.container.stateCounts)),
  );
  const maxStateCounts = Object.fromEntries(
    [...allStates]
      .sort()
      .map((state) => [
        state,
        max((sample) => sample.container.stateCounts[state] ?? 0),
      ]),
  );
  const stats = {
    samples: samples.length,
    errors: errors.length,
    maxMachines: max((sample) => sample.machines.total, machineSamples, null),
    maxRunningMachines: max(
      (sample) => sample.machines.running,
      machineSamples,
      null,
    ),
    maxContainerProcesses: max((sample) => sample.container.processes),
    maxContainerSshHelpers: max(sshHelpers),
    maxContainerFds: max((sample) => sample.container.fdCount),
    maxContainerSocketFds: max((sample) => sample.container.socketFds),
    maxContainerProcessFds: max((sample) => sample.container.maxProcessFds),
    maxContainerZombies: max((sample) => sample.container.zombieProcesses),
    maxContainerPpid1Processes: max(
      (sample) => sample.container.ppid1Processes,
    ),
    maxContainerPpid1Zombies: max(
      (sample) => sample.container.ppid1ZombieProcesses,
    ),
    maxContainerStateCounts: maxStateCounts,
    baselineContainerProcesses: baseline?.container.processes ?? null,
    finalContainerProcesses: final?.container.processes ?? null,
    finalContainerSshHelpers: final ? sshHelpers(final) : null,
    finalContainerProcessDelta:
      baseline && final
        ? final.container.processes - baseline.container.processes
        : null,
    finalContainerNonHelperProcessDelta:
      baseline && final
        ? nonHelperProcesses(final) - nonHelperProcesses(baseline)
        : null,
    finalContainerZombies: final?.container.zombieProcesses ?? null,
    finalContainerPpid1Processes: final?.container.ppid1Processes ?? null,
    finalContainerPpid1Zombies: final?.container.ppid1ZombieProcesses ?? null,
    finalContainerStateCounts: final
      ? stateCounts(final.container.stateCounts)
      : null,
    maxLoad1: max((sample) => sample.host.load1),
    minMemoryAvailableMb:
      min((sample) => sample.host.memoryAvailableKb) / KB_PER_MB,
    maxLocalDiskMb:
      localDiskSamples.length === 0
        ? null
        : max((sample) => sample.localDiskKb, localDiskSamples) / KB_PER_MB,
  };

  if (final?.container.zombieProcesses > 0) {
    failures.push(
      `API container retained ${final.container.zombieProcesses} zombie processes after final quiescence (${final.container.ppid1ZombieProcesses} parented to PID 1)`,
    );
  }
  if (
    baseline &&
    final &&
    nonHelperProcesses(final) > nonHelperProcesses(baseline)
  ) {
    failures.push(
      `API container retained ${nonHelperProcesses(final) - nonHelperProcesses(baseline)} extra processes after final quiescence, excluding SSH helpers (baseline=${nonHelperProcesses(baseline)}, final=${nonHelperProcesses(final)})`,
    );
  }
  if (final && sshHelpers(final) > 1) {
    failures.push(
      `API container retained ${sshHelpers(final)} SSH helpers after final quiescence (maximum=1)`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    stats,
  };
}

export function areHostSamplesQuiescent(rows) {
  const samples = validHostSamples(rows);
  const baseline = samples[0];
  const final = rows.at(-1);
  return Boolean(
    baseline &&
      final &&
      validHostSample(final) &&
      final.container.zombieProcesses === 0 &&
      sshHelpers(final) <= 1 &&
      nonHelperProcesses(final) <= nonHelperProcesses(baseline),
  );
}

function formatStateCounts(counts) {
  if (!counts || Object.keys(counts).length === 0) return 'none';
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}:${count}`)
    .join(',');
}

export function formatHostSummary(report) {
  const stats = report.stats;
  const machines = stats.maxMachines ?? 'n/a';
  const runningMachines = stats.maxRunningMachines ?? 'n/a';
  const localDisk =
    stats.maxLocalDiskMb == null
      ? 'n/a'
      : `${stats.maxLocalDiskMb.toFixed(1)}MB`;
  return (
    `host: samples=${stats.samples} machines=${machines} ` +
    `running=${runningMachines} ` +
    `container-processes=${stats.maxContainerProcesses} ` +
    `container-fds=${stats.maxContainerFds} ` +
    `container-socket-fds=${stats.maxContainerSocketFds} ` +
    `max-container-process-fds=${stats.maxContainerProcessFds} ` +
    `zombies=${stats.maxContainerZombies}/${stats.finalContainerZombies} ` +
    `ppid1-zombies=${stats.maxContainerPpid1Zombies}/${stats.finalContainerPpid1Zombies} ` +
    `processes-final=${stats.finalContainerProcesses} ` +
    `process-delta=${stats.finalContainerProcessDelta} ` +
    `ssh-helpers=${stats.maxContainerSshHelpers}/${stats.finalContainerSshHelpers} ` +
    `non-helper-process-delta=${stats.finalContainerNonHelperProcessDelta} ` +
    `states-max=${formatStateCounts(stats.maxContainerStateCounts)} ` +
    `states-final=${formatStateCounts(stats.finalContainerStateCounts)} ` +
    `load1=${stats.maxLoad1.toFixed(2)} min-available=${stats.minMemoryAvailableMb.toFixed(1)}MB ` +
    `local-disk=${localDisk}`
  );
}

const CONTAINER_PROBE = String.raw`
const fs = require('node:fs');

function read(path, fallback = '') {
  try { return fs.readFileSync(path, 'utf8'); } catch { return fallback; }
}

let containerProcesses = 0;
let containerSshHelpers = 0;
let containerFds = 0;
let containerSocketFds = 0;
let maxContainerProcessFds = 0;
let containerZombieProcesses = 0;
let containerPpid1Processes = 0;
let containerPpid1ZombieProcesses = 0;
const containerStateCounts = {};
for (const name of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(name)) continue;
  const root = '/proc/' + name;
  const status = read(root + '/status');
  if (!status) continue;
  containerProcesses += 1;
  // The helper starts lazily on the first SSH operation and stays available
  // through API shutdown. Identify it explicitly, not by allowing an arbitrary
  // extra process that could hide a leaked SSH client or master.
  const argv = read(root + '/cmdline').split('\0');
  if (
    /^Name:\s+node$/m.test(status) &&
    argv.some(argument => argument.endsWith('/ssh-process-helper.js'))
  ) containerSshHelpers += 1;
  const state = status.match(/^State:\s+([A-Za-z?])/m)?.[1] ?? '?';
  const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? -1);
  containerStateCounts[state] = (containerStateCounts[state] ?? 0) + 1;
  if (state === 'Z') containerZombieProcesses += 1;
  if (ppid === 1) {
    containerPpid1Processes += 1;
    if (state === 'Z') containerPpid1ZombieProcesses += 1;
  }
  let fdCount = 0;
  try {
    const fds = fs.readdirSync(root + '/fd');
    fdCount = fds.length;
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(root + '/fd/' + fd).startsWith('socket:[')) {
          containerSocketFds += 1;
        }
      } catch {}
    }
  } catch {}
  containerFds += fdCount;
  maxContainerProcessFds = Math.max(maxContainerProcessFds, fdCount);
}

process.stdout.write(JSON.stringify({
  container: {
    processes: containerProcesses,
    sshHelperProcesses: containerSshHelpers,
    fdCount: containerFds,
    socketFds: containerSocketFds,
    maxProcessFds: maxContainerProcessFds,
    stateCounts: containerStateCounts,
    zombieProcesses: containerZombieProcesses,
    ppid1Processes: containerPpid1Processes,
    ppid1ZombieProcesses: containerPpid1ZombieProcesses,
  },
}));
`;

function run(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '')
      .trim()
      .slice(-500);
    die(`${label} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout ?? '');
}

function probeContainer(container) {
  const output = run(
    'docker',
    [
      'exec',
      container,
      'node',
      '--input-type=commonjs',
      '--eval',
      CONTAINER_PROBE,
    ],
    'API container metrics probe',
  );
  try {
    return JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(`API container metrics probe returned malformed JSON: ${detail}`);
  }
}

function probeMachines(url) {
  const output = run(
    'curl',
    ['-fsS', '--max-time', '3', url],
    'smolvm machine probe',
  );
  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(`smolvm machine probe returned malformed JSON: ${detail}`);
  }
  const machines = Array.isArray(payload) ? payload : (payload.machines ?? []);
  const stateOf = (machine) =>
    String(machine.state ?? machine.status ?? '').toLowerCase();
  const isRunning = (machine) =>
    ['running', 'started'].includes(stateOf(machine));
  return {
    total: machines.length,
    running: machines.filter(isRunning).length,
    notRunning: machines
      .filter((machine) => !isRunning(machine))
      .map((machine) => ({ name: machine.name, state: stateOf(machine) })),
  };
}

function probeHost() {
  const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(/\s+/)[0]);
  const memory = readFileSync('/proc/meminfo', 'utf8');
  const available = memory.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!Number.isFinite(load1) || !available) {
    die('Linux host pressure files returned an unexpected shape');
  }
  return { load1, memoryAvailableKb: Number(available[1]) };
}

function probeLocalDisk(directories) {
  const result = spawnSync('du', ['-skc', ...directories], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  // The last line is the total.
  const value = Number(
    String(result.stdout).trim().split('\n').at(-1)?.split(/\s+/)[0],
  );
  return Number.isFinite(value) ? value : null;
}

// smolvm deletes a machine's directory, console log included, with the
// machine, and recovery deletes a stopped one within a monitor cycle. Save
// each state a stopped machine reaches, with its console tail, once.
const CONSOLE_TAIL_BYTES = 64 * 1024;

function smolvmConsoleLog(name) {
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return join(cacheRoot, 'smolvm', 'vms', hash, 'agent-console.log');
}

export function captureStoppedMachines(notRunning, directory) {
  for (const { name, state } of notRunning) {
    if (state === 'created' || !/^[\w.-]+$/.test(String(name))) continue;
    const file = join(directory, `${name}.${state}.log`);
    if (existsSync(file)) continue;
    let tail;
    try {
      tail = readFileSync(smolvmConsoleLog(name)).subarray(-CONSOLE_TAIL_BYTES);
    } catch (error) {
      tail = `console log unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      file,
      `${new Date().toISOString()} state=${state}\n--- agent-console.log tail ---\n${tail}\n`,
    );
  }
}

export function sampleHost(options = {}) {
  const provider = options.provider ?? process.env.NUKE_PROVIDER ?? 'azure';
  const isLocal = provider === 'local';
  const container =
    options.container ?? process.env.NUKE_API_CONTAINER ?? 'anycloud-api';
  const machineUrl =
    options.machineUrl ??
    process.env.NUKE_SMOLVM_MACHINES_URL ??
    'http://127.0.0.1:18089/api/v1/machines';
  const localDirectory =
    options.localDirectory ??
    process.env.NUKE_LOCAL_RUNTIME_DIR ??
    '/var/lib/anycloud-test/local';
  const containerSample = probeContainer(container);
  const machines = isLocal ? probeMachines(machineUrl) : null;
  const captureDirectory = process.env.NUKE_SMOLVM_CAPTURE_DIR;
  if (machines && captureDirectory) {
    try {
      captureStoppedMachines(machines.notRunning, captureDirectory);
    } catch {
      // Diagnostics only; a failed capture must not drop the sample.
    }
  }
  return {
    timestampMs: Date.now(),
    provider,
    elapsedSec: Number(
      options.elapsedSec ?? process.env.NUKE_HOST_ELAPSED_SEC ?? 0,
    ),
    host: probeHost(),
    machines,
    container: {
      processes: finite(containerSample.container?.processes),
      sshHelperProcesses: finite(containerSample.container?.sshHelperProcesses),
      fdCount: finite(containerSample.container?.fdCount),
      socketFds: finite(containerSample.container?.socketFds),
      maxProcessFds: finite(containerSample.container?.maxProcessFds),
      stateCounts: stateCounts(containerSample.container?.stateCounts) ?? {},
      zombieProcesses: finite(containerSample.container?.zombieProcesses),
      ppid1Processes: finite(containerSample.container?.ppid1Processes),
      ppid1ZombieProcesses: finite(
        containerSample.container?.ppid1ZombieProcesses,
      ),
    },
    localDiskKb: isLocal
      ? probeLocalDisk(
          // CI moves the bucket root out of the runtime directory.
          [localDirectory, process.env.ANYCLOUD_TEST_LOCAL_BUCKET_ROOT].filter(
            Boolean,
          ),
        )
      : null,
  };
}

function runSampleCli() {
  try {
    console.log(JSON.stringify(sampleHost()));
  } catch (error) {
    console.log(
      JSON.stringify({
        timestampMs: Date.now(),
        provider: process.env.NUKE_PROVIDER ?? 'azure',
        elapsedSec: Number(process.env.NUKE_HOST_ELAPSED_SEC ?? 0),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

function runReportCli() {
  const file = process.env.NUKE_HOST_FILE;
  if (!file) die('NUKE_HOST_FILE must be set');
  const report = analyzeHostSamples(
    parseHostRows(readFileSync(file, 'utf8'), file),
  );
  const reportFile = process.env.NUKE_HOST_REPORT_FILE;
  if (reportFile) {
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
  console.log(formatHostSummary(report));
  if (!report.ok) {
    for (const failure of report.failures) {
      console.error(`host metrics failed: ${failure}`);
    }
    process.exitCode = 1;
  }
}

function runQuiescentCli() {
  const file = process.env.NUKE_HOST_FILE;
  if (!file) die('NUKE_HOST_FILE must be set');
  const rows = parseHostRows(readFileSync(file, 'utf8'), file);
  if (!areHostSamplesQuiescent(rows)) process.exitCode = 1;
}

export function analyzeNukeResponsiveness(samples, pressure, requirePressure) {
  const health = summarizeHealth(samples, 6000);
  const failures = [];
  if (health.offered < 250)
    failures.push('Insufficient independent HTTP probes');
  if (health.responsive !== true)
    failures.push('HTTP errors or six-second timeouts');
  if (health.p99Ms === null || health.p99Ms >= 1000) {
    failures.push(`HTTP p99 ${health.p99Ms}ms exceeded one second`);
  }
  if (requirePressure) {
    if (!pressure)
      failures.push('Missing resident-memory/SSH pressure evidence');
    else {
      if (!(pressure.minRssBytes >= 2048 * 1024 ** 2))
        failures.push('API RSS below 2 GiB');
      if (!(pressure.durationMs >= 30_000))
        failures.push('SSH pressure lasted less than 30 seconds');
      if (
        !(
          pressure.offered >= 720 &&
          pressure.launched / (pressure.durationMs / 1000) >= 23
        )
      ) {
        failures.push('Incident SSH launch rate was not sustained');
      }
      if (
        pressure.state !== 'stopped' ||
        pressure.pending !== 0 ||
        pressure.failures !== 0 ||
        pressure.offered !== pressure.launched ||
        pressure.launched !== pressure.completed
      ) {
        failures.push('SSH pressure commands failed or did not drain');
      }
    }
  }
  return { ok: failures.length === 0, failures, health, pressure };
}

async function waitForPressure(directory, state) {
  const file = `${directory}/nuke-ssh-pressure.json`;
  const deadline = Date.now() + 15_000;
  do {
    if (existsSync(file)) {
      const pressure = JSON.parse(readFileSync(file, 'utf8'));
      if (pressure.state === state) return pressure;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`API SSH pressure did not reach ${state}`);
}

// Keep HTTP measurement in its own process: host inspection uses spawnSync.
async function runHealthCli() {
  const directory = process.env.RESULTS_DIR;
  if (!directory || !process.env.API_URL)
    die('RESULTS_DIR and API_URL must be set');
  const requirePressure = process.env.NUKE_PROVIDER === 'local';
  let finish;
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  process.once('SIGTERM', finish);
  process.once('SIGINT', finish);
  const sampler = startHealthSampler(`${process.env.API_URL}/health`, {
    timeoutMs: 6000,
  });
  let pressure;
  let failure;
  try {
    if (requirePressure) {
      await waitForPressure(directory, 'ready');
      writeFileSync(`${directory}/nuke-ssh-start`, '');
      await waitForPressure(directory, 'running');
    }
    sampler.setPhase('work');
    writeFileSync(`${directory}/nuke-health-ready`, '');
    await stopped;
  } catch (error) {
    failure = error.message;
  } finally {
    // Stop offers, then drain requests while the real API is still alive.
    const health = sampler.stop();
    if (requirePressure) {
      writeFileSync(`${directory}/nuke-ssh-stop`, '');
      try {
        pressure = await waitForPressure(directory, 'stopped');
      } catch (error) {
        failure ??= error.message;
      }
    }
    const samples = await health;
    writeFileSync(
      `${directory}/nuke-health.json`,
      JSON.stringify(samples) + '\n',
    );
    const report = analyzeNukeResponsiveness(
      samples,
      pressure,
      requirePressure,
    );
    if (failure) {
      report.ok = false;
      report.failures.push(failure);
    }
    writeFileSync(
      `${directory}/nuke-health-report.json`,
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
    process.exitCode = report.ok ? 0 : 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] === 'sample') runSampleCli();
    else if (process.argv[2] === 'report') runReportCli();
    else if (process.argv[2] === 'quiescent') runQuiescentCli();
    else if (process.argv[2] === 'health') await runHealthCli();
    else die('Usage: nuke-host-metrics.mjs sample|report|quiescent|health');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
