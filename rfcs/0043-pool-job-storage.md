# RFC 0043: Storage for pool Jobs

> Status: Accepted
> Date: 2026-10-13
> Updated: 2026-11-03
> Author: Claude draft, for Luis Fernando De Pombo

## Summary

Pool Jobs refuse buckets today, and the batch customer's ML Jobs can't leave VM Jobs
without inputs, outputs and checkpoints. Under
[RFC 0044](./0044-one-pool-runtime.md)'s decision 26, a pool Job runs as a
targeted Job on a managed Deployment, and the **runner** in each replica claims
one Job at a time. This RFC says how that runner moves the Job's data:

- the Job sees VM Jobs' fixed paths, `/mnt/input`, `/mnt/output` and
  `/mnt/checkpoint`;
- the runner stages inputs and restores the checkpoint before the command
  starts, uploads outputs and checkpoints about every 60 s, and runs a final
  upload before it reports the outcome, so a Job completes only after its final
  upload;
- outputs and an explicit checkpoint bucket's checkpoints live under the Job's
  own `<bucket>/<job-id>/` prefix (O10), and there is no `--checkpoint-prefix`
  (D-prefix);
- a Job on a spot pool with no `--checkpoint-bucket` gets a managed checkpoint
  bucket named after the Job, as VM spot Jobs do, and is refused when it has
  no supported checkpoint storage (D-managed);
- the API mints per-Job, per-role storage credentials limited to those
  prefixes or the managed bucket, returns them in the claim and renews them
  through the execution. They are never written to a Secret, the Pod spec,
  disk or logs;
- the minter is provider-neutral, with three storage backends (O26, amended
  2026-10-22 by D-s3gcs): an Azure directory SAS, an AWS STS federation token
  whose session policy names the prefix, and a GCS token downscoped by a
  Credential Access Boundary on the prefix. Each is signed by a storage
  credential the API selects for each role, independently of the pool's
  compute provider (O11). An explicit storage credential selects it; otherwise
  the pool's compute credential serves the role when it can provide storage;
- on H100 and A100 the fixed paths sit on local NVMe (ST2b), so a preempted
  Job re-stages its inputs at NVMe speed (RS).

There are no helper containers and no per-Job Secret: the earlier helper design
went with RFC 0044's batch Pod owner. RFC 0044 counts the runner's storage code
in PR 6 (ST1a); this RFC adds ST1b's minter and renewal and ST2b's disk.

## Context

### VM Jobs today

VM Jobs' three mounts and their sync are in
[Buckets](../docs/platform/buckets.md). The sync runs on the VM over SSH, with a
scoped token per bucket since RFC 0047 (`mintScopedStorageToken` in
`gateways/cloud.ts`): a container SAS (`mintSas` in `gateways/azure.ts`, signed
by `azureContainerSas` in `provider-clients/azure.ts`), an STS federation token
whose session policy names the bucket (`s3BucketStatement` and
`mintFederationToken` in `gateways/aws.ts`), or a GCS token downscoped to the
bucket (`mintGcpDownscopedToken` in `provider-clients/gcp.ts`), renewed five
minutes before it expires (`vm-runtime-storage.ts`). Only Azure's limits a
prefix, through `azureDirectorySas` since ST1b; AWS's and GCP's cover whole
buckets. Pool Services and targeted Jobs refuse buckets
(`node-pool-service-admission.ts`, `submit.ts`).

RFC 0044's [§ Pool Jobs on managed
Deployments](./0044-one-pool-runtime.md#pool-jobs-on-managed-deployments)
fixes the runner loop, the states, the outcome table and the reset; this RFC
adds only what the 2026-10-13 note leaves to it.

### Evidence

- **Per-Job credentials** (the per-Job credential spike): an Azure
  directory SAS (`sr=d`) with `rcwl` enforces its prefix on flat and
  hierarchical-namespace accounts alike, signed with the account key or a
  user-delegation key; a container SAS doesn't limit the prefix. Delete is
  refused, but overwrite isn't. AWS `GetFederationToken` with a prefix session
  policy enforces the prefix, capped at 1 h on root keys.
- **GCS prefix grants** (Google's documentation, not yet a spike; ST1b-s3gcs's
  S18 tests both points on real GCS): a Credential Access Boundary limits
  object reads and writes with `resource.name.startsWith(...)`, and listing
  with a condition on the `storage.googleapis.com/objectListPrefix` API
  attribute, since a list's resource is the bucket
  ([Credential Access Boundaries](https://cloud.google.com/iam/docs/downscoping-short-lived-credentials)).
  Overwriting an existing object needs `storage.objects.delete` as well as
  `create` ([IAM permissions](https://cloud.google.com/storage/docs/access-control/iam-permissions)),
  and a downscoped token lives no longer than its source token, one hour.
- **Transfers on a warm Deployment** (the shared-Deployment storage
  evaluation): per-Job staging, upload, cleanup, cancellation and upload-failure
  recovery, with the MACE e2e. It ran the transfers over Kubernetes exec; the
  runner runs the same logic in the replica.
- **Re-stage speed** (spike S5): a full
  re-stage of 527 GB onto local NVMe takes about 9 min with rclone's default
  flags, which the runner reuses, and about 2 min with tuned flags (M12), extrapolated
  from 75 GB, where today's VM move re-syncs at the OS disk's throughput cap.

## Proposal

### Smallest useful release

In milestone 4 (Pool Jobs for
batch work), a batch-customer
agent runs:

```bash
anycloud job <image> --node-pool P --gpus 1 \
  --input-bucket <dataset> --output-bucket <results> \
  --checkpoint-bucket <state> -- python train.py
```

The command reads `/mnt/input`, writes `/mnt/output` and `/mnt/checkpoint`, and
after a spot preemption its retry restores the last uploaded checkpoint.
Out of scope: everything under § Later, a node input cache, and any change to
VM Jobs.

### Layout

1. **Input** is the whole input bucket, read-only, as on VM Jobs (D-input).
2. **Output** goes to `<output bucket>/<job-id>/`. This differs from VM Jobs,
   which copy to the bucket's root: Jobs share a replica's container and can
   read their own credentials, so a prefix per Job is what keeps one Job from
   overwriting another's results. The docs say so when ST1a ships.
3. **Checkpoint**, restored into `/mnt/checkpoint` before every attempt, is
   `<checkpoint bucket>/<job-id>/` with `--checkpoint-bucket` (O10). A Job on
   a spot pool without it gets a managed bucket named after the Job, used from
   its root, as on VM spot Jobs (D-managed): the API creates the bucket before
   the first claim (`ensureManagedWorkloadCheckpoint`) and deletes it with the
   Job's record (`cleanupManagedWorkloadStorage`). The bucket lives where the
   Job's selected checkpoint credential puts it:
   `--checkpoint-storage-credentials` chooses that, with or without
   `--checkpoint-bucket`. Whether a Job gets one follows from the pool's spot
   mode and whether that credential provides supported storage (O26), not
   from the pool's compute provider. A spot Job with neither a
   `--checkpoint-bucket` nor a credential that provides supported storage is
   refused at admission on every provider, as VM spot Jobs are on a provider
   with no native storage. Since D-s3gcs an AWS or GCP spot pool's compute
   credential provides supported storage, so its Job's managed bucket is an S3
   or GCS bucket in the pool's account; a compute-only provider's spot pool,
   or an AWS compute credential that can't mint (§ Credentials, AWS), still
   needs `--checkpoint-storage-credentials`.
   Cleanup uses the credential and region persisted at admission
   (§ Admission), so it works after the pool is deleted. There is no
   `--checkpoint-prefix` (D-prefix).

The Job ID is the prefix, so a Job resubmitted with the same `--id` after its
record is deleted writes over the old outputs and, with an explicit checkpoint
bucket, restores the old checkpoint; a managed bucket went with the record.

### Credentials

**The minter.** The storage provider's `mintScopedStorageToken` (RFC 0047)
gains a requested lifetime; the grant's `prefix` and `noDelete` already exist
on main (`ScopedStorageGrant`), honored only by Azure:

```ts
mintScopedStorageToken(
  grants: Array<{
    bucket: string;
    prefix?: string;
    mode: 'read' | 'readwrite';
    noDelete?: true;
  }>,
  options?: { lifetimeMs?: number },
): Promise<ScopedStorageToken | undefined>; // { credentials, expiresAt }
```

`read` is for inputs and `readwrite` for outputs and checkpoints. The
interface names no provider's permissions: `rl` and `rcwl` belong to the Azure
implementation. `noDelete`, which `mintPoolJobGrants` sets on every pool
grant, means: the grant overwrites but never deletes where the backend can
overwrite without delete (Azure, S3), and otherwise deletes only inside the
grant's own prefix, or its bucket when it has none (GCS). Every minter honors
it, so the caller never branches on the provider (invariant 6), and the GCS
minter documents and tests that meaning (S18). ST1b-s3gcs rewrites
`ScopedStorageGrant`'s `prefix` and `noDelete` docstrings to this meaning.
Refusing `noDelete` on GCS was
the alternative; it was not chosen, because the caller would then have to know
which backends can't serve it, and GCS would end with the same scoped delete
anyway (§ Decided, 1).

A provider may return a shorter expiry than asked for, and
every caller schedules renewal from the returned `expiresAt`. The VM sync keeps
calling it without a prefix. AWS and GCP implement the prefix in ST1b-s3gcs
(D-s3gcs, below); R2 (CF3,
`prefixes` and
`object-read-only` or `object-read-write`) implements the same call later.

**Azure** (ST1b). One grant mints one SAS, signed with the account key from
`listKeys`, as `mintSas` already does:

| Role       | SAS                                            | Permissions |
| ---------- | ---------------------------------------------- | ----------- |
| Input      | container SAS on the input bucket              | `rl`        |
| Output     | directory SAS (`sr=d`, `sdd=1`) on `<job-id>/` | `rcwl`      |
| Checkpoint | directory SAS (`sr=d`, `sdd=1`) on `<job-id>/` | `rcwl`      |
| Managed    | container SAS on the Job's own bucket          | `rcwl`      |

There is no `d`, so rclone copies upload-only and never deletes. rclone needs
`r` and `l` beside `cw` (ST1b confirms `rcwl` and `rl` with the real rclone).
A user-delegation key, which would also serve accounts with shared-key access
disabled, is Later; until then such an account is refused at admission with
the existing `azureSharedKeyDisabledError`.

**AWS** (ST1b-s3gcs). One grant mints one STS `GetFederationToken`, as VM
Jobs' `mintFederationToken` already does, signed by a long-term IAM user key.
`s3BucketStatement` gains the prefix and `noDelete`:

| Role       | Session policy                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input      | VM Jobs' `read` statement: `s3:ListBucket` and `s3:GetBucketLocation` on the bucket, `s3:GetObject` on `<bucket>/*`                                                                |
| Output     | `s3:ListBucket` on the bucket with `s3:prefix` limited to `<job-id>/`; `s3:GetObject`, `s3:PutObject` and `s3:AbortMultipartUpload` on `<bucket>/<job-id>/*`; no `s3:DeleteObject` |
| Checkpoint | as Output                                                                                                                                                                          |
| Managed    | as Output on the Job's own bucket, without the prefix                                                                                                                              |

A `PutObject` overwrites without `DeleteObject`, so S3 matches Azure: overwrite
allowed, delete refused. `AbortMultipartUpload` only discards an unfinished
upload of rclone's own. The Output `ListBucket` statement's condition is exactly
`"Condition": {"StringLike": {"s3:prefix": ["<job-id>/", "<job-id>/*"]}}`, so a
list of the bucket's root or another Job's prefix is refused. Each role mints
its own token, so each session policy holds only that role's statements, about
500 characters, well under `GetFederationToken`'s 2,048-character limit. The
effective permissions are the intersection of the session policy and the IAM
user's, so the IAM user needs the actions above on the buckets and
`sts:GetFederationToken`, as VM Jobs' cross-cloud sync already does. A
credential with a `sessionToken` (SSO or another STS session) can't call
`GetFederationToken`, so `validateScopedStorageTokenSource` refuses it at
admission, as for VM Jobs. An AWS role connection mints with
`AssumeRoleWithWebIdentity` instead (RFC 0047 amendment 8; § Alternatives).

**GCS** (ST1b-s3gcs). One grant mints one token downscoped from the service
account key, as `mintGcpDownscopedToken` already does, or from a GCP role
connection's federated token (RFC 0047 amendment 9; downscoping a federated
token is untested until RFC 0047's S14). The prefix becomes the rule's
`availabilityCondition`:

| Role       | Access boundary rule                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input      | VM Jobs' `read` rule: `inRole:roles/storage.objectViewer` on the bucket, no condition                                                                               |
| Output     | `inRole:roles/storage.objectUser` on the bucket, if `resource.name` starts with `projects/_/buckets/<bucket>/objects/<job-id>/` or the list prefix with `<job-id>/` |
| Checkpoint | as Output                                                                                                                                                           |
| Managed    | `inRole:roles/storage.objectUser` on the Job's own bucket, no condition                                                                                             |

GCS can't overwrite without delete: replacing an object needs
`storage.objects.delete`, and the runner replaces checkpoint files every minute.
So the GCS minter serves `noDelete` as the interface defines it (§ The minter):
the grant deletes inside the Job's own prefix or managed bucket, and nowhere
else (invariant 2, amended). rclone copy itself never deletes; the difference is
only what a command that reads its grant can do (§ Risks). The grant needs no
IAM permission beyond the service account's own on the bucket, but the project
must have the Security Token Service API enabled, as VM Jobs' sync already
requires.

New GCS buckets keep a replaced or deleted object for 7 days as a billed
soft-deleted copy
([soft delete](https://cloud.google.com/storage/docs/soft-delete)). A
checkpoint rewritten every few minutes would multiply a bucket's billed
storage, so ST1b-s3gcs creates managed GCS checkpoint buckets with soft delete
off (a retention of 0). User buckets keep their own policy; the docs state the
cost and how to turn it off on a checkpoint bucket. The same feature softens
the GCS delete: a deleted or overwritten object in a user's bucket stays
recoverable for 7 days unless its owner turned soft delete off.

**Reuse.** As ST1b-cred did for Azure, the pool path reuses VM Jobs' code:
`resolveStorageCredential`, `loadWorkloadStorageCredentials`,
`validateWorkloadStorageRequest` (with `validateStorageCapabilities`),
`resolveWorkloadStorage` and its `resolveRuntimeBucketStorageRegions`,
`validateExistingWorkloadStorage`, `ensureWorkloadOutputStorage`,
`ensureManagedWorkloadCheckpoint`, `cleanupManagedWorkloadStorage`,
`readWorkloadCheckpointHealth`, each provider's `upsertBucket`, `hasBucket`
and `classifyStorageFailure`, `rcloneEnvVars`, and the two minters above. What
is new:

- the prefix and `noDelete` in `s3BucketStatement`, and the prefix condition in
  `mintGcpDownscopedToken`, each a few lines in its provider's gateway;
- `mintPoolJobGrants` takes each provider's rclone remote and env instead of
  refusing everything but Azure. `rclone-config.ts` builds them, beside
  `rcloneEnvVars` and `GCS_REMOTE`, so each remote has one owner:
  `s3:<bucket>/<prefix>` with
  `RCLONE_CONFIG_S3_TYPE=s3`, `PROVIDER=AWS`, `NO_CHECK_BUCKET` and
  `rcloneEnvVars`' `AWS_*` and region; and
  `gcs:<bucket>/<prefix>` with `RCLONE_CONFIG_GCS_TYPE=google cloud storage`,
  `BUCKET_POLICY_ONLY`, `NO_CHECK_BUCKET` and the token as
  `RCLONE_CONFIG_GCS_TOKEN`, built from the JSON `rcloneTokenConfig` writes;
- `validateStorageCapabilities` accepts an explicit GCP storage credential on
  the pool path, where the trial mint proves it, and keeps refusing it for VM
  Jobs (that widening stays a separate decision, as its comment says).

VM Jobs' token in a file (`rcloneTokenConfig`) exists so a long-running sync
re-reads a renewed token. The runner starts a new rclone child for each copy,
so the token rides that child's env, like the Azure SAS and the AWS session,
and never a file (invariant 3).

**Signing credential** (O11, amended 2026-10-19 by D-storage-credential). The
API resolves an explicit storage credential independently for each role. A
named `--input-storage-credentials`, `--output-storage-credentials` or
`--checkpoint-storage-credentials` selects the role's credential, a managed
checkpoint bucket included. Without one, the pool's compute credential serves
the role only when it can provide pool storage: an Azure compute credential, an
AWS long-term IAM user key or role connection, or a GCP service account key
or role connection (D-s3gcs, O11; RFC 0047 amendments 8 and 9). A role it
can't serve needs an explicit credential, and admission refuses the Job without
one. So a Job on any pool can keep each role's data in an Azure storage
account, an S3 bucket or a GCS bucket: storage limits the backend (O26), never
the compute provider. This is what lets compute-only pool providers, which
offer GPUs, often spot, but no storage service Anycloud supports, run
bucket-backed pool Jobs, with their storage on an independent account.
Explicit named credentials come first; an automatic platform-wide storage
account is a separate product decision and is not needed for this separation.

Pool Nodes have no instance identity, so the API holds the account
credentials, as it holds compute credentials, and a runner receives only
scoped, temporary grants (§ Where they live). That keeps one path for every
compute provider, and owning the accounts keeps onboarding simple.

Until ST1b-cred
lands, admission refuses a storage credential on a pool Job, and only an Azure
pool's compute credential signs (the deferral of 2026-10-17). That follow-up
supersedes the deferral.

**Lifetime and renewal.** Pool Job credentials ask for VM Jobs' lifetime: 36 h
on Azure and 12 h on AWS (D-lifetime). The runner renews all of a Job's
credentials through the execution once half of the earliest one's lifetime has passed, and retries
every minute after a failed renewal, so an API outage shorter than half the
earliest lifetime never interrupts a Job. What each backend returns:

| Backend | Lifetime                                                                                                                   | Outage a Job survives     |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Azure   | 36 h, the SAS expiry the API signs                                                                                         | 18 h                      |
| AWS     | 12 h for a key or a role connection (RFC 0047 amendment 10; VM Jobs' `SCOPED_STORAGE_CRED_TTL_SECONDS`); 1 h on a root key | 6 h; 30 min on a root key |
| GCS     | 1 h, the source token's; every mint signs a new source token, so each renewal gets a full hour                             | 30 min                    |

A Job with any role on GCS renews every 30 min, and an API outage longer than
that stops its command (D-lifetime, amended by D-s3gcs). A longer GCS
lifetime needs a service account token extended up to 12 h under an
organization policy, which is Later.

**Transfers that outlive a grant.** Each rclone child holds the grant it
started with. A stage of a large input on GCS can run past that grant's
expiry. On GCS, rclone checks the token JSON's `expiry` before each request
and fails locally with "token expired and refresh token is not set", sending
nothing; only a request already in flight at expiry gets a 401. On S3 the
request gets `ExpiredToken` (HTTP 400). The runner must classify both as
`failed`, not `denied`, so it retries with the renewed grant, which it already
holds. Today's classification does, since neither matches `DENIED`, unless
rclone exits 7 (fatal); ST1b-s3gcs checks both backends' exit code and message
with the real rclone (S19). A 403 stays `denied`: S3 answers a forged or
revoked token with `InvalidAccessKeyId` (403), which no retry fixes. The retried
`rclone sync` or `copy` skips the files already transferred, so the cost is
the one file in flight, at most once an hour. No new runner loop is needed;
ST1b-s3gcs adds the classification test. The renewal call is behind the
execution fence (RFC 0044 invariant 10): once the execution has ended, renewal
is refused. If a credential expires before a renewal succeeds, the runner
stops the command and the Job goes `retrying`, as RFC 0044's outcome table
says.

**Where they live.** The claim and renewal responses carry, per role, the
storage provider's rclone remote (provider type, Azure account, endpoint,
region), the bucket, the prefix, the credentials and `expiresAt`. Each role
has its own remote and env, so one Job's roles can sit on different backends. The runner
keeps them in memory and passes them to each rclone child as environment
variables (`rcloneEnvVars`). They never reach a Secret, the Pod spec, the
command's environment, a file or a log, and the reset drops them (see Risks
for what the command can still read).

### Transfers in the runner

The runner (ST1a) follows RFC 0044's loop, reusing the evaluation's transfer
logic and the VM sync's rclone flags (`rcloneCopyCommand`). What this RFC adds:

- **Remotes.** Stage syncs the input bucket into `/mnt/input` (D-reuse) and
  copies the checkpoint prefix, or the managed bucket, into `/mnt/checkpoint`;
  uploads copy `/mnt/output` and `/mnt/checkpoint` back to the same places.
- **Staging.** An empty or missing checkpoint prefix, or an empty managed
  bucket (every first attempt), is not an error. A missing bucket or a denied
  read is terminal `invalid`. As on VM Jobs there is no fixed deadline: a copy
  with no progress for 15 min is stopped and retried.
- **Periodic uploads** that fail are retried on the next tick and never fail
  the Job.

### Admission

ST1a lifts the bucket refusal for Jobs on managed Deployments only; targeted
Jobs on user Deployments keep refusing buckets. For a pool Job with buckets,
or on a spot pool (its managed checkpoint bucket), admission (ST1b's checks, in
PR 8's pool Job admission):

- selects each role's storage credential (O11) and refuses the Job when a
  role with a bucket has no credential that can provide storage, or when a
  Job on a spot pool has no `--checkpoint-bucket` and its checkpoint role has
  no such credential (D-managed);
- refuses a bucket, or a `--checkpoint-storage-credentials` given for a
  managed bucket, whose selected credential's storage provider has no prefix
  minter, naming the provider and the supported ones (O26): Azure, AWS and GCP
  since D-s3gcs, so R2 and Local today. The pool's compute provider plays no
  part;
- applies VM Jobs' bucket rules: the input and an explicit checkpoint bucket
  must exist, the output bucket is created when missing, and the three roles
  name different buckets, none of them the API's backup bucket
  (`validateWorkloadBucketRoles`), and a managed bucket needs a Job ID that is
  a valid bucket name;
- checks that the signing credential can mint
  (`validateScopedStorageTokenSource`, then a trial mint): an AWS credential
  with a `sessionToken`, a GCP project without the Security Token Service API
  and a shared-key-disabled Azure account are refused here, with VM Jobs'
  messages;
- creates a managed checkpoint bucket last, once every other check has
  passed, so a refused Job leaves none (D-managed, amended by D-s3gcs). S3 and
  GCS bucket names are global, unlike Azure containers, so a Job ID such as
  `train-1` is often taken. Main's `upsertBucket` can't tell: it reads the
  bucket first, so another owner's name answers 403, which it rethrows, or,
  in another S3 region, 301, which it reuses as ours. The managed path
  therefore creates first and classifies the create's answer, never a HEAD or
  bucket read: S3 `BucketAlreadyOwnedByYou` (or a 200 in us-east-1) and GCS
  409 "you already own" reuse the bucket; S3 `BucketAlreadyExists` and GCS
  409 "not available" are a taken name, so a foreign bucket is never adopted.
  GCS gives both answers reason `conflict`, and the "not available" text is
  observed, not documented, so on "you already own" admission also reads the
  bucket's metadata and treats a `projectNumber` other than the credential's
  project as a taken name. The API stores only the project ID, so admission
  reads the credential's project number with Resource Manager's
  `projects.get`, which needs `resourcemanager.projects.get`; a number or
  bucket metadata it can't read is refused, never reused. A reused S3 bucket's region is read with
  `GetBucketLocation`, since an owned bucket may be in another region. A
  taken name answers 409, so a create's 403 is most often a missing
  `s3:CreateBucket` or `storage.buckets.create`, but it can also be a GCS
  project whose billing is disabled (`accountDisabled`) or an SCP or
  org-policy deny. Admission refuses it naming the role and that permission,
  followed by the provider's reason, so a billing 403 isn't reported as a
  missing permission.
  Admission refuses a taken name with "Pass `--checkpoint-bucket` or choose a
  different `--id`", the wording VM spot Jobs use for an invalid name (on
  main a VM spot Job with a taken name fails at provisioning with the raw
  error). The claim's idempotent `ensureManagedWorkloadCheckpoint`, which
  recreates a bucket cleanup deleted, uses the same classification; a taken
  name there, possible only if the name was lost after admission, ends the Job
  terminal `invalid` with the same message. If the record insert fails after
  the create, admission never deletes the bucket: the create can't prove it
  made it (us-east-1 answers 200 to a create and a reuse alike), and even a
  bucket it did make may already hold the checkpoints of a concurrent submit
  with the same ID that won the insert. An empty bucket left by a failed
  insert costs nothing beyond a place in S3's per-account bucket quota, and no
  sweep reclaims it: it has no `anycloud_ended_at` tag and no Job record, so
  it stays until the user deletes it or resubmits with that ID, which reuses
  it and deletes it with that Job;
- persists each role's selected credential and storage region on the Job's
  record, the compute credential's included when it serves a role. The region
  is the bucket's own as `resolveRuntimeBucketStorageRegions` finds it (an S3
  bucket's region; the request's or the pool's for Azure, GCS and a managed
  bucket's creation; a reused S3 bucket's own), so claim and renewal never look it up again.

Validation, the claim, renewal, `status`'s checkpoint health and cleanup all
read that persisted selection, never the pool's current credential or region,
so an API restart or a deleted pool doesn't change which storage identity a
Job uses.

Buckets arrive in the claim, so they don't enter the managed Deployment's shape
key, and Jobs with different buckets share replicas. The existing checkpoint health
lists only `<checkpoint bucket>/<job-id>/` for a pool Job with an explicit
bucket, and the whole managed bucket otherwise, and
`loadWorkloadConfigs` resolves its storage credentials.

### Cross-cloud storage and egress

Any pool provider (AWS, Azure, GCP, Lambda) can use any backend (Azure, S3,
GCS) for any role, and a Job's three roles may use three backends:

| Pool   | Default for a role with a bucket                 | Other backends                 | Managed checkpoint bucket on a spot pool                   |
| ------ | ------------------------------------------------ | ------------------------------ | ---------------------------------------------------------- |
| Azure  | the compute credential, Azure storage            | `--<role>-storage-credentials` | Azure, or where `--checkpoint-storage-credentials` puts it |
| AWS    | the compute credential, S3 (a long-term IAM key) | `--<role>-storage-credentials` | S3, or as Azure                                            |
| GCP    | the compute credential, GCS                      | `--<role>-storage-credentials` | GCS, or as Azure                                           |
| Lambda | none: every role names a storage credential      | `--<role>-storage-credentials` | no spot                                                    |

The same-cloud default keeps data where the pool's provider bills no egress
when the bucket is in the pool's region. Anything else pays the storage
provider's internet egress on every stage, at list prices about $0.09/GB from
S3, $0.087/GB from Azure and $0.12/GB from GCS (premium tier), or
inter-region rates within one provider. For W1's 527 GB dataset that is about
$45–65 per full stage, paid again on every retry on a new replica (46% of GPU
Jobs were preempted) and on every replica that stages it (D-reuse). Uploads
into a bucket are free on all three. Admission doesn't warn or refuse: the
user chose the bucket, and the docs for ST1b-s3gcs state the cost and
recommend a same-cloud, same-region input bucket for large inputs. A shared
per-Node input copy (Later) cuts the per-replica part.

### Disk

The three paths are emptyDir volumes on the kubelet's filesystem, so pool disk
sizing decides how much a Job can stage. ST2b:

- On H100 and A100, a per-boot unit mounts the raw NVMe (RAID 0 when there are
  several devices) at `/var/lib/kubelet` and containerd's directory before
  `k3s-agent` starts (`RequiresMounts`), so images, writable layers and
  emptyDirs share one filesystem. Image layers use it outside any Pod's
  limit.
- On sizes without NVMe (T4), kubelet scratch goes on the configurable OS disk
  (OD).
- `kube-reserved` and `system-reserved` are set per VM class, on new Nodes
  only. Each class's `ephemeral-storage` reservation includes an allowance
  for images, so allocatable is what replicas can use and the fractions below
  never add up to more than the disk minus the allowance. ST2b sizes the
  allowance per class to cover the images it expects. Otherwise a full Node
  reaches DiskPressure, and kubelet evicts a replica of its own choosing
  before any replica reaches its limit. ST2b's tests or EX4 confirm K3s's
  accounting on the shared filesystem before ST2b fixes the allowance; RFC
  0044's 100 GB GPU disk is the tight case.
- Each managed replica requests, and is limited to, a fraction of the Node's
  allocatable `ephemeral-storage`: its GPU fraction on GPU pools and its CPU
  fraction on CPU pools, with no flag (D-disk). Those fractions sum to at most
  one Node, so disk never stops replicas packing that GPUs or CPUs allow.
- The limit covers the container's writable layer as well as the three
  paths: the image's own changes, what `git pull` adds, and the reset's copy
  of the working directory taken at replica start (RFC 0044), which doubles a
  working directory's footprint. A replica past its limit is evicted, and its
  Job ends terminal `invalid` (RFC 0044's outcome table).

ST2b and RFC 0044's PR 9 both edit the pool join script; ST2b owns the
per-boot NVMe unit, and the two PRs are sequenced.

**Re-stage after preemption** (RS). NVMe is wiped
when a VM is deallocated, and spot pools delete evicted VMs, so a retried Job
always re-stages its whole input. On NVMe that takes about 9 min for 527 GB
with the runner's flags, and about 2 min once the flags are tuned (spike
S5). The reset keeps `/mnt/input` for a next Job of the same input bucket, which
syncs only what changed (D-reuse); a Job of another bucket, or with no input,
finds it empty, and a new replica stages it again. A shared per-Node input copy
is a planned M12 follow-up.

### Workload fit

This section applies the workload-fit convention to the batch customer's Jobs. The
evidence is the customer notes, RFC 0044's § Customers, the aggregate Job
profile behind its decision 26, the storage evaluation, spike S5 and the JAX
cache row. The
customer records stay outside this repository; below they carry no bucket,
image, host or Job names.

| #   | Batch customer's workload                                                                                                                                                                                                            | Spec                                                                                                                                                                                                                                                                                                                   | Served                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Training on a 527 GB dataset of 161 shards, which about 80 Jobs read, up to 14 at once. VM Jobs give each a 1.5 TB high-tier disk, and a move to a new VM after preemption re-syncs the whole dataset in 45–60 min                   | the whole input bucket, read-only, in `/mnt/input`; on H100 and A100 it is staged onto local NVMe within the replica's GPU fraction of the Node's disk (D-disk), and a retry on a new replica, or a Job of another input bucket, re-stages it: about 9 min with the runner's flags, about 2 min after tuning the flags | Yes, on a size whose per-GPU share of the disk holds the dataset and the writable layer (S11 and S12, in EX4). Without NVMe, only with OD's configurable disk sized as VM Jobs' (RFC 0044's 100 GB GPU disk can't hold it), and a re-stage there runs at the OS disk's cap, about 37–40 min on a P40 (S5). A share too small evicts the replica and ends the Job `invalid`; the disk flag is Later (D-disk). Each replica stages its own copy, once per input bucket (D-reuse); a shared per-Node copy is planned for Later (M12) |
| W2  | Spot Jobs that checkpoint and resume: 46% of GPU Jobs were preempted, and most Azure re-runs are restarts on the same VM, which keep its disk and recover in about 30 s                                                              | the checkpoint restored from `<checkpoint bucket>/<job-id>/`, or from the managed bucket on a spot pool with no `--checkpoint-bucket` (D-managed), before every attempt; uploads about every 60 s and a final upload                                                                                                   | Yes for the checkpoint. **No** for the same-VM restart: a pool deletes evicted VMs, so every retry re-stages on a new Node (W1). RD (Later, M12) retries on the deallocated VM and keeps its OS disk (the node cache, and images on sizes without NVMe), but the replacement replica's paths are new, so the input still re-stages                                                                                                                                                                                                |
| W3  | Fan-out batches: agents submit one command over many inputs, always with `--id`, and a median GPU Job runs about 107 min. In a sample of 1,000 Jobs, 980 used 27 input buckets and 997 used 44 output buckets, so Jobs share buckets | inputs as in W1; outputs under `<output bucket>/<job-id>/` (§ Layout, item 2), where the prefix is the ID the agent chose                                                                                                                                                                                              | Yes. Outputs land under a prefix per Job instead of the bucket's root, so whatever collects a batch's results reads one prefix per Job ID. A copy of the command's log in the bucket is LG, Later (milestone 5)                                                                                                                                                                                                                                                                                                                   |
| W4  | JAX Jobs, which recompile the same programs on every run                                                                                                                                                                             | as W3                                                                                                                                                                                                                                                                                                                  | Yes for their data. Only `/mnt/input` outlives a Job, for the replica's next Job of the same input bucket (D-reuse); a compile cache kept on the Node between Jobs is JAXC, Later (M12)                                                                                                                                                                                                                                                                                                                                           |
| W5  | A point-evaluation server that loads its model once and serves calculations, seen in source only; the sampled Jobs don't call it                                                                                                     | one pool Job per command, which starts the process and loads the model each time                                                                                                                                                                                                                                       | Yes when calls are batched into one Job: process start and model load took about 4.5 s, plus a first-calculation warm-up, against about 36 ms per warm calculation on a T4 in the evaluation, so a Job per single calculation pays that start each time. **No** as a warm Deployment taking buckets per Job, which is out of scope: decision 26 found model reuse saves 0.4–1.7% of GPU time, targeted Jobs on user Deployments keep refusing buckets (§ Admission), and M4 has no per-Job directories in a replica               |
| W6  | Jobs with buckets on AWS or GCP, expected since the batch customer's credits span AWS, Azure and GCP; no evidence shows such buckets yet                                                                                             | each role's bucket on Azure, S3 or GCS (D-s3gcs), signed by the pool's compute credential on the same cloud or a named storage credential                                                                                                                                                                              | Yes, with ST1b-s3gcs. On GCS a Job survives an API outage of 30 min, not 6 h (S3) or 18 h (Azure), and its grant can delete inside its own prefix (§ Credentials); a bucket off the pool's cloud pays egress on every stage (§ Cross-cloud storage and egress)                                                                                                                                                                                                                                                                    |

The storage evaluation ran its transfers with the MACE e2e image, whose model
is baked in, so it proves the transfers, not the batch customer's own commands.

### _(Later)_

- **LG, the bucket log copy** (milestone 5): the runner writes the command's
  output to `/mnt/output/.anycloud/logs/`, as VM Jobs do, so it reaches
  `<output bucket>/<job-id>/.anycloud/logs/`. RFC 0044's PR 14 waits on it.
- **CF3:** the R2 minter, behind the same call. (ST1b-aws and GCP's prefix
  grants moved
  into ST1b-s3gcs with D-s3gcs.)
- **Longer GCS grants:** service account tokens extended up to 12 h under an
  organization policy, so a Job on GCS survives an API outage longer than
  30 min.
- **User-delegation signing** for shared-key-disabled Azure accounts.
- **An automatic platform-wide storage account**, so a Job on a pool whose
  compute credential can't provide storage needs no named storage credential.
  A separate product decision (D-storage-credential).
- **A disk flag**, with ST2b's refusal of a request above per-Node
  allocatable, if a Job outgrows its fraction (D-disk).
- **T1c:** VM Jobs' explicit checkpoint buckets move to `<job-id>/`, with no
  compatibility mode (O10).

## Changes

| Row        | Issue | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Source                        | Tests                                                                                                                                                                                                                                                                         |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST1b       | —     | the minter's prefix and lifetime (+10); a directory SAS signer beyond the earlier one, since `@azure/storage-blob` signs no `sr=d` (+35); the renewal call behind the fence (+30); admission's Azure-only and minting checks (+15); the managed checkpoint bucket's spot resolution, creation before the first claim and deletion with the record, through the VM helpers (+20). The claim's credential field is in RFC 0044 PR 6's claim payload (+80). Was +100–130                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | +110                          | +75                                                                                                                                                                                                                                                                           |
| ST1b-cred  | —     | independent storage credentials (D-storage-credential): admission and the CLI stop refusing `--*-storage-credentials` on pool Jobs and resolve each role's credential, refusing a role the compute credential can't serve and a spot Job with no supported checkpoint storage (+25, −15); the selected credential IDs and regions persisted on the record (+10); the pool path signs with an explicit Azure storage credential through admission's trial mint, without widening VM Jobs' cross-cloud check (+0–10); claim, renewal, `status` and cleanup load the persisted selection, with no pool needed for cleanup (+25–35); D-managed's spot rule reads the selected checkpoint credential instead of the pool's cloud, in code and in its cleanup SQL (+15–25, −10). No migration: the per-role credential and region columns exist                                                                                                                                                                                                                                                                                                                                                                                                                             | +75–105                       | +250–350 unit, +40–60 e2e                                                                                                                                                                                                                                                     |
| ST1a       | —     | stage, periodic and final upload, retries and renewal in the runner (RFC 0044 PR 6, counted there); the bucket refusal lifted for managed Deployments; prefix-scoped checkpoint health                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | (+190–210 of PR 6's +490–550) | +190 runner tests on real Azure storage (S1, S2, S7, S10); +230 an S1 and S6 smoke on e2e-cluster-cloud's Azure GPU pool                                                                                                                                                      |
| ST2b       | —     | NVMe unit, OD scratch, reserves with the image allowance, `ephemeral-storage` requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | +155                          | cloud only, in EX4                                                                                                                                                                                                                                                            |
| ST1b-s3gcs | —     | S3 and GCS backends (D-s3gcs): the prefix, `s3:prefix` condition and `noDelete` in `s3BucketStatement` (+15–25); the prefix condition in `mintGcpDownscopedToken` (+15–25); `mintPoolJobGrants`' S3 and GCS remotes and env in place of the Azure-only refusal, with the GCS token's JSON shared with `rcloneTokenConfig` (+35–55, −10); admission's supported-backend refusal (+5, −8), an explicit GCP storage credential on the pool path only (+3–8) and the bucket's resolved region persisted (+5–10, −2); the runner's expired-grant classification, if rclone needs it (+0–10); the managed bucket created first at admission and at the claim, its create's answer classified, a reused GCS bucket's project and S3 bucket's region checked, a create's 403 named, and kept on a failed insert (+20–40); `resourcemanager.projects.get` in `gcp-anycloud-role.json` (+1); the `prefix` and `noDelete` docstrings (+0, −2); soft delete off on managed GCS buckets (+5–10); the S3 and GCS remotes in `rclone-config.ts` (counted above); the e2e hosted stage's signer per provider, the Lambda Job's mixed backends, S6's pattern for AWS and GCS tokens and the run's S3 and GCS bucket sweep (+90–135); two integration matrix entries (+5). No migration | +196–331, −22                 | +130–195 `pool-job-storage-azure` generalized over Azure, AWS and GCP (S17–S19, S22's taken name); +125–190 unit (minters, admission S22 with its duplicate-ID race, region, managed creation and cleanup on S3 and GCS); +15 the runner's classification; +1 the role's spec |
| RS         | —     | the NVMe re-stage after preemption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | inside ST2b                   | EX4                                                                                                                                                                                                                                                                           |

Real-storage scenarios with no VM (S1 to S4, S7 and S10 below) run on Azure
storage on every pull request and cost pennies; S6 needs a real replica and runs
on e2e-cluster-cloud's Azure GPU pool; the NVMe scenarios run in milestone 4's
exit run (EX4).
Order: this RFC is accepted before ST1a, ST1b and ST2b merge; ST1a can land
first against test buckets. ST1b-cred starts once the D-storage-credential
amendment is reviewed, joins 0.1.71 and blocks its cut. ST1b-s3gcs starts now
that the owner has approved the D-s3gcs amendment (2026-10-23), joins 0.1.71
(owner, 2026-10-22) and blocks its cut. It is one PR: the two minters share
admission, `mintPoolJobGrants`, the integration spec and the live runs, so one
review, CI cycle and train cover both. Its real-storage scenarios (S17–S19) run on S3 and
GCS on every pull request through the integration workflow's existing AWS and
GCP secrets; its live runs are in § Live runs.

## Required invariants

1. A pool Job writes only under `<output bucket>/<job-id>/` and
   `<checkpoint bucket>/<job-id>/` or its own managed checkpoint bucket, and
   reads its input bucket read-only.
   _Enforcement: review — ST1a adds runner tests and S1._
2. Every storage credential a runner receives is minted for one Job and one
   role, covers only that role's bucket and, for output and an explicit
   checkpoint bucket, the Job's prefix. It grants no delete on Azure and S3,
   and on GCS, where an overwrite needs delete, none outside the Job's prefix
   or managed bucket.
   _Enforcement: review — ST1b adds a minter test and S3 against real Azure
   storage; ST1b-s3gcs adds S18 against real S3 and GCS._
3. Storage credentials reach a replica only in claim and renewal responses,
   and are never written to a Kubernetes object, the Pod spec, a file, a log
   or the command's environment.
   _Enforcement: review — ST1a and ST1b add tests, and S6 checks the replica._
4. A renewal for an execution that has ended is refused.
   _Enforcement: review — ST1b adds a test behind the execution fence._
5. A pool Job's command starts only after its inputs are staged and its
   checkpoint is restored.
   _Enforcement: review — ST1a adds a runner ordering test._
6. The minter's interface names no provider's permissions; Azure SAS
   permissions, S3 actions and GCS roles and conditions appear only in their
   provider's gateway or client.
   _Enforcement: review — a meaning, not a shape; ST1b's review checks it._
7. Pool admission refuses a bucket whose storage provider has no per-Job
   minter (every provider but Azure, AWS and GCP since D-s3gcs).
   _Enforcement: review — ST1b adds an admission test; ST1b-s3gcs extends it
   (S22)._
8. A pool Job's grants are minted, renewed, reported and cleaned up with the
   storage credential and region persisted for each role at admission, never
   with the pool's current compute credential or region, and never with a
   region looked up again after admission.
   _Enforcement: review — ST1b-cred adds admission, renewal and cleanup tests,
   and S14–S16; ST1b-s3gcs adds an S3 bucket's resolved region to them, and
   S21._

**0 of 8 verified wired, 0 cited, and 8 resting on review**: invariants 1, 2,
3, 4, 5, 6, 7, and 8.

## Acceptance scenarios

| ID  | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Required result                                                                                                                                                                                                                                                                                                                        | Coverage                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | A pool Job with an input, output and checkpoint bucket writes files and exits 0                                                                                                                                                                                                                                                                                                                                                                                                                                                 | its inputs were in `/mnt/input` before the command started; its outputs and checkpoint are under `<bucket>/<job-id>/`; it is `completed` only after the final upload                                                                                                                                                                   | test:0043/S1 — the runner's `runJob` on real Azure storage in `pool-job-storage`, with no Pod; a smoke on e2e-cluster-cloud's Azure GPU pool                                                                                                                                              |
| S2  | A pool Job's replica is lost after a periodic checkpoint upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | the retry re-stages the input, restores `<checkpoint bucket>/<job-id>/` and the command sees the last uploaded checkpoint                                                                                                                                                                                                              | test:0043/S2 — a second attempt through `runJob` on real Azure storage in `pool-job-storage`                                                                                                                                                                                              |
| S3  | A credential minted for Job A, on a real Azure account, signed once by an Azure compute credential and once by an explicit storage credential                                                                                                                                                                                                                                                                                                                                                                                   | the input grant reads and lists the whole input bucket and writes nothing; read, write and list inside A's output and checkpoint prefixes succeed; delete inside them, and read, write and list in Job B's prefix or another container, are refused                                                                                    | test:0043/S3 — on real Azure storage with no VM in `pool-job-storage`; ST1b-cred adds the explicit storage credential's signing                                                                                                                                                           |
| S4  | A renewal before expiry, and one after the execution ends                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the first returns fresh credentials that work on real Azure storage; the second is refused                                                                                                                                                                                                                                             | test:0043/S4 — on real Azure storage with no VM in `pool-job-storage`                                                                                                                                                                                                                     |
| S5  | The API is unreachable for 5 h while a pool Job runs, and then for longer than the credential's lifetime                                                                                                                                                                                                                                                                                                                                                                                                                        | the first Job keeps uploading and renews when the API returns; in the second, the command is stopped and the Job goes `retrying`                                                                                                                                                                                                       | review — to become test:0043/S5 in ST1a's runner unit tests                                                                                                                                                                                                                               |
| S6  | A pool Job prints its environment and lists the replica's files and the namespace's Secrets                                                                                                                                                                                                                                                                                                                                                                                                                                     | no storage credential appears in its environment, its log, a file or a Secret                                                                                                                                                                                                                                                          | review — needs a real replica: on e2e-cluster-cloud's Azure GPU pool a bucketed Job fails on a credential in its env, files or mounted Secrets, and the stage scans its log and the namespace's Secrets                                                                                   |
| S7  | A pool Job's input bucket is deleted after admission                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the Job ends terminal `invalid` while staging, and the command never runs                                                                                                                                                                                                                                                              | test:0043/S7 — `runJob` on real Azure storage in `pool-job-storage`                                                                                                                                                                                                                       |
| S8  | Input staging takes hours but makes progress, then stalls for 15 min                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the Job stays `syncing` while rclone progresses; the stalled copy is stopped and retried                                                                                                                                                                                                                                               | review — to become test:0043/S8 in ST1a's runner unit tests                                                                                                                                                                                                                               |
| S9  | A shared-key-disabled Azure account, with buckets or on a spot pool with none; the same bucket for output and checkpoint; a bucket on a Lambda pool with no storage credential (amended by D-s3gcs: an AWS bucket, an explicit AWS storage credential and an AWS spot Job with no checkpoint storage moved to S22, which refuses them only when they can't mint)                                                                                                                                                                | each is refused at admission                                                                                                                                                                                                                                                                                                           | review — to become test:0043/S9 in ST1b's admission tests                                                                                                                                                                                                                                 |
| S10 | `status` on a running pool Job with a checkpoint bucket                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | checkpoint health lists only `<checkpoint bucket>/<job-id>/`                                                                                                                                                                                                                                                                           | test:0043/S10 — checkpoint health on real Azure storage in `pool-job-storage`                                                                                                                                                                                                             |
| S11 | A spot H100 or A100 pool Job is preempted after staging a large input                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the retry's re-stage runs on local NVMe, at spike S5's default-flag rate (about 9 min for 527 GB), not OS-disk speed                                                                                                                                                                                                                   | review — to become test:0043/S11 in EX4, on a named NVMe size                                                                                                                                                                                                                             |
| S12 | With the Node's images within the allowance, a pool Job writes past its replica's `ephemeral-storage` limit, and one stages an input that fits its fraction on a replica whose image has a large working directory                                                                                                                                                                                                                                                                                                              | each replica is evicted and its Job ends terminal `invalid`, naming the limit; other replicas on the Node keep running                                                                                                                                                                                                                 | review — to become test:0043/S12 in ST2b's tests and EX4                                                                                                                                                                                                                                  |
| S13 | A pool Job on an Azure spot pool with no `--checkpoint-bucket` loses its replica after a periodic upload, and is later deleted                                                                                                                                                                                                                                                                                                                                                                                                  | the retry restores from the managed bucket named after the Job; `status` lists the managed bucket; deleting the Job deletes the bucket                                                                                                                                                                                                 | test:0043/S13 — e2e-cluster-cloud's Azure GPU pool with `pool_spot`: the bucketed Job without `--checkpoint-bucket` loses its Pod after a periodic upload                                                                                                                                 |
| S14 | A pool Job on a compute-only provider's pool (Lambda today, whose compute credential provides no storage) names input, output and checkpoint buckets in an independent Azure storage account through `--*-storage-credentials`                                                                                                                                                                                                                                                                                                  | it stages, uploads and completes as S1 does, with grants signed by that storage credential; the pool's compute credential signs nothing                                                                                                                                                                                                | test:0043/S14 — admission to mint in `pool-job-storage.spec`; live on e2e-cluster-cloud's Lambda pool with `hosted_stage`, the bucketed Job naming the run's Azure credential                                                                                                             |
| S15 | The API restarts while a pool Job with explicit storage credentials runs, and the runner then renews                                                                                                                                                                                                                                                                                                                                                                                                                            | the renewal is signed by the same storage credential, for the same accounts and regions, as the first claim                                                                                                                                                                                                                            | test:0043/S15 — a renewal after a restart and after the pool's deletion in `pool-job-storage.spec`                                                                                                                                                                                        |
| S16 | A Job on an AWS spot pool with `--checkpoint-storage-credentials` and no `--checkpoint-bucket` loses its replica after a periodic upload; the Job's pool is deleted, then the Job                                                                                                                                                                                                                                                                                                                                               | the retry restores from the managed bucket in that storage credential's account; deleting the Job deletes the bucket with the persisted credential                                                                                                                                                                                     | test:0043/S16 — cleanup with the persisted credential after the pool's deletion in `pool-job-managed-cleanup.spec`; live on e2e-cluster-cloud's AWS GPU pool with `pool_spot`, where the Job is deleted before its pool                                                                   |
| S17 | Scenario S1 on S3 and on GCS: a pool Job with an input, output and checkpoint bucket on S3 on an AWS pool, and on GCS on a GCP pool, each signed by the pool's compute credential                                                                                                                                                                                                                                                                                                                                               | as S1: inputs staged before the command; outputs and checkpoint under `<bucket>/<job-id>/`; `completed` only after the final upload; no credential in the Job's env, files, log or Secrets (S6)                                                                                                                                        | test:0043/S17 — `runJob` on real S3 and GCS in the generalized `pool-job-storage` integration spec; live on e2e-cluster-cloud's AWS and GCP pools (§ Live runs)                                                                                                                           |
| S18 | Scenario S3 on S3 and on GCS: a credential minted for Job A, signed once by a compute credential and once by an explicit storage credential                                                                                                                                                                                                                                                                                                                                                                                     | the input grant reads and lists the whole bucket and writes nothing; read, write, overwrite and list in A's prefixes succeed; read, write and list in Job B's prefix or another bucket are refused; delete in A's prefix is refused on S3 and allowed on GCS, and refused on GCS in B's prefix: the GCS minter's reading of `noDelete` | test:0043/S18 — real S3 and GCS with no VM in `pool-job-storage`; the minters' policies and boundaries in `aws-storage-creds.spec` and `gcp.spec`                                                                                                                                         |
| S19 | Scenario S4 on S3 and on GCS, and a copy whose grant is no longer valid: a renewal before expiry; one after the execution ends; a stage started with an expired grant while a valid renewal is held: on GCS a token whose `expiry` is in the past, on S3 a 900 s federation token that has lapsed                                                                                                                                                                                                                               | the renewal's credentials work; the late renewal is refused; the expired grant's copy ends `failed`, not `denied`, and the retry with the held grant completes the stage                                                                                                                                                               | test:0043/S19 — real S3 and GCS with no VM in `pool-job-storage`, both real expiries: the S3 token is minted at the spec's start and used after 15 min (§ Decided, 6); the runner's classification in `transfer.spec`                                                                     |
| S20 | A Job on a Lambda pool with its input on GCS, its output on S3 and its checkpoint in Azure, each through `--<role>-storage-credentials`                                                                                                                                                                                                                                                                                                                                                                                         | it stages, uploads and completes as S1 does; each role's grant is signed by its own credential and works only on its own backend                                                                                                                                                                                                       | test:0043/S20 — admission to mint in `pool-job-storage.spec`; live on e2e-cluster-cloud's Lambda pool with `hosted_stage`, replacing S14's all-Azure Job                                                                                                                                  |
| S21 | D-managed on S3 and GCS: a Job on an AWS spot pool, and one on a GCP spot pool, with no `--checkpoint-bucket` and no checkpoint storage credential, loses its replica after a periodic upload; its pool is deleted, then the Job                                                                                                                                                                                                                                                                                                | the managed bucket is an S3 or GCS bucket in the pool's account, named after the Job; the retry restores from it; deleting the Job deletes it with the persisted credential and region                                                                                                                                                 | test:0043/S21 — admission, claim and region in `pool-job-storage.spec` and cleanup in `pool-job-managed-cleanup.spec`, on AWS and GCP rows; live on e2e-cluster-cloud's AWS and GCP spot pools (§ Live runs)                                                                              |
| S22 | Admission with: an R2 bucket; an AWS compute or storage credential with a `sessionToken`, for a bucket or a spot pool's managed bucket; a GCS bucket on a Lambda pool with no storage credential; a GCP credential in a project without the Security Token Service API; a spot Job on an AWS and on a GCP pool whose ID is taken as a bucket name by another account or project, and on AWS by a bucket in another region; two submits of one ID racing, the loser's create reusing the winner's bucket before its insert fails | each is refused before the Job is stored, naming the role and the supported backends or VM Jobs' message; the taken name with "Pass `--checkpoint-bucket` or choose a different `--id`", and a claim that meets one ends the Job `invalid`; the race's loser is refused as a duplicate ID and the winner's bucket and objects survive  | test:0043/S22 — admission in `pool-job-storage.spec`, with its duplicate-ID race; the create's classification in `aws.spec` and `gcp.spec`; the claim's taken name in `node-pool-deployment-jobs.spec`; the taken name on real S3 (same and another region) and GCS in `pool-job-storage` |

### Live runs

D-s3gcs changes the storage path on every provider, so ST1b-s3gcs proves it
on each, through the coordinator's merge train (one dispatch per purpose,
announced with its cost, native cleanup confirmed):

- **AWS:** e2e-cluster-cloud with `pool_provider: aws`, `hosted_stage` and
  `pool_spot`: S17 on S3 for input and output (a spot pool's checkpoint is
  managed), S6 and S21 on S3.
- **GCP:** the same with `pool_provider: gcp`: S17, S6 and S21 on GCS.
- **Lambda:** `pool_provider: lambda` with `hosted_stage`: S20 and S6. Lambda
  has no spot, so no S21.
- **Azure storage:** no live run. Its grants are unchanged and run on real
  Azure on every pull request (S1–S4, S7, S10), which also covers
  `mintPoolJobGrants`' refactor.
- **An Azure pool with S3 or GCS storage:** no live run. Nothing on that path
  depends on the compute provider: the runner gets the same grants and env
  from the claim on every pool, and the pool namespace's egress policy is the
  same on every cloud (all addresses but the cluster's and instance metadata).
  Azure's host-only block also drops Pod traffic to the WireServer
  168.63.129.16 but leaves its port 53 open, and every Azure pool Job already
  resolves public storage names through it, as S3 and GCS hostnames are. So
  an Azure Node reaches S3 and GCS over the internet as a Lambda Node does.
  Lambda's S20 proves that off-cloud path live for both backends, and S17–S19
  prove the grants on real S3 and GCS on every pull request.

S17's explicit checkpoint bucket under `<job-id>/` and S18's prefix isolation
run on real S3 and GCS on every pull request, so the spot runs needn't repeat
them. If `hosted_stage` refuses `pool_spot` today, ST1b-s3gcs lifts that in
the workflow. S16's live run is unchanged: `gpu_pool` on an AWS spot pool
keeps naming the run's Azure credential as `--checkpoint-storage-credentials`
(`poolJobUsesAzureStorage`), which now proves an explicit storage credential
overriding the S3 default, while the AWS run above proves the default.

## Alternatives considered

- **Helper containers with a per-Job Secret** (this RFC's earlier draft). A
  `stage` init container and a `watch` sidecar per Job Pod, reading
  credentials from a Secret the API renewed. Superseded by decision 26:
  replicas outlive Jobs, so per-Job containers and Secrets no longer fit.
- **A container SAS per bucket, as VM Jobs use.** Less code, but every Job
  could read and overwrite every other Job's outputs and checkpoints with a
  credential it can read. Rejected: the prefix is the isolation between Jobs
  on a shared replica.
- **One container per Job** as the isolation for outputs and explicit
  checkpoint buckets. Isolation without a directory SAS, but it creates and
  deletes containers per Job inside user-owned storage. Rejected, since the
  directory SAS works on flat accounts; D-managed keeps only VM Jobs'
  managed bucket for spot Jobs with no checkpoint bucket.
- **User-delegation signing now.** Works without shared-key access, but the
  signing credential needs a data-plane role (Storage Blob Data Contributor).
  Later, when a customer disables shared-key access.
- **An identity on the replica** (Azure workload identity). A replica runs
  many Jobs, so the identity can't be scoped to one Job, and RFC 0047 removed
  storage identities from compute. Rejected.
- **AWS `AssumeRole` with a session policy** instead of
  `GetFederationToken`. It serves SSO and other temporary credentials, but
  needs a role ARN the stored credential doesn't carry, lasts at most 12 h
  (1 h when chained from a session), and VM Jobs already mint federation
  tokens. Not chosen; a credential with a `sessionToken` is refused.
  Superseded for AWS role connections (RFC 0047 amendment 8): the connection
  saves a role ARN and mints with `AssumeRoleWithWebIdentity`, which is not
  chained and lasts 12 h. Key connections keep `GetFederationToken`.
- **GCS without delete**, by uploading each checkpoint under a new object name
  and pointing at the newest. Keeps invariant 2 whole, but changes the
  checkpoint layout the command sees and needs a pruning step the runner
  doesn't have. Rejected in favor of delete inside the Job's own prefix.
- **API-driven transfers over Kubernetes exec:** rejected with RFC 0044's c2.
- **FUSE or CSI bucket mounts:** rejected; they need a driver or privilege on
  pool Nodes.

## Risks

- **Readable, unrevocable credentials.** The command can read its credentials
  from the runner's processes, since they share a container and a user (RFC
  0044's shared-container risk), and an account-key SAS can't be revoked before
  it expires short of rotating the account key. A leaked one works for up to its
  36 h lifetime (D-lifetime), within its Job's prefixes, its managed bucket and
  its input bucket. Overwrite is allowed; only delete is refused.
- **Delete on GCS.** A GCS grant can delete inside its Job's prefix or managed
  bucket. A command that reads it can delete its own outputs and checkpoints,
  which it could already destroy by overwriting them on every backend; it
  can't reach another Job's prefix.
- **A 30-minute outage on GCS.** A Job with any role on GCS stops its command
  when the API is unreachable for about 30 min, and retries. Azure roles alone
  survive 18 h, and S3 roles 6 h.
- **Egress.** A bucket off the pool's cloud or region costs about
  $0.09–0.12/GB on every stage and re-stage (§ Cross-cloud storage and
  egress).
- **Shared-key access.** Signing needs `listKeys` on the selected
  credential's storage account and shared-key access enabled; accounts without
  it are refused until user-delegation signing.
- **Images beyond the allowance.** Several distinct heavy images on one Node,
  or one image larger than its class's allowance, bring back DiskPressure:
  kubelet then evicts a replica of its own choosing and taints the Node.
- **Reusing an unrelated owned bucket.** S3 and GCS names are global, and a
  managed bucket is created by the Job ID, so a bucket the account already
  owns under that name, such as `datasets`, is reused and then emptied with
  every object version when the Job is deleted. VM managed buckets and Azure
  containers already behave this way, but D-s3gcs makes it the default on AWS
  and GCP spot pools. No tag check guards the reuse.
- **The last minute of work.** A final upload cut short by the grace, or an
  upgrade forced past it, loses up to one upload interval; the retry restores
  the previous checkpoint.

## Owner decisions

- **O10** (2026-10-01, kept): explicit checkpoint buckets move to `<id>/`,
  with no compatibility mode; pools use the layout from the start, and VM Jobs
  move only with T1c (optional, Later).
- **O26** (2026-10-01; clarified 2026-10-19 by D-storage-credential; amended
  2026-10-22 by D-s3gcs): pool storage backends are Azure, S3 and GCS; R2
  (CF3) is Later. O26 limits storage backends, not compute providers.
- **D-prefix** (2026-10-01, "def yes"): no `--checkpoint-prefix`; the prefix is
  always `<job-id>/`. The flag was never on `main`.
- **O11, signing** (tracker constraint; amended 2026-10-19 by
  D-storage-credential): the API resolves an explicit storage credential
  independently for each role, and the pool's compute credential signs a role
  only when it can provide storage and no storage credential is named. Until
  ST1b-cred lands, a pool Job's storage credential is refused at admission (the
  2026-10-17 deferral); ST1b-cred supersedes that deferral. Amended 2026-11-03
  by RFC 0047 amendments 8 and 9: an AWS or GCP role connection can also
  provide storage.
- **O27, by evidence**: an account-key directory SAS per Job; the
  user-delegation key is Later.
- **O8, final copy on cancel**: a terminated pool Job gets the final upload
  once its command exits, or is killed at the end of the grace (RFC 0044's
  runner loop, step 4). VM Jobs are unchanged.
- **A provider-neutral minter** (2026-10-09, "yes"): the interface takes a
  bucket, a prefix and a mode and returns credentials with their expiry; Azure
  is its only implementation in the MVP, and R2 and AWS follow.
- **Written first** (2026-10-13): this RFC follows decision 26 and is accepted
  before ST1a, ST1b and ST2b merge.
- **D-managed** (2026-10-13): a pool Job on a spot pool with no
  `--checkpoint-bucket` gets a managed checkpoint bucket named after the Job,
  created and deleted by Anycloud, as VM spot Jobs do; an explicit bucket
  still uses `<job-id>/`. This reverses the draft's recommendation of none.
  Amended 2026-10-19 by D-storage-credential: `--checkpoint-storage-credentials`
  selects where the managed bucket lives, even without `--checkpoint-bucket`,
  and the pool's spot mode and supported storage decide it, not the pool's
  compute provider. A spot pool Job with no supported checkpoint storage is
  refused at admission on every provider, AWS and GCP spot pools included
  until they have supported storage (owner, 2026-10-19: "Refuse everywhere,
  like VM spot"). Amended 2026-10-22 by D-s3gcs: AWS and GCP spot pools'
  compute credentials now provide supported storage, so their Jobs' managed
  buckets live on S3 and GCS; the refusal stays for a credential that can't
  mint and for compute-only providers. Since S3 and GCS names are global,
  admission creates the managed bucket and refuses a taken name (§ Admission;
  § Decided, 5).
- **D-lifetime** (2026-10-13): credentials last 36 h, as VM Jobs' do, renewed
  at half-life. This reverses the draft's 12 h recommendation. Amended
  2026-10-22 by D-s3gcs: a backend may return less (GCS 1 h, an AWS root key
  1 h), and the runner renews at half the earliest grant's lifetime. Amended
  2026-11-03 by RFC 0047 amendment 10: AWS credentials last 12 h, for key and
  role connections alike, so S3 roles survive a 6 h API outage.
- **D-disk** (2026-10-13): each replica gets its GPU (or CPU) fraction of the
  Node's allocatable `ephemeral-storage`, with no flag; the flag is Later.
- **D-input** (2026-10-13): the input grant covers the whole input bucket,
  read-only, though the 2026-10-09 note lists `<job-id>/` beside every mode.
- **D-reuse** (2026-10-13, input reuse):
  a replica keeps `/mnt/input` between Jobs of the same input bucket and stages
  it with `rclone sync`; a Job with no input or another bucket finds it empty.
- **D-gcp** (2026-10-14): GCP buckets for pool Jobs are Later, planned for
  M12.
  Superseded 2026-10-22 by D-s3gcs.
- **D-accept** (2026-10-13, option A): the RFC is
  accepted before its workload-fit mapping, which is owed before ST1a and ST1b
  merge. § Workload fit meets it. ST1a part A merged before
  it in error, and the owner kept it (2026-10-14); part B and ST1b wait for it.

- **D-storage-credential** (2026-10-19; owner: "'Azure-only storage' must no
  longer imply 'Azure-only compute.' Keep Azure as the first storage backend,
  and make independent credentials a prerequisite for expanding GPU providers.",
  "the impetus behind this is adding compute only pool providers for spot to
  support more clouds", and "Apply it: one RFC PR + issues", "Join 0.1.71"):
  O11, O26 and D-managed are amended as above, and § Admission persists each
  role's selected credential and region for validation, claim, renewal, `status`
  and cleanup. Explicit named storage credentials come first; an automatic
  platform-wide storage account is a separate product decision. One shared
  follow-up, ST1b-cred
  (under
  ST1b), owns it, so storage stays shared infrastructure for provider expansion
  instead of work repeated in each cloud adapter: R2, GCP and new GPU
  providers that promise bucket-backed Jobs depend on it and add only their own
  grants and transfers. It joins 0.1.71 and blocks the cut.

- **D-s3gcs** (2026-10-22; owner: "move s3/gcs to 0.1.71"): S3 and GCS join
  Azure as pool storage backends in 0.1.71, alongside Azure, not instead of it
  (the owner earlier chose "No: keep Azure first" over S3 only). O26,
  D-lifetime, D-managed's spot refusal and invariants 2, 6, 7 and 8 are amended
  as above, and D-gcp is superseded. One PR, ST1b-s3gcs, reuses VM Jobs'
  minters and storage code, as ST1b-cred did. It blocks 0.1.71's cut, as
  ST1b-cred does: "move s3/gcs to 0.1.71" puts it in the release. Approved by
  the owner on 2026-10-23 ("Approve"), with every recommended option in
  § Decided.

## Decided (2026-10-23)

The owner chose every recommended option ("All recommended: 1A, 2A, 3A", "All
recommended: 4A, 5A, 6A") and approved the amendment ("Approve"). The earlier
question whether ST1b-s3gcs blocks the cut was answered by "move s3/gcs to
0.1.71" and is recorded in D-s3gcs.

1. **GCS delete and `noDelete`: A.** `noDelete` means "no delete where the
   backend can overwrite without it, otherwise only inside the grant's prefix
   or bucket", and the GCS minter grants delete inside the Job's prefix or
   managed bucket (invariant 2). One interface with no provider branch; a
   command could already destroy its own files by overwriting them.
   - Rejected B, the GCS minter refuses `noDelete`: the same permissions, but
     the caller needs a provider branch or a capability flag.
   - Rejected C, a new object per upload: changes the checkpoint layout and
     needs pruning.
   - Rejected D, GCS for input only: no GCS output or checkpoint.
2. **GCS lifetime: A.** 1 h grants renewed every 30 min, so a GCS Job survives
   a 30-minute API outage with no customer setup.
   - Rejected B, 12 h tokens under
     `iam.allowServiceAccountCredentialLifetimeExtension`: each customer
     changes an organization policy; it stays Later.
3. **Explicit GCP storage credentials: A.** Accepted on pool Jobs only, where
   the trial mint proves them, so any pool can use GCS (S20); VM Jobs keep
   refusing them.
   - Rejected B, pool and VM Jobs: widens VM Jobs' check with no VM coverage.
   - Rejected C, refused: Lambda, Azure and AWS pools couldn't use GCS.
4. **Egress: A.** No admission warning or refusal for a bucket off the pool's
   cloud; the docs state the cost, and an intentional choice isn't nagged.
   - Rejected B, a CLI warning (+10–20): repeats on every intentional
     cross-cloud Job.
   - Rejected C, a refusal with an opt-in flag: a new flag that refuses a
     legitimate setup.
5. **A taken managed bucket name on S3 or GCS: A.** Admission creates the
   managed bucket last, create first, and classifies the create's answer, so a
   taken name in any region is refused at submit and never adopted; a taken
   name at the claim ends the Job `invalid` (§ Admission). About +20–40.
   - Rejected B, a `hasBucket` probe at admission: the name can be lost before
     the claim, and a 403 or an S3 301 can't tell a foreign bucket apart.
   - Rejected C, a random suffix (+40–70): the name stops being the Job ID and
     needs a migration.
   - Rejected D, the claim alone (+5–10): the user learns only after the Job
     has queued.
6. **S19's S3 expiry: A.** A real 900 s federation token, minted at the
   integration spec's start and used once it has lapsed, proves the real
   `ExpiredToken` path on every pull request; the lane's 2–4 min stays under
   the slowest lane's 45 min, so the wait adds no wall-clock time. The spec
   runs S17 and S18 while it lapses and sets a vitest timeout of at least
   16 min.
   - Rejected B, the real lapse only in a dispatched run: a change in rclone's
     output is found only on the next dispatched run.

## Tracking

Each row links its PR here when it opens: ST1b, ST1a, ST2b, RS, ST1b-cred
and ST1b-s3gcs; D-s3gcs was approved on 2026-10-23.

## Decision

Accepted by the owner on 2026-10-13 (D-accept), with the
amendments described above
and under [RFC 0044](./0044-one-pool-runtime.md#owner-decisions)'s decision 26.
The workload-fit mapping that [rfcs/README.md](./README.md#conventions) requires
merged as a follow-up amendment (§ Workload fit) before ST1a's
runner and ST1b merge. It maps
each of the batch customer's workloads onto this spec and names those it doesn't serve.
On 2026-10-19 the owner amended O11, O26 and D-managed so pool storage
credentials are independent of compute (D-storage-credential); the amendment
added invariant 8 and scenarios S14–S16, and extended S3 and S9. On
2026-10-22 the owner moved S3 and GCS pool storage into 0.1.71 (D-s3gcs); the
amendment, approved by the owner on 2026-10-23 (§ Decided), amends O26,
D-lifetime, D-managed and invariants 2, 6, 7 and 8, narrows S9, and adds
scenarios S17–S22. On 2026-11-03 RFC 0047's amendments 8 and 10 set the AWS
lifetime to 12 h, and amendments 8 and 9 let an AWS or GCP role connection
sign (D-lifetime, O11).
