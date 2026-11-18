# RFC 0047: Credential scope and least-privilege provisioning

> Status: Accepted
> Date: 2026-10-07
> Updated: 2026-11-06
> Author: Claude draft, for Luis Fernando De Pombo

## Summary

An AWS pilot on 0.1.66 brought its own credential: an IAM user allowed `ec2:*`
in three US regions and no IAM actions. Every AWS Job failed. The
[restricted-IAM experiment](../experiments/aws-restricted-iam/README.md)
reproduced both failures with the released binary:

- Every managed Job ended `invalid` as `bad-credential`, because `newVM` first
  creates or reads the shared `anycloud-vm-role` and `anycloud-vm-profile`
  ([`aws.ts`](../src/api/services/gateways/aws.ts) `ensureSharedInstanceProfile`).
  Granting only those IAM actions made the same Job complete.
- A Job without `--region` was rejected with "could not conclusively validate
  cloud credential … ap-south-1 … Please retry", because placement picked the
  cheapest catalog region and validation ran `DescribeVpcs` there.

The cause is shared by every cloud gateway: the
[compute contract](../src/api/services/gateways/cloud.ts) assumes the credential
administers the whole account. Three contract points encode that assumption:

1. `validateCredentials()` is a single valid-or-invalid check in one region, and
   placement chooses from every catalog region. A credential has no scope.
2. `newVM` performs account-wide identity setup whenever
   `hostCredentialPolicy.storageIdentity` is `attach`, which is every Job
   and Service, whether or not it uses a bucket. Azure creates a
   managed identity and a Storage Blob Data Contributor role assignment, which
   needs Owner or User Access Administrator. GCP attaches the default compute
   service account, which needs `iam.serviceAccounts.actAs`.
3. `CloudFailureDiagnosis` has no permission-denied value. A missing IAM action
   or a denied region becomes `bad-credential` or a retryable validation
   failure, so a working but scoped key looks broken.

This RFC changes those three points. It leaves VM termination, release
observation, networking and provisioning-attempt adoption unchanged.

## Context: credential access in plain terms

When Anycloud runs a Job in a customer's AWS account, there are **two separate AWS identities** involved:

|                         | What it is                                                                                                            | What it's used for                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **① The Anycloud key**  | The AWS access key the customer gives Anycloud: imported, pasted, or created by `anycloud credentials new --generate` | Anycloud's own work: launch and stop VMs, create buckets, read quotas and costs            |
| **② The VM's identity** | A role attached to each VM Anycloud launches                                                                          | Lets the program on the VM read inputs from and write outputs to the customer's S3 buckets |

### What we have today

- **① is broad.** When Anycloud generates it, it gets `PowerUserAccess` + `IAMFullAccess`, close to admin.
- **② is created by Anycloud using ①.** Before launching a VM, Anycloud creates or reads a role called `anycloud-vm-role`, which can read and write all of the customer's buckets, and attaches it to every VM. Creating, reading and attaching that role needs IAM permissions on ①.
- **Exception:** for buckets in a _different_ account or cloud, the VM instead gets short-lived tokens that Anycloud mints from ①, each limited to one bucket.
- **Checking ① at submit:** Anycloud calls an EC2 API (`DescribeVpcs`) in the region the Job will run in. With no `--region`, that's the cheapest region in the catalog.

### What the pilot hit

Their admin gave ① only EC2, only in three US regions, and no IAM. Two failures:

1. **Every Job failed with "bad credential".** Anycloud tried to create or read ②, the VM role, which needs IAM. They had none, even for Jobs with no buckets.
2. **Jobs with no `--region` were rejected at submit with "Please retry".** The cheapest region was Mumbai (`ap-south-1`), which their key isn't allowed in, so the submit-time check failed there.

### What this RFC proposes

- **Drop ② entirely.** VMs get short-lived, bucket-scoped tokens minted from ① for every bucket, not just cross-account ones, so ① needs no IAM permissions. This fixes failure 1.
- **Check ① without a region** (STS `GetCallerIdentity`). This fixes failure 2 at submit.
- **When a region is denied at launch, try another region,** and report "permission denied" clearly.
- **Publish a minimal policy for ①,** used by `--generate` instead of near-admin, and remove the equivalent VM identities on Azure and GCP.

In one line: today Anycloud needs near-admin keys because it builds a VM role with IAM. This RFC removes the VM role, so the key needs no IAM.

## Proposal

- **Smallest useful release (0.1.68).** On AWS, a credential allowed only to
  run VMs in some regions runs Jobs in those regions. On AWS, Azure and GCP, a
  Job with a bucket in the same cloud gets a short-lived token scoped to that
  bucket, as cross-account buckets do today, and Anycloud never creates or
  attaches a VM identity. How Azure and GCP region restrictions are classified
  stays an open question, outside 0.1.68. Excluded: customer-supplied
  identities, subnets and security groups; quota-increase requests; and the items under **Later** below.

- **Credential scope (contract point 1).** Validation proves only that the
  secret is genuine, with a call that does not depend on the placement region
  (AWS STS `GetCallerIdentity`). A newly created key can be rejected while it
  propagates. STS returns `InvalidClientTokenId` for both a propagating key and
  a deleted one, so validation retries `InvalidClientTokenId` with the bounded
  backoff (about 23 seconds) that `listBuckets` already uses for S3's
  `InvalidAccessKeyId` ([`aws.ts`](../src/api/services/gateways/aws.ts)
  `listBuckets`). A deleted key is therefore reported as invalid only after
  that backoff.

  On AWS, scope is learned per Job from denials, not configured. An EC2 regional
  denial (`UnauthorizedOperation`) on a Job with no pinned region blocks that
  whole region for that Job only, and placement moves on. The block is read
  from the Job's existing provisioning-failure history, the way `InvalidTarget`
  failover works today
  ([`provisioning-failure.ts`](../src/api/services/provisioning-failure.ts)):
  it is not shared with other Jobs, has no block window, and adds no state. A
  pinned Job, or a Job whose candidate regions are all denied, ends `invalid`
  naming the denied action. No `--regions` flag is added: learning needs no
  configuration and cannot drift from the provider policy.

- **No VM identity (contract point 2).** Remove
  `HostCredentialPolicy.storageIdentity` on all three clouds. `newVM` never
  attaches an identity or creates identity resources, so the AWS role and
  instance profile bootstrap, the Azure managed identity and role assignment,
  and the GCP default service account attachment are deleted. Same-cloud
  buckets use `mintScopedStorageToken`, the path cross-account buckets already
  use ([`vm-runtime-storage.ts`](../src/api/services/vm-runtime-storage.ts)).
  Node pools already launch without an identity (`kubernetes-node`), so this
  makes VM Jobs match the pool direction of
  [RFC 0044](./0044-one-pool-runtime.md).

  Tokens keep today's per-bucket grants: read and list for an input bucket,
  read, write and list for an output or checkpoint bucket, each limited to that
  one bucket. Narrower per-role grants are **Later**.

  Minted-token lifetime differs by cloud. An AWS mint lasts 12 hours for both
  connection kinds (amendment 10): `GetFederationToken` for a key,
  `AssumeRoleWithWebIdentity` for a role connection. An Azure SAS
  lasts whatever the SAS minter's design sets. A GCP downscoped token lives
  only as long as its source access token, about one hour. Renewal is
  expiry-driven: the API renews a running VM-host Job's or Service's token a
  few minutes before that token's own expiry, as it already does for Services
  ([`service-storage-renewal.ts`](../src/api/services/service-storage-renewal.ts)
  `RENEW_BEFORE_EXPIRY_MS`), so the same loop serves every lifetime. VM
  finalization re-mints before its final copy. Pool Job token lifetimes
  are RFC 0043's. The token is
  written to the VM for the storage sync; an in-memory credential endpoint
  instead of a file is added only if a customer's security review requires it.

  `GetFederationToken` needs a long-term IAM-user key. A snapshot of AWS
  session credentials (with a session token) expires and cannot be refreshed,
  so it is rejected when saved, and inline at submit, by both the CLI and the
  API. There is no spot special case and no runtime fallback for VMs started
  before the upgrade. A role connection (below) saves no session credentials:
  the API gets fresh sessions on demand.

  Azure and GCP remove their VM storage identities in 0.1.68 too. Their
  same-cloud buckets then need minters that do not exist yet: Azure needs the
  shared SAS minter of RFC 0043's pool storage, and GCP needs
  a downscoped-token minter (Credential Access Boundary). If RFC 0043's minters
  have not landed when this work starts, this RFC builds them for these paths.
  Tokens are per bucket, so Azure uses a container SAS and does not wait on
  the directory-SAS question.

  Trade-offs:
  - **Gained.** The compute credential needs only VM permissions and storage
    access to the buckets its Jobs use. A Job reaches only the buckets it names
    instead of every bucket in the account (`arn:aws:s3:::*` today). No role,
    identity or role assignment is left in the customer's account.
  - **A credential on the VM.** Root on the VM can read the token, where today
    same-cloud Jobs fetch rotating instance credentials from the metadata
    endpoint. A leaked token works from anywhere until it expires: an input
    token reads that whole bucket, and an output or checkpoint token can add,
    overwrite or delete any object in that bucket, including other Jobs'
    results, until per-role grants land.
  - **Expiry.** Renewal keeps running Jobs and Services working past one
    token's lifetime. A token stops working at its own expiry if the API cannot
    renew it, for example while the API is unreachable: after 12 hours on AWS,
    but after about an hour on GCP.
  - **No opt-out.** A customer whose policy forbids credentials on VMs cannot
    use same-cloud buckets until a customer-supplied identity is added.
  - **Minting permission.** The selected storage identity signs each role's
    tokens (amendment 7): the compute credential signs only a role it serves
    with no storage credential named, and only then needs storage permissions.
    On AWS a key connection needs `sts:GetFederationToken`, S3 on the buckets,
    and a long-term IAM-user key; a role connection needs only S3 on the
    buckets, because its role's trust policy authorizes the mint.
  - **New code.** Only AWS mints scoped tokens today. Azure SAS and GCP
    downscoped minters, and renewal for VM-host Jobs, are new.

- **One minter, shared with pool storage.** RFC 0043 gives pool
  Jobs per-Job grants that the runner receives in its claim. The selected
  storage identity signs grants (amendment 7): for each role, the explicit
  storage credential when one is named, otherwise the compute credential. A
  compute credential needs storage permissions only when it is used for that
  role. VM Jobs follow the same rule. The minter is the
  storage provider's `mintScopedStorageToken` capability, implemented once per
  cloud and used by both the VM storage sync and RFC 0043's helpers; whichever
  RFC lands an Azure or GCP minter first, the other reuses it. RFC 0044 PR 14
  later deletes VM Job storage sync, so the VM-side token code is
  transitional; the minters remain.

- **Permission-denied diagnosis (contract point 3).** Add `PermissionDenied`
  to `CloudFailureDiagnosis`, carrying the denied action, the region, and
  whether the denial is regional. Regional denials on an unpinned Job become
  the per-Job region block above; other denials, pinned Jobs and Jobs with
  every candidate region denied end the Workload `invalid` with the denied
  action and region named, so the admin request can be shown at
  runtime. `BadCredential` is kept for secrets the provider does not recognize
  (AWS `InvalidClientTokenId`).

- **Least-privilege policy (`AnycloudAccess`).** Publish the minimal AWS
  policy as JSON in the docs, derived from the gateway's calls. A pull-request
  CI check, which makes no cloud calls, fails when the gateway sends an AWS
  action the policy lacks. `credentials new --generate` attaches
  `AnycloudAccess` instead of `PowerUserAccess` and `IAMFullAccess`, once the
  spot service-linked-role question below is answered. One paid AWS run with a
  credential restricted to the policy proves it. Azure and GCP publish their
  minimal roles the same way once their VM identities are gone: a
  role-definition JSON for Azure and a custom-role YAML for GCP, each with its
  own drift check: a pull-request CI check, making no cloud calls, that fails
  when that cloud's gateway calls an operation the published role does not
  grant. Key connections are set up from the docs alone. Role connections add
  one generated setup template per cloud (amendment 9).

- **Role connections (amendments 8 and 9).** On AWS, GCP and Azure a
  connection is either a **key**, as today, or a **role** that saves only
  non-secret identifiers. A self-hosted API's own K3s ServiceAccount token
  (`anycloud-api` in `anycloud-system`) is exchanged for short-lived cloud
  credentials. A local API has no such token, so it refuses a role connection
  at save and keeps keys. Key connections stay the baseline, and the only
  option on key-only clouds.

  | Cloud | Saved identifiers                                    | Exchange                                               | One-click setup                                                                                                         |
  | ----- | ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
  | AWS   | role ARN                                             | `AssumeRoleWithWebIdentity`                            | CloudFormation quick-create: an IAM OIDC provider and a role with `AnycloudAccess`, `MaxSessionDuration` 12 h           |
  | GCP   | workload identity provider and service account email | STS token exchange, then service account impersonation | "Open in Cloud Shell" tutorial: a pool, a provider, a service account with the published role, an impersonation binding |
  | Azure | client ID and tenant ID (subscription as for keys)   | client assertion                                       | Deploy to Azure: a user-assigned managed identity, a federated credential, the published role; no tenant-admin consent  |
  - **Issuer prerequisite.** K3s sets `service-account-issuer` to a public
    HTTPS URL, keeping the in-cluster issuer second so current tokens stay
    valid, and `service-account-jwks-uri` beside it. The API serves the
    discovery document and JWKS at that URL, read from the cluster on every
    request, so
    the JWKS always lists every public key in K3s's
    `/var/lib/rancher/k3s/server/tls/service.key`: IAM reads discovery when
    the AWS stack creates the provider, GCP fetches the JWKS from it, and
    Azure reads it at every exchange. K3s signs with the first key in that
    file (`service.current.key`) and accepts every key listed.
  - **Signing-key rotation.** K3s generates that key once, when the file is
    missing, and never rotates it; it renews only its TLS certificates, at
    start within 120 days of their expiry
    ([K3s certificates](https://docs.k3s.io/cli/certificate), `genServiceAccount`
    in [`deps.go`](https://github.com/k3s-io/k3s/blob/master/pkg/daemons/control/deps/deps.go)).
    Role connections therefore ship a documented, tested rotation in three
    steps:
    1. **Add.** A new key goes first in `service.key` with the old one kept
       after it, loaded with `k3s certificate rotate-ca` and a K3s restart.
       New tokens are signed with the new key, and the JWKS publishes both.
    2. **Overlap.** Both keys stay published for at least as long as the
       longest-lived token the old key signed that is still in use. The
       role-connection tokens last 10 minutes, but the same key signs every
       in-cluster token, which the kubelet replaces once it is 24 hours old,
       so the overlap is at least 24 hours. The one non-expiring token, the
       installer's Secret-based token from `INSTALLER_ACCESS_READ_COMMAND`,
       is re-issued during the overlap: its Secret is deleted and recreated,
       because Kubernetes fills a token only into a Secret that has none,
       and the installer's stored kubeconfig is replaced with the new token.
    3. **Retire.** The old key is removed from `service.key` and K3s
       restarts. The JWKS no longer lists it, and AWS and Azure refuse tokens
       it signed. GCP caches the JWKS: it still accepted a removed key's
       tokens after 59 minutes in the C26 spike
       (run 41957954716),
       the end of that spike's window. A longer spike measures GCP's bound
       before S16 is written, and retirement on GCP is complete only at that
       bound (§ Open).

    The operator triggers a rotation with two CLI commands, both run over
    the management-host SSH path that configures K3s
    ([`clusters-domain.ts`](../src/api/services/clusters-domain.ts)): one
    adds the new key and re-issues the installer token, and one retires the
    old key, which it refuses until 24 hours after the add. The documented,
    recommended cadence is every 90 days. On a suspected key compromise the
    operator rotates at once
    with no overlap, restarting the cluster's Pods so each gets a token
    signed by the new key, and
    revokes every role connection's trust on its cloud (the AWS role or
    stack, the GCP impersonation binding, the Azure federated credential),
    then recreates it from the setup template and saves the connection
    again. On GCP the new trust uses a new workload identity provider ID
    after the old provider is deleted (or a new pool), because the
    impersonation binding admits the subject from every provider in its
    pool: a trust recreated on the old provider, or a new provider beside
    it, would admit the old key again from the old provider's cached JWKS,
    and a deleted provider's ID cannot be reused while it is soft-deleted.
    Revoking the trust is required, not optional, because of GCP's cache,
    and credentials already issued outlive both steps (Known limits).

  - **Trust conditions.** Each cloud trusts exactly that issuer, a per-cloud
    audience, and the subject
    `system:serviceaccount:anycloud-system:anycloud-api`, always all three:
    the AWS trust policy matches the provider and `StringEquals` on the
    issuer's `aud` and `sub`; the GCP provider's attribute condition names the
    subject, its allowed audience is the provider's, and the impersonation
    binding names that one `principal://…/subject/…`, never a
    `principalSet://…/*`; the Azure federated credential names the issuer,
    subject and audience, with no claims-matching expression. Never a
    wildcard, and never a trust on the issuer alone, which would admit every
    ServiceAccount in the cluster. The setup templates generate exactly these
    conditions. No external ID is
    needed: the trust has one caller, the user's own API. A role connection
    records that issuer URL, audience and subject as data, and nothing assumes
    the issuer is the local cluster's. A different issuer later, such as a
    hosted one with a subject per tenant, needs new values, not a new design;
    hosting itself stays out of scope.
  - **Save-time check.** Saving a role connection performs the exchange once:
    on AWS, `GetCallerIdentity` and one 12-hour trial bucket-token mint, which
    fails with an error naming `MaxSessionDuration` on a role left at 1 hour;
    on GCP, the STS exchange and `generateAccessToken`, retrying an
    impersonation 403 for about 2 minutes while saying it is waiting for GCP
    IAM; on Azure, the client assertion. After that exchange succeeds, the
    check proves the trust is pinned: it repeats the exchange with a token for
    a second ServiceAccount, `anycloud-trust-probe` in `anycloud-system`,
    which has no other use or permission, and with the API's own token for
    another audience. The cloud must refuse both; if it accepts either, the
    save is refused with a message naming the unpinned subject or audience. A
    refusal at either GCP step (STS or impersonation) counts. The chart adds
    the probe ServiceAccount and its name to the `serviceaccounts/token`
    `resourceNames` of the `anycloud-api-token` Role. A failure
    refuses the save and names the connection. The issuer needs no probe:
    every cloud's trust names one issuer (the AWS OIDC provider, the GCP
    provider's issuer URI, the Azure credential's issuer), with no wildcard
    form.
  - **Bucket tokens.** AWS mints each with another
    `AssumeRoleWithWebIdentity` call, a newly read ServiceAccount token and the
    grant's session policy, for 12 hours, with no storage role and no role
    chaining. `RoleSessionName` names the grant. GCP downscoping and Azure SAS
    are expected to work unchanged from a federated source credential, so GCP
    and Azure role connections sign pool storage as keys do (RFC 0043 O11).
    Neither has run yet; S14 verifies both.
  - **Known limits** (from earlier spikes):
    - Revocation stops new exchanges, after 71–101 seconds on GCP in the
      spikes. On AWS, deleting the stack ended live sessions within seconds in
      the spike. On GCP and Azure, issued tokens outlive revocation by up to 1
      hour and about 24 hours.
    - Retiring a signing key stops new exchanges on AWS within about 60
      seconds and on Azure at once, but GCP still accepted a removed key's
      tokens after 59 minutes, the end of the C26 spike's window; GCP's bound
      is unmeasured. S16's GCP arm waits for the bound that a longer spike
      measures, and a compromise response does not rely on it. That a new
      GCP provider ID, with the old provider deleted, starts without the old
      key cached is inferred, not run; S16's compromise arm proves it.
    - Permissions propagate slowly after setup: GCP IAM took 61 and 91 seconds
      before the first exchange, and Azure RBAC from 6 seconds to over 10
      minutes. The save-time check retries on GCP, and the first calls after
      setup retry `AuthorizationFailed` on Azure, saying they are waiting for
      Azure permissions.
    - A live migration of a running key connection is untested. It needs the
      new gateway credential types (AWS web identity, GCP external account,
      Azure client assertion) and changes the AWS storage coordination key,
      which `storageCoordinationPrefix` derives from the access key ID.
    - Untested so far: a token mounted into a Pod (the runs used TokenRequest),
      GCP organization policy, GCP reading the JWKS from
      the public issuer (the run passed it inline), and a GCP downscoped token
      or an Azure SAS minted from a federated credential.

- **Later.**
  - Per-role token grants. Input and output buckets are shared across Jobs, so
    only checkpoints are per Job:

    | Role       | Token scope                                                                        |
    | ---------- | ---------------------------------------------------------------------------------- |
    | Input      | the bucket; read and list                                                          |
    | Output     | the bucket; write and list, no delete                                              |
    | Checkpoint | the Job's checkpoint bucket or `<job-id>/` prefix; read, write and list, no delete |

- **Accepted limitations:** a region block lasts only for its Job, so each
  unpinned Job pays one fast denied call per denied region it tries before it
  lands. A deleted AWS key is reported invalid only after the fresh-key
  backoff, about 23 seconds.

## Required invariants

1. Provisioning a VM or node calls no identity or role-management API.
   _Enforcement: review — this RFC removes the identity from `newVM`'s
   parameters, and `test/unit/services/gateways/aws.spec.ts` will assert no
   IAM call; on Azure,
   `test/unit/services/gateways/azure.spec.ts` asserts `newVM` attaches no
   identity, and `test/unit/services/gateways/azure-anycloud-role.spec.ts`
   that the published role grants no role-assignment or identity action; GCP
   follows with Tracking item 4 in the same release._
2. Credential validation does not depend on the placement region.
   _Enforcement: review — the validation tests in
   `test/unit/services/gateways/aws.spec.ts` will hold it; today validation
   runs `DescribeVpcs` in the placement region._
3. `bad-credential` is reported only for a secret the provider does not
   recognize.
   _Enforcement: test — the "0047 invariant 3" classifier cases in
   `test/unit/services/gateways/aws.spec.ts`,
   `test/unit/services/gateways/azure.spec.ts` and
   `test/unit/services/gateways/gcp.spec.ts` classify each recorded denial as
   `permission-denied`, with the adjacent BadCredential cases keeping
   unrecognized secrets `bad-credential`;
   implemented._
4. On AWS, a region denied to an unpinned Job is not tried again for that Job, and the
   denial blocks it for no other Job.
   _Enforcement: test — test/unit/services/permission-denial.spec.ts
   ("0047 invariant 4") records a denial through the deploy step's classifier
   and the Job's own failure history, then resolves placement for that Job and
   another; implemented._
5. A running VM-host Job's or Service's minted storage token is renewed before
   it expires.
   _Enforcement: test — test/unit/services/service-storage-renewal.spec.ts
   renews a Job's and a Service's minted token five minutes before expiry, and
   test/unit/services/vm-runtime-storage.spec.ts re-mints before the final
   copy; implemented._
6. Every AWS action the gateway calls is allowed by the published
   `AnycloudAccess` policy.
   _Enforcement: test — test/unit/services/gateways/aws-anycloud-access.spec.ts
   ("0047 invariant 6") scans `src/` for AWS SDK commands and the actions the
   API writes into minted session policies, and compares them both ways with
   `src/shared/cloud-policies/aws-anycloud-access.json`; implemented._
7. A role connection stores no secret, only the identifiers in § Role
   connections plus the issuer URL, audience and subject.
   _Enforcement: review — no role connection exists yet; its save schema lands
   with the M16 implementation._
8. No AWS bucket token, from either connection kind, lasts longer than 12
   hours.
   _Enforcement: test — the "0047 invariant 8" cases in
   test/unit/services/gateways/aws-role-connection.spec.ts (role) and
   test/unit/services/gateways/aws-storage-creds.spec.ts (key) cap a request
   for longer at 12 hours; implemented._
9. A signing-key rotation, other than a compromise response, keeps the old
   and new public keys in the JWKS for at least the longest lifetime of a
   token the old key signed that is still in use (24 hours, with the
   installer's non-expiring token re-issued), then retires the old key.
   _Enforcement: review — no rotation exists yet; it lands with the M16
   implementation, and S16 proves it on AWS, GCP and Azure._
10. A role connection is saved only when its cloud trust pins the issuer,
    audience and subject: no wildcard and no issuer-only trust.
    _Enforcement: review — the save-time probe (§ Save-time check) lands with
    the M16 implementation; S17 proves the refusals on AWS, GCP and
    Azure._

On 2026-11-06 that is **0 of 10 verified wired, 5 cited, and 5 resting on
review**: invariants 1, 2, 7, 9, and 10.

## Acceptance scenarios

| ID  | Scenario                                                                                                                                                                                                                                                                                           | Required result                                                                                                                                                                                                                                                                                                                    | Coverage                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | AWS credential with `ec2:*` in three regions and no IAM; Job pinned to one of them.                                                                                                                                                                                                                | Job completes.                                                                                                                                                                                                                                                                                                                     | test:0047/S1 — test/integration/e2e/specs/contracts/dedicated-job/aws-restricted-credential.spec.ts runs a pinned `t3.small` Job on a pilot-shaped IAM user                                                                                                            |
| S2  | Same credential; Job with no region whose cheapest catalog region is denied.                                                                                                                                                                                                                       | Submit succeeds; Job runs in an allowed region.                                                                                                                                                                                                                                                                                    | test:0047/S2 — the same e2e member runs an unpinned `c6i.xlarge` Job and asserts an allowed region                                                                                                                                                                     |
| S3  | Same credential plus scoped S3 access; Job with a same-account output bucket.                                                                                                                                                                                                                      | Output reaches the bucket; no IAM call is made.                                                                                                                                                                                                                                                                                    | test:0047/S3 — the same e2e member reads the Job's output from a same-account bucket; test/unit/services/vm-runtime-storage.spec.ts asserts the minted token                                                                                                           |
| S4  | Azure service principal holding only the published Anycloud role (narrower than Contributor; amendment 6); Job with no bucket.                                                                                                                                                                     | Job completes.                                                                                                                                                                                                                                                                                                                     | review — becomes test:0047/S4 once azure-restricted-credential (test/integration/e2e/specs/contracts/dedicated-job/azure-restricted-credential.spec.ts, no bucket) passes live on the merge train                                                                      |
| S5  | AWS credential whose access key has been deleted.                                                                                                                                                                                                                                                  | After the bounded fresh-key backoff (about 23 seconds), submit fails with an invalid-credential message, not "Please retry".                                                                                                                                                                                                       | test:0047/S5 — test/unit/services/gateways/aws.spec.ts                                                                                                                                                                                                                 |
| S6  | Credential denied a non-regional action the gateway needs.                                                                                                                                                                                                                                         | Workload `invalid`, message names the denied action.                                                                                                                                                                                                                                                                               | test:0047/S6 — test/unit/services/permission-denial.spec.ts, an AWS, Azure and GCP denial on an unpinned Job                                                                                                                                                           |
| S7  | Same credential plus scoped S3 access; a VM-host Job and a VM-host Service, each with a same-account checkpoint or output bucket, running longer than one token's lifetime (12 hours on AWS); the Job then finishes.                                                                               | Sync keeps working past that lifetime for both; the Job's final copy uses a token re-minted at finalization.                                                                                                                                                                                                                       | test:0047/S7 — test/unit/services/service-storage-renewal.spec.ts renews a Job and a Service; test/unit/services/vm-runtime-storage.spec.ts asserts the final-copy re-mint                                                                                             |
| S8  | GCP service account without `iam.serviceAccounts.actAs`; Job with no bucket.                                                                                                                                                                                                                       | Job completes.                                                                                                                                                                                                                                                                                                                     | review — becomes test:0047/S8 once the gcp-\* e2e-job members, whose import credential holds only the published role and no `actAs`, pass live on the merge train                                                                                                      |
| S9  | Same AWS credential; Job pinned to a denied region, or with every candidate region denied.                                                                                                                                                                                                         | Workload `invalid`, message names the denied action and region.                                                                                                                                                                                                                                                                    | test:0047/S9 — test/unit/services/permission-denial.spec.ts, pinned and every-region cases                                                                                                                                                                             |
| S10 | AWS session credential, saved or inline at submit.                                                                                                                                                                                                                                                 | Rejected with a reason naming the session credential; nothing is stored or admitted.                                                                                                                                                                                                                                               | test:0047/S10 — test/unit/routes/credentials.spec.ts (save) and test/unit/routes/new.spec.ts (inline submit)                                                                                                                                                           |
| S11 | Azure and GCP credentials restricted to the minimal roles published in the docs (VM and bucket access only; on Azure, `listKeys` on the storage account, which must allow shared-key access); Job with a same-account output bucket, running longer than one GCP token's lifetime (about an hour). | Output reaches the bucket on both clouds, and GCP sync keeps working past the first token's expiry; no identity or role call is made.                                                                                                                                                                                              | review — becomes test:0047/S11 once azure-restricted-credential (published role) passes live on the merge train; GCP follows (item 4)                                                                                                                                  |
| S12 | AWS credential restricted to `AnycloudAccess`; spot Job with same-account input and output buckets.                                                                                                                                                                                                | Job completes.                                                                                                                                                                                                                                                                                                                     | review — recorded run, not a test: e2e-job run 37893779827 passed `aws-bucket-sync` (spot, same-account input and output), `aws-job-host-unreachable` (spot) and `aws-input-hydration-recovery` (on-demand), each on an imported user granted exactly `AnycloudAccess` |
| S13 | Newly created AWS access key that STS still rejects with `InvalidClientTokenId`, then accepts within the backoff.                                                                                                                                                                                  | Submit succeeds without a retry by the user.                                                                                                                                                                                                                                                                                       | test:0047/S13 — test/unit/services/gateways/aws.spec.ts                                                                                                                                                                                                                |
| S14 | Self-hosted API; a role connection saved on AWS, GCP and Azure through each cloud's setup template; Job with a same-cloud output bucket.                                                                                                                                                           | Save succeeds after the trial exchange; output reaches the bucket; nothing secret is stored.                                                                                                                                                                                                                                       | review — no role connection exists yet; becomes a test with the M16 implementation                                                                                                                                                                                     |
| S15 | AWS role left at the default 1-hour `MaxSessionDuration`, or a trust policy with the wrong audience or subject, saved as a role connection; or a local API.                                                                                                                                        | Save refused with a message naming `MaxSessionDuration`, the trust condition, or the missing ServiceAccount token.                                                                                                                                                                                                                 | review — no role connection exists yet; becomes a test with the M16 implementation                                                                                                                                                                                     |
| S16 | Self-hosted API with a role connection on AWS, GCP and Azure; the signing key is rotated: added, overlapped, then retired. Compromise arm: rotated with no overlap, and each trust revoked and recreated (GCP on a new provider ID after the old provider is deleted, or a new pool).              | During the overlap, tokens signed by the new key and by the old key exchange on all three clouds; after retirement, old-key tokens are refused on all three (GCP within its measured cache bound), and new-key tokens still exchange. Compromise arm: old-key tokens are refused on all three once the recreated trusts are saved. | review — no rotation exists yet; becomes a test with the M16 implementation                                                                                                                                                                                            |
| S17 | Self-hosted API; a role connection on AWS, GCP and Azure whose trust admits any subject, or any audience, or only names the issuer; and one whose trust is pinned.                                                                                                                                 | Pinned: save succeeds, and a token for another subject (`anycloud-trust-probe`) or another audience is refused by each cloud. Unpinned: save refused, naming the unpinned subject or audience.                                                                                                                                     | review — no role connection probe exists yet; becomes a test with the M16 implementation                                                                                                                                                                               |

The [restricted-IAM experiment](../experiments/aws-restricted-iam/README.md)
reproduces S1 and S2 live against a released binary until those specs land; it
records evidence and asserts nothing. Its Jobs use no bucket, so S3 and S7 rest
on the specs their coverage cites.

## Alternatives / open questions

- **One-click setup templates and Terraform** (a CloudFormation quick-create
  link, an ARM "Deploy to Azure" button, a Cloud Shell script, a Terraform
  module). Cut on 2026-10-08. SkyPilot and dstack publish minimal permissions
  in their docs only, and each template is another copy of the policy to keep
  in sync. The docs and the drift checks cover the admin-approval need.
  Superseded for role connections on AWS, GCP and Azure (amendment 9): each
  cloud's template is generated from its published policy or role. Terraform
  stays cut.

- **Keep the VM identity, attached only when a Job uses a same-cloud bucket.**
  No credential on the VM and little code, and Jobs without buckets need only
  VM permissions. Jobs with buckets still need identity and role management,
  every VM reaches every bucket, and the three identity bootstraps stay. A
  fallback if the GCP or Azure minters prove costly.
- **Customer-supplied identity** (the pilot's instance-profile request).
  No credential on the VM, and the credential needs only permission to attach
  that one identity (`iam:PassRole`, Managed Identity Operator or `actAs`). Its
  scope is whatever the customer grants, the same for every Job, so a
  checkpoint cannot be limited to its Job, and it adds a credential field and
  setup step. Revisit if a customer requires no credential on VMs.
- **Learned region blocks shared across Jobs, with a block window.** Cut. Each
  new Job would skip a known-denied region, but it needs new per-credential
  state and a window after which the region is retried. The per-Job block
  reuses the Job's failure history and costs one denied call per Job.
- **Different token lifetimes for VM-host and pool Jobs.** Cut. Pool Job
  lifetimes belong to RFC 0043; VM-host tokens last each cloud's minted
  lifetime (12 hours on AWS, amendment 10) and are renewed.
- **Explicit `--regions` on the credential.** Auditable, but must be kept in
  step with the provider policy. Add if customers ask for it after learned
  scope ships.
- **Probe regions at `credentials new`.** Twenty-plus calls up front, and stale
  when the policy changes.
- **Resolved (2026-10-09):** the first spot launch in an account
  needs `iam:CreateServiceLinkedRole` for `AWSServiceRoleForEC2Spot`. AWS
  creates that role automatically only for a console request and tells API
  callers to make sure it exists
  ([AWS documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/service-linked-roles-spot-instance-requests.html));
  without it `RunInstances` fails with
  `AuthFailure.ServiceLinkedRoleCreationNotPermitted`. `AnycloudAccess` grants
  it on that role's ARN with `iam:AWSServiceName` = `spot.amazonaws.com`, and
  `--generate` now attaches `AnycloudAccess`. The CI account already has the
  role, so no live run exercises the first launch.
- **Open:** Azure exposure is inferred from code. Confirming S4 live needs Azure
  credentials in the Spike workflow, a change on `main`.
- **Open:** VM Job checkpoints differ from RFC 0043's `<job-id>/` prefix
  ([`checkpoint.ts`](../src/shared/checkpoint.ts)). A managed spot checkpoint is
  already a bucket named after the Job; an explicit `--checkpoint-bucket` is
  used whole. Scoping the explicit case to a prefix changes where VM Jobs write
  checkpoints and is decided with the later per-role grants.
- **Dependency:** the per-Job credential spike
  no longer
  decides AWS minting from a role: a role connection mints with
  `AssumeRoleWithWebIdentity`, which is not role chaining and lasts 12 hours
  (amendment 8). It still decides whether a later prefix-scoped Azure token
  uses a directory SAS, which may need a hierarchical-namespace account.
- **Open (amendment 11):** GCP's JWKS cache bound. The C26 spike stopped at
  59 minutes with GCP still accepting a removed key. A longer `jwks-cache`
  spike measures it before S16 is written. If GCP has no bound within 24
  hours, the owner chooses between passing GCP providers the JWKS inline
  (each rotation then needs a GCP session to update them) and a new
  provider ID at every retirement, with the old provider deleted (or a new
  pool).
- **Open, outside 0.1.68:** how GCP and Azure organization region restrictions
  (`gcp.resourceLocations`, Azure Policy allowed locations) surface in each
  classifier.

## Tracking

All five items ship in 0.1.68.

1. AWS credential scope and diagnosis: region-free
   validation with the fresh-key retry, `PermissionDenied`, and the per-Job
   region block (S1, S2, S5, S6, S9, S13). Unblocks the pilot; no dependency on
   RFC 0043.
2. AWS storage without the instance profile: same-account
   buckets on minted tokens, renewed for running VM-host Jobs and Services and
   re-minted for the final copy; AWS session credentials rejected when saved,
   and inline at submit (S3, S7, S10).
3. Azure: drop the managed identity and role assignment; same-account buckets
   use the shared SAS minter from RFC 0043's pool storage, built here if
   it has not landed (S4, S11). Publish the minimal Azure role in the docs,
   with its drift check (S11).
4. GCP: drop the default service account attachment; same-account buckets use
   a downscoped-token minter, built here if RFC 0043's has not landed, and
   publish the minimal GCP role in the docs with its drift check (S8, S11).
5. `AnycloudAccess`:
   the policy JSON in the docs, the pull-request CI drift check, `--generate`
   attaching the policy, and one paid AWS run restricted to it (S12).

Later: per-role token grants.

Role connections (amendments 8 to 10) and the 12-hour AWS lifetime are
implemented under the M16 tracker, in issues filed
from it.

## Decision

Accepted on 2026-10-08 by the owner ("rfc 0047 approved"), and amended after
acceptance on 2026-10-08:

1. **Token lifetime.** VM-host Jobs keep today's 36-hour minted tokens, AWS
   `GetFederationToken`'s maximum, because they get no refresh during the run;
   pool Jobs keep RFC 0043's 12 hours and retry. Scenario S7 covers a VM-host
   Job running longer than 12 hours. Owner: "Keep 36h for VM Jobs".

2. **0.1.68 scope.** Owner: "I agree with your suggestion of puytting back
   those 2 things and I would also add azure/gcp". The release ships
   region-free validation with the fresh-key retry; removal of the AWS
   instance profile, with same-account buckets on minted tokens re-minted for
   the final copy; API renewal of minted tokens for running VM-host Jobs and
   Services, renewed before each token's own expiry, which replaces amendment
   1's "no refresh during the run" while keeping 36 hours per AWS mint (GCP
   downscoped tokens last about an hour); a per-Job block of a region denied to an
   unpinned Job, read from the Job's failure history; rejection of
   same-account buckets on session credentials until the per-Job credential
   spike settles `AssumeRole` (superseded by amendment 5); the `PermissionDenied`
   diagnosis; the `AnycloudAccess` policy, its CI drift check, `--generate`
   attaching it, one paid run and a
   CloudFormation quick-create link if it fits; and removal of the Azure and
   GCP VM storage identities, building their minters if RFC 0043's have not
   landed. Per-role token grants and the Terraform module move to Later.
   Learned cross-Job region blocks with a block window, and the 36h/12h
   lifetime split, are cut. Learned region scope is AWS-only in 0.1.68.
   Invariant 4 is now per Job, invariants 5 and 6 and scenarios S8–S13 are
   added, S4 is back in scope, and S7 now covers a Job and a Service running
   longer than 36 hours and the final-copy re-mint.
3. **Plain-language context.** The "Context: credential access in plain
   terms" section was added verbatim at the owner's request: "that
   explanation was amazing can you put it in rfc perhaps as context as is?"
4. **Docs-only publishing.** Owner, 2026-10-08: "terraform makes no sense",
   then "yes" to publishing minimal permissions in the docs only, after
   comparing SkyPilot and dstack. The CloudFormation link and the Terraform
   module are cut, and Azure and GCP publish their minimal roles in the docs
   with drift checks. S11 now runs with credentials restricted to those
   published roles. This supersedes those parts of amendment 2.
5. **Session credentials rejected at save.** Owner, 2026-10-08: "yes reject
   them". AWS session credentials are rejected when saved, and inline at
   submit, by both the CLI and the API, with no spot special case and no
   runtime fallback for VMs started before the upgrade. This supersedes
   amendment 2's admission-time rejection of same-account buckets on session
   credentials.
6. **Azure's restricted credential is the published role.** Owner,
   2026-10-09: "agree" that the Azure e2e member runs on the
   published Azure role, not Contributor. S4 and S11 share one per-run
   principal holding only that role, which is narrower than Contributor, so
   S4 on it also covers a Contributor-only principal. The role is one shared
   custom definition per version of the published JSON.

7. **The selected storage identity signs grants.** Owner, 2026-10-19:
   "Clarify that the selected storage identity signs grants; compute
   credentials need storage permissions only when explicitly used for that
   role." The account credentials stay in the API, and runners and VMs receive
   only scoped, temporary grants. This amends § Proposal, One minter, and the
   minting-permission trade-off, with RFC 0043's D-storage-credential.

8. **AWS role connections.** Owner, 2026-11-03: "adopt
   amendment 8 as drafted" and mint with `AssumeRoleWithWebIdentity` plus a
   session policy. As drafted: an AWS connection is either an IAM-user
   **key**, as today, or a **role**: a saved role ARN with no secret, usable
   only by an API that has a projected ServiceAccount token trusted by that
   role (the self-hosted API). The API gets
   compute sessions with `AssumeRoleWithWebIdentity`, refreshed by the SDK. It
   mints each bucket token with the same call, a fresh token and the grant's
   session policy, for up to 12 h, with no role chaining. Key connections keep
   `GetFederationToken` and 36 h (since amendment 10, 12 h). A saved or inline
   snapshot of session credentials (an access key with a `sessionToken`) is
   still rejected, as amendment 5 says. A role connection is checked at save
   with `GetCallerIdentity` and one 12 h trial mint. This amends amendment 5,
   the minting-permission trade-off, and § Dependency for AWS.

9. **Keyless role connections on AWS, GCP and Azure.** Owner, 2026-11-03: "Adopt,
   verify first", with the scope "focus on local and self hosted, drop hosted
   for now completely". Verified with a real K3s issuer on AWS
   and on GCP and Azure.
   GCP and Azure gain role connections like amendment 8's, trusting the same issuer, each with its one-click setup
   template, save-time check and known limits (§ Role connections). Keys stay
   the baseline. This supersedes, for these three clouds, amendment 4's
   docs-only publishing, the 2026-10-08 cut of one-click templates, and that
   day's deferral of keyless federation to an unfiled "stage 5".

10. **One AWS bucket-token lifetime: 12 hours.** Owner, 2026-11-03,
    Q4: key connections align to 12 h as well. `GetFederationToken`
    tokens drop from 36 to 12 hours, so both connection kinds share one lifetime, and
    VM-host and pool Jobs keep sharing it. For existing key connections, a pool
    Job survives an API outage of 6 hours instead of 18 and renews about every
    6 hours instead of 18; a VM-host Job's or Service's token renews about
    every 12 hours instead of 36 and lasts at most 12 hours once the API is
    unreachable. A leaked token lasts a third as long. This
    supersedes amendment 1's 36 hours, and the AWS row of RFC 0043's
    § Lifetime and renewal table and D-lifetime.

11. **Signing-key rotation and pinned trust.** Owner, 2026-11-06: two explicit
    requirements of the role-connection work. First, a documented, tested
    rotation of the issuer signing key, which K3s never rotates itself: the
    operator runs it, recommended every 90 days, with an add command and a
    retire command that it refuses until 24 hours later, so both keys stay in
    the JWKS for at least that overlap; on suspected compromise the operator
    rotates at once and revokes each cloud's trust, recreating GCP's on a
    new provider ID after deleting the old provider (or in a new pool),
    since the impersonation binding admits every provider in its pool.
    Second, every trust pins the issuer, audience and subject, and the
    save-time check proves it by requiring each cloud to refuse another
    subject's token and another audience's. This adds § Signing-key rotation,
    the trust-pinning probe in § Save-time check, invariants 9 and 10, and
    scenarios S16 and S17, and removes signing-key rotation from the untested
    list.

The other changes after acceptance are conformance and editorial: the
invariant and scenario annotations now follow RFC 0025, the restricted-IAM
experiment's README and cleanup were brought up to date, and a wording
correction below says scenario tests go under `test/`, not in the experiment.
On 2026-10-09 an earlier change resolved the spot service-linked-role
question, cited invariant 6's test and S12's run, and shipped it.

Implementation follows the Tracking order. Rows A3 and A4 of the
Smoother agent onboarding milestone (release 0.1.68) deliver the AWS
items; Tracking items 3 to 5 ship in the same release. Each starts by turning
its acceptance scenarios into tests under `test/`, failing on `main` before the
fix.
