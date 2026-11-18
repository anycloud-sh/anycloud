import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { jobMemberProfile } from '../integration/e2e/internal/contracts/job-policy.js';
import { jobGhcrPull } from '../integration/e2e/internal/contracts/job-observations.js';
import type {
  CloudJobFixture,
  JobNativeAttempt,
} from '../integration/e2e/internal/targets/job-types.js';
import { JobGhcrTransport } from '../integration/e2e/internal/transports/job-ghcr.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import type { PinnedRemoteHost } from '../integration/e2e/internal/remote.js';
import type { TargetHttpClient } from '../integration/e2e/internal/transports/http.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';

const pullOutput = [
  'PARALLEL_PULL docker_visibility PASS inspect=ok create=ok namespace=probe',
  'PARALLEL_PULL verdict SUPPORTED fallback=not_needed',
  'PARALLEL_PULL cleanup PASS daemons=absent',
  'PARALLEL_PULL pull mib_per_second=20 peak_connections=3',
].join('\n');

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'job-ghcr-'));
  const foreground = new AbortController();
  const cleanupController = new AbortController();
  const cleanup = new CleanupStack();
  const events: string[] = [];
  const redactor = new Redactor();
  const artifacts = new ArtifactStore(directory, redactor);
  await artifacts.initialize({
    testName: 'ghcr-unit',
    runId: 'ghcr-unit',
    startedAt: new Date().toISOString(),
  });
  const records: Array<{ name: string; value: unknown }> = [];
  const record = artifacts.json.bind(artifacts);
  vi.spyOn(artifacts, 'json').mockImplementation(async (name, value) => {
    records.push({ name, value });
    return record(name, value);
  });
  cleanup.defer('original Job native cleanup', async () => {
    events.push('native-absent');
  });
  const profile = jobMemberProfile(
    { kind: 'ghcr-probe', target: 'azure' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  const fixture: CloudJobFixture = {
    ref: trackedWorkloadRefForTest('ghcr-unit'),
    profile,
    credentialName: 'azure-test',
    storageCredentialName: 'azure-test',
    runLabel: 'ghcr-unit',
    concurrentIndex: 0,
    concurrentWrites: [],
  };
  const attempt: JobNativeAttempt = {
    ref: fixture.ref,
    rowId: 11,
    createdAt: 1,
    endedAt: null,
    cloudId: 'original-vm',
    ip: '203.0.113.7',
    cloudProvider: CloudType.Azure,
    credentialId: 'a'.repeat(64),
    region: 'westus2',
    availabilityZone: '2',
    vmType: 'Standard_NC4as_T4_v3',
  };
  const state = {
    foreignAttempt: false,
    changedController: false,
    lostStart: false,
    captureFailed: false,
    poll: 'AC_PROBE_STATUS done:0\n',
    pollExit: 0,
    imageFailure: '' as
      | ''
      | 'authentication'
      | 'schema'
      | 'architecture'
      | 'redirect'
      | 'deadline',
  };
  const hostRun = vi.fn<PinnedRemoteHost['run']>(async (command, options) => {
    options?.signal?.throwIfAborted();
    if (command.includes('systemd-run')) {
      events.push(
        `launch:${cleanup.observations().some((entry) => entry.label === 'job-ghcr-unit-ghcr-ssh-material' && !entry.completed)}`,
      );
      return commandResultForTest(
        state.lostStart ? { exitCode: 255, stderr: 'connection lost' } : {},
      );
    }
    if (command.startsWith('if [ -s '))
      return commandResultForTest({
        stdout: state.poll,
        combined: state.poll,
        exitCode: state.pollExit,
      });
    if (command.startsWith('cat '))
      return commandResultForTest({
        stdout: pullOutput,
        combined: pullOutput,
        exitCode: state.captureFailed ? 255 : 0,
      });
    if (command.startsWith('load=')) {
      events.push('stop-original-unit');
      return commandResultForTest();
    }
    const stdout =
      'PROBE fingerprint kernel=linux nproc=4\nPROBE verdict PER_CONNECTION_CAP ratio=2.0\n';
    return commandResultForTest({ stdout, combined: stdout });
  });
  const host: PinnedRemoteHost = {
    run: hostRun,
    close: async () => {
      events.push('ssh-material-closed');
    },
  };
  const pinHost = vi.fn(async () => host);
  const get = vi.fn<TargetHttpClient['get']>(async (_label, url, options) => {
    options?.signal?.throwIfAborted();
    if (state.imageFailure === 'redirect') throw new Error('redirect rejected');
    if (state.imageFailure === 'deadline') throw new Error('deadline expired');
    if (state.imageFailure === 'authentication')
      return { status: 401, body: { error: 'unauthorized' } };
    if (url.pathname === '/token')
      return { status: 200, body: { token: 'anonymous-pull-secret' } };
    if (state.imageFailure === 'schema')
      return {
        status: 200,
        body: { layers: [{ digest: 'sha256:bad', size: 42 }] },
      };
    if (url.pathname.endsWith('a'.repeat(64)))
      return {
        status: 200,
        body: {
          layers: [
            { digest: `sha256:${'b'.repeat(64)}`, size: 100 },
            { digest: `sha256:${'c'.repeat(64)}`, size: 200 },
          ],
        },
      };
    return {
      status: 200,
      body: {
        manifests: [
          {
            digest: `sha256:${'a'.repeat(64)}`,
            platform: {
              os: 'linux',
              architecture:
                state.imageFailure === 'architecture' ? 'arm64' : 'amd64',
            },
          },
        ],
      },
    };
  });
  const noCommand = {
    run: async () => {
      throw new Error('unexpected native command');
    },
  };
  const transport = new JobGhcrTransport({
    fixture,
    cleanupRemote: { pinHost },
    commands: new JobPrivateCommands(noCommand, foreground.signal),
    cleanupCommands: new JobPrivateCommands(
      noCommand,
      cleanupController.signal,
    ),
    cleanup,
    artifacts,
    redactor,
    http: { get },
    assertController: () => {
      if (state.changedController)
        throw new Error('original controller changed');
    },
    assertAttempt: async (actual) => {
      if (
        state.foreignAttempt ||
        actual.ref !== fixture.ref ||
        actual.rowId !== 11 ||
        actual.cloudId !== attempt.cloudId
      )
        throw new Error('original native attempt changed');
    },
  });
  onTestFinished(async () => {
    try {
      await cleanup.run();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const ready = async () => {
    await transport.prepare();
    await transport.bind(attempt);
    await transport.throughput(Date.now() + 60_000);
  };
  return {
    transport,
    state,
    fixture,
    attempt,
    directory,
    records,
    foreground,
    cleanup,
    events,
    hostRun,
    pinHost,
    get,
    ready,
  };
}

test('GHCR resolves the pinned linux/amd64 largest layer privately, then sends both unchanged payloads to the original registered host', async () => {
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-aws-must-not-reach-ssh');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const w = await harness();
  const facts = await w.transport.prepare();
  expect(facts).toEqual({
    image: w.fixture.profile.ghcr!.image,
    layerDigest: `sha256:${'c'.repeat(64)}`,
    imageBytes: 300,
    resolution: 'runner',
  });
  expect(w.pinHost).not.toHaveBeenCalled();
  await w.transport.bind(w.attempt);
  expect(w.pinHost).toHaveBeenCalledWith('ghcr-unit', {
    expectedHost: '203.0.113.7',
    env: expect.objectContaining({
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_CONFIG_FILE: '/dev/null',
    }),
    recordArtifact: false,
  });
  await w.transport.throughput(Date.now() + 60_000);
  const throughputCommand = w.hostRun.mock.calls[0][0];
  const throughputPayload = await readFile(
    'test/integration/probe-ghcr-throughput.sh',
  );
  expect(throughputCommand).toContain(throughputPayload.toString('base64'));
  expect(throughputCommand).toContain("268435456 '1 4 8 16'");
  await w.transport.startPull();
  expect(w.events).toContain('launch:true');
  const start = w.hostRun.mock.calls[1][0];
  const pullPayload = await readFile(
    'test/integration/probe-containerd-parallel-pull.sh',
  );
  expect(start).toContain(pullPayload.toString('base64'));
  expect(start).toContain('--property=RuntimeMaxSec=1200');
  expect(start).toContain("--unit='ghcr-unit-containerd-pull'");
  const launcher = [
    ...start.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)'/gu),
  ][1][1];
  const script = Buffer.from(launcher, 'base64').toString();
  expect(script).toContain('300 3 134217728 0');
  expect(script).toContain('trap finish EXIT');
  expect(script).toContain('mv -f "${status}.tmp" "$status"');
  await expect(w.transport.poll(Date.now() + 60_000)).resolves.toEqual({
    state: 'done',
    exitCode: 0,
  });
  await expect(w.transport.capture()).resolves.toBe(pullOutput);
  await w.transport.finish(Date.now() + 60_000);
  await w.cleanup.run();
  expect(w.events.indexOf('ssh-material-closed')).toBeLessThan(
    w.events.indexOf('native-absent'),
  );
  expect(
    w.hostRun.mock.calls.every(
      ([, options]) =>
        options?.recordArtifact === false &&
        Object.hasOwn(options.env ?? {}, 'AWS_SECRET_ACCESS_KEY') &&
        options.env?.AWS_SECRET_ACCESS_KEY === undefined,
    ),
  ).toBe(true);
  expect(
    w.get.mock.calls.every(([, , options]) => options?.redirect === 'error'),
  ).toBe(true);
  expect(w.get.mock.calls[1][2]?.headers).toMatchObject({
    Authorization: 'Bearer anonymous-pull-secret',
  });
  const contents = await Promise.all(
    (await readdir(w.directory))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFile(path.join(w.directory, name), 'utf8')),
  );
  expect(contents.join('\n')).not.toContain('anonymous-pull-secret');
  await expect(w.transport.prepare()).rejects.toThrow('reused');
  await expect(w.transport.finish(Date.now() + 60_000)).rejects.toThrow(
    'reused',
  );
});

test.each([
  'authentication',
  'schema',
  'architecture',
  'redirect',
  'deadline',
] as const)(
  'GHCR preserves the original %s failure and declared VM auto-resolution fallback',
  async (imageFailure) => {
    const w = await harness();
    w.state.imageFailure = imageFailure;
    await expect(w.transport.prepare()).resolves.toEqual({
      image: w.fixture.profile.ghcr!.image,
      layerDigest: 'auto',
      imageBytes: 0,
      resolution: 'vm-auto',
    });
    expect(
      w.records.find(
        ({ name }) => name === 'job-ghcr-unit-ghcr-resolution-failure',
      )?.value,
    ).toMatchObject({
      workloadId: 'ghcr-unit',
      generation: 1,
      resolution: 'vm-auto',
      error: expect.any(String),
    });
    expect(w.hostRun).not.toHaveBeenCalled();
  },
);

test('GHCR retains a lost start reply, stops only its original unit after cancellation and still runs native cleanup', async () => {
  const w = await harness();
  await w.ready();
  w.state.lostStart = true;
  await expect(w.transport.startPull()).rejects.toThrow(
    'private command failed',
  );
  w.foreground.abort();
  await w.cleanup.run();
  expect(w.events).toEqual([
    'launch:true',
    'stop-original-unit',
    'ssh-material-closed',
    'native-absent',
  ]);
  expect(w.hostRun.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false);
  expect(w.hostRun.mock.calls.at(-1)?.[0]).toContain(
    '/var/tmp/ghcr-unit-containerd-pull/output.log',
  );
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
});

test('GHCR keeps a cleanup diagnostic failure secondary and allows the original native owner to run', async () => {
  const w = await harness();
  await w.ready();
  await w.transport.startPull();
  w.state.captureFailed = true;
  w.foreground.abort();
  await expect(w.cleanup.run()).rejects.toThrow(
    'diagnostics or SSH material cleanup',
  );
  expect(w.events).toContain('native-absent');
  expect(w.events).toContain('ssh-material-closed');
  expect(
    w.cleanup
      .observations()
      .find((entry) => entry.label === 'job-ghcr-unit-ghcr-ssh-material')
      ?.completed,
  ).toBe(false);
});

test.each(['foreign', 'controller', 'ended', 'copied'] as const)(
  'GHCR rejects %s identity before sending a probe command',
  async (failure) => {
    const w = await harness();
    await w.transport.prepare();
    if (failure === 'foreign') w.state.foreignAttempt = true;
    if (failure === 'controller') w.state.changedController = true;
    const selected =
      failure === 'ended'
        ? { ...w.attempt, endedAt: 2 }
        : failure === 'copied'
          ? { ...w.attempt, ref: trackedWorkloadRefForTest('ghcr-unit') }
          : w.attempt;
    await expect(w.transport.bind(selected)).rejects.toThrow(/original/);
    expect(w.hostRun).not.toHaveBeenCalled();
  },
);

test.each([
  'AC_PROBE_STATUS done:999\n',
  'AC_PROBE_STATUS done:0\nAC_PROBE_STATUS done:1\n',
  'unknown',
])('GHCR rejects malformed detached status %j', async (poll) => {
  const w = await harness();
  await w.ready();
  await w.transport.startPull();
  w.state.poll = poll;
  await expect(w.transport.poll(Date.now() + 60_000)).rejects.toThrow(
    'malformed status',
  );
  expect(
    w.records.find(({ name }) => name === 'job-ghcr-unit-ghcr-poll')?.value,
  ).toMatchObject({ unit: 'ghcr-unit-containerd-pull' });
});

test('GHCR reports a transient SSH poll failure without treating its partial stdout as a successful exit', async () => {
  const w = await harness();
  await w.ready();
  await w.transport.startPull();
  w.state.pollExit = 255;
  await expect(w.transport.poll(Date.now() + 60_000)).resolves.toEqual({
    state: 'transport-failure',
  });
  expect(
    w.records.find(({ name }) => name === 'job-ghcr-unit-ghcr-poll')?.value,
  ).toMatchObject({ result: { exitCode: 255 } });
});

test('GHCR cannot rescue an automatic daemon-cleanup assertion and makes no comparison when its baseline was not requested', () => {
  expect(jobGhcrPull(pullOutput, false)).toMatchObject({
    baseline: { requested: false, measured: false },
    probeCleanup: true,
  });
  expect(() =>
    jobGhcrPull(pullOutput.replace('cleanup PASS', 'cleanup FAILED'), false),
  ).toThrow('automatic probe cleanup');
  expect(() =>
    jobGhcrPull(
      `${pullOutput}\nPARALLEL_PULL baseline mib_per_second=10`,
      false,
    ),
  ).toThrow('undeclared baseline');
});

test.each([
  '',
  'error=cached_layers',
  'error=pull_failed',
  'mib_per_second=0',
  'mib_per_second=NA',
  'mib_per_second=1.2.3',
  'mib_per_second=20',
  'mib_per_second=21',
])('GHCR rejects an invalid or losing requested baseline %j', (baseline) => {
  expect(() =>
    jobGhcrPull(
      `${pullOutput}\n${baseline ? `PARALLEL_PULL baseline ${baseline}` : ''}`,
      true,
    ),
  ).toThrow();
});
