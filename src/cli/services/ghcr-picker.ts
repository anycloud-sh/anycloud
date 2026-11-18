import { safePrompts } from '../utils/safe-prompts.js';
import { getGitHubToken } from './auth.js';
import { createSpinner, printError, printWarning } from '../utils/output.js';
import {
  fetchPackageTags,
  listGitHubPackages,
  type GhcrPackage,
} from './ghcr.js';

/**
 * Two-step picker: GHCR repos -> tags. Returns the image string
 * "ghcr.io/<owner>/<repo>:<tag>" or null if user cancels.
 */
export async function pickGHCRImage(): Promise<string | null> {
  // GHCR is GitHub's: only the GitHub sign-in reaches it, never an API bearer.
  const accessToken = await getGitHubToken();
  const spinner = createSpinner('Loading available repos...').start();
  const { packages: repos, warnings } = await listGitHubPackages(accessToken);
  spinner.stop();

  for (const warning of warnings) {
    printWarning(warning);
  }

  if (repos.length === 0) {
    printError(
      'No GHCR packages found for your GitHub account. Pass an explicit image, e.g. ghcr.io/owner/repo:tag.',
    );
    process.exit(1);
  }

  const personalRepos = repos.filter((r) => !r.isOrg);
  const orgRepos = repos.filter((r) => r.isOrg);
  const repoChoices = [
    ...personalRepos.map((r) => ({
      title: r.name,
      value: r,
      description: 'personal',
    })),
    ...orgRepos.map((r) => ({
      title: r.name,
      value: r,
      description: `org: ${r.owner}`,
    })),
  ];

  console.log('');
  const repoSelection = await safePrompts<'repo'>({
    type: 'select',
    name: 'repo',
    message: 'Select repo:',
    choices: repoChoices,
  });
  if (!repoSelection.repo) return null;

  const selectedRepo = repoSelection.repo as GhcrPackage;
  const tagSpinner = createSpinner(
    `Loading tags for ${selectedRepo.packageName}...`,
  ).start();
  const tags = await fetchPackageTags(accessToken, selectedRepo);
  tagSpinner.stop();

  if (tags.length === 0) {
    printError(`No tags found for ${selectedRepo.name}`);
    process.exit(1);
  }

  console.log('');
  const tagSelection = await safePrompts<'tag'>({
    type: 'select',
    name: 'tag',
    message: 'Select tag:',
    choices: tags.map((t) => ({ title: t, value: t })),
  });
  if (!tagSelection.tag) return null;

  return `${selectedRepo.name}:${tagSelection.tag}`;
}
