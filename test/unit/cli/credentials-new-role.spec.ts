import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORPCError } from '@orpc/client';

/**
 * `anycloud credentials new --role` (RFC 0047 § Role connections): prints how
 * to create the cloud side from the template the API serves, then saves only
 * the identifiers.
 */

const api = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  info: [] as string[],
  errors: [] as string[],
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    exitWithError: (message: string) => {
      throw new Error(message);
    },
    // Recorded, then routed as usual: --json moves it to stderr.
    printInfo: (line: string) => {
      api.info.push(line);
      actual.printInfo(line);
    },
    printError: (line: string) => api.errors.push(line),
  };
});
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

import { createNewCommand } from '../../../src/cli/commands/credentials/new.js';
import { apiClient } from '../../../src/cli/services/auth.js';

const API = 'https://c-1.anycloud.sh';
let served: number;
const fetchMock = vi.fn(async () => new Response(null, { status: served }));

beforeEach(() => {
  served = 200;
  api.info.length = 0;
  api.errors.length = 0;
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}: ${api.errors.join(' ')}`);
  });
  api.list.mockResolvedValue([]);
  api.save.mockResolvedValue(undefined);
  vi.stubEnv('CI', 'true');
  vi.stubEnv('API_URL', API);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const stdinTTY = process.stdin.isTTY;
const setStdinTTY = (value: boolean) =>
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
afterEach(() => setStdinTTY(stdinTTY));

const run = (...args: string[]) =>
  createNewCommand().parseAsync(['node', 'anycloud', 'conn', ...args]);

describe.each([
  {
    provider: 'aws',
    flags: ['--role-arn', 'arn:aws:iam::123456789012:role/anycloud'],
    body: { roleArn: 'arn:aws:iam::123456789012:role/anycloud' },
    template: '/role-setup/aws.json',
    setup: `aws cloudformation describe-stacks --stack-name anycloud-role-c-1-anycloud-sh --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
  },
  {
    provider: 'gcp',
    flags: [
      '--workload-identity-provider',
      'projects/1/locations/global/workloadIdentityPools/p/providers/q',
      '--service-account-email',
      'anycloud-role@proj.iam.gserviceaccount.com',
    ],
    body: {
      workloadIdentityProvider:
        'projects/1/locations/global/workloadIdentityPools/p/providers/q',
      serviceAccountEmail: 'anycloud-role@proj.iam.gserviceaccount.com',
    },
    template: '/role-setup/gcp.sh',
    setup: `curl -fsSL ${API}/role-setup/gcp.sh | bash`,
  },
  {
    provider: 'azure',
    flags: [
      '--application-id',
      'client',
      '--directory-id',
      'tenant',
      '--subscription-id',
      'sub',
    ],
    body: {
      applicationId: 'client',
      directoryId: 'tenant',
      subscriptionId: 'sub',
    },
    template: '/role-setup/azure.json',
    setup: `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(`${API}/role-setup/azure.json`)}`,
  },
])('$provider', ({ provider, flags, body, template, setup }) => {
  it('prints the setup from the API, then saves only the identifiers', async () => {
    await run('--provider', provider, '--role', ...flags);

    expect(fetchMock).toHaveBeenCalledWith(`${API}${template}`, {
      method: 'HEAD',
    });
    expect(api.info.map((line) => line.trim())).toContain(setup);
    expect(api.save).toHaveBeenCalledWith({
      params: { name: 'conn' },
      query: { overwrite: 'false' },
      body: {
        cloudProvider: { aws: 'AWS', gcp: 'GCP', azure: 'Azure' }[provider],
        kind: 'role',
        ...body,
      },
    });
  });

  it.each(flags.filter((flag) => flag.startsWith('--')))(
    'without a terminal, prints the setup and exits 2 naming a missing %s',
    async (flag) => {
      const at = flags.indexOf(flag);
      const rest = [...flags.slice(0, at), ...flags.slice(at + 2)];
      await expect(
        run('--provider', provider, '--role', ...rest),
      ).rejects.toThrow(`exit 2: Failed to add credentials: Pass ${flag}, `);
      expect(api.info.map((line) => line.trim())).toContain(setup);
      expect(api.save).not.toHaveBeenCalled();
    },
  );

  it('emits the saved identifiers as the only stdout with --json', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run('--provider', provider, '--role', ...flags, '--json');
    // A sign-in it needs exits 2 (not run), as in the lifecycle commands.
    expect(apiClient).toHaveBeenCalledWith({ missingExitCode: 2 });
    // The setup and the success line still print, on stderr.
    expect(stderr.mock.calls.join('\n')).toContain(setup);
    expect(stderr.mock.calls.join('\n')).toContain(
      'Role connection "conn" saved',
    );
    expect(stdout.mock.calls).toEqual([
      [
        JSON.stringify({
          name: 'conn',
          cloudProvider: { aws: 'AWS', gcp: 'GCP', azure: 'Azure' }[provider],
          kind: 'role',
          ...body,
        }),
      ],
    ]);
  });

  it('refuses on an API that serves no setup template', async () => {
    served = 404;
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      run('--provider', provider, '--role', ...flags, '--json'),
    ).rejects.toThrow('exit 1');
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'ROLE_SETUP_UNAVAILABLE',
        message: expect.stringContaining(
          'Role connections need a self-hosted API',
        ),
      },
    });
    expect(api.save).not.toHaveBeenCalled();
  });
});

it('tells AWS operators how to reuse an existing issuer provider', async () => {
  await run(
    '--provider',
    'aws',
    '--role',
    '--role-arn',
    'arn:aws:iam::1:role/r',
  );

  expect(api.info.map((line) => line.trim())).toEqual(
    expect.arrayContaining([
      'aws cloudformation deploy --template-file anycloud-role.json --stack-name anycloud-role-c-1-anycloud-sh --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset',
      'aws cloudformation delete-stack --stack-name anycloud-role-c-1-anycloud-sh',
      'aws cloudformation wait stack-delete-complete --stack-name anycloud-role-c-1-anycloud-sh',
      'aws cloudformation deploy --template-file anycloud-role.json --stack-name anycloud-role-c-1-anycloud-sh --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides IssuerProviderExists=true',
    ]),
  );
});

it('refuses a cloud without role connections', async () => {
  await expect(
    run('--provider', 'lambda', '--role', '--role-arn', 'x'),
  ).rejects.toThrow(
    'exit 2: Failed to add credentials: Role connections are available on aws, gcp and azure',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('names the AWS stack after the whole API host', async () => {
  vi.stubEnv('API_URL', 'https://api.prod.example.com');
  await run(
    '--provider',
    'aws',
    '--role',
    '--role-arn',
    'arn:aws:iam::1:role/r',
  );
  expect(api.info.join('\n')).toContain(
    '--stack-name anycloud-role-api-prod-example-com ',
  );
});

it('reads the outputs the setup templates declare', async () => {
  const { awsRoleSetupTemplate, azureRoleSetupTemplate } = await import(
    '../../../src/api/services/role-connection-setup-templates.js'
  );
  const trust = {
    issuer: API,
    subject: 'system:serviceaccount:anycloud-system:anycloud-api',
    audience: 'sts.amazonaws.com',
  };
  // The AWS commands query RoleArn; the Azure prompts name these outputs.
  expect(
    Object.keys(
      (awsRoleSetupTemplate(trust, 'a'.repeat(40)) as { Outputs: object })
        .Outputs,
    ),
  ).toEqual(['RoleArn']);
  expect(
    Object.keys((azureRoleSetupTemplate(trust) as { outputs: object }).outputs),
  ).toEqual(['applicationId', 'directoryId', 'subscriptionId']);
});

describe('without a terminal', () => {
  it.each([
    [['--provider', 'aws'], 'Pass the name: anycloud credentials new <name>'],
    [['conn'], 'Pass --provider aws, gcp or azure'],
  ])('exits 2 for %j naming what is missing', async (args, missing) => {
    vi.stubEnv('CI', 'false');
    setStdinTTY(false);
    await expect(
      createNewCommand().parseAsync(['node', 'anycloud', ...args, '--role']),
    ).rejects.toThrow(`exit 2: Failed to add credentials: ${missing}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 2 for an empty name', async () => {
    await expect(
      createNewCommand().parseAsync(['node', 'anycloud', '', '--role']),
    ).rejects.toThrow(
      'exit 2: Failed to add credentials: The name cannot be empty.',
    );
    expect(api.list).not.toHaveBeenCalled();
  });

  it('exits 2 for an option without its value', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      run('--provider', 'aws', '--role', '--role-arn'),
    ).rejects.toThrow('exit 2');
  });
});

describe('--json failures', () => {
  const stdout = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('never prompts, even in a terminal, and reports a usage error', async () => {
    vi.stubEnv('CI', 'false');
    setStdinTTY(true);
    const log = stdout();
    await expect(run('--provider', 'aws', '--role', '--json')).rejects.toThrow(
      'exit 2',
    );
    expect(log.mock.calls).toEqual([
      [
        JSON.stringify({
          error: {
            code: 'INVALID_ARGUMENT',
            message:
              'Pass --role-arn, or run the command in a terminal to be asked for it.',
          },
        }),
      ],
    ]);
  });

  it('reports an existing name and an API error code', async () => {
    const log = stdout();
    api.list.mockResolvedValue([{ name: 'conn' }]);
    const flags = ['--provider', 'aws', '--role', '--role-arn', 'a', '--json'];
    await expect(run(...flags)).rejects.toThrow('exit 1');
    api.list.mockResolvedValue([]);
    api.save.mockRejectedValue(
      new ORPCError('ROLE_CONNECTION_REFUSED', {
        defined: true,
        message: 'AWS refused the trust',
      }),
    );
    await expect(run(...flags)).rejects.toThrow('exit 1');
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        error: {
          code: 'CREDENTIAL_NAME_EXISTS',
          message:
            'Credentials "conn" already exist. Pass --overwrite to replace them.',
        },
      },
      {
        error: {
          code: 'ROLE_CONNECTION_REFUSED',
          message: 'AWS refused the trust',
        },
      },
    ]);
  });

  it('refuses --json without --role', async () => {
    const log = stdout();
    await expect(run('--provider', 'aws', '--json')).rejects.toThrow('exit 2');
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      error: {
        code: 'INVALID_ARGUMENT',
        message: '--json works with --role only.',
      },
    });
  });
});
