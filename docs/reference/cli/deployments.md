---
title: deployment
description: Create and manage persistent Kubernetes Deployments that accept Jobs.
---

# `anycloud deployment`

Create and manage persistent Kubernetes Deployments that accept targeted Jobs.
Each Deployment keeps an application container running. Targeted Jobs execute
inside that container and retain their own Workload records.

A Deployment runs on exactly one [node pool](/reference/cli/node-pools) in the
installation's cluster, named with `--node-pool` and fixed for the
Deployment's whole life.

## Create

```bash
anycloud deployment create <name> <image> \
  --node-pool <id-or-name> \
  [--gpus <all|N>] \
  [--runtime <nvidia|runc>] \
  [--replicas <count> | --min-replicas <count> --max-replicas <count>] \
  [--max-concurrent-jobs-per-replica <count>] \
  [--grace-period <duration>] \
  [-- command...]
```

Pass `--wait` to wait until the Deployment is ready, with the exit codes of
[`anycloud wait`](/reference/cli/workloads#anycloud-wait).

Create also accepts `--env`, `--env-file`, repeatable
[`--secret <name>`](#named-secrets), `--shm-size`, `--memory`, `--cpus`,
`--privileged`, and repeatable `--bind /absolute/path` volumes.
Concurrency defaults to one. The Deployment runs between `--min-replicas`
and `--max-replicas` replica Pods (default one each; the maximum defaults to
the minimum), enough for its queued and running Jobs; `--replicas N` is
shorthand for both set to N, a fixed count. Each replica claims Jobs up to
its own `--max-concurrent-jobs-per-replica`, and on a GPU node pool each
holds its GPUs on one Node, so admission reserves the GPU count times the
maximum. Scaling up waits while a spend cap blocks the node pool; scaling
down removes only replicas that hold no Job. `deployment update` with these
flags changes the bounds as a new revision, after running Jobs drain. `list`
and `status` report ready replicas over the bounds. CPU, memory, and the resolved GPU count
become equal Kubernetes requests and limits. Without `--cpus` or `--memory`,
each defaults: on a GPU node pool, to 90% of the replica's GPUs' share of the
VM's CPU or memory; on a CPU node pool, to a request of 1 CPU, a default VM
Job's size, and 90% of the replica's CPU share of the VM's memory. Its memory
limit is that memory but at least 512 MiB, and neither is more than a Node can
allocate. With `--cpus`, the memory request is that limit too, so it is at
least 512 MiB, or the Node's allocatable memory if that is smaller, and the
replica has Guaranteed QoS. Unless `--privileged`, the container runs with
the `RuntimeDefault` seccomp profile and can't gain privileges, so setuid
programs such as `sudo` don't work.

Use `--readiness-probe` to configure a native Kubernetes exec probe:

```bash
anycloud deployment create model-deployments ghcr.io/acme/model:latest \
  --node-pool training \
  --readiness-probe '{"exec":{"command":["/app/check-ready"]},"periodSeconds":2}'
```

The image supplies the executable. Kubernetes runs its argument array directly;
include an explicit shell to use shell syntax. Exit status zero means ready.
Optional `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`,
`successThreshold`, and `failureThreshold` use Kubernetes defaults when omitted.
While the probe fails, the container cannot claim new Jobs. Readiness loss does
not release Jobs already running inside it. Without a configured probe,
application readiness remains unknown and container readiness retains its
existing claim behavior.

### Node pool admission

```bash
anycloud deployment create model ghcr.io/acme/model:latest \
  --node-pool aws-east --gpus 1
```

The node pool must be `running`. Admission reserves capacity against the
node pool's ready Nodes as observed at that moment: a Deployment needs at
least one ready Node, and a GPU Deployment's devices must fit alongside the
live GPU reservations of its sibling Deployments and
[Services on the node pool](/reference/cli/service#services-on-a-node-pool)
(`ready Nodes × devices per Node`, from the catalog). The bound is pool-wide:
on a multi-VM pool a Deployment replica can still land on the VM whose GPUs a
Service holds and stay `Pending`. The bound is re-checked in the same database write
that stores the record, so two concurrent admissions cannot both take the last
free devices; the loser receives a conflict and can retry. Node pools that are
`creating`, `failed`, or `deleting` are refused with a diagnostic naming the
state. GPU intent is resolved against the node pool's VM type.

A Deployment's Pods run in the node pool's own namespace on the cluster
(`anycloud-node-pool-<node pool>-<hash>`), created by the first Deployment
that targets the node pool and owned by the node pool; a namespace of that
name that Anycloud does not own fails the Deployment closed. Each Pod
is constrained to the node pool's Nodes (selector, required affinity, and
the node pool taint's toleration) and is never scheduled onto the management
Node or a sibling node pool. It resolves DNS through its Node (`dnsPolicy:
Default`) and receives no Service, ingress, or cluster networking; Jobs-only
node pools stay outbound-connected. The namespace's default egress policy
lets Pods reach their Node's DNS resolver, the other Pods in the node pool
and the internet, but not other cluster Pod addresses (or Services backed by
them) or the instance-metadata address `169.254.169.254` beyond its DNS port.
On GCP the Node's resolver is that metadata address, which is why its DNS port
stays open; Lambda Nodes resolve through the public `1.1.1.1` and `8.8.8.8`.
Each node pool Node also drops Pod traffic to the metadata address itself (DNS
excepted on GCP), and on Azure to the WireServer `168.63.129.16` except its DNS
port, before any policy applies, so the deny holds for a Pod that starts before
the policy covers it; the Node's own use of both is unaffected.
The projected token the application presents to `next_job()` is bound to that
namespace's ServiceAccount and to the running Pod, and the API verifies it
against the cluster before every pickup.

In API responses `target` names the target as `{ kind: "nodePool", nodePoolId }`
and the summary also carries `nodePoolId`.

A targeted Job is one Workload record and creates no native Kubernetes Job or
VM. It is picked up, completed, canceled, retried, and cleaned up the same way
whichever Pod runs it, and it survives an API restart: a running Job whose Pod
is gone is retried, and a finished one is released. Deleting the Deployment drains
its Jobs, removes its own native objects by exact UID, and leaves the
namespace, sibling Deployments, the node pool, and the cluster untouched. A
node pool cannot be deleted while a Deployment still targets it; once none
does, node pool deletion removes the namespace it owns.

**Deprecated:** `--privileged` is removed in the next release, and a
`--user-namespace-jobs` node pool refuses it; run such work as Jobs on that
pool ([User-namespace Jobs](/platform/jobs#user-namespace-jobs)).
`--privileged` grants broad Linux capabilities and host device access, including
KVM when the node supports it. Use it for trusted workloads on dedicated
capacity; a privileged Deployment can affect its node and other workloads there.
Cluster security policy may reject privileged Pods.

Deployment binds are disposable Kubernetes `emptyDir` volumes. They survive a
container restart and are removed when the Pod is replaced or deleted. Host
paths, named Docker volumes, mount modes, overlapping paths, and mounts covering
`/dev`, `/proc`, `/sys`, or runtime token directories are rejected. The Deployment
application owns per-Job cleanup; volumes are shared by the Jobs running concurrently in it.

GPU options follow VM Job defaults. On verified NVIDIA capacity, omitting
`--gpus` or using `--gpus all` requests every GPU on one capacity VM. A positive
integer `N` requests exactly that many GPUs and cannot exceed verified per-VM
supply. `--gpus 0` and malformed values are invalid. CPU capacity requests no
GPUs when the flag is omitted. Explicit GPU access on CPU or non-CUDA capacity
is rejected. Deployments require verified CPU or NVIDIA capacity even without GPU
flags; unknown supply is rejected. Image names and CUDA
metadata do not change these defaults. `all` is independent of node pool size
and the number of currently free GPUs. Empty Docker option values,
including `--runtime ""`, are invalid.

GPU Deployments automatically use the NVIDIA runtime. Explicit `--runtime nvidia`
is supported on NVIDIA capacity; CPU `--runtime runc` uses the default managed
runtime. The current managed adapter rejects `--runtime runc` with GPU access
because its NVIDIA device injection requires the NVIDIA runtime.
Image inspection rejects incompatible accelerator requirements, such as a ROCm
image on NVIDIA capacity.

### Named Secrets

Repeatable `--secret <name>` gives the container a saved
[Secret](/platform/secrets-environment)'s keys as environment variables:

```bash
anycloud secrets new model-db DATABASE_URL=postgres://...
anycloud deployment create model ghcr.io/acme/model:latest \
  --node-pool training --secret model-db
```

Create and every upgrade refuse a name with no saved Secret before anything is
stored. `status` shows the names on a `Secrets` line, and JSON responses carry
them as `secretNames`; values never appear in responses. On each reconcile the
API resolves the current values into one Kubernetes Secret the Deployment owns,
which the container reads through `envFrom`. An explicit `--env` value wins
over a same-named Secret key, and when two Secrets share a key the later
`--secret` wins.

To rotate, overwrite the Secret with `anycloud secrets new`. Running containers
keep the values they started with. Within seconds the Deployment's Kubernetes
Secret holds the new values, and a key removed from the Secret is removed
from it too, so any container that starts later (a restart, a
replaced Pod, the next rollout) receives them, including after an API restart.
To move every replica to the new values, run
`anycloud deployment upgrade <name> --secret <secret>`, which drains running
Jobs first like any upgrade.

`upgrade --secret` replaces the whole list, `--no-secret` removes every
reference, and omitting both preserves them. To move a credential out of
`--env`, save it as a Secret and, in one update, add the Secret and drop the
`env` key through the [API](#api-updates) or
[Python SDK](../python-sdk.md), since the `env` value would otherwise win.

`anycloud secrets delete` refuses a Secret that a Deployment not yet deleted
references. After `--force`, the running replicas keep their values, but the
Deployment stops reconciling: it doesn't roll out or repair its Kubernetes
objects, and upgrades that keep the reference are refused, until you save the
Secret again or upgrade without it. The API log names the missing Secret.
Deleting the Deployment still works.

## Inspect, upgrade, and delete

```bash
anycloud deployment list [--node-pool <id-or-name>] [--json]
anycloud deployment status <id-or-active-name> [--verbose] [--json]
anycloud deployment upgrade <id-or-active-name> [options] [-- command...]
anycloud deployment delete <id-or-active-name> [--json]
```

`update` is an alias for `upgrade`, and `terminate` and `rm` are aliases for `delete`.
`upgrade --wait` waits until all replicas on the upgraded revision are ready (a
later upgrade also satisfies it) and exits `1` if the rollout fails, including
a container in `CrashLoopBackOff` that Kubernetes is still retrying.
With `--json`, the first line is the Deployment, then the wait records.

`list` also accepts `ls` and `get`, and `status` accepts `describe`. Without a filter, it lists all visible
Deployments. The node pool filter accepts an ID or active name and returns only
Deployments on that node pool. Unknown and inaccessible node pools return the same
error. Each row shows the Deployment's revision, `REPLICAS` (ready over the
bounds), and `JOBS`, the Jobs holding a slot over
`max-replicas × max-concurrent-jobs-per-replica`. A row whose name ends in
`(managed)` is a Deployment Anycloud runs for
[Jobs on a node pool](/platform/jobs#jobs-on-a-node-pool); `upgrade` and
`delete` refuse it, and it's removed after 24 hours with no Job.
`list` reads stored inventory without
contacting Kubernetes, so an unhealthy node pool can still be inspected. Its
`STATE` shows only what's stored: `terminated · releasing` while a deletion is
pending, and `terminated` once it's deleted. For a live Deployment the cell is
blank, and `status` shows its live state:

```text
$ anycloud deployment list
NAME     ID           NODE POOL  REVISION  REPLICAS  JOBS  AGE  STATE
whisper  dep-whisper  np-gpu     1         -/1       2/2   3h
voice    dep-voice    np-gpu     3         -/2       1/4   3h
rerank   dep-rerank   np-gpu     3         -/1       1/2   3h   terminated · releasing
```

States follow Jobs and Services:

- `starting`: the first revision has never been ready: its container is
  starting, or its readiness probe hasn't passed yet.
- `running`: the Deployment has been ready, which means the probe passed when
  one is set. An upgrade leaves it `running`, and `status` shows the rollout as
  `Upgrade N`.
- `failed`: a revision that hasn't rolled out can't start as configured:
  Kubernetes is backing off from `ImagePullBackOff` or `CrashLoopBackOff`, which
  it keeps retrying, or the image name is malformed (`InvalidImageName`).
- `terminated · releasing`: deletion was requested, and the Deployment is
  waiting for its Jobs to finish and be cleaned up. The label goes away once
  the Deployment is deleted.
- `unknown`: the Kubernetes Pod phase, shown when Kubernetes can't be read
  within one second or the Pod can't be identified yet.

A revision has rolled out once Kubernetes reports its ReplicaSet available. If
that revision then loses readiness (its probe fails, its Pod restarts, or its
container starts crash-looping), the Deployment stays `running` and `status`
shows a ✗ `ready` line with the reason, the way a Service shows an unhealthy
container. Ready replicas can continue taking new Jobs while others recover:

```text
   ✗ ready  Waiting for the readiness probe to pass; new Jobs wait.
```

`status` uses bounded live Kubernetes reads. It shows the
fields, the reason for the current state, and, while Jobs block an upgrade or
deletion, up to three of them. Revision 1 is the create, so revision N + 1 is
`Upgrade N`. The API also starts a revision itself, once, when an API upgrade
changes how it runs replicas, or when a natively recreated ServiceAccount
leaves a replica unable to authenticate. Such a revision drains like any
other:

```text
$ anycloud deployment status voice

⚡  running

   Name             voice
   ID               dep-voice
   Node pool        np-gpu
   Image            ghcr.io/acme/model:v3
   Revision         3
   Jobs             1/2 · 1 queued
   Readiness probe  exec: ["/app/check-ready"] (periodSeconds=2)
   Age              3h
   Replica time     41.5 h ($207.50) · 36.0 h busy ($180.00) · 5.5 h idle ($27.50)
   Waiting on       job-7f3a (running)

   Upgrade 2 · ghcr.io/acme/model:v3
   ◌ pod  starting: Waiting for Jobs on the previous revision to finish and be cleaned up; new Jobs wait.
```

`--verbose` breaks the revision into requested, applied to the Kubernetes
Deployment, and observed on the Pod, and it adds the Pod's name, UID, container ID
and up to ten blocking Jobs with their revisions. Both views use the same
observation:

```text
   Revision         3 requested · 2 applied · 2 in Pod
```

`Replica time` totals the hours the Deployment's replicas have held a node
pool Node since each was scheduled, priced at each replica's share of its
Node's VM price: the largest of its GPU, CPU and memory requests as a fraction
of the Node. Busy is time a Job ran on the replica; idle is the rest. Account
spend and caps still count each pool VM in full. JSON reports it as `usage`
(`replicaHours`, `busyHours`, `costUsd`, `busyCostUsd`), only on `status`.

A finished Job still holds its slot until it's cleaned up, so it appears in
`JOBS` and as `cleaning up` while it blocks. These observations explain
availability; they don't reserve a slot.

JSON summaries include the desired `readinessProbe`. Individual status includes
the `status` observation; list and mutation responses set `status` to `null`.
`status.state`, `status.releasing`, `status.ready` and `status.upgrade`
(`number` and `state`) carry the states and lines above. `applicationReady` and `probeConfigured` describe the
observed Pod's probe. Jobs holding a slot are `jobs.unreleased`. Revisions stay
numeric under the Kubernetes field names `generation`, `requestedGeneration`,
`appliedGeneration` and `podGeneration`. `--json` returns the complete
structured response and takes precedence over `--verbose`. Reading status
observes Kubernetes probe results without executing the probe.

```bash
anycloud deployment list --node-pool training
anycloud deployment ls --node-pool node-pool-id --json
anycloud job list --deployment deployment-id -n 400
```

Upgrade accepts a trailing replacement command plus `--image`, `--gpus`,
`--runtime`, `--shm-size`, `--memory`, `--cpus`, `--privileged`,
`--no-privileged`, repeatable `--bind` and `--secret`, `--no-secret`,
`--max-concurrent-jobs-per-replica`, and `--grace-period`. Each supplied container option changes only
that setting; omission preserves it. For example, upgrading CPUs keeps memory,
volumes, privilege, and the admitted GPU allocation:

```bash
anycloud deployment upgrade model-deployments --cpus 6
anycloud deployment upgrade model-deployments --no-privileged
anycloud deployment upgrade model-deployments --readiness-probe '{"exec":{"command":["/app/check-ready"]}}'
anycloud deployment upgrade model-deployments --readiness-probe null
```

`--no-privileged` explicitly stores `false`. Supplying `--bind` replaces the whole
volume list; omitting it preserves all existing mounts. Use the
[API](#api-updates) or [Python SDK](../python-sdk.md) to remove stored settings.
Put `--` before a replacement process command to pass its flags unchanged.

Omitting `--readiness-probe` preserves the configured probe. Supplying an object
replaces the whole probe; `null` removes it. Probe changes are upgrades too:
they advance the revision and wait for active Jobs to drain before replacement.

Only supplying `--gpus` in a CLI update recalculates GPU allocation. Other
updates preserve the admitted count and revalidate capacity and runtime
compatibility. A catalog change cannot silently expand that allocation;
insufficient or incompatible capacity rejects the update. Raising `--gpus`
reserves the added devices against the same pool-wide bound as create; an
increase that doesn't fit is refused with a 409 conflict.

The server validates and commits all supplied changes together. Concurrent
upgrades from the same revision cannot overwrite one another: one succeeds
and the other reports a conflict. Run the command again to apply its changes to
the latest configuration. An upgrade increments the revision,
stops the old process from selecting new Jobs, drains its running Jobs, and
then performs a no-surge replacement. Deletion rejects new Jobs, terminates
queued Jobs, drains running work, and removes the Kubernetes resources.

### Shutdown grace

Every replica stop gets the Deployment's `--grace-period` (default `30s`, at
most `1h`) between SIGTERM and SIGKILL. Upgrades and deletion first wait,
without a time limit, for its running Jobs; an eviction, a Node drain, a
`kubectl delete` and scale-in (which removes only replicas that hold no Job)
don't. Set it to how long the process needs to finish its sessions, such as
`--grace-period 10m` for voice agents. `deployment status` shows it, and
changing it is an upgrade.

The grace can't outlive a spot reclaim: AWS gives about 2 minutes' notice,
and GCP and Azure about 30 seconds. A Node lost without notice gives none,
and its running Jobs are retried.

Active names are API-wide and case-insensitively unique. A deleted Deployment
remains addressable by immutable ID, its name can be reused, and name lookup
only selects active Deployments.

Submit work with `anycloud job --deployment <id-or-active-name>`. Targeted Jobs
reuse status, termination, and resubmission, but do not support per-Job logs,
exec, or SSH. `anycloud logs <id-or-active-name> [--follow]` shows the
Deployment's newest Pod, Ready or not, including the previous run of a
crash-looping container (see [`anycloud logs`](workloads.md#anycloud-logs)).
`anycloud exec [--replica <pod>] <id-or-active-name> "<command>"` runs a
command in a ready replica, or in the running replica `--replica` names (see
[`anycloud exec`](workloads.md#anycloud-exec)).

A Job uses the Deployment's current configuration when selected for execution.
Resubmitting it preserves the Deployment target, so Deployment updates can change the
configuration used by its next execution. Inspect configuration through
`anycloud deployment status`; the Job's list/status JSON reports its `deploymentId`
and null container configuration fields.

### API updates

`PATCH /v1/deployments/{id}` accepts `dockerOptions`, such as
`{"dockerOptions":{"cpus":"6","memory":null,"privileged":false}}`.
Omitted keys preserve their values, `null` removes a setting, and arrays replace
the entire array. `binds: []` explicitly clears the volume list.

Removing `gpus` through an explicit `null` reapplies the capacity default,
including all GPUs on NVIDIA capacity.

`dockerOptions: null` clears all options and reapplies GPU capacity defaults.
Empty updates, empty option objects, and invalid combinations fail before
persistence; revision conflicts return 409 without partial changes.

Options objects now preserve omitted settings. Callers that previously relied
on full replacement must explicitly set unwanted options to `null` in the same
request. Replace clear-all `dockerOptions: {}` calls with `dockerOptions: null`.
Upgrade the API and its CLI/Python clients to matching versions.
