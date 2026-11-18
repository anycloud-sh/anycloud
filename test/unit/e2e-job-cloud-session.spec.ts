import { inspect } from 'node:util';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import {
  jobNativeSessionFixture,
  JOB_NATIVE_CREDENTIALS,
} from '../helpers/e2e-job-native.js';
import { privateJobOutput } from '../integration/e2e/internal/transports/job-command.js';
import { commandResultForTest } from './helpers/e2e.js';

afterEach(() => vi.restoreAllMocks());

describe('Job private command failure classification', () => {
  test.each([
    [
      'timeout',
      { exitCode: null, signal: 'SIGTERM' as const, timedOut: true },
      'timeout; exit=null, signal=SIGTERM, timeout=true',
    ],
    ['aborted', { exitCode: null, aborted: true }, 'aborted; exit=null'],
    [
      'gcloud usage error',
      {
        executable: 'gcloud' as const,
        exitCode: 2,
        stderr:
          'ERROR: (gcloud.compute.instances.delete) unrecognized arguments: --async\n',
      },
      'gcloud usage error (unrecognized argument); exit=2',
    ],
    [
      'native code',
      {
        executable: 'gcloud' as const,
        exitCode: 1,
        stderr:
          'ERROR: (gcloud.compute.instances.delete) PERMISSION_DENIED: no\n',
      },
      'PERMISSION_DENIED; exit=1',
    ],
    [
      'unknown',
      { exitCode: 1, stderr: 'something else' },
      'unclassified; exit=1',
    ],
  ])('names a %s', (_label, overrides, expected) => {
    expect(
      () => privateJobOutput(commandResultForTest(overrides)),
      // The message carries the receipt fields, never provider output.
    ).toThrow(`Job private command failed: ${expected}`);
  });
});
const privateToken = 'private-new-session-token';
const bucketUrl = new URL(
  'https://storage.googleapis.com/storage/v1/b/original-bucket',
);

describe('Job original native authorization session', () => {
  test.each(['aws', 'gcp', 'azure'] as const)(
    'initializes %s only with frozen selected credentials and private command receipts',
    async (provider) => {
      const credential = { ...JOB_NATIVE_CREDENTIALS[provider] };
      const world = jobNativeSessionFixture(credential);
      await world.session.initialize(Date.now() + 10_000);
      expect(Object.isFrozen(world.session.credential)).toBe(true);
      expect(world.calls.length).toBeGreaterThan(0);
      for (const call of world.calls) {
        expect(call.options).toMatchObject({
          recordArtifact: false,
          signal: world.foreground.signal,
        });
        expect(call.options?.timeoutMs).toBeLessThanOrEqual(10_000);
      }
      expect(world.calls[0].options?.env).toMatchObject({
        AWS_CONFIG_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true',
      });
      if (provider === 'aws') {
        expect(world.session.accountId).toBe('123456789012');
        expect(world.calls[0].args).toContain(
          'https://sts.us-east-1.amazonaws.com',
        );
        expect(world.calls[0].options?.env).toMatchObject({
          AWS_ACCESS_KEY_ID: 'original-access',
        });
      } else if (provider === 'gcp') {
        expect(world.session.projectNumber).toBe('1234567890');
        expect(world.calls[0].args).toContain('--project=original-project');
        expect(world.calls[0].args).toContain(
          '--account=original@original-project.iam.gserviceaccount.com',
        );
        expect(JSON.parse(world.privateFiles[0].contents)).toMatchObject({
          private_key: 'private-original-gcp',
        });
      } else {
        expect(world.calls[0].args).toContain(
          '--password=private-original-azure',
        );
        expect(world.calls[1].args).toContain(
          JOB_NATIVE_CREDENTIALS.azure.subscriptionId,
        );
        expect(world.calls[0].options?.env?.AZURE_CONFIG_DIR).toBe(
          '/private-test/job-native-original-native/azure',
        );
        // A detached telemetry uploader would write here after az returns.
        expect(world.calls[0].options?.env?.AZURE_CORE_COLLECT_TELEMETRY).toBe(
          'false',
        );
      }
    },
  );

  test('registers new HTTP tokens before the request and uses an independent cleanup cancellation scope', async () => {
    const world = jobNativeSessionFixture(
      JOB_NATIVE_CREDENTIALS.gcp,
      () => privateToken,
    );
    await world.session.initialize(Date.now() + 10_000);
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, options) => {
        expect(world.redactor.text(privateToken)).not.toContain(privateToken);
        expect(options?.headers).toEqual({
          Authorization: `Bearer ${privateToken}`,
        });
        expect(options?.redirect).toBe('error');
        return new Response('{"kind":"storage#bucket"}', { status: 200 });
      });
    world.foreground.abort(new Error('foreground cancelled'));
    await expect(
      world.session.get(bucketUrl, Date.now() + 5_000),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      world.session.get(bucketUrl, Date.now() + 5_000, true),
    ).resolves.toEqual({ status: 200, body: { kind: 'storage#bucket' } });
    expect(world.calls.at(-1)?.options?.signal).toBe(world.cleanup.signal);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    'https://foreign.invalid/storage/v1/b/original-bucket',
    'https://storage.googleapis.com/compute/v1/projects/foreign',
    'https://user:private@storage.googleapis.com/storage/v1/b/original-bucket',
    'https://storage.googleapis.com/storage/v1/b/original-bucket#fragment',
  ])(
    'rejects a changed authorized HTTP URL before token acquisition: %s',
    async (url) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.gcp);
      await expect(
        world.session.get(new URL(url), Date.now() + 5_000),
      ).rejects.toThrow('authorized');
      expect(world.calls).toHaveLength(0);
    },
  );

  test.each(['redirect', 'malformed', 'network', 'body-deadline'] as const)(
    'rejects %s without leaking native response causes',
    async (failure) => {
      const world = jobNativeSessionFixture(
        JOB_NATIVE_CREDENTIALS.gcp,
        () => privateToken,
      );
      await world.session.initialize(Date.now() + 5_000);
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => {
          if (failure === 'network')
            throw new Error(`transport ${privateToken}`);
          if (failure === 'redirect')
            return new Response('', {
              status: 302,
              headers: { location: `https://foreign.invalid/${privateToken}` },
            });
          if (failure === 'malformed') return new Response(privateToken);
          const response = new Response('{}');
          vi.spyOn(response, 'text').mockImplementation(
            () => new Promise<string>(() => undefined),
          );
          return response;
        });
      const result: unknown = await world.session
        .get(bucketUrl, Date.now() + (failure === 'body-deadline' ? 25 : 5_000))
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(inspect(result, { depth: 10 })).not.toContain(privateToken);
      expect(result).not.toHaveProperty('cause');
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );

  test.each([
    ['46', 46_000],
    ['Wed, 14 Oct 2026 19:30:30 GMT', 30_000],
    [null, undefined],
  ] as const)(
    'reports an Azure 429 Retry-After of %s as %s ms',
    async (header, expected) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse('2026-10-14T19:30:00Z'));
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure, () =>
        JSON.stringify({
          accessToken: privateToken,
          subscription: JOB_NATIVE_CREDENTIALS.azure.subscriptionId,
          tenant: JOB_NATIVE_CREDENTIALS.azure.directoryId,
        }),
      );
      await world.session.initialize(Date.now() + 5_000);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"error":{"code":"TooManyRequests"}}', {
          status: 429,
          headers: header ? { 'retry-after': header } : {},
        }),
      );
      await expect(
        world.session.get(
          new URL(
            `https://management.azure.com/subscriptions/${JOB_NATIVE_CREDENTIALS.azure.subscriptionId}/resourceGroups/original`,
          ),
          Date.now() + 5_000,
        ),
      ).resolves.toEqual({
        status: 429,
        body: { error: { code: 'TooManyRequests' } },
        retryAfterMs: expected,
      });
    },
  );

  test.each(['subscription', 'tenant'] as const)(
    'rejects an Azure token with a foreign %s',
    async (field) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure, () =>
        JSON.stringify({
          accessToken: privateToken,
          subscription: JOB_NATIVE_CREDENTIALS.azure.subscriptionId,
          tenant: JOB_NATIVE_CREDENTIALS.azure.directoryId,
          [field]: 'foreign',
        }),
      );
      await world.session.initialize(Date.now() + 5_000);
      const fetcher = vi.spyOn(globalThis, 'fetch');
      await expect(
        world.session.get(
          new URL(
            `https://management.azure.com/subscriptions/${JOB_NATIVE_CREDENTIALS.azure.subscriptionId}/resourceGroups/original`,
          ),
          Date.now() + 5_000,
        ),
      ).rejects.toThrow('changed tenant or subscription');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
