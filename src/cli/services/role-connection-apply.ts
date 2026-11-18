/**
 * `credentials new --role --apply`: create a role connection's cloud side by
 * applying the API's setup template through the user's own signed-in cloud
 * CLI (the seed's runners), then return the identifiers to save. The user
 * owns what it creates; deleting it is theirs (or backmesh's) to do.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoleConnectionRequest } from '../../shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../shared/cloud.js';
import type { RoleSetupCloud } from '../../shared/role-connection-setup.js';
import { discoverAccount } from '../seed/accounts.js';
import { createCloudCli } from '../seed/cloud-cli.js';
import {
  CloudCliError,
  SeedUnavailableError,
  type SeedCloud,
} from '../seed/types.js';
import { exitWithActionRequired, exitWithError } from '../utils/output.js';
import {
  exitWithLifecycleError,
  NOT_RUN_EXIT_CODE,
} from '../utils/lifecycle-result.js';
import {
  CommandFailedError,
  CommandNotFoundError,
  runArgv,
} from './slurp/cli-exec.js';

/** The cloud's CLI is installed but signed out; `command` signs it in. */
class RoleApplySignInError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
  }
}

/** The cloud refused the apply for want of rights (`CLOUD_RIGHTS_MISSING`). */
class RoleApplyRightsError extends Error {
  readonly code = 'CLOUD_RIGHTS_MISSING';
}

const DENIED =
  /AccessDenied|not authorized|PERMISSION_DENIED|Required '[\w.]+' permission|AuthorizationFailed|does not have authorization/i;
/** The account already has this API's OIDC provider, from another stack. */
const PROVIDER_EXISTS =
  /AWS::IAM::OIDCProvider[\s\S]*?(already exists|EntityAlreadyExists)/i;

/** One CloudFormation stack per API, so a second API gets its own trust. */
export function awsRoleStackName(apiUrl: string): string {
  return `anycloud-role-${new URL(apiUrl).hostname.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(
    0,
    128,
  );
}

/**
 * The Azure template puts its resource group in the deployment's location:
 * an existing `anycloud-role` group's, so a re-run converges, else this.
 */
const AZURE_DEFAULT_LOCATION = 'eastus';

/** The account to apply in, instead of the CLI's own default. */
export interface RoleApplyAccount {
  /** AWS profile. */
  profile?: string;
  /** GCP project. */
  projectId?: string;
  /** Azure subscription. */
  subscriptionId?: string;
}

/** What gets a signed-out (or project-less) CLI going. */
function signIn(
  cloud: SeedCloud,
  account: RoleApplyAccount,
  reason: string,
): string {
  if (cloud === 'aws')
    return !account.profile
      ? 'aws configure'
      : /could not be found/.test(reason)
        ? `aws configure --profile ${account.profile}`
        : `aws sso login --profile ${account.profile}`;
  if (cloud === 'gcp')
    return /no project is set/.test(reason)
      ? 'gcloud config set project <project-id>'
      : 'gcloud auth login';
  return 'az login';
}

/**
 * The cloud's CLI signed in to the selected account. A signed-out CLI throws
 * `RoleApplySignInError`; `refused` turns a rights refusal into
 * `RoleApplyRightsError` and rethrows anything else.
 */
export async function signedInCli(
  seedCloud: SeedCloud,
  selected: RoleApplyAccount,
  verb: 'create' | 'delete',
) {
  const env = {
    ...(selected.projectId && { CLOUDSDK_CORE_PROJECT: selected.projectId }),
  };
  const base = createCloudCli(seedCloud, env);
  // A flag, since exported access keys would outrank AWS_PROFILE.
  const profile = selected.profile ? ['--profile', selected.profile] : [];
  const cli: typeof base = {
    run: (command, options) =>
      base.run({ ...command, args: [...command.args, ...profile] }, options),
  };
  const signedIn = await discoverAccount(seedCloud, cli).catch(
    (error: unknown) => {
      // Installed, but signed out (discoverAccount names that case).
      if (
        error instanceof SeedUnavailableError &&
        /isn't signed in/.test(error.message)
      )
        throw new RoleApplySignInError(
          error.message,
          signIn(seedCloud, selected, error.message),
        );
      throw error;
    },
  );
  const account = {
    ...signedIn,
    account: selected.subscriptionId ?? signedIn.account,
  };
  const refused = (error: unknown, detail?: string): never => {
    const stderr =
      error instanceof CloudCliError || error instanceof CommandFailedError
        ? error.stderr
        : '';
    if (DENIED.test(detail ?? stderr))
      throw new RoleApplyRightsError(
        `${account.principal} may not ${verb} the role connection in ${seedCloud} account ${account.account}: ${(detail ?? stderr).trim()}`,
      );
    throw error;
  };
  return { cli, env, account, refused };
}

/**
 * Apply the template at `templateUrl` in the account the CLI (or `account`)
 * selects, returning the identifiers and that account. A signed-out CLI
 * throws `RoleApplySignInError`, a refusal `RoleApplyRightsError`.
 */
export async function applyRoleSetup(
  cloud: RoleSetupCloud,
  apiUrl: string,
  templateUrl: string,
  selected: RoleApplyAccount = {},
): Promise<{ body: RoleConnectionRequest; account: string }> {
  const seedCloud = cloud.toLowerCase() as SeedCloud;
  const { cli, env, account, refused } = await signedInCli(
    seedCloud,
    selected,
    'create',
  );
  const subscription = selected.subscriptionId
    ? ['--subscription', selected.subscriptionId]
    : [];
  const response = await fetch(templateUrl);
  if (!response.ok)
    throw new Error(
      `The API could not serve the ${cloud} setup template (HTTP ${response.status}).`,
    );
  const template = await response.text();

  const dir = await mkdtemp(join(tmpdir(), 'anycloud-role-'));
  try {
    const file = join(dir, 'template');
    await writeFile(file, template, { mode: 0o600 });
    // cloudtype-boundary-ok: each cloud has its own setup flow (RFC 0047).
    switch (cloud) {
      case CloudType.AWS: {
        const stack = awsRoleStackName(apiUrl);
        const aws = (...args: string[]) => cli.run({ args });
        const read = (...args: string[]) =>
          aws(...args).then(
            (out) => out.trim(),
            () => '',
          );
        const deploy = (overrides: string[]) =>
          aws(
            'cloudformation',
            'deploy',
            '--template-file',
            file,
            '--stack-name',
            stack,
            '--capabilities',
            'CAPABILITY_IAM',
            '--no-fail-on-empty-changeset',
            ...overrides,
          );
        const events = () =>
          read(
            'cloudformation',
            'describe-stack-events',
            '--stack-name',
            stack,
            '--output',
            'json',
          );
        /** A failed deploy names a refusal only in the stack's events. */
        const failed = async (error: unknown): Promise<never> => {
          if (DENIED.test(await events()))
            throw new RoleApplyRightsError(
              `${account.principal} may not create the role connection in aws account ${account.account}; see aws cloudformation describe-stack-events --stack-name ${stack}`,
            );
          return refused(error);
        };
        try {
          await deploy([]);
        } catch (error) {
          const status = await read(
            'cloudformation',
            'describe-stacks',
            '--stack-name',
            stack,
            '--query',
            'Stacks[0].StackStatus',
            '--output',
            'text',
          );
          // A stack that never came up holds nothing and blocks every
          // re-run, so it is recreated, whatever its old events say; a
          // working one is never deleted.
          if (status !== 'ROLLBACK_COMPLETE') await failed(error);
          const history = await events();
          await aws(
            'cloudformation',
            'delete-stack',
            '--stack-name',
            stack,
          ).catch(refused);
          await aws(
            'cloudformation',
            'wait',
            'stack-delete-complete',
            '--stack-name',
            stack,
          ).catch(refused);
          // The account already has this API's OIDC provider: reuse it.
          await deploy(
            PROVIDER_EXISTS.test(history)
              ? ['--parameter-overrides', 'IssuerProviderExists=true']
              : [],
          ).catch(failed);
        }
        const roleArn = (
          await cli.run({
            args: [
              'cloudformation',
              'describe-stacks',
              '--stack-name',
              stack,
              '--query',
              "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue",
              '--output',
              'text',
            ],
          })
        ).trim();
        if (!roleArn.startsWith('arn:'))
          throw new Error(`Stack ${stack} has no RoleArn output.`);
        return {
          body: { cloudProvider: cloud, kind: 'role', roleArn },
          account: account.account,
        };
      }
      // cloudtype-boundary-ok: each cloud has its own setup flow (RFC 0047).
      case CloudType.GCP: {
        // In the temp directory: the script writes its role file there.
        // Its stderr shows, so the user sees its notes (a reused provider).
        const stdout = await runArgv('bash', [file], {
          env,
          cwd: dir,
          timeoutMs: 30 * 60_000,
          showStderr: true,
        }).catch(refused);
        const value = (label: string) =>
          new RegExp(`^\\s*${label}:\\s*(\\S+)\\s*$`, 'm').exec(stdout)?.[1];
        const workloadIdentityProvider = value('workload identity provider');
        const serviceAccountEmail = value('service account email');
        if (!workloadIdentityProvider || !serviceAccountEmail)
          throw new Error('The GCP setup script printed no identifiers.');
        return {
          body: {
            cloudProvider: cloud,
            kind: 'role',
            workloadIdentityProvider,
            serviceAccountEmail,
          },
          account: account.account,
        };
      }
      // cloudtype-boundary-ok: each cloud has its own setup flow (RFC 0047).
      case CloudType.Azure: {
        // A deployment keeps its location, and so does its group.
        const location = (...args: string[]) =>
          cli
            .run({
              args: [
                ...args,
                '--query',
                'location',
                '--output',
                'tsv',
                ...subscription,
              ],
            })
            .then(
              (out) => out.trim(),
              () => '',
            );
        const existing =
          (await location(
            'deployment',
            'sub',
            'show',
            '--name',
            'anycloud-role',
          )) || (await location('group', 'show', '--name', 'anycloud-role'));
        const outputs = JSON.parse(
          await cli
            .run({
              args: [
                'deployment',
                'sub',
                'create',
                '--name',
                'anycloud-role',
                '--location',
                existing || AZURE_DEFAULT_LOCATION,
                '--template-file',
                file,
                '--query',
                'properties.outputs',
                '--output',
                'json',
                ...subscription,
              ],
            })
            .catch(refused),
        ) as Record<string, { value?: string } | undefined>;
        const value = (key: string) => {
          const found = outputs[key]?.value;
          if (!found)
            throw new Error(`The Azure deployment has no ${key} output.`);
          return found;
        };
        return {
          body: {
            cloudProvider: cloud,
            kind: 'role',
            applicationId: value('applicationId'),
            directoryId: value('directoryId'),
            subscriptionId: value('subscriptionId'),
          },
          account: account.account,
        };
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Report an `--apply` failure and exit. A sign-in the CLI needs is a step for
 * the user, relayed as `actionRequired` with `--json` (exit 2, as for GitHub);
 * a missing CLI and a refusal take `cluster create`'s codes.
 */
export function exitWithRoleApplyError(
  failure: string,
  error: unknown,
  json: boolean | undefined,
  ownCode?: (error: unknown) => string | undefined,
): never {
  if (error instanceof RoleApplySignInError) {
    const message = `${error.message} (\`${error.command}\`), then retry.`;
    if (!json) exitWithError(`${failure}: ${message}`, NOT_RUN_EXIT_CODE);
    exitWithActionRequired(
      { code: 'CLOUD_SIGN_IN_REQUIRED', message, command: error.command },
      NOT_RUN_EXIT_CODE,
    );
  }
  exitWithLifecycleError(failure, error, json, (error) => {
    if (
      error instanceof SeedUnavailableError ||
      error instanceof CommandNotFoundError
    )
      return 'CLOUD_CLI_UNAVAILABLE';
    if (error instanceof RoleApplyRightsError) return error.code;
    return ownCode?.(error);
  });
}
