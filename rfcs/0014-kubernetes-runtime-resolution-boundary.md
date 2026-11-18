# RFC 0014: K8 runtime resolution boundary

> Status: Accepted
> Date: 2026-08-16
> Author: Codex draft
> Accepted: 2026-08-16 after the resolver cutover shipped.

## Summary

Put every production entry point for a workload-scoped k8 workload operation
behind a request-aware runtime resolver while preserving the current
single-cluster behavior.

The resolver introduced here still returns the process-default k8 clients and
runtimes. This RFC adds no persistence, public cluster commands, placement
behavior, or multi-cluster support. It establishes the boundary a later cluster
management RFC can replace without rewriting workload lifecycle code.

## Context / problem

Today the API process discovers one cluster from its environment:

```text
KUBECONFIG or in-cluster identity
  -> default k8 clients
  -> default Job and Serve runtimes
  -> k8 workload operations
```

The workload implementations are already appropriately k8-specific. Native
Jobs and Serve resources have deterministic ownership, cleanup is confirmed
through `cleaned_at`, and these workloads create no `vms` rows.

The limiting assumption is that callers can independently recover a
process-global runtime. If managed cluster selection is added while that
remains true, deployment, polling, status, logs, exec, termination, and cleanup
would each need separate routing changes.

## Proposal

### Make runtime construction explicit

Separate the inputs currently combined by the default loaders:

- workload configuration, such as namespace and manifest policy;
- cluster access and API clients;
- the durable workload store.

In this RFC, a connected cluster means an already-resolved
`KubernetesClusterClient`: the Kubernetes API surface used by a runtime. It is
not a durable cluster record, credential, or placement target. Those domain
concepts remain deferred to the managed-cluster RFC.

Construct one bundle from those dependencies:

```ts
interface K8RuntimeBundle {
  job: KubernetesNativeJobRuntime;
  serve: ServeRuntime;
}

interface K8RuntimeBundleDeps {
  config: LocalKubernetesConfig;
  cluster: KubernetesClusterClient;
  jobStore: KubernetesNativeJobStore;
  serveStore: KubernetesServeStore;
}

declare function createK8RuntimeBundle(
  deps: K8RuntimeBundleDeps,
): K8RuntimeBundle;
```

The bundle is a composition unit, not a shared workload state machine. Job and
Serve retain their existing lifecycle implementations. The factory gives both
runtimes the same resolved configuration and cluster connection while keeping
their store ports explicit; a production caller may satisfy both ports with the
same workload store. Neither concrete runtime discovers cluster access.

Before request-aware resolution is introduced, Job status, logs, and exec move
behind a provider-neutral operations facade:

```ts
interface JobOperations {
  observeHealth(request: JobHealthRequest): Promise<JobHealthObservation>;
  prepareExec(request: JobExecRequest): Promise<JobExecPreparation>;
  prepareLogs(request: JobLogsRequest): Promise<JobLogsPreparation>;
}
```

This is provider dispatch and transport preparation, not a second lifecycle
abstraction. The route still owns health-check eligibility and timeout policy,
HTTP responses, NDJSON framing, abort propagation, and backpressure. Requests
carry the already-loaded workload and VM rows; adapters do not reload them
from the database. Prepared exec and log operations resolve their target before
the route writes response headers, then expose a `run(stream)` operation. Logs
also return typed `probeCount` and `targetContainerStatus` telemetry.

Concrete scheduler behavior remains on `KubernetesNativeJobRuntime`. The
Kubernetes operations adapter only translates the provider-neutral operation
requests to that runtime.

Only the production top-level default adapter may discover cluster access from
the process environment. Client, manifest, and lifecycle modules receive
explicit dependencies. Executable integration harnesses are separate test
composition roots and may discover their explicitly selected local cluster at
their entry point.

### Resolve by stored workload

Introduce a request-aware boundary:

```ts
interface K8RuntimeResolver {
  resolve(workload: StoredWorkload): Promise<K8RuntimeBundle>;
}
```

Every production entry point for a workload-scoped k8 workload operation for
which a `StoredWorkload` exists must resolve through this boundary using the
workload already owned by the caller. This includes Job and Serve lifecycle
operations, monitoring and reconciliation, status, logs, exec, termination, and
resubmission paths.

Provider-scoped operations that run before or without a stored workload are
outside this resolver contract. In this RFC, credential validation continues to
check the process-default connection. A future managed-cluster RFC must
define target-aware admission and any provider-wide inventory behavior.

`ExecutionModel.SchedulerNative` and `CloudType.Kubernetes` keep their existing
upstream routing roles. The resolver sits below provider selection; it does not
select an execution model or make an unregistered provider behave like k8.

### Preserve current behavior with one default adapter

The only production implementation in this RFC is behavior-preserving:

```text
StoredWorkload
  -> DefaultK8RuntimeResolver
  -> process-default k8 connection
  -> one cached K8RuntimeBundle
```

It may lazily initialize the bundle so VM-host workloads do not require a k8
configuration. It must preserve current namespace selection, API behavior,
state transitions, streaming, and cleanup semantics.

There is no persisted cluster identity or fallback chain. All requests resolve
to the same process-default bundle until managed cluster selection replaces the
adapter.

### Delivery

The implementation has three behavior-preserving stages:

1. Make client and runtime construction accept explicit dependencies, leaving
   environment discovery in one top-level adapter.
2. Move Job health, exec, and logs behind the provider-neutral operations
   facade. VM-host Jobs retain the existing SSH/Docker transport and native
   Kubernetes Jobs retain `KubernetesNativeJobRuntime`; only dispatch and
   transport preparation move out of the route.
3. Make lifecycle routers and the Kubernetes operations adapter resolve by stored
   workload, then remove the old default Job and Serve runtime accessors.

These stages are the entire implementation scope of this RFC.

## Required invariants and tests

- In production, `loadFromDefault()` is reachable only from the top-level
  default adapter. A live integration harness may load its local cluster only at
  its executable composition root.
- Every production entry point for a workload-scoped k8 workload operation
  resolves one bundle from its stored workload and does not recover clients
  through another path.
- Provider credential validation remains explicitly provider-scoped and does
  not invent a synthetic workload to enter the runtime resolver.
- Job and Serve routing remains fail-closed at the existing provider boundary.
- The operations facade receives already-loaded workload and VM data and
  performs no database reads.
- `cloudProvider === null` may retain the existing VM-host fallback. A stored
  Kubernetes Job always selects native Kubernetes operations; it never falls
  back to VM-host handling, including for Jobs created before native Kubernetes
  support.
- Health-check eligibility and timeout policy remain in the route, and exec/log
  target-selection failures occur before NDJSON headers are written.
- VM-host behavior, placement, storage semantics, and API responses remain
  unchanged.
- K8 workloads continue creating no `vms` rows.
- Focused tests prove explicit client construction, operations dispatch and
  preparation, request propagation through both lifecycle routers, resolver use
  by status/logs/exec, lazy default initialization, and retry after
  initialization failure.
- Existing Job and Serve tests remain behavior-equivalent.
- The live local k8 provider contract constructs `K8RuntimeBundle` from explicit
  configuration, cluster, and Job/Serve store dependencies; it does not call
  process-default runtime getters. As a provider contract, it may invoke that
  explicitly constructed bundle directly. It remains a live integration
  harness and retains its Job and Serve behavior assertions.

## Future managed clusters (non-normative)

A later RFC may add Anycloud-managed cluster records and an `anycloud cluster`
workflow. That work should replace the default adapter, not its callers:

```text
StoredWorkload
  -> managed cluster identity
  -> Anycloud-owned connection
  -> revision-keyed client cache
  -> existing K8RuntimeBundle
```

This sketch reserves no schema or CLI contract. The later RFC must decide the
data model, tenant constraints, connection rotation, VM ownership, capacity
control, legacy cutover, and multi-cluster isolation.

A future shared cluster command may dispatch by cluster type. That does not
require k8 and Slurm to share credentials, validation, clients, or lifecycle
code. A Slurm implementation should have its own concrete runtime and resolver;
shared persistence or resolver machinery should be extracted only after both
providers establish the same real contract.

## Non-goals

This RFC does not add or define:

- database migrations, cluster records, or workload target columns;
- cluster create, list, show, or delete commands;
- multiple-cluster selection or placement;
- stored credentials, rotation, identity persistence, or health persistence;
- managed control planes, cluster VMs, or autoscaling;
- a Slurm provider or generic scheduler-target abstraction;
- local test-cluster provisioning or replacement of live provider-contract
  harnesses;
- compatibility behavior for a future managed-cluster cutover.

## Alternatives considered

### Add managed clusters now

Persistence before the managed-cluster feature would force decisions about
identity, ownership, capacity, and migration that this RFC does not need.

### Introduce a generic scheduler-target resolver

K8 is the only shipped scheduler-native provider. A cross-scheduler abstraction
would have one implementation and no proven Slurm contract.

### Wait and refactor during cluster management

That would mix lifecycle rewiring with persistence and security policy. The
small request-aware seam is independently useful and behavior-preserving.

## Risks & caveats

- A missed direct default-runtime caller would preserve the global assumption;
  import searches and route tests must cover every production entry point for a
  workload-scoped k8 workload operation.
- The default resolver is intentionally a singleton-backed adapter today. Its
  request-aware contract must remain even though it ignores workload identity.
- Provider credential validation remains process-default because no stored
  workload exists at that point. Cluster management must introduce a
  target-aware admission input instead of forcing validation through this
  resolver.
- The future sketch validates extensibility but makes no compatibility promise;
  managed-cluster details require their own RFC.

## Open questions

None block this boundary. Persistence, command shape, and Slurm sharing are
explicitly deferred to the feature RFCs that can decide them from concrete
requirements.

## Decision

Accepted on 2026-08-16. Earlier changes made Kubernetes client
construction explicit, routed Job operations through a provider-neutral
facade, and moved every workload-scoped Job and Serve operation behind the
request-aware resolver. The shipped default resolver deliberately preserves
the process-default cluster until RFC 0015 replaces that adapter.
