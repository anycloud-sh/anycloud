---
title: cluster
description: Create, inspect and delete the installation's Kubernetes cluster and update the API it hosts.
---

# `anycloud cluster`

An installation has **one Kubernetes cluster**: a management VM in your cloud
running a pinned K3s server and the Anycloud API released onto it as a Helm
chart.
`anycloud cluster create` builds it, `anycloud api use` points the CLI at the
API it hosts, and `anycloud cluster delete` releases it.

## Create the cluster and install the API

```bash
anycloud cluster create <name> \
  [--cloud aws|gcp|azure] \
  [--region <region>] \
  [--zone <zone>] \
  [--vm-type <type>] \
  [--checkpoint-bucket <name>] \
  [--sign-in-apps <id,...>] \
  [--json]
```

Create runs on this machine through your cloud's own CLI, `aws`, `gcloud` or
`az`, signed in as you. It needs no Docker, no local API and no saved cloud
credential, and it stores nothing on this machine. In a terminal, without
`--cloud`, create offers the clouds whose CLI is signed in here, or uses the
only one. It also asks for `--vm-type` and `--region` when you leave them out, and
offers only regions that have the chosen VM type; `--zone` needs `--region`.
Without a terminal, or with `--json`, it names the missing flags and exits
with status 2.

Create then:

1. names the account (AWS account, GCP project or Azure subscription) and the
   identity the CLI is signed in as, and checks that the identity holds the
   [cloud rights](#cloud-rights) create needs. A missing right stops create,
   naming it, before anything is bought. When the cloud can't answer for the
   identity (the AWS root, a federated user, or an identity that may not read
   its own rights), create says so and continues;
2. resolves this CLI's version to the API image's immutable digest and the
   digest of the chart that image names, so an unpublished version fails
   before anything is bought;
3. creates the management VM, its network, the VM's own cloud identity and
   the managed checkpoint bucket: one CloudFormation stack on AWS, one ARM
   deployment into the installation's resource group on Azure, and a few
   `gcloud` calls on GCP. Every resource that takes tags or labels carries the
   `anycloud_cluster` tag (a label on GCP) with the cluster's ID; GCP's
   firewall rules and service account are named from the ID;
4. leaves the rest to the VM's startup script, which installs a pinned K3s
   server and the API release. The release values hold no secrets, and the
   VM makes its own TLS key. They carry the **cluster record** that delete
   and upgrade need: the cloud and its account (the AWS account, GCP project
   or Azure subscription), region, zone, VM type, the management VM's
   provider ID, the network scope `anycloud-cluster-<id>` its network
   resources are named and tagged with, the K3s version and checksum, and the
   checkpoint bucket with whether Anycloud manages it;
5. once the VM's public address is known, publishes the API's DNS record
   **`<cluster-id>.anycloud.sh`** → that address (proxied through Cloudflare,
   with your GitHub token), marked as awaiting bootstrap; and
6. waits until the API answers at **`https://<cluster-id>.anycloud.sh`** and
   its first backup has landed in the checkpoint bucket.

```text
[12:00:00] Using aws account 123456789012 as arn:aws:iam::123456789012:user/ops
[12:00:01] Creating cluster prod (ID: <cluster-id>)
[12:00:02] Deploying the management VM in us-east-2
[12:02:40] Published <cluster-id>.anycloud.sh at <management-vm-ip>
[12:02:51] Waiting for the API and its first backup
✓ Cluster prod is running.
Next: anycloud api use https://<cluster-id>.anycloud.sh
```

Create never reports a running cluster without a backup. A first backup that
fails stops create with its error; an API that doesn't answer within 25
minutes stops it too. `--json` prints the cluster, or on failure
`{"error":{"code","message"}}` with `CLOUD_CLI_UNAVAILABLE` (the cloud CLI
is missing or signed out), `CLOUD_RIGHTS_MISSING`, `RESTORE_REFUSED`, `FIRST_BACKUP_FAILED`,
`API_NOT_READY`, `INVALID_ARGUMENT` (exit status 2) or `UNEXPECTED` (anything
else, such as a failed cloud CLI call while deploying). Every code but
`INVALID_ARGUMENT` exits with status 1.

**Re-running `create` with the same name and region resumes** the cluster.
The cloud's `anycloud_cluster_name` tag, not this machine, records it, so a
re-run from another machine resumes too. Repeat `--checkpoint-bucket` when the
cluster backs up to a bucket you supplied: for a deployed cluster, create names
that bucket and exits with status 2 when the flag is missing or names another
bucket. A deployed cluster that backs up to its own `<cluster-id>` bucket also
resumes without the flag.

**The checkpoint bucket** holds the hosted API's backups. The VM's own identity
reaches it: an AWS instance profile, an Azure user-assigned managed identity or
a GCP service account attached to the VM, which may write objects but never
delete object versions. That identity is never attached to workload VMs.
`--checkpoint-bucket` names a bucket you own in the CLI's account, which
Anycloud never deletes (except the cluster's own managed bucket, named by its
ID, which stays managed when create is given it back); one holding a backup makes create a
[restore](#recover-after-losing-the-management-vm). Without the flag, create
makes an Anycloud-managed bucket named after the cluster ID, with object
versioning; `delete` keeps it unless you pass `--delete-buckets`.

**`--sign-in-apps`** lists the GitHub Apps, by App ID, whose user tokens the
API exchanges for its own API tokens, as it does an `anycloud login` sign-in;
see [API tokens](/reference/cli/api-utilities#api-tokens). The list rides
in the release values and seeds the API's database on its first start; its
owner replaces it with
[`api upgrade --sign-in-apps`](/reference/cli/api-utilities#upgrade-the-api).

### Cloud rights

The identity the cloud CLI is signed in as needs these rights. They cover the
management VM and its network, the VM's identity, the checkpoint bucket, and
deleting all of them again.

AWS (IAM actions):

```text
cloudformation:CreateChangeSet
cloudformation:DeleteStack
cloudformation:DescribeChangeSet
cloudformation:DescribeStackEvents
cloudformation:DescribeStacks
cloudformation:ExecuteChangeSet
cloudformation:GetTemplateSummary
ec2:AuthorizeSecurityGroupIngress
ec2:CreateSecurityGroup
ec2:CreateTags
ec2:DeleteSecurityGroup
ec2:DescribeInstanceAttribute
ec2:DescribeInstances
ec2:DescribeNetworkInterfaces
ec2:DescribeSecurityGroupRules
ec2:DescribeSecurityGroups
ec2:DescribeVolumes
ec2:RevokeSecurityGroupIngress
ec2:RunInstances
ec2:TerminateInstances
iam:AddRoleToInstanceProfile
iam:CreateInstanceProfile
iam:CreateRole
iam:DeleteInstanceProfile
iam:DeleteRole
iam:DeleteRolePolicy
iam:GetInstanceProfile
iam:GetRole
iam:GetRolePolicy
iam:ListAttachedRolePolicies
iam:ListInstanceProfilesForRole
iam:ListRolePolicies
iam:PassRole
iam:PutRolePolicy
iam:RemoveRoleFromInstanceProfile
iam:SimulatePrincipalPolicy
iam:TagRole
s3:CreateBucket
s3:DeleteBucket
s3:DeleteObjectVersion
s3:GetObject
s3:ListBucket
s3:ListBucketVersions
s3:PutBucketPublicAccessBlock
s3:PutBucketTagging
s3:PutBucketVersioning
ssm:GetParameters
tag:GetResources
```

GCP (IAM permissions on the project):

```text
compute.disks.create
compute.firewalls.create
compute.firewalls.delete
compute.firewalls.get
compute.firewalls.update
compute.globalOperations.get
compute.instances.create
compute.instances.delete
compute.instances.get
compute.instances.list
compute.instances.setLabels
compute.instances.setMetadata
compute.instances.setServiceAccount
compute.instances.setTags
compute.networks.get
compute.networks.updatePolicy
compute.subnetworks.use
compute.subnetworks.useExternalIp
compute.zoneOperations.get
iam.serviceAccounts.actAs
iam.serviceAccounts.create
iam.serviceAccounts.delete
iam.serviceAccounts.get
iam.serviceAccounts.list
resourcemanager.projects.getIamPolicy
resourcemanager.projects.setIamPolicy
storage.buckets.create
storage.buckets.delete
storage.buckets.get
storage.buckets.getIamPolicy
storage.buckets.list
storage.buckets.setIamPolicy
storage.buckets.update
storage.objects.delete
storage.objects.get
storage.objects.list
```

Azure (actions on the subscription):

```text
Microsoft.Authorization/roleAssignments/delete
Microsoft.Authorization/roleAssignments/write
Microsoft.Compute/virtualMachines/write
Microsoft.ManagedIdentity/userAssignedIdentities/assign/action
Microsoft.ManagedIdentity/userAssignedIdentities/write
Microsoft.Network/networkInterfaces/join/action
Microsoft.Network/networkInterfaces/write
Microsoft.Network/networkSecurityGroups/join/action
Microsoft.Network/networkSecurityGroups/write
Microsoft.Network/publicIPAddresses/join/action
Microsoft.Network/publicIPAddresses/write
Microsoft.Network/virtualNetworks/subnets/join/action
Microsoft.Network/virtualNetworks/write
Microsoft.Resources/deployments/read
Microsoft.Resources/deployments/write
Microsoft.Resources/subscriptions/resourceGroups/delete
Microsoft.Resources/subscriptions/resourceGroups/write
Microsoft.Storage/storageAccounts/blobServices/containers/write
Microsoft.Storage/storageAccounts/blobServices/write
Microsoft.Storage/storageAccounts/listKeys/action
Microsoft.Storage/storageAccounts/write
```

**The API's URL is `https://<cluster-id>.anycloud.sh`.** Cloudflare
terminates TLS and reaches the management VM on port 443 or 80, admitted from
Cloudflare's ranges only, where Traefik routes the hostname to the API. On 443
Traefik serves a Cloudflare Origin CA certificate for the hostname. The VM
generates its key, and the DNS Worker signs it only for a request from the
record's own address while the record awaits bootstrap. `delete` revokes
it. Once 443 serves the certificate, Cloudflare connects to it in Full
(strict) mode, so the hop to the VM is encrypted and verified. The record is
created once and never re-pointed, because the VM's address is stable for its
life. `delete` removes it.

The hosted API **records the cluster it runs in** on its first start, from its
release values: it reads the `kube-system` UID through its own ServiceAccount
and refuses to start when that UID differs from the one its release values
name, then keeps the cluster record on its own row, which its
[backups](#back-up-and-upgrade-the-hosted-api) carry. The record is immutable;
a restored database instead adopts the new cluster with its new record (see
[recovery](#recover-after-losing-the-management-vm)). It lists under
`anycloud cluster list` with the cluster's location and VM type. A cluster
created before 0.1.74 has no record on its hosted API, which shows only its
ID, address and API version. No kubeconfig or token is stored for it; the
API's authority is its chart-bound ServiceAccount (see
[Cluster authority](#cluster-authority)). It starts with an empty database:
before launching workloads, add their cloud credentials there
(`anycloud credentials new` against the hosted API).

## Inspect and delete

```bash
anycloud cluster list
anycloud cluster status <id-or-name> [--watch] [--interval <seconds>]
anycloud cluster delete <id-or-name> [--delete-buckets] [--confirm <cluster-id>]
  [--cloud aws|gcp|azure --region <region>] [--checkpoint-bucket <name>]
  [--delete-vms] [--skip-cloud]
```

`list` shows the clusters this API knows with their location, VM type, age,
address, installed API version and state; `status` shows one in the Workload
status layout (state, cloud, VM, address, Kubernetes and API versions, URL,
age and last error), and `--watch` refreshes it until the cluster
is `running`, `failed` or fully `terminated`. Against a hosted API, its own
cluster shows the cloud, account, region and VM type from its record, and the
address, API version and URL it knows of itself. `list` also accepts `ls` and `get`, and `status`
accepts `describe`.

`delete` (aliases `terminate`, `rm`) asks the hosted API to delete its
installation, and the API deletes itself last. The API refuses
(`SELF_DELETE_REFUSED`) while a running VM Service or VM Job remains, naming
each: run `anycloud terminate <id>` against the hosted API, then `delete`
again. A hosted API on an older release that still has node pools is refused
the same way until they are deleted on that release. Otherwise the API takes a final backup, answers,
waits for its Workloads' cleanups (their VMs and per-Job buckets, through the
credential that made them), deletes any VM left tagged for the cluster, and
asks its cloud to delete its own stack (AWS), resource group (Azure) or
instance (GCP). The CLI follows it, then your cloud CLI until the installation
is gone, runs the cloud's last steps with your own sign-in (AWS: the
CloudFormation service role; GCP: the firewall rules and service account),
and removes the `<cluster-id>.anycloud.sh` DNS record and certificate. A
Workload whose cleanup never commits, for example because its credential was
deleted, is listed in `remaining` with its ID. If the API can't delete a VM,
it stops there, still answering, and `delete` exits non-zero with what is
left; run it again once it can finish.

The managed checkpoint bucket is kept by default, with its backups, and the
result prints its restore command and `anycloud cluster delete <cluster-id>
--delete-buckets`, which deletes it later from any machine. `--delete-buckets`
deletes it now, with every backup; the cluster can't be restored afterwards.
In a terminal it asks for the cluster ID to be typed; without one, or with
`--json`, it needs `--confirm <cluster-id>` (`CONFIRMATION_REQUIRED`), and
`--yes` never confirms it. A bucket you supplied is never deleted. The
cluster's own managed bucket, named by its ID, stays managed when create is
given it back, in a restore or a resume.

### Delete with the hosted API gone

When the hosted API doesn't answer (a refused connection, a DNS or TLS
failure, a timeout, or Cloudflare's 5xx with no origin behind it),
`delete <cluster-id> --cloud <cloud> --region <region>` runs against your own
cloud CLI (`aws`, `az` or `gcloud`) on any machine signed in to the cluster's
account. It takes the cluster
**ID**, which create prints; finding a cluster by name without its API isn't
supported. It first asks `https://<cluster-id>.anycloud.sh/health` and refuses
(`API_REACHABLE`) while that answers. Nothing is deleted until three guards
pass:

1. **The recorded account.** Delete reads `anycloud-api/backup.json` from the
   bucket and refuses (`ACCOUNT_MISMATCH`) unless your CLI is signed in to
   the account it records. Without one, such as after a create that failed
   before its first backup, the account must show the installation or hold
   resources named or tagged with the cluster ID; finding neither, delete refuses
   and keeps the DNS record (`ACCOUNT_UNCONFIRMED`).
2. **The management VM is gone or stopped.** A running one is refused
   (`MANAGEMENT_VM_RUNNING`): the API may be unreachable only from this
   machine. A stopped one still holds the API's disk: on Azure, start it and
   delete normally; elsewhere delete it with `--delete-vms`. An installation
   still changing, or one whose create or delete failed, is refused
   (`INSTALLATION_INCOMPLETE`) with the cloud's status, whether or not it
   holds a VM; delete it with `--delete-vms`.
3. **Each deletion has its own flag.** Without one, delete only lists what it
   would delete. `--delete-vms` deletes the stack, group or instance and the
   VMs tagged `anycloud_cluster=<cluster-id>`; `--delete-buckets`
   also deletes the managed bucket. Each asks for the same confirmation.

What it can't delete is listed in `remaining` with the tag or name to search
for. `--skip-cloud` forgets a cluster whose cloud account is gone: it deletes
nothing in the cloud and removes the DNS record only once your CLI shows the
installation gone. Its outcome is `abandoned`.

Clusters created before anycloud 0.1.74 are torn down by hand: delete the
management VM and its network (tagged `anycloud_resource=anycloud-cluster-<cluster-id>`),
the VMs, disks and networks tagged `anycloud_cluster=<cluster-id>` (
or `anycloud_owner_api=<identity>`), the checkpoint bucket (named for the
cluster ID), and the `<cluster-id>.anycloud.sh` DNS record with `cluster
delete <cluster-id> --skip-cloud`.

`delete --json` prints `{ "outcome", "clusterId", "finalBackup", "deleted",
"remaining" }`; `outcome` is `destroyed`, `planned` or `abandoned`.

Each command accepts `--json`.

`--json` reports these fields:

| Field                                                   | Meaning                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`, `name`, `state`, `releasing`                      | Record identity, the Workload state, and whether the management VM is still being released           |
| `cloudProvider`, `region`, `zone`, `vmType`             | Where the management VM runs (null on a hosted API's record from before 0.1.74)                      |
| `cloudAccount`                                          | The AWS account, GCP project or Azure subscription; on the hosted API's record only                  |
| `managementVmId`, `networkScope`                        | The management VM's provider ID and the `anycloud-cluster-<id>` name of its network resources        |
| `k3sVersion`, `apiVersion`, `apiImage`, `chartVersion`  | The pinned control plane, the installed API and its chart                                            |
| `connected`, `kubernetesIdentity`, `connectionRevision` | Whether the installer can reach the cluster, the observed `kube-system` UID, the connection revision |
| `address`                                               | The management VM's public address                                                                   |
| `managementApiUrl`                                      | `https://<cluster-id>.anycloud.sh`, the `anycloud api use` target; an installer's once released      |
| `release`                                               | The installed API release: `apiVersion`, `apiImage`, `chartVersion`; null until it is installed      |
| `checkpointBucket`                                      | `name` and `managed` of the hosted API's backup bucket; null once `--delete-buckets` deleted it      |
| `lastError`                                             | The last reconciliation error, or null                                                               |

`delete --json` prints `outcome`, `clusterId`, `finalBackup` and two lists,
`deleted` and `remaining`:

```json
{
  "outcome": "destroyed",
  "clusterId": "<cluster-id>",
  "finalBackup": "taken",
  "deleted": [
    {
      "kind": "cloudResource",
      "type": "identity",
      "id": "anycloud-<cluster-id>-cfn",
      "location": null
    },
    { "kind": "dnsRecord", "name": "<cluster-id>.anycloud.sh" }
  ],
  "remaining": [
    {
      "kind": "checkpointBucket",
      "name": "<cluster-id>",
      "managed": true,
      "reason": "kept",
      "restoreCommand": "anycloud cluster create <name> --cloud aws --region us-east-1 --checkpoint-bucket <cluster-id>",
      "deleteCommand": "anycloud cluster delete <cluster-id> --delete-buckets"
    }
  ]
}
```

`reason` is `kept`, or `supplied` for a bucket you supplied (it has no
`deleteCommand`). `finalBackup` is `taken`, `failed`, `skipped` (under
`--delete-buckets` with a managed bucket) or null with the API gone. A
remaining `cloudResource` names the tag or name to search for in `selector`.

See [Clusters](/platform/clusters) for the end-to-end path from `create` to a
running Service.

### Results for scripts

`cluster create` and
[`api upgrade`](#back-up-and-upgrade-the-hosted-api) are the commands an
embedding product drives, and each is safe to re-run. With `--json`, stdout
holds one JSON document: the result, or the failure

```json
{ "error": { "code": "CLUSTER_EXISTS", "message": "…" } }
```

where `code` is the API's error code (`CLUSTER_EXISTS`, `CLUSTER_BUSY`,
`SYSTEM_RELEASE_REFUSED`, …) or one of the CLI's:
`INVALID_ARGUMENT` (a missing or invalid flag), `API_UNREACHABLE` (no answer
from the API, or it is restarting), `LOCAL_API_STILL_STARTING`,
`HOSTED_API_STILL_STARTING`,
`REMOVED_WORKLOADS_REMAIN` (`api upgrade`: node pools, Deployments or node pool
Services remain) or `UNEXPECTED`. Progress lines go to stderr. When the command needs a GitHub
sign-in, the document is instead the
[`actionRequired` relay](/reference/cli/api-utilities#anycloud-login) with the device
code, and the exit status is `2`: approve the code and run it again.

| Exit  | Meaning                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------- |
| `0`   | Done, or accepted where the command returns before the work finishes                                      |
| `1`   | Refused with an API error code, or the operation ended `failed`                                           |
| `2`   | Not run: a usage error, an unreachable API, or a GitHub sign-in it needs (`actionRequired`); run it again |
| `4`   | A `--wait` timed out, or the new local or hosted API was still starting                                   |
| `130` | Interrupted with Ctrl-C; no document is printed                                                           |

`cluster delete` is not on this contract yet: `--json` prints the result above,
the cluster when the delete ends `failed`, or `CONFIRMATION_REQUIRED`; any
other failure exits `1` with the message on stderr.

`cluster create --json` prints the cluster as `status --json` does, once it is
recorded; `anycloud wait cluster/<id>` or `cluster status <id> --watch --json`
follows it. A re-run with the same name and settings resumes the creation or,
once it is running, answers with the cluster.

## Back up and upgrade the hosted API

The API on the cluster backs its SQLite database up **hourly and before every
self-update**: an online SQLite backup (writes continue; the copy is
consistent) uploaded whole to `anycloud-api/database.sqlite` in the
cluster's checkpoint bucket. History is the bucket's own **object
versioning** — on for a managed bucket; on a bucket you supplied the hourly
timer refuses to start — and says so in the API log — until versioning is
enabled (`aws s3api put-bucket-versioning --bucket <name>
--versioning-configuration Status=Enabled`, `gcloud storage buckets update
gs://<name> --versioning`, or `az storage account blob-service-properties
update --account-name <account> --enable-versioning true`), then restart the
API. The **pre-release backup still runs without versioning** and replaces
the previous object, so until versioning is on exactly one copy exists — the
latest pre-release one. Each backup also uploads the API's cipher key to
`anycloud-api/cipher.key`, then writes `anycloud-api/backup.json` last, naming
the installation, the backup time, the schema version and the database's
SHA-256. The manifest also lists where the installation's resources live, with
no secret: each saved credential's name, cloud and account (AWS account, GCP
project or Azure subscription; a Lambda key names none). Saving a credential
runs a backup too, so the list doesn't wait for the hourly one.
**Anyone who can read the bucket can decrypt every stored cloud
credential and secret**: keep it private, readable only by you, the installer
and the API. The compute credential travels in the release values
as a chart Secret on the cluster.

```bash
anycloud api upgrade [--image ghcr.io/anycloud-sh/api:<version>@sha256:<digest>]
```

Node pools, Kubernetes Deployments and node pool Services are removed.
Before anything changes, `api upgrade` lists a hosted API's node pools,
Deployments and live node pool Services and refuses while any remain, naming
each, with the error code `REMOVED_WORKLOADS_REMAIN`. Remove
them on the current release, Services first, then Deployments, then node
pools, and upgrade again. Run Jobs as [VM Jobs](/platform/jobs) and
long-running processes on a [VM](/platform/vms) or as a
[VM Service](/platform/services).

With the hosted API active, `anycloud api upgrade` (alias `update`) asks it for this CLI's
release (`POST /v1/system-release`) — any GitHub account the API admits, no
installer, Docker or cloud credentials involved. The API pins the release tag
to its published digest (or refuses with the version named when none is
published), refuses an image that is not from `ghcr.io/anycloud-sh/api`, and
applies the rule it applies to itself at startup: a target older than the
version its database was last used by is refused, because that image would
refuse to start. The serving API stamped that version when it started, so
every target older than it is refused; going back means restoring the
pre-upgrade backup. The API then backs its
database up, records the upgrade durably, and patches its own
`HelmChart` — the target image's chart, and image and revision in the release values — through its own
in-cluster ServiceAccount, against the cluster record it wrote on start (the
`HelmChart` must name this cluster, or the upgrade is refused).
helm-controller applies the change:
the chart's pre-upgrade guard refuses a revision that is not newer than the
running one, and the API's Kubernetes Deployment object is recreated with the new image while the API
stays `running`. The command returns once the upgrade is recorded, printing the
verdict as a plain line — `Hosted API upgrade N started: <old> → <version>`,
`already matches anycloud <version>` or `already runs <image>; nothing to do
(unchanged)`, or `Hosted API upgrade refused: <reason>` on stderr — so scripts
read it without a terminal. With `--json` it prints one
[result](#results-for-scripts) instead:

```json
{
  "outcome": "started",
  "api": {
    "url": "https://<cluster-id>.anycloud.sh",
    "previousVersion": "0.1.73",
    "version": "0.1.74"
  },
  "upgrade": 4,
  "k3s": { "configuration": "changed" }
}
```

`outcome` is `started` (upgrade `upgrade` began), `unchanged` (it already runs
the release; `version` is the served one), `accepted` (an API older than this
CLI took it without naming the version, so `version` is null) or `local` (the
active API is the local one, now on `version`). `k3s` is the
[K3s step](#back-up-and-upgrade-the-hosted-api)'s result: `configuration` is `changed`
when it restarted K3s onto a new server configuration, or `current`; it is
null when the step didn't run. A refusal is the error document with the API's code, such as
`SYSTEM_RELEASE_REFUSED`; running it again after the cause is fixed resumes. `anycloud api status` (`GET /v1/system-release`)
shows the served version, the schema version and `Upgrade N · <version>`
with one `✓`/`◌`/`✗` line: `starting` until the release's ready check Job
succeeds, then `running`, or `failed` with the reason. The API answers from
inside the cluster, so right after an upgrade the public URL may answer 503
for a few seconds while the edge reconnects; retry. These two calls accept the
previous release's CLI or any newer one; see
[Hosted APIs](/platform/hosted-apis#upgrade-a-hosted-api) for the other calls'
version window. With a hosted API active, `api upgrade` touches neither the
local API nor Docker, so it runs on any machine with the CLI.

Before it asks for the image upgrade, `api upgrade` has the hosted API bring K3s's server
configuration to the new release's, from any machine and with no SSH
(`POST /v1/system-release/kubernetes`). The hosted API runs a one-shot Job on
the management Node with the new release's image. The Job is anycloud's own,
privileged and in the host's PID namespace. It hands the work to a transient
systemd unit on the host, so the K3s restart can't stop it. The unit labels
the management Node `node-restriction.kubernetes.io/anycloud-management=true`,
writes the configuration with the server token the host already holds, and
restarts K3s only when the configuration changed. It then waits up to 5
minutes for the Kubernetes API server to be ready again. Pods keep running
through the restart. `api upgrade` prints the result, for
example `K3s step: configuration changed, Kubernetes ready`, and
`anycloud api status` shows the latest one as `K3s step`. If the step fails,
the image upgrade is not requested, and running the command again runs the
step again.

## Recover after losing the management VM

Restore is `cluster create` pointed at the lost cluster's checkpoint bucket:

```bash
anycloud cluster create prod --cloud aws --region us-east-1 \
  --vm-type t3.large --checkpoint-bucket my-api-state
```

When the bucket holds a backup (`anycloud-api/backup.json`), create reuses the
backup's cluster ID, so `https://<cluster-id>.anycloud.sh` keeps working. It
refuses a backup written by a newer API; run `anycloud update` and retry. Before
the new API first starts, it fills the API's empty state volume with the
backup's cipher key and database. A database that does not match
`backup.json` is refused because the backup was interrupted: in the bucket's
version history, restore the `anycloud-api/database.sqlite` version whose
SHA-256 the error names, then create again.

Before anything is bought, create refuses the restore (`RESTORE_REFUSED`) unless
`backup.json` names the cloud and account the cloud CLI is signed in to, since
a lookup in another account cannot see the old cluster. It also refuses while
the backed-up cluster's management VM still exists in the region the backup
records, in any state, because two APIs must never write one bucket. The one
exception is a running or still-deploying installation this name already holds
under the backup's cluster ID: re-running create, after a restore or after a
create into that bucket, resumes it. One whose management VM is stopped or
gone is refused until you delete it, and a name that holds another cluster is
refused. Given back the bucket Anycloud made for the cluster
(`--checkpoint-bucket <cluster-id>`), a restore or resume keeps managing it, so a later
`delete --delete-buckets` deletes it; any other bucket stays yours and `delete`
keeps it.

On its first start the restored API adopts the new cluster. Jobs that were
running at the last backup are retried; a Job that finished after it runs
again. Kubernetes state itself is not backed up.

Up to one backup interval of changes is lost, since backups run hourly and
before every update. Make sure the old management VM is gone before you
restore: two APIs must never write the same bucket.

## Cluster authority

The hosted API applies its own release, runs host steps on the management Node
and observes both through the `anycloud-api` ServiceAccount the chart binds to
a `ClusterRole` (`charts/anycloud-api/templates/rbac.yaml`): `get`, `create`,
`patch` and `delete` Namespaces; `get` and `patch` Nodes (the management
Node's label); Secrets and ServiceAccounts for its release; `get`, `list` and
`watch` Pods, with `get` on `pods/log` and `list` on events, for diagnostics;
`get`, `list` and `watch` `apps` Deployments (its own rollout); `batch` Jobs
(release hooks and host steps); and `helm.cattle.io` HelmCharts and
HelmChartConfigs (cluster add-ons and the API's own release). A namespaced
Role lets it mint tokens for itself and the trust probe, which
[role connections](/reference/cli/credentials) use. **No credential for this
authority is stored or exported**: no kubeconfig and no token row.

The cluster's management Node carries the standard control-plane taint
`node-role.kubernetes.io/control-plane=true:NoSchedule` and the label
`node-restriction.kubernetes.io/anycloud-management=true`, which only the API
can set, never a Node itself. Create sets both, and `api upgrade` sets the
label again before it asks the hosted API to upgrade. The API, its hook Jobs
and its Traefik select that label. The API moves its Traefik onto the
label when it starts, so an upgraded cluster's Traefik follows.

There is no command to register an existing Kubernetes control plane: the
installation's cluster is the one `anycloud cluster create` creates, and the
hosted API's record of it is written by the API itself.

## Lifecycle states

The Workload states: `provisioning`, `initializing` and `starting` while it is
created, `failed` (a failed create or delete; a failed delete's `Last error:` starts
with `Delete failed:`), and `terminated` (with the "releasing" label while the management VM
is still being released). The
record is removed only by `anycloud cluster delete`, which the hosted API
refuses (`SELF_DELETE_REFUSED`) while a running VM Service or
Job remains, naming each (see [delete](#inspect-and-delete) above). Each command accepts `--json`.

## What create makes on AWS

On AWS, `create` deploys one CloudFormation stack, `anycloud-<cluster-id>`,
through your own `aws` CLI. It tags every resource that supports tags with
`anycloud_cluster`, `anycloud_cluster_name` and `anycloud_owner_api`. The stack
holds:

- **The management VM:** Ubuntu 24.04 in the default VPC, whose user-data is
  the startup script that brings up K3s and the API. Its metadata service
  requires IMDSv2 with a hop limit of 2.
- **A security group:** TCP 6443 (the K3s server) from anywhere, and
  TCP 80 and 443 from Cloudflare's ranges only. No SSH.
- **The VM's role and instance profile, `anycloud-<cluster-id>-vm`.**
  Workloads launch on the connections you add to the API, never on
  this role. It can only:
  - list the account's regions, then terminate, delete or cancel the
    instances, volumes, network interfaces, security groups and spot requests
    tagged with this cluster or with its API's `anycloud_owner_api`, when the
    API deletes the cluster;
  - read and write the checkpoint bucket, but not delete object versions or
    the bucket;
  - delete its own stack through the delete role.
- **The delete role, `anycloud-<cluster-id>-cfn`:** CloudFormation deletes the
  stack under it, so the delete never loses its rights partway through. The
  stack's own delete keeps this role, and `delete` removes it afterwards.
- **The checkpoint bucket:** versioned, and kept when the stack is deleted.
  With `--checkpoint-bucket`, the stack uses your bucket and creates none.
