import { describe, it, expect, vi } from 'vitest';
import {
  distinctCreators,
  distinctSessions,
  fetchWorkloadList,
  shouldPromptForView,
  validateListOptions,
  workloadListViews,
  workloadsForView,
  type WorkloadListClient,
} from '../../../../src/cli/use-cases/workload-list.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { makeWorkloadListRow } from '../../helpers/fixtures';

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
  it('rejects an unknown type', () => {
    expect(() => validateListOptions({ type: 'pod' }, {})).toThrow(
      '--type must be job, service, or vm',
    );
  });

  it('resolves the type filter, preferring the typed command', () => {
    expect(validateListOptions({ type: 'VM' }, {})).toEqual({
      type: 'vm',
    });
    expect(
      validateListOptions(
        { type: 'bogus' },
        { workloadType: WorkloadType.Job },
      ),
    ).toEqual({ type: WorkloadType.Job });
    expect(validateListOptions({}, {})).toEqual({
      type: undefined,
    });
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
      'credentials',
      'user',
      'session',
      'agent',
    ] as const) {
      expect(shouldPromptForView({ [key]: 'x' }, bare)).toBe(false);
    }
  });
});

function fakeClient() {
  const list = vi.fn<WorkloadListClient['workloads']['list']>(async () => [
    makeWorkloadListRow({ id: 'job-1' }),
  ]);
  const client: WorkloadListClient = {
    workloads: { list },
  };
  return { client, list };
}

describe('fetchWorkloadList', () => {
  it('maps flags, window and an auto-derived session into an exact query', async () => {
    const { client, list } = fakeClient();
    await fetchWorkloadList(client, {
      options: { status: 'running', credentials: 'prod' },
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
        credentialName: 'prod',
        filter: undefined,
        user: undefined,
      },
    });
  });
});
