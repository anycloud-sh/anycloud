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

const SERVICE_OPTION = '--service <name>';

interface TargetOptions {
  service?: string;
}

/** A GitHub user, or with `--service` a service, not both. */
function oneTarget(user: string | undefined, options: TargetOptions): void {
  if (!user === !options.service) {
    throw new Error(`Name a GitHub user or pass ${SERVICE_OPTION}, not both.`);
  }
}

/** A new token goes to stdout alone, so scripts can capture it. */
function printToken(
  token: string,
  json: object | undefined,
  hint: string,
): void {
  if (json) {
    console.log(JSON.stringify(json));
    return;
  }
  console.log(token);
  process.stderr.write(`${hint}\n`);
}

function createAddCommand(): Command {
  return new Command('add')
    .description(
      'Grant a GitHub user or a service access to the active hosted API',
    )
    .argument('[github-user]', 'GitHub username')
    .option(
      SERVICE_OPTION,
      'Issue a token for a service, such as a CI system; it is printed once',
    )
    .option('--json', 'Emit the new member, and a service token, as JSON')
    .action(
      async (
        username: string | undefined,
        options: TargetOptions & { json?: boolean },
      ) => {
        try {
          if (options.json) setJsonMode(true);
          oneTarget(username, options);
          const client = await apiClient();
          if (options.service) {
            const issued = await client.apiAccess.issueServiceToken({
              name: options.service,
            });
            printToken(
              issued.token,
              options.json ? issued : undefined,
              `This is the only time the token for service ${issued.username} is shown. Set it as ANYCLOUD_API_TOKEN beside API_URL.`,
            );
            return;
          }
          const user = await client.apiAccess.grant({ username: username! });
          if (options.json) {
            console.log(JSON.stringify(user));
            return;
          }
          printSuccess(
            `Granted hosted API access to ${user.username} (${user.userId}).`,
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
          table.push(['member', user.kind, user.username, user.userId]);
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
    .description('Remove a GitHub user or a service from the active hosted API')
    .argument('[github-user-or-id]', 'GitHub username or immutable account ID')
    .option(SERVICE_OPTION, "Revoke the service's token")
    .action(async (identifier: string | undefined, options: TargetOptions) => {
      try {
        oneTarget(identifier, options);
        const client = await apiClient();
        if (options.service) {
          await client.apiAccess.revoke({
            params: { userId: `service:${options.service}` },
          });
          printSuccess(
            `Service ${options.service} no longer has hosted API access.`,
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
    });
}

export function createApiAccessCommand(): Command {
  const access = new Command('access').description(
    'Manage who and which services can use the active hosted API',
  );
  access.addCommand(createAddCommand());
  access.addCommand(createRemoveCommand());
  access.addCommand(createListCommand());
  return access;
}

function createApiTokenRotateCommand(): Command {
  return new Command('rotate')
    .description(
      "Replace your token, or a service's, for the active hosted API",
    )
    .option(SERVICE_OPTION, "Replace this service's token (owner only)")
    .option('--json', 'Emit the new token as JSON')
    .action(async (options: { service?: string; json?: boolean }) => {
      try {
        if (options.json) setJsonMode(true);
        const url = getApiUrl();
        const client = await apiClient({ apiUrl: url });
        if (options.service) {
          const rotated = await client.apiAccess.rotateServiceToken({
            params: { name: options.service },
          });
          printToken(
            rotated.token,
            options.json ? rotated : undefined,
            `Service ${options.service}'s previous token no longer works; update its ANYCLOUD_API_TOKEN.`,
          );
          return;
        }
        const rotated = await client.apiAccess.rotateToken({});
        saveApiToken(url, rotated.token);
        printToken(
          rotated.token,
          options.json ? rotated : undefined,
          `Elsewhere, run \`anycloud login ${url}\` or update ANYCLOUD_API_TOKEN.`,
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
  $ anycloud api token rotate --service ci

Every machine gets the same token; CI sets it as ANYCLOUD_API_TOKEN beside
API_URL. 'rotate' replaces it everywhere. A service's token comes from
'anycloud api access add --service <name>'.
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
