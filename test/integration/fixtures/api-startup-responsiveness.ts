import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const helperPath = '/fixture/api-responsiveness/run-child.mjs';
const { runChild } = (await import(helperPath)) as {
  runChild: (options: Readonly<Record<string, unknown>>) => Promise<unknown>;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  assert.ok(
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
    'SSH measurement was not a nonnegative finite number',
  );
  return value;
}

const measurements: {
  residentMiB: number;
  launchRate: number;
  result: Record<string, unknown>;
}[] = [];
for (const [residentMiB, launchRate] of [
  [2048, 24],
  [4096, 24],
  [2048, 48],
] as const) {
  const runDir = `/tmp/ssh-responsiveness-${residentMiB}-${launchRate}`;
  const result = record(
    await runChild({
      buildDir: '/app',
      action: 'measure',
      scenario: 'ssh',
      sshResidentMiB: residentMiB,
      sshLaunchRate: launchRate,
      runDir,
      registerEntry: null,
      healthTimeoutMs: 6000,
      timeoutMs: 90_000,
    }).catch((error: unknown) => {
      const childLog = `${runDir}/child.log`;
      if (existsSync(childLog)) console.error(readFileSync(childLog, 'utf8'));
      throw error;
    }),
  );
  console.log(JSON.stringify(result));
  measurements.push({ residentMiB, launchRate, result });
}

for (const { residentMiB, launchRate, result } of measurements) {
  const offered = number(result.offered);
  const launched = number(result.launched);
  const rejected = number(result.rejected);
  const cancelled = number(result.cancelled);
  const completed = number(result.completed);
  const failures = number(result.failures);
  assert.equal(offered, launchRate * 30, 'SSH workload was not fully offered');
  assert.equal(
    offered,
    launched + rejected + cancelled,
    'SSH offers were lost',
  );
  assert.equal(completed, launched, 'SSH clients did not drain');
  assert.equal(failures, rejected + cancelled, 'Started SSH clients failed');
  assert.equal(number(result.finalPending), 0, 'SSH launches remained queued');
  assert.deepEqual(
    result.processes,
    { clients: 0, helpers: 1, zombies: 0 },
    'SSH process leak',
  );
  assert.ok(
    number(record(result.health).offered) >= 250,
    'Insufficient independent health probes',
  );
  assert.equal(
    record(result.healthCoarse).responsive,
    true,
    'SSH spawning caused HTTP errors or six-second timeouts',
  );
  assert.ok(
    number(record(result.health).p99Ms) < 1000,
    'HTTP p99 exceeded one second',
  );
  if (residentMiB === 2048 && launchRate === 24) {
    assert.equal(failures, 0, 'Incident workload exceeded SSH capacity');
    assert.ok(
      number(result.launchesPerSecond) >= 23,
      'Incident launch rate was not sustained',
    );
    assert.ok(
      number(result.startWaitP99Ms) < 2000,
      'SSH start wait p99 exceeded two seconds',
    );
  } else {
    console.log(
      JSON.stringify({
        event: 'ssh-capacity',
        residentMiB,
        launchRate,
        allCompleted: completed === offered,
        startWaitP99Ms: number(result.startWaitP99Ms),
        rejected,
        containerCpuMs: number(result.containerCpuMs),
      }),
    );
  }
}
