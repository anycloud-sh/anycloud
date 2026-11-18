import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { cloudCredentialSchema } from '../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { inspectAzureJobIdentity } from '../integration/credentials-onboarding/azure/identity-readback.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const subscriptionId = '11111111-1111-4111-8111-111111111111';
const directoryId = '22222222-2222-4222-8222-222222222222';
const bootstrapId = '33333333-3333-4333-8333-333333333333';
const applicationId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const objectId = '66666666-6666-4666-8666-666666666666';
const secret = 'private-azure-readback-secret';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function world() {
  const credential = cloudCredentialSchema.parse({
    cloudProvider: CloudType.Azure,
    applicationId: bootstrapId,
    directoryId,
    subscriptionId,
    secret,
  });
  const request = {
    member: 'azure-bucket-sync',
    source: 'a'.repeat(40),
    base: 'b'.repeat(40),
    runId: 123,
    attempt: 1,
    fixtureRunId: '123456789a',
    recordId: hash(JSON.stringify(credential)),
    subscriptionIdSha256: hash(subscriptionId),
    applicationId,
    applicationObjectId: objectId,
    displayName: 'anycloud-bkt-12345',
  };
  const observer = { source: 'c'.repeat(40), runId: 456, attempt: 2 };
  const patch: Partial<CommandResult> = {};
  const state = {
    scope: { id: subscriptionId, tenantId: directoryId },
    app: [] as unknown,
    sp: [] as unknown,
    failAt: 0,
    patch,
    runnerThrows: false,
    advance: (): void => {},
  };
  const calls: Array<{
    executable: string;
    args: readonly string[];
    options: CommandOptions;
  }> = [];
  const runner = {
    run: vi.fn(
      async (
        executable: string,
        args: readonly string[],
        options: CommandOptions = {},
      ): Promise<CommandResult> => {
        calls.push({ executable, args, options });
        state.advance();
        if (state.runnerThrows) throw new Error(secret);
        const invalidDirectoryArguments =
          args[0] === 'ad' && args.includes('--subscription');
        const body =
          args[0] === 'login' || invalidDirectoryArguments
            ? ''
            : JSON.stringify(
                args[0] === 'account'
                  ? state.scope
                  : args[1] === 'app'
                    ? state.app
                    : state.sp,
              );
        const stderr = invalidDirectoryArguments
          ? `ERROR: unrecognized arguments: --subscription ${subscriptionId}`
          : '';
        return {
          executable,
          args: [...args],
          stdout: body,
          stderr,
          combined: [body, stderr].filter(Boolean).join('\n'),
          exitCode: invalidDirectoryArguments ? 2 : 0,
          signal: null,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          durationMs: 1,
          ...(state.failAt === calls.length ? state.patch : {}),
        };
      },
    ),
  };
  const dependencies = {
    runner,
    files: {
      directory: vi.fn(async () => '/private-readback-session'),
      privateText: vi.fn(async () => {
        throw new Error('Azure has no key file');
      }),
    },
    redactor: new Redactor(),
    signal: new AbortController().signal,
  };
  const execute = () =>
    inspectAzureJobIdentity(request, credential, observer, dependencies);
  return { request, credential, observer, state, calls, dependencies, execute };
}

describe('exact Azure Job cleanup readback', () => {
  test.each([
    { name: 'matching manual inputs', runId: '123', attempt: '1' },
    { name: 'existing comparison entry' },
    {
      name: 'different original run',
      runId: '124',
      attempt: '1',
      failureStage: 'original-run',
    },
    {
      name: 'different original attempt',
      runId: '123',
      attempt: '2',
      failureStage: 'original-run',
    },
    {
      name: 'missing original run',
      attempt: '1',
      failureStage: 'original-run',
    },
    {
      name: 'missing original attempt',
      runId: '123',
      failureStage: 'original-run',
    },
    {
      name: 'empty original run',
      runId: '',
      attempt: '1',
      failureStage: 'original-run',
    },
    {
      name: 'malformed original run',
      runId: 'not-a-run',
      attempt: '1',
      failureStage: 'original-run',
    },
    {
      name: 'unsafe original run',
      runId: '9007199254740992',
      attempt: '1',
      failureStage: 'original-run',
    },
    {
      name: 'zero original attempt',
      runId: '123',
      attempt: '0',
      failureStage: 'original-run',
    },
    {
      name: 'malformed request',
      runId: '123',
      attempt: '1',
      request: 'not-json',
      failureStage: 'request',
    },
  ])('runs the real CLI for $name before authenticating', async (input) => {
    const w = world();
    const runId = 9_100_000_000_000 + process.pid;
    const output = `/tmp/azure-job-identity-readback/${runId}-1`;
    const bin = await mkdtemp(path.join(tmpdir(), 'azure-readback-binding-'));
    const callsPath = path.join(bin, 'calls.jsonl');
    try {
      // Execute the actual CLI and ProcessRunner against a local Azure stand-in.
      // Unexpected authentication is observable without any network access.
      await writeFile(
        path.join(bin, 'az'),
        `#!${process.execPath}\n` +
          `const fs = require('node:fs');\n` +
          `const args = process.argv.slice(2);\n` +
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');\n` +
          `console.log(args[0] === 'account' ? ${JSON.stringify(JSON.stringify({ id: subscriptionId, tenantId: directoryId }))} : '[]');\n`,
      );
      await chmod(path.join(bin, 'az'), 0o755);
      const execution = promisify(execFile)(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'test/integration/credentials-onboarding/azure/identity-readback-cli.ts',
        ],
        {
          cwd: process.cwd(),
          timeout: 20_000,
          env: {
            PATH: bin,
            E2E_AZURE_JOB_IDENTITY_READBACK:
              input.request ?? JSON.stringify(w.request),
            ORIGINAL_RUN_ID: input.runId,
            ORIGINAL_RUN_ATTEMPT: input.attempt,
            AZURE_CLIENT_ID: bootstrapId,
            AZURE_CLIENT_SECRET: secret,
            AZURE_TENANT_ID: directoryId,
            AZURE_SUBSCRIPTION_ID: subscriptionId,
            GITHUB_SHA: w.observer.source,
            GITHUB_RUN_ID: String(runId),
            GITHUB_RUN_ATTEMPT: '1',
          },
        },
      );
      if (input.failureStage)
        await expect(execution).rejects.toMatchObject({ code: 1 });
      else await execution;
      const body = await readFile(path.join(output, 'receipt.json'), 'utf8');
      const receipt = JSON.parse(body) as unknown;
      if (input.failureStage) {
        expect(receipt).toMatchObject({
          complete: false,
          absent: false,
          scopeMatched: false,
          processes: [],
          failureStage: input.failureStage,
        });
        await expect(readFile(callsPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        expect(receipt).toMatchObject({
          request: w.request,
          observer: { source: w.observer.source, runId, attempt: 1 },
          complete: true,
          absent: true,
          scopeMatched: true,
          mutations: 0,
        });
        const calls = (await readFile(callsPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(calls.map((args) => args.slice(0, 3))).toEqual([
          ['login', '--service-principal', '--username'],
          ['account', 'show', '--output'],
          ['ad', 'app', 'list'],
          ['ad', 'sp', 'list'],
        ]);
      }
      expect(body).not.toContain(secret);
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  test('the workflow entrypoint replaces stale output and retains a zero-command scope rejection', async () => {
    const w = world();
    const runId = 9_000_000_000_000 + process.pid;
    const output = `/tmp/azure-job-identity-readback/${runId}-1`;
    const bin = await mkdtemp(path.join(tmpdir(), 'azure-readback-cli-test-'));
    try {
      await writeFile(path.join(bin, 'az'), '#!/bin/sh\nexit 99\n');
      await chmod(path.join(bin, 'az'), 0o755);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'receipt.json'), 'stale receipt');
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            'node_modules/tsx/dist/cli.mjs',
            'test/integration/credentials-onboarding/azure/identity-readback-cli.ts',
          ],
          {
            cwd: process.cwd(),
            timeout: 20_000,
            env: {
              PATH: bin,
              E2E_AZURE_JOB_IDENTITY_READBACK: JSON.stringify({
                ...w.request,
                recordId: 'd'.repeat(64),
              }),
              AZURE_CLIENT_ID: bootstrapId,
              AZURE_CLIENT_SECRET: secret,
              AZURE_TENANT_ID: directoryId,
              AZURE_SUBSCRIPTION_ID: subscriptionId,
              GITHUB_SHA: w.observer.source,
              GITHUB_RUN_ID: String(runId),
              GITHUB_RUN_ATTEMPT: '1',
            },
          },
        ),
      ).rejects.toMatchObject({ code: 1 });
      const body = await readFile(path.join(output, 'receipt.json'), 'utf8');
      const receipt = JSON.parse(body) as unknown;
      expect(receipt).toMatchObject({
        request: { ...w.request, recordId: 'd'.repeat(64) },
        observer: { source: w.observer.source, runId, attempt: 1 },
        complete: false,
        absent: false,
        processes: [],
        failureStage: 'original-authorization',
      });
      expect(body).not.toContain(secret);
      expect(body).not.toContain('stale receipt');
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  test('requires original authorization, then reads both exact indexes without mutation or private output', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'foreign-ambient-value');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'foreign-ambient-secret');
    const w = world();
    const result = await w.execute();
    expect(result).toMatchObject({
      request: w.request,
      observer: w.observer,
      complete: true,
      absent: true,
      scopeMatched: true,
      mutations: 0,
    });
    expect(result.observations).toEqual(
      ['app', 'sp'].map((kind) => ({
        kind,
        observedAt: expect.any(Number),
        complete: true,
        identities: [],
      })),
    );
    expect(w.calls.map(({ args }) => args.slice(0, 3))).toEqual([
      ['login', '--service-principal', '--username'],
      ['account', 'show', '--output'],
      ['ad', 'app', 'list'],
      ['ad', 'sp', 'list'],
    ]);
    for (const call of w.calls) {
      expect(call.executable).toBe('az');
      expect(call.options.recordArtifact).toBe(false);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(29_000);
      expect(call.options.env?.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(call.options.env?.AZURE_CLIENT_SECRET).toBeUndefined();
    }
    for (const call of w.calls.slice(2)) {
      expect(call.args).toContain('--all');
      expect(call.args).toContain(`appId eq '${applicationId}'`);
      expect(call.args).not.toContain('--subscription');
      expect(call.args).not.toContain(subscriptionId);
      expect(call.options.env?.AZURE_CONFIG_DIR).toBe(
        w.calls[0].options.env?.AZURE_CONFIG_DIR,
      );
    }
    expect(w.calls[0].args).toContain(directoryId);
    expect(w.calls[1].args).toEqual([
      'account',
      'show',
      '--output',
      'json',
      '--subscription',
      subscriptionId,
    ]);
    expect(result.processes).toHaveLength(4);
    expect(
      result.processes.every(
        (process) => process.reaped && process.exitCode === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('foreign-ambient');
    expect(JSON.stringify(result)).not.toContain('private-readback-session');
  });

  test.each(['recordId', 'subscriptionIdSha256'] as const)(
    'refuses a different original %s before login',
    async (field) => {
      const w = world();
      w.request[field] = 'd'.repeat(64);
      const result = await w.execute();
      expect(result).toMatchObject({
        complete: false,
        absent: false,
        scopeMatched: false,
        failureStage: 'original-authorization',
      });
      expect(w.calls).toHaveLength(0);
    },
  );

  test('does not accept missing or open request/observer descriptions', async () => {
    const w = world();
    for (const request of [
      undefined,
      { ...w.request, mutate: true },
      { ...w.request, applicationId: "'bad-filter" },
    ]) {
      const result = await inspectAzureJobIdentity(
        request,
        w.credential,
        w.observer,
        w.dependencies,
      );
      expect(result.failureStage).toBe('request');
      expect(result.absent).toBe(false);
    }
    const result = await inspectAzureJobIdentity(
      w.request,
      w.credential,
      { ...w.observer, source: w.request.fixtureRunId },
      w.dependencies,
    );
    expect(result.failureStage).toBe('observer');
    expect(w.calls).toHaveLength(0);
  });

  test.each(['id', 'tenantId'] as const)(
    'rejects wrong account %s before directory reads',
    async (field) => {
      const w = world();
      w.state.scope[field] = objectId;
      const result = await w.execute();
      expect(result).toMatchObject({
        complete: false,
        absent: false,
        scopeMatched: false,
        failureStage: 'login-and-scope',
      });
      expect(w.calls).toHaveLength(2);
    },
  );

  test('retains present original objects without claiming absence or deleting them', async () => {
    const w = world();
    w.state.app = [
      {
        id: objectId,
        appId: applicationId,
        displayName: w.request.displayName,
        privateField: secret,
      },
    ];
    w.state.sp = [
      {
        id: principalId,
        appId: applicationId,
        displayName: w.request.displayName,
      },
    ];
    const result = await w.execute();
    expect(result).toMatchObject({ complete: true, absent: false });
    expect(result.observations.map((row) => row.identities[0].id)).toEqual([
      objectId,
      principalId,
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(w.calls).toHaveLength(4);
  });

  test.each([
    { id: objectId, appId: bootstrapId, displayName: 'anycloud-bkt-12345' },
    {
      id: principalId,
      appId: applicationId,
      displayName: 'anycloud-bkt-12345',
    },
    { id: objectId, appId: applicationId, displayName: 'renamed-foreign' },
    {
      id: 'malformed',
      appId: applicationId,
      displayName: 'anycloud-bkt-12345',
    },
  ])(
    'rejects a foreign or malformed directory row before the next inventory',
    async (row) => {
      const w = world();
      w.state.app = [row];
      const result = await w.execute();
      expect(result).toMatchObject({
        complete: false,
        absent: false,
        failureStage: 'app',
      });
      expect(result.observations[0].complete).toBe(false);
      expect(w.calls).toHaveLength(3);
    },
  );

  test('retains a validated prefix when a later row is malformed or duplicated', async () => {
    const w = world();
    const original = {
      id: objectId,
      appId: applicationId,
      displayName: w.request.displayName,
    };
    for (const tail of [{ privateField: secret }, original]) {
      w.state.app = [original, tail];
      const result = await w.execute();
      expect(result.complete).toBe(false);
      expect(result.observations[0]).toMatchObject({
        complete: false,
        identities: [original],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test.each([
    { exitCode: 1, stderr: secret },
    {
      exitCode: 2,
      stderr: `ERROR: unrecognized arguments: --subscription ${subscriptionId}`,
    },
    { signal: 'SIGTERM' },
    { timedOut: true },
    { aborted: true },
    { outputTruncated: true },
    { spawnError: secret },
    { stdout: '[]truncated' },
    { stdout: JSON.stringify({ value: [], nextLink: 'unread-page' }) },
  ] as Partial<CommandResult>[])(
    'keeps failed/incomplete provider observations unknown',
    async (patch) => {
      const w = world();
      w.state.failAt = 3;
      w.state.patch = patch;
      const result = await w.execute();
      expect(result).toMatchObject({
        complete: false,
        absent: false,
        failureStage: 'app',
      });
      expect(result.observations[0].complete).toBe(false);
      expect(w.calls).toHaveLength(3);
      if (patch.exitCode !== undefined)
        expect(result.processes.at(-1)?.exitCode).toBe(patch.exitCode);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  test('keeps the first completed absence if the second inventory fails', async () => {
    const w = world();
    w.state.failAt = 4;
    w.state.patch = { exitCode: 1, stderr: secret };
    const result = await w.execute();
    expect(result).toMatchObject({
      complete: false,
      absent: false,
      failureStage: 'sp',
    });
    expect(result.observations.map((row) => row.complete)).toEqual([
      true,
      false,
    ]);
    expect(w.calls).toHaveLength(4);
  });

  test('does not invent completion when a process receipt is missing', async () => {
    const w = world();
    w.state.runnerThrows = true;
    const result = await w.execute();
    expect(result.complete).toBe(false);
    expect(result.processes).toEqual([
      expect.objectContaining({ reaped: false }),
    ]);
    expect(w.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('does not read through cancellation or accept an application row as its principal', async () => {
    const w = world();
    const result = await inspectAzureJobIdentity(
      w.request,
      w.credential,
      w.observer,
      {
        ...w.dependencies,
        signal: AbortSignal.abort(),
      },
    );
    expect(result.complete).toBe(false);
    expect(w.calls).toHaveLength(0);
    w.state.sp = [
      {
        id: objectId,
        appId: applicationId,
        displayName: w.request.displayName,
      },
    ];
    const copied = await w.execute();
    expect(copied).toMatchObject({
      complete: false,
      absent: false,
      failureStage: 'sp',
    });
  });

  test('stops before another command after a command or total deadline violation', async () => {
    const w = world();
    w.state.failAt = 1;
    w.state.patch = { durationMs: 30_001 };
    expect((await w.execute()).complete).toBe(false);
    expect(w.calls).toHaveLength(1);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const other = world();
    other.state.advance = () => {
      now += 120_001;
    };
    const result = await other.execute();
    expect(result.complete).toBe(false);
    expect(other.calls).toHaveLength(1);
    expect(result.processes[0].reaped).toBe(true);
  });
});
