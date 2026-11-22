---
title: credentials
description: Exact syntax and provider fields for creating and managing saved cloud credentials.
---

import CodeBlock from '@theme/CodeBlock';
import anycloudAccess from '../../../src/shared/cloud-policies/aws-anycloud-access.json';
import azureRole from '../../../src/shared/cloud-policies/azure-anycloud-role.json';
import gcpRole from '../../../src/shared/cloud-policies/gcp-anycloud-role.json';

# `anycloud credentials`

Manage named provider credentials. Alias: `anycloud creds`.

```bash
anycloud credentials new [name] [provider options]
anycloud credentials list [--json]
anycloud credentials edit <name> [provider options]
anycloud credentials delete [name] [--force] [--apply [--profile NAME] [--json]]
```

| Option                                                    | Applies to   | Description                                                                            |
| --------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `--provider aws\|azure\|gcp\|lambda\|cloudflare`          | `new`        | Select the provider without the interactive picker                                     |
| `--profile NAME`                                          | `new`        | AWS profile to import, or authenticated operator profile with `--generate`             |
| `--account-id ID`                                         | `new`        | Required target AWS account with `--generate`, or the Cloudflare account ID            |
| `--generate`                                              | `new`        | Explicitly create AWS, Azure, or GCP credentials using an authenticated provider CLI   |
| `--gcloud-account EMAIL`                                  | `new`        | Select the cached gcloud operator account for GCP generation                           |
| `--overwrite`                                             | `new`        | Replace an existing credential with the same name                                      |
| `--role`                                                  | `new`        | Save an AWS, GCP or Azure [role connection](#role-connections) instead of a key        |
| `--role-arn ARN`                                          | `new`        | AWS role ARN for `--role`                                                              |
| `--workload-identity-provider`, `--service-account-email` | `new`        | GCP identifiers for `--role`                                                           |
| `--access-key-id`, `--secret-access-key`                  | `new`,`edit` | Set AWS fields                                                                         |
| `--application-id`, `--secret`                            | `new`,`edit` | Set Azure application fields                                                           |
| `--subscription-id`, `--directory-id`                     | `new`,`edit` | Set Azure account fields                                                               |
| `--project-id`, `--client-email`                          | `new`,`edit` | Set GCP service-account fields                                                         |
| `--private-key`                                           | `new`,`edit` | Set the GCP service-account private key                                                |
| `--key-file PATH`                                         | `edit`       | Read replacement GCP service-account fields from a JSON key file                       |
| `--api-key`                                               | `new`,`edit` | Set a Lambda Labs key                                                                  |
| `--api-token`, `--jurisdiction`                           | `new`,`edit` | Set the Cloudflare API token and R2 jurisdiction (`default`, `eu` or `fedramp`)        |
| `--json`                                                  | `list`       | `[{name, cloudProvider, kind, health, invalidSince?}]`; never includes secret values   |
| `--json`                                                  | `new --role` | Print the saved [role connection](#role-connections) as JSON; never prompts            |
| `--apply`                                                 | `new --role` | Create the role through this machine's signed-in `aws`, `gcloud` or `az`, then save it |
| `-f, --force`                                             | `delete`     | Delete even when a non-terminal workload references the credential                     |
| `--apply`                                                 | `delete`     | Also delete what [`new --role --apply`](#role-apply) created, through the cloud's CLI  |

Each saved credential has one name. Saving credentials that are already saved
under another name fails with `CREDENTIALS_EXIST` and names the saved
credential, even with `--overwrite`: use that name, or delete it first. Saving
the same credentials again under their own name changes nothing.

With missing provider arguments in a terminal, `new` opens a wizard. Provider
flows can import local credentials, accept pasted values, or generate AWS,
Azure, and GCP credentials.

Wizard imports ask you to choose a source whenever local or environment
credentials are available, even if only one source was detected. Complete
environment credentials are highlighted first. Manual entry asks for fresh
values; GCP asks for a service-account JSON file.

Before saving, the wizard shows the source and available account identifiers,
then asks `Save these <provider> credentials as "<name>"?`. The default is
**Yes**. Declining or pressing Ctrl-C at that prompt saves nothing. Secrets
stay hidden.
AWS authenticates the account and identity through STS. GCP and Azure reviews
show identifiers supplied in the credentials. Lambda reviews show the
provider, source, and credential name.

Explicit complete credential flags, AWS `--profile`, and non-interactive
imports do not add a source picker or save confirmation. Existing AWS and
Azure partial-field completion still uses flags and environment fallbacks,
then asks for confirmation when interactive.

Choosing generation in the wizard previews the target and grants, then asks
for confirmation. Passing `--generate` authorizes creation without another
confirmation prompt, even in a terminal.

Generation uses an authenticated provider CLI. Reuse a working login or sign in
first. `--generate` cannot be combined with credential-material flags or
`--overwrite`. Anycloud never installs provider CLIs. When one is missing, the
wizard prints a per-user install command that needs no `sudo` and still offers
the other choices.

The AWS, Azure, and GCP pickers end with an option for people who have neither
credentials nor permission to create them, such as **I don't have AWS access
keys**. It prints a request to forward to your cloud administrator and saves
nothing; see [Ask an administrator](#ask-an-administrator).

Secret provider fields accept their documented environment fallbacks; an
explicit CLI flag wins when creating credentials. `edit` uses explicit flags
only.

`edit` requires an existing name and updates only the provider fields supplied
as flags; it does not open a wizard or change the provider. The API merges those
fields into the stored credential, so saved secrets never leave it. A flag for
another provider's field fails and leaves the credential unchanged. `delete` without a
name opens a picker in a terminal. Deletion is blocked while a non-terminal
workload references the credential unless `--force` is supplied.

## Non-interactive provider fields

### AWS

```bash
# Enter existing keys
anycloud credentials new production-aws \
  --provider aws \
  --access-key-id AKIA... \
  --secret-access-key ...

# Import durable keys from a named AWS profile
anycloud credentials new production-aws \
  --provider aws \
  --profile production

# Generate a new IAM user/key through an authenticated AWS operator
anycloud credentials new production-aws \
  --provider aws --generate \
  --profile operator --account-id 123456789012
```

Importable profiles must contain a durable access-key ID and secret in the
shared credentials or config file. When credentials are detected, the wizard
asks you to choose a source, even when only one profile is available. It offers
durable profiles, complete durable environment keys, and manual entry.
Environment keys are highlighted first; otherwise the current or default
profile is highlighted.
`AWS_PROFILE` sets a default selection without authorizing an import. Manual
entry from this picker asks for fresh keys instead of reusing environment
values. SSO, role, web-identity, credential-process, and session-token profiles
cannot be imported because their credentials rotate or expire; the API also
refuses to save an AWS credential with a session token.

Before saving imported, pasted, or environment-provided AWS keys, Anycloud
calls STS with those exact keys. This proves their identity, not broad EC2, S3,
IAM, quota, or organization-policy access.

Anycloud attaches no IAM role to the VMs it launches. Everything an imported
key needs is in the [`AnycloudAccess` policy](#aws-permissions). A key that may
use EC2 in only some regions runs Jobs in those regions (see
[Cloud Credentials](/platform/cloud-credentials)).

Wizard imports show the source, authenticated account ID, and identity ARN,
then ask for confirmation before saving. The default is **Yes**; declining or
pressing Ctrl-C saves nothing. Partial key flags also receive this confirmation
after their missing fields are completed. Explicit `--profile`, both access-key
flags together, and non-interactive commands authorize the import without a
confirmation prompt.

Generation uses the selected operator profile and requires both `--profile`
and `--account-id`; an account mismatch fails before creation. A working
profile needs no new sign-in. To authenticate through the browser, run
`aws login --profile operator` with AWS CLI 2.32.0 or newer. Static keys in
that profile can shadow the login session. Anycloud does not launch AWS
sign-in for you.

When the AWS CLI is installed, the source picker also offers **Create an IAM
user with AWS CLI**, including when existing credentials are available. Without
it, the wizard prints the official per-user installer, even when profiles or
environment keys are available:
`curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash`, or
`irm https://awscli.amazonaws.com/v2/install.ps1 | iex` on Windows. The picker
still offers detected credentials, manual entry, and the administrator request.
Failed imports never trigger generation automatically. Choosing generation
lists every profile in `~/.aws/config` and `~/.aws/credentials`, including SSO
profiles, as the operator; the current profile is highlighted.

The new IAM user, `anycloud-<credential-name>`, receives one inline policy,
[`AnycloudAccess`](#aws-permissions), and nothing else. The operator needs the
[operator permissions](#aws-operator-permissions) listed below.

For a comparison of the AWS paths, see
[Ways to add AWS credentials](/platform/cloud-credentials#aws-credential-sources).

Generation names use 1–55 letters, digits, or `_+=,.@-` characters. Generation
cannot overwrite an existing credential or IAM user.

### Azure

```bash
# Azure service principal
anycloud credentials new production-azure \
  --provider azure \
  --application-id ... \
  --secret ... \
  --subscription-id ... \
  --directory-id ...

# Create an Azure service principal through an authenticated Azure CLI
anycloud credentials new production-azure \
  --provider azure \
  --generate
```

Azure CLI user sessions cannot reveal an existing service-principal secret.
The wizard offers complete environment credentials, **Enter existing service
principal credentials**, and **Create a service principal with Azure CLI**.
Environment values never bypass this choice. Before saving an import, review
the tenant, subscription, and application ID. Without the Azure CLI, choosing
creation prints an install hint: `brew install azure-cli` on macOS,
`winget install --exact --id Microsoft.AzureCLI` on Windows, and Microsoft's
Linux install page, whose packages need administrator rights. For explicit
generation, authenticate with `az login` if needed; use `--subscription-id` to
select a subscription or reuse the Azure CLI's current subscription.

The preview identifies the tenant, subscription, scope, and grants. Generation
creates an application, service principal, client secret, and one
subscription-scoped Contributor assignment. Azure VMs get no managed identity,
so generation assigns no role-administration role. Controller Blob operations use a current account key fetched
through `listKeys`; the controller does not receive a subscription-wide Blob
data role. An imported service principal needs only the
[Anycloud role](#azure-permissions) on its subscription.

### GCP

```bash
# GCP service account
anycloud credentials new production-gcp \
  --provider gcp \
  --project-id my-project \
  --client-email service-account@my-project.iam.gserviceaccount.com \
  --private-key "..."

# Generate a service account/key through an authenticated gcloud operator
anycloud credentials new production-gcp \
  --provider gcp --generate \
  --gcloud-account operator@example.com --project-id my-project
```

Import accepts service-account fields or a key JSON file discovered through
`GOOGLE_APPLICATION_CREDENTIALS`, the conventional Application Default
Credentials (ADC) path, or `~/.anycloud`. A gcloud user login or user ADC cannot
be imported and never triggers generation automatically.

The wizard also offers complete `GCP_PROJECT_ID`, `GCP_CLIENT_EMAIL`, and
`GCP_PRIVATE_KEY` environment credentials. File selection and generation stay
available alongside detected credentials. Review the project and service-account
email before approving an import. An uploaded key is copied to the Anycloud
directory only after approval, using the same contents that were reviewed.

Generation uses the selected cached gcloud account. Without gcloud, generation
prints Google's per-user installer, `curl https://sdk.cloud.google.com | bash`,
or its Windows installer page. Run `gcloud auth login` if needed, then choose
**Create a service account with gcloud** in the wizard or pass `--generate`
with both `--gcloud-account` and `--project-id`.

Enable the IAM, Cloud Resource Manager, Compute Engine, Cloud Storage, and
Security Token Service APIs
beforehand. The operator needs permission to inspect the project and service
accounts, create service accounts and keys, update the project IAM policy, and
delete the created resources for cleanup.

The new service account, `anycloud-<credential-name>`, receives project roles
`roles/compute.instanceAdmin.v1`, `roles/compute.securityAdmin`, and
`roles/storage.admin`. Anycloud attaches no service account to its VMs, so it
needs no grant on the default Compute service account. An administrator can
grant the narrower [`Anycloud` role](#gcp-permissions) instead.

Generation names use 1–21 lowercase letters, digits, or hyphens, ending in a
letter or digit. Generation cannot overwrite an existing credential or service
account.

### Lambda

When `LAMBDA_API_KEY` is set, choose whether to use it or enter
a fresh key. Without an environment key, the wizard prompts directly for
masked entry. Both paths ask for confirmation before saving.

```bash
anycloud credentials new production-lambda \
  --provider lambda \
  --api-key ...
```

### Cloudflare

Cloudflare credentials hold R2 storage only: [`bucket`](/reference/cli/bucket)
commands use them, and every compute command refuses them. They are never
picked automatically. Pass `--provider cloudflare`;
the token is not detected from `CLOUDFLARE_API_TOKEN` alone. The token needs
account-level R2 read and write. Before saving, `new` checks with Cloudflare
that the token is active.

```bash
anycloud credentials new r2 \
  --provider cloudflare \
  --account-id ... \
  --api-token ...
```

With `--provider cloudflare`, missing flags fall back to
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

### Role connections {#role-connections}

On a self-hosted API, `--role` connects a role on AWS, GCP or Azure instead of
saving a key ([Role connections](/platform/cloud-credentials#role-connections)).
`new` first prints how to create the cloud side from the template the API
serves for its own issuer, then saves only the identifiers that setup prints.
A local API serves no template, and `new` refuses there.

| Cloud | Setup                                                              | Identifiers to save                                                 |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| AWS   | Three printed commands in AWS CloudShell (one stack per API)       | `--role-arn` (the stack's `RoleArn` output)                         |
| GCP   | `curl -fsSL <api>/role-setup/gcp.sh \| bash` in Google Cloud Shell | `--workload-identity-provider`, `--service-account-email`           |
| Azure | A Deploy to Azure link                                             | `--application-id`, `--directory-id`, `--subscription-id` (outputs) |

```bash
anycloud credentials new prod-aws --provider aws --role
anycloud credentials new prod-aws --provider aws --role \
  --role-arn arn:aws:iam::123456789012:role/anycloud-role-Role-1A2B3C
```

In a terminal, a missing name, provider or identifier is prompted for, the
identifiers after the setup is printed. With `--json` or without a terminal,
`new` never prompts: a missing or invalid value is a usage error naming its
flag that exits `2`, after printing the setup when only identifiers are
missing.

With `--json`, the setup and progress go to stderr, and stdout carries one
document: `{name, cloudProvider, kind: "role", ...identifiers}` on success, or
`{"error": {"code", "message"}}` on failure, with the
[exit codes of the lifecycle commands](/reference/cli/api-utilities#results-for-scripts):
`INVALID_ARGUMENT` or `API_UNREACHABLE` (exit `2`, not run),
`CREDENTIAL_NAME_EXISTS` (the name is taken; pass `--overwrite`),
`ROLE_SETUP_UNAVAILABLE` (the API serves no setup template), the API's error
code such as `CREDENTIALS_EXIST` (the same identifiers are saved under the
name the message gives), or `UNEXPECTED` (exit `1`).

```bash
anycloud credentials new prod-gcp --provider gcp --role --json \
  --workload-identity-provider projects/123/locations/global/workloadIdentityPools/anycloud/providers/anycloud-api \
  --service-account-email anycloud-role@my-proj.iam.gserviceaccount.com
```

Saving checks the connection with the cloud first and waits, saying so, while
a new trust reaches the cloud's IAM. `list` shows each role connection's
identifiers.

An AWS account can hold one OIDC provider per issuer, so the deploy fails in
an account that already has the API's provider;
`aws cloudformation describe-stack-events --stack-name <stack>` shows the
provider already exists. Recreate the stack to reuse that provider:

```bash
aws cloudformation delete-stack --stack-name <stack>
aws cloudformation wait stack-delete-complete --stack-name <stack>
aws cloudformation deploy --template-file anycloud-role.json --stack-name <stack> \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides IssuerProviderExists=true
```

Pass `IssuerProviderExists=true` only on a new stack: on an existing one it
deletes the provider that stack created.

#### Apply the setup from this machine {#role-apply}

`--apply` does the setup itself through the cloud's own CLI, signed in on this
machine, and saves the identifiers it reads back without asking for them:

| Cloud | What `--apply` runs                                                                                       | Account it applies in                                |
| ----- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| AWS   | `aws cloudformation deploy` of the template as stack `anycloud-role-<api host>`, then reads its `RoleArn` | the CLI's default, or `--profile NAME`               |
| GCP   | the setup script with `bash`, in a temporary directory, and reads the two values it prints                | the selected project, or `--project-id ID`           |
| Azure | `az deployment sub create --name anycloud-role`, and reads its three outputs                              | the selected subscription, or `--subscription-id ID` |

```bash
anycloud credentials new prod-gcp --provider gcp --role --apply --json
anycloud credentials new prod-aws --provider aws --role --apply --profile production
```

With `--json`, the document adds `account`: the AWS account, GCP project or
Azure subscription it applied in. `--apply` takes no identifier flags.

Running it again converges:

- **AWS:** `deploy` updates the stack. A new stack that never came up is
  deleted and created again. When it failed because the account already has
  the API's OIDC provider, the new stack reuses that provider
  (`IssuerProviderExists=true`). A stack that once deployed is never deleted.
- **GCP:** the script adopts the provider it created, the same ID with the same
  issuer, audience and condition, says so, and converges the rest. It still refuses a
  pool holding any other provider, even one with the same issuer: after a
  [signing-key compromise](/platform/cloud-credentials#role-connections) the
  trust is replaced, not adopted. It also refuses an ID that GCP keeps for 30
  days after a delete.
- **Azure:** the deployment runs again in its first region, or the
  `anycloud-role` group's (`eastus` for a new one).

When the CLI is missing, signed out or refused, `new` prints the manual setup
instead. In a terminal it then asks for the identifiers. With `--json` or
without a terminal it stops:

- a signed-out CLI prints `{"actionRequired": {"code":
"CLOUD_SIGN_IN_REQUIRED", "message", "command"}}`, where `command` signs in
  (`aws sso login`, `gcloud auth login`, `az login`), and exits `2`;
- a missing CLI is `CLOUD_CLI_UNAVAILABLE` and a refusal
  `CLOUD_RIGHTS_MISSING` (exit `1`), as for `api create`.

The signed-in account needs these rights; an account administrator has them:

| Cloud | Rights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS   | `cloudformation:CreateChangeSet`, `ExecuteChangeSet`, `DescribeChangeSet`, `DescribeStacks`, `DescribeStackEvents`, `DeleteStack`; `iam:CreateRole`, `GetRole`, `UpdateRole`, `UpdateAssumeRolePolicy`, `PutRolePolicy`, `GetRolePolicy`, `DeleteRole`, `DeleteRolePolicy`, `CreateOpenIDConnectProvider`, `GetOpenIDConnectProvider`, `DeleteOpenIDConnectProvider`, `UpdateOpenIDConnectProviderThumbprint`, `AddClientIDToOpenIDConnectProvider`, `RemoveClientIDFromOpenIDConnectProvider` (a stack that fails rolls back; a re-run updates the provider) |
| GCP   | `iam.workloadIdentityPools.create`, `get`; `iam.workloadIdentityPoolProviders.create`, `get`, `list`; `iam.roles.create`, `update`; `iam.serviceAccounts.create`, `get`, `getIamPolicy`, `setIamPolicy`; `resourcemanager.projects.get`, `getIamPolicy`, `setIamPolicy`; `serviceusage.services.enable`, `list`                                                                                                                                                                                                                                               |
| Azure | `Microsoft.Resources/deployments/write`, `Microsoft.Resources/subscriptions/resourceGroups/write`, `Microsoft.ManagedIdentity/userAssignedIdentities/write` and `federatedIdentityCredentials/write`, `Microsoft.Authorization/roleDefinitions/write` and `roleAssignments/write` (Owner, or Contributor and User Access Administrator)                                                                                                                                                                                                                       |

You own what `--apply` creates: the AWS stack, the GCP workload identity pool,
provider, service account and custom role, and the Azure resource group,
identity and role. `anycloud credentials delete <name>` leaves them in place.

`anycloud credentials delete <name> --apply` deletes them too, through the
same CLI. It first checks, changing nothing, that the CLI is signed in and the
cloud side is this connection's; a failure there leaves everything for a
retry. Then the saved connection goes, refused (without `--force`) while
workloads use it, and then the cloud side, skipping what is already gone.
`--json` prints `{name, deleted, kept}`. If a cloud delete fails, the error
says the connection is already deleted: finish with the cloud's CLI.

It deletes only what proves to be this connection's, and refuses with
`ROLE_TEARDOWN_REFUSED` when another saved connection uses the same cloud side:

| Cloud | Deletes, once it proves it is this connection's                                                                                                                                    | Keeps                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| AWS   | the stack `anycloud-role-<api host>`, whose `RoleArn` is this connection's (`--profile` selects the account)                                                                       |                                                                                                          |
| GCP   | the provider that trusts this API; the pool once it holds no other provider; the setup's service account and its project bindings, unless another pool or saved connection uses it | the custom role, which a key connection may use too; a shared service account, minus this pool's binding |
| Azure | the role assignment, the `anycloud-role` group whose identity is this connection's, the role definition and the deployment                                                         |                                                                                                          |

GCP keeps a deleted pool's and provider's IDs for 30 days, and `--apply` never
undeletes or adopts them: after a signing-key compromise the old trust must
stay gone. Until then, a new `--apply` in that project needs new IDs:

```bash
ANYCLOUD_ROLE_POOL=anycloud-2 ANYCLOUD_ROLE_PROVIDER=anycloud-api-2 \
  anycloud credentials new prod-gcp --provider gcp --role --apply
```

Deleting needs each cloud's read and delete rights for the same resources:
AWS `cloudformation:DescribeStacks` and `DeleteStack` with the IAM deletes;
GCP `iam.workloadIdentityPoolProviders.get`, `list` and `delete`,
`iam.workloadIdentityPools.get` and `delete`, `iam.serviceAccounts.get` and
`delete`, and `resourcemanager.projects.getIamPolicy` and `setIamPolicy`;
Azure the matching reads and deletes, which Owner holds.

The GCP script uses the pool `anycloud`, the provider `anycloud-api`, the
service account `anycloud-role` and the custom role `anycloud`. Set
`ANYCLOUD_ROLE_POOL`, `ANYCLOUD_ROLE_PROVIDER`,
`ANYCLOUD_ROLE_SERVICE_ACCOUNT` or `ANYCLOUD_ROLE_CUSTOM_ROLE` on `bash` to
use other IDs, for example
`curl -fsSL <api>/role-setup/gcp.sh | ANYCLOUD_ROLE_PROVIDER=anycloud-api-2 bash`. It refuses a pool that already has a provider, because
its impersonation binding admits the subject through every provider in the
pool, and an ID GCP still holds after a deletion (30 days).

## Ask an administrator

Anycloud needs a dedicated identity in your cloud account. If you can't create
one, ask whoever administers the account for either of these:

| Provider | Credentials to send you                                                                                                                          | Or permission to create them                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| AWS      | Access keys for a dedicated Anycloud IAM user with [`AnycloudAccess`](#aws-permissions)                                                          | Create IAM users, add inline policies, and create access keys ([operator permissions](#aws-operator-permissions)) |
| Azure    | The application ID, secret, subscription ID, and tenant ID for a service principal with Contributor or the [`Anycloud` role](#azure-permissions) | Create Entra applications and assign roles on the subscription                                                    |
| GCP      | A JSON key for a dedicated Anycloud service account with the [`Anycloud` role](#gcp-permissions)                                                 | Create service accounts and keys, and grant project IAM roles                                                     |

The identity needs the grants listed for generation under its provider above.
With credentials, rerun `anycloud credentials new` and enter them. With
permission, rerun it and choose the create option.

When generation fails because the operator lacks permission, the error ends
with the same request, naming the operator identity when Anycloud knows it.

When a saved credential is valid but the cloud refuses it an action, the Job
ends `invalid` with a "Permission denied" message, or the submission is rejected
with it. The message names the cloud, the denied action and where it was
denied, such as `ec2:RunInstances in us-east-1`. On AWS it also points to the
[`AnycloudAccess`](#aws-permissions) policy. Send it to your administrator. On AWS, when the denial is
limited to a region (an EC2 action), a Job without `--region` first tries the
other regions that offer its VM type, and ends `invalid` only when every region
refuses it.

### AWS permissions

`AnycloudAccess` is everything Anycloud does with an AWS key: launch, recover
and terminate VMs, create and delete Buckets, mint the short-lived token each
VM syncs a Bucket with, and read regions, quotas and costs. It grants no IAM
action except creating the Spot service-linked role: AWS creates
`AWSServiceRoleForEC2Spot` automatically only for a console request, and asks
API callers to make sure it exists
([AWS documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/service-linked-roles-spot-instance-requests.html)).
The condition limits that statement to that one role. `--generate` adds this
policy inline; an administrator can do the same with
`aws iam put-user-policy --user-name anycloud-<name> --policy-name AnycloudAccess --policy-document file://aws-anycloud-access.json`.

<CodeBlock language="json" title="aws-anycloud-access.json">
  {JSON.stringify(anycloudAccess, null, 2)}
</CodeBlock>

An administrator can narrow it further:

- **Buckets:** move `s3:ListAllMyBuckets` to its own statement on `*`, and
  replace the `Buckets` statement's `Resource` with the Buckets Anycloud may
  use, for example `arn:aws:s3:::team-ml-*` and `arn:aws:s3:::team-ml-*/*`.
  Buckets Anycloud names for you, such as a spot Job's checkpoint Bucket, fall
  outside such a prefix, so name every Bucket explicitly.
- **Regions:** split the `Compute` statement in two. Keep the `ec2:Describe*`
  actions unconditioned, because Anycloud reads every enabled region, for
  example to find a cluster's VMs when restoring it. Put the
  `aws:RequestedRegion` condition only on the actions that change resources.
  Jobs without `--region` then run only in those regions; see
  [Cloud Credentials](/platform/cloud-credentials).

  ```json
  {
    "Sid": "ComputeReads",
    "Effect": "Allow",
    "Action": [
      "ec2:DescribeImages",
      "ec2:DescribeInstances",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeRegions",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSpotInstanceRequests",
      "ec2:DescribeVolumes",
      "ec2:DescribeVpcs"
    ],
    "Resource": "*"
  },
  {
    "Sid": "ComputeChanges",
    "Effect": "Allow",
    "Action": [
      "ec2:RunInstances",
      "ec2:StartInstances",
      "ec2:TerminateInstances",
      "ec2:CreateTags",
      "ec2:CancelSpotInstanceRequests",
      "ec2:CreateSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:DeleteSecurityGroup",
      "ec2:DeleteNetworkInterface",
      "ec2:DeleteVolume"
    ],
    "Resource": "*",
    "Condition": {
      "StringEquals": { "aws:RequestedRegion": ["us-east-1", "us-west-2"] }
    }
  }
  ```

If your account encrypts EBS volumes by default with a customer-managed KMS
key, that key's policy must also let this user and `AWSServiceRoleForEC2Spot`
use it. The AWS-managed `aws/ebs` key needs nothing.

#### AWS operator permissions

To let someone run `--generate` instead of handing them keys, grant their
profile these actions. Anycloud creates users only under `anycloud-`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateUser",
        "iam:TagUser",
        "iam:GetUser",
        "iam:ListUserTags",
        "iam:PutUserPolicy",
        "iam:CreateAccessKey",
        "iam:DeleteAccessKey",
        "iam:DeleteUserPolicy",
        "iam:DeleteUser"
      ],
      "Resource": "arn:aws:iam::*:user/anycloud-*"
    }
  ]
}
```

The delete actions are used only to clean up after a failed generation.

### Azure permissions

The Anycloud role is everything Anycloud does with an Azure service principal:
launch, recover and delete VMs and their networks, create the storage account
and its Buckets, read the account key that signs each VM's Bucket token, and
read regions, quotas and costs. Azure VMs get no managed identity, so the role
grants no role-assignment or identity action. Contributor also covers it.

To create it, replace `<subscription-id>` in `AssignableScopes`, then run
`az role definition create --role-definition azure-anycloud-role.json` and
`az role assignment create --assignee <application-id> --role Anycloud --scope /subscriptions/<subscription-id>`.

<CodeBlock language="json" title="azure-anycloud-role.json">
  {JSON.stringify(azureRole, null, 2)}
</CodeBlock>

### GCP permissions

The `Anycloud` custom role is everything Anycloud does with a GCP
service-account key: launch, recover and delete VMs and their firewall rules,
create and delete Buckets, and read costs from a Cloud Billing BigQuery export.
Anycloud attaches no service account to its VMs, so the role grants no
`iam.serviceAccounts.actAs`. Each VM syncs a Bucket with an access token
downscoped from the key to that one Bucket. That needs no further permission,
but the project must have the Security Token Service API
(`sts.googleapis.com`) enabled.

An administrator creates the role and grants it to the service account:

```bash
gcloud iam roles create anycloud --project=PROJECT_ID --file=gcp-anycloud-role.json
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=serviceAccount:SERVICE_ACCOUNT_EMAIL \
  --role=projects/PROJECT_ID/roles/anycloud
```

<CodeBlock language="json" title="gcp-anycloud-role.json">
  {JSON.stringify(gcpRole, null, 2)}
</CodeBlock>

`resourcemanager.projects.get` reads the project's number, which Anycloud
checks before it reuses a checkpoint bucket that already has its name.

The two `bigquery` permissions are needed only for per-VM costs from a billing
export; remove them if you don't configure one. Anycloud runs the cost query
in the key's project, which needs `bigquery.jobs.create`, and reads the export
table, which needs `bigquery.tables.getData` where the billing dataset lives.
When that dataset is in another project, also grant the service account
`roles/bigquery.dataViewer` on the dataset.

## Saving and cleanup

Generated credentials use the normal encrypted API save flow; provider CLI
logins stay local. AWS generation leaves the operator profile unchanged. GCP
keeps the new private key in memory until saving and creates no local key file.
Saving generated AWS or Azure credentials does not perform a separate
readiness wait or probe.

Interrupted generation or uncertain responses can leave identities, keys, or
grants requiring manual reconciliation. AWS diagnostics identify the known
account and user; GCP diagnostics identify the project, service-account ID,
and invocation. Uncertain saves retain the identity. Automatic cleanup only
removes resources verified as belonging to that invocation.

AWS generation and cleanup retry transient connection failures, throttling,
and temporary service errors in `GetCallerIdentity`, `GetUser`, and
`ListUserTags`, and in the cleanup deletes of the access key, inline policy,
and user. Each call allows up to three attempts within 60 seconds, including
command execution and backoff. A cleanup delete that finds its resource
already gone counts as done. Authentication, permission, and ownership failures
stop immediately. Other IAM writes are sent once. Failures report the
operation, safe error category, attempt count, and elapsed time without
exposing credentials or raw CLI output.

Deleting a saved Anycloud credential does not delete its cloud identity, keys,
or grants. Existing credentials and provider resources created by older
releases remain available.

## First-use recovery

GCP bucket listing, existence checks, creation and deletion, and object
upload, download and deletion, retry only the structured OAuth `invalid_grant`
failure with `Invalid JWT Signature.` or `Invalid grant: account not found`, at
most six attempts with 23 seconds of backoff. A key Google still refuses after
that answers the retryable `BUCKET_CREDENTIAL_NOT_READY` error.
Unrelated permission denials remain terminal. Generation also bounds retries
for a newly created identity that IAM cannot yet read or definitively rejects
in a grant update. Service-account creation, key issuance, and uncertain writes
are never automatically repeated.

Azure authorization can still be propagating when a credential is first used.
At compute validation and storage operations, the API retries only the specific ARM `AuthorizationFailed` and
Entra `AADSTS7000215` shapes. Recovery is capped at nine attempts over 39.5
seconds and refreshes authentication between attempts. It does not depend on
credential age, a readiness probe, or a previous success.

An unrelated 403, an expired secret (`AADSTS7000222`), or a generic
`invalid_client` failure receives no special propagation retry. A persistently
broken secret exhausts at most the bounded recovery window and then fails
normally.

For selection precedence and storage identities, see
[Cloud Credentials](/platform/cloud-credentials) and
[Configuration](/reference/configuration#credential-precedence).
