import { describe, expect, it, vi } from 'vitest';
import {
  authorizeAzureOnboardingRecovery,
  azureOnboardingRunLocator,
  readAzureOnboardingRunLocator,
} from '../../integration/credentials-onboarding/azure/run-authority.js';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'anycloud-sh/anycloud',
  GITHUB_RUN_ID: '123456789012345',
  GITHUB_RUN_ATTEMPT: '101',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_TOKEN: 'test-token',
};
const locator = readAzureOnboardingRunLocator(env);
const run = {
  id: Number(locator.runId),
  run_attempt: 101,
  head_sha: env.GITHUB_SHA,
  repository: { full_name: locator.repository },
  head_repository: { full_name: locator.repository },
  path: '.github/workflows/integration.yml@main',
  event: 'workflow_dispatch',
};
const creator = {
  id: 1,
  run_id: run.id,
  head_sha: env.GITHUB_SHA,
  name: 'azure-onboarding-runner-loss-create',
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-09-09T00:00:00Z',
};
const attemptUrl = `https://api.github.com/repos/${locator.repository}/actions/runs/${locator.runId}/attempts/101`;
const responses = (...bodies: unknown[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies)
    fetcher.mockResolvedValueOnce(
      body instanceof Response ? body : Response.json(body),
    );
  return fetcher;
};
const authorize = (fetcher: typeof fetch, context = env) =>
  authorizeAzureOnboardingRecovery(locator, context, fetcher);

describe('Azure run locator and GitHub abandonment authority', () => {
  it('reconstructs a non-secret locator without truncating run components', () => {
    expect(locator.credentialName).toMatch(/^onb-run-[a-f0-9]{20}$/);
    expect(locator.operationId).toBe(
      `github:${locator.repository}:${locator.runId}:101`,
    );
    for (const other of [
      azureOnboardingRunLocator(locator.repository, locator.runId, '1'),
      azureOnboardingRunLocator(locator.repository, '993456789012345', '101'),
      azureOnboardingRunLocator('another/repo', locator.runId, '101'),
    ])
      expect(other.credentialName).not.toBe(locator.credentialName);
    expect(() => azureOnboardingRunLocator('org/..', '123', '1')).toThrow();
  });

  it('authorizes the exact completed creator across all GitHub job pages', async () => {
    const page = Response.json({ total_count: 2, jobs: [creator] });
    page.headers.set(
      'link',
      `<${attemptUrl}/jobs?per_page=100&page=2>; rel="next"`,
    );
    const fetcher = responses(run, page, {
      total_count: 2,
      jobs: [{ ...creator, id: 2, name: 'other' }],
    });
    await expect(authorize(fetcher)).resolves.toBeUndefined();
    expect(fetcher.mock.calls[2][0]).toBe(
      `${attemptUrl}/jobs?per_page=100&page=2`,
    );
  });

  it.each([
    { id: 99 },
    { run_attempt: 1 },
    { repository: { full_name: 'other/repo' } },
    { head_repository: { full_name: 'fork/repo' } },
    { head_sha: 'b'.repeat(40) },
    { path: '.github/workflows/integration.yml-lookalike' },
    { event: 'pull_request_target' },
  ])('rejects mismatched workflow evidence %j', async (override) => {
    await expect(authorize(responses({ ...run, ...override }))).rejects.toThrow(
      'does not authorize',
    );
  });

  it.each([
    { status: 'in_progress' },
    { conclusion: 'skipped' },
    { completed_at: null },
    { name: 'azure-onboarding-runner-loss-create-lookalike' },
    { run_id: 99 },
    { run_attempt: 1 },
    { head_sha: 'b'.repeat(40) },
  ])('rejects incomplete or foreign creator evidence %j', async (override) => {
    const fetcher = responses(run, {
      total_count: 1,
      jobs: [{ ...creator, ...override }],
    });
    await expect(authorize(fetcher)).rejects.toThrow('abandonment');
  });

  it('rejects duplicate creators, truncated listings, unavailable evidence, and local authority', async () => {
    for (const jobs of [[creator, { ...creator, id: 2 }], []]) {
      await expect(
        authorize(responses(run, { total_count: 2, jobs })),
      ).rejects.toThrow('abandonment');
    }
    const denied = responses(
      Response.json({ message: 'Forbidden' }, { status: 403 }),
    );
    await expect(authorize(denied)).rejects.toThrow('Forbidden');
    const untouched = vi.fn<typeof fetch>();
    await expect(
      authorize(untouched, { ...env, GITHUB_ACTIONS: 'false' }),
    ).rejects.toThrow('workflow authority');
    const wrong = { ...locator, containerName: 'other' };
    await expect(
      authorizeAzureOnboardingRecovery(wrong, env, untouched),
    ).rejects.toThrow('locator');
    expect(untouched).not.toHaveBeenCalled();
  });
});
