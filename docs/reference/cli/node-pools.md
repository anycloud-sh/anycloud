---
title: node pool
description: Run cloud-specific node pools inside the installation's Kubernetes cluster.
---

# `anycloud node-pool`

**Node pools** are cloud-specific VM pools inside the installation's
[cluster](/reference/cli/cluster): each node pool owns its own compute
credential, VM types and optional region and zone pins, and Anycloud provisions its
VMs, joins them to the cluster, and releases them. Deleting a node pool never
deletes the cluster or a sibling node pool. Node pools are created through the
hosted API (`anycloud api use https://<cluster-id>.anycloud.sh`) after the
compute credential has been added there with `anycloud credentials new`.
The end-to-end path from `anycloud cluster create` to a Service running on a
node pool is in [Clusters](/platform/clusters).

## Create a node pool

```bash
anycloud node-pool create <name> \
  [--cluster <id-or-name>] \
  --credentials <name> \
  [--region <region> [--zone <zone>]] \
  --vm-type <type> [--vm-type <type> ...] \
  --min-vms <count> \
  --max-vms <count> \
  [--disk-size <gb>] [--disk-tier medium|high|ultra] [--spot] \
  [--user-namespace-jobs | --allow-privileged-jobs] [--require-nested-virtualization]
```

Pass `--wait` to wait until the node pool is Ready, with the exit codes of
[`anycloud wait`](/reference/cli/workloads#anycloud-wait). A pool that reports
`failed` ends the wait with exit `1`. With `--json`, the first line is the
node pool, then the wait records.

Creation is refused with `NODE_POOLS_UNAVAILABLE` until the cluster is
ready. `--cluster` is optional and must resolve to the cluster record when
given. The credential, VM types and pins are fixed for the node pool's whole
life. Repeat `--vm-type` to give an ordered list of types, like a VM Job's:
each VM launches as one of them, and the type with no capacity is skipped for
the next. Every type in the list must share one GPU kind and count, so a list
that mixes CPU and GPU types or GPU counts is refused at creation, as is a
type the pinned region doesn't offer. Each VM is
priced and billed as its own type, and `anycloud node-pool status` shows the
type each live VM runs. Without `--region` the node pool is unpinned, like a
VM Job: each VM launches in a region the catalog offers its type in, the
cluster's own region first, then in the list's order, and a region without
capacity is skipped for the next. `--region`
pins every VM to that region; a region pin still moves between the list's
types and, on GCP without a zone, between the region's zones. `--zone` requires `--region` and must belong to it
(`us-east-1a`, `us-central1-a`) or be a single digit on Azure; other providers
accept no zone. `--min-vms` and
`--max-vms` are both required, with `0 ≤ --min-vms ≤ --max-vms` and
`--max-vms` at least 1; the pool scales between them, and equal bounds make it
fixed-size ([Scaling](#scaling)). The bounds are fixed for the node pool's life. The credential's
cloud must support isolated capacity networking: AWS, Azure, GCP, and Lambda.
On Lambda, a node pool VM's own firewall ruleset opens nothing, but TCP 22 and
ICMP stay reachable through the account's global firewall rules, which apply
to every instance. In `us-south-1`, which has no firewall rulesets, Lambda
rejects the ruleset, so no VM launches and the node pool is `failed` with that
error.
The cluster must run Kubernetes v1.35 through v1.38, the window the pinned
agent supports.

`--disk-size` and `--disk-tier` set the OS disk every VM in the pool boots
with, as they do for a VM Job, and `anycloud node-pool status` shows them.
Without them a VM gets the provider's default disk, raised to at least 25 GB
on a CPU pool so the Node fits what it reserves, or 100 GB on an NVIDIA GPU
pool. On Azure, `high` and `ultra` need VM types with Premium storage. Lambda
node pools boot with a fixed disk and refuse both. A `--disk-size` smaller
than the tier or the VM image needs isn't checked at creation: the pool's VMs
fail to launch, so delete the node pool and recreate it with a larger
`--disk-size`. Each Node keeps a cache directory,
`/var/lib/anycloud/node-cache`, that outlives its Pods, where a Job's
[`--cache`](/platform/jobs#jobs-on-a-node-pool) lives.

On H100 and A100 sizes with local NVMe, kubelet scratch space, container
images and the cache directory live on the NVMe, striped (RAID 0) across its devices and made again
on each boot after a deallocation wipes it. On other Azure sizes with a
resource disk at least as large as the OS disk, they live on the resource
disk, which a deallocation empties, so images are pulled again. On other sizes
they live on the OS disk. Each Node reserves room for the OS and images (55 GB on an OS-disk GPU
pool, 20 GB on a CPU pool, 100 GB on NVMe), and a `--disk-size` that leaves
nothing after it is refused, naming the minimum. A pool Job's replica gets its
GPU (or CPU) share of the rest, and a Job that writes past it is evicted and
ends `invalid`. A CPU pool created without `--disk-size` sets no such limit.
These settings apply to VMs launched after the upgrade.

`--spot` launches every VM in the pool as a spot VM on AWS, GCP and Azure;
Lambda has no spot VMs and refuses it. Without it the pool is on-demand, and
`anycloud node-pool status` shows which. When the cloud reclaims a spot VM, it
deletes the VM rather than stopping it, and the node pool launches a
replacement. The VM's OS disk and node cache go with it, and its Workloads
recover as they do from any lost Node. On every node pool, an OS shutdown gives Pods up to 80 seconds to
stop.

**Deprecated:** `--allow-privileged-jobs` is removed in the next release; use
`--user-namespace-jobs` instead. It lets
[Jobs on the pool](/platform/jobs#jobs-on-a-node-pool) use `--privileged` and
`--bind`, which other pools refuse. A privileged Job is root on its Node, and
can read the GitHub login token of each user whose Job, Deployment or Service
runs there, unprivileged ones included. That token grants the user's anycloud
access. Use such a pool only from one dedicated GitHub account whose access is
limited to that pool's purpose, such as your CI runners. `anycloud node-pool status` shows `Privileged Jobs` on such a pool.
The option gates Jobs only:
[`anycloud deployment create --privileged`](/reference/cli/deployments) is
admitted on every pool but a `--user-namespace-jobs` one. Every Node allows 8192 inotify instances,
enough for Docker-in-Docker and nested K3s.

`--user-namespace-jobs` runs every
[Job on the pool](/platform/jobs#user-namespace-jobs) as root of its own user
namespace, so it can run container engines, image builds, inner `--privileged`
containers and nested clusters without being root on its Node. Those Jobs take
`--bind`, and not `--cache`. The pool takes CPU VM types only, not with
`--allow-privileged-jobs`, and the option can't change after create.
`anycloud node-pool status` shows `User-namespace Jobs` on such a pool. It
applies to Jobs only: Deployments and Services on the pool run as on any other.
Every Node allows 8192 inotify instances, enough for Docker-in-Docker and
nested K3s.

`--require-nested-virtualization` gives every Node `/dev/kvm`, for microVMs
such as Firecracker, Android emulators or VM image builds. It keeps only
the listed VM types that the catalog reports as supporting nested
virtualization in the pool's region, or in any region when the pool is
unpinned, and launches them with it on. An unpinned pool launches only where
the catalog reports support. Unknown support counts as none, and a pool left
with no type is refused.
[`anycloud vm-types <cloud> <region> --details`](/reference/cli/catalog-pricing#anycloud-vm-types)
shows each type's support. On AWS, 7th- and 8th-generation Intel types such as
`m7i` and `c8i` support it; Graviton types don't. On GCP, Intel series such as
N2, N4, C3 and C4 support it, as does AMD's N4D, and an organization policy
that forbids it makes each launch fail with that error. On Azure, the size
series decides, for example Dsv5, Dsv6 and Dasv6. With
`--user-namespace-jobs`, each Job gets `/dev/kvm`; other Pods don't see it.
`anycloud node-pool status` shows `Nested virtualization` on such a pool.

Creation returns after durable intent is stored. Anycloud then provisions each
VM with the node pool's own credential in an outbound-only network scope,
one per region the pool launches in (no public ingress, no peer rules, no SSH key, no cloud credential on the VM),
and the VM downloads a checksum-pinned K3s agent and joins the cluster with a
short-lived, per-VM bootstrap token pinned to the cluster's certificate authority.
The token is removed as soon as the Node object exists, before it is Ready, and
a retried attempt replaces its previous token rather than adding one. Only
x86_64 VM types are supported: the agent refuses to start on any other
architecture, and a Lambda node pool on an arm64 type (such as `gpu_1x_gh200`)
launches no VM and is `failed` with that error. Each VM is recorded like a Job or Service VM,
with the node pool as its only owner, and is billed under the node pool's
resource scope. The cluster advertises its public address, so an agent's
supervisor tunnel to it works from any cloud, and the cluster reads pool kubelets
through that tunnel — no inbound port into a pool VM is ever needed. Agents
register their public address as the Node external IP and the cluster's flannel
uses external IPs, so Pod-to-Pod traffic between the cluster and a pool in
another cloud would need UDP 8472 open between their public addresses; Jobs
send no Pod traffic across nodes, and a node pool Service's replica runs on
the pool's ingress entry Node so its Traefik reaches it locally, so nothing
has to be opened for them. A restarted or rebooted agent rejoins with
its kubelet certificates, and a VM whose agent crashed before its Node
registered is replaced. A new Node starts pulling the pool's recent public Job
images as it joins
([pull and startup behavior](/platform/container-images#pull-and-startup-behavior)).

Node pool Nodes join with the labels `anycloud.sh/cluster`, `anycloud.sh/node-pool`,
`anycloud.sh/provider`, and `anycloud.sh/attempt` — plus
`anycloud.sh/accelerator=nvidia` on NVIDIA GPU VM types — and the taint
`anycloud.sh/node-pool=<id>:NoSchedule`. Once the API matches a Node by name
to a VM it launched for the node pool, it adds
`node-restriction.kubernetes.io/anycloud-node-pool=<id>`, a label a Node can't
set on itself. Work that Anycloud schedules onto a node pool selects that
label and tolerates only the pool's taint, so even a root process on one Node
can't move that Node into another node pool. A missing or deleted node pool
leaves such work Pending rather than moving it to a sibling node pool or the
management Node.

Every K3s agent also holds a shared controller identity that K3s lets update
the status of any Node. Before a node pool's first VM launches, the API
installs the admission policy `anycloud-k3s-controller-node-status`. It lets
that identity change only flannel's `flannel.alpha.coreos.com/` annotations,
so a root process on one Node can't use it to change another Node's labels,
conditions or addresses.

A node pool uses Workload states: it is `provisioning` until it becomes
`running`, when `--min-vms` of its Nodes are Ready and, for GPU VM
types, advertise the catalog's physical GPU count; with `--min-vms 0` it is
`running` at once, with no Nodes. It stays `running` while it scales. A VM whose Node never
appears within ten minutes, stays NotReady for fifteen, or fails a GPU check
after a Job couldn't use its GPU, is replaced. Replacement pauses while more
than 40% of the pool's Nodes (at least two) are absent or NotReady at once, or after
three replacements within six hours. The pool keeps its VMs, `node-pool
status` shows why, and replacement resumes once Nodes recover or the six
hours pass. A VM the cloud reports
stopped, such as one stopped from the cloud console, is deleted at once
instead, without counting toward that limit, and its Workloads recover once
its deletion is confirmed. Its replacement launches in the same pass when the
pool is at `--min-vms` or the VM ran a Workload; an idle stopped VM above the
minimum isn't replaced. A failed launch is
classified like a VM Job's and recorded on its VM row; the next launch picks
from the node pool's failures in the last 12 hours. Where the provider reports
which candidates can launch, as for a VM Job, those are tried first; this check
runs only before buying a VM, and a credential with no usable target (no
enabled region, or no quota) backs off like a capacity failure. A capacity or
regional-quota failure, or a region the provider rejects for an unpinned pool,
moves on at once to a candidate not yet tried in this pass (a pool pinned to
one zone, or to one region on a provider without zone rotation with a single VM
type, backs off instead); an account quota or transient error, or every
candidate failing in the pass, backs off (one minute, doubling to thirty), and
the next launch walks every candidate again. None of these fails the node
pool. Only a terminal outcome does: a pinned target the provider rejects with
no other VM type to try, a pinned region the credential may not use, or an
invalid request. A
credential the provider reports invalid is marked, and launches pause until it
is fixed. While it backs off, the node pool keeps its state and reports the
failure, with its region and diagnosis, in its last error, which clears once a
new VM launches.
Any other unexpected error in a pass, such as a cluster API timeout, also keeps
the node pool's state and is reported in its last error until the node pool is
next ready. A `failed` node pool provisions nothing until it is deleted and
recreated. A Node that claims the node pool — by label or by the
Node name Anycloud issued — but does not match a VM the node pool provisioned
marks the node pool `failed` and is never counted. The exception is a Node
that claims it only by the `anycloud.sh/node-pool` label while it is a member
of another node pool, or carries the Node name Anycloud issued for another
node pool: the node pool ignores it and names it in its last error. A Node
left behind by a VM the node pool already released is removed.

## Scaling

A node pool buys VMs when its Pods can't be scheduled and removes VMs that
stay idle, between `--min-vms` and `--max-vms`. It checks every 30 seconds.

- **Scale-out.** Anycloud Pods that select the pool and that Kubernetes marks
  Unschedulable buy VMs: pool Job, Deployment and Service replicas. Queued
  pool Jobs reach the pool only as Pending replicas, so Jobs held back by a
  cap buy nothing. One pass packs the Pending Pods onto the smallest shape
  among the pool's VM types, after what each Node reserves for the system and
  its DaemonSets, and buys every VM they need, up to `--max-vms`. A pool with
  no Ready Node estimates that reserve from the catalog, so a burst from zero
  is also bought in one pass; a Pod the estimate rejects still buys one VM,
  whose Node then judges it. A VM counts
  toward capacity while it boots, joins and registers its GPUs, so repeated
  passes and an API restart never buy twice for the same Pods. A Pod that no
  empty Node of the pool holds buys nothing, even once the pool is back at
  zero Nodes. When an account budget or
  throttle blocks a purchase, the node pool keeps its state and reports
  `scale-out blocked by account cap` in its last error until a purchase is
  allowed again.
- **Scale-in.** A Node is busy while it runs an Anycloud workload Pod (a Job,
  Deployment or Service replica, including one finishing its upload), the
  pool's ingress, or a Pod that Anycloud's finalizer still holds. DaemonSet
  Pods don't count. A Node that stays idle for about 10 minutes is removed,
  down to `--min-vms`, which can be 0: Anycloud cordons it, lists its Pods again, and deletes
  it only if it is still idle. A Node that took a Pod in the meantime is
  uncordoned and kept. Scale-in never evicts a Pod, so a pool can stay larger
  than its demand until its Nodes go idle, and replica autoscaling removes idle
  managed replicas first. An API restart restarts every idle window, which can
  delay a removal but never removes a busy Node. A Node that joined with an
  older join script is replaced instead, one at a time and the ingress entry
  last; in a pool that would otherwise empty to `--min-vms 0`, it idles out
  instead. A spare Node joins first, then the old Node is drained through the
  Eviction API, which respects PodDisruptionBudgets for up to an hour; the
  pool's last error names a Node removed when that hour ran out. Services move
  to the spare and keep answering throughout. Without quota or spend room for
  the spare, the old Node goes first and the pool's last error says why.
- **Zero Nodes.** A pool with `--min-vms 0` runs no VMs while idle. The
  first pool Job after an idle gap waits for a VM to boot and join. Services
  and Deployments need a Ready Node, so they are refused while the pool has
  none, and a Node running one is never idle.

## Cluster add-ons

Some cluster components are installed once per cluster and shared by every
node pool on it. The first is the NVIDIA stack: the `nvidia` RuntimeClass and
the NVIDIA device plugin DaemonSet (`kube-system/anycloud-nvidia-device-plugin`,
image pinned by digest). The hosted API installs them through its own cluster
authority the first time a GPU node pool is reconciled, before any VM is
bought, and re-checks them on every later GPU node pool pass, after that
node pool's existing VMs have been observed: an object it owns is left alone
while unchanged, rewritten if something else edited it, and recreated if a
field the API server treats as immutable differs. A RuntimeClass that K3s
installed itself with the `nvidia` handler and no overrides is used as is. Any
other object with the same name that Anycloud does not own marks the GPU
node pool `failed` with a diagnostic naming the object and the `kubectl
delete` that removes it; Anycloud never adopts or replaces foreign objects,
and an add-on failure never blocks releasing or replacing the node pool's
existing VMs. A write the cluster's RBAC denies fails the node pool with a
diagnostic naming the missing verb and resource. CPU node pools need no add-on
and touch none of these objects, and a cluster with no GPU node pool is not
re-checked.

Add-ons are never uninstalled. They are inert without GPU Nodes (the DaemonSet
selects none), and `anycloud cluster delete` removes the control plane they
live on. To uninstall by hand before that, delete `RuntimeClass nvidia` and
`DaemonSet kube-system/anycloud-nvidia-device-plugin` after the last GPU node
pool is deleted.

The DaemonSet selects only Nodes labelled `anycloud.sh/cluster=<cluster-id>` and
`anycloud.sh/accelerator=nvidia`, tolerates node pool taints, and does not
tolerate the management taint, so it never runs on the management Node or on
CPU node pools. GPU node pool Nodes join with the accelerator label; a GPU Node
that joined before this release without it is labelled by the next
reconciliation pass. The VM image must provide the NVIDIA driver and container
runtime; Anycloud selects a CUDA image for NVIDIA VM types.

A GPU node pool becomes `running` only when each Node advertises exactly the
number of `nvidia.com/gpu` devices the catalog attributes to its VM type as
allocatable. Allocatable is the advertised total, not free devices: Nodes whose
GPUs are all held by running Jobs remain ready capacity. A Ready Node that
advertises zero devices has ten minutes — from its VM's creation, or from the
pass that first saw the devices missing when a plugin restart drops the count
on a Node that was already ready — before the node pool is marked `failed`
with a diagnostic that names the add-on objects and their state; it counts as
`starting` meanwhile. A Node that advertises a different non-zero count than
the catalog marks the node pool `failed` with a device-count mismatch
diagnostic and is never counted; refresh the catalog or choose a VM type whose
physical device count matches. Work scheduled onto a GPU node pool — a
Deployment Pod or a Service replica — must request
whole `nvidia.com/gpu` devices — the larger of its biggest init container and
its regular containers' total, no more than one Node advertises — and run
under the `nvidia` RuntimeClass; work on a CPU node pool must request none.

## Ingress entry

A node pool that hosts a Service elects one **ingress entry**: the Ready VM
with the lowest attempt id, labelled `anycloud.sh/ingress-entry=<pool-id>` on
its Node and shown as `✓ ingress <public IP>` in `node-pool status`. The
entry keeps running ordinary workloads; it is a role, not a dedicated VM. If
its Node stays NotReady for two minutes and another VM's Node is Ready, that
VM takes over and the label moves; with no Ready replacement the entry stays
until its VM is replaced. Once the pool's last Service is gone, the label and
the entry are released, so that Node can go idle. On the first Service, the pool's network additionally
admits TCP 80 from Cloudflare's published edge ranges only — the same rule
VM-host Services carry. **The rule is applied to the pool's network as a
whole**, in every region with a live VM, so every VM in the pool accepts that traffic from Cloudflare, while
only the entry Node runs anything on the port; it is never removed. AnyCloud
then installs the pool's ingress release — a pinned Traefik `HelmChart`
installed through the same cluster add-on mechanism as the NVIDIA stack (its
install Job runs on the management Node like the API release's) — as a
DaemonSet on that pool's entry Node only, on host port 80, tolerating that
pool's taint and never the management Node's, watching only routes labelled
`anycloud.sh/ingress-pool=<pool-id>`, so a request to one pool's entry is never
served by another pool's Service. Deleting the node pool removes its release.
A Service on the pool is published at `https://<id>.anycloud.sh` pointing at
the entry IP (see [Public URL](/reference/cli/service#public-url)). Jobs-only node pools elect no entry,
open no port and install nothing.

`node-pool status` shows the release, read from the cluster at request time,
on one line: `✓ ingress <IP>` once the release is installed and running on a
Ready entry VM, `✗ ingress failed: <error>`, or `◌ ingress` with the first
thing it is waiting for: `waiting for an entry VM` (none elected yet),
`pending` (no ingress release on the cluster yet, or why the cluster could not
be read), `installing` (the release is installing), `entry VM not ready` (the
entry Node is not Ready), or `starting` (ingress replicas not all ready). With
`--json` the full view
is `ingress: { entryIp, release }`, where `release` is `null` for a pool that
hosts no Service and otherwise `{ state, helmJob, daemonSet, lastEvent }`:
`state` is `absent` (no HelmChart on the cluster), `installing`, `installed` or
`failed`; `helmJob` is `{ phase, message }` with the install container's
non-zero exit as `message`, or `null` before the HelmChart exists;
`daemonSet` is `{ desired, ready, entryNodeReady }` once Helm created it, else
`null`; `routes` counts the Services the pool's Traefik serves; `lastEvent` is the newest event on the install Job and its Pods (or,
once the DaemonSet exists, in the release namespace) as `reason: message`,
or a `cluster unavailable: …` note when the cluster could not be read. `ingressEntryIp`
remains as a shortcut for `ingress.entryIp`. The generated Python SDK models
these as nested objects of the node pool summary.

## Inspect and delete a node pool

```bash
anycloud node-pool list [--cluster <id-or-name>]
anycloud node-pool status <id-or-name>
anycloud node-pool delete <id-or-name>
```

`status` and `delete` accept the node pool ID or its name. Status reports the
state, the last reconciliation error, ready, starting, and
draining VM counts, and the region and zone of each live VM. `Scale-out`
shows the last pass that bought VMs, with the Pending Pods and lost VMs it
bought them for (`Scale-out  3 VMs for 3 Pending Pods, 2m ago`;
`capacity.lastScaleOut` in `--json`); an API restart clears it. `Runners` counts
the replicas that run [Jobs on the node pool](/platform/jobs#jobs-on-a-node-pool):
busy with a Job, idle, and Pending with why (the pool's capacity, a spend cap,
an image pull). It does not expose Kubernetes credentials, endpoints,
Pods, or raw Node objects.

Deletion is rejected while Deployments or Workloads target the node pool
(see [`anycloud deployment create --node-pool`](/reference/cli/deployments)),
including a terminated Service whose native objects have not yet been confirmed
removed. That cleanup runs through the hosted API's own cluster authority: if
the hosted API is down, or its chart-bound `ClusterRole` no longer holds the
permissions above, the Service stays uncleaned, the node pool cannot begin
deletion, and the cluster cannot be destroyed either. Restore the hosted API
(`anycloud api status` shows its latest upgrade) or the chart's RBAC and
cleanup resumes on its own; there is no forced cleanup path in this release. The reference check runs inside the deletion
request itself, so a Deployment or Service admitted at the same moment either
lands before the request and blocks it or finds the node pool already
`terminated` and is refused. Once nothing references the node pool, deletion
also removes the namespace the node pool owns on the cluster (Deployment
Pods run there; each Service owns its own namespace), re-checking
references immediately before; a namespace of that name Anycloud does not own
is left in place and recorded in the node pool's last error. Otherwise
deletion is durable and asynchronous: the node pool moves to `terminated ·
releasing VM (still billing)` (`releasing: true` in `--json`), Anycloud cordons
and removes its Nodes, terminates its VMs, waits for the provider to confirm
each release, removes its isolated network in every region it launched in
(including regions where every launch failed), and then drops the releasing
label.
While a VM is releasing, status shows how long it has been releasing and the
longest a normal release takes on its cloud
(`Releasing  g6e.xlarge for 2m; usually under 4m`;
`capacity.locations[].releasing` in `--json`): 4 minutes on AWS, and an
unmeasured ceiling of 11 minutes on GCP, Azure and Lambda. After the last VM is
released, the node pool reads `terminated · releasing network resources` while
its network is removed, and no VM is billing; on AWS the security group can
only be deleted once the instance has finished terminating, which can take up
to 5 more minutes. A provider error during a
release (a rejected terminate or a failed status read) is recorded in the node
pool's last error until that VM's release is confirmed, and it is retried on
the next pass. A permission error is reported at once instead of being retried
for minutes.
An uncertain provider observation keeps the VM attempt open and the node pool
releasing. The cluster and sibling node pools stay
usable throughout. `terminate` and `rm` are aliases for `delete`; `list` accepts
`ls` and `get`, and `status` accepts `describe`. Each command accepts `--json`.

### Results for scripts

`create` and `delete` are safe to re-run, and with `--json` print one
document with the
[exit codes and error codes of the lifecycle commands](/reference/cli/cluster#results-for-scripts):
the node pool as `status --json` shows it, or `{"error": {"code", "message"}}`.
Re-running `create` with the same name and settings answers with the node
pool it made; other settings are refused with `NODE_POOL_ALREADY_EXISTS`, as
are a pool still being deleted and a `failed` one, which you delete and create
again. Re-running `delete`, by ID or by name, answers
with the same node pool, `terminated` once it is gone; a name no node pool
ever had is `NODE_POOL_NOT_FOUND`. A pool with live references is
`NODE_POOL_REFERENCED`.
