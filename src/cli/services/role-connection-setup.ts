import { ORPCError } from '@orpc/client';
import {
  credentialsExistDataSchema,
  type RoleConnectionRequest,
} from '../../shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../shared/cloud.js';
import { CredentialNameExistsError } from '../../shared/errors.js';
import {
  ROLE_SETUP_PATHS,
  type RoleSetupCloud,
} from '../../shared/role-connection-setup.js';
import { resolveApiTarget } from '../../shared/config.js';
import { printInfo, printSuccess, setJsonMode } from '../utils/output.js';
import {
  exitWithLifecycleError,
  NOT_RUN_EXIT_CODE,
  UsageError,
} from '../utils/lifecycle-result.js';
import { normalizeCredentialProvider } from '../utils/providers.js';
import { apiClient } from './auth.js';
import { requireOrPrompt, shouldAllowPrompts } from '../utils/safe-prompts.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import {
  applyRoleSetup,
  awsRoleStackName,
  exitWithRoleApplyError,
} from './role-connection-apply.js';

export interface RoleConnectionOptions {
  overwrite?: boolean;
  provider?: string;
  roleArn?: string;
  workloadIdentityProvider?: string;
  serviceAccountEmail?: string;
  applicationId?: string;
  directoryId?: string;
  subscriptionId?: string;
  json?: boolean;
  apply?: boolean;
  /** With --apply: the AWS profile or GCP project to apply in. */
  profile?: string;
  projectId?: string;
}

/** The role path's own refusal, its own --json code (exit 1). */
class RoleSetupUnavailableError extends Error {}

/** {@link requireOrPrompt}, but a missing value without prompts exits 2. */
function flagOrPrompt<T>(
  provided: string | undefined,
  options: RoleConnectionOptions,
  opts: Parameters<typeof requireOrPrompt<T>>[1],
): Promise<T> {
  if (provided === undefined && (options.json || !shouldAllowPrompts()))
    throw new UsageError(opts.missingError);
  return requireOrPrompt(provided, opts);
}

const ROLE_CLOUDS: readonly string[] = Object.keys(ROLE_SETUP_PATHS);

async function roleConnectionCloud(
  options: RoleConnectionOptions,
): Promise<RoleSetupCloud> {
  return flagOrPrompt(options.provider, options, {
    parse: (raw) => {
      const cloud = normalizeCredentialProvider(raw);
      if (!ROLE_CLOUDS.includes(cloud))
        throw new UsageError(
          `Role connections are available on aws, gcp and azure, not ${cloud}`,
        );
      return cloud as RoleSetupCloud;
    },
    missingError: 'Pass --provider aws, gcp or azure with --role.',
    prompt: {
      type: 'select',
      name: 'value',
      message: 'Cloud for this role connection:',
      choices: ROLE_CLOUDS.map((cloud) => ({
        title: cloud,
        value: cloud.toLowerCase(),
      })),
    },
  });
}

/**
 * How to create the cloud side from the template the API serves. Throws when
 * the API serves none: only a self-hosted API has a ServiceAccount issuer.
 */
async function roleSetupInstructions(
  apiUrl: string,
  cloud: RoleSetupCloud,
): Promise<string[]> {
  const url = `${apiUrl}${ROLE_SETUP_PATHS[cloud]}`;
  const response = await fetch(url, { method: 'HEAD' });
  if (response.status === 404)
    throw new RoleSetupUnavailableError(
      'This API serves no role setup template. Role connections need a self-hosted API; a local API saves keys only.',
    );
  if (!response.ok)
    throw new Error(
      `The API could not serve the ${cloud} setup template (HTTP ${response.status}).`,
    );
  // cloudtype-boundary-ok: each cloud has its own setup flow (RFC 0047).
  switch (cloud) {
    case CloudType.AWS: {
      const stack = awsRoleStackName(apiUrl);
      const deploy = `  aws cloudformation deploy --template-file anycloud-role.json --stack-name ${stack} --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset`;
      return [
        'Create the role in AWS CloudShell (https://console.aws.amazon.com/cloudshell/home):',
        `  curl -fsSLo anycloud-role.json ${url}`,
        deploy,
        `  aws cloudformation describe-stacks --stack-name ${stack} --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
        `If the deploy fails because the account already has this API's OIDC provider (aws cloudformation describe-stack-events --stack-name ${stack} shows it), recreate the stack to reuse that provider:`,
        `  aws cloudformation delete-stack --stack-name ${stack}`,
        `  aws cloudformation wait stack-delete-complete --stack-name ${stack}`,
        `${deploy} --parameter-overrides IssuerProviderExists=true`,
        'Pass IssuerProviderExists=true only on a new stack: on an existing one it deletes the provider that stack created.',
      ];
    }
    // cloudtype-boundary-ok: each cloud has its own setup flow (RFC 0047).
    case CloudType.GCP:
      return [
        'Run in Google Cloud Shell (https://shell.cloud.google.com/?show=terminal) with your project selected:',
        `  curl -fsSL ${url} | bash`,
      ];
    // cloudtype-boundary-ok: each cloud has its own setup flow (RFC 0047).
    case CloudType.Azure:
      return [
        'Deploy to Azure, then copy applicationId, directoryId and subscriptionId from the deployment outputs:',
        `  https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(url)}`,
      ];
  }
}

/** The identifiers the setup printed, from flags or prompts. */
async function roleConnectionRequest(
  cloud: RoleSetupCloud,
  options: RoleConnectionOptions,
): Promise<RoleConnectionRequest> {
  const identifier = (
    provided: string | undefined,
    flag: string,
    message: string,
  ) =>
    flagOrPrompt(provided, options, {
      parse: (raw) => raw.trim(),
      missingError: `Pass ${flag}, or run the command in a terminal to be asked for it.`,
      prompt: { type: 'text', name: 'value', message },
    });
  // cloudtype-boundary-ok: each cloud saves its own identifiers (RFC 0047).
  switch (cloud) {
    case CloudType.AWS:
      return {
        cloudProvider: cloud,
        kind: 'role',
        roleArn: await identifier(options.roleArn, '--role-arn', 'Role ARN:'),
      };
    case CloudType.GCP:
      return {
        cloudProvider: cloud,
        kind: 'role',
        workloadIdentityProvider: await identifier(
          options.workloadIdentityProvider,
          '--workload-identity-provider',
          'Workload identity provider (projects/…/providers/…):',
        ),
        serviceAccountEmail: await identifier(
          options.serviceAccountEmail,
          '--service-account-email',
          'Service account email:',
        ),
      };
    // cloudtype-boundary-ok: each cloud saves its own identifiers (RFC 0047).
    case CloudType.Azure:
      return {
        cloudProvider: cloud,
        kind: 'role',
        applicationId: await identifier(
          options.applicationId,
          '--application-id',
          'Application (client) ID:',
        ),
        directoryId: await identifier(
          options.directoryId,
          '--directory-id',
          'Directory (tenant) ID:',
        ),
        subscriptionId: await identifier(
          options.subscriptionId,
          '--subscription-id',
          'Subscription ID:',
        ),
      };
  }
}

/** `--json` and `--apply` without `--role`: a usage error (exit 2). */
export function refuseRoleOnlyFlags(options: RoleConnectionOptions): void {
  const flag = options.json ? '--json' : options.apply ? '--apply' : undefined;
  if (flag)
    exitWithLifecycleError(
      'Failed to add credentials',
      new UsageError(`${flag} works with --role only.`),
      options.json,
    );
}

/**
 * `--apply`: the cloud side through the user's own CLI. When that CLI is
 * missing, signed out or refused, the manual steps follow, and in a terminal
 * the identifiers are asked for; otherwise the refusal is the error.
 */
async function appliedOrManual(
  cloud: RoleSetupCloud,
  apiUrl: string,
  steps: string[],
  options: RoleConnectionOptions,
): Promise<{ body: RoleConnectionRequest; account?: string }> {
  printInfo(
    `Applying the ${cloud} role setup through your ${cloud.toLowerCase()} CLI; this can take a few minutes...`,
  );
  try {
    return await applyRoleSetup(
      cloud,
      apiUrl,
      `${apiUrl}${ROLE_SETUP_PATHS[cloud]}`,
      options,
    );
  } catch (error) {
    printInfo(
      `Could not apply it (${errorMessage(error)}). Set it up by hand:`,
    );
    for (const line of steps) printInfo(line);
    if (!options.json && shouldAllowPrompts())
      return { body: await roleConnectionRequest(cloud, options) };
    throw error;
  }
}

/** --apply reads the identifiers, and takes only the account to apply in. */
function refuseIdentifiersWithApply(
  cloud: RoleSetupCloud,
  options: RoleConnectionOptions,
): void {
  const given = [
    options.roleArn && '--role-arn',
    options.workloadIdentityProvider && '--workload-identity-provider',
    options.serviceAccountEmail && '--service-account-email',
    options.applicationId && '--application-id',
    options.directoryId && '--directory-id',
    // cloudtype-boundary-ok: each cloud selects its account by its own flag.
    cloud !== CloudType.Azure && options.subscriptionId && '--subscription-id',
    cloud !== CloudType.AWS && options.profile && '--profile',
    cloud !== CloudType.GCP && options.projectId && '--project-id',
  ].filter(Boolean);
  if (given.length > 0)
    throw new UsageError(
      `--apply reads the identifiers itself; drop ${given.join(', ')}.`,
    );
}

/**
 * `credentials new --role`: print the setup, then save the identifiers. With
 * --json or no terminal it never prompts, and stdout carries only the result
 * or the lifecycle error document.
 */
export async function saveRoleConnection(
  provided: string | undefined,
  options: RoleConnectionOptions,
): Promise<void> {
  try {
    await saveRoleConnectionOrThrow(provided, options);
  } catch (error) {
    exitWithRoleApplyError(
      'Failed to add credentials',
      error,
      options.json,
      (error) =>
        // The API's code for the same refusal.
        error instanceof CredentialNameExistsError
          ? 'CREDENTIAL_NAME_EXISTS'
          : error instanceof RoleSetupUnavailableError
            ? 'ROLE_SETUP_UNAVAILABLE'
            : undefined,
    );
  }
}

async function saveRoleConnectionOrThrow(
  provided: string | undefined,
  options: RoleConnectionOptions,
): Promise<void> {
  if (options.json) setJsonMode(true);
  const name = await flagOrPrompt(provided, options, {
    parse: (raw) => {
      if (!raw.trim()) throw new UsageError('The name cannot be empty.');
      return raw.trim();
    },
    missingError: 'Pass the name: anycloud credentials new <name> --role.',
    prompt: {
      type: 'text',
      name: 'value',
      message: 'Name for this role connection:',
      validate: (value: string) => value.trim().length > 0 || 'Name required',
    },
  });
  const cloud = await roleConnectionCloud(options);
  if (options.apply) refuseIdentifiersWithApply(cloud, options);
  const client = await apiClient({ missingExitCode: NOT_RUN_EXIT_CODE });
  const taken = options.overwrite
    ? undefined
    : (await client.credentials.list()).find((saved) => saved.name === name);
  // A taken name is refused, unless --apply may be re-saving this very
  // trust: a role connection of this cloud. The API then saves it as a
  // no-op once the cloud accepts it, or refuses another trust.
  if (
    taken &&
    (!options.apply ||
      taken.cloudProvider !== cloud ||
      !('kind' in taken) ||
      taken.kind !== 'role')
  )
    throw new CredentialNameExistsError(name);
  const apiUrl = resolveApiTarget().url;
  const steps = await roleSetupInstructions(apiUrl, cloud);
  let applied: { body: RoleConnectionRequest; account?: string };
  if (options.apply) {
    applied = await appliedOrManual(cloud, apiUrl, steps, options);
  } else {
    for (const line of steps) printInfo(line);
    applied = { body: await roleConnectionRequest(cloud, options) };
  }
  const { body, account } = applied;
  // No spinner: the client prints the API's message while it waits for the
  // cloud's IAM to accept a new trust (up to 2.5 minutes).
  printInfo(`Checking role connection "${name}" with ${cloud}...`);
  try {
    await client.credentials.save({
      params: { name },
      query: { overwrite: options.overwrite ? 'true' : 'false' },
      body,
    });
  } catch (error) {
    // --apply re-run under a new name: the trust is saved already, as
    // `existingName`, which is the connection's name.
    const existingName = savedElsewhere(error);
    // With --overwrite the user asked for this name: not a re-run.
    if (!options.apply || options.overwrite || !existingName) throw error;
    printSuccess(`Role connection "${existingName}" already holds this trust.`);
    return printResult(existingName, body, account, options);
  }
  printSuccess(`Role connection "${name}" saved. No secret is stored.`);
  printResult(name, body, account, options);
}

/** The name the API says already holds these credentials, if that's the refusal. */
function savedElsewhere(error: unknown): string | undefined {
  if (!(error instanceof ORPCError) || error.code !== 'CREDENTIALS_EXIST')
    return undefined;
  return credentialsExistDataSchema.safeParse(error.data).data?.existingName;
}

function printResult(
  name: string,
  body: RoleConnectionRequest,
  account: string | undefined,
  options: RoleConnectionOptions,
): void {
  if (options.json)
    console.log(JSON.stringify({ name, ...body, ...(account && { account }) }));
}
