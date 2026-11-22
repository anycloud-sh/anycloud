# RFC 0030: Kubernetes Deployment autoscaling

<span id="rfc-0030-anycloud-deployment-autoscaling"></span>

> Status: Superseded — node pools, Kubernetes Deployments and node pool
> Services were removed (migrations 0172 and 0173); VM Jobs and VM Services
> replace them.
> Date: 2026-08-31
> Author: Luis Fernando De Pombo
> Depends on: RFC 0029's promoted O19 Deployment candidate
> Managed-cluster completion dependency: RFC 0016 Node autoscaling

## Summary

Add an Anycloud policy that converts demand for an RFC 0029 Deployment
into a desired replica count, scaling from its durable backlog and occupied
Job slots. The policy extends the reconciler and drain behavior established by RFC 0029.
Today, a Deployment has a fixed `--replicas N` that the owner sets;
this RFC would vary it from demand. This RFC applies only to Deployments that consume finite
Jobs. Cluster-backed Service autoscaling, request observation, and activation
belong exclusively to
[RFC 0032](./0032-kubernetes-ingress-deployments.md).

The durable backlog means the Anycloud-owned Job state in
RFC 0029 O19. A Supabase or other application-owned queue is not silently an
input to this policy. It requires a separately specified external-demand
adapter; RFC 0029 provides no manual replica setter for its owner to call, and
a subscriber inside a zero-replica Deployment cannot activate itself.

This RFC owns workload replica policy only. It never creates or terminates
cloud VMs. It can operate against fixed or externally managed capacity without
RFC 0016, but the Anycloud-managed elastic outcome is incomplete until RFC
0016 turns its Pending Pods into managed Cluster Nodes. Without that layer,
additional replicas may remain Pending indefinitely.

RFC 0030 extends rather than supersedes RFC 0029. O19 is promoted there, but
this RFC remains conditional on that Deployment primitive being implemented
and accepted.

## Context / problem

RFC 0029 deliberately fixes every Deployment at one replica:

```text
fixed target 1
  -> Deployment reconciler
    -> actual Pod
```

That is enough to keep one customer model process warm, but it cannot add
capacity when demand exceeds that replica's slots or remove idle capacity.

The required extension is a policy above the reconciler, not another workload
or machine primitive:

```text
demand policy -> desired replicas
Deployment reconciler -> actual Pods
Kubernetes scheduler -> Pod placement
RFC 0016 -> managed Nodes, required for managed elasticity
```

These layers must not amplify one another. A Pod that is still starting or
Pending already belongs to the current desired replica count. Physical
capacity delay is not evidence that more workload replicas are required.

### Shared slot model

RFC 0029 gives a jobs Deployment a configured
`max_concurrent_jobs_per_replica`:

```text
The session customer:       N Job slots per model replica
ordinary work:  1 Job slot per replica
```

The autoscaler can therefore reason about generic finite work without knowing
what a customer session or model is. Under RFC 0029 O19, queued, starting, and
running Jobs are Anycloud facts; ready Pods and their container identities are
Kubernetes facts observed by Anycloud. Available capacity is derived from
those facts rather than reported through a separate Slot or heartbeat contract.
The session customer's model/hardware matrix remains application configuration.

The autoscaler reaches targeted Jobs through
`workloads.deployment_id` and reads Cluster placement from
`deployments.cluster_id` on the persistent-application table. RFC 0029 removed
the direct Cluster target from the former shared Deployment table, now
`workloads`; scaling queries must use the Job's target Deployment for placement.

## Proposal

### One scaling owner

A Deployment has exactly one scaling mode:

```text
Fixed

Autoscaling(
  min_replicas,
  max_replicas,
  policy,
)
```

`Fixed` is RFC 0029 behavior and always means one replica. `Autoscaling` stores
bounds and the jobs policy. There is no manual replica-count mode or
separate scale operation. Switching between one fixed replica and automatic
scaling is an explicit revisioned update.

The durable record stores scaling mode, bounds, policy, and policy revision.
The calculated desired count is ephemeral controller output, not a second
piece of user intent. The Deployment reconciler accepts it as an input:

```text
desired = calculate(policy, observations)
reconcileDeployment(deployment, desired)
```

Kubernetes retains the last applied replica target if the Anycloud API is
temporarily unavailable. After restart, Anycloud reloads policy and live state,
rebuilds its observation window, and calculates again. A last-applied value may
be reported for diagnostics but is not authoritative intent.

Only the active policy revision may call reconciliation. A stale pass cannot
overwrite a return to one fixed replica or a newer autoscaling configuration.
Policy evaluations are coalesced per Deployment; they do not invoke provider
gateways.

### Illustrative object and CLI interface

The exact names are not accepted, but the interface preserves RFC 0029's thin,
flat `Client` style:

```python
client.set_deployment_autoscaling(
    "model-a",
    min_replicas=1,
    max_replicas=20,
    target_slot_utilization=0.75,
)

client.disable_deployment_autoscaling("model-a")
```

A jobs Deployment takes the single flat `target_slot_utilization` argument.
The SDK need not expose `Autoscaling` or `JobSlots` policy object graphs.

Equivalent CLI operations use flags rather than YAML:

```bash
anycloud deployment autoscale model-a \
  --min-replicas 1 \
  --max-replicas 20 \
  --target-slot-utilization 0.75

anycloud deployment autoscale disable model-a
```

Disabling autoscaling returns the Deployment to RFC 0029's fixed target of one.

The Job-slot policy is the only Deployment policy. RFC 0032 defines a separate
Service policy rather than another Deployment mode. Admission requires:

```text
0 <= min_replicas <= max_replicas
max_replicas > 0
0 < target_slot_utilization <= 1
```

`min_replicas` is both the scale-down floor and the explicit warm-capacity
choice. Setting it to zero accepts the full cold-start path.

### Jobs Deployment calculation

For one policy observation:

```text
Q = targeted Jobs queued and eligible to run
A = current running executions consuming application capacity
C = configured max concurrent Jobs per replica
U = target slot utilization
T = max(1, floor(C * U))

work_replicas = ceil((Q + A) / T)
desired = clamp(work_replicas, min_replicas, max_replicas)
```

Each Job contributes exactly once: queued before next-Job selection, then
active in `running`. `T` allows deliberate headroom. With `C=1`, `T` is one and
the same calculation supports ordinary sequential Jobs.

RFC 0029 execution-start events associate active Jobs with runtime identities. The
runtime requests work only when it has local capacity, and the API atomically
enforces at most `C` active Jobs for that runtime. Ready runtimes and their
current executions therefore determine unused capacity without another
capacity-reporting protocol. Starting and Pending Pods already belong to the
absolute desired target and do not cause another increase on the next pass.

The policy can calculate a lower desired count while active Jobs protect some
replicas from removal. Actual count converges after those Jobs finish.

At `min_replicas=0`, the first queued Job produces a desired count of at least
one. The Job remains durable through Pod scheduling, image delivery, model
loading, and in-workload runtime readiness. A timeout can end the Job; demand
never bypasses its existing lifecycle.

Demand beyond `max_replicas * C` remains queued and publishes a bounded
saturation reason. This autoscaler does not change queue admission, Job retry,
or the API-wide workload setup limit.

### Scale-up and cold-start behavior

Scale-up reacts immediately after a coherent observation; it does not wait for
the scale-down window. The calculated target is absolute, so repeated passes
while replicas or Nodes are starting return the same value for the same demand.

The cold path remains visible:

```text
demand
  -> desired replicas
  -> Pods created
  -> [Pods Pending]
  -> [RFC 0016 provisions and joins Nodes]
  -> image delivered
  -> application/model ready
  -> next Job selected
```

`min_replicas`, a utilization target below one, and Cluster warm capacity are
the available latency/cost controls. Autoscaling cannot make a zero-capacity
GPU model respond with warm-path latency.

### Scale-down and draining

Downward decisions require a stabilization window so a brief drop does not
churn loaded models. A restart clears accumulated scale-down evidence and
starts the window again; this can cost money but cannot remove replicas based
on stale observations.

The autoscaler only changes the desired count. RFC 0029's reconciler selects
and drains replicas:

- a jobs replica stops receiving new Jobs and waits for starting and running
  work; and
- a protected replica may keep actual count above desired until it is safe to
  remove.

Ordinary autoscaling never cancels a Job to reach the target. Explicit
termination and deletion retain their separate
timeout policies.

Scale-down during a rollout is deferred until the rollout controller has
enough ready capacity to distinguish revision replacement from falling demand.
The autoscaler owns total desired replicas; the rollout controller owns how
that total is distributed across revisions.

### Workload and Node loops

Deployment autoscaling and managed-Node autoscaling consume different signals:

```text
Job backlog
  -> RFC 0030 desired Deployment replicas
    -> RFC 0029 Pods
      -> Kubernetes scheduling
        -> RFC 0016 observes compatible Pending Pods
          -> managed Cluster VMs
```

RFC 0030 never treats Pending Pods, absent Nodes, cloud provisioning latency,
or GPU utilization as additional workload demand. RFC 0016 never treats Job
backlog as direct machine demand. This preserves one owner for each desired
count.

Quota, spend, credential, and `max_vm_count` constraints remain authoritative
in the Cluster layer. If they block Nodes, Deployment Pods stay Pending and
Jobs may time out. RFC 0030 reports the physical-capacity block but does not
exceed `max_replicas` or bypass Cluster limits.

On an attached Cluster, RFC 0030 may change Deployment replicas but never
assumes authority over Nodes. Pods can remain Pending until the external
capacity owner acts.

### Controller status and observability

Status separates intent, calculation, workload state, and physical state:

- scaling mode, bounds, policy revision, and metric target;
- calculated and last-applied desired replicas;
- current, ready, starting, Pending, draining, and protected replicas;
- queued, starting, and running Jobs plus derived unused capacity;
- stabilization state and the reason for the last decision; and
- saturation, missing metrics, Cluster capacity blocks, and other bounded
  reasons.

Autoscaling decisions should be evented for debugging, but event history is
not desired state. Application-store contents, dispatch tokens, request
contents, and unsafe Kubernetes details never enter scaling logs or metrics.

### Restart and failure behavior

After a controller restart:

1. Reload the current scaling policy revision.
2. Read durable targeted Job state.
3. Observe existing Pods and the last applied Kubernetes replica target.
4. Reset scale-down stabilization.
5. Calculate an absolute desired count and invoke the existing reconciler.

Job backlog makes jobs scaling restart-safe without persisting a calculated
target.

A failed Pod is replaced to maintain the current desired count by RFC 0029's
reconciler. Failure replacement is repair, not evidence to increase desired
replicas. A stale autoscaler pass is rejected when its policy revision no
longer matches.

## Decision requirements

**R1 — Keep the one-replica fallback.** Autoscaling is optional. Disabling it
returns to exactly one replica, and switching ownership between fixed and
automatic modes is explicit.

**R2 — Keep one owner.** No HPA, application loop, or second Anycloud policy may
write replica count while RFC 0030 owns it.

**R3 — Use Anycloud-owned demand.** Jobs Deployments scale from Anycloud-owned
finite-Job state and slot configuration. An external application queue is not
interchangeable with that source.

**R4 — Support one and many slots.** The same calculation works when one
replica accepts one ordinary Job or several customer Jobs.

**R5 — Scale from zero honestly.** An Anycloud queued Job can activate a
zero-replica jobs Deployment. An external queue requires an observer outside
the scaled Deployment.

**R6 — Do not amplify cold capacity.** Starting or Pending Pods count toward the
absolute desired target and cannot recursively create more replicas.

**R7 — Keep machine policy separate and qualify its composition.** Only RFC
0016 or an external Cluster owner changes Nodes; this RFC never invokes a cloud
provider. The Anycloud-managed elastic outcome cannot be marked complete until
an end-to-end qualification proves composition with RFC 0016.

**R8 — Preserve work on scale-down.** Starting/running Jobs protect replicas
through RFC 0029 drain behavior.

**R9 — Recover conservatively.** Restart rebuilds policy input, rejects stale
policy revisions, and never treats unread demand as zero demand.

**R10 — Bound cost and overload.** Desired replicas stay within durable bounds;
excess work queues with a bounded saturation reason.

**R11 — Expose latency choices.** Warm floors, utilization headroom, cold-start
stages, and physical-capacity blocks are visible.

**R12 — Keep application policy opaque.** Anycloud consumes generic Jobs,
and slots without learning customer sessions, models, or its
concurrency matrix.

**R13 — Work on attached Clusters.** Workload scaling cannot depend on Anycloud
owning the Cluster's Nodes.

**R14 — Remain object-first.** Python objects, JSON, and CLI flags configure the
policy without mandatory YAML or Kubernetes autoscaler manifests.

## Acceptance scenarios

| ID  | Scenario                     | Required result                                                                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Multi-slot sessions          | Backlog and occupied slots raise model replicas without Anycloud interpreting sessions.                                                                 |
| S2  | One-slot ordinary work       | `C=1` uses the same policy and never runs two Jobs in one replica.                                                                                      |
| S3  | Jobs scale-to-zero           | A durable targeted Job raises replicas from zero and waits through the complete cold path.                                                              |
| S4  | Saturated maximum            | Desired remains at maximum while additional Jobs queue with a bounded saturation reason.                                                                |
| S5  | Pending Pods                 | Repeated observations do not increase workload replicas merely because existing desired Pods lack Nodes.                                                |
| S6  | Protected scale-down         | Starting/running Jobs keep actual count above target until drain is safe.                                                                               |
| S7  | Controller restart           | Job demand is recomputed and the stabilization window restarts.                                                                                         |
| S8  | Policy ownership change      | A stale automatic pass cannot overwrite a return to one fixed replica or a newer policy revision.                                                       |
| S9  | Attached Cluster             | Replicas change through the same API while Pending Pods remain the external capacity owner's responsibility.                                            |
| S10 | Rollout under changing load  | Autoscaling owns total count and rollout owns revision distribution without deleting protected old replicas.                                            |
| S11 | Workload/Node loop isolation | Job demand creates Pods once; only scheduler-visible Pod demand can subsequently create managed Cluster VMs.                                            |
| S12 | Managed elasticity           | Job demand raises replicas, a resulting Pending Pod causes RFC 0016 to provision a VM, the VM joins as a Node, the Pod becomes ready, and the Job runs. |

## Delivery

1. Add one-replica-versus-autoscaling policy types, admission, persistence, and
   status without changing the RFC 0029 reconciler.
2. Implement the pure jobs desired-count calculator with deterministic tests
   for bounds, scale-to-zero, headroom, and saturation.
3. Add the coalesced policy runner with policy-revision fencing and restart-safe
   jobs observations.
4. Connect jobs scaling to the Anycloud-owned Deployment backlog, runtime
   identities, and execution-start events; validate one-slot and multi-slot behavior
   before enabling scale-down.
5. Add drain-aware downward reconciliation and rollout interaction.
6. Validate fixed-capacity and attached-Cluster behavior independently. Then
   qualify the complete managed path: Job demand raises replicas, a Pod becomes
   Pending, RFC 0016 provisions a VM, the VM joins as a Node, the Pod becomes
   ready, and the Job runs. Managed-cluster elasticity is not complete until
   that contract passes.

If delivery requires changing Job selection or execution, Deployment identity, Pod
reconciliation, drain, Cluster VM ownership, or provider mutation, the lower
RFC seam is incomplete and should be corrected there rather than duplicated in
the autoscaler.

## Alternatives considered

### Kubernetes HPA or KEDA owns replicas

These are strong Kubernetes-native implementations. HPA does not directly own
Anycloud's durable Job backlog, and queue-driven scale-to-zero generally needs
an external metric and activation component such as KEDA. Splitting replica
ownership across policy owners would split status, fencing, and drain
semantics. They remain possible backend components only if one Anycloud policy
contract and one writer remain authoritative.

### Application/Supabase pushes desired replicas

This is RFC 0029 O9 rather than the O19 input to this policy. The Supabase
reservation table is the durable queue and Realtime is only notification;
those reservations are not targeted Jobs. Adding a customer-only manual replica
setter would recreate a second public scaling interface that RFCs 0029 and 0030
deliberately exclude, so this alternative is rejected.

O9 remains usable with one fixed replica. Scaling from its demand would require
a separately specified adapter that converts an external signal into RFC
0030's policy input while Anycloud remains the sole replica-count owner. It is
not implied by Supabase access, and a subscriber inside a zero-replica
Deployment still cannot activate itself.

### Scale Nodes directly from Job demand

Rejected because application demand does not prove how Pods fit on Nodes. It
would duplicate Kubernetes scheduling, bypass RFC 0016's VM ledger and limits,
and amplify one unit of demand through two capacity paths.

### Scale from CPU or GPU utilization

Deferred as a policy extension. Utilization cannot activate from zero and can
be weakly correlated with concurrent sessions or queue delay. Jobs already
have a direct logical-demand signal.

### Persist every calculated desired count as user intent

Rejected. Durable policy and work state are sufficient to recalculate, while
Kubernetes retains the last applied target during an API outage. Persisting the
calculation as another intent source creates ambiguity when policy changes.

## Risks and caveats

- Queue depth is reactive. A zero or low warm floor still pays Pod scheduling,
  image delivery, model loading, and possibly VM provisioning latency.
- Application-owned queues cannot drive this controller without an explicit
  external-demand contract; granting Anycloud direct access to application
  databases is not such a contract.
- A utilization target below one buys latency headroom with idle cost.
- Long Job durations and uneven placement can leave many protected replicas
  above the calculated target because running work is not migrated.
- At-least-once Job delivery and autoscaling can briefly count a retry while a
  stale attempt is still doing external work; RFC 0029 fencing remains
  essential.
- Absolute targets prevent recursive growth from Pending Pods but do not stop
  oscillation from genuinely volatile demand; stabilization defaults need live
  tuning.
- `max_replicas` bounds workload count, not spend. Physical cost also depends
  on Pod resources, packing, Cluster warm capacity, and RFC 0016 bounds.

## Non-goals

- changing Cluster or VM ownership;
- replacing RFC 0016 managed-Node autoscaling;
- cluster-backed Service autoscaling, request observation, and activation
  (owned by RFC 0032);
- multi-Cluster placement, spillover, or failover;
- predictive, scheduled, or cost-optimized scaling;
- per-Job slot weights or heterogeneous replicas in one Deployment;
- application-aware customer model selection;
- autoscaling current dedicated VM Jobs; or
- requiring users to install HPA, KEDA, or a Kubernetes custom resource.

## Open questions

1. What target slot-utilization default provides useful headroom without making
   idle GPU cost surprising?
2. What scale-down stabilization and minimum replica lifetime should be the
   initial defaults?
3. Should users be allowed to update bounds while keeping the same policy
   revision, or should every policy change fence in-flight calculations?
4. How much autoscaling decision history belongs in durable events versus
   metrics only?
5. How should multiple-replica current-execution queries remain efficient while
   RFC 0029 keeps observed Pod/container identity in execution-start-event metadata
   rather than adding a public Replica or Slot resource?

## Tracking

No implementation is authorized or tracked by this RFC yet.

## Change log

- **2026-09-01:** Renumbered after RFC 0028 landed on `main` and clarified that
  jobs scaling consumes RFC 0029 O19's Anycloud-owned backlog; Supabase-owned
  demand requires a separately specified external-demand adapter.
- **2026-09-01:** Made RFC 0029's fixed mode exactly one replica, removed manual
  replica counts and scale operations, and left variable counts solely to the
  autoscaling policy.
- **2026-09-01:** Made RFC 0016 an explicit completion dependency for the
  Anycloud-managed elastic outcome and required full Job-to-VM qualification.
- **2026-09-01:** Aligned jobs scaling with RFC 0029's Job-ID and
  execution-start-event model: demand uses Anycloud Job state, Pod/container facts
  stay Kubernetes-owned, and capacity is derived without claim, heartbeat,
  finalization, or slot-reporting state.
- **2026-09-01:** Aligned Cluster lookup with promoted RFC 0029 O19: targeted
  Jobs join through `cluster_deployment_id`, while the obsolete direct
  `deployments.cluster_id` relationship is removed before implementation.
- **2026-09-01:** Kept autoscaling consistent with RFC 0029's thin SDK by using
  flat `Client` methods and mode-specific scalar targets instead of nested
  resource and policy objects.
- **2026-09-01:** Narrowed to jobs autoscaling per the RFC 0029 jobs-only
  split: retitled the RFC and moved the ingress policy, observation adapter,
  and activator to RFC 0032.
- **2026-09-03:** Renamed the persistent workload to Worker, updated its
  proposed interfaces, and clarified that RFC 0032 independently owns
  cluster-backed Service autoscaling rather than a Worker ingress policy.

## Decision

_(Filled when accepted or rejected: the call, date, and rationale.)_
