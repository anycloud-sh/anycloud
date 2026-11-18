import { createHash } from 'crypto';
import { Octokit } from '@octokit/rest';

const CREATOR_JOB = 'azure-onboarding-runner-loss-create';

export interface AzureOnboardingRunLocator {
  repository: string;
  runId: string;
  runAttempt: string;
  credentialName: string;
  displayName: string;
  operationId: string;
  containerName: string;
}

export function azureOnboardingRunLocator(
  repository: string,
  runId: string,
  runAttempt: string,
): AzureOnboardingRunLocator {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    ['.', '..'].includes(repository.split('/')[1]) ||
    !/^[1-9]\d*$/.test(runId) ||
    !/^[1-9]\d*$/.test(runAttempt)
  )
    throw new Error('Invalid Azure onboarding repository, run ID, or attempt.');
  const hash = createHash('sha256')
    .update(JSON.stringify([repository, runId, runAttempt]))
    .digest('hex')
    .slice(0, 20);
  const credentialName = `onb-run-${hash}`;
  const displayName = `anycloud-${credentialName}`;
  return {
    repository,
    runId,
    runAttempt,
    credentialName,
    displayName,
    operationId: `github:${repository}:${runId}:${runAttempt}`,
    containerName: displayName,
  };
}

export function readAzureOnboardingRunLocator(
  env: NodeJS.ProcessEnv = process.env,
): AzureOnboardingRunLocator {
  return azureOnboardingRunLocator(
    env.GITHUB_REPOSITORY ?? '',
    env.GITHUB_RUN_ID ?? '',
    env.GITHUB_RUN_ATTEMPT ?? '',
  );
}

/** GitHub's terminal creator job proves abandonment independently of Azure tags. */
export async function authorizeAzureOnboardingRecovery(
  locator: AzureOnboardingRunLocator,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const expected = readAzureOnboardingRunLocator(env);
  for (const [key, value] of Object.entries(expected)) {
    if (Reflect.get(locator, key) !== value)
      throw new Error('Recovery locator does not match this run.');
  }
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    !env.GITHUB_TOKEN ||
    !/^[a-f0-9]{40}$/i.test(env.GITHUB_SHA ?? '') ||
    ![locator.runId, locator.runAttempt].every((id) =>
      Number.isSafeInteger(Number(id)),
    )
  )
    throw new Error('GitHub workflow authority is required for recovery.');
  const github = new Octokit({
    auth: env.GITHUB_TOKEN,
    request: {
      fetch: fetcher,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  });
  const [owner, repo] = locator.repository.split('/');
  const params = {
    owner,
    repo,
    run_id: Number(locator.runId),
    attempt_number: Number(locator.runAttempt),
  };
  const { data: run } = await github.rest.actions.getWorkflowRunAttempt(params);
  if (
    run.id !== params.run_id ||
    run.run_attempt !== params.attempt_number ||
    run.repository?.full_name !== locator.repository ||
    run.head_repository?.full_name !== locator.repository ||
    run.head_sha !== env.GITHUB_SHA ||
    run.event !== 'workflow_dispatch' ||
    run.path?.split('@')[0] !== '.github/workflows/integration.yml'
  )
    throw new Error('GitHub run does not authorize recovery.');
  let totalCount: number | undefined;
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRunAttempt,
    { ...params, per_page: 100 },
    ({ data }) => {
      // Octokit preserves total_count on the normalized page array.
      const count = (data as { total_count?: number }).total_count;
      if (
        !Number.isSafeInteger(count) ||
        (totalCount !== undefined && count !== totalCount)
      )
        throw new Error('Ambiguous GitHub creator job listing.');
      totalCount = count;
      return data;
    },
  );
  const creators = jobs.filter((job) => job.name === CREATOR_JOB);
  const creator = creators[0];
  const terminal =
    /^(success|failure|cancelled|timed_out|neutral|action_required|stale)$/;
  if (
    jobs.length !== totalCount ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    jobs.some(
      (job) =>
        !Number.isSafeInteger(job.id) ||
        job.id <= 0 ||
        job.run_id !== run.id ||
        job.head_sha !== env.GITHUB_SHA ||
        ('run_attempt' in job && job.run_attempt !== run.run_attempt),
    ) ||
    creators.length !== 1 ||
    creator.status !== 'completed' ||
    !terminal.test(creator.conclusion ?? '') ||
    !creator.completed_at ||
    !Number.isFinite(Date.parse(creator.completed_at))
  )
    throw new Error('GitHub creator abandonment is not confirmed.');
}
