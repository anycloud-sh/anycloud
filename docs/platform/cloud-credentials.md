---
title: Cloud Credentials
description: Connect cloud accounts, understand credential selection, and keep provider access local and encrypted.
---

# Cloud Credentials

Cloud Credentials authorize Anycloud to provision resources in your AWS,
Azure, GCP, or Lambda account. Save multiple named credentials when
you want to use several accounts or let Anycloud choose across them.

Cloud credentials are distinct from [Secrets](/platform/secrets-environment):
credentials let Anycloud manage infrastructure; secrets become environment
variables inside your workload.

## Create credentials

Run the wizard and choose a provider:

```bash
anycloud credentials new production-aws
```

### Import or generate {#import-and-explicit-generation}

- **Import:** reuse local AWS access keys or a GCP service-account key file,
  or enter existing provider credentials.
- **Generate:** create a separate IAM user, Azure service principal, or GCP
  service account. The wizard shows the target and permissions and asks for
  confirmation.

For imports, choose a detected local source, complete environment credentials,
or fresh manual entry. GCP accepts service-account JSON files. Even a single
detected source requires selection. The wizard shows the source and available
account identifiers, then asks for confirmation before saving; the default is
**No**. Declining or pressing Ctrl-C at that prompt saves nothing.

AWS reviews show the account and identity authenticated through STS. GCP
reviews show the project and service-account email; Azure reviews show the
tenant, subscription, and application ID supplied in the credentials. Lambda
reviews identify the provider and source. Secret values stay hidden.

To generate, reuse a working provider CLI login, or sign in first. Choose
generation in the wizard or use [`--generate`](/reference/cli/credentials#aws)
to explicitly request a new key.

### Ways to add AWS credentials {#aws-credential-sources}

| How                                                                      | What Anycloud stores                                                                                                                                                                                                                                                  | What works                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `anycloud credentials new --generate`                                    | Uses your existing AWS profile as the operator (from SSO, `aws login` or keys; Anycloud doesn't run the sign-in), creates an `anycloud-<name>` IAM user with the [`AnycloudAccess`](/reference/cli/credentials#aws-permissions) policy, and stores its long-lived key | Jobs, Services, Buckets, spot recovery                              |
| Import a static profile from `~/.aws/credentials`                        | That profile's long-lived IAM user key                                                                                                                                                                                                                                | Jobs, Services; Buckets and spot recovery if its policy allows them |
| Use `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment | That long-lived key; offered only without `AWS_SESSION_TOKEN`                                                                                                                                                                                                         | Jobs, Services; Buckets and spot recovery if its policy allows them |
| Paste an access key ID and secret                                        | That long-lived key; use this when an administrator creates the IAM user (see [Ask an administrator](/reference/cli/credentials#ask-an-administrator))                                                                                                                | Jobs, Services; Buckets and spot recovery if its policy allows them |
| Temporary session keys (SSO or `aws login`, with a session token)        | Nothing: the CLI and the API reject them, saved or inline, because they expire                                                                                                                                                                                        | —                                                                   |

Buckets, and spot recovery (resuming a preempted spot Job from its automatic
checkpoint Bucket), need `sts:GetFederationToken` and S3 access to the
Buckets. A generated key has both; an imported or pasted key has them if its
policy grants them.

`--generate` and the administrator path end with the same IAM user and
permissions: an administrator grants the published
[`AnycloudAccess`](/reference/cli/credentials#aws-permissions) policy.
`--generate` just does it for you.

### Cleanup {#generated-credentials-and-first-use-recovery}

Interrupted generation or an uncertain save may require manual cleanup of
cloud resources. Deleting a saved credential does not delete its cloud identity.

See the [`credentials` reference](/reference/cli/credentials) for command
examples, provider permissions, naming rules, and recovery details.

### Role connections {#role-connections}

A self-hosted API can save a role connection on AWS, GCP or Azure instead of a
key: it stores only the role's identifiers and exchanges the API's own
Kubernetes ServiceAccount token for short-lived cloud credentials. A local API
refuses one. Saving checks the connection once, then checks that the role's
trust names exactly the API's ServiceAccount and audience: the cloud must
refuse a token for the `anycloud-trust-probe` ServiceAccount and the API's
token for another audience. If it accepts either, the save is refused, naming
the subject or audience the trust leaves open. A new GCP impersonation
binding or Azure role assignment takes a while to reach the cloud, so the save
waits up to about 2.5 minutes, saying what it waits for. Azure role
assignments can take over 10 minutes; if the save stops waiting, run the same
save again later.

Create one with `anycloud credentials new <name> --provider aws|gcp|azure
--role` ([reference](/reference/cli/credentials#role-connections)). The API
serves each cloud's setup template beside its issuer, generated from the
published policy or role: a CloudFormation template on AWS, a Cloud Shell
script on GCP, and a Deploy to Azure template, which uses a managed identity
and needs no tenant-admin consent. Each trusts exactly the API's issuer, the
cloud's audience and the subject
`system:serviceaccount:anycloud-system:anycloud-api`. In an AWS account that
already has the issuer's OIDC provider, deploy a new stack with
`IssuerProviderExists=true` to reuse it. Don't switch an existing stack to
`true`: that deletes the provider the stack created.

To recreate a GCP trust, for example after a suspected signing-key compromise,
first delete the old provider: a binding in a pool that still holds it would
trust that provider's cached keys again. Then run the script with a new
provider ID (GCP keeps a deleted provider's ID for 30 days) or a new pool, for
example `curl -fsSL <api>/role-setup/gcp.sh | ANYCLOUD_ROLE_PROVIDER=anycloud-api-2 bash`,
and save the printed identifiers with
`anycloud credentials new <name> --provider gcp --role --overwrite`.

## Select credentials for compute

Select a named credential when account choice is part of the workload:

```bash
anycloud job ghcr.io/acme/train:latest \
  --credentials production-aws \
  --gpu-type h100
```

In Python, pass `credential_name` when submitting the Job:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="production-aws",
        gpu="h100",
    )
    print(job.id)
```

If `--credentials` and `ANYCLOUD_CREDENTIALS_NAME` are absent, the CLI selects
the sole saved credential automatically. With several saved credentials, an
interactive terminal shows a picker; non-interactive use must pass
`--credentials`. The Python `Client` discovers the API URL and authentication
token, but does not automatically select a compute credential. Pass
`credential_name` explicitly for remote Jobs. Generated requests can supply
named or inline credentials.

Each remote workload uses one compute credential for its lifetime. If the
cloud rejects that credential, the workload becomes `invalid`; Anycloud does
not switch accounts. Region can remain unset so the workload can still fail
over between regions in the selected account.

An AWS credential may be limited to some regions, for example with an
`aws:RequestedRegion` condition. Submit checks the key with STS, which does
not depend on the region. When EC2 denies a region to a Job with no
`--region`, that Job moves to another region and does not try the denied one
again; other Jobs are unaffected. A Job pinned to a denied region, or denied in
every region that offers its VM type, becomes `invalid` with AWS's message
naming the denied action. A newly created key can take up to about 23 seconds
to be accepted; submit waits for it, so a deleted key is also reported invalid
only after that wait. Local compute does not require a
cloud credential.

## Storage credentials

AWS, Azure and GCP VMs get no identity: each Bucket syncs with a short-lived
token scoped to it, minted from the selected credential. On AWS that takes
`sts:GetFederationToken`, so the credential needs no other IAM permission
except `iam:CreateServiceLinkedRole` for the account's first Spot launch (see
[`AnycloudAccess`](/reference/cli/credentials#aws-permissions)). On Azure it is
a container SAS signed with the storage account key, so a Contributor-only
service principal, or one with the
[Anycloud role](/reference/cli/credentials#azure-permissions), is enough. On
GCP the token is downscoped from the service-account key, so the key needs no
`iam.serviceAccounts.actAs` (see
[GCP permissions](/reference/cli/credentials#gcp-permissions) and
[Buckets](/platform/buckets#authentication)). When a Bucket belongs to a
different account, give it a separate storage credential:

```bash
anycloud job ghcr.io/acme/train:latest \
  --credentials compute-account \
  --input-bucket training-data \
  --input-storage-credentials storage-account \
  --input-storage-region us-east-1
```

Input, output, and checkpoint storage credentials are independent. See
[Buckets](/platform/buckets#authentication).

Python submissions with a separate saved storage credential use a generated
admission request. The credential name belongs at the top level, while the
Bucket and storage region belong under `cloudConfig`; see
[Bucket credential rules](/reference/configuration#bucket-credential-rules)
for a complete example.

## Local security model

Saved cloud credentials live in the local Anycloud API database at
`~/.anycloud/api.db`. They are encrypted at rest with libsodium
(XSalsa20-Poly1305) using a locally generated key at
`~/.anycloud/cipher.key`. Anycloud communicates directly with the cloud
provider rather than sending the credentials to an Anycloud-hosted service.

The database records the identity of the API that owns it, and cloud resources
carry that identity in their tags. To move a local API installation, run
`anycloud api stop`, then copy the whole `~/.anycloud` state, including
`cipher.key`; stopping first writes pending database changes into `api.db`.
The database keeps its
identity, so the resources it created stay recognisably its own.

Each workload receives a unique ED25519 SSH keypair. The private key remains
encrypted in the local API database; commands such as `anycloud exec` ask the
API to perform the SSH operation rather than returning the key to the CLI.

Bucket sync never puts a long-lived provider key on the VM or in the
container: each Bucket uses a short-lived token scoped to it (see
[Storage credentials](#storage-credentials)).
