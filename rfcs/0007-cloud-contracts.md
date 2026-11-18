# RFC 0007: Enforce Cloud Storage and Compute Contracts

> Status: Proposed
> Date: 2026-06-22
> Updated: 2026-08-16 to reconcile removed admission and image-baking layers.
> Author: Codex draft

> Current-scope note: Workload image baking and `CloudImageBaker` were removed.
> The shared `admission_blocks` state was also removed in migration 0078 in favor
> of per-workload failure history. Sections explicitly marked historical retain
> the design record; neither layer is part of the current provider contract.

## Summary

Move retry, idempotency, error taxonomy, operation polling, and upload replayability into enforceable cloud contracts. Provider gateways should keep provider-specific SDK calls and classifiers, but shared cloud code should own lifecycle policy so new clouds cannot compile while bypassing the same guarantees.

This follows the broad shape used by SkyPilot and dstack: central orchestration and provider contracts, with provider implementations still substantial. It should not become one generic provider implementation.

## Context / problem

The GCP 50-job nuke run failed with a storage/OAuth transport pattern, not an API memory or scheduler collapse. Jobs submitted successfully, responsiveness and memory gates held, but logs showed repeated GCP token/GCS stream errors such as token endpoint close and `ERR_STREAM_PREMATURE_CLOSE`.

The immediate production mitigation is a runtime pin: `origin/main` pins the API
image to Node 22.22.3 because floating `node:22-slim` moved to Node 22.23.0,
where the `@google-cloud/storage` service-account OAuth path failed in
`node-fetch@2` gzip handling. This RFC keeps that mitigation separate from the
cloud-contract work. Unpinning Node should be a deliberate follow-up after either
the GCS auth path is moved off the failing transport or the storage client
forces uncompressed token requests.

The important failure shape was not just "a storage call lacked retry." Fifty
workloads attempted to prepare the same shared output bucket. The single-flight
coordination prevented a pure create storm, but rejected shared promises still
released waiters into synchronized retry waves. The provider recovered much
later than the short coordinated retry window, so most workloads spent a large
part of the nuke deadline re-entering storage preparation. Once the shared
bucket finally became usable, GCP compute quota/admission became the next
bottleneck: the run wanted roughly 100 vCPU for 50 `e2-standard-2` jobs, while
the observed project had a lower global CPU quota.

A follow-up smaller GCP nuke run exposed the sharper contract bug: a slow SDK
token retry can consume almost the whole coordinated bucket-upsert window before
AnyCloud observes the first transient failure. If `createCloudStorage` then wraps
that same-bucket upsert session in its own generic retry, every waiter can
re-enter another shared-bucket session after the same rejected owner operation.
Shared bucket upsert therefore needs exactly one owner retry session with a
budget measured from observed transient failure, not nested independent retry
loops.

The initial mitigation was partial. `src/api/services/gateways/cloud.ts` had `withTransientTransportRetry`, and GCP used it for `hasBucket` and `upsertBucket`, but storage operations such as `uploadObject`, `downloadObject`, `deleteObject`, and `deleteBucket` were still exposed directly enough that the same class of transient GCS failure could leak through.

The same design gap exists in compute. `CloudCompute` documents behavior, but provider implementations can still bypass shared policy for retry, timeout, long-running operation polling, not-found delete semantics, and terminal error classification.

The footgun is not limited to required methods. Optional capabilities are risky too when they remain structural on provider classes. AWS scoped storage token minting is the clearest example: production should discover it from the branded `CloudStorage` object with `canMintScopedStorageToken(storage)`, not from `AWS.prototype.mintScopedStorageToken`. Image baking had the same shape before the branded `CloudImageBaker` factory: `createImageBaker()` returned provider instances that implemented `CloudImageBaker` directly.

Compute-side optional capabilities have the same problem. `Preemptible` should
be explicitly attached to a `CloudCompute` object as an all-or-nothing capability
because callers need both `verifyVMPreemption()` and `startVM()`. Terminal auth
classification should also be explicit because it changes durable credential
invalidation behavior; a provider class helper named `isTerminalAuthError` is
not by itself a caller-visible capability.

Relevant current surfaces:

- `src/api/services/gateways/cloud.ts`
- `src/api/services/gateways/aws.ts`
- `src/api/services/gateways/azure.ts`
- `src/api/services/gateways/gcp.ts`
- `src/api/routes/bucket.ts`
- `src/api/services/candidate-preflight-cache.ts`

External comparison:

- SkyPilot centralizes auto-failover across regions/clouds for quota and capacity failures: https://docs.skypilot.co/en/stable/examples/auto-failover.html
- SkyPilot's `Cloud` abstraction owns regions, zones, capabilities, credentials, and resource feasibility: https://github.com/skypilot-org/skypilot/blob/master/sky/clouds/cloud.py
- dstack's backend guide makes provider `compute.py` the core implementation while server code centrally tries offers and handles launch failures: https://github.com/dstackai/dstack/blob/master/contributing/BACKENDS.md
- dstack's base `Compute` contract defines offers, launch, termination, and optional feature mixins: https://github.com/dstackai/dstack/blob/master/src/dstack/_internal/core/backends/base/compute.py

## Proposal

Keep `CloudStorage` and `CloudCompute` as the public surfaces consumed by API and scheduler code. Do not rename the public caller-facing types. Instead, add internal provider-side `Ops` contracts that contain raw cloud operations, and expose public objects only through shared factories in `cloud.ts` or small sibling modules.

The naming split is:

- `CloudStorage`: public, safe, branded storage contract used by callers.
- `CloudStorageOps`: provider-side raw storage operations supplied by AWS/GCP/Azure/Local.
- `createCloudStorage(ops)`: provider-neutral shared factory that wraps `CloudStorageOps` with retry, idempotency, logging, replayable upload handling, and optional storage capabilities.
- `CloudCompute`: public, safe, branded compute contract used by callers.
- `CloudComputeOps`: provider-side raw compute operations supplied by AWS/GCP/Azure/Lambda/Vast/Local.
- `createCloudCompute(ops)`: provider-neutral shared factory that wraps `CloudComputeOps` with retry, timeout, polling, cleanup, and error-classification policy.

The factories contain no provider SDK code. Provider files keep SDK calls and provider-specific predicates/classifiers.

### Current implementation status

The broad contract shape is already partially implemented:

- `CloudStorageOps`, branded `CloudStorage`, and `createCloudStorage` exist.
- Storage upload sources are replayable, and API bucket uploads spool incoming
  request bodies before calling storage.
- AWS, Azure, GCP, Kubernetes Local, and test fixtures construct storage through
  `createCloudStorage`.
- Same-bucket existence/upsert coordination and coordinated retry ownership live
  in the storage factory/coordinator, not provider-private bucket methods.
- Optional scoped storage token minting is attached to branded storage and
  discovered by `canMintScopedStorageToken(storage)`.
- `CloudComputeOps`, branded `CloudCompute`, and `createCloudCompute` exist.
- `createCloudCompute` owns public `terminateVMs()` fan-out, placeholder VM
  handling, concurrency limits, and confirmed-ID aggregation.
- Candidate preflight is a branded `CandidateRegionFilter` capability created
  by shared code and attached through `CloudComputeOps`.
- Structured candidate admission snapshots are exposed through the same
  preflight factory, so the optimizer can consume quota/unavailability facts
  instead of only receiving a filtered list. AWS and Azure snapshots report
  regional quota blocks; GCP snapshots report machine-type unavailability until
  a first-class GCP quota provider exists. Candidate preflight is now
  snapshot-first: legacy `filterCandidateRegions()` behavior is derived from
  `snapshot.filteredCandidates`, so providers do not maintain a second
  filter-only interpretation branch.
- Runtime quota/capacity diagnoses are stored in each workload's event/attempt
  history. The optimizer uses that workload-local failure history to rotate or
  penalize candidates. It does not maintain shared time-based admission blocks
  across workloads.
- `Preemptible` and terminal-auth classification are explicit branded compute
  capabilities rather than structural provider-class methods.

The remaining work is not another interface rename. It is moving quota headroom
snapshots, admission-budget reservation, status reporting, and more compute
lifecycle policy into the shared compute contract.

### Storage

Add an internal `CloudStorageOps` contract with raw provider operations and provider-specific predicates:

```ts
declare const cloudStorageBrand: unique symbol;

type CloudStorage = CloudStoragePublic & {
  readonly [cloudStorageBrand]: true;
};

interface CloudStorageOps extends Partial<ScopedStorageTokenMinter> {
  readonly type: CloudType;
  readonly region: string;
  readonly storageAccountName?: string;
  readonly retryPolicy?: CloudRetryPolicy;
  readonly rawBucketCoordinationKey?: (bucketName: string) => string;
  rawGetBucketRegion?(bucketName: string): Promise<string | undefined>;

  rawHasBucket(bucketName: string): Promise<boolean>;
  rawUpsertBucketUncoordinated(
    bucketName: string,
    version: string,
    workloadId: string,
    userId: string,
  ): Promise<void>;
  rawDeleteBucket(bucketName: string): Promise<void>;
  rawDeleteObject(bucketName: string, remotePath: string): Promise<void>;
  rawUploadObject(request: CloudUploadRequest): Promise<void>;
  rawDownloadObject(
    bucketName: string,
    remotePath: string,
  ): Promise<CloudDownload>;

  isNotFound?(error: unknown): boolean;
}
```

Expose shared construction:

```ts
function createCloudStorage(ops: CloudStorageOps): CloudStorage;
```

The generated public methods apply retry, logging, idempotency rules, and not-found handling consistently. Provider files supply only raw SDK bodies and classifiers. The hidden brand prevents provider classes from structurally implementing `CloudStorage` directly; they must go through `createCloudStorage`.

Shared bucket creation needs stronger behavior than ordinary per-call retry:

- same-bucket upserts use single-flight coordination
- transient failures are coordinated, not only in-flight successes
- waiters do not stampede when the owner operation rejects
- providers expose an optional coordination key and an uncoordinated raw upsert;
  the factory owns the single retry/coordinator session
- retry windows start when the first retryable failure is observed, not before a
  slow SDK/auth attempt begins
- retry delays include jitter/backoff and respect the workload deadline
- retry budget exhaustion is logged separately from terminal storage errors
- a successful upsert marks the bucket usable for short-lived positive reuse

The retry budget should be long enough to survive realistic provider auth/data
plane turbulence under stress, but not an unbounded "retry for the whole nuke"
loop. Deadline-aware coordination should let the scheduler distinguish
storage-blocked workloads from terminal failures and from compute
quota/admission failures.

Optional storage capabilities follow the same rule. A provider may pass optional operations such as `ScopedStorageTokenMinter` into `createCloudStorage`, but API/scheduler code should only see them on the branded `CloudStorage` object after a guard such as `canMintScopedStorageToken(storage)`. Provider classes should not publicly implement optional storage capability interfaces just because they happen to have same-named helper methods; raw helpers can be private/protected or covered through provider-specific unit tests.

Replace one-shot upload streams with replayable upload sources:

```ts
type CloudUploadSource =
  | { kind: 'buffer'; bytes: Buffer; contentLength: number }
  | { kind: 'file'; path: string; contentLength: number }
  | { kind: 'factory'; open: () => Readable; contentLength?: number };
```

`src/api/routes/bucket.ts` should spool incoming HTTP uploads to a temp file and pass a `file` source. That makes retry safe because each attempt can open a fresh stream.

### Compute

Add an internal `CloudComputeOps` contract with raw lifecycle operations:

```ts
declare const cloudComputeBrand: unique symbol;

type CloudCompute = CloudComputePublic & {
  readonly [cloudComputeBrand]: true;
};

type VMTerminationStatus =
  | { state: 'alive' }
  | { state: 'terminated' }
  | { state: 'unknown'; error: string };

interface CloudComputeOps {
  readonly type: CloudType;
  readonly region: string;
  readonly spot?: boolean;
  readonly vmType: string;

  rawValidateCredentials(): Promise<void>;
  rawCleanupOrphanedResources(dryRun?: boolean): Promise<CleanupResult>;
  rawClassifyError(error: unknown): CloudFailureDiagnosis;
  rawNewVM(params: NewVMProps): Promise<CloudVM>;
  rawTerminateVM(vmId: string): Promise<void>;
  rawTerminateNetworking(workloadId: string): Promise<void>;
  rawGetAllVMs(): Promise<CloudVM[]>;
  rawUpsertFirewall(
    ipWhiteList: string[],
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<void>;
  rawPrepareNetwork?(
    spec: NetworkSpec,
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<CloudNetworkHandle | undefined>;
  rawGetVMTerminationStatus(
    cloudId: string,
    options?: { signal?: AbortSignal },
  ): Promise<VMTerminationStatus>;
  isPlaceholderVMId?(vmId: string): boolean;
  terminateVMsConcurrency?: number;
}
```

Expose shared construction:

```ts
function createCloudCompute(ops: CloudComputeOps): CloudCompute;
```

The first compute increments made lifecycle methods available only on branded
`CloudCompute`, moved public `terminateVMs()` fan-out, placeholder handling,
concurrency limits, and confirmed-ID aggregation into `createCloudCompute(...)`,
and attached optional capabilities through explicit bundles. Providers now
supply one-ID raw termination plus provider-specific SDK sequencing. Later
increments can move more retry policy, timeout/deadline budget, long-running
operation polling, not-found-as-success for deletes, cleanup result
aggregation, and structured logs into this factory without exposing another
public surface. Provider `Ops` still build AWS/GCP/Azure/Lambda/Vast payloads.

Optional compute capabilities follow the same boundary. A provider may pass a
`preemptible` bundle into `createCloudCompute`, but API/scheduler code should
only call `verifyVMPreemption()` / `startVM()` after `isPreemptible(compute)`
checks the branded public object. Likewise, terminal auth classification should
be attached as an explicit `terminalAuthErrorClassifier` bundle and discovered
through `canClassifyTerminalAuthError(compute)`, not by structural method-name
matching on a provider class.

### Historical image-baking design (removed)

This increment briefly applied the public/ops split to image baking. Workload
baking and the entire capability were later removed; the types and factories in
this section do not exist on main.

```ts
declare const cloudImageBakerBrand: unique symbol;

type CloudImageBaker = CloudImageBakerPublic & {
  readonly [cloudImageBakerBrand]: true;
};

interface CloudImageBakerOps {
  rawGetPrebakedImage(
    digest: string,
    baseImageFamily: string,
  ): Promise<string | null>;
  rawBakeImage(
    imageRef: string,
    vmCloudId: string,
    digest: string,
    baseImageFamily: string,
    version: string,
  ): Promise<string>;
  rawListBakedImages(): Promise<BakedImage[]>;
  rawDeleteImage(imageId: string): Promise<void>;
}

function createCloudImageBaker(ops: CloudImageBakerOps): CloudImageBaker;
```

The historical increment made `createImageBaker()` return a branded
`CloudImageBaker`, not `new AWS(c)` or `new Azure(c)`. Raw provider
bake/list/delete helpers are reached through `imageBaker()`, and tests that
exercise caller behavior should mock the branded image-baker surface instead of
stubbing provider prototypes. RFCs 0012 and 0013 subsequently removed this
surface instead of moving more policy into it.

### Candidate preflight

Make candidate preflight a typed provider capability rather than a convention
checked by source-grep tests. A raw provider class method named
`filterCandidateRegions` is not the capability. The capability is a branded
`CandidateRegionFilter` object constructed through shared code and attached to
`CloudCompute`:

```ts
type CandidateRegionFilter = CandidateRegionFilterPublic & {
  readonly [candidateRegionFilterBrand]: true;
};

interface CloudComputeOps {
  candidateRegionFilter?: CandidateRegionFilter;
}

function createCandidateRegionFilter<TPreflight>(
  ops: CandidateRegionFilterOps<TPreflight>,
): CandidateRegionFilter;
```

`CloudComputeOps` must not accept a raw `filterCandidateRegions` function. This
makes a new provider that tries to expose candidate filtering structurally fail
at compile time; it must first construct the branded filter. For any provider
that exposes preflight, the provider-specific result application should return a
structured `CandidateAdmissionSnapshot`. Compatibility
`filterCandidateRegions()` behavior should be derived by shared code from
`snapshot.filteredCandidates`, not reimplemented beside the structured path.

The shared candidate-filter constructor owns the cross-provider lifecycle policy:

- cache keying for identical sweeps
- short TTL reuse
- pending-sweep sharing with a maximum share window
- bounded caller wait timeout
- fail-open logging
- `shouldCache` rejection of incomplete results

Provider code supplies the provider-specific sweep body and snapshot mapping:

- `complete`
- filtered candidates
- quota or availability blocks
- provider-specific messages or diagnoses

The provider-specific SDK reads are still provider code: AWS owns enabled-region
and Service Quotas calls, Azure owns Resource SKU and quota/usage calls, and GCP
owns machine-type availability calls. The shared contract should delete
duplicated interpretation code, not hide cloud API bodies in `cloud.ts`.

Incomplete sweeps must not be cached as complete. Per-region/per-zone fan-out
inside a provider sweep should still use `runCandidatePreflightUnitSweep` so one
unhealthy regional endpoint does not poison the entire filter. Fully absorbing
unit enumeration into the shared constructor is a possible follow-up, but the
first enforcement boundary is the branded filter plus shared cache/fail-open
wrapper and snapshot-first result mapping.

### Quota and admission

Storage retry alone cannot make a stress run pass when the account cannot admit
the requested fleet. The compute contract should make quota/capacity handling a
first-class scheduler input, not only a runtime error classifier.

AWS and Azure already have quota-oriented prefilter paths and runtime
quota-exhaustion classification. GCP currently has machine-type availability
filtering and runtime quota classification, but no equivalent quota-status
provider. That leaves GCP able to recover from storage turbulence only to spend
the remaining deadline launching doomed candidates against regional address,
regional instance, or global CPU limits.

The target behavior should be implemented in stages:

- provider quota preflight filters impossible regions before launch when the
  cloud exposes reliable quota APIs
- scheduler admission limits active launches by observed account/global quotas
  when exact preflight is unavailable
- runtime quota exhaustion guides retry/failover through the affected
  workload's durable failure history
- the nuke harness reports storage-blocked, quota-blocked, and API-health
  failures separately so a provider-account limit is not misread as an API
  memory or storage regression

## Implementation plan

### Slice 1: per-workload failure history (current outcome)

The first implementation introduced shared, time-based `admission_blocks` keyed
by account and target. That state was later removed by migration 0078 because it
could suppress unrelated workloads and duplicated the durable failure facts
already recorded on each workload.

Current target selection classifies quota/capacity failures, persists them in the
affected workload's event and VM-attempt history, and uses that history for its
next candidate choice. Cross-workload fleet admission remains unimplemented;
it requires reliable provider headroom plus an explicit reservation budget, not
an inferred TTL block.

### Slice 2: structured candidate admission snapshots

This slice makes structured snapshots the primary branded preflight contract for
providers that can report admission facts before launch. The scheduler consumes
this capability through `CloudCompute`, not by calling provider classes
directly:

- AWS adapts existing enabled-region and zero-quota reads.
- Azure adapts existing family quota, spot quota, total-core quota, and SKU
  availability reads.
- GCP adapts existing machine-type availability reads and continues relying on
  observed runtime state for quota until a quota API contract is settled.
- The shared admission code treats incomplete provider snapshots as partial,
  not complete, and does not cache partial failures as authoritative.
- Shared code derives compatibility `filterCandidateRegions()` results from
  `snapshot.filteredCandidates`; providers do not maintain a second
  `applyPreflight` interpretation branch.
- The optimizer consumes each snapshot's filtered candidates directly; runtime
  failures remain workload-local.
- Tests prove AWS/Azure/GCP filtered candidates and preflight call counts remain
  unchanged after moving to snapshot-first mapping.

This is intentionally not yet exact fleet admission. The remaining quota
snapshot work is exposing count/headroom facts precise enough to reserve
capacity for a dispatch burst. If a snapshot says an account can admit only 20
of 50 requested jobs, the scheduler should admit only the safe subset and leave
the rest queued/backing off instead of launching doomed work.

That later increment needs provider headroom snapshots and a shared reservation
or admission-budget model, not just per-candidate filtering.

### Slice 3: nuke and status reporting

Make the stress harness and API status distinguish the major failure classes:

- storage-blocked
- quota-blocked
- provider-capacity
- API health or memory failure
- invalid workload
- cleanup leak or cleanup timeout

The goal is not to make real-cloud nuke pass in an undersized account. The goal
is to make the reason machine-readable enough that quota/capacity failures are
not mistaken for API regressions.

### Slice 4: compute operation runner

After quota/admission is explicit, continue the `CloudCompute` fattening work by
moving generic VM lifecycle policy into shared compute code:

- shared retry wrappers with provider predicates
- long-running operation polling budgets
- not-found-as-success delete semantics
- cleanup result aggregation
- structured operation logging
- deadline-aware retry/polling decisions

Migrate low-risk providers first (`Local`, `Lambda`), then `AWS`, `Azure`,
`GCP`, and `Vast`. Keep provider files responsible for SDK request bodies,
resource naming, provider-specific sequencing, and classification predicates.

## Migration plan

1. Done: add shared storage and compute `Ops` types plus fake-ops unit tests without changing provider behavior.
2. Done: migrate storage first because the GCP nuke failure was storage/OAuth data-plane related.
3. Done: change `uploadObject` to accept `CloudUploadSource`, and refactor `src/api/routes/bucket.ts` to spool uploads to temp files.
4. Done: migrate Local, AWS, Azure, and GCP storage into `createCloudStorage`.
5. Done: strengthen coordinated bucket upsert retry so same-bucket transient failures
   stay inside one owner retry session instead of releasing callers into
   synchronized retry waves. Providers declare an optional bucket coordination
   key and an uncoordinated raw upsert body; `createCloudStorage` owns the
   coordinated retry session.
6. Done: move optional storage capabilities, starting with AWS scoped storage token minting, behind the branded `CloudStorage` surface. Tests that validate caller behavior should use `storage()` plus `canMintScopedStorageToken(storage)`, not `AWS.prototype.mintScopedStorageToken`.
7. Done: move candidate preflight into a typed shared capability and retire file-content contract tests where the compiler now enforces the path. First increment: brand `CandidateRegionFilter`, add `createCandidateRegionFilter`, require `CloudComputeOps.candidateRegionFilter`, and migrate AWS/Azure/GCP.
8. Superseded: shared quota/admission state was added, then removed by migration 0078. Runtime failover now uses the affected workload's durable failure
   history.
9. Done: move remaining optional compute capabilities behind explicit branded attachment: `Preemptible` and terminal auth classification.
10. Done: expose structured candidate admission snapshots through
    `CloudCompute`, backed by AWS/Azure/GCP candidate preflight.
11. Done: make candidate preflight snapshot-first by deriving legacy
    `filterCandidateRegions()` results from `snapshot.filteredCandidates` and
    deleting provider `applyPreflight` duplication.
12. In progress: make nuke/status reporting distinguish storage-blocked,
    quota-blocked, provider-capacity, API-health, memory, invalid-workload,
    and cleanup failures. First increment: the nuke harness emits a
    machine-readable classification artifact from list outcomes, the evaluated
    memory gate, and run-scoped API-log signatures. Deadline snapshots distinguish
    genuinely overdue workloads from jobs that were merely active when another
    failure aborted the run. A later increment should expose richer per-workload
    diagnosis metadata through API/status instead of relying on logs.
13. Later: add provider headroom snapshots plus shared admission-budget
    reservation for exact dispatch-burst admission.
14. Later: add the compute operation runner and migrate Local/Lambda first, then AWS/Azure/GCP, then Vast.
15. Removed: the branded image-baker factory landed, then workload baking and the
    entire capability were removed under RFCs 0012 and 0013.
16. Keep a real VM-host nuke lane as end-to-end validation after the lower-level
    contract tests pass. The required Local PR lane is currently 20-way; larger
    real-cloud or manual runs may use a different width.

Acceptance criteria:

- TypeScript rejects one-shot `Readable` upload calls.
- Every retryable storage operation gets the declared provider retry policy,
  while coordinated bucket upsert owns exactly one retry session instead of a
  generic wrapper retry plus a provider retry.
- Same-bucket concurrent upsert tests cover at least 50 callers, repeated
  transient failures, eventual success, bounded raw calls, jittered retry
  timing, and no waiter stampede after a rejected owner operation.
- Slow first transient failures do not consume the whole shared upsert retry
  budget before AnyCloud gets a chance to retry.
- Coordinated bucket upserts are not multiplied by another generic
  `CloudStorage` retry wrapper or provider-owned retry loop.
- GCP-style storage tests cover repeated `ERR_STREAM_PREMATURE_CLOSE` during
  shared output bucket work followed by eventual success.
- Optional storage capabilities are discovered from branded storage objects, not directly from provider classes.
- Optional compute capabilities are discovered from branded compute objects, not directly from provider class method names, and wrapper tests prove those capabilities are forwarded.
- Delete idempotency is declared and enforced centrally.
- Candidate preflight partial failures cannot be cached as complete, raw compute providers cannot expose optimizer-visible candidate filtering without `createCandidateRegionFilter`, and providers cannot add candidate filtering without structured snapshot output.
- Per-workload failure-history tests cover account-wide and regional quota
  diagnoses, target rotation, and retry dispositions without relying on shared
  TTL admission state.
- Structured candidate admission snapshot tests cover the shared brand/forwarder,
  AWS quota and opt-in blocks, Azure quota and SKU blocks, GCP machine-type
  blocks, parity between legacy filtered candidates and
  `snapshot.filteredCandidates`, and optimizer consumption of the filtered
  result.
- Nuke result reporting distinguishes storage-blocked, quota-blocked,
  provider-capacity, API-health, memory, invalid-workload, and cleanup
  failures.
- Compute operations cannot bypass retry/polling/not-found semantics once migrated.
- Existing gateway unit tests, cleanup specs, prefilter specs, and nuke workflows continue to pass.

## Alternatives considered

### Keep provider methods and add more helper calls

This is the smallest patch but repeats the current failure mode: helpers exist, but providers can forget to use them. It relies on review and brittle file-content tests instead of type-level enforcement.

### Add a separate driver or adapter layer

This adds indirection without changing the real boundary. The issue is not the word "gateway"; it is that the public interface does not force shared policy. `Ops` contracts plus branded public factory outputs are enough.

### Create one generic compute implementation

This would erase useful provider differences and likely become a lowest-common-denominator abstraction. The better split is shared lifecycle policy plus provider-specific operation bodies.

### Pin the API runtime or only fix GCP auth

This is the right immediate mitigation when one runtime/SKD combination is
known-bad, and `origin/main` does pin the API image to Node 22.22.3 for that
reason. It does not address the shared-bucket retry contract, retry wrapping
scope, future runtime unpinning, or the same design bug in future clouds and
future operations.

## Risks & caveats

- Further compute interface changes will touch many provider tests.
- Upload spooling adds disk IO and requires reliable temp-file cleanup.
- Shared retries can amplify SDK retries if policy counts are too aggressive.
- Shared retries can also hide account quota failures if storage-blocked and
  quota-blocked states are not reported separately.
- Retrying writes is safe only when sources are replayable and operations are idempotent or correctly classified.
- Long provider auth/data-plane outages require deadline-aware coordination;
  simply increasing retry windows can pin workers and delay useful failover.
- Compute migration has higher blast radius than storage because it touches
  provisioning, cleanup, networking, and image paths.
- Cross-workload admission can under-admit work if provider headroom is stale or
  reservations are over-broad; do not reintroduce inferred TTL blocks as a
  substitute for explicit provider facts and budgets.

## Open questions

- Should AWS use shared transient retry in addition to SDK retry, or only shared logging/metrics around SDK retry?
- What retry budget should shared bucket coordination use relative to the
  workload provisioning deadline?
- What admission budget should the scheduler reserve for already-running or
  already-provisioning workloads when a provider quota snapshot is partial?
- What GCP quota API shape is reliable enough to graduate from observed runtime
  quota state to a first-class quota snapshot provider?

## Decision

Pending. The storage wrapper, compute wrapper, optional capability brands,
termination fan-out, and candidate snapshots are implemented. Provider-headroom
reservations, richer status reporting, and the general compute operation runner
remain proposed. Shared `admission_blocks` and image baking are explicitly not
part of the current direction.
