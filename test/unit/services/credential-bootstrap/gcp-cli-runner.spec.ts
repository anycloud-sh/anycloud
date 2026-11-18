import { execa } from 'execa';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGcloud } from '../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import { cliFixture, shortenCliDeadline } from './cli-fixture.js';

vi.mock('execa', { spy: true });
afterEach(() => vi.clearAllMocks());

describe('GCP CLI subprocess containment', () => {
  it('preserves argv and newlines while excluding ambient credentials', async () => {
    const fixture = await cliFixture('gcloud', {
      stdout: 'selected-token\r\n\n',
      environment: [
        'GOOGLE_APPLICATION_CREDENTIALS',
        'CLOUDSDK_CONFIG',
        'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
        'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
        'CLOUDSDK_CORE_LOG_HTTP',
        'CLI_AMBIENT_MARKER',
      ],
    });
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', 'PRIVATE-AMBIENT-KEY');
    vi.stubEnv('CLI_AMBIENT_MARKER', 'PRIVATE-AMBIENT');
    await expect(
      runGcloud(
        ['auth', 'print-access-token', '--account=selected@example.com'],
        {
          ...fixture.environment,
          CLOUDSDK_CONFIG: 'selected-config',
          CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'wrong',
        },
      ),
    ).resolves.toBe('selected-token\r\n\n');
    expect(await fixture.observed()).toMatchObject({
      args: [
        'auth',
        'print-access-token',
        '--account=selected@example.com',
        '--quiet',
        '--verbosity=error',
      ],
      env: {
        CLOUDSDK_CONFIG: 'selected-config',
        CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '',
        CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '',
        CLOUDSDK_CORE_LOG_HTTP: 'false',
      },
    });
    expect((await fixture.observed()).env).not.toHaveProperty(
      'GOOGLE_APPLICATION_CREDENTIALS',
    );
    expect((await fixture.observed()).env).not.toHaveProperty(
      'CLI_AMBIENT_MARKER',
    );
    expect(execa).toHaveBeenCalledWith(
      'gcloud',
      expect.any(Array),
      expect.objectContaining({
        timeout: 30_000,
        extendEnv: false,
        forceKillAfterDelay: false,
      }),
    );
    expect(await fixture.signalCount()).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)(
    'bounds %s in bytes and never exposes tokens',
    async (stream) => {
      const limit = 'é'.repeat(512 * 1024);
      const fixture = await cliFixture('gcloud', {
        stdout: limit,
        stderr: limit,
      });
      await expect(runGcloud(['probe'], fixture.environment)).resolves.toBe(
        limit,
      );
      await fixture.respond({
        [stream]: limit + 'PRIVATE-TOKEN',
        wait: true,
        holdPipe: stream === 'stdout' ? 'stderr' : 'stdout',
      });
      let error: unknown;
      const pending = runGcloud(
        ['PRIVATE-ARGUMENT'],
        fixture.environment,
      ).catch((value: unknown) => {
        error = value;
      });
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(() =>
          expect(String(error)).toContain(
            'Could not use the selected gcloud login.',
          ),
        );
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
          'PRIVATE-',
        );
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
      const fixture = await cliFixture('gcloud', { wait: true, holdPipe });
      await shortenCliDeadline();
      let error: unknown;
      const pending = runGcloud(['probe'], fixture.environment).catch(
        (value: unknown) => {
          error = value;
        },
      );
      try {
        const { pid, helperPid } = await vi.waitFor(fixture.observed);
        await vi.waitFor(
          async () => expect(await fixture.signalCount()).toBe(1),
          { timeout: 2_000 },
        );
        await vi.waitFor(() =>
          expect(String(error)).toContain(
            'Could not use the selected gcloud login.',
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

  it('redacts exits, timeouts, and launch errors without replaying commands', async () => {
    const fixture = await cliFixture('gcloud', {
      exitCode: 1,
      stdout: 'PRIVATE-TOKEN',
      stderr: 'PRIVATE-KEY',
    });
    await expect(
      runGcloud(['PRIVATE-ARGUMENT'], fixture.environment),
    ).rejects.toThrow('Could not use the selected gcloud login.');
    vi.mocked(execa).mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE-FORMATTED-ERROR'), { timedOut: true }),
    );
    await expect(runGcloud(['probe'], fixture.environment)).rejects.toThrow(
      'Could not use the selected gcloud login.',
    );
    await rm(fixture.executable);
    await expect(runGcloud(['probe'], fixture.environment)).rejects.toThrow(
      'Google Cloud CLI is not installed.',
    );
    await expect(
      runGcloud(['PRIVATE\0ARGUMENT'], fixture.environment),
    ).rejects.toThrow('Could not use the selected gcloud login.');
    expect(execa).toHaveBeenCalledTimes(4);
  });
});
