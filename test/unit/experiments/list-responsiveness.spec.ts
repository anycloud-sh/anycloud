import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arrivalDisposition,
  deadlineMiss,
  summarizeRequests,
} from '../../helpers/list-responsiveness/accounting.mjs';
import {
  startHealthSampler,
  summarizeHealth,
} from '../../helpers/list-responsiveness/shared/metrics.mjs';

describe('list responsiveness accounting and isolation', () => {
  it('counts a late success as a deadline miss independently of abort callbacks', () => {
    expect(deadlineMiss({ outcome: 'success', elapsedMs: 1001 }, 1000)).toBe(
      true,
    );
    expect(
      summarizeHealth([
        { phase: 'work', ok: true, elapsedMs: 1001, offerDelayMs: 0 },
      ]),
    ).toMatchObject({
      offered: 1,
      completed: 1,
      deadlineMisses: 1,
      responsive: false,
    });
    expect(summarizeHealth([]).responsive).toBeNull();
  });

  it('reports scheduling/admission losses and unfinished work separately from completions', () => {
    expect(
      arrivalDisposition({
        now: 120,
        due: 0,
        maximumLagMs: 100,
        inFlight: 0,
        maximumInFlight: 128,
      }),
    ).toBe('scheduling-skipped');
    expect(
      arrivalDisposition({
        now: 10,
        due: 0,
        maximumLagMs: 100,
        inFlight: 128,
        maximumInFlight: 128,
      }),
    ).toBe('admission-skipped');
    expect(
      arrivalDisposition({
        now: 10,
        due: 0,
        maximumLagMs: 100,
        inFlight: 127,
        maximumInFlight: 128,
      }),
    ).toBe('admitted');
    const records = [
      'success',
      'timeout',
      'unfinished',
      'scheduling-skipped',
      'admission-skipped',
    ].map((outcome) => ({ outcome, elapsedMs: 1, offerDelayMs: 0, bytes: 1 }));
    expect(summarizeRequests(records, 1000)).toMatchObject({
      offered: 5,
      admitted: 3,
      completed: 1,
      timedOut: 1,
      unfinished: 1,
      schedulingSkipped: 1,
      admissionSkipped: 1,
    });
  });

  it('drains already-offered health requests before the caller closes the API', async () => {
    const server = createServer((_request, response) =>
      setTimeout(() => response.end('ok'), 25),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    const sampler = startHealthSampler(
      `http://127.0.0.1:${address.port}/health`,
      { intervalMs: 1000 },
    );
    try {
      const samples = await sampler.stop();
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({ ok: true });
      expect(samples[0].elapsedMs).toBeGreaterThanOrEqual(20);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retains completed and unfinished requests when the HTTP driver is killed', async () => {
    const runDir = mkdtempSync(path.join(tmpdir(), 'list-driver-'));
    let received = 0;
    let reachedStall!: () => void;
    const stalled = new Promise<void>((resolve) => {
      reachedStall = resolve;
    });
    const server = createServer((_request, response) => {
      if (++received === 3) reachedStall();
      else response.end('[]');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    const driver = fork(
      fileURLToPath(
        new URL(
          '../../helpers/list-responsiveness/http-driver.mjs',
          import.meta.url,
        ),
      ),
      [
        JSON.stringify({
          port: address.port,
          runDir,
          mode: 'matrix',
          scope: 'user',
          samples: 1,
          warmups: 0,
          version: '0.0.0',
        }),
      ],
      {
        execArgv: [],
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      },
    );
    const closed = once(driver, 'close');
    const watchdog = setTimeout(() => driver.kill('SIGKILL'), 10000);
    try {
      await Promise.race([
        stalled,
        closed.then(() => {
          throw new Error('Driver exited before the stalled request');
        }),
      ]);
      driver.kill('SIGKILL');
      expect(await closed).toEqual([null, 'SIGKILL']);
      const latest = new Map(
        readFileSync(path.join(runDir, 'request-journal.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const record = JSON.parse(line);
            return [record.id, record] as const;
          }),
      );
      expect(summarizeRequests([...latest.values()], 15000)).toMatchObject({
        offered: 3,
        admitted: 3,
        completed: 2,
        unfinished: 1,
        timedOut: 0,
      });
      expect(existsSync(path.join(runDir, 'requests.jsonl'))).toBe(false);
    } finally {
      clearTimeout(watchdog);
      driver.kill('SIGKILL');
      await closed.catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('retains caught network, provider and subprocess violations as experiment failures', () => {
    const guardUrl = new URL(
      '../../helpers/list-responsiveness/guard.mjs',
      import.meta.url,
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      const { installGuard } = await import(${JSON.stringify(guardUrl)});
      const guard = installGuard();
      class SyntheticProvider { compute() { return 'must never run'; } }
      guard.rejectProviderOperations([SyntheticProvider]);
      try { fetch('https://example.invalid'); } catch {}
      try { childProcess.spawn('never-run'); } catch {}
      try { new SyntheticProvider().compute(); } catch {}
      assert.equal(guard.violations.length, 3);
      assert.throws(() => guard.assertClean());
      process.stdout.write('guard caught');
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        encoding: 'utf8',
      },
    );
    expect(output).toBe('guard caught');
  });
});
