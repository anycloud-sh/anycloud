import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, onTestFinished, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import {
  AwsJobImportFixture,
  SYNCHRONOUS_IAM_MUTATION_MS,
} from '../integration/e2e/internal/transports/job-aws-credential.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';

const account = '123456789012';
const name = 'bkt-12345';
const original = {
  UserName: `anycloud-${name}`,
  UserId: 'AIDAORIGINAL1234567890',
  Arn: `arn:aws:iam::${account}:user/anycloud-${name}`,
};
const keyId = 'AKIAIMPORTED123456789';
const secret = 'generated-private-aws-value';

async function withFixture(
  use: (world: {
    fixture: AwsJobImportFixture;
    controller: AbortController;
    calls: Array<{ args: readonly string[]; options: CommandOptions }>;
    records: unknown[];
    redactor: Redactor;
    state: {
      user: typeof original | undefined;
      loseCreation: boolean;
      failSecondPage: boolean;
      malformedKeys: boolean;
      iamFaults: Record<string, string[]>;
      readinessFailures: number;
      readinessCalls: number;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'job-aws-fixture-'));
  try {
    const controller = new AbortController();
    const calls: Array<{ args: readonly string[]; options: CommandOptions }> =
      [];
    const records: unknown[] = [];
    const iamFaults: Record<string, string[]> = {};
    const state = {
      user: undefined as typeof original | undefined,
      loseCreation: false,
      failSecondPage: false,
      malformedKeys: false,
      iamFaults,
      readinessFailures: 0,
      readinessCalls: 0,
    };
    const run = async (
      executable: string,
      args: readonly string[],
      options: CommandOptions = {},
    ): Promise<CommandResult> => {
      calls.push({ args, options });
      options.signal?.throwIfAborted();
      let body: unknown = {};
      let stderr = '';
      const failure = (code: string, operation: string): void => {
        stderr = `An error occurred (${code}) when calling the ${operation} operation: withheld-private-detail`;
      };
      const operation = args[1];
      const fault = state.iamFaults[operation]?.shift();
      if (fault && fault !== 'timeout') failure(fault, 'IamCleanup');
      if (fault) {
        // An injected fault answers instead of the fake IAM.
      } else if (args[0] === 'sts')
        body =
          options.env?.AWS_ACCESS_KEY_ID === keyId
            ? { Account: account, Arn: original.Arn, UserId: original.UserId }
            : {
                Account: account,
                Arn: `arn:aws:iam::${account}:user/bootstrap`,
                UserId: 'AIDABOOTSTRAP12345678',
              };
      else if (args[0] === 's3api') {
        state.readinessCalls += 1;
        if (state.readinessFailures-- > 0)
          failure('InvalidAccessKeyId', 'ListBuckets');
        body = { Buckets: [] };
      } else if (operation === 'get-user') {
        if (state.user?.UserName === original.UserName)
          body = { User: state.user };
        else failure('NoSuchEntity', 'GetUser');
      } else if (operation === 'create-user') {
        state.user = { ...original };
        if (state.loseCreation) throw new Error('lost-private-creation-reply');
        body = { User: state.user };
      } else if (operation === 'create-access-key')
        body = {
          AccessKey: {
            UserName: original.UserName,
            AccessKeyId: keyId,
            SecretAccessKey: secret,
          },
        };
      else if (operation === 'list-users')
        body = state.failSecondPage
          ? args.includes('--marker')
            ? { Users: 'unvalidated', IsTruncated: false }
            : {
                Users: state.user ? [state.user] : [],
                IsTruncated: true,
                Marker: 'next',
              }
          : { Users: state.user ? [state.user] : [], IsTruncated: false };
      else if (operation === 'list-user-tags')
        body = {
          Tags: [
            { Key: 'anycloud:managed', Value: 'true' },
            { Key: 'anycloud:credential-name', Value: name },
          ],
          IsTruncated: false,
        };
      else if (operation === 'list-access-keys')
        body = {
          AccessKeyMetadata: state.malformedKeys
            ? [{ AccessKeyId: keyId }]
            : [
                {
                  UserName: original.UserName,
                  AccessKeyId: keyId,
                  Status: 'Active',
                },
              ],
          IsTruncated: false,
        };
      else if (operation === 'list-user-policies')
        body = { PolicyNames: ['AnycloudAccess'], IsTruncated: false };
      else if (operation === 'list-attached-user-policies')
        body = { AttachedPolicies: [], IsTruncated: false };
      else if (operation === 'delete-user') state.user = undefined;
      const stdout = stderr || fault ? '' : JSON.stringify(body);
      return {
        executable,
        args: [...args],
        exitCode: fault === 'timeout' ? null : stderr ? 255 : 0,
        signal: null,
        stdout,
        stderr,
        combined: stdout || stderr,
        durationMs: 1,
        timedOut: fault === 'timeout',
        aborted: false,
        outputTruncated: false,
      };
    };
    const bootstrap = {
      cloudProvider: CloudType.AWS as const,
      accessKeyId: 'bootstrap-key',
      secretAccessKey: 'bootstrap-private',
    };
    const redactor = new Redactor();
    const fixture = new AwsJobImportFixture({
      name,
      bootstrap,
      commands: new JobPrivateCommands({ run }, controller.signal),
      cleanupCommands: new JobPrivateCommands(
        { run },
        new AbortController().signal,
      ),
      files: new FixtureFiles(root),
      artifacts: {
        json: async (_label, data) => {
          records.push(data);
          return '';
        },
      },
      redactor,
    });
    bootstrap.accessKeyId = 'mutated-after-registration';
    await use({ fixture, controller, calls, records, state, redactor });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('Job AWS import credential ownership', () => {
  test('retains original bootstrap identity, uses the imported key for readiness and proves full native absence', async () => {
    await withFixture(async ({ fixture, calls, records, state }) => {
      expect(await fixture.create(Date.now() + 30_000)).toEqual({
        cloudProvider: CloudType.AWS,
        accessKeyId: keyId,
        secretAccessKey: secret,
      });
      expect(
        calls.find(({ args }) => args[0] === 'sts')?.options.env
          ?.AWS_ACCESS_KEY_ID,
      ).toBe('bootstrap-key');
      expect(
        calls.find(({ args }) => args[0] === 's3api')?.options.env
          ?.AWS_ACCESS_KEY_ID,
      ).toBe(keyId);
      await fixture.remove(Date.now() + 30_000);
      expect(state.user).toBeUndefined();
      expect(records.at(-1)).toMatchObject({
        state: 'absent',
        user: { UserId: original.UserId },
      });
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['iam', 'list-users']);
      expect(
        calls.every(({ options }) => options.recordArtifact === false),
      ).toBe(true);
      expect(JSON.stringify(records)).not.toContain(secret);
    });
  });

  test('redacts the account ID before a provider error can name it', async () => {
    await withFixture(async ({ fixture, redactor }) => {
      await fixture.create(Date.now() + 30_000);
      const denial = `User: ${original.Arn} is not authorized to perform: ec2:DescribeVpcs`;
      expect(redactor.text(denial)).not.toContain(account);
      await fixture.remove(Date.now() + 30_000);
    });
  });

  test('gives IAM cleanup mutations the synchronous budget and keeps the private cap on reads', async () => {
    await withFixture(async ({ fixture, calls }) => {
      await fixture.create(Date.now() + 600_000);
      await fixture.remove(Date.now() + 600_000);
      const budget = (operation: string) =>
        calls.find(({ args }) => args[0] === 'iam' && args[1] === operation)
          ?.options.timeoutMs;
      expect(budget('delete-user')).toBe(SYNCHRONOUS_IAM_MUTATION_MS);
      expect(budget('delete-access-key')).toBe(SYNCHRONOUS_IAM_MUTATION_MS);
      expect(budget('list-users')).toBeLessThanOrEqual(30_000);
      expect(budget('get-user')).toBeLessThanOrEqual(30_000);
    });
  });

  test('preserves InvalidAccessKeyId as a bounded new-key propagation retry', async () => {
    await withFixture(async ({ fixture, state }) => {
      state.readinessFailures = 1;
      await fixture.create(Date.now() + 30_000);
      expect(state.readinessCalls).toBe(2);
      await fixture.remove(Date.now() + 30_000);
      expect(state.user).toBeUndefined();
    });
  });

  test('does not adopt a same-name user after losing the creation response', async () => {
    await withFixture(async ({ fixture, state, calls }) => {
      state.loseCreation = true;
      await expect(fixture.create(Date.now() + 30_000)).rejects.toThrow();
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'creation reply is unresolved',
      );
      expect(state.user?.UserId).toBe(original.UserId);
      expect(calls.some(({ args }) => args[1] === 'delete-user')).toBe(false);
    });
  });

  test('rejects same-name replacement and a renamed original instead of declaring absence', async () => {
    await withFixture(async ({ fixture, state, records, calls }) => {
      await fixture.create(Date.now() + 30_000);
      state.user = { ...original, UserId: 'AIDAREPLACED1234567890' };
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'changed identity',
      );
      state.user = {
        ...original,
        UserName: 'renamed-original',
        Arn: `arn:aws:iam::${account}:user/renamed-original`,
      };
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'possibly under another name',
      );
      expect(calls.some(({ args }) => args[1] === 'delete-user')).toBe(false);
      expect(JSON.stringify(records)).not.toContain('"state":"absent"');
    });
  });

  test('retains a validated identity prefix when a later inventory page fails', async () => {
    await withFixture(async ({ fixture, state, records }) => {
      await fixture.create(Date.now() + 30_000);
      state.failSecondPage = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'inventory is incomplete',
      );
      expect(records.at(-1)).toMatchObject({
        state: 'inventory',
        complete: false,
        validatedRows: 1,
        matchingUsers: [{ UserId: original.UserId }],
      });
      expect(state.user?.UserId).toBe(original.UserId);
    });
  });

  test('does not erase a malformed key inventory with later successful deletion', async () => {
    await withFixture(async ({ fixture, state, records }) => {
      await fixture.create(Date.now() + 30_000);
      state.malformedKeys = true;
      await expect(fixture.remove(Date.now() + 30_000)).rejects.toThrow(
        'cleanup',
      );
      expect(JSON.stringify(records)).not.toContain('"state":"absent"');
    });
  });

  test('retries IAM cleanup timeouts and throttling within the cleanup deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await withFixture(async ({ fixture, state, calls }) => {
      await fixture.create(Date.now() + 30_000);
      state.iamFaults = {
        'list-access-keys': ['timeout', 'Throttling'],
        'delete-user': ['RequestLimitExceeded'],
      };
      const removal = fixture.remove(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await removal;
      expect(state.user).toBeUndefined();
      expect(calls.some(({ args }) => args[1] === 'delete-access-key')).toBe(
        true,
      );
    });
  });

  test.each([
    ['a non-transient error', ['AccessDenied'], 1],
    ['a timeout that outlasts the deadline', Array(20).fill('timeout'), 5],
  ])(
    'records %s from IAM cleanup without hiding the leaked user',
    async (_case, faults, attempts) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      await withFixture(async ({ fixture, state, calls }) => {
        await fixture.create(Date.now() + 30_000);
        state.iamFaults = { 'list-access-keys': [...faults] };
        const removal = fixture.remove(Date.now() + 10_000);
        const rejected = expect(removal).rejects.toThrow(
          /AWS cleanup for anycloud-bkt-12345 had \d+ failure\(s\): iam list-access-keys: /u,
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await rejected;
        await expect(removal).rejects.not.toThrow('withheld-private-detail');
        expect(
          calls.filter(({ args }) => args[1] === 'list-access-keys'),
        ).toHaveLength(attempts);
      });
    },
  );

  test('performs cleanup on an independent scope after foreground cancellation', async () => {
    await withFixture(async ({ fixture, controller, state }) => {
      await fixture.create(Date.now() + 30_000);
      controller.abort();
      await fixture.remove(Date.now() + 30_000);
      expect(state.user).toBeUndefined();
    });
  });
});
