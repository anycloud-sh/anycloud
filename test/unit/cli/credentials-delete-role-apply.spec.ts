import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `anycloud credentials delete <name> --apply`: read-only checks that the
 * cloud side is this connection's, then the saved connection, then what
 * `new --role --apply` created, through the user's aws, gcloud or az (fake
 * executables here).
 */

const api = vi.hoisted(() => ({ list: vi.fn(), delete: vi.fn() }));

vi.mock(
  '../../../src/shared/services/api-client/rpc.js',
  async (importActual) => ({
    ...(await importActual<object>()),
    createApiClient: () => ({
      credentials: { list: api.list, delete: api.delete },
    }),
  }),
);
vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

import { createDeleteCommand } from '../../../src/cli/commands/credentials/delete.js';
import {
  installFakeCloudClis,
  type FakeCliResponder,
  type FakeCloudCliName,
  type FakeCloudClis,
} from '../../helpers/fake-cloud-cli.js';

const API = 'https://c-1.anycloud.sh';
const STACK = 'anycloud-role-c-1-anycloud-sh';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/anycloud-role';
const PROVIDER =
  'projects/1/locations/global/workloadIdentityPools/anycloud/providers/anycloud-api';
const EMAIL = 'anycloud-role@acme.iam.gserviceaccount.com';
const ISSUER = 'https://c-1.anycloud.sh/issuer';
const CONDITION = "assertion.sub == 'system:serviceaccount:anycloud:api'";
/** The served script's pinned trust, as the teardown reads it. */
const GCP_SCRIPT = `gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \\
  --issuer-uri='${ISSUER}' \\
  --attribute-condition="${CONDITION}"`;

let clis: FakeCloudClis | undefined;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  api.list.mockReset().mockResolvedValue([
    { name: 'aws', cloudProvider: 'AWS', kind: 'role', roleArn: ROLE_ARN },
    {
      name: 'gcp',
      cloudProvider: 'GCP',
      kind: 'role',
      workloadIdentityProvider: PROVIDER,
      serviceAccountEmail: EMAIL,
    },
    {
      name: 'azure',
      cloudProvider: 'Azure',
      kind: 'role',
      applicationId: 'client',
      directoryId: 'tenant',
      subscriptionId: 'sub-1',
    },
    { name: 'key', cloudProvider: 'AWS', accessKeyId: 'AKIA' },
  ]);
  api.delete.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('CI', 'true');
  vi.stubEnv('API_URL', API);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(GCP_SCRIPT)),
  );
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  vi.stubEnv('PATH', clis.env.PATH);
  return clis;
}

const run = (name: string, ...args: string[]) =>
  createDeleteCommand().parseAsync([
    'node',
    'delete',
    name,
    '--apply',
    '--json',
    ...args,
  ]);
const document = () => JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
const steps = (fakes: FakeCloudClis) =>
  fakes.calls().map(({ args }) => args.slice(0, 3).join(' '));

const AWS_SIGNED_IN: FakeCliResponder = {
  match: ['sts', 'get-caller-identity'],
  stdout: { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/me' },
};

const GCP_SIGNED_IN: FakeCliResponder[] = [
  { match: ['config', 'get', 'project'], stdout: 'acme\n' },
  { match: ['auth', 'print-access-token'], stdout: 'tok\n' },
  { match: ['config', 'get', 'account'], stdout: 'me@acme.com\n' },
];
const GCP_NOT_FOUND = {
  stderr: 'ERROR: (gcloud.iam) NOT_FOUND: Requested entity was not found.',
  exitCode: 1,
};
const AZURE_SIGNED_IN: FakeCliResponder = {
  match: ['account', 'show'],
  stdout: { id: 'sub-1', user: { name: 'me@acme.com' } },
};
const destructive = (fakes: FakeCloudClis) =>
  fakes
    .calls()
    .map(({ args }) => args.join(' '))
    .filter((call) => /delete|remove/.test(call));

describe('credentials delete --apply', () => {
  it('deletes the connection, then the AWS stack holding its role', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
      { match: ['cloudformation', 'delete-stack'], stdout: '' },
      { match: ['cloudformation', 'wait'], stdout: '' },
    ]);
    await run('aws');
    expect(steps(aws)).toEqual([
      'sts get-caller-identity --output',
      'cloudformation describe-stacks --stack-name',
      'cloudformation delete-stack --stack-name',
      'cloudformation wait stack-delete-complete',
    ]);
    expect(api.delete).toHaveBeenCalledWith({
      params: { name: 'aws' },
      query: { force: 'false' },
    });
    expect(document()).toEqual({
      name: 'aws',
      deleted: [`CloudFormation stack ${STACK}`],
      kept: [],
    });
  });

  it('changes nothing in the cloud while workloads use the connection', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
      { match: /./, stdout: '' },
    ]);
    api.delete.mockRejectedValue(new Error('Credential "aws" is in use'));
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(destructive(aws)).toEqual([]);
  });

  it('refuses a stack that holds another role, and a cloud side another connection shares', async () => {
    const aws = fake('aws', [
      AWS_SIGNED_IN,
      {
        match: ['cloudformation', 'describe-stacks'],
        stdout: 'arn:aws:iam::123456789012:role/other\n',
      },
    ]);
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'ROLE_TEARDOWN_REFUSED' },
    });
    expect(destructive(aws)).toEqual([]);

    api.list.mockResolvedValue([
      { name: 'aws', cloudProvider: 'AWS', kind: 'role', roleArn: ROLE_ARN },
      { name: 'aws-2', cloudProvider: 'AWS', kind: 'role', roleArn: ROLE_ARN },
    ]);
    api.delete.mockClear();
    await expect(run('aws')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'ROLE_TEARDOWN_REFUSED' },
    });
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('deletes only the connection when the stack is already gone', async () => {
    fake('aws', [
      AWS_SIGNED_IN,
      {
        match: ['cloudformation', 'describe-stacks'],
        stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${STACK} does not exist`,
        exitCode: 254,
      },
    ]);
    await run('aws');
    expect(document()).toEqual({ name: 'aws', deleted: [], kept: [] });
  });

  it('deletes the GCP provider with this trust, the empty pool, bindings and service account', async () => {
    const gcloud = fake('gcloud', [
      ...GCP_SIGNED_IN,
      {
        match: /providers describe/,
        stdout: `ACTIVE\t${ISSUER}\t${CONDITION}\n`,
      },
      { match: /pools describe/, stdout: 'ACTIVE\n' },
      { match: /providers list/, stdout: '' },
      {
        match: ['iam', 'service-accounts', 'describe'],
        stdout: 'Anycloud role connection\n',
      },
      {
        match: ['iam', 'service-accounts', 'get-iam-policy'],
        stdout: `principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/anycloud/subject/system:serviceaccount:anycloud:api\n`,
      },
      {
        match: ['projects', 'get-iam-policy'],
        stdout: 'projects/acme/roles/anycloud\n',
      },
      { match: /./, stdout: '' },
    ]);
    await run('gcp');
    expect(destructive(gcloud)).toEqual([
      'iam workload-identity-pools providers delete anycloud-api --workload-identity-pool anycloud --location=global --project=acme --quiet',
      'iam workload-identity-pools delete anycloud --location=global --project=acme --quiet',
      `projects remove-iam-policy-binding acme --member=serviceAccount:${EMAIL} --role=projects/acme/roles/anycloud --all --project=acme --quiet`,
      `iam service-accounts delete ${EMAIL} --project=acme --quiet`,
    ]);
    const { deleted, kept } = document();
    expect(deleted).toEqual([
      'workload identity provider anycloud-api',
      'workload identity pool anycloud',
      `service account ${EMAIL}`,
    ]);
    // Kept, never undeleted: a compromise recovery must stay deleted.
    expect(kept).toEqual([
      expect.stringContaining('custom role projects/acme/roles/anycloud'),
      expect.stringContaining('ANYCLOUD_ROLE_POOL and ANYCLOUD_ROLE_PROVIDER'),
    ]);
  });

  it('resumes past soft-deleted GCP resources without undeleting them', async () => {
    const gcloud = fake('gcloud', [
      ...GCP_SIGNED_IN,
      {
        match: /providers describe/,
        stdout: `DELETED\t${ISSUER}\t${CONDITION}\n`,
      },
      { match: /pools describe/, stdout: 'DELETED\n' },
      { match: ['iam', 'service-accounts', 'describe'], ...GCP_NOT_FOUND },
    ]);
    await run('gcp');
    expect(destructive(gcloud)).toEqual([]);
    expect(gcloud.calls().some(({ args }) => args.includes('undelete'))).toBe(
      false,
    );
    expect(document()).toEqual({ name: 'gcp', deleted: [], kept: [] });
  });

  it('reads a deleted GCP service account, denied "(or it may not exist)", as gone once the rights are confirmed', async () => {
    // As GCP answered for the deleted account in run 42519226966.
    const deniedOrGone = {
      stderr:
        "ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED: Permission 'iam.serviceAccounts.get' denied on resource (or it may not exist).",
      exitCode: 1,
    };
    const answers = [
      ...GCP_SIGNED_IN,
      {
        match: /providers describe/,
        stdout: `DELETED\t${ISSUER}\t${CONDITION}\n`,
      },
      { match: /pools describe/, stdout: 'DELETED\n' },
      { match: ['iam', 'service-accounts', 'describe'], ...deniedOrGone },
    ];
    const rights = (permissions: string[]) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.includes('testIamPermissions')
            ? Response.json({ permissions })
            : new Response(GCP_SCRIPT),
        ),
      );
    rights(['iam.serviceAccounts.get', 'iam.serviceAccounts.delete']);
    const gcloud = fake('gcloud', answers);
    await run('gcp');
    expect(destructive(gcloud)).toEqual([]);
    expect(document()).toEqual({ name: 'gcp', deleted: [], kept: [] });
    clis?.cleanup();

    // When Resource Manager can't say, it stays a refusal too.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('testIamPermissions')
          ? new Response('', { status: 403 })
          : new Response(GCP_SCRIPT),
      ),
    );
    fake('gcloud', answers);
    await expect(run('gcp')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'CLOUD_RIGHTS_MISSING' },
    });
    clis?.cleanup();

    // Without the rights it's a real refusal, before the connection goes.
    rights([]);
    api.delete.mockClear();
    fake('gcloud', answers);
    await expect(run('gcp')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'CLOUD_RIGHTS_MISSING' },
    });
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('refuses a GCP provider with another trust, and keeps a pool with other providers', async () => {
    const gcloud = fake('gcloud', [
      ...GCP_SIGNED_IN,
      {
        match: /providers describe/,
        stdout: `ACTIVE\thttps://other.example\t${CONDITION}\n`,
      },
    ]);
    await expect(run('gcp')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'ROLE_TEARDOWN_REFUSED' },
    });
    expect(destructive(gcloud)).toEqual([]);
    clis?.cleanup();

    fake('gcloud', [
      ...GCP_SIGNED_IN,
      { match: /providers describe/, ...GCP_NOT_FOUND },
      { match: /pools describe/, stdout: 'ACTIVE\n' },
      { match: /providers list/, stdout: `${PROVIDER}-2\n` },
      { match: ['iam', 'service-accounts', 'describe'], ...GCP_NOT_FOUND },
    ]);
    await run('gcp');
    expect(document().kept).toEqual([
      'workload identity pool anycloud: it holds other providers',
    ]);
  });

  it("keeps a GCP service account another pool's principal uses", async () => {
    const gcloud = fake('gcloud', [
      ...GCP_SIGNED_IN,
      { match: /providers describe/, ...GCP_NOT_FOUND },
      { match: /pools describe/, ...GCP_NOT_FOUND },
      {
        match: ['iam', 'service-accounts', 'describe'],
        stdout: 'Anycloud role connection\n',
      },
      {
        match: ['iam', 'service-accounts', 'get-iam-policy'],
        stdout: `principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/anycloud-2/subject/x\n`,
      },
    ]);
    await run('gcp');
    expect(destructive(gcloud)).toEqual([]);
    expect(document().kept).toEqual([
      `service account ${EMAIL}: another connection or pool may use it`,
    ]);
  });

  it('refuses when the template fetch fails, and keeps an account a key connection uses', async () => {
    fake('gcloud', [...GCP_SIGNED_IN, { match: /./, stdout: '' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    await expect(run('gcp')).rejects.toThrow('exit 1');
    expect(api.delete).not.toHaveBeenCalled();

    clis?.cleanup();

    // A key connection for the same account keeps it, unbinding only this pool.
    api.list.mockResolvedValue([
      {
        name: 'gcp',
        cloudProvider: 'GCP',
        kind: 'role',
        workloadIdentityProvider: PROVIDER,
        serviceAccountEmail: EMAIL,
      },
      { name: 'gcp-key', cloudProvider: 'GCP', clientEmail: EMAIL },
    ]);
    const ours = `principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/anycloud/subject/x`;
    const gcloud = fake('gcloud', [
      ...GCP_SIGNED_IN,
      { match: /providers describe/, ...GCP_NOT_FOUND },
      { match: /pools describe/, ...GCP_NOT_FOUND },
      {
        match: ['iam', 'service-accounts', 'describe'],
        stdout: 'Anycloud role connection\n',
      },
      {
        match: ['iam', 'service-accounts', 'get-iam-policy'],
        stdout: `${ours}\n`,
      },
      { match: /./, stdout: '' },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(GCP_SCRIPT)),
    );
    await run('gcp');
    expect(destructive(gcloud)).toEqual([
      `iam service-accounts remove-iam-policy-binding ${EMAIL} --member=${ours} --role=roles/iam.workloadIdentityUser --project=acme --quiet`,
    ]);
  });

  it('deletes the Azure assignment, group, role definition and deployment it made', async () => {
    const az = fake('az', [
      AZURE_SIGNED_IN,
      { match: ['identity', 'show'], stdout: 'client\n' },
      { match: ['deployment', 'sub', 'show'], stdout: 'client\n' },
      // No other connection's assignment once ours is gone.
      { match: /role assignment list --role/, stdout: '' },
      { match: /list/, stdout: '/subscriptions/sub-1/x\n' },
      { match: /./, stdout: '' },
    ]);
    await run('azure');
    expect(steps(az).filter((step) => step.includes('delete'))).toEqual([
      'role assignment delete',
      'group delete --name',
      'role definition delete',
      'deployment sub delete',
    ]);
    expect(document().deleted).toEqual([
      'role assignment',
      'resource group anycloud-role',
      'role definition',
      'deployment anycloud-role',
    ]);
    const lists = az
      .calls()
      .map(({ args }) => args.join(' '))
      .filter((call) => call.includes(' list '));
    expect(lists).toEqual([
      'role assignment list --assignee client --scope /subscriptions/sub-1 --query [].id --output=tsv --subscription sub-1',
      'role definition list --name Anycloud role connection sub-1 --scope /subscriptions/sub-1 --query [].id --output=tsv --subscription sub-1',
      // After ours goes: does another connection still use the definition?
      'role assignment list --role Anycloud role connection sub-1 --scope /subscriptions/sub-1 --query [].id --output=tsv --subscription sub-1',
    ]);
  });

  it('skips an Azure assignment that is already gone', async () => {
    const az = fake('az', [
      AZURE_SIGNED_IN,
      { match: ['identity', 'show'], stdout: 'client\n' },
      { match: ['deployment', 'sub', 'show'], stdout: 'client\n' },
      { match: /role assignment list/, stdout: '' },
      { match: /list/, stdout: '/subscriptions/sub-1/x\n' },
      { match: /./, stdout: '' },
    ]);
    await run('azure');
    expect(steps(az).some((step) => step === 'role assignment delete')).toBe(
      false,
    );
    expect(document().deleted).not.toContain('role assignment');
  });

  it('keeps the Azure role definition another connection still uses', async () => {
    const az = fake('az', [
      AZURE_SIGNED_IN,
      { match: ['identity', 'show'], stdout: 'client\n' },
      { match: ['deployment', 'sub', 'show'], stdout: 'client\n' },
      // Another API's connection in this subscription still holds it.
      {
        match: /role assignment list --role/,
        stdout: '/subscriptions/sub-1/providers/x/other\n',
      },
      { match: /list/, stdout: '/subscriptions/sub-1/x\n' },
      { match: /./, stdout: '' },
    ]);
    await run('azure');
    expect(
      steps(az).some((step) => step.startsWith('role definition delete')),
    ).toBe(false);
    expect(document().kept).toEqual([
      'role definition Anycloud role connection sub-1: another role connection uses it',
    ]);
  });

  it("proves Azure ownership by the identity when the deployment's history is gone", async () => {
    const mine = fake('az', [
      AZURE_SIGNED_IN,
      { match: ['identity', 'show'], stdout: 'client\n' },
      {
        match: ['deployment', 'sub', 'show'],
        stderr:
          'ERROR: (DeploymentNotFound) Deployment anycloud-role could not be found.',
        exitCode: 3,
      },
      // The role definition is already gone: nothing to list.
      { match: /role definition list/, stdout: '' },
      { match: /list/, stdout: '/subscriptions/sub-1/x\n' },
      { match: /./, stdout: '' },
    ]);
    await run('azure');
    expect(steps(mine).filter((step) => step.includes('delete'))).toEqual([
      'role assignment delete',
      'group delete --name',
    ]);
    expect(document().deleted).toEqual([
      'role assignment',
      'resource group anycloud-role',
    ]);
    clis?.cleanup();

    const other = fake('az', [
      AZURE_SIGNED_IN,
      { match: ['identity', 'show'], stdout: 'someone-else\n' },
    ]);
    await expect(run('azure')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'ROLE_TEARDOWN_REFUSED' },
    });
    expect(destructive(other)).toEqual([]);
  });

  it('relays a sign-in, reports a missing connection, and refuses a key credential', async () => {
    fake('az', [
      {
        match: ['account', 'show'],
        stderr: 'Please run az login',
        exitCode: 1,
      },
    ]);
    await expect(run('azure')).rejects.toThrow('exit 2');
    expect(document()).toMatchObject({
      actionRequired: { code: 'CLOUD_SIGN_IN_REQUIRED', command: 'az login' },
    });
    // Nothing changed, so a retry after signing in works.
    expect(api.delete).not.toHaveBeenCalled();

    await expect(run('nope')).rejects.toThrow('exit 1');
    expect(document()).toMatchObject({
      error: { code: 'CREDENTIAL_NOT_FOUND' },
    });

    api.delete.mockClear();
    await expect(run('key')).rejects.toThrow('exit 2');
    await expect(run('gcp', '--profile', 'p')).rejects.toThrow('exit 2');
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('says the connection is already deleted when a cloud delete fails', async () => {
    fake('aws', [
      AWS_SIGNED_IN,
      { match: ['cloudformation', 'describe-stacks'], stdout: `${ROLE_ARN}\n` },
      {
        match: ['cloudformation', 'delete-stack'],
        stderr:
          'User: arn:aws:iam::123456789012:user/me is not authorized to perform: cloudformation:DeleteStack',
        exitCode: 254,
      },
    ]);
    await expect(run('aws')).rejects.toThrow('exit 1');
    // The connection went first; the code names the cloud's refusal.
    expect(api.delete).toHaveBeenCalled();
    expect(document()).toMatchObject({
      error: { code: 'CLOUD_RIGHTS_MISSING' },
    });
  });
});
