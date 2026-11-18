import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupAWSGenerationFixture,
  readAWSGeneratedUser,
  readAWSGenerationOwnership,
} from '../../integration/credentials-onboarding/aws/generation-fixture.js';
import { AWSCliError } from '../../../src/cli/services/credential-bootstrap/aws-cli-runner.js';
import { cleanupAWSGeneration } from '../../../src/cli/services/credential-bootstrap/aws.js';

vi.mock(
  '../../../src/cli/services/credential-bootstrap/aws.js',
  async (importActual) => ({
    ...(await importActual<
      typeof import('../../../src/cli/services/credential-bootstrap/aws.js')
    >()),
    cleanupAWSGeneration: vi.fn(),
  }),
);

const clusterRecords: string[] = [];
beforeEach(() => {
  vi.mocked(cleanupAWSGeneration).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const root of clusterRecords.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Job 114704503429: list-attached-user-policies failed once with a
// connection timeout, which the product runner does not retry for it.
describe('AWS generated-user policy reads', () => {
  it('retries a transient failure but not a denial', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new AWSCliError('timed out', undefined, 'connection timeout'),
      )
      .mockResolvedValue('{}');
    await expect(readAWSGeneratedUser(read, wait)).resolves.toBe('{}');
    expect(read).toHaveBeenCalledTimes(2);

    const denied = new AWSCliError(
      'denied',
      'AccessDenied',
      'permission denied',
    );
    const refused = vi.fn<() => Promise<string>>().mockRejectedValue(denied);
    await expect(readAWSGeneratedUser(refused, wait)).rejects.toBe(denied);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('AWS generation CI creation evidence', () => {
  it('0038/S2 preserves the returned UserId across later lookups and records only non-secret key metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aws-recording-test-'));
    clusterRecords.push(root);
    const recordPath = join(root, 'ownership.json');
    const fakeAWS = join(root, 'aws');
    const expected = {
      userName: 'anycloud-onb-gen-abc123',
      accountId: '123456789012',
    };
    await writeFile(
      fakeAWS,
      `#!${process.execPath}
const command = process.argv[3];
const User = { UserName: '${expected.userName}', UserId: command === 'create-user' ? 'AIDA-CREATION' : 'AIDA-REPLACEMENT', Arn: 'arn:aws:iam::${expected.accountId}:user/${expected.userName}' };
process.stdout.write(JSON.stringify(command === 'create-access-key' ? { AccessKey: { UserName: User.UserName, AccessKeyId: 'AKIA-CREATED', SecretAccessKey: 'NEVER-RECORD-THIS-SECRET' } } : { User }));
`,
      { mode: 0o755 },
    );
    const run = (command: string) =>
      promisify(execFile)(
        process.execPath,
        [
          resolve(
            'test/integration/credentials-onboarding/aws/recording-cli.mjs',
          ),
          'iam',
          command,
          '--user-name',
          expected.userName,
          '--tags',
          JSON.stringify([
            {
              Key: 'anycloud:generation-id',
              Value: '00000000-0000-4000-8000-000000000001',
            },
          ]),
        ],
        {
          env: {
            ...process.env,
            ANYCLOUD_TEST_REAL_AWS: fakeAWS,
            ANYCLOUD_TEST_AWS_OWNERSHIP: recordPath,
            ANYCLOUD_TEST_AWS_USER: expected.userName,
            ANYCLOUD_TEST_AWS_ACCOUNT: expected.accountId,
          },
        },
      );
    await run('create-user');
    await run('get-user');
    await run('create-access-key');
    const owned = await readAWSGenerationOwnership(recordPath, expected);
    expect(owned.userId).toBe('AIDA-CREATION');
    expect(owned.accessKeyIds).toEqual(['AKIA-CREATED']);
    expect(JSON.stringify(owned)).not.toContain('NEVER-RECORD');
    await expect(
      readAWSGenerationOwnership(recordPath, {
        ...expected,
        accountId: '999999999999',
      }),
    ).rejects.toThrow('different invocation target');
  });

  it('0038/S2 missing creation evidence requires manual handling without a cloud lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aws-missing-record-'));
    clusterRecords.push(root);
    await expect(
      readAWSGenerationOwnership(join(root, 'missing.json'), {
        userName: 'anycloud-onb-gen-abc123',
        accountId: '123456789012',
      }),
    ).rejects.toThrow('No name-based cleanup is allowed');
    const deleteAPICredential = vi.fn();
    await expect(
      cleanupAWSGenerationFixture(
        {
          operator: { profile: 'operator', environment: {} },
          recordPath: join(root, 'missing.json'),
          userName: 'anycloud-onb-gen-abc123',
          accountId: '123456789012',
        },
        deleteAPICredential,
      ),
    ).rejects.toThrow('No name-based cleanup is allowed');
    expect(cleanupAWSGeneration).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    '0038/S2 attempts owned IAM teardown after API deletion fails (IAM also fails: %s)',
    async (iamFails) => {
      const root = await mkdtemp(join(tmpdir(), 'aws-fixture-cleanup-'));
      clusterRecords.push(root);
      const owned = {
        userName: 'anycloud-onb-gen-abc123',
        accountId: '123456789012',
        userId: 'AIDA-CREATION',
        invocationId: '00000000-0000-4000-8000-000000000001',
        accessKeyIds: ['AKIA-CREATED'],
        inlinePolicyNames: [],
      };
      const fixture = {
        ...owned,
        operator: { profile: 'operator', environment: {} },
        recordPath: join(root, 'ownership.json'),
      };
      await writeFile(fixture.recordPath, JSON.stringify(owned), {
        mode: 0o600,
      });
      const apiFailure = new Error('temporary API unavailable');
      const iamFailure = new Error('IAM cleanup rejected');
      const deleteAPICredential = vi.fn().mockRejectedValue(apiFailure);
      const log = vi.spyOn(console, 'info').mockImplementation(() => {});
      if (iamFails)
        vi.mocked(cleanupAWSGeneration).mockRejectedValue(iamFailure);

      await expect(
        cleanupAWSGenerationFixture(fixture, deleteAPICredential),
      ).rejects.toMatchObject({
        errors: iamFails ? [apiFailure, iamFailure] : [apiFailure],
        message: expect.stringContaining(owned.userId),
      });
      expect(cleanupAWSGeneration).toHaveBeenCalledExactlyOnceWith(
        fixture.operator,
        owned,
      );
      for (const value of [owned.accountId, owned.userId, owned.invocationId]) {
        expect(log.mock.calls.flat().join(' ')).toContain(value);
      }
      expect(log.mock.invocationCallOrder[0]).toBeLessThan(
        deleteAPICredential.mock.invocationCallOrder[0],
      );
    },
  );
});
