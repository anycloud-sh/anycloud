/**
 * Who the user's cloud CLI is signed in as, and whether it may create an
 * installation, asked through the CLI itself (RFC 0049 C26 (e)). The seeds
 * (lanes S2 to S4) call these from `discoverAccount` and `checkRights`.
 */

import { CommandNotFoundError } from '../services/slurp/cli-exec.js';
import {
  CloudCliError,
  SeedUnavailableError,
  type CloudCli,
  type SeedAccount,
  type SeedCloud,
} from './types.js';

/** The executable each cloud's seed drives. */
export const SEED_EXECUTABLES: Record<SeedCloud, string> = {
  aws: 'aws',
  gcp: 'gcloud',
  azure: 'az',
};

const SIGN_IN: Record<SeedCloud, string> = {
  aws: 'sign in with aws configure or aws sso login, or set AWS_PROFILE',
  gcp: 'sign in with gcloud auth login and set a project with gcloud config set project <id>',
  azure: 'sign in with az login',
};

/**
 * What creating an installation needs, per cloud: its template or calls,
 * the management VM and its network, its own identity scoped to the bucket
 * and to deleting the installation, and the bucket. `api create` checks
 * them before anything is bought; docs/reference/cli/api-utilities.md lists them.
 */
export const SEED_RIGHTS: Record<SeedCloud, readonly string[]> = {
  aws: [
    'cloudformation:DescribeStacks',
    'cloudformation:DeleteStack',
    'cloudformation:CreateChangeSet',
    'cloudformation:ExecuteChangeSet',
    'cloudformation:DescribeChangeSet',
    'ec2:RunInstances',
    'ec2:DescribeInstances',
    'ec2:TerminateInstances',
    'ec2:CreateSecurityGroup',
    'ec2:AuthorizeSecurityGroupIngress',
    'ec2:DeleteSecurityGroup',
    'ec2:CreateTags',
    'iam:CreateRole',
    'iam:PutRolePolicy',
    'iam:DeleteRolePolicy',
    'iam:DeleteRole',
    'iam:CreateInstanceProfile',
    'iam:AddRoleToInstanceProfile',
    'iam:RemoveRoleFromInstanceProfile',
    'iam:DeleteInstanceProfile',
    // The VM's role and the stack's anycloud-<id>-cfn service role.
    'iam:PassRole',
    'iam:TagRole',
    's3:CreateBucket',
    's3:PutBucketVersioning',
    's3:PutBucketTagging',
    'iam:SimulatePrincipalPolicy',
    'cloudformation:DescribeStackEvents',
    'cloudformation:GetTemplateSummary',
    'ssm:GetParameters',
    'ec2:DescribeSecurityGroups',
    'ec2:RevokeSecurityGroupIngress',
    'iam:GetRole',
    'iam:GetRolePolicy',
    'iam:GetInstanceProfile',
    's3:PutBucketPublicAccessBlock',
    's3:ListBucket',
    's3:GetObject',
    // The dead-API delete and --delete-buckets.
    's3:ListBucketVersions',
    's3:DeleteObjectVersion',
    's3:DeleteBucket',
    'ec2:DescribeSecurityGroupRules',
    'ec2:DescribeInstanceAttribute',
    'ec2:DescribeNetworkInterfaces',
    'ec2:DescribeVolumes',
    'iam:ListInstanceProfilesForRole',
    'iam:ListRolePolicies',
    'iam:ListAttachedRolePolicies',
    'tag:GetResources',
  ],
  gcp: [
    'compute.disks.create',
    'compute.firewalls.create',
    'compute.firewalls.delete',
    'compute.firewalls.get',
    'compute.firewalls.update',
    'compute.globalOperations.get',
    'compute.instances.create',
    'compute.instances.delete',
    'compute.instances.get',
    'compute.instances.list',
    'compute.instances.setLabels',
    'compute.instances.setMetadata',
    'compute.instances.setServiceAccount',
    'compute.instances.setTags',
    'compute.networks.get',
    'compute.networks.updatePolicy',
    'compute.subnetworks.use',
    'compute.subnetworks.useExternalIp',
    'compute.zoneOperations.get',
    'iam.serviceAccounts.actAs',
    'iam.serviceAccounts.create',
    'iam.serviceAccounts.delete',
    'iam.serviceAccounts.get',
    'iam.serviceAccounts.list',
    'resourcemanager.projects.getIamPolicy',
    'resourcemanager.projects.setIamPolicy',
    'storage.buckets.create',
    'storage.buckets.delete',
    'storage.buckets.get',
    'storage.buckets.getIamPolicy',
    'storage.buckets.list',
    'storage.buckets.setIamPolicy',
    'storage.buckets.update',
    'storage.objects.delete',
    'storage.objects.get',
    'storage.objects.list',
  ],
  azure: [
    'Microsoft.Resources/subscriptions/resourceGroups/write',
    'Microsoft.Resources/subscriptions/resourceGroups/delete',
    'Microsoft.Resources/deployments/write',
    'Microsoft.Resources/deployments/read',
    'Microsoft.Compute/virtualMachines/write',
    'Microsoft.Network/virtualNetworks/write',
    'Microsoft.Network/networkSecurityGroups/write',
    'Microsoft.Network/publicIPAddresses/write',
    'Microsoft.Network/networkInterfaces/write',
    'Microsoft.ManagedIdentity/userAssignedIdentities/write',
    'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
    'Microsoft.Authorization/roleAssignments/write',
    // The dead-API delete removes the grant too.
    'Microsoft.Authorization/roleAssignments/delete',
    'Microsoft.Storage/storageAccounts/write',
    'Microsoft.Network/virtualNetworks/subnets/join/action',
    'Microsoft.Network/networkSecurityGroups/join/action',
    'Microsoft.Network/publicIPAddresses/join/action',
    'Microsoft.Network/networkInterfaces/join/action',
    'Microsoft.Storage/storageAccounts/listKeys/action',
    'Microsoft.Storage/storageAccounts/blobServices/write',
    'Microsoft.Storage/storageAccounts/blobServices/containers/write',
  ],
};

/**
 * GCP Resource Manager's base URL; `GCP_RESOURCE_MANAGER_ENDPOINT` points it
 * elsewhere (a test's fake), as the API's RFC 0034 overrides do
 * (src/api/services/cloud-endpoints.ts).
 */
function resourceManagerEndpoint(): string {
  return (
    process.env.GCP_RESOURCE_MANAGER_ENDPOINT?.replace(/\/+$/, '') ||
    'https://cloudresourcemanager.googleapis.com'
  );
}

function parse<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${what} returned no JSON`);
  }
}

/** The account and caller the user's cloud CLI is signed in as. */
export async function discoverAccount(
  cloud: SeedCloud,
  cli: CloudCli,
): Promise<SeedAccount> {
  try {
    switch (cloud) {
      case 'aws': {
        const identity = parse<{ Account?: string; Arn?: string }>(
          await cli.run({
            args: ['sts', 'get-caller-identity', '--output', 'json'],
          }),
          'aws sts get-caller-identity',
        );
        if (!identity.Account || !identity.Arn) {
          throw new Error('STS named no account for the caller');
        }
        return { account: identity.Account, principal: identity.Arn };
      }
      case 'gcp': {
        const project = (
          await cli.run({ args: ['config', 'get', 'project'] })
        ).trim();
        if (!project) {
          throw new Error('no project is set');
        }
        // Fails here, not mid-create, when the sign-in has lapsed.
        await cli.run({ args: ['auth', 'print-access-token'] });
        const principal = (
          await cli.run({ args: ['config', 'get', 'account'] })
        ).trim();
        return { account: project, principal: principal || 'gcloud' };
      }
      case 'azure': {
        const account = parse<{
          id?: string;
          tenantId?: string;
          user?: { name?: string };
        }>(
          await cli.run({ args: ['account', 'show', '--output', 'json'] }),
          'az account show',
        );
        if (!account.id) throw new Error('no subscription is selected');
        return {
          account: account.id,
          principal: account.user?.name ?? 'az',
          ...(account.tenantId ? { directory: account.tenantId } : {}),
        };
      }
    }
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      throw new SeedUnavailableError(
        `${error.message}; install it, then ${SIGN_IN[cloud]}`,
      );
    }
    const reason =
      error instanceof CloudCliError
        ? error.stderr.trim() || error.message
        : (error as Error).message;
    throw new SeedUnavailableError(
      `${SEED_EXECUTABLES[cloud]} isn't signed in (${reason}); ${SIGN_IN[cloud]}`,
    );
  }
}

/**
 * Which of `rights` the caller lacks; null when the cloud can't say for this
 * caller (the AWS root, a federated user).
 */
export async function missingRights(
  cloud: SeedCloud,
  cli: CloudCli,
  account: SeedAccount,
  rights: readonly string[] = SEED_RIGHTS[cloud],
): Promise<string[] | null> {
  try {
    return await askRights(cloud, cli, account, rights);
  } catch (error) {
    // The caller may not ask (iam:SimulatePrincipalPolicy, iam:GetRole or
    // the permissions read denied): the cloud can't say, and create goes on.
    if (error instanceof CloudCliError) return null;
    throw error;
  }
}

async function askRights(
  cloud: SeedCloud,
  cli: CloudCli,
  account: SeedAccount,
  rights: readonly string[],
): Promise<string[] | null> {
  switch (cloud) {
    case 'aws': {
      const source = await awsPolicySource(cli, account.principal);
      if (!source) return null;
      const { EvaluationResults: results = [] } = parse<{
        EvaluationResults?: Array<{
          EvalActionName?: string;
          EvalDecision?: string;
        }>;
      }>(
        await cli.run({
          args: [
            'iam',
            'simulate-principal-policy',
            '--policy-source-arn',
            source,
            '--action-names',
            ...rights,
            '--output',
            'json',
          ],
        }),
        'aws iam simulate-principal-policy',
      );
      const allowed = new Set(
        results
          .filter((result) => result.EvalDecision === 'allowed')
          .map((result) => result.EvalActionName),
      );
      return rights.filter((right) => !allowed.has(right));
    }
    case 'gcp': {
      // gcloud has no test-iam-permissions for a project: Resource Manager's
      // REST call with the CLI's own token.
      const token = (
        await cli.run({ args: ['auth', 'print-access-token'] })
      ).trim();
      // A refusal or no answer means GCP can't say, like a CLI error.
      const response = await fetch(
        `${resourceManagerEndpoint()}/v1/projects/${encodeURIComponent(account.account)}:testIamPermissions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ permissions: rights }),
          signal: AbortSignal.timeout(30_000),
        },
      ).catch(() => null);
      if (!response?.ok) return null;
      const { permissions = [] } = (await response.json()) as {
        permissions?: string[];
      };
      const granted = new Set(permissions);
      return rights.filter((right) => !granted.has(right));
    }
    case 'azure': {
      const { value = [] } = parse<{
        value?: Array<{ actions?: string[]; notActions?: string[] }>;
      }>(
        await cli.run({
          args: [
            'rest',
            '--method',
            'get',
            '--url',
            `https://management.azure.com/subscriptions/${account.account}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`,
            '--output',
            'json',
          ],
        }),
        'az rest permissions',
      );
      return rights.filter((right) => !azureGrants(value, right));
    }
  }
}

/**
 * The IAM user or role whose policies govern the caller. An assumed role's
 * ARN names the role without its path, so IAM is asked for the role's own.
 * The account root and federated users can't be simulated: null.
 */
async function awsPolicySource(
  cli: CloudCli,
  principal: string,
): Promise<string | null> {
  const assumed = /^arn:[^:]+:sts::\d+:assumed-role\/([^/]+)\//.exec(principal);
  if (assumed) {
    return (
      await cli.run({
        args: [
          'iam',
          'get-role',
          '--role-name',
          assumed[1]!,
          '--query',
          'Role.Arn',
          '--output',
          'text',
        ],
      })
    ).trim();
  }
  return /^arn:[^:]+:iam::\d+:user\//.test(principal) ? principal : null;
}

/** Whether a role's actions grant one action: a wildcard match that no notAction removes. */
export function azureGrants(
  permissions: ReadonlyArray<{ actions?: string[]; notActions?: string[] }>,
  action: string,
): boolean {
  const matches = (pattern: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
        .join('.*')}$`,
      'i',
    ).test(action);
  return permissions.some(
    (permission) =>
      (permission.actions ?? []).some(matches) &&
      !(permission.notActions ?? []).some(matches),
  );
}
