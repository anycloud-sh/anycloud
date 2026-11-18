# RFC 0048: Node pool scaling

> Status: Superseded — node pools, Kubernetes Deployments and node pool
> Services were removed (migrations 0171 and 0172); VM Jobs and VM Services
> replace them.
> Date: 2026-10-15
> Author: Claude draft, for Luis Fernando De Pombo

## Summary

Node pools are fixed-size today: `node-pool create` requires `--min-vms` to
equal `--max-vms`. The API contract enforces it
(`src/shared/api-contract/node-pools-schemas.ts`), and the controller also
refuses unequal bounds ("fixed capacity requires equal non-zero VM bounds",
`node-pool-controller.ts`). The owner ruled out a fixed-size on-demand pool for
pool Jobs ("fixed size non-spot pool is a nogo", 10-01), and RFC 0044's M4
requires pools that scale between `--min-vms` ≥ 1 and a required `--max-vms`.

This RFC makes a pool buy Nodes when its Pods pend and remove Nodes that have
stayed idle. Pending pool Pods are the only demand signal. FIT's `nodesNeeded`
turns them into a count of Nodes, and the existing `reconcileCapacity` path
receives that count as `desiredVmCount`. Scale-in removes only idle Nodes,
after a restart-safe idle window. The pool's other removal paths (a stopped
VM, a Node from an older join script, a Node that never joined) keep their
owner, and § One owner per VM keeps scale-in off the VMs they act on. No column
or table is added.

It supersedes [RFC 0016](./0016-managed-kubernetes-vm-autoscaling.md), which
scaled RFC 0015's `cluster_capacity` path. Migration `0122_drop_clusters.sql`
dropped that path. The ideas from 0016 that still hold are kept, and each one
says where it came from. The design input is RFC 0044's
[§ RFC 0048 and capacity](./0044-one-pool-runtime.md#rfc-0048-and-capacity), together with RA, FIT, SPEND, and RT9's spot
pools. The work is tracked below.

## Context

- **Built, with no caller yet:**
  - `nodesNeeded` in `pool-fit.ts` (FIT) bin-packs request vectors onto
    one Node shape, after DaemonSet and system reservations. A request that no
    empty Node holds adds no Node.
  - `PoolReconciler.demand()` (`pool-reconciler.ts`) returns a namespace's
    Pods with `PodScheduled` reason `Unschedulable`, read from the watch cache.
  - `reconcileCapacity(nodePool, runtime, desiredVmCount)` launches and
    removes VMs, fenced by `beginVmAttempt`'s SQL count and by
    `claimVmRemoval`.
  - `cordonNodePoolNode`.
- **Still fixed-size:**
  - The caller always passes `nodePool.minVmCount`.
  - Scale-in uses `selectScaleDownVms`, which orders VMs by readiness and ID
    and ignores what runs on them.
  - The pool is `ready` only while `live.length === desiredVmCount`.
  - A spend-cap block throws `NodePoolActionableError`, and `reconcile` then
    marks the pool failed.
- **Upstream of the demand:**
  - RA sizes each Deployment's replicas. For managed Deployments that
    is the Jobs held plus the queued Jobs that would pass the claim's checks.
    The count is capped at what `--max-vms` Nodes hold, and the in-flight cap
    (about 200 per cluster) also applies.
  - RT8 puts pool Jobs on managed Deployments. Queued
    pool Jobs therefore reach the pool only as Pending replicas.
  - SPEND prices replicas.
- **Spot (RT9):** a spot pool VM is deleted on eviction, on every spot cloud,
  and the pool's release path ends its row.
- **Removal paths landed after this RFC's 10-16 review.** Each one claims
  the VM with `claimVmRemoval` and then runs `reconcileClaimedRemoval`, which
  cordons the Node, terminates the VM and, once the provider confirms the
  release, runs `finalizeReleasedVm`:
  - **A stopped VM is replaced at once** (SPOT; RFC 0044 decision 33).
    `reconcileCapacity` reads `observeStopped` for each unclaimed VM whose
    Node isn't Ready. A stopped VM is claimed through `removeVm`, with no
    join-replacement count and no 15 min grace, and the launch loop refills
    the pool in the same pass. The VM's Pods are deleted only in
    `finalizeReleasedVm`, so a restarted VM can never run a Job beside its
    retry (RFC 0044 invariant 18).
  - **The stop read is narrowing** (STOP-NARROW, open; RFC 0044 Q5
    option A). Pools read stopped VMs through their own `observeStoppedVm`,
    and VM spot Jobs keep `verifyVMPreemption`. On Azure the pool read is true
    only for stopped, stopping, deallocated or deallocating, so a rebooting
    or unknown-state Azure VM waits out the Node grace instead.
  - **Nodes from an older join script are replaced on upgrade.** The Node's `anycloud.sh/join-revision` label marks it `outdated`.
    `replaceOutdatedNode` runs after scale-down and before launches, and only
    while the pool is at its desired count, every live VM is Ready and no VM
    has removal requested. It closes the Node's Pods to pool Job claims,
    waits for the Jobs they hold, then claims and removes the VM. The launch
    loop buys its replacement in the same pass.
- **What launches.** A provider now supplies its join-script inputs: its
  host-only addresses and its external-IP command (BOOT). Scaling
  calls today's launch path, so it has no per-provider branch. VM-type
  candidates are ordered round-robin by each type's region rank, so
  after a capacity failure the next type is tried in the same region. A pool
  with several types therefore mixes them more often. Nebius is the next
  provider, as a compute-only Spot pool provider (RFC 0044 decision 33),
  and it stops evicted VMs rather than deleting them.
- **Bounds:** owner question Q9 was decided on 09-28: `--min-vms` and
  `--max-vms` both stay required. RFC 0044's decision 12 keeps `--min-vms` ≥ 1
  until scale-to-zero serving exists.

## Proposal

### Smallest useful release

A user creates `node-pool create --min-vms 1 --max-vms 8 [--spot]`. Queued pool
Jobs and Deployment replicas that don't fit buy Nodes, up to 8. Nodes with no
anycloud work are removed after about 10 min idle, down to 1. A spend cap stops
purchases without failing the pool.

Excluded: scale-to-zero (`--min-vms 0`), placement across pools, scaling on
requests in flight, changing the bounds after create, and predictive or
scheduled scaling.

### One seam, one signal

The seam is from RFC 0016: a policy computes a desired count, and one
reconciler converges the VMs to it. The policy now runs in the node-pool
controller's existing 30 s pass (`node-pool-reconciler.ts`). Inside
`reconcileCapacity`, it runs after the loss handling (released, stopped and
never-joined VMs) and the pass over claimed removals, and before scale-in,
`replaceOutdatedNode` and the launch loop. The caller passes the bounds
instead of `nodePool.minVmCount`. A Node is **usable** when it is
Ready, capability-ready (today's `nodeCapabilityReady`, which on a GPU pool
also requires that its GPUs are registered) and free of Kubernetes'
`node.kubernetes.io/not-ready` taint. Today's `NodePoolNodeObservation` has no
taint field, so P2 adds taint observation.

```text
pending   = demand(pool) — anycloud Pods that select this pool, Unschedulable
            in the pass-start Pod snapshot
lost      = VMs this pass's step 1 claimed as stopped, whose Node was busy
            in the pass-start Pod snapshot, ignoring Pods being deleted
inFlight  = this pool's VM rows with no removal claim whose Node isn't usable,
            or is usable and not busy in the pass-start Pod snapshot
idle      = usable, current Nodes that aren't busy (§ Scale-in) in the
            pass-start Pod snapshot and whose window has elapsed; none
            while nodesNeeded(shape, reserved, pending) + |lost| > 0
want      = live + max(0, nodesNeeded(shape, reserved, pending) + |lost| − inFlight) − |idle|
desiredVmCount = clamp(want, min_vm_count, max_vm_count)
```

where `live` is this pool's VM rows with no removal claim, so in-flight VMs
already count toward capacity. A Node is **current** when it isn't `outdated`,
that is, it joined with today's join script.

- **Demand is Pending Pods only** (RFC 0044 § RFC 0048 and capacity, from
  RFC 0016's "only Anycloud-owned, compatible, unschedulable Pods").
  - A Pod counts if it carries anycloud's labels and selects this pool's Node
    label. Today's `demand(clusterId, namespace)` returns every Unschedulable
    Pod in a namespace, so P2 adds this filter.
  - Queued Jobs never count directly. RA has already counted only the Jobs
    that would pass the claim's checks, so 50 queued Jobs under a budget for 3
    produce 3 replicas, and Jobs blocked by caps produce none.
  - `pool-objects.ts` renders every pool Pod, with no user affinity, so the
    only scheduling constraints are resources and the pool's selector and
    tolerations. A Service replica also selects the ingress entry's label,
    which no new Node carries, so it never counts.
  - The policy reads Pods from a snapshot of the watch cache taken with
    `nodeByVm` at the start of the pass, not from the live cache. Step 1
    force-deletes a released VM's Pods, and their recreated replicas can be
    Unschedulable in the live cache before step 3. Read live, a busy lost VM
    would count once in `lost` and again in `pending`. From the snapshot,
    its replicas count only from the next pass, where its successor's
    `inFlight` covers them. Subtracting lost VMs' replicas from a live read
    would need to trace each recreated Pod to its old Node, which nothing
    records.
  - `lost`'s busy check ignores Pods with a `deletionTimestamp`. Pool Pods
    tolerate `not-ready` and `unreachable` for Kubernetes' default 300 s, so
    a VM that step 1 claims later than that has Pods that Kubernetes already
    evicted. They stay Terminating and bound to the dead Node while their
    recreated replicas are Unschedulable in the same snapshot, so counting
    both would buy twice. The replicas count in `pending`, in that pass or
    the next.
- **In-flight VMs count toward capacity** (from RFC 0016). A VM offsets
  Pending demand until its Node is usable, not merely Ready. On a GPU pool,
  `nvidia.com/gpu` becomes allocatable only after the device plugin registers,
  and Kubernetes removes the not-ready taint only after Ready, so Pods stay
  Unschedulable for a while after a Node turns Ready. A usable Node that runs
  nothing still counts: binding trails the Node update, so the replica it was
  bought for can still be Unschedulable in the snapshot, and an empty Node
  of the shape holds any Pod that fits the shape. P3 keeps such a Node out
  of `idle` while Pending Pods are counted against it.
  Counting such a Node as in flight means repeated passes, or the pass after a
  restart, can't buy duplicates. `beginVmAttempt`'s count fence still prevents
  an overshoot between concurrent passes.
- **The Node shape.** For each resource, the shape is the smallest value
  among the catalog shapes of the pool's VM types. Every type in the list
  shares one GPU kind and count, so the GPU value is the same for all of them.
  A Node packed this way fits whichever type launches. `reserved` is read
  from a usable Node of the pool: its type's catalog value minus its
  allocatable, plus the requests of its DaemonSet Pods. The catalog's nominal
  memory exceeds the kubelet's capacity, so subtracting from the catalog
  value keeps a Node's room within its real allocatable.
  - Because `--min-vms` is at least 1, a ready pool always has a Node to read
    `reserved` from. Before the pool first becomes ready, the policy only
    reconciles to the minimum.
- **Too-large Pods.** A Pod that no empty Node of the shape holds adds no
  Node. The Deployment shows "fits no Node of pool P". Admission (RFC 0044
  PR 2) already refuses most such shapes.
- **No new trigger.** The 30 s pass is short next to VM boot and join, and a
  cold image pull alone took 56 s (RFC 0044 § Customers). A Pod-event trigger
  waits until measured scale-out latency shows the timer dominates.
- **Lost VMs leave `live` before the count.** On `main` the caller fixes
  `desiredVmCount` before the pass, so a stopped VM claimed in the pass is
  refilled at once whatever the demand. With the policy after the loss
  handling, a claimed VM is in neither `live` nor `inFlight`. At the floor,
  the clamp still replaces it in the same pass. Above the floor, a stopped VM
  that step 1 claims, whose Node was busy, counts as one Node of demand in
  that pass only, even if its release confirms within the pass, so its
  successor is bought in the same pass (question 4, § Spot loss).
- **Nothing durable is added to the database** (from RFC 0016's "Persist
  `target_vm_count`", rejected). Each pass recomputes `desiredVmCount` from
  the bounds, the VM ledger and the pass-start Pod snapshot. The only new durable state
  is scale-in's stamp on the Node (§ Scale-in, step 4).

### Scale-out

One pass may buy several Nodes. A burst of Jobs becomes, in one pass,
`nodesNeeded` VMs (capped by `--max-vms`), not one VM per pass. Launches keep
today's target ranking, catalog pricing (the spot rate on a spot pool) and
provisioning backoff.

**A cap block is soft** (RFC 0044 decision 22; P1):

- No VM is bought.
- The pool stays `ready` with "scale-out blocked by account cap". It is not
  marked failed, and it doesn't enter provisioning backoff.
- The reason is stored in `node_pools.last_error` under its own prefix.
  P1 extends `markReady` to keep that prefix, as it already keeps a
  VM-release error, and the next pass that isn't blocked clears it.
- Queued pool Jobs and Pending replicas show the same reason.
- RA reads that prefix and holds its step-up while it stands, so blocked
  capacity doesn't fill up with Pending replicas.
- Account burn counts this pool's VMs that are still being provisioned, so
  concurrent passes can't each overshoot a throttle by one VM.
- Budgets never remove Nodes, and the minimum's Nodes keep billing.

**Pool state:**

- A pool becomes `ready` once its minimum Nodes are Ready with their
  capabilities, and it stays `ready` while it scales.
- `node-pool status` shows ready, starting and draining counts, and the last
  scale-out or cap-block reason.
- Failures that need an operator (join-replacement cap, missing GPUs, an
  invalid credential) keep today's behavior.

### Scale-in

Scale-in removes only idle Nodes (RFC 0044 invariant 14 and its row PR 7,
which this work folds in):

1. **Busy Nodes.** A Node is busy if it runs any anycloud workload Pod or any
   Pod that still carries the anycloud finalizer. Workload Pods are replicas,
   managed or not (a replica finishing a final upload included), pool Service
   replicas and the ingress. DaemonSet and mirror Pods don't count. Busy has
   one definition over the watch cache's Pods bound to the Node
   (`spec.nodeName`), read from the pass-start Pod snapshot for `lost` and
   `idle` in the policy, and from the live cache for the idle window. `lost`
   alone also ignores Pods being deleted (§ Policy). Only the post-cordon
   re-check LISTs instead (question 2).
2. **The idle window** (from RFC 0016's "one restart-safe idle window").
   - A Node is a scale-in candidate once it has been idle for one continuous
     in-memory window, about 10 min (RFC 0044).
   - The window starts no earlier than when the controller first sees the
     Node usable.
   - Any busy Pod seen on the Node, whether a workload Pod or one carrying
     the anycloud finalizer, resets the window.
   - An API restart restarts every window. That delays scale-in and costs
     money, but it never removes a Node that should stay.
   - 0016's separate minimum VM lifetime is dropped. 0016 needed both
     guards against oscillation, because its window could start before a new
     VM took work. Here the window starts only once the Node is usable, and a
     Node bought for Pending Pods takes them within one pass. So a new Node
     is never removed sooner than one full window after it could first take
     work, which is the lifetime's purpose.
3. **Only current Nodes.** An `outdated` Node is never a scale-in
   candidate. `replaceOutdatedNode` owns it (§ One owner per VM), so it is
   replaced rather than scaled in, even when idle. The replacement then idles
   out after one window, which costs one extra boot per idle Node, once per
   join-script revision.
4. **Stamp, claim, cordon, re-check, then delete.** The claim-before-cordon
   order comes from RFC 0016, and the post-cordon re-check from RFC 0044
   § Scale-down. All steps run in the same pass.
   - Scale-in picks a time `T` and writes it to the Node's
     `anycloud.sh/scale-in` annotation. It then claims the VM through
     `claimVmRemoval`, which P3 lets take `T` as the claim time, only after
     the annotation write succeeds. A failed write skips the VM for this
     pass. The claim is scale-in's only if the returned
     `removal_requested_at` equals `T`.
     Passes of one pool never overlap (`node-pool-reconciler.ts`), and one
     API process owns the database (`ARCHITECTURE.md`; the API chart's
     `replicas: 1` with `strategy: Recreate`), so no other path can claim
     between scale-in's ledger read and its claim.
   - `cordonNodePoolNode` then cordons the Node, and the controller re-checks
     that it is idle.
   - If the Node is still idle, it is deleted through today's
     `reconcileClaimedRemoval`.
   - If it turned busy, the controller uncordons it, then clears the claim,
     then removes the annotation (all added in P3). A crash after any of
     these steps is safe. After the uncordon, the claim and its matching
     stamp remain, so step 5's re-check cordons the Node again and unclaims
     it. After the claim is cleared, the Node is unclaimed and uncordoned,
     and its stale stamp is ignored (step 5) until the next scale-in
     overwrites it. Any other order can leave a claim without its stamp, which
     step 5 removes without the re-check, or an unclaimed Node that stays
     cordoned.
5. **The re-check after a restart.** `removal_requested_at` doesn't say why a
   VM was claimed, so the pass over claimed VMs reads the stamp.
   - Every claimed VM first takes today's `confirmRelease()`. A released VM is
     finalized as now, even if its stale Node still looks Ready.
   - A VM that isn't released, whose Node is usable and whose stamp equals
     its `removal_requested_at`, gets the re-check, whether the Node is
     current or outdated. It is cordoned first if it isn't yet, and it is
     unclaimed if busy. A busy outdated Node then waits for
     `replaceOutdatedNode`, which waits for its Jobs before claiming it.
   - Every other claimed VM keeps today's direct removal, with no re-check.
     That covers a VM past the join cap, a Node that never joined, a NotReady
     or stopped Node, and an outdated Node that `replaceOutdatedNode` claimed.
     Each of those paths issued its terminate with its claim
     (`reconcileClaimedRemoval`), so a Node that recovered since is still
     deleted, never unclaimed. A stamp left by a restart before the claim
     never matches another path's claim time, so it is ignored.
     `reconcileDeletion` never re-checks, so deleting a pool can't stall on a
     busy Node.
   - An unclaim never undoes a deletion in progress. Scale-in terminates only
     a cordoned Node that it found idle, and a cordoned Node takes no new
     anycloud Pod, so a later re-check finds it idle again and only repeats
     the deletion.
6. **Fewer than asked is fine.** A pass removes at most `live − min` Nodes,
   and only idle ones, so a smaller desired count can leave more Nodes than it
   asks for until they go idle. Scale-in never evicts a Pod.

RA removes idle managed replicas first (Pending and not-ready ones before
ready ones, never one that holds a Job), so their Nodes become idle. A user
Deployment's minimum replicas keep their Nodes busy, which bounds how far
scale-in can go.

### One owner per VM

Once P3 lands, each pass of `reconcileCapacity` runs these steps in order.
Steps 1, 4 and 5 act only on unclaimed VMs, so none of them takes a VM that an
earlier step claimed. On `main`, step 1 reads the pass's first `listVms`, and
steps 2, 4 and 5 re-list the ledger first. Every step reads Node state from
the pass-start `nodeByVm` snapshot, and step 3 reads Pods from a snapshot
taken with it (§ One seam, one signal).

| Step | Path                                        | Acts on                                                                   | Ends in                                                                   |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | Loss handling (RT9, SPOT, join replacement) | unclaimed VMs whose Node isn't Ready: released, stopped or never joined   | claim, then `finalizeReleasedVm` or `reconcileClaimedRemoval`             |
| 2    | Claimed removals                            | every claimed VM                                                          | release confirmed, the re-check (§ Scale-in, step 5), or direct removal   |
| 3    | The policy (P2)                             | the ledger and the pass-start Pod snapshot, read only                     | `desiredVmCount`                                                          |
| 4    | Scale-in (P3)                               | unclaimed, usable, current Nodes that have been idle for the window       | stamp, claim, cordon, re-check, then delete or uncordon and unclaim       |
| 5    | `replaceOutdatedNode`                       | one outdated Node, only while no VM is claimed and every live VM is Ready | claim, then `reconcileClaimedRemoval`; the launch loop buys its successor |
| 6    | Launch loop                                 | the gap to `desiredVmCount`                                               | new VM attempts                                                           |

So two paths never act on one VM:

- **Scale-in and stop replacement.** Step 1 reads a stopped VM only when its
  Node isn't Ready, and step 4 takes only usable Nodes, so the two sets never
  overlap within one pass. If the provider stops a Node after step 1 read
  it, step 4 may still claim it. If the re-check finds it idle, it is deleted
  as scale-in. If it finds it busy, it is unclaimed, and the next pass's
  step 1 sees a stopped VM. Either way one path owns it at a time.
- **Scale-in and join-script replacement.** Step 4 skips outdated Nodes, and
  step 5 skips the whole pass while any VM is claimed, so it never starts
  while a scale-in removal is pending. After a restart, step 2 finds no
  scale-in stamp on a Node that `replaceOutdatedNode` claimed and removes it
  without the re-check. So it is never unclaimed while its termination runs,
  even though its user replicas still make it busy. A Node that scale-in
  claimed and an upgrade made outdated keeps its stamp, so it still gets the
  re-check.
- **Step 5 and scaling.** `replaceOutdatedNode` already skips while the pool
  is short of its desired count. While a pool scales out, or a launched VM is
  still joining, its outdated Nodes wait for a steady pass.

Every path except scale-in's re-check ends in deletion, so the unclaim is the
only step that gives a claim back. It is limited to scale-in's own claim, on
a usable Node whose VM isn't released, and it never reaches a Node whose
termination is in flight (§ Scale-in, step 5).

### Spot loss and failure replacement

RFC 0016 kept failure replacement separate from autoscaling. On a pool, that
applies in two cases:

- **Below the floor:** a VM lost below `--min-vms` is replaced whatever the
  demand. That is today's fixed-capacity repair, and for a stopped VM it is
  SPOT's same-pass replacement (RFC 0044 S21).
- **Above the floor:** an evicted spot Node takes its replicas with it,
  whether the provider deleted it (RT9) or stopped it (SPOT, Nebius). A
  stopped VM is deleted first, and its Pods are deleted only once its release
  is confirmed. Their Deployments then recreate them as Pending replicas.
  - Until then, a stopped VM whose Node was busy counts as one Node of
    demand (`lost`, question 4), only in the pass whose step 1 claims it,
    whether its release confirms in that pass or later. Its Pods aren't
    Pending in the pass-start Pod snapshot, even when step 1 confirms its
    release and deletes them, so `pending` doesn't count them in that pass,
    and its successor boots in that pass, as on `main`. Later passes don't count it
    again, however long the release takes. The successor's `inFlight`
    covers the demand while it joins, and once usable it is an empty Node
    that the Pods take when they pend, so nothing is bought twice. If the
    claiming pass buys nothing (a cap block, backoff or `--max-vms`), or the
    API restarts after the claim, the Pods buy through demand once the
    release is confirmed, as in question 4's option (a). A durable link from
    a lost VM to its successor would carry the count further, which § One
    seam rejects.
  - A VM the provider deleted (RT9) is finalized in step 1, so it is never
    `lost`. Its replicas pend at once and buy through demand, in that pass or
    the next.
  - A busy outdated Node that `replaceOutdatedNode` claims isn't `lost`
    either. Step 5 claims it after the policy ran, so the launch loop buys
    its successor from the gap it leaves in `live`.
  - A lost Node that nothing ran on isn't replaced.
  - This changes SPOT only for an idle stopped Node above the floor. On
    `main`, the pool is fixed-size, so its desired count always equals the
    floor and every stopped VM is refilled in the same pass. RFC 0044's S21
    gains "at the floor, or when the Node was busy" when P2 lands.

Replacement still passes credential, quota and spend checks, and the failed
VM's ledger row is kept, as before. A VM that never joined leaves `live` when
it is claimed, so its Pending Pods buy its replacement in the same pass, and
the join-replacement cap still bounds that loop.

### Bounds and surface

- Admission accepts `1 ≤ --min-vms ≤ --max-vms`, and both stay required (Q9).
  The controller's equal-bounds check becomes the same check.
- A pool with equal bounds is a fixed-size pool, and nothing else changes for
  it.
- `--min-vms` and `--max-vms` lose "(node pools are fixed-size)" from their
  help.
- `docs/` documents pool scaling, and the user-visible change gets a changelog
  entry in P3.

### Changes

These follow an earlier triage discussion.
P2 and P3 merge back to back, so scale-out never ships without scale-in.

| PR  | What                                                                                                                                                                 | Source       | Tests         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------- |
| P0  | This RFC, which supersedes RFC 0016; RFCs 0017, 0033 and 0044 repointed                                                                                              | doc only     | —             |
| P1  | Soft cap block (S7) and in-flight pool VMs in account burn; useful alone on fixed pools                                                                              | +50–80       | +120–180      |
| P2  | Pending demand → FIT → `desiredVmCount`, the shape and `reserved`, scale-out (S1, S2, S8); the policy after loss handling, `lost`                                    | +330–450     | +450–580      |
| P3  | Busy-aware idle scale-in (RFC 0044 PR 7), the scale-in stamp, unclaim and uncordon, current Nodes only, bounds, CLI, the scale-out reason in status, docs (S11, S12) | +230–330     | +370–500      |
| P4  | `e2e-pool-scaling-local`: S1–S8 and RFC 0044's S6 and S7 on local K3s                                                                                                | —            | +600–900      |
| Σ   |                                                                                                                                                                      | **+610–860** | **+1.5–2.2k** |

The reconciliation with SPOT, STOP-NARROW, and outdated-Node replacement adds
about +60–100 source lines to the 10-16 estimate. P2 gains +30–50: the policy
runs inside `reconcileCapacity` after the loss handling, SPOT's same-pass
refill becomes the floor's clamp, and `lost` keeps it above the floor for
busy Nodes (+10–20, question 4). P3 gains +30–50: the scale-in stamp and
its claim time, the stamp filter on the re-check, the current-Node filter on
candidates, and the uncordon guard.

P1 starts once STOP-NARROW merges, because both edit
`node-pool-controller.ts`. P2 and P3 change `reconcileCapacity`,
which every gateway uses, so their train needs one paid `e2e-cluster-cloud`
scale-out and scale-in run on each of AWS, GCP, Azure and Lambda. Nebius joins
once its gateway and accounts exist.

## Required invariants

1. `desiredVmCount` is never outside `[min_vm_count, max_vm_count]`, and
   admission refuses bounds other than `1 ≤ min ≤ max`.
   _Enforcement: review — P2 adds the clamp's unit tests at both bounds and P3
   the admission test; no mechanism exists before them._
2. Only anycloud-labeled Pods that select this pool, are `Unschedulable` and
   fit an empty Node of its shape create scale-out demand. Queued Jobs never
   create demand directly.
   _Enforcement: review — P2 adds demand tests for foreign, other-pool and
   too-large Pods._
3. A VM counts toward capacity until its Node is usable (Ready,
   capability-ready and free of the not-ready taint), so neither repeated
   passes nor a restart buys a duplicate VM for the same Pending Pods.
   _Enforcement: review — P2 adds a repeated-pass and restart test against a
   fake `CloudCompute`._
4. A spend-cap block buys nothing, keeps the pool `ready` with its reason,
   and leaves provisioning backoff unchanged.
   _Enforcement: review — P1 adds the controller test (S7)._
5. A VM that scale-in claimed, that isn't released and whose Node is usable,
   current or outdated, is deleted only after the post-cordon re-check in
   the same pass finds the Node idle, with no anycloud workload Pod and no
   Pod with the anycloud finalizer. Scale-in never goes below
   `min_vm_count`.
   _Enforcement: review — P3 adds tests for each Pod kind and a
   claim/schedule race test, the tests RFC 0044 invariant 14 names._
6. Scaling stores no target count and no idle-window state. A restart
   restarts every idle window, and `vms.removal_requested_at` stays the only
   scale-in fence in the database. The Node's scale-in stamp is the only
   other durable state, and it only decides between the re-check and direct
   removal after a restart.
   _Enforcement: review — P2 and P3 add no migration; P3 adds a restart test._
7. One path acts on a VM at a time. Scale-in claims only an unclaimed,
   usable, current Node, and stamps it first with its claim time. The
   post-cordon re-check is the only step that clears a claim, and only a
   claim whose time matches the Node's stamp, on a VM that isn't released and
   whose Node is usable. Every other claim ends in deletion, even if the Node
   recovers. Each write is ordered so that a crash after it is safe: the stamp
   is written before the claim, so no claim lacks its stamp; the unclaim
   uncordons, then clears the claim, then removes the stamp, so an
   interrupted unclaim is either re-checked again or leaves an uncordoned,
   unclaimed Node with a stale stamp that matches no later claim.
   _Enforcement: review — P3 adds tests in which scale-in and the stop path,
   and scale-in and `replaceOutdatedNode`, meet one VM, with and without a
   restart, in which a never-joined Node recovers after its claim, and in
   which the API stops after each step of the stamp, claim and unclaim (S6,
   S11, S12)._
8. A stopped VM is replaced in the same pass when the pool is at its floor
   or its Node was busy, as SPOT does today. Above the floor, an idle lost
   Node isn't replaced, and a busy one counts as one Node of demand only in
   the pass that claims it, so no lost VM is bought for twice, however long
   or short its release takes. The policy reads `pending` from the pass-start
   Pod snapshot, and `lost`'s busy check ignores Pods being deleted, so a
   lost VM's recreated replicas never count in the pass that counts it in
   `lost`, even when Kubernetes evicted its Pods before the claim. A restart
   after that pass, or a claiming pass that buys nothing, falls back to buying
   through demand.
   _Enforcement: review — P2 adds the policy-order test (S8), including a
   release that confirms in the claiming pass, with its recreated replicas
   already Unschedulable in the watch cache before the policy runs, one
   claimed after Kubernetes evicted its Pods, and one that outlasts the
   successor's boot and join._

**0 of 8 verified wired, 0 cited, and 8 resting on review**: invariants 1, 2,
3, 4, 5, 6, 7, and 8.

## Acceptance scenarios

The coverage cells become `test:0048/S<k>` tokens as P1–P4 land.

| ID  | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                 | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Coverage                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S1  | A 1-GPU pool with `--min-vms 1 --max-vms 4` and one Node; 12 `--gpus 1` pool Jobs are queued                                                                                                                                                                                                                                                                                                                                             | RA asks for 4 replicas; 3 pend; one pass buys 3 VMs; 4 Jobs run and 8 stay queued                                                                                                                                                                                                                                                                                                                                                                                                                                                   | test:0048/S1                                                                                       |
| S2  | S1's 3 VMs are still joining, or are Ready with their GPUs not yet registered, when further passes run and the API restarts                                                                                                                                                                                                                                                                                                              | no fourth VM is bought                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | test:0048/S2                                                                                       |
| S3  | S1's queue drains                                                                                                                                                                                                                                                                                                                                                                                                                        | RA scales the managed replicas to 0; about 10 min later 3 Nodes are removed and 1 stays                                                                                                                                                                                                                                                                                                                                                                                                                                             | test:0048/S3 — P3's unit tests; end to end in `e2e-pool-scaling-local`                             |
| S4  | Scale-in wants 3 Nodes gone; one runs a Job, one holds a finalizer Pod                                                                                                                                                                                                                                                                                                                                                                   | only the third is removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | test:0048/S4 — P3's unit tests; end to end in `e2e-pool-scaling-local`                             |
| S5  | A replica is scheduled onto a Node after the Node is chosen and before the cordon is seen                                                                                                                                                                                                                                                                                                                                                | the re-check finds it; the Node is uncordoned and its claim cleared; the replica's Job runs                                                                                                                                                                                                                                                                                                                                                                                                                                         | test:0048/S5                                                                                       |
| S6  | The API restarts 8 min into a Node's idle window; separately, it restarts after a scale-in claim and before the cordon, once on a plain restart and once on an upgrade that makes the Node outdated, after each step of an unclaim, with a claimed NotReady Node, with a claimed never-joined Node that turns Ready while its terminate runs, and with a claimed VM the provider already released whose Node still looks Ready           | the idle Node is removed no sooner than one full window after the restart; both scale-in claims are cordoned and re-checked before removal, and a busy outdated one is unclaimed and later taken by `replaceOutdatedNode`; an unclaim stopped after the uncordon is re-checked and unclaimed again, and one stopped after clearing the claim leaves the Node uncordoned and unclaimed, its stale stamp ignored; the NotReady and recovered Nodes are removed directly, never unclaimed; the released VM is finalized, not unclaimed | test:0048/S6                                                                                       |
| S7  | An account budget is exhausted while pool Jobs are queued on a full pool                                                                                                                                                                                                                                                                                                                                                                 | no VM is bought; the pool stays `ready` with "scale-out blocked by account cap"; backoff is unchanged; the Jobs and Pending replicas show the reason; RA holds its step-up                                                                                                                                                                                                                                                                                                                                                          | test:0048/S7 — P1's unit tests; end to end in `e2e-pool-scaling-local` (RFC 0044 S15)              |
| S8  | With the pool above its minimum, a spot Node running a Job is evicted, once deleted (RT9) and twice stopped (SPOT), with a release that is confirmed in the claiming pass, its recreated replica already Unschedulable in the watch cache before the policy runs, and one confirmed only after the successor is usable; once more stopped (SPOT) and claimed after Kubernetes evicted its Pods; separately, an idle spot Node is stopped | the stopped VM is deleted before its Pods are; its successor is bought in the claiming pass, when no empty usable Node can take its replica, and only one VM is bought; after RT9's deletion the replica pends and one VM is bought; after the eviction the Node isn't `lost`, and its replica buys one VM through `pending`; the Job's retry runs on the new VM; the idle stopped Node is deleted and not replaced                                                                                                                 | test:0048/S8 — through `deleteNodePoolNode`; RT9's deletion end to end in `e2e-pool-scaling-local` |
| S9  | A Pending replica requests more than an empty Node of the pool holds                                                                                                                                                                                                                                                                                                                                                                     | no VM is bought; the Deployment shows "fits no Node of pool P"                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | test:0048/S9                                                                                       |
| S10 | `node-pool create` with `--min-vms 0`, then `--min-vms 3 --max-vms 2`, then `--min-vms 2 --max-vms 2`                                                                                                                                                                                                                                                                                                                                    | the first two are refused; the third is a fixed-size pool that behaves as today                                                                                                                                                                                                                                                                                                                                                                                                                                                     | test:0048/S10                                                                                      |
| S11 | After an upgrade, a pool has one idle outdated Node and one busy outdated Node; the API restarts after `replaceOutdatedNode` claims the busy one                                                                                                                                                                                                                                                                                         | scale-in never claims either; the claimed busy Node is removed without the re-check and is never unclaimed; one Node at a time is replaced; the idle Node's replacement idles out after one window                                                                                                                                                                                                                                                                                                                                  | test:0048/S11                                                                                      |
| S12 | In one pass a scale-in candidate is stopped by the provider after loss handling read it                                                                                                                                                                                                                                                                                                                                                  | the stopped candidate is deleted once, either as scale-in or, if it was busy and unclaimed, by the next pass's stop path                                                                                                                                                                                                                                                                                                                                                                                                            | test:0048/S12                                                                                      |

## Workload fit

This section applies the workload-fit convention to the batch customer's pool Jobs. The
evidence is the aggregate profile behind RFC 0044's decision 26 and its §
Customers, and RFC 0043's § Workload fit. The customer records stay outside
this repository, and nothing below names a Job, image, bucket, host or user.

| #   | Batch customer's workload                                                                                            | Spec                                                                                                                                     | Served                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| W1  | Agents submit fan-out bursts of hundreds to thousands of command Jobs over a few heavy images, most on one small GPU | RA turns the claimable backlog into replicas, up to `--max-vms` Nodes and the about 200 in-flight cap; one pass buys the Nodes they need | Yes, up to `--max-vms`. Jobs above it wait queued and show why. RFC 0044's S12 is the path past 200 in flight |
| W2  | GPU Jobs that run long (median about 107 min)                                                                        | a Node stays busy while a Job holds its replica; scale-in waits for the window after the last Job ends                                   | Yes. The 10 min window is small next to a Job, so it adds little cost per burst                               |
| W3  | A new batch soon after the last, on the same images                                                                  | Nodes inside their idle window take the new replicas with the image cached (0.65 s start against 56 s cold for 4 GB)                     | Yes within the window. A gap longer than the window pays VM boot, join and the pull                           |
| W4  | Spot Jobs that checkpoint and resume; 46% of GPU Jobs were preempted                                                 | RT9 deletes the evicted VM, or SPOT deletes a stopped one; the retry pends and buys a Node through demand (S8)                           | Yes, with the checkpoint (RFC 0043). Same-VM restarts are **not** served: RD (M12)                            |
| W5  | Per-agent-session throttles and budgets                                                                              | capped Jobs make no replicas (RA), so they buy no Nodes; an account cap is a soft block (S7)                                             | Yes                                                                                                           |
| W6  | Spot capacity found by rotating across regions and clouds, as VM Jobs do                                             | one pool is one provider and region; scaling stays inside it                                                                             | **No.** Placement across pools is its own RFC (M5)                                                            |
| W7  | Quiet periods with no Jobs                                                                                           | the pool keeps `--min-vms` ≥ 1 Nodes                                                                                                     | **Partly.** The minimum's Nodes keep billing, which an overnight gap pays for. Scale-to-zero is Later         |

## Alternatives considered

- **Rewrite RFC 0016 in place.** Rejected by the owner (10-15). Its subject,
  RFC 0015's raw-VM clusters, no longer exists, and a new RFC keeps 0016's
  history readable.
- **Kubernetes Cluster Autoscaler or Karpenter** (rejected in RFC 0016, and
  still rejected). Either one would need anycloud's cloud credentials and
  would bypass the VM ledger, spend caps, target ranking and provider
  recovery. Kubernetes stays the sensor and the scheduler.
- **Scale Nodes directly from queue length.** Rejected. RA already turns
  queued Jobs into replicas after the cap checks. A second count from the
  queue would bypass those checks and double-count Jobs that are already
  Pending (RFC 0044 § RFC 0048 and capacity).
- **Keep `selectScaleDownVms` (by readiness and ID).** Rejected, because it
  can delete a Node that holds a Job, which costs an uncharged retry.
- **A durable idle window or a minimum lifetime** (RFC 0016 had a lifetime).
  Rejected. The in-memory window only fails toward keeping a Node, and a
  window that starts once the Node is usable covers new Nodes.
- **Scale-to-zero (`--min-vms 0`).** Later (RFC 0044 decision 12). It needs a
  `reserved` estimate when the pool has no Node, and it adds the full boot,
  join and pull time to the first Job.

## Risks

- **A Pod that pends for a reason other than capacity** but fits the shape
  would buy Nodes that then idle out. The loop is bounded by `--max-vms` and
  the window. Pool Pods carry no user affinity or volumes, which keeps such
  reasons rare. A Pod still Pending after a Node of its shape joined is the
  evidence that would justify a per-Pod cooldown.
- **A stale `reserved` estimate** after a DaemonSet change under-buys, which
  the next pass corrects, or over-buys, which idles out.
- **Mixed VM-type pools** pack onto the smallest shape, so a larger launched
  type may leave room unused for one pass.
- **Spot capacity can run out** in the pool's region. Pods stay Pending with
  the provisioning reason, under today's backoff, until W6's placement RFC.
- **Spend:** the minimum's Nodes and each window bill as whole VMs, by design
  (RFC 0044 decision 22).
- **Join-script replacement waits for a steady pass.** `replaceOutdatedNode`
  skips while the pool is short, any VM is claimed or any live VM isn't
  Ready. A pool that scales without pause keeps its outdated Nodes, and the
  gap an earlier fix closed reopens, until it settles. Each idle outdated Node also costs one
  extra boot (§ Scale-in, step 3).

## Owner questions

No owner questions remain open. Questions 1–3 were decided on 10-22 ("All
recommended: 1a, 2a, 3a"), and question 4 on 10-22 ("(c) Refill only if it
was busy").

### Decided

1. **The idle window: one constant, or a flag?**
   - _Options:_ (a) one constant of about 10 min for every pool; (b) a
     per-pool `--scale-in-delay` on `node-pool create`.
   - _Trade-off:_ the window trades idle spend for warm Nodes. W2's Jobs run
     about 107 min, so 10 min adds little per burst, and W3's follow-up
     batches inside the window find their image cached. A flag adds a column,
     a migration and its validation, and becomes a contract once shipped.
   - _Decided (10-22): (a), a fixed window of about 10 min._ A flag waits for
     evidence that one value doesn't fit both the session and batch customers,
     and adding it later doesn't break the constant's users.
2. **The post-cordon re-check: a direct Pod LIST, or the watch cache?**
   - _Options:_ (a) one Pod LIST of that Node (`spec.nodeName`), per removal;
     (b) the watch cache, as RFC 0044 § Scale-down says.
   - _Trade-off:_ the Node watch and the Pod watch aren't ordered, so a Pod
     bound just before the cordon can be missing from the cache, and the
     re-check would then delete a Node that holds a replica (S5). The LIST
     costs one API call per removal, the same call `replaceOutdatedNode`
     already makes for its Node.
   - _Decided (10-22): (a), the direct LIST._ RFC 0044's wording is amended
     when P3 lands.
3. **The Node shape for a pool with several VM types.**
   - _Options:_ (a) for each resource, the smallest value among the pool's
     types; (b) the first listed type's shape; (c) the shape of the type the
     launch loop will try first, which the round-robin launch order makes known.
   - _Trade-off:_ the launch loop may start any listed type. Since that change, it
     tries the next type in the same region after a capacity failure, so
     mixed pools are more common. With (b), a smaller type that launches
     leaves Pods Pending until the next pass buys again. With (a), a larger
     type leaves room unused until the next pass packs it. (c) packs exactly,
     but it couples the policy to launch ordering, and a smaller fallback
     after that type fails under-buys for a pass.
   - _Decided (10-22): (a), the per-resource minimum._ It never under-buys,
     and the cost of an over-buy is one idle window.
4. **SPOT's refill above the floor.** On `main`, a stopped VM's successor
   launches in the pass that claims it (RFC 0044 S21) and boots while the
   release is being confirmed.
   - _Options:_ (a) only through demand: an idle lost Node isn't replaced,
     and a retry waits for the confirmed release, which may take several
     passes under a provider's `releaseConfirmationPolicy`
     (`gateways/cloud.ts`), then the next pass, then boot and join, which no
     longer overlap; (b) keep the same-pass refill, counting each claimed
     lost VM as one Node of demand until its Pods are deleted; (c) like (b),
     but only for a lost VM whose Node was busy in the pass's snapshot.
   - _Trade-off:_ (a) adds nothing but slows the common spot path: W4's GPU
     Jobs were preempted 46% of the time. (b) keeps SPOT's latency, but an
     idle evicted Node is replaced and idles out after one window, a boot
     plus about 10 min of VM. (c) keeps the latency for retries and replaces
     no idle Node, for +10–20 source lines and +20–40 test lines in P2.
   - _Decided (10-22): (c), busy lost Nodes only._ Above the floor, a lost
     VM whose Node was busy in the pass's snapshot counts as one Node of
     demand, and an idle lost VM isn't replaced. Spot retries are the path
     W4 exercises most, so they keep SPOT's latency, and an idle Node is
     never bought back. (Amended 10-23 for the second and third delta
     reviews:) a busy lost VM
     counts only in the pass that claims it, so a slow release can't buy it
     twice, and it counts whether or not its release confirms in that pass.
     (Amended 10-23 for the fourth delta review:) `pending` is read from the
     pass-start Pod snapshot, so its recreated replicas don't count again in
     that pass. (Amended 10-23 for the fifth delta review:) `lost`'s busy
     check ignores Pods being deleted, so Pods that Kubernetes evicted before
     the claim count only through their replicas in `pending`.
     A restart after that pass, or a claiming pass that buys nothing, falls
     back to (a).

## Tracking

As changes ship, each one links its PR here, across phases P1–P4.

## Decision

_(Filled when accepted or rejected: the call, date, and link to the relevant
owner decision.)_
