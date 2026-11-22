# RFC 0029: Kubernetes Deployments for Jobs

<span id="rfc-0029-anycloud-deployments-for-jobs"></span>

> Status: Superseded — node pools, Kubernetes Deployments and node pool
> Services were removed (migrations 0172 and 0173); VM Jobs and VM Services
> replace them.
> Date: 2026-08-28
> Author: Luis Fernando De Pombo
> Decision state: O19 promoted for implementation validation
> Implementation state: O19 shipped through the integrated implementation and subsequent naming fixes;
> RFC acceptance remains pending

## Summary

Anycloud needs a Kubernetes workload primitive for processes that stay loaded
and handle more than one unit of work. The forcing use case is the session customer: one
loaded model process can run several concurrent sessions. The same seam should
later let an ordinary workload process one Job at a time without introducing a
customer-specific abstraction.

This RFC considers a public **Kubernetes Deployment** that targets one Kubernetes Cluster
and owns one persistent Pod template. It accepts finite Jobs. A jobs
Deployment may configure `max_concurrent_jobs_per_replica`, which defaults to
one; RFC 0029 always reconciles exactly one replica. Deployments accept Jobs only.
Request-serving Kubernetes workloads are ordinary cluster-backed
Services specified separately by
[RFC 0032](./0032-kubernetes-ingress-deployments.md); neither RFC adds an
ingress mode or ingress fields to Deployment.

O19 is the promoted candidate under the current requirements. Promotion
selects it for implementation validation without accepting this RFC. Its
narrowed data-model transition is shown using current names for the surviving
records. The removed field retains its historical schema name:

```text
add     deployments                          persistent workload resource
add     workloads.deployment_id              target relationship on existing Job rows
add     workloads.current_execution_id       current targeted-execution fence
remove  deployments.cluster_id              obsolete direct workload target
retain  vms.cluster_id                       managed Node VM ownership
reuse   workload_events                      Job state and execution history
```

As of 2026-09-16, this O19 resource model is shipped behavior and is therefore
an architectural fact even though the RFC remains `Proposed`: a Job may target
one Deployment; that Deployment targets one Cluster; a targeted Job keeps its
Job identity and lifecycle but creates no dedicated VM, Pod, or Kubernetes Job
of its own. This implementation outcome does not erase the option history or
satisfy the acceptance scenarios by itself.

A targeted Job is an existing Job whose target is a Deployment. Its
Job ID is the application invocation reference. `current_execution_id` is a
private concurrency fence, not another resource. Anycloud does not add an
inline message payload or a public Assignment, Execution, Runtime, Queue,
Claim, Slot, Replica, or Job-attempt resource in this RFC.

The ownership boundary is deliberate: Anycloud stores Deployment intent and
Job history, while Kubernetes supplies live workload facts. The
`deployments` row does not copy Kubernetes readiness, endpoint,
container identity, controller errors, or a second lifecycle state machine.

For the session customer, Supabase may retain the session reservation and business data
keyed by the Job ID. Anycloud remains authoritative for admitting,
queuing, selecting, retrying, cancelling, and observing the Job. A Pod may look
up the exact reservation for a Job selected by Anycloud; it may not independently pick
another reservation from Supabase.

The repository's legacy Kubernetes Job and Service workload paths are unused
and have no compatibility or persisted-workload migration requirement. O19
removes them and their `deployments.cluster_id` target as part of replacing them
with the new Deployment path. The ordered migrations remove the obsolete target
before adding the new relationships. The production direct-provider Job, VM,
and VM-host Service paths remain unchanged. RFC 0032 may later add Cluster
placement to that existing Service resource under a new contract; it does not
restore the removed runtime as a Deployment mode.

Autoscaling and manual replica control are excluded. RFC 0030 may later vary
replica count from Job demand. RFC 0016 separately owns managed Cluster Node
scaling from Pending Pods.

## How this RFC evolves

Option states mean:

- **Component**: useful machinery or a relationship, but not a complete answer;
- **Considering**: a complete candidate that passes the current requirements;
- **Promoted**: selected for concrete validation without accepting the RFC; and
- **Eliminated**: retained history that fails a current requirement.

The RFC remains `Proposed` until a repository-level decision is made. Option
IDs remain stable so narrowing does not rewrite the history as though
Deployment were inevitable.

## Context

### Current execution contracts

[`ARCHITECTURE.md`](../ARCHITECTURE.md#workload-types) currently describes:

- a **Job** as finite container work with a terminal outcome;
- a **Service** as a long-running HTTP workload; and
- a **VM** as a persistent development container on one cloud host.

A direct-provider Job provisions a dedicated VM, initializes it, pulls an
image, starts one finite container, finalizes configured artifacts, and
releases the VM. A Job submitted with direct-provider placement and without a
Deployment target keeps that behavior.

The public `vm` command remains the existing development environment. Rows in
the internal `vms` ledger continue to represent real provider machines,
including machines used as managed Kubernetes Nodes. Pods and Deployment
replicas never become synthetic VM rows.

The repository also contains unused Kubernetes paths that map a Job to a
`batch/v1` Job and a Service to an `apps/v1` Deployment plus native networking.
Removing those paths, the direct `job --cluster` and `service --cluster`
interfaces, and `deployments.cluster_id` is part of the replacement. There is
no request-serving Kubernetes path in RFC 0029. RFC 0032 separately proposes
Cluster placement for the existing public Service.

After that cleanup, workload and machine placement use distinct relationships:

```text
Job -> deployment_id -> Deployment -> cluster_id -> Cluster
managed Node VM -> cluster_id -> Cluster
```

A targeted Job never stores or snapshots the Cluster ID. It resolves Cluster
placement through its Deployment. A dedicated direct-provider Job has no
Cluster relationship.

### Proposed seam

```text
Job -> Deployment[jobs] -> Pod -> application capacity

Deployment -> Kubernetes Cluster -> Pod -> Node
managed Node -> Anycloud-provisioned cloud VM
```

A Deployment is the logical persistent workload. Its replica maps to a Pod in
the initial Kubernetes runtime. A Job remains finite application work and does
not map one-to-one to a Pod or container.

The Job targets the Deployment, never an individual Pod. Anycloud delivers the
Job ID to the long-running application. Kubernetes remains responsible for Pod
placement and replacement.

### Session Jobs and ordinary Jobs

The session customer supplies the difficult case:

- every model image starts a long-running process;
- one model process handles several concurrent sessions;
- The session customer owns the model, hardware, and safe-concurrency matrix;
- a session is finite work but is not a container or Pod; and
- Session customer v0 places one model Pod on one GPU Node, while later versions may
  place several model Pods on a larger Node.

The generic relationship is:

```text
Job -> Deployment -> long-running application
```

The session customer configures several concurrent Jobs. An ordinary reusable workload can
later configure one:

```text
Session model:     one replica, N concurrent Jobs
ordinary deployment: one replica, 1 concurrent Job
```

Setting the value to one does not recreate today's fresh-container isolation.
A later adapter for arbitrary current Job images must define process reset,
workspace cleanup, and storage behavior. Dedicated direct-provider Jobs remain
authoritative until then.

### Cluster capacity remains separate

[RFC 0015](./0015-anycloud-managed-kubernetes-clusters.md) owns Cluster
identity, runtime access, and fixed managed capacity. [RFC
0016](./0016-managed-kubernetes-vm-autoscaling.md) considers changing managed
Node count from scheduler-visible Pod demand.

RFC 0029 only reconciles one Pod:

```text
fixed target 1 -> Deployment reconciler -> Pod -> Kubernetes scheduler
```

Without RFC 0016, the Pod waits when the Cluster lacks capacity. RFC 0029 does
not provision a VM in response.

### Control-plane setup is not application concurrency

`MAX_ACTIVE_DEPLOY_PIPELINES = 50` protects direct-provider setup work. It does
not describe the number of Jobs that a Deployment application can run.

```text
API setup capacity       direct-provider initialization protection
Deployment backlog      targeted Jobs in queued state
application capacity    max_concurrent_jobs_per_replica
physical capacity       CPU, memory, GPU, and Pod placement
```

## Decision requirements

These requirements gate acceptance. The promoted candidate must satisfy them
through implementation validation and add the RFC 0025 enforcement ledger for
every invariant it makes normative before this RFC is accepted.

### Preserved behavior and vocabulary

**R1 — Preserve dedicated Jobs.** A Job without a Deployment target retains the
current direct-provider lifecycle, including its image, command, VM, status,
logs, buckets, retries, termination, and cost history.

**R2 — Do not add a reuse flag.** Reusable execution is named by targeting a
Deployment. Per-Job configuration must not create an anonymous hidden Pool.

**R3 — Use Deployment as the public persistent Job workload.** Pool, Fleet, Queue,
Assignment, Execution, Runtime, Resident, Replica, Pod, VM, Claim, and Slot
must not become additional public execution targets or SDK resource roots.
`DeploymentContext` and `CurrentJob` are scoped SDK handles for the existing Deployment
and Job nouns. Internal records and Kubernetes objects do not become public
resources merely because operators can observe them.

**R4 — Keep Services separate.** A Deployment never serves HTTP ingress. RFC 0032
may place the existing Service resource on a Cluster while preserving
its `$PORT`, URL, upgrade, status, and termination contracts. Native
Kubernetes networking objects remain implementation details, and existing
VM-host Services remain unchanged.

**R5 — Be object-first, API-backed, and SDK-thin.** Python arguments, JSON
requests, and CLI flags must be sufficient; YAML is not required. The CLI and
SDK call the same control-plane operations. The Python SDK extends its existing
flat `Client` style with Deployment CRUD and targeted `submit`, plus
`anycloud.current_deployment()` for code inside the Deployment Pod. That helper
returns a `DeploymentContext`; `next_job()` returns `CurrentJob | None`.
`CurrentJob` carries the execution fence privately through cancellation,
outcome, and cleanup calls. The same SDK distribution supplies both operator
and in-Pod APIs while preserving their distinct GitHub-user and projected
ServiceAccount authorities. The SDK does not add a resource hierarchy, policy
framework, background dispatcher, handler framework, application executor, or
owned loop. The raw scoped HTTP API remains the language-neutral integration
contract and no workload requires a CLI supervisor or sidecar.

### Deployment and Job contracts

**R6 — Keep jobs the only Deployment kind.** Every RFC 0029 Deployment accepts
Jobs. Create and update contain no `ingress`, mode, or generic `accepts`
discriminator. RFC 0032 defines cluster-backed Services independently and does
not extend the Deployment request shape.

**R7 — Let the Deployment own the supported template.** Image, command,
environment, resources, Cluster, and concurrency configuration belong to the
Deployment. A targeted Job cannot override them. Named application Secrets
(amended 2026-10-04) are Deployment references too: create and update
accept saved Secret names, responses expose only the names, and reconcile
projects the values through one owned application-env Kubernetes Secret.

**R8 — Keep targeted Jobs as existing Jobs.** The existing Job row gains nullable `deployment_id` and
`current_execution_id`, plus `submission_revision`, `claim_deadline_at`, and
`first_claimed_at` for first-claim arbitration. `deployment_id` owns the target relationship;
`current_execution_id` is the latest/current execution fence rather than a Job-attempt resource. A
targeted Job keeps the existing Job ID, state vocabulary, events, ownership,
cancellation, resubmission, and terminal outcomes. This reuses the durable Job
and management contract, not the direct-provider admission, provisioning,
polling, retry preparation, or teardown implementation.

**R9 — Keep targeted Jobs finite and contextual.** A targeted Job uses
`queued`, `running`, `retrying`, and existing terminal outcomes independently
from the Deployment lifetime. `starting` is unreachable for targeted Jobs; it
also never enters `provisioning`, `initializing`, `downloading`, `syncing`,
`recovering`, or `finalizing`. Targeted transitions are guarded by
`deployment_id`; they do not widen the dedicated-Job state machine.

**R10 — Support one or many Jobs in the long-running process.** A jobs
Deployment may declare positive `max_concurrent_jobs_per_replica`; omitting it
means one. One supports future sequential work; values greater than one support
Customer sessions. A slot remains occupied from atomic next-Job selection until
the current execution is released: normally by a runtime-reported terminal
outcome, and after user termination only when `cleaned_at` confirms that
cancellation stopped the local task or Kubernetes observation proves that the
runtime identity recorded for the current execution is absent or was replaced.
Publishing a terminal state alone must not expose replacement capacity
prematurely. Next-Job, outcome, and cleanup operations are idempotent so an
acknowledgement loss cannot permanently consume a slot.

**R11 — Do not equate Job, session, and Pod.** Kubernetes does not create one
Pod for each targeted Job. Customer session identity and mutable business data
remain distinct from Job and Pod identity.

**R12 — Preserve ordinary-Job convergence.** Existing Job-owned bucket fields
and terminal semantics must remain usable by a later one-slot adapter. Automatic
template materialization and long-running-process isolation are not required
here.

### Execution durability and application data

**R13 — Discover before atomically claiming an exact Job.** Discovery is read-only
and returns Job ID, submission revision, and required-nullable previous execution
UUID. The SDK creates a new execution UUID only before attempting a claim. One
transaction replays an identical successful binding before checking readiness,
then checks target, generation, deletion, capacity, candidate identity, and
first-claim eligibility before changing queued to running and writing the start
event. The event binds the complete candidate and runtime identity. Unused UUIDs
are not independently bound to failed requests. The shared dedicated-Job FSM
and lifecycle callbacks remain unchanged.

**R14 — Recover from observed runtime loss and fence stale executions.** The
execution-start event records the desired generation and authenticated runtime
identity tuple: Kubernetes Pod UID plus the workload container's non-empty
`containerID` from Pod status. Every lifecycle callback compares its execution
UUID with `workloads.current_execution_id`. Runtime recovery reads the event
matching that current UUID; it does not infer current execution from an
arbitrary historical event. When Kubernetes proves that either identity member
is absent or replaced, unfinished Jobs can move through `retrying` to `queued`,
and the next logical selection writes a fresh UUID. Old callbacks cannot mutate
the new execution. Existing retry-event counting, bounded backoff, revision
fencing, and `retrying -> queued` timing are reused; targeted retry preparation
never resolves compute credentials or tears down Job-owned runtime resources.
A terminal Job is never retried: if its current execution still awaits
cancellation cleanup, the same fenced runtime-loss observation completes
`cleaned_at` instead.

**R15 — Keep Job-selection authority in Anycloud.** An application may store
business data outside Anycloud and look it up by the Job ID selected by
Anycloud. The application cannot use that store to select work independently.
If Supabase chooses the next session, Anycloud no longer owns the Job queue and
the design is O9 rather than O19.

**R16 — Carry identity only in v0.** A targeted Job has no new inline payload.
The long-running application receives its Job ID. Input, output, and checkpoint
bucket options are rejected for targeted Jobs until a later RFC defines their
shared-process behavior.

### Kubernetes and lifecycle

**R17 — Use a native persistent workload.** The runtime reconciles an
`apps/v1` Deployment or equivalent controller with exactly one replica and
lets the Kubernetes scheduler place its Pod. It does not recreate VM scheduling
inside the workload.

**R18 — Implement managed Clusters first without closing attachment.** RFC 0029
must work on RFC 0015 managed Clusters through the generic Kubernetes runtime
resolver. An attached-Cluster implementation may use the same public contract
later and must not require a Job or Deployment schema change. TokenReview is
the initial runtime-authentication capability; an attached implementation may
supply equivalent Pod-bound authentication behind the resolver while preserving
the same authorization and observation contract.

**R19 — Keep identities separate.** Deployment, Job, execution UUID,
event, Pod, Node, and cloud VM identities cannot be derived from one another.
One Pod per Node may be configured without becoming an invariant.

**R20 — Separate Cluster supply from Deployment demand.** CPU, memory, and GPU
count are Deployment configuration. Anycloud does not store the session customer's
model-to-hardware matrix as platform policy. A managed Cluster is homogeneous,
so its VM type fixes the accelerator model and available count. Deployment GPU
options follow VM Jobs: omitted GPU intent uses all GPUs on one verified NVIDIA
capacity VM and none on CPU capacity. Explicit `all` or a positive integer
requests verified per-VM supply; zero, incompatible accelerators, unknown
supply, and counts above that supply are rejected. Future
heterogeneous attached Clusters add an accelerator placement selector rather
than overloading the count.

**R21 — Reconcile exactly one replica.** There is no public replica field,
manual scale operation, or autoscaling policy in RFC 0029. Only RFC 0030 may
later vary the target.

**R22 — Treat Kubernetes as the runtime authority.** As with a cloud provider,
Anycloud persists desired configuration and cleanup ownership while the
external control plane supplies live facts. Anycloud stores the desired
template and generation, deletion timestamps, and existing Job history;
Kubernetes remains authoritative for the applied generation, Pods, readiness,
Pending reasons, container identity and restarts, networking endpoint, and
controller errors. `deployments` must not mirror those facts as a
lifecycle state, `last_error`, endpoint, runtime registration, or heartbeat.
Status and reconciliation may query Kubernetes; ordinary list operations stay
database-backed. Invalid desired configuration is rejected at admission,
Cluster access failures belong to Cluster status, and execution outcomes belong
to Job events.

**R23 — Preserve low-latency fixed capacity without overstating readiness.**
The Pod, image, and model process can remain warm. The application calls
`next_job()` only after it can accept work, and failure of that critical loop
must exit the process so Kubernetes replaces it. Anycloud reports observed
Kubernetes container readiness as such. An optional native exec readiness probe
is desired configuration applied through the existing generation and drain;
Kubernetes owns its result. Application readiness is unknown without a probe.
No observation is persisted as a readiness bit. Next-Job selection requires a Ready container
on the desired generation. Matching cancellation, outcome, and cleanup calls
remain valid while that process is Unready, draining, or on an older desired
generation.

**R24 — Drain before replacement.** A jobs Deployment stops selecting new Jobs,
waits for unreleased targeted Job executions and pending cleanup fences,
removes the old Pod, and then creates the new generation. Deletion prevents new
input, resolves queued Jobs, drains active work, and cleans subordinate
Kubernetes objects.
Existing per-Job termination is the only operator escape hatch; RFC 0029 adds
no Deployment-level force or drain timeout. RFC 0029 does not require a surge
Pod.

**R25 — Remove direct Cluster workload targeting.** The implementation removes
the legacy `job --cluster` and `service --cluster` forms, their unused
Kubernetes Job and Serve runtimes, and `deployments.cluster_id`. The ordered
migrations first remove that obsolete target and add the persistent workload
relationship. Migration 0100 renames the historical `cluster_deployments` table
to `workers` and `deployments.cluster_deployment_id` to `worker_id`. Migrations
0105 and 0106 then establish the current `workloads` and `deployments` tables and
`workloads.deployment_id` relationship, preserving rows and identities. A targeted Job reaches a
Cluster only through its Deployment. Managed Node VMs retain `vms.cluster_id`.
Removing the column and updating its live SQL consumers are one change:
`laneKeySql` loses its `cluster_id` term because targeted Jobs are outside that
scheduler, and the Cluster-deletion guard moves from
the historical `deployments.cluster_id` target to undeleted `deployments` in
`ClusterStore.requestDeletion`. Normal repository and Cluster-deletion coverage
must exercise the final schema; this RFC does not require a dedicated
historical migration fixture.

**R26 — Persist admission-to-first-claim expiry.** Deployment submissions accept an
optional timeout. Blocking submission confirms a durable claim, independently
of completion waiting. Claim and revision-fenced expiry use one transaction and
one sampled time. Confirmed expiry persists termination and cannot later start,
even after clock rollback, disconnect, or restart. Direct observation does not
wait for provider reconciliation slots. Explicit resubmission preserves the Job
ID, advances its revision, and replaces or clears the deadline; automatic retry
retains revision and first-claim evidence.

**R27 — Make empty discovery safe to stop.** Candidate discovery accepts
`waitMs=0..20000`, subscribes before inspecting runtime and capacity, and
creates no reservation, UUID, or empty-result row. New acquisition requires a
fresh eligible candidate; the Python SDK discards late candidates before claim.
Empty bounded receives wait on the shared Deployment channel. Committed writers
and a supervised Pod watch provide hints; every wake reauthenticates and
reobserves before discovery. Idle receives do not poll once per second. Last
receiver disposal, timeout, disconnect, and shutdown release their subscriptions.
It retains an ambiguous complete claim tuple until matching success or a typed
permanent result. Missing Jobs, future revisions, unknown prior UUIDs, and
transient runtime/capacity/authentication failures are not permanent staleness.

**R28 — Use discovery and exact claim for Deployment acquisition.** The SDK waits
up to 20 seconds for a candidate by default. A zero timeout performs one
nonwaiting discovery and at most one exact claim. Both use the same runtime,
capacity, and submission-deadline rules. Management API and SDK changes use the
existing exact-version release boundary.

## Acceptance scenarios

This table is the single acceptance checklist for O19's decision requirements.
Acceptance requires the RFC 0025 ledger for normative invariants and the local
and cloud qualification described in [Reuse and required implementation](#reuse-and-required-implementation).
`deferred:` rows do not gate this release. Validation retains the option history
and does not introduce autoscaling policy.

| ID  | Scenario                                         | Required result                                                                                                                                                                                                                                                                                                                                                                                                                       | Coverage                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Existing Job                                     | `anycloud job IMAGE` retains its dedicated-VM lifecycle and never creates a Deployment.                                                                                                                                                                                                                                                                                                                                               | test:0029/S1 — the Job runtime router sends an untargeted provider Job through the unchanged VM-host lifecycle.                                                                                                                                                                                                                       |
| S2  | Jobs-only contract                               | Create and update expose no ingress or generic mode selector; RFC 0032 defines cluster-backed Services separately.                                                                                                                                                                                                                                                                                                                    | test:0029/S2 — strict create and update schemas reject ingress, mode, and generic accepts selectors.                                                                                                                                                                                                                                  |
| S3  | Default jobs                                     | Omitting concurrency creates a one-slot jobs Deployment; its targeted Job is an existing Job row whose target, execution fence, submission revision, deadline, and first-claim evidence stay on the existing row.                                                                                                                                                                                                                     | test:0029/S3 — the e2e-cluster-local journey (`e2e-cluster-local.spec.ts`) observes the one-slot default on a node pool Deployment; repository upgrade tests verify the target and execution-fence columns.                                                                                                                           |
| S4  | Session customer v0                              | `current_deployment().next_job()` returns a Job ID, the Pod loads that exact Supabase reservation, and the Job remains running for the session lifetime.                                                                                                                                                                                                                                                                              | test:0029/S4 — the e2e-cluster-local journey holds a selected Job while its in-Pod SDK deployment resolves the reservation keyed by that Job ID.                                                                                                                                                                                      |
| S5  | Saturation                                       | With capacity `N`, no more than `N` executions remain unreleased. One transactional report accepts completed, errored, invalid or retryable outcomes from the matching running execution; exact retries succeed and stale fences conflict. Both report/termination orderings preserve the winner and release one slot only after execution stop is known.                                                                             | test:0029/S5 — table-driven store tests exercise every report kind in both orderings and prove the next queued Job is admitted exactly after cleanup.                                                                                                                                                                                 |
| S6  | Atomic claim and lost response                   | An exact claim atomically moves one Job `queued -> running`, binds one execution UUID and appends its start event. Matching replay precedes readiness/capacity checks. The SDK retains the complete pending tuple across transport/5xx errors, retry exhaustion and later calls; only typed permanent results retire unsuccessful claims.                                                                                             | review — store/domain and Python workflow/wire qualification cover same-UUID, different-UUID, full-capacity and concurrent claims; stale UUIDs cannot reclaim or mutate later executions.                                                                                                                                             |
| S7  | Runtime loss                                     | Kubernetes-observed Pod or container absence/replacement retries nonterminal Jobs, completes `cleaned_at` for terminal Jobs awaiting cancellation acknowledgement, and rejects stale execution callbacks. Stale or unavailable observations neither trigger recovery nor release capacity; API restart recovers nonterminal work and terminal pending cleanup.                                                                        | test:0029/S7 — the e2e-cluster-local journey deletes live Pods on a node pool, observes execution redelivery and cleanup, and rejects progress until matching runtime loss is proven.                                                                                                                                                 |
| S8  | External data boundary                           | Supabase can store data for the selected Job but cannot independently select the next Job.                                                                                                                                                                                                                                                                                                                                            | test:0029/S8 — the e2e-cluster-local fixture exposes reservation lookup only after Anycloud selects and delivers the exact Job ID.                                                                                                                                                                                                    |
| S9  | Storage rejection                                | Targeted Jobs carry identity only and reject inline payloads plus input, output and checkpoint bucket options rather than partially mounting them.                                                                                                                                                                                                                                                                                    | test:0029/S9 — CLI matrix and managed-Kubernetes journey reject bucket overrides before persistence; inline-payload rejection also rests on strict-contract review.                                                                                                                                                                   |
| S10 | Rollout and drain                                | Next-Job selection stops, active executions drain, the old Pod disappears, and only then does the new generation start.                                                                                                                                                                                                                                                                                                               | test:0029/S10 — the e2e-cluster-local journey updates a busy node pool Deployment, retains its old Pod through drain, then observes a distinct new-generation Pod.                                                                                                                                                                    |
| S11 | Fixed Cluster capacity                           | A Pod may remain Pending; RFC 0029 does not provision or terminate a Node.                                                                                                                                                                                                                                                                                                                                                            | test:0029/S11 — the e2e-cluster-local journey audits the node pool VM ledger before final release, so Deployment and Job activity cannot add or remove capacity records.                                                                                                                                                              |
| S12 | Future colocation                                | Several model Pods may later share one Node without changing Job, Deployment, session, or Pod identity.                                                                                                                                                                                                                                                                                                                               | deferred:0030 — replica-count policy and multi-Pod behavior belong to the Kubernetes Deployment autoscaling RFC.                                                                                                                                                                                                                      |
| S13 | Direct-target cleanup                            | R25 migrations remove direct Cluster workload targeting before adding Deployment relationships and R8 submission/fence fields, including non-null execution-UUID uniqueness. Final-schema fair queueing, Cluster deletion, and the deletion/reuse/E2E replacement audit preserve direct-provider workloads and managed Cluster lifecycle.                                                                                             | test:0029/S13 — the final-schema test pins the node pool, Cluster and Workload ownership indexes; review also covers migration order, obsolete-path removal and the shared managed-Kubernetes replacement journey.                                                                                                                    |
| S14 | Job machinery boundary                           | Existing management and retry timing are reused, while targeted Jobs move directly `queued -> running`, never enter `starting` or provider provisioning, and do not widen the dedicated-Job transition map.                                                                                                                                                                                                                           | test:0029/S14 — runtime and store tests keep targeted selection out of the dedicated VM path while preserving existing Job rows, states, events, and retry timing.                                                                                                                                                                    |
| S15 | Same SDK, two roles                              | The local acceptance journey installs the same workspace-built Python SDK for operator `Client` calls and in-Pod `current_deployment().next_job()` calls, preserving the R5 DeploymentContext/CurrentJob contract and distinct operator/runtime authorities, with no private SDK transport or raw-HTTP substitute.                                                                                                                    | test:0029/S15 — the e2e-cluster-local harness builds one workspace wheel and uses it for both operator Job requests and the in-Pod deployment.                                                                                                                                                                                        |
| S16 | Named Secrets                                    | Persistent Deployment create/update accept saved Secret names, responses expose names but never values, and Kubernetes manifests add one owned application-env Secret read through `envFrom` only when names are referenced.                                                                                                                                                                                                          | test:0029/S16 — contract tests accept Secret names and expose no values; manifest tests render the application-env Secret and `envFrom` only with references, and none otherwise.                                                                                                                                                     |
| S17 | Removed VM-hosted API upgrade                    | Approved removal for 0.1.65 (2026-09-27): refuse API-image Service admission and upgrades with cluster-hosted migration guidance before mutation. Existing records remain terminable.                                                                                                                                                                                                                                                 | test:0029/S17 — API-image admission and upgrade refusals replace the removed VM-hosted callback derivation path; no equivalent upgrade support is claimed.                                                                                                                                                                            |
| S18 | VM GPU option parity                             | Deployment `dockerOptions.gpus` accepts `all` or a positive count. Omission uses all GPUs on one verified NVIDIA capacity VM and none on CPU capacity; zero is invalid. Runtime defaults and explicit choices use shared VM Job validation, with `runc` plus GPU access rejected by the current managed adapter.                                                                                                                      | test:0029/S18 — shared admission cases cover omitted, all, positive, zero, excess, CPU, NVIDIA, non-CUDA, and unknown supply; manifests cover resolved resources and runtime selection.                                                                                                                                               |
| S19 | Submission expiry                                | Claim and expiry have one durable winner; resubmission fences old observers and automatic retry retains first claim.                                                                                                                                                                                                                                                                                                                  | review — submission HTTP and Deployment store tests cover direct expiry with all reconciliation slots occupied, restart, and clock rollback.                                                                                                                                                                                          |
| S20 | Safe stopping                                    | After `None`, no delayed request from that call can assign work; lifecycle calls remain usable during discovery.                                                                                                                                                                                                                                                                                                                      | review — deterministic Python deadline/claim tests; the managed-Kubernetes idle-stop checkpoint requires final runtime qualification.                                                                                                                                                                                                 |
| S21 | Warm CUDA inference                              | Two distinct targeted Jobs calculate MACE energies on CUDA in one Deployment Pod/process and one model load, with fresh calculations, matching model checksums, and bounded numerical error against two CPU references.                                                                                                                                                                                                               | review — warm CUDA inference reuse was proven only by the retired Cluster GPU qualification; node-pool GPU Deployment coverage must re-prove it. Cluster-hosted E2E coverage was removed with the independent Cluster surface on 2026-09-25 (owner decision C); the node-pool Deployment journey must restore an executable token.    |
| S22 | GPU recovery and replacement                     | Actual MACE Jobs succeed after device-plugin recovery without VM churn, controller and Pod recovery, Deployment rollout, and replacement GPU capacity; occupied GPUs do not reduce advertised readiness.                                                                                                                                                                                                                              | review — GPU recovery and replacement was proven only by the retired Cluster GPU qualification; node-pool GPU Deployment coverage must re-prove it. Cluster-hosted E2E coverage was removed with the independent Cluster surface on 2026-09-25 (owner decision C); the node-pool Deployment journey must restore an executable token. |
| S23 | Public and wire contracts                        | Flat Client, CLI and JSON interfaces expose mutually exclusive dedicated/Deployment submit inputs and a Deployment response distinct from Workload. Scoped APIs retain stable OpenAPI operation IDs and explicit request, response, replay, status and security schemas, with no Assignment-named path, property, operation, tag or symbol and no separate started operation.                                                         | review — compare public signatures and generated OpenAPI with the object and in-workload API contracts; these cross-surface requirements have no single scenario token.                                                                                                                                                               |
| S24 | Targeted management and query coverage           | A state-by-target matrix covers both listQueued arms, countDeploying, retry hydration, every reconcile-candidate arm including restart recovery, capacity, drain, cleanup and status health gates. Status/wait/termination/retry/resubmission avoid Job-owned VM, runtime, credential, secret and bucket work. Duplicate caller Job IDs return WORKLOAD_ID_CONFLICT without a new row.                                                | review — assess table-driven repository/query coverage and current-execution management checks across their owning paths.                                                                                                                                                                                                             |
| S25 | Runtime authentication and application readiness | Projected ServiceAccount tokens are reread on rotation and validated by TokenReview and Pod/container observation through the managed-Cluster resolver, with typed 503 responses when Cluster access is unavailable and no custom registration, credentials or heartbeats. R23 readiness rules apply; documentation requires capacity before next_job and process exit if that critical loop fails, with no SDK-owned loop/framework. | review — resolver, authentication, restart and caller-documentation evidence jointly establish runtime authority and application-owned readiness; raw scoped HTTP remains supported.                                                                                                                                                  |
| S26 | Deletion and identity reuse                      | Deletion prevents new input, resolves queued Jobs, drains active work and cleans subordinate objects. Qualification covers no-surge rollout, cancellation, active-name reuse and deleted-ID lookup, without Deployment-level force or timeout operations.                                                                                                                                                                             | review — assess deletion/name-lifecycle tests together with the S10 rollout journey and existing per-Job termination escape hatch.                                                                                                                                                                                                    |
| S27 | Resource and registry translation                | Rendering preserves CPU/memory requests and limits and the matching registry username/token pair, with an application-env Kubernetes Secret only for named Secrets. GPU admission and managed runtime selection follow S18.                                                                                                                                                                                                           | review — assess resource/manifest tests and registry encoding together; S9 retains payload and bucket rejection coverage; S16 covers named Secrets.                                                                                                                                                                                   |
| S28 | Receiver wakeups                                 | A subscribed receive wakes on committed target availability or native readiness changes without a Job mutation or idle polling. Each wake reauthenticates and reobserves; rollback, runtime replacement, interruption, cancellation, and restart preserve ownership and release subscriptions.                                                                                                                                        | test:0029/S28 — discovery, writer, Pod-watch, and shared-notifier tests; managed Kubernetes warmup/recovery timing receipts qualify the production path.                                                                                                                                                                              |

## Option registry

The registry retains the previously considered primitive relationships. The
current requirements eliminate candidates that depend on Pool, Fleet, an
execution-scoped Deployment, anonymous reuse, externally selected work, or a fresh
Pod per Job. RFC 0032 independently owns the existing Service resource's
Cluster placement.

O19 is promoted for concrete implementation validation. It is the only
complete candidate currently written against the narrowed requirements;
promotion does not make it an accepted decision.

| ID  | Primitive set or relationship                           | State      | Current disposition                                       |
| --- | ------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| O2  | `Job -> Pool`                                           | Eliminated | adds Pool instead of using Deployment                     |
| O3  | `Job -> Queue`                                          | Component  | durable queued state is required but does not own runtime |
| O4  | `Job -> per-execution Deployment`                       | Eliminated | confuses one execution with the persistent Deployment     |
| O5  | `Job -> Pool -> Deployment`                             | Eliminated | adds two public layers                                    |
| O6  | `Job -> Pool -> VM`                                     | Eliminated | ties logical execution too closely to machines            |
| O7  | `Job -> Fleet`                                          | Eliminated | machine-shaped target does not name Kubernetes workload   |
| O9  | `Deployment -> replicas`; external queue owns work      | Eliminated | hides Job backlog and execution from Anycloud             |
| O11 | `Job -> Queue -> Compute Environment/Capacity Provider` | Eliminated | overbuilds the public capacity model                      |
| O12 | Generic `Workload -> execution policy`                  | Eliminated | replaces stable roots with a broad polymorphic resource   |
| O13 | Anonymous reuse configuration on `Job`                  | Eliminated | rejected hidden identity and `reuse` configuration        |
| O17 | `Request -> Service`                                    | Component  | retained as RFC 0032's separate cluster-backed Service    |
| O18 | Typed Pool for allocating and persistent execution      | Eliminated | depends on Pool, fresh Job Pods, and external dispatch    |
| O19 | `Job -> Deployment -> Kubernetes Cluster`               | Promoted   | selected for concrete implementation validation           |

O3 survives only as existing Job rows in `queued`. O9 remains the fallback in
which the session customer chooses work from Supabase; it does not describe O19's permitted
lookup of data for a Job that Anycloud already selected.

<span id="o19--exclusive-input-anycloud-deployment"></span>

## O19 — Exclusive-input Kubernetes Deployment

O19 adds one public persistent Kubernetes workload:

```text
Deployment[jobs]
  owns a Pod template
  accepts existing finite Jobs
  exposes max_concurrent_jobs_per_replica
```

Request serving is not a variant of this workload. RFC 0032 specifies Cluster
placement for Services independently.

Job, Deployment, and Cluster are the public resources in this Kubernetes path.
Pod and execution details remain runtime observations. The existing public VM
resource stays outside the path.

### Object and CLI interface

The candidate SDK interface follows the current flat `Client` style:

```python
model = client.create_deployment(
    name="model-a",
    cluster="gpu-cluster",
    image="ghcr.io/acme/model-a:sha-456",
    command=["python", "worker.py"],
    docker_options={"gpus": "all"},
    max_concurrent_jobs_per_replica=8,
)

session = client.submit(
    deployment=model.id,
    workload_id="session-123",
)

model = client.get_deployment(model.id)
models = client.list_deployments()
model = client.update_deployment(model.id, image="ghcr.io/acme/model-a:sha-789")
client.delete_deployment(model.id)
```

No `client.deployments` namespace or `Jobs`, `Ingress`, `Resources`, scaling,
or executor framework is required. These methods validate and serialize API
arguments and return small existing-style handles or response models; the
control plane owns reconciliation and Job selection.

The existing `Client.submit` gains a mutually exclusive `deployment` target.
Its current image form remains unchanged, and `workload_id` remains the
caller's optional Job ID. A call supplies either an image for a dedicated Job
or a persistent Deployment target, never both. The five Deployment management
methods return `Deployment` values, distinct from the existing `Workload` model
used for generic Job, Service, and VM lifecycle rows.

Supplying `workload_id` does not make submission idempotent. If that Job ID
already exists, admission returns the existing `WORKLOAD_ID_CONFLICT` (`409`)
instead of treating the duplicate as success. A caller recovering from an
ambiguous response may read that stable ID; v0 neither compares the two
submissions nor converts the conflict into success.

On the wire, `maxConcurrentJobsPerReplica` defaults to one. Create and update
have no `ingress`, mode, or `accepts` field; RFC 0032 does not extend this
request shape.

Deployment GPU intent uses the same `dockerOptions.gpus` and
`dockerOptions.runtime` fields as VM Jobs. Python supplies these through
`docker_options`. `gpus` accepts `"all"` or a positive integer string. Omission
on verified NVIDIA capacity requests all GPUs on one capacity VM; omission on
CPU capacity requests none. `all` uses the VM's physical count, independent of
Cluster size and free scheduler capacity. Explicit GPU access on CPU or known
non-CUDA capacity, zero, malformed values, and requests above verified supply
are rejected. Unknown supply produces an actionable error. Image names and
CUDA metadata do not determine the default GPU request. Unsupported non-CUDA
capacity and unknown supply reject Deployment admission even without GPU options.
The shared CLI builder preserves explicitly empty options so common validation
rejects them. Image inspection uses the same accelerator-runtime compatibility
predicate as VM Jobs, including rejection of ROCm images on NVIDIA capacity.

GPU access automatically selects the NVIDIA RuntimeClass. Explicit `nvidia`
uses the same CUDA-capability validation as VM Jobs. CPU `runc` maps to the
default managed runtime. The managed adapter rejects explicit `runc` with GPU
access because its current device injection requires the NVIDIA runtime.

The stored configuration preserves submitted GPU intent, while scheduling and
status use the resolved numeric count. Update omission preserves both the option
map and admitted GPU count, revalidating that allocation against current capacity.
A catalog correction cannot silently expand an unrelated update; insufficient
or incompatible capacity rejects it before mutation. A supplied `dockerOptions`
object replaces the map, and `null` clears it;
both apply capacity defaults when the resulting options omit `gpus`. GPU
configuration belongs to the Deployment and cannot be overridden by a targeted Job.

Equivalent CLI operations use flags rather than YAML:

```bash
anycloud deployment create model-a \
  --cluster gpu-cluster \
  --max-concurrent-jobs-per-replica 8 \
  --gpus all \
  ghcr.io/acme/model-a:sha-456 -- python worker.py

anycloud job \
  --deployment model-a \
  --id session-123
```

Current Job management remains applicable:

```bash
anycloud status session-123
anycloud terminate session-123
anycloud resubmit session-123
```

A Deployment has no public request endpoint. A cluster-backed Service is a separate
Service resource, never a converted Deployment.

The current dedicated form remains unchanged:

```text
anycloud job IMAGE [flags] -- COMMAND -> dedicated provider VM
anycloud job --deployment NAME --id ID -> persistent Deployment application
```

The targeted form rejects image, command, provider, Cluster, VM, and bucket
overrides. Admission copies only the target's values needed by the existing Job
record and response shape into existing columns. Those values are descriptive
submission metadata, not Job-owned overrides or an execution-generation pin;
the execution-start event records the generation that actually runs. It does not
snapshot `cluster_id`; the `deployment_id` relationship resolves
Cluster placement.

The earlier admission requirement wrote the validated client version into
`deployments.version TEXT NOT NULL` and prohibited bypassing the admission plan
or writing `version ?? null`. Migration 0096 removed that historical column, as
recorded in [RFC 0031](./0031-terminal-phase-data-boundaries.md). Workload
persistence has no version column; the naming changes do not restore it.

The old `job --cluster` and `service --cluster` forms are removed rather than
redirected. No old Kubernetes workload row is migrated. RFC 0032's future
`service --cluster` interface is a new implementation of the ordinary Service
contract, not compatibility with the removed path.

### Desired facts and derived lifecycle

A Deployment has no persisted workload state machine. Its durable
facts are the desired template and generation plus separate deletion-requested
and deletion-confirmed timestamps. Kubernetes objects carry the observed
generation and supply live controller, Pod, container, and networking facts.

| Fact                                                                                   | Authority                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------- |
| Desired template, generation, and deletion cleanup fence                               | `deployments`                               |
| Job queue, execution, cancellation, retry, and outcome                                 | `workloads` and `workload_events`           |
| Applied workload, Pod/container health, scheduler/controller diagnostics, and endpoint | Kubernetes API, Conditions, and Events      |
| Cluster identity, access, and managed-capacity lifecycle                               | Existing Cluster and managed-Node machinery |

Detailed status returns the desired generation and deletion timestamps beside
current Kubernetes and Job observations. A client may present concepts such as
ready, updating, or draining from those facts, but RFC 0029 does not add a
second public status enum or stored transition authority:

```text
desired generation + deletion timestamps + Kubernetes observation + Job events
  -> current status view
```

There is no terminal `failed` Deployment state. Invalid configuration is
rejected before it becomes desired state; a valid persistent workload keeps
reconciling through transient Cluster or Kubernetes failures. `deleted_at` is
written only after targeted-Job cleanup fences are resolved and Kubernetes
confirms that subordinate resources are absent. The fixed target is one and is
not user configuration.

### Targeted Job execution

A targeted Job is created through the existing Job control plane and receives
`deployment_id`. Its durable queue membership is its existing `queued`
state. `current_execution_id` is null until a Deployment process starts it.

```text
queued --exact claim-----------------------> running
running --complete-------------------------> completed
running --application error----------------> errored
running --invalid invocation---------------> invalid
running --retryable failure/runtime loss---> retrying
retrying --backoff with budget remaining---> queued
retrying --retry budget exhausted----------> failed
queued/running/retrying --terminate--------> terminated
```

`next_job()` is acceptance and start in one operation. A successful call means
the application requested capacity and the selected Job is now `running`; there
is no public or wire-level `started()` acknowledgement. `starting` is
unreachable for targeted Jobs. This lifecycle is contextual: the claim
transaction requires a non-null `deployment_id` and performs a
targeted-only `queued -> running` conditional update without widening the
shared dedicated-Job FSM. Targeted Jobs never enter the direct-provider deploy
pipeline or consume its 50 setup slots.

The SDK first calls `GET /deployments/{deploymentId}/jobs/candidate?waitMs=0..20000`.
Discovery uses read-only queue/capacity observation and returns `204` or
`{jobId, submissionRevision, previousExecutionId}` with `Cache-Control: no-store`.
The prior UUID is required and may explicitly be null. At cutoff no candidate
is assigned. Each probe refreshes Kubernetes observation; pauses are capped at
one second. Authentication starts within the same 30-second request budget.

A claim posts the last two candidate fields to
`/deployments/{deploymentId}/jobs/{jobId}/claim`, with a new execution UUID in
`Idempotency-Key`. Its transaction authenticates the candidate against current
Job and execution history, resolves matching replay before readiness/capacity,
commits due unclaimed expiry before returning stale, or commits queued-to-running
and the start event together. It returns `{jobId, executionId}` and never `204`.
The same UUID with a changed successful binding is a conflict. Historical UUID
reuse returns `WORKLOAD_EXECUTION_USED`. Only proven obsolete candidates return
`WORKLOAD_CANDIDATE_STALE`; generic `WORKLOAD_CONFLICT`, authorization, missing
resources, transport errors, and malformed responses preserve pending SDK state.
Acquisition timeout is a per-call waiting preference; an already attempted claim
may resolve after it within the elapsed request budget. It is not a durable lease.

The execution UUID is a concurrency fence, not a credential or resource.
`current_execution_id` remains stable through cancellation, outcome, and
cleanup. A later `retrying -> queued -> running` cycle overwrites it with a
fresh UUID, and resubmission clears it before the next execution. Every
lifecycle write uses a Job-row CAS over Job ID, target, expected state, and
current UUID, so an old process cannot publish an outcome for a newer
execution. The projected ServiceAccount token authenticates the process.

User termination keeps the existing two-axis lifecycle: it publishes
`terminated` immediately and leaves `cleaned_at` pending only when local work
may still exist. A queued or retrying Job cleans immediately even if an older
execution UUID remains. A running Job retains the UUID until the matching
in-Deployment process confirms cleanup or Kubernetes proves that the runtime
identity recorded by the matching execution-start event is absent or replaced.
The execution report and termination writes share one transactional ordering
point. If an ordinary completed, errored, invalid, or retryable report wins, its
outcome remains authoritative and releases capacity. If termination wins, a
matching report preserves `terminated` while setting `cleaned_at`, because the
report confirms that execution stopped. Stale UUIDs cannot release capacity. A
terminal outcome is idempotent, and an exact cleanup retry succeeds. Merely
requesting Pod deletion or temporarily failing to read Kubernetes is not
confirmation. There is no new cancelling state or cancellation record, and
resubmission remains blocked while cleanup is pending.

No time-based lease or heartbeat is required in this RFC. A healthy but
partitioned runtime retains its execution rather than causing speculative
duplicate execution. Runtime replacement, Pod replacement, explicit failure,
cancellation, or an explicit application outcome can resolve the Job.

### In-workload API

A jobs Pod receives its target Deployment ID and Anycloud API URL plus a
Kubernetes projected ServiceAccount token with an Anycloud-specific audience.
Runtime operations name that target. Anycloud resolves its Cluster, submits the
token to that Cluster's
[TokenReview API](https://kubernetes.io/docs/reference/kubernetes-api/definitions/token-review-v1-authentication/),
validates the expected audience,
ServiceAccount, namespace, and bound Pod UID, and then verifies the Pod's
deterministic target label, desired-generation annotation, and workload
container status. Kubernetes therefore supplies both authentication and
runtime identity; Anycloud stores no custom workload credential or registration
record.

[Kubernetes recommends TokenReview](https://kubernetes.io/docs/concepts/security/service-accounts/#authenticating-service-account-credentials-in-your-own-code)
rather than offline OIDC validation for an external verifier because it checks
that a token's bound object still exists. The exact verifier remains a
Cluster-runtime capability so adopting an equivalent Pod-bound identity system
later does not alter Deployment or Job persistence.

The workload uses five scoped, authenticated HTTP operations:

```text
GET  /v1/deployments/{deploymentId}/jobs/candidate
POST /v1/deployments/{deploymentId}/jobs/{jobId}/claim
GET  /v1/deployments/{deploymentId}/jobs/{jobId}/cancellation
POST /v1/deployments/{deploymentId}/jobs/{jobId}/outcome
POST /v1/deployments/{deploymentId}/jobs/{jobId}/cleanup
```

Their stable OpenAPI operation IDs are `discoverDeploymentJobCandidate`,
`claimDeploymentJob`, `getDeploymentJobCancellation`,
`reportDeploymentJobOutcome`, and `cleanupDeploymentJob`.
Schemas explicitly document their workload security scheme, UUID replay
behavior, `200`/`204` success responses, and `400`/`401`/`403`/`404`/`409`/`503`
errors as applicable. No path, schema, property, operation ID, tag, or generated
symbol uses Assignment terminology. OpenAPI remains the wire authority, while
the generated SDK exposes each operation and Python workflow helpers compose
discovery and claim.

The same `anycloud-sdk` distribution used by the external operator exposes one
in-Pod entry point:

An illustrative application adapter is:

```python
import anycloud

with anycloud.current_deployment() as deployment:
    job = deployment.next_job()
    if job is not None:
        try:
            reservation = app.lookup(job.id)
            session = app.attach(reservation)
            session.wait()
            job.complete()
        except TemporaryError as error:
            job.retry(str(error))
        except InvalidReservation as error:
            job.invalid(str(error))
        except Exception as error:
            job.error(str(error))
```

`current_deployment()` reads the injected Deployment ID, API URL, and projected
token path and returns a `DeploymentContext`. `next_job()` makes one logical
request and returns `CurrentJob | None`. `CurrentJob` exposes `id`,
`cancellation_requested()`, `complete()`, `error()`, `invalid()`, `retry()`, and
`cleanup()`. It carries `executionId` privately; that value is not a public
property, constructor argument, or application concern. `CurrentJob` avoids a
`JobContext` name that collides with common application frameworks.

The helper rereads the rotating projected token for requests and internally
retries an ambiguous claim with the same complete candidate and UUID tuple. It does not start
background tasks, choose concurrency, perform reservation lookup, retry
application work, or own liveness. The application may issue several
`next_job()` calls when it can safely handle concurrent Jobs. The workload is
not required to run an Anycloud CLI, sidecar, agent, executor, dispatcher, or
handler process. Non-Python workloads may implement the documented raw HTTP
contract directly.

The runtime only requests another Job when the application has capacity. The
API also atomically prevents more than
`max_concurrent_jobs_per_replica` current executions from remaining unreleased
in the fixed-one-replica implementation. This includes Jobs in `running` and
terminal Jobs with a current execution whose cancellation cleanup is still
pending.

The application calls `next_job()` only after its process is ready to accept
work. The next-Job loop is part of the application's critical process
lifecycle: if it dies, the process must exit so Kubernetes replaces the
container. An optional native exec probe can express application readiness;
container readiness without that configuration leaves application readiness
unknown. The application continues to own its work and concurrency.

### Recovery

Execution-start events record the execution UUID, desired generation,
Kubernetes Pod UID, and the workload container's Kubernetes `containerID`.
Kubernetes workload
reconciliation uses current Pod status to detect:

- deletion or replacement of the executing Pod;
- restart of the workload container inside the same Pod; and
- an explicit application failure after next-Job selection.

Nonterminal Jobs executing on a replaced identity move through `retrying` to
`queued`, subject to the existing bounded retry policy. The existing generic
workload reconciler retains retry-event counting, backoff, exhaustion, and
revision fencing. Its targeted branch runs before credential or runtime resolution: it
either uses the existing fenced `retrying -> queued` operation or publishes
`failed` when the retry budget is exhausted. It never tears down the shared
Deployment or its Pod for one Job retry. A later next-Job call writes a new
`current_execution_id`.

A terminal Job with `cleaned_at IS NULL` takes a separate branch. If Kubernetes
shows that the Pod UID or container ID stored on the execution-start event for
its `current_execution_id` is absent or was replaced, the reconciler completes
`cleaned_at` without another Job state transition. The write is fenced by the
Job-row execution ID, so an observation of an older identity cannot release
newer work. API restart recovery reconstructs both the nonterminal retry branch
and this terminal cleanup branch from Job state, `current_execution_id`, the
matching `workload_events` metadata, current Pod identity, and container
status.

This provides durable recovery from observed execution loss without a new Job
attempt table. It deliberately does not retry merely because the control plane
temporarily cannot reach an otherwise-live Pod.

### Dedicated and targeted Job funnel partition

`deployment_id` divides two execution funnels. The distinction must be
made at each store query and domain gate, not only immediately before provider
provisioning:

| Funnel or query                                                            | Dedicated Job                           | Targeted Job                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listQueued` `lane_load`                                                   | Counts direct-provider pipeline work    | Excluded so persistent-Deployment work cannot distort lane fairness                                                                                                    |
| `listQueued` ranked candidates                                             | Eligible for the direct scheduler       | Excluded; only Pod-authenticated next-Job selection may start it                                                                                                       |
| `countDeploying`                                                           | Counts against the 50-slot setup limit  | Excluded in every state                                                                                                                                                |
| `listWorkloadReconcileCandidates` and `getWorkloadReconcileCandidate` arms | Retain current active-recovery behavior | `running` remains discoverable for current-execution observation and is classified before direct active recovery or VM polling; `starting` is unreachable              |
| API-restart `activeRecoveryNow` kick                                       | Retains current recovery behavior       | Cannot override target classification; Kubernetes execution observation owns nonterminal retry and terminal cleanup                                                    |
| `getRetryCandidatesByIds`                                                  | Reuses existing retry facts             | Reuses the same facts only after target classification, then takes the targeted retry branch before provider work                                                      |
| Running poll                                                               | Retains current Job/VM observation      | Excluded; Kubernetes and the current execution-start event supply observations                                                                                         |
| Terminal cleanup                                                           | Retains VM/runtime cleanup              | In-Pod acknowledgement or execution-fenced observation of current runtime absence/replacement sets `cleaned_at`; it never retries the Job or tears down shared runtime |
| `anycloud status` `getWorkloadOperations` gate                             | Retains current workload operations     | Does not call per-Job runtime or VM health operations; combines Job events with target Deployment observation                                                          |

The list and single-item reconcile-candidate queries must encode equivalent
arms. A table-driven unit specification enumerates state by nullable/non-null
`deployment_id` and pins query membership, reconcile classification,
provisioning-slot counts, and health-operation calls. End-to-end API-restart
coverage supplements this matrix; it does not replace it because lane weighting
and exact slot counts are not deterministic E2E observations.

### Session customer mapping

One customer model and resource configuration maps to one jobs Deployment.
The session customer translates its model/hardware matrix into generic resources and
`max_concurrent_jobs_per_replica`.

Before submitting a Job, the session customer creates a Supabase reservation associated
with an Anycloud-valid Job ID. It then submits that ID to the target Deployment.
The executing Pod receives the Job ID and queries the exact reservation. The
reservation can contain the session reference, dispatch token, and other
customer-owned data; Anycloud does not interpret or duplicate it.

Successful attachment moves the Job to `running`. The Job continues to occupy
application capacity for the session lifetime and becomes terminal when the
local adapter reports the outcome.

Supabase remains authoritative for session and business data. It is not the
queue: the Pod may not query for an arbitrary unselected reservation, reserve a
free row, or dispatch the same session to another model process.

Under O9, the session customer does perform that selection in Supabase. Anycloud then
cannot observe authoritative backlog or execution and cannot drive RFC 0030
from Job state. O9 and O19 are mutually exclusive selection models.

### Storage and ordinary Jobs

RFC 0029 targeted Jobs carry only identity. Admission rejects their existing
input, output, and checkpoint bucket options. This prevents a shared long-running
Pod from pretending that current container-global bucket mounts remain
Job-isolated.

The existing bucket fields stay Job-owned and are the future compatibility
seam. A later RFC may define isolated shared-process workspaces, output
finalization, and common read-only caching without changing the
Job-to-Deployment relationship. Deployment-owned model weights remain in the
image or another revision-scoped asset mechanism.

A one-slot Deployment is likewise only a convergence point for ordinary work.
RFC 0029 does not automatically turn `Job(image, command, resources)` into a
reusable Deployment and does not promise fresh-process isolation.

### Kubernetes and Cluster mapping

One Deployment targets one Cluster for its lifetime. O19 initially reconciles
an `apps/v1` Deployment with `spec.replicas = 1`; the Kubernetes scheduler
selects a Node.

The first implementation supports RFC 0015 managed Clusters through RFC 0014's
runtime resolver. That resolver remains authority-neutral so a future attached
Cluster can use the same public Deployment and Job schemas. RFC 0029 does not
implement Cluster attachment or grant Node authority.

This RFC does not select across Clusters, create a different Cluster kind, or
target a provider without Kubernetes. Moving a workload requires a new
Deployment.

### Fixed reconciliation and observations

```text
desired target 1 -> Kubernetes workload reconciliation -> apps/v1 Deployment
Kubernetes scheduler -> actual Pod
```

Reconciliation applies the desired generation using deterministic Kubernetes
identity. Kubernetes creates or replaces the Pod. Detailed status queries the
runtime and exposes:

- current Pod, observed Kubernetes container readiness, and Pending reason;
- requested, applied, and Pod generations, native application readiness, and
  warmup/draining/replacement explanations;
- at most ten blocking Job IDs and their total from one SQLite snapshot;
- queued, running, retrying, and terminal Job counts; and
- configured capacity and derived unused capacity.

For the fixed target, derived unused capacity is:

```text
max(0, max_concurrent_jobs_per_replica - unreleased_current_executions)
```

`unreleased_current_executions` counts targeted Jobs in `running`, plus a
terminal Job with a current execution whose `cleaned_at` fence still awaits
confirmation that its local task stopped. This is the same predicate used by
next-Job admission, status, drain, and deletion; a terminal state transition
cannot transiently create a free slot.

Backlog never changes the target in RFC 0029.

Individual status bounds runtime resolution and observation to one second and
returns unknown runtime facts when unavailable. List and mutation responses do
not request live status. Status does not run an exec probe. Receiver Pod watches
require namespace-scoped `watch` access in addition to existing Pod reads,
share one stream per watched Cluster, and relist on interruption or expired
resourceVersion. They retain subscriptions and transport state without caching
Pod readiness. Local measurements and promotion ownership are recorded in
[the readiness qualification record](evidence/1127-status-readiness.md).

List operations use the desired database record and do not fan out to every
Cluster. Apply failures are rejected by admission when deterministic; transient
reconciliation failures are retried and logged. Kubernetes Conditions and
Events remain the durable diagnostic source for accepted objects rather than a
scalar Anycloud `last_error` cache.

### Update, drain, and deletion

Deployment updates validate the proposed template against Kubernetes and then
atomically persist it with an incremented `generation`. A jobs update thereby
prevents the old generation from selecting new Jobs and waits for its
active Jobs. After drain, reconciliation applies the new Pod template using a
no-surge replacement strategy. Queued Jobs remain queued through the gap and
resume after the new application becomes ready. Draining is derived from the
generation mismatch and active Job events; it is not a stored Deployment state.

Deletion first persists `deletion_requested_at`. That fact rejects new input,
terminates queued Jobs, and drains active Jobs before reconciliation deletes
subordinate Kubernetes resources. An update or deletion that still has active
Jobs or pending targeted-Job cleanup is reported as draining. An operator can
use the existing `anycloud terminate JOB_ID` operation on individual Jobs to
unblock it; the rollout then waits for cancellation cleanup to finish. This RFC
adds no Deployment-level force, bulk cancellation, or drain timeout. Deleting a
Deployment never deletes its Cluster or Cluster-owned VMs.

### Persistence

O19 removes the obsolete direct workload target:

```text
remove deployments.cluster_id
```

That column represented the deleted Kubernetes Job and Service paths. It is
not retained for targeted Jobs, which resolve their Cluster transitively.
`vms.cluster_id` remains the ownership relationship for real managed Node VMs.
Cluster deletion consequently checks `deployments` and `vms`, never
the generic `workloads` table.

The persistent resource was initially `cluster_deployments`, then `workers`
after migration 0100. Migration 0106 gives it the current `deployments` name,
following the shared-record rename to `workloads` in migration 0105. The renames
preserve active and deleted resources, targeted Jobs, execution fences, and event
history. This original table sketch uses current resource names; the shared
container-spec model in [RFC 0036](./0036-job-deployment-configuration-authority.md)
replaces its `template` column:

```text
deployments
  id
  owner_user_id
  name
  cluster_id
  template
  max_concurrent_jobs_per_replica
  generation
  deletion_requested_at
  deleted_at
  created_at
  updated_at
```

`name` is the display and active lookup name; active names are unique
case-insensitively across the hosted API. Names resolve active rows only, while
retained deleted history is addressable by immutable ID. A name may be reused
after deletion completes. `owner_user_id` keeps the existing top-level-resource
authorization and attribution boundary, while `cluster_id` owns immutable
placement. Neither is inferred from the other.

`template` is the canonical desired Pod-template configuration and is encrypted
at rest because environment and private-registry authentication are sensitive.
Named application Secret references live beside `template` as names;
their values stay in the secrets store and are materialized into an
application-env Kubernetes Secret on reconcile. Every Deployment accepts Jobs and requires
positive `max_concurrent_jobs_per_replica`; RFC 0032's cluster-backed Service
does not add fields to this table. There is no stored input-kind discriminator,
replica count, lifecycle state, endpoint, `last_error`, applied generation,
Pod/container observation, runtime registration, or workload credential.

The only schema additions to existing Jobs are:

```text
workloads.deployment_id NULL
  REFERENCES deployments(id) ON DELETE RESTRICT

workloads.current_execution_id TEXT NULL

workloads.submission_revision INTEGER NOT NULL DEFAULT 0
workloads.claim_deadline_at INTEGER NULL
workloads.first_claimed_at INTEGER NULL
```

`current_execution_id` has a partial unique index where non-null. UUID syntax
is enforced at the contract/application layer and SQLite uniqueness closes
concurrent replay races. A new targeted Job starts with null; next-Job selection
writes it, resubmission clears it, and a later retry execution overwrites it.
It is current Job state, not a foreign key or a new execution resource.

Explicit resubmission advances `submission_revision` and replaces or clears
`claim_deadline_at`. The first claim sets `first_claimed_at`; automatic retries
preserve that evidence and revision, while explicit resubmission clears it.

Deployments are soft-deleted so Job history retains its target. The
restricting foreign key also prevents a targeted Job from silently becoming a
dedicated Job or losing its execution context. Cluster deletion is blocked
while any referenced Deployment lacks `deleted_at`; after deletion the
row remains available to historical Jobs.

No separate `jobs` table is introduced. If Job persistence is normalized in a
future change, one canonical subtype must cover every Job rather than creating
a second persistence path only for Deployment-targeted Jobs.

Existing `workload_events` stores state history plus execution-start metadata:
the execution UUID, claimed submission revision and previous UUID, desired
generation, Pod UID, and container ID. Event IDs
remain internal audit identities and never cross the workload wire. There is no
payload, Assignment, Execution, claim, lease, heartbeat, Job-attempt, Queue,
Slot, Replica, or revision table, and runtime observations are not duplicated
onto the Job row.

Shared Job, Service, and VM records use `workloads` and `/v1/workloads` after
an earlier rename. Persistent applications use `deployments` and `/v1/deployments` after
a later rename. These are separate persistence and API resources; the former Worker
names have no compatibility aliases.

### Reuse and required implementation

The current Job implementation is reused at the durable record and management
boundaries, not as the persistent Deployment execution runtime:

| Concern                            | Reused                                                                                             | Targeted-Job adaptation                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and ownership             | Job ID, `workloads` row, ownership, attribution                                                    | Add only `deployment_id` and `current_execution_id`; create through narrow target admission                                                                                           |
| State and history                  | Existing state names, `workload_events`, transactional CAS helpers                                 | Add targeted-only next-Job and current-execution outcome operations; do not widen the global FSM                                                                                      |
| Provisioning admission             | Dedicated Job scheduler remains unchanged                                                          | Exclude targeted Jobs from queued selection, setup counts, active-step recovery, and provider resolution                                                                              |
| Retry                              | Retry-event counting, bounded backoff, exhaustion, revision fencing, and `retrying -> queued`      | Branch before credential resolution and VM/runtime teardown                                                                                                                           |
| Termination                        | Existing owner-authorized `requestTermination`, `terminated` event, and asynchronous cleanup fence | In-Pod application stops the current task and confirms cleanup; identity loss is equivalent confirmation; Job cleanup never stops the shared Deployment                               |
| Resubmission                       | Existing eligible terminal states, cleanup fence, row reset, and resubmission event                | Validate the target still accepts Jobs, skip Job-owned credential/secret preflight, and execute against the target's current generation                                               |
| Status and wait                    | Existing Job row, events, list, status, and SDK/CLI wait behavior                                  | Expose the target Deployment identity; skip VM health polling and return no synthetic VM observation                                                                                  |
| Terminal cleanup                   | Existing `cleaned_at` fence and no-live-VM check                                                   | Complete immediately when no execution runs; running termination waits for cancellation confirmation or identity loss; never invoke Job runtime teardown or delete Deployment objects |
| Logs, exec, SSH, buckets, and cost | Dedicated Job behavior remains unchanged                                                           | Reject per-Job exec/SSH/buckets, expose only event diagnostics, and do not attribute shared Cluster VM cost to the Job                                                                |
| Authentication                     | Existing operator authentication and ownership scope                                               | Use a projected Kubernetes ServiceAccount token, TokenReview through the target Cluster, and bound Pod observation; store no second credential or registration                        |

The existing workload reconciler remains the timing owner for targeted Job
retry and terminal cleanup. It must not discover targeted `running` rows as
direct deploy-pipeline or completion-poll work; targeted `starting` is
unreachable. Kubernetes
workload reconciliation observes Pod/container replacement through the generic
runtime resolver and uses target-specific Job transitions to publish retryable
runtime loss. This RFC specifies that seam, not a new required reconciler class
or service boundary.

Cluster runtime resolution, Kubernetes clients, ownership metadata, and Pod
construction helpers are reused. Real VM provisioning and accounting remain
in RFC 0015's managed Cluster Node path. Targeted Jobs never create a `vms`
row, enter `JobRuntime`, or reuse the unused Kubernetes Job and Serve workload
implementations.

The implementation may land as one integrated pull request. Its ordered
migrations remove the obsolete target before adding the new relationships, and
its final code removes the obsolete model rather than retaining a compatibility
path:

- remove the `job --cluster` and `service --cluster` interfaces and admission
  branches;
- delete the unused Kubernetes Job and Serve runtime implementations;
- make the existing Job and VM-host Service paths direct-provider-only;
- remove `deployments.cluster_id` plus its indexes and query dependencies; and
- retain Cluster management, generic Kubernetes runtime resolution and
  clients, Pod construction helpers, and `vms.cluster_id`.

The existing `managedKubernetes('kubernetes')` E2E contract is rewritten in
place as the end-to-end testbed. It retains managed Cluster lifecycle,
placement, replacement, isolation, and deletion coverage, then creates a jobs
Deployment and submits Jobs to it. The old
Kubernetes Job and Serve adapters and assertions are deleted, not skipped. The
same rewritten contract continues to drive the per-PR local gate and the
operator-dispatched cloud qualification.

The 2026-09-09 amendment adds the `mace-cuda` workload profile to that same
contract. GPU-count admission and manifest translation alone did not prove a
schedulable, CUDA-capable managed Deployment. S21 and S22 require real numerical
inference, warm model reuse, and recovery on actual GPU capacity. Host and
capacity placement are inputs to the same reusable qualification workflow as
CPU execution. The exact API, CLI, and SDK artifacts intended for publication
must pass the full shared contract and tracked teardown, with a matching
receipt as specified in
[RELEASE.md](../RELEASE.md).
The same amendment aligns Deployment GPU intent and runtime selection with VM
Jobs; Kubernetes resolves each request to an integer for scheduling.

Narrow tests prove that dedicated Jobs, VMs, VM-host Services, and managed
Cluster lifecycle remain unchanged. The integrated implementation adds:

- `deployments` CRUD, reconciliation, status, drain, and deletion;
- the nullable Job target and scheduler split that keeps targeted Jobs out of
  VM provisioning;
- atomic next-Job and conditional lifecycle operations using Job state,
  `current_execution_id`, and execution-start events;
- the in-workload HTTP contract and Kubernetes-projected runtime
  authentication; and
- replacement tests and documentation for the new workload model.

## Industry terminology

[Kubernetes](https://kubernetes.io/docs/concepts/workloads/) separates
controllers, Pods, Nodes, and networking Services. SkyPilot Pools, dstack
Fleets, AWS Batch compute environments, Cloud Run services, Porter
applications, and Nomad node pools demonstrate adjacent queue, capacity, and
long-running-workload models. None requires Anycloud to expose those infrastructure
nouns for this relationship; the option registry records the alternatives.

## Relationship to existing RFCs

- [RFC 0006](./0006-single-reusable-vm.md) explores sequential Jobs on one
  explicit VM. O19 keeps its isolation questions but does not expose that VM as
  the Job target.
- [RFC 0014](./0014-kubernetes-runtime-resolution-boundary.md) owns
  request-aware Kubernetes runtime resolution. O19 keeps that boundary while
  replacing the concrete Job/Serve runtime bundle.
- [RFC 0015](./0015-anycloud-managed-kubernetes-clusters.md) owns Cluster
  identity, runtime access, fixed managed capacity, and the real VM ledger.
  O19 uses its managed Cluster target.
- [RFC 0016](./0016-managed-kubernetes-vm-autoscaling.md) owns managed Node
  scaling from Pending Pods. O19 can create Pending Pods but neither requires
  nor replaces that policy.
- [RFC 0032](./0032-kubernetes-ingress-deployments.md) proposes Cluster
  placement, autoscaling, and required networking for the existing
  Service. It does not add a Deployment mode or selector.
- [RFC 0033](./0033-peer-networkless-jobs-capacity.md) removes peer
  networking from jobs capacity. The O19 implementation sets
  `dnsPolicy: Default` in its Pod template and asserts no cross-node behavior
  in the rewritten workload E2E contract.

No RFC changes status merely because RFC 0029 is Proposed.

## Follow-up Deployment autoscaling

[RFC 0030](./0030-kubernetes-deployment-autoscaling.md) may extend an accepted
Deployment with policy:

```text
jobs Deployment:
  queued Jobs + unreleased current executions
  max_concurrent_jobs_per_replica
    -> desired replicas
```

That RFC owns minimum and maximum replicas, scale-to-zero, warm floors,
stabilization, cooldown, and scale-down selection. For the session customer, it consumes
targeted Job state; Supabase reservation count is not an O19 scaling input.

Managed Node autoscaling remains RFC 0016:

```text
RFC 0030 -> more Pods
Kubernetes scheduler -> Pending Pods
RFC 0016 -> more managed Cluster VMs
```

## Risks and caveats

- Delivering Jobs to a long-running process requires application integration;
  an arbitrary container image does not automatically call the scoped next-Job
  protocol.
- A Job ID is the only v0 invocation input. Applications that need inline
  self-contained messages require a later payload contract.
- Application data lookup is now on the invocation path. The session customer must handle
  a missing, late, or unavailable Supabase reservation explicitly.
- Recovery depends on trustworthy Kubernetes Pod/container observation and
  application liveness. A live-looking but stuck next-Job process can retain
  Jobs until liveness, cancellation, or an explicit application outcome
  resolves it.
- A terminated execution retains capacity while Kubernetes cannot confirm its
  recorded runtime identity is absent or was replaced. This safety bias must
  recover when Cluster observation returns; a transient observation failure
  cannot release work speculatively.
- At-least-once recovery can repeat external effects. Stable Job and execution
  IDs let applications make attachment idempotent but do not promise
  exactly-once execution.
- A one-slot limit prevents overlap but does not provide a fresh process,
  filesystem, or kernel boundary.
- Shared-process targeted Jobs do not automatically inherit per-container logs,
  artifact finalization, or per-Job infrastructure costing.
- Fixed warm Pods spend money while idle. RFC 0029 exposes that ownership but
  does not optimize it.
- The session customer must choose one selection authority. Running Supabase selection and
  Anycloud selection concurrently can duplicate sessions.
- The shared `workloads` lifecycle table and `/v1/workloads` operations own
  Jobs, Services, and VMs. The Deployment record has its own
  `deployments` table and `/v1/deployments` operations. Native Kubernetes
  Deployment objects retain their Kubernetes kind and use qualified names in code.

## Non-goals before acceptance

- automatic or manual replica-count changes;
- cluster-backed Services or any request-serving Kubernetes implementation
  (deferred to RFC 0032);
- changing RFC 0016's managed-Node policy;
- attached-Cluster implementation;
- cross-Cluster placement, failover, or global routing;
- a public Pool, Fleet, Queue, Claim, Replica, Slot, or native Kubernetes
  Service;
- a separate `jobs` persistence table;
- a public Assignment, Execution, Runtime, or Resident SDK resource;
- a mirrored Deployment lifecycle, scalar `last_error`, endpoint cache,
  runtime-registration record, or custom workload-token store;
- inline targeted-Job payloads;
- targeted-Job bucket synchronization or finalization;
- a fresh Kubernetes Pod for each targeted Job;
- automatically converting current Jobs to one-slot Deployments;
- compatibility aliases or record migration for unused Kubernetes workloads;
- per-Job logs or infrastructure cost allocation inside a shared process;
- moving the session customer's session schema into Anycloud; or
- requiring YAML, templates, profiles, or Kubernetes manifests.

## Open questions

No RFC 0029 implementation question remains open. The application owns its
critical next-Job loop and exits when that loop fails. Python uses flat
Deployment CRUD plus targeted `submit`, `Deployment` response values,
and the scoped `current_deployment().next_job()` integration. Deployment autoscaling,
cluster-backed Services, attached-Cluster selectors, and shared-process storage
remain in their own RFCs or future work.

## Tracking

O19 is promoted for implementation validation. This revision remains the
normative design and acceptance record for the implementation now on main.
The canonical execution checklist must be added to the **Anycloud Release**
project; it owns implementation progress while this RFC owns the design and
acceptance contract. An earlier pull request shipped the integrated
implementation; subsequent naming changes established the
Workload and Anycloud Deployment terminology used at that time. A later pull request landed the 2026-09-03
GPU-count contract correction. Another pull request introduced the earlier
Worker name. Shipped implementation does not change the RFC's `Proposed`
status, and issue or PR closure alone does not satisfy the
[acceptance scenarios](#acceptance-scenarios).

## Change log

- **2026-10-10 (amendment):** The owner reversed "exactly one replica,
  no manual replica control". A Deployment takes a fixed `--replicas N`
  (default 1) on create and update, rendered as the native Deployment's
  `replicas`. Admission reserves `gpu_count × replicas`, and each replica must
  still fit on one Node. Every replica claims Jobs up to
  `max_concurrent_jobs_per_replica` of its own, and a replica-count change is
  a new generation that drains first, like any update. Autoscaling stays with
  RFC 0030.

- **2026-09-09:** Added real managed-Kubernetes MACE CUDA inference and
  recovery acceptance, including warm reuse, replacement VM evidence, and
  exact-artifact release qualification. GPU admission tests alone had not
  exposed missing device registration and runtime selection. Aligned Worker
  GPU defaults, `all`/positive-count inputs, and canonical Docker options with
  VM Jobs, with explicit validation of managed runtime limitations.

- **2026-08-28:** Opened the decision frame and option registry with no
  promoted candidate.
- **2026-08-31:** Narrowed to O19's exclusive-input Kubernetes Deployment and
  retained prior primitive options as decision history.
- **2026-09-01:** Renumbered after RFC 0028 landed, removed compatibility for
  the unused Kubernetes workload paths, and fixed RFC 0029 Deployments at one
  replica.
- **2026-09-01:** Tightened O19 to reuse existing Job rows and events, with
  `cluster_deployment_id` as the only Job schema addition, Job-ID-based
  application lookup, event-backed execution, and no payload, claim, lease,
  heartbeat, or attempt table.
- **2026-09-01:** Made jobs mode the default when ingress is absent and kept the
  Python SDK flat and transport-oriented, without input-mode wrappers, resource
  namespaces, or an SDK-owned execution loop.
- **2026-09-01:** Promoted O19 for implementation validation and made removal
  of the unused direct Cluster workload paths and `deployments.cluster_id` a
  prerequisite, while retaining `vms.cluster_id` for managed Node ownership.
- **2026-09-01:** Audited the production Job machinery, limited reuse to its
  durable record, management, retry timing, and cleanup fences, made execution
  target-guarded, and removed Deployment-level force and timeout.
- **2026-09-01:** Reframed implementation as one integrated change with ordered
  migrations and an in-place rewrite of the shared local and cloud managed-
  Kubernetes E2E contract instead of a separately landed stage-zero gate.
- **2026-09-01:** Made Kubernetes authoritative for live workload facts, removed
  the proposed Deployment FSM, error and endpoint caches, runtime registration,
  and custom workload credential, and grounded execution identity in projected
  ServiceAccount authentication plus observed Pod/container state.
- **2026-09-01:** Synchronized the promoted candidate with implementation
  planning: counted unreleased executions, enumerated every direct/targeted Job
  funnel, pinned duplicate-ID, stored-version, runtime HTTP, and exact
  execution-event semantics, and required same-change implementation tracking.
- **2026-09-01:** Closed terminal-execution liveness by making observed current
  runtime absence or replacement complete `cleaned_at`, while retaining event
  fencing and reserving retry exclusively for nonterminal Jobs.
- **2026-09-01:** Narrowed the RFC to jobs mode: retitled it, moved the ingress
  Deployment, its subordinate networking, and its scaling follow-up to RFC
  0032, kept the `ingress` wire selector reserved and rejected as deferred,
  and removed `ingress_port` from the persistence model.
- **2026-09-01:** Selected an earlier synchronous, scoped runtime SDK facade
  while leaving selection loops, concurrency, retries, and application liveness
  with the persistent Deployment application.
- **2026-09-01:** Replaced that facade with
  `current_deployment().next_job()`, folded start into idempotent next-Job
  selection, stored its execution UUID directly on the Job row, removed the
  ingress placeholder, and linked the implementation checklist.
- **2026-09-01:** Linked the integrated implementation after
  repository, Python SDK, API-wire, and local managed-Kubernetes validation.
- **2026-09-01:** Deferred named application Secrets, made next-Job UUID reuse
  survive ambiguous failures across caller invocations, defined atomic
  report/termination ordering, and required hosted API upgrade parity.
- **2026-09-03:** Made the Cluster VM type the accelerator-model authority and
  narrowed Deployment placement to an explicit nonnegative GPU count, with
  omission permitted only for catalogued CPU capacity.
- **2026-09-03:** Renamed the persistent Job workload to Worker throughout its
  public contracts and storage, retained Kubernetes Deployment terminology,
  and moved request-serving Cluster placement exclusively to the existing
  Service resource in RFC 0032.
- **2026-10-04:** Amended R7 and S16: Deployments accept named
  application Secret references, expose only their names, and project the
  values through one owned application-env Kubernetes Secret.

## Decision

O19 is implemented and shipped but not yet accepted as an RFC decision. This
section will record the final acceptance call, date, and rationale after the
shipped candidate has been validated against the
[acceptance scenarios](#acceptance-scenarios). The approved one-replica scope
and decision requirements are unchanged by consolidating the checklist.

### Discovery and claim amendment

This amendment implements first-claim deadlines and look-then-claim from main;
it does not change the RFC's overall Pending review decision. An acquisition
table would require permanent bookkeeping for empty requests. One Deployment ticket
would serialize otherwise independent capacity, and persistent SDK empty-request
records would move durable authority into each client. Leases add ownership
expiry and handler interruption requirements; they remain outside this change.
[TaskFlow's discovery and claim API](https://docs.openstack.org/taskflow/latest/user/jobs.html#usage)
is a mechanism precedent. Its optional Redis ownership expiry is separate from
our submission deadline and resubmission guarantees.
