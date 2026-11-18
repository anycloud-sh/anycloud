# RFC 0017: Contract-first constrained Vitest end-to-end tests

> Status: Accepted
> Date: 2026-08-17
> Amended: 2026-08-18, 2026-08-19, 2026-08-21, 2026-08-23, 2026-09-09, 2026-09-16, 2026-09-25, 2026-10-05
> Author: Anycloud maintainers

## Summary

Migrate the Bash integration scenarios to contract-first Vitest tests
incrementally. A shared product behavior is implemented once as a contract;
providers supply data and narrowly typed substrate operations but cannot
redefine lifecycle sequencing, assertions, retries, deadlines, diagnostics, or
cleanup.

Every constrained spec uses a mandatory automatic fixture and repository-owned
lint rules. Contract-member specs are thinner still: they may only select one
contract and one target and assert the contract's typed completion result. The
existing Bash scenario remains authoritative while its Vitest replacement runs
in an isolated shadow job. Promotion is recorded in this RFC after repeated
successful runs; there is no executable parity manifest and no generic output
comparator.

The target architecture is:

```text
thin target spec
        |
behavioral contract or extension
        |-- compatible family journey
        |-- family adapter --> private target transport
        |-- outcome-neutral probes and resource fixtures
        |-- tracked Workload, Deployment, or Cluster kernel
        `-- controller session --> process / API / CLI / wait mechanics
```

The Workload kernel is shared by Persistent VM, VM-host Service, dedicated Job,
and Deployment-targeted Job contracts. It owns
identity, pre-mutation cleanup registration, status/event reads, exact state
waits, the termination request, the persisted cleanup wait, and disarming
fallback cleanup. It deliberately does not define a generic submission shape,
readiness condition, successful terminal outcome, or substrate-absence rule.
Those names look common across families but do not have common semantics.

API-managed Clusters and Deployments use sibling tracked kernels rather than
widening the Workload kernel into a generic resource manager. A tracked
Deployment is immutably bound to its tracked Cluster parent. A targeted Job is
a Workload with identity and lifecycle bound to that Deployment, but it does
not create its own Pod, Kubernetes Job, or VM and does not inherit dedicated-
Job image, storage, log, exec, or SSH behavior. The kernels bind to one
endpoint-scoped controller session, which presents the same owning API/CLI
clients and domain kernels regardless of whether the API is external or
fixture-owned.

The RFC 0015 managed-Kubernetes qualification is a composition of three public
resource contracts: Cluster, Deployment, and Deployment-targeted Job.
Docker-backed k3s capacity is only the local fixture's private qualification
substrate; it is not a product target, provider, profile, adapter member, or
completion result. Dedicated Jobs remain VM-host Workloads on AWS, Azure, GCP,
Lambda, Vast, and local smolvm, and neither a Kubernetes Job nor a Kubernetes
Service belongs to the VM-host Job or Service family. Kubernetes pool Jobs,
`--port` Deployments, and Slurm Jobs are separate families, admitted by the
[2026-10-05 amendment](#amendment-2026-10-05-pool-jobs---port-deployments-and-slurm-jobs).

## Context / problem

The integration suite currently contains 60 Bash scenarios (about 7,954 lines)
and about 7,529 lines of shared shell helpers. The helpers have accumulated
several overlapping ways to spawn the CLI, poll state, record cleanup, handle
timeouts, and print diagnostics. Bash is useful at the outer CI/orchestration
boundary, but it cannot give scenario code a closed capability surface or make
lifecycle cleanup structurally mandatory.

The repository also has TypeScript integration tests, but merely choosing
Vitest does not constrain their shape. A normal Vitest file can import Node
process APIs, start untracked children, use arbitrary timers, bypass common
cleanup, add conditional skips, or create a second local harness. TypeScript and
ESLint are useful only if the allowed spec language is deliberately narrow.

Provider divergence is the more important architectural failure. Thirty-three
Bash scenarios are variants of recurring VM, invalid-input, unreachable-host,
service, GPU, bucket, concurrent-output, and image-pull behaviors. Some use
shared runners, while local smolvm Job and Serve coverage grew as large,
standalone scenarios. That made it possible for a target intended to exercise
the same product behavior to develop a separate test architecture and a
different effective contract.

The former standalone local Kubernetes program—first
`scripts/local-kubernetes-e2e.ts`, then
`test/integration/local-kubernetes.spec.ts`—demonstrated the same risk in
TypeScript. It independently owned process setup, API lifecycle, CLI execution,
polling, diagnostics, resource tracking, Kubernetes clients, and best-effort
teardown. Moving it into the mandatory fixture solved that language boundary;
the later Deployment model exposed a second problem: its replacement contract
still combines Cluster, Deployment, and targeted-Job authority under one name.

Merely expressing a standalone program in TypeScript preserves the problem. A
fixture that offers only granular API, CLI, wait, and cleanup helpers would
still allow each provider spec to assemble a different lifecycle. Contract
families, rather than provider files, therefore have to be the primary unit of
design, implementation, review, and migration.

Host loss makes the distinction concrete. A missing workload container on a
reachable persistent-VM host is repaired on that host, while a cloud-confirmed
missing persistent-VM host is terminal because its local `/workspace` cannot be
recovered. A Job may instead recover by provisioning replacement capacity.
Treating all three observations as a generic "unreachable/recovery" scenario
would permit targets to assert opposite product outcomes under one family name.

## Core invariants

1. Shared product behavior is implemented once as a contract runner.
   _Enforcement: lint:valid-e2e-contract-spec — a member spec may only call the family runner and assert its completion record; landed earlier._
2. A product target is data plus a constrained adapter, not a copied test
   program. A one-off qualification substrate remains a private concrete
   composition and cannot redefine the target contract.
   _Enforcement: lint:no-e2e-raw-mutation-clients — adapters are a closed dependency layer that cannot reach raw clients or lifecycle mechanics; landed earlier._
3. The fixture kernel owns mandatory pre-mutation resource registration and
   outcome-neutral lifecycle mechanics. The contract owns their order,
   readiness and terminal semantics, assertions, deadlines, substrate cleanup
   postconditions, and common diagnostics.
   _Enforcement: type — the automatic fixture in `test/integration/e2e/fixture.ts` and the tracked kernel in `internal/workloads.ts` mint the reference cleanup is registered against; landed earlier._
4. An adapter may only perform the operations and return the observations named
   by its contract interface. It cannot accept arbitrary callbacks, override
   cleanup, or disable contract stages.
   _Enforcement: lint:no-e2e-adapter-escape-hatches — a function-typed property or a lifecycle flag in a closed-layer interface is rejected, so a target cannot be handed behaviour or decline a stage; overriding cleanup is already refused by the layer allowlist; landed earlier._
5. Provider-specific behavior lives in a separately named extension contract.
   It cannot replace or weaken an applicable shared contract.
   _Enforcement: review — an extension composing the shared stages is structural and checked, but whether it asserts less than the baseline it extends is a comparison between assertion meanings, and no check reads meaning._
6. Unsupported family membership is explicit in the Markdown coverage matrix
   with a reason. A missing provider file is not an implicit exception.
   _Enforcement: script:scripts/validate-rfc-ledgers.mjs — every membership cell must be Required, Unsupported, or Evaluate with a reason, and a shipped member the matrix declares unsupported is rejected; landed earlier._
7. Local smolvm is a conformance target for applicable VM-host behavior. The
   family-owned CLI submission omits compute-placement flags so admission can
   select the healthy credentialless Local capability; only its direct
   substrate observations are adapter concerns.
   _Enforcement: test — `test/unit/e2e-persistent-vm-boundaries.spec.ts` requires the local submission to omit compute-placement flags; landed earlier._
8. Migration happens by complete contract family. A single provider pilot must
   be refactored into the family runner before more provider variants are added.
   _Enforcement: lint:valid-e2e-contract-spec — every spec in a family directory must call that family's runner, and an unrecognised family directory is rejected outright, so a second variant cannot be added beside a pilot; landed earlier._
9. Persistent-VM host loss and Job host recovery are separate contracts.
   Workload type and provider evidence determine the required outcome; raw
   reachability failure alone does not.
   _Enforcement: review — separate contracts and required outcomes are structural and checked; whether a contract treats raw reachability failure as sufficient evidence is a property of what its assertions mean, and no check reads meaning._
10. A shared mechanism requires two named, inventoried consumers. Existing
    Bash scenarios count as evidence; a roadmap entry does not. Only the
    identical mechanism is extracted, never unrelated behavior around it. The
    same rule governs a shared contract stage: it may be written with one
    member, but its assertions may not encode that member's target facts until a
    second inventoried consumer exists. Target-class facts are therefore
    declared once per kind in a table checked with `satisfies`, never derived by
    dispatch at each decision, so a new kind is a compile error where the facts
    live. Observation-keyed dispatch needs no such table: reading a
    variant-specific field already fails to compile for an unrecognised
    variant. A family with one substrate declares that substrate rather than a
    union of one.
    _Enforcement: lint:no-e2e-single-member-target-union — a target union of one is rejected; class tables cover every multi-target family: dedicated-job, gpu-serve, persistent-vm, persistent-vm-host-loss, serve, storage-tokens; each is proved exhaustive with `satisfies` plus a typed test, and the ledger check fails when that list stops matching the families derived from the spec tree, so a new multi-target family cannot inherit this claim unexamined; a family running one target declares that substrate instead; counting a shared mechanism's consumers remains a review judgment; landed earlier, scope corrected later._
11. Every public-resource-producing or mutating internal transport requires
    the corresponding opaque tracked Workload, Cluster, or Deployment
    reference. A plain string ID is insufficient authority to mutate. Raw API,
    CLI, and SDK clients are not available to family adapters.
    _Enforcement: type — branded references and active registries fence each approved mutation transport, while lint:no-e2e-raw-mutation-clients closes adapter imports; Workload authority landed earlier and was narrowed in a later change, Cluster authority landed after that, and Deployment authority landed last._
12. Persisted cleanup, VM-ledger cleanup, and substrate absence are separate
    observations. No one can stand in for another, and a missing status record
    is not the `Terminated` state.
    _Enforcement: type — `release()` requires evidence of all three observations, and the VM-ledger proof is minted from the row count itself so it cannot exist without the query; landed earlier._
13. Managed-Kubernetes qualification composes tracked Cluster, Deployment, and
    Deployment-targeted Job contracts. Kubernetes is their runtime, not a
    target of the VM-host Job or Service families, and local Docker-backed k3s
    capacity remains a private test substrate. Kubernetes is also the runtime
    of two further families, pool Jobs and `--port` Deployments, and Slurm
    Jobs form a third on a Slurm substrate; each has its own contract and the
    membership recorded in section 2, and none joins a VM-host family.
    _Enforcement: review — an earlier change adds typed Deployment authority and removes the direct Kubernetes Job/Service seams; lint:valid-e2e-contract-spec closes implemented family shapes, while the three-resource module decomposition remains explicit implementation work elsewhere; whether a new family's contract keeps out of the VM-host families is a judgment about what its stages assert._
14. A controller restart contract kills and replaces the Anycloud API process
    over the same endpoint and durable state. It does not restart a Kubernetes
    control plane, recreate workloads, or simulate a restart by rebuilding
    modules inside one Node.js process.
    _Enforcement: test — `test/unit/e2e-fixture.spec.ts` requires a replaced controller to change both operating-system PID and launch nonce; landed earlier._
15. Failure handling records diagnostics before teardown, executes every
    registered cleanup even when one fails, and reports cleanup failures
    without masking the primary test failure.
    _Enforcement: runtime — `finalizeE2ELifecycle` records diagnostics before teardown and `CleanupStack.run` aggregates every failure without masking the primary error; landed earlier._
16. Qualification substrates cannot replace product cluster orchestration.
    Every API-driven Kubernetes composition uses the production cluster domain,
    controller, reconciler, runtime resolver, and configured supervisor client.
    Only capacity compute, profile data, observations, and fault operations are
    substrate-specific. The Slurm Job family holds the same rule: its local
    substrate runs the production Slurm submission, observation, and
    classification code against real Slurm daemons, and its stand-in
    `podman-hpc` is a substrate stand-in for the site's container runtime,
    like Docker-backed capacity compute.
    _Enforcement: review — an earlier change landed the restricted-import boundary for the local API child and one shared qualification transport, but the boundary is a core `no-restricted-imports` configuration the ledger cannot verify as wired; the Slurm clause is held by review until Slurm S2's `slurm-substrate-boundary` rule lands._

## Goals

- Make fixture setup and teardown unavoidable for every new E2E spec.
- Make the shared contract unavoidable for every provider member of a contract
  family.
- Give contracts one obvious way to run the CLI, call the API, wait, create IDs,
  retain artifacts, register resources for cleanup, and report why a wait that
  timed out was still waiting.
- Keep provider specs declarative and normally within 10–35 lines.
- Eliminate shell parsing for CLI argument construction.
- Preserve the Bash suite during qualification and keep both results separately
  observable.
- Prevent local smolvm and future targets from silently diverging from
  user-visible cloud behavior.
- Require every VM-host target to prove the same provider-confirmed host-loss
  outcome before its legacy persistent-VM coverage can be retired.
- Move RFC 0015's local Kubernetes acceptance path, and RFC 0048's future live
  acceptance additions, into the same automatic fixture and closed
  contract-spec language while preserving the stable
  `yarn test:local-k8s-e2e` CI entry point.
- Decompose managed-Kubernetes qualification into Cluster, Deployment, and
  targeted-Job modules while preserving one paid composition and preventing
  native Kubernetes objects from becoming public resource identities.
- Preserve VM-host Service and dedicated-Job behavior independently; placement
  through a Deployment must not redefine either family.
- Measure future work by removed duplication and enforced authority rather than
  a target line count that predates the current harness.

## Non-goals

- Rewriting CI bootstrap, Docker image assembly, or account-level cloud cleanup
  in TypeScript solely to remove every line of Bash.
- Comparing human-oriented stdout byte-for-byte between implementations.
- Building a typed migration or qualification registry that duplicates the
  Markdown records below.
- Pretending that every provider supports every product behavior. Unsupported
  membership remains valid when it is explicit and justified.
- Combining unrelated provider-specific guarantees into a lowest-common-
  denominator contract.
- Creating a general local-substrate framework or making the local Docker/k3s
  implementation a product resource, provider adapter, public fixture
  capability, or production ledger entity.
- Treating graceful in-process server reconstruction as evidence that durable
  state survives an Anycloud API process crash.
- Converting all scenarios in one change.

## Proposal

### 1. Audited architecture and reuse boundaries

The seam is not “one helper per repeated verb.” It is the narrowest layer at
which the inputs, outputs, failure meaning, and cleanup ownership are actually
the same. The constrained suite therefore uses the following ordered
boundaries:

```text
thin target spec
        |
behavioral contract or named extension
        |
compatible family journey
        |-- family adapter --> private target transport
        |-- outcome-neutral probes and resource fixtures
        |-- tracked workload or cluster kernel
        `-- controller session --> process / API / CLI / wait mechanics
```

| Layer or boundary                      | Examples                                                                                         | Reuse boundary                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Controller session and managed process | Endpoint-scoped API/CLI clients, readiness, artifacts, graceful disposal, hard crash/replacement | Reuse process and client ownership; contracts retain the meaning and postconditions of a restart                                 |
| Tracked-workload kernel                | Opaque identity, cleanup registration, status/events, exact state wait, termination request      | Reuse for every API-managed workload; it records facts and performs named mutations but defines no readiness or success          |
| Tracked-cluster kernel                 | Opaque cluster identity, cleanup registration, status/history reads, create and delete fences    | Reuse for API-managed clusters; keep cluster state and deletion semantics out of the workload kernel                             |
| Tracked-deployment kernel              | Opaque identity, immutable Cluster parent, cleanup registration, read/update/delete fences       | Reuse for Deployment mutations and targeted admission; keep Deployment/Pod semantics out of Workload and Cluster kernels         |
| Outcome-neutral probes and resources   | Files, artifacts, secrets, HTTP, VM ledger, workload inspection, cleanup stack                   | Reuse the exact fact or resource lifecycle; no probe may turn its observation into a family outcome                              |
| Target transports and substrate facts  | Credentials, cloud SDK/CLI calls, smolvm, Kubernetes, exact host deletion                        | Reuse a private operation when its request and result are identical; expose only a narrower family adapter                       |
| Compatible family journeys             | Persistent VM to `Running`; Serve to endpoint readiness; finite Job submission/outcome           | Reuse inside one workload family and compatible extensions; do not create a conditional generic-workload journey                 |
| Behavioral contracts                   | VM repair, persistent-VM host loss, Serve readiness, Job completion, managed-cluster lifecycle   | Reuse only when the user-visible product outcome is identical; opposite or substrate-distinct outcomes remain separate contracts |

Dependencies point downward. The kernels and probes do not import contracts or
choose expected states. Adapters do not wait on Anycloud lifecycle state,
select expected results, or disarm cleanup. Contracts do not expose raw
process, HTTP, SSH, API, CLI, Kubernetes, database, or provider clients to
specs. A private provider operation may support several family adapters
without coupling their journeys or outcomes.

#### Fail-closed boundary protocols

Seven cross-layer boundaries carry explicit, owner-defined protocol values. A
consumer rejects missing, malformed, ambiguous, or conflicting values instead
of reconstructing meaning from adjacent text or maintaining a parallel model:

- Runner → triage: each new isolated invocation writes one strict, versioned,
  write-once `e2e-run.json`. Both runner substrates install the shared evidence
  trap before candidate resolution, so argument, resolution, preflight, build,
  and test failures retain their original nonzero result and still produce the
  record, declared log, compatibility joblog, and triage output. The command is
  diagnostic text only and must not be used to infer log identity.
- Fixture → provider: resource names are scoped by kind and run, retain a
  digest of the complete normalized logical name when the readable prefix is
  truncated, and reject any remaining in-run collision.
- Contract → VM history: contracts receive opaque VM-ledger snapshots and use
  probe-owned baseline/current comparisons. They do not inspect or copy the raw
  `StatusResponse.vms` array.
- Migration record → CI: this Markdown document remains the authoritative,
  human-owned parity record, while CI resolves every Bash, package-script, and
  Vitest entry point; requires one row for every uniquely named candidate;
  validates lifecycle and host-loss Bash phases; enforces the three- or
  five-run threshold; and rejects impossible counts or premature promotion.
- Controller child → fixture: a fixture-owned API child emits one strict,
  versioned ready record containing the launch nonce, PID, and bound port. The
  parent rejects stale, duplicate, malformed, or wrong-version records and
  does not infer readiness from arbitrary stdout.
- Test failure → teardown: the fixture captures diagnostics while failed
  resources still exist, then runs every LIFO cleanup. It preserves the primary
  error and attaches all cleanup errors instead of replacing either with the
  other.
- Fixture → triage: every finalized fixture lifecycle writes one strict,
  versioned record naming its outcome, primary failures, tracked workloads
  with their observed status, the artifacts holding their captured evidence,
  and any diagnostic that failed. Triage reads those records instead of
  recovering resource identity by scanning test output, rejects a malformed or
  unknown-version record, and refuses to attribute records it cannot tie to one
  constrained candidate. Because the record is written on success too, a failed
  run without one is reported as a failure that preceded fixture setup rather
  than as an absence of diagnostics.
- API → fixture: fixture operations consume RFC 0018's contract-derived oRPC
  client and wire types; they do not copy request or response schemas or own
  HTTP paths, headers, validation, retry, or request-timeout policy. Ordinary
  transport, authentication, declared API, and response-validation failures
  remain errors. A fixture operation may convert only one exact declared
  outcome, such as `WORKLOAD_MANAGEMENT_NOT_FOUND`, into a typed domain observation.

#### Workload lifecycle responsibility audit

The current constrained Persistent VM implementation and the surveyed public
Service, local-smolvm Service and Job, bucket-sync, concurrent-output, Job host
recovery, Deployment-targeted workload, secrets, and provider orphan-reaping
scenarios produce this responsibility split:

| Concern                           | Shared kernel, probe, or transport responsibility                                                     | Family responsibility                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Identity and fallback cleanup     | Allocate or validate an ID and arm idempotent fallback cleanup before any resource-producing mutation | Choose the ID prefix, timeout budget, and any additional fixture-owned resources                                                     |
| Submission                        | Require the tracked identity in every creation transport and verify its wire ID matches               | Own the family's canonical product entry point, build its request, serialize target placement, and assert family-specific acceptance |
| Persisted state                   | Read status and events; wait for one exact state with a bounded deadline                              | Decide which state or event history constitutes progress, readiness, recovery, or failure                                            |
| Readiness                         | Supply exact state, HTTP, workload, ledger, and substrate observations                                | Combine the required observations: SSH/runtime for VM, endpoint/backing workload for Serve, start-or-terminal rules for Job          |
| User termination                  | Issue one idempotent Anycloud termination request for a tracked workload                              | Decide whether user termination belongs to the path and assert its exact terminal outcome                                            |
| Persisted cleanup                 | Wait for an actual `cleanedAt` record and return the status snapshot                                  | Assert timestamp ordering and that cleanup preserved the correct family outcome                                                      |
| Capacity ledger                   | Return typed VM rows or other controller facts without interpreting them                              | Require zero, one, replacement, or no applicable VM rows according to the family and target                                          |
| Substrate absence                 | Perform one typed provider, smolvm, or Kubernetes observation per poll                                | Select recorded identities, own polling/deadline, and require the exact resources to be absent                                       |
| Upgrade, resubmit, or replacement | Require the tracked identity for the named mutation and expose event/status snapshots                 | Own legal ordering, identity continuity or replacement, and the resulting assertions                                                 |
| External fault injection          | Delete or stop one exact substrate resource and return provider acceptance                            | Own the baseline, expected recovery or failure, replacement rules, and terminal assertions                                           |
| Provider orphan reaping           | Register directly created cloud resources and expose provider cleanup operations                      | Remain a separate provider-resource contract; it is not an API-workload terminal stage                                               |

This audit establishes shared lifecycle primitives but rejects three tempting
generic workflows:

- A generic `submit()` would need the union of VM, Serve, and Job request and
  acceptance semantics. The shared part is tracked mutation transport;
  `submitPersistentVm`, `submitServe`, and `submitJob` remain family stages.
- A generic `awaitReady()` would be false. Persistent VM readiness includes
  SSH and runtime shape, Serve readiness includes a reachable endpoint and
  backing workload, and a short Job may validly become terminal before a poll
  sees `Running`. The shared part is exact state/event/probe mechanics.
- A generic high-level `terminate()` would hide different postconditions. The
  shared part is `requestTermination` and `waitForCleanupRecorded`;
  `terminatePersistentVm`, `terminateServe`, and a Job cancellation path own
  terminal, ledger, storage-finalization, and substrate-absence assertions.

Terminology is strict throughout this RFC: `requestTermination` is the user
mutation; `Terminated` is its persisted outcome for an active workload;
runtime teardown deletes workload resources; `cleanedAt` is the durable
control-plane cleanup fence; and substrate absence is an independent
observation. Natural Job `Completed` or `Errored` remains unchanged by later
cleanup on both VM hosts and Kubernetes.

The resulting kernel is intentionally small. The names are illustrative, but
the ownership and type boundary are normative:

```ts
declare const trackedWorkloadBrand: unique symbol;
declare const cleanupRecordedBrand: unique symbol;

type TrackedWorkloadRef = Readonly<{
  id: string;
  [trackedWorkloadBrand]: true;
}>;

type CleanupRecorded = Readonly<{
  ref: TrackedWorkloadRef;
  status: StatusResponse;
  [cleanupRecordedBrand]: true;
}>;

interface WorkloadKernel {
  reserve(id: string, cleanupTimeoutMs: number): Promise<TrackedWorkloadRef>;
  status(ref: TrackedWorkloadRef, verbose?: boolean): Promise<StatusResponse>;
  eventsSince(
    ref: TrackedWorkloadRef,
    baseline: number,
  ): Promise<readonly WorkloadEvent[]>;
  waitForState(
    ref: TrackedWorkloadRef,
    state: WorkloadState,
    timeoutMs: number,
  ): Promise<StatusResponse>;
  requestTermination(ref: TrackedWorkloadRef, timeoutMs: number): Promise<void>;
  waitForCleanupRecorded(
    ref: TrackedWorkloadRef,
    timeoutMs: number,
  ): Promise<CleanupRecorded>;
  release(cleanup: CleanupRecorded): Promise<void>;
}
```

`TrackedWorkloadRef` is created only by `reserve`. Internal creation,
upgrade, resubmit, and termination transports require it rather than a string.
They validate at runtime that the exact reference is still active in the
kernel registry and that a body or argv ID equals `ref.id`. The brand catches
accidental untracked calls at compile time; the registry rejects cast/forged or
released references; the ID check prevents one tracked handle from authorizing
mutation of another ID. The reference is not a typestate claim: external state
is always established from a fresh status or event observation.

Fallback cleanup attached by `reserve` may request termination and tolerate a
workload that was never created. It must not declare contract success,
interpret a missing status row as `Terminated`, or use VM rows as a universal
cleanup signal. `waitForCleanupRecorded` returns an opaque, one-use
`CleanupRecorded` value only for an active reference whose persisted
`cleanedAt` exists. `release` accepts that value rather than a workload
reference, so compile-time and runtime checks prevent disarming cleanup before
persisted cleanup. The closed family terminal stage still orders applicable
ledger and substrate assertions before `release`; no honest generic proof can
encode those target-specific facts.

The kernel tracks a mutation generation per reference. Every initial create,
upgrade that can replace capacity, and same-ID resubmit advances it and
invalidates earlier cleanup proofs before sending the mutation. A
`CleanupRecorded` value is valid only for the generation that produced its
status. This prevents a proof from an errored Job's first attempt from
releasing fallback cleanup after that ID has been resubmitted.

Raw mutation clients are confined to the kernel and approved transport
modules. Path-aware lint rules reject them in family adapters and contracts;
TypeScript requires `TrackedWorkloadRef` at every approved mutation entry;
contract tests prove reserve-before-submit and release-after-postconditions;
runtime guards remain a backstop for granular direct specs. This is stronger
than relying on every caller to remember `track(id)`.

#### Evidence before extraction

A shared mechanism requires at least two named, inventoried consumers. An
existing Bash scenario counts as a concrete consumer once its inputs, outputs,
failure behavior, redaction, and cleanup ownership have been surveyed; both
consumers do not need to be Vitest implementations. A roadmap row alone does
not count. Bash remains evidence of demand rather than proof of the right
boundary: one shared helper may combine unrelated behavior, while two copied
scenarios may contain a genuinely identical lower-level operation.

Before extracting a mechanism, record:

1. the named consuming scenarios or contracts;
2. their identical inputs and typed outputs;
3. their matching failure and timeout behavior;
4. their matching redaction and cleanup ownership; and
5. the behavioral assertions that deliberately remain above the mechanism.

If only a provider operation is identical, share only that operation behind
separate family adapters. Do not manufacture reuse through optional callbacks,
boolean mode flags, generic result bags, or an interface containing the union
of several families' capabilities.

The completed survey establishes these decisions before the next family is
implemented:

| Candidate boundary                                         | Named evidence                                                                                                                              | Decision                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracked workload lifecycle kernel                          | Both constrained Persistent VM contracts; public Serve; local-smolvm Serve and Job; bucket-sync; concurrent output; secrets                 | Extract the opaque reference, status/events, exact wait, termination request, persisted cleanup wait, and release; compose them in family stages                      |
| Tracked cluster lifecycle kernel                           | RFC 0015 create/status/list/delete; RFC 0048 capacity reconciliation; two-cluster Kubernetes qualification                                  | Build a sibling opaque cluster reference, pre-mutation fallback cleanup, typed status/history reads, and deletion fence; do not create a generic resource kernel      |
| `provisionRunningPersistentVm`                             | Persistent-VM lifecycle and persistent-VM host loss                                                                                         | Keep as a family journey; later families consume the kernel beneath it, not this VM-specific journey                                                                  |
| Process, HTTP, files, artifacts, secrets, and generic wait | Persistent VM; public Serve; local-smolvm Serve and Job; provider bucket-sync; CLI/preflight candidates                                     | Maintain narrow outcome-neutral modules across families                                                                                                               |
| Endpoint-scoped controller session                         | Outer-runner API used by cloud contracts; fixture-owned API used by RFC 0015 qualification                                                  | Compose owning API/CLI clients and domain kernels once per endpoint; neither contracts nor adapters construct clients                                                 |
| Managed Anycloud API process replacement                   | Local-smolvm Starting reconciliation and RFC 0015 live-workload restart                                                                     | Share abrupt child-process replacement over unchanged endpoint and durable state; each contract retains its own preconditions and adoption assertions                 |
| Failure boundary and cleanup aggregation                   | Automatic constrained fixture plus the local-smolvm and RFC 0015 standalone teardown paths                                                  | Capture diagnostics before cleanup, execute every registered LIFO action, and preserve primary and cleanup errors; do not expose error policy to contracts            |
| VM row hydration                                           | AWS, Azure, GCP, Lambda, Vast, and local-smolvm lifecycle, status, SSH access, storage, repair, and monitoring paths                        | Keep provider facts optional and storage columns nullable; resolve one required effective SSH endpoint at the shared `VMRow`-to-`DbVM` boundary                       |
| Target profiles and VM/workload probes                     | Persistent VM, public Serve, local-smolvm Serve, local-smolvm Job, and Job host recovery                                                    | Reuse exact transports and observations through family adapters; do not merge family readiness                                                                        |
| Provider host-presence query                               | Lambda/Vast constrained Persistent VM plus their bucket-sync termination checks; AWS/Azure/GCP cleanup integration presence/deletion checks | Extract a one-shot private query per target; contracts own polling and meaning. Rewire the corresponding Persistent VM consumer with each Serve target                |
| Local smolvm machine and port transport                    | Constrained Persistent VM lifecycle/host loss plus local-smolvm Serve and Job                                                               | Extract validated list/read, port decoding, argv-exec, and absence operations; family adapters retain behavior and exact-machine deletion remains host-loss-specific  |
| Environment and named-secret probes                        | Persistent VM, public Serve, local-smolvm Job, secrets, and required Serve membership                                                       | Keep environment-file/resolved-value data separate from named-secret registration/digest data; both are fixture-owned resources                                       |
| AWS, Azure, and GCP external host deletion                 | Persistent-VM host loss plus `aws-vm-unreachable`, `azure-vm-unreachable`, and `gcp-vm-unreachable`                                         | Share the private provider operation; persistent-VM failure and Job replacement stay separate contracts                                                               |
| Lambda, Vast, and local smolvm external host deletion      | Persistent-VM host loss only; corresponding Job recovery is unresolved                                                                      | Keep behind host loss until a second inventoried consumer passes the gate                                                                                             |
| Baseline VM-host Service family journey                    | Public clouds' `run_serve_smoke_test` and `local-smolvm-serve`                                                                              | Define family-specific submission, readiness, and termination stages over the shared kernel; keep ingress, secret, restart, upgrade, and GPU boundaries explicit      |
| Baseline dedicated-Job family journey                      | `local-smolvm-job`, provider bucket-sync and concurrent-output runners, and VM-unreachable Job recovery                                     | Define family-specific submission and terminal-outcome stages over the kernel; share paid workloads with storage/logging/resubmit modules only where ordering permits |
| Tracked Deployment lifecycle kernel                        | RFC 0029 Deployment CRUD, Pod recovery, targeted submission, and managed qualification                                                      | Add opaque authority bound to one tracked Cluster; do not use plain IDs above the private wire transport or merge it into the Workload/Cluster kernels                |
| Local managed-Kubernetes composition                       | RFC 0015 two-cluster acceptance and RFC 0048 capacity acceptance                                                                            | Reuse production cluster composition with Docker-backed capacity and narrow product probes; never add the local substrate to target/profile/adapter unions            |
| Provider orphan reaping                                    | AWS, Azure, GCP, and Lambda `cleanupOrphanedResources` integration tests                                                                    | Share provider-resource registration and observations where exact; do not force this direct cloud-resource behavior through the workload kernel                       |
| Persistent-VM host-loss assertions                         | Persistent-VM host loss only                                                                                                                | Keep contract-specific                                                                                                                                                |

Original SSH-host identity is another surveyed lower-level boundary. Bash and
constrained Persistent VM lifecycle are named consumers, while prepared-image
sibling qualification proves that cold boots mint distinct host keys. One
outcome-neutral fixture captures the presented fingerprints while Running and
observes the same endpoint after teardown. Contracts retain ordering, deadline,
and outcome ownership; target adapters retain independent provider evidence.

This evidence permits known reuse before a second Vitest caller is written. It
does not permit a speculative abstraction or a coincidental verb to stand in
for matching semantics.

### 2. Contract families and provider membership

Repeated user-visible behavior lives under
`test/integration/e2e/internal/contracts/`. A contract returns a small typed
completion record only after every required assertion and cleanup observation
succeeds and its tracked references have been released. A completion record is
never an input to an extension that still needs the resource live.

One family is deliberately outside the tracked-workload kernel. Provider
orphan reaping registers cloud resources directly and asserts
`cleanupOrphanedResources` against them, so it composes with no workload
lifecycle and owns its protected-resource and dry-run rules. Its rows in the
responsibility audit and reuse-boundary tables restate that boundary rather
than adding to it.

Initial families are split by public resource boundary:

| Contract family              | Required starting membership                | Intentional differences or boundary                                           | Migration state |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- | --------------- |
| Persistent VM lifecycle      | AWS, Azure, GCP, Lambda, Vast, local smolvm | Submission and fixed running/termination substrate evidence                   | Shadow          |
| Persistent VM host loss      | AWS, Azure, GCP, Lambda, Vast, local smolvm | Exact external host deletion; terminal behavior is shared                     | Shadow          |
| VM-host Service baseline     | AWS, Azure, GCP, Lambda, local smolvm       | Submission and fixed endpoint boundary                                        | Shadow          |
| GPU Service extension        | AWS, Azure, GCP, Lambda                     | Profile/runtime selection and device evidence                                 | Planned         |
| Dedicated Job lifecycle      | AWS, Azure, GCP, Lambda, Vast, local smolvm | A finite container on a dedicated VM host                                     | Planned         |
| Dedicated Job host recovery  | AWS, Azure, GCP                             | Provider fault injection and replacement/checkpoint behavior                  | Planned         |
| Dedicated Job storage/output | AWS, Azure, GCP, Lambda, Vast               | Storage implementation and independent provider observations                  | Planned         |
| Managed Cluster              | Managed qualification composition           | Cluster identity, capacity, history, and deletion                             | Split required  |
| Deployment                   | Managed qualification composition           | Persistent application bound to one tracked Cluster                           | Split required  |
| Deployment-targeted Job      | Managed qualification composition           | Existing Job identity claimed by one Deployment; no dedicated VM or Pod       | Split required  |
| Provider orphan reaping      | AWS, Azure, GCP, Lambda                     | Direct provider resources; no Workload, Deployment, or Cluster kernel         | Planned         |
| Pool Job                     | Local cluster                               | A finite Job claimed by a runner on an anycloud-managed Deployment; no VM row | Planned         |
| `--port` Deployment          | Managed qualification composition           | A Deployment serving one port through the pool route                          | Planned         |
| Slurm Job                    | Local Slurm, `pilot-site`                   | One `sbatch` per attempt on an attached Slurm cluster                         | Planned         |

VM-host membership is closed independently of managed-Kubernetes composition.
`Required` means the target must invoke the family contract. `Evaluate` blocks
that member until this RFC records either `Required` or a concrete
`Unsupported` reason; it does not permit silent omission.

| Contract family                 | AWS      | Azure    | GCP      | Lambda                          | Vast                                        | Local smolvm                                |
| ------------------------------- | -------- | -------- | -------- | ------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Persistent VM lifecycle         | Required | Required | Required | Required                        | Required                                    | Required                                    |
| Persistent VM host loss         | Required | Required | Required | Required                        | Required                                    | Required                                    |
| VM-host Service baseline        | Required | Required | Required | Required                        | Unsupported — no attachable service ingress | Required                                    |
| GPU Service extension           | Required | Required | Required | Required                        | Unsupported — no qualified Service profile  | Unsupported — smolvm has no GPU passthrough |
| Dedicated Job lifecycle         | Required | Required | Required | Required                        | Required                                    | Required                                    |
| Dedicated Job host recovery     | Required | Required | Required | Evaluate                        | Evaluate                                    | Evaluate — define exact host-fault behavior |
| Dedicated Job storage           | Required | Required | Required | Required                        | Required                                    | Evaluate — no cross-cloud bucket identity   |
| Dedicated Job concurrent output | Required | Required | Required | Evaluate                        | Evaluate                                    | Evaluate — no cross-cloud storage           |
| Dedicated Job spot eviction     | Required | Required | Required | Unsupported — no spot instances | Evaluate — no shipped Vast gateway          | Unsupported — no spot or preemption seam    |
| Dedicated Job invalid admission | Required | Required | Required | Evaluate                        | Required                                    | Evaluate — define invalid local substrate   |
| Provider orphan reaping         | Required | Required | Required | Required                        | Evaluate — production path lacks E2E survey | Unsupported — no provider account inventory |

Managed qualification is closed by public resource, not by pretending
Kubernetes is another provider target:

| Resource contract       | Runtime placement                 | Qualification responsibility                                                                   |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Cluster                 | Kubernetes control plane/capacity | Identity, isolation, capacity replacement, durable deletion, and native absence                |
| Deployment              | One Cluster                       | Application readiness, generation, rollout/drain, Pod recovery, deletion, and native absence   |
| Deployment-targeted Job | One Deployment                    | Admission, claim/retry/cancel/result, execution fence, cleanup, and zero dedicated VM attempts |

The local Docker-backed k3s implementation and cloud-backed capacity are
private substrates of the same composition. Neither changes resource identity
or contract completion. Kubernetes is not a VM-host Service or dedicated-Job
member.

The 2026-10-05 amendment admits three families that the VM-host matrix does
not cover. Each has its own contract, and its members are:

| Family              | Member                                                                                                            | Substrate                          | Runs                                | Lands in                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------- | ------------------------ |
| Pool Job            | `e2e-pool-jobs-local`: lifecycle, Node loss, unschedulable timeout, log tail, admission refusals, restore cleanup | Local cluster                      | Every PR                            | RT8                      |
| Pool Job            | `e2e-pool-scaling-local`: scale-out, the account-cap block, idle-only scale-in                                    | Local cluster                      | Every PR                            | P                        |
| `--port` Deployment | The `--port` stages of `e2e-cluster-local`                                                                        | Local cluster                      | Every PR                            | RT11                     |
| `--port` Deployment | The `--port` stages of `e2e-cluster-cloud`                                                                        | Cloud cluster                      | Dispatch                            | RT11                     |
| Slurm Job           | `e2e-slurm-local`, run as `yarn test:e2e-slurm-local:vitest`                                                      | Local Slurm, stand-in `podman-hpc` | Every PR                            | Slurm S2                 |
| Slurm Job           | `e2e-slurm-site`, the `pilot-site` target, run as `yarn test:e2e-slurm-site:vitest`                               | The pilot site                     | A site member's devbox, by approval | Slurm S2, run by gate L2 |

Baseline Service is the next low-flux family after the current Persistent VM
work. Section 9 defines its assertion inventory, fixed target observations,
extension membership, and known legacy gaps. Public DNS/HTTPS, local-smolvm
port mapping, starting-state reconciliation, upgrade, and GPU guarantees are
fixed observations or named extensions, never optional branches that weaken
the baseline.

### 3. Behavioral contracts and compatible journeys

A contract runner owns the full user-visible behavior while composing the
kernel rather than reimplementing it. The contract chooses fixture values and
timeout policy, reserves a tracked workload, constructs the family request,
orders every mutation and observation, defines readiness and terminal success,
asserts controller and substrate facts, and releases fallback cleanup only at
the end. The kernel supplies identity, cleanup registration, exact reads and
waits, named mutations, redaction, artifacts, and failure-path teardown.

A compatible family journey packages a common prefix or ordered portion of
that behavior for two or more contracts. The journey remains internal to the
family: specs cannot call it, targets cannot replace it, and it cannot accept a
provider callback. A named extension may compose the journey and add stronger
behavior, but it cannot replace or weaken the applicable baseline contract.

Each family uses the same workload kernel through different semantic stages:

| Family        | Submission stage                                                               | Readiness or progress stage                                                                                      | Normal terminal stage                                                                                                           |
| ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Persistent VM | `submitPersistentVm` reserves a reference and submits the canonical VM request | `awaitPersistentVmRunning` requires `Running`, one VM, SSH, runtime shape, environment, secret, and target facts | `terminatePersistentVm` requests termination, requires `Terminated`, persisted cleanup, VM-ledger end, and substrate absence    |
| Serve         | `submitServe` reserves a reference and submits the canonical Service request   | `awaitServeReady` requires `Running`, endpoint markers, backing identity, and target-ready facts                 | `terminateServe` requests termination, requires `Terminated`, persisted cleanup, capacity-ledger end, and substrate absence     |
| Job           | `submitJob` reserves a reference and submits a finite-workload request         | `awaitJobProgress` handles start-or-terminal races and records workload/log/storage facts                        | Natural completion requires exact exit outcome, finalization, persisted cleanup, ledger/substrate absence; cancellation differs |

These stage names are family-private. They share `reserve`, status/events,
exact waits, `requestTermination`, and `waitForCleanupRecorded` below them;
they do not duplicate those mechanics. Conversely, the kernel does not acquire
`workloadType` switches to implement the three rows.

Service and dedicated-Job extensions use an explicit live-resource protocol:

```text
tracked ref + submitted resource
  -> typed active-baseline record (reference remains armed and live)
  -> zero or more required typed extension records
  -> terminal observation
  -> persisted cleanup + independent substrate absence + reference release
  -> exactly one final completion record
```

The active Service baseline proves accepted type and placement, `Running`,
profile/provider identity, environment precedence, secret digest where
required, endpoint identity, and readiness while retaining its tracked ref. GPU,
recovery, and upgrade extensions consume that record and return distinct typed
evidence. For a dedicated Job, the active baseline proves admission, target and
profile, provider identity, and the Running/claim facts available before its
terminal outcome. Storage extensions return transfer evidence. Recovery
extensions require a typed pre-fault identity/checkpoint record before fault
injection and return a typed post-fault record; neither can be reconstructed
from final status text.

One family finalizer accepts the baseline, the closed set of required extension
records, and the terminal observation. It alone may wait for every cleanup
receipt, prove independent absence, release the ref, and mint completion.
Baseline-only members pass an empty extension set. Types and negative controls
must reject final completion as an extension input, cleanup before a required
extension, missing pre/post records, and a second completion mint.

Contract runners and journeys do not expose `skip*` settings, optional stages,
provider-selected assertions, or lifecycle mode flags. A genuine capability or
outcome difference defines a separate family or named extension.

Large legacy scenarios may compose several contracts around the same tracked
reference and paid workload when their ordering and terminal paths are
compatible. The local-smolvm Job scenario, for example, combines workload
configuration, logs, storage, user termination, natural success, natural
error, and resubmit. Workload, logs, and storage modules may share the initial
Job journey. User termination, success, and error are mutually exclusive and
therefore require separate tracked workloads; same-ID resubmit composes only
with the errored branch. This becomes a fixed composition, not one
option-driven mega-contract and not one workload per assertion.

A product qualification composition may also own more than one tracked public
resource when behavior requires their interaction. Managed-Kubernetes
qualification owns two tracked Clusters, two child Deployments, and several
Deployment-targeted Job Workloads. It composes the three resource-owned
contracts and keeps only cross-resource ordering. It does not call the
dedicated-Job or VM-host Service journey: a targeted Job creates no VM or native
Kubernetes Job, and request serving is outside RFC 0029.

The dedicated-Job survey is an explicit check on this seam. Long-running local
and bucket-sync Jobs expose `Running`, while short workloads may reach
`Completed` before a waiter observes that state. Natural success, nonzero
`Errored`, user `Terminated`, and host-loss recovery have different event,
storage-finalization, replacement, and cleanup requirements. They reuse the
same tracked Workload mechanics but cannot share one `awaitReady` or terminal
workflow. Same-ID resubmit retains the armed reference through the first
errored outcome and releases it only after the resubmitted outcome and cleanup
postconditions have been proved.

`awaitJobProgress` therefore returns a discriminated record: either `active`,
with the tracked reference and the pre-terminal facts that a live extension may
consume, or `terminal-before-active`, with the exact terminal observation and
no live-extension authority. The finalizer accepts either branch, but an
extension requiring storage mutation, a checkpoint, or a recovery fault accepts
only `active`. A short Job that wins the race may complete baseline-only
qualification; it cannot fabricate an active baseline or silently omit a
required extension.

### 4. Family adapters and reusable target transports

Adapters live under `test/integration/e2e/internal/targets/` and are internal to
the fixture. Every family defines the smallest adapter interface it needs. An
adapter may:

- provide validated profile data;
- perform one named target fault or substrate operation; and
- return fixed, typed substrate evidence at contract-selected stages when that
  target has evidence beyond the common controller facts.

An adapter may not accept a plain workload ID for mutation, own lifecycle
waits, common assertions, resource registration, test cleanup, arbitrary
remote commands, expected outcomes, or provider-controlled hooks. The contract
decides whether an observation passes. It also may not choose between CLI and
API submission or reserialize the family's common request. Adapters receive
narrowed transports, not `ApiClient`, `CliClient`, `ProcessRunner`, or
`DeploymentManager`.

Reusable provider clients and operations sit below adapters. Two family
adapters may call the same private target transport when the extraction gate in
Section 1 is satisfied, but there is no cross-family adapter containing the
union of their methods. This keeps transport reuse from turning into behavioral
coupling.

The local Docker/k3s substrate sits below this adapter layer as a concrete
fixture composition. It implements the RFC 0015 capacity port and exposes
narrow, product-shaped Kubernetes and capacity observations. The API still
obtains its control-plane client, cluster lifecycle, and runtimes through the
production composition. No contract receives a raw Kubernetes client, database
repository, Docker client, shell command, or process handle. Because the local
substrate is not a target, it cannot appear in a family adapter union or be
selected by a contract spec.

Creation transports enforce the common precondition without defining a common
request. A CLI-backed Serve adapter may accept
`submit(ref, ServeSubmission)`, while the Local adapter implements the same
family interface through `/v1/new`; both private transports require the opaque
reference and check the outgoing ID. The contract therefore cannot forget
registration, while the transport does not decide what a valid Serve request
or response means.

The surveyed later families are expected to divide reuse as follows:

| Later family               | Reuse from lower layers                                                                                                  | Family-owned behavior                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Serve                      | Tracked reference, status/events, exact wait, termination request, persisted cleanup, HTTP/profile/secret/absence probes | Service request and acceptance, endpoint readiness, and named secret, restart, upgrade, and GPU extensions |
| Job lifecycle              | Tracked reference, status/events, exact wait, termination request, persisted cleanup, profile/workload/log probes        | Start-or-terminal behavior, exit outcome, finalization, user cancellation, and resubmit sequencing         |
| Job host recovery          | Tracked reference, event snapshots, ledger probes, and exact provider deletion where its evidence gate is satisfied      | `Recovering`, replacement-ledger, restored-workload, and terminal assertions                               |
| Storage/concurrent output  | Files, credentials, process execution, generic waits, artifacts, tracked reference, and cleanup stack                    | Hydration, synchronization, finalization, isolation, and object-level assertions                           |
| Workload substrate absence | Independent provider/smolvm/Kubernetes probes and tracked backing identities                                             | Exact absence and its ordering relative to the owning lifecycle contract's persisted cleanup boundary      |
| Provider orphan reaping    | Direct-provider resource registration, profiles, artifacts, and target transports                                        | Orphan classification, protected-resource behavior, dry-run behavior, and direct cleanup results           |

This table identifies candidate boundaries from existing scenarios. Each
extraction still records its named consumers and exact interface during that
family's migration.

### 5. Mandatory outcome-neutral fixture

`test/integration/e2e/fixture.ts` is the only public import. It extends Vitest
with an automatic, test-scoped `e2e` fixture. Before a test, the fixture creates
isolated temporary and artifact directories. Afterward it always performs LIFO
cleanup, including after assertion failures and timeouts.

The public capability object composes centrally owned mechanics:

- `contracts`: the only lifecycle capability available to contract-member
  specs;
- `cli`: argv-only CLI execution, bounded deadlines, stdin, transient retry,
  captured output, and command artifacts;
- `api`: authenticated named operations rather than raw request access;
- `files`: fixture-owned directories and executable shims;
- named direct-spec fact capabilities that require an automatically tracked
  resource, currently `workloadFacts.liveVmCount`; and
- `names`, `env`, and `runId`: scoped, collision-resistant resource names and
  validated configuration access. Truncation retains a digest of the complete
  logical name, and a lifecycle rejects any remaining in-run collision.

Artifacts, waits, target profiles, hashing, secrets, VM access, and substrate
operations remain fixture internals until a concrete direct spec requires one
as a named capability. Surveyed future consumers justify the internal seam;
they do not justify exposing an unused public escape hatch in advance.

The internal fixture graph, which is not the public spec API, contains the
tracked-workload and tracked-cluster kernels, `ControllerSessionFactory`,
`ManagedProcess`, `ProcessRunner`, `Waiter`, owning API and CLI clients,
`ArtifactStore`, `FixtureFiles`, `SecretManager`, `TargetHttpClient`,
`VmHarness`, `HostIdentityHarness`, validated profiles, and fixed substrate
probes. Their presence in one automatic fixture does not make them one
abstraction. Contracts receive narrow kernels and required probes; adapters
receive only target transports; specs receive neither.

Wire request and response types come from the owning oRPC contract when one
exists, and from the current shared API type otherwise. The contract-derived
client owns JSON encoding, Zod validation, declared errors, authentication,
retry eligibility, and per-procedure request deadlines. The E2E fixture adds
only redacted operation artifacts and resource-domain semantics; it must not
define a parallel Zod schema, copied wire model, or second transport policy.

`ControllerSessionFactory` is the sole composition root for clients that talk
to an Anycloud API endpoint. It can attach to the outer runner's API or start a
fixture-owned local API, then binds the owning API client, CLI client, tracked
workload kernel, tracked-cluster kernel, mutations, and fact probes to that
one endpoint. Contracts cannot construct or retarget those components
independently.

`ManagedProcess` differs from finite `ProcessRunner` commands. It owns one
long-running child, readiness protocol, stdout/stderr artifacts, graceful
fixture disposal, and an explicit hard-crash/replacement operation. A local API
child receives its complete environment before dynamically importing any
production module. First boot chooses a port; replacement uses that same port,
state root, and SQLite database while proving a new PID. Module caches,
repository singletons, runtime bundles, and monitor maps therefore cannot
survive merely because the test and server share a process.

The automatic fixture is also the only failure boundary. On a test or setup
failure it first records registered session, workload, cluster, process, and
substrate diagnostics while those resources are observable. It then runs every
cleanup action in LIFO order even if an earlier action throws. If both the test
and teardown fail, the reported error retains the original failure as primary
and includes every cleanup failure with its cause. Cleanup failure alone fails
the test; warning-only best-effort teardown is not an accepted outcome.

The workload fallback registered by `reserve` is deliberately weaker than a
passing contract. On fixture disposal it requests termination if necessary,
waits for the control-plane cleanup record when one exists, records diagnostics,
and leaves account-level cleanup as a backstop if the provider is unavailable.
It does not assert a family outcome or consider a zero VM count sufficient for
Kubernetes. Resource fixtures such as secrets, buckets, temporary files, and
directly created provider objects register their own LIFO cleanup independently
of the workload reference.

The tracked-cluster kernel applies the same safety property to cluster-creating
mutations without pretending clusters are workloads. Because the API owns
cluster ID generation, `reserveCluster(name)` returns an opaque logical
reference and arms exact name-scoped fallback deletion before creation. The
create transport verifies the request name, then binds the returned server ID
to the active reference. If the response is lost, the kernel resolves that
unique name through the owning API and rejects missing, duplicate, or
conflicting identity rather than guessing an ID. Status/history and deletion
transports require the bound reference. A persisted `Deleted` observation
mints a one-use cluster-deletion proof; the managed-cluster contract orders
capacity-ledger completion and substrate absence before releasing fallback
cleanup with that proof. Cluster and workload references are not
interchangeable, and neither kernel grows a generic `resourceType` switch.

The pre-kernel `DeploymentManager` was transitional. Its replacement before
the first Serve contract follows this audited mapping:

| Former surface                                        | Audit finding                                                                                       | Implemented replacement                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `track(id): Promise<void>`                            | Registration is easy to duplicate or bypass, and mutation still accepts any string                  | `reserve` returns an opaque `TrackedWorkloadRef`; every internal workload mutation requires it                             |
| `complete(id)`                                        | Any caller can disarm fallback cleanup before persisted or substrate cleanup is proved              | `waitForCleanupRecorded` mints a one-use proof; `release` requires it, and closed family stages order remaining assertions |
| `terminate(id)`                                       | It combines the generic termination request with a wait over the VM table                           | Split into `requestTermination` and `waitForCleanupRecorded`; family terminal stages own ledger and substrate assertions   |
| `liveCleanupTargetCount(ids)`                         | It queries only `vms`, so its generic name is false and it can pass immediately for Kubernetes      | Rename and type it as a VM-ledger probe; add target-specific capacity and substrate observations where applicable          |
| `waitForState(id, Terminated)` accepting HTTP 404     | Absence is silently treated as a persisted terminal state                                           | Exact state waits require an observed state; provide a separate absence observation only to contracts that require it      |
| `prepareCliMutation` plus explicit contract `track()` | Two registration paths obscure which one establishes safety; adapters can still hold raw CLI/API    | Branded internal transports become the primary guard; retain argument parsing only as a runtime backstop for direct specs  |
| Public `workloads: DeploymentManager`                 | A broad class lets direct specs assemble alternate lifecycle behavior and exposes VM-specific names | Replace it with named, narrow direct-spec operations; contract specs continue to expose only `e2e.contracts`               |

Implemented on 2026-08-18, the public `WorkloadKernel` interface contains
only the lifecycle operations above, while `TrackedWorkloadKernel` owns the
private registry and mutation authorizer. `WorkloadMutationTransport`
requires the opaque reference and validates API-body or CLI-argument identity;
adapters receive only its create-specific API or CLI interface, while upgrade
and resubmit remain separately named transports. `VmLedgerProbe` owns the
explicitly VM-only database facts. Both Persistent VM contracts use these
surfaces, and direct specs see only an automatically guarded CLI plus the
narrow `workloadFacts.liveVmCount(id)` observation.

The fixture redacts registered secrets before output reaches artifacts or
thrown errors. Process spawning never uses a shell. Generic shell interpreters,
raw networking, and raw remote execution are not public capabilities. Granular
capabilities are added only for a direct, genuinely unique constrained spec
that consumes them; contract-member specs cannot use them to assemble an
alternate lifecycle.

### 6. Closed specs and structural enforcement

Constrained specs live only under `test/integration/e2e/specs/`. Repository
lint rules enforce this closed language:

1. A file has exactly one import: its correct relative path to the public
   `fixture.js`, with the unaliased named imports `test` and `expect`.
2. Top-level executable statements are direct
   `test("...", async ({ e2e }) => ...)` calls. Suites, hooks, `.each`, custom
   timeouts, and nested tests are not part of the language.
3. `test.skip`, `test.only`, and conditional skip APIs are forbidden.
4. Specs cannot import Vitest directly, Node built-ins, fixture internals, or
   production modules.
5. Direct access to processes, global objects, timers, networking, mocks,
   dynamic imports, eval, and lint-disable comments is rejected.
6. Type-aware ESLint, strict TypeScript, complexity limits, and file/function
   size limits apply to the directory.

This boundary governs deployed-product behavior, not every lower-layer
integration protocol. A compatibility test explicitly owned by another
accepted RFC remains outside the E2E fixture on an exact lint allowlist; RFC
0018's Python real-HTTP wire test is the current sole member. It cannot define
or duplicate a workload lifecycle contract.

Contract members live at
`test/integration/e2e/specs/contracts/<family>/<legacy-name>.spec.ts`. A
path-aware rule requires exactly one contract call using the target implied by
the filename and one exact completion assertion. Granular capabilities are
forbidden in these files. Reusable mechanics are added below the contract
boundary with unit tests rather than reconstructed in a spec.

The managed Kubernetes member is
`specs/contracts/managed-kubernetes/kubernetes.spec.ts`. It follows the same
closed form and invokes only `e2e.contracts.managedKubernetes('kubernetes')`,
then asserts exactly
`{ contract: 'managed-kubernetes', target: 'kubernetes', satisfied: true }`.
There is no local-substrate spec, substrate argument, or substrate field in the
result. The existing exact-member rule gains this family mapping; no separate
spec language or standalone-shape enforcement is introduced.

Enforcement is layered:

- ESLint validates the closed spec language and rejects constrained specs in
  other paths.
- The path-aware rule validates exact member shape and filename/target
  agreement.
- Internal path rules make contracts and target adapters closed dependency
  layers. A positive allowlist admits only their declared sibling and boundary
  modules; Node/package imports, raw clients, target mechanics, direct transport
  imports, re-exports, dynamic imports, ambient process/network/time
  capabilities, inline lint configuration, and noncanonical module extensions
  are rejected. Raw mutation and execution clients remain in the kernel,
  transport, and composition modules.
- TypeScript requires the opaque `TrackedWorkloadRef` for every
  workload-producing mutation and constrains every adapter observation.
- A wait that retries probe errors names which errors it will wait through, so
  a permanent failure aborts with its own message instead of being polled to the
  deadline. A wait that ends while its probe is failing reports that failure
  alongside the unmet condition.
- A wait states its unmet condition once. The predicate that decides whether to
  keep waiting returns that condition, and the timeout report is derived from
  it, so a wait cannot decide correctly and explain wrongly.
- A tracked mutation resolves to acceptance, never to command output. The
  transport raises the redacted diagnostic itself, so human-oriented stdout
  cannot become a value a contract or adapter reads; a layer that needs a fact
  about the workload reads it from persisted status, the provider, or the
  endpoint. A transport whose observation genuinely is the command outcome,
  such as proving that a request was rejected, takes a separately named raw
  surface that the closed-layer allowlist does not admit.
- Mutation transports check that the reference is active in the kernel
  registry and that its ID equals the outgoing API body or CLI argument,
  covering casts and runtime data that structural typing cannot prove.
- The kernel mints a one-use cleanup proof only after observing `cleanedAt` and
  rejects forged, mismatched, stale-generation, or reused proofs when fallback
  cleanup is released.
- Contract tests use controlled adapters to prove stage ordering, failure
  propagation, deadlines, reserve-before-mutation, and release-after-all-
  postconditions ordering.
- Adapter tests validate parsing, redaction, and target-specific observation
  schemas without provisioning resources.
- Runtime mutation guards reject unregistered resource-producing CLI
  operations in direct specs.

Typed target names and adapter interfaces are ordinary program boundaries. The
implementation does not contain qualification counts, migration stages,
assertion-parity metadata, or a generic result comparator; those remain in this
RFC.

### 7. Isolated execution and qualification

#### Managed GPU release qualification

The managed-Kubernetes contract accepts private workload facts for `cpu` and
`mace-cuda`. Both execute the complete cluster and Deployment lifecycle journey;
GPU adds real CUDA inference and recovery evidence without creating a second
public target or weaker smoke contract. One reusable and manually dispatched
`managed-kubernetes-qualification.yml` selects `profile=cpu|gpu`, defaulting to
CPU. Both profiles share setup, execution, tracked teardown, and evidence upload.
CPU runs use distinct matching API/SDK versions for each run and attempt; only
GPU capacity shares a provider lock at the qualification job. GPU enables candidate assembly, receipt
validation, and the publication gate within that workflow.
Host and capacity placement are inputs resolved through existing provider
profiles; GPU acceptance requires verified NVIDIA capacity and CUDA execution.
The selected release defaults and exact-artifact gate are documented in
[RELEASE.md](../RELEASE.md).

The thin MACE image adds that SDK wheel and the shared Deployment integration to a
pinned model image. Two geometries have CPU reference energies computed from
the cached model during image construction. Each selected Job forces a fresh
CUDA calculation and records numerical agreement, model checksum, SDK version,
execution identity, Pod/process identity, model-load identity, and observed
Node/VM/image identity. Durable fixture evidence is written before completion
so Pod deletion cannot erase the result. Two Jobs must reuse one loaded model;
later Jobs must succeed after plugin, controller, Pod, Deployment, and capacity
recovery.

Completed inference evidence matches the durable Job's current execution in
`Completed` state. Retry/recovery attempts use separate observations of the
current `Running` execution; they cannot replace completed evidence. Required
phase records identify their before/after executions and the relevant plugin,
Pod, Deployment generation, controller, connection, and capacity VM identities.
The actual serialized receipt producer is exercised through the publication
validator, including configured provider spelling, numerical comparisons,
physical GPU counts, and initial/recovered API images. CPU retry behavior and
both clusters' recovery identity assertions remain part of the shared contract.

A qualification receipt is emitted only after the complete contract and
tracked cleanup succeed. It binds resolved placement, actual runtime and
installed artifact observations, and consistent GPU allocation to the candidate
and current workflow run/attempt. The shared qualification and receipt gate
must succeed; skipped, cancelled, missing, stale, or inconclusive required
evidence cannot authorize publication. Qualification removes only its tracked
fixture resources and does not run an account-wide provider sweep.
The cleanup ledger retains every reserved owner, including failed creations
and deterministic DNS records. Cleanup receipts are emitted independently of
runtime success. Every earlier workflow attempt requires its own confirmed
cleanup proof before retry provisioning; missing proof requires scoped
recovery instead of silently certifying an abandoned attempt.
API version/latest manifests and downstream publication wait for the
gate described in RELEASE.md.

The complete candidate bundle is verified before use and publication. Missing,
expired, or partial candidate artifacts fail on retry and are never rebuilt:
source/version equality is not byte identity. Release publication consumes
the recorded CLI/SDK bytes, both API child digests, and release notes.

Qualification persists run/attempt cleanup authority before provisioning.
Manual recovery for the configured AWS host/state and Azure capacity setup
authenticates that authority against the completed original GitHub attempt,
works without its runner or API, and confirms controller shutdown before
capacity/state removal. Its separate receipt reports provider coverage and
residuals. It does not replace tracked cleanup evidence or unlock automatic
retries. Automatic cross-provider recovery, including GCP's missing firewall
ownership association, remains deferred. The command and limits are recorded
in [RELEASE.md](../RELEASE.md#manual-recovery-after-runner-loss).

This gate qualifies current-version behavior and recovery.

#### Runner isolation and promotion

`vitest.e2e.config.mts` selects only constrained specs and does not load the
unit-test global setup or mocks. File parallelism is disabled within one
runner; provider concurrency remains an orchestration decision. The fixture
owns operation deadlines, with an outer runner timeout as a final backstop.

Selection is closed in both directions. The default configuration excludes the
same glob, so watch mode, editor gutters, and a bare `vitest run <path>` cannot
start a candidate under unit-test setup, injected environment, and 30-second
timeouts. The fixture additionally refuses to provision unless the constrained
configuration supplied its marker, and a repository boundary check proves that
the default configuration selects no candidate, that the constrained one selects
every candidate on disk, and that the lint layer still recognizes the same
files.

The outer `test/integration/e2e.sh` continues to build the product image and
boot an isolated local API. Its `--vitest` mode resolves one unique same-named
constrained spec recursively instead of a Bash scenario. Candidate-only names
may map to one phase of a combined legacy scenario without requiring a
same-named Bash file.

Legacy and candidate tests run in separate jobs or fresh invocations. They do
not share an API, database, temporary directory, workload, or cleanup state;
their logs and artifacts have distinct names. During Shadow, candidate failures
are visible but non-blocking and Bash remains authoritative.

Each isolated runner invocation writes exactly one `e2e-run.json` with these
strict fields. The file is created with write-once filesystem semantics; a
later fallback or cleanup path cannot replace the original result. The Bash and
no-API Vitest runners install their evidence trap before selecting an
implementation, and debug mode skips resource teardown only after it validates
the same evidence protocol.

| Field             | Required value                                                                       |
| ----------------- | ------------------------------------------------------------------------------------ |
| `version`         | Protocol version `1`; unknown versions are rejected                                  |
| `testName`        | Non-empty runner-declared identity containing only letters, digits, `.`, `_`, or `-` |
| `implementation`  | Exactly `bash` or `vitest`                                                           |
| `command`         | Non-empty diagnostic command text; never an identity or log-discovery source         |
| `logFile`         | Exact `.log` basename within the results directory                                   |
| `exitCode`        | Integer process exit code                                                            |
| `durationSeconds` | Finite, non-negative elapsed seconds                                                 |

Triage reads the declared `logFile` by exact basename. It does not scan for a
similar filename or derive one from `testName` or `command`. A malformed or
unknown-version run record and a missing declared log are triage failures, not
grounds for inference or silent omission.

GNU `joblog.txt` is still emitted by both runner substrates for operators and
older artifact tooling. Parsing a recordless joblog is temporary compatibility
behavior for artifacts created before the run-record protocol: only known
legacy Bash and constrained Vitest command shapes are accepted, and unknown
commands fail triage. The compatibility parser is not an alternate identity
protocol for new runs.

There is deliberately no semantic output comparator. Review records the legacy
assertion-to-contract mapping, after which the shared contract owns the
assertions. Human-oriented wording and timing may differ.

Promotion stages are:

`Planned` -> `Shadow` -> `Dual blocking` -> `Vitest primary` -> `Bash retired`

A local or no-provision member needs five consecutive conclusive matching runs
before Dual blocking; a real-cloud member needs three. A skipped or otherwise
inconclusive run does not count. A behavioral disagreement resets the count
after its cause is fixed. Entry into Dual blocking also requires complete
legacy assertion coverage, artifacts sufficient to diagnose a failure, and
resource-mode-appropriate failure evidence: observed automatic cleanup after a
forced failure for provisioning, or exact `Not applicable` for no-provision.

Qualification is recorded per family member. Sharing a runner does not force
all targets to promote together. Bash retirement is a later explicit change,
and shared shell helpers remain until no Bash scenario consumes them.

### 8. Persistent VM as the worked example

The Persistent VM implementation establishes family-level reuse and becomes
the first consumer of the audited workload kernel before Serve begins. AWS,
Azure, GCP, Lambda, Vast, and local smolvm invoke the same lifecycle behavior
and the same family-owned CLI submission stage. That stage always emits the
canonical Persistent VM arguments. Public providers additionally save and
select named credentials plus their requested VM placement; local smolvm emits
no compute-placement flags and admission selects the healthy credentialless
Local capability. Targeting a Deployment is a separate Job path, while
cluster-backed Service is deferred to RFC 0032; neither is a Persistent VM or
local-smolvm escape hatch.
Target adapters return only meaningful additional evidence: Local machine
identity, SSH mapping, and deletion evidence; Vast direct SSH/KVM provenance;
and Lambda and Vast independent provider-termination observations.

#### Provider facts and hydrated VM facts

The cross-cloud boundary is deliberately not an E2E-only adapter convention.
It is a product-domain invariant shared by every VM-host contract:

1. `CloudVM` is a gateway result. It contains provider facts: `ip` plus optional
   `sshHost`, `sshPort`, and `sshUsername` overrides when the endpoint differs
   from `ip:22` as `root`.
2. `VMRow` is the literal persistence shape. Its SSH override columns remain
   nullable. Their NULL encoding is private storage detail, not contract
   behavior.
3. `DbVM` is the hydrated operational entity. One shared row projection and
   one `VMRow`-to-`DbVM` function, used by every live, historical, and by-IP VM
   read, require an effective `sshHost`, `sshPort`, and `sshUsername`. The
   hydrator resolves missing values to `ip`, `22`, and `root` exactly once.

Operational consumers receive `DbVM`, so status and SSH-access responses expose
effective values even when the provider result and raw row omit defaults. This
RFC centralizes and tests that hydration boundary; it does not make the E2E
migration depend on a broader runtime-client rewrite.

Two follow-up enforcement seams remain tracked separately: constructing
transport, Docker, and supervisor clients from one atomic VM-host session, and
binding exact-VM lifecycle calls to the VM attempt's provider, credential,
location, and cloud ID. Those changes may prevent future call-site omissions,
but they remain independently reviewable product refactors rather than hidden
prerequisites of RFC 0017.

The constrained contracts already correlate hosts by provider VM identity and
use the active VM row's concrete placement. They do not use an IP address as VM
identity: separate VMs may reuse an address or share one NAT host while differing
by mapped port.

Normal teardown applies the same rule to the old SSH endpoint. While the VM is
Running, an outcome-neutral fixture captures the normalized fingerprints of the
host keys actually presented by that endpoint. After persisted cleanup and any
required independent provider observation, the contract accepts either stable
endpoint unreachability or a valid, disjoint fingerprint set. A generic TCP
accept is not proof that the original VM remains, while a matching fingerprint
is. An open endpoint that never completes a valid SSH handshake remains
inconclusive and cannot satisfy qualification. Provider-resource absence stays
a separate assertion because endpoint identity cannot prove that the original
cloud ID was deleted.

| VM-host target          | Gateway facts                                                       | Effective hydrated endpoint             |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| AWS, Azure, GCP, Lambda | Provider `ip`; no redundant SSH overrides                           | `<ip>:22` as `root`                     |
| Local smolvm            | `ip = localhost`; forwarded host port; no fake loopback `privateIp` | `localhost:<forwarded-port>` as `root`  |
| Vast                    | Public `ip`; mapped port; host only when distinct from public `ip`  | `<direct-host>:<mapped-port>` as `root` |

Scheduler-native Kubernetes owns Pods rather than VM rows and remains outside
this VM-host hydration boundary. Its endpoint and termination semantics stay in
the Kubernetes contract instead of being forced through `DbVM`.

Constrained E2E asserts the effective endpoint against independent provider or
smolvm observations. It does not assert whether a default was stored as NULL;
unit tests at the persistence boundary prove sparse defaults, mapped ports, and
non-root overrides hydrate identically through every read path. This keeps
Local smolvm as a true conformance target without turning one database encoding
into a cross-cloud behavioral contract.

#### Persistent VM legacy-to-candidate acceptance inventory

The following inventory is the parity boundary for the currently migrated CLI,
image-preflight, Persistent VM lifecycle, and Persistent VM host-loss rows. An
item marked Enforced has a contract, fixture, adapter, or runner assertion and a
controlled test for its failure behavior. This records behavioral coverage; it
does not advance the conclusive-run counts in the migration record.

| Legacy behavior                      | Candidate owner and exact acceptance condition                                                                                                                                                                                                                                                                                                                                                                                   | Status   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Canonical Persistent VM submission   | The family stage creates the named secret, reserves cleanup before mutation, invokes the built `vm` CLI with the image, ID, environment, and secret, and adds only the target's serialized credential and placement inputs. Public targets prove the saved credential association; Local proves credentialless placement.                                                                                                        | Enforced |
| Running workload and ledger          | The shared journey requires type `vm`, exact provider, `Running`, no DNS record, one live VM row, a non-empty cloud ID, a usable effective SSH host/port/username, and exactly one live cleanup target.                                                                                                                                                                                                                          | Enforced |
| Workload container profile           | Both the original and repaired containers require the exact name, running state, `/bin/sh` path, keepalive argv, empty Docker user, `/workspace` working directory and mode `777`, Docker init, numeric socket GID in `GroupAdd`, `unless-stopped`, zero published ports, exact ownership labels, one writable exact-source workspace bind, one writable exact-source Docker-socket bind, and accessible runtime paths.          | Enforced |
| SSH modes and workload fixture       | Container SSH must match the active VM's effective endpoint and expose a private key; the container must observe the exact environment marker and named-secret digest. Host SSH must reach Docker. Snapshot SSH must return the exact declared 400 rejection.                                                                                                                                                                    | Enforced |
| Missing-container repair             | Removing the workload must produce a different running container on the same cloud VM, preserve the workspace marker, reproduce the complete runtime profile and environment/secret observations, retain `Running`, and retain exactly one live ledger row.                                                                                                                                                                      | Enforced |
| Normal termination and cleanup       | The contract requires exact `Terminated`, ordered `completedAt`/`cleanedAt`, zero live VM rows, the target's required substrate observation, and identity-aware release of the SSH host captured while Running. Stable unreachability or a valid disjoint host-key fingerprint set satisfies release; a matching identity or inconclusive handshake does not. Secret deletion and fallback-cleanup release occur only afterward. | Enforced |
| AWS default root disk                | Direct AWS observations must resolve the active instance's root volume and prove `gp3`, 8,000 IOPS, and 1,000 MiB/s throughput on both lifecycle paths.                                                                                                                                                                                                                                                                          | Enforced |
| Vast VM-host identity                | Direct Vast observations must match the effective SSH host and port, require root, correlate provider image ID with the ledger, identify `vastai/kvm`, retain the `a=<workload>-...` attempt identity, and prove the temporary account key is absent.                                                                                                                                                                            | Enforced |
| Local smolvm substrate               | Direct Local observations require one running, deterministically named guest with only a positive host mapping for guest port 22, exact cloud-ID/endpoint correlation, root, and zero owned guests after normal termination.                                                                                                                                                                                                     | Enforced |
| Lambda and Vast provider termination | Independent provider polling returns `terminated` or `inconclusive`. Only `terminated` yields a `conclusive` completion record; every thin lifecycle spec requires `conclusive`, so unavailable provider evidence cannot count as a passing qualification run.                                                                                                                                                                   | Enforced |
| Provider-confirmed host loss         | All six targets delete the exact active host externally. The shared contract then requires exact `Failed`, the fixed local-workspace-loss reason and cloud ID, unchanged historical VM identity, an ended original row, no recovery/provisioning event, ordered cleanup timestamps, zero live rows, and no replacement.                                                                                                          | Enforced |
| Image preflight rejection            | Architecture mismatch, missing tag, explicit undersized disk, and catalog-undersized disk must exit unsuccessfully without timeout, abort, or spawn failure and leave zero workload rows, zero VM rows, and zero live VM rows for the pre-registered ID.                                                                                                                                                                         | Enforced |
| CLI exit behavior                    | The constrained candidate preserves the legacy command/help, missing-input, missing-API, and hung-Docker exit contracts through bounded argv-only processes.                                                                                                                                                                                                                                                                     | Enforced |
| Failure ownership and evidence       | A primary failure captures verbose status plus redacted Docker process/inspect/log artifacts before teardown. Cleanup uses a separate bounded signal, executes every LIFO action, and aggregates all cleanup causes with the primary failure. Every isolated runner emits one strict run record, and missing metadata, malformed metadata, or a missing declared log fails triage.                                               | Enforced |
| Fixture diagnostics reach triage     | Every finalized lifecycle records its outcome, primary failures, tracked workloads with observed status, and the artifacts holding their evidence. Triage names those workloads even when no API log line ever attributed them, reports the fixture's own failure as the root cause, and states when diagnostics were never captured or a lifecycle never finalized.                                                             | Enforced |

The corresponding failure-path inventory is deliberately fail closed:

| Boundary                         | Required failure behavior                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test timeout or cancellation     | Abort test-owned process, CLI retry, API, HTTP, and wait work without aborting teardown work.                                                                                    |
| Slow probe or response body      | The operation-level deadline covers the complete probe or response body; a result arriving after the deadline is rejected.                                                       |
| Diagnostic failure               | Record it as secondary evidence and continue through every cleanup action.                                                                                                       |
| Cleanup failure                  | Continue later LIFO actions and retain each labeled cause in an `AggregateError`; never replace the primary test error.                                                          |
| Direct CLI escape                | Permit only explicit read/validation shapes or tracked workload mutations; every other new command is rejected until a named, automatically cleaned capability owns it.          |
| Provider observation unavailable | Return an explicit inconclusive qualification outcome; never convert it into a conclusive passing contract result.                                                               |
| SSH-host identity unavailable    | Retry malformed handshakes and transient network failures within the contract deadline; never reinterpret a generic TCP accept or an inconclusive scan as original-host absence. |
| Runner or triage interruption    | Emit a failure run record when setup exits early; reject missing or malformed evidence instead of inferring identity or silently continuing.                                     |
| Fixture evidence missing         | Reject a malformed or unattributable fixture record; report an absent record or an unfinalized lifecycle explicitly rather than as a failure with no related resources.          |

The internal `provisionRunningPersistentVm` journey has two concrete consumers:
normal lifecycle and host loss. Its submission portion prepares family
fixtures, calls `reserve`, and then invokes the family-owned
`submitPersistentVm` operation with the resulting `TrackedWorkloadRef`.
That operation alone serializes and sends the canonical CLI request, including
the target's placement inputs; adapters cannot replace that entry point.
`awaitPersistentVmRunning` owns the `Running` transition, canonical runtime
profile, SSH evidence, and one-live-VM invariant. Normal lifecycle continues
through workload repair on the same host and a family terminal stage composed
from `requestTermination`, exact `Terminated`, persisted cleanup, VM-ledger
completion, provider termination, identity-aware release of the SSH host
captured immediately before termination, and `release`.

Host observations have four distinct product outcomes:

| Observation                                                 | Required product behavior                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Workload container is absent but its VM host is reachable   | Repair the container on the original VM and remain `Running`           |
| SSH observation fails and the provider confirms host alive  | Preserve the workload and defer; do not replace or fail it             |
| Provider status is unavailable or unknown                   | Preserve the workload and defer; absence has not been established      |
| Provider confirms the sole persistent-VM host is terminated | Transition to `Failed`, clean up, and never provision a replacement VM |

Job host loss is not a variant of this contract. A Job may recover through
replacement capacity because it does not promise persistence of a host-local
workspace. `Job host recovery` owns that opposite behavior and cannot branch on
workload type inside the persistent-VM contract.

Normal lifecycle and host loss use separate fixture-scoped workloads because
normal termination and external destruction are mutually exclusive terminal
paths. Host loss adds one family-specific adapter operation:
`deleteHost(context)`. The contract constructs the context from the persisted
live VM identity, including its cloud ID and location fields. The adapter
deletes exactly that host outside Anycloud and returns after the provider
accepts the operation. It cannot wait on Anycloud state, manufacture the
expected outcome, create a replacement, assert behavior, or control cleanup.
The active VM row is authoritative for per-attempt location: its region and
availability zone win over workload-level requested values, with workload
metadata used only as a fallback when the provider did not return a per-VM
value. This prevents capacity fallback from directing a GCP deletion at the
requested zone instead of the zone that owns the live instance.

After recording an event baseline and invoking `deleteHost`, the contract
requires:

- `Failed` within the bounded host-loss deadline;
- terminal metadata containing the original cloud ID and the exact reason
  `Cloud provider confirms VM host no longer exists; Anycloud cannot recover its local /workspace.`;
- a Running snapshot that may include ended capacity-retry rows but contains
  exactly one live original VM;
- no VM-ledger identity added or removed after that snapshot;
- the original live row ended no earlier than the terminal transition;
- no later `Recovering`, `Queued`, or `Provisioning` event;
- `cleanedAt` present and no earlier than `completedAt`;
- no live or replacement VM remaining; and
- fixture cleanup remaining armed until all postconditions are observed.

The provider-confirmed `Failed` transition is authoritative; an adapter cannot
produce it through an Anycloud API call. All six VM-host targets invoke this
extension. AWS, Azure, and GCP may eventually share their private external
deletion operations with Job recovery because the surveyed legacy scenarios
provide a second consumer. Lambda, Vast, and local smolvm remain host-loss-
specific until another inventoried consumer passes the evidence gate.

The lifecycle foundation is structurally established only when:

- all six targets invoke the same persistent-VM runner;
- every member satisfies the exact thin-spec lint rule;
- the contract composes the tracked-workload kernel and owns family setup,
  submission semantics, state/runtime/SSH assertions, repair, terminal
  postconditions, and substrate cleanup evidence;
- target differences are fixed adapter observations rather than optional
  hooks;
- local smolvm proves the common lifecycle plus its machine, port, and removal
  observations;
- Bash and constrained lifecycle use the same versioned SSH-host identity
  protocol and target-specific bounded release policy;
- forced failures at representative stages prove cleanup remains armed;
- contract and adapter unit tests pass; and
- each Bash/Vitest pair remains independently runnable through qualification.

A target's persistent-VM family is fully accepted only when host loss also:

- invokes the shared provision-to-Running journey on a separate workload;
- exposes only exact external deletion through its adapter;
- proves terminal `Failed`, the exact reason, complete cleanup, and no recovery
  or replacement;
- covers success, deletion failure, provider delay, assertion failure, and
  cleanup failure in contract and adapter tests; and
- reaches its qualification threshold alongside the legacy host-loss phase.

Lifecycle and host loss retain separate migration rows. A combined Bash
invocation may supply both legacy observations, but each count advances only
when that phase and its candidate are conclusive. Neither row can substitute
for the other, and both must reach Vitest primary before the target's legacy VM
scenario can be retired.

### 9. Serve assertion inventory and migration contract

This section is the normative input to the Serve migration. It records the
assertion ownership and target membership before implementation so the
constrained suite cannot treat the most recently ported target as the implicit
model for every other target.

The existing sources have different scopes and therefore cannot be counted as
interchangeable parity evidence:

| Legacy source                                                            | Execution boundary                                                | Assertions it currently proves                                                                                                                                                                                                                                                                                                     | Assertions it does not prove                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `run_serve_smoke_test`, invoked by AWS, Azure, GCP, and Lambda CPU tests | Public CLI and API                                                | Accepted CLI submission; persisted `workloadType=service`; `Running`; nonempty DNS record ID; deterministic public HTTPS; service, env-file, direct-env-override, and named-secret markers; no live VM ledger row after cleanup                                                                                                    | Explicit `Terminated`, cleanup timestamp ordering, or independent provider-host absence                           |
| `local-smolvm-serve.test.sh`                                             | Credentialless CLI plus the local smolvm and Docker control plane | Credentialless CLI acceptance without an advertised public URL; a complete persisted `Starting` checkpoint; restart adoption; `Running`; one live VM and one owned microVM; null DNS; valid SSH/HTTP mappings; guest container identity; mapped HTTP; replacement upgrade; `Terminated`; no live VM, machine, or open tracked port | Env-file precedence, named-secret injection, or public ingress                                                    |
| `run_serve_upgrade_test`, invoked by AWS                                 | Public CLI and API                                                | Initial `Running`; live cloud ID; v1 public marker; accepted upgrade; durable `serve-upgrade` event; return to `Running`; different cloud ID; v2 at the same URL; no live VM row after cleanup                                                                                                                                     | Azure, GCP, or Lambda execution; explicit old-host absence; explicit terminal state or cleanup timestamp ordering |
| AWS, Azure, GCP, and Lambda GPU Serve tests                              | Public CLI and API through `run_serve_smoke_test`                 | The entire public smoke flow plus successful `nvidia-smi` and `nvidia-smi -L` before the HTTP server starts; GCP also exercises explicit `--runtime nvidia`                                                                                                                                                                        | An explicit assertion over the GPU enumeration lines already written to the response body                         |

The baseline is the shared user-visible contract, not the intersection of the
weakest legacy sources. Every AWS, Azure, GCP, Lambda, and local-smolvm baseline
member must:

1. obtain a tracked workload reference, which arms automatic cleanup, before
   the first resource-producing mutation;
2. submit one Service with unique service, environment, and override markers;
   CLI-backed targets must source the environment marker and an initial
   override value from a fixture-owned env file, then replace the latter with a
   direct environment flag;
3. prove accepted submission and the canonical persisted Service type
   (`service` on the status wire);
4. reach persisted `Running` and prove exactly one ready backing workload
   through the target's fixed ready observation;
5. resolve the target's supported endpoint and observe the service marker,
   environment marker, and direct override;
6. request termination, reach persisted `Terminated`, and prove completion and
   cleanup timestamps are ordered;
7. prove that no live VM-capacity ledger entry remains; and
8. run the target's fixed absence observation while fixture cleanup remains
   armed.

The terminal stage additionally proves authoritative DNS absence for public
Services and exact named-bundle deletion readback. Those are explicit
candidate additions, not claims about historical Bash parity: the legacy public
scenarios never established DNS-removal behavior. Every delegated authority must
answer for the exact hostname; an unavailable HTTP endpoint, partial authority
coverage or unknown native state cannot establish absence. Local members prove
closed forwarded ports without claiming public DNS coverage.

The common `Terminated` requirement matches the production VM-host Service
control plane. The terminate route commits `Terminated` before responding for
every active Service, and cleanup records `cleanedAt` only after runtime cleanup
returns. RFC 0032 owns any future proof that cluster placement preserves that
same public lifecycle.

The environment outcome is target-neutral: every workload must receive the
same resolved values and direct value must win. Submission mechanics are not.
Public-cloud targets prove the env-file/direct-flag merge. Local uses the
ordinary credentialless Service CLI and its named recovery/upgrade journey;
its map distinguishes that boundary from public ingress and env-file coverage. That fixed transport difference cannot
omit endpoint assertions. User-named secret bundles remain a required
VM-host extension. Cluster-backed secret projection is deferred with the rest
of RFC 0032 rather than represented as a partial current baseline.

#### Serve composition over the workload kernel

Serve shares compatible family stages, and every stage composes the common
kernel explicitly:

```text
submitServe
  native cleanup reservation -> adapter.submit(ref) -> assert accepted/type
       |                                     |
       |-- awaitServeReady -----------------> baseline / GPU / upgrade
       `-- Starting checkpoint -> restart/adopt -> awaitServeReady

final ready context
  -> optional before-finalize fault after journey evidence
  -> observeServeTermination
     kernel.requestTermination
     -> exact Terminated
     -> kernel.waitForCleanupRecorded -> cleanup proof
     -> cleared ledger + all historical native identities absent
     -> authoritative DNS / Local ports + durable named-bundle absence
     -> child-resource cleanup -> kernel.release(cleanup proof)
     -> one completion
```

`submitServe` chooses the profile and request, obtains the
`TrackedWorkloadRef` before submission, calls an adapter that requires that
reference, and proves family-specific acceptance and the canonical persisted
Service type. It returns a pending Serve context but performs no readiness or
terminal work. `awaitServeReady` owns the `Running` transition, endpoint
markers, closed target-ready observation, and recording every backing identity.
`provisionReadyServe` is only their ordinary composition.

The starting-state reconciliation extension uses `submitServe` directly,
inserts its fresh `Starting` checkpoint and fault/adoption assertions, then
rejoins `awaitServeReady`; it cannot call a journey that has already reached
`Running`. Upgrade starts with `provisionReadyServe`, returns an updated ready
context containing the original and replacement identities, and then enters
the common family terminal stage. GPU selects its fixed request/profile before
submission and retains the privately owned `ActiveServeBaseline` through
`GpuServeEvidence` to the single finalizer. Copied/foreign objects, profile or
native-coordinate drift, missing GPU evidence and early/repeated completion
cannot authorize release. The closed `gpu-serve` family exposes only
`contracts.gpuServe(target)` to its four thin specs.

The pending and ready contexts carry the opaque workload reference rather
than a mutation-authorizing string ID. A ready context additionally contains:

- target and validated profile identity;
- immutable environment-probe expectations;
- the persisted ready status;
- the closed public or local-smolvm endpoint/ready observation;
  and
- every fixture-recorded backing identity observed so far.

It contains no secret plaintext, raw provider response, HTTP/process client,
or optional assertion callback. It cannot upgrade, restart, terminate, release
fallback cleanup, or delete resources on its own. `observeServeTermination`
accepts the final ready context and joins the kernel termination request and
persisted cleanup with Service-owned terminal, timestamp, ledger and independent
absence assertions. The finalizer releases child resources before passing the
opaque proofs to `release`, then writes one completion record. Baseline,
recovery, upgrade and GPU reuse that terminal behavior. The existing native
cleanup hook registers the same Service DNS/port and named-bundle checks before
creation, so forced failure and cancellation cannot release a Workload early.

The stages and contexts remain private to Serve, while the kernel beneath them
is shared across workload types. Controlled-adapter tests prove that
submission receives a previously reserved reference and performs no readiness
or terminal work; readiness neither submits nor terminates; reconciliation
orders its checkpoint and fault before readiness; upgrade carries every
capacity identity forward; and termination does not release cleanup before all
recorded identities have been probed. Kernel tests separately prove branded-ID
matching, exact-state versus absence behavior, fallback teardown, and release
ordering. Resource-fixture tests prove env-file and named-secret cleanup after
failures at each consuming stage.

#### Serve probe and transport prerequisites

Before the first Serve adapter, the existing Persistent VM contracts move to
the tracked-workload kernel. That prerequisite is now complete, establishing
one lifecycle foundation rather than leaving Serve beside the former
`DeploymentManager`. The provider host-presence query below is complete as of
2026-08-22: every public VM host answers the same one-shot query, and the
Persistent VM contract now proves AWS, Azure, and GCP release through it
instead of accepting the controller's own terminal record as evidence. Serve
then extracts the remaining evidenced probes and target transports below. An extraction is not complete when a wrapper exists:
the same change unit-tests it and rewires at least one existing consumer. Each
later Serve target rewires the corresponding Persistent VM target transport
before or with its adapter.

| Private mechanism            | Exact input and typed output                                                                                                                                   | Failure, redaction, and cleanup ownership                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider host-presence query | A provider-specific profile and exact ledger-derived host identity/location; one result of `present`, `absent`, or `unknown` plus a redacted diagnostic        | One provider request only. Authentication or schema violations throw a redacted error; an unavailable/transient provider response is `unknown`, which never satisfies absence. The calling contract owns polling and its deadline. The transport owns no cleanup.                                                                                                                                                                                                                 |
| Local smolvm transport       | The configured smolvm base URL plus an exact ownership prefix or machine name; validated machine/port records, exact guest-port decoding, or argv-exec results | Each method performs one read/exec operation and rejects malformed records, invalid TCP ports, and missing or duplicate required port mappings. Port order has no meaning: SSH is guest port 22. Output passes through fixture redaction. It cannot poll Anycloud state, select an outcome, or own cleanup; Persistent VM, Serve, and Job adapters retain distinct assertions. Exact-machine deletion stays private to host loss until a second inventoried consumer requires it. |
| Environment probe fixture    | Collision-safe keys and marker prefix; fixture-owned env-file path, direct environment map, and immutable expected resolved values                             | File creation failure aborts before submission. The fixture owns file removal. It has no secret value, provider selection, expected lifecycle state, or endpoint assertion.                                                                                                                                                                                                                                                                                                       |
| Named-secret probe fixture   | Collision-safe name/value prefix; registered secret name and expected digest, never plaintext                                                                  | It registers redaction before output or artifacts can contain the value and registers LIFO deletion before creation. Creation/deletion use `SecretManager`; only contracts with required named-secret membership may request it.                                                                                                                                                                                                                                                  |

Provider-presence reuse strengthens existing coverage rather than merely moving
code. Lambda and Vast already perform provider-direct normal-termination
observations. When AWS, Azure, or GCP gains its Serve presence query, its
controller-only Persistent VM termination observation is replaced by the same
private one-shot transport and independently asserted by the Persistent VM
contract. Serve never imports or calls a Persistent VM adapter.

Target observations are closed, stage-specific schemas. They return facts to
the contract and cannot wait for Anycloud state or choose which assertions run:

| Target class                     | Required ready observation                                                                                                                                                  | Required absence observation                                                     | Existing evidence and candidate delta                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS, Azure, GCP, Lambda VM hosts | Exactly one live VM ledger identity and a target-resolved HTTP endpoint                                                                                                     | Every fixture-recorded provider host is absent and no live VM ledger row remains | Public smoke currently proves the endpoint and ledger cleanup but not provider-host absence; reuse the private provider observation mechanism, not a persistent-VM journey |
| Local smolvm                     | Exactly one running owned microVM matching the sole live cloud ID; nonzero, distinct SSH and HTTP ports; present guest container; null DNS/public URL; mapped HTTP response | No owned microVM and every fixture-recorded forwarded port is closed             | The legacy local test already supplies these observations; the baseline preserves them without exposing smolvm operations to the spec                                      |

The absence stage composes `Workload substrate absence` against the same paid
workload. Service owns when it is required; reusable private target transports
own only the substrate query. This preserves stronger local cleanup evidence
while closing the public-provider gap without duplicating provider clients in
the Service family.

The remaining assertions are fixed target classifications, named extensions,
or adjacent families:

| Classification                | Contract-owned assertions                                                                                                                                                                                                                                                                                                     | Legacy evidence and disposition                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public ingress                | Nonempty persisted DNS record ID, deterministic `https://<id>.anycloud.sh`, and required markers over HTTPS                                                                                                                                                                                                                   | A required fixed baseline observation for AWS, Azure, GCP, and Lambda. Local smolvm has an exact null URL/DNS boundary. The legacy tests do not establish DNS-removal behavior, so this RFC does not claim it as migrated parity. |
| Named secret injection        | Register a named secret before creating it; submit only its name; verify its injected value through a one-way expected digest and a response marker without printing plaintext; delete it during fixture cleanup                                                                                                              | Required for VM-host Service targets. Public smoke already proves it. Local smolvm uses the same VM-host runtime but lacks legacy coverage, so the candidate closes that gap.                                                     |
| Starting-state reconciliation | Capture one fresh persisted `Starting` checkpoint after the workload and endpoint are operational; hard-restart the API without recreating its container; recover health; adopt the same backing workload identity and endpoint mapping; then reach `Running` with the v1 marker                                              | Required for local smolvm by its existing scenario. Other targets remain unresolved below; the fault-injection validity check (same API container ID) stays in the fixture, while adoption assertions stay in the extension.      |
| Upgrade                       | Start from the shared ready journey; accept an upgrade; record the durable `serve-upgrade` transition; return to `Running`; replace backing capacity; preserve the logical Service identity and target-specific endpoint boundary; serve the v2 marker; retain exactly one backing workload; then terminate and prove absence | Existing consumers are AWS and local smolvm. The common API and `ServeRuntime` route make upgrade required for every supported VM-host Service target; missing Azure, GCP, and Lambda wrappers are coverage gaps.                 |
| GPU                           | Run the baseline workload with requested GPU exposure; require `nvidia-smi` success and at least one explicitly asserted device-enumeration line before accepting endpoint readiness                                                                                                                                          | Required for the four public VM-host targets with existing tests. The explicit response assertion strengthens their current indirect check. Local smolvm has no GPU-passthrough qualification substrate.                          |

Target-classification and extension membership are closed independently of
baseline membership:

| Serve concern                 | Kind                       | AWS                                  | Azure                                | GCP                                  | Lambda                               | Vast                                          | Local smolvm                                               | Kubernetes                                          |
| ----------------------------- | -------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------ | ------------------------------------ | --------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Public ingress                | Fixed baseline observation | Required                             | Required                             | Required                             | Required                             | Unsupported — baseline Service is unsupported | Unsupported — no public endpoint                           | Unsupported — `--port` Deployment is its own family |
| Named secret injection        | Named extension            | Required                             | Required                             | Required                             | Required                             | Unsupported — baseline Service is unsupported | Required                                                   | Unsupported — `--port` Deployment is its own family |
| Starting-state reconciliation | Named extension            | Evaluate — no legacy fault injection | Evaluate — no legacy fault injection | Evaluate — no legacy fault injection | Evaluate — no legacy fault injection | Unsupported — baseline Service is unsupported | Required                                                   | Unsupported — `--port` Deployment is its own family |
| Upgrade                       | Named extension            | Required                             | Required                             | Required                             | Required                             | Unsupported — baseline Service is unsupported | Required                                                   | Unsupported — `--port` Deployment is its own family |
| GPU                           | Named extension            | Required                             | Required                             | Required                             | Required                             | Unsupported — baseline Service is unsupported | Unsupported — smolvm test substrate has no GPU passthrough | Unsupported — `--port` Deployment is its own family |

An `Evaluate` cell in this table blocks implementation of that extension, not
implementation of baseline Serve. It must be resolved to `Required` or a
concrete `Unsupported` reason before the first constrained member of that
extension is added.

The migration mapping is consequently explicit:

| Legacy entry point                                                      | Constrained contracts sharing its workload where compatible                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws-serve`, `azure-serve`, `gcp-serve`, `lambda-serve`                 | Baseline Serve, including public ingress, + named secret injection + substrate absence                                                           |
| `local-smolvm-serve`                                                    | Baseline Serve + named secret injection + starting-state reconciliation + upgrade + substrate absence, retaining the current compatible ordering |
| `aws-serve-upgrade`                                                     | Upgrade + fixed public-ingress observation + substrate absence until the shared public upgrade contract is qualified across all required targets |
| `aws-gpu-serve`, `azure-gpu-serve`, `gcp-gpu-serve`, `lambda-gpu-serve` | Baseline Serve, including public ingress, + named secret injection + GPU + substrate absence                                                     |

Implementation exposes only the staged family internals above:
`submitServe`, `awaitServeReady`, their `provisionReadyServe` composition, and
`terminateServe`. A closed ready-observation union includes the public-ingress
boundary; separate baseline, named-secret, reconciliation, upgrade, and GPU
assertion modules compose the stages. It does not add `publicIngress`,
`namedSecret`, `restart`, `upgrade`, or `gpu` booleans to one runner. Compatible
modules may share a workload through a named, fixed composition, but each
owns its assertions and closed membership. Thin target specs select only a
target and one named contract or composition; target adapters cannot opt out
of a stage.

### 10. Managed Kubernetes qualification composition

RFC 0015 owns the managed-cluster requirements and current API-driven scenario;
RFC 0048 owns future autoscaling additions, and RFC 0029 owns Deployment and
targeted-Job semantics. This RFC owns the constrained architecture used to
qualify them. The current `managedKubernetes('kubernetes')` implementation is a
transitional composition, not evidence that Kubernetes is one product target.
It must be decomposed without multiplying the two paid Clusters or losing any
live acceptance assertion.

The public-resource authority graph is:

```text
TrackedClusterRef
  `- reserve Deployment under this exact Cluster
       `- TrackedDeploymentRef
            `- reserve targeted Job against this exact Deployment
                 `- TrackedWorkloadRef + immutable parent binding
```

The Deployment kernel is a sibling of the Workload and Cluster kernels. It
registers fallback cleanup before creation; binds one server ID to one active
Cluster ref; requires the exact active Deployment ref for create, read, update,
Pod fault injection, targeted submission, and delete; and rejects forged,
stale, released, wrong-ID, and cross-Cluster authority. It mints a one-use
deletion record only after durable deletion. Native Kubernetes absence remains
an independent observation, and a Cluster cannot release while a tracked child
Deployment remains live.

The corrected qualification graph is:

```text
reserve two Clusters before mutation
  -> create and await two isolated Ready Clusters
  -> reserve/create one tracked Deployment per Cluster
  -> prove Deployment readiness, placement, and cross-Cluster isolation
  -> submit targeted Jobs bound to the exact Deployment refs
  -> prove queue, claim, execution, result, retry, cancel, and resubmit fences
  -> lose admission and claimed-observation replies; recover the same Job/revision
  -> prove independent cancellation watchers and acknowledgement-before-release
  -> hard-crash and replace the Anycloud API with resources live
  -> prove Deployment/Job adoption and GPU plugin/application recovery
  -> reject Cluster deletion while a child Deployment is live
  -> complete Jobs; drain/delete Deployments; prove durable/native absence
  -> delete Clusters independently; prove history and capacity absence
  -> release child refs before parent refs
```

Resource modules own their assertions. `managed-cluster` owns identity,
connection/capacity readiness, isolation, capacity replacement, controller
continuity, deletion, and capacity release. `deployment` owns immutable Cluster
binding, application readiness, configuration generation, drain-before-rollout,
Pod replacement, deletion, and native absence. `targeted-job` owns admission,
queue/saturation, claim deadline, duplicate ID, execution fence, terminal
result, retry/resubmit/cancel, response-loss recovery, cancellation-watcher
isolation, runtime loss, cleanup, and zero dedicated-VM attempts. The outer
qualification owns only sequencing and facts spanning more than one of those
resources.

A targeted Job retains its Workload record but has no dedicated-Job
container substrate of its own. Its Deployment application claims the existing
Job ID. It therefore cannot inherit dedicated-Job image, bucket, secret, SSH,
per-container logs/exec, VM replacement, or storage-finalization assertions.
The application and Deployment own Pod identity and application logs. Native
Pods and execution UUIDs are observations/fences, not public resources.

The managed concurrency stage added earlier remains normative during the
split. It starts the first two targeted submissions concurrently through one
installed public Python `AsyncClient`, awaits them only after both have started,
and proves both were claimed at submission revision zero against the selected
tracked Deployment. The driver cancels and gathers unfinished siblings in a
`finally` block and the client context closes the transport on failures; a
successful observation records `transportClosed: true` and `pendingTasks: 0`.
It does not currently serialize those two fields after an exception, so the
split must preserve cleanup behavior without claiming a failure receipt that
does not exist. Installed `Client` and `AsyncClient` wheel identity,
`kubernetes-async-submissions.json`, the fixture record, and the E2E run record
remain required 30-day artifacts. A serial-submission control must fail.

The cancellation-watcher behavior accepted earlier also remains normative:
completion closes only that Job's watcher, another active Job continues
observing cancellation, and termination is not released before cancellation
acknowledgement and watcher shutdown. The lost-reply behavior accepted later
adds two required AsyncClient paths—one lost admission reply and one lost
claimed-observation reply. Each recovers the original Job and submission
revision with one admission, zero resubmissions, one execution and work start,
stable Deployment/Pod/container/image identity, installed SDK/API/source
identity, closed transport, zero pending tasks, and persisted cleanup.

Managed GPU behavior is a named qualification extension over these resource
modules. It owns MACE numerical evidence, warm application reuse, device-plugin
recovery, GPU scheduling, capacity replacement correlation, and its cleanup
receipt. It does not define the targeted-Job baseline or the four VM-host GPU
Service members.

#### Local managed-Kubernetes substrate

The fixture keeps the concrete qualification implementation under a private
substrate boundary such as
`test/integration/e2e/internal/substrates/local-managed-kubernetes/`. It
contains the local API child composition, a production supervisor host,
capacity `CloudCompute` implementation, Docker command transport, and
observations. It is not imported by specs or family contracts.

The intended module seams are concrete rather than a pluggable substrate
framework:

```text
internal/substrates/local-managed-kubernetes/
  environment.ts       versioned child configuration and run ownership
  api-child.ts          environment-before-import production API composition
  supervisor-host.ts    production supervisor and Unix transport host
  capacity-compute.ts   Docker-backed k3s-agent CloudCompute implementation
  observations.ts      product-shaped Kubernetes and ownership facts
  protocol.ts           ready record and fixture-private fact messages
```

The parent passes one validated, versioned child configuration rather than
mutating its own global environment. The child uses a fixture-private typed
facts protocol for capacity history and runtime identity that the production
API does not expose. That protocol is validated on both sides, emits no secret
material, and is consumed only by lower-level probes; it is not a public API,
contract capability, or copied model of an oRPC response.

The substrate supplies only the production ports and outcome-neutral facts
needed by the composition:

- a managed Kubernetes control plane whose identity and connection revision
  survive Anycloud API replacement, reached through the configured production
  supervisor client;
- Docker-backed k3s agents standing in for raw cloud capacity VMs through the
  production capacity reconciler;
- cluster capacity-ledger snapshots, including retained ended attempts;
- Kubernetes workload, Service, Endpoint, Pod, node-placement, and absence
  observations; and
- exact run-owned control-plane, agent, network, and port presence.

Docker-backed agents may correspond to cluster-owned VM ledger rows because
they implement the capacity port. The supervisor-owned k3s server container,
Kubernetes Nodes, Pods, Services, and other scheduler resources do not become
`vms` rows. Contracts receive typed product facts or opaque snapshot
comparisons, never raw SQL repositories, Kubernetes SDK clients, Docker
clients, or parsed command output.

Every concrete local resource carries the fixture run's ownership label and a
collision-resistant logical identity. Fallback cleanup is registered from the
reserved unique cluster name before the API create mutation. The kernel binds
the returned ID or resolves the exact name after a lost response, so it can
discover and remove an owned cluster after persistence or substrate mutation.
Passing cleanup requires exact absence of all run-owned control planes, agents,
networks, and recorded ports; a broad best-effort sweep or warning is
insufficient.

The local substrate never appears in public resource identities,
provider/profile unions, adapter maps, or contract completion records. The
local and cloud-backed environments implement one narrow, contract-private
qualification interface and are consumed by the same transport. That interface
contains substrate facts and fault operations only; it cannot add conditional
contract stages, construct cluster orchestration, or weaken the resource
outcomes.

The replaceable API child calls the same default cluster composition as a
hosted API. It configures the supervisor socket and injects only the capacity
compute/profile boundary. Repository lint rejects direct imports of the cluster
domain, controller, reconciler, or managed-control-plane implementation from
that child. This makes the local run evidence for production wiring rather than
a parallel in-test implementation of the same lifecycle.

#### Real controller-process replacement

“API restart” in this composition means the Anycloud Node.js API process, not a
Kubernetes API or k3s control plane. With clusters and workloads live, the
fixture sends an ungraceful termination such as `SIGKILL`, observes that
incarnation exit, and starts a new child with:

- a different PID and launch nonce;
- the same bound API port and client-visible endpoint;
- the same state root, SQLite database, encryption material, and fixture run
  identity; and
- the existing k3s control planes, agents, and workload resources untouched.

The child sets its environment before dynamically importing production
modules. Its only readiness signal is the strict versioned record described in
Section 1. The parent rejects a record for another nonce or PID and reconnects
the endpoint-scoped controller session only after the replacement is healthy.
This exercises persistence and runtime reconstruction rather than preserving
module globals in the test process.

The lower-level fault boundary is shared with local-smolvm Starting-state
reconciliation: abruptly replace the Anycloud controller while durable state
and workload substrate remain. The transports differ. Local smolvm kills and
starts the same outer API container; local Kubernetes kills and spawns a child
process. Their behavioral contracts remain separate: smolvm asserts adoption
of its Starting Service and stable mapped endpoint, while managed Kubernetes
asserts both Clusters, their Deployments and targeted Jobs, capacity history,
application continuity, and native resource continuity.

#### Required implementation and failure proofs

The fixture foundation is complete only when unit and controlled-adapter tests
prove:

- child failure before readiness leaves no session and reports retained logs;
- stale, malformed, duplicate, and unknown-version readiness records fail
  closed;
- a lost create response after cluster persistence still triggers exact
  run-scoped cleanup;
- every Deployment mutation requires its pre-registered active ref and exact
  Cluster parent, and Cluster release rejects a live child;
- an assertion failure plus one or more cleanup failures preserves the primary
  error and every cleanup cause while later cleanup actions still run;
- abrupt controller death with live workloads creates a new PID on the same
  endpoint and durable state; and
- Deployment and Cluster deletion cannot release fallback cleanup before their
  respective durable deletion, child/capacity completion, and native absence.

The live local managed-Kubernetes composition proves the fixed graph through
`yarn test:local-k8s-e2e`. The package command and CI job remain stable while
the internals split into resource-owned modules. The split must retain every
existing assertion, the earlier concurrent installed-SDK evidence, one CPU cloud
receipt per supported managed-capacity provider, and one conclusive managed-GPU
MACE receipt before the monolithic contract is removed.

The controller session continues to consume RFC 0018's owning oRPC clients and
schemas rather than copied wire types. RFCs 0015, 0048, and 0029 continue to own
product assertions; this section owns their constrained authority and
composition seams.

### 11. Migration order

1. Establish the lint boundary, automatic fixture, contract tests, dedicated
   configuration, and isolated Shadow execution.
2. Refactor the AWS persistent-VM pilot into a fixed family runner before
   adding another target.
3. Implement persistent-VM lifecycle for AWS, Azure, GCP, Lambda, Vast, and
   local smolvm, then accumulate independent qualification alongside Bash.
4. Keep the implemented persistent-VM host-loss extension in Shadow and
   qualify each target once its corresponding product behavior and legacy phase
   are available. Host loss remains required before VM Bash retirement but does
   not block migration of an independent family.
5. Completed on 2026-08-18: replace the transitional `DeploymentManager`
   surface with the audited tracked-workload kernel. Return an opaque
   reference from `reserve`; require
   it in creation, upgrade, resubmit, and termination transports; split the
   termination request from persisted cleanup; require the one-use persisted-
   cleanup proof to release fallback cleanup; separate exact `Terminated` from
   absence; rename the VM-only ledger query; narrow the public fixture; and
   rewire both Persistent VM contracts and every target adapter. Preserve their
   behavior and Shadow rows while unit-testing each enforcement boundary.
6. Completed historically: add the failure boundary, `ManagedProcess`,
   endpoint-scoped controller session, tracked-Cluster kernel, and constrained
   managed-Kubernetes composition; repoint `yarn test:local-k8s-e2e` and delete
   the standalone implementation.
7. Before another Bash retirement, land the exact 56-source disposition
   inventory, fingerprinted paired-run/resource-mode failure protocol, and
   atomic promotion policy in this amendment. Reset pre-protocol Shadow counts.
8. Add tracked Deployment authority bound to one tracked Cluster, bind targeted
   Job submission to that exact Deployment, and delete obsolete direct
   Kubernetes Job/Service adapters and the unit-only generic Job contract.
9. Split the managed composition into Cluster, Deployment, targeted-Job, and
   cross-resource qualification modules. Preserve one paid composition, every
   existing assertion, and the earlier concurrent installed-`AsyncClient`
   transport-cleanup evidence before removing the monolith.
10. Add AWS, Azure, GCP, and Lambda GPU Service extensions over the active
    VM-host Service baseline. Keep MACE and GCP disk-tier behaviors unchanged;
    cluster-backed Service remains deferred to RFC 0032.
11. Build the dedicated-Job baseline and its storage, output, invalid,
    configuration, recovery, image, and provider extensions. Preserve the
    existing AWS/Azure/GCP VM and boot-disk identity checks, Azure checkpoint-before-
    delete/replacement/restoration proof, exact four required recovery
    receipts, and complete 14-member workflow matrix.
12. Freeze each member's contract and assertion-map fingerprints, collect three
    consecutive paired real-cloud matches or five local/no-provision matches,
    and record one live forced-failure cleanup receipt for provisioning or
    exact `Not applicable` for no-provision. Retire a source only in a later
    atomic CI/package/registry/disposition change, and only after every member
    sharing it is eligible.
13. Move benchmark, hosted-API, operations, and artifact sources to their
    recorded owners. Convert unique scenarios individually, keep the destructive
    account cleanup backstop last, and delete `helpers/common.sh` only after
    policy proves it has no consumers.

No provider member is implemented by copying another provider's spec body. A
family runner and adapter boundary exist before additional variants are added.

### 12. Size model and reuse accounting

The 2026-09-16 reinventory supersedes this section's predictive 3,500–5,000-line
target. The constrained tree is now 21,030 lines and its E2E-focused unit files
are 10,603 lines before a correct dedicated-Job family exists; the 56 root
shell sources add 8,223 lines and `helpers/common.sh` adds 6,225. These figures
make a fixed final-size target actively misleading. New work is measured by
removed duplication, complete assertion preservation, and enforced resource
authority. The dated measurements below remain implementation history.

The initial 400–700-line estimate for the first family was too low. Physical
line counts after formatting on 2026-08-18 are:

| Surface                                                                    | Lines |
| -------------------------------------------------------------------------- | ----: |
| Complete constrained E2E TypeScript tree                                   | 4,755 |
| Persistent-VM shared journey, both contracts, target modules, and 12 specs | 2,236 |
| Persistent-VM contract and adapter unit tests                              | 1,389 |
| Twelve persistent-VM target specs alone                                    |   120 |
| Net constrained E2E TypeScript increase for the host-loss extension        |   849 |

That table is the pre-kernel-refactor baseline. The completed step 5 measures:

| Post-kernel surface                                                   | Lines | Change from baseline |
| --------------------------------------------------------------------- | ----: | -------------------: |
| Complete constrained E2E TypeScript tree                              | 5,439 |                 +684 |
| Kernel, guarded mutation, VM-ledger, and credential transport modules |   783 |                  n/a |
| Persistent-VM contract, adapter, and kernel unit tests                | 1,948 |                 +559 |

The increase replaces and narrows the former 300-line manager, rewires both
contracts, and adds runtime, ordering, type-boundary, and lint-boundary tests;
it is not a new family-sized layer to add on top. The additional boundary
hardening is accounted for separately because runner/triage and migration-ledger
enforcement live outside the constrained TypeScript tree:

The adapter-boundary correction was remeasured after formatting on 2026-08-21:

| Corrected surface                                                            | Lines | Change from the pre-correction branch head |
| ---------------------------------------------------------------------------- | ----: | -----------------------------------------: |
| Complete constrained E2E TypeScript tree                                     | 6,270 |                                       +167 |
| Persistent-VM adapter shells and their dispatch factory                      |   149 |                                       -749 |
| One-attempt HTTP, smolvm, provider-observation, and host-deletion transports | 1,138 |                                     +1,138 |
| Persistent-VM shared journey, both contracts, and contract-owned policy      | 1,115 |                                       +246 |
| Five Persistent-VM contract, adapter, transport, and boundary unit files     | 2,185 |                                       +319 |
| Twelve Persistent-VM target specs                                            |   132 |                                          0 |

The transport row is a relocation from the former adapter modules, not a new
parallel layer. The 167-line net constrained-tree increase adds closed attempt
types, contract-owned polling and deadline policy, and composition wiring. The
lint enforcement and 286-line controlled boundary test are outside that tree.

| Boundary-hardening component       | Measured implementation surface                                                                                                                            | Included in the corrected 6,270-line tree |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Versioned run record and triage    | 108-line run-record module, 98-line fixture-record module, 66-line shared evidence helper, shared traps in both runners, and the 807-line triage processor | No                                        |
| Closed contract and adapter layers | 202-line path/capability lint rule plus the matched no-inline-configuration policy                                                                         | No                                        |
| Scoped, digest-preserving names    | 65-line fixture-name module                                                                                                                                | Yes                                       |
| Opaque VM-ledger snapshots         | 253-line VM-ledger probe                                                                                                                                   | Yes                                       |
| Migration-ledger validation        | 315-line validator plus the `yarn style` hook                                                                                                              | No                                        |

The fixture → triage record later moved the constrained tree to 6,347 lines;
its schema and reader live outside that tree with the other evidence modules.

Serve and Job are measured against this hardened post-kernel baseline. Outer
orchestration and CI enforcement remain separate from the readable constrained
test surface rather than being attributed to a future family.

The 849-line increase is not one reusable package:

| Component                                                             | Lines | Reuse classification                                                                                                   |
| --------------------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------- |
| Shared-running-journey extraction plus the remaining lifecycle branch |   113 | Demonstrably shared by lifecycle and host loss; available to compatible persistent-VM extensions                       |
| Fixture, context, types, target HTTP, files, and wait integration     |   181 | Broad mechanics with multiple legacy consumers; reuse through their narrow modules                                     |
| Exact provider host-deletion mechanisms                               |   349 | Operation-only reuse where another named consumer passes the evidence gate; outcomes and family adapters stay separate |
| Persistent-VM host-loss assertions                                    |   146 | Specific to terminal loss of a persistent VM's local `/workspace`                                                      |
| Six thin host-loss target specs                                       |    60 | Specific family-membership declarations                                                                                |

Thus 113 lines are shared now, 181 lines belong to broadly consumed
mechanics, and 349 lines can amortize only at an exact provider-operation
boundary. The remaining 206 lines express host-loss behavior and membership and
must not be generalized. Future estimates distinguish demonstrated reuse,
survey-supported operation reuse, and contract-specific coverage.

The family exceeds the planning sketch because it retains the complete legacy
assertion inventory, fixed Local and Vast observations, independent
Lambda/Vast termination probes, safe provider HTTP handling, failure-stage
cleanup proofs, parser tests, and redaction tests. Omitting these would make the
apparent reduction come from dropped guarantees.

Each provider member is nevertheless exactly 10 lines and contains no lifecycle
mechanics. The 445-line shared running journey feeds the 170-line lifecycle
branch and 146-line host-loss branch. Provider deletion mechanisms are isolated
in one 349-line module while the contract owns terminal assertions, waits, and
cleanup postconditions. The host-loss work increased the constrained tree from
3,906 to 4,755 lines; its separate unit coverage increased by 760 lines.

At that point, the readable spec-and-contract surface was tentatively estimated
at 3,500–5,000 lines. The 2026-09-16 reinventory above retires that forecast;
LOC remains design feedback, not an acceptance criterion.

Serve and the managed Kubernetes port are measured on 2026-08-22, closing the
re-measurement this section requires. Physical line counts after formatting:

| Surface                                         |  Lines |
| ----------------------------------------------- | -----: |
| Complete constrained E2E TypeScript tree        | 15,563 |
| Readable spec and contract surface              |  3,651 |
| Twenty-one target specs                         |    446 |
| Target adapters and resource probes             |  1,247 |
| One-attempt transports and concrete substrates  |  3,999 |
| Fixture kernel, mechanics, and composition      |  6,613 |
| Constrained E2E unit coverage, outside the tree |  6,986 |

On 2026-08-22, the readable spec-and-contract surface was the number compared
with the then-current 3,500–5,000-line estimate. The
complete tree is more than double its last recorded 6,347 because the managed
Kubernetes port added two concrete substrates and a controller session, which
this section holds separate from contract cost: transports and substrates alone
are 3,999 lines, and the four-category split that port owes is dominated by
categories one and two rather than by Kubernetes-only composition.

Serve cost 537 readable lines for five members across two substrates. Members
three through five cost about eleven lines each; the expense was making the
stage set describe a second substrate at all. Breadth within a family is nearly
free, and depth across substrate classes is not.

Lines are one signal; the other is how much of this document is enforced rather
than asserted. Each core invariant above records the layer that enforces it, and
`yarn check:rfc-ledgers` validates the claim — a `lint:`, `script:`, or
`graph:` mechanism must exist and be wired, while `type`, `runtime`, and `test` are
cited with only their named paths checked. On 2026-09-16 that is **6 of 16
verified wired, 6 cited, and 4 resting on review**: invariants 5, 9, 13, and 16.
Invariants 5 and 9 compare what assertions mean rather than how code is shaped;
their structural halves are enforced and the judgment half is named as judgment.
Invariant 13 remains on review until tracked Deployment authority and the
three-resource split land. Invariant 16's boundary landed earlier as a core
`no-restricted-imports` configuration, which the ledger cannot verify as wired,
so it stays recorded as review.

That number is the one to watch. Every footgun found while migrating Serve sat
on a rule this document already stated and did not enforce, and invariant 12 was
the clearest instance: the branded one-use cleanup proof protected the proof's
authenticity and never its completeness, so `release()` accepted one of the
three observations the invariant says cannot substitute for one another. The
first pass over the annotations closed that one and found invariant 8 already
enforced and mis-recorded, which is the annotation earning its place. If the
review count does not fall across releases, it is decoration and should be
removed rather than kept.

The historical managed-Kubernetes migration was measured separately against
the 1,381-line standalone program. The next decomposition report must instead
split physical lines into:

1. controller session, managed process, failure boundary, and tracked-cluster
   kernel shared infrastructure;
2. concrete local managed-Kubernetes capacity and observations;
3. Cluster, Deployment, and targeted-Job resource-owned modules; and
4. cross-resource managed-Kubernetes composition, extensions, and thin spec.

Only the fourth category is composition cost. Moving assertions among modules
does not make the resource-owned work free, and reuse does not justify copying
dedicated-Job or VM-host Service behavior into targeted execution. Re-measure
after the atomic split rather than forcing an artificial net-negative diff.

## Legacy source disposition

Source ownership is independent of contract qualification. This table covers
the exact root shell-source registry and gives every source one decision.
`Replace` means a typed owner must supersede it, `Relocate` means its behavior
belongs outside integration E2E, and `Retain` means shell remains the native
outer boundary. A retirement or relocation removes the source and its row from
the registry and this table in the same change; it does not relabel a deleted
file as retained history.

<!-- prettier-ignore -->
| Legacy source                                           | Owner                   | Disposition | Replacement or destination            | Notes                                                    |
| ------------------------------------------------------- | ----------------------- | ----------- | ------------------------------------- | -------------------------------------------------------- |
| `test/integration/api-image.test.sh`                    | System / hosted API     | Retain      | Native API-image qualification        | Docker image assembly is the outer interface.            |
| `test/integration/api-startup.test.sh`                  | System / hosted API     | Retain      | Native API-process qualification      | Process startup is the outer interface.                  |
| `test/integration/binary.test.sh`                       | CLI / release artifact  | Retain      | Native binary qualification           | The installed executable is the outer interface.         |
| `test/integration/install-script.test.sh`               | CLI / release artifact  | Retain      | Native installer qualification        | The downloaded installer is the outer interface.         |
| `test/integration/installed-wizard.test.sh`             | CLI / release artifact  | Retain      | Native installed-wizard qualification | PTY and installed artifacts are the outer interface.     |
| `test/integration/nuke.test.sh`                         | Destructive backstop    | Retain      | Independent destructive qualification | It remains last and independent of workload cleanup.     |
| `test/integration/quota.test.sh`                        | Operations / read model | Retain      | Provider-parity qualification         | Quota behavior is outside Workload contracts.            |

Nuke implementation records also retain the original local build's Docker
engine image ID and the actual API container's ID, engine image ID, and
configured reference before teardown. These engine IDs are not labeled as OCI
manifest or config digests. Both caller inventories retain their Workload
image references and controller-resolved digests from the same authenticated
list observations; this records controller configuration, not guest execution
proof. Missing, unresolved, or malformed image evidence keeps the implementation
record incomplete without discarding tracked IDs, prior observations, primary
failures, or cleanup evidence. Bash remains authoritative and qualification
counts remain zero.

## Amendment 2026-09-25: green-streak retirement

Approved by the owner on 2026-09-25 after the Lane A size review. The
qualification and retirement machinery above had grown to roughly 64,000 lines
(implementation and delivery maps, receipts, the hosted retirement authority,
the ledger validators) while retiring zero lines of Bash. From this amendment
on, a **green-streak rule** supersedes the paired-run, receipt, contract
fingerprint, and retirement-authority protocol as the sanctioned path for
retiring a Bash member. The operative record is
[`test/integration/e2e/RETIREMENT.md`](../test/integration/e2e/RETIREMENT.md),
checked by `scripts/check-retirement-table.mjs` in `yarn check:boundaries`.
That checker was deleted once every member had retired; the record is
now frozen and no longer validated.

**Rule.** A member's Bash source may be deleted once its constrained Vitest
candidate has passed on N green executions on `main`, which need not be
consecutive (owner decision 2026-09-27):

- `local-or-no-provision` members: N = 5. An execution is a `main` or
  pull-request Integration run in which the member's Vitest cell actually ran.
- `real-cloud` members: N = 3. An execution is a scheduled or dispatched run
  of the member's E2E workflow (`e2e-job`, `e2e-vm`, or `e2e-serve`) for its
  provider in which its Vitest cell actually ran.
- `real-cloud-gpu` members (owner decision 2026-09-25): N = 2, because GPU
  quota is scarce and those runs are correspondingly rare. An execution is a
  run of `e2e-gpu` for the member's provider, or of the Vast lane in `e2e-vm`
  or `e2e-job`, in which its Vitest cell actually ran. The class covers
  exactly the members whose execution needs a GPU instance: the four GPU
  Service and four MACE full-pull members, the Azure GHCR probe, and the
  three Vast members; `gcp-disk-tier` runs in `e2e-gpu` on CPU instances and
  the no-provision Vast invalid-admission member is local, so both keep
  their classes.

Cancelled and skipped runs are not executions. A run in which the member's
spec never ran is likewise **not an execution** and neither counts toward N
nor resets the streak: the harness or the local API failed to start (for
example `Local API failed to start`), or every provisioning attempt ended
`capacity-exhausted` or `insufficient-capacity` so the candidate never reached
its contract; the row's Notes may record it. A failure blocks, resetting the
streak to zero, only when a product or contract assertion fails (owner
decision 2026-09-27). An environmental failure that hits the candidate and its
Bash member identically in the same run — a third-party API quota, a provider
outage — is also **not an execution** for either, provided no product path is
implicated and nothing leaked (owner decision 2026-09-27, after the
`aws-recursion` round-4 GitHub-quota 403). A harness observation timeout, an
incomplete native read, or a fixture-cleanup or provider-side failure whose
cleanup was confirmed neither counts nor resets; the row's Notes records the
run. A job whose spec passed but whose post-steps failed is a **green
execution**: the streak is about the spec result (clarified 2026-09-26, after
the round-1 and round-2 classifications). Streaks count from
the first run after this amendment merges. Where several members share one Bash source (the Persistent
VM lifecycle and host-loss pairs, the three local smolvm Job members, the two
`secrets.test.sh` owners), every sharing member must reach N before the source
is deleted, and their rows are retired together.

**Retirement PR.** One member (or one shared source) per change: delete the
`.test.sh`, its Bash matrix cell, and any helper under
`test/integration/helpers/` with no remaining consumer; make the Vitest cell a
required check instead of `continue-on-error`; review the member's assertion
map under `test/integration/e2e/qualification/assertion-maps/` and confirm
each mapped requirement is still asserted by the candidate; set the row to
`retired` with the merge date and the map's requirement count. The checker
makes two parts of that review mechanical: every `candidateEvidence` string in
the member's assertion map must resolve to existing files and identifiers
(a warning while the row is `shadow`, a failure once it is `retired`), and a
retired member's requirement count is append-only — the map may not later hold
fewer requirements than the row records unless Notes names each removal as
`dropped <id>: <reason>`. A member whose Bash must stay is marked `retained`
with its reason. Every retirement states `Bash lines retired : lines added` in
its description. Vitest is unchanged by this rule; retirement is decided
against the candidate as it exists on `main`.

**Evidence resolution rule.** A `candidateEvidence` string is parsed as
`<file or dir/>: <identifiers> …`. File references are tokens ending in `.ts`,
`.mjs`, `.sh`, `.json`, or `.yml`, or directory tokens ending in `/`; each
resolves repository-relative, then relative to `test/integration/e2e/`, then
as a unique basename under `test/`, `src/`, `ci/`, or `.github/` (ties prefer
the E2E tree). Identifiers are the camelCase, `UPPER_SNAKE`, and
`Owner.member`, `Owner.#member`, or `file.ts::member` tokens of at least four
characters; each must occur as a word in one of the referenced files. A string
naming no file never resolves. Existing strings that fail this rule are
reported as warnings until the member's retirement PR tightens them; the rule
is not loosened to fit them. The check does not catch an assertion that still
exists but became weaker — that remains the reviewer's job against the
assertion map.

**Mutation gate** (owner-approved 2026-09-26, mechanism introduced
earlier). Each retirement batch after the first is preceded by a passing
mutation sample of the batch's members: for each member, a deliberate product
fault named against a requirement in its assertion map makes the candidate's
cell fail with the expected signature (`test/integration/e2e/mutations/`,
`mutation-sample.yml`). This turns "no weaker assertion" from a reading into
an experiment.

For `real-cloud` and `real-cloud-gpu` members the sample is interpreted per the
owner's decision of 2026-09-26 (19:15 UTC): "a member's mutation may be a kill
through the shared contract on a local cell, plus one real-cloud kill per
contract family (Job, VM, Service) as the sample." A kill on a
`local-or-no-provision` cell counts for every member whose assertion-map
requirements the same shared contract file asserts. The real-cloud sample is one
kill per family — Job, VM, Service and Hosted API (`cloud: true` sidecars, run
only with the workflow's `cloud` input) — taken once and reused by the later
retirements, which since 2026-09-27 land one PR per contract across every cloud.
The mapping of each member's requirements to its local and cloud kills is kept
in `test/integration/e2e/mutations/real-cloud-batch-1.md`. A member whose
requirements no local cell's contract asserts — the hosted-API members — is
killed only by its family's real-cloud sample. Provider-specific requirements
with no local kill, such as those of the Lambda and Vast members, are not
mutated; they rest on the member's green streak or, under the Vast exception
below, on none. Two owner exceptions apply: a contract may retire across all
clouds when Vast is its only cloud without a streak, provided every other cloud
has its full streak and the family gate holds (2026-09-27, 14:25 UTC); and the
GCP disk-tier and Azure ghcr-probe members retire by exception as targeted tests
rather than full end-to-end journeys, ghcr-probe without a full streak
(2026-09-27, 20:40 UTC).

**Frozen records — deleted.** From this amendment on, the qualification
counts, receipt sets, contract fingerprints, and forced-failure cells of the
former "Contract qualification record" ledger, the source-bound contract and
delivery maps, and the retirement authority received no further updates. W1 of
the Lane A trim deleted them on 2026-09-25, before the first
retirement; the green-streak rule never consulted them. Their last state is in
git at `90aee3d021dad5f4a2792c901e6ff78b786832f7`. The assertion maps were
exempt from the freeze and remain the per-requirement coverage-parity record;
they change with the contract.

**What W1 deleted** (2026-09-25): the implementation and delivery
maps, the managed-Kubernetes contract map, `.github/workflows/e2e-retirement-authority.yml`,
`check-qualification-policy`, `check-qualification-retirement`,
`check-qualification-provenance` and their `E2E_RETIREMENT_BASE_SHA`
plumbing, the receipt aggregator (`yarn e2e:qualification-receipt`), the RFC
0017 qualification-record validation in `validate-rfc-ledgers.mjs`, and the
"Contract qualification record" table itself. No receipt or provenance
artifact had ever been checked in. `validate-rfc-ledgers.mjs` still closes the
"Legacy source disposition" table over the root shell-source registry, the
contract class tables, and the membership matrices; that table stays until
every `Replace` row is deleted with its source.

The historical `Managed Kubernetes qualification` member has no Bash source and
no streak; it retires with the Cluster surface in W4, not through this table.

## Amendment 2026-10-05: pool Jobs, `--port` Deployments and Slurm Jobs

Approved by the owner on 2026-10-04 as tracker row RF17, from the e2e
audit of [RFC 0044](./0044-one-pool-runtime.md)'s plan. RFC 0044 runs Jobs as
bare Pods on node pools and folds pool Services into `deployment create
--port`, and the Slurm on a pilot site milestone runs Jobs through `sbatch`. This
RFC said Kubernetes was not a Service or dedicated-Job member, so none of them
had a family to join.

_Since RFC 0044 decision 26 (2026-10-13), pool Jobs run on anycloud-managed
Deployments through a runner, not as bare Pods._

**Families.** Invariant 13 and section 2 admit three families: Pool Job,
`--port` Deployment, and Slurm Job. Section 2 lists their members. They are
siblings of the VM-host families, not new targets of them: a pool Job does not
satisfy the Dedicated Job contract, and a `--port` Deployment does not
satisfy the VM-host Service baseline. The Serve concern matrix therefore keeps
its Kubernetes column `Unsupported`. If RFC 0045 retargets the Serve baseline
at `--port`, the change that adds that Kubernetes member records its cells,
since the ledger check rejects a member the matrix marks `Unsupported`.

**Invariant 10.** The ledger check requires the class-table list to name
exactly the directories under `test/integration/e2e/specs/contracts/` that hold
more than one spec, so the list changes only when the spec tree does. The pool
Job and `--port` members are top-level composition specs, like
`e2e-cluster-local`, so they belong to no directory and stay out of the list;
`e2e-pool-scaling-local` beside `e2e-pool-jobs-local` does not change it. If a
pool Job directory is created instead, the change that adds its second spec
adds it. The Slurm members share one directory, so the change that adds
`e2e-slurm-site` beside `e2e-slurm-local` adds the family to the list and its
class table, or `yarn check:rfc-ledgers` fails. The same check means RT13 and
RT14, which delete the Service and dedicated-Job members, edit section 2 and
invariant 10 in the same change.

**Invariant 16.** The local Slurm member runs real `slurmctld`, `slurmd`, and
`slurmdbd` in one container, with a stand-in `podman-hpc`. That stand-in is a
substrate stand-in, allowed for the same reason as Docker-backed capacity
compute: it replaces only the site's container runtime, while production
Slurm code submits, observes, and classifies. What only the site can prove,
such as the real `podman-hpc` pull and GPU devices, stays with the `pilot-site`
target.

**Earlier wording.** The statements in sections 8, 9, and 11 that
cluster-backed Service is deferred to RFC 0032 are historical. Services on
node pools shipped under RFC 0032, and RFC 0044 folds them into the `--port`
Deployment family.

**Order.** This amendment lands before the first change that adds one of these
members: RT8, P, RT11, or Slurm S2.

## Alternatives considered

### Keep Bash and adopt ShellSpec

ShellSpec is the strongest Bash-native option considered and can express the
current behavior, including CLI execution and external resources. It provides a
more disciplined assertion DSL than hand-written Bash. It cannot, however,
close over process/environment access, make typed resource registration
mandatory, or make provider membership execute one unoverrideable contract.

### Bats-core or shUnit2

Both add useful test organization with lower migration cost. They impose fewer
constraints than ShellSpec and leave more lifecycle and helper conventions to
review. They do not meet the goal of a small, statically enforceable spec
language.

### Ordinary Vitest plus conventions

This has the lowest up-front infrastructure cost but reproduces the current
degrees of freedom in TypeScript. Documentation and code review alone cannot
make fixture use, family contracts, resource registration, deadlines, or
cleanup mandatory.

### Granular fixture capabilities without contract runners

This centralizes mechanics but leaves provider specs free to choose different
state transitions, omit assertions, adjust waits, or terminate resources
differently. It is useful for unique scenarios but insufficient for repeated
provider behavior and is the reason contract member paths have stronger lint.

### Generic submit, ready, and terminate workflows

Making these three high-level verbs workload-type agnostic appears to
maximize reuse, but the survey shows that only their lower-level mechanics
match. Request and acceptance shapes differ at submission; readiness is
SSH/runtime, endpoint/backing-workload, or start-or-terminal depending on the
family; terminal success differs among user cancellation, natural Job outcome,
host loss, storage finalization, VM-ledger cleanup, and Kubernetes resource
deletion. One generic workflow would require family switches, callbacks, or
optional assertions. This RFC instead shares the tracked mutation, exact
status/event waits, termination request, persisted cleanup wait, and probes,
then composes them in typed family stages.

### Keep or wrap the standalone local Kubernetes program

Keeping `test/integration/local-kubernetes.spec.ts`, or invoking it as an opaque command
from Vitest, would preserve a second process, wait, diagnostics, assertion, and
cleanup architecture. This RFC instead moved its product assertions into the
constrained composition and put concrete Docker/k3s operations below private
fixture probes. The Deployment amendment now further splits that composition by
public resource without restoring the standalone program.

### Make the local Kubernetes substrate a target or use one generic resource kernel

Exposing the local Docker/k3s composition as a target would confuse a
qualification substrate with the Kubernetes product boundary and invite
local-only branches in contracts.
Combining cluster and workload tracking behind `resourceType` would similarly
hide different persistence, cleanup, history, and absence semantics. This RFC
keeps Kubernetes as the target, the local implementation private, and
cluster/workload kernels as typed siblings over a shared controller session
and cleanup mechanics.

### Executable parity registry and generic comparator

A typed migration registry could prove that every legacy name has a candidate,
but it would duplicate orchestration selection and still could not prove
equivalent assertions. A generic stdout comparator would couple tests to
incidental messages and timing. The Markdown records plus repeated isolated
runs provide rollout evidence without a second pseudo-test suite.

## Risks & caveats

- A generic contract can become a lowest-common-denominator test. Required
  behavior stays mandatory; genuine differences use named extension contracts
  rather than skip flags.
- A target adapter can become an escape hatch. Keep interfaces family-specific,
  return fixed observations, and prevent specs from importing adapters.
- A powerful fixture can become a new monolith. Keep capabilities narrow and
  split internal modules while preserving one public import.
- A private local substrate can leak into the product contract. Keep it out of
  public unions and return product-shaped Kubernetes facts, not substrate
  handles or conditional capabilities.
- An in-process reconstruction can falsely pass restart coverage because
  module globals survive. Require a new API PID and nonce over unchanged
  durable state while independent workload resources remain live.
- Teardown can hide the original failure or stop after its first error. Capture
  diagnostics first, preserve the primary failure, aggregate cleanup causes,
  and continue every registered LIFO action.
- A tracked reference can become ceremony without safety if raw mutation
  clients remain reachable. Enforce import boundaries, active-reference
  validation, and outgoing-ID equality together; the TypeScript brand alone is
  insufficient.
- Control-plane cleanup can be mistaken for substrate absence. Keep exact
  terminal state, `cleanedAt`, controller ledgers, and provider, smolvm, and
  Kubernetes observations as independently asserted facts.
- A legacy helper can be mistaken for the correct abstraction. Treat Bash as
  consumer evidence, apply the extraction gate to semantics, and share only
  the narrow mechanism whose inputs, failures, and cleanup ownership match.
- Contract runners hide detailed assertions from thin provider specs. Keep the
  runner readable, return a small completion record, and unit-test every stage
  and failure boundary.
- Shadowing intentionally doubles runtime and, for real-cloud members,
  temporary cost. Promote each member promptly after sufficient evidence.
- Cleanup can still fail because a cloud provider is unavailable. The fixture
  reports cleanup as a test failure and account-level cleanup remains a
  backstop.
- Provider capacity makes some real-cloud results inconclusive. Those runs must
  not advance qualification.
- TCP reachability can outlive or be reassigned independently of a provider VM.
  Capture SSH host identity before termination, retain independent provider
  evidence, and fail closed when the post-termination handshake is malformed or
  otherwise inconclusive.
- The temporary dual implementation is expected duplication, not a permanent
  architecture.

## Decision

Accepted on 2026-08-17 and amended on 2026-08-18 to make contract families the
primary architecture rather than a later optimization, to make provider-
confirmed persistent-VM host loss a required all-VM extension distinct from Job
host recovery, and to define an audited tracked-workload kernel beneath
family-specific submission, readiness, and terminal stages. That amendment also
separates persisted cleanup, capacity-ledger cleanup, workload substrate
absence, and provider orphan reaping, and grounds reuse in named legacy or
constrained consumers. The 2026-08-19 boundary-hardening amendment makes
runner/triage metadata, fixture resource names, VM-history comparisons,
migration-record validation, API wire ownership, controller readiness, and
failure/teardown reporting explicit fail-closed protocols, and corrects
host-loss ledger requirements to preserve ended capacity history while
forbidding replacement. It also makes managed Kubernetes a first-class
constrained composition: Kubernetes remains the target, the local substrate
remains private, workload and cluster kernels are typed siblings, Job and
Serve stages are reused, and API recovery requires real process replacement.
The 2026-08-23 amendment requires local and cloud Kubernetes qualification to
use the production cluster composition and one shared lifecycle transport;
only capacity, profile data, observations, and fault operations vary by
substrate. New
Bash and constrained Persistent VM lifecycle paths additionally share a
versioned, identity-aware SSH-host release probe: provider absence, persisted
cleanup, and endpoint identity remain separate evidence, and an IP address or
generic TCP accept cannot identify the original VM. New
Bash E2E scenarios should not be added when the constrained Vitest system can
express the behavior. New provider variants must use an applicable shared
contract and may not copy a provider scenario body. Existing scenarios migrate
through the stages above; accepting either amendment does not by itself promote
or retire any row in the migration record. The 2026-10-05 amendment admits Pool
Job, `--port` Deployment, and Slurm Job as sibling families of the VM-host
families.
