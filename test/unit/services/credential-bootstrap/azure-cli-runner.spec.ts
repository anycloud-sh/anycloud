import { execa } from 'execa';
import { getEventListeners } from 'node:events';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AzureCliCommandError,
  runAzureCli,
} from '../../../../src/cli/services/credential-bootstrap/azure-cli-runner.js';
import { cliFixture, shortenCliDeadline } from './cli-fixture.js';

vi.mock('execa', { spy: true });
afterEach(() => vi.clearAllMocks());

describe('Azure CLI argument runner', () => {
  it('executes literal argv with bounded defaults and exact output', async () => {
    const fixture = await cliFixture('az', {
      stdout: '{"id":"sub-123"}\r\n\n',
      environment: ['AZURE_CONFIG_DIR'],
    });
    vi.stubEnv('AZURE_CONFIG_DIR', 'selected-config');
    const args = ['account', 'show', '--query', 'literal;$(no-shell)'];
    const controller = new AbortController();
    await expect(
      runAzureCli(args, { signal: controller.signal }),
    ).resolves.toBe('{"id":"sub-123"}\r\n\n');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(await fixture.signalCount()).toBe(0);
    expect(await fixture.observed()).toMatchObject({
      args,
      env: { AZURE_CONFIG_DIR: 'selected-config' },
    });
    expect(execa).toHaveBeenCalledWith(
      'az',
      args,
      expect.objectContaining({
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: 'latin1',
        extendEnv: false,
        windowsHide: true,
        forceKillAfterDelay: false,
        verbose: 'none',
      }),
    );
  });

  it.each([
    {
      stderr: JSON.stringify({
        error: {
          code: 'AuthorizationFailed',
          message: 'Permission denied for José.',
          statusCode: 403,
          innerError: { 'request-id': 'request-123' },
        },
      }),
      expected: {
        code: 'AuthorizationFailed',
        statusCode: 403,
        requestId: 'request-123',
        message: 'Permission denied for José.',
      },
    },
    {
      stderr:
        'ERROR: (PrincipalNotFound) Principal is not in the directory.\nCode: PrincipalNotFound\nMessage: Principal is not in the directory.\nRequest ID: request-456',
      expected: {
        code: 'PrincipalNotFound',
        requestId: 'request-456',
        message: 'Principal is not in the directory.',
      },
    },
  ])(
    'preserves provider details without exposing argv ($expected.code)',
    async ({ stderr, expected }) => {
      await cliFixture('az', { exitCode: 1, stderr });
      const controller = new AbortController();
      const error = await runAzureCli(
        ['role', 'assignment', 'create', '--scope', 'PRIVATE-SCOPE'],
        { signal: controller.signal },
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AzureCliCommandError);
      expect(error).toMatchObject({
        ...expected,
        exitCode: 1,
        aborted: false,
        timedOut: false,
        mayHaveSucceeded: false,
      });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
        'PRIVATE-',
      );
      expect(execa).toHaveBeenCalledTimes(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );

  it('returns cancellation immediately when the child ignores SIGTERM', async () => {
    const fixture = await cliFixture('az', {
      wait: true,
      ignoreSigterm: true,
      stdout: 'PRIVATE-OUTPUT',
    });
    const controller = new AbortController();
    let error: unknown;
    const pending = runAzureCli(['rest'], { signal: controller.signal }).catch(
      (value: unknown) => {
        error = value;
      },
    );
    try {
      const { pid } = await vi.waitFor(fixture.observed);
      controller.abort(new Error('PRIVATE-REASON'));
      await vi.waitFor(() =>
        expect(error).toMatchObject({
          code: 'ABORT_ERR',
          exitCode: undefined,
          aborted: true,
          timedOut: false,
          mayHaveSucceeded: true,
        }),
      );
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
        'PRIVATE-',
      );
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      await vi.waitFor(async () => expect(await fixture.signalCount()).toBe(1));
      expect(process.kill(pid, 0)).toBe(true);
    } finally {
      await fixture.cleanup();
      await pending;
    }
  });

  it.each(['stdout', 'stderr'] as const)(
    'times out while a helper retains %s',
    async (holdPipe) => {
      const fixture = await cliFixture('az', { wait: true, holdPipe });
      await shortenCliDeadline();
      const controller = new AbortController();
      let error: unknown;
      const pending = runAzureCli(['probe'], {
        signal: controller.signal,
      }).catch((value: unknown) => {
        error = value;
      });
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(
          async () => expect(await fixture.signalCount()).toBe(1),
          { timeout: 2_000 },
        );
        await vi.waitFor(() =>
          expect(error).toMatchObject({
            timedOut: true,
            aborted: false,
            mayHaveSucceeded: true,
          }),
        );
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(process.kill(helperPid!, 0)).toBe(true);
        expect(await fixture.signalCount()).toBe(1);
      } finally {
        await fixture.cleanup();
        await pending;
      }
    },
  );

  it('keeps a zero timeout disabled', async () => {
    const fixture = await cliFixture('az', { stdout: 'ready\n' });
    await expect(runAzureCli(['probe'], { timeoutMs: 0 })).resolves.toBe(
      'ready\n',
    );
    expect(await fixture.signalCount()).toBe(0);
  });

  it('marks real timeouts as ambiguous', async () => {
    await cliFixture('az', { wait: true });
    const controller = new AbortController();
    await expect(
      runAzureCli(['rest'], { timeoutMs: 100, signal: controller.signal }),
    ).rejects.toMatchObject({
      message: 'Azure CLI command timed out after 100ms.',
      timedOut: true,
      aborted: false,
      mayHaveSucceeded: true,
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each([true, false])(
    'preserves cancellation without leaking its reason (already aborted: %s)',
    async (alreadyAborted) => {
      const fixture = await cliFixture('az', { wait: true });
      const controller = new AbortController();
      if (alreadyAborted) controller.abort(new Error('PRIVATE-REASON'));
      const pending = runAzureCli(['rest', '--body', 'PRIVATE-BODY'], {
        signal: controller.signal,
      }).catch((value: unknown) => value);
      try {
        if (!alreadyAborted) {
          await vi.waitFor(async () =>
            expect((await fixture.observed()).pid).toBeGreaterThan(0),
          );
          controller.abort(new Error('PRIVATE-REASON'));
        }
        const error = await pending;
        expect(error).toMatchObject({
          code: 'ABORT_ERR',
          message: 'Azure CLI command was canceled.',
          aborted: true,
          timedOut: false,
          mayHaveSucceeded: true,
        });
        expect(error).not.toHaveProperty('cause');
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
          'PRIVATE-',
        );
        expect(execa).toHaveBeenCalledTimes(1);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        await fixture.cleanup();
        await pending;
      }
    },
  );

  it.each(['stdout', 'stderr'] as const)(
    'enforces an independent byte cap on %s',
    async (stream) => {
      const limit = 'é'.repeat(512 * 1024);
      const fixture = await cliFixture('az', { stdout: limit, stderr: limit });
      await expect(runAzureCli(['probe'])).resolves.toBe(limit);
      await fixture.respond({
        [stream]: limit + 'PRIVATE-OVERFLOW',
        wait: true,
        holdPipe: stream === 'stdout' ? 'stderr' : 'stdout',
      });
      const controller = new AbortController();
      let error: unknown;
      const pending = runAzureCli(['probe'], {
        signal: controller.signal,
      }).catch((value: unknown) => {
        error = value;
      });
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(() =>
          expect(error).toMatchObject({
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            message: 'Azure CLI output exceeded the 1048576-byte limit.',
            exitCode: undefined,
            timedOut: false,
            aborted: false,
            mayHaveSucceeded: true,
          }),
        );
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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

  it('redacts secrets from both streams, bearer tokens, and formatted launch errors', async () => {
    const markerToken = `eyJ${'a'.repeat(32)}`;
    const fixture = await cliFixture('az', {
      exitCode: 1,
      stdout: JSON.stringify({ secretText: 'PRIVATE-GENERATED' }),
      stderr: JSON.stringify({
        error: {
          code: 'CredentialFailure',
          message: `clientSecret=PRIVATE-GENERATED Bearer ${markerToken} unexpected PRIVATE-STDERR`,
          secretText: 'PRIVATE-STDERR',
        },
      }),
    });
    const error = await runAzureCli([
      'rest',
      '--body',
      'PRIVATE-ARGUMENT',
    ]).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'CredentialFailure' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(
      /PRIVATE-|eyJ/,
    );
    for (const property of ['stdout', 'stderr', 'cause', 'command'])
      expect(error).not.toHaveProperty(property);
    await rm(fixture.executable);
    await expect(runAzureCli(['probe'])).rejects.toMatchObject({
      code: 'ENOENT',
      mayHaveSucceeded: false,
    });
    const invalid = await runAzureCli(['PRIVATE\0ARGUMENT']).catch(
      (value: unknown) => value,
    );
    expect(invalid).toBeInstanceOf(AzureCliCommandError);
    expect(`${String(invalid)} ${JSON.stringify(invalid)}`).not.toContain(
      'PRIVATE',
    );
  });
});
