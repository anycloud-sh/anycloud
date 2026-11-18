import { beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.hoisted(() =>
  vi.fn(async (_request: unknown) => ({ id: 'job-1' })),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({ admission: { submit } }),
}));
vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);
vi.mock('../../../src/cli/commands/shared.js', () => ({
  parseEnvVars: () => undefined,
  resolveCloudConfig: async () => ({ cloudConfig: {}, gpuType: ['h100:4'] }),
  buildDockerOptions: () => undefined,
}));
vi.mock('../../../src/cli/session/detect.js', () => ({
  detectSession: () => null,
}));
vi.mock('../../../src/cli/utils/output.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/cli/utils/output.js')>()),
  createSpinner: () => ({ start: () => ({ succeed: () => undefined }) }),
  printInfo: () => undefined,
  printError: () => undefined,
}));

import { createSubmitCommand } from '../../../src/cli/commands/submit.js';
import { jobSpecRequest } from '../../../src/cli/commands/job-spec-options.js';

async function run(argv: string[]) {
  const command = createSubmitCommand()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await command.parseAsync(argv, { from: 'user' });
  return submit.mock.calls.at(-1)?.[0];
}

describe('job neutral Job spec flags', () => {
  beforeEach(() => submit.mockClear());

  it('stay hidden from job --help', () => {
    expect(createSubmitCommand().helpInformation()).not.toMatch(
      /--(nodes|gpus-per-node|launch|mount|time-limit|resumable)\b/,
    );
  });

  it('send every field to admission', async () => {
    const base = ['ghcr.io/acme/train:v1'];
    const flags = [
      '--nodes 2 --gpus-per-node 4 --launch distributed --resumable',
      '--mount /lustre/data:/data:ro --mount state:/state --time-limit 24h',
    ];
    const request = await run([...base, ...flags.join(' ').split(' ')]);
    expect(request).toMatchObject({
      nodes: 2,
      gpusPerNode: 4,
      launch: 'distributed',
      mounts: [
        { name: '/lustre/data', path: '/data', ro: true },
        { name: 'state', path: '/state' },
      ],
      timeLimit: 86_400,
      resumable: true,
    });
  });

  it('0046/S20 sends no Job spec field when no flag is given', async () => {
    const request = await run(['ghcr.io/acme/train:v1']);
    const sent = Object.keys(JSON.parse(JSON.stringify(request)));
    expect(sent.filter((key) => key in jobSpecRequest({}))).toEqual([]);
  });

  it.each([
    [['--time-limit', '60'], 'needs a unit'],
    [['--time-limit', '0s'], 'at least 1s'],
    [['--time-limit', '1500ms'], 'whole number of seconds'],
    [['--nodes', '0'], 'positive integer'],
    [['--mount', 'data:/data'], '--mount must look like'],
    [['--mount', '/data:/data:rw'], '--mount must look like'],
    [['--launch', 'mpi'], 'Allowed choices'],
  ])('0046/S21 refuses %j before submitting', async (flags, message) => {
    await expect(run(['ghcr.io/acme/train:v1', ...flags])).rejects.toThrow(
      message,
    );
    expect(submit).not.toHaveBeenCalled();
  });
});
