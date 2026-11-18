/**
 * `credentials delete --apply`: remove what `credentials new --role --apply`
 * created, through the user's own signed-in cloud CLI. Every read-only check
 * runs first, then the saved connection goes (the API's in-use check refuses
 * before anything in the cloud changes), then the cloud deletes, each
 * treating "already gone" as done. Only what proves to be this connection's,
 * and no other saved one's, is deleted.
 */
import type { RedactedCredential } from '../../shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../shared/cloud.js';
import { resolveApiTarget } from '../../shared/config.js';
import { ROLE_SETUP_PATHS } from '../../shared/role-connection-setup.js';
import { missingRights } from '../seed/accounts.js';
import { ACCOUNT_DENIED_OR_GONE } from '../seed/gcp.js';
import { CloudCliError } from '../seed/types.js';
import { printInfo, printSuccess, setJsonMode } from '../utils/output.js';
import { NOT_RUN_EXIT_CODE, UsageError } from '../utils/lifecycle-result.js';
import { apiClient } from './auth.js';
import {
  awsRoleStackName,
  exitWithRoleApplyError,
  signedInCli,
} from './role-connection-apply.js';

/** Each CLI's "it's already gone". */
const GONE = {
  aws: /does not exist/,
  gcp: /NOT_FOUND|binding with the specified principal, role, and condition not found/,
  azure:
    /ResourceGroupNotFound|DeploymentNotFound|ResourceNotFound|RoleDefinitionDoesNotExist|No matched assignments/,
};

interface RoleTeardown {
  deleted: string[];
  kept: string[];
}

/** The cloud side isn't provably this connection's alone. */
class RoleTeardownMismatchError extends Error {}

type Cli = { run(command: { args: string[] }): Promise<string> };

/**
 * A CLI over `words` (a space-separated command, then its arguments) that
 * resolves to its trimmed stdout, or null when the resource is gone.
 */
function runner(
  cli: Cli,
  gone: RegExp | ((stderr: string) => Promise<boolean>),
  refused: (error: unknown) => never,
  suffix: string[] = [],
) {
  const isGone = (stderr: string) =>
    gone instanceof RegExp ? gone.test(stderr) : gone(stderr);
  return (words: string, ...args: string[]) =>
    cli.run({ args: [...words.split(' '), ...args, ...suffix] }).then(
      (out) => out.trim(),
      async (error: unknown) =>
        error instanceof CloudCliError && (await isGone(error.stderr))
          ? null
          : refused(error),
    );
}

function refuse(what: string): never {
  throw new RoleTeardownMismatchError(
    `${what}, so it may not be this connection's; delete it by hand if it is.`,
  );
}

/**
 * Check, without changing anything, that the cloud side of `saved` is this
 * connection's (signed in, and owned), then return the deletes to run. So
 * every failure that changes nothing comes before the saved connection goes.
 */
async function planRoleTeardown(
  saved: RedactedCredential,
  apiUrl: string,
  profile: string | undefined,
  /** Another saved connection (a role's or a key's) names the GCP account. */
  accountNamedElsewhere = false,
): Promise<() => Promise<RoleTeardown>> {
  const deleted: string[] = [];
  const kept: string[] = [];
  const done = { deleted, kept };
  // cloudtype-boundary-ok: each cloud removes its own setup (RFC 0047).
  switch (saved.cloudProvider) {
    case CloudType.AWS: {
      const { cli, refused } = await signedInCli('aws', { profile }, 'delete');
      const aws = runner(cli, GONE.aws, refused);
      const stack = awsRoleStackName(apiUrl);
      const roleArn = await aws(
        'cloudformation describe-stacks --stack-name',
        stack,
        '--query',
        "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue",
        '--output=text',
      );
      if (roleArn === null) return async () => done;
      if (roleArn !== saved.roleArn)
        refuse(`Stack ${stack} holds ${roleArn}, not ${saved.roleArn}`);
      return async () => {
        await aws('cloudformation delete-stack --stack-name', stack);
        await aws(
          'cloudformation wait stack-delete-complete --stack-name',
          stack,
        );
        deleted.push(`CloudFormation stack ${stack}`);
        return done;
      };
    }
    // cloudtype-boundary-ok: each cloud removes its own setup (RFC 0047).
    case CloudType.GCP: {
      const [, pool = '', provider = ''] =
        /^projects\/[^/]+\/locations\/global\/workloadIdentityPools\/([^/]+)\/providers\/([^/]+)$/.exec(
          saved.workloadIdentityProvider ?? '',
        ) ?? [];
      const email = saved.serviceAccountEmail ?? '';
      const project =
        /@([^.]+)\.iam\.gserviceaccount\.com$/.exec(email)?.[1] ??
        refuse('This connection names no provider and service account');
      if (!pool) refuse('This connection names no workload identity pool');
      const { cli, refused, account } = await signedInCli(
        'gcp',
        { projectId: project },
        'delete',
      );
      // IAM answers a deleted service account with "permission denied (or it
      // may not exist)": gone, once Resource Manager says the caller holds
      // the rights, else a real refusal.
      let rightsHeld: Promise<boolean> | undefined;
      const gone = async (stderr: string) => {
        if (GONE.gcp.test(stderr)) return true;
        if (!ACCOUNT_DENIED_OR_GONE.test(stderr)) return false;
        rightsHeld ??= missingRights('gcp', cli, account, [
          'iam.serviceAccounts.get',
          'iam.serviceAccounts.delete',
        ]).then((missing) => missing?.length === 0);
        rightsHeld.catch(() => (rightsHeld = undefined));
        return rightsHeld;
      };
      const gcloud = runner(cli, gone, refused, [
        `--project=${project}`,
        '--quiet',
      ]);
      const inPool = ['--workload-identity-pool', pool, '--location=global'];
      // This API's trust, as its setup script pins it.
      // cloudtype-boundary-ok: the GCP setup template.
      const response = await fetch(
        `${apiUrl}${ROLE_SETUP_PATHS[CloudType.GCP]}`,
      );
      if (!response.ok)
        throw new Error(
          `The API could not serve the GCP setup template (HTTP ${response.status}).`,
        );
      const script = await response.text();
      const issuer = /--issuer-uri='([^']+)'/.exec(script)?.[1];
      const condition = /--attribute-condition="([^"]+)"/.exec(script)?.[1];
      // A deleted provider or pool stays readable as DELETED: that's done.
      const live = await gcloud(
        'iam workload-identity-pools providers describe',
        provider,
        ...inPool,
        '--format=value(state,oidc.issuerUri,attributeCondition)',
      );
      const providerLive = live !== null && !live.startsWith('DELETED');
      if (providerLive) {
        const [, liveIssuer, liveCondition] = live.split('\t');
        if (!issuer || liveIssuer !== issuer || liveCondition !== condition)
          refuse(`Provider ${provider} trusts another issuer or subject`);
      }
      const poolState = await gcloud(
        'iam workload-identity-pools describe',
        pool,
        '--location=global',
        '--format=value(state)',
      );
      // The setup script gives its service account this name.
      const displayName = await gcloud(
        'iam service-accounts describe',
        email,
        '--format=value(displayName)',
      );
      if (displayName !== null && displayName !== 'Anycloud role connection')
        refuse(`Service account ${email} isn't the setup's`);
      // The pool goes only once it holds no other provider.
      const poolLive = poolState !== null && poolState !== 'DELETED';
      const otherProviders = poolLive
        ? (
            (await gcloud(
              'iam workload-identity-pools providers list',
              ...inPool,
              '--format=value(name)',
            )) ?? ''
          )
            .split('\n')
            .filter((name) => name && name !== saved.workloadIdentityProvider)
        : [];
      // The account goes only when no other pool's principal may use it: the
      // script reuses one account for every pool in the project.
      const poolName = saved.workloadIdentityProvider!.replace(
        /\/providers\/[^/]+$/,
        '',
      );
      const users =
        displayName === null
          ? []
          : (
              (await gcloud(
                'iam service-accounts get-iam-policy',
                email,
                '--flatten=bindings[].members',
                '--filter=bindings.role:roles/iam.workloadIdentityUser',
                '--format=value(bindings.members)',
              )) ?? ''
            )
              .split('\n')
              .filter(Boolean);
      const ours = `principal://iam.googleapis.com/${poolName}/`;
      const accountShared =
        accountNamedElsewhere ||
        users.some((member) => !member.startsWith(ours));
      const roles =
        displayName === null || accountShared
          ? []
          : (
              (await gcloud(
                'projects get-iam-policy',
                project,
                '--flatten=bindings[].members',
                `--filter=bindings.members:serviceAccount:${email}`,
                '--format=value(bindings.role)',
              )) ?? ''
            )
              .split('\n')
              .filter(Boolean);
      return async () => {
        if (providerLive) {
          await gcloud(
            'iam workload-identity-pools providers delete',
            provider,
            ...inPool,
          );
          deleted.push(`workload identity provider ${provider}`);
        }
        if (poolLive && otherProviders.length > 0)
          kept.push(`workload identity pool ${pool}: it holds other providers`);
        else if (poolLive) {
          await gcloud(
            'iam workload-identity-pools delete',
            pool,
            '--location=global',
          );
          deleted.push(`workload identity pool ${pool}`);
        }
        if (accountShared) {
          // Kept, but no longer usable through this connection's pool.
          for (const member of users.filter((user) => user.startsWith(ours)))
            await gcloud(
              'iam service-accounts remove-iam-policy-binding',
              email,
              `--member=${member}`,
              '--role=roles/iam.workloadIdentityUser',
            );
          kept.push(
            `service account ${email}: another connection or pool may use it`,
          );
        } else if (displayName !== null) {
          for (const role of roles) {
            await gcloud(
              'projects remove-iam-policy-binding',
              project,
              `--member=serviceAccount:${email}`,
              `--role=${role}`,
              '--all',
            );
            if (role.startsWith(`projects/${project}/roles/`))
              kept.push(`custom role ${role}: a key connection may use it too`);
          }
          await gcloud('iam service-accounts delete', email);
          deleted.push(`service account ${email}`);
        }
        // GCP soft-deletes them; RFC 0047 amendment 11 keeps them deleted.
        if (
          deleted.some((resource) => resource.startsWith('workload identity'))
        )
          kept.push(
            `the IDs ${pool} and ${provider}: GCP keeps them for 30 days, so a new --apply needs ANYCLOUD_ROLE_POOL and ANYCLOUD_ROLE_PROVIDER set to new IDs until then`,
          );
        return done;
      };
    }
    // cloudtype-boundary-ok: each cloud removes its own setup (RFC 0047).
    case CloudType.Azure: {
      const subscription = saved.subscriptionId ?? '';
      const { cli, refused } = await signedInCli(
        'azure',
        { subscriptionId: subscription },
        'delete',
      );
      const az = runner(cli, GONE.azure, refused, [
        '--subscription',
        subscription,
      ]);
      const tsv = (words: string, query: string, ...args: string[]) =>
        az(words, ...args, '--query', query, '--output=tsv');
      // The identity proves the group's; the deployment may be pruned.
      const clientId = await tsv(
        'identity show --resource-group anycloud-role --name anycloud-role',
        'clientId',
      );
      if (clientId !== null && clientId !== saved.applicationId)
        refuse(
          `Identity anycloud-role is ${clientId}, not ${saved.applicationId}`,
        );
      const made = await tsv(
        'deployment sub show --name anycloud-role',
        'properties.outputs.applicationId.value',
      );
      if (made !== null && made !== saved.applicationId)
        refuse(
          `Deployment anycloud-role made ${made}, not ${saved.applicationId}`,
        );
      const scope = `/subscriptions/${subscription}`;
      const role = `Anycloud role connection ${subscription}`;
      // az exits 0 when a delete matches nothing, so list first.
      const assigned =
        clientId !== null &&
        !!(await tsv(
          'role assignment list --assignee',
          '[].id',
          clientId,
          '--scope',
          scope,
        ));
      const defined = !!(await tsv(
        'role definition list --name',
        '[].id',
        role,
        '--scope',
        scope,
      ));
      return async () => {
        if (assigned) {
          await az(
            'role assignment delete --assignee',
            clientId!,
            '--scope',
            scope,
          );
          deleted.push('role assignment');
        }
        if (
          clientId !== null &&
          (await az('group delete --name anycloud-role --yes')) !== null
        )
          deleted.push('resource group anycloud-role');
        // Every role connection in the subscription shares the definition:
        // it goes only once no other assignment uses it.
        const othersAssigned =
          defined &&
          !!(await tsv(
            'role assignment list --role',
            '[].id',
            role,
            '--scope',
            scope,
          ));
        if (othersAssigned)
          kept.push(`role definition ${role}: another role connection uses it`);
        else if (defined) {
          await az('role definition delete --name', role, '--scope', scope);
          deleted.push('role definition');
        }
        if (
          made !== null &&
          (await az('deployment sub delete --name anycloud-role')) !== null
        )
          deleted.push('deployment anycloud-role');
        return done;
      };
    }
    // cloudtype-boundary-ok: no role connection exists for these clouds.
    case CloudType.Lambda:
    case CloudType.Cloudflare:
      return refuse(`${saved.cloudProvider} has no role connections`);
  }
}

/** The cloud identifier a role connection is bound to. */
function boundTo(credential: RedactedCredential): string | undefined {
  if ('roleArn' in credential && credential.roleArn) return credential.roleArn;
  if ('workloadIdentityProvider' in credential)
    return credential.workloadIdentityProvider;
  if ('applicationId' in credential) return credential.applicationId;
  return undefined;
}

export interface DeleteOptions {
  force?: boolean;
  apply?: boolean;
  profile?: string;
  json?: boolean;
}

class CredentialNotFoundError extends Error {}

/**
 * `credentials delete <name> --apply`: the saved connection (refused while
 * workloads use it, unless --force), then its cloud side.
 */
export async function deleteRoleConnection(
  name: string | undefined,
  options: DeleteOptions,
): Promise<void> {
  try {
    if (options.json) setJsonMode(true);
    if (!name)
      throw new UsageError(
        'Pass the name: anycloud credentials delete <name> --apply.',
      );
    const client = await apiClient({ missingExitCode: NOT_RUN_EXIT_CODE });
    const all = await client.credentials.list();
    const saved = all.find((credential) => credential.name === name);
    if (!saved)
      throw new CredentialNotFoundError(`Credential "${name}" not found.`);
    if (!('kind' in saved) || saved.kind !== 'role')
      throw new UsageError(
        `"${name}" saves a key; --apply deletes role connections only.`,
      );
    // cloudtype-boundary-ok: --profile is the AWS account selector.
    if (options.profile && saved.cloudProvider !== CloudType.AWS)
      throw new UsageError('--profile selects an AWS account only.');
    const others = all.filter((other) => other.name !== name);
    const shared = others.find(
      (other) =>
        boundTo(other) !== undefined && boundTo(other) === boundTo(saved),
    );
    if (shared)
      refuse(`Role connection "${shared.name}" uses the same cloud side`);
    // A role's or a key's GCP account, kept for whoever else names it.
    const account = (credential: RedactedCredential) =>
      'serviceAccountEmail' in credential && credential.serviceAccountEmail
        ? credential.serviceAccountEmail
        : 'clientEmail' in credential
          ? credential.clientEmail
          : undefined;
    // Every check that changes nothing, then the saved connection (the API
    // refuses while workloads use it), then the cloud side.
    const teardown = await planRoleTeardown(
      saved,
      resolveApiTarget().url,
      options.profile,
      others.some(
        (other) =>
          account(other) !== undefined && account(other) === account(saved),
      ),
    );
    await client.credentials.delete({
      params: { name },
      query: { force: options.force === true ? 'true' : 'false' },
    });
    printInfo(
      `Deleted role connection "${name}"; now its ${saved.cloudProvider} side, which can take a few minutes...`,
    );
    const result = await teardown().catch((error: unknown) => {
      if (error instanceof Error)
        error.message = `The connection is deleted, but its ${saved.cloudProvider} side isn't; finish with the cloud's CLI (https://anycloud.sh/reference/cli/credentials#role-apply): ${error.message}`;
      throw error;
    });
    for (const resource of result.deleted) printInfo(`Deleted ${resource}`);
    for (const note of result.kept) printInfo(`Kept ${note}`);
    printSuccess(`Role connection "${name}" and its cloud side deleted.`);
    if (options.json) console.log(JSON.stringify({ name, ...result }));
  } catch (error) {
    exitWithRoleApplyError(
      'Failed to delete credential',
      error,
      options.json,
      (error) =>
        error instanceof CredentialNotFoundError
          ? 'CREDENTIAL_NOT_FOUND'
          : error instanceof RoleTeardownMismatchError
            ? 'ROLE_TEARDOWN_REFUSED'
            : undefined,
    );
  }
}
