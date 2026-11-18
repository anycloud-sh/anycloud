import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import { JobMaceTransport } from '../integration/e2e/internal/transports/job-mace.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import { jobMemberProfile } from '../integration/e2e/internal/contracts/job-policy.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import { commandResultForTest } from './helpers/e2e.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'job-mace-'));
  const foreground = new AbortController();
  const cleanup = new CleanupStack();
  const events: string[] = [];
  cleanup.defer('original-workload', async () => {
    events.push('workload-cleanup');
  });
  const redactor = new Redactor();
  const token = 'original-mace-token';
  redactor.add(token);
  const artifacts = new ArtifactStore(
    path.join(directory, 'artifacts'),
    redactor,
  );
  await artifacts.initialize({
    testName: 'mace-unit',
    runId: 'mace-unit',
    startedAt: new Date().toISOString(),
  });
  const records: Array<{ label: string; value: unknown }> = [];
  const record = artifacts.json.bind(artifacts);
  vi.spyOn(artifacts, 'json').mockImplementation(async (label, value) => {
    records.push({ label, value });
    return record(label, value);
  });
  const state = { marker: false, reject: false, changedController: false };
  const requests: Array<{ url: string; authorization: string | undefined }> =
    [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url!,
      authorization: request.headers.authorization,
    });
    if (state.reject) {
      response.writeHead(401);
      response.end('denied');
      return;
    }
    if (request.url?.includes('/logs')) {
      if (!state.marker) {
        response.writeHead(404);
        response.end('not created');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const line = `AC_TIMING ${JSON.stringify({ name: 'first_inference_done', runId: 'mace-unit-run', device: 'cuda', energy: -12.3 })}\n`;
      response.end(
        `${JSON.stringify({ type: 'stdout', data: Buffer.from(line).toString('base64') })}\n`,
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ workload: { state: 'queued' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture has no port');
  const runner = new ProcessRunner(artifacts, foreground.signal, process.cwd());
  const execute = runner.run.bind(runner);
  const run = vi.spyOn(runner, 'run').mockImplementation(async (...args) => {
    events.push(
      `spawn:${cleanup.observations().some((entry) => entry.label === 'job-mace-unit-mace-observer' && !entry.completed)}`,
    );
    const result = await execute(...args);
    events.push('observer-reaped');
    return result;
  });
  const native = {
    run: vi.fn(async (_executable: string, args: readonly string[]) =>
      commandResultForTest({
        stdout: args[0] === 'inspect' ? 'a'.repeat(64) : '',
        combined: [
          JSON.stringify({
            id: 'foreign',
            message: 'Image pulled successfully with containerd transfer',
          }),
          JSON.stringify({
            id: 'mace-unit',
            message: 'Containerd transfer unavailable; using Docker pull',
          }),
          JSON.stringify({
            id: 'mace-unit',
            message: 'Image pulled successfully',
          }),
        ].join('\n'),
      }),
    ),
  };
  const transport = new JobMaceTransport({
    id: 'mace-unit',
    profile: jobMemberProfile(
      { kind: 'mace-full-pull', target: 'aws' },
      new Environment({}, redactor),
    ),
    apiUrl: `http://127.0.0.1:${address.port}`,
    bearer: () => token,
    runner,
    files: new FixtureFiles(directory),
    cleanup,
    artifacts,
    commands: new JobPrivateCommands(native, foreground.signal),
    assertController: () => {
      if (state.changedController)
        throw new Error('original controller changed');
    },
  });
  onTestFinished(async () => {
    foreground.abort();
    try {
      await cleanup.run();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    transport,
    run,
    native,
    cleanup,
    records,
    events,
    requests,
    state,
    foreground,
    directory,
    output: path.join(directory, 'job-mace-mace-unit/observer.json'),
    wait: new Waiter(new AbortController().signal),
  };
}

test('the real shared observer uses private credentials, arms before submission and retains its original schema and process result', async () => {
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-secret-must-not-reach-child');
  const w = await harness();
  await w.transport.start(10_000);
  const armed = await w.wait.for(
    'observer armed',
    () => w.transport.observation(),
    {
      timeoutMs: 5_000,
      intervalMs: 20,
      probeError: 'fail',
      unmet: (value) => (value ? undefined : 'waiting'),
    },
  );
  expect(armed).toMatchObject({
    schemaVersion: 2,
    phase: 'armed',
    workloadId: 'mace-unit',
    runId: 'mace-unit-run',
  });
  expect(w.events).toContain('spawn:true');
  expect(w.run.mock.calls[0][2]).toMatchObject({
    recordArtifact: false,
    env: {
      AWS_SECRET_ACCESS_KEY: undefined,
      ANYCLOUD_OBSERVER_ACCESS_TOKEN: 'original-mace-token',
    },
  });
  expect(w.run.mock.calls[0][1]).toContain('--run-id');
  w.state.marker = true;
  const observed = await w.wait.for(
    'observer inference',
    () => w.transport.observation(),
    {
      timeoutMs: 5_000,
      intervalMs: 20,
      probeError: 'fail',
      unmet: (value) => (value?.phase === 'observed' ? undefined : 'waiting'),
    },
  );
  expect(observed).toMatchObject({
    phase: 'observed',
    marker: { payload: { device: 'cuda', energy: -12.3 } },
  });
  await w.transport.finish();
  expect(
    w.records.find(({ label }) => label === 'job-mace-unit-mace-observer')
      ?.value,
  ).toEqual(observed);
  expect(
    w.records.find(
      ({ label }) => label === 'job-mace-unit-mace-observer-process',
    )?.value,
  ).toMatchObject({ exitCode: 0, aborted: false, timedOut: false });
  expect(
    w.requests.every(
      ({ authorization }) => authorization === 'Bearer original-mace-token',
    ),
  ).toBe(true);
  await expect(readFile(w.output, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(w.transport.pullLogMessages()).resolves.toEqual([
    'Containerd transfer unavailable; using Docker pull',
    'Image pulled successfully',
  ]);
  expect(w.native.run.mock.calls.at(-1)?.[1]).toEqual(['logs', 'a'.repeat(64)]);
  await w.transport.writeReport(undefined, observed, 'docker-fallback');
  expect(
    w.records.find(({ label }) => label === 'job-mace-unit-mace-report')?.value,
  ).toMatchObject({
    reportType: 'mace-timing',
    schemaVersion: 2,
    cloud: 'aws',
    workloadId: 'mace-unit',
    infrastructure: { vmType: 'g6e.xlarge' },
    deliveryPath: 'docker-fallback',
    firstInference: { device: 'cuda', energy: -12.3 },
  });
  await expect(
    w.transport.writeReport(
      undefined,
      { ...observed!, workloadId: 'foreign' },
      'docker-fallback',
    ),
  ).rejects.toThrow('another Job');

  await expect(w.transport.finish()).rejects.toThrow('reused');
  await expect(w.transport.start(10_000)).rejects.toThrow('twice');
});

test('foreground cancellation joins the real observer before independent Workload cleanup and retains the interrupted receipt', async () => {
  const w = await harness();
  await w.transport.start(10_000);
  await w.wait.for('observer armed', () => w.transport.observation(), {
    timeoutMs: 5_000,
    intervalMs: 20,
    probeError: 'fail',
    unmet: (value) => (value ? undefined : 'waiting'),
  });
  w.foreground.abort();
  await w.cleanup.run();
  expect(w.events.indexOf('observer-reaped')).toBeLessThan(
    w.events.indexOf('workload-cleanup'),
  );
  expect(
    w.records.find(({ label }) => label === 'job-mace-unit-mace-observer')
      ?.value,
  ).toMatchObject({ phase: 'armed', workloadId: 'mace-unit' });
  expect(
    w.records.find(
      ({ label }) => label === 'job-mace-unit-mace-observer-process',
    )?.value,
  ).toMatchObject({ aborted: true });
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
});

test('a failed observer retains its original failure and cannot become successful inference', async () => {
  const w = await harness();
  w.state.reject = true;
  await w.transport.start(5_000);
  await expect(w.transport.finish()).rejects.toThrow('private command failed');
  expect(
    w.records.find(({ label }) => label === 'job-mace-unit-mace-observer')
      ?.value,
  ).toMatchObject({
    phase: 'failed',
    error: expect.stringContaining('non-retryable HTTP 401'),
  });
  expect(
    w.records.find(
      ({ label }) => label === 'job-mace-unit-mace-observer-process',
    )?.value,
  ).toMatchObject({ exitCode: 1 });
  await expect(w.transport.pullLogMessages()).rejects.toThrow(
    'successful observation',
  );
});

test.each(['foreign', 'stale', 'schema', 'malformed'] as const)(
  'the observer rejects %s receipts without dropping the original record',
  async (failure) => {
    const w = await harness();
    await w.transport.start(10_000);
    const armed = await w.wait.for(
      'observer armed',
      () => w.transport.observation(),
      {
        timeoutMs: 5_000,
        intervalMs: 20,
        probeError: 'fail',
        unmet: (value) => (value ? undefined : 'waiting'),
      },
    );
    const body = {
      ...armed,
      ...(failure === 'foreign' ? { runId: 'copied-run' } : {}),
      ...(failure === 'stale' ? { observerArmedAtMs: 1 } : {}),
      ...(failure === 'schema' ? { schemaVersion: 1 } : {}),
    };
    await writeFile(
      w.output,
      failure === 'malformed' ? '{bad JSON' : JSON.stringify(body),
    );
    await expect(w.transport.observation()).rejects.toThrow(
      /malformed|foreign/,
    );
    if (failure === 'malformed') {
      expect(
        w.records.find(
          ({ label }) => label === 'job-mace-unit-mace-invalid-observer',
        )?.value,
      ).toEqual({ raw: '{bad JSON' });
      await expect(w.cleanup.run()).rejects.toThrow('malformed JSON');
      expect(w.events).toContain('workload-cleanup');
    } else {
      await w.cleanup.run();
      expect(
        w.records.find(({ label }) => label === 'job-mace-unit-mace-observer')
          ?.value,
      ).toEqual(body);
    }
  },
);
