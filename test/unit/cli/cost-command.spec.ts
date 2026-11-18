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
  getCostReport: vi.fn(),
  getWorkloadCosts: vi.fn(),
}));

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: () => ({ start: () => ({ stop: () => undefined }) }),
    printInfo: vi.fn(),
    printError: vi.fn(),
  };
});

vi.mock('../../../src/shared/services/api-client/rpc.js', () => ({
  createApiClient: () => ({
    workloads: {
      cost: api.getWorkloadCosts,
      costReport: api.getCostReport,
    },
  }),
}));

vi.mock('../../../src/shared/services/api-client/runtime.js', () => ({
  getAnycloudVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(),
);

import { createCostCommand } from '../../../src/cli/commands/cost.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';
import { makeStoredWorkload } from '../helpers/fixtures.js';
import { type WorkloadCostReport as CostReport } from '../../../src/shared/api-contract/workload-management-schemas.js';

const getCostReport = api.getCostReport;
const getWorkloadCosts = api.getWorkloadCosts;

const emptyCostReport: CostReport = {
  periodMs: 30 * 24 * 60 * 60 * 1000,
  totalCost: 0,
  totalDurationMs: 0,
  totalJobs: 0,
  totalServices: 0,
  totalVms: 0,
  workloadsWithoutPrice: 0,
  byProvider: {},
  byAgent: {},
  byUser: {},
  includesOtherUsers: false,
};

describe('createCostCommand', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    setJsonMode(false);
    // Neutralize ambient agent markers so the default path is deterministic
    // regardless of whether the suite itself runs inside an agent.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CODEX_BIN_PATH', '');
    vi.stubEnv('CODEX_THREAD_ID', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('AIDER_MODEL', '');
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(getWorkloadCosts).mockResolvedValue([]);
    vi.mocked(getCostReport).mockResolvedValue(emptyCostReport);
  });

  afterEach(() => {
    setJsonMode(false);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('0036/S19 labels Deployment Job cost output while preserving a null JSON image', async () => {
    vi.mocked(getWorkloadCosts).mockResolvedValue([
      {
        ...makeStoredWorkload({ id: 'deployment-job' }),
        image: null,
        cloudProvider: null,
        region: null,
        vmType: null,
      },
    ]);
    await createCostCommand()
      .parseAsync(['node', 'test', 'deployment-job'])
      .catch(() => undefined);
    const humanOutput = logSpy.mock.calls
      .map(([line]) => String(line))
      .join('\n');
    expect(humanOutput).toContain('deployment-job — Deployment Job');

    logSpy.mockClear();
    await createCostCommand()
      .parseAsync(['node', 'test', 'deployment-job', '--json'])
      .catch(() => undefined);
    const jsonLine = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.startsWith('{'));
    expect(JSON.parse(jsonLine!)).toMatchObject({
      id: 'deployment-job',
      image: null,
    });
  });

  it('--session forwards the filter to the cost endpoint', async () => {
    await createCostCommand()
      .parseAsync(['node', 'test', '--session', 'claude-1234'])
      .catch(() => undefined);
    expect(getCostReport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ session: 'claude-1234' }),
      }),
    );
  });

  it('--agent forwards the filter to the cost endpoint', async () => {
    await createCostCommand()
      .parseAsync(['node', 'test', '--agent', 'cursor'])
      .catch(() => undefined);
    expect(getCostReport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ agent: 'cursor' }),
      }),
    );
  });

  it('omits session/agent when flags are absent and no agent is detected', async () => {
    await createCostCommand()
      .parseAsync(['node', 'test'])
      .catch(() => undefined);
    const call = vi.mocked(getCostReport).mock.calls[0]?.[0];
    expect(call?.query.session).toBeUndefined();
    expect(call?.query.agent).toBeUndefined();
  });

  it('auto-scopes to the caller session when an agent is detected', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'sess-auto');
    await createCostCommand()
      .parseAsync(['node', 'test'])
      .catch(() => undefined);
    const call = vi.mocked(getCostReport).mock.calls[0]?.[0];
    expect(call?.query.session).toBe('sess-auto');
  });

  it('explicit --session overrides the auto-scope', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'sess-auto');
    await createCostCommand()
      .parseAsync(['node', 'test', '--session', 'other'])
      .catch(() => undefined);
    const call = vi.mocked(getCostReport).mock.calls[0]?.[0];
    expect(call?.query.session).toBe('other');
  });

  it('passes the selected reporting window to the bounded cost query', async () => {
    const now = Date.UTC(2026, 6, 13, 12);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await createCostCommand()
      .parseAsync(['node', 'test', '--period', '7d'])
      .catch(() => undefined);

    expect(getCostReport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          sinceMs: String(now - 7 * 24 * 60 * 60 * 1000),
        }),
      }),
    );
    expect(vi.mocked(getCostReport).mock.calls[0]?.[0]).not.toHaveProperty(
      'params',
    );
  });

  it('uses an exact all-time request for a workload ID', async () => {
    await createCostCommand()
      .parseAsync(['node', 'test', 'historical-workload'])
      .catch(() => undefined);

    const call = vi.mocked(getWorkloadCosts).mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({ params: { id: 'historical-workload' } }),
    );
    expect(call?.query).not.toHaveProperty('sinceMs');
    expect(call?.query).not.toHaveProperty('limit');
  });

  it('uses canonical Service keys in aggregate JSON', async () => {
    vi.mocked(getCostReport).mockResolvedValue({
      periodMs: 123,
      totalCost: 10,
      totalDurationMs: 3 * 60 * 60 * 1000,
      totalJobs: 1,
      totalServices: 1,
      totalVms: 0,
      workloadsWithoutPrice: 0,
      byProvider: {
        AWS: {
          cost: 10,
          durationMs: 3 * 60 * 60 * 1000,
          jobs: 1,
          services: 1,
          vms: 0,
          hasSpot: false,
        },
      },
      byAgent: {},
      byUser: {},
      includesOtherUsers: true,
    });

    await createCostCommand()
      .parseAsync(['node', 'test', '--json'])
      .catch(() => undefined);

    const jsonLine = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.startsWith('{'));
    expect(jsonLine).toBeDefined();
    expect(JSON.parse(jsonLine!)).toMatchObject({
      totalCost: 10,
      totalJobs: 1,
      totalServices: 1,
      totalVms: 0,
      byProvider: {
        AWS: { cost: 10, jobs: 1, services: 1, vms: 0 },
      },
      periodMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(JSON.parse(jsonLine!)).not.toHaveProperty('includesOtherUsers');
  });

  it('renders Service terminology in human-readable cost output', async () => {
    vi.mocked(getCostReport).mockResolvedValue({
      ...emptyCostReport,
      totalCost: 4,
      totalDurationMs: 60 * 60 * 1000,
      totalServices: 1,
      byProvider: {
        AWS: {
          cost: 4,
          durationMs: 60 * 60 * 1000,
          jobs: 0,
          services: 1,
          vms: 0,
          hasSpot: false,
        },
      },
    });

    await createCostCommand()
      .parseAsync(['node', 'test'])
      .catch(() => undefined);

    const stdout = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(stdout).toContain('1 service');
    expect(stdout).toContain('SERVICES');
    expect(stdout).not.toContain('1 server');
  });

  it('renders a USER table when the only reported spend belongs to another user', async () => {
    vi.mocked(getCostReport).mockResolvedValue({
      ...emptyCostReport,
      totalCost: 4,
      totalDurationMs: 60 * 60 * 1000,
      totalJobs: 1,
      byUser: {
        teammate: {
          cost: 4,
          durationMs: 60 * 60 * 1000,
          jobs: 1,
          services: 0,
          vms: 0,
        },
      },
      includesOtherUsers: true,
    });

    await createCostCommand()
      .parseAsync(['node', 'test'])
      .catch(() => undefined);

    const stdout = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(stdout).toContain('USER');
    expect(stdout).toContain('teammate');
  });

  it('hides a one-row USER table when all reported spend belongs to the caller', async () => {
    vi.mocked(getCostReport).mockResolvedValue({
      ...emptyCostReport,
      totalCost: 4,
      totalDurationMs: 60 * 60 * 1000,
      totalJobs: 1,
      byUser: {
        'test-user': {
          cost: 4,
          durationMs: 60 * 60 * 1000,
          jobs: 1,
          services: 0,
          vms: 0,
        },
      },
      includesOtherUsers: false,
    });

    await createCostCommand()
      .parseAsync(['node', 'test'])
      .catch(() => undefined);

    const stdout = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(stdout).not.toContain('USER');
  });

  it('includes workloadType in a single-workload JSON report', async () => {
    vi.mocked(getWorkloadCosts).mockResolvedValue([
      makeStoredWorkload({
        id: 'service-1',
        workloadType: 'service',
        vmDurationMs: 60 * 60 * 1000,
        totalCost: 4,
      }),
    ]);

    await createCostCommand()
      .parseAsync(['node', 'test', 'service-1', '--json'])
      .catch(() => undefined);

    const jsonLine = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.startsWith('{'));
    expect(JSON.parse(jsonLine!)).toMatchObject({
      id: 'service-1',
      workloadType: 'service',
      totalCost: 4,
    });
  });

  // The human-readable branch renders this; the JSON branch enumerates its
  // fields, so it has to be added there deliberately or machine consumers see
  // a different report from the one on screen.
  it('includes awaitingReleaseMs in a single-workload JSON report', async () => {
    vi.mocked(getWorkloadCosts).mockResolvedValue([
      makeStoredWorkload({
        id: 'job-overran',
        vmDurationMs: 60 * 60 * 1000,
        awaitingReleaseMs: 26 * 60 * 1000,
        totalCost: 4,
      }),
    ]);

    await createCostCommand()
      .parseAsync(['node', 'test', 'job-overran', '--json'])
      .catch(() => undefined);

    const jsonLine = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.startsWith('{'));
    expect(JSON.parse(jsonLine!)).toMatchObject({
      id: 'job-overran',
      durationMs: 60 * 60 * 1000,
      awaitingReleaseMs: 26 * 60 * 1000,
    });
  });
});
