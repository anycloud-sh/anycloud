import { execa, type Options } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awsOperator,
  awsOperatorEnvironment,
  AWSCliError,
  runAWSCLI,
} from '../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js';
import {
  AWS_INVOCATION_TAG,
  cleanupAWSGeneration,
  generateAWSCredentials,
  getAWSGenerationPreview,
  type AWSGenerationOwnership,
} from '../../../../src/cli/services/credential-bootstrap/aws.js';

vi.mock('execa', { spy: true });
const execute: (
  file: string,
  args: readonly string[],
  options: Options,
) => ReturnType<typeof execa> = execa;
vi.mock(
  '../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js')
    >()),
    runAWSCLI: vi.fn(),
  }),
);
afterEach(() => vi.useRealTimers());

const caller = {
  Account: '123456789012',
  Arn: 'arn:aws:iam::123456789012:user/operator',
  UserId: 'AIDA-OPERATOR',
};
const operator = awsOperator('operator', {});
let currentCaller: typeof caller;
let user: { UserName: string; UserId: string; Arn: string } | undefined;
let tags: { Key: string; Value: string }[];
let owned: AWSGenerationOwnership;
const mutations = new Set([
  'create-user',
  'attach-user-policy',
  'put-user-policy',
  'create-access-key',
  'delete-user',
  'delete-access-key',
  'delete-user-policy',
]);

beforeEach(() => {
  vi.resetAllMocks();
  currentCaller = { ...caller };
  user = undefined;
  tags = [];
  owned = {
    accountId: caller.Account,
    userName: 'anycloud-test',
    userId: 'AIDA-CREATED',
    invocationId: 'invocation-original',
    accessKeyIds: ['AKIA-CREATED'],
    inlinePolicyNames: ['AnycloudAccess'],
  };
  vi.mocked(runAWSCLI).mockImplementation(async (_operator, args) => {
    const command = args[1];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    if (command === 'get-caller-identity') return JSON.stringify(currentCaller);
    if (command === 'get-user') {
      if (!user) throw new AWSCliError('No user', 'NoSuchEntity');
      return JSON.stringify({ User: user });
    }
    if (command === 'create-user') {
      user = {
        UserName: after('--user-name'),
        UserId: 'AIDA-CREATED',
        Arn: `arn:aws:iam::${caller.Account}:user/${after('--user-name')}`,
      };
      tags = JSON.parse(after('--tags'));
      return JSON.stringify({ User: user });
    }
    if (command === 'list-user-tags') return JSON.stringify({ Tags: tags });
    if (command === 'create-access-key')
      return JSON.stringify({
        AccessKey: {
          UserName: user!.UserName,
          AccessKeyId: 'AKIA-CREATED',
          SecretAccessKey: 'SECRET-CREATED',
        },
      });
    if (command === 'delete-user') user = undefined;
    return '{}';
  });
});

describe('AWS generation and cleanup read recovery', () => {
  // Keep the stateful IAM model, but exercise the real runner and retry policy
  // by injecting failures at the subprocess boundary.
  async function useRealRunner(
    respond: (
      args: readonly string[],
      dispatch: () => Promise<string>,
    ) => Promise<string>,
  ): Promise<string[]> {
    const model = vi.mocked(runAWSCLI).getMockImplementation()!;
    const actual = await vi.importActual<
      typeof import('../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js')
    >('../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js');
    vi.mocked(runAWSCLI).mockImplementation(actual.runAWSCLI);
    const commands: string[] = [];
    vi.mocked(execute).mockImplementation((_file, args) => {
      commands.push(args[1]);
      return respond(args, () => model(operator, args))
        .then((stdout) => ({ stdout }))
        .catch((error: unknown) => {
          if (error instanceof AWSCliError && error.code) {
            throw Object.assign(new Error('simulated AWS CLI rejection'), {
              stderr: `An error occurred (${error.code}) when calling the test operation: rejected`,
            });
          }
          throw error;
        }) as ReturnType<typeof execa>;
    });
    return commands;
  }

  function connectionFailure(): Error {
    return Object.assign(new Error('PRIVATE-ERROR'), {
      stderr: 'Connect timeout on endpoint URL: PRIVATE-ENDPOINT',
    });
  }

  it.each(['generation', 'cleanup'] as const)(
    'recovers an interrupted %s ownership check without repeating mutations',
    async (phase) => {
      vi.useFakeTimers();
      if (phase === 'cleanup') seedOwnedUser();
      let failures = 0;
      let deletedPolicy = false;
      const commands = await useRealRunner(async (args, dispatch) => {
        if (
          args[1] === 'get-user' &&
          user &&
          (phase === 'generation' || deletedPolicy) &&
          failures < 2
        ) {
          failures += 1;
          throw connectionFailure();
        }
        const response = await dispatch();
        if (args[1] === 'delete-user-policy') deletedPolicy = true;
        return response;
      });
      const journey = async () => {
        if (phase === 'cleanup') {
          await cleanupAWSGeneration(operator, owned);
        } else {
          const generated = await generateAWSCredentials(
            await getAWSGenerationPreview(operator, 'test'),
          );
          expect(generated.secretAccessKey).toBe('SECRET-CREATED');
          await generated.cleanup();
        }
      };
      const result = expect(journey()).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await result;
      expect(failures).toBe(2);
      expect(user).toBeUndefined();
      expect(commands.filter((command) => mutations.has(command))).toEqual(
        phase === 'generation'
          ? [
              'create-user',
              'put-user-policy',
              'create-access-key',
              'delete-access-key',
              'delete-user-policy',
              'delete-user',
            ]
          : ['delete-access-key', 'delete-user-policy', 'delete-user'],
      );
    },
  );

  it('replays each cleanup delete whose response was lost and accepts NoSuchEntity', async () => {
    vi.useFakeTimers();
    seedOwnedUser();
    const applied = new Set<string>();
    const commands = await useRealRunner(async (args, dispatch) => {
      if (!args[1].startsWith('delete-')) return dispatch();
      if (applied.has(args[1])) throw new AWSCliError('gone', 'NoSuchEntity');
      await dispatch();
      applied.add(args[1]);
      throw connectionFailure();
    });
    const result = expect(
      cleanupAWSGeneration(operator, owned),
    ).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;
    expect(user).toBeUndefined();
    expect(commands.filter((command) => mutations.has(command))).toEqual([
      'delete-access-key',
      'delete-access-key',
      'delete-user-policy',
      'delete-user-policy',
      'delete-user',
      'delete-user',
    ]);
  });

  it('retains the created user when its ownership read exhausts recovery', async () => {
    vi.useFakeTimers();
    const commands = await useRealRunner(async (args, dispatch) => {
      if (args[1] === 'get-user' && user) throw connectionFailure();
      return dispatch();
    });
    const result = expect(
      getAWSGenerationPreview(operator, 'test').then(generateAWSCredentials),
    ).rejects.toThrow(
      /IAM GetUser failed after 3 attempts.*resources were retained/,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(user?.UserId).toBe('AIDA-CREATED');
    expect(commands.filter((command) => mutations.has(command))).toEqual([
      'create-user',
    ]);
  });

  it('stops cleanup when a retried read observes a different owner', async () => {
    vi.useFakeTimers();
    seedOwnedUser();
    let firstRead = true;
    const commands = await useRealRunner(async (args, dispatch) => {
      if (args[1] === 'get-user' && firstRead) {
        firstRead = false;
        user!.UserId = 'AIDA-REPLACEMENT';
        throw connectionFailure();
      }
      return dispatch();
    });
    const result = expect(
      cleanupAWSGeneration(operator, owned),
    ).rejects.toThrow('ownership changed');
    await vi.runAllTimersAsync();
    await result;
    expect(commands.filter((command) => command === 'get-user')).toHaveLength(
      2,
    );
    expect(commands.filter((command) => mutations.has(command))).toEqual([]);
  });

  it('keeps malformed read output terminal and redacted', async () => {
    const commands = await useRealRunner(async () => 'PRIVATE-MALFORMED-JSON');
    const error = await getAWSGenerationPreview(operator, 'test').catch(
      (value: unknown) => value,
    );
    expect(String(error)).toContain('AWS CLI returned invalid output');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
      'PRIVATE',
    );
    expect(error).not.toHaveProperty('cause');
    expect(commands).toEqual(['get-caller-identity']);
  });
});

function mutationCalls() {
  return vi
    .mocked(runAWSCLI)
    .mock.calls.map(([, args]) => args)
    .filter((args) => mutations.has(args[1]));
}

function seedOwnedUser() {
  user = {
    UserName: owned.userName,
    UserId: owned.userId,
    Arn: `arn:aws:iam::${owned.accountId}:user/${owned.userName}`,
  };
  tags = [{ Key: AWS_INVOCATION_TAG, Value: owned.invocationId }];
}

describe('AWS generation ownership', () => {
  it('0038/S2 grants only AnycloudAccess and returns the exact key with guarded teardown', async () => {
    const preview = await getAWSGenerationPreview(
      operator,
      'test',
      caller.Account,
    );
    const generated = await generateAWSCredentials(preview);
    expect(generated).toMatchObject({
      accessKeyId: 'AKIA-CREATED',
      secretAccessKey: 'SECRET-CREATED',
    });
    expect(generated.ownership.userId).toBe('AIDA-CREATED');
    expect(generated.ownership.invocationId).toBe(
      tags.find((tag) => tag.Key === AWS_INVOCATION_TAG)?.Value,
    );
    expect(generated.ownership.inlinePolicyNames).toEqual(['AnycloudAccess']);
    expect(mutationCalls().map((args) => args[1])).toEqual([
      'create-user',
      'put-user-policy',
      'create-access-key',
    ]);
    await generated.cleanup();
    expect(user).toBeUndefined();
    expect(
      mutationCalls()
        .map((args) => args[1])
        .slice(3),
    ).toEqual(['delete-access-key', 'delete-user-policy', 'delete-user']);
    expect(
      vi
        .mocked(runAWSCLI)
        .mock.calls.some(([, args]) =>
          [
            'list-access-keys',
            'list-user-policies',
            'list-attached-user-policies',
          ].includes(args[1]),
        ),
    ).toBe(false);
  });

  it('0038/S2 rejects account mismatch before any mutation', async () => {
    await expect(
      getAWSGenerationPreview(operator, 'test', '999999999999'),
    ).rejects.toThrow('selected account');
    expect(mutationCalls()).toEqual([]);
  });

  it('0038/S2 rejects a changed operator between consent and creation', async () => {
    const preview = await getAWSGenerationPreview(operator, 'test');
    currentCaller.UserId = 'AIDA-REPLACEMENT';
    await expect(generateAWSCredentials(preview)).rejects.toThrow(
      'operator changed',
    );
    expect(mutationCalls()).toEqual([]);
  });

  it('0038/S2 never adopts or cleans up a colliding user', async () => {
    seedOwnedUser();
    await expect(
      generateAWSCredentials(await getAWSGenerationPreview(operator, 'test')),
    ).rejects.toThrow('already exists');
    expect(mutationCalls()).toEqual([]);
  });

  it.each(['create-user', 'create-access-key'])(
    '0038/S2 preserves uncertain %s without replay or name-based recovery',
    async (command) => {
      const original = vi.mocked(runAWSCLI).getMockImplementation()!;
      vi.mocked(runAWSCLI).mockImplementation(async (selected, args) => {
        const result = await original(selected, args);
        if (args[1] === command) throw new AWSCliError('response lost');
        return result;
      });
      await expect(
        generateAWSCredentials(await getAWSGenerationPreview(operator, 'test')),
      ).rejects.toThrow(/manual reconciliation.*retained/);
      expect(
        mutationCalls().filter((args) => args[1] === command),
      ).toHaveLength(1);
      expect(mutationCalls().some((args) => args[1].startsWith('delete'))).toBe(
        false,
      );
      expect(user).toBeDefined();
    },
  );

  it.each(['account', 'user-id', 'marker', 'missing-marker', 'missing-record'])(
    '0038/S2 refuses cleanup with mismatched %s evidence',
    async (mismatch) => {
      seedOwnedUser();
      if (mismatch === 'account') currentCaller.Account = '999999999999';
      if (mismatch === 'user-id') user!.UserId = 'AIDA-REPLACEMENT';
      if (mismatch === 'marker') tags[0].Value = 'another-invocation';
      if (mismatch === 'missing-marker') tags = [];
      if (mismatch === 'missing-record') owned.userId = '';
      await expect(cleanupAWSGeneration(operator, owned)).rejects.toThrow();
      expect(mutationCalls()).toEqual([]);
    },
  );

  it('0038/S2 checks for replacement again between destructive phases', async () => {
    seedOwnedUser();
    const original = vi.mocked(runAWSCLI).getMockImplementation()!;
    vi.mocked(runAWSCLI).mockImplementation(async (selected, args) => {
      const result = await original(selected, args);
      if (args[1] === 'delete-access-key') user!.UserId = 'AIDA-REPLACEMENT';
      return result;
    });
    await expect(cleanupAWSGeneration(operator, owned)).rejects.toThrow(
      'ownership changed',
    );
    expect(mutationCalls().map((args) => args[1])).toEqual([
      'delete-access-key',
    ]);
  });

  it('0038/S2 overrides ambient identity, endpoints, and retry settings while preserving profile locations', () => {
    const environment = awsOperatorEnvironment({
      PATH: '/bin',
      AWS_PROFILE: 'wrong',
      AWS_DEFAULT_PROFILE: 'wrong',
      AWS_ACCESS_KEY_ID: 'poison',
      AWS_SECRET_ACCESS_KEY: 'poison',
      AWS_SESSION_TOKEN: 'poison',
      AWS_ROLE_ARN: 'poison',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/poison',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://poison',
      AWS_ENDPOINT_URL: 'http://poison',
      AWS_ENDPOINT_URL_IAM: 'http://poison',
      AWS_DATA_PATH: '/poison',
      AWS_MAX_ATTEMPTS: '9',
      AWS_RETRY_MODE: 'adaptive',
      BOTO_CONFIG: '/poison/boto',
      AWS_CONFIG_FILE: '/selected/config',
      AWS_SHARED_CREDENTIALS_FILE: '/selected/credentials',
      AWS_LOGIN_CACHE_DIRECTORY: '/selected/login',
    });
    expect(environment).toEqual({
      PATH: '/bin',
      AWS_CONFIG_FILE: '/selected/config',
      AWS_SHARED_CREDENTIALS_FILE: '/selected/credentials',
      AWS_LOGIN_CACHE_DIRECTORY: '/selected/login',
      AWS_MAX_ATTEMPTS: '1',
      AWS_RETRY_MODE: 'standard',
      AWS_PAGER: '',
      AWS_CLI_AUTO_PROMPT: 'off',
      AWS_EC2_METADATA_DISABLED: 'true',
      BOTO_CONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    });
  });
});
