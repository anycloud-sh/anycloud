# RFC 0015: Durable cluster placement and Anycloud-managed Kubernetes

> Status: Retired (2026-09-25)
> Date: 2026-08-16
> Author: Codex draft
> Updated: 2026-08-23 after making every API-driven qualification use the
> production cluster composition and making hosted API identity enable that
> composition without a separate capability flag.
> Accepted: 2026-08-23 after the implementation and live qualification
> completed.
> Outcome updated: 2026-08-31 to reconcile the completed qualification and
> remaining operational follow-up.
> Retired: 2026-09-25. Independent Clusters were removed from the product
> (owner decision C); node pools on the installation's one
> cluster are the only placement. This RFC remains as the historical record.
> Outcome updated: 2026-09-01 after
> [RFC 0033](./0033-peer-networkless-jobs-capacity.md) removed the
> peer-connectivity half of capacity networking (scope peer rules and the
> CoreDNS readiness gate) from the active jobs path. The no-public-ingress
> isolation scope is unchanged; RFC 0032 holds the restoration design.
> Amended: 2026-09-09 to require NVIDIA device registration for CUDA capacity
> and qualify it with real managed-Kubernetes MACE Jobs.

> Naming and placement update: shared records now use Workload; persistent
> applications use Kubernetes Deployment. The original `deployments.cluster_id`
> association below names the historical shared table. RFC 0029 removed that
> direct target; targeted Jobs now reach a Cluster through their Deployment.

## Summary

Add a durable `anycloud cluster` placement resource. A cluster record identifies
a scheduler target, owns its encrypted runtime connection, and survives API
restarts. How that target is acquired and who owns its infrastructure are
separate from how Job and Serve workloads use it.

RFC 0015 implements the first cluster kind, Kubernetes, and the first
acquisition path: Anycloud creates an isolated k3s control plane and joins a
fixed number of real cloud VMs to it. The first production qualification hosts
the control plane with the Anycloud API, separate from cluster capacity. That
ordering tests whether control-plane placement can remain independent of
capacity placement; it is not a permanent topology requirement. The path has a
one-to-one `cluster_capacity` record and uses the existing `vms` table as its
machine ledger. The generic cluster record does not contain compute
credentials, regions, VM types, capacity bounds, or control-plane placement.

This separation deliberately leaves two additive Kubernetes acquisition paths:

- registering an externally owned Kubernetes cluster; and
- creating a provider-managed Kubernetes service and then registering its
  connection.

Those paths are not delivered by RFC 0015. They must reuse the same stored
cluster identity, connection contract, workload association, and Job and
Serve runtimes rather than introduce parallel workload implementations.

The RFC 0015 VM-capacity path requires `min_vm_count == max_vm_count >= 1`, but
persists both bounds and drives provisioning through a desired-count capacity
reconciler. RFC 0016 can therefore add demand-based autoscaling for clusters
whose capacity Anycloud owns without replacing VM provisioning, ownership,
draining, or recovery. Externally managed capacity remains external.

## Context / problem

RFC 0014 shipped a request-aware Kubernetes runtime resolver while
deliberately preserving one process-default connection:

```text
StoredWorkload
  -> process-default Kubernetes connection
  -> Job and Serve runtimes
```

That is the correct workload seam but not a durable way to create, register,
select, or recover multiple clusters. Cluster selection must survive API
restarts and must apply consistently to deployment, polling, status, logs,
exec, termination, cleanup, update, and resubmission.

Cluster registration and infrastructure ownership are independent concerns. A
Kubernetes runtime needs a verified cluster identity and connection whether the
cluster was created from raw VMs, attached by a user, or created through a
managed Kubernetes service. Conversely, only the raw-VM path needs VM
placement, joining, replacement, draining, and cost accounting. Putting those
fields directly on every cluster would make external and provider-managed
clusters carry meaningless data and would couple the runtime to one acquisition
strategy.

The existing `vms` table is Anycloud's crash-recoverable cloud-VM provisioning
ledger. Its rows represent attempts to provision real machines and preserve the
provider identity needed for adoption, termination, cost, and cleanup. When
Anycloud directly creates cluster capacity, that capacity needs the same
guarantees without manufacturing Workload records or introducing a second
machine ledger. Nodes supplied by an external or provider-managed cluster are
not API-managed VM attempts and must not be represented by synthetic `vms` rows.

An earlier prototype ran a privileged k3s container beside the API, mounted the
host Docker socket, and recorded capacity in `cluster_nodes`. It proved the
basic API-hosted topology but conflicts with two current boundaries:

- hosted API containers deliberately receive neither the Docker socket nor a
  host-local workload capability; and
- `vms` must remain the sole ledger for real cloud machines Anycloud creates.

RFC 0015 keeps that acquisition topology while replacing those implementation
choices and preventing them from becoming assumptions of every cluster record.

## Goals and boundary

RFC 0015 must:

- persist scheduler-neutral cluster identity and workload selection;
- define one Kubernetes connection contract consumed by every workload path;
- make managed-capacity presence an explicit deletion-safety fence;
- implement durable Anycloud-created k3s clusters with fixed VM capacity;
- reuse the existing cloud gateways and VM ledger for that capacity;
- support the same managed-capacity lifecycle on every cloud gateway that can
  supply an isolated private peer network;
- preserve a normal extension path for attached and provider-managed
  Kubernetes clusters; and
- preserve the capacity seam RFC 0016 needs for autoscaling.

Opening that extension path does not mean partially implementing attachment.
RFC 0015 adds no attach command, cloud-managed Kubernetes adapter, in-cluster
connector, or external-cluster authentication contract. Unsupported acquisition
paths fail admission. The shared persistence and runtime layers nevertheless
must not assume that every cluster has Anycloud-owned infrastructure.

## Proposal

### Architectural separation

The design separates three concepts:

1. A **cluster record** is the durable placement identity selected by a
   workload.
2. A **runtime connection** lets the scheduler-specific runtime operate on the
   cluster.
3. An optional **managed-capacity record** means Anycloud owns the cluster's
   infrastructure lifecycle. Its absence means the target is externally
   managed and can only be detached.

For Kubernetes, every acquisition path must converge on the same registered
connection:

```text
Anycloud-created k3s ─────────────┐
externally attached Kubernetes ──┼─> registered Kubernetes connection
Anycloud-created EKS/GKE/AKS ────┘                 |
                                                   v
                                      request-aware runtime resolver
                                                   |
                                                   v
                                          Job and Serve runtimes
```

RFC 0015 implements only the first incoming path. The other paths are shown to
define the architectural boundary, not their user-facing or provider-specific
contracts.

The runtime resolver receives a stored workload and consumes cluster identity
plus connection state. It never reads capacity in order to choose or build a
runtime. The managed lifecycle controller is the only component that reads the
capacity record. A later managed acquisition path may extend that record with a
capacity kind and controller-specific state without changing workload routing
or Kubernetes workload behavior.

### Durable cluster registry and connection

Add one scheduler-neutral cluster table. RFC 0015 creates only rows whose
immutable `kind` is `kubernetes`:

```text
clusters
- id
- kind
- owner_user_id
- name
- state
- controller_identity
- encrypted_runtime_state
- connection_revision
- last_error
- created_at
- updated_at
```

The cluster row alone never authorizes infrastructure mutation. A matching
`cluster_capacity` row means Anycloud manages the target; no row means the
target is externally managed. Destructive code must load that record and the
selected controller's durable intent immediately before mutation. A missing or
mismatched record fails closed and permits registration cleanup only.

`clusters.kind` answers which scheduler runtime to use. Capacity-record presence
answers whether the target is managed or attached. RFC 0015 has only one
managed-capacity implementation, so it adds no capacity-type discriminator yet.

The generic `kind` prevents scheduler-specific foreign keys such as
`k8_cluster_id` followed by a future `slurm_cluster_id`. It does not introduce a
generic scheduler implementation: each supported kind owns its runtime,
connection validation, and controller module. A later cluster kind may add
kind-specific storage when it has concrete requirements.

Cluster lifecycle states are `Creating`, `Ready`, `Failed`, `Deleting`, and
`Deleted`:

- `Creating` means acquisition or registration has durable intent but has not
  yet produced an admitted runtime target.
- `Ready` means the connection is usable and the selected lifecycle
  implementation's readiness criteria hold.
- `Deleting` rejects new workloads while workload and lifecycle cleanup
  proceeds.
- `Deleted` means the connection is no longer selectable; historical identity
  remains.

A capacity shortfall is derived controller state rather than a cluster
lifecycle state. Name uniqueness applies to rows whose state is not `Deleted`.
Intent is persisted before local or cloud mutation.

`control_plane_identity` (named `controller_identity` when this RFC was
written) identifies the scheduler instance reached through the
connection. The registry treats it as opaque; for Kubernetes it is the
immutable UID of the `kube-system` namespace observed through the Kubernetes
API. The Kubernetes implementation verifies it before accepting new connection
state so a changed endpoint or credential cannot silently rebind an existing
cluster ID to a different Kubernetes cluster.

`encrypted_runtime_state` is opaque outside the kind-specific connection and
runtime modules. It may later describe a direct API connection or an
agent-mediated connection without changing the cluster repository or
workload schema. Endpoint, token, CA, kubeconfig, connector, and recovery
formats are not generic columns.

`connection_revision` advances through compare-and-set store operations when
usable connection material changes. Runtime bundles are cached by
`(cluster_id, connection_revision)`, and a changed revision invalidates the old
bundle. An older reconciler cannot overwrite newer access material.

Cluster rows record the immutable creator user ID for attribution. Access uses
the same ownership scope as workloads: a local API restricts access to the
creator, while all users admitted to a shared hosted API can use and manage the
clusters in that API database. Active names are unique within one API database
so name lookup cannot become ambiguous when a hosted API is shared.

### Optional Anycloud-managed capacity

Add a one-to-one capacity table. Its presence means Anycloud manages cluster
infrastructure; its absence means capacity and infrastructure lifecycle remain
external:

```text
cluster_capacity
- cluster_id
- compute_credential_id
- region
- vm_type
- min_vm_count
- max_vm_count
```

`cluster_id` is both the primary key and a restrictive foreign key to
`clusters`. The table records Anycloud's capacity intent, not all capacity
visible to the scheduler. An attached cluster may have many Nodes while having
no row because their lifecycle remains external.

RFC 0015 implements one capacity type: homogeneous raw VMs. The cloud provider
is derived from `compute_credential_id`, matching the schema decision that
removed `deployments.cloud_provider`.

The database permits:

```text
0 <= min_vm_count <= max_vm_count
```

The RFC 0015 creation path additionally requires equality and a non-zero
minimum. Neither is a permanent database constraint that RFC 0016 would have to
migrate away; RFC 0016 relaxes both in the same admission check.

An RFC 0015 Anycloud-created k3s cluster must have exactly one capacity record.
A future externally attached cluster has none. When a second Anycloud-managed
capacity implementation is added, the record gains a durable capacity-kind
discriminator and that implementation's controller-specific state. An
Anycloud-created managed Kubernetes service still has a capacity record because
Anycloud owns its lifecycle, but provider-managed Nodes do not become synthetic
`vms` rows.

This distinction gives future acquisition modes normal additive behavior:

| Acquisition path                 | `cluster_capacity`  | VM ledger                       | Infrastructure release                                 |
| -------------------------------- | ------------------- | ------------------------------- | ------------------------------------------------------ |
| RFC 0015 raw-VM k3s              | Raw-VM record       | Real Anycloud-created VMs only  | Drain and terminate VMs, then delete the control plane |
| Externally attached Kubernetes   | None                | None                            | Detach only; never destroy external infrastructure     |
| Anycloud-created managed service | Future typed record | No synthetic provider-node rows | Delete through that service's lifecycle controller     |

Only the first row is implemented here.

### Workload association and VM ownership

Add `deployments.cluster_id` with a restrictive foreign key and an index. The
selected cluster is immutable for the workload's lifetime. Resubmission uses
the same cluster; targeting another cluster requires a new workload.

Generalize `vms` so one row has exactly one durable owner:

```text
workload_id is set XOR cluster_id is set
```

This requires a stable VM-row identity rather than relying on a
workload-specific composite primary key. Cluster-owned rows add only
`removal_requested_at`. Existing workload-owned queries continue filtering by
`workload_id`; raw-VM cluster capacity queries filter by `cluster_id`.

Only RFC 0015's raw-VM capacity controller may create cluster-owned VM rows. In
production every such row represents an attempt to provision a real cloud
machine. A control-plane process, Kubernetes Node, Pod, container, managed
node-group member, or externally supplied machine does not enter the ledger.

`removal_requested_at` is Anycloud intent rather than mirrored Kubernetes
state. A live row with no removal request contributes or is joining capacity; a
live row with a removal request has durably claimed drain and termination; and
`ended_at` continues to mean that the provider VM is confirmed gone. Setting
the removal timestamp conditionally before Kubernetes or provider mutation
prevents a restart or concurrent pass from selecting a second VM. It does not
change the billing meaning of `ended_at`.

Cluster VM rows participate in the same credential retention, quota, spend,
price, cost, provider adoption, termination, and historical accounting as
workload VM rows. Rows remain after teardown. No `cluster_nodes` or other
parallel machine inventory is introduced.

### RFC 0015 Kubernetes acquisition topology

RFC 0015's concrete acquisition path has two distinct management layers:

- The **Anycloud API** owns durable intent, credentials, reconciliation, and
  provider mutations.
- A **Kubernetes control plane** owns one Kubernetes API, scheduler,
  controllers, and datastore.

Each RFC 0015-created cluster receives one isolated control-plane instance.
Production qualification first places that instance on the Anycloud API host,
outside the infrastructure location that supplies cluster capacity:

```text
Anycloud API host
├── Anycloud API process
├── Kubernetes control-plane instance for cluster A
└── Kubernetes control-plane instance for cluster B

cloud VMs owned by A ──join──> cluster A
cloud VMs owned by B ──join──> cluster B
```

One Kubernetes control plane defines one physical Kubernetes cluster. Sharing
the Anycloud API host does not share cluster identity. Each control-plane
instance has its own access material, durable state, and lifecycle. It is
independently supervised and survives an Anycloud API process restart.

This separated placement is an acceptance order, not a cluster-model
invariant. Qualification must measure correctness, control-path latency,
partition recovery, capacity replacement, and API-host replacement. If the
separated topology does not meet those gates at acceptable complexity, the
control plane may instead run alongside capacity through the same provisioner
contract. That fallback must not change cluster identity, runtime resolution,
or capacity ownership, and must not replace the VM ledger. The concrete
provider pairing and operating procedure belong to the production qualification
task, not this RFC.

In the first production qualification, the control-plane instance uses the
existing API host. It is not a cloud VM created for the cluster and is not
represented in `vms`. Any fallback that creates a real control-plane VM must
preserve the invariant that every Anycloud-created machine enters the existing
VM ledger. Kubernetes calls a joined VM a Node; Anycloud's public and
persistence vocabulary continues to call it a VM. The local acceptance
substrate may substitute a Docker-backed k3s agent for a cloud VM, but that test
double does not expand the production ledger to containers or Kubernetes
resources.

The control plane does not run Anycloud workloads. Consequently,
`min_vm_count` and `max_vm_count` count every workload-capacity VM and exclude
the control plane. Zero means a healthy control plane with no cloud
VM capacity: a state the reconciler reaches during teardown, but not one RFC
0015 accepts as a configured bound.

Each raw-VM cluster uses one compute credential, one cloud provider, one region,
and one homogeneous on-demand VM type. VMs may occupy multiple availability
zones inside that region when the provider network permits it. An Anycloud API
is multi-cloud by owning multiple single-cloud cluster records; RFC 0015 does
not place VMs from different providers or regions in one Kubernetes cluster.

Managed creation is admitted only for a compute gateway that implements the
private-peer network contract below. AWS, Azure, and GCP are the initial
production adapters. Spot capacity, providers without isolated peer
networking, heterogeneous VM types, cross-region capacity, cross-cloud capacity
inside one cluster, and pools are not part of this acquisition implementation.

### Cloud resource and private network boundary

Cloud gateways do not receive a cluster, cluster ID, scheduler kind, or managed
capacity record. The capacity controller translates its durable owner into an
opaque cloud-resource scope before calling the existing compute boundary:

```ts
interface CloudResourceScope {
  id: string;
  tags: Readonly<Record<string, string>>;
}
```

The scope is a deterministic namespace for provider resource names and tags.
All newly created resources carry `anycloud_resource=<scope.id>`; workload
or capacity code may add attribution tags, but the gateway neither interprets
them nor branches on their owner type. Existing `anycloud_deployment` tags
remain a legacy billing and cleanup fallback. Gateway orphan discovery uses
the generic resource tag plus the existing ended/user safety signals.

Extend the provider-neutral network intent with traffic admitted from another
VM attached to the same scope:

```ts
interface PeerIngressRule {
  protocol: 'tcp' | 'udp';
  port: number;
}

interface IngressSpec {
  ingress: IngressRule[];
  peerIngress?: PeerIngressRule[];
}
```

RFC 0015 requests no public ingress on capacity VMs. It requests UDP 8472 for
the Flannel VXLAN data path and TCP 10250 for kubelet and metrics traffic from
scope peers only. The provider mapping is deliberately small:

- AWS uses a scope-specific security group whose peer rules reference that
  same group.
- Azure uses a scope-specific VNet and NSG whose peer-rule source is the
  virtual network.
- GCP uses a scope-specific network tag and firewall rules with matching source
  and target tags.

The gateway still knows only resource scope, ingress intent, and VM operations.
It never installs k3s, handles join material, observes Nodes, or imports cluster
or Kubernetes lifecycle modules. Unsupported gateways reject the network
intent during admission before durable intent or provider mutation.

Network preparation is idempotent and precedes VM creation. A restart ensures
or adopts the same scope-specific network and passes its transient
`CloudNetworkHandle` to VM creation; provider identifiers are not added to the
generic cluster schema. Cluster deletion retains the network until every VM is
confirmed ended, then deletes it through the existing network teardown
primitive. Failed deletion remains durable cluster cleanup work.

Capacity VMs use private addresses for peer traffic. They initiate outbound TLS
to the stable control-plane join endpoint; the agent reverse tunnel carries
control-plane-to-node operations. In the first production qualification, the
API-hosted control plane is not a member of the provider-private capacity
network, so its endpoint must be publicly reachable without making capacity
VMs public. The same stable registration address and port are advertised by
k3s as the cluster's API endpoint and included in its TLS identity. The
control-plane process's host-private address must never be advertised to
agents: k3s agents discover advertised server addresses after initial
registration and would otherwise replace the reachable join address with an
unroutable one. A capacity-colocated fallback may use a private endpoint behind
the same control-plane access contract. A future Kubernetes cluster spanning
providers or regions requires an overlay-network capacity mode and multiple
capacity sources; it does not change cluster identity or workload runtime
resolution.

### User-facing RFC 0015 contract

Add:

```text
anycloud cluster create <name> \
  --credentials <name> \
  --region <region> \
  --vm-type <type> \
  --min-vms <count> \
  --max-vms <count>

anycloud cluster list
anycloud cluster status <id-or-name>
anycloud cluster delete <id-or-name>
```

`cluster create` selects RFC 0015's managed raw-VM capacity implementation and
transactionally creates the cluster and capacity records. Both capacity flags
are required and stored independently. RFC 0015 accepts them only when they are
equal and at least one. Unequal values fail before any provider mutation with
an error that autoscaling is not enabled. Zero fails because bounds are fixed
at creation and no command changes them: a `0 / 0` cluster would report `Ready`
with no workload capacity and strand every workload Pending for its entire
lifetime.

Job and Serve submission accept `--cluster <id-or-name>`. Cluster selection
is resolved server-side and persisted before Kubernetes mutation. A cluster
target is mutually exclusive with workload-level compute placement such as
credentials, region, VM type, and spot. Runtime-supported container options
remain workload-level input; RFC 0015 does not add Kubernetes CPU or memory
translation.

Managed cluster creation is available on hosted APIs, whose immutable process
identity composes the host-local supervisor client and capacity implementation.
There is no separate enablement flag or workload authorization bit to omit
during an upgrade. Other API installations fail admission rather than partially
creating a cluster. The cluster API does not expose where the capability runs.

`cluster status` reports lifecycle state, whether capacity is managed or
external, and details provided by the selected controller. For the RFC 0015
controller those details include cloud placement, configured capacity, derived
ready/starting/draining/failed VM counts, and a sanitized failure reason.
Generic status does not promise placement or VM counts for every future
cluster.

Status does not return Kubernetes Pods or Nodes, raw scheduler conditions,
kubeconfig, endpoints, tokens, controller identity, or connection revisions.
Internally observed Kubernetes conditions are translated to Anycloud terms
such as `waiting for cluster capacity` or `the requested resources do not fit
the configured VM type`.

Future external registration may add `cluster attach` and `cluster detach`.
Those commands are not aliases for create and delete: attach records and
validates an externally owned target, while detach removes Anycloud's
registration and owned scheduler resources without destroying the target. This
RFC reserves no CLI flags or authentication format for them.

This makes clusters user-facing placement resources, superseding earlier
owner decisions. Product positioning continues to describe
shipped behavior and changes when the feature ships, not when this RFC is
accepted.

### Managed control-plane provisioner

The API receives a narrow host-local dependency rather than Docker or root
access:

```ts
interface ManagedKubernetesControlPlane {
  ensure(intent: ClusterControlPlaneIntent): Promise<ControlPlaneAccess>;
  prepareForHostReplacement(
    clusterId: string,
  ): Promise<ControlPlaneRecoveryRef>;
  delete(clusterId: string): Promise<void>;
}
```

`ControlPlaneAccess` contains the values the Kubernetes acquisition controller
needs to establish the common registered connection: the `kube-system`
namespace UID as controller identity, client and VM-join material, and a
connection revision.
`ControlPlaneRecoveryRef` proves that recoverable state has been captured
durably. Neither type exposes endpoint, token, CA, datastore, or snapshot
formats outside the Kubernetes-specific controller and runtime modules.

The first production qualification uses a host-level supervisor installed with
the hosted API VM. It manages one control-plane-only k3s instance per RFC
0015-created cluster. The API container receives only the supervisor's
constrained interface; it never receives an unrestricted Docker socket or
arbitrary root command execution. The provisioner boundary does not require
that placement permanently: a capacity-colocated implementation must present
the same operations and ownership guarantees. Local acceptance runs this same
production supervisor against Docker Engine and the pinned k3s image. It
supplies only the control plane; cluster capacity is provisioned separately
through the compute seam and stays in the VM ledger.

The provisioner must:

- name and label local resources deterministically from the cluster ID;
- make `ensure` idempotently create, restart, or adopt an instance, so it
  doubles as the recovery action for a lost control-plane process;
- isolate ports, data, credentials, and deletion between clusters;
- return opaque API-client and VM-join access whose join path is reachable by
  the cluster's cloud VMs;
- preserve controller identity and access across process and host recovery;
- produce a crash-safe recovery point rather than copying live datastore
  files;
- refuse to initialize an empty replacement when durable state is expected;
  and
- delete only resources whose durable ownership identity matches.

The Kubernetes acquisition controller verifies the returned identity and
persists its client access through the common encrypted runtime state. It
increments the connection revision when access changes. VM-join material stays
inside the raw-VM lifecycle implementation and is not part of the generic
runtime contract.

API-hosted placement makes hosted API replacement part of the first production
qualification. A planned API upgrade must prepare every API-hosted control
plane for replacement before the old API host completes its final state sync.
The replacement host restores the same controller identity and access,
restores VM join reachability, and verifies that joined VMs reconnect.
Unplanned host recovery uses the most recent durable recovery point. It must
never silently create a new Kubernetes identity for an existing cluster row.
Any alternative placement remains responsible for equivalent identity and
recovery guarantees through the same lifecycle contract.

The host-provisioner spike is an acceptance gate for the RFC 0015 acquisition
path, not a requirement imposed on future attached or provider-managed
clusters. It must prove multi-instance isolation, remote VM joining, API
process restart, hosted API host replacement, stable join reachability, and
operation without exposing the Docker socket to the API. The first production
qualification deliberately keeps the control plane separate from capacity and
adds measurements for latency and partition recovery. If that placement fails
the gates, the control plane moves alongside capacity without changing the
common registry, runtime connection, capacity ownership, or workload paths.

The [local hosting spike](./0026-control-plane-hosting-spike.md) proves the
multi-instance, agent joining, process restart, snapshot restore, stable
identity, reconnection, deletion-isolation, and no-Docker-socket mechanics. The
production foundation promotes its constrained-supervisor boundary, raw-TLS
endpoint, encrypted recovery payload, and host-replacement protocol. A local
integration test runs that production supervisor against the real Docker
Engine and pinned k3s image, restores it on a fresh host root, and proves that
an existing agent reconnects with unchanged controller identity. The live
follow-up subsequently proved endpoint publication, checkpoint upload, VM
replacement, cleanup, and operation with Lambda-hosted control planes
separated from both Azure and GCP capacity.

### Fixed capacity through an autoscaling-ready seam

Managed capacity requires verified CPU or NVIDIA catalog facts. Unknown or
unsupported accelerator capacity rejects provisioning and remains degraded in
status. CUDA capacity has an additional readiness requirement. The capacity controller
derives the expected physical GPU count from the selected VM type and asks the
cluster's supervisor to reconcile its pinned NVIDIA device-plugin DaemonSet.
New CUDA agents carry the NVIDIA runtime label; the plugin selects those
agents, runs with the `nvidia` RuntimeClass, and advertises `nvidia.com/gpu`.
The supervisor first preserves a valid K3s-owned NVIDIA RuntimeClass or creates
its own. It refuses foreign ownership and repairs owned RuntimeClass and plugin
drift using UID/resourceVersion checks, including replacement of immutable
fields. CPU clusters do not reconcile NVIDIA resources.
CUDA capacity requests 100 GB boot disks through the shared compute
configuration, including replacement VMs, to accommodate downloaded image
layers and unpacked snapshots.
GPU Deployments select that runtime automatically. Deployment GPU intent follows VM
Jobs: omitted options on verified NVIDIA capacity and `gpus: "all"` resolve to
all GPUs on one capacity VM; a positive count requests that many verified
devices. Omitted GPU options on CPU capacity request none. The public
`dockerOptions.gpus` and `dockerOptions.runtime` fields retain that intent;
the Kubernetes adapter resolves an integer GPU request and limit.
Explicit `nvidia` is supported on NVIDIA capacity, and CPU `runc` maps to the
default managed runtime. Explicit `runc` with GPU access is rejected because
the current adapter requires NVIDIA runtime-assisted device injection.

A joined, Ready Node counts as ready CUDA capacity only when its allocatable
GPU count reaches the catalogued physical count. Allocatable supply remains
valid while Pods reserve every GPU; free scheduler capacity is a separate
observation. Initial cluster provisioning gets a bounded registration window. Missing
registration after that window, or loss on a previously ready cluster, exposes
a recoverable cluster failure with observed and expected counts. The
supervisor retries plugin reconciliation, and the cluster recovers when devices
return. Device registration failure alone must not replace an otherwise
healthy VM.

Same-version controller recovery and replacement-capacity bootstrap remain
required behavior.

Separate desired-capacity calculation from capacity convergence:

```text
capacity policy -> desiredVmCount
capacity reconciler -> actual and in-flight VMs converge to desiredVmCount
```

Expose one internal entry point for clusters with API-managed VM capacity:

```ts
reconcileClusterCapacity(cluster, capacity, desiredVmCount);
```

RFC 0015 validates equal non-zero bounds and passes `min_vm_count`. The desired
count is not persisted. Durable VM attempts and removal requests record
provider work already in flight, while Kubernetes supplies current join and
drain observations. The desired count can therefore be recomputed after an API
restart without losing mutation ownership.

Capacity provisioning calls `createComputeProvider()` with the capacity
record's stored credential and placement. It reuses the existing cloud gateways
and the lower-level VM attempt, adoption, networking, quota, spend, accounting,
and termination primitives beneath workload VM orchestration. It does not
invoke workload storage or workload-specific workload setup, and it does
not add a second production compute-provider abstraction.

The cluster path supplies a startup configuration containing the pinned k3s
version, opaque join access, a stable VM-derived node name, and Anycloud
ownership labels. K3s installs and runs the agent, registers it with the control
plane, and reconnects it after VM or control-plane process restarts. The agent
is a Kubernetes node component, not an Anycloud orchestration daemon: it
receives no cloud credential and never mutates provider infrastructure.

The reconciler:

- derives Ready and joining capacity from live VM rows and labeled Kubernetes
  Nodes so concurrent passes do not overprovision;
- registers a VM attempt before the first provider mutation;
- adopts an existing provider resource after interruption;
- supplies the agent startup configuration and waits for its matching Node to
  become Ready;
- replaces a failed VM to restore fixed capacity;
- deletes the obsolete Kubernetes Node after its provider VM is confirmed gone
  so system and workload Pods can be rescheduled immediately;
- keeps up to two CoreDNS replicas Ready on distinct capacity Nodes, and
  treats a shortfall as convergence still in progress rather than a cluster
  failure;
- conditionally sets `removal_requested_at` before cordoning, draining, or
  provider termination;
- retains a blocked drain for retry instead of force-deleting non-evictable
  work during ordinary reconciliation; and
- sets `ended_at` only after the provider confirms that the VM is gone.

Each agent registers with deterministic cluster and unique VM-attempt labels.
The reconciler associates the provider VM with its Node through those labels
and observes readiness, cordoning, workload eviction, and drain completion from
Kubernetes. Node names, UIDs, join state, Pod state, and drain progress are not
mirrored into the database.

The API coalesces reconciliation per cluster in memory. VM-row compare-and-set
operations remain the durable concurrency fence; no cluster-wide database lease
or persisted desired count is introduced.

Failed-VM replacement belongs to RFC 0015 because fixed capacity means
maintaining the configured count. It is not demand autoscaling. RFC 0016 changes
only how `desiredVmCount` is calculated within the stored bounds. RFC 0016
applies only to the raw-VM capacity implementation, not an attached cluster or
a future managed-service capacity type.

### Durable RFC 0015 lifecycle

Creation proceeds as follows:

1. Authenticate the cluster command and validate the API capability, compute
   credential, placement, VM type, private-peer network capability, and equal
   non-zero capacity bounds.
2. Transactionally insert the `Creating` cluster intent and its
   `cluster_capacity` record.
3. Ask the managed control-plane provisioner to ensure the control plane.
4. Verify its controller identity and persist the encrypted common runtime
   state and connection revision.
5. Reconcile cluster VMs to the fixed desired count.
6. Mark `Ready` only when the Kubernetes API is healthy, every expected VM has
   a matching labeled Ready Node, and the required CoreDNS replicas are Ready
   on distinct capacity Nodes. Capacity that joins late holds the cluster in
   its current state for the next reconciliation to retry; it never makes a
   `Creating` cluster `Failed` or unseats a `Ready` one.

After an API restart, reconciliation resumes from the cluster row, capacity
configuration, provisioner identity, opaque runtime state, and VM ledger. A
capacity shortfall is recomputed from the ledger and Kubernetes observations
rather than stored. An unreachable Kubernetes API invokes `ensure`, which
restarts or adopts the control-plane instance. Missing or corrupt durable
control-plane state makes the cluster `Failed`; Anycloud does not silently
replace its Kubernetes identity.

Deletion proceeds as follows:

1. Enter `Deleting` in one conditional write that succeeds only when no active
   or cleanup-pending workload references the cluster. The condition rejects
   deletion while the cluster is referenced; the `Deleting` state closes new
   submissions.
2. Claim each live cluster VM for removal, then cordon and drain it when the
   Kubernetes API is reachable.
3. Terminate every cluster-owned cloud VM and finalize its ledger row. Once no
   workload references remain, an unreachable Kubernetes API cannot leave
   billing VMs running indefinitely; drain failure is recorded and
   infrastructure teardown continues.
4. Delete the managed control-plane instance and its durable recovery and
   runtime state.
5. Enter `Deleted` while retaining the cluster row, capacity intent, and VM
   history.

Each step is idempotent and retryable. `cluster delete` reports the durable
operation rather than claiming success before reconciliation confirms teardown.
The capacity record and raw-VM controller intent are checked again immediately
before infrastructure mutation; generic registry cleanup alone never
authorizes destruction.

A future detach for a cluster without a capacity record follows the same
reference-safety rule and closes new submissions, but stops after removing
Anycloud-owned Kubernetes resources and registration state. It cannot invoke
the RFC 0015 control-plane or capacity teardown paths.

### Runtime selection and hard cutover

The rollout preserves current behavior until cluster selection is ready:

1. RFC 0014's shipped static resolver remains while cluster persistence and
   creation are added.
2. Cluster-targeted submissions persist `cluster_id` before Kubernetes
   mutation.
3. The production resolver changes to:

   ```text
   StoredWorkload.cluster_id
     -> authorized active cluster row
     -> require kind = kubernetes
     -> decrypt and verify opaque runtime state plus controller identity
     -> revision-keyed KubernetesRuntimeBundle
   ```

4. Process-default Kubernetes admission and runtime fallback are removed.

Every workload-scoped Job and Serve path already enters the RFC 0014
resolver. The cluster-aware implementation therefore covers deployment,
polling, cleanup, status, logs, exec, termination, Serve update, and Job
resubmission without direct route changes. Direct-cloud VM paths never load a
Kubernetes connection.

Neither runtime construction nor workload operations inspect
`cluster_capacity` or cluster-owned VM rows. All Kubernetes acquisition paths
therefore reuse the same Job and Serve runtime. Acquisition-specific capability
validation happens before a cluster becomes Ready and target-aware admission
happens when a workload selects it.

Target selection does not replace workload admission. Admission resolves the
request's storage credentials and regions, validates bucket names against the
storage provider, and checks that the selected workload runtime can implement
the requested storage behavior. A cluster target bypasses only VM compute
gateway validation. Checks that depend on a particular cluster, such as future
workload identity, CSI, namespace, or RBAC policies, belong to that cluster
kind's target-aware admission. Every applicable check completes before the
workload is persisted or Kubernetes is mutated.

This is a hard cutover. A Kubernetes workload with `cluster_id = NULL` is
unsupported after the cutover and is not backfilled, rebound, or resubmitted
through a compatibility path. `CloudType.Kubernetes` remains provider metadata,
but `cluster_id` and the stored cluster kind are the runtime source of truth.

The immutable cluster kind is the scheduler dispatch key. RFC 0015 implements
only `kubernetes`; an unsupported kind fails admission. This generic identity
does not create speculative Slurm interfaces or behavior.

## Required acceptance contracts

### Registry and runtime boundaries

Unit and boundary tests must prove:

- a cluster record and Kubernetes runtime connection do not require a
  `cluster_capacity` row;
- only a managed lifecycle controller reads the capacity table, and only RFC
  0015's raw-VM controller creates cluster-owned VM rows;
- the runtime resolver selects exclusively through the workload's stored
  cluster ID and connection revision;
- cluster-targeted submissions retain workload and storage admission without
  constructing a VM compute gateway, including submit-time rejection of
  missing or incapable bucket credentials and invalid bucket names;
- Job and Serve runtime code has no dependency on capacity configuration;
- changing connection revision replaces the cached runtime bundle;
- mismatched controller identity fails closed; and
- infrastructure teardown requires a matching capacity record and
  controller-specific durable intent; absence fails closed.

Cloud-boundary tests must additionally prove:

- gateways receive only an opaque `CloudResourceScope` and generic network
  intent, with no cluster or Kubernetes lifecycle dependency;
- AWS, Azure, and GCP translate peer ingress into scope-local membership rather
  than public CIDR ingress;
- preparation and adoption return the same logical network after interruption;
- one scope cannot satisfy another scope's peer rule;
- network teardown starts only after every scope VM is confirmed ended; and
- a gateway without peer-network support fails admission before mutation.

These contracts open the future acquisition seam without exposing an attach
command or accepting an unsupported external cluster record through production
routes.

### Managed control-plane contract

The host-provisioner contract must prove:

- two isolated control planes on one API host;
- unique access, data, credentials, and controller identities;
- two remote-VM analogues joining one intended cluster, a third joining another,
  and none registering with the wrong control plane;
- cross-node Pod, Service, DNS, logs, and exec traffic inside one cluster while
  the two clusters' capacity networks remain isolated;
- abrupt Anycloud API process replacement without control-plane restart or
  identity change;
- hosted API host replacement through durable recovery;
- stable join-endpoint recovery for already joined VMs;
- the stable join endpoint remaining the advertised API address after
  discovery; and
- ownership-safe independent deletion without API Docker-socket access.

Production qualification first runs this contract with the control plane and
capacity in separate infrastructure locations. It additionally records
control-path latency, behavior during loss and restoration of connectivity,
and recovery after both control-plane-host and capacity-VM replacement. The
concrete provider pairing is tracked separately, not as an RFC
invariant.

### API-driven Kubernetes contract

`yarn test:local-k8s-e2e` has two complementary layers. The first runs the
constrained production control-plane host-recovery proof against the real
Docker Engine and pinned k3s image. It joins a real external k3s agent, captures
encrypted recovery state, destroys the control plane and live host root,
restores through a fresh supervisor, and proves stable identity, endpoint, and
agent reconnection.

The second is RFC 0017's constrained, API-driven two-cluster
`managedKubernetes('kubernetes')` contract. Kubernetes is the product target;
Docker-backed k3s agents are only the local fixture's private capacity
implementation. The fixture starts the real API as a replaceable child with a
real database and no process-default kubeconfig, creates both clusters through
`anycloud cluster create` with non-zero equal bounds, and exercises the shared
Job and Serve stages for submission, status, logs, exec, update, resubmission,
termination, and cleanup.
With workloads live, it hard-crashes and replaces the Anycloud API process over
the same endpoint and durable state without restarting either Kubernetes
control plane or recreating workloads. It then proves independent cluster
deletion. It also proves through the real API that an unsupported Kubernetes
bucket request is rejected before a workload is created. Scoped-token minting
and wrapper execution remain in the always-run unit contracts so this local
test requires no live cloud storage credentials.

During RFC 0017's staged migration, the API-driven layer remains an exact
RFC-owned integration test. RFC 0017's managed-Kubernetes stage atomically
moves it into the constrained fixture, reuses the shared Job and Serve stages,
and removes the temporary exception.

Cross-cluster assertions must fail if any operation accidentally uses a global
client. One cluster has at least two capacity agents so the contract can force
a workload data path across agents and repeat it after agent replacement. The
private local substrate injects an implementation of the existing
`CloudCompute` boundary whose create and terminate operations add and remove
Docker-backed k3s agents. The isolated test database therefore holds
cluster-owned `vms` rows that stand in for real cloud-VM attempts, and the
contract asserts their ownership, join readiness, drain, and termination
against a live Kubernetes API. The supervisor-owned control-plane instance
stays out of the ledger. This test implementation is not a production provider.
Contracts receive typed capacity and Kubernetes facts, not raw database,
Kubernetes, Docker, or process clients.

Every API-driven qualification must use the default production cluster domain,
controller, reconciler, runtime resolver, and configured supervisor client. A
fixture may inject the capacity `CloudCompute`, cluster profile data, and
outcome-neutral observations or fault operations; it may not construct a
parallel cluster lifecycle. Local and real-cloud compositions use the same
contract-private qualification transport so changing substrate facts cannot
change Job, Serve, or cluster sequencing.

A separate capacity contract with a fake `CloudCompute` covers what the live
local substrate cannot reach: VM intent-before-mutation, adoption after
interruption, failed-VM
replacement, concurrent reconciliation, restart recovery, quota/spend/cost
integration, and retained history. It drives the capacity reconciler with
desired counts below, equal to, and above observed capacity, including zero,
even though RFC 0015's public API accepts only equal bounds of at least one.

The contract replaces the former managed-cluster and direct-provider scripts.
RFC 0017's implementation port also deletes
`test/integration/local-kubernetes.spec.ts`; no second standalone bootstrap,
process, wait, assertion, or cleanup path remains.

## Delivery

RFC 0014 is a completed prerequisite. RFC 0015 was delivered in five focused
stages:

1. An earlier change added the generic
   cluster registry and connection schema, optional capacity schema, workload
   association, and generalized VM ownership.
2. A later change added the managed
   raw-VM Kubernetes lifecycle, cloud-resource scopes, private-peer networking,
   desired-count capacity reconciliation, and cluster commands.
3. A later change added cluster-kind
   dispatch, Job and Serve runtime resolution, and API-driven multi-cluster
   acceptance while removing the process-default path.
4. A later change added the
   provider-neutral production control-plane supervisor transport, stable
   endpoint, durable snapshots, and API-host replacement lifecycle; a
   follow-up change promoted the
   constrained local qualification substrate.
5. A final change added the
   separated control-plane/capacity production qualification. The Azure and GCP
   runs passed; the
   GCP run included an IP-family correction.

The fifth stage reuses the constrained
`managedKubernetes('kubernetes')` contract through a private real-cloud fixture
composition. Its operator-dispatched **Managed Kubernetes Qualification**
workflow owns credentials, image publication, evidence retention, and provider
cleanup; `yarn test:cloud-k8s-e2e` is its stable repository entry point.

Registry and runtime reads remain independent of the optional capacity record.
Only the raw-VM lifecycle and capacity implementation may assume that record
exists. The fourth and fifth stages did not add control-plane placement to the
generic cluster schema.

Anycloud-managed k3s is implemented first because it validates the complete
cluster lifecycle and provides the tightest API-driven integration loop.
Capacity-less runtime tests preserve the external-attachment boundary.
Attachment may ship independently if production control-plane hosting takes
longer to qualify.

RFC 0016 validates the delivered capacity contract, but its production
autoscaling policy is not implemented in this RFC. A later attachment or
managed-service RFC adds a lifecycle controller and acceptance contract without
changing the registry or workload-routing PRs.

## Required invariants

Each invariant recorded its enforcement layer per
[RFC 0025](./0025-enforcement-ledgers.md). The ledger is historical: the
mechanisms it names were deleted with independent Clusters, so
`yarn check:rfc-ledgers` no longer validates this section.

1. A cluster's durable identity and runtime connection do not imply how its
   infrastructure was acquired.
   _Enforcement: review — the registry stores no acquisition marker for the
   runtime to branch on, but nothing rejects a future
   acquisition-conditional path._
2. A workload's stored cluster identity controls every later scheduler
   operation, with no process-default fallback.
   _Enforcement: lint:no-restricted-syntax — a ClusterState
   comparison outside the configured deciding modules is rejected, so workload
   gating cannot fork from the resolver in
   `src/api/services/cluster-workload-target.ts`; the process-default path was
   removed earlier, and the rule landed in a later change._
3. Every Kubernetes acquisition path reuses the same Job and Serve runtimes.
   _Enforcement: review — Job and Serve resolve through the single runtime
   resolver keyed by the stored workload, but nothing rejects a
   new acquisition path composing its own runtime._
4. Connection identity is verified, and connection revisions fence stale
   runtime bundles and writers.
   _Enforcement: runtime — the supervisor refuses mutation on identity
   mismatch, recovery verifies the datastore identity, and runtime bundles are
   keyed by cluster id and connection revision in
   `src/api/services/kubernetes/runtime-resolver.ts`; landed across two
   earlier changes._
5. Infrastructure destruction requires a matching `cluster_capacity` record and
   controller-specific durable intent; absence permits detach only.
   _Enforcement: runtime — reconciliation returns before any provider or
   control-plane mutation when no capacity record exists, and each VM removal
   first claims durable intent; landed earlier._
6. Only RFC 0015's raw-VM capacity controller may own VM-ledger rows.
   _Enforcement: review — cluster-owned VM-ledger writes live in the capacity
   repository, but nothing rejects a new writer outside it._
7. In production, only real cloud-VM provisioning attempts enter `vms`;
   control-plane instances, managed-service nodes, external Nodes, and
   Kubernetes resources do not.
   _Enforcement: review — control-plane instances take no ledger rows by
   construction, but only convention keeps a future path from inserting
   one._
8. Every VM row has exactly one workload or cluster owner.
   _Enforcement: runtime — the `vms` CHECK constraint requires exactly one of
   `workload_id` and `cluster_id` (migration 0087 used `deployment_id`, renamed
   by migration 0105); landed earlier._
9. Cluster provisioning intent is durable before local or provider mutation.
   _Enforcement: runtime — `beginVmAttempt` persists the attempt row before
   the gateway provisions; landed earlier._
10. VM removal intent is durable before cordon, drain, or provider mutation, and
    `ended_at` is written only after provider teardown is confirmed.
    _Enforcement: runtime — removal claims `removal_requested_at` before
    cordon, drain, or termination, and the row is ended only after the provider
    reports the VM terminated; landed earlier, with ordering corrected in a
    later change._
11. Kubernetes labels and observations associate Nodes with VMs; Node, Pod, join,
    and drain state are not mirrored into the database.
    _Enforcement: review — the schema stores no Node, Pod, join, or drain
    state, but nothing rejects adding a mirror column._
12. Raw-VM cluster capacity reuses the existing cloud gateways and does not
    introduce a second production compute-provider abstraction.
    _Enforcement: review — capacity provisioning calls the existing gateways
    through their resource-scoped capability, but nothing rejects a
    parallel compute abstraction._
13. Gateways receive only an opaque cloud-resource scope and generic network
    intent; they do not receive or import cluster or Kubernetes lifecycle types.
    _Enforcement: graph:cloud-resource-boundary — gateway sources cannot
    import cluster or Kubernetes lifecycle modules on the dependency graph;
    landed earlier, ported to the graph in a later change._
14. One raw-VM cluster has one compute credential, provider, region, and
    resource scope. Multi-cloud Anycloud placement uses multiple
    clusters rather than cross-cloud VMs in one cluster.
    _Enforcement: runtime — `cluster_capacity` is one row per cluster with
    single credential, region, and VM-type columns, and the resource scope
    derives from the cluster id; landed across two earlier changes, peer
    network removed per RFC 0033._
15. Capacity VMs expose no public Kubernetes or SSH ingress.
    _Enforcement: runtime — capacity VMs are provisioned with an empty public
    ingress and no peer rules (RFC 0033), and
    `src/api/services/firewall-plan.ts` compiles the deny and IP-family rules
    once for every gateway to transcribe; landed earlier, split by IP family
    in a later change, then compiled further still._
16. Fixed Anycloud-owned capacity is restored after ordinary VM failure.
    _Enforcement: test — `test/unit/services/managed-kubernetes-cluster.spec.ts`
    converges failed-VM replacement back to the fixed count; landed earlier,
    with DNS continuity added in a later change._
17. Normal Anycloud-owned removal drains a Node before terminating its VM and
    deletes the Node object only after the provider confirms the VM is gone.
    _Enforcement: type — `endVm` requires a `NodeDetached` proof whose only
    producers are Node deletion, a no-Node observation, and the recorded-error
    force witness in `src/api/services/cluster-node-detachment.ts`; ordering
    landed across two earlier changes, the proof in a later one._
18. No legacy `cluster_id = NULL` Kubernetes compatibility path is added.
    _Enforcement: runtime — the Kubernetes runtime resolver refuses a
    workload without a stored cluster id; landed earlier, and the
    process-default fallback was removed in a later change._
19. Kubernetes and k3s connection, credential, and recovery details remain
    internal and are not exposed by the cluster API.
    _Enforcement: review — the cluster API contract exposes state and capacity
    only, but nothing rejects adding a connection-detail field._
20. Raw-VM `cluster_capacity` stores `min_vm_count` and `max_vm_count` separately;
    RFC 0015 requires them to be equal and at least one, and both exclude the
    control plane regardless of its placement.
    _Enforcement: runtime — the API contract rejects unequal or zero counts and
    the controller re-checks before provisioning, with both counts stored
    separately under a schema CHECK; landed across two earlier changes._
21. Capacity convergence accepts an ephemeral desired count and never requires a
    persisted `target_vm_count`.
    _Enforcement: review — convergence derives its desired count from the
    capacity record and live rows each pass, but nothing rejects
    reintroducing a persisted target._
22. One RFC 0015-created cluster has one Kubernetes control plane; sharing an API
    host does not merge cluster identity.
    _Enforcement: runtime — the supervisor keys every control plane, port, and
    recovery path by cluster id, and identity is the per-cluster server-CA
    fingerprint; landed earlier._
23. The API never receives an unrestricted Docker socket to manage control
    planes.
    _Enforcement: runtime — the API reaches control planes only over the
    supervisor's injected Unix socket, and the Docker engine client lives in
    the supervisor composition root; landed in the same change._
24. Control-plane state and stable VM join reachability survive a hosted API
    host replacement before the RFC 0015 acquisition path is considered
    supported.
    _Enforcement: test —
    `test/unit/services/managed-cluster-host-replacement.spec.ts` and the
    `yarn test:local-k8s-e2e` recovery leg replace the host and require
    identity, endpoint, and agent reconnection; landed across two earlier
    changes. Live Lambda/Azure and Lambda/GCP qualification completed
    separately._

On 2026-08-26 that is **2 of 24 verified wired, 14 cited, and 8 resting on
review**: invariants 1, 3, 6, 7, 11, 12, 19, and 21.

## Alternatives considered

### Put VM placement and bounds on every cluster

Rejected. Compute credentials, region, VM type, and bounds describe one
capacity implementation, not a scheduler target. Embedding them in `clusters`
would force attached and provider-managed clusters to store null or fabricated
values and would encourage runtime code to depend on infrastructure ownership.

### Give attachment a separate workload runtime

Rejected. Once a Kubernetes identity and connection are registered, Job and
Serve behavior should not depend on who created the control plane. A separate
attached-cluster runtime would duplicate polling, logs, exec, update,
termination, cleanup, and resubmission behavior and recreate the routing
problem RFC 0014 solved.

### Implement external attachment in RFC 0015

Deferred. Attachment needs explicit credential bootstrap, connection rotation,
capability discovery, namespace and RBAC ownership, detach cleanup, and private
endpoint behavior. Leaving its persistence and runtime path open is necessary;
shipping an underspecified attachment contract is not.

### One separate control-plane VM per cluster

This gives each raw-VM cluster an independent host and straightforward network
identity, but adds another cloud machine lifecycle, fixed cost, credential
placement, and failure-recovery path to every cluster. RFC 0015 first qualifies
the already-required Anycloud API host while keeping placement behind the
managed-control-plane contract. A dedicated host alongside capacity remains
the fallback if separated placement fails its correctness or operational gates.

### One shared Kubernetes control plane with pools

Sharing one control plane creates one physical Kubernetes cluster, not multiple
clusters. Different capacity groups would need a pool model, labels, taints,
quotas, and a shared failure and upgrade boundary. Pools may be useful later,
but they do not satisfy independent cluster identity.

### Give the API the Docker socket

Rejected. It restores host-root-equivalent access deliberately removed from the
hosted API and makes a generic container API part of the production security
boundary. A constrained host provisioner exposes only managed-control-plane
operations.

### Add a separate cluster-node ledger

Rejected. It duplicates provisioning, adoption, credentials, cost, and cleanup
semantics. Real VMs Anycloud creates use the existing `vms` ledger with an
explicit owner. Machines Anycloud does not create do not belong in either
ledger.

### Add scheduler-specific cluster foreign keys

Rejected. `k8_cluster_id` followed by a future `slurm_cluster_id` would spread
scheduler choices through workload and VM ownership. A generic `cluster_id`
references a cluster with an immutable kind while each kind keeps its own
implementation.

### Add a separate cluster compute provider

Rejected. Raw-VM cluster capacity uses the same cloud gateways, provider
identities, adoption, quota, spend, and termination semantics as other cloud
VMs. Only orchestration and startup configuration differ.

### Let Kubernetes create raw cloud VMs

Rejected for the RFC 0015 capacity implementation. Anycloud owns cross-cloud
credentials, placement, provider failure handling, cost, and the VM ledger.
Kubernetes supplies scheduling state; Anycloud performs machine mutation. A
future provider-managed Kubernetes service is a different lifecycle controller
and does not cause its opaque Nodes to enter the VM ledger.

### Keep the process-default cluster

Rejected. It cannot represent durable ownership or isolate multiple clusters,
and it makes behavior depend on which environment happens to start the API.

## Risks and caveats

- The registry is intentionally broader than its first acquisition
  implementation. The acceptance boundaries prevent speculative attachment
  code while ensuring raw-VM assumptions do not leak into the runtime.
- The first production qualification couples RFC 0015-created Kubernetes
  availability to the API host while separating that host from capacity.
  Stable join reachability, cross-location latency and partition behavior,
  durable recovery, and host-replacement proofs are feature gates, not later
  hardening.
- One API host carries multiple RFC 0015 control planes. Resource limits, port
  allocation, upgrade ordering, and noisy-neighbor behavior require explicit
  bounds.
- The first control plane is not highly available. Recovery preserves identity
  but may have downtime and a documented recovery point.
- Generalizing the workload-oriented `vms` primary key and ownership queries
  is a material migration. Existing workload behavior and accounting need
  regression coverage.
- The first raw-VM capacity implementation is on-demand and requires a
  private-peer network adapter. AWS, Azure, and GCP use the same generic
  contract; other gateways fail admission until they implement it.
- A future attached cluster may expose different scheduler capabilities,
  policies, networking, and storage. The shared connection contract does not
  pretend those admission questions are already solved.
- The hard cutover deliberately provides no routing or resubmission path for
  process-default Kubernetes rows.

## Deferred work and non-goals

RFC 0015 does not deliver:

- external `cluster attach` or `cluster detach` commands;
- EKS, GKE, AKS, or another provider-managed Kubernetes lifecycle;
- the direct-versus-connector access contract for private clusters;
- Slurm or another cluster kind;
- node pools or heterogeneous raw-VM configurations;
- cross-provider or cross-region VMs inside one Kubernetes cluster;
- an overlay-network capacity mode;
- demand-based autoscaling, minimum lifetimes, or scaling metrics (RFC 0016);
- multiple or highly available control-plane instances for the RFC 0015
  acquisition path;
- user-authored Kubernetes resources;
- public kubeconfig or raw Kubernetes administration;
- cross-cluster workload balancing or Serve routing; or
- compatibility for Kubernetes workloads without `cluster_id`.

It also does not add Kubernetes CPU or memory translation, cluster-native
storage through workload identity or CSI, per-cluster storage capability
advertisement, GCP or Azure scoped bucket-token minting, live cloud bucket-sync
credentials in the local contract, long-running bucket-token refresh, or
per-workload output prefixes. Those storage mechanisms may extend
target-aware admission without changing cluster identity or runtime routing.

The first three items are deferred acquisition paths, not rejected
architectural directions. They must enter through the common cluster registry
and Kubernetes connection boundary described here.

## Implementation outcome and follow-ups

The 2026-09-09 GPU incident exposed a gap in the earlier qualification: Node
readiness and GPU resource translation had been tested separately, without a
real CUDA Job on managed capacity. Those checks did not prove device-plugin
installation or runtime selection. The MACE profile now extends the shared
managed-Kubernetes acceptance contract with actual inference, occupied GPU
capacity, plugin recovery without VM churn, and inference on replacement
capacity. Host and capacity placement remain inputs to the same reusable
qualification workflow as CPU execution. The full shared contract and tracked
teardown must pass. [RELEASE.md](../RELEASE.md)
defines candidate identity, receipt validation, and release gating; RFC 0029
records the Deployment acceptance scenarios. This preserves the accepted topology
decision.

The local hosting spike selected the recovery payload and showed that no
generic recovery-reference column is needed. The production foundation now
implements the stable raw-TLS hostname and port path and places encrypted
snapshots in the hosted-API checkpoint tree. A follow-up qualification then
proved the separated topology on real infrastructure: Lambda-hosted control planes with
both Azure and GCP capacity survived hosted-API replacement without changing
controller identity, recovered joined agents, replaced capacity, and cleaned up
all owned resources.

A separate tracked item retains the
additional explicit control-path partition exercise and accepted latency, RPO,
and RTO evidence. That work strengthens the operational qualification but does
not block the accepted initial topology. Each newly enabled compute gateway
still needs live acceptance for private peer traffic, isolation, adoption, and
teardown; those are provider acceptance tests rather than new hosting
architecture decisions.

Future attachment and provider-managed lifecycle RFCs must separately resolve
credential bootstrap and rotation, capability admission, externally owned
cleanup boundaries, private endpoint access, and their acceptance substrates.

## Decision

Accepted on 2026-08-23 after the five delivery stages and the Lambda/Azure and
Lambda/GCP qualification completed. Anycloud-managed Kubernetes uses a
durable cluster placement resource, one isolated control plane per cluster, the
existing VM ledger for Anycloud-owned capacity, and the same Job and Service
runtimes regardless of acquisition path. The accepted initial production
topology permits the control plane to run with a hosted API separately from
capacity while preserving cluster identity through host replacement.

Retired on 2026-09-25 by owner decision C: independent Clusters
and their per-Cluster control planes left the product without a cutover tool;
node pools on the installation's one cluster are the only placement.
