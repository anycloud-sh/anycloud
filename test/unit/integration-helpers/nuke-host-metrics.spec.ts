import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  analyzeHostSamples,
  captureStoppedMachines,
  analyzeNukeResponsiveness,
  areHostSamplesQuiescent,
  formatHostSummary,
  parseHostRows,
} from '../../integration/helpers/nuke-host-metrics.mjs';

function sample(elapsedSec: number, overrides: Record<string, unknown> = {}) {
  return {
    elapsedSec,
    host: { load1: 1.5, memoryAvailableKb: 1_000_000 },
    machines: { total: 2, running: 2 },
    container: {
      processes: 6,
      fdCount: 80,
      socketFds: 12,
      maxProcessFds: 30,
      stateCounts: { R: 1, S: 5 },
      zombieProcesses: 0,
      ppid1Processes: 1,
      ppid1ZombieProcesses: 0,
    },
    ...overrides,
  };
}

describe('nuke runner host metrics', () => {
  const pressure = {
    state: 'stopped',
    minRssBytes: 2048 * 1024 ** 2,
    durationMs: 60_000,
    offered: 1440,
    launched: 1440,
    completed: 1440,
    failures: 0,
    pending: 0,
  };
  const health = Array.from({ length: 300 }, () => ({
    phase: 'work',
    ok: true,
    elapsedMs: 8,
    offerDelayMs: 0,
  }));

  it('requires responsive HTTP and sustained incident pressure together', () => {
    const report = analyzeNukeResponsiveness(health, pressure, true);
    expect(report.ok).toBe(true);
    expect(report.health).toMatchObject({ p99Ms: 8, deadlineMisses: 0 });
    expect(
      analyzeNukeResponsiveness(health, undefined, true).failures,
    ).toContain('Missing resident-memory/SSH pressure evidence');
    expect(analyzeNukeResponsiveness(health, undefined, false).ok).toBe(true);
  });

  it.each([
    [{ minRssBytes: 540 * 1024 ** 2 }, 'API RSS below 2 GiB'],
    [{ durationMs: 20_000 }, 'SSH pressure lasted less than 30 seconds'],
    [{ durationMs: 120_000 }, 'Incident SSH launch rate was not sustained'],
    [{ completed: 1439 }, 'SSH pressure commands failed or did not drain'],
    [{ state: 'running' }, 'SSH pressure commands failed or did not drain'],
    [{ failures: 1 }, 'SSH pressure commands failed or did not drain'],
    [{ pending: 1 }, 'SSH pressure commands failed or did not drain'],
  ])('rejects incomplete incident coverage: %j', (change, message) => {
    const report = analyzeNukeResponsiveness(
      health,
      { ...pressure, ...change },
      true,
    );
    expect(report.ok).toBe(false);
    expect(report.failures).toContain(message);
  });

  it('rejects a slow HTTP tail and even a single six-second timeout', () => {
    const tail = health.map((sample, index) => ({
      ...sample,
      elapsedMs: index < 10 ? 2000 : 8,
    }));
    expect(analyzeNukeResponsiveness(tail, pressure, true).failures).toContain(
      'HTTP p99 2000ms exceeded one second',
    );
    const timeout = [
      ...health,
      {
        phase: 'work',
        ok: false,
        elapsedMs: 6001,
        offerDelayMs: 0,
        error: 'timeout',
      },
    ];
    const report = analyzeNukeResponsiveness(timeout, pressure, true);
    expect(report.health.p99Ms).toBe(8);
    expect(report.failures).toContain('HTTP errors or six-second timeouts');
    expect(analyzeNukeResponsiveness([], pressure, true).ok).toBe(false);
  });

  it('reports peak container, socket, machine, and host pressure', () => {
    const report = analyzeHostSamples([
      sample(0),
      { elapsedSec: 10, error: 'transient docker inspection failure' },
      sample(20, {
        host: { load1: 7.25, memoryAvailableKb: 700_000 },
        machines: { total: 100, running: 80 },
        container: {
          processes: 184,
          fdCount: 2_520,
          socketFds: 350,
          maxProcessFds: 70,
          stateCounts: { R: 4, S: 177, Z: 3 },
          zombieProcesses: 3,
          ppid1Processes: 5,
          ppid1ZombieProcesses: 3,
        },
      }),
      sample(30),
    ]);

    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.stats).toMatchObject({
      samples: 3,
      errors: 1,
      maxMachines: 100,
      maxRunningMachines: 80,
      maxContainerProcesses: 184,
      maxContainerFds: 2_520,
      maxContainerSocketFds: 350,
      maxContainerProcessFds: 70,
      maxContainerZombies: 3,
      maxContainerPpid1Processes: 5,
      maxContainerPpid1Zombies: 3,
      maxContainerStateCounts: { R: 4, S: 177, Z: 3 },
      finalContainerProcesses: 6,
      finalContainerZombies: 0,
      finalContainerPpid1Zombies: 0,
      finalContainerStateCounts: { R: 1, S: 5 },
      maxLoad1: 7.25,
      minMemoryAvailableMb: 700_000 / 1024,
    });
    expect(formatHostSummary(report)).toContain('container-processes=184');
    expect(formatHostSummary(report)).toContain('container-fds=2520');
    expect(formatHostSummary(report)).toContain('zombies=3/0');
    expect(formatHostSummary(report)).toContain('ppid1-zombies=3/0');
  });

  it('fails when the final sample still contains unreaped children', () => {
    const report = analyzeHostSamples([
      sample(0),
      sample(20, {
        container: {
          processes: 9,
          fdCount: 40,
          socketFds: 1,
          maxProcessFds: 20,
          stateCounts: { R: 1, S: 5, Z: 3 },
          zombieProcesses: 3,
          ppid1Processes: 4,
          ppid1ZombieProcesses: 3,
        },
      }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.failures).toContain(
      'API container retained 3 zombie processes after final quiescence (3 parented to PID 1)',
    );
    expect(areHostSamplesQuiescent([sample(0), sample(20)])).toBe(true);
    expect(
      areHostSamplesQuiescent([
        sample(0),
        sample(20, {
          container: {
            processes: 7,
            fdCount: 40,
            socketFds: 1,
            maxProcessFds: 20,
            stateCounts: { R: 1, S: 6 },
            zombieProcesses: 0,
            ppid1Processes: 2,
            ppid1ZombieProcesses: 0,
          },
        }),
      ]),
    ).toBe(false);
  });

  it('accepts cloud samples without Local machine or disk metrics', () => {
    const report = analyzeHostSamples([
      sample(0, {
        provider: 'azure',
        machines: null,
        localDiskKb: null,
      }),
    ]);

    expect(report.ok).toBe(true);
    expect(report.stats).toMatchObject({
      maxMachines: null,
      maxRunningMachines: null,
      maxLocalDiskMb: null,
      maxContainerProcesses: 6,
    });
    expect(formatHostSummary(report)).toContain('machines=n/a');
    expect(formatHostSummary(report)).toContain('local-disk=n/a');
  });

  it('accepts one persistent helper created after the baseline sample', () => {
    const baseline = sample(0);
    const final = sample(20, {
      container: {
        ...baseline.container,
        processes: 7,
        sshHelperProcesses: 1,
        stateCounts: { R: 1, S: 6 },
      },
    });
    const report = analyzeHostSamples([baseline, final]);
    expect(report.ok).toBe(true);
    expect(areHostSamplesQuiescent([baseline, final])).toBe(true);
    expect(report.stats).toMatchObject({
      maxContainerSshHelpers: 1,
      finalContainerSshHelpers: 1,
      finalContainerProcessDelta: 1,
      finalContainerNonHelperProcessDelta: 0,
    });
    expect(formatHostSummary(report)).toContain('ssh-helpers=1/1');
  });

  it.each([
    { processes: 7, sshHelperProcesses: 0 },
    { processes: 8, sshHelperProcesses: 1 },
    { processes: 8, sshHelperProcesses: 2 },
  ])('rejects leaked processes with $sshHelperProcesses helpers', (counts) => {
    const baseline = sample(0);
    const final = sample(20, {
      container: {
        ...baseline.container,
        ...counts,
        stateCounts: { R: 1, S: counts.processes - 1 },
      },
    });
    const report = analyzeHostSamples([baseline, final]);
    expect(report.ok).toBe(false);
    expect(report.failures.join(' ')).toContain(
      counts.sshHelperProcesses > 1 ? 'SSH helpers' : 'extra processes',
    );
    expect(areHostSamplesQuiescent([baseline, final])).toBe(false);
  });

  it('fails when no valid host sample was captured', () => {
    const report = analyzeHostSamples([
      { elapsedSec: 0, error: 'container unavailable' },
    ]);

    expect(report.ok).toBe(false);
    expect(report.failures).toContain('No valid runner host samples');
  });

  it('identifies malformed NDJSON by line', () => {
    expect(() =>
      parseHostRows('{"elapsedSec":0}\nnope\n', 'host.ndjson'),
    ).toThrow(/host\.ndjson:2/);
  });

  it('captures each stopped state and its console tail once', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuke-capture-'));
    const vmDir = createHash('sha256').update('ac-local-a').digest('hex');
    const consoleDir = join(root, 'smolvm', 'vms', vmDir.slice(0, 16));
    mkdirSync(consoleDir, { recursive: true });
    writeFileSync(join(consoleDir, 'agent-console.log'), 'kernel panic\n');
    vi.stubEnv('XDG_CACHE_HOME', root);
    const out = join(root, 'out');
    const seen = (aState: string) => [
      { name: 'ac-local-a', state: aState },
      { name: 'ac-local-b', state: 'failed' },
      { name: 'ac-local-c', state: 'created' },
    ];

    captureStoppedMachines(seen('unreachable'), out);
    writeFileSync(join(consoleDir, 'agent-console.log'), 'later\n');
    captureStoppedMachines(seen('unreachable'), out);
    captureStoppedMachines(seen('stopped'), out);
    vi.unstubAllEnvs();

    expect(readdirSync(out).sort()).toEqual([
      'ac-local-a.stopped.log',
      'ac-local-a.unreachable.log',
      'ac-local-b.failed.log',
    ]);
    const read = (file: string) => readFileSync(join(out, file), 'utf8');
    expect(read('ac-local-a.unreachable.log')).toMatch(
      /state=unreachable\n[^]*kernel panic/,
    );
    expect(read('ac-local-a.stopped.log')).toContain('later');
    expect(read('ac-local-b.failed.log')).toContain('console log unavailable');
  });
});
