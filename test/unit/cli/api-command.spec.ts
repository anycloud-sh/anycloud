import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const spinner = {
  start: vi.fn(() => spinner),
  stop: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
};

const mocks = vi.hoisted(() => ({
  createWorkload: vi.fn(),
  discoverApiTargetRows: vi.fn(),
  grantApiAccessUser: vi.fn(),
  getActiveApiTargetInfo: vi.fn(),
  getWorkloadStatus: vi.fn(),
  listApiAccessUsers: vi.fn(),
  persistApiTarget: vi.fn(),
  printError: vi.fn(),
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  printWarning: vi.fn(),
  reconcileLocalApi: vi.fn(),
  revokeApiAccessUser: vi.fn(),
  apiBearer: vi.fn(),
  resolveApiTarget: vi.fn(),
  resolveApiTargetArgument: vi.fn(),
  resolveGitHubToken: vi.fn(),
  resolveLocalApiTarget: vi.fn(),
  selectApiTarget: vi.fn(),
  selectableApiTargets: vi.fn(),
  setJsonMode: vi.fn(),
  shouldAllowPrompts: vi.fn(),
  safePrompts: vi.fn(),
  activeVmHostedApi: vi.fn(),
  systemReleaseStatus: vi.fn(),
  systemReleaseRequest: vi.fn(),
  systemReleaseKubernetes: vi.fn(),
  clustersList: vi.fn(),
  remainingRemovedWorkloads: vi.fn(async (): Promise<unknown[]> => []),
  createApiClientOptions: vi.fn(),
  /** `docker inspect --format {{.RestartCount}}`; null when no container. */
  restartCount: vi.fn((): string | null => null),
}));

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: ((command: string, args: readonly string[], options: never) => {
      if (command === 'docker' && args.includes('{{.RestartCount}}')) {
        const count = mocks.restartCount();
        return count === null
          ? { status: 1, stdout: '' }
          : { status: 0, stdout: `${count}\n` };
      }
      return actual.spawnSync(command, args, options);
    }) as typeof actual.spawnSync,
  };
});

vi.mock('../../../src/cli/utils/output.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/cli/utils/output.js')>();
  return {
    ...actual,
    createSpinner: vi.fn(() => spinner),
    printError: mocks.printError,
    printInfo: mocks.printInfo,
    printSuccess: mocks.printSuccess,
    printWarning: mocks.printWarning,
    setJsonMode: mocks.setJsonMode,
  };
});

vi.mock('../../../src/cli/utils/safe-prompts.js', () => ({
  shouldAllowPrompts: mocks.shouldAllowPrompts,
  safePrompts: mocks.safePrompts,
}));

vi.mock('../../../src/shared/services/auth.js', () => ({
  resolveGitHubToken: mocks.resolveGitHubToken,
  optionalGitHubToken: () => {
    try {
      return mocks.resolveGitHubToken() as string | null;
    } catch {
      return null;
    }
  },
}));

vi.mock('../../../src/cli/services/auth.js', async () =>
  (await import('./cli-auth-mock.js')).cliAuthMock(() => mocks.apiBearer()),
);

vi.mock('../../../src/cli/commands/shared.js', () => ({
  parseEnvVars: vi.fn(),
}));

vi.mock('../../../src/shared/config.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/shared/config.js')>();
  return {
    ...actual,
    resolveApiTarget: mocks.resolveApiTarget,
    resolveLocalApiTarget: mocks.resolveLocalApiTarget,
  };
});

vi.mock('../../../src/cli/services/api-target.js', async (importActual) => ({
  vmHostedApiMigrationMessage: (
    await importActual<
      typeof import('../../../src/cli/services/api-target.js')
    >()
  ).vmHostedApiMigrationMessage,
  activeVmHostedApi: mocks.activeVmHostedApi,
  describeApiUrlSource: vi.fn(() => 'default local API'),
  discoverApiTargetRows: mocks.discoverApiTargetRows,
  getActiveApiTargetInfo: mocks.getActiveApiTargetInfo,
  persistApiTarget: mocks.persistApiTarget,
  resolveApiTargetArgument: mocks.resolveApiTargetArgument,
  sameApiUrl: (a: string, b: string) =>
    a.replace(/\/+$/, '') === b.replace(/\/+$/, ''),
  selectableApiTargets: mocks.selectableApiTargets,
  selectApiTarget: mocks.selectApiTarget,
}));

vi.mock(
  '../../../src/cli/use-cases/removed-workloads.js',
  async (importActual) => ({
    ...(await importActual()),
    remainingRemovedWorkloads: mocks.remainingRemovedWorkloads,
  }),
);

vi.mock(
  '../../../src/cli/services/local-api-update.js',
  async (importActual) => ({
    ...(await importActual()),
    reconcileLocalApi: mocks.reconcileLocalApi,
  }),
);

vi.mock('../../../src/shared/services/api-client/rpc.js', async (actual) => ({
  ...(await actual<
    typeof import('../../../src/shared/services/api-client/rpc.js')
  >()),
  createApiClient: (_token: string, options?: unknown) => ({
    ...(mocks.createApiClientOptions(options) as object),
    systemRelease: {
      status: mocks.systemReleaseStatus,
      request: mocks.systemReleaseRequest,
      kubernetes: mocks.systemReleaseKubernetes,
    },
    clusters: {
      list: mocks.clustersList,
    },
    admission: { submit: mocks.createWorkload },
    workloads: { status: mocks.getWorkloadStatus },
    apiAccess: {
      grant: mocks.grantApiAccessUser,
      list: mocks.listApiAccessUsers,
      revoke: mocks.revokeApiAccessUser,
    },
  }),
}));

import { ORPCError } from '@orpc/client';
import { createApiCommand } from '../../../src/cli/commands/api.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { type ApiTargetDiscovery } from '../../../src/cli/services/api-target.js';

function discovery(): ApiTargetDiscovery {
  return {
    activeUrl: 'http://localhost:8080',
    activeSource: 'default',
    warnings: ['hosted list warning'],
    targets: [
      {
        current: true,
        kind: 'local',
        id: 'local',
        label: 'local',
        url: 'http://localhost:8080',
        health: 'healthy',
        apiVersion: '0.1.34',
        compatible: true,
        source: 'default',
      },
      {
        current: false,
        kind: 'manual',
        id: 'api-1',
        label: 'active',
        url: 'https://api-1.anycloud.sh',
        health: 'healthy',
        apiVersion: '0.1.33',
        compatible: false,
        source: 'manual',
      },
    ],
  };
}

function hostedDiscovery(): ApiTargetDiscovery {
  const rows = discovery();
  const [local, hosted] = rows.targets;
  return {
    ...rows,
    activeUrl: 'https://api-1.anycloud.sh',
    activeSource: 'file',
    targets: [
      { ...local, current: false },
      { ...hosted, current: true },
    ],
  };
}

async function runApi(argv: string[]) {
  const cmd = createApiCommand();
  cmd.exitOverride();
  await cmd.parseAsync(argv, { from: 'user' });
}

function useHostedActive(rows = hostedDiscovery()) {
  mocks.resolveApiTarget.mockReturnValue({
    url: 'https://api-1.anycloud.sh',
    source: 'file',
  });
  mocks.discoverApiTargetRows.mockResolvedValue(rows);
}

describe('api command', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.restartCount.mockReturnValue(null);
    mocks.resolveGitHubToken.mockReturnValue('gh-token');
    mocks.apiBearer.mockResolvedValue('gh-token');
    mocks.discoverApiTargetRows.mockResolvedValue(discovery());
    mocks.reconcileLocalApi.mockResolvedValue(undefined);
    mocks.systemReleaseKubernetes.mockResolvedValue({ step: null });
    mocks.clustersList.mockResolvedValue({ clusters: [] });
    // A Docker-hosted API has no release surface: the legacy path is taken.
    mocks.systemReleaseStatus.mockRejectedValue(
      new ORPCError('SYSTEM_RELEASE_UNAVAILABLE', { status: 503 }),
    );
    mocks.resolveApiTarget.mockReturnValue({
      url: 'http://localhost:8080',
      source: 'default',
      localApiContainer: { running: true, hostPort: 8080 },
    });
    mocks.resolveLocalApiTarget.mockReturnValue({
      url: 'http://localhost:8080',
      source: 'default',
      localApiContainer: { running: true, hostPort: 8080 },
    });
    mocks.activeVmHostedApi.mockResolvedValue(null);
    mocks.shouldAllowPrompts.mockReturnValue(true);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('api list prints a read-only table and warnings', async () => {
    await runApi(['list']);

    expect(mocks.discoverApiTargetRows).toHaveBeenCalledWith();
    expect(mocks.printWarning).toHaveBeenCalledWith('hosted list warning');
    expect(mocks.persistApiTarget).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('api-1'));
  });

  it('api list omits the table when no API targets are available', async () => {
    mocks.discoverApiTargetRows.mockResolvedValue({
      activeUrl: 'http://localhost:8080',
      activeSource: 'default',
      warnings: [
        'No local API server is running at http://localhost:8080. Start one with: anycloud api start',
      ],
      targets: [],
    });

    await runApi(['list']);

    expect(mocks.printWarning).toHaveBeenCalledWith(
      'No local API server is running at http://localhost:8080. Start one with: anycloud api start',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('api list --json emits discovery data without warnings on stdout', async () => {
    await runApi(['list', '--json']);

    expect(mocks.setJsonMode).toHaveBeenCalledWith(true);
    expect(mocks.printWarning).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(discovery()));
  });

  it('api use with no target is the interactive mutating path', async () => {
    const selected = {
      id: 'local',
      label: 'local',
      url: 'http://localhost:8080',
      source: 'local',
    };
    mocks.selectableApiTargets.mockReturnValue([selected]);
    mocks.selectApiTarget.mockResolvedValue(selected);

    await runApi(['use']);

    expect(mocks.selectApiTarget).toHaveBeenCalled();
    expect(mocks.persistApiTarget).toHaveBeenCalledWith(selected);
  });

  it.each(['status', 'use'])(
    'api %s warns about an active legacy target without migrating it',
    async (command) => {
      useHostedActive();
      const legacy = {
        id: 'api-1',
        url: 'https://api-1.anycloud.sh',
        installerUrl: 'http://localhost:8787',
      };
      mocks.activeVmHostedApi.mockResolvedValue(legacy);
      mocks.getActiveApiTargetInfo.mockResolvedValue({
        url: legacy.url,
        source: 'file',
        healthy: true,
        compatible: false,
      });
      const candidate = {
        id: 'manual',
        label: legacy.url,
        url: legacy.url,
        source: 'manual',
      };
      mocks.resolveApiTargetArgument.mockReturnValue(candidate);

      mocks.systemReleaseStatus.mockResolvedValue(null);
      await runApi(command === 'use' ? ['use', legacy.url] : ['status']);

      expect(mocks.printWarning).toHaveBeenCalledWith(
        expect.stringContaining(
          'API_URL=http://localhost:8787 anycloud terminate',
        ),
      );
      expect(mocks.createWorkload).not.toHaveBeenCalled();
      expect(mocks.systemReleaseRequest).not.toHaveBeenCalled();
      expect(mocks.reconcileLocalApi).not.toHaveBeenCalled();
    },
  );

  it('api use saves the target even when the legacy check fails', async () => {
    const candidate = {
      id: 'manual',
      label: 'https://api-1.anycloud.sh',
      url: 'https://api-1.anycloud.sh',
      source: 'manual',
    };
    mocks.resolveApiTargetArgument.mockReturnValue(candidate);
    mocks.activeVmHostedApi.mockRejectedValue(
      new Error('Could not read the local API token'),
    );

    await runApi(['use', candidate.url]);

    expect(mocks.persistApiTarget).toHaveBeenCalledWith(candidate);
    expect(mocks.printWarning).toHaveBeenCalledWith(
      expect.stringContaining('Could not read the local API token'),
    );
    expect(mocks.printInfo).toHaveBeenCalledWith(
      expect.stringContaining('Saved to'),
    );
  });

  it('api use with no target fails clearly outside an interactive terminal', async () => {
    mocks.shouldAllowPrompts.mockReturnValue(false);

    await expect(runApi(['use'])).rejects.toThrow(/process\.exit:1/);

    expect(mocks.printError).toHaveBeenCalledWith(
      'Pass an API URL or "local".',
    );
    expect(mocks.apiBearer).not.toHaveBeenCalled();
  });

  it('api status surfaces errors cleanly instead of an unhandled rejection', async () => {
    mocks.getActiveApiTargetInfo.mockRejectedValue(
      new Error('active API unreachable'),
    );

    await expect(runApi(['status'])).rejects.toThrow(/process\.exit:1/);

    expect(mocks.printError).toHaveBeenCalledWith('active API unreachable');
  });

  it('api upgrade reconciles only local when local is active', async () => {
    await runApi(['upgrade']);

    expect(mocks.reconcileLocalApi).toHaveBeenCalledWith(packageJson.version, {
      startIfStopped: true,
    });
    expect(mocks.apiBearer).not.toHaveBeenCalled();
    expect(mocks.activeVmHostedApi).not.toHaveBeenCalled();
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      `Local API matches anycloud ${packageJson.version}.`,
    );
  });

  it('restarts a stopped persisted local target on its custom port', async () => {
    mocks.resolveApiTarget.mockReturnValue({
      url: 'http://localhost:9000',
      source: 'file',
    });
    mocks.resolveLocalApiTarget.mockReturnValue({
      url: 'http://localhost:8080',
      source: 'default',
      localApiContainer: {
        running: false,
        hostPort: null,
        failure: 'missing',
      },
    });

    await runApi(['upgrade']);

    expect(mocks.reconcileLocalApi).toHaveBeenCalledWith(packageJson.version, {
      startIfStopped: true,
      startPort: 9000,
    });
    expect(mocks.apiBearer).not.toHaveBeenCalled();
    expect(mocks.activeVmHostedApi).not.toHaveBeenCalled();
  });

  it('api upgrade names a VM-hosted API for what it is and points at cluster create', async () => {
    useHostedActive();

    mocks.activeVmHostedApi.mockResolvedValue({
      id: 'api-1',
      url: 'https://api-1.anycloud.sh',
      installerUrl: 'http://localhost:8080',
    });

    await expect(runApi(['upgrade'])).rejects.toThrow(/process\.exit:1/);

    expect(mocks.reconcileLocalApi).not.toHaveBeenCalled();
    expect(mocks.activeVmHostedApi).toHaveBeenCalledWith();
    const message = mocks.printError.mock.calls[0]?.[0] as string;
    expect(message).toContain(
      'https://api-1.anycloud.sh is a VM-hosted API (the removed anycloud api serve)',
    );
    expect(message).toContain('anycloud api create <name>');
    expect(message).toContain(
      'anycloud api use https://<cluster-id>.anycloud.sh',
    );
    expect(message).toContain('anycloud terminate api-1');
    expect(mocks.persistApiTarget).not.toHaveBeenCalled();
  });

  it("api upgrade asks a Helm-managed API for this CLI's release and reports the applied intent", async () => {
    useHostedActive();
    mocks.systemReleaseStatus.mockResolvedValue({
      servedVersion: '0.0.1',
      schemaVersion: '0.0.1',
      upgrade: null,
      rollout: null,
    });
    mocks.systemReleaseRequest.mockResolvedValue({
      unchanged: false,
      upgrade: {
        number: 1,
        apiVersion: packageJson.version,
        apiImage: `${packageJson.apiImage}:${packageJson.version}@sha256:${'b'.repeat(64)}`,
        state: 'starting',
        lastError: null,
      },
    });

    // `update` is the alias of `upgrade`.
    await runApi(['update']);

    // A signed-out hosted target is "not run" (exit 2), like the other
    // lifecycle commands (cluster.md, Results for scripts).
    expect(mocks.createApiClientOptions).toHaveBeenCalledWith({
      apiUrl: 'https://api-1.anycloud.sh',
      missingExitCode: 2,
    });
    expect(mocks.systemReleaseRequest).toHaveBeenCalledWith({
      image: `${packageJson.apiImage}:${packageJson.version}`,
    });
    expect(mocks.activeVmHostedApi).not.toHaveBeenCalled();
    // The verdict is a plain line with the upgrade number, not a spinner
    // message (a non-TTY run prints none).
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      `Hosted API upgrade 1 started: 0.0.1 → ${packageJson.version}.`,
    );
    // A hosted API needs no Docker: the local API is never inspected,
    // started or restarted.
    expect(mocks.reconcileLocalApi).not.toHaveBeenCalled();
    expect(mocks.printInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        'Run "anycloud api status --watch" to follow the upgrade',
      ),
    );
  });

  it('api upgrade --json prints one result naming the old and new API versions, or the refusal', async () => {
    const stdout = () =>
      logSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown);
    mocks.reconcileLocalApi.mockResolvedValue('0.0.9');
    await runApi(['upgrade', '--json']);
    expect(stdout()).toEqual([
      {
        outcome: 'local',
        api: {
          url: 'http://localhost:8080',
          previousVersion: '0.0.9',
          version: packageJson.version,
        },
        upgrade: null,
        k3s: null,
      },
    ]);

    useHostedActive();
    mocks.systemReleaseStatus.mockResolvedValue({
      servedVersion: '0.0.1',
      schemaVersion: '0.0.1',
      upgrade: null,
      rollout: null,
    });
    mocks.systemReleaseRequest.mockResolvedValueOnce({
      unchanged: false,
      upgrade: {
        number: 3,
        apiVersion: packageJson.version,
        apiImage: `${packageJson.apiImage}:${packageJson.version}@sha256:${'b'.repeat(64)}`,
        state: 'starting',
        lastError: null,
      },
    });
    mocks.systemReleaseKubernetes.mockResolvedValueOnce({
      step: {
        id: 'step0001',
        state: 'succeeded',
        configuration: 'changed',
        startedAt: null,
        finishedAt: null,
        reason: null,
      },
    });
    logSpy.mockClear();
    await runApi(['upgrade', '--json']);
    expect(stdout()).toEqual([
      {
        outcome: 'started',
        api: {
          url: 'https://api-1.anycloud.sh',
          previousVersion: '0.0.1',
          version: packageJson.version,
        },
        upgrade: 3,
        k3s: { configuration: 'changed' },
      },
    ]);
    expect(mocks.printSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining('Hosted API upgrade 3'),
    );

    mocks.systemReleaseRequest.mockRejectedValueOnce(
      new ORPCError('SYSTEM_RELEASE_REFUSED', {
        defined: true,
        status: 400,
        message: 'Release refused: image is older than the served version',
      }),
    );
    logSpy.mockClear();
    await expect(runApi(['upgrade', '--json'])).rejects.toThrow(
      /process\.exit:1/,
    );
    // The first document; the mocked exit returns into the command's catch.
    expect(stdout()[0]).toEqual({
      error: {
        code: 'SYSTEM_RELEASE_REFUSED',
        message: 'Release refused: image is older than the served version',
      },
    });
  });

  describe('api upgrade and the K3s step', () => {
    const step = {
      id: 'step0001',
      state: 'succeeded',
      configuration: 'changed',
      startedAt: null,
      finishedAt: null,
      reason: null,
    };

    beforeEach(() => {
      useHostedActive();
      mocks.systemReleaseStatus.mockResolvedValue({
        servedVersion: '0.0.1',
        schemaVersion: '0.0.1',
        upgrade: null,
        rollout: null,
      });
      mocks.systemReleaseRequest.mockResolvedValue({
        unchanged: true,
        upgrade: null,
      });
    });

    it('runs before the hosted upgrade, from any machine, and reports its result', async () => {
      mocks.systemReleaseKubernetes.mockResolvedValue({ step });
      await runApi(['upgrade']);

      const image = `${packageJson.apiImage}:${packageJson.version}`;
      expect(mocks.systemReleaseKubernetes).toHaveBeenCalledExactlyOnceWith({
        id: expect.stringMatching(/^[a-z0-9]{16}$/u),
        image,
      });
      const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
        mock.mock.invocationCallOrder[0]!;
      expect(order(mocks.systemReleaseKubernetes)).toBeLessThan(
        order(mocks.systemReleaseRequest),
      );
      expect(mocks.printInfo).toHaveBeenCalledWith(
        'K3s step: configuration changed, Kubernetes ready',
      );
      // No SSH: nothing asks the local API for the cluster.
      expect(mocks.clustersList).not.toHaveBeenCalled();
    });

    it('does not request the hosted upgrade when the K3s step fails', async () => {
      mocks.systemReleaseKubernetes.mockResolvedValue({
        step: {
          ...step,
          state: 'failed',
          reason:
            'the K3s step exited 75: Kubernetes did not become ready within 5 minutes',
        },
      });
      await expect(runApi(['upgrade'])).rejects.toThrow('process.exit:1');
      expect(mocks.printError).toHaveBeenCalledWith(
        expect.stringContaining(
          'The K3s step failed: the K3s step exited 75: Kubernetes did not become ready within 5 minutes. The hosted API upgrade was not requested',
        ),
      );
      expect(mocks.systemReleaseRequest).not.toHaveBeenCalled();
    });
  });

  it('api upgrade prints the refusal as a plain stderr line with the API reason', async () => {
    useHostedActive();
    mocks.systemReleaseStatus.mockResolvedValue({
      servedVersion: '0.0.1',
      schemaVersion: '0.0.1',
      upgrade: null,
      rollout: null,
    });
    mocks.systemReleaseRequest.mockRejectedValue(
      new Error('Release refused: image is older than the served version'),
    );
    await expect(runApi(['upgrade'])).rejects.toThrow(/process\.exit:1/);
    expect(mocks.printError).toHaveBeenCalledWith(
      'Hosted API upgrade refused: Release refused: image is older than the served version',
    );
    expect(mocks.printSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining('Hosted API upgrade'),
    );
  });

  it('api upgrade refuses, naming them, while the hosted API runs node pools, Deployments or node pool Services', async () => {
    useHostedActive();
    mocks.systemReleaseStatus.mockResolvedValue({
      servedVersion: '0.0.1',
      schemaVersion: '0.0.1',
      upgrade: null,
      rollout: null,
    });
    mocks.remainingRemovedWorkloads.mockResolvedValueOnce([
      { kind: 'node pool Service', id: 'svc-1', name: 'svc-1' },
      { kind: 'node pool', id: 'np-1', name: 'gpu' },
    ]);
    await expect(runApi(['upgrade', '--json'])).rejects.toThrow(
      /process\.exit:1/,
    );
    // Read with the served version, before anything else.
    expect(mocks.remainingRemovedWorkloads).toHaveBeenCalledWith(
      'https://api-1.anycloud.sh',
      '0.0.1',
      'gh-token',
    );
    const [document] = logSpy.mock.calls.map(
      (call) =>
        JSON.parse(String(call[0])) as {
          error: { code: string; message: string };
        },
    );
    expect(document!.error.code).toBe('REMOVED_WORKLOADS_REMAIN');
    expect(document!.error.message).toContain(
      '  node pool Service svc-1\n  node pool gpu (np-1)\n',
    );
    expect(mocks.systemReleaseKubernetes).not.toHaveBeenCalled();
    expect(mocks.systemReleaseRequest).not.toHaveBeenCalled();
  });

  it('api status shows a hosted API running with its latest upgrade as one ✓/◌/✗ line', async () => {
    useHostedActive();
    mocks.getActiveApiTargetInfo.mockResolvedValue({
      url: 'https://api-1.anycloud.sh',
      source: 'file',
      sourceLabel: '~/.anycloud/api-url',
      healthy: true,
      cliVersion: packageJson.version,
      apiVersion: packageJson.version,
      compatible: true,
    });
    const release = {
      servedVersion: packageJson.version,
      schemaVersion: packageJson.version,
      upgrade: {
        number: 2,
        apiVersion: packageJson.version,
        apiImage: 'img',
        state: 'starting',
        lastError: null,
        createdAt: 0,
        updatedAt: 0,
      },
      rollout: {
        observedGeneration: 2,
        replicas: 2,
        updatedReplicas: 1,
        readyReplicas: 1,
        conditions: [],
      },
    };
    mocks.systemReleaseStatus.mockResolvedValue(release);
    await runApi(['status']);
    const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain('running');
    expect(printed).toContain('https://api-1.anycloud.sh');
    expect(printed).toContain(`Upgrade 2 · ${packageJson.version}`);
    expect(printed).toContain('◌ api  starting · 1/2 ready');
    expect(printed).not.toMatch(/revision|rolling|operation/u);
    expect(mocks.systemReleaseRequest).not.toHaveBeenCalled();

    logSpy.mockClear();
    mocks.systemReleaseStatus.mockResolvedValue({
      ...release,
      upgrade: {
        ...release.upgrade,
        state: 'failed',
        lastError: 'the ready check failed: BackoffLimitExceeded',
      },
    });
    await runApi(['status']);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '✗ api  failed · 1/2 ready: the ready check failed: BackoffLimitExceeded',
      ),
    );

    logSpy.mockClear();
    await runApi(['status', '--json']);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      url: 'https://api-1.anycloud.sh',
      release: { upgrade: { number: 2, state: 'failed' } },
    });
  });

  describe('api status --watch', () => {
    const info = (healthy = true) => ({
      url: 'https://api-1.anycloud.sh',
      source: 'file',
      sourceLabel: '~/.anycloud/api-url',
      healthy,
      cliVersion: packageJson.version,
      apiVersion: packageJson.version,
      compatible: true,
    });
    const release = (state: string, lastError: string | null = null) => ({
      servedVersion: packageJson.version,
      schemaVersion: packageJson.version,
      upgrade: {
        number: 2,
        apiVersion: packageJson.version,
        apiImage: 'img',
        state,
        lastError,
        createdAt: 0,
        updatedAt: 0,
      },
      rollout: null,
    });
    const progress = () =>
      mocks.printInfo.mock.calls
        .map(([line]) => String(line))
        .filter((line) => /^\[.+\] /u.test(line))
        .map((line) => line.replace(/^\[.+\] /u, ''));

    it('prints each upgrade state change, waits out an API that stops answering, then the final status', async () => {
      useHostedActive();
      mocks.getActiveApiTargetInfo
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(info(false))
        .mockResolvedValueOnce(info());
      mocks.systemReleaseStatus
        .mockResolvedValueOnce(release('starting'))
        .mockResolvedValueOnce(release('running'));
      await runApi(['status', '--watch', '--interval', '1']);
      expect(progress()).toEqual([
        'Upgrade 2 starting',
        'not answering',
        'Upgrade 2 running',
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('✓ api  running'),
      );
    });

    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    it.each([
      ['a 503', new ORPCError('SERVICE_UNAVAILABLE', { status: 503 })],
      [
        'a fetch failure',
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        }),
      ],
    ])(
      'waits out %s from the upgrade read once the API has answered',
      async (_label, gap) => {
        useHostedActive();
        mocks.getActiveApiTargetInfo.mockResolvedValue(info());
        mocks.systemReleaseStatus
          .mockResolvedValueOnce(release('starting'))
          .mockRejectedValueOnce(gap)
          .mockResolvedValueOnce(release('running'));
        await runApi(['status', '--watch', '--interval', '1']);
        expect(progress()).toEqual([
          'Upgrade 2 starting',
          'not answering',
          'Upgrade 2 running',
        ]);
      },
    );

    it.each([
      ['a 4xx', new ORPCError('BAD_REQUEST', { status: 400 })],
      ['a TypeError from our own code', new TypeError('x is not a function')],
      ['a timeout', timeout],
    ])('stops on %s after the API has answered', async (_label, error) => {
      useHostedActive();
      mocks.getActiveApiTargetInfo.mockResolvedValue(info());
      mocks.systemReleaseStatus
        .mockResolvedValueOnce(release('starting'))
        .mockRejectedValueOnce(error);
      await expect(
        runApi(['status', '--watch', '--interval', '1']),
      ).rejects.toThrow(/process\.exit:1/);
      expect(mocks.systemReleaseStatus).toHaveBeenCalledTimes(2);
    });

    it('reports an API that never answered at once, as without --watch', async () => {
      useHostedActive();
      mocks.getActiveApiTargetInfo.mockResolvedValue(info(false));
      await expect(
        runApi(['status', '--watch', '--interval', '1']),
      ).rejects.toThrow(/process\.exit:1/);
      expect(mocks.getActiveApiTargetInfo).toHaveBeenCalledTimes(1);
      expect(progress()).toEqual([]);
      expect(mocks.printError).toHaveBeenCalledWith(
        expect.stringContaining('is not answering'),
      );
    });

    it('ends at once with no upgrade in progress, and on a stopped local API', async () => {
      useHostedActive();
      mocks.getActiveApiTargetInfo.mockResolvedValue(info());
      mocks.systemReleaseStatus.mockResolvedValue({
        ...release('starting'),
        upgrade: null,
      });
      await runApi(['status', '--watch', '--interval', '1']);
      expect(mocks.getActiveApiTargetInfo).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      mocks.getActiveApiTargetInfo.mockResolvedValue({
        ...info(false),
        url: 'http://localhost:8080',
        source: 'default',
      });
      await runApi(['status', '--watch', '--interval', '1']);
      expect(mocks.getActiveApiTargetInfo).toHaveBeenCalledTimes(1);
      expect(progress()).toEqual([]);
      expect(mocks.printInfo).toHaveBeenCalledWith(
        'Local API server is not running.',
      );
    });

    it('is done on a failed upgrade, and prints one JSON document per read', async () => {
      useHostedActive();
      mocks.getActiveApiTargetInfo.mockResolvedValue(info());
      mocks.systemReleaseStatus
        .mockResolvedValueOnce(release('starting'))
        .mockResolvedValueOnce(release('failed', 'the ready check failed'));
      await runApi(['status', '--watch', '--interval', '1', '--json']);
      expect(
        logSpy.mock.calls.map(
          ([line]) =>
            (
              JSON.parse(String(line)) as {
                release: ReturnType<typeof release>;
              }
            ).release.upgrade.state,
        ),
      ).toEqual(['starting', 'failed']);
      expect(progress()).toEqual([]);
    });
  });

  it('api status reports a stopped local API with how to start it, and an unreachable hosted one as an error', async () => {
    mocks.getActiveApiTargetInfo.mockResolvedValue({
      url: 'http://localhost:8080',
      source: 'default',
      sourceLabel: 'default local API',
      healthy: false,
      cliVersion: packageJson.version,
      compatible: false,
    });
    await runApi(['status']);
    expect(mocks.printInfo).toHaveBeenCalledWith(
      'Start it with: anycloud api start',
    );
    expect(mocks.systemReleaseStatus).not.toHaveBeenCalled();

    mocks.getActiveApiTargetInfo.mockResolvedValue({
      url: 'https://api-1.anycloud.sh',
      source: 'file',
      sourceLabel: '~/.anycloud/api-url',
      healthy: false,
      cliVersion: packageJson.version,
      compatible: false,
    });
    await expect(runApi(['status'])).rejects.toThrow(/process\.exit:1/);
    // Found by F run 18: the API cannot see the edge reconnecting.
    expect(mocks.printError).toHaveBeenCalledWith(
      expect.stringContaining('may answer 503 for a few seconds'),
    );
  });

  it('api status shows a crash-looping local container as starting with its restarts, not as stopped', async () => {
    mocks.restartCount.mockReturnValue('3');
    mocks.getActiveApiTargetInfo.mockResolvedValue({
      url: 'http://localhost:8080',
      source: 'default',
      sourceLabel: 'default local API',
      healthy: false,
      cliVersion: packageJson.version,
      compatible: false,
    });
    await runApi(['status']);
    const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain('starting');
    expect(printed).toMatch(/Restarts\s+3: it has crashed/u);
    expect(mocks.printInfo).toHaveBeenCalledWith(
      'It is not answering yet. Check why with: anycloud api logs',
    );
    expect(mocks.printInfo).not.toHaveBeenCalledWith(
      'Start it with: anycloud api start',
    );
  });

  it.each([
    ['signed out', null],
    ['with an unreadable saved token', 'UNREADABLE'],
    ['not on the access list', 'FORBIDDEN'],
    ['refused its token', 'UNAUTHORIZED'],
  ])(
    'api status still shows a hosted API to an account %s, without its upgrades',
    async (_case, code) => {
      useHostedActive();
      mocks.getActiveApiTargetInfo.mockResolvedValue({
        url: 'https://api-1.anycloud.sh',
        source: 'file',
        sourceLabel: '~/.anycloud/api-url',
        healthy: true,
        cliVersion: packageJson.version,
        apiVersion: packageJson.version,
        compatible: true,
      });
      if (code === null) mocks.resolveGitHubToken.mockReturnValue(null);
      else if (code === 'UNREADABLE') {
        mocks.resolveGitHubToken.mockImplementation(() => {
          throw new Error('Could not read the saved token');
        });
      } else {
        mocks.systemReleaseStatus.mockRejectedValue(
          new ORPCError(code, { status: code === 'FORBIDDEN' ? 403 : 401 }),
        );
      }
      await runApi(['status']);
      const printed = logSpy.mock.calls
        .map(([line]) => String(line))
        .join('\n');
      expect(printed).toContain('https://api-1.anycloud.sh');
      expect(printed).toContain(packageJson.version);
      expect(mocks.printError).not.toHaveBeenCalled();
      expect(mocks.printInfo).toHaveBeenCalledWith(
        expect.stringContaining('shown only to accounts it admits'),
      );
      expect(mocks.printWarning).not.toHaveBeenCalled();
    },
  );

  it('api upgrade --image pins or rolls back a Helm-managed API', async () => {
    useHostedActive();
    mocks.systemReleaseStatus.mockResolvedValue({
      servedVersion: packageJson.version,
      schemaVersion: packageJson.version,
      upgrade: null,
      rollout: null,
    });

    // Already matching without --image: nothing is requested.
    await runApi(['upgrade']);
    expect(mocks.systemReleaseRequest).not.toHaveBeenCalled();
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      expect.stringContaining('already matches'),
    );

    const older = `${packageJson.apiImage}:0.0.1@sha256:${'a'.repeat(64)}`;
    mocks.systemReleaseRequest.mockResolvedValue({
      unchanged: false,
      upgrade: {
        number: 2,
        apiVersion: '0.0.1',
        apiImage: older,
        state: 'starting',
        lastError: null,
      },
    });
    await runApi(['upgrade', '--image', older]);
    expect(mocks.systemReleaseRequest).toHaveBeenCalledWith({ image: older });

    // The image the API already runs: nothing to report beyond that.
    mocks.systemReleaseRequest.mockResolvedValue({
      unchanged: true,
      upgrade: null,
    });
    await runApi(['upgrade', '--image', older]);
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      `Hosted API https://api-1.anycloud.sh already runs ${older}; nothing to do (unchanged).`,
    );

    // An older API starts the upgrade without naming it: never "nothing to do".
    mocks.printSuccess.mockClear();
    // v0.1.65's response: `release`, no `upgrade` key.
    mocks.systemReleaseRequest.mockResolvedValue({
      unchanged: false,
      release: {
        revision: 2,
        operationId: 'op-1',
        apiVersion: '0.0.1',
        apiImage: older,
        state: 'applied',
      },
    });
    await runApi(['upgrade', '--image', older]);
    expect(mocks.printSuccess).toHaveBeenCalledWith(
      `Hosted API https://api-1.anycloud.sh accepted the upgrade to ${older}.`,
    );
    expect(mocks.printInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        `"anycloud api status" until it no longer reports version ${packageJson.version}`,
      ),
    );
  });

  it('api upgrade refuses --image against an API without the release surface', async () => {
    useHostedActive();
    await expect(
      runApi(['upgrade', '--image', 'ghcr.io/anycloud-sh/api:0.0.1']),
    ).rejects.toThrow(/process\.exit:1/);
    expect(mocks.printError).toHaveBeenCalledWith(
      expect.stringContaining('is not a Helm-managed API'),
    );
    expect(mocks.activeVmHostedApi).not.toHaveBeenCalled();
  });

  it('api upgrade rejects target arguments without touching either API', async () => {
    // A usage error: exit 2, as for every lifecycle command.
    await expect(runApi(['upgrade', 'api-1'])).rejects.toThrow(
      /process\.exit:2/,
    );

    expect(mocks.reconcileLocalApi).not.toHaveBeenCalled();
    expect(mocks.activeVmHostedApi).not.toHaveBeenCalled();
  });

  it('fails when the active remote is neither Helm-managed nor a VM-hosted API of the local API', async () => {
    mocks.resolveApiTarget.mockReturnValue({
      url: 'https://unknown.example.com',
      source: 'file',
    });

    await expect(runApi(['upgrade'])).rejects.toThrow(/process\.exit:1/);

    expect(mocks.reconcileLocalApi).not.toHaveBeenCalled();
    expect(mocks.activeVmHostedApi).toHaveBeenCalledWith();
    expect(mocks.printError).toHaveBeenCalledWith(
      expect.stringContaining(
        'is not a Helm-managed API; api upgrade applies to the local API and to an API created with anycloud api create',
      ),
    );
  });

  it('with the local API active, reports its failed reconcile and asks no hosted API', async () => {
    mocks.reconcileLocalApi.mockRejectedValue(new Error('local update failed'));

    await expect(runApi(['upgrade'])).rejects.toThrow(/process\.exit:1/);

    expect(mocks.printError).toHaveBeenCalledWith('local update failed');
    expect(mocks.activeVmHostedApi).not.toHaveBeenCalled();
  });
});
