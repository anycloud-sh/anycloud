import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';

const api = vi.hoisted(() => ({
  getApiCredential: vi.fn(),
  listApiCredentials: vi.fn(),
  requestQuota: vi.fn(),
  getQuotaStatus: vi.fn(),
  getQuotaOperation: vi.fn(),
}));

const { spinnerMock, spinnerTextUpdates } = vi.hoisted(() => {
  const spinnerTextUpdates: string[] = [];
  const spinnerMock = {
    start: vi.fn(),
    stop: vi.fn(),
    _text: '',
  };
  spinnerMock.start.mockImplementation(() => spinnerMock);
  Object.defineProperty(spinnerMock, 'text', {
    get() {
      return spinnerMock._text;
    },
    set(value: string) {
      spinnerTextUpdates.push(value);
      spinnerMock._text = value;
    },
  });
  return { spinnerMock, spinnerTextUpdates };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: vi.fn(),
  safePrompts: vi.fn(),
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: (accessToken: string) => ({
    credentials: {
      get: api.getApiCredential,
      list: () => api.listApiCredentials(accessToken),
    },
    quota: {
      request: api.requestQuota,
      status: ({ query }: { query: Record<string, string> }) =>
        api.getQuotaStatus(accessToken, {
          cloud: query.cloud,
          credentialName: query.credentialName,
          ...(query.region ? { region: query.region } : {}),
        }),
      canceled: () => api.getQuotaStatus(accessToken, { canceledOnly: 'true' }),
      operation: api.getQuotaOperation,
    },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: vi.fn(() => '0.0.0-test'),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    printError: vi.fn(),
    printInfo: vi.fn(),
    createSpinner: vi.fn(() => spinnerMock),
  };
});

import { createQuotaCommand } from '../../../src/cli/commands/quota.js';
import { installFakeCloudClis } from '../../helpers/fake-cloud-cli.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  shouldAllowPrompts,
  safePrompts,
} from '../../../src/cli/utils/safe-prompts.js';
import { printInfo } from '../../../src/cli/utils/output.js';

const getApiCredential = api.getApiCredential;
const getQuotaStatus = api.getQuotaStatus;
const listApiCredentials = api.listApiCredentials;

describe('quota status command', () => {
  const originalStdoutIsTTY = process.stdout.isTTY;
  let exitSpy: MockInstance<typeof process.exit>;
  let writeSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    vi.clearAllMocks();
    spinnerTextUpdates.length = 0;
    spinnerMock._text = '';
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(
        (code?: string | number | null | undefined): never => {
          throw new Error(`process.exit:${code ?? 0}`);
        },
      );
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('offers only quota status', () => {
    expect(
      createQuotaCommand().commands.map((command) => command.name()),
    ).toEqual(['status']);
  });

  it('shows canceled local submissions without looking up credentials', async () => {
    vi.mocked(getQuotaStatus).mockResolvedValue({ entries: [] });

    await createQuotaCommand().parseAsync(['status', '--canceled', '--json'], {
      from: 'user',
    });

    expect(getQuotaStatus).toHaveBeenCalledWith('test-token', {
      canceledOnly: 'true',
    });
    expect(listApiCredentials).not.toHaveBeenCalled();
    expect(getApiCredential).not.toHaveBeenCalled();
  });

  it('reads quotas through the cloud CLI with --cloud, without the API', async () => {
    const clis = installFakeCloudClis({
      gcloud: [
        { match: ['config', 'get', 'project'], stdout: 'acme-prod\n' },
        { match: ['auth', 'print-access-token'], stdout: 'tok\n' },
        { match: ['config', 'get', 'account'], stdout: 'me@acme.com\n' },
        {
          match: ['compute', 'regions', 'describe'],
          stdout: { quotas: [{ metric: 'CPUS', limit: 24 }] },
        },
      ],
    });
    vi.stubEnv('PATH', clis.env.PATH);
    try {
      await createQuotaCommand().parseAsync(
        ['status', '--cloud', 'gcp', '--region', 'us-central1', '--json'],
        { from: 'user' },
      );
    } finally {
      vi.unstubAllEnvs();
      clis.cleanup();
    }
    const written = JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0]));
    expect(written).toEqual([
      expect.objectContaining({ resourceName: 'CPUS', currentLimit: 24 }),
    ]);
    expect(getQuotaStatus).not.toHaveBeenCalled();
    expect(listApiCredentials).not.toHaveBeenCalled();
  });

  it('exits 2 with the error document when --cloud lacks --region', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      createQuotaCommand().parseAsync(['status', '--cloud', 'gcp', '--json'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit:2');
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      error: { code: 'INVALID_ARGUMENT', message: expect.any(String) },
    });
    log.mockRestore();
  });

  it('rejects filters that the canceled view cannot apply', async () => {
    await expect(
      createQuotaCommand().parseAsync(
        ['status', '--canceled', '--credentials', 'prod'],
        { from: 'user' },
      ),
    ).rejects.toThrow('process.exit:1');

    expect(getQuotaStatus).not.toHaveBeenCalled();
  });

  it('renders current quota status rows instead of a no-requests message', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'my-aws', cloudProvider: CloudType.AWS },
    ]);
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'All P Spot Instance Requests',
          status: 'CURRENT',
          currentLimit: 96,
        },
      ],
    });

    await createQuotaCommand().parseAsync(
      ['status', '--credentials', 'my-aws'],
      { from: 'user' },
    );

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(listApiCredentials).toHaveBeenCalledWith('test-token');
    expect(getApiCredential).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalledWith('No quota requests found.');
    expect(output).toContain('Current nonzero quota limits');
    expect(output).toContain('us-east-1');
    expect(output).toContain('96');
  });

  it('shows unavailable Azure scopes alongside available Compute limits', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(false);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'my-azure', cloudProvider: CloudType.Azure },
    ]);
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.Azure,
          region: 'eastus2',
          resourceName: 'Total Regional vCPUs',
          resourceKey: 'azure:cores',
          status: 'CURRENT',
          currentLimit: 65,
        },
        {
          kind: 'unavailable',
          cloud: CloudType.Azure,
          region: 'eastus2',
          resourceName: 'Compute requests',
          status: 'UNAVAILABLE',
          message: 'Microsoft.Quota unregistered',
        },
      ],
    });

    await createQuotaCommand().parseAsync(
      ['status', '--credentials', 'my-azure'],
      { from: 'user' },
    );

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Unavailable in eastus2: Compute requests');
    expect(output).toContain('65');
  });

  it('prompts for quota type in interactive quota status and filters to spot', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'my-aws', cloudProvider: CloudType.AWS },
    ]);
    vi.mocked(safePrompts).mockResolvedValueOnce({ quotaType: 'spot' });
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'All P Spot Instance Requests',
          status: 'CURRENT',
          currentLimit: 96,
        },
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand P instances',
          status: 'CURRENT',
          currentLimit: 192,
        },
      ],
    });

    await createQuotaCommand().parseAsync(
      ['status', '--credentials', 'my-aws'],
      { from: 'user' },
    );

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(safePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'quotaType' }),
    );
    expect(getQuotaStatus).toHaveBeenCalledWith('test-token', {
      cloud: CloudType.AWS,
      credentialName: 'my-aws',
    });
    expect(output).toContain('SPOT');
    expect(output).toContain('96');
    expect(output).not.toContain('ON-DEMAND');
    expect(output).not.toContain('192');
  });

  it('honors --on-demand in quota status without prompting', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'my-aws', cloudProvider: CloudType.AWS },
    ]);
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'All P Spot Instance Requests',
          status: 'CURRENT',
          currentLimit: 96,
        },
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand P instances',
          status: 'CURRENT',
          currentLimit: 192,
        },
      ],
    });

    await createQuotaCommand().parseAsync(
      ['status', '--credentials', 'my-aws', '--on-demand'],
      { from: 'user' },
    );

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(safePrompts).not.toHaveBeenCalled();
    expect(output).toContain('ON-DEMAND');
    expect(output).toContain('192');
    expect(output).not.toContain('SPOT');
    expect(output).not.toContain('96');
  });

  it('does not prompt for quota type in json quota status unless filtered by flag', async () => {
    vi.mocked(shouldAllowPrompts).mockReturnValue(true);
    vi.mocked(listApiCredentials).mockResolvedValue([
      { name: 'my-aws', cloudProvider: CloudType.AWS },
    ]);
    vi.mocked(getQuotaStatus).mockResolvedValue({
      entries: [
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'All P Spot Instance Requests',
          status: 'CURRENT',
          currentLimit: 96,
        },
        {
          kind: 'current',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand P instances',
          status: 'CURRENT',
          currentLimit: 192,
        },
      ],
    });

    await createQuotaCommand().parseAsync(
      ['status', '--credentials', 'my-aws', '--json'],
      { from: 'user' },
    );

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    const entries = JSON.parse(output) as Array<{ currentLimit: number }>;
    expect(safePrompts).not.toHaveBeenCalled();
    expect(
      entries.map((entry) => entry.currentLimit).sort((a, b) => a - b),
    ).toEqual([96, 192]);
  });
});
