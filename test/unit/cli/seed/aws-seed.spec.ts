import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import stackTemplate from '../../../../src/cli/seed/aws-stack.json' with { type: 'json' };
import { SEED_RIGHTS } from '../../../../src/cli/seed/accounts.js';
import { runSeedCreate } from '../../../../src/cli/seed/create.js';
import {
  awsSelfDelete,
  createAwsSeed,
  deleteServiceRole,
} from '../../../../src/cli/seed/aws.js';
import {
  CloudCliError,
  type CloudCli,
  type SeedParams,
} from '../../../../src/cli/seed/types.js';
import { createCloudCli } from '../../../../src/cli/seed/cloud-cli.js';
import {
  installFakeCloudClis,
  type FakeCloudClis,
} from '../../../helpers/fake-cloud-cli.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { CLOUDFLARE_IPV4_RANGES } from '../../../../src/shared/cloudflare-ips.js';

type Reply = string | object | Failure;
class Failure {
  constructor(readonly stderr: string) {}
}

const fakes: FakeCloudClis[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const fake of fakes.splice(0)) fake.cleanup();
});

/**
 * The fake `aws` executable (S1's kit) on PATH, behind the CLI the seed
 * really uses: each reply answers one call whose argv starts with its words,
 * and any other call prints `[]`. The template and delete files are read as
 * they're passed, since the seed removes them after.
 */
function fakeAws(replies: [words: string, reply: Reply][]) {
  const clis = installFakeCloudClis({
    aws: [
      ...replies.map(([words, reply]) => ({
        match: words.split(' '),
        times: 1,
        ...(reply instanceof Failure
          ? { stderr: reply.stderr, exitCode: 254 }
          : { stdout: reply }),
      })),
      { match: /.*/, stdout: '[]' },
    ],
  });
  fakes.push(clis);
  vi.stubEnv('PATH', clis.env.PATH);
  const files: string[] = [];
  const real = createCloudCli('aws');
  const cli: CloudCli = {
    run(command, options) {
      for (const flag of ['--template-file', '--delete']) {
        const at = command.args.indexOf(flag);
        if (at >= 0) {
          files.push(
            readFileSync(command.args[at + 1].replace('file://', ''), 'utf8'),
          );
        }
      }
      return real.run(command, options);
    },
  };
  return {
    cli,
    files,
    get calls() {
      return clis.calls().map((call) => call.args);
    },
  };
}

const failure = (stderr: string) => new Failure(stderr);
const missingStack = () =>
  failure(
    'An error occurred (ValidationError): Stack with id anycloud-c1 does not exist',
  );

const account = {
  account: '123456789012',
  principal: 'arn:aws:sts::123456789012:assumed-role/Admin/me',
};
const outputs = [
  { OutputKey: 'PublicIp', OutputValue: '203.0.113.7' },
  { OutputKey: 'InstanceId', OutputValue: 'i-0abc' },
  { OutputKey: 'Bucket', OutputValue: 'ckpt' },
  {
    OutputKey: 'RoleArn',
    OutputValue: 'arn:aws:iam::123456789012:role/anycloud-c1-vm',
  },
];
const stack = (StackStatus: string) => ({ StackStatus, Outputs: outputs });

const params: SeedParams = {
  clusterId: 'c1',
  clusterName: 'prod',
  region: 'us-east-2',
  zone: 'us-east-2b',
  vmType: 'm7i.large',
  bucket: { name: 'ckpt', managed: true },
  releaseValues: {
    selfDelete: awsSelfDelete('c1', account),
    backup: {
      bucket: 'ckpt',
      region: 'us-east-2',
      cloudProvider: CloudType.AWS,
      credentials: { cloudProvider: CloudType.AWS, kind: 'instance' },
    },
  },
  startupScript: '#!/bin/bash\necho boot\n',
  tags: { anycloud_cluster_name: 'prod', anycloud_owner_api: 'a'.repeat(32) },
};

describe('AWS seed', () => {
  it('deploys the stack with its parameters, tags and user-data, and returns its outputs', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', missingStack()],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
    ]);
    const result = await createAwsSeed(aws.cli).deploy(params);

    expect(result).toEqual({
      publicIp: '203.0.113.7',
      instanceId: 'i-0abc',
      bucket: 'ckpt',
      identity: 'arn:aws:iam::123456789012:role/anycloud-c1-vm',
    });
    const deploy = aws.calls.find((c) => c[1] === 'deploy')!;
    const after = (flag: string) => deploy[deploy.indexOf(flag) + 1];
    expect(after('--stack-name')).toBe('anycloud-c1');
    expect(after('--region')).toBe('us-east-2');
    expect(deploy).toEqual(
      expect.arrayContaining([
        'CAPABILITY_NAMED_IAM',
        'CAPABILITY_AUTO_EXPAND',
        'ClusterId=c1',
        'InstanceType=m7i.large',
        'AvailabilityZone=us-east-2b',
        `CloudflareIpv4=${CLOUDFLARE_IPV4_RANGES.join(',')}`,
        'CheckpointBucket=ckpt',
        'CreateBucket=true',
        'anycloud_cluster=c1',
        'anycloud_cluster_name=prod',
        `anycloud_owner_api=${'a'.repeat(32)}`,
        `OwnerApiIdentity=${'a'.repeat(32)}`,
      ]),
    );
    const template = JSON.parse(aws.files[0]);
    expect(
      Buffer.from(
        template.Resources.Instance.Properties.UserData,
        'base64',
      ).toString(),
    ).toBe(params.startupScript);
  });

  it('reuses the managed bucket a restore names instead of creating it', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', missingStack()],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
    ]);
    await createAwsSeed(aws.cli).deploy({
      ...params,
      bucket: { name: 'ckpt', managed: true, exists: true },
    });
    const deploy = aws.calls.find((c) => c[1] === 'deploy')!;
    expect(deploy).toContain('CreateBucket=false');
    expect(deploy).toContain('CheckpointBucket=ckpt');
  });

  it('adopts a complete stack after waiting out its create, never updating it', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', stack('CREATE_IN_PROGRESS')],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
    ]);
    const result = await createAwsSeed(aws.cli).deploy(params);
    expect(result.instanceId).toBe('i-0abc');
    expect(aws.calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'cloudformation describe-stacks --query',
      'cloudformation wait stack-create-complete',
      'cloudformation describe-stacks --query',
    ]);
  });

  it('creates afresh once an interrupted delete finishes', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', stack('DELETE_IN_PROGRESS')],
      ['cloudformation describe-stacks', missingStack()],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
    ]);
    await createAwsSeed(aws.cli).deploy({
      ...params,
      zone: null,
      bucket: { name: 'mine', managed: false },
    });
    expect(aws.calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'cloudformation describe-stacks --query',
      'cloudformation wait stack-delete-complete',
      'cloudformation describe-stacks --query',
      'cloudformation deploy --capabilities',
      'cloudformation describe-stacks --query',
    ]);
    expect(aws.calls[3]).toEqual(
      expect.arrayContaining([
        'AvailabilityZone=',
        'CheckpointBucket=mine',
        'CreateBucket=false',
      ]),
    );
  });

  it('replaces a rolled-back create, and refuses a stack stuck in a failed state', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', stack('ROLLBACK_COMPLETE')],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
    ]);
    await createAwsSeed(aws.cli).deploy(params);
    expect(aws.calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'cloudformation describe-stacks',
      'cloudformation delete-stack',
      'cloudformation wait',
      'cloudformation deploy',
      'cloudformation describe-stacks',
    ]);
    expect(aws.calls[1]).not.toContain('--role-arn');

    const stuck = fakeAws([
      ['cloudformation describe-stacks', stack('DELETE_FAILED')],
    ]);
    await expect(createAwsSeed(stuck.cli).deploy(params)).rejects.toThrow(
      /DELETE_FAILED/,
    );
    expect(stuck.calls.some((c) => c[1] === 'deploy')).toBe(false);
  });

  it('waits out a rollback, then replaces the rolled-back stack', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', stack('ROLLBACK_IN_PROGRESS')],
      [
        'cloudformation wait stack-create-complete',
        failure('Waiter StackCreateComplete failed'),
      ],
      ['cloudformation describe-stacks', stack('ROLLBACK_COMPLETE')],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
    ]);
    await createAwsSeed(aws.cli).deploy(params);
    expect(aws.calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'cloudformation describe-stacks --query',
      'cloudformation wait stack-create-complete',
      'cloudformation describe-stacks --query',
      'cloudformation delete-stack --stack-name',
      'cloudformation wait stack-delete-complete',
      'cloudformation deploy --capabilities',
      'cloudformation describe-stacks --query',
    ]);
  });

  it("reports the stack's first resource failure", async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', missingStack()],
      ['cloudformation deploy', failure('Waiter StackCreateComplete failed')],
      [
        'cloudformation describe-stack-events',
        [
          { status: 'ROLLBACK_COMPLETE', id: 'anycloud-c1' },
          {
            status: 'CREATE_FAILED',
            id: 'Instance',
            reason: 'Resource creation cancelled',
          },
          {
            status: 'CREATE_FAILED',
            id: 'Bucket',
            reason: 'ckpt already exists',
          },
        ],
      ],
    ]);
    await expect(createAwsSeed(aws.cli).deploy(params)).rejects.toThrow(
      'Bucket: ckpt already exists',
    );
  });

  it('reads status from the stack and its instance', async () => {
    const statusOf = (...replies: [string, Reply][]) =>
      createAwsSeed(fakeAws(replies).cli).status('c1', 'us-east-2');

    expect(
      await statusOf(['cloudformation describe-stacks', missingStack()]),
    ).toEqual({
      kind: 'absent',
    });
    expect(
      (
        await statusOf([
          'cloudformation describe-stacks',
          stack('DELETE_IN_PROGRESS'),
        ])
      ).kind,
    ).toBe('in-progress');
    expect(
      (
        await statusOf([
          'cloudformation describe-stacks',
          stack('ROLLBACK_COMPLETE'),
        ])
      ).kind,
    ).toBe('failed');
    expect(
      await statusOf(
        ['cloudformation describe-stacks', stack('UPDATE_COMPLETE')],
        ['ec2 describe-instances', '"stopped"'],
      ),
    ).toMatchObject({
      kind: 'deployed',
      stopped: true,
      outputs: { instanceId: 'i-0abc' },
    });
    for (const gone of [
      '"terminated"',
      failure('An error occurred (InvalidInstanceID.NotFound)'),
    ]) {
      expect(
        (
          await statusOf(
            ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
            ['ec2 describe-instances', gone],
          )
        ).kind,
      ).toBe('failed');
    }
  });

  it('derives the self-delete role and the instance-role backup values', () => {
    const seed = createAwsSeed(fakeAws([]).cli);
    expect(seed.selfDeleteValues(params, account)).toEqual({
      cloud: 'aws',
      stackName: 'anycloud-c1',
      roleArn: 'arn:aws:iam::123456789012:role/anycloud-c1-cfn',
    });
    expect(
      seed.selfDeleteValues(params, {
        account: '1',
        principal: 'arn:aws-us-gov:iam::1:user/me',
      }),
    ).toMatchObject({ roleArn: 'arn:aws-us-gov:iam::1:role/anycloud-c1-cfn' });
    // Backups run as the VM's own role, with no saved credential in the values.
    expect(seed.backupValues(params, account)).toEqual({
      bucket: 'ckpt',
      region: 'us-east-2',
      cloudProvider: CloudType.AWS,
      credentials: { cloudProvider: CloudType.AWS, kind: 'instance' },
    });
  });

  it("skips the rights check when the caller can't simulate its policy", async () => {
    const aws = fakeAws([['iam get-role', failure('AccessDenied')]]);
    expect(await createAwsSeed(aws.cli).checkRights(account)).toBeNull();
  });

  it('finds a cluster by its name tag, refusing two', async () => {
    const tags = (id: string, name: string) => [
      { Key: 'anycloud_cluster', Value: id },
      { Key: 'anycloud_cluster_name', Value: name },
    ];
    const find = (stacks: object) =>
      createAwsSeed(
        fakeAws([['cloudformation describe-stacks', stacks]]).cli,
      ).findByName('prod', 'us-east-2');
    expect(await find([tags('c1', 'prod'), tags('c2', 'dev')])).toBe('c1');
    expect(await find([tags('c2', 'dev')])).toBeNull();
    await expect(
      find([tags('c1', 'prod'), tags('c3', 'prod')]),
    ).rejects.toThrow(/c1, c3/);
  });

  it('reads an object only when its exact key exists', async () => {
    const aws = fakeAws([
      ['s3api list-objects-v2', '"backup.json.tmp"'],
      ['s3api list-objects-v2', '"backup.json"'],
      ['s3 cp', '{"version":1}'],
    ]);
    const seed = createAwsSeed(aws.cli);
    expect(
      await seed.readObject('ckpt', 'backup.json', 'us-east-2'),
    ).toBeNull();
    expect(await seed.readObject('ckpt', 'backup.json', 'us-east-2')).toBe(
      '{"version":1}',
    );
  });

  const signedIn: [string, Reply] = [
    'sts get-caller-identity',
    { Account: account.account, Arn: account.principal },
  ];
  const taggedBuckets: [string, Reply] = [
    'resourcegroupstaggingapi get-resources',
    ['arn:aws:s3:::ckpt'],
  ];

  it('falls back to deleting pool VMs, the stack under its role, groups and the role, keeping the bucket', async () => {
    const aws = fakeAws([
      ['ec2 describe-instances', ['i-pool', 'i-0abc']],
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
      signedIn,
      ['ec2 describe-security-groups', ['sg-pool']],
      taggedBuckets,
    ]);
    const result = await createAwsSeed(aws.cli).deleteFallback(
      'c1',
      'us-east-2',
      {
        deleteBuckets: false,
      },
    );

    expect(aws.calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'ec2 describe-instances',
      'ec2 terminate-instances',
      'ec2 wait',
      'cloudformation describe-stacks',
      'sts get-caller-identity',
      'cloudformation delete-stack',
      'cloudformation wait',
      'ec2 describe-security-groups',
      'ec2 delete-security-group',
      'iam delete-role-policy',
      'iam delete-role',
      'resourcegroupstaggingapi get-resources',
    ]);
    const deleteStack = aws.calls[5];
    expect(deleteStack[deleteStack.indexOf('--role-arn') + 1]).toBe(
      'arn:aws:iam::123456789012:role/anycloud-c1-cfn',
    );
    expect(result.deleted.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'vm:i-pool',
      'vm:i-0abc',
      'stack:anycloud-c1',
      'firewall:sg-pool',
      'identity:anycloud-c1-cfn',
    ]);
    expect(result.remaining).toEqual([
      {
        kind: 'bucket',
        id: 'ckpt',
        location: 'us-east-2',
        selector: 'anycloud_cluster=c1',
        reason: 'kept',
      },
    ]);
  });

  it('deletes a rolled-back stack without its role, and names a failed delete', async () => {
    const rolledBack = fakeAws([
      ['cloudformation describe-stacks', stack('ROLLBACK_COMPLETE')],
      signedIn,
    ]);
    await createAwsSeed(rolledBack.cli).deleteFallback('c1', 'us-east-2', {
      deleteBuckets: false,
    });
    const deleteStack = rolledBack.calls.find((c) => c[1] === 'delete-stack')!;
    expect(deleteStack).not.toContain('--role-arn');
    for (const status of ['ROLLBACK_FAILED', 'REVIEW_IN_PROGRESS']) {
      const failed = fakeAws([
        ['cloudformation describe-stacks', stack(status)],
        signedIn,
      ]);
      await createAwsSeed(failed.cli).deleteFallback('c1', 'us-east-2', {
        deleteBuckets: false,
      });
      expect(failed.calls.find((c) => c[1] === 'delete-stack')).not.toContain(
        '--role-arn',
      );
    }

    const stuck = fakeAws([
      ['cloudformation describe-stacks', stack('CREATE_COMPLETE')],
      signedIn,
      [
        'cloudformation wait stack-delete-complete',
        failure('Waiter StackDeleteComplete failed'),
      ],
      [
        'cloudformation describe-stack-events',
        [
          {
            status: 'DELETE_FAILED',
            id: 'SecurityGroup',
            reason: 'has a dependent object',
          },
          {
            status: 'CREATE_FAILED',
            id: 'Bucket',
            reason: 'ckpt already exists',
          },
        ],
      ],
    ]);
    await expect(
      createAwsSeed(stuck.cli).deleteFallback('c1', 'us-east-2', {
        deleteBuckets: false,
      }),
    ).rejects.toThrow('SecurityGroup: has a dependent object');
  });

  it('after a self-delete, removes the delete role and, with deleteBuckets, every version of the tagged bucket', async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', missingStack()],
      taggedBuckets,
      [
        's3api list-object-versions',
        {
          v: [{ Key: 'a', VersionId: '1' }],
          d: [{ Key: 'a', VersionId: '2' }],
        },
      ],
      ['s3api list-object-versions', { v: null, d: null }],
    ]);
    const result = await createAwsSeed(aws.cli).afterSelfDelete(
      'c1',
      'us-east-2',
      {
        deleteBuckets: true,
      },
    );
    expect(JSON.parse(aws.files[0]).Objects).toEqual([
      { Key: 'a', VersionId: '1' },
      { Key: 'a', VersionId: '2' },
    ]);
    expect(aws.calls.at(-1)?.slice(0, 2)).toEqual(['s3api', 'delete-bucket']);
    expect(result).toEqual({
      deleted: [
        { kind: 'identity', id: 'anycloud-c1-cfn' },
        { kind: 'bucket', id: 'ckpt', location: 'us-east-2' },
      ],
      remaining: [],
    });

    // A supplied bucket carries no cluster tag, so it's never found.
    const supplied = fakeAws([
      ['cloudformation describe-stacks', missingStack()],
      ['resourcegroupstaggingapi get-resources', []],
    ]);
    expect(
      await createAwsSeed(supplied.cli).afterSelfDelete('c1', 'us-east-2', {
        deleteBuckets: true,
      }),
    ).toEqual({
      deleted: [{ kind: 'identity', id: 'anycloud-c1-cfn' }],
      remaining: [],
    });
    expect(supplied.calls.some((c) => c[0] === 's3api')).toBe(false);
  });

  it("keeps the delete role while the stack's own delete still runs", async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', stack('DELETE_FAILED')],
    ]);
    await expect(
      createAwsSeed(aws.cli).afterSelfDelete('c1', 'us-east-2', {
        deleteBuckets: true,
      }),
    ).rejects.toThrow(/DELETE_FAILED/);
    expect(aws.calls.some((c) => c[0] === 'iam')).toBe(false);
  });

  it("stops emptying a bucket when S3 reports objects it couldn't delete", async () => {
    const aws = fakeAws([
      ['cloudformation describe-stacks', missingStack()],
      taggedBuckets,
      [
        's3api list-object-versions',
        { v: [{ Key: 'a', VersionId: '1' }], d: null },
      ],
      ['s3api delete-objects', [{ Key: 'a', Code: 'AccessDenied' }]],
    ]);
    await expect(
      createAwsSeed(aws.cli).afterSelfDelete('c1', 'us-east-2', {
        deleteBuckets: true,
      }),
    ).rejects.toThrow('a (AccessDenied)');
  });

  it('deletes the retained service role after a self-delete, tolerating its absence', async () => {
    const aws = fakeAws([]);
    expect(await deleteServiceRole(aws.cli, 'c1')).toBe(true);
    expect(aws.calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'iam delete-role-policy',
      'iam delete-role',
    ]);
    for (const call of aws.calls) {
      expect(call[call.indexOf('--role-name') + 1]).toBe('anycloud-c1-cfn');
    }
    const missing = fakeAws([
      ['iam delete-role-policy', failure('NoSuchEntity')],
      ['iam delete-role', failure('NoSuchEntity')],
    ]);
    expect(await deleteServiceRole(missing.cli, 'c1')).toBe(false);
    const denied = fakeAws([
      ['iam delete-role-policy', failure('AccessDenied')],
    ]);
    await expect(deleteServiceRole(denied.cli, 'c1')).rejects.toThrow(
      CloudCliError,
    );
  });
});

describe('cluster create on AWS through the aws CLI', () => {
  it('drives the stack from rights check to outputs, with the boot script as user-data', async () => {
    const clis = installFakeCloudClis({
      aws: [
        {
          match: ['sts', 'get-caller-identity'],
          stdout: {
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:user/ops',
          },
        },
        {
          match: ['iam', 'simulate-principal-policy'],
          stdout: {
            EvaluationResults: SEED_RIGHTS.aws.map((EvalActionName) => ({
              EvalActionName,
              EvalDecision: 'allowed',
            })),
          },
        },
        // findByName: no installation under the name yet.
        {
          match: /^cloudformation describe-stacks --query Stacks\[\?/,
          stdout: [],
        },
        {
          match: /^cloudformation describe-stacks .*--stack-name/,
          stderr:
            'An error occurred (ValidationError): Stack with id x does not exist',
          exitCode: 254,
          times: 1,
        },
        { match: ['cloudformation', 'deploy'], stdout: '' },
        {
          match: /^cloudformation describe-stacks .*--stack-name/,
          stdout: { StackStatus: 'CREATE_COMPLETE', Outputs: outputs },
        },
      ],
    });
    fakes.push(clis);
    vi.stubEnv('PATH', clis.env.PATH);
    const templates: string[] = [];
    const real = createCloudCli('aws');
    const seed = createAwsSeed({
      run(command, options) {
        const at = command.args.indexOf('--template-file');
        if (at >= 0) templates.push(readFileSync(command.args[at + 1], 'utf8'));
        return real.run(command, options);
      },
    });
    const api = {
      systemRelease: {
        status: vi.fn(async () => ({
          firstBackup: { state: 'landed', backedUpAt: 'now' },
        })),
      },
      clusters: {
        get: vi.fn(async () => ({ cluster: { id: 'x', name: 'production' } })),
      },
    };
    const published: string[] = [];
    await runSeedCreate(
      {
        seed,
        name: 'production',
        region: 'us-east-1',
        zone: null,
        vmType: 't3.medium',
        checkpointBucket: null,
        githubToken: 'gh-token',
        owner: { id: '4242', username: 'owner' },
        version: '0.1.74',
        hostedApi: async () => api as never,
        progress: () => {},
      },
      {
        bootstrapCatalog: async () => {},
        resolveApiImage: async () => ({
          digest: `sha256:${'a'.repeat(64)}`,
          chart: `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`,
        }),
        publish: async (subdomain, ip) => {
          published.push(`${subdomain} ${ip}`);
          return 'record-1';
        },
        publicARecordExists: async () => true,
        sleep: async () => {},
        now: () => 0,
        e2eAccess: false,
      },
    );

    const deploy = clis.calls().find((c) => c.args[1] === 'deploy')!.args;
    const clusterId = deploy[deploy.indexOf('--stack-name') + 1]!.replace(
      'anycloud-',
      '',
    );
    expect(published).toEqual([`${clusterId} 203.0.113.7`]);
    expect(deploy).toEqual(
      expect.arrayContaining([
        `ClusterId=${clusterId}`,
        `CheckpointBucket=${clusterId}`,
        'CreateBucket=true',
        `anycloud_cluster_name=production`,
      ]),
    );
    // The parameter the stack validates, and the owner tag the VM role's sweep matches.
    expect(clusterId).toMatch(
      new RegExp(stackTemplate.Parameters.ClusterId.AllowedPattern),
    );
    const value = (prefix: string) =>
      deploy.find((a) => a.startsWith(prefix))!.slice(prefix.length);
    expect(value('OwnerApiIdentity=')).toMatch(
      new RegExp(stackTemplate.Parameters.OwnerApiIdentity.AllowedPattern),
    );
    expect(value('anycloud_owner_api=')).toBe(value('OwnerApiIdentity='));
    // The rights were simulated for every right create needs.
    const simulate = clis
      .calls()
      .find((c) => c.args[1] === 'simulate-principal-policy');
    expect(simulate).toBeDefined();
    const actions = simulate!.args.slice(
      simulate!.args.indexOf('--action-names') + 1,
    );
    expect(actions.slice(0, SEED_RIGHTS.aws.length)).toEqual([
      ...SEED_RIGHTS.aws,
    ]);
    const userData = Buffer.from(
      JSON.parse(templates[0]!).Resources.Instance.Properties.UserData,
      'base64',
    ).toString();
    expect(userData.startsWith('#!/bin/bash')).toBe(true);
    expect(userData).toContain(`bootstrap (${clusterId})`);
  });
});
