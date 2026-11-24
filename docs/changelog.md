---
sidebar_position: 9
description: 'Release notes for anycloud: deployments, credential-scoped commands, diagnostics, and other CLI / API changes per version.'
---

# Changelog

## 0.1.83

### AWS launches skip a zone out of capacity at once

When EC2 has no capacity in a zone, anycloud now tries the next zone, type or region immediately instead of retrying that zone for up to a minute. In testing, spot Jobs that met a full zone started in 10–14 s rather than 40–47 s.

### CPU VM Jobs start sooner on GCP

A CPU VM Job host on GCP no longer copies system logs to the slow serial console while booting. In testing, the median time from network start to container start fell from 40.4 to 29.1 s.

### CPU VM Jobs start sooner on Azure and AWS

A CPU VM Job host now pulls the image once containerd is up. In testing, network-to-container time fell from 26.5–32.9 s to 21.6–24.4 s on Azure, and from 13.3 to 12.1 s (median) on AWS. The `running` event's [`bootMarks`](/reference/cli/workloads#anycloud-status) times each start step.

## 0.1.82

### GCP generated credentials can launch VM Jobs

`anycloud credentials new --provider gcp --generate` now grants the published `anycloud` role, creating it or adding missing permissions, so VM Jobs can create their network. Grant existing 0.1.81 generated keys the [role](/reference/cli/credentials#gcp-permissions) once.

## 0.1.81

### VM Jobs run in an anycloud-owned network on AWS and GCP

Breaking: AWS and GCP VM Jobs now launch into an `anycloud-jobs` VPC or network and can't reach private addresses in your default network. Re-run each role connection's setup; key credentials need the new [network grants](/platform/jobs#vm-job-network).

### `cluster create` and `cluster delete` are now `api create` and `api delete`

Create a hosted API with `anycloud api create <name>` and delete it with `anycloud api delete <name>`; `--skip-cloud` still forgets one whose cloud resources are gone. `anycloud cluster list` and `cluster status` are unchanged.

### Upgrading drops node pool and Deployment history

The upgrade deletes the records of ended node pools, Deployments, their Jobs and node pool Services, including node pool VM costs, so `anycloud spend` and spend limits stop counting them.

### `api access --service-account` is removed

A registered Deployment no longer calls a hosted API with its Pod's ServiceAccount token, and `anycloud api access add|remove --service-account` is gone. Give a program an owner-issued service token with `anycloud api access add --service <name>` instead.

### Node pools, Kubernetes Deployments and node pool Services are removed

anycloud now runs VMs, VM Jobs and VM Services: run Jobs as VM Jobs, and long-running processes on a VM or VM Service. `anycloud api upgrade` refuses while a hosted API still has node pools, Deployments or node pool Services, naming each; delete them first.

## 0.1.80

### Secrets saved while a Job starts reach it at once

A Secret saved while its Job, Service or VM is still starting now reaches the container's `/run/anycloud-secrets` files as soon as it runs, instead of up to 30 seconds later.

## 0.1.79

### anycloud is open source under Apache-2.0

anycloud, including the CLI, the API image and the Python SDK (previously MIT), is now licensed under the Apache License 2.0. Release tarballs, the Homebrew formula and the API image include its LICENSE and NOTICE.

### On-demand VMs restart after the cloud stops them

When a cloud stops an on-demand persistent VM or Job's VM, for example for GCP host maintenance, anycloud now starts it again in place with its disk and new IP. Persistent VMs keep retrying while the zone lacks capacity.

### Hosted APIs accept GitHub App sign-ins

A hosted API exchanges user tokens of GitHub Apps its owner lists with `anycloud cluster create --sign-in-apps <ids>` or `anycloud api upgrade --sign-in-apps <ids>`. Private GHCR images, Services, clusters and `api access add` still need `anycloud login`.

### Service tokens for hosted APIs

The owner of a hosted API can issue a token for a program, such as CI, with `anycloud api access add --service <name>`, replace it with `anycloud api token rotate --service <name>` and revoke it with `anycloud api access remove --service <name>`.

## 0.1.78

### Faster `anycloud list --credentials` on large histories

Listing workloads with `--credentials` no longer stalls a self-hosted API for seconds per call on large histories. On a 41,000-workload history, one such list dropped from 9 seconds to 55 milliseconds.

## 0.1.77

### VM Job hosts run Docker 29 with parallel image unpacking

CPU VM Job hosts now run Docker 29 on the containerd image store and unpack layers in parallel: a 2 GB image pulls and starts 7–14 s sooner but takes about 0.8 GB more disk. `docker save` writes OCI archives, and multi-platform `buildx` builds work.

### VM Job hosts set up Docker faster and more reliably

VM Job hosts now fetch Docker's networking packages from their cloud's regional Ubuntu mirror, falling back to archive.ubuntu.com, and install faster image decompression before Docker starts. Archive timeouts no longer delay some hosts by minutes.

### Root installs of the CLI are owned by root

The installer now leaves `anycloud` owned by root when run as root or when it updates an admin-owned install; before, another account could own and replace it. If you installed as root, run `anycloud update` to fix the owner.

## 0.1.76

### Stuck Azure VMs are deleted promptly

When an Azure VM stalls while being created, Anycloud now deletes it within about a minute of giving up on it, instead of after up to an hour, so the stuck VM stops billing and releases its public IP.

### Role connections ride out a Kubernetes API server restart

A self-hosted API using role connections now waits up to about two minutes for a restarting Kubernetes API server, such as during a signing-key rotation, instead of failing the Job's setup and spending one of its retries.

### Azure VM Jobs get a stop signal on terminate

On Azure, terminating a VM Job now shuts its VM down gracefully first, so its processes get SIGTERM as on AWS and GCP. Custom Anycloud roles, including role connection roles, need `Microsoft.Compute/virtualMachines/powerOff/action` for this; without it, VMs are still deleted, just without the stop signal.

### Live Secret files on running VM Jobs, Services and VMs

Each attached Secret's keys are also read-only files at `/run/anycloud-secrets/<name>/<KEY>`, and saving the Secret updates them within seconds without a restart. Secrets named with a leading `_` are hidden from `anycloud secrets list` unless `--all` is passed.

### Mint prefix-scoped storage tokens

`POST /v1/credentials/{credentialName}/storage-tokens` returns short-lived AWS, GCP or Azure tokens for read or readwrite bucket prefixes. Any admitted member, including a registered Deployment, may mint, so code without cloud credentials can use the cloud's own SDK.

## 0.1.75

### Region-pinned VM Jobs fail over between their VM types

A VM Job pinned to one region that lists several VM types now tries its next type when the cloud reports no capacity, instead of retrying its first type indefinitely.

### AWS Jobs skip regions the account hasn't enabled

An unpinned AWS VM Job whose credential can't read account regions, such as a restricted key or role, no longer launches into regions the account hasn't enabled, which ended it Invalid as a bad credential.

## 0.1.74

### Spot VM Jobs cancelled right after launch no longer leak instances

Cancelling an AWS spot VM Job shortly after launch now cancels its spot request before terminating the VM. The resource sweep also cancels leaked spot requests and terminates the untagged instances EC2 launched for them.

### Full regions no longer slow a VM launch

When a cloud refuses a VM Job's, Service's or VM's launch for capacity or quota, anycloud now moves at once to a region or VM type it hasn't tried yet.

### Run a VM Job in any of a list of regions

`anycloud job --regions us-east-1,us-west-2` (Python SDK `regions`) lets a VM Job launch in any listed region and fail over between them after a capacity, quota or regional failure. It takes neither `--region` nor `--zone`.

### Spot Jobs with `--max-retries 0` end sooner

A spot VM Job on AWS or GCP with `--max-retries 0` whose container exits 0 now ends about two and a half minutes sooner, unless its VM has a reclaim notice.

### Saving credentials under a second name no longer breaks the first

`credentials new` with credentials already saved under another name now fails with `CREDENTIALS_EXIST`, naming the saved credential, instead of moving that name and breaking Jobs that reference it.

### Set a VM Job's AWS gp3 disk IOPS and throughput

`anycloud job --disk-iops N --disk-throughput MiBps` (Python SDK `disk_iops`, `disk_throughput_mibps`) sets the AWS gp3 root volume's performance, overriding `--disk-tier`, within AWS's limits. Other clouds refuse them, and the root is never grown to fit.

### Delete a role connection's cloud side

`anycloud credentials delete <name> --apply` also removes what `credentials new --role --apply` created, through your signed-in `aws`, `gcloud` or `az`. GCP keeps deleted IDs for 30 days, so a new `--apply` needs new ones.

### Status shows each VM's launched type

`anycloud status` and the status API now report the VM type each of a Workload's VMs launched as, next to its address. A Workload's own `vmType` still shows the types it asked for.

### Create a role connection from your terminal

`anycloud credentials new --role --apply` creates the role through your signed-in `aws`, `gcloud` or `az` and saves it without prompts; rerunning converges. Without a usable CLI it prints the manual steps. You own what it creates.

### `anycloud status` reports NVIDIA GPU health on GPU VMs

`anycloud status` now flags a GPU that needs a reset, logged a serious Xid error, or whose `nvidia-smi` hangs, and shows the workload `down`. It reports only. A GPU that stalls silently, without an Xid error, still reads healthy.

### Quota status reports reads it can't complete

`anycloud quota status` now shows a quota or region it fails to read as an unavailable row with the cloud's error, instead of dropping it, so you can tell a key still propagating from a missing quota.

### Quota status before an installation exists

`anycloud quota status --cloud aws|gcp|azure --region REGION` reads current quota limits through your signed-in `aws`, `gcloud` or `az`, with no API or saved credential, so you can check capacity before `cluster create`.

### Hosted API upgrades without Docker, and a clearer delete refusal

`anycloud api upgrade` against a hosted API no longer starts or restarts the local API, so it runs without Docker. `cluster delete` with the API gone refuses an unfinished or failed installation as `INSTALLATION_INCOMPLETE`, not `MANAGEMENT_VM_RUNNING`.

### Docker and KVM in VM Jobs without `--privileged`

`anycloud job --host-docker` gives a VM Job the host's Docker and `/workspace`, plus `/dev/kvm` with `--require-nested-virtualization`. `--privileged` is deprecated in its favor and will be removed. On GCP, VM Job hosts now refuse other VMs' traffic beyond their own rules.

### Faster VM Job cold start

CPU VM Jobs on AWS, GCP and Azure now boot Ubuntu minimal, which installs Docker and pulls a public image while anycloud connects, so a Job starts sooner. VM Jobs also accept `--max-retries`, `--no-checkpoint` and `--require-nested-virtualization`.

### `cluster create` runs through your cloud's own CLI

`anycloud cluster create --cloud aws|gcp|azure` now builds the cluster through the signed-in `aws`, `gcloud` or `az` CLI, with no Docker, local API or saved key, and returns once the first backup lands. `--credentials` is removed.

### `cluster delete` keeps the checkpoint bucket

`anycloud cluster delete` now takes a final backup and keeps the managed checkpoint bucket, so the cluster can be restored. Pass `--delete-buckets` (with typed confirmation, or `--confirm <name-or-id>`) to delete it too.

### `api upgrade` reconfigures K3s from any machine

The hosted API now updates its cluster's K3s configuration and labels the management Node itself, after pool Jobs drain. This replaces the creating machine's SSH reconfiguration and the label prompt; `api upgrade --yes`, which skipped that prompt, is removed.

### Lifecycle commands report results for scripts

`cluster create`, `node-pool create`, `node-pool delete` and `api upgrade` print one `--json` result or error code with documented exit statuses, and are safe to re-run. `cluster status` against a hosted API shows its cloud, account, region and VM type.

### Keyless role connections on AWS, GCP and Azure

On a self-hosted API, `anycloud credentials new <name> --provider aws|gcp|azure --role` prints a setup template for that cloud, then saves only the role's identifiers, with no secret. `credentials list` shows role connections. `--json` serves scripts; without a terminal, a missing value exits 2.

## 0.1.73

### Existing pool Nodes are replaced once

After the API upgrades, each node pool replaces its Nodes once, a spare first, so they get the new join script: Node caches on the scratch disk and the image pre-pull. A Node finishes its pool Jobs first; without room for a spare, the old Node goes first.

### User-namespace Jobs on node pools; privileged workloads deprecated

`node-pool create --user-namespace-jobs` runs each Job as root of its own user namespace, for container engines, nested clusters and `/dev/kvm`. `node-pool create --allow-privileged-jobs`, `job --privileged` and `deployment --privileged` are deprecated and removed next release: move those workloads to such a pool first.

### Privileged pool Jobs report OOM kills

A `--privileged` pool Job that runs out of memory now ends with "OOMKilled (exit 137)" instead of "Exited with code 137". A later Job on the same replica is no longer misreported as OOM-killed.

### Pool Nodes can't rewrite other Nodes' labels or status

A root process on a privileged pool Node can no longer use K3s's shared controller identity to change another Node's labels, conditions or addresses. One node pool's Node also can't stop another node pool by claiming it in a label.

### The macOS CLI launches on Apple Silicon

The macOS binaries now carry a valid ad-hoc code signature. Before, current macOS on Apple Silicon killed `anycloud` at launch (`zsh: killed`). A killed CLI can't run `anycloud update`: reinstall with `brew upgrade anycloud-sh/tap/anycloud` or `curl -fsSL https://get.anycloud.sh | sh`.

### New node pool Nodes pull recent Job images as they join

A new node pool Node now pulls the pool's runner and up to four recently used public Job images in the background, within its image disk allowance, so the next Jobs on it start sooner.

### Pool Jobs can share a Node cache with `--cache`

`anycloud job IMAGE --node-pool P --cache name:/path` mounts a directory that outlives the Job and is shared by the pool's Jobs on that Node, such as a pip or model cache. Any Job on the pool can read or overwrite it.

### Node pools with KVM on AWS, GCP and Azure

`anycloud node-pool create --require-nested-virtualization` keeps only VM types the catalog reports as supporting nested virtualization, launches them with it on, and gives every Node `/dev/kvm` for microVMs and emulators.

### Node pools can scale to zero

`anycloud node-pool create --min-vms 0` creates a pool that removes its last idle VM and buys VMs again when pool Jobs arrive. The first Job after an idle gap waits for a VM to boot and join.

## 0.1.72

### In-cluster clients authenticate with their ServiceAccount token

`anycloud api access add --service-account <deployment>` lets a Deployment on a hosted API's cluster call the API with its replicas' hourly, Pod-bound token from `ANYCLOUD_API_TOKEN_FILE`, instead of a stored API token.

### Privileged Jobs can't move their Node into another pool

A privileged Job can no longer move its Node into another pool or attract the API: both select labels only the API sets. `anycloud api upgrade` from a machine that didn't create the cluster prints a one-time label command; scripts pass `--yes` after running it.

### Guaranteed CPU for pool Jobs and Deployments that set `--cpus`

A pool Job or Deployment replica with `--cpus` now runs with Guaranteed QoS, so its CPU doesn't vary with its Node's other work. Its memory request equals its limit: at least 512 MiB, or the Node's allocatable memory if smaller.

### AWS bucket tokens last 12 hours

Bucket-scoped AWS tokens now last 12 hours instead of 36, for saved keys too. Running Jobs and Services still renew them, but a pool Job now rides out an API outage of about 6 hours instead of 18.

### Jobs can cap their automatic retries

`anycloud job --max-retries N` caps a node pool or Deployment Job's reruns after a reclaimed or lost Node or Pod, or a runner exit. A capped Job ends `failed` rather than `retries-exhausted`, with `endReason` naming its last attempt's cause.

### Spot pool Jobs can skip their checkpoint bucket

`anycloud job --node-pool <pool> --no-checkpoint` runs a stateless Job on a spot pool without the checkpoint bucket anycloud otherwise creates for it, so nothing is uploaded or restored and a reclaimed attempt reruns from the start.

### Pool Jobs keep running through an API upgrade

`anycloud api upgrade` no longer waits for running pool Jobs or stops them with `--force`: they keep running while the API is replaced. Jobs started before this release still drain once during the first upgrade to it.

### Structured end reasons for workloads

`status`, `list --json` and `wait --json` now say why a workload ended, as `endReason`: `exited`, `cancelled`, `reclaimed`, `lost`, `timeout`, `retries-exhausted` or `invalid`. After the retry budget runs out, `lastAttemptEndReason` names what ended the final attempt.

### A pinned CLI keeps working through one API upgrade

A CLI one release behind the API can still submit, list, inspect and stop workloads, manage Deployments, read node pools, credentials, quotas and costs, and rotate its token. Other commands, and the Python SDK, need the API's release.

### Python SDK saves credentials with `SaveCredentialBody`

The Python SDK's `save_credential` now takes a `SaveCredentialBody` instead of a `CloudCredential`. Build it from the same fields with `SaveCredentialBody.from_dict(...)`.

### A local API refuses work its Pods could never claim

A local API now refuses `deployment create`, Jobs on a node pool and `job --deployment` with an error, instead of admitting Jobs that never run. Run them through the cluster's API: `anycloud api use https://<cluster-id>.anycloud.sh`.

## 0.1.71

### Logs and exec reach the right Azure pool Node

With several Azure node pools, `anycloud logs` and `anycloud exec` no longer reach the wrong Node or hang. Existing clusters get the fix from `anycloud api upgrade` run on the machine that created them, which briefly restarts the Kubernetes API server.

### Upgrades replace pool Nodes without interrupting pool Services

When an upgrade replaces pool Nodes, a spare Node now joins first. Each old Node is drained within PodDisruptionBudgets, and pool Services move to the spare without failed requests. If quota leaves no room for a spare, the pool's last error says so.

### GPU Jobs check the GPU before retrying on a fresh VM

When a GPU Job's log reports an unusable GPU, anycloud now runs a CUDA check on its VM. If the GPU passes, the Job reruns once on the same VM, then ends Errored pointing at the image instead of using up to 3 fresh VMs.

### CPU node pool replicas default to 1 CPU and their share of memory

A CPU-pool Job or Deployment without `--cpus` requests 1 CPU, not 100m, and without `--memory` its share of the VM's memory, with a limit of at least 512 MiB. Existing Deployments restart on upgrade, and replicas that no longer fit in `--max-vms` VMs stay Pending; raise `--max-vms` or set `--cpus`.

### Node pool Nodes survive an agent restart or VM reboot

A node pool VM whose K3s agent restarts, whether from an OS reboot, a crash or host maintenance, now rejoins as the same Node. Before, the Node stayed NotReady and was replaced after 15 minutes, losing its Job.

### Pool Node replacement checks the GPU and pauses instead of failing the pool

A GPU pool Job that can't use its GPU retries elsewhere only when the Node fails a GPU check. Unhealthy-Node replacement now pauses, with the reason in `node-pool status`, instead of failing the pool. Connected clusters must grant `create pods`.

### Faster image pulls on node pool Nodes

Node pool Nodes now unpack gzip image layers with the same pinned `unpigz` as VM hosts. On Azure sizes without local NVMe, they store images and kubelet scratch on the resource disk instead of the OS disk.

### Node pools download large image layers in parallel

Pool Nodes now fetch several parts of one large image layer at once, as GPU VM hosts already do, so Jobs with large images start sooner. Images and submit options need no changes.

### Jobs on unpinned node pools start with a created output bucket

A Job on a node pool without `--region` that created its output bucket no longer retries forever before starting. Each bucket's region is now recorded, and a cluster's region applies only to pools on the cluster's cloud.

### Azure bucket commands no longer stall on the hosted API

The hosted API now reads each Azure credential's storage account and key once every 15 minutes rather than on every bucket request, so bucket commands and Job cleanup no longer wait on Azure Storage throttling.

### Privileged Jobs on an opted-in node pool

`anycloud node-pool create --allow-privileged-jobs` lets `job --node-pool` on that pool use `--privileged` and `--bind`. Such Jobs can read their Node's submitters' GitHub login tokens, so use such a pool from one dedicated account only. `job --bind` now takes one path per flag.

### Faster image unpacking on VM hosts

VM hosts now unpack gzip image layers with a pinned `unpigz` alongside Docker. A 9.8 GB image pull on a GCP L4 host fell from 248 s to 187 s.

### Node pools scale between their bounds

`node-pool create` now accepts `--min-vms` below `--max-vms`. Pending pool Pods buy VMs up to the maximum, and Nodes idle for about 10 minutes are removed down to the minimum, never while they run a Workload.

### GPU Jobs keep their GPU after a host systemd reload

On VM hosts, GPU containers now get the NVIDIA device nodes explicitly. A host `systemctl daemon-reload` no longer cuts a running GPU Job off its GPU with `Failed to initialize NVML: Unknown Error` or `No CUDA GPUs are available`.

### Spend caps no longer fail node pools

When an account budget or throttle blocks a node pool's VM purchase, the pool now stays in its state with "scale-out blocked by account cap" as its reason, and buys again once the cap allows, instead of failing.

### Waiting replicas no longer race for the same Job

When many replicas of a node pool Deployment wait for work, each queued Job now goes to a different waiting replica, and a new Job wakes only the replicas needed, so a backlog starts faster.

### GPU Jobs check the GPU after an in-place Spot restart

After a Spot VM is restarted in place, a GPU Job now checks that its GPU is listed before resuming. If no GPU is listed, the Job moves to a fresh VM, within the same 3-VM limit.

### Jobs on a node pool can use S3 and Cloud Storage buckets

A Job on any node pool can keep each bucket in Azure, S3 or Cloud Storage, signed by the pool's own AWS, GCP or Azure credential or a named storage credential. GCP credentials need `resourcemanager.projects.get`, now in the published Anycloud role.

### Faster image pulls for Jobs on Azure GPU VMs

On Azure VM types with a local resource disk, such as `Standard_NC4as_T4_v3`, Jobs now store container images on that disk instead of the OS disk, removing the OS disk's 70 MB/s write bound on large image pulls.

### GPU Jobs retry when their GPU is unusable

A GPU Job whose log shows no usable or faulty GPU, such as `no CUDA-capable device is detected`, `Failed to initialize NVML` or failed XLA autotuning checks, now retries on up to 3 fresh VMs, then fails.

### `anycloud exec` into pool Jobs and Deployments

`anycloud exec` now runs a command in a node pool Job's replica while the Job runs, and in a Deployment's ready replica or the one `--replica <pod>` names. The API's cluster role gains `pods/exec`.

### Faster Job claims on busy node pool Deployments

Runner replicas now authenticate each call without listing every replica of their Deployment, and a replica's free slots are counted without scanning the Deployment's Job history, so claims stay quicker as replicas and finished Jobs grow.

### Several VM types try each type's first-choice region first

A Job or node pool with several VM types now tries each type's first-choice region, in your order, before retrying the same type in another region, so a type without capacity no longer blocks the others.

### Stopped node pool VMs are replaced at once

When a cloud stops a node pool VM, such as one stopped from the cloud console, the pool now deletes and replaces it immediately, and its Workloads retry once it is gone, instead of waiting 15 minutes as a VM that never joined.

### Independent Azure storage for Jobs on a node pool

`anycloud job --node-pool` takes `--input-storage-credentials`, `--output-storage-credentials` and `--checkpoint-storage-credentials` naming a saved Azure credential, so a Job on a Lambda or AWS pool keeps its buckets, and a spot pool's managed checkpoint bucket, in Azure. A spot pool's Job without supported checkpoint storage is refused.

### Azure node pool Pods can't reach the WireServer

Azure node pool Nodes now drop their Pods' traffic to the WireServer `168.63.129.16`, except DNS, so a Pod can't read or write the Node's Azure agent channel. Nodes joined before this release get the block when replaced.

### Existing node pool Nodes are replaced on upgrade

After `anycloud api upgrade`, the API replaces each node pool VM that joined before this release, one per pool at a time once its pool Jobs finish, so it gets the instance-metadata block. A one-VM pool is briefly unavailable.

### New clusters stay reachable right after creation

`anycloud cluster create` now waits until the cluster's API hostname resolves publicly before using it. Some networks could otherwise cache the name as missing and fail every call to the new cluster for up to 30 minutes.

### Node pool Pods can't reach instance metadata

Every node pool Node now drops its Pods' traffic to the cloud instance-metadata address (DNS excepted on GCP), even before the namespace's egress policy covers a new Pod. Nodes joined before this release get the block when replaced.

### Managed checkpoint buckets for Jobs on spot node pools

A Job run with `--node-pool` on a spot node pool and no `--checkpoint-bucket` gets its own checkpoint bucket, as spot Jobs on VMs do, in the Azure account of the pool or of `--checkpoint-storage-credentials`. A retry restores from it, `anycloud status` names it, and deleting the Job deletes it.

### Buckets on Jobs on a node pool

`anycloud job IMAGE --node-pool <pool>` now takes `--input-bucket`, `--output-bucket` and `--checkpoint-bucket` on Azure storage. Each Job syncs its input, uploads under its own `<job-id>/` prefix, and restores its checkpoint on retry.

### Run Jobs on a node pool

`anycloud job IMAGE --node-pool <pool> --gpus N -- cmd` runs a Job on a node pool, with its logs, status and `--timeout`. `anycloud api upgrade` now waits for running pool Jobs first; `--force` stops them to retry.

### Detailed VM inspection and AWS nested virtualization

`anycloud vm-types <cloud> <region> --details --json` shows CPU, memory, GPUs, regional prices, quota group and capabilities, with unknown values as `null`. GCP regions now list their zones' types. AWS VMs enable nested virtualization where supported, so KVM tools run inside them.

### Services report running once their DNS name resolves

A public Service now reports `running` only after both authoritative DNS servers publish its hostname, so early requests no longer fail with `ENOTFOUND`. The API needs outbound DNS on port 53 to those servers; otherwise VM-backed Services fail with an error naming them.

### Spot node pools

`anycloud node-pool create --spot` launches the pool's VMs as spot VMs on AWS, GCP and Azure. When the cloud reclaims one, it is deleted and the pool launches a replacement. Pools stay on-demand by default.

### Pool Job scratch on local NVMe, with a per-replica disk limit

On H100 and A100 sizes, node pool VMs put kubelet scratch and images on local NVMe. Each pool Job gets its GPU or CPU share of the Node's disk; a Job writing past it ends `invalid`.

### Shutdown grace for Deployment replicas

`anycloud deployment create` and `upgrade` take `--grace-period`, such as `10m`: how long a replica gets between SIGTERM and SIGKILL. The default stays 30 seconds. Upgrading anycloud replaces each existing Deployment once, all replicas together, after its running Jobs finish.

### Node pool status explains slow and failing VM releases

`anycloud node-pool status` now shows how long each releasing VM has been releasing and how long its cloud usually takes. A rejected terminate or failed status read appears as the pool's last error, and AWS and GCP permission errors are reported at once.

### `logs` reports SSH failures instead of a missing container

When `anycloud logs` cannot reach a VM-host Workload's VM over SSH, it now reports the host and the SSH error instead of saying no workload container exists. The container check also waits up to 15 seconds, so slow VMs are no longer misreported.

### Deployments scale between minimum and maximum replicas

`deployment create` and `update` accept `--min-replicas` and `--max-replicas`; a Deployment runs enough replicas for its queued and running Jobs between them, removing only idle ones. `--replicas N` sets both. The API's Deployment `replicas` field is replaced by `minReplicas` and `maxReplicas`.

### `cost --session` includes Deployment Job slot time

`anycloud cost --session` now charges each Job sent to a Deployment for its slot time: the replica's share of its node pool Node's hourly price, divided by `--max-concurrent-jobs-per-replica`, for as long as the Job runs.

### Node pool OS disk size and tier

`anycloud node-pool create` takes `--disk-size <gb>` and `--disk-tier medium|high|ultra`, like VM Jobs, and every VM in the pool boots with that OS disk. `node-pool status` shows it. Lambda pools keep their fixed disk.

### AWS `--generate` rollback retries its deletes

When `anycloud credentials new --generate` rolls back on AWS, it now retries deleting the access key, inline policy and IAM user after a network timeout, instead of leaving them behind for manual cleanup.

## 0.1.70

0.1.70 secures hosted APIs with their own tokens and owner-only sharing, removes the GCP VM service account, reports denied cloud permissions clearly, and lets node pools retry across VM type lists.

### Action required

- **Sign in to hosted APIs again.** Hosted APIs refuse GitHub tokens, including personal access and Actions tokens. Update the CLI, then run `anycloud login <api-url>`; in CI, set `ANYCLOUD_API_TOKEN` with `API_URL`. Run `anycloud api upgrade` before upgrading the Python SDK.
- **Prepare GCP keys before upgrading.** Give the key object read and write on its Buckets and enable the Security Token Service API. It no longer needs `iam.serviceAccounts.actAs`.
- **Upgrade the CLI and hosted API together.** Node pools now take a list of VM types (`vmTypes`) instead of one (`vmType`), so a CLI and API on different versions can't create or list node pools.

### No action needed

- Running GCP Jobs and Services switch to a short-lived token minted from your key on their next sync.
- Local APIs keep their access rules; only hosted APIs change.

### Hosted APIs

- Hosted APIs accept only tokens they issue through `anycloud login <api-url>`. Cluster upgrade and delete need that sign-in.
- Only a hosted API's owner can run `anycloud api access add` and `anycloud api access remove`; members get an error naming the owner and can still list who has access.

### Credentials and permissions

- GCP VMs no longer get a service account; Buckets sync with tokens minted from your key.
- When a cloud denies a valid credential an action, the Job ends `invalid` with a message naming the action and region and how to request access, instead of `bad-credential`. Azure and GCP submissions are rejected, not "Please retry".
- `anycloud credentials new --generate` on Azure retries a transient directory error while creating the client secret instead of failing.

### Node pools

- Repeat `--vm-type` on `anycloud node-pool create` for an ordered list sharing one GPU kind and count. Each retry tries every type and region.

## 0.1.69

### Deployments run several replicas

Deployments accept `--replicas N` on create and update (default 1), so one Deployment can use several VMs. Each replica has its own Job capacity. `list` shows desired replicas; `status` shows ready / desired replicas.

### Azure Jobs run on a Contributor-only service principal

Azure VMs no longer get a managed identity; Buckets sync with short-lived container SAS tokens. Contributor or the published Anycloud role is enough, and `--generate` grants only Contributor. After older VMs end, delete `anycloud-vm-identity` and its Blob Data role assignment, and remove User Access Administrator from generated principals.

## 0.1.68

0.1.68 tightens credentials and tokens, adds Cloudflare R2 storage and node pools on Lambda, hardens Deployment replicas, and makes hosted API upgrades and bucket errors smoother.

### Action required

- **Give workloads Git access through a secret.** Workloads no longer receive your GitHub token. If they clone private repositories, run `anycloud secrets new github GITHUB_TOKEN=<token>` and submit with `--secret github`.
- **Log Docker in with the GitHub CLI to push to ghcr.io.** `anycloud login` now asks only for `read:org` and `read:packages` and no longer sets up Docker. Run `gh auth refresh -s write:packages`, then `gh auth token | docker login ghcr.io -u <user> --password-stdin`.
- **Add `sts:GetFederationToken` to AWS credentials that use buckets.** AWS VMs no longer get an IAM role, so bucket sync mints short-lived tokens from your credential. Keys from `anycloud credentials new --generate` already have it.

### No action needed

- Existing node pools get a default egress policy, and each Deployment replica restarts once on upgrade, after its running Jobs finish.
- The API no longer returns saved credentials and refuses AWS session credentials.

### Credentials and tokens

- AWS uses least privilege: VMs get no IAM role, and `anycloud credentials new --generate` grants only the published `AnycloudAccess` policy.
- The saved login token is readable only by you.
- `anycloud credentials new` works without cloud CLIs or admin rights, and can print a request for your cloud administrator.
- The local API runs public images without GitHub sign-in, and agents can drive `anycloud login`.

### Cloudflare R2

- Save a storage-only Cloudflare credential and manage R2 buckets with `anycloud bucket`.
- VM-hosted Jobs on any cloud can sync inputs, outputs and checkpoints with R2.

### Node pools

- Node pools run on Lambda.
- `node-pool create --region` is optional: VMs launch in any region the catalog offers, trying the cluster's region first.
- Capacity and quota failures back off and move to another region instead of failing the pool.

### Deployment replicas

- Replicas run with `RuntimeDefault` seccomp and no privilege escalation.
- The default egress policy allows DNS, the pool's own Pods and the internet, and it's restored if deleted or edited.

### Hosted APIs

- New clusters serve the hosted API over origin TLS.
- `anycloud api upgrade` restarts the API once, and callers wait through it instead of failing.
- `anycloud cluster delete` cleans up a creation an installer restart interrupted.

### Bucket errors

- Missing buckets and objects, and denied access, are reported plainly instead of "Internal server error".
- Throttled calls and just-created GCP keys are retried.

### Other fixes

- Spot recovery, GCP permission errors, cost tracking, Azure OS disks, and Azure Spot IDs containing `--`.

## 0.1.67

### Install without sudo, and set up from your coding agent

The installer now puts `anycloud` in `~/.local/bin` without sudo and adds it to `PATH`; existing `/usr/local/bin` installs update in place. Paste `set up https://anycloud.sh/SKILL.md` into a coding agent to install and configure Anycloud.

### The local API no longer mounts `~/.ssh`

`anycloud api start` no longer mounts your `~/.ssh` directory or Clifton's certificate cache into the local API container. `anycloud cluster attach --login` is withdrawn until Slurm support returns.

### Upgraded hosted APIs apply their own chart

A cluster-hosted API now applies its chart, including permissions, after an upgrade, so features such as Deployment logs work on upgraded clusters. `anycloud api upgrade` no longer reports "nothing to do" when an upgrade starts.

## 0.1.66

### Lambda accounts with more than 50 instances

Lambda now pages its instance list. anycloud follows every page, so cleanup sweeps, launch-retry adoption and release checks see all instances in accounts with more than 50, instead of only the first page.

### Attach an existing Slurm cluster

`anycloud cluster attach NAME --login <ssh-alias>` registers a Slurm cluster after a no-allocation preflight, using your own SSH config. The local API now mounts `~/.ssh` read-only, exposing its unencrypted keys; the cluster's key needs no passphrase.

### Deployment GPU updates respect node pool capacity

`anycloud deployment update` now refuses a GPU increase that the node pool's ready Nodes can't hold alongside its other Deployments and Services, and names the reason, instead of overbooking the pool.

### Node pools stay ready through transient cluster errors

A brief cluster API or network error no longer marks a node pool `failed`, so Deployment and Service creation on it is no longer refused. The error shows in the pool's last error until the pool is next ready.

### Deployments accept named Secrets

`anycloud deployment create` and `upgrade` take `--secret <name>`, and the API and Python SDK take `secrets`, so credentials no longer need plain `env`. Status shows Secret names, never values; `upgrade --no-secret` removes them.

### Deployment-targeted Jobs say why their replica died

When a Deployment replica dies while running a targeted Job, the Job's retry now names the cause, such as `replica OOMKilled (exit 137)` or `replica exited with code 1`, instead of "executing Kubernetes process was replaced".

### Wait on workloads, Deployments and node pools with `anycloud wait`

`anycloud wait` and `--wait` on create and upgrade commands exit 0 once Jobs complete, or Services, VMs, node pools and Deployments are ready. `logs --follow` waits through setup and, for Jobs, until the Job ends; `--watch` is removed. `status` shows retry timing and checkpoint health.

### Faster private GHCR pulls on GPU VM Jobs, and clear full-disk failures

GPU VM Jobs pulling private GHCR images now use the faster containerd transfer instead of always falling back to Docker. A pull on a full root disk fails at once as `invalid`, naming `--disk-size`, instead of retrying.

### Deployments use Workload states, REVISION and JOBS

`deployment status` shows `starting`, `running`, `failed` or `terminated · releasing`, with rollouts as `Upgrade N`, and `list` shows `REVISION` and `JOBS 1/2`. JSON `status.phase` becomes `status.state` plus `status.upgrade`; `unusedCapacity` is removed (use `maxConcurrentJobsPerReplica − jobs.unreleased`).

### API and Deployment upgrades use `upgrade` and show as `Upgrade N`

`anycloud api upgrade` and `anycloud deployment upgrade` replace `update`, which remains an alias. `api status` covers the active local or hosted API, showing the latest hosted upgrade as `Upgrade N`. `api info` and `api update --status` are removed.

### `--credentials` replaces `--credential`, and `cluster destroy` is gone

`anycloud list`, `job/service/vm list` and `quota status` now take `--credentials <name>`, like every other command; `--credential` is removed. `cluster delete` keeps `terminate` and `rm` but no longer accepts `destroy`.

### Clusters report Workload states, and `cluster create` returns like a Job

`anycloud cluster create` now returns once the cluster is recorded; follow it with `anycloud cluster status <name> --watch`. Cluster states are `provisioning`, `initializing`, `starting`, `running`, `failed` and `terminated`, and JSON no longer has `step`.

### Node pools use Workload states

Node pools use Workload states: `state` in `status`, `list` and `--json` is `provisioning`, `running`, `failed` or `terminated` instead of `creating`, `ready`, `deleting` or `deleted`, with a new `releasing` field. Update scripts matching the old values. Status shows one ingress line.

### Vast support removed

AnyCloud no longer supports Vast.ai. The `vast` provider is gone from credential setup, workload placement, GPU and pricing lookups, and the catalog. AWS, Azure, GCP, and Lambda remain available.

### GCP clusters start their API

`anycloud cluster create` on GCP no longer fails with the hosted API crash-looping at startup, including clusters restored from a checkpoint bucket.

### `cluster create` asks for missing credentials, VM type and region

In a terminal, `anycloud cluster create <name>` now prompts for any of `--credentials`, `--vm-type` and `--region` you omit, offering only regions with the chosen VM type. Scripts and `--json` get an error naming the missing flags.

### Piped CLI output is no longer cut off at 64 KiB

Commands such as `anycloud list --json` and `anycloud bucket list` now write their complete output into pipes like `| jq`. Previously, output past 64 KiB was silently dropped while the command still exited successfully.

### Capped bucket listings are visible to scripts and resumable

`anycloud bucket list --json` now prints `{ "entries": [...], "truncated": bool, "nextCursor": string|null }` instead of a bare array. A listing that stops at the limit exits with code `3`; continue it with `--cursor <nextCursor>`, or pass `--all`.

### Logs for Deployments and Services on a node pool

`anycloud logs` now works for Deployments and Services on a node pool. It shows the newest Pod, Ready or not, plus a crashed container's previous run, so failed startups can be diagnosed without `kubectl`.

## 0.1.65

### `anycloud serve` removed; `anycloud submit` and `anycloud run` deprecated

The `anycloud serve` alias has been removed; use `anycloud service`. `anycloud submit` and `anycloud run` still run `anycloud job` in 0.1.65, with a deprecation warning, and are removed in 0.1.66.

### `anycloud api serve` removed

`anycloud api serve` and VM-hosted API upgrades are removed. Host an API on a cluster with `anycloud cluster create`; when the active API is VM-hosted, `api use`, `api list` and `api update` explain how to move to one.

### Quota increase submission retired

`anycloud quota request`, its bare VM shortcut, and `quota operation` are removed. Use the AWS or Azure CLI or portal to request increases; `quota status` still shows limits and provider history. Unfinished local operations are canceled during upgrade.

### Azure quota status is more complete

For Azure, `anycloud quota status` shows regional, Spot and GPU-family Compute limits even when Microsoft's Quota API is unavailable, and reports an error instead of empty rows when provider reads fail.

### `anycloud status` reads the recent event tail

Status now returns a workload's 200 most recent events with an `eventsTotal` count, so heavy histories no longer cost megabytes per read. Pass `--history` (API: `eventsLimit=all`) for every event.

### Bring-your-own Clusters are removed

Clusters registered from your own kubeconfig, with their previous `anycloud cluster create|list|status|delete` commands and API, are removed, along with Cluster-targeted Deployments. Deployments now target node pools with `--node-pool`.

### Kubernetes clusters with a hosted API

`anycloud cluster create` builds a Kubernetes cluster and hosts the API at `https://<cluster-id>.anycloud.sh`. `cluster status`, `delete` and `forget` manage it. `api update` upgrades it after a backup to its checkpoint bucket, which `cluster create --checkpoint-bucket` restores from. Keep that bucket private: it holds the cipher key.

### Node pools, including GPU

`anycloud node-pool create` adds fixed-size CPU or GPU VM pools to the cluster. Services started with `--node-pool` get an `https://<id>.anycloud.sh` URL and, on GPU pools, every GPU of one VM by default. Deployments and their Jobs can target a pool the same way.

### Service checkpoints and configurable upgrades

Services support separate S3 credentials through `--checkpoint-storage-credentials` with automatic renewal. `anycloud service upgrade` can merge environment changes and replace mounts while preserving the URL. Large uploads avoid proxy handshake stalls, and `anycloud bucket upload BUCKET - KEY` accepts stdin.

### Kubernetes Deployments in daily Slack summaries

Daily Slack summaries now include Kubernetes Deployment inventory by owner and targeted Job activity by submitter. Idle Deployments appear when provisioned backing VMs ran during the reporting day. Job breakdowns remain included in existing totals.

### Compatible guest drivers for Vast GPUs

Vast GPU VMs now select a newer compatible guest image, fixing RTX 50-series startup and supporting current CUDA workloads. Explicit image overrides remain supported, while GPUs below the new image's compatibility minimum retain the previous guest.

### Kubernetes Deployment readiness and drain status

Configure native exec readiness probes for Kubernetes Deployments and inspect warmup, readiness loss, generation replacement and blocking Jobs. Individual status preserves stored information when Kubernetes is unavailable; ordinary lists remain available without Kubernetes reads.

### Choose and confirm cloud credential imports

Interactive credential setup now asks you to choose a source and confirm the import before saving, defaulting to No. Manual entry uses fresh values. Explicit credential flags and non-interactive imports keep their existing behavior.

### Workers are now Kubernetes Deployments

Use `anycloud deployment`, `--deployment`, `/v1/deployments`, Python Deployment helpers, and `ANYCLOUD_DEPLOYMENT_ID`. Upgrade API, CLI, SDK, and application images together; old Worker names have no aliases. Workload names, existing IDs, history, and resource identities are preserved.

### Run complete Job workflows from async applications

Python applications can submit image or Kubernetes Deployment Jobs, wait for completion and manage Deployments through `AsyncClient`. Both clients share arguments and outcomes, including first-claim expiry and recoverable uncertainty, so async applications need no manual API composition.

### Workload names replace shared Deployment names

Jobs, Services, and VMs now use Workload names. Update API calls to `/v1/workloads`, Python SDK names, and environment variables to `ANYCLOUD_WORKLOAD_ID` and `WORKLOAD_ID`. Upgrade API and clients together. For 0.1.65 only, containers also get `DEPLOYMENT_ID`, equal to `WORKLOAD_ID`; other old names have no aliases.

### Preserve Kubernetes Deployment settings during updates

Kubernetes Deployment updates now preserve unspecified container settings across the CLI, API and Python SDK. Options no longer replace the whole map; explicit nulls remove settings. Empty maps are rejected: use `dockerOptions: null` or `docker_options=None` to clear all.

## 0.1.64

### Generate GCP credentials from an existing login

Generate and save GCP service-account credentials using an existing gcloud login. Interactive setup previews the project and permissions before confirmation; automation uses `--generate --gcloud-account EMAIL --project-id PROJECT`. Interrupted or uncertain operations may require manual cleanup.

### Run trusted nested runtimes in Workers

Workers now support `--privileged` for trusted nested Docker and KVM workloads, plus disposable volumes through `--bind /absolute/path`. Volumes survive container restarts and are removed with the Pod; privileged workloads require dedicated, trusted capacity.

### Generate AWS credentials from an operator login

AWS credential onboarding can now explicitly create an IAM user and access key from an authenticated CLI profile. Generation verifies the selected account and preserves credentials after uncertain saves, reporting resources that may need manual reconciliation.

### List Workers through the Python Client

The Python SDK's `Client` now lists Workers directly and supports filtering by Cluster name or ID. Listing returns Worker summaries and uses the same configured request timeout as other Client operations.

### Codex session titles

Codex submissions now show readable session titles and use native thread IDs. Renames apply to subsequent submissions. To inspect historical process-based sessions after upgrading, pass `--session codex-<ppid>` or `--agent codex` explicitly.

### Keep generated credentials safe after interrupted saves

Azure credential generation now preserves the generated identity when the API saves its credential but the response is lost. Uncertain saves retain resources for manual reconciliation, preventing automatic cleanup from invalidating a saved credential.

### Reconcile costs despite damaged workload settings

VM costs now reconcile even when unrelated SSH, storage, container, or placement settings are malformed. Billing still uses each VM’s recorded compute credential and leaves costs unsettled when required records or usable credentials are missing.

### List Jobs, Services, and VMs directly

`job list`, `service list`, and `vm list` now support `ls` aliases. Filter Jobs with `--worker` and Workers with `--cluster`. Bare `list`/`ls` select subcommands; launch images with those names using tags such as `list:latest`.

### Inspect Cluster Jobs from `anycloud list`

Interactive `anycloud list` now drills into Clusters and Workers to show status and recent Jobs, with an optional responsive watch mode. Scripted deployment, Cluster, and Worker list commands retain their existing behavior.

## 0.1.63

### Bound Worker waits and preserve API recovery

Worker Jobs support durable pickup deadlines and blocking submission, with 20-second polling by default. Resubmission keeps Job IDs, and uncertain claims recover the same execution. Hosted APIs drain stalled client connections during replacement while preserving Kubernetes recovery.

### Managed GPU Workers configure usable capacity automatically

Managed NVIDIA Workers default to all GPUs on one VM. Clusters recover GPU capacity without replacing healthy VMs. Replace `--gpu-type`, `gpuType`, and Python `gpu` with CLI `--gpus`, API `dockerOptions.gpus`, and Python `docker_options={"gpus": "N"}`; use `all` or positive counts. NVIDIA capacity VMs have 100 GB boot disks.

### Wait for confirmed VM release before retrying

Deployment retries now wait for confirmed release of VMs requiring replacement. Pending cleanup preserves the retry budget and avoids unnecessary delays between long release checks, while supported reuse of existing VMs continues.

### Track queued Jobs on Workers

Job status now reports the number of queued Jobs ahead on the same Worker. Applications can combine this API-calculated queue position with Worker readiness and remaining concurrency to show progress before pickup.

### Add ergonomic Python Job workflows

Python users can now submit, inspect, wait for, and terminate Jobs through an optional context-managed client that discovers existing AnyCloud credentials while preserving generated SDK response models and direct API access.

### Back up API state before the configuration migration

Stop the API and back up its database and matching encryption key before upgrading. This configuration migration is forward-only; rollback requires restoring the backup and matching older release. Unexpected experimental Worker data blocks the upgrade and needs inspection.

### Replace the handwritten Python SDK with the generated client

The Python SDK now exposes generated API-family clients and Pydantic models. Import Job helpers and `current_worker()` from `anycloud_workflows`; Worker Jobs retain `job.id` and lifecycle methods, with generated data in `job.selected`. Log, exec, and bucket-transfer helpers are removed.

### Rename persistent Deployments to Workers

Persistent Kubernetes Deployments are now Workers. Update clients to use `anycloud worker`, `job --worker`, `/v1/workers`, and the Worker Python APIs, and rebuild Worker images to read `ANYCLOUD_WORKER_ID`; legacy interfaces and environment variables are no longer supported.

### Wait for Lambda to release failed VMs before retrying

Lambda deployments now wait for both instance status views to confirm a failed VM is gone before closing cleanup records or launching a replacement, preventing retry failures caused by delayed provider listings.

## 0.1.62

### Deploy-time credential failures now explain themselves

Submitting with a credential the provider rejects no longer returns a
generic internal error: the API names the credential and the provider's
reason, and answers retryably when the provider is unavailable or the
rejection is inconclusive.

### Deployments no longer record the submitting CLI's version

The per-deployment `version` field is retired and now reads empty; the API
records its own version timeline for diagnostics instead. Do not roll the API
back below this release once a database has upgraded.

### AWS and GCP credential onboarding is import-only

Anycloud now imports existing durable AWS and GCP credentials instead of generating cloud identities. Azure generation remains explicit, while immediate Azure use retries narrowly classified propagation failures for a bounded period without treating credential age or a prior probe as readiness evidence.

### Fair scheduling across agent sessions

Queued deployments now share provisioning slots fairly across agent sessions and deployment types, so a large batch submitted by one session no longer delays interactive VMs or other sessions' runs on the same credential.

### Alert when cloud VM cleanup is delayed

Slack now sends one aggregate alert when cloud VMs remain unreleased five minutes after cleanup begins, repeats it at most every six hours while risk remains, and silently resets after all affected releases complete.

### Improve Lambda launch reliability under throttling

Lambda requests now recover from HTTP 429 responses with bounded exponential backoff instead of proactive request pacing, reducing median launch latency while preserving reliable burst provisioning. Operators can tune the retry attempt, base-delay, and delay-cap settings through environment variables.

### Azure placement no longer stalls on large SKU inventories

Azure placement now reads subscription SKU availability through bounded regional requests and reuses successful observations across restarts, preventing large live inventory responses from blocking the API while preserving fail-open retries for incomplete regions.

### Scarce capacity is claimed where it is actually available

When a provider reports which regions currently have capacity, deployments now
retry there first instead of continuing through regions already reported empty.
Previously that signal only helped while a region had never been tried.

### Faster retries when capacity is scarce

Deployments waiting on scarce capacity now try the next region within a couple
of minutes at first, escalating toward the previous ten-minute ceiling only
after repeated failures. Previously the first retry waited as long as the tenth.

### Failed deployments record why they failed

A deployment that retries now reports what went wrong at each attempt: a
workload that will not start shows its container's exit code and log tail, not
just the step it failed at. Stored reasons are bounded and redacted.

### Long-running cross-cloud VM storage cleans up reliably

VM-hosted workloads now mint fresh scoped storage credentials before their final output and checkpoint copies, allowing cleanup to finish and preserve accumulated data even when the credentials used by periodic sync have expired.

### Hosted APIs can use separate state-bucket credentials

`anycloud api serve` can now place its durable state in AWS S3 through explicit storage credentials, allowing hosted APIs on compute providers without compatible object storage while ordinary Services retain their existing same-credential rule.

### Interactive deployments support portable GPU aliases

Interactive Job and Service setup can now select portable GPU aliases such as
`h100:8`, showing the resolved VM, hardware, price, and quota availability.
Spot mode hides aliases without spot pricing; `pricing` and `regions` continue
requiring exact VM types.

## 0.1.61

### Slack notifications work on hosted APIs

`anycloud notifications` now configures the API you are pointed at, storing the
webhook there encrypted so it survives restarts and upgrades. Hosted APIs could
not previously send anything. `test` now posts from the API. Re-run `enable`
against each API; local APIs migrate automatically.

### Vast VM cleanup recognizes released instances

Vast VM termination now recognizes both omitted destroyed-instance records and
provider-retained unloaded records as fully released, allowing deployment
cleanup to complete promptly instead of repeatedly issuing delete requests
after the host is already gone.

### Terminated deployments show when the machine is still running

Status and list now mark a terminated deployment whose cloud machine has not
been released yet, so a tombstone is never mistaken for stopped spend. Release
also retries far sooner after a failed attempt instead of waiting a fixed five
minutes, cutting billed time and freeing capacity for your next run.

### Long-running logs no longer block VM operations

Long-running log followers and exec sessions no longer block later VM operations.
Anycloud now isolates user commands from platform monitoring through OpenSSH
multiplexing, reaps retired connections, and returns an immediate capacity error
above ten concurrent user sessions.

### Shared API output identifies a single teammate's activity

Shared hosted API list and cost output now identifies another member's activity
even when every returned deployment or dollar belongs to that one person.
Caller-only results remain compact, and machine-readable output retains its
existing shape.

### Region pin warnings work with saved credentials

Jobs, Services, and VMs now warn when a saved cloud credential is combined
with `--region`, making the loss of regional capacity failover visible before
submission while continuing to honor intentional region constraints.

### Hosted API upgrades now require durable owner identity

Hosted API upgrades now require the complete owner identity written by current
releases. APIs not migrated through 0.1.60 must use that release first; current
hosted APIs continue updating normally.

### Hosted API guidance covers the complete lifecycle

Platform documentation now walks through creating, selecting, sharing,
updating, and retiring a hosted API, while clearly distinguishing the local
`api start` command from the hosted `api serve` workflow.

### API requests carry their client version in a header

Requests now send the client version in an `AnyCloud-Client-Version` header
instead of a `version` body or query field, and JSON endpoints return errors as
`{code, status, message}`. Streaming and bucket-transfer endpoints keep their
old error bodies. The CLI and Python SDK handle both; direct API scripts need
the header.

## 0.1.60

### Hosted APIs created before durable owner IDs upgrade normally

`anycloud api update` now carries the authenticated owner's durable identity
forward when upgrading older hosted APIs, preventing legacy owner metadata from
surfacing as a server error while retaining ownership checks.

### GitHub outages no longer interrupt authenticated API use

Hosted APIs now keep a successfully validated GitHub identity during temporary
GitHub outages while continuing to enforce their current access list. An
explicit credential rejection still clears the identity.

### Managed Kubernetes clusters now own workload placement

Hosted APIs with managed control planes can now operate fixed-capacity
Kubernetes clusters on AWS, Azure, and GCP. Jobs and Services target a Ready
cluster with `--cluster`, and their placement survives API restarts. AWS users
should enable the `anycloud_resource` cost-allocation tag for settled costs.

## 0.1.59

### VM digests no longer repeat terminal counts

Daily Slack digests now list VM terminal outcomes directly, without a redundant
ended total. Jobs and Services keep their ended totals because they can finish
in several ways.

### Unpinned regions are ranked globally by price

When `--region` is omitted, Anycloud ranks eligible regions globally by catalog
price instead of preferring US regions. Explicit region selection,
failure-driven rotation, and curated quota-request regions are unchanged.

### High is the default root disk tier

`high` is now the default `--disk-tier` on AWS, GCP, and Azure; pass `medium`
for standard performance. On AWS, Anycloud also prevents high-performance root
disks from being smaller than the selected AMI.

### GCP disk tiers no longer gate the VM catalog

GCP now resolves disk tiers when building the VM, allowing newly published
machine families through the catalog. Hyperdisk-only machines use Hyperdisk
Balanced; other families use `pd-ssd` for fast tiers, with incompatible
fallback targets removed before selection.

### Slack notifications identify their source API

Slack notifications now identify their source API. Local APIs show the account,
host, and non-default port; hosted APIs show their stable hostname and GitHub
owner, making shared-channel alerts distinguishable.

### `anycloud login` no longer reports a browser failure on every sign-in

`anycloud login` now shows the manual URL message only when opening the browser
fails, and no longer crashes on hosts without a browser handler.

### Slack setup now starts from the CLI

`anycloud notifications connect slack` now opens Slack setup and securely
prompts for the channel webhook. The callback offers a copy button, while
`notifications enable slack --webhook` remains available for automation.

### Release update notifications remain deduplicated on Linux

Linux APIs now track successful release notifications separately from the
host-shared version cache, preventing CLI refreshes from making Slack receive
the same release twice.

### Hosted APIs can be shared with a team

`anycloud api access add`, `remove`, and `list` share hosted APIs with individual
GitHub users. Members are equal peers who can manage shared workloads and
resources; list, cost, and spend alerts attribute activity by user. Removing
access blocks future requests without stopping existing workloads.

### Slack notifications group large numbers

Daily usage digests and spend-cap alerts now add thousands separators to
currency, workload counts, VM attempts, and aggregate durations, making busy
accounts easier to scan in Slack.

### Hosted API ownership uses durable GitHub account IDs

Hosted APIs, new deployments, and quota operations now authorize with immutable
GitHub account IDs, so username changes do not break access. Existing records
without an account ID continue using their captured username and may become
unreachable after a rename.

### VM creation uses the direct workload syntax

`anycloud vm [image]` now creates a persistent VM directly, matching Job and
Service syntax. Omitting the image opens the GHCR picker in interactive
terminals; `anycloud vm new` has been removed.

### Service is the canonical long-running workload name

Service is now the canonical name across the CLI, docs, notifications, and
Python SDK. `anycloud serve`, Python's deprecated `Server` alias, stored
`server` values, and `--type server` remain compatible. A new workload guide
compares Jobs, Services, VMs, and Buckets.

### Python Git repository sync removed

The Python SDK no longer clones Git repositories or exports `function`, `serve`,
`Function`, `ServiceFunction`, or `ServeFunction`. Package code in an image,
then use `Client.submit()`, `submit_many()`, `get_or_submit()`, or `serve()` with
an explicit command.

### AWS and Azure generated credentials are ready on first use

Generated AWS and Azure credentials now authenticate and verify required
storage and role access before saving. Azure Blob operations use a current ARM
account key, while workload VMs retain scoped Entra permissions; disabled Shared
Key access produces an actionable error.

## 0.1.58

### Cost reports cover the complete reporting window

`anycloud cost` now handles reporting windows with more than 1,000 deployments
by aggregating in SQLite. Exact deployment lookups and the 1,000-row limits for
`anycloud list` and pickers are unchanged.

### Persistent VMs

`anycloud vm new <image>` creates a persistent, SSH-only VM on AWS, Azure, GCP,
Lambda, or Vast. The container and host share `/workspace`; use
`anycloud ssh <id>` for the container or `--host` for the host. VMs reject spot,
buckets, startup commands, custom Docker options, resubmit, and snapshots.

### Compute credentials no longer switch accounts automatically

Remote deployments now choose one compute credential before submission and keep
it for their lifetime. The CLI selects the only saved credential, prompts when
several exist, and requires an explicit non-interactive choice. Region and
target failover stay within that account; supported spot Jobs reuse it for
checkpoint storage.

### Docker runtime options fail before provisioning

Docker option names and values are now validated before cloud resources are
created, including GPU compatibility and bucket-mount conflicts. Fallback pools
skip incompatible VMs. Kubernetes Jobs and Services translate GPU and
shared-memory options and reject unsupported options.

### Kubernetes Jobs now use native batch workloads

Kubernetes Jobs now use native `batch/v1` workloads, exposing real scheduling
and exit state while retaining Anycloud retries, logs, exec, and cleanup. Images
without commands preserve their ENTRYPOINT and CMD. GPU, shared memory, registry
authentication, and buckets remain supported; bucket Jobs still require a
command.

### Local Docker execution is no longer a public feature

The Job and Server `--local` flag and API `--enable-local-docker` option have
been removed. Local API containers no longer mount the host Docker socket or
run the Docker-control stack.

### `api update` follows the local-to-hosted control chain

`anycloud api update` now updates or starts the local API first, then replaces
the active hosted API's backing VM through that local manager. It preserves the
hosted URL, retained state, active selection, and any custom local API port;
deployment IDs are no longer accepted.

### Terminal outcomes stay visible while resources are released

Jobs and Servers now keep their terminal outcome visible while provider cleanup
runs. Status JSON separates `completedAt` from `cleanedAt`, cost continues
through each VM's actual lifetime, and resubmission waits for cleanup to finish.

### Generated Google Cloud credentials are ready before use

Generated GCP credentials now wait for the new key to propagate and prove
project access before saving. New controller accounts use specific compute,
security, and storage roles instead of project-wide Editor, with Service Account
User limited to the default Compute service account.

### Large input buckets can finish hydrating before startup

Input-bucket hydration no longer has a fixed 14-minute limit. Healthy `rclone`
transfers can run as long as needed, a 15-minute silence watchdog stops stalled
work, and API restarts reattach to active VM-side synchronization instead of
restarting it.

### Lambda cleanup waits for actual instance termination

Lambda VMs now remain in teardown until Lambda confirms termination or no
longer finds the instance, avoiding premature cleanup while the VM may still be
billable.

### Vast workloads now run on KVM hosts

Vast workloads now run on Ubuntu KVM hosts through Anycloud's standard Docker
path, supporting commandless images, secrets, shell access, logs, and bucket
sync. They require 130 GB of disk. Existing Vast deployments are not migrated;
terminate and resubmit them after upgrading.

## 0.1.57

### Google Cloud GPU retries now use exact zones

Region-pinned GCP deployments now select an exact compatible zone and rotate
zones after capacity failures. Explicit targets refresh the catalog once before
rejection. Each attempt retains its zone, and status or cleanup can find
historical VMs even when the current catalog no longer lists their placement.

### Google Cloud root disk tiers

`--disk-tier medium`, `high`, and `ultra` now work on GCP. Compatible machines
use `pd-ssd` or Hyperdisk Balanced, with high-performance defaults for IOPS,
throughput, and size. Invalid sizes and unqualified machine families fail before
provisioning.

### Jobs always release their VM when they finish

Jobs now always release their VM after completing or failing, following final
bucket sync. The `--persist` flag and prompt are removed, including for older
retained Jobs after upgrade. Resubmission waits for cleanup; use a persistent VM
instead of a finished Job for shell access.

### Release notifications link to the full notes

Slack release notifications now contain a short update prompt and link to the
public GitHub release, keeping the full notes in one place and allowing Slack
previews.

### Ctrl-C stops the remote command it was running

Pressing Ctrl-C during `anycloud logs --follow` or `anycloud exec` now stops the
corresponding remote command instead of leaving it running on the VM.

### Bucket downloads detect and retry incomplete files

CLI and Python bucket downloads now validate received byte counts, retry
incomplete transfers twice, and atomically replace destination files only after
success. The API preserves object size through `X-Anycloud-Object-Size` when
intermediaries remove `Content-Length`; replacement files retain their
permissions.

## 0.1.56

### Server upgrades no longer drop the public URL

`anycloud service upgrade` and `anycloud api update` move a server's public URL
onto its replacement machine. That handover used to remove the URL before
re-publishing it, so requests arriving in the gap failed to resolve. The URL is
now moved in place and keeps answering for the whole upgrade.

### Automatic spot checkpoint buckets are always cleaned up

The `--persist-bucket` Job option has been removed. Automatic checkpoint
buckets still preserve a spot Job across preemptions, but AnyCloud now deletes
them when the Job finishes. To retain checkpoint state across separate Jobs,
create a bucket first and pass it with `--checkpoint-bucket`; explicitly named
checkpoint buckets remain user-owned and are never deleted by AnyCloud.

### Live logs now appear promptly for Python deployments

`anycloud logs --watch` could show no output for a running Python deployment
because Python buffered stdout when no terminal was attached. Python output is
now unbuffered by default; set `PYTHONUNBUFFERED=""` to opt out.

### NVIDIA RTX PRO 6000 on Google Cloud

`anycloud gpus gcp` now lists RTX PRO 6000, and `--gpu-type rtxpro6000` (or
`rtxpro6000:2`, `:4`, `:8`) launches it on the matching whole-GPU machine.
Google Cloud GPU machines now also request the boot disk and network interface
their hardware requires, and the Google Cloud GPU listing is rebuilt from
Google's own machine data. Newly released GPU families are detected and held
from publication until their launch path is explicitly qualified.

### New releases post their changelog to Slack

When Slack notifications are configured, the Anycloud API now checks for a new
public release at startup and hourly. If an update is available, it posts that
version's full changelog and the `anycloud update` command once. Successful
delivery is recorded in the existing version cache, so API restarts do not
repeat the same release; failed webhook posts retry on a later check.

### `anycloud cost <id>` works for older deployments

`anycloud cost <deployment-id>` reported "not found" for a deployment that
finished more than 24 hours ago. It now looks the deployment up directly and
reports its full lifetime cost, regardless of age. Aggregate reports with
`--period` are unchanged.

### Bucket discovery across AWS, GCP, and Azure

`anycloud bucket list` now enumerates every natively discoverable bucket for a
saved AWS, GCP, or Azure credential, with sorted table and compact JSON output.
The authenticated `GET /v1/bucket/list` API preserves provider pagination with
opaque cursors, and the Python SDK adds `Client.list_buckets()` plus bucket
`name`, nullable `region`, and nullable `created_at` metadata. Listings default
to 1,000 results; `--all` or `limit=None` exhausts all pages.

Azure discovery reads containers from Anycloud's deterministic storage account
without creating missing infrastructure. Discovery is provider-native and does
not filter out customer-created resources that lack Anycloud tags.

### Bucket object and prefix browsing

`anycloud bucket list <bucket> [prefix]` now browses one slash-delimited level
of files and virtual folders, while `--recursive` returns a flat object tree.
The new authenticated `GET /v1/bucket/objects` API and
`Bucket.list_objects()` Python method expose provider-native pagination and
nullable size and modification metadata. Prefixes are passed literally, and
complete CLI and SDK results are sorted by key.

### Recursive bucket directory operations

`anycloud bucket upload`, `download`, and `rm` now accept `--recursive` for
complete directory or prefix operations. They preflight deterministic
manifests, use bounded configurable concurrency, reject unsafe filesystem
mappings, attempt every object after partial failures, and preserve existing
single-object behavior. Recursive deletion requires confirmation or `--yes`
and cannot target an empty prefix.

The Python SDK adds `Bucket.upload_directory()`, `download_directory()`,
`delete()`, and `delete_prefix()`. Recursive methods return
`BucketOperationResult`; partial failures raise `BucketOperationError` with the
partial summary and ordered per-key exceptions. These clients compose the
existing authenticated listing and single-object APIs, so no new server route
or provider bulk capability is required.

### Hosted APIs can be updated from the CLI

`anycloud api update [id]` now upgrades a hosted API to the image matching the
installed CLI while preserving its public URL and retained checkpoint state.
The command runs through the API that manages the hosted deployment, supports
an interactive picker, and can negotiate an older controller version so the
upgrade path remains available after the CLI moves forward.

### Daily Slack digests break down usage by user

Daily Slack digests now give each contributing Anycloud user a separate section
with their Jobs, Servers, VM usage, compute spend, outcomes, and median Job
duration. The host-wide compute-spend total remains at the top of the message,
and structured Slack lists keep outcome details reliably nested across clients.

### Clearer names for the deploy commands

`anycloud submit` is now `anycloud job`, and `anycloud serve` is now
`anycloud service`. The old names keep working: `submit` and `run` are aliases
for `job`, and `serve` is an alias for `service`.

## 0.1.55

### Hosted API state stays private after a restore

A hosted API keeps its database and encryption key in its state bucket. Object
storage does not carry file permissions, so after the backing VM was replaced or
restarted those files were restored readable by other accounts on the VM. The
restored state directory and key are now returned to owner-only access, and the
state mount is created owner-only before the restore runs. Checkpoint mounts for
ordinary Jobs and Servers are unchanged, so images that run as a non-root user
can still read their own checkpoint.

### Checkpoint buckets preserve VM-backed Server state

Jobs and VM-backed Servers can now attach a pre-existing, user-owned bucket at
`/mnt/checkpoint`, independently of spot. Anycloud restores it before startup,
uploads changes periodically, and never creates or deletes an explicitly named
checkpoint bucket. The existing automatic deployment-named bucket for spot Jobs
is unchanged.

Server replacement and termination now stop the workload, stop continuous
sync, and complete a final checkpoint upload before removing the VM.
Replacement still has downtime while a new VM starts; if the final upload
fails, cleanup retains the old VM for retry rather than proceeding with stale
state. Kubernetes-backed Servers reject checkpoint buckets in this phase.

`anycloud api serve` now requires a pre-existing, user-owned checkpoint bucket
and stores its SQLite database and cipher key in `/mnt/checkpoint`, preserving
its deployment ledger across backing-VM replacement. Hosted API creation,
upgrade, and termination validate that stored bucket before mutation; Anycloud
never creates or deletes it. Hosted API deployments created before this release
are not migrated and must be redeployed with `anycloud api serve`.

## 0.1.54

### API updates bound local Docker image storage

After a local API update succeeds, anycloud now keeps the current API image and
one previous version for rollback while removing older versioned AnyCloud API
images. Cleanup is limited to canonical version tags in the AnyCloud API image
repository, never uses forced or Docker-wide pruning, and cannot fail an
otherwise successful update.

### Throttle alerts show the rate they actually compare

Spend-cap block reasons and Slack alerts now report the projected hourly rate,
including the queued deployment, instead of showing only the current live rate.
This keeps the displayed rate consistent with the throttle decision.

### GitHub tokens no longer appear in Docker launch commands

VM and Local Docker workloads now deliver the authenticated GitHub token
through a root-only, memory-backed secret env-file instead of embedding it in
a `docker run -e` argument. Secret contents travel over SSH stdin rather than
inside a retry-logged command, and Local Docker control containers use a
dedicated tmpfs for the staging directory. Workload code still receives
`GITHUB_TOKEN`, so private repository cloning and existing integrations
continue to work.

### Daily digest separates jobs from servers

The daily notifications digest now reports jobs and servers as separate
sections, each with its own compute spend and VM usage, so it's clear which
kind of workload drove the day's bill. Lines with a zero count are omitted
instead of padding the message with zeros.

## 0.1.53

### Queued deployments now share provisioning slots across credentials

A large backlog pinned to one credential no longer takes every available
provisioning slot before another credential gets a turn. Queued deployments are
scheduled in FIFO lanes per credential, with less-busy lanes considered first;
deployments that choose credentials automatically share one lane. A single lane
can still use the full global provisioning limit when no other lane has work.

Provisioning retries now use one state-based retry curve instead of separate
admission gates and diagnosis-specific cooldowns. Failure history retains the
selected credential and quota scope, so a regional AWS or Azure Spot quota
failure slows retries for the affected credential and region without penalizing
another healthy credential.

### Serve can run on a fixed Kubernetes cluster

Opt-in Serve deployments can now run on one pre-existing Kubernetes cluster.
AnyCloud creates a one-replica workload and stable internal service, waits for
the workload to become ready, and handles replacement and termination through
the Kubernetes runtime. This first phase does not publish a public URL.

### Job logs are saved to your output bucket

Previously, a job's container logs were only available while its instance was
running. Now, when a job runs with an output bucket, AnyCloud copies the
workload container's logs — everything it writes to standard output and standard
error — into that bucket alongside your other output. Because the logs live in
your bucket, you can review or search a completed run's logs long after its
instance has been terminated.

### Slack digests report compute spend when it was incurred

The daily Slack usage digest now counts every provisioned VM that overlapped the
UTC reporting day, including long-running deployments that finished later.
Multi-day VM costs are prorated into each day instead of being charged entirely
to the day the deployment ended. VM usage, initial submissions, resubmissions,
and deployments ended are reported separately so canceled or invalid
deployments are not mistaken for billed instances. The digest lists every user
whose activity contributed to the host-wide totals and makes clear that
preemption is measured over the full run of deployments that ended that day.

### Kubernetes provider configuration is automatic

The Kubernetes provider now discovers its cluster from the in-cluster service
account or the standard local kubeconfig instead of AnyCloud-specific
environment variables. Namespace, SSH protocol, routing, and pull-policy
settings are now deterministic runtime defaults. The SSH sidecar image remains
the only temporary provider-specific environment override.

## 0.1.52

### Azure spot uses the spot quota pool only

Azure gates spot VMs by a single regional spot vCPU quota that is separate from
the per-VM-family quota gating on-demand VMs. anycloud previously required the
on-demand family quota for spot as well: candidate regions with spot quota but
no family quota were skipped, and `anycloud quota request --spot` filed a
family increase that spot deployments never needed. Spot candidate regions are
now gated by the regional spot quota alone, and `--spot` requests only that
quota — the one Azure typically auto-approves. `anycloud quota request`
selections that resolve to the same Azure quota — several spot types in one
region, or same-family sizes — are combined into a single request sized for
the largest need. `anycloud quota status --spot` likewise shows only the
quotas that gate spot; VM-family rows — current limits and previously filed
requests — appear under the on-demand view.

### Quota increases now happen only when requested

The background quota monitor no longer files AWS or Azure quota increases or
posts follow-up messages on old support cases by itself. Quota changes now come
from an explicit `anycloud quota request`, so operators stay in control of every
provider-side request. Explicit requests still work, but requested limits now add
one VM of headroom instead of doubling the current limit, Azure skips writes when
the current limit already has enough capacity, and reruns that find an existing
support ticket report it without posting another communication.

### Stopped local API servers stay stopped during update

`anycloud api stop` now cancels pending restart state, so a later
`anycloud update` no longer relaunches a local API server that was deliberately
stopped. When an update does need to replace a running local API server, restart
recovery state is written after the internal stop step so failures still leave a
clear retry path.

## 0.1.51

### GPU images now use one full-pull delivery path

eStargz lazy loading has been removed. Every image now follows the normal OCI
full-pull path, and status no longer shows lazy-loading labels. Images published
with eStargz metadata still work as ordinary OCI images and are pulled by their
normal pinned `linux/amd64` digest.

On capable GPU VM images, containerd concurrent range transfer is now the
default: several parts of one large layer can download at once. The optimization
is automatic, model-agnostic, and requires no image changes or submit options.
Unsupported runtimes, unsafe host configuration, registry throttling, or a
failed transfer fall back to the normal Docker pull.

### Base VM images moved to Ubuntu 24.04

anycloud now provisions machines on Ubuntu 24.04 (Noble) instead of 22.04. Every
CPU base image across AWS, Azure, and GCP moves to 24.04, as do the AWS and GCP
GPU images — GCP GPU hosts also pick up CUDA 12.9 with the NVIDIA 580 driver.
This is a transparent infrastructure change that brings a newer kernel and system
libraries to the machine your container runs on; most workloads need no changes.

## 0.1.50

### Disk tiers now work on Azure

`--disk-tier` (`medium`/`high`/`ultra`) now works on Azure in addition to AWS.
On Azure, `high` and `ultra` provision a Premium SSD root disk while `medium`
(the default) keeps Standard storage; `ultra` behaves the same as `high`, since
Premium is Azure's fastest root-disk tier. Premium tiers require a
Premium-capable VM size, which most modern GPU instances are.

### GPU jobs retry a not-ready host instead of failing

When a GPU machine's NVLink fabric hasn't finished initializing, a job can crash
at startup with CUDA error 802 ("system not yet initialized") before your code
runs. anycloud now treats this as a problem with the machine rather than a fault
in your container, and retries the job on a fresh machine — which almost always
clears it. It most often shows up on multi-GPU machines such as H100 pairs.

### Lambda deployments reach newer regions and fall back across instance types

Lambda GPU deployments can now use regions that Lambda offers but that weren't
yet in anycloud's catalog (for example us-southeast-1) — anycloud now reads
Lambda's own catalog directly instead of a slower third-party snapshot, so newly
available regions show up within hours. A GPU request such as `H100:1` also falls
back across equivalent instance types automatically, so a deployment lands on
whichever is available instead of failing on the cheaper one.

Modern Lambda GPU instances now explicitly select the rolling Lambda Stack
24.04 image family, letting Lambda resolve its newest compatible build in each
region. V100 instances remain on Lambda Stack Legacy 22.04, which supplies the
closed-source NVIDIA driver that hardware requires.

## 0.1.49

### Large images start sooner with SOCI v2

Large GPU and machine-learning images can spend most of their launch time just
downloading. If your image is pushed to GHCR in SOCI v2 format, anycloud can
start it lazily where the runtime supports it: the container runs while its
layers are fetched on demand, so it doesn't wait for the whole image to download
first.
`anycloud status` marks the running event `[lazy-loaded]` when this happens, or
`[full pull]` otherwise. Small or ordinary images pull as before.

### Azure bucket sync data now avoids temporary VM storage

Azure VM-host deployments now place host-side input, output, and checkpoint
bucket directories under `/var/lib/anycloud/deployments` on the managed OS disk
instead of Azure's temporary `/mnt` resource disk, so bucket data survives VM
deallocation during in-place spot recovery. Other providers keep the existing
`/mnt` layout. The host paths are stored per VM so already-running deployments
keep their original bucket directories after an API upgrade.

### Region-pinned deployments retry capacity sooner

When a cloud reports insufficient capacity for an explicitly pinned region,
anycloud schedules another launch attempt after about one minute instead of
waiting behind the shared ten-minute capacity observation. Unpinned deployments
keep the longer observation window so they can fail over without repeatedly
probing an exhausted target, and regional and account quota protections remain
unchanged. While waiting, `anycloud status` confirms that an automatic capacity
retry is scheduled.

### Lambda launch retries clean up duplicate instances

Lambda deployments now tag launched instances and sweep stale same-deployment
instances around launch retries. This prevents duplicate or orphaned Lambda
instances when the provider accepts a launch request but the client only sees a
transient failure.

### `anycloud cost` includes long-running servers

Cost reports now keep active servers in the selected reporting window even
when those servers started before it. Human-readable summaries and provider /
agent tables distinguish jobs from servers, while their compute duration and
cost are included in the same totals. JSON reports add `totalServers` and a
`servers` count to each provider and agent bucket; single-deployment JSON now
includes `deploymentType`. Reporting periods are limited to 1–90 days, and the
API rejects reports matching more than 1,000 deployments instead of running an
unbounded read or returning a partial total.

### Workload image baking has been removed

Jobs and servers now always boot from a provider base VM and pull the resolved
Docker image. The CLI and Python SDK no longer expose workload-image baking,
cache reuse, or image warm-up controls, and status no longer includes a baking
lifecycle phase. The entire `anycloud baked` command group, including its list,
copy, and prune operations, has also been removed. Earlier changelog entries
below describe the behavior of those historical releases.

Existing baked workload AMIs and their snapshots are not automatically
discovered or deleted by this release. They remain in the owning cloud account
until an account owner removes them with provider-native tooling; generic
AnyCloud base/runtime images must be retained.

## 0.1.48

### Preempted spot deployments no longer stay falsely `running`

If the API restarted while a cloud provider was bringing a preempted VM back
online, the deployment could remain recorded as `running` even though its only
VM was already recorded as preempted. Those stale deployments then appeared in
`anycloud list` and `anycloud terminate` indefinitely. Recovery is now committed
before waiting on the cloud restart, interrupted attempts resume through the
normal recovery queue, and upgraded API servers automatically repair existing
`running` deployments whose live VM records are all preempted.

### Failing bucket syncs back off between retries

When a continuous output or checkpoint sync failed (expired storage token,
revoked bucket access, network trouble), it retried immediately in a tight
loop instead of waiting for the normal sync interval — hammering the
storage API and burning VM CPU next to the workload until the problem
cleared. Failed attempts now wait the same interval as successful ones.
Applies to deployments launched after this release; already-running VMs
keep the sync script they launched with.

### Bucket sync health now comes from rclone's own errors

`anycloud status` derived bucket-sync health by keyword-matching service
logs, so a harmless systemd warning could make a healthy output sync render
as failed — both live and in a past deployment's event history. Sync health
is now read from the rclone log itself and only rclone's explicit errors
count as sync failures; the harmless warning is also stripped when showing
older deployments' history.

### Clearer terminal status for jobs with output buckets

Terminal events now show the final output sync result separately from the
workload's own exit code (e.g. `errored [exit: 137] [final sync: succeeded,
attempt: 1]`), a stopped sync service now shows as `stopped` instead of
disappearing from status entirely, and sync diagnostics are no longer
duplicated into termination events.

## 0.1.47

### `anycloud update` actually restarts the local API server again

Since 0.1.46, `anycloud update` silently failed to restart a running local
API container onto the new version: it printed the target version and
exited as if it had succeeded, but the container was left on its old image.
`anycloud update` now restarts it correctly. If a local API server has been
stuck on an old version, run `anycloud update` again after upgrading.

### Cross-cloud input buckets no longer get stuck in syncing

Deployments with a cross-cloud input bucket (e.g. compute on one provider,
an S3 input bucket on another) could get stuck retrying in `syncing`
indefinitely. The pre-sync connectivity check now verifies read access for
input buckets instead of attempting a write, matching the read-only
credentials those buckets are already granted.

## 0.1.46

### Bake-hit boots wait for the warm-up, and it targets the right files

On a cache-hit boot from a baked image, the container now waits (up to 60
seconds) for the boot-time page-cache warm-up to finish before starting, so
the workload's first reads land warm instead of racing an in-progress
warm-up. The warm-up itself also skips large files a running container
never actually reads — copies and caches left over from pulling and
building the image, along with libraries the image ships but doesn't use
at runtime — so its limited time budget goes to the files that matter.
Re-bake existing images to pick up both changes.

## 0.1.45

### Faster initialization on baked-image boots

VM initialization now confirms Docker readiness through the init system's
native ready signal instead of repeatedly querying the daemon, reaches new
VMs with a connection-level probe before attempting SSH logins, and the
boot-time warm-up reads the container runtime's bookkeeping first. Together
these decouple initialization from the background warm-up: multi-minute
initialization on large baked images drops to under a minute. The readiness
and connection improvements apply to all deployments immediately; re-bake to
pick up the warm-up ordering change.

## 0.1.44

### Boot-stable warm-up for large baked images

The boot-time warm-up introduced in 0.1.42 now reads boot-critical files
first and large image data last, reducing contention with VM startup.
For large images, pair `--bake` with `--disk-tier high`: baked-image boots
are fastest there and model loads start warm. On the default disk tier,
booting very large baked images can still delay or retry provisioning —
prefer a normal pull (`--no-bake-cache`) or the high tier for those.
Re-bake existing images to pick up the new warm-up ordering.

### Target selection

When the interactive submit and serve VM picker can't fetch quota limits in
time, it now says so and shows the full catalog, instead of silently dropping
the quota-aware ranking. Quota lookups are also cached longer, so repeat picks
and `anycloud quota status` checks return faster.

## 0.1.43

### Baked-image warm-up now covers GPU base images

The boot-time warm-up introduced in 0.1.42 read only Docker's classic storage
directory. GPU base images store cached layers through Docker's containerd
image store, which keeps its data in a separate location — so GPU-family bake
hits warmed almost nothing and still started cold. The warm-up now reads both
storage locations. Re-bake existing images to pick up the fix; the bake e2e
suite now also verifies that the warm-up did proportional work on a live
bake-hit VM.

## 0.1.42

### Faster container starts on baked-image cache hits

VMs booted from a baked image now read the cached Docker image into memory in
the background at boot, restoring the warm state a fresh Docker pull leaves
behind. Large images (model weights, CUDA libraries) previously paid cold-disk
reads on first access, which could make a cache-hit start slower than a fresh
pull. Applies to images baked from this version onward; older baked images
start cold until re-baked.

### AWS disk tiers

`anycloud submit`, `anycloud serve`, cloud config, and the Python SDK now support
an AWS `diskTier` / `--disk-tier` option for choosing gp3 root-volume
performance independently from root disk capacity. The initial tiers are
`medium`, `high`, and `ultra`.

On baked-image cache hits, `high` and `ultra` also request the fastest supported
EBS volume initialization rate for the root volume. Workloads that still start
faster with a normal Docker pull should use `--no-bake-cache`; disk tiers are a
root-disk performance knob, not a guarantee that prebaked AMIs beat registry
pulls.

### gp3 root volumes by default

AWS deployments now always launch with a gp3 root volume. Previously,
deployments that did not set a disk size or disk tier could fall back to the
base image's gp2 default, which is slower — especially at small disk sizes —
and 25% more expensive per GB.

### Baked-image cache opt-out

`anycloud submit`, `anycloud serve`, `anycloud serve upgrade`, and the Python
SDK now support a no-bake-cache option for runs that should force a normal base
VM boot and Docker pull even when a matching baked image exists. It can be
combined with legacy `--bake` to pull normally and refresh the baked image after
the pull.

### Release hardening

Unit test runtime was reduced for status and Azure gateway coverage, keeping the
release validation path faster without reducing behavioral checks.

## 0.1.40

### AWS baked-image startup reliability

AWS bake-hit launches now request a bounded EBS volume initialization rate for
the root volume, reducing unpredictable snapshot lazy-load latency when booting
from prebaked AMIs. If AWS rejects that optimization because of regional quota
or capacity pressure, provisioning retries without it instead of failing the
deployment.

The AWS serve-bake integration test now verifies that bake-hit VMs launch from
the baked image and request the bounded initialization rate while the instance
is still live.

### Local Kubernetes release hardening

The local Kubernetes provider contract now uses a `Never` pull policy for the
locally built SSH sidecar image after importing it into k3d, preventing CI from
falling back to Docker Hub for a test-only image tag.

## 0.1.39

### Bake reliability

Explicit bake now flushes Docker filesystem state before snapshotting and
records whether bake failures happened during flush or image creation. Failed
bakes no longer fall through into workload execution, and same-tag baked images
with different digests are kept until an explicit prune removes them.

### Quota and status

`anycloud quota status` now prompts for spot or on-demand quota in interactive
mode and supports explicit `--spot` / `--on-demand` filters while keeping JSON
output script-friendly. Quota integration coverage now checks AWS and Azure
provider parity against cloud API data.

Status telemetry is now throttled per user and deployment so watch and wait
polling loops do not flood analytics.

### Updates and release hardening

`anycloud upgrade` is now an alias for `anycloud update`, with clearer output
when the CLI is current and there is no local API server to restart.
Homebrew-managed installs now update through Homebrew from `anycloud update`;
when Homebrew is already on its latest formula, the command still restarts a
stale local API server to match the installed CLI.

Nightly bake e2e jobs have longer timeout headroom and stricter phase checks,
so release-adjacent bake regressions surface before publishing.

## 0.1.38

### Quota and status internals

Quota resource resolution now uses shared AWS and Azure resolvers, improving
quota lookup consistency across provider gateways, API handlers, and the CLI.

Internal provider status domains now use enums across API and CLI paths, keeping
status handling consistent as quota and deployment flows evolve.

## 0.1.37

### Local Docker-control

AnyCloud can now run Local workloads through a Docker-control container on the
API host, using the same workload path as VM deployments.

`anycloud logs` works for Local deployments, streaming through the API without
exposing SSH material. Local missing-GPU failures now stop instead of retrying
the same fixed host.

### Serve upgrades

`anycloud serve upgrade <id> <image> [command...]` replaces a running serve
deployment while preserving its existing `https://<id>.anycloud.sh` URL.

### Target selection

The interactive submit and serve VM picker now shows quota-aware ranking and
spot pricing while keeping region selection unpinned.

Image inspection now filters CUDA/ROCm-incompatible GPU fallback targets and
rejects images whose compressed layers cannot fit on the selected disk.

### Baked images and registries

Private GHCR manifest inspection now reports real auth failures for `--bake`
instead of falling back to misleading digest errors.

`anycloud baked list` has shorter age formatting, more stable picker columns,
and safer regional caching that avoids reusing partial scans.

### Local API reliability

The CLI now discovers local API containers on non-default host ports.
`anycloud update` checks `/v1/version`, verifies the target API image before
stopping the old container, and can recover a failed restart on the next update.

### Operational hardening

Catalog refresh falls back to usable cache when available. Lambda serve rotates
away from regions without required firewall rulesets. Container startup health
now catches unhealthy, restarting, and missing-GPU states before publishing
endpoints.

## 0.1.36

### Choose which API server the CLI talks to

The CLI now remembers a preferred API server, so you don't need to set `API_URL`
on every command.

- `anycloud api use <url>` saves a hosted API as the active server (stored in
  `~/.anycloud/api-url`). Pass a deployment ID to pick one of your hosted APIs,
  `local` to return to `http://localhost:8080`, or run it with no argument for an
  interactive picker of healthy, compatible servers.
- `anycloud api list` shows your local and hosted API servers with their health,
  version, and which one is active. `--json` emits the same data for scripting.
- `anycloud api info` shows the active server, where the setting came from, and
  whether its version matches your CLI.
- `anycloud api serve --use` makes a newly created hosted API active once it's
  healthy.

`API_URL` still works as a one-command override and takes precedence over the
saved setting.

### CLI and API versions must match

The CLI and the API server it talks to must now be the same version. If they
differ, commands fail fast with a clear message — run `anycloud update` for a
local API, or `anycloud api list` then `anycloud api use <target>` to switch to a
matching server.

### `anycloud logs` for VM-host deployments

`anycloud logs [id]` prints workload container stdout/stderr logs for VM-host
deployments, and `anycloud logs [id] --watch` streams them. At this release,
the then-current container-mode Vast integration was reported as unsupported.

### `anycloud list` distinguishes jobs and servers

`anycloud list` now includes a `TYPE` column and a type-aware summary, so mixed
job/server history is easier to scan. Use `anycloud list --type job` or
`anycloud list --type server` to filter. `--json` includes `deploymentType`, and
`--csv` keeps the existing columns in order while appending `deploymentType` as
the final column.

### Credential prompts are more consistent

Commands that need saved credentials now share the same resolver behavior: one
eligible credential is selected automatically, multiple eligible credentials open
the same autocomplete picker on a TTY, and non-interactive runs fail with a
message naming the flag to pass.

Bare interactive `anycloud submit`, `anycloud serve`, and `anycloud api serve`
now prompt for saved credentials before opening the compute target picker, then
pin the selected credential on the deployment. Bucket commands can also omit
`--credentials` in interactive flows and still send the resolved credential name
to the bucket API.

`anycloud baked list` uses the same credential selection behavior. Its default
table now includes a `Cloud` column, while both `--by-region` and `--json` remain
available.

## 0.1.35

### `anycloud baked` manages baked VM images

A new `anycloud baked` command group manages the prebaked VM images that `--bake`
creates:

- `anycloud baked list` shows the baked images discovered in a selected named
  credential/account, grouped by the container image they were baked from.
- `anycloud baked copy` (AWS) copies a baked image to other regions so deployments
  there boot warm without re-baking. Copies are idempotent, and `--wait` blocks
  until each copy is ready.
- `anycloud baked prune` removes baked images you no longer need from a selected
  named credential/account, with `--unused-for` to keep recently-used ones and
  `--region`, `--image`, and `--digest` filters to scope the sweep. This
  replaces `anycloud images prune`.

### `anycloud list` filters by credential

`anycloud list --provider <cloud>` has been removed. Use
`anycloud list --credential <name>` to narrow deployment history to a specific
saved credential. The filter matches both deployments pinned to that credential
and unpinned deployments whose VMs were later provisioned with it.

### Quota commands require an explicit credential

`anycloud quota request` and `anycloud quota status` now operate against one
named credential at a time. Interactive runs still pick or auto-select a matching
credential, but scripted runs should pass `--credential <name>` so quota reads
and requests cannot accidentally scan the wrong cloud account.

### `anycloud status --verbose` shows VM diagnostics

`anycloud status --verbose` now includes container exit details, container logs,
and bucket-sync diagnostics when a VM health check finds a problem. The default
status view stays concise and points you to `--verbose` when logs are available.
Read-only status checks also no longer append noisy same-state deployment events
or API log errors just because a user inspected a deployment.

### Clearer GPU runtime handling

AnyCloud now resolves the runtime a GPU VM needs as CUDA, ROCm, or unsupported.
NVIDIA CUDA VM-host targets still default Docker GPU access to `--gpus all`, but
AMD/ROCm and other unsupported accelerator targets now fail clearly instead of
silently booting a CUDA base image. The GPU docs were updated to match the
automatic GPU access behavior.

### Hosted API owner checks run before lookups

Hosted API requests now enforce the owner policy before named credential, secret,
catalog, or image lookups. Denied callers receive the authorization failure
without being able to probe saved server state first.

## 0.1.34

### Local API Docker access is opt-in

`anycloud api start` binds the API port to `127.0.0.1` and mounts the host Docker
socket only when explicitly started with `--enable-local-docker`. To run
`anycloud submit --local`, restart the local API with
`anycloud api start --enable-local-docker`; that opt-in is preserved by
`anycloud update`.

### `anycloud ssh` restored

`anycloud ssh <id>` is available again for VM-host jobs and servers. It opens an
interactive shell in the workload container by default, with `--vm` for host VM
diagnostics and `--snapshot` for exited-container inspection. SSH keys are not
returned from `status`; the CLI requests explicit, audited SSH access from the
API when the command runs.

### Configurable `anycloud serve` listen port

Server deployments still default to `PORT=8088`, but you can now override it with
`--env PORT=<port>` (CLI) or `env={"PORT": "<port>"}` (Python SDK). The public URL
and HTTPS routing are unchanged.

### `anycloud serve` always runs servers on-demand

Server deployments (`anycloud serve` and `anycloud api serve`) no longer ask you
to choose between on-demand and spot pricing when you pick a spot-capable VM
type — they always run on-demand, so picking a target is one fewer prompt.
Passing `--spot` to a server deployment is now rejected with a clear error
instead of being applied.

### Interactive target picker shows disk sizes

When you pick a compute target interactively for `anycloud submit` or
`anycloud serve`, each option now lists the instance's local disk size alongside
its vCPU, memory, and price. The picker aligns every option into stable columns,
so machine type, compute, CPU, memory, disk, and rate line up down the list and
are easier to scan and compare.

### `anycloud status` shows spot and disk size

`anycloud status` now lists the spot setting and disk size as their own rows in a
deployment's summary. Previously a spot deployment was only hinted at by a small
marker next to the VM type, and the disk size was not shown at all — so you can
now confirm both choices without digging through your deploy configuration.

### `anycloud status` shows why an image pull failed

When a VM-side Docker image pull fails, `anycloud status` now surfaces the
underlying Docker daemon output — for example `manifest unknown`, or an
authentication or disk-space error — in a "Docker output" block beneath the
concise failure line, instead of a bare "Failed to pull image". This applies to
both remote-VM and direct pulls, and to failures recorded earlier, so you can
tell why a pull failed without digging into the VM.

### `--bake` accepts single-arch and digest-pinned amd64 images

`anycloud submit --bake` and `anycloud serve --bake` now work with more kinds of
images. Previously `--bake` could only resolve a linux/amd64 digest from a
multi-arch image; it now also handles plain single-manifest linux/amd64 images
and images referenced by digest (`image@sha256:...`), inspecting the image's
config to confirm it really targets linux/amd64 before baking. When an image
genuinely has no linux/amd64 build, the rejection message is now clearer about
what to do.

### `anycloud exec` captures complete output more reliably

`anycloud exec` no longer drops trailing standard error: it waits for all
buffered error output to flush before finishing, so the last lines of a failing
command's diagnostics are reported instead of being cut off, and a slow output
consumer no longer leaves the stream hanging. The Python SDK's `Job.exec()` now
keeps streamed output as raw bytes and decodes it once at the end, so multibyte
characters (emoji, accented or non-Latin text) that land on a chunk boundary are
no longer corrupted.

### Faster failures and cleaner failover for GPU and Lambda serve

A GPU deployment whose container image needs a newer driver than the host
provides now fails fast with the underlying driver-mismatch message, instead of
silently retrying the same doomed target until the launch budget runs out. On
Lambda, hitting your account instance limit is now reported as a quota issue (so
the CLI points you at `anycloud quota`) rather than rotating through regions that
can't help, and tearing down a Lambda server that failed over across regions now
removes the firewall rules it created in every region, not just the last one.

## 0.1.33

### `anycloud serve` on Lambda

Server deployments can now run on Lambda, alongside AWS, GCP, and Azure, with the
same public `https://<id>.anycloud.sh` URL and HTTPS routing as the other
providers.

### `anycloud serve --bake`

Server deployments can now opt into baked VM images. Serve uses the same
server-resolved image digest as jobs, so a baked image created by a job can be
reused by a server, and a baked image created by a server can be reused by a job
when the image digest, cloud account, region, and base image family match.

### Hosted API restricted to its owner

A hosted AnyCloud API (`anycloud api serve`) now serves only the account that
deployed it and rejects requests from anyone else, instead of being reachable by
any caller who has the URL.

## 0.1.32

### `anycloud api serve` deploys a hosted AnyCloud API

Runs the AnyCloud API as a long-running server on your own cloud compute instead
of locally, printing the public URL and `API_URL` once it's healthy (`--no-wait`
to skip the wait). `anycloud api start` now refuses to start when a database
exists without its key, instead of generating a mismatched one.

### Python SDK `get_or_submit()` for restart-safe workflows

A restarted workflow step reattaches to the deployment it already submitted
instead of duplicating it, using a stable ID derived from the workflow id, step
name, and submission spec.

### `anycloud quota status` shows new requests immediately

A request you just made with `anycloud quota request` now appears right away with
its state, instead of disappearing until the provider's own history catches up.

### `anycloud serve` origins locked to Cloudflare

Server HTTP ports are now firewalled to Cloudflare's edge ranges instead of open
to the whole internet; existing servers are tightened on their next firewall
reconcile.

### `anycloud serve` deployments on Azure are reachable again

`anycloud serve` runs on any supported provider. On Azure specifically, some HTTP
requests to a server's `https://<id>.anycloud.sh` URL could be dropped before
reaching it, so the deployment looked unreachable even when healthy — now fixed
for both IPv4 and IPv6.

### GCP skips regions that can't see the requested machine type

Unpinned GCP deployments drop candidate regions where the requested machine type
isn't visible before provisioning, so they fail over to a working region faster.

### Azure terminations clean up leftover network resources more reliably

If an Azure termination fails partway through, the deployment's network interface
and public IP are now marked for cleanup up front, so the next cleanup pass
reclaims them rather than leaving them behind in your subscription.

## 0.1.31

### CLI installs now use public release assets and Homebrew

The anycloud CLI now ships as platform tarballs in the public
[`anycloud-sh/releases`](https://github.com/anycloud-sh/releases) repo instead
of through npm. The installer downloads the matching tarball and verifies it
against `checksums.txt` before installing.

macOS and Linuxbrew users can install with
`brew install anycloud-sh/tap/anycloud` and upgrade with
`brew upgrade anycloud-sh/tap/anycloud`. `anycloud update` now checks GitHub
Releases for newer versions and points Homebrew-managed installs back to
Homebrew instead of overwriting them.

### `anycloud quota request` GPU picker starts empty

The interactive `anycloud quota request` GPU picker no longer preselects curated
GPU instance types. Curated options still appear first, but users now explicitly
choose every GPU VM type they want to request.

### `anycloud status` can watch a deployment until it finishes

`anycloud status <id> --watch` now polls and redraws the status view until the
deployment reaches a terminal state. Use `--interval <seconds>` to adjust the
poll cadence. For scripts, `anycloud status <id> --watch --json` emits one
compact status object per line.

## 0.1.30

### `anycloud list` gets a time window and a result limit; `-a/--all` is removed

`anycloud list` now shows your most recent deployments by default, newest
first, instead of only the last 24 hours — so a bare `anycloud list` no longer
comes up empty when your latest work is a few days old. Two new flags adjust
the view, on both `list` and the `status` picker:

- `-p, --period <window>` — only deployments started within a window, e.g.
  `anycloud list -p 7d` or `-p 24h`.
- `-n, --limit <count>` — how many to show, newest first.

The `-a, --all` flag has been removed. To reach older deployments, widen the
window with `-p` or raise the count with `-n`. Every list query is now bounded,
so listing stays responsive on accounts with long histories.

The `--status`, `--provider`, and `-f`/`--filter` filters now search your full
history rather than only the page being shown, so filtering for an older
deployment no longer comes up empty when it falls outside the recent window.

### `anycloud cost --period all` is removed

`anycloud cost` no longer accepts `--period all`. Cost is always computed over a
recent window of deployments rather than your entire history, so "all-time" was
misleading. Pass an explicit window instead — e.g. `anycloud cost --period 90d`
(the default is still `30d`).

### Azure bucket sync no longer loses storage access after cleanup

On Azure, deployments in a subscription share a single identity that grants their
VMs read/write access to bucket storage. Routine cleanup of orphaned resources
could mistakenly remove that shared access, after which bucket sync failed with
permission errors on every running and new deployment until the API was
restarted. Cleanup now preserves the shared access grant, and each deployment
restores it automatically if it is ever missing — so bucket sync recovers on its
own.

### Invalid cloud credentials are flagged instead of failing on every deployment

When a saved cloud credential starts failing authentication — for example after
its secret is rotated or expires — anycloud now marks it invalid instead of
retrying the same failing call on every deployment and cleanup pass. New work
that would use it is skipped, and cleanup for affected deployments pauses (so it
stops re-hitting the provider and flooding logs) until the credential is fixed.
`anycloud credentials list` shows which credential is failing and since when, and
with notifications enabled anycloud sends a one-time alert so a broken credential
surfaces instead of failing silently. Re-entering a valid secret clears the flag;
affected deployments can then be resubmitted.

## 0.1.29

### `anycloud list` stays responsive on accounts with long histories

The list and cost commands now select the deployments to display first, then
total their VM usage, cost, and latest status only for those — instead of
aggregating across every deployment an account has ever created and trimming
afterward. Accounts with thousands of past deployments no longer pay
whole-history cost on each list. Results are unchanged except that deployments
sharing an exact start time now sort in a stable order.

### Cleanup fails fast on broken cloud credentials

When a cloud credential is rotated, expired, or missing required permissions,
resource teardown now gives up immediately instead of retrying the same failing
delete for several minutes, and Azure requests that would otherwise hang now
time out. This clears stuck cleanup work sooner; a genuinely broken credential
still needs to be corrected before its leftover resources can be removed.

### API containers use vanilla Node memory defaults again

The API Docker image no longer starts through a shell entrypoint that auto-sizes
V8 heap memory from the host or container memory limit. Local API containers now
use Node.js's default memory behavior unless operators explicitly provide
`NODE_OPTIONS`.

## 0.1.28

### Large queued batches no longer overwhelm the API server

Before dispatching a queued deployment, the server checks cloud quota and
availability across candidate regions. Each queued deployment used to run that
check independently, so a deep queue of similar jobs could issue thousands of
simultaneous cloud API calls every few seconds — enough to starve the server
and slow every command. Identical checks are now shared: a batch of similar
deployments performs one sweep together, and a failed sweep logs a single
warning instead of flooding the logs. Region filtering behavior is unchanged.

## 0.1.27

### Releases now ship as one forward-only public line

The release flow no longer has separate `latest` and `stable` channels. Each
release publishes the matching API image before publishing public CLI assets,
then publishes the Python SDK and agent skill from the same version-bump commit.
This prevents an updated CLI from pointing at an API image that has not been
published yet.

`anycloud update` now moves forward to the current public release and restarts a
running local API server automatically. Version arguments, channel selectors,
and `--no-restart` have been removed so CLI/API installs stay in lockstep.
Local API databases also record the newest app version that touched them, and
older API containers refuse to start against newer forward-migrated data.

## 0.1.26

### More history reads are bounded to live work or explicit windows

The local API now adds indexes for the other recurring database reads that can
grow with deployment history: live VM checks, spend windows, pending cost
reconciliation, active-state monitors, and daily digest ranges. Retry and
startup-recovery monitors now start from the small set of active deployments
and probe their events, rather than grouping all historical events.

These changes keep full history in SQLite; they make the common reads pay for
the live fleet or the requested time window instead of the lifetime size of the
database. Slow SQLite queries are also logged, rate-limited, so future
unbounded reads show up in API logs before they become outages.

## 0.1.25

### The local API server restarts itself after crashes and reboots

`anycloud api start` now runs the server with Docker's `unless-stopped` restart
policy: if the process crashes or the machine reboots, the API comes back on
its own instead of staying down until someone notices — while jobs run
unsupervised, a dead API means completed VMs keep billing. An explicit
`anycloud api stop` still keeps it stopped.

Crashes also stay diagnosable now: the server's recent logs are saved to
`~/.anycloud/api-last.log` before the container is replaced or removed (they
were previously destroyed with it), container logs rotate instead of growing
without bound, and `anycloud api status` shows a restart count when the server
has been crashing.

### Deployment listings no longer include secrets

The deployment list API response included each deployment's decrypted SSH
private key, environment variables, and GitHub token — none of which
`anycloud list` ever displayed. Listings are now redacted. Flows that
genuinely need the key, like `anycloud exec`, are unaffected: they fetch it
through the single-deployment status endpoint.

### The API server stays responsive with a large deployment history

A background check that runs every minute used to scan the server's entire
deployment history; once that history reached hundreds of thousands of records
(large, long-running fleets) it could stall the server for seconds at a time,
slowing every command. The scan is now indexed — about 60× faster on a real
customer database — so `anycloud list` and `anycloud status` stay snappy
during big runs.

### The API server uses your machine's memory instead of a fixed ~4GB cap

The server previously ran with Node.js's default heap ceiling (~4GB) no matter
how much memory the machine had, which could crash it under heavy fleet load
even on large machines. It now sizes its heap to 75% of available memory.

### `anycloud status` separates billable time from wall-clock duration, and shows cost

The status header used to show a single Duration measured from submission to
completion — including time spent queued or retrying before any VM existed. It
now also shows **Billable**, the time VMs actually existed (summed across spot
replacements) — the time your cloud charges you for — and a **Cost** row with
the deployment's spend and hourly rate, marked "(est.)" while it's estimated
from catalog prices rather than reconciled against your cloud bill. All three
update live for running deployments.

## 0.1.24

### Fixed: image validation no longer depends on local Docker

`anycloud submit` used to verify your image with a local Docker pull, which could
wrongly reject a valid image on Apple Silicon Macs (a "no matching manifest for
linux/arm64/v8" error) and depended on tools not present on a default macOS
install. Image validation now happens server-side, so it behaves the same from
the CLI, the Python SDK, and CI, and no longer needs Docker on your machine.

### Clearer errors for bad images, before your job starts

Before provisioning, anycloud now checks your image and fails fast with an
actionable message when it has no linux/amd64 build (anycloud VMs run x86_64 —
with `docker buildx build --platform linux/amd64 … --push` guidance), doesn't
exist, or isn't accessible — instead of failing partway through the deployment.

### `anycloud update` restarts a running API server

If a local API server is running when you run `anycloud update`, it now offers to
restart it on the new version (on the same port) so you pick up the update right
away. At a terminal you're asked to confirm (default yes); in non-interactive
contexts it restarts automatically. Previously you had to remember to run
`anycloud api stop` and `anycloud api start` yourself, or the server kept
serving the old version.

### `anycloud submit` is now fully interactive

Running `anycloud submit` in a terminal without the cloud flags used to exit with
a "Cloud config required" error. It now guides you through the whole job: it
prompts for credentials (auto-selecting when you only have one), then for a
compute type from a searchable list of your cloud's instances — GPU options first,
then CPU instances labeled with vCPUs, memory, and price — and, when the instance
supports it, whether to run on-demand or spot. Pass `--credentials`, `--vm-type`,
`--gpu-type`, or `--spot` to skip the matching prompt.

### Fixed: clearer error when requesting spot on a cloud that doesn't support it

Submitting a spot job to a provider without spot instances now returns a clear
client error instead of a generic server error.

## 0.1.23

### Fixed: slow failover when a region is out of capacity

When a region had no capacity for the requested instance type, a deployment
could spend several minutes on each retry before trying another region.
Deployments now fail over to the next region with availability promptly.

### Fixed: deployments could get stuck while downloading the image

If the SSH connection dropped while the container image was being pulled, a
deployment could wedge in the `downloading` state. Image pulls now run
detached on the VM, so a dropped connection no longer stalls progress.

## 0.1.22

### Fixed: CLI failed to start on fresh installs

A packaging bug in 0.1.21 caused the `anycloud` CLI to exit immediately on
startup with a `Cannot find module` error. The CLI now starts normally. If
you're on 0.1.21, reinstall with:

    curl -fsSL https://get.anycloud.sh | bash

## 0.1.21

### `anycloud ssh` and `anycloud logs` removed

The `anycloud ssh` and `anycloud logs` commands have been removed. Use
`anycloud exec <id> "<command>"` to run a command in your job's execution
environment, and `anycloud status <id> --verbose` for lifecycle, errors, and
captured output. On providers that run your image directly as the workload,
`anycloud exec` now runs your command in that environment rather than wrapping it
in a container exec.

### Vast spot (interruptible) instances

`anycloud submit --spot` now works on Vast. Spot runs bid on Vast's
interruptible marketplace at the live offer price, and anycloud detects when an
instance is reclaimed and reprovisions a fresh one to keep the job going.

Vast hosts have no storage of their own, so spot on Vast requires a checkpoint
bucket on a cloud that does. Point it at storage credentials with the new flags:

    anycloud submit my-image --spot \
      --checkpoint-storage-credentials my-aws \
      --checkpoint-storage-region us-east-1

Checkpoints your job writes sync to that bucket, so a reprovisioned instance
restarts with them already in place. The bucket is named after the deployment and
is removed when the deployment ends — keep it with `--persist-bucket`.

Vast also now appears in `anycloud gpus` and `anycloud pricing`, including the
cross-cloud `anycloud gpus --type` comparison.

### Bring your own Docker image

`anycloud build`, `Client.build()`, and the Python `anycloud.Image` builder API have been removed. Build and push Docker images locally or in CI, then submit the resulting image reference with `anycloud submit` or `Client.submit()`. See [Container Images — Build and publish](/platform/container-images#build-and-publish) for local and GitHub Actions examples.

`anycloud login` now also attempts a best-effort local `docker login ghcr.io` when Docker is installed, using the same GitHub token, so GHCR pushes work without setting up a separate registry credential.

### Explicit image baking and pruning

`anycloud submit --bake` and `Client.submit(..., bake=True)` now explicitly opt in to creating baked VM images. Normal submits can still reuse a matching baked image when one exists, but they no longer create new baked images by default. Use `anycloud images prune` to remove stale baked images from cloud accounts.

### Stricter git source checks for `@anycloud.function()`

The Python function decorator now rejects dirty working trees and commits that are not pushed to `origin` before submission. Remote execution clones from GitHub at the submitted commit, so local-only changes cannot be reproduced on the VM.

### Agent session labels use Claude Code titles

Agent-scoped CLI output now shows the readable Claude Code session title when one is available, instead of only showing the raw session identifier in list and spend-control views.

### Interactive credential setup improvements

`anycloud credentials new` now better guides AWS and Azure setup from local CLI state, including browser login paths, profile selection, and clearer cleanup when deleting credentials.

### `anycloud quota request` now raises Azure public-IP limits

Azure caps public IP addresses per subscription per region (100 by default), and every VM consumes one — so a fleet could stall on the IP cap even with plenty of vCPU quota. Two changes: `anycloud quota request` now files a public-IP increase alongside the vCPU request for each region, and hitting the public-IP cap is now treated as a quota error (the region backs off and the `anycloud quota` hint is shown) instead of being retried indefinitely.

### Guided `anycloud quota request` picker

Running `anycloud quota request` with no arguments in a terminal now walks through credential → GPU quota target (choose specific types or all GPU families) → GPU instance type(s) when needed (searchable multi-select, with Ctrl-A to toggle all) → quota type(s) (on-demand, spot, or both) → region (or all regions), filing a request per selected type. Passing `--spot` or `--region` skips the matching prompt; explicit `vmType`/`--gpu` invocations and non-TTY/`--json` usage are unchanged.

## 0.1.20

### Vast.ai provider support

Vast.ai is now available as a GPU marketplace provider. Add a Vast credential with `anycloud credentials new`, submit jobs against Vast GPU offers, and use the normal `logs`, `exec`, `ssh`, and bucket-sync flows through Vast's NAT'd SSH endpoints.

### Config profiles removed in favor of inline flags

`anycloud config` and `ANYCLOUD_CONFIG` profiles have been removed. Pass submit settings directly with flags such as `--credentials`, `--gpu-type`, `--vm-type`, `--region`, and bucket options. Existing docs and tutorials now use inline submit flags.

### `anycloud images` browses GHCR images

`anycloud images` now lists and filters images from GitHub Container Registry, with interactive selection in a TTY and `--json` / `--only-refs` output for scripts. The build flow also gained a credential picker so image builds can target the intended cloud account.

### AWS, Azure, and prebake reliability

AWS provisioning now handles multi-VPC security group selection correctly and avoids default-VPC security group APIs. Azure capacity failures rotate more cleanly, and prebake image lookup now keys on image digest so reused tags resolve to the right baked image.

## 0.1.19

### Agent-scoped list, cost, and spend controls

`anycloud list` and `anycloud cost` now scope to the detected agent session when appropriate, matching the per-session throttle and budget controls. Spend-cap block alerts are debounced so queued deployments do not spam repeated notifications while waiting for capacity or budget.

### Quota and capacity retry routing

Quota failures are now classified by region versus account scope, so the optimizer blocks the right retry target instead of over- or under-rotating. AWS provisioning also handles shared IAM bootstrap retries and non-default networking paths more reliably.

### Cross-cloud bucket and checkpoint credential fixes

Bucket sync, checkpoint restore, and cross-cloud storage credentials now use the credential scoped for the actual storage operation. This avoids leaking AWS S3 credentials across provider boundaries and makes cross-cloud checkpoint flows more predictable.

## 0.1.18

### Auto-retry jobs whose container can't see the GPU

If a GPU job's container exits with `CUDA_ERROR_NO_DEVICE` in its logs — the host booted without visible GPUs — the deployment now retries on a fresh VM instead of being marked errored. The previous behavior required a manual `anycloud resubmit` for every occurrence. The retry uses the standard failed-deploy backoff and exhaustion limits.

### Notifications digest skips the first-run backfill

The first time the digest monitor runs after enabling notifications on a host, it marks today as the starting point and posts nothing. Previously the next 15-minute tick would post a half-empty digest of whatever happened to be in the DB before notifications were configured. Your first real digest now lands the morning after your first full UTC day with notifications enabled.

### Interactive prompts for `budget`, `throttle`, `notifications`

Running `anycloud budget set`, `anycloud throttle set`, or `anycloud notifications enable slack` with no arguments now prompts for the missing values (cap, window, webhook URL) when stdin is a terminal. Flag-only invocations behave the same as before, and piped or CI usage (no TTY, or `CI=true`) still exits with the previous error instead of hanging.

## 0.1.17

### `status` now returns the full VM history (breaking)

`/v1/status` and `anycloud status --json` now return `vms` (every VM ever associated with the deployment, terminated rows included) instead of `vmStatuses` (active only). Each entry has a new `endedAt` field — `null` for live VMs, a millisecond timestamp for terminated ones. Live VMs still carry the `container` and `rclone` health-check fields; terminated rows are provisioning metadata only. This lets you read `prebakedImageId`, `region`, and `cloudId` for VMs after they've been cleaned up — previously those were only visible during the deployment's running window.

The human-formatted `anycloud status` output is unchanged by default (terminated VMs are hidden). Pass `--verbose` to see them, marked `(terminated)`. The Python SDK's `status_response.vm_statuses` is now `status_response.vms` and includes terminated rows; SDK helpers like `Job.exec()` and `Job.logs()` filter to live VMs automatically.

If you have scripts that grep for `vmStatuses` in `status --json` output, rename to `vms` and add `select(.endedAt == null)` if you want the old "active VMs only" semantics.

### Spend controls: `anycloud throttle` and `anycloud budget`

Two new commands cap spend by blocking new dispatches when usage exceeds a limit. Running jobs are never killed — only queued work pauses.

- `anycloud throttle set 20` — burn-rate cap (`$/hr` across in-flight VMs, plus the candidate). Set `--agent-session` to cap each agent run independently instead of account-wide.
- `anycloud budget set 100 --per day` — calendar-window cap (day, week, or month). Same `--agent-session` toggle.

Blocked deployments stay queued with a reason shown inline in `anycloud list` and `anycloud status`, and auto-dispatch once running VMs end (throttle), the calendar resets (budget), or you raise the cap. See [Spend Controls](/platform/spend-controls) for the full surface.

### `anycloud db query` / `db schema` for read-only DB inspection

Two new commands let you (or an agent) inspect the local API database without leaving the CLI. `anycloud db query "<sql>"` runs a read-only `SELECT` / `WITH` / `EXPLAIN` / `PRAGMA` — writes are refused at the SQLite engine level — and emits rows as JSON with `--json`. `anycloud db schema [table]` introspects tables, columns, foreign keys, and indexes; pair the JSON form with `db query` to answer "which deployments are stuck and why" without poking the SQLite file directly.

### `anycloud cost` switches to real billed cost

`anycloud cost <id>` now shows the real cost pulled from your cloud provider's billing API once the bill settles (~24 hours after a deployment ends). Until then — or if your account doesn't have billing-read permissions — it falls back to the catalog estimate as before, marked `(est.)`.

To enable this, the cloud credentials anycloud uses now need a small additional permission:

- **AWS**: add `ce:GetCostAndUsage` to the IAM policy. Activate the `anycloud_deployment` cost-allocation tag once (Billing → Cost Allocation Tags → activate, or `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=anycloud_deployment,Status=Active`).
- **Azure**: grant the service principal the built-in `Cost Management Reader` role on the subscription.
- **GCP**: enable Cloud Billing BigQuery export with resource-level detail, grant the service account `roles/bigquery.dataViewer` on the billing dataset, and pass the dataset to `anycloud setup gcp`.

Without these, nothing breaks — `anycloud cost` keeps showing the estimate.

### `anycloud notifications enable slack` — daily Slack digest of usage

The API container can now post a once-a-day summary to a Slack channel you choose, aggregated from your local deployment history (`~/.anycloud/api.db`) and sent directly from your machine to the webhook.

`anycloud notifications enable slack --webhook https://hooks.slack.com/...` posts a test message before saving so a typo'd webhook is caught immediately. The digest covers total spend, count by terminal state, preemption rate, median runtime, and active users. `anycloud notifications status` / `test slack` / `disable slack` round out the surface. Setup details are in [Notifications](/platform/notifications).

## 0.1.16

### MCP secrets tools

Three new MCP tools — `secrets_list`, `secrets_create`, `secrets_delete` — let an agent manage named secrets (env-var bundles used via `secrets=[...]` on submit). Mirrors the existing CLI `secrets new/list/delete`. `secrets_delete` accepts `force=True` to override the safeguard that blocks delete while non-terminal deployments still reference the secret.

### CLI catalog introspection

Four new commands surface the same cloud catalog the Python SDK already exposed, so you can pick a region or VM type before you submit:

- `anycloud regions <provider> [--vm-type <type>] [--spot]` — list available regions. With `--vm-type`, narrows to regions that offer that VM type, sorted cheapest first.
- `anycloud vm-types <provider> <region> [--accelerator <gpu>]` — list VM types in a region, optionally filtered to ones with a specific accelerator.
- `anycloud gpus <provider> [--type <gpu>]` — list available GPUs, or available counts for a specific GPU when `--type` is given.
- `anycloud pricing <provider> <vm-type> [--region <r>] [--spot]` — on-demand or spot price per region.

All four accept `--json` for scripting and accept the provider name case-insensitively (`aws`, `AWS`, `Aws` all work).

### `anycloud bucket upload` / `download`

New CLI commands stream files in and out of an S3, GCS, or Azure Blob bucket using a credential you've already registered with `anycloud credentials new`:

```
anycloud bucket upload my-bucket ./data.bin data/in.bin --credentials prod-aws
anycloud bucket download my-bucket data/out.bin ./out.bin --credentials prod-aws --region us-east-1
```

The same routes back the Python SDK's `Bucket.upload()` / `Bucket.download()`, so the CLI and SDK now go through one code path. As part of that switch, the Python SDK no longer needs cloud filesystem libraries — the `[aws]`, `[gcp]`, and `[azure]` extras have been removed from `anycloud-sdk` because `s3fs`, `gcsfs`, and `adlfs` are no longer used. Bucket I/O now requires the credential to be registered with `anycloud credentials new` (it could previously work with inline `CloudConfig` credentials passed to `Client(...)`); construct your client with `Client(credentials="<name>")` instead.

### `anycloud cost --json` for scripts and agents

`anycloud cost` now accepts `--json`. Without an id, it emits the aggregate report `{ periodMs, totalCost, totalDurationMs, totalJobs, deploymentsWithoutPrice, byProvider }`; with an id, it emits the per-deployment fields (`id`, `image`, `cloudProvider`, `region`, `vmType`, `spot`, `totalCost`, `durationMs`, `ratePerHour`). Previously the only output was a formatted table, so anything calling `anycloud cost` from a script had to grep currency strings out of stdout.

### `anycloud list` gains exact-match filters and machine-friendly output modes

`anycloud list` now supports `--status <state>`, `--provider <cloud>`, `--csv`, and `--only-ids` in addition to the existing substring `-f, --filter` and `--json`. Multiple predicates AND together. `--csv` emits a header row plus one row per deployment (`id,state,cloudProvider,region,vmType,image,spot,startedAt,completedAt,totalCost,deploymentType`), useful for piping into spreadsheets or `awk`. `--only-ids` emits one deployment ID per line and skips the table, useful for `anycloud list --only-ids --status running | xargs anycloud terminate` and similar batch operations.

### `--json` output is now compact

Every `--json` flag in the CLI (`list`, `status`, `cost`, `credentials list`, `config list`, `quota`) now emits a single line of compact JSON instead of pretty-printed JSON with two-space indents. Equivalent payload, ~30% fewer bytes. `jq .` and any other JSON parser handle it identically.

## 0.1.15

### Failed provisioning attempts no longer orphan cloud resources or pollute `anycloud list` / `cost`

When a VM provisioning attempt failed partway through (for example, Azure created the NIC and Public IP but the VM create itself errored), the rows were marked "ended" in anycloud's bookkeeping even though the cloud-side resources were still there — slowly eating the 100-Public-IP-per-region Azure quota until new submits started failing on quota errors. The same rows also showed up as live VMs in `anycloud list` and accrued duration in `anycloud cost`. Cleanup now waits for the cloud to confirm each resource is gone before marking it ended (the cleanup monitor keeps retrying anything the cloud rejected), and failed-attempt rows are filtered out of the list and cost aggregates.

### `status` always renders the deployment header

`anycloud status <id>` no longer falls back to `❓ unknown` with a "deployment not found in deployments list" hint when the id is older than the picker window or otherwise missing from the recent list. The metadata (image, cloud, region, VM type, age) now comes back with the status response itself, so the header is correct on the first call and the second round-trip is gone.

### Security: deployment IDs are no longer probeable across users

Knowing another user's deployment id no longer lets you fetch their SSH key (`status`), terminate their job (`terminate`), or resubmit it (`resubmit`). All three now reject cross-user ids with the same "deployment not found" response they return for ids that genuinely don't exist, so an authenticated caller can't enumerate other users' deployments either. Pre-existing pings against your own deployments are unchanged.

## 0.1.14

### `anycloud cost` now works for jobs submitted without a pinned region

`anycloud cost` reported `$0.00` for jobs submitted without an explicit region — the common case, since omitting a region enables multi-region failover. The hourly rate is now captured on each VM at provision time (when the region is finally known) and cost is summed across the deployment's VMs, instead of relying on a single rate stored at submit. Multi-region retries that land in different-priced regions are now reflected accurately in the total.

## 0.1.13

### Multi-region Azure submits stop retrying regions the subscription can't use

When Azure rejects a region with a "not permitted for subscription" or "not available for resource group" error (e.g. Jio India regions on most commercial subscriptions), the deployment now skips that region for the rest of its lifetime instead of cycling back to it every few minutes. Previously, multi-region jobs could exhaust their retry budget bouncing between forbidden regions and never reach the regions the subscription actually has access to.

## 0.1.12

### `--persist-bucket` retains the spot checkpoint bucket without keeping the VM

`anycloud submit --spot --persist-bucket` skips the auto-deletion of the checkpoint bucket on job completion. Independent of `--persist` — the common shape is an ephemeral VM (no `--persist`) plus a retained bucket, so a later `anycloud resubmit <id>` brings a fresh VM up against the same checkpoint contents without paying for an idle one in between. The flag is a no-op (with a warning) on non-spot deployments since they have no checkpoint bucket. Cleanup is manual: `aws s3 rb s3://<id> --force` or the equivalent for your provider — the existing orphan reaper leaves retained buckets alone because they aren't tagged as ended.

## 0.1.11

### Legacy credential arrays

Earlier builds briefly accepted a list of named compute credentials. That shape has been superseded by pinned-or-unpinned compute credentials: pass one `--credentials <name>` to pin compute, or omit it so anycloud chooses from saved named credentials.

Legacy array rows are normalized to unpinned compute during migration.

## 0.1.10

### Ordered fallback pools for `vmType` and `gpuType`

Both fields now accept an array as well as a single string. The provisioning scheduler expands every entry into the candidate pool — for `gpuType`, each alias is resolved into all interchangeable instance types — and falls over in order when the primary is quota-blocked or unavailable. CLI flags `--vm-type` / `--gpu-type` are now repeatable on `submit`, `config new`, and `config edit`; `anycloud.yaml` profiles accept a list under either field. The `config new` wizard now uses a multi-select picker (Space to mark, Enter to confirm — selection order is fallback order). The two fields are still mutually exclusive (only one of `vmType` / `gpuType` may be set, but each can itself be a list). The original list is preserved on the deployment row for display and retries.

### `quota request` always asks for one more instance of headroom

`anycloud quota <vmType>` now files a ticket every time you run it (unless an in-flight request is already pending for the same family + region). The previous "only when exhausted" trigger missed the common fresh-subscription case — `limit=0`, `usage=0` looked fine but the user couldn't launch a single VM. The new target is `max(currentUsage + vCPUsPerVM, currentLimit × 2, vCPUsPerVM)` — at minimum, one more instance's worth of capacity, with a doubling floor on top so re-running keeps growing the ceiling. AWS applies the same rule with `currentUsage` treated as 0 (Service Quotas doesn't expose live usage).

If every surveyed region already has a pending ticket for the family, the tail reads `No new tickets filed — every surveyed region already has a pending quota request for <vmType> on <cloud>.` instead of `No actions taken.`.

### `quota` picks credentials, not clouds

`quota request` and `quota status` now prompt for a credential rather than a cloud — credential implies cloud, so the second picker round-trip is gone. With a single AWS or Azure credential the picker is silent; with multiple, an autocomplete labelled `<name> (<cloud>)` appears. `--credential <name>` still bypasses the picker. Credentials for clouds without quota support (GCP, Lambda, Local) are filtered out and surface a clear error instead of running the picker only to fail later.

### Breaking: `--cloud` removed from `quota` subcommands

`anycloud quota --cloud <aws|azure>` no longer accepts the flag on either `request` or `status`. Cloud is now derived from the resolved credential or, for `request`, the `vmType` prefix. Pass `--credential <name>` to pin to a specific account.

## 0.1.9

### Picker fixups

- Restore `-a/--all` on `status` (regressed when the picker came back) so the picker can widen past the last 24h.
- `--json` now refuses the picker rather than dumping its stdout chrome into the JSON pipe.

### Multi-region `quota request` / `quota status`

`--region` is now optional on both subcommands. Omit it to fan out across every region in the cloud's catalog (AWS narrows to regions where the vmType is offered; Azure narrows to regions where the family is exhausted). Per-region calls run in parallel via `Promise.allSettled`, so wall-clock matches a single-region invocation. Re-runs stay idempotent thanks to the existing per-region dedup.

When the fan-out hits an AWS region that is disabled-by-default (e.g. `me-central-1`, `ap-east-1`, `af-south-1`), anycloud submits the AWS `EnableRegion` call for it. Opt-in is asynchronous — the quota request for that region is deferred and the entry comes back as `SUBMITTED` with `optInAction: enabling`. Pass `--region` if you'd rather not opt anything new in.

### Interactive GPU instance picker

Run `anycloud quota request` with no `vmType` and no `--gpu` in a TTY to get an interactive cloud picker followed by an autocomplete list of GPU instance types from the catalog (e.g. `g6e.48xlarge — 8× L40S (192 vCPUs)`). Non-TTY / `--json` flows are unchanged: an explicit `vmType` or `--gpu` is still required.

## 0.1.8

### Smarter blocks for disabled regions

When a provision fails because the region's quota is 0 or the subscription can't deploy there at all (AWS `OptInRequired`, Azure `ProvisioningDisabled` / `LocationIsOfferRestricted`), the optimizer blocks that region for 6 hours instead of the 30-minute generic quota block — so retries stop hammering regions that won't come back without a support ticket.

### Named Secrets

New primitive for env vars you don't want visible in API responses. `anycloud secrets new|list|delete` manages named bundles that are encrypted at rest, never returned by the API, and injected into containers at run time via `--secret <name>` (CLI) or `secrets=[...]` (Python SDK). Update a secret and resubmit to rotate — no need to edit every call site. See [Secrets & Environment](/platform/secrets-environment).

### Sensitivity warning on `--env`

When you pass a likely-sensitive key via `--env` (e.g. `HF_TOKEN`, `API_KEY`, anything matching `token` / `secret` / `password` / `key`), the CLI prints a one-line warning pointing at `anycloud secrets new`. The submit still proceeds; the warning is advisory.

### Version warning

The CLI checks its own version against the current public release and prints a warning when you're behind. Keeps users from debugging issues that were already fixed upstream.

### Quota dashboard links

`anycloud quota status` now surfaces structural console URLs (AWS Service Quotas, Azure portal) for each case, so you can jump straight to the provider's UI.

### Smarter `quota request`

`anycloud quota request` detects partial grants and skips re-requesting quota that's already been submitted or granted, so re-runs are idempotent.

### Broader Azure Region Coverage

Azure catalog now pulls the full list of physical regions via the subscription-wide `/locations` endpoint instead of per-SKU `locationInfo`, which was silently gated on per-SKU enrollment. Measured on one subscription: 43 → 58 regions, ~33k → ~55k SKU rows.

### `--json` on read-shaped commands

`status`, `list`, `config list`, and `credentials list` now accept `--json`. Chrome output routes to stderr; stdout is the pure JSON payload, so `anycloud list --json | jq` just works. `credentials list --json` emits only `{name, cloudProvider}` — secret fields never cross the boundary. Empty results return `[]` instead of the prior "No X found" strings.

### Interactive deployment picker (TTY only)

Deployment ID is now optional on `status`, `logs`, `exec`, `ssh`, `terminate`, and `resubmit`: omit it in a TTY for an interactive picker (multi-select on `terminate` and `resubmit`). This walks back part of the "Non-Interactive CLI" change from 0.1.7 — non-TTY/CI still requires an explicit ID or `ANYCLOUD_DEPLOYMENT_ID`, so scripts and agents are unaffected.

### Azure-safe deployment ID cap

Max deployment ID length lowered 40 → 28 to leave room for the `-${index}` suffix Azure appends to VM/NIC/public-IP names. Auto-generated IDs also tightened so they fit under the new cap.

## 0.1.7

### Batch Submission in the Python SDK

Submit many jobs in parallel from a single call, with first-class partial-failure handling. The decorator path gets a `map` helper for fan-out workloads.

### More Resilient Prebakes

Cached images survive upstream base-image rotation, and bake outcomes now show up in deployment status instead of disappearing into logs. CLI status also surfaces when a deploy hits a prebake cache.

### Quota Requests From the CLI

Request and check cloud quota directly from the CLI, with AWS now supported alongside Azure. Deployments that exhaust retries on a quota error point you at the new commands.

### Credentials Through the API

The CLI and MCP no longer touch plaintext credentials on disk. New MCP tools cover importing existing cloud credentials and generating least-privilege ones.

### Non-Interactive CLI

Every CLI command is now flag- and env-driven — no prompts, no pickers, no wizards. Better for scripts, CI, and agents.

### Steadier Region Rotation

Region or SKU mismatches from a cloud no longer fail a deployment outright; the optimizer rotates instead.

## 0.1.6

### More Resilient Image Pulls

Faster retries on transient pull failures and gentler post-provisioning backoff.

### Expanded MCP Server

Added `list_gpus`, `list_gpu_counts`, `credentials_get`, `bucket_upload`, and `bucket_download` tools.

### Smarter Region Rotation

When every target is temporarily blocked, the optimizer rotates across regions instead of stalling on the cheapest one. Block TTLs are also preserved at their maximum, and `InvalidTarget` blocks are capped at 6 hours.

### Strict CloudConfig Validation (Python SDK)

`CloudConfig` now rejects unknown keyword arguments instead of silently ignoring them.

## 0.1.5

### Per-Bucket Storage Credentials

Input and output buckets can now use **different cloud credentials and regions**. The shared `storageCredentials`/`storageRegion` fields have been replaced with per-bucket equivalents (`inputStorageCredentials`, `outputStorageCredentials`, etc.).
