import { describe, expect, it, vi } from 'vitest';
import {
  artifactKind,
  completedStorageTarget,
  planArtifactCleanup,
} from '../../../ci/cleanup/actions-artifact-policy.mjs';
import {
  cleanupArtifacts,
  githubApi,
} from '../../../ci/cleanup/actions-artifacts.mjs';

type PolicyInput = Parameters<typeof planArtifactCleanup>[0];
type Artifact = PolicyInput['artifacts'][number];
type Run = PolicyInput['runs'] extends Map<number, infer Value> ? Value : never;
const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const MIB = 1024 * 1024;
const date = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function run(id: number, overrides: Partial<Run> = {}): Run {
  return {
    id,
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    updated_at: date(1),
    path: '.github/workflows/tests.yml',
    ...overrides,
  };
}

function artifact(
  id: number,
  name = 'test-logs-example',
  overrides: Partial<Artifact> = {},
): Artifact {
  return {
    id,
    name,
    size_in_bytes: MIB,
    expired: false,
    created_at: date(2),
    workflow_run: { id },
    ...overrides,
  };
}

const releaseArtifacts = () =>
  [
    'cli-binary-artifacts',
    'release-python-sdk-distributions',
    'digest-amd64',
    'digest-arm64',
  ].map((name, index) =>
    artifact(index + 10, name, { workflow_run: { id: 1 } }),
  );

function plan(
  artifacts: Artifact[],
  owners: Run[],
  options: Partial<PolicyInput> = {},
) {
  return planArtifactCleanup({
    artifacts,
    runs: new Map(owners.map((owner) => [owner.id, owner])),
    now: NOW,
    qualificationActive: false,
    ...options,
  });
}

const plannedIds = (result: ReturnType<typeof plan>) =>
  result.groups.flatMap((group) => group.artifacts.map((entry) => entry.id));

const cleanup = (
  api: Parameters<typeof cleanupArtifacts>[0],
  options: Partial<Parameters<typeof cleanupArtifacts>[1]> = {},
) => cleanupArtifacts(api, { repository: 'owner/repo', now: NOW, ...options });

function mockHttp(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const sleep = vi
    .fn<(delay: number) => Promise<void>>()
    .mockResolvedValue(undefined);
  return { api: githubApi('test-token', fetcher, sleep), fetcher, sleep };
}

function memoryApi(artifacts: Artifact[], owners: Run[]) {
  const live = [...artifacts];
  const calls: { method: string; path: string }[] = [];
  const getRun = vi.fn(async (id: number) =>
    owners.find((owner) => owner.id === id),
  );
  const api = async (method: string, path: string) => {
    calls.push({ method, path });
    const url = new URL('https://api.github.com/' + path);
    if (method === 'DELETE') {
      const id = Number(url.pathname.split('/').at(-1));
      const index = live.findIndex((entry) => entry.id === id);
      if (index >= 0) live.splice(index, 1);
      return undefined;
    }
    if (url.pathname.endsWith('/artifacts')) {
      const id = url.pathname.match(/\/runs\/(\d+)\//)?.[1];
      const entries = live.filter(
        (entry) => !id || entry.workflow_run?.id === Number(id),
      );
      const offset = (Number(url.searchParams.get('page')) - 1) * 100;
      return {
        total_count: entries.length,
        artifacts: entries.slice(offset, offset + 100),
      };
    }
    if (url.searchParams.has('status')) {
      const entries = owners.filter(
        (owner) => owner.status === url.searchParams.get('status'),
      );
      return { total_count: entries.length, workflow_runs: entries };
    }
    return getRun(Number(url.pathname.split('/').at(-1)));
  };
  return { api, calls, getRun, live };
}

describe('Actions artifact retention policy', () => {
  it('protects successful and failed compact implementation records for their full upload lifetime', () => {
    const evidence = [
      artifact(1, 'implementation-evidence-nuke-aws-101-1', {
        created_at: date(24 * 29),
      }),
      artifact(2, 'implementation-evidence-nuke-local-102-1', {
        created_at: date(24 * 29),
      }),
      artifact(3, 'implementation-evidence-spike-103-1', {
        created_at: date(24 * 29),
      }),
    ];
    const result = plan(
      evidence,
      [
        run(1, { conclusion: 'success' }),
        run(2, { conclusion: 'failure' }),
        run(3, { conclusion: 'cancelled' }),
      ],
      { targetBytes: 0 },
    );
    expect(plannedIds(result)).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.protectedBytes).toBe(3 * MIB);
  });

  it('protects Job comparison and cleanup records through their declared retention', () => {
    const evidence = [
      artifact(1, 'job-comparison-evidence-local-job-held-vitest-101-1', {
        created_at: date(24 * 29),
      }),
      artifact(2, 'job-comparison-evidence-local-job-102-1', {
        created_at: date(24 * 29),
      }),
    ];
    expect(artifactKind(evidence[0].name)).toBe('recovery');
    const result = plan(evidence, [run(1), run(2, { conclusion: 'success' })], {
      targetBytes: 0,
    });
    expect(plannedIds(result)).toEqual([]);
    expect(result.protectedBytes).toBe(2 * MIB);
  });
  it('protects successful and failed VM and Service comparisons from storage-pressure eviction', () => {
    const evidence = [
      artifact(1, 'vm-comparison-evidence-cloud-aws-vm-101-1', {
        created_at: date(24 * 29),
      }),
      artifact(2, 'vm-comparison-evidence-local-vm-102-1', {
        created_at: date(24 * 29),
      }),
      artifact(3, 'service-comparison-evidence-gpu-aws-103-1', {
        created_at: date(24 * 29),
      }),
      artifact(4, 'service-comparison-evidence-local-serve-vitest-104-1', {
        created_at: date(24 * 29),
      }),
    ];
    expect(evidence.map((entry) => artifactKind(entry.name))).toEqual([
      'recovery',
      'recovery',
      'recovery',
      'recovery',
    ]);
    const result = plan(
      evidence,
      [
        run(1),
        run(2, { conclusion: 'success' }),
        run(3),
        run(4, { conclusion: 'success' }),
      ],
      {
        targetBytes: 0,
      },
    );
    expect(plannedIds(result)).toEqual([]);
    expect(result.protectedBytes).toBe(4 * MIB);
  });
  it('switches the temporary target at the UTC billing reset', () => {
    expect(completedStorageTarget(Date.parse('2026-09-30T23:59:59Z'))).toBe(
      20 * MIB,
    );
    expect(completedStorageTarget(Date.parse('2026-10-01T00:00:00Z'))).toBe(
      250 * MIB,
    );
  });

  it('keeps recovery evidence, unknown names, and unresolved owners under pressure', () => {
    const artifacts = [
      artifact(1, 'managed-gpu-cleanup-authority-1-1'),
      artifact(2, 'managed-gpu-recovery-2-1'),
      artifact(3, 'managed-kubernetes-qualification-3-1'),
      artifact(4, 'lambda-boot-failover-4-01-1'),
      artifact(5, 'unclassified-evidence'),
      artifact(6),
      artifact(7, 'azure-spot-restart-recovery-7-1'),
      artifact(8, 'recovery-evidence-azure-bucket-sync-8-1'),
      artifact(9, 'conversation-capture-9-1'),
      artifact(10, 'managed-kubernetes-records-gpu-azure-10-1'),
    ];
    const result = plan(
      artifacts,
      artifacts.filter((entry) => entry.id !== 6).map((entry) => run(entry.id)),
      { targetBytes: 0 },
    );
    expect(result.groups).toEqual([]);
    expect(result.protectedBytes).toBe(10 * MIB);
    expect(result.unknown.map((entry) => entry.id)).toEqual([5, 7]);
    expect(artifactKind(artifacts[6].name)).toBe('unknown');
    expect(artifactKind(artifacts[7].name)).toBe('recovery');
    expect(artifactKind(artifacts[9].name)).toBe('recovery');
  });

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
    'protects %s runs regardless of artifact age',
    (status) => {
      const result = plan(
        [artifact(1, 'managed-gpu-candidate', { created_at: date(120) })],
        [run(1, { status, conclusion: null })],
        { targetBytes: 0 },
      );
      expect(result.groups).toEqual([]);
      expect(result.activeBytes).toBe(MIB);
    },
  );

  it.each(['success', 'failure', 'cancelled'])(
    'retains %s mutation reports until GitHub expiration even under storage pressure',
    (conclusion) => {
      const result = plan(
        [
          artifact(1, 'mutation-harness-current', { created_at: date(6 * 24) }),
          artifact(2, 'mutation-harness-expired', { expired: true }),
          artifact(3),
        ],
        [run(1, { conclusion }), run(2, { conclusion }), run(3)],
        { targetBytes: 0 },
      );

      expect(artifactKind('mutation-harness-current')).toBe('mutation');
      expect(result.unknown).toEqual([]);
      expect(plannedIds(result)).toEqual([3]);
      expect(result.beforeBytes).toBe(2 * MIB);
      expect(result.protectedBytes).toBe(MIB);
      expect(result.plannedAfterBytes).toBe(MIB);
    },
  );

  it('retains successful performance evidence for seven days under storage pressure', () => {
    const artifacts = [
      'api-responsiveness-standard-empty-yield',
      'api-responsiveness-report',
      'billing-responsiveness',
      'billing-settlement-qualification',
    ].map((name, index) =>
      artifact(index + 1, name, { created_at: date(168 - 1 / 3600) }),
    );
    const owners = artifacts.map((entry) =>
      run(entry.id, { conclusion: 'success' }),
    );
    const retained = plan(artifacts, owners, { targetBytes: 0 });
    expect(retained.groups).toEqual([]);
    expect(retained.unknown).toEqual([]);
    expect(retained.protectedBytes).toBe(4 * MIB);
    const expired = plan(
      artifacts.map((entry) => ({ ...entry, created_at: date(168) })),
      owners,
      { targetBytes: 0 },
    );
    expect(plannedIds(expired).sort()).toEqual([1, 2, 3, 4]);
    expect(
      expired.groups.every((group) => group.reason?.includes('7-day')),
    ).toBe(true);
  });

  it('keeps newer performance evidence when an older upload in the same run expires', () => {
    const result = plan(
      [
        artifact(1, 'api-responsiveness-standard-empty-yield', {
          created_at: date(168),
          workflow_run: { id: 1 },
        }),
        artifact(2, 'api-responsiveness-report', {
          workflow_run: { id: 1 },
        }),
      ],
      [run(1, { conclusion: 'success' })],
      { targetBytes: 0 },
    );
    expect(plannedIds(result)).toEqual([1]);
    expect(result.protectedBytes).toBe(MIB);
  });

  it('measures candidate retry age from completion and retains only the newest failure', () => {
    const result = plan(
      [
        artifact(1, 'managed-gpu-candidate'),
        artifact(2, 'managed-gpu-candidate', { created_at: date(100) }),
        artifact(3, 'managed-gpu-candidate'),
      ],
      [
        run(1, { updated_at: date(2) }),
        run(2),
        run(3, { conclusion: 'success' }),
      ],
    );
    expect(plannedIds(result).sort()).toEqual([1, 3]);
    expect(result.groups.find((group) => group.run.id === 3)?.reason).toContain(
      'successfully',
    );
  });

  it('expires the failed candidate at exactly 24 hours', () => {
    const result = plan(
      [artifact(1, 'managed-gpu-candidate')],
      [run(1, { updated_at: date(24) })],
    );
    expect(result.groups[0].reason).toContain('24-hour');
  });

  it('evicts release bytes as a cohort and protects them during qualification', () => {
    const artifacts = releaseArtifacts();
    const owners = [run(1, { updated_at: date(25) })];
    expect(plan(artifacts, owners).groups[0].artifacts).toHaveLength(4);
    expect(
      plan(artifacts, owners, { qualificationActive: true, targetBytes: 0 })
        .groups,
    ).toEqual([]);
  });

  it('keeps the latest release regardless of conclusion until its window or budget ends', () => {
    const artifacts = [
      artifact(1, 'cli-binary-artifacts'),
      artifact(2, 'cli-binary-artifacts'),
    ];
    const result = plan(artifacts, [
      run(1, { updated_at: date(3) }),
      run(2, { conclusion: 'success' }),
    ]);
    expect(result.groups.map((group) => group.run.id)).toEqual([1]);
  });

  it('cleans successful transfers and unused uploads while retaining recent failure logs', () => {
    const artifacts = [
      artifact(1, 'generated-python-sdk'),
      artifact(2, 'python-sdk-distributions'),
      artifact(3, 'deps-digests-amd64', { created_at: date(24) }),
      artifact(4, 'docs-build'),
      artifact(5, 'build.dockerbuild'),
      artifact(6),
    ];
    const result = plan(
      artifacts,
      artifacts.map((entry) =>
        run(entry.id, entry.id === 1 ? { conclusion: 'success' } : {}),
      ),
    );
    expect(plannedIds(result).sort()).toEqual([1, 3, 4, 5]);
  });

  it('expires individual diagnostics without expiring newer logs in the same run', () => {
    const result = plan(
      [
        artifact(1, 'test-logs-old', {
          created_at: date(72),
          workflow_run: { id: 1 },
        }),
        artifact(2, 'test-logs-new', { workflow_run: { id: 1 } }),
      ],
      [run(1)],
    );
    expect(plannedIds(result)).toEqual([1]);
  });

  it('evicts older completed runs under pressure and excludes expired bytes', () => {
    const result = plan(
      [
        artifact(1),
        artifact(2),
        artifact(3, 'test-logs-expired', { expired: true }),
      ],
      [run(1, { updated_at: date(3) }), run(2)],
      { targetBytes: MIB },
    );
    expect(result.beforeBytes).toBe(2 * MIB);
    expect(result.plannedAfterBytes).toBe(MIB);
    expect(result.groups[0].run.id).toBe(1);
  });

  it('retains unrecognized artifact names', () => {
    expect(artifactKind('new-unrecognized-output')).toBe('unknown');
  });

  it('removes expired entries before pressure evictions and then evicts oldest first', () => {
    const result = plan(
      [
        artifact(1, 'test-logs-expired-policy', { created_at: date(72) }),
        artifact(2, 'test-logs-older', { size_in_bytes: 2 * MIB }),
        artifact(3, 'test-logs-newer', { size_in_bytes: 3 * MIB }),
      ],
      [run(1), run(2, { updated_at: date(3) }), run(3)],
      { targetBytes: 0 },
    );
    expect(plannedIds(result)).toEqual([1, 2, 3]);
  });
});

describe('Actions artifact cleanup execution', () => {
  it('defaults to a deletion preview and paginates beyond expired metadata', async () => {
    const data = Array.from({ length: 100 }, (_, index) =>
      artifact(index + 1, 'test-logs-expired', { expired: true }),
    );
    const memory = memoryApi(
      [...data, artifact(101, 'docs-build')],
      [run(101)],
    );
    const report = await cleanup(memory.api);
    expect(report.selected.map((entry) => entry.id)).toEqual([101]);
    expect(report.deleted).toEqual([]);
    expect(memory.calls.some((call) => call.path.includes('page=2'))).toBe(
      true,
    );
    expect(memory.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('rechecks status and attempt immediately before deletion', async () => {
    const memory = memoryApi([artifact(1, 'docs-build')], [run(1)]);
    memory.getRun
      .mockResolvedValueOnce(run(1))
      .mockResolvedValueOnce(run(1, { status: 'queued', run_attempt: 2 }));
    const report = await cleanup(memory.api, { apply: true });
    expect(report.deleted).toEqual([]);
    expect(report.skipped[0].reason).toContain('run changed');
    expect(memory.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('rechecks qualification before deleting another run’s release source', async () => {
    const memory = memoryApi(
      [artifact(1, 'cli-binary-artifacts')],
      [run(1, { updated_at: date(25) })],
    );
    let inspections = 0;
    const api = async (method: string, path: string) => {
      if (path.includes('status=in_progress') && ++inspections === 2) {
        return {
          total_count: 1,
          workflow_runs: [
            run(2, {
              status: 'in_progress',
              path: '.github/workflows/managed-kubernetes-qualification.yml',
            }),
          ],
        };
      }
      return memory.api(method, path);
    };
    const report = await cleanup(api, { apply: true });
    expect(report.deleted).toEqual([]);
    expect(report.skipped[0].reason).toContain('qualification became active');
  });

  it.each(['owner', 'qualification'])(
    'defers failed %s checks without waiting on stale qualification state',
    async (check) => {
      const artifacts = releaseArtifacts();
      const owners = [run(1, { updated_at: date(25) })];
      const memory = memoryApi(artifacts, owners);
      const qualification = run(2, {
        status: 'queued',
        conclusion: null,
        path: '.github/workflows/managed-kubernetes-qualification.yml',
      });
      const lookup = check === 'owner' ? '/runs/1' : 'status=requested';
      let inspections = 0;
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const path = url.pathname.slice(1) + url.search;
        if (path.includes(lookup) && ++inspections === 2)
          return Response.json(
            { message: 'secondary rate limit' },
            { status: 403, headers: { 'retry-after': '1' } },
          );
        const body = await memory.api(method, path);
        return body === undefined
          ? new Response(null, { status: 204 })
          : Response.json(body);
      });
      const sleep = vi.fn(async () => {
        owners.push(qualification);
      });
      const api = githubApi('test-token', fetcher, sleep);
      const first = await cleanup(api, { apply: true });
      expect(first.deleted).toEqual([]);
      expect(first.failure).toContain('403');
      expect(sleep).not.toHaveBeenCalled();
      expect(memory.live).toEqual(artifacts);

      owners.push(qualification);
      const second = await cleanup(api, { apply: true });
      expect(second.deleted).toEqual([]);
      expect(second.protectedBytes).toBe(4 * MIB);
      expect(memory.live).toEqual(artifacts);
    },
  );

  it('rechecks qualification after pacing between release artifacts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const artifacts = releaseArtifacts();
      const owners = [run(1, { updated_at: date(25) })];
      const memory = memoryApi(artifacts, owners);
      const api = async (method: string, path: string) => {
        const result = await memory.api(method, path);
        if (method === 'DELETE' && path.endsWith('/' + artifacts[0].id))
          setTimeout(() => {
            owners.push(
              run(2, {
                status: 'in_progress',
                conclusion: null,
                path: '.github/workflows/managed-kubernetes-qualification.yml',
              }),
            );
          }, 100);
        return result;
      };
      const pending = cleanup(api, { apply: true });
      await vi.runAllTimersAsync();
      const report = await pending;
      expect(report.deleted.map((entry) => entry.id)).toEqual([
        artifacts[0].id,
      ]);
      expect(report.skipped[0].reason).toContain('qualification became active');
      expect(memory.live).toEqual(artifacts.slice(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds work without splitting a release cohort', async () => {
    const memory = memoryApi(releaseArtifacts(), [
      run(1, { updated_at: date(25) }),
    ]);
    const report = await cleanup(memory.api, { apply: true, maxDeletes: 3 });
    expect(report.deleted).toEqual([]);
    expect(report.remainingGroups).toBe(1);
  });

  it('limits owner lookups and retains uninspected runs', async () => {
    const memory = memoryApi(
      [artifact(1, 'docs-build'), artifact(2)],
      [run(1), run(2)],
    );
    const report = await cleanup(memory.api, { apply: true, maxRuns: 1 });
    expect(report.pendingRuns).toBe(1);
    expect(report.deleted.map((entry) => entry.id)).toEqual([1]);
    expect(memory.live.map((entry) => entry.id)).toEqual([2]);
  });

  it('supports run-scoped and repeated cleanup without deleting workflow history', async () => {
    const memory = memoryApi(
      [artifact(1, 'docs-build'), artifact(2, 'docs-build')],
      [run(1), run(2)],
    );
    const options = { runId: 1, apply: true };
    expect(
      (await cleanup(memory.api, options)).deleted.map((entry) => entry.id),
    ).toEqual([1]);
    expect((await cleanup(memory.api, options)).deleted).toEqual([]);
    expect(memory.live.map((entry) => entry.id)).toEqual([2]);
    expect(
      memory.calls
        .filter((call) => call.method === 'DELETE')
        .map((call) => call.path),
    ).toEqual(['repos/owner/repo/actions/artifacts/1']);
  });

  it('records partial progress if GitHub stops accepting deletions', async () => {
    const memory = memoryApi(
      [artifact(1, 'docs-build'), artifact(2, 'docs-build')],
      [run(1), run(2)],
    );
    let deletions = 0;
    const api = async (method: string, path: string) => {
      if (method === 'DELETE' && ++deletions === 2)
        throw new Error('rate limit; retry later');
      return memory.api(method, path);
    };
    const report = await cleanup(api, { apply: true });
    expect(report.deleted).toHaveLength(1);
    expect(report.afterBytes).toBe(MIB);
    expect(report.remainingGroups).toBe(1);
    expect(report.failure).toContain('rate limit');
  });

  it('normalizes run-scoped artifacts when GitHub omits workflow_run metadata', async () => {
    const memory = memoryApi([artifact(1, 'docs-build')], [run(1)]);
    const api = async (method: string, path: string) => {
      if (path.includes('/runs/1/artifacts'))
        return {
          artifacts: [artifact(1, 'docs-build', { workflow_run: undefined })],
        };
      return memory.api(method, path);
    };
    const report = await cleanup(api, { apply: true, runId: 1 });
    expect(report.deleted.map((entry) => entry.id)).toEqual([1]);
  });

  it('fails closed when active runs exceed GitHub’s filtered listing limit', async () => {
    const memory = memoryApi([artifact(1, 'cli-binary-artifacts')], [run(1)]);
    const api = async (method: string, path: string) => {
      if (path.includes('status=queued'))
        return {
          total_count: 1001,
          workflow_runs: Array.from({ length: 100 }, (_, index) =>
            run(index + 100, { status: 'queued' }),
          ),
        };
      return memory.api(method, path);
    };
    await expect(cleanup(api, { apply: true })).rejects.toThrow(
      '1,000-result limit',
    );
    expect(memory.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('honors bounded rate-limit retries for reads', async () => {
    const { api, fetcher, sleep } = mockHttp(
      Response.json(
        { message: 'rate limit exceeded' },
        {
          status: 429,
          headers: { 'retry-after': '2' },
        },
      ),
      Response.json(run(1)),
    );
    expect(await api('GET', 'repos/owner/repo/actions/runs/1')).toEqual(run(1));
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats already-deleted artifacts as complete', async () => {
    const { api, fetcher } = mockHttp(new Response(null, { status: 404 }));
    await expect(
      api('DELETE', 'repos/owner/repo/actions/artifacts/1'),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 502, 503, 504])(
    'defers a failed DELETE (%s) so the next pass protects a restarted run',
    async (status) => {
      const owners = [run(1, { updated_at: date(25) })];
      const candidate = artifact(1, 'managed-gpu-candidate');
      const memory = memoryApi([candidate], owners);
      let blocked = true;
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'DELETE' && blocked) {
          blocked = false;
          return Response.json(
            { message: 'rate limit' },
            {
              status,
              headers: { 'retry-after': '1' },
            },
          );
        }
        const body = await memory.api(
          method,
          url.pathname.slice(1) + url.search,
        );
        return body === undefined
          ? new Response(null, { status: 204 })
          : Response.json(body);
      });
      const restart = () => {
        owners[0] = run(1, {
          status: 'in_progress',
          conclusion: null,
          run_attempt: 2,
        });
      };
      const sleep = vi.fn(async () => restart());
      const api = githubApi('test-token', fetcher, sleep);
      const first = await cleanup(api, { apply: true });
      expect(first.deleted).toEqual([]);
      expect(first.failure).toContain(String(status));
      expect(sleep).not.toHaveBeenCalled();
      restart();
      const second = await cleanup(api, { apply: true });
      expect(second.deleted).toEqual([]);
      expect(second.activeBytes).toBe(MIB);
      expect(memory.live).toEqual([candidate]);
      expect(
        fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
      ).toHaveLength(1);
    },
  );

  it('does not retry permission errors or wait beyond a minute on rate limits', async () => {
    const { api, fetcher, sleep } = mockHttp(
      Response.json({ message: 'Forbidden' }, { status: 403 }),
      Response.json(
        { message: 'rate limit exceeded' },
        {
          status: 429,
          headers: { 'retry-after': '120' },
        },
      ),
    );
    await expect(
      api('GET', 'repos/owner/repo/actions/artifacts'),
    ).rejects.toThrow('403');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      api('GET', 'repos/owner/repo/actions/artifacts'),
    ).rejects.toThrow('429');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('revalidates cached run metadata and observes a changed retry before returning it', async () => {
    const original = run(1);
    const changed = run(1, { status: 'queued', run_attempt: 2 });
    const { api, fetcher } = mockHttp(
      Response.json(original, { headers: { etag: '"first"' } }),
      new Response(null, { status: 304 }),
      Response.json(changed, { headers: { etag: '"second"' } }),
    );
    const path = 'repos/owner/repo/actions/runs/1';
    expect(await api('GET', path)).toEqual(original);
    expect(await api('GET', path)).toEqual(original);
    expect(await api('GET', path)).toEqual(changed);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      'If-None-Match': '"first"',
    });
    expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({
      'If-None-Match': '"first"',
    });
  });

  it('waits a minute for secondary limits even when the primary reset is hours away', async () => {
    const { api, sleep } = mockHttp(
      Response.json(
        { message: 'secondary rate limit' },
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '100',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      ),
      Response.json(run(1)),
    );
    expect(await api('GET', 'repos/owner/repo/actions/runs/1')).toEqual(run(1));
    expect(sleep).toHaveBeenCalledWith(60_000);
  });
});
