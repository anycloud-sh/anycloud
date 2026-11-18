// Run with: yarn tsx benchmarks/process-runners.ts
// Each case gets a fresh process so peak RSS and pending shutdown handles stay visible.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execAsync } from '../src/cli/services/slurp/cli-exec.js';
import {
  ArtifactStore,
  Redactor,
} from '../test/integration/e2e/internal/artifacts.js';
import { ManagedProcess } from '../test/integration/e2e/internal/managed-process.js';
import { ProcessRunner } from '../test/integration/e2e/internal/process.js';

const cases = [
  'quiet',
  'captured-cli',
  'output-16mib',
  'deadline',
  'cancellation',
  'managed-stop',
];
const scenario = process.argv[2];
const samples = 20;
const warmups = 3;
const outputBytes = 16 * 1024 * 1024;

if (scenario === undefined) {
  const results = cases.map((name) => {
    const started = performance.now();
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), name],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return {
      ...JSON.parse(child.stdout),
      processWallMs: performance.now() - started,
    };
  });
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        results,
      },
      null,
      2,
    ),
  );
} else {
  assert(cases.includes(scenario), `Unknown case: ${scenario}`);
  const startupMs = performance.now();
  const directory = await mkdtemp(
    path.join(tmpdir(), 'process-runners-bench-'),
  );
  const artifacts = new ArtifactStore(directory, new Redactor());
  const managed = new ManagedProcess(artifacts);
  const readyPath = path.join(directory, 'ready.json');
  const durations: number[] = [];
  try {
    for (let index = -warmups; index < samples; index += 1) {
      const cancellation = new AbortController();
      const runner = new ProcessRunner(
        artifacts,
        cancellation.signal,
        directory,
      );
      let started = performance.now();
      if (scenario === 'managed-stop') {
        await managed.start({
          executable: process.execPath,
          args: [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], "{}"); setInterval(() => {}, 1000)',
            readyPath,
          ],
          cwd: directory,
          label: 'managed',
          readyPath,
          readyTimeoutMs: 5_000,
          parseReady: (_value, pid) => pid,
        });
        started = performance.now();
        await managed.stop();
      } else if (scenario === 'captured-cli') {
        const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
        assert.equal(
          await execAsync(`${executable} -e 'process.stdout.write("ok\\n")'`),
          'ok\n',
        );
      } else {
        const abort =
          scenario === 'cancellation'
            ? setTimeout(() => cancellation.abort(), 100)
            : undefined;
        const result = await runner.run(
          process.execPath,
          [
            '-e',
            scenario === 'output-16mib'
              ? `process.stdout.write(Buffer.alloc(${outputBytes}, 120))`
              : scenario === 'deadline' || scenario === 'cancellation'
                ? 'setInterval(() => {}, 1000)'
                : '',
          ],
          {
            timeoutMs: scenario === 'deadline' ? 100 : 30_000,
            recordArtifact: false,
          },
        );
        clearTimeout(abort);
        assert.equal(result.timedOut, scenario === 'deadline');
        assert.equal(result.aborted, scenario === 'cancellation');
        if (scenario !== 'deadline' && scenario !== 'cancellation') {
          assert.equal(result.exitCode, 0);
        }
        if (scenario === 'output-16mib') {
          assert.equal(result.stdout.length, 4 * 1024 * 1024);
          assert.equal(result.outputTruncated, true);
        }
      }
      if (index >= 0) durations.push(performance.now() - started);
      await rm(readyPath, { force: true });
    }
    durations.sort((left, right) => left - right);
    const medianMs = (durations[samples / 2 - 1] + durations[samples / 2]) / 2;
    console.log(
      JSON.stringify({
        scenario,
        samples,
        warmups,
        startupMs,
        medianMs,
        p95Ms: durations[Math.ceil(samples * 0.95) - 1],
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
        ...(scenario === 'output-16mib'
          ? { throughputMiBPerSecond: 16_000 / medianMs }
          : {}),
      }),
    );
  } finally {
    await managed.stop();
    await rm(directory, { force: true, recursive: true });
  }
}
