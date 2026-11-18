/**
 * Private Git through the documented `github` Secret (docs/platform/
 * secrets-environment.md, "Git access from workloads"): inside an Alpine-based
 * workload, the docs' `insteadOf` rewrite, then `git ls-remote` and a sparse,
 * shallow clone of a private fixture repository, read with
 * `E2E_PRIVATE_REPO_TOKEN`.
 *
 * The script prints only `PRIVATE_GIT_*` markers and always exits 0. Git's
 * stderr is matched for the authentication failure, never printed, so a URL
 * credential cannot reach a log.
 */
const REPOSITORY = 'https://github.com/anycloud-sh/private-fixture.git';

export const PRIVATE_GIT_SCRIPT = [
  'apk add --no-cache git >/dev/null 2>&1 || echo PRIVATE_GIT_APK=failed',
  'if [ -n "${GITHUB_TOKEN:-}" ]; then echo PRIVATE_GIT_TOKEN=present; else echo PRIVATE_GIT_TOKEN=absent; fi',
  'git config --global url."https://x-access-token:${GITHUB_TOKEN:-}@github.com/".insteadOf "https://github.com/"',
  'export GIT_TERMINAL_PROMPT=0',
  `git ls-remote ${REPOSITORY} HEAD >/dev/null 2>/tmp/private-git.err; echo "PRIVATE_GIT_LS_REMOTE=$?"`,
  'grep -q "Authentication failed" /tmp/private-git.err && echo PRIVATE_GIT_AUTH=refused',
  'rm -rf /tmp/private-git',
  `git clone --quiet --depth 1 --filter=blob:none --sparse ${REPOSITORY} /tmp/private-git >/dev/null 2>&1; echo "PRIVATE_GIT_CLONE=$?"`,
  'test -f /tmp/private-git/AGENTS.md && echo PRIVATE_GIT_FILE=AGENTS.md',
  'rm -rf /tmp/private-git /tmp/private-git.err',
].join('\n');

/** The probe's markers, keyed without the `PRIVATE_GIT_` prefix. */
export function privateGitMarkers(log: string): Record<string, string> {
  return Object.fromEntries(
    [...log.matchAll(/^PRIVATE_GIT_([A-Z_]+)=(\S+)$/gmu)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

/**
 * Whether the markers show the expected outcome: with the Secret, the token
 * is present and both commands succeed; without it, the token is absent and
 * GitHub refuses the credential, so the clone fails too.
 */
export function privateGitPassed(
  markers: Record<string, string>,
  withSecret: boolean,
): boolean {
  return withSecret
    ? markers.TOKEN === 'present' &&
        markers.LS_REMOTE === '0' &&
        markers.CLONE === '0' &&
        markers.FILE === 'AGENTS.md'
    : markers.TOKEN === 'absent' &&
        markers.AUTH === 'refused' &&
        markers.CLONE !== undefined &&
        markers.CLONE !== '0';
}
