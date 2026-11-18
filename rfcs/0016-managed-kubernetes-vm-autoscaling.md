# RFC 0016: Managed Kubernetes VM autoscaling

> Status: Superseded by [RFC 0048](./0048-node-pool-scaling.md)
> Date: 2026-08-17
> Author: Codex draft
> Updated: 2026-08-18 after removing a cluster-wide durable claim, reducing
> scale-down memory to one restart-safe idle window, and limiting the policy to
> RFC 0015's raw-VM `cluster_capacity` path; 2026-08-19 to bind live local k3s
> qualification to RFC 0017's constrained Kubernetes composition.

## Summary

Allow a Kubernetes cluster with RFC 0015 VM capacity to vary its
cloud-VM count between the already-persisted `min_vm_count` and
`max_vm_count`. An Anycloud policy observes Kubernetes scheduling demand,
computes an ephemeral desired VM count, and passes it to RFC 0015's durable
capacity reconciler.

This RFC adds policy, signals, and scale-down safety. It does not add another VM
provisioner, ledger, controller authority, persisted `target_vm_count`, or any
new durable state.

## Context / problem

RFC 0015 deliberately ships fixed capacity while establishing this seam:

```text
capacity policy -> desiredVmCount
capacity reconciler -> actual and in-flight VMs converge to desiredVmCount
```

Its raw-VM creation path requires equal, non-zero minimum and maximum counts,
but its `cluster_capacity` record stores both and its reconciler accepts any
desired count, including zero. Failed-VM replacement is already fixed-capacity
repair: it restores the requested count and must work whether autoscaling is
enabled or not.

Kubernetes can identify Pods that do not fit, schedule Pods after a VM joins,
and expose which VMs are empty or still carry work. It does not own Anycloud's
cloud credentials, placement policy, VM ledger, quota checks, cost tracking, or
provider recovery. For clusters enrolled in this capacity controller,
Anycloud must therefore remain the only component that creates and terminates
cluster VMs. Attached and provider-managed cluster capacity remains outside
this policy.

## Proposal

### Relax only the capacity policy

Keep the RFC 0015 command shape:

```text
anycloud cluster create <name> \
  --credentials <name> \
  --region <region> \
  --vm-type <type> \
  --min-vms <count> \
  --max-vms <count>
```

RFC 0016 removes the application-level equality check and non-zero minimum in
one admission change, and accepts:

```text
0 <= min_vm_count <= max_vm_count
```

The counts continue to include every cloud VM providing workload capacity
and exclude the colocated Kubernetes control plane. `min_vm_count = 0` is
therefore scale-to-zero for billable cluster VMs while the control plane remains
available to observe new demand.

Autoscaling never changes placement topology. Every VM selected by a policy
pass uses RFC 0015's immutable compute credential, provider, region,
cloud-resource scope, and private peer network. Multi-cloud Anycloud placement
uses multiple independently scaled clusters; this policy does not add another
provider, region, pool, or overlay network to one cluster.

The autoscaler computes:

```text
desiredVmCount = clamp(policy(observation), min_vm_count, max_vm_count)
await reconcileClusterCapacity(cluster, capacity, desiredVmCount)
```

`desiredVmCount` is a calculation result, not durable intent. It is recomputed
after every API restart. RFC 0015 VM attempts and removal timestamps remain the
durable record of provider work already in progress; Kubernetes supplies live
join and drain observations.

### Demand and ownership

Only Anycloud-owned Pods in the selected cluster contribute demand. The policy
ignores system Pods and resources not carrying Anycloud ownership labels.

Scale-up demand comes from Anycloud Pods that Kubernetes has determined are
unschedulable for capacity reasons and that are compatible with the cluster's
single configured VM type. The policy uses declared Pod resource requests and
the VM type's allocatable CPU, memory, and GPU capacity. Application requests,
connection rejection, queue length, or raw utilization do not directly create
VMs in this RFC.

Workload replica decisions remain separate:

- a Job runtime creates the Pods required by that Job;
- a Serve controller determines its desired Pod replicas; and
- the cluster autoscaler supplies VMs when those Pods cannot be scheduled.

The autoscaler never edits Job parallelism or Kubernetes Deployment replica counts.

### Scale-up

One policy pass considers:

- Ready cluster VMs;
- VMs being provisioned or joined;
- VMs whose `removal_requested_at` is set;
- compatible unschedulable Anycloud Pods;
- the configured maximum;
- the cluster's immutable resource scope and private peer network;
- credential validity, quota, spend controls, and existing admission blocks;
  and
- the allocatable resources of the homogeneous VM type.

Provisioning and joining VMs count toward the expected capacity so repeated or
concurrent observations cannot launch duplicates. A new scale-up decision calls
the existing RFC 0015 reconciler; the policy never invokes a cloud gateway
itself.

Demand beyond `max_vm_count`, quota, or spend limits leaves Pods Pending and
publishes a bounded Anycloud capacity reason. Public status does not expose the
raw Pod or scheduler condition. The policy does not bypass limits or create a
second retry loop.

### Scale-down

Scale-down is conservative:

1. Never choose enough VMs to go below `min_vm_count`.
2. Prefer VMs with no Anycloud workload Pods.
3. Require the scale-down condition to remain true for an idle window.
4. Claim a removal durably before cordoning.
5. Cordon and drain through the RFC 0015 VM lifecycle primitive.
6. Terminate the cloud VM only after drain succeeds.

Pods protected by disruption policy, local data, or another non-evictable
condition defer ordinary scale-down. The autoscaler does not force eviction to
meet a desired count. Explicit cluster deletion retains RFC 0015's separate
eventual-infrastructure-teardown rule.

A VM is not eligible for ordinary scale-down until it has exceeded a minimum
lifetime derived from its durable `created_at` and its scale-down condition has
remained continuously true for one in-memory idle window. Any observed Anycloud
workload activity resets that window. An API restart also resets it, delaying
scale-down and costing money but never terminating a VM that should have been
kept.

### Failure replacement is not autoscaling

A failed VM stops contributing available capacity. RFC 0015's capacity
reconciler replaces it whenever the current desired count still requires the
capacity. Replacement:

- does not wait for new Pending Pods;
- is not blocked by the ordinary scale-down minimum lifetime;
- still obeys credential, quota, spend, and provider safety checks; and
- preserves the failed VM's ledger row.

The autoscaler may independently compute a lower desired count after demand
falls. It must account for replacement or termination already in progress
rather than racing it.

### Controller and restart behavior

The autoscaling policy runs from the existing Anycloud reconciliation authority,
not from an in-cluster controller. Policy evaluation is coalesced per cluster
within the API process. All provider mutation enters RFC 0015's capacity
reconciler, where VM-attempt and removal compare-and-set operations are the
durable fences. RFC 0016 adds no database lease or cluster-wide durable claim.

After an API restart:

1. Reload the cluster bounds.
2. Observe Kubernetes demand and the durable VM ledger.
3. Restart each scale-down idle window from zero.
4. Recompute the desired count.
5. Invoke the unchanged capacity reconciler.

No previous desired count must be recovered for correctness.

### Delivery

RFC 0016 should be a narrow follow-up to RFC 0015:

1. Add Kubernetes capacity observations and pure desired-count calculation.
2. Add the ledger-derived minimum lifetime, in-memory idle window, and periodic
   policy runner.
3. Relax the equal-bounds admission check and add autoscaling acceptance tests.

If implementation requires changing VM ownership, provider mutation, join,
drain, termination, runtime resolution, or cluster selection, RFC 0015's seam is
incomplete and should be corrected rather than duplicated here.

## Required invariants and tests

- The policy cannot return a value outside the stored bounds.
- Only Anycloud-owned, compatible, unschedulable Pods contribute scale-up
  demand.
- Ready plus in-flight capacity prevents duplicate scale-up.
- A failed VM is repaired independently of demand-based scaling.
- Scale-down never crosses the minimum and never force-evicts ordinary work.
- The colocated control plane is neither counted nor selected for removal.
- Scale-to-zero removes all cloud capacity VMs while preserving the control
  plane and cluster identity.
- Quota, spend, and credential blocks remain authoritative.
- Concurrent policy passes coalesce, and provider work remains fenced by RFC
  0015's VM-row compare-and-set operations.
- API restart during provisioning, joining, idle observation, draining, and
  termination converges without a persisted target count or idle-window state.
- Fixed clusters with equal bounds retain RFC 0015 behavior when the policy
  runner is enabled.

Unit tests cover pure desired-count decisions at both bounds, incompatible and
non-Anycloud Pods, in-flight capacity, minimum lifetime, the idle window, and
blocked drains. The capacity contract with a fake `CloudCompute` covers
provider mutation and restart.
When this RFC is implemented, RFC 0017's API-driven
`managedKubernetes('kubernetes')` composition adds Pending-Pod scale-up signals,
scale-down to zero, and isolation between two clusters, scaling ledger-backed
k3d agent capacity between the stored bounds. Kubernetes remains the contract
target; Docker-backed k3s capacity is a private fixture substrate and does not become a
provider or public contract variant.

## Alternatives considered

### Persist `target_vm_count`

Rejected. The autoscaler owns the desired count and can recompute it from the
stored bounds, live observations, and the VM ledger. Persisting the target
would introduce a second piece of intent that can become stale while individual
VM operations already provide the required crash-recovery fence.

### Kubernetes Cluster Autoscaler or Karpenter creates VMs

Rejected for this implementation. Those systems would need Anycloud's
cross-cloud credentials and would bypass its VM ledger, provider recovery,
quota, spend, and cost contracts. Kubernetes remains the demand sensor and
scheduler; Anycloud remains the machine authority.

### Scale directly from application traffic

Rejected. Traffic may determine Serve replicas in a separate workload policy,
but VM capacity should respond to scheduler-visible resource demand. Combining
both loops would duplicate Kubernetes placement logic and couple cluster
capacity to one serving protocol.

### Add pools with independent bounds

Deferred. RFC 0015 intentionally has one homogeneous VM configuration per
physical cluster. Pools require placement and scale-down choices that are not
needed to validate the first autoscaling policy.

## Risks & caveats

- Scheduler observations can oscillate while Pods or VMs transition; the
  minimum lifetime and idle window are correctness requirements, not cosmetic
  tuning.
- Declared resource requests may poorly represent real workload use. This RFC
  scales scheduler capacity, not measured application performance.
- Homogeneous capacity may waste resources when Pending Pods have incompatible
  shapes. Pools are the eventual answer, not hidden per-Pod VM selection.
- Scale-to-zero increases cold-start latency by the full cloud-VM provisioning
  and Kubernetes join time.
- A single colocated control plane remains an availability limit inherited from
  RFC 0015.

## Non-goals

- workload replica autoscaling;
- request routing or cross-cluster balancing;
- heterogeneous VM pools;
- attached-cluster machine management;
- control-plane autoscaling or high availability;
- predictive or scheduled scaling; or
- replacing Anycloud's VM ledger with an in-cluster machine controller.

## Open questions

- Which Pending-Pod conditions are treated as capacity shortages rather than
  configuration failures?
- What scale-up batching, minimum-lifetime, and idle-window defaults give
  acceptable latency without oscillation?

These policy choices do not change RFC 0015's ownership or reconciliation
boundaries.

## Decision

_(Filled when accepted or rejected: the call, date, and link to the relevant
owner decision.)_
