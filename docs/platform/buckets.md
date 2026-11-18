---
title: Buckets
description: Use cloud object storage as input, output, and checkpoint files inside Anycloud containers.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Buckets

Buckets connect durable cloud object storage to a Job or VM-backed Service as
ordinary files. Anycloud handles S3, Azure Blob Storage, or Google Cloud
Storage access and bind-mounts the synchronized directories into the
container.

Use Buckets for large datasets, model weights, results, logs, and state that
must survive a spot interruption. They are a first-class platform primitive,
not an image-building detail.

<span id="combining-buckets"></span>

## The three mounts

| Role       | Container path    | Workloads                   | Access     | Sync                                                          |
| ---------- | ----------------- | --------------------------- | ---------- | ------------------------------------------------------------- |
| Input      | `/mnt/input`      | Jobs                        | Read-only  | Download once before startup                                  |
| Output     | `/mnt/output`     | Jobs                        | Read-write | Upload about every 60 seconds and at exit                     |
| Checkpoint | `/mnt/checkpoint` | Jobs and VM-backed Services | Read-write | Restore at startup; upload about every 60 seconds and at exit |

Input buckets must already exist. Output buckets are created when necessary.
Input and output must use different bucket names.
An explicitly named checkpoint bucket must already exist. It is user-owned:
Anycloud syncs its contents but never creates or deletes the bucket. A spot Job
without an explicit name keeps the existing behavior—Anycloud creates and
manages a checkpoint bucket named after the workload, so the workload ID must
also be a valid bucket name on that cloud; Azure, for example, rejects `--`, and
S3 reserves forms such as an `xn--` prefix or an `-an` suffix for new buckets.
The same applies to an output bucket that doesn't exist yet.
Cluster-hosted APIs create a managed checkpoint bucket by default. To retain a
bucket you own, create it first and pass
`anycloud cluster create --checkpoint-bucket`.

## Attach input and output

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job ghcr.io/acme/train:latest \
  --credentials my-aws \
  --gpu-type a100:8 \
  --spot \
  --input-bucket training-data \
  --output-bucket training-results \
  -- python train.py
```

</TabItem>
<TabItem value="python" label="Python">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu="a100:8",
        cloud_config={
            "spot": True,
            "input_bucket": "training-data",
            "output_bucket": "training-results",
        },
        command=["python", "train.py"],
    )
    print(job.id)
```

</TabItem>
</Tabs>

Inside the container, application code only reads and writes paths:

```python
from pathlib import Path

model = Path("/mnt/input/base-model.bin").read_bytes()
Path("/mnt/output/metrics.json").write_text('{"loss": 0.12}')
```

## Attach checkpoint state

Create the bucket first, then attach the same name to a Job or VM-backed
Service:

```bash
anycloud bucket create model-state --credentials my-aws
anycloud service ghcr.io/acme/model-api:latest \
  --credentials my-aws \
  --vm-type g5.xlarge \
  --checkpoint-bucket model-state
```

For a Python Job, pass `cloud_config={"checkpoint_bucket": "model-state"}`
to `client.submit()`. For a Service, set `cloudConfig.checkpointBucket` in the
[generated Service request](/platform/services#start-a-service). The process
reads and writes `/mnt/checkpoint`.

For Services, the checkpoint Bucket must use the selected compute credential.
Separate or cross-account checkpoint storage credentials are supported only
for Jobs. The Bucket may be in another region when the same compute identity
can access it.

## Sync guarantees

Input uses `rclone sync` once before startup. Output uses upload-only
`rclone copy`, so two Jobs writing to one bucket do not delete one another's
objects. Checkpoints restore existing objects first and then use the same
upload-only behavior.

Input hydration has no fixed wall-clock deadline: a Job remains in `syncing`
until the whole bucket is present, however long a healthy transfer takes.
Rclone emits activity once a minute; Anycloud stops and retries a worker only
after 15 minutes without new output, and reattaches to an active VM-side sync
after an API restart. Self-hosted API operators can tune that watchdog with
`INPUT_SYNC_INACTIVITY_TIMEOUT_MS`.

An input mount always hydrates the entire bucket; it does not accept an object
prefix. Startup time therefore scales with both bytes and object count. Use a
dedicated input bucket for each pipeline stage when a shared bucket contains
unrelated data.

When a bucket-backed Job exits, it enters `finalizing` while Anycloud performs
one last output and checkpoint copy. `completed` or `errored` is published only
after that succeeds. If final sync exhausts its retries, the Job becomes
`failed` because its artifacts could not be preserved.

Before a VM-backed Service is terminated or replaced, Anycloud stops the
workload, stops continuous checkpoint sync, completes one final upload, and
only then removes the VM. A failed final upload leaves the VM registered so
cleanup can retry instead of silently replacing it with stale state.

Periodic sync is file copying, not an application-aware database snapshot. A
clean Service termination or replacement quiesces the process first, but sudden
VM loss can lose roughly one sync interval, and the last live-file copy is not
guaranteed to be a coherent multi-file snapshot. Applications with multi-file
or hot database state should write their own atomic checkpoint into
`/mnt/checkpoint`. Use one active writer per checkpoint bucket.

Files exist once on the VM and are exposed through Docker bind mounts; there is
no second copy inside the container. The host paths can differ by provider, but
the three `/mnt/...` container paths are stable.

## Work with objects directly

Use the CLI when you need to discover, prepare, or inspect a bucket outside a
Job. With no target, `list` enumerates buckets visible to the selected AWS, GCP,
or Azure credential. With a target, it shows top-level objects and virtual
folders:

```bash
anycloud bucket list --credentials my-aws
anycloud bucket create training-data --credentials my-aws
anycloud bucket upload training-data ./dataset.parquet data/dataset.parquet \
  --credentials my-aws
anycloud bucket list training-data --credentials my-aws
anycloud bucket list training-data data/ --credentials my-aws
anycloud bucket list training-data --recursive --credentials my-aws
anycloud bucket download training-data data/dataset.parquet ./dataset.parquet \
  --credentials my-aws
anycloud bucket upload training-data ./dataset-shards data/shards/ --recursive \
  --credentials my-aws
anycloud bucket download training-data data/shards/ ./dataset-shards --recursive \
  --credentials my-aws
```

Prefixes are literal; use a trailing `/` to browse a folder. Add `--recursive`
for a flat full-tree view. Listings default to 1,000 sorted results; `--all`
exhausts all pages. A listing cut at the limit exits with code `3`; in
`--json` output it sets `"truncated": true` and a `nextCursor` to pass to
`--cursor` to continue.

Recursive upload and download preserve paths relative to the supplied literal
folder prefix. Use `''` as the prefix to copy the bucket root. Recursive prefix
deletion requires a non-empty trailing-slash prefix and confirmation (or
`--yes` for automation):

```bash
anycloud bucket rm training-data stale-runs/ --recursive --yes \
  --credentials my-aws
```

Directory operations default to four concurrent object requests and accept
`--concurrency 1` through `32`. They preflight the complete manifest before
starting, attempt every item after an individual failure, and report partial
success without rollback.

The generated SDK exposes JSON bucket metadata operations through `BucketsApi`:

```python
from anycloud import Client
from anycloud.api.buckets_api import BucketsApi

with Client() as client:
    buckets = BucketsApi(client.api_client)
    page = buckets.list_buckets_sync(
        "my-aws", client.sdk_version, page_size="100"
    )
    for bucket in page.buckets:
        print(bucket.name)

    objects = buckets.list_bucket_objects_sync(
        "my-aws", "training-data", client.sdk_version, prefix="data/"
    )
```

Follow each response's `next_cursor` to paginate. Upload, download, and
directory transfer are native byte transports and are not included in the
generated SDK; use the CLI for those operations.

See [`bucket` reference](/reference/cli/bucket) for exact commands.

## Hand out storage tokens

A program that holds no cloud credential but holds an API token can ask the API
for short-lived tokens scoped to prefixes of a saved credential's buckets, and
use them with the cloud's own SDK. Each grant is `read` (read and list) or
`readwrite` (also write and overwrite):

```bash
curl -sS -X POST "$API_URL/v1/credentials/prod-aws/storage-tokens" \
  -H "Authorization: Bearer $ANYCLOUD_API_TOKEN" \
  -H "AnyCloud-Client-Version: $(curl -sS "$API_URL/v1/version" | jq -r .version)" \
  -H 'Content-Type: application/json' \
  -d '{"lifetimeSeconds": 900, "grants": [
        {"bucket": "build-cache", "prefix": "cache/main/", "mode": "read"},
        {"bucket": "build-cache", "prefix": "cache/feature-x/", "mode": "readwrite"}]}'
```

The Python SDK's `BucketsApi.mint_storage_tokens` makes the same call. The
response lists tokens, each with the indexes of the grants it covers and its
real `expiresAt`. An AWS response's `region` is the one the request names with
`?region=`, or else the credential's; name the bucket's region, or the S3
client must follow region redirects:

| Cloud | Tokens                                                                                          | Lifetime                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AWS   | One STS session (`accessKeyId`, `secretAccessKey`, `sessionToken`, and the response's `region`) | At least 15 minutes, STS's floor                                                         |
| GCP   | One downscoped `accessToken`                                                                    | One hour from a key; the requested lifetime, at least 10 minutes, from a role connection |
| Azure | One SAS per grant, for the response's `accountUrl`                                              | Exactly as requested                                                                     |

`lifetimeSeconds` is 60 to 3,600 and defaults to 900. A request holds 1 to 10
grants. A prefix is empty (the whole bucket) or ends in `/`, with no leading
`/`, no empty, `.` or `..` segment, no control character, and none of
`\ * ? $ ' " % #`. An AWS request whose session policy would exceed STS's
2,048 characters, about six prefix grants, is refused with
`STORAGE_TOKEN_REQUEST_INVALID`.

A token reaches only its prefixes. With `noDelete` (the default), AWS and
Azure tokens never delete. GCS needs delete permission to overwrite, so a GCP
`readwrite` token can delete objects inside its own `readwrite` prefixes,
never elsewhere. Every token lists the
keys under its prefixes. Tokens can't be revoked one at a time; their short
life is the control. In an emergency:

- AWS: attach to the credential's IAM user, or to a role connection's role, a
  policy that denies everything when `aws:TokenIssueTime` is earlier than now.
  Rotating the key does not end sessions already issued. The deny also ends
  VM storage sessions issued before then.
- GCP: remove the service account's access to the bucket.
- Azure: rotate the storage account's first key (`key1`), which signs every
  token and also voids VM SAS tokens. For up to 15 minutes the
  API may still sign new tokens with its cached old key, and they are refused.

Minting follows the hosted API's peer model: the owner and every member may
mint any grant on any saved credential, as each can already reach those buckets through
the bucket commands or a Job. `noDelete: false` mints a token that deletes on
AWS and on a whole Azure container. Scope a token by what you request, not by
who requests it. No one can mint for the API's own backup bucket. Cloudflare
R2, Local and Lambda credentials are refused with `STORAGE_TOKEN_UNSUPPORTED`,
as is an AWS key that carries a session token. The API logs one line for each request that
passes validation, with its principal, grants, lifetime and outcome, never a
token.

<span id="credentials"></span>

## Authentication

Sync never puts a long-lived cloud credential on the VM:

- AWS: every S3 Bucket syncs with a short-lived token scoped to that one
  Bucket, minted from the selected credential with `sts:GetFederationToken`.
  AWS VMs get no IAM role, so the credential needs no other IAM permission
  except `iam:CreateServiceLinkedRole` for the account's first Spot launch.
  The published [`AnycloudAccess`](/reference/cli/credentials#aws-permissions)
  policy lists everything it needs.
- Azure: every Azure Bucket syncs with a short-lived SAS scoped to that one
  container, signed with the storage account key that the selected credential
  reads with `listKeys`. Azure VMs get no managed identity, so the credential
  needs no role-assignment permission. The published
  [`Anycloud` role](/reference/cli/credentials#azure-permissions) lists
  everything it needs.
- GCP: every Cloud Storage Bucket syncs with an access token downscoped to
  that one Bucket from the selected service-account key. GCP VMs get no
  service account, so the key needs no `iam.serviceAccounts.actAs`, but it
  needs object read and write on its Buckets, and its project needs the
  Security Token Service API (`sts.googleapis.com`) enabled. Set both up before
  upgrading Anycloud: running GCP Jobs and Services switch to the new token on
  their next sync, and new ones need it from the start. The published
  [`Anycloud` role](/reference/cli/credentials#gcp-permissions) lists
  everything the key needs.
- Cloudflare R2: a short-lived token scoped to one Bucket, minted from the
  saved Cloudflare API token with R2's temporary-credentials API.

Long-lived cloud credentials are not injected into the workload container.

On Azure, the Anycloud controller fetches a current account key with
`listKeys` for its own Blob operations and to sign each VM's container SAS:
read and list for an input Bucket; read, write, delete and list for an output
or checkpoint Bucket. A SAS lasts 36 hours and is renewed like an AWS token.
The account key grants broad data-plane access but is never persisted, logged
or sent to a VM. Rotating the key that signed a SAS (`key1`) invalidates the
live SAS tokens: sync to those Buckets fails until the API's next scheduled
renewal, up to 36 hours later. The final copy at the end of a Job always uses
a freshly minted SAS, so accumulated output is still saved.

This model requires **Allow storage account key access** on the
Anycloud-managed storage account. Anycloud explicitly enables it when creating
the account and reports an actionable error if policy later disables it. See
Microsoft's [Shared Key security guidance](https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent) when evaluating this
tradeoff.

Azure VMs from earlier releases used a shared managed identity. Once those VMs
end, you can delete the `anycloud-vm-identity` managed identity in the
`anycloud-storage` resource group and its orphaned Storage Blob Data
Contributor assignment on the storage account. Service principals created by
earlier `credentials new --generate` runs can drop User Access Administrator.

If storage belongs to a different account, use a generated admission request
with a top-level saved credential name, such as `inputStorageCredentialName`,
and its region under `cloudConfig.inputStorageRegion`. These saved-name options
are not arguments to `Client.submit()`; see the Python example in
[Bucket credential rules](/reference/configuration#bucket-credential-rules).

For Jobs, use the corresponding `--input-storage-*`, `--output-storage-*`,
or `--checkpoint-storage-*` flags. The three identities are independent.
Service checkpoints are the exception: they require a selected compute
credential, whose identity supplies bucket access unless
`--checkpoint-storage-credentials` selects a separate AWS credential (see
[Service storage](/platform/services#separate-s3-checkpoint-credentials)).

Cross-cloud storage supports AWS S3 and Cloudflare R2. On AWS and GCP,
Anycloud mints bucket-scoped, short-lived credentials rather than copying the
saved key to the VM: read and list for an input Bucket; read, write and list
for an output or checkpoint Bucket. A token lasts up to 12 hours on AWS and
about an hour on GCP. The API renews it a few minutes before it expires, both
while a VM first downloads its input and checkpoint data and while a VM-hosted
Job or Service runs, and mints a fresh one for the final copy, so termination still preserves
accumulated output and checkpoint data. If the API is unreachable past a
token's expiry, sync stops until it renews the token.

Minting uses STS `GetFederationToken`, which needs a long-term IAM user access
key with `sts:GetFederationToken` and S3 access to the Bucket. Anycloud refuses
to save AWS credentials with a session token (SSO or an assumed role), since
they expire.

For R2, name a saved Cloudflare credential with the `--*-storage-credentials`
flags. R2 has no regions, so omit `--*-storage-region`; the credential's
jurisdiction picks the endpoint. The VM gets a temporary credential limited to
one Bucket: read-only for input, read-write for output and checkpoints. It lasts
36 hours and is renewed like the AWS token. The saved API token
needs account-level R2 read and write.

AWS, Azure, and GCP Jobs can use the selected compute identity for same-account
Buckets, including automatic spot checkpoints. Lambda and Local Jobs
require explicit storage credentials for checkpoint buckets, plus a storage
region for S3, because they do not provide a compatible native bucket identity.
Scoped cross-identity storage supports AWS and Cloudflare R2. Checkpointed Services
use their selected compute identity unless `--checkpoint-storage-credentials`
names a separate AWS or Cloudflare credential.
