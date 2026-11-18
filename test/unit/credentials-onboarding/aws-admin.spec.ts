import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupAWSOnboardingBucket,
  cleanupAWSOnboardingUser,
  createAWSImportFixture,
  managedCredentialName,
  readAWSOnboardingSecrets,
  selectManagedAWSUsers,
  sweepAWSOnboardingUsers,
  waitForAWSImportFixtureReadiness,
} from '../../integration/credentials-onboarding/aws/admin.js';
import anycloudAccess from '../../../src/shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AWS onboarding cleanup guards', () => {
  it('passes each operation its actual generated-key environment', async () => {
    const original = {
      AWS_ACCESS_KEY_ID: 'bootstrap-access',
      AWS_SESSION_TOKEN: 'bootstrap-token',
    };
    const imported = {
      AWS_ACCESS_KEY_ID: 'imported-access',
      AWS_SECRET_ACCESS_KEY: 'imported-private',
    };
    const expected = {
      UserName: 'anycloud-bkt-123',
      Arn: 'arn:aws:iam::123456789012:user/anycloud-bkt-123',
    };
    const observed: NodeJS.ProcessEnv[] = [];
    await waitForAWSImportFixtureReadiness(
      {
        bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
        environment: original,
        rootDir: '/unused',
        run: async (args, environment) => {
          observed.push(environment);
          if (args[0] === 'sts') return JSON.stringify({ Arn: expected.Arn });
          return JSON.stringify({ Buckets: [] });
        },
      },
      imported,
      expected,
    );
    expect(observed).toHaveLength(3);
    expect(
      observed.every(
        (environment) =>
          environment.AWS_ACCESS_KEY_ID === imported.AWS_ACCESS_KEY_ID &&
          environment.AWS_SECRET_ACCESS_KEY === imported.AWS_SECRET_ACCESS_KEY,
      ),
    ).toBe(true);
    expect(
      observed.every(
        (environment) => environment.AWS_SESSION_TOKEN === undefined,
      ),
    ).toBe(true);
    expect(original.AWS_ACCESS_KEY_ID).toBe('bootstrap-access');
  });

  it('sweeps only exact generated users carrying a generation invocation marker', async () => {
    const invocation = '0f8c2a4e-1b3d-4c5e-8f7a-9b0c1d2e3f40';
    const named = (userName: string) => ({
      UserName: userName,
      Arn: `arn:aws:iam::123456789012:user/${userName}`,
    });
    const generated = named(`anycloud-onb-gen-${invocation}`);
    const unmarked = named(
      'anycloud-onb-gen-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    );
    const inexact = named('anycloud-onb-gen-abc123');
    const markerProtected = named('anycloud-onb-123');
    const marker = { Key: 'anycloud:generation-id', Value: invocation };
    const tags: Record<string, { Key: string; Value: string }[]> = {
      [generated.UserName]: [marker],
      [unmarked.UserName]: [],
      [inexact.UserName]: [marker],
      [markerProtected.UserName]: [
        { Key: 'anycloud:managed', Value: 'true' },
        { Key: 'anycloud:credential-name', Value: 'onb-123' },
        marker,
      ],
    };
    let users = [generated, unmarked, inexact, markerProtected];
    const calls: string[][] = [];
    const after = (args: string[], flag: string) =>
      args[args.indexOf(flag) + 1];
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/unused',
      run: async (args: string[]) => {
        calls.push(args);
        const userName = after(args, '--user-name');
        switch (args[1]) {
          case 'list-users':
            return JSON.stringify({ Users: users });
          case 'list-user-tags':
            return JSON.stringify({ Tags: tags[userName] });
          case 'list-access-keys':
            return JSON.stringify({
              AccessKeyMetadata: [{ AccessKeyId: 'AKIAGENERATED' }],
            });
          case 'list-user-policies':
            return JSON.stringify({ PolicyNames: ['AnycloudAccess'] });
          case 'list-attached-user-policies':
            return JSON.stringify({ AttachedPolicies: [] });
          case 'delete-user':
            users = users.filter((user) => user.UserName !== userName);
            return '';
          default:
            return '';
        }
      },
    };

    expect(await sweepAWSOnboardingUsers(context, 'bucket')).toBe(0);
    expect(await sweepAWSOnboardingUsers(context, 'onboarding')).toBe(1);
    expect(await sweepAWSOnboardingUsers(context, 'onboarding')).toBe(0);
    expect(
      calls
        .filter((args) => args[1].startsWith('delete-'))
        .map((args) => [args[1], after(args, '--user-name')]),
    ).toEqual([
      ['delete-access-key', generated.UserName],
      ['delete-user-policy', generated.UserName],
      ['delete-user', generated.UserName],
    ]);
    await expect(
      cleanupAWSOnboardingUser(context, inexact.UserName, 'onboarding'),
    ).rejects.toThrow('unmanaged');
    await expect(
      cleanupAWSOnboardingUser(context, markerProtected.UserName, 'onboarding'),
    ).rejects.toThrow('not owned');
  });

  it('waits beyond 90 seconds for the exact key and its EC2 and S3 capabilities', async () => {
    let currentTime = 0;
    const calls: string[][] = [];
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => currentTime,
      random: () => 1,
      wait,
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 2).join(' ');
        if (command === 'sts get-caller-identity') {
          if (currentTime < 120_000) {
            throw new Error(
              'InvalidClientTokenId: The security token included in the request is invalid.',
            );
          }
          return JSON.stringify({
            Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
          });
        }
        if (command === 's3api list-buckets' && currentTime < 150_000) {
          throw new Error('AccessDenied: policy is still propagating');
        }
        if (command === 'ec2 describe-vpcs' && currentTime < 180_000) {
          throw new Error('UnauthorizedOperation: policy is still propagating');
        }
        return JSON.stringify({ Buckets: [] });
      }),
    };

    await waitForAWSImportFixtureReadiness(
      context,
      {},
      {
        UserName: 'anycloud-onb-123',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
      },
    );

    expect(currentTime).toBeGreaterThanOrEqual(180_000);
    expect(currentTime).toBeLessThanOrEqual(5 * 60_000);
    expect(calls.some((args) => args[0] === 's3api')).toBe(true);
    expect(calls.some((args) => args[1] === 'describe-vpcs')).toBe(true);
  });

  it('makes one final readiness attempt at the deadline', async () => {
    let currentTime = 0;
    let stsAttempts = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => currentTime,
      random: () => 1,
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 2).join(' ');
        if (command === 'sts get-caller-identity') {
          stsAttempts += 1;
          if (currentTime < 5 * 60_000) {
            throw new Error('InvalidClientTokenId: key is still propagating');
          }
          return JSON.stringify({
            Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
          });
        }
        return JSON.stringify({ Buckets: [] });
      }),
    };

    await waitForAWSImportFixtureReadiness(
      context,
      {},
      {
        UserName: 'anycloud-onb-123',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
      },
    );

    expect(currentTime).toBe(5 * 60_000);
    expect(stsAttempts).toBeGreaterThan(1);
  });

  it('reports the elapsed budget, attempts, operation, and final AWS error', async () => {
    let currentTime = 0;
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => currentTime,
      random: () => 1,
      wait: vi.fn(async (milliseconds: number) => {
        currentTime += milliseconds;
      }),
      run: vi.fn(async () => {
        const error = new Error(
          'Command failed: aws sts get-caller-identity --output json',
        ) as Error & { code: number; stderr: string };
        error.code = 254;
        error.stderr =
          'aws: [ERROR]: An error occurred (InvalidClientTokenId): The security token included in the request is invalid.';
        throw error;
      }),
    };

    await expect(
      waitForAWSImportFixtureReadiness(
        context,
        {},
        {
          UserName: 'anycloud-onb-123',
          Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
        },
      ),
    ).rejects.toThrow(
      /after \d+ readiness attempts over 300000ms\. Final STS error:.*InvalidClientTokenId/,
    );
  });

  it.each([
    'Could not connect to the endpoint URL: "https://sts.us-east-1.amazonaws.com/"',
    'Failed to connect to proxy URL: "http://127.0.0.1:3128"',
    'Read timeout on endpoint URL: "https://sts.us-east-1.amazonaws.com/"',
    'Connect timeout on endpoint URL: "https://sts.us-east-1.amazonaws.com/"',
    'Connection was closed before we received a valid response from endpoint URL: "https://sts.us-east-1.amazonaws.com/".',
    'connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo ENOTFOUND sts.invalid',
    'getaddrinfo EAI_AGAIN sts.amazonaws.com',
  ])('retries the transient transport failure %s', async (diagnostic) => {
    let currentTime = 0;
    let stsAttempts = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => currentTime,
      random: () => 0,
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 2).join(' ');
        if (command === 'sts get-caller-identity') {
          stsAttempts += 1;
          if (stsAttempts === 1) {
            throw Object.assign(new Error('Command failed'), {
              stderr: diagnostic,
            });
          }
          return JSON.stringify({
            Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
          });
        }
        return JSON.stringify({ Buckets: [] });
      }),
    };

    await waitForAWSImportFixtureReadiness(
      context,
      {},
      {
        UserName: 'anycloud-onb-123',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
      },
    );

    expect(stsAttempts).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(currentTime).toBeGreaterThan(0);
  });

  it('retries an EC2 ServiceFailure while checking the fixture key', async () => {
    let currentTime = 0;
    let ec2Attempts = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => currentTime,
      random: () => 0,
      wait,
      run: vi.fn(async (args: string[]) => {
        const command = args.slice(0, 2).join(' ');
        if (command === 'sts get-caller-identity') {
          return JSON.stringify({
            Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
          });
        }
        if (command === 'ec2 describe-vpcs') {
          ec2Attempts += 1;
          if (ec2Attempts === 1) {
            throw Object.assign(new Error('Command failed'), {
              stderr:
                'An error occurred (ServiceFailure) when calling the DescribeVpcs operation: The request processing has failed.',
            });
          }
        }
        return JSON.stringify({ Buckets: [] });
      }),
    };

    await waitForAWSImportFixtureReadiness(
      context,
      {},
      {
        UserName: 'anycloud-onb-123',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
      },
    );

    expect(ec2Attempts).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(currentTime).toBeGreaterThan(0);
  });

  it('fails immediately for a permanent AWS CLI configuration error', async () => {
    const wait = vi.fn(async () => undefined);
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => 0,
      random: () => 1,
      wait,
      run: vi.fn(async () => {
        throw new Error('Unknown options: --broken-configuration');
      }),
    };

    await expect(
      waitForAWSImportFixtureReadiness(
        context,
        {},
        {
          UserName: 'anycloud-onb-123',
          Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
        },
      ),
    ).rejects.toThrow(
      /after 1 readiness attempt over 0ms\. Final STS error: Unknown options/,
    );
    expect(wait).not.toHaveBeenCalled();
  });

  it('does not retry a key that resolves to the wrong AWS identity', async () => {
    const wait = vi.fn(async () => undefined);
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      now: () => 0,
      random: () => 0,
      wait,
      run: vi.fn(async () =>
        JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/someone-else' }),
      ),
    };

    await expect(
      waitForAWSImportFixtureReadiness(
        context,
        {},
        {
          UserName: 'anycloud-onb-123',
          Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
        },
      ),
    ).rejects.toThrow(/did not become usable/);
    expect(wait).not.toHaveBeenCalled();
  });

  it('accepts an assumed-role bootstrap and pins readiness to the created user ARN', async () => {
    const createdUser = {
      UserName: 'anycloud-onb-123',
      Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
    };
    const calls: string[][] = [];
    const context = {
      bootstrapArn:
        'arn:aws:sts::123456789012:assumed-role/ci-bootstrap/run-123',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 2).join(' ');
        if (command === 'iam create-user') {
          return JSON.stringify({ User: createdUser });
        }
        if (command === 'iam create-access-key') {
          return JSON.stringify({
            AccessKey: {
              AccessKeyId: 'AKIA_FIXTURE',
              SecretAccessKey: 'fixture-secret',
            },
          });
        }
        if (command === 'sts get-caller-identity') {
          return JSON.stringify({ Arn: createdUser.Arn });
        }
        return JSON.stringify({ Buckets: [] });
      }),
    };

    await expect(
      createAWSImportFixture(context, 'onb-123', 'onboarding'),
    ).resolves.toEqual({
      userName: createdUser.UserName,
      accessKeyId: 'AKIA_FIXTURE',
      secretAccessKey: 'fixture-secret',
    });
    expect(
      calls.find((args) => args.slice(0, 2).join(' ') === 'iam create-user'),
    ).toEqual(expect.arrayContaining(['--output', 'json']));
    // The key gets exactly what `--generate` grants.
    const grants = calls.filter((args) =>
      ['attach-user-policy', 'put-user-policy'].includes(args[1]),
    );
    expect(grants).toEqual([
      [
        'iam',
        'put-user-policy',
        '--user-name',
        createdUser.UserName,
        '--policy-name',
        'AnycloudAccess',
        '--policy-document',
        JSON.stringify(anycloudAccess),
      ],
    ]);
  });

  it('reads the bootstrap credentials without accepting partial configuration', () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA_BOOTSTRAP');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'bootstrap-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'bootstrap-session');

    expect(readAWSOnboardingSecrets()).toEqual({
      accessKeyId: 'AKIA_BOOTSTRAP',
      secretAccessKey: 'bootstrap-secret',
      sessionToken: 'bootstrap-session',
    });
  });

  it('builds distinct numeric credential names for each suite', () => {
    expect(managedCredentialName('onboarding', '123')).toBe('onb-123');
    expect(managedCredentialName('bucket', '123')).toBe('bkt-123');
    expect(() => managedCredentialName('bucket', 'abc')).toThrow(/numeric/);
  });

  it('cleans only an exact onboarding smoke bucket', async () => {
    const calls: string[][] = [];
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[1] === 'head-bucket') {
          throw new Error('An error occurred (404): Not Found');
        }
        return '';
      }),
    };
    const bucketName = 'anycloud-onb-smoke-123-aabbccddeeff0011';

    await cleanupAWSOnboardingBucket(context, bucketName);
    await expect(
      cleanupAWSOnboardingBucket(context, 'customer-production'),
    ).rejects.toThrow(/Refusing to clean unmanaged AWS bucket/);

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ['s3api', 'delete-bucket'],
      ['s3api', 'head-bucket'],
    ]);
    expect(calls.every((args) => args.includes(bucketName))).toBe(true);
  });

  it('selects only exact numeric names carrying both ownership tags', () => {
    const users = [
      {
        UserName: 'anycloud-onb-123',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
      },
      {
        UserName: 'anycloud-onb-456',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-456',
      },
      {
        UserName: 'anycloud-bkt-789',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-bkt-789',
      },
      {
        UserName: 'anycloud-onb-human',
        Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-human',
      },
    ];
    const tags = new Map([
      [
        'anycloud-onb-123',
        [
          { Key: 'anycloud:managed', Value: 'true' },
          { Key: 'anycloud:credential-name', Value: 'onb-123' },
        ],
      ],
      ['anycloud-onb-456', [{ Key: 'anycloud:managed', Value: 'true' }]],
      [
        'anycloud-bkt-789',
        [
          { Key: 'anycloud:managed', Value: 'true' },
          { Key: 'anycloud:credential-name', Value: 'bkt-789' },
        ],
      ],
    ]);

    expect(
      selectManagedAWSUsers(
        users,
        tags,
        'arn:aws:iam::123456789012:user/anycloud-onb-999',
        'onboarding',
      ),
    ).toEqual([users[0]]);
    expect(selectManagedAWSUsers(users, tags, users[2].Arn, 'bucket')).toEqual(
      [],
    );
  });

  it('cleans an exact owned user idempotently and by enumerated resource IDs', async () => {
    const calls: string[][] = [];
    let exists = true;
    const user = {
      UserName: 'anycloud-onb-123',
      Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
    };
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 2).join(' ');
        if (command === 'iam list-users') {
          return JSON.stringify({ Users: exists ? [user] : [] });
        }
        if (command === 'iam list-user-tags') {
          return JSON.stringify({
            Tags: [
              { Key: 'anycloud:managed', Value: 'true' },
              { Key: 'anycloud:credential-name', Value: 'onb-123' },
            ],
          });
        }
        if (command === 'iam list-access-keys') {
          return JSON.stringify({
            AccessKeyMetadata: [{ AccessKeyId: 'AKIAOWNED' }],
          });
        }
        if (command === 'iam list-user-policies') {
          return JSON.stringify({ PolicyNames: ['AnyCloudRegionOptIn'] });
        }
        if (command === 'iam list-attached-user-policies') {
          return JSON.stringify({
            AttachedPolicies: [
              { PolicyArn: 'arn:aws:iam::aws:policy/PowerUserAccess' },
            ],
          });
        }
        if (command === 'iam delete-user') exists = false;
        return '';
      }),
    };

    await cleanupAWSOnboardingUser(context, user.UserName, 'onboarding');
    await cleanupAWSOnboardingUser(context, user.UserName, 'onboarding');

    expect(
      calls.some(
        (args) => args[1] === 'delete-access-key' && args.includes('AKIAOWNED'),
      ),
    ).toBe(true);
    expect(calls.filter((args) => args[1] === 'delete-user')).toHaveLength(1);
  });

  it('continues independent cleanup steps and reports all AWS failures', async () => {
    const calls: string[][] = [];
    const context = {
      bootstrapArn: 'arn:aws:iam::123456789012:user/bootstrap',
      environment: {},
      rootDir: '/tmp/fake-aws-admin',
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        const command = args.slice(0, 2).join(' ');
        if (command === 'iam list-users') {
          return JSON.stringify({
            Users: [
              {
                UserName: 'anycloud-onb-123',
                Arn: 'arn:aws:iam::123456789012:user/anycloud-onb-123',
              },
            ],
          });
        }
        if (command === 'iam list-user-tags') {
          return JSON.stringify({
            Tags: [
              { Key: 'anycloud:managed', Value: 'true' },
              { Key: 'anycloud:credential-name', Value: 'onb-123' },
            ],
          });
        }
        if (command === 'iam list-access-keys') {
          return JSON.stringify({
            AccessKeyMetadata: [{ AccessKeyId: 'AKIAFAIL' }],
          });
        }
        if (command === 'iam delete-access-key') {
          throw new Error('denied deleting key');
        }
        if (command === 'iam list-user-policies') {
          return JSON.stringify({ PolicyNames: [] });
        }
        if (command === 'iam list-attached-user-policies') {
          return JSON.stringify({ AttachedPolicies: [] });
        }
        if (command === 'iam delete-user') {
          throw new Error('delete conflict');
        }
        return '';
      }),
    };

    await expect(
      cleanupAWSOnboardingUser(context, 'anycloud-onb-123', 'onboarding'),
    ).rejects.toThrow(/2 failure\(s\).*denied deleting key.*delete conflict/i);
    expect(calls.some((args) => args[1] === 'list-user-policies')).toBe(true);
  });
});
