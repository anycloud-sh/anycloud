import { Command } from 'commander';
import { exchangeApiToken, getGitHubToken } from '../services/auth.js';
import { normalizeApiUrl } from '../../shared/config.js';
import { resolveGitHubToken } from '../../shared/services/auth.js';
import {
  authenticateWithGitHub,
  completePendingSignIn,
  gitHubAccepts,
  relayGitHubSignIn,
} from '../services/oauth.js';
import { isUnattended } from '../session/detect.js';
import { printError, printSuccess } from '../utils/output.js';

/** Exchange the GitHub sign-in (signing in first if needed) for a hosted API's token. */
async function loginToApi(api: string): Promise<void> {
  const url = normalizeApiUrl(api);
  await exchangeApiToken(url, await getGitHubToken());
  printSuccess(`Signed in to ${url}.`);
}

export function createLoginCommand(): Command {
  return new Command('login')
    .description('🔓 Login to anycloud')
    .argument('[api]', 'Also sign in to this hosted API, by its URL')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud login
  $ anycloud login https://<cluster-id>.anycloud.sh

Output:
  Enter this code: XXXX-YYYY on https://github.com/login/device
  Or visit: https://github.com/login/device?user_code=XXXX-YYYY
  Waiting for authorization...
  ✓ Successfully authenticated with GitHub!

Login asks GitHub only for read:org and read:packages, enough to run your
own and your organizations' private ghcr.io images. It doesn't set up Docker
to push images. To push to ghcr.io, use the GitHub CLI with GH_TOKEN and
GITHUB_TOKEN unset (gh auth refresh fails while either is set):
  $ gh auth refresh -s write:packages
  $ gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" \\
      --password-stdin
In GitHub Actions, use GITHUB_TOKEN with 'packages: write'.

When an agent runs it, or stdout isn't a terminal, login prints the URL and
code as {"actionRequired": ...} JSON and exits 1 instead of waiting. Approve
the code in a browser; the next anycloud command completes the sign-in.

With a hosted API's URL, login exchanges your GitHub sign-in for that API's
token and saves it; every command to that API then sends only that token.
Run it again after 'anycloud api token rotate' on another machine.

Re-run 'anycloud login' to refresh an expired token, and 'anycloud login
<api-url>' to give a hosted API your current sign-in. Workloads don't
receive this token; pass Git access to them with a Secret.
'anycloud service upgrade' refreshes the token the host uses to pull a
Service's private image.
`,
    )
    .action(async (api: string | undefined) => {
      try {
        if (api) {
          await loginToApi(api);
          return;
        }
        if (!isUnattended()) {
          await authenticateWithGitHub();
          return;
        }
        // Unattended: finish the code an earlier run relayed, or relay one.
        if (await completePendingSignIn()) return;
        const token = resolveGitHubToken();
        if (token && (await gitHubAccepts(token))) {
          printSuccess('Already signed in with GitHub.');
          return;
        }
        await relayGitHubSignIn(
          token ? 'GitHub rejected your sign-in.' : undefined,
        );
      } catch (error) {
        printError(`Login failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
