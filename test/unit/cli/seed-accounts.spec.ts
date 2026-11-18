import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  azureGrants,
  discoverAccount,
  missingRights,
  SEED_RIGHTS,
} from '../../../src/cli/seed/accounts.js';
import { createCloudCli } from '../../../src/cli/seed/cloud-cli.js';
import {
  CommandFailedError,
  runArgv,
} from '../../../src/cli/services/slurp/cli-exec.js';
import {
  CloudCliError,
  SeedUnavailableError,
} from '../../../src/cli/seed/types.js';
import {
  installFakeCloudClis,
  type FakeCloudClis,
} from '../../helpers/fake-cloud-cli.js';

let clis: FakeCloudClis | undefined;

function fakes(table: Parameters<typeof installFakeCloudClis>[0]) {
  clis = installFakeCloudClis(table);
  vi.stubEnv('PATH', clis.env.PATH);
  return clis;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clis?.cleanup();
  clis = undefined;
});

describe('the cloud CLI adapter', () => {
  it('runs the cloud executable by argv with stdin, and turns a failure into CloudCliError', async () => {
    const recorded = fakes({
      aws: [
        { match: ['s3', 'cp'], stdout: 'copied' },
        { match: ['ec2'], stderr: 'AccessDenied', exitCode: 254 },
      ],
    });
    const cli = createCloudCli('aws');
    expect(
      await cli.run({ args: ['s3', 'cp', '-', 's3://b/k'], input: 'x' }),
    ).toBe('copied');
    expect(recorded.calls()[0]).toEqual({
      cli: 'aws',
      args: ['s3', 'cp', '-', 's3://b/k'],
      stdin: 'x',
    });
    const failure = await cli
      .run({ args: ['ec2', 'describe-instances'] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudCliError);
    expect(failure).toMatchObject({
      executable: 'aws',
      args: ['ec2', 'describe-instances'],
      exitCode: 254,
      stderr: expect.stringContaining('AccessDenied'),
    });
  });
  it('reports a timeout as a timeout, not as a failed command', async () => {
    await expect(
      runArgv(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out after 100 ms/);
    await expect(
      runArgv(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        timeoutMs: 100,
      }),
    ).rejects.not.toBeInstanceOf(CommandFailedError);
  });

  it('passes a cancel through as its reason, not as a failed command', async () => {
    fakes({ aws: [{ match: ['sts'], stdout: '{}' }] });
    const controller = new AbortController();
    const reason = new Error('interrupted');
    controller.abort(reason);
    await expect(
      createCloudCli('aws').run(
        { args: ['sts', 'get-caller-identity'] },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });
});

describe('account discovery through each CLI', () => {
  it('names the account and caller on AWS, GCP and Azure', async () => {
    fakes({
      aws: [
        {
          match: ['sts', 'get-caller-identity'],
          stdout: {
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:user/ops',
          },
        },
      ],
      gcloud: [
        { match: ['config', 'get', 'project'], stdout: 'my-project\n' },
        { match: ['auth', 'print-access-token'], stdout: 'token\n' },
        { match: ['config', 'get', 'account'], stdout: 'me@example.com\n' },
      ],
      az: [
        {
          match: ['account', 'show'],
          stdout: {
            id: 'sub-1',
            tenantId: 'tenant-1',
            user: { name: 'me@example.com' },
          },
        },
      ],
    });
    expect(await discoverAccount('aws', createCloudCli('aws'))).toEqual({
      account: '123456789012',
      principal: 'arn:aws:iam::123456789012:user/ops',
    });
    expect(await discoverAccount('gcp', createCloudCli('gcp'))).toEqual({
      account: 'my-project',
      principal: 'me@example.com',
    });
    expect(await discoverAccount('azure', createCloudCli('azure'))).toEqual({
      account: 'sub-1',
      principal: 'me@example.com',
      directory: 'tenant-1',
    });
  });

  it('says how to sign in when the CLI is signed out, or GCP has no project', async () => {
    fakes({
      aws: [
        {
          match: ['sts'],
          stderr: 'Unable to locate credentials',
          exitCode: 253,
        },
      ],
      gcloud: [{ match: ['config', 'get', 'project'], stdout: '\n' }],
    });
    await expect(discoverAccount('aws', createCloudCli('aws'))).rejects.toThrow(
      SeedUnavailableError,
    );
    await expect(discoverAccount('aws', createCloudCli('aws'))).rejects.toThrow(
      /Unable to locate credentials.*aws sso login/s,
    );
    await expect(discoverAccount('gcp', createCloudCli('gcp'))).rejects.toThrow(
      /no project is set.*gcloud config set project/s,
    );
    // No az on PATH at all.
    vi.stubEnv('PATH', '/nonexistent');
    await expect(
      discoverAccount('azure', createCloudCli('azure')),
    ).rejects.toThrow(/az is not installed or not on PATH; install it, then/);
  });
});

describe('the rights check through each CLI', () => {
  it("simulates an assumed role's own policies on AWS, and can't say for the root", async () => {
    const recorded = fakes({
      aws: [
        {
          match: ['iam', 'get-role', '--role-name', 'Admin'],
          stdout: 'arn:aws:iam::1:role/aws-reserved/Admin\n',
        },
        {
          match: ['iam', 'simulate-principal-policy'],
          stdout: {
            EvaluationResults: SEED_RIGHTS.aws.slice(1).map((action) => ({
              EvalActionName: action,
              EvalDecision: 'allowed',
            })),
          },
        },
      ],
    });
    const cli = createCloudCli('aws');
    expect(
      await missingRights('aws', cli, {
        account: '1',
        principal: 'arn:aws:sts::1:assumed-role/Admin/session',
      }),
    ).toEqual([SEED_RIGHTS.aws[0]]);
    expect(recorded.calls()[1]!.args.slice(0, 4)).toEqual([
      'iam',
      'simulate-principal-policy',
      '--policy-source-arn',
      'arn:aws:iam::1:role/aws-reserved/Admin',
    ]);
    expect(
      await missingRights('aws', cli, {
        account: '1',
        principal: 'arn:aws:iam::1:root',
      }),
    ).toBeNull();
  });

  it('returns null when the CLI may not ask, on every cloud', async () => {
    fakes({
      aws: [{ match: ['iam'], stderr: 'AccessDenied', exitCode: 254 }],
      gcloud: [{ match: ['auth'], stderr: 'reauth', exitCode: 1 }],
      az: [{ match: ['rest'], stderr: 'Forbidden', exitCode: 1 }],
    });
    const account = { account: 'a', principal: 'arn:aws:iam::1:user/ops' };
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      expect(
        await missingRights(cloud, createCloudCli(cloud), account),
      ).toBeNull();
    }
  });

  it("tests GCP permissions with gcloud's token, and reads Azure's through az rest", async () => {
    fakes({
      gcloud: [{ match: ['auth', 'print-access-token'], stdout: 'gtoken\n' }],
      az: [
        {
          match: ['rest', '--method', 'get'],
          stdout: {
            value: [
              {
                actions: ['*'],
                notActions: ['Microsoft.Authorization/*/write'],
              },
            ],
          },
        },
      ],
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ permissions: SEED_RIGHTS.gcp.slice(1) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await missingRights('gcp', createCloudCli('gcp'), {
        account: 'my-project',
        principal: 'me',
      }),
    ).toEqual([SEED_RIGHTS.gcp[0]]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloudresourcemanager.googleapis.com/v1/projects/my-project:testIamPermissions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer gtoken' }),
      }),
    );
    expect(
      await missingRights('azure', createCloudCli('azure'), {
        account: 'sub-1',
        principal: 'me',
      }),
    ).toEqual(['Microsoft.Authorization/roleAssignments/write']);

    // GCP refusing, or not answering, can't say either.
    for (const answer of [
      async () => new Response('bad permission', { status: 400 }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      vi.stubGlobal('fetch', vi.fn(answer));
      expect(
        await missingRights('gcp', createCloudCli('gcp'), {
          account: 'my-project',
          principal: 'me',
        }),
      ).toBeNull();
    }
  });

  it('grants by wildcard, case-insensitively, unless a notAction removes it', () => {
    const permissions = [{ actions: ['microsoft.compute/*'], notActions: [] }];
    expect(
      azureGrants(permissions, 'Microsoft.Compute/virtualMachines/write'),
    ).toBe(true);
    expect(
      azureGrants(
        [{ actions: ['*'], notActions: ['*/delete'] }],
        'Microsoft.Resources/subscriptions/resourceGroups/delete',
      ),
    ).toBe(false);
  });
});

it('the cluster reference lists exactly the rights create checks', () => {
  const doc = readFileSync('docs/reference/cli/cluster.md', 'utf8');
  const section = doc.slice(
    doc.indexOf('### Cloud rights'),
    doc.indexOf("**The API's URL"),
  );
  const listed = [...section.matchAll(/```text\n([\s\S]*?)```/g)].map((match) =>
    match[1]!.trim().split('\n'),
  );
  expect(listed).toEqual(
    (['aws', 'gcp', 'azure'] as const).map((cloud) =>
      [...SEED_RIGHTS[cloud]].sort(),
    ),
  );
});
