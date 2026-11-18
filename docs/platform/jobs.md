---
title: Jobs
description: Run finite container workloads, recover spot jobs, pass data through buckets, and operate workloads through their lifecycle.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import WorkloadLifecycle from '@site/src/components/WorkloadLifecycle';

# Jobs

A Job is a finite container workload. Use one for training, batch inference,
evaluation, data processing, builds, and any other task that should exit when
its work is complete. On VM-backed providers, Anycloud provisions a VM, runs one
container, records the result, and tears the VM down.

Use a [Service](/platform/services) instead when the process should stay online
and receive HTTP traffic. Use a [VM](/platform/vms) when you need an
interactive shell and direct control of the provisioned host.

## Jobs on a node pool {#jobs-on-a-node-pool}

A running [node pool](/reference/cli/node-pools) runs Jobs from an image, as a
VM host does, without starting a VM for each one. The pool sets the cloud,
region, VM type, disk and spot mode; a Job asks for its share of a Node:

```bash
anycloud job ghcr.io/example/train:latest --node-pool gpu --gpus 1 -- python train.py
```

`--gpus` is required on a GPU pool. `--cpus` and `--memory` size the Job's
replica, as its request and limit. A CPU-pool Job without `--cpus` requests 1
CPU, and without `--memory` its CPU share of the VM's memory, up to what a Node
can allocate, so Jobs fill a Node and then the pool scales out. Its memory
limit is that share but at least 512 MiB, since page cache counts against it,
and never more than a Node can allocate. With `--cpus`, the memory request is
that limit too: at least 512 MiB, or the Node's allocatable memory if that is
smaller. The Job's Pod then has Guaranteed QoS, so its CPU doesn't vary with
what else runs on the Node. Its disk is its CPU share of the Node's disk.
`--shm-size` and `--ipc host` give it a memory-backed `/dev/shm` counted
against `--memory`; with `--ipc host` alone, `/dev/shm` is the memory request,
so with `--cpus` it is at least that floor too. `--secret` puts a named Secret in its
environment. Options the pool owns (`--credentials`, `--region`, `--zone`,
`--vm-type`, `--gpu-type`, `--spot`, `--disk-size`, `--disk-tier`),
`--runtime` and any other `--ipc` are refused with a message that names the
pool.

`--privileged` and `--bind` are refused too, unless the pool was created with
`--allow-privileged-jobs`, or, for `--bind`, `--user-namespace-jobs`.
**Deprecated:** `--privileged` and `--allow-privileged-jobs` are removed in the
next release; move such Jobs to a
[user-namespace pool](#user-namespace-jobs) first. A privileged Job is root on its Node, so it controls
the Node and every Pod on it. That includes the image pull Secrets, which hold
the GitHub login token of each user whose Job, Deployment or Service runs on
the Node, unprivileged ones included. That token grants the user's anycloud
access, not just image pulls. Use such a pool only from one dedicated GitHub
account whose access is limited to that pool's purpose, such as your CI
runners. The Job can't move its Node into another pool, though: other pools'
Pods select a Node label that only the API sets. Each `--bind` path is a volume of the replica, kept between the Jobs it
runs. Privileged Jobs, and Jobs with different `--bind` paths, never share a
replica.

### User-namespace Jobs

On a pool created with `--user-namespace-jobs`, every Job runs as root of its
own user namespace, with every capability there and its own cgroup. It can run
Docker, Podman or BuildKit, image builds and `docker compose`, inner
`--privileged` containers, and, on a pool with
`--require-nested-virtualization`, VMs on `/dev/kvm`. On the Node it is an
unmapped user: it can't read the Node's disk, the kubelet's credential, the
image pull Secrets or another Pod's Secrets, can't lift its own `--memory` or
`--cpus`, and its inner containers stay inside its memory limit. Its network
is its own Pod's, so the pool's egress policy and metadata block hold.

```bash
anycloud node-pool create builds --credentials aws --vm-type m7i.xlarge \
  --min-vms 0 --max-vms 4 --user-namespace-jobs --require-nested-virtualization
anycloud job ghcr.io/example/ci:latest --node-pool builds --bind /var/lib/docker \
  --cpus 4 --memory 14g -- ./build-and-test.sh
```

Before the replica claims a Job, the runner moves its processes out of the
container's cgroup root, so an engine can delegate cgroups to its containers.
It does so as the image's user, or else through passwordless `sudo -n`, and
opens the cgroup root to every user in the container, so an engine started
through `sudo` can use it. Its limits stay out of the Job's reach. A replica
that can't claims none, and its queued Jobs end saying so. An engine such as
`dockerd` runs as root, so a non-root image starts it through `sudo`.
A `--bind` path is where the engine keeps its
data, a volume of the replica counted in its disk share and kept between the
Jobs it runs; Jobs with different `--bind` paths never share a replica.
`--cache` is refused on these pools for now, and they take only CPU VM types.
Each replica's Pod asks for 32 MiB more than its memory request, so a
`--memory` above the smallest VM type's allocatable memory less 32 MiB is
refused. A nested Kubernetes cluster needs the kubelet's
`KubeletInUserNamespace` feature gate and kube-proxy's conntrack sizing off
(`--conntrack-max-per-core=0`).

The Pod's network MTU can be below Docker's default of 1500, such as 1450 on
Azure and 1410 on GCP. Start `dockerd` at the MTU of the Pod's `eth0`, for
example `--mtu=1450 --default-network-opt=bridge=com.docker.network.driver.mtu=1450`
for the default bridge and the networks Jobs create; otherwise inner
containers' large downloads can stall.

The Job still shares the Node's kernel: root in a user namespace reaches the
kernel's namespaced code, such as filesystem mounts and netfilter, so a kernel
exploit could escape it, and the Job can read the Node's `/sys`, including
other Pods' network interfaces. Its own processes run without seccomp or
AppArmor; inner containers keep Docker's default profile. Put Jobs of
different trust on separate pools.

`--cache NAME:/path` mounts the Node directory
`/var/lib/anycloud/node-cache/<pool-id>/NAME` at `/path`, so a pip, model or
dataset cache outlives the Job and the replica: the next Job on that Node
with the same `--cache` NAME finds what the last one left. A NAME is up to 32
lowercase letters, digits and hyphens. The path can't overlap (contain or sit
inside) `/tmp`, `/mnt/input`, `/mnt/output` or `/mnt/checkpoint`, which the
reset empties; `/opt/anycloud-runner` or `/opt/anycloud-workdir`, which the
runner owns; `/dev`, `/proc`, `/sys`, `/run/secrets` or `/var/run/secrets`; or
the Job's other `--cache` and `--bind` paths. Any user the image runs as can
write it, as with `/tmp`. A cache is on the Node only: a new Node starts with
none, and it's gone with its Node.

A cache is shared by every Job on the pool, whoever submits it, so any Job on
the pool can read or overwrite what another left there. The pool is the trust
boundary: put Jobs that must not share files on separate pools. A cache is on
the disk that holds the Node's container images and Pod storage: the local NVMe
or Azure resource disk where the VM type has one, else the OS disk. It counts
against no Job's disk share, and nothing prunes it, so the workload prunes its
own. Evicting Pods frees none of a cache, so a full one leaves the Node under
disk pressure, taking no new replicas, until the Node is replaced. Scale-in
removes it once idle if the pool is above `--min-vms`; otherwise stop its VM
from the cloud console, and the node pool deletes the stopped VM and launches a
replacement (see [node pool health](/reference/cli/node-pools#create-a-node-pool)).

Buckets work as on a VM host, on Azure storage, S3 or Cloud Storage: the whole
`--input-bucket` is synced read-only into `/mnt/input`, and `/mnt/output` and
`/mnt/checkpoint` are uploaded about every minute and when the command ends,
to the Job's own `<job-id>/` prefix in `--output-bucket` and
`--checkpoint-bucket`. A retry restores `/mnt/checkpoint` from that prefix.

Each bucket's access is signed by its own credential: a saved Azure, AWS or
GCP credential named with `--input-storage-credentials`,
`--output-storage-credentials` or `--checkpoint-storage-credentials`, with its
`--*-storage-region`, or else the node pool's credential when the pool is on
Azure, AWS or GCP. So a Job on a Lambda pool can keep its input on Cloud
Storage, its output on S3 and its checkpoints in Azure. Admission refuses a
bucket on any other storage, such as R2, a bucket with no credential that can
sign for it, a missing input or checkpoint bucket, an AWS credential with a
session token, a GCP project without the Security Token Service API and an
Azure account with Shared Key access disabled, and creates a missing output
bucket. Each attempt gets short-lived credentials for its own prefixes only,
never stored in the cluster, from the credentials admission selected, even
after the pool is deleted.

Azure credentials last 36 hours and S3 credentials 12 hours, so a Job keeps
running through an API outage of up to 18 hours on Azure and 6 hours on S3. A
Cloud Storage credential lasts an hour, so a Job with any bucket there stops
and retries after an outage of about 30 minutes.
Cloud Storage can't overwrite an object without deleting it, so its credential
can also delete inside the Job's own prefix, but nowhere else.

A bucket outside the pool's cloud or region pays that storage's egress on
every stage and every retry's re-stage: at list prices about $0.09/GB from S3,
$0.087/GB from Azure and $0.12/GB from Cloud Storage, so a 500 GB input costs
about $45–60 each time. Keep a large input in the pool's cloud and region.
A bucket admission creates, a missing output bucket or a spot pool Job's
checkpoint bucket, is in the pool's region. For a pool without `--region` it
is in the cluster's region when the cluster is on the pool's cloud, else in
the cloud's default region (`us-east-1`, `us-east4` or `eastus`), even when a
VM launches elsewhere. Pin the pool's region, or name a bucket in the region
its VMs use, to avoid that transfer.
New Cloud Storage buckets keep each replaced object for 7 days as billed
soft-deleted data, which multiplies a checkpoint bucket's cost when the
checkpoint is rewritten every few minutes. Turn it off on an explicit
checkpoint bucket with
`gcloud storage buckets update gs://BUCKET --clear-soft-delete`.

On a [spot node pool](/reference/cli/node-pools), a Job with no
`--checkpoint-bucket` gets its own checkpoint bucket named after it, as a spot
Job on a VM host does: `anycloud status` names it, a retry restores from it,
and it is deleted with the Job, even after the pool is. It lives in the
account of `--checkpoint-storage-credentials`, or of an Azure, AWS or GCP
pool's credential, and on Cloud Storage keeps no soft-deleted copies; a Job on
any other spot pool needs that option, and is refused without it. S3 and Cloud
Storage bucket names are global, so a Job ID that another account or project
already uses as a bucket name is refused: pass `--checkpoint-bucket` or choose
a different `--id`. A bucket with the Job's ID that your own account already
holds is reused, and deleted with the Job.

A stateless Job, such as an inference batch, a validation pass or a CI job,
can skip that bucket with `--no-checkpoint`, on a spot pool or a spot VM. It
gets no checkpoint bucket, nothing it writes to `/mnt/checkpoint` is uploaded
or restored, and it needs no checkpoint storage credential, so a Lambda spot
pool admits it without `--checkpoint-storage-credentials`. A reclaimed
attempt reruns from the start. `--no-checkpoint` takes no other checkpoint
option and changes nothing on demand.

Anycloud runs each Job on a replica of a Deployment it manages for the pool, the
image's digest and the Job's shape (`--gpus`, `--cpus`, `--memory`,
`--shm-size`, `--ipc`, `--secret`), so Jobs with the same image and shape share
replicas. A replica runs one Job at a time:
it starts the image's entrypoint with the Job's command and environment in the
image's working directory, as a VM host does. Replicas scale from zero with the
queued Jobs and back to zero when idle. `anycloud deployment list` shows these
Deployments with a `(managed)` label; they can't be updated or deleted, and
each is removed after 24 hours with no Job.

A queued Job waits for a replica with no deadline: `anycloud status <id>` says
why (no replica yet, a spend cap, or the replica's Pending reason, such as the
pool's capacity). `--timeout 30m` fails the Job if no replica starts it within
30 minutes, and gives a retried Job the same 30 minutes again. A replica whose image the registry refuses (not found or
unauthorized), or whose image the runner can't execute in, fails the queued
Jobs with `invalid`; a pull stuck in back-off holds them until `--timeout` or
`terminate`. `anycloud node-pool
status <pool>` counts the pool's busy, idle and Pending replicas.

`anycloud logs <id>` shows the Job's output from when its replica started it;
`logs -f` waits while the Job is queued, and the last 1 MiB is kept once the
Job ends. `anycloud exec <id> "<command>"` runs a command in the Job's replica
while the Job runs (see [`anycloud exec`](/reference/cli/workloads#anycloud-exec)).
`wait`, `status`, `terminate`, `resubmit` and `cost` work as for any Job;
`ssh` doesn't.

Between Jobs, the replica resets: it stops every process the Job left, empties
`/mnt/output`, `/mnt/checkpoint`, `/tmp` and `/dev/shm`, and restores the
image's working directory to how it was when the replica started. The reset
has limits:

- Files a Job changes outside the image's working directory aren't restored
  for the next Job.
- Files the restore copies back belong to the runner's user, not their
  original owners.
- If the image's working directory has paths the runner's user can't read,
  the replica restarts after every Job instead, and Kubernetes' restart
  back-off (10 s, doubling up to 5 minutes) can leave it not ready for up to
  5 minutes between Jobs.

`anycloud api upgrade` starts no new pool Job while it replaces the API. A
Job whose runner is this release's or the previous release's keeps running
through the upgrade, and its replica finishes the Jobs already queued on it;
Jobs submitted after the upgrade get the new release's runner. The upgrade
waits for Jobs on older runners, and `--force` stops them instead; each
retries after the upgrade.

While the API is down, a running Job keeps running and reports when the API is
back. A Job with storage on GCP tolerates about 30 minutes of API downtime,
since its storage credentials last an hour; past that it ends `disrupted` and
retries from its last checkpoint. On AWS and Azure the bound is 18 hours.

## Jobs on Kubernetes Deployments {#jobs-on-deployments}

A running [node pool](/reference/cli/node-pools) runs persistent Kubernetes
Deployments whose applications accept Jobs. Submit a Job that carries only its ID to an existing Deployment, which supplies image and placement:

```bash
anycloud job --deployment model-deployments --id request-123
```

In Python:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(deployment="model-deployments", workload_id="request-123")
    print(job.id, job.status().workload.state)
```

`job.status().jobs_ahead` reports the API-calculated number of queued Jobs ahead
on that Deployment: `0` is first, and `None` applies outside a queued targeted Job.
Use `client.get_deployment("model-deployments")` for readiness and the Jobs holding its slots;
`job.status().workload.claimed` records whether this submission was ever picked
up, including after a fast completion or automatic retry. See the
[Python queue-status example](/reference/python-sdk#jobs-on-deployments) for the
capacity comparison, lifecycle details, and refresh guidance.

The long-running application calls
`anycloud_workflows.current_deployment().next_job()` when it can accept work. That
call atomically starts one queued Job and returns a `CurrentJob` handle. Use
`job.id` to load invocation data and `job.complete()`, `job.error(message)`,
`job.invalid(message)`, or `job.retry(message)` to report the outcome. The
original generated `SelectedJob` remains available as `job.selected`.

`next_job(timeout=20)` waits up to 20 seconds to discover a candidate;
`timeout=0` performs one immediate lookup. An attempted claim may resolve later
within the separate request budget. `None` confirms that this call has no unresolved claim that
could assign work later. Keep one Deployment context open across errors so it can
recover an uncertain claim before looking for other work. See
the [Python SDK workflow example](/reference/python-sdk#handle-jobs-inside-a-deployment) for a
loop with a one-second delay and cooperative cancellation methods.

Targeted Jobs use the normal status, termination, and resubmission commands.
In Python, reattach with `client.get(job_id)`, then call `job.status()`,
`job.terminate()`, or `job.resubmit()`. Resubmission requires completed cleanup.
Pass `timeout=30, wait=True` to `client.submit(deployment="model-deployments", ...)` to
wait for a durable first claim within 30 seconds of admission. Waiting for the Job
to finish remains a separate `job.wait()` operation. With `wait=False`, the same deadline
continues after the call returns; `job.wait_for_claim()` observes its result.
Confirmed expiry means the submission was never claimed and cannot start later.
Resubmission keeps the Job ID, advances its submission revision, and replaces
or clears its deadline. Automatic retries retain the first-claim evidence.
Their image, command, environment, resources, and Docker options come from the
Deployment. Per-Job buckets, logs, exec, and SSH are unavailable because the
Jobs share a long-running application process.

## Submit a job

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job ghcr.io/acme/train:latest \
  --credentials my-aws \
  --gpu-type h100:8 \
  --spot \
  --gpus all \
  -- python train.py
```

</TabItem>
<TabItem value="python" label="Python">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        gpu="h100:8",
        command=["python", "train.py"],
        credential_name="my-aws",
        cloud_config={"spot": True},
        docker_options={"gpus": "all"},
    )
    job.wait(timeout_seconds=3600)
```

</TabItem>
</Tabs>

The Python example waits up to one hour. A `WorkloadWaitTimeout` stops
waiting without terminating the Job; see [Wait and terminate](/reference/python-sdk#wait-and-terminate).

Choose hardware by GPU name when the accelerator matters, or by exact VM type
when the instance shape matters. See [GPUs & VM Types](/platform/gpus-vm-types)
for that decision and [`job` reference](/reference/cli/job) for every
option.

### Docker in a VM Job {#docker-in-a-vm-job}

`--host-docker` is the supported way for a Job on a VM to run containers. It
replaces `--privileged`, which can't be combined with it. The Job gets the
host's Docker socket, joined to its group, and the host's `/workspace` as its
working directory, mounted at the same path, so a container it starts can
bind-mount anything under `/workspace`; `/workspace` replaces the image's
working directory, so give the Job's command an absolute path or one under
`/workspace`. It also gets `--init` and
`host.docker.internal`. With `--require-nested-virtualization` it gets
`/dev/kvm` too, joined to its group, for microVMs and emulators; a host
without `/dev/kvm` fails the Job instead of running it without KVM.

```bash
anycloud job ghcr.io/acme/ci:latest --credentials aws --vm-type m7i.xlarge \
  --host-docker --require-nested-virtualization \
  --shm-size 2g --ulimit nofile=1048576:1048576 -- /ci/build-and-test.sh
```

The container itself stays unprivileged: no added capabilities, and Docker's
default seccomp and AppArmor profiles. The socket still makes it
root-equivalent on its VM, since it can start any container there, which can
read what the host holds for the Job, such as its Secrets and bucket
credentials. Each VM Job
has a VM of its own, so that VM is the trust boundary: nothing else runs on
it. Services, node pool Jobs and Deployment Jobs refuse `--host-docker`; an
`anycloud vm` dev box has the host's Docker already.

Where anycloud installs the host's Docker, it is set up for this:

- Its networks use the VM's network MTU, such as 1460 on GCP, so large
  downloads don't stall.
- Its containers get an open-file limit of 1048576 unless they set their own.
- Docker Hub images come through Google's mirror, `mirror.gcr.io`, so pulls
  aren't rate-limited per VM; Docker falls back to Docker Hub for an image the
  mirror lacks.

On AWS, GCP and Azure, other machines can't reach a `--host-docker` Job's
published ports: the VM takes only SSH from its network, even from other VMs
in it, and on the VM's IPv4 network the host drops new connections from
outside to its containers. The
Job, host-networked containers and other containers on the host still reach
them, through `localhost`, `host.docker.internal` or a shared Docker network.
On GCP, every VM Job's VM refuses the network's other VMs beyond its own
rules, with or without `--host-docker`; a Service's or `anycloud vm` dev box's
VM keeps its network's internal traffic.

<span id="workload-workflows"></span>
<span id="ci-pipeline"></span>

## Package code in the image

Build the application and its dependencies into a published image before
submitting it:

```bash
anycloud job ghcr.io/acme/trainer:sha-4d82f7a --gpu-type h100:8
```

Anycloud resolves the image to a registry digest before pulling it, so a
mutable tag always resolves to the content available for that workload.
Tag images with a commit SHA or another immutable release identifier when
reproducibility matters. See [Container Images](/platform/container-images) for
build, cache, and registry guidance.

<span id="provisioning-concurrency"></span>
<span id="error-states"></span>
<span id="auto-retry"></span>
<span id="credential-recovery"></span>
<span id="quota-recovery"></span>

## Lifecycle

<WorkloadLifecycle kind="job" />

Infrastructure setup failures are retried up to 100 setup attempts. Failures
during image download, data sync, or container startup can reuse an existing
VM. When replacement is required, retries wait for the provider to confirm
release of the old VM; waiting for cleanup does not consume setup attempts.
Invalid configuration is not retried. A GPU Job whose log shows an unusable
GPU, such as no CUDA device or an NVLink fabric that hasn't initialized, retries
up to three times on a fresh VM. On a node pool, a check Pod first tests the
Node's GPUs with CUDA, independent of the Job's image. If the check fails, the
Job retries on another Node, up to three times, and the pool replaces the Node.
If the GPUs pass, or the check can't run, the Node stays and the Job reruns
once in a new Pod, since a container can lose its GPU on a healthy Node; if
that run fails the same way, the Job fails with the result. While the pool's replacements are paused (see
[node pools](../reference/cli/node-pools.md)), such a Node stays cordoned. A local API can have 50
workloads in the setup pipeline at once; that cap does not limit the number
already running.

`--max-retries N` caps a Job's automatic retries after a disruption or a
runner exit at N per submission, and `--max-retries 0` allows none, for a
program with side effects that must not repeat or a client that owns its
retries. A disruption is a Node or Pod, or a Job's VM, that is reclaimed or
lost, during setup or while the program runs; a runner exit is a pool
replica's runner, or a Deployment's replica, exiting before it reported. Other retries
don't count: one the Job's handler asks for with `job.retry(message)`, a GPU
rerun above, or a Deployment replica's other ends such as a storage eviction.
The budgets above still apply, and a spent budget still ends
`retries-exhausted`. Once the limit is reached, the Job ends `failed`, and both
`endReason` and `lastAttemptEndReason` name what ended its last attempt:
`reclaimed` when its capacity was taken back, `lost` when the Node or Pod went
away otherwise, or `exited` when its runner exited. A resubmit renews the limit.

A job publishes its terminal outcome as soon as it is known; `completedAt` is
that time, and `endReason` says why it ended. `status` shows it as
`End reason`, and `list --json` and `wait --json` carry it too. The values are
part of the API contract, and clients generated from it reject a value they
don't know, so a new value is a contract change.

| `endReason`         | Meaning                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exited`            | The program exited: `completed` with code 0, `errored` otherwise; or `failed` when its runner exited and `--max-retries` allowed no further retry                                                                      |
| `cancelled`         | Terminated by a user, or its Deployment was deleted                                                                                                                                                                    |
| `reclaimed`         | Its capacity was taken back, by the cloud or by anycloud's own drains, rollouts and forced upgrades, and `--max-retries` allowed no further retry                                                                      |
| `lost`              | Its outcome couldn't be observed, its host went away, or its final output upload failed                                                                                                                                |
| `timeout`           | No replica claimed it before its `--timeout`, or its attempt passed its deadline                                                                                                                                       |
| `retries-exhausted` | A retry budget ran out, including the GPU reruns above; `lastAttemptEndReason` is whatever ended the final attempt, such as `reclaimed`, `lost`, `exited` or `timeout`, or null before the program ran or when unknown |
| `invalid`           | Its configuration can never run                                                                                                                                                                                        |

`endReason` is null until the job ends and on a job that ended before the API recorded it, and a resubmit clears it. Resource teardown continues without adding another lifecycle event,
and `cleanedAt` stays null until teardown succeeds; resubmission is blocked in
between. When a teardown attempt fails, `status` names the reason as
`Cleanup pending: …` (`cleanupError` in JSON) until an attempt succeeds. Compute spend follows each VM's own lifetime — from when it is created
until its `endedAt` cutoff — independently of both workload timestamps.

Use `status` to see the current phase and its events, `logs --follow` to
stream output from submission onward, and `wait` to continue only after the Job
succeeds:

```bash
anycloud status <job-id> --verbose
anycloud logs <job-id> --follow
anycloud wait <job-id> && echo "training finished"
```

`wait` exits `0` when the Job completes and `1` when it fails, and prints one
line per state change, so scripts and agents never parse status output. See
[`anycloud wait`](/reference/cli/workloads#anycloud-wait). While a spot Job is
retrying, `status` and `wait` show the attempt, when the next attempt is due,
and whether capacity or quota is the cause.

## Data and artifacts

Attach object storage when the job needs datasets, durable results, or
recoverable state:

| Container path    | Access     | Behavior                                     |
| ----------------- | ---------- | -------------------------------------------- |
| `/mnt/input`      | Read-only  | Downloaded before the container starts       |
| `/mnt/output`     | Read-write | Uploaded about every 60 seconds and at exit  |
| `/mnt/checkpoint` | Read-write | Restored at startup; uploaded during the run |

See [Buckets](/platform/buckets) for configuration and sync behavior.
An explicit checkpoint bucket works on both on-demand and spot Jobs. Spot Jobs
without one keep the automatic workload-named checkpoint described below.

<span id="retaining-checkpoints-across-runs"></span>

## Spot recovery

Spot capacity costs less but may be reclaimed at any point. With `--spot`,
Anycloud detects preemption and first tries to restart the VM in place;
otherwise it cleans up the lost VM, provisions a replacement, restores
`/mnt/checkpoint`, and restarts the container.

A cloud can also stop an on-demand Job's VM, for example for host
maintenance. Once the host stops answering SSH and the cloud reports the VM
stopped, Anycloud recovers the Job the same way, within `--max-retries`.

```python
from pathlib import Path
import json

checkpoint = Path("/mnt/checkpoint/state.json")
start_epoch = json.loads(checkpoint.read_text())["epoch"] if checkpoint.exists() else 0

for epoch in range(start_epoch, 100):
    train_one_epoch(epoch)
    checkpoint.write_text(json.dumps({"epoch": epoch + 1}))
```

Checkpoint changes sync about every 60 seconds, so checkpoint often and make
startup idempotent. The automatic checkpoint bucket is deleted when a spot Job
finishes. To retain checkpoint state across separate Jobs, create a bucket and
pass it with `--checkpoint-bucket`.

`anycloud status` shows the checkpoint bucket, its mount, whether it is kept
after the Job, and what has reached the bucket so far:

```text
Checkpoint: 52 objects, 101.0 MB in the bucket, newest 40s ago
```

<span id="chaining-jobs"></span>

## Compose jobs

Sequence Jobs with ordinary Python. Wait for a preparation step to finish, then
use its output bucket as the training Job's input:

```python
from anycloud import Client

with Client() as client:
    prepared = client.submit(
        "ghcr.io/acme/prepare:latest",
        credential_name="my-aws",
        gpu="h100",
        cloud_config={"output_bucket": "prepared-training-data"},
    )
    prepared.wait()
    trained = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu="h100:8",
        cloud_config={"input_bucket": "prepared-training-data"},
    )
    trained.wait()
```

The preparation container writes to `/mnt/output`; training reads from
`/mnt/input`. Use separate buckets or application prefixes for concurrent runs.
A failed wait raises before the next submission. To run independent Jobs in
parallel, submit them before waiting and handle partial failures in your
application. The SDK has no `JobGroup`, `submit_many()`, or `get_or_submit()`
helper.

<span id="debugging-a-job"></span>

## Operate and debug

```bash
anycloud job list --status running
anycloud logs <job-id>
anycloud exec <job-id> "nvidia-smi"
anycloud terminate <job-id>
anycloud resubmit <job-id>
```

`exec` and live logs require the workload's container to still be running.
When an output bucket is attached, logs are also copied under
`.anycloud/logs/`, preserving them after teardown. Exact lifecycle and
operation syntax is in [Workload operations](/reference/cli/workloads).

<span id="session-scoping"></span>

## Agent-operated jobs

The CLI supports coding agents that run and monitor Jobs directly. Commands
that print tables also provide structured output, and non-interactive
workloads from Claude Code, Codex, Cursor, and Aider are tagged with the
detected agent and session.

```bash
anycloud job list --agent codex --json
anycloud job list --session <session-id> --only-ids
anycloud status <job-id> --json
anycloud cost --agent codex --json
```

When an agent invokes `list`, `job list`, or `cost`, results default to that
agent's own session. This is cooperative scoping for usability, not an access
boundary; an explicit `--session` or `--agent` can select another scope.

Codex submissions use the native `CODEX_THREAD_ID` when available. Older
Codex environments that expose only `CODEX_BIN_PATH` retain the
`codex-<parent-process-id>` fallback. After upgrading, new native-thread scopes
do not include earlier process-based sessions. Select that history explicitly:

```bash
anycloud job list --session codex-49152
anycloud cost --agent codex
```

Claude Code and Codex session titles appear in human-readable session output
when available. Codex titles come from `session_index.jsonl` under
`$CODEX_HOME`, which defaults to `~/.codex`. Titles are captured when work is
submitted; renaming a session affects subsequent submissions. Missing or
unreadable titles keep the usual session identifier display.

Use `anycloud docs` for the documentation index and `anycloud docs --all` for
the full Markdown corpus. Pair autonomous sessions with
[per-session Spend Controls](/platform/spend-controls#agent-session-scope).
