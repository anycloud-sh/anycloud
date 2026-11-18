import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { resolveComparisonRevisions } from '../../../ci/api-responsiveness-revisions.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const repo = { owner: 'anycloud-sh', repo: 'anycloud' };

it('runs billing settlement and long-history responsiveness as required Vitest cells, with no Bash step left in the common lane', () => {
  const workflow = loadYaml(
    readFileSync('.github/workflows/integration.yml', 'utf8'),
  );
  const common = workflow.jobs['integration-tests-common'];
  expect(common.strategy.matrix.test).not.toContain(
    'long-history-responsiveness',
  );
  expect(
    common.steps.some((step) => step.run === 'yarn test:billing-settlement'),
  ).toBe(false);
  expect(common['continue-on-error']).toBeUndefined();
  const vitestE2e = workflow.jobs['vitest-e2e'];
  expect(vitestE2e['continue-on-error']).toBeUndefined();
  for (const test of ['billing-settlement', 'long-history-responsiveness']) {
    const cell = vitestE2e.strategy.matrix.include.find(
      (entry) => entry.test === test,
    );
    expect(cell, test).toMatchObject({ command: `yarn test:${test}:vitest` });
  }
});

function request(eventName = 'schedule', inputs = {}) {
  const context = {
    eventName,
    repo,
    ref: 'refs/heads/main',
    sha: headSha,
    payload: { inputs },
  };
  const getLatestRelease = vi.fn().mockResolvedValue({
    data: {
      tag_name: 'v0.1.63',
      target_commitish: 'main',
      draft: false,
      prerelease: false,
    },
  });
  const getCommit = vi.fn(async ({ ref }) => ({
    data: { sha: ref === headSha ? headSha : baseSha },
  }));
  return {
    context,
    github: { rest: { repos: { getLatestRelease, getCommit } } },
    getLatestRelease,
    getCommit,
  };
}

describe('API performance revision selection', () => {
  it('pins the published source tag and scheduled main snapshot once', async () => {
    const args = request('schedule', {
      base_ref: 'ignored',
      candidate_ref: 'ignored',
    });
    expect(await resolveComparisonRevisions(args)).toEqual({
      event: 'schedule',
      baseline: { ref: 'refs/tags/v0.1.63', sha: baseSha },
      candidate: { ref: headSha, sha: headSha },
    });
    expect(args.getLatestRelease).toHaveBeenCalledExactlyOnceWith({
      owner: 'anycloud-sh',
      repo: 'releases',
    });
    expect(args.getCommit.mock.calls.map(([call]) => call)).toEqual([
      { ...repo, ref: 'refs/tags/v0.1.63' },
      { ...repo, ref: headSha },
    ]);
  });

  it('preserves explicit manual refs without looking up a release', async () => {
    const args = request('workflow_dispatch', {
      base_ref: ' v0.1.63 ',
      candidate_ref: ' refs/pull/1150/merge ',
    });
    args.getCommit.mockImplementation(async ({ ref }) => ({
      data: { sha: ref === 'v0.1.63' ? baseSha : headSha },
    }));
    expect(await resolveComparisonRevisions(args)).toEqual({
      event: 'workflow_dispatch',
      baseline: { ref: 'v0.1.63', sha: baseSha },
      candidate: { ref: 'refs/pull/1150/merge', sha: headSha },
    });
    expect(args.getLatestRelease).not.toHaveBeenCalled();
  });

  it('uses the selected workflow commit when the manual candidate is blank', async () => {
    expect(
      await resolveComparisonRevisions(
        request('workflow_dispatch', { candidate_ref: '' }),
      ),
    ).toMatchObject({
      baseline: { ref: 'main', sha: baseSha },
      candidate: { ref: headSha, sha: headSha },
    });
  });

  it('allows explicit baseline-versus-itself controls', async () => {
    const result = await resolveComparisonRevisions(
      request('workflow_dispatch', {
        base_ref: headSha,
        candidate_ref: headSha,
      }),
    );
    expect(result.baseline.sha).toBe(result.candidate.sha);
  });

  it('fails a missing published release without substituting main', async () => {
    const args = request();
    args.getLatestRelease.mockRejectedValue(new Error('Release not found'));
    await expect(resolveComparisonRevisions(args)).rejects.toThrow(
      'Release not found',
    );
    expect(args.getCommit).not.toHaveBeenCalled();
  });

  it('fails a missing source tag without using the public repo commit', async () => {
    const args = request();
    args.getCommit.mockImplementation(async ({ ref }) => {
      if (ref === 'refs/tags/v0.1.63') throw new Error('Source tag not found');
      return { data: { sha: headSha } };
    });
    await expect(resolveComparisonRevisions(args)).rejects.toThrow(
      'Source tag not found',
    );
    expect(
      args.getCommit.mock.calls.every(
        ([call]) => call.repo === 'anycloud' && call.ref !== 'main',
      ),
    ).toBe(true);
  });

  it.each([
    { tag_name: 'main' },
    { tag_name: 'v0.1.63', draft: true },
    { tag_name: 'v0.1.63', prerelease: true },
  ])('rejects an unusable release: %j', async (release) => {
    const args = request();
    args.getLatestRelease.mockResolvedValue({ data: release });
    await expect(resolveComparisonRevisions(args)).rejects.toThrow();
    expect(args.getCommit).not.toHaveBeenCalled();
  });

  it('rejects schedules outside main and PR events', async () => {
    const args = request();
    args.context.ref = 'refs/heads/feature';
    await expect(resolveComparisonRevisions(args)).rejects.toThrow(
      'Daily comparisons require main',
    );
    expect(args.getLatestRelease).not.toHaveBeenCalled();
    await expect(
      resolveComparisonRevisions(request('pull_request')),
    ).rejects.toThrow('Unsupported benchmark event');
  });

  it('rejects a mutable resolved revision', async () => {
    const args = request();
    args.getCommit.mockResolvedValue({ data: { sha: 'main' } });
    await expect(resolveComparisonRevisions(args)).rejects.toThrow(
      'Invalid resolved commit',
    );
  });
});

const workflow = loadYaml(
  readFileSync('.github/workflows/api-performance.yml', 'utf8'),
);
const catalog = loadYaml(readFileSync('.github/workflows/catalog.yml', 'utf8'));

describe('API performance workflow', () => {
  it('runs daily and manually without adding PR checks', () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);
    expect(workflow.on.schedule).toEqual([{ cron: '17 13 * * *' }]);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain('github.event_name');
  });

  it('defaults to all cases and six pairs with bounded concurrency', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual([
      'base_ref',
      'boundary',
      'candidate_ref',
      'profile',
      'repetitions',
      'response',
    ]);
    for (const axis of ['profile', 'response', 'boundary'])
      expect(inputs[axis].default).toBe('all');
    expect(inputs.repetitions.default).toBe('6');
    expect(workflow.jobs.compare.strategy).toMatchObject({
      'max-parallel': 3,
      'fail-fast': false,
    });
  });

  it('checks out the once-resolved revisions in every case', () => {
    expect(workflow.jobs.compare.needs).toBe('resolve');
    const checkouts = workflow.jobs.compare.steps.filter(
      (step) => step.uses === 'actions/checkout@v5',
    );
    expect(checkouts.map((step) => [step.with.path, step.with.ref])).toEqual([
      ['harness', '${{ github.sha }}'],
      ['candidate', '${{ needs.resolve.outputs.candidate-sha }}'],
      ['baseline', '${{ needs.resolve.outputs.baseline-sha }}'],
    ]);
  });

  it('uses the catalog failure/cancellation policy after all required jobs', () => {
    const notify = workflow.jobs['notify-slack'];
    const reference = catalog.jobs['notify-slack'];
    expect(notify.needs).toEqual(['resolve', 'compare', 'report']);
    expect(notify.if).toBe(reference.if);
    expect(notify.if).toBe(
      "${{ !cancelled() && contains(needs.*.result, 'failure') }}",
    );
    expect(notify.uses).toBe(reference.uses);
    expect(notify.permissions).toEqual({});
    expect(notify.secrets).toEqual(reference.secrets);
    expect(notify.with.message).toBe(
      'API Performance failed: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
    );
    expect(workflow.jobs.resolve.if).toBeUndefined();
    expect(workflow.jobs.report.if).toBe('${{ !cancelled() }}');
    expect(
      Object.values(workflow.jobs).filter((job) => job.uses === reference.uses),
    ).toHaveLength(1);
  });
});
