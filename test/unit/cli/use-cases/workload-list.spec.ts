import { describe, it, expect, vi } from 'vitest';
import {
  distinctCreators,
  distinctSessions,
  fetchNodePoolDeploymentJobs,
  fetchWorkloadList,
  shouldPromptForView,
  validateListOptions,
  watchNodePoolDeploymentJobs,
  workloadListViews,
  workloadsForView,
  type ListOptions,
  type WorkloadListClient,
} from '../../../../src/cli/use-cases/workload-list.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { isInterrupted } from '../../../../src/cli/utils/interrupt.js';
import type { DeploymentSummary } from '../../../../src/shared/api-contract/deployments-schemas.js';
import {
  makeDeploymentSummary,
  makeNodePoolSummary,
  makeWorkloadListRow,
} from '../../helpers/fixtures';

describe('distinctSessions', () => {
  const now = Date.now();

  it('groups by session, counts, picks displayForm, and sorts by recency', () => {
    const groups = distinctSessions([
      makeWorkloadListRow({
        id: 'a',
        session: 's1',
        agent: 'claude',
        sessionLabel: 'pipeline',
        startedAt: now - 1000,
      }),
      makeWorkloadListRow({
        id: 'b',
        state: WorkloadState.Completed,
        session: 's1',
        agent: 'claude',
        sessionLabel: 'pipeline',
        startedAt: now - 500,
      }),
      makeWorkloadListRow({
        id: 'c',
        session: 's2',
        agent: 'codex',
        startedAt: now,
      }),
      makeWorkloadListRow({
        id: 'd',
        session: null,
        startedAt: now - 100,
      }),
    ]);

    // null-session rows are excluded; most-recent session first
    expect(groups.map((g) => g.session)).toEqual(['s2', 's1']);
    const s1 = groups.find((g) => g.session === 's1');
    expect(s1?.count).toBe(2);
    expect(s1?.displayForm).toBe('pipeline');
  });
});

describe('workloadListViews', () => {
  it('offers a "by session" view when >=2 distinct sessions exist', () => {
    const views = workloadListViews([
      makeWorkloadListRow({
        id: 'a',
        session: 's1',
      }),
      makeWorkloadListRow({
        id: 'b',
        session: 's2',
      }),
    ]);
    expect(views.sessions.map((group) => group.session)).toEqual(
      expect.arrayContaining(['s1', 's2']),
    );
  });

  it('omits the "by session" view with fewer than 2 sessions', () => {
    const views = workloadListViews([
      makeWorkloadListRow({
        id: 'a',
        session: 's1',
      }),
      makeWorkloadListRow({
        id: 'b',
        session: null,
      }),
    ]);
    expect(views.sessions).toEqual([]);
  });

  it('offers a "by user" view once a listing spans two creators', () => {
    const views = workloadListViews([
      makeWorkloadListRow({ id: 'a', state: WorkloadState.Running }),
      makeWorkloadListRow({
        id: 'b',
        userId: 'teammate',
      }),
    ]);
    expect(views.creators).toHaveLength(2);
  });

  it('omits the "by user" view on an unshared API', () => {
    const views = workloadListViews([
      makeWorkloadListRow({ id: 'a', state: WorkloadState.Running }),
      makeWorkloadListRow({ id: 'b', state: WorkloadState.Running }),
    ]);
    expect(views.creators).toEqual([]);
    expect(views.stateCounts).toEqual(new Map([[WorkloadState.Running, 2]]));
    expect(views.total).toBe(2);
  });
});

describe('distinctCreators', () => {
  it('counts each creator and orders them by most recent activity', () => {
    expect(
      distinctCreators([
        makeWorkloadListRow({ id: 'a', userId: 'octocat', startedAt: 100 }),
        makeWorkloadListRow({ id: 'b', userId: 'teammate', startedAt: 300 }),
        makeWorkloadListRow({ id: 'c', userId: 'octocat', startedAt: 200 }),
      ]),
    ).toEqual([
      { username: 'teammate', count: 1, latest: 300 },
      { username: 'octocat', count: 2, latest: 200 },
    ]);
  });
});

describe('workloadsForView', () => {
  it('keeps every workload for "all" and narrows to one state, creator, or session', () => {
    const running = makeWorkloadListRow({
      id: 'a',
      state: WorkloadState.Running,
    });
    const queued = makeWorkloadListRow({
      id: 'b',
      state: WorkloadState.Queued,
      userId: 'teammate',
      session: 's1',
    });
    expect(workloadsForView([running, queued], '__all__')).toEqual([
      running,
      queued,
    ]);
    expect(workloadsForView([running, queued], WorkloadState.Queued)).toEqual([
      queued,
    ]);
    expect(workloadsForView([running, queued], { userId: 'teammate' })).toEqual(
      [queued],
    );
    expect(workloadsForView([running, queued], { session: 's1' })).toEqual([
      queued,
    ]);
  });
});

describe('validateListOptions', () => {
  it.each([
    [{ type: 'pod' }, {}, '--type must be job, service, or vm'],
    [
      { deployment: 'd' },
      { workloadType: WorkloadType.Vm },
      '--deployment only supports Jobs',
    ],
    [{ interval: '5' }, {}, '--interval requires --watch'],
    ...[{ csv: true }, { json: true }, { deployment: 'd' }].map(
      (flags): [ListOptions, object, string] => [
        { watch: true, ...flags },
        {},
        '--watch cannot be combined with list filters or machine-readable output',
      ],
    ),
    [
      { watch: true },
      { interactive: false },
      '--watch requires an interactive terminal',
    ],
  ] satisfies Array<
    [
      ListOptions,
      { workloadType?: WorkloadType; interactive?: boolean },
      string,
    ]
  >)('rejects %o', (options, context, message) => {
    expect(() =>
      validateListOptions(options, { interactive: true, ...context }),
    ).toThrow(message);
  });

  it('resolves the type filter, preferring the typed command', () => {
    const interactive = true;
    expect(validateListOptions({ type: 'VM' }, { interactive })).toEqual({
      type: 'vm',
    });
    expect(
      validateListOptions(
        { type: 'bogus', deployment: 'd' },
        { interactive, workloadType: WorkloadType.Job },
      ),
    ).toEqual({ type: WorkloadType.Job });
    expect(
      validateListOptions({ watch: true, interval: '5' }, { interactive }),
    ).toEqual({ type: undefined });
  });
});

describe('shouldPromptForView', () => {
  const bare = {
    interactive: true,
    machineMode: false,
    autoScoped: false,
  };

  it('prompts only for a bare, human, unscoped top-level list', () => {
    expect(shouldPromptForView({}, bare)).toBe(true);
    expect(shouldPromptForView({}, { ...bare, interactive: false })).toBe(
      false,
    );
    expect(shouldPromptForView({}, { ...bare, machineMode: true })).toBe(false);
    expect(shouldPromptForView({}, { ...bare, autoScoped: true })).toBe(false);
    expect(
      shouldPromptForView({}, { ...bare, workloadType: WorkloadType.Job }),
    ).toBe(false);
    for (const key of [
      'period',
      'limit',
      'filter',
      'status',
      'type',
      'deployment',
      'credentials',
      'user',
      'session',
      'agent',
    ] as const) {
      expect(shouldPromptForView({ [key]: 'x' }, bare)).toBe(false);
    }
  });
});

const nodePool = makeNodePoolSummary();
const deployment = makeDeploymentSummary();

function fakeClient(deploymentOverride: Partial<DeploymentSummary> = {}) {
  const list = vi.fn<WorkloadListClient['workloads']['list']>(async () => [
    makeWorkloadListRow({ id: 'job-1' }),
  ]);
  const client: WorkloadListClient = {
    workloads: { list },
    nodePools: {
      list: async () => ({ nodePools: [nodePool] }),
      get: async () => ({ nodePool }),
    },
    deployments: {
      list: async () => ({ deployments: [deployment] }),
      get: async () => ({
        deployment: { ...deployment, ...deploymentOverride },
      }),
    },
  };
  return { client, list };
}

describe('fetchWorkloadList', () => {
  it('maps flags, window and an auto-derived session into an exact query', async () => {
    const { client, list } = fakeClient();
    await fetchWorkloadList(client, {
      options: { status: 'running', deployment: 'dep-1', credentials: 'prod' },
      type: 'job',
      limit: 50,
      sinceMs: 1000,
      scope: { session: 'sess', agent: 'claude', autoScoped: true },
    });
    expect(list).toHaveBeenCalledWith({
      query: {
        limit: '50',
        sinceMs: '1000',
        session: 'sess',
        sessionExact: 'true',
        agent: 'claude',
        status: 'running',
        workloadType: 'job',
        deploymentId: 'dep-1',
        credentialName: 'prod',
        filter: undefined,
        user: undefined,
      },
    });
  });
});

describe('fetchNodePoolDeploymentJobs', () => {
  it('reads the node pool, the Deployment, and its Jobs together', async () => {
    const view = await fetchNodePoolDeploymentJobs(fakeClient().client, {
      nodePool,
      deployment,
    });
    expect(view.deployment.id).toBe(deployment.id);
    expect(view.workloads.map((workload) => workload.id)).toEqual(['job-1']);
  });

  it('reports an aborted read as an interruption', async () => {
    const { client, list } = fakeClient();
    const controller = new AbortController();
    list.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    const error = await fetchNodePoolDeploymentJobs(
      client,
      { nodePool, deployment },
      controller.signal,
    ).catch((caught: unknown) => caught);
    expect(isInterrupted(error)).toBe(true);
  });
});

describe('watchNodePoolDeploymentJobs', () => {
  it('hands each read over until a read is aborted', async () => {
    const controller = new AbortController();
    const { client, list } = fakeClient();
    list
      .mockResolvedValueOnce([makeWorkloadListRow({ id: 'job-1' })])
      .mockResolvedValueOnce([makeWorkloadListRow({ id: 'job-2' })])
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('aborted');
      });
    const seen: string[] = [];
    const error = await watchNodePoolDeploymentJobs(
      client,
      { nodePool, deployment },
      {
        intervalSeconds: 0,
        signal: controller.signal,
        onView: (view) => seen.push(view.workloads[0]!.id),
      },
    ).catch((caught: unknown) => caught);
    expect(seen).toEqual(['job-1', 'job-2']);
    expect(isInterrupted(error)).toBe(true);
  });
});
