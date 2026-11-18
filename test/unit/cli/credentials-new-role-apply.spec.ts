import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `anycloud credentials new --role --apply`: the cloud side through the
 * user's own aws, gcloud or az (fake executables here), then the identifiers
 * saved with no prompt; the manual steps when that CLI can't.
 */

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));

vi.mock(
  '../../../src/shared/services/api-client/rpc.js',
  async (importActual) => ({
    ...(await importActual<object>()),
    createApiClient: () => ({
      credentials: { list: api.list, save: api.save },
    }),
  }),
);
vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

import { ORPCError } from '@orpc/client';

import { createNewCommand } from '../../../src/cli/commands/credentials/new.js';
import {
  installFakeCloudClis,
  type FakeCliResponder,
  type FakeCloudCliName,
  type FakeCloudClis,
} from '../../helpers/fake-cloud-cli.js';

const API = 'https://c-1.anycloud.sh';
const STACK = 'anycloud-role-c-1-anycloud-sh';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/anycloud-role';
const GCP_SCRIPT = `#!/usr/bin/env bash
echo "Save the role connection with:"
echo "  workload identity provider: projects/1/locations/global/workloadIdentityPools/anycloud/providers/anycloud-api"
echo "  service account email:      anycloud-role@\${CLOUDSDK_CORE_PROJECT:-acme}.iam.gserviceaccount.com"
# The real script writes its role file in the working directory.
echo '{}' > anycloud-role.json
`;

let clis: FakeCloudClis | undefined;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  api.list.mockReset().mockResolvedValue([]);
  api.save.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('CI', 'true');
  vi.stubEnv('API_URL', API);
  // The API serves each template: HEAD to check, GET to apply.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url.endsWith('gcp.sh') ? GCP_SCRIPT : '{"template":1}'),
    ),
  );
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  clis?.cleanup();
  clis = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fake(cli: FakeCloudCliName, responders: FakeCliResponder[]) {
  clis = installFakeCloudClis({ [cli]: responders });
  // bash runs the GCP script; no real cloud CLI is reachable first.
  vi.stubEnv('PATH', `${clis.env.PATH}:/bin:/usr/bin`);
  return clis;
}

const run = (provider: string, ...args: string[]) =>
  createNewCommand().parseAsync([
    'node',
    'anycloud',
    'conn',
    '--provider',
    provider,
    '--role',
    '--apply',
    '--json',
    ...args,
  ]);

const errorDocument = () => JSON.parse(String(stdout.mock.calls[0]?.[0]));

const AWS_SIGNED_IN: FakeCliResponder = {
  match: ['sts', 'get-caller-identity'],
  stdout: { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/me' },
};
const GCP_SIGNED_IN: FakeCliResponder[] = [
  { match: ['config', 'get', 'project'], stdout: 'acme\n' },
  { match: ['auth', 'print-access-token'], stdout: 'tok\n' },
  { match: ['config', 'get', 'account'], stdout: 'me@acme.com\n' },
];
const AZURE_SIGNED_IN: FakeCliResponder = {
  match: ['account', 'show'],
  stdout: { id: 'sub-1', user: { name: 'me@acme.com' } },
};

describe('credentials new --role --apply', () => {
  const PROVIDER_EXISTS_EVENTS = {
    // As AWS reports it.
    StackEvents: [
      {
        LogicalResourceId: 'IssuerProvider',
        ResourceType: 'AWS::IAM::OIDCProvider',
        ResourceStatus: 'CREATE_FAILED',
        ResourceStatusReason:
          'Provider with url https://c-1.anycloud.sh already exists. (Service: Iam, Status Code: 409, Request ID: 1)',
      },
    ],
  };
  const RECREATE: FakeCliResponder[] = [
    { match: /StackStatus/, stdout: 'ROLLBACK_COMPLETE\n', times: 1 },
    { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
    { match: ['cloudformation', 'delete-stack'], stdout: '' },
    { match: ['cloudformation', 'wait'], stdout: '' },
  ];
  const awsSteps = (aws: FakeCloudClis) =>
    aws
      .calls()
      .map(
        ({ args }) =>
          args.slice(0, 2).join(' ') +
          (args.includes('IssuerProviderExists=true') ? ' reuse' : ''),
      );

  it('deploys the AWS stack and saves its RoleArn and account', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      { match: ['cloudformation', 'deploy'], stdout: '' },
      { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
    ]);
    await run('aws');
    expect(api.save).toHaveBeenCalledWith({
      params: { name: 'conn' },
      query: { overwrite: 'false' },
      body: { cloudProvider: 'AWS', kind: 'role', roleArn: ROLE_ARN },
    });
    expect(stdout.mock.calls).toEqual([
      [
        JSON.stringify({
          name: 'conn',
          cloudProvider: 'AWS',
          kind: 'role',
          roleArn: ROLE_ARN,
          account: '123456789012',
        }),
      ],
    ]);
    expect(aws.calls().find(({ args }) => args[1] === 'deploy')!.args).toEqual([
      'cloudformation',
      'deploy',
      '--template-file',
      expect.stringMatching(/anycloud-role-.*template$/),
      '--stack-name',
      STACK,
      '--capabilities',
      'CAPABILITY_IAM',
      '--no-fail-on-empty-changeset',
    ]);
  });

  it("recreates a new AWS stack that failed on the account's existing provider, reusing it", async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      {
        match: /^cloudformation deploy (?!.*IssuerProviderExists)/,
        stderr: 'Failed to create/update the stack.',
        exitCode: 255,
      },
      { match: /IssuerProviderExists=true/, stdout: '' },
      {
        match: ['cloudformation', 'describe-stack-events'],
        stdout: PROVIDER_EXISTS_EVENTS,
      },
      ...RECREATE,
    ]);
    await run('aws');
    expect(awsSteps(aws)).toEqual([
      'sts get-caller-identity',
      'cloudformation deploy',
      'cloudformation describe-stacks',
      'cloudformation describe-stack-events',
      'cloudformation delete-stack',
      'cloudformation wait',
      'cloudformation deploy reuse',
      'cloudformation describe-stacks',
    ]);
    expect(api.save).toHaveBeenCalled();
  });

  it('recreates a new AWS stack that failed for another reason, without reusing a provider', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      {
        match: ['cloudformation', 'deploy'],
        stderr: 'Failed',
        exitCode: 255,
        times: 1,
      },
      { match: ['cloudformation', 'deploy'], stdout: '' },
      {
        match: ['cloudformation', 'describe-stack-events'],
        stdout: { StackEvents: [] },
      },
      ...RECREATE,
    ]);
    await run('aws');
    expect(awsSteps(aws).filter((step) => step.includes('deploy'))).toEqual([
      'cloudformation deploy',
      'cloudformation deploy',
    ]);
    expect(api.save).toHaveBeenCalled();
  });

  it('recreates a new AWS stack whose old events show a refusal since fixed', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      {
        match: ['cloudformation', 'deploy'],
        stderr: 'Stack is in ROLLBACK_COMPLETE state and can not be updated.',
        exitCode: 255,
        times: 1,
      },
      { match: ['cloudformation', 'deploy'], stdout: '' },
      {
        match: ['cloudformation', 'describe-stack-events'],
        stdout: {
          StackEvents: [
            {
              ResourceType: 'AWS::IAM::Role',
              ResourceStatusReason:
                'User: arn:aws:iam::123456789012:user/me is not authorized to perform: iam:CreateRole',
            },
          ],
        },
      },
      ...RECREATE,
    ]);
    await run('aws');
    expect(aws.calls().some(({ args }) => args[1] === 'delete-stack')).toBe(
      true,
    );
    expect(api.save).toHaveBeenCalled();
  });

  it('passes --profile to every aws call', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      { match: ['cloudformation', 'deploy'], stdout: '' },
      { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
    ]);
    await run('aws', '--profile', 'production');
    expect(aws.calls().map(({ args }) => args.slice(-2))).toEqual(
      aws.calls().map(() => ['--profile', 'production']),
    );
  });

  it('never deletes a working AWS stack whose update failed', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      { match: ['cloudformation', 'deploy'], stderr: 'Failed', exitCode: 255 },
      {
        match: ['cloudformation', 'describe-stack-events'],
        stdout: PROVIDER_EXISTS_EVENTS,
      },
      {
        match: ['cloudformation', 'describe-stacks'],
        stdout: 'UPDATE_ROLLBACK_COMPLETE\n',
      },
    ]);
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(aws.calls().some(({ args }) => args[1] === 'delete-stack')).toBe(
      false,
    );
    expect(api.save).not.toHaveBeenCalled();
  });

  it('runs the GCP script in its own directory and saves the identifiers it prints', async () => {
    fake('gcloud', GCP_SIGNED_IN);
    await run('gcp');
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          cloudProvider: 'GCP',
          kind: 'role',
          workloadIdentityProvider:
            'projects/1/locations/global/workloadIdentityPools/anycloud/providers/anycloud-api',
          serviceAccountEmail: 'anycloud-role@acme.iam.gserviceaccount.com',
        },
      }),
    );
    expect(existsSync(join(process.cwd(), 'anycloud-role.json'))).toBe(false);
    expect(errorDocument()).toMatchObject({ account: 'acme' });
  });

  it('deploys the Azure template in the existing group location and saves its outputs', async () => {
    const az = fake('az', [
      AZURE_SIGNED_IN,
      { match: ['group', 'show'], stdout: 'westeurope\n' },
      {
        match: ['deployment', 'sub', 'create'],
        stdout: {
          applicationId: { type: 'String', value: 'client' },
          directoryId: { type: 'String', value: 'tenant' },
          subscriptionId: { type: 'String', value: 'sub-1' },
        },
      },
    ]);
    await run('azure');
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          cloudProvider: 'Azure',
          kind: 'role',
          applicationId: 'client',
          directoryId: 'tenant',
          subscriptionId: 'sub-1',
        },
      }),
    );
    expect(az.calls().at(-1)!.args).toEqual(
      expect.arrayContaining([
        '--name',
        'anycloud-role',
        '--location',
        'westeurope',
        '--query',
        'properties.outputs',
      ]),
    );
    expect(errorDocument()).toMatchObject({ account: 'sub-1' });
  });

  it('applies in the account the flags select', async () => {
    const az = fake('az', [
      AZURE_SIGNED_IN,
      {
        match: ['group', 'show'],
        stderr: 'ResourceGroupNotFound',
        exitCode: 3,
      },
      {
        match: ['deployment', 'sub', 'create'],
        stdout: {
          applicationId: { value: 'client' },
          directoryId: { value: 'tenant' },
          subscriptionId: { value: 'sub-2' },
        },
      },
    ]);
    await run('azure', '--subscription-id', 'sub-2');
    expect(az.calls().at(-1)!.args).toEqual(
      expect.arrayContaining([
        '--location',
        'eastus',
        '--subscription',
        'sub-2',
      ]),
    );
    expect(errorDocument()).toMatchObject({ account: 'sub-2' });
    clis?.cleanup();

    stdout.mockClear();
    fake('gcloud', GCP_SIGNED_IN);
    await run('gcp', '--project-id', 'other');
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          serviceAccountEmail: 'anycloud-role@other.iam.gserviceaccount.com',
        }),
      }),
    );
  });

  it('prints the manual steps and relays the sign-in a signed-out CLI needs', async () => {
    fake('az', [
      {
        match: ['account', 'show'],
        stderr: 'Please run az login',
        exitCode: 1,
      },
    ]);
    await expect(run('azure')).rejects.toThrow('exit 2');
    expect(errorDocument()).toMatchObject({
      actionRequired: { code: 'CLOUD_SIGN_IN_REQUIRED', command: 'az login' },
    });
    expect(stderr.mock.calls.join('\n')).toContain('portal.azure.com/#create');
    expect(api.save).not.toHaveBeenCalled();
  });

  it('names the project to select when gcloud has none', async () => {
    fake('gcloud', [{ match: ['config', 'get', 'project'], stdout: '\n' }]);
    await expect(run('gcp')).rejects.toThrow('exit 2');
    expect(errorDocument()).toMatchObject({
      actionRequired: {
        code: 'CLOUD_SIGN_IN_REQUIRED',
        command: 'gcloud config set project <project-id>',
      },
    });
  });

  it('reports a missing CLI as CLOUD_CLI_UNAVAILABLE', async () => {
    fake('aws', []);
    vi.stubEnv('PATH', '/nonexistent');
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(errorDocument()).toMatchObject({
      error: { code: 'CLOUD_CLI_UNAVAILABLE' },
    });
  });

  it('reports a refusal as CLOUD_RIGHTS_MISSING, from stderr or only the stack events', async () => {
    fake('aws', [
      AWS_SIGNED_IN,
      {
        match: ['cloudformation', 'deploy'],
        stderr:
          'An error occurred (AccessDenied) when calling the CreateChangeSet operation: User: arn:aws:iam::123456789012:user/me is not authorized to perform: cloudformation:CreateChangeSet',
        exitCode: 254,
      },
      { match: ['cloudformation', 'describe-stack-events'], stdout: '' },
      { match: ['cloudformation', 'describe-stacks'], stdout: '' },
    ]);
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(errorDocument()).toMatchObject({
      error: { code: 'CLOUD_RIGHTS_MISSING' },
    });
    expect(stderr.mock.calls.join('\n')).toContain('aws cloudformation deploy');
    clis?.cleanup();

    stdout.mockClear();
    fake('aws', [
      AWS_SIGNED_IN,
      {
        match: ['cloudformation', 'deploy'],
        stderr: 'Failed to create/update the stack',
        exitCode: 255,
      },
      {
        match: ['cloudformation', 'describe-stack-events'],
        stdout: {
          StackEvents: [
            {
              ResourceType: 'AWS::IAM::Role',
              ResourceStatusReason:
                'User: arn:aws:iam::123456789012:user/me is not authorized to perform: iam:CreateRole',
            },
          ],
        },
      },
    ]);
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(errorDocument()).toMatchObject({
      error: { code: 'CLOUD_RIGHTS_MISSING' },
    });
  });

  const AWS_APPLIED: FakeCliResponder[] = [
    AWS_SIGNED_IN,
    { match: ['cloudformation', 'deploy'], stdout: '' },
    { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
  ];

  it('returns the existing name when the trust is saved under another (CREDENTIALS_EXIST)', async () => {
    fake('aws', AWS_APPLIED);
    api.save.mockRejectedValue(
      new ORPCError('CREDENTIALS_EXIST', {
        defined: true,
        status: 409,
        message: 'These credentials are already saved under another name',
        data: { name: 'conn', existingName: 'prod-aws' },
      }),
    );
    await run('aws');
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(errorDocument()).toEqual({
      name: 'prod-aws',
      cloudProvider: 'AWS',
      kind: 'role',
      roleArn: ROLE_ARN,
      account: '123456789012',
    });
  });

  it('re-saves a taken role name through the API, which refuses another trust (CREDENTIAL_NAME_EXISTS)', async () => {
    fake('aws', AWS_APPLIED);
    api.list.mockResolvedValue([
      { name: 'conn', cloudProvider: 'AWS', kind: 'role', roleArn: ROLE_ARN },
    ]);
    // The same trust: the API's save is a no-op once the cloud accepts it.
    await run('aws');
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({ query: { overwrite: 'false' } }),
    );
    expect(errorDocument()).toMatchObject({ name: 'conn', roleArn: ROLE_ARN });

    // Another trust under that name: the API refuses, and so does --apply.
    stdout.mockClear();
    api.save.mockRejectedValue(
      new ORPCError('CREDENTIAL_NAME_EXISTS', {
        defined: true,
        status: 409,
        message: 'Credential name already exists',
        data: { name: 'conn' },
      }),
    );
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(errorDocument()).toMatchObject({
      error: { code: 'CREDENTIAL_NAME_EXISTS' },
    });

    // A key under that name: refused before anything is applied.
    stdout.mockClear();
    api.list.mockResolvedValue([
      { name: 'conn', cloudProvider: 'AWS', accessKeyId: 'AKIA' },
    ]);
    clis?.cleanup();
    api.save.mockClear();
    const aws = fake('aws', AWS_APPLIED);
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(errorDocument()).toMatchObject({
      error: { code: 'CREDENTIAL_NAME_EXISTS' },
    });
    expect(aws.calls()).toEqual([]);
    expect(api.save).not.toHaveBeenCalled();
  });

  it('exits 2 for identifiers passed with --apply, and for --apply without --role', async () => {
    await expect(run('aws', '--role-arn', ROLE_ARN)).rejects.toThrow('exit 2');
    await expect(run('azure', '--directory-id', 'tenant')).rejects.toThrow(
      'exit 2',
    );
    await expect(run('aws', '--subscription-id', 'sub')).rejects.toThrow(
      'exit 2',
    );
    await expect(
      createNewCommand().parseAsync([
        'node',
        'anycloud',
        'conn',
        '--provider',
        'aws',
        '--apply',
      ]),
    ).rejects.toThrow('exit 2');
    expect(api.save).not.toHaveBeenCalled();
  });
});
