import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import {
  JobPrivateCommandFailure,
  JobPrivateCommands,
  privateJobOutput,
} from '../integration/e2e/internal/transports/job-command.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';

afterEach(() => vi.unstubAllEnvs());

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    executable: 'aws',
    args: [],
    exitCode: 255,
    signal: null,
    stdout: '',
    stderr:
      'An error occurred (NoSuchEntity) when calling the GetUser operation: private-native-diagnostic',
    combined: '',
    durationMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...overrides,
  };
}

describe('Job private native command boundary', () => {
  test.each(['', 'aws: [ERROR]: '])(
    'recognizes only complete AWS native failures with prefix %j',
    (prefix) => {
      for (const code of ['NoSuchEntity', 'NoSuchBucket', 'AccessDenied']) {
        const receipt = result({
          exitCode: 254,
          stderr: `${prefix}An error occurred (${code}) when calling the GetUser operation: private-native-diagnostic\n`,
        });
        const error = new JobPrivateCommandFailure(receipt);
        expect(error.nativeCode).toBe(code);
        expect(inspect(error)).not.toContain('private-native-diagnostic');
        for (const incomplete of [
          { timedOut: true },
          { aborted: true },
          { outputTruncated: true },
          { exitCode: 0 },
          { exitCode: null },
          { signal: 'SIGTERM' as const },
          { spawnError: 'private-spawn-error' },
          { stdout: 'private-partial-inventory' },
          { stderr: `${receipt.stderr}another error\n` },
          { stderr: `unrecognized prefix ${receipt.stderr}` },
        ])
          expect(
            new JobPrivateCommandFailure({ ...receipt, ...incomplete })
              .nativeCode,
          ).toBeUndefined();
      }
    },
  );

  test.each([
    { timedOut: true },
    { aborted: true },
    { outputTruncated: true },
    { stdout: '{"User":{"UserName":"still-present"}}' },
    { spawnError: 'private-native-diagnostic' },
    { signal: 'SIGTERM' as const, exitCode: null },
  ])(
    'never mints a native absence code from an incomplete process receipt %j',
    (flags) => {
      const error = new JobPrivateCommandFailure(result(flags));
      expect(error.nativeCode).toBeUndefined();
      expect(inspect(error, { depth: 10 })).not.toContain(
        'private-native-diagnostic',
      );
      expect(() => privateJobOutput(result(flags))).toThrow();
    },
  );

  test.each([
    'InvalidAccessKeyId',
    'InvalidClientTokenId',
    'AccessDenied',
    'Throttling',
    'ServiceUnavailable',
  ])(
    'retains the safe readiness class %s without its native diagnostic',
    (code) => {
      const error = new JobPrivateCommandFailure(
        result({
          stderr: `An error occurred (${code}) when calling the ListBuckets operation: private-native-diagnostic`,
          durationMs: 61_234,
        }),
      );
      expect(error.nativeCode).toBe(code);
      expect(error.message).toContain(code);
      expect(error.message).toContain('elapsed=61234ms');
      expect(inspect(error)).not.toContain('private-native-diagnostic');
    },
  );

  test.each(['ABORTED', 'FAILED_PRECONDITION'])(
    'names the gcloud refusal %s without its native diagnostic',
    (code) => {
      const error = new JobPrivateCommandFailure(
        result({
          executable: 'gcloud',
          exitCode: 1,
          stderr: `ERROR: (gcloud.iam.roles.create) ${code}: private-native-diagnostic\n`,
        }),
      );
      expect(error.nativeCode).toBe(code);
      expect(error.message).toContain(code);
      expect(inspect(error)).not.toContain('private-native-diagnostic');
    },
  );

  test.each([
    // `az rest` failure shapes: `ERROR: <reason>(<Graph response body>)`.
    ...(
      [
        ['Not Found', 'Request_ResourceNotFound'],
        ['Forbidden', 'Authorization_RequestDenied'],
      ] as const
    ).map(([reason, code]) => ({
      stderr: `ERROR: ${reason}(${JSON.stringify({ error: { code, message: 'private-provider-diagnostic', innerError: { 'request-id': 'private-original-identity' } } })})\n`,
      nativeCode: code,
      description: code,
    })),
    {
      stderr: 'ERROR: Insufficient privileges to complete the operation.\n',
      nativeCode: undefined,
      description: 'Azure Graph insufficient-privileges message',
    },
  ])(
    'retains only a safe Azure Graph failure description: $description',
    ({ stderr, nativeCode, description }) => {
      const receipt = result({
        executable: 'az',
        args: ['ad', 'app', 'delete', '--id', 'private-original-identity'],
        exitCode: 1,
        stderr,
        combined: stderr,
      });
      const error = new JobPrivateCommandFailure(receipt);
      expect(error.nativeCode).toBe(nativeCode);
      expect(error.message).toContain(description);
      for (const value of [
        'private-provider-diagnostic',
        'private-original-identity',
      ])
        expect(inspect(error, { depth: 10 })).not.toContain(value);
      for (const incomplete of [
        { timedOut: true },
        { aborted: true },
        { outputTruncated: true },
        { exitCode: 0 },
        { exitCode: null },
        { signal: 'SIGTERM' as const },
        { spawnError: 'private-spawn-error' },
        { stdout: 'private-partial-output' },
      ]) {
        const failure = new JobPrivateCommandFailure({
          ...receipt,
          ...incomplete,
        });
        expect(failure.nativeCode).toBeUndefined();
        // An ended budget or a cancelled command is named as such; every
        // other incomplete receipt stays unclassified. None carries output.
        expect(failure.message).toContain(
          'timedOut' in incomplete
            ? 'timeout;'
            : 'aborted' in incomplete
              ? 'aborted;'
              : 'unclassified',
        );
        for (const value of [
          'private-provider-diagnostic',
          'private-original-identity',
          'private-spawn-error',
          'private-partial-output',
        ])
          expect(inspect(failure, { depth: 10 })).not.toContain(value);
      }
    },
  );

  test.each([
    'ERROR: Insufficient privileges to complete the operation. private-value',
    'ERROR: Insufficient privileges to complete the operation.\nprivate-value',
    'private-prefix ERROR: Insufficient privileges to complete the operation.',
    'ERROR: Resource private-object does not exist.',
    'ERROR: Not Found({"error":{"code":"Request_ResourceNotFound" private-value',
    'ERROR: Not Found({"error":{"code":"Private_Unlisted","message":"private-value"}})',
    'ERROR: Not Found({"error":{"code":"Request_ResourceNotFound"}})\nprivate-value',
  ])(
    'does not interpret arbitrary Graph messages as native evidence',
    (stderr) => {
      const error = new JobPrivateCommandFailure(
        result({ executable: 'az', exitCode: 1, stderr }),
      );
      expect(error.nativeCode).toBeUndefined();
      expect(error.message).toContain('unclassified');
      for (const value of ['private-value', 'private-prefix', 'private-object'])
        expect(inspect(error, { depth: 10 })).not.toContain(value);
    },
  );

  test('sanitizes the actual child environment and suppresses command artifacts before output exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'job-private-command-'));
    try {
      const removed = [
        'AWS_PROFILE',
        'AWS_SESSION_TOKEN',
        'AWS_ENDPOINT_URL',
        'AZURE_CLIENT_SECRET',
        'ARM_USE_MSI',
        'CLOUDSDK_AUTH_ACCESS_TOKEN',
        'CLOUDSDK_API_ENDPOINT_OVERRIDES_IAM',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'GCP_PRIVATE_KEY',
        'LAMBDA_API_KEY',
        'IDENTITY_ENDPOINT',
      ];
      for (const name of removed) vi.stubEnv(name, 'ambient-private-value');
      const files = new FixtureFiles(root);
      const directory = await files.executableDirectory(
        'bin',
        'aws',
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ environment: process.env, secret: 'new-private-value' }));
`,
      );
      vi.stubEnv(
        'PATH',
        `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
      );
      const artifacts = new ArtifactStore(
        path.join(root, 'artifacts'),
        new Redactor(),
      );
      await artifacts.initialize({ test: 'private command' });
      const signal = new AbortController().signal;
      const commands = new JobPrivateCommands(
        new ProcessRunner(artifacts, signal, root),
        signal,
      );
      const output = JSON.parse(
        await commands.run(
          'aws',
          ['sts', 'get-caller-identity'],
          {
            AWS_ACCESS_KEY_ID: 'original-key',
            AWS_SECRET_ACCESS_KEY: 'original-private',
          },
          Date.now() + 5_000,
        ),
      ) as {
        environment: Record<string, string>;
        secret: string;
      };
      for (const name of removed)
        expect(output.environment).not.toHaveProperty(name);
      expect(output.environment).toMatchObject({
        AWS_ACCESS_KEY_ID: 'original-key',
        AWS_SECRET_ACCESS_KEY: 'original-private',
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true',
      });
      expect(output.secret).toBe('new-private-value');
      expect(await readdir(artifacts.directory)).toEqual(['metadata.json']);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('cancels foreground pauses while a separate cleanup scope remains usable', async () => {
    const controller = new AbortController();
    const runner = {
      run: vi.fn(async () =>
        result({ exitCode: 0, stderr: '', stdout: 'cleanup-readback' }),
      ),
    };
    const foreground = new JobPrivateCommands(runner, controller.signal);
    const waiting = foreground.wait(10_000, Date.now() + 30_000);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    const cleanup = new JobPrivateCommands(
      runner,
      new AbortController().signal,
    );
    await expect(
      cleanup.run('aws', ['iam', 'get-user'], {}, Date.now() + 5_000),
    ).resolves.toBe('cleanup-readback');
    expect(runner.run).toHaveBeenCalledOnce();
  });

  test('reports a probe timeout at the wait deadline instead of an abort', async () => {
    const runner = {
      run: async (_: string, __: readonly string[], { timeoutMs = 0 }) => {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        return result({ exitCode: null, stderr: '', timedOut: true });
      },
    };
    const commands = new JobPrivateCommands(
      runner,
      new AbortController().signal,
    );
    const deadlineAt = Date.now() + 300;
    await expect(
      commands.waitFor(
        'cleanup call',
        () => commands.run('aws', ['iam', 'get-user'], {}, deadlineAt, 100),
        {
          intervalMs: 20,
          probeError: {
            retry: (error) =>
              error instanceof JobPrivateCommandFailure && error.timedOut,
          },
          unmet: () => undefined,
        },
        deadlineAt,
      ),
    ).rejects.toThrow(/cleanup call: timed out after \d+ms .*timeout=true/u);
  });

  test('rejects an exit-zero truncated inventory before it can prove native absence', async () => {
    const commands = new JobPrivateCommands(
      {
        run: async () =>
          result({
            exitCode: 0,
            stderr: '',
            stdout: '{"Reservations":[]}',
            combined: '{"Reservations":[]}',
            outputTruncated: true,
          }),
      },
      new AbortController().signal,
    );
    await expect(
      commands.run(
        'aws',
        ['ec2', 'describe-instances'],
        {},
        Date.now() + 5_000,
      ),
    ).rejects.toThrow('truncated=true');
  });

  test('does not expose a runner rejection containing private arguments', async () => {
    const commands = new JobPrivateCommands(
      {
        run: async () => {
          throw new Error('private-argv');
        },
      },
      new AbortController().signal,
    );
    const failure: unknown = await commands
      .run('az', ['login'], {}, Date.now() + 5_000)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure, { depth: 10 })).not.toContain('private-argv');
    expect(failure).not.toHaveProperty('cause');
  });
});
