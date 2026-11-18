const GITHUB_API_BASE = 'https://api.github.com';

type GitHubPackage = {
  name: string;
};

type GitHubOrg = {
  login: string;
};

type GitHubUser = {
  login: string;
};

type GitHubPackageVersion = {
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
};

export interface GhcrPackage {
  name: string; // e.g., ghcr.io/owner/repo
  owner: string;
  packageName: string;
  isOrg: boolean;
}

export interface GhcrPackageList {
  packages: GhcrPackage[];
  warnings: string[];
}

class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function gitHubError(response: Response, url: string): Promise<Error> {
  let detail = response.statusText;
  // The body stream can only be read once, so read it as text and then try to
  // parse GitHub's JSON `message` out of it. Falling back to response.text()
  // after response.json() would throw "body already read" and lose the detail
  // for non-JSON errors (e.g. an HTML 502/503 from the edge).
  try {
    const text = (await response.text()).trim();
    if (text) {
      try {
        detail = (JSON.parse(text) as { message?: string }).message || text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // Keep statusText.
  }
  return new GitHubApiError(
    `GitHub API ${response.status}: ${detail}`,
    response.status,
    url,
  );
}

function withPerPage(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('per_page')) {
    parsed.searchParams.set('per_page', '100');
  }
  return parsed.toString();
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function fetchGitHubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw await gitHubError(response, url);
  return (await response.json()) as T;
}

async function fetchGitHubPages<T>(url: string, token: string): Promise<T[]> {
  const items: T[] = [];
  let pageUrl: string | null = withPerPage(url);

  while (pageUrl) {
    const response = await fetch(pageUrl, { headers: githubHeaders(token) });
    if (!response.ok) throw await gitHubError(response, pageUrl);
    const page = (await response.json()) as T[];
    if (!Array.isArray(page)) {
      throw new Error(`GitHub API returned a non-list response for ${pageUrl}`);
    }
    items.push(...page);
    pageUrl = nextLink(response.headers.get('link'));
  }

  return items;
}

function packageToGhcrPackage(
  owner: string,
  pkg: GitHubPackage,
  isOrg: boolean,
): GhcrPackage {
  const normalizedOwner = owner.toLowerCase();
  const normalizedPackageName = pkg.name.toLowerCase();
  return {
    name: `ghcr.io/${normalizedOwner}/${normalizedPackageName}`,
    owner: normalizedOwner,
    packageName: pkg.name,
    isOrg,
  };
}

function formatWarning(context: string, error: unknown): string {
  return `${context}: ${formatGitHubApiError(error)}`;
}

export function formatGitHubApiError(error: unknown): string {
  if (error instanceof GitHubApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * List GHCR container packages visible to the authenticated GitHub token.
 */
export async function listGitHubPackages(
  token: string,
): Promise<GhcrPackageList> {
  const warnings: string[] = [];
  const user = await fetchGitHubJson<GitHubUser>(
    `${GITHUB_API_BASE}/user`,
    token,
  );

  const [userPackagesResult, orgsResult] = await Promise.allSettled([
    fetchGitHubPages<GitHubPackage>(
      `${GITHUB_API_BASE}/user/packages?package_type=container`,
      token,
    ),
    fetchGitHubPages<GitHubOrg>(`${GITHUB_API_BASE}/user/orgs`, token),
  ]);

  const packages: GhcrPackage[] = [];

  if (userPackagesResult.status === 'fulfilled') {
    packages.push(
      ...userPackagesResult.value.map((pkg) =>
        packageToGhcrPackage(user.login, pkg, false),
      ),
    );
  } else {
    warnings.push(
      formatWarning(
        'Could not list personal GHCR packages',
        userPackagesResult.reason,
      ),
    );
  }

  const orgs =
    orgsResult.status === 'fulfilled' ? orgsResult.value : ([] as GitHubOrg[]);
  if (orgsResult.status === 'rejected') {
    warnings.push(
      formatWarning('Could not list GitHub orgs', orgsResult.reason),
    );
  }

  const orgPackageResults = await Promise.allSettled(
    orgs.map(async (org) => {
      const orgPackages = await fetchGitHubPages<GitHubPackage>(
        `${GITHUB_API_BASE}/orgs/${org.login}/packages?package_type=container`,
        token,
      );
      return orgPackages.map((pkg) =>
        packageToGhcrPackage(org.login, pkg, true),
      );
    }),
  );

  for (let i = 0; i < orgPackageResults.length; i++) {
    const result = orgPackageResults[i];
    if (result.status === 'fulfilled') {
      packages.push(...result.value);
    } else {
      warnings.push(
        formatWarning(
          `Could not list GHCR packages for org ${orgs[i]?.login ?? i + 1}`,
          result.reason,
        ),
      );
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages, warnings };
}

/**
 * List tags for a GHCR package. Tags are returned in GitHub's version order,
 * with duplicates removed across paginated versions.
 */
export async function fetchPackageTags(
  token: string,
  pkg: GhcrPackage,
): Promise<string[]> {
  const packageName = encodeURIComponent(pkg.packageName);
  const baseUrl = pkg.isOrg
    ? `${GITHUB_API_BASE}/orgs/${pkg.owner}/packages/container/${packageName}/versions`
    : `${GITHUB_API_BASE}/user/packages/container/${packageName}/versions`;
  const versions = await fetchGitHubPages<GitHubPackageVersion>(baseUrl, token);
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const version of versions) {
    for (const tag of version.metadata?.container?.tags ?? []) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }

  return tags;
}
