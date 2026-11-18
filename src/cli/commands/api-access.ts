import { Command } from 'commander';
import {
  apiClient,
  getGitHubToken,
  hostedApiBearer,
} from '../services/auth.js';
import { getApiUrl } from '../../shared/config.js';
import { saveApiToken } from '../../shared/services/auth.js';
import { newTable } from '../renderers/table.js';
import type {
  ApiAccessMember,
  ApiAccessUsersResponse,
} from '../../shared/api-contract/api-access-schemas.js';
import {
  printError,
  printInfo,
  printSuccess,
  setJsonMode,
} from '../utils/output.js';

const SERVICE_ACCOUNT_OPTION = '--service-account <deployment>';

/** A GitHub user, or with `--service-account` a Deployment name, not both. */
function oneTarget(
  user: string | undefined,
  options: { serviceAccount?: string },
): void {
  if (!user === !options.serviceAccount) {
    throw new Error(
      `Name a GitHub user or pass ${SERVICE_ACCOUNT_OPTION}, not both.`,
    );
  }
}

function createAddCommand(): Command {
  return new Command('add')
    .description(
      'Grant a GitHub user or a Deployment access to the active hosted API',
    )
    .argument('[github-user]', 'GitHub username')
    .option(
      SERVICE_ACCOUNT_OPTION,
      "Admit this Deployment's replicas by their ServiceAccount token, before or after it is created",
    )
    .action(
      async (
        username: string | undefined,
        options: { serviceAccount?: string },
      ) => {
        try {
          oneTarget(username, options);
          const user = await (
            await apiClient()
          ).apiAccess.grant(
            options.serviceAccount
              ? { serviceAccount: options.serviceAccount }
              : { username: username! },
          );
          printSuccess(
            user.kind === 'github'
              ? `Granted hosted API access to ${user.username} (${user.userId}).`
              : `Granted hosted API access to Deployment ${user.username}${user.deploymentId ? '; its replicas restart to mount the token' : ', once it exists'}.`,
          );
        } catch (err) {
          printError(`Failed to grant API access: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
}

function createListCommand(): Command {
  return new Command('list')
    .alias('ls')
    .description('List users with access to the active hosted API')
    .option('--json', 'Emit API access as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        if (options.json) setJsonMode(true);
        const api = await apiClient();
        const access = await api.apiAccess.list();
        if (options.json) {
          console.log(JSON.stringify(access));
          return;
        }

        const table = newTable({
          head: ['ROLE', 'KIND', 'NAME', 'ID'],
          style: { head: [] },
        });
        table.push([
          'owner',
          'github',
          access.owner.username,
          access.owner.userId,
        ]);
        for (const user of access.users) {
          table.push([
            'member',
            user.kind,
            user.username,
            user.kind === 'github'
              ? user.userId
              : (user.deploymentId ?? 'no deployment'),
          ]);
        }
        console.log(table.toString());
      } catch (err) {
        printError(`Failed to list API access: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function resolveRemovableUser(
  identifier: string,
  access: ApiAccessUsersResponse,
): ApiAccessMember {
  const requested = identifier.trim();
  const requestedUsername = requested.toLowerCase();
  if (
    access.owner.userId === requested ||
    access.owner.username.toLowerCase() === requestedUsername
  ) {
    throw new Error('The hosted API owner cannot be removed');
  }

  const github = access.users.filter(({ kind }) => kind === 'github');
  const user =
    github.find((candidate) => candidate.userId === requested) ??
    github.find(
      (candidate) => candidate.username.toLowerCase() === requestedUsername,
    );
  if (!user) {
    throw new Error(
      `GitHub user "${identifier}" does not have hosted API access. Run "anycloud api access list" to see removable users.`,
    );
  }
  return user;
}

function createRemoveCommand(): Command {
  return new Command('remove')
    .alias('rm')
    .description(
      'Remove a GitHub user or a Deployment from the active hosted API',
    )
    .argument('[github-user-or-id]', 'GitHub username or immutable account ID')
    .option(SERVICE_ACCOUNT_OPTION, 'Remove the registered Deployment name')
    .action(
      async (
        identifier: string | undefined,
        options: { serviceAccount?: string },
      ) => {
        try {
          oneTarget(identifier, options);
          const client = await apiClient();
          if (options.serviceAccount) {
            // The API lowercases the name as it did at registration.
            await client.apiAccess.revoke({
              params: { userId: `serviceaccount:${options.serviceAccount}` },
            });
            printSuccess(
              `Deployment ${options.serviceAccount} no longer has hosted API access.`,
            );
            return;
          }
          const target = resolveRemovableUser(
            identifier!,
            await client.apiAccess.list(),
          );
          await client.apiAccess.revoke({
            params: { userId: target.userId },
          });
          printSuccess(
            `${target.username} (${target.userId}) no longer has hosted API access.`,
          );
          printInfo('Existing workloads were not stopped.');
          printInfo(`Review them with: anycloud list --user ${target.userId}`);
        } catch (err) {
          printError(`Failed to remove API access: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
}

export function createApiAccessCommand(): Command {
  const access = new Command('access').description(
    'Manage who and which Deployments can use the active hosted API',
  );
  access.addCommand(createAddCommand());
  access.addCommand(createRemoveCommand());
  access.addCommand(createListCommand());
  return access;
}

function createApiTokenRotateCommand(): Command {
  return new Command('rotate')
    .description('Replace your token for the active hosted API')
    .action(async () => {
      try {
        const url = getApiUrl();
        const { token } = await (
          await apiClient({ apiUrl: url })
        ).apiAccess.rotateToken({});
        saveApiToken(url, token);
        console.log(token);
        process.stderr.write(
          `Elsewhere, run \`anycloud login ${url}\` or update ANYCLOUD_API_TOKEN.\n`,
        );
      } catch (err) {
        printError(`Failed to rotate the API token: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function createApiTokenCommand(): Command {
  const command = new Command('token')
    .description('Print your token for the active hosted API')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud api token
  $ anycloud api token rotate

Every machine gets the same token; CI sets it as ANYCLOUD_API_TOKEN beside
API_URL. 'rotate' replaces it everywhere.
`,
    )
    .action(async () => {
      try {
        const url = getApiUrl();
        const token = await hostedApiBearer(url, () => getGitHubToken());
        // Without an API token the bearer is a GitHub sign-in: never print it.
        if (!token?.startsWith('acapi_')) {
          throw new Error(`${url} issued no API token.`);
        }
        console.log(token);
      } catch (err) {
        printError(`Failed to get the API token: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  command.addCommand(createApiTokenRotateCommand());
  return command;
}
