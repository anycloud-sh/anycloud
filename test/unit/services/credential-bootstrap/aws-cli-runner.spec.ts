import { execa, type Options } from 'execa';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awsOperator,
  runAWSCLI,
} from '../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js';
import { cliFixture, shortenCliDeadline } from './cli-fixture.js';

vi.mock('execa', { spy: true });
const execute: (
  file: string,
  args: readonly string[],
  options: Options,
) => ReturnType<typeof execa> = execa;
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(execute).mockReset();
  vi.useRealTimers();
});

describe('AWS CLI subprocess containment', () => {
  it('keeps literal argv, exact output, selected configuration, and an isolated identity', async () => {
    const fixture = await cliFixture('aws', {
      stdout: '{"ok":true}\r\n\n',
      environment: [
        'AWS_ACCESS_KEY_ID',
        'AWS_PROFILE',
        'AWS_CONFIG_FILE',
        'AWS_MAX_ATTEMPTS',
        'BOTO_CONFIG',
        'CLI_AMBIENT_MARKER',
      ],
    });
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'PRIVATE-AMBIENT-KEY');
    vi.stubEnv('CLI_AMBIENT_MARKER', 'PRIVATE-AMBIENT');
    const operator = awsOperator('selected', {
      ...fixture.environment,
      AWS_PROFILE: 'wrong',
      AWS_CONFIG_FILE: 'selected-config',
      AWS_MAX_ATTEMPTS: '9',
    });
    await expect(
      runAWSCLI(operator, [
        'iam',
        'get-user',
        '--user-name',
        'literal;$(no-shell)',
      ]),
    ).resolves.toBe('{"ok":true}\r\n\n');
    expect(await fixture.observed()).toMatchObject({
      args: [
        'iam',
        'get-user',
        '--user-name',
        'literal;$(no-shell)',
        '--profile',
        'selected',
        '--output',
        'json',
        '--no-cli-pager',
        '--no-cli-auto-prompt',
        '--cli-connect-timeout',
        '10',
        '--cli-read-timeout',
        '45',
      ],
      env: {
        AWS_CONFIG_FILE: 'selected-config',
        AWS_MAX_ATTEMPTS: '1',
        BOTO_CONFIG: '/dev/null',
      },
    });
    expect((await fixture.observed()).env).not.toHaveProperty(
      'AWS_ACCESS_KEY_ID',
    );
    expect((await fixture.observed()).env).not.toHaveProperty('AWS_PROFILE');
    expect((await fixture.observed()).env).not.toHaveProperty(
      'CLI_AMBIENT_MARKER',
    );
    expect(execa).toHaveBeenCalledWith(
      'aws',
      expect.any(Array),
      expect.objectContaining({
        timeout: expect.any(Number),
        extendEnv: false,
        forceKillAfterDelay: false,
      }),
    );
    expect(vi.mocked(execute).mock.calls[0][2]?.timeout).toBeGreaterThan(
      59_000,
    );
    expect(vi.mocked(execute).mock.calls[0][2]?.timeout).toBeLessThanOrEqual(
      60_000,
    );
    expect(await fixture.signalCount()).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)(
    'enforces a byte limit on %s without replay or leaked output',
    async (stream) => {
      const limit = 'é'.repeat(512 * 1024);
      const fixture = await cliFixture('aws', { stdout: limit, stderr: limit });
      const operator = awsOperator('selected', fixture.environment);
      await expect(runAWSCLI(operator, ['probe'])).resolves.toBe(limit);
      await fixture.respond({
        [stream]: limit + 'PRIVATE-OVERFLOW',
        wait: true,
        holdPipe: stream === 'stdout' ? 'stderr' : 'stdout',
      });
      let error: unknown;
      const pending = runAWSCLI(operator, ['probe']).catch((value: unknown) => {
        error = value;
      });
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(() =>
          expect(String(error)).toContain('AWS CLI command failed'),
        );
        expect(String(error)).not.toContain('PRIVATE-');
        expect(error).not.toHaveProperty('cause');
        expect(() => process.kill(pid, 0)).toThrow();
        expect(process.kill(helperPid!, 0)).toBe(true);
        expect(await fixture.signalCount()).toBe(1);
        expect(execa).toHaveBeenCalledTimes(2);
      } finally {
        await fixture.cleanup();
        await pending;
      }
    },
  );

  it.each(['stdout', 'stderr'] as const)(
    'times out while a helper retains %s',
    async (holdPipe) => {
      const fixture = await cliFixture('aws', { wait: true, holdPipe });
      await shortenCliDeadline();
      let error: unknown;
      const pending = runAWSCLI(awsOperator('selected', fixture.environment), [
        'probe',
      ]).catch((value: unknown) => {
        error = value;
      });
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(
          async () => expect(await fixture.signalCount()).toBe(1),
          { timeout: 2_000 },
        );
        await vi.waitFor(() =>
          expect(String(error)).toContain(
            'command timeout. The request may have succeeded.',
          ),
        );
        expect(() => process.kill(pid, 0)).toThrow();
        expect(process.kill(helperPid!, 0)).toBe(true);
        expect(await fixture.signalCount()).toBe(1);
      } finally {
        await fixture.cleanup();
        await pending;
      }
    },
  );

  it.each(['AccessDenied', 'PRIVATE-UNRECOGNIZED'])(
    'redacts provider failures and only retains recognized codes (%s)',
    async (code) => {
      const fixture = await cliFixture('aws', {
        exitCode: 254,
        stdout: '{"SecretAccessKey":"PRIVATE-GENERATED-KEY"}',
        stderr: `An error occurred (${code}) when calling the CreateAccessKey operation: PRIVATE-GENERATED-KEY`,
      });
      const error = await runAWSCLI(
        awsOperator('selected', fixture.environment),
        ['iam', 'create-access-key', '--user-name', 'PRIVATE-ARGUMENT'],
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: code === 'AccessDenied' ? code : undefined,
      });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
        'PRIVATE-',
      );
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('command');
      expect(execa).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves missing-tool and ambiguous timeout diagnostics', async () => {
    const fixture = await cliFixture('aws');
    const operator = awsOperator('selected', fixture.environment);
    await rm(fixture.executable);
    await expect(runAWSCLI(operator, ['probe'])).rejects.toThrow(
      'AWS CLI is not installed.',
    );
    vi.mocked(execute).mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE-FORMATTED-ERROR'), {
        timedOut: true,
        stderr: 'PRIVATE-DIAGNOSTIC',
      }),
    );
    await expect(runAWSCLI(operator, ['probe'])).rejects.toThrow(
      'command timeout. The request may have succeeded.',
    );
    expect(execa).toHaveBeenCalledTimes(2);
  });
});

describe('AWS CLI read and idempotent delete recovery', () => {
  const operator = awsOperator('selected', {});
  const transientError = (stderr: string) =>
    Object.assign(new Error('PRIVATE-FORMATTED-ERROR'), {
      stderr,
      stdout: 'PRIVATE-RESPONSE',
      exitCode: 255,
    });
  const reply = { stdout: '{"ok":true}' };

  it.each([
    ['sts', 'get-caller-identity', 'Connect timeout on endpoint URL: PRIVATE'],
    ['iam', 'get-user', 'Read timeout on endpoint URL: PRIVATE'],
    [
      'iam',
      'list-user-tags',
      'Connection was closed before a valid response: PRIVATE',
    ],
    ['iam', 'get-user', 'Could not connect to the endpoint URL: PRIVATE'],
    ['iam', 'get-user', 'NameResolutionError: PRIVATE'],
    [
      'iam',
      'get-user',
      'An error occurred (Throttling) when calling the GetUser operation: PRIVATE',
    ],
    [
      'iam',
      'get-user',
      'An error occurred (ServiceFailure) when calling the GetUser operation: PRIVATE',
    ],
    ['iam', 'delete-access-key', 'Connect timeout on endpoint URL: PRIVATE'],
    ['iam', 'delete-user-policy', 'Read timeout on endpoint URL: PRIVATE'],
    ['iam', 'delete-user', 'ConnectionClosedError: PRIVATE'],
  ])('recovers %s %s after %s', async (service, command, stderr) => {
    vi.useFakeTimers();
    vi.mocked(execute, { partial: true })
      .mockRejectedValueOnce(transientError(stderr))
      .mockResolvedValueOnce(reply);
    const result = expect(
      runAWSCLI(operator, [service, command]),
    ).resolves.toBe(reply.stdout);
    await vi.runAllTimersAsync();
    await result;
    expect(execa).toHaveBeenCalledTimes(2);
    for (const [, , options] of vi.mocked(execute).mock.calls) {
      expect(options?.env).toMatchObject({ AWS_MAX_ATTEMPTS: '1' });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'AccessDenied',
    'InvalidClientTokenId',
    'ExpiredToken',
    'NoSuchEntity',
    'LimitExceeded',
    'ValidationError',
    'PRIVATE-UNKNOWN',
  ])('does not retry a provider rejection (%s)', async (code) => {
    vi.mocked(execute).mockRejectedValueOnce(
      transientError(
        `An error occurred (${code}) when calling the GetUser operation: Connect timeout on endpoint URL: PRIVATE`,
      ),
    );
    const error = await runAWSCLI(operator, ['iam', 'get-user']).catch(
      (value: unknown) => value,
    );
    expect(execa).toHaveBeenCalledTimes(1);
    expect(String(error)).toContain('IAM GetUser failed after 1 attempt');
    expect(String(error)).not.toContain('PRIVATE');
  });

  it.each([
    'Connect timeout on endpoint URL: PRIVATE',
    'An error occurred (ServiceFailure) when calling the GetSessionToken operation: PRIVATE',
    'An error occurred (Throttling) when calling the AssumeRole operation: PRIVATE',
  ])(
    'keeps a credential-process rejection terminal when it wraps %s',
    async (diagnostic) => {
      vi.useFakeTimers();
      vi.mocked(execute).mockRejectedValue(
        transientError(
          `Error when retrieving credentials from custom-process: ${diagnostic}`,
        ),
      );
      const pending = runAWSCLI(operator, ['sts', 'get-caller-identity']).catch(
        (value: unknown) => value,
      );
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({
        category: 'authentication failure',
        code: undefined,
      });
      expect(execa).toHaveBeenCalledTimes(1);
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
        'PRIVATE',
      );
    },
  );

  it('bounds repeated failures and reports only safe operation and error metadata', async () => {
    vi.useFakeTimers();
    const failure = transientError(
      'Connect timeout on endpoint URL: PRIVATE-ENDPOINT',
    );
    vi.mocked(execute)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    const pending = runAWSCLI(operator, [
      'iam',
      'get-user',
      '--user-name',
      'PRIVATE-ARGUMENT',
    ]).catch((value: unknown) => value);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(execa).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ category: 'connection timeout' });
    expect(String(error)).toMatch(
      /IAM GetUser failed after 3 attempts \(\d+ ms\): connection timeout\./,
    );
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
      'PRIVATE',
    );
    for (const property of ['cause', 'command', 'stdout', 'stderr']) {
      expect(error).not.toHaveProperty(property);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['iam', 'create-user'],
    ['iam', 'create-access-key'],
    ['iam', 'attach-user-policy'],
    ['iam', 'put-user-policy'],
    ['iam', 'detach-user-policy'],
    ['iam', 'list-attached-user-policies'],
    ['PRIVATE-SERVICE', 'PRIVATE-OPERATION'],
  ])('dispatches non-allowlisted %s %s only once', async (service, command) => {
    vi.mocked(execute).mockRejectedValueOnce(
      transientError('ConnectionClosedError: PRIVATE'),
    );
    const error = await runAWSCLI(operator, [service, command]).catch(
      (value: unknown) => value,
    );
    expect(execa).toHaveBeenCalledTimes(1);
    expect(String(error)).toContain('failed after 1 attempt');
    expect(String(error)).not.toContain('PRIVATE');
    expect(vi.mocked(execute).mock.calls[0][2]?.env).toMatchObject({
      AWS_MAX_ATTEMPTS: '1',
    });
  });

  it('includes backoff in the deadline and preserves the last classified failure', async () => {
    vi.useFakeTimers();
    vi.mocked(execute).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(
                transientError('Connect timeout on endpoint URL: PRIVATE'),
              ),
            59_900,
          );
        }) as ReturnType<typeof execa>,
    );
    const result = expect(
      runAWSCLI(operator, ['iam', 'get-user']),
    ).rejects.toThrow(
      'IAM GetUser failed after 1 attempt (60000 ms): connection timeout.',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(execa).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clips a later subprocess to the remaining deadline and terminates its capture', async () => {
    vi.useFakeTimers();
    vi.mocked(execute).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(transientError('Read timeout on endpoint URL: PRIVATE')),
            45_000,
          );
        }) as ReturnType<typeof execa>,
    );
    const kill = vi.fn();
    vi.mocked(execute).mockImplementationOnce(
      (_file, _args, options) =>
        Object.assign(
          new Promise((_, reject) => {
            options?.cancelSignal?.addEventListener(
              'abort',
              () => reject(transientError('PRIVATE-CANCELLED')),
              { once: true },
            );
          }),
          { nodeChildProcess: { killed: false }, kill },
        ) as unknown as ReturnType<typeof execa>,
    );
    const result = expect(
      runAWSCLI(operator, ['iam', 'get-user']),
    ).rejects.toThrow(
      'IAM GetUser failed after 2 attempts (60000 ms): command timeout.',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(execa).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execute).mock.calls[1][2]?.timeout).toBeLessThanOrEqual(
      14_500,
    );
    expect(vi.mocked(execute).mock.calls[1][2]?.timeout).toBeGreaterThanOrEqual(
      14_000,
    );
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a real stalled read even if the subprocess ignores SIGTERM', async () => {
    const fixture = await cliFixture('aws', {
      wait: true,
      ignoreSigterm: true,
      holdPipe: 'stdout',
    });
    await shortenCliDeadline();
    const pending = runAWSCLI(awsOperator('selected', fixture.environment), [
      'iam',
      'get-user',
    ]).catch((value: unknown) => value);
    try {
      const { pid } = await vi.waitFor(fixture.observed);
      const error = await pending;
      expect(String(error)).toContain('IAM GetUser failed after 1 attempt');
      expect(String(error)).toContain('command timeout');
      expect(() => process.kill(pid, 0)).toThrow();
      expect(execa).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
