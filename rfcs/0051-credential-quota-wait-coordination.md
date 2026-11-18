# RFC 0051: Per-credential coordination of quota-refused launch retries

> Status: Accepted
> Date: 2026-11-10
> Author: Claude draft, for Luis Fernando De Pombo
> Amended: 2026-11-11, after acceptance — a vCPU quota on the Local test
> substrate and the `quota-wait` E2E contract family (owner decisions of
> 2026-11-11)

## Summary

When several Workloads on one credential exhaust a shared quota, each one
backs off on its own [RFC 0022](./0022-provisioning-retry-cadence.md) timer.
None of them notices when a sibling releases a VM, so freed quota sits unused
until a timer fires by chance. In a 16-Job burst on a new GCP project, launch
retries took up to 1016 s against a VM boot of about 36 s.

This RFC wakes quota waiters when anycloud confirms that a VM on the same quota
scope has been released. Waiters are woken in the order of their first
refusal, one waiter for each released VM, and a passover limit keeps a large
request from starving. The scope is the credential for account-wide quota, and
the credential plus region for a regional quota on a region-pinned Workload.
The wait also becomes a reported fact: `status` returns a `retry.wait` object
with the reason, scope and queue position, and a woken retry's `queued` event
records why it was woken. Nothing is added to the schema. The order is derived
from the existing `workload_events` and `vms` rows. The RFC 0022 curve stays
in place as the fallback for releases that anycloud does not observe.

Placement changes to match. Today a region whose quota reading shows less
than one VM of room is dropped from the candidates before launch, and a
Workload whose every candidate is dropped this way ends `invalid` instead of
waiting. Under this RFC such a target ranks last instead, following the
reorder-never-exclude rule. A Workload
pinned to a full region then launches, is refused, and waits on that
region's quota like any other waiter.

Together, these let a client submit every Workload it has on one credential
without capping its own submissions at the quota or skipping regions it
believes are full. anycloud places each Workload, holds it while quota is
short, and starts it in order when a VM on the same credential, or on the
same credential and region, ends.

Local, which exists only as a test substrate, gains a vCPU quota so the
account-wide path can be tested live: `ANYCLOUD_LOCAL_VCPU_QUOTA` caps the
vCPUs that local VMs may use, and the Local gateway refuses a launch past it
with the account-wide quota diagnosis. A `quota-wait` E2E contract family
runs the account-wide wake, its order, passovers, the reservation and an API
restart on Local on every pull request, and runs the regional and placement
paths on GCP, AWS and Azure once per release.

## Context

### Evidence

A burst of 16 Jobs ran on a GCP project created a few days earlier. Each Job
was one VM of 2, 4, 8 or 16 vCPUs on the `n2` family, 120 vCPUs in total. The
project had the default `CPUS_ALL_REGIONS` limit of 32. Seven Jobs launched at
once. Nine were refused one to four times, with
`Quota 'CPUS_ALL_REGIONS' exceeded. Limit: 32.0 globally`
(`quota-exhausted-account`) or a regional `CPUS` quota
(`quota-exhausted-region`).

| vCPUs | refusals | diagnosis                 | launch (s) | VM boot (s) |
| ----- | -------- | ------------------------- | ---------- | ----------- |
| 2–16  | 0 (×7)   | –                         | 11–20      | 34–42       |
| 8     | 1        | `quota-exhausted-region`  | 102        | 31          |
| 2     | 1        | `quota-exhausted-account` | 119        | 37          |
| 2     | 1        | `quota-exhausted-region`  | 133        | 37          |
| 8     | 1        | `quota-exhausted-account` | 165        | 27          |
| 8     | 1        | `quota-exhausted-account` | 162        | 31          |
| 8     | 2        | `quota-exhausted-region`  | 195        | 38          |
| 16    | 2        | `quota-exhausted-region`  | 210        | 38          |
| 16    | 2        | `quota-exhausted-account` | 337        | 38          |
| 16    | 4        | `quota-exhausted-account` | 1016       | 32          |

Launch is the time from `submitted` to the first `initializing` event. Boot is
the time from `initializing` to `downloading`. Boot, image pull (22–32 s) and
start barely varied between Jobs. Launch varied by two orders of magnitude.
The slowest Job spent 94% of its 1076 s in launch. Its four waits lie on the
RFC 0022 curve, whose ceiling runs 150, 300, 600 and then 600 s, so each one
was a timer drawn without regard to when siblings released quota.

In the same window, AWS Jobs on another account saw `capacity-exhausted`
refusals that resolved after one or two retries or a failover. That was a
hardware shortage, not a quota wall.

### How a quota refusal is handled today

- **Classification.** Each gateway maps a provider error to a shared
  diagnosis in `src/shared/cloud.ts`. The quota diagnoses are
  `quota-exhausted-account`, `quota-exhausted-region` and
  `account-regional-spot-quota-exhausted`. The quota metric, limit and usage
  are never extracted.

  | Cloud  | Account-wide (`quota-exhausted-account`)                                   | Regional (`quota-exhausted-region`, or the spot diagnosis)                                                                                                               |
  | ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | GCP    | `RESOURCE_EXHAUSTED`/quota matching `ALL_REGIONS` or `globally`            | every other quota message, including regional `CPUS` and `NVIDIA_*_GPUS` (`gateways/gcp.ts`, `classifyError`)                                                            |
  | AWS    | none                                                                       | `VcpuLimitExceeded`, `InstanceLimitExceeded`, `NetworkInterfaceLimitExceeded`; spot `MaxSpotInstanceCountExceeded` (`gateways/aws.ts`). "limit of 0" is `invalid-target` |
  | Azure  | none                                                                       | `QuotaExceeded`, quota-shaped `OperationNotAllowed`, public IP limits; spot `LowPriorityCores` (`gateways/azure.ts`). "Current Limit: 0" is `invalid-target`             |
  | Lambda | `quota-exceeded`, the account instance-launch limit (`gateways/lambda.ts`) | none                                                                                                                                                                     |

  AWS and Azure vCPU quotas are per region and per family, so neither has an
  account-wide quota at this level. Local has no quota today: every local VM
  has 1 vCPU and 512 MB (`local-smolvm-runtime.ts`), and the local gateway
  never refuses a launch for quota.

- **Disposition.** `resolveProvisioningFailureDisposition` in
  `src/api/services/provisioning-failure.ts` always returns
  `retry-same-target` for an account-wide quota. For a regional quota it
  returns `retry-same-target` when the Workload is pinned to the region, and
  `failover-target` otherwise. A failover moves the Workload to another region
  and penalizes the same VM type in every zone of the refused region
  (`launch-targets.ts`, `failureAppliesToTarget`). The `retrying` event stores
  `diagnosis`, `disposition`, `credentialId`, `targetRegion` and the rest of
  the target (`vm-host-startup.ts`, `task.ts`).
- **Placement preflight.** Before each launch, `preflightTargetCandidates`
  (`launch-targets.ts`) asks the gateway to classify candidates as
  `Verified`, `Unknown` or `Unavailable`, and drops every `Unavailable` one
  (`createCandidateRegionFilter` in `gateways/cloud.ts`). Two of those
  verdicts come from quota readings:

  | Cloud  | Quota reading                                                                                                                                                          | Today                  |
  | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
  | Azure  | `getInsufficientQuotaRegions` (`quota/azure.ts`): limit minus usage below the VM's vCPUs on the family quota and the regional total, or on `LowPriorityCores` for spot | `Unavailable`, dropped |
  | AWS    | `getZeroQuotaRegions` (`quota/aws.ts`): the family vCPU limit is 0                                                                                                     | `Unavailable`, dropped |
  | GCP    | none; the preflight checks only the machine type's catalog presence                                                                                                    | –                      |
  | Lambda | none; the preflight reads live instance availability, which is capacity, not quota                                                                                     | –                      |

  When the preflight drops every candidate, a Workload ends `invalid` with the
  provider's `exhaustedCandidateFilterMessage` (`optimizer.ts`) and a node
  pool records a failed pass (`node-pool-controller.ts`). So a Workload pinned
  to an Azure region that is full when it is placed never reaches a quota
  wait. The other `Unavailable` verdicts are not quota readings and are out of
  scope: an AWS region not opted in, an Azure family the region does not
  report, a GCP machine type missing from a zone, and Lambda's capacity read.
  The reorder-never-exclude rule sets the
  owner's rule for quota readings at placement: they may only reorder
  candidates and must never exclude one, because the launch result is the
  source of truth. An earlier incident
  is the history behind it, where an Azure quota check refused launches that
  had quota.

- **Retry timing.** `retryCandidatesQuery`
  (`src/api/services/repositories/retry-candidates.ts`) derives `retryCount`,
  `lastRetryAt` and `failedAtState` from `workload_events`. The reconciler
  samples `lastRetryAt + computeRetryWait(...)` once per retry revision and
  keeps that `retryDueAt` only in memory (`workload-reconciler.ts`,
  `classifySnapshot`). Discovery runs every 30 s and the pump every second.
  Before the deadline the work is `retry-prepare` (teardown); after it,
  `retry-launch` moves the Workload from `retrying` to `queued`. The
  provisioning scheduler then admits it within 5 s, up to
  `MAX_ACTIVE_DEPLOY_PIPELINES` (50).
- **Release.** A VM releases its quota when the provider confirms deletion.
  At that point `terminateBoundVMs` (`host-runtime/termination.ts`) calls
  `endProvisioningAttempt`, which sets `vms.ended_at`. The `vms` row carries
  `credential_id`, `region` and `vm_type`, and `launch_diagnosis` is null for
  a VM that actually launched. A replaced preempted VM sets it in
  `workload-lifecycle.ts`, and node pool and cluster VMs in `cluster-store.ts`. Nothing tells a waiter that a release happened.
- **Reporting.** `status` returns `retry: {attempt, earliestAt, latestAt}`,
  which is the RFC 0022 window. The list row reads "waiting for quota"
  (`workload-event-metadata.ts`). The CLI prints "Account quota exhausted" or
  "Regional quota exhausted" and the next window (`workload-retry.ts`). A
  client can tell that a Workload is waiting on quota, but not on which scope,
  behind how many siblings, or whether a release has woken it.
- **Replicas.** One API process owns one SQLite database
  ([ARCHITECTURE.md](../ARCHITECTURE.md#api-modes)). The chart runs
  `replicas: 1` with `strategy: Recreate`. The reconciler's deadlines,
  fairness and in-flight set are process-local and rebuilt by discovery.

## Proposal

### Smallest useful release

Workloads that wait on a shared quota on one credential start the moment
anycloud releases a VM that frees that quota. They start in order of their
first refusal, not when a timer fires. `anycloud status`, `wait` and `list`
show the wait as a quota wait with its scope and queue position, separately
from provisioning and boot. This covers GCP and Lambda account-wide quotas
and regional quotas on GCP, AWS and Azure for region-pinned Workloads. The
Local test substrate gets an account-wide vCPU quota so this path can be
tested live. A regional
waiter is woken by a VM that ends on the same credential and in the same
region, whether or not any account-wide quota is involved.

When anycloud chooses where to place a VM, a target whose known quota has
room for less than one VM ranks after every other candidate instead of being
dropped. A Workload never ends `invalid` because of a quota reading.

A client therefore needs no quota cap or region skipping of its own: it can
submit all its Workloads at once on one credential and leave placement and
pacing to anycloud.

Excluded:

- releases that anycloud does not perform, such as a VM deleted in the
  console or by another API installation using the same account. The RFC 0022
  curve still covers them;
- unpinned Workloads refused on a regional quota. They already fail over to
  another region;
- node pool launches. Their releases do wake Workload waiters, but pools keep
  their own per-key backoff;
- raising quota.

### Quota scope

A waiter is a `retrying` Workload whose latest `retrying` event has a quota
diagnosis and `disposition: retry-same-target`. Its scope comes from that
event:

| Diagnosis                               | Scope key                              |
| --------------------------------------- | -------------------------------------- |
| `quota-exhausted-account`               | `account:<credentialId>`               |
| `quota-exhausted-region`                | `region:<credentialId>:<targetRegion>` |
| `account-regional-spot-quota-exhausted` | `spot:<credentialId>:<targetRegion>`   |

A Local Workload has no credential, so its `retrying` event carries
`credentialId: null`. Its account-wide scope is `account:local`, and the
release query matches `vms` rows with `credential_id IS NULL` whose owning
Workload runs on Local. Every other scope needs a non-null credential.

A release counts toward a scope when its `vms` row has `launch_diagnosis IS
NULL`, a non-null `ended_at`, and the same `credential_id`, plus the same
`region` for a regional or spot scope. A spot scope also needs the VM to
have been spot, read from its owning Workload's or node pool's `spot`. One
release can count for an account scope and a regional scope at once.

A regional scope is therefore the credential plus the region, never the
credential alone. A VM that ends on the same credential in `us-east-1` wakes
`us-east-1` regional waiters; one that ends in `us-west-2` does not, though it
still counts for that credential's account scope. This holds for every cloud
with a regional quota diagnosis: GCP regional `CPUS` and GPU quotas, AWS and
Azure family vCPU quotas, and the AWS and Azure spot pools. Lambda has no
regional quota diagnosis.

The scope ignores the quota metric. A released GPU VM also frees vCPUs, and
reading the metric would mean a per-cloud parser for a message that AWS does
not structure. The cost of this coarseness is at most one extra refused
attempt per release, which the walk below bounds.

The key is the saved credential, not the cloud account. Two saved credentials
for the same GCP project do not coordinate with each other, as noted under
accepted limitations.

### Release detection

A release is valid for a waiter when the VM's `ended_at` is later than that
waiter's latest refusal on the scope. A refusal after the release shows that
the freed quota did not fit that waiter, or was already taken.

The reconciler reads valid releases from durable rows on each discovery pass,
every 30 s, so nothing new is stored. A process-local set of the `vms.id`
values already spent on a launch keeps one release from starting two
Workloads.

`endProvisioningAttempt` also calls the reconciler's `noteRelease(vmRowId)`
after it commits. That runs the same check at once, so a Job release is seen
in about a second rather than up to 30 s. This hook is the only addition
outside the reconciler. Preempted, node pool and cluster releases are picked
up by the next discovery pass.

After a restart, the spent set is empty, so a release that already started a
Workload can be handed out once more. That costs at most one extra launch
attempt per waiter, whose refusal then invalidates the release for that
waiter. A release is
never lost, because it stays valid for every waiter refused before it.

### Wake order and fairness

Each scope keeps a first-in, first-out (FIFO) queue of its waiters. The queue
is ordered by the waiter's _first refusal_ on that scope: the `created_at` of
the earliest `retrying` event with the same scope key since its last
`initializing` event or resubmission. Ties are broken by Workload ID. The order
is derived on each discovery pass from `workload_events`, the same table
`retryCandidatesQuery` already reads, so a restart keeps it.

Each release wakes one waiter at a time. Waking means setting the waiter's
in-memory `retryDueAt` to now. Retry preparation and its VM eligibility checks
still run first, and admission is unchanged.

1. Give the release to the earliest waiter for which it is valid and that is
   not already woken.
2. If that waiter's attempt launches, the release is spent.
3. If its attempt is refused on the same scope, it keeps its place in the
   queue. Its new refusal makes the release invalid for it, so the release
   passes to the next waiter.
4. When the release is valid for no remaining waiter, it is dropped.

So each release causes at most one launch attempt per waiter, with one attempt
in flight at a time. N releases run N walks at once, so a scope never has more
attempts in flight than releases it has seen.

**Starvation.** First fit lets a small request take quota freed for a larger
one ahead of it. A _passover_ is defined once, on durable rows, and the
reconciler and the E2E runner use the same predicate. A waiter W is passed
over once for each of its refusals on a scope, at time `t`, when both hold:

- a release on that scope has `ended_at` after W's previous refusal on the
  scope and at or before `t`, so W was refused while that release was valid
  for it; and
- a waiter with a later first refusal on the scope has a launched `vms` row
  (`launch_diagnosis IS NULL`) on the scope created after `t` and before W's
  next `queued` event.

The later launch counts whether a wake or its own RFC 0022 timer started it,
since either way it took quota W was refused. After three passovers W holds a
_reservation_, from the creation of the third passover's launch. Releases on
its scope then go only to W until it launches or the reservation expires,
after `RETRY_PROVISIONING_CAP_MS` (10 minutes). Passovers before an expired
reservation no longer count. The reservation affects wakes only. Waiters
behind it still retry on their own RFC 0022 timers, so a request larger than
the remaining quota can delay its siblings by at most 10 minutes per
reservation, and never halts the scope. The reconciler derives passover
counts and reservations from `workload_events` and `vms` on each discovery
pass, so both survive a restart.

**Timers stay.** A wake can only bring a deadline forward. A waiter that is not
woken keeps its RFC 0022 deadline, so releases anycloud does not see are still
picked up. A wake-induced refusal is an ordinary retry. It advances the curve
index and counts toward the 100-attempt budget (`FAILED_DEPLOY_MAX_ATTEMPTS`).
The walk bounds that to one attempt per waiter per release.

### Placement: a known quota shortfall ranks last

A candidate whose quota reading is complete and shows room for less than one
VM gets a fourth verdict, `QuotaShort`, in place of `Unavailable`. That covers
Azure's family, regional-total and `LowPriorityCores` headroom checks and the
AWS zero-limit check, the two readings in the table under Context. The
classification returns these candidates after the `Verified` and `Unknown`
ones, along with their keys, and `preflightTargetCandidates` passes the keys
on beside `verifiedKeys`.

`pickTarget` ranks candidates by:

1. verified live capacity, as today;
2. fewest failures;
3. not quota-short before quota-short;
4. least recently failed, then catalog order, as today.

A quota-short target is therefore tried last among targets with the same
failure history, and is tried at all only after every other target has been
refused at least as often. A reading that says "full" when the launch would
succeed costs at most one pass before that target is tried. The node pool
pass applies the same tiebreak to its untried candidates.

A quota reading can never empty the candidate list. If every candidate is
quota-short, they are all tried in the usual order. A read that fails, times
out or returns a malformed result leaves the candidate `Unknown`, as today.
A cached reading is at most 60 s old (the snapshot TTL), and a stale reading
can only misorder candidates. The provider's launch result decides, as
the reorder-never-exclude rule requires.

The exclusions that are not quota readings stay as they are. When they leave
nothing, the Workload ends `invalid` with a message that no longer mentions
quota.

A pinned Workload whose region is quota-short now launches. A refusal there
is a regional quota refusal, which makes it a regional waiter on that
credential and region, woken as described above. A known limit below one VM
behaves differently: AWS refuses with "limit of 0" and Azure with
"Current Limit: 0", both classified as `invalid-target`. That already fails
over for an unpinned Workload and ends a pinned one as `invalid`. The cost of
not excluding the target is one refused call per pass.

A multi-region Workload can exhaust every candidate this way within one pass:
each listed region refuses in turn with `invalid-target`. When a pass refuses
every one of a Workload's candidates as `invalid-target`, with none left
untried, the Workload ends `invalid` after that pass, with the same message
the preflight gives today. A pass in which any candidate is instead refused on
a quota diagnosis, or is still untried, does not end the Workload: it keeps
retrying on the RFC 0022 curve, since some candidate may still take the
launch. This is the only placement-time verdict this RFC ends a Workload on;
every other refusal retries. _Decided (2026-11-11) by the owner._

### Local vCPU quota (test substrate)

Local has no users; it is the substrate the E2E suite runs on. It gets a
vCPU quota so that the account-wide wake runs live on every pull request
through the same gateway refusal, scope and wake path as a cloud. The quota
is judged on test value and size only, and it is not offered or documented as
a user feature: there is no `api start` option and no `docs/` page. The E2E
harness sets the variable when it starts its Local API, the way it already
sets `ANYCLOUD_TEST_LOCAL_BUCKET_ROOT`.

| Part      | Design                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setting   | `ANYCLOUD_LOCAL_VCPU_QUOTA=N` in the API's environment, which `test/integration/e2e.sh` passes in `start_local_api_for_smolvm_e2e` for the `local-quota-wait` member only.                                                                  |
| Default   | Unset: unlimited, which is today's behavior. `N` is a positive integer; an API process that reads a malformed value refuses to start and names the variable, so a typo never means unlimited.                                               |
| Read      | Once at startup, in `src/api/config.ts` as `LOCAL_VCPU_QUOTA` (`number \| undefined`), beside the other environment-tuned limits. The Local gateway (`gateways/local.ts`) reads that constant on each launch.                               |
| Usage     | The vCPUs of every live local machine with the API's `ac-local-` prefix, read from smolvm's `listMachines` (each machine reports its `cpus`), plus launches in flight in this process. The runtime smoke-check machine is not counted.      |
| Refusal   | Before it creates a machine, `newVM` refuses when usage plus the new VM's vCPU would exceed `N`, with `Local vCPU quota exceeded: 2 of 2 vCPUs in use (ANYCLOUD_LOCAL_VCPU_QUOTA=2).` `classifyError` maps it to `quota-exhausted-account`. |
| Atomicity | The check and the machine create run under one process-local lock, so two concurrent launches cannot both take the last vCPU. One API process owns Local compute, as with the reconciler.                                                   |

A refused local launch then follows the rest of this RFC unchanged. Its
`retrying` event has `quota-exhausted-account` and `retry-same-target`, it
waits in scope `account:local`, and a Local VM's release wakes it. Local has
no placement quota reading, so the `QuotaShort` ranking does not apply.

**Passover fault.** Every local VM has 1 vCPU, so any release fits any
waiter, and a real quota alone can never pass a waiter over. A passover needs
a waiter that a release does not fit while a later one does. The Local
target adapter therefore has one named fault, armed when the harness starts
the API, following the existing `ANYCLOUD_E2E_CAPACITY_FAULT`:

- **Read.** `src/api/config.ts`, which owns environment access, parses
  `ANYCLOUD_E2E_QUOTA_FAULT=<workload ID prefix>:<n>` once at startup; a
  malformed value stops the API, as for the quota.
- **Applied.** Inside the Local vCPU claim (`gateways/local-quota.ts`), under
  the same lock that decides whether the quota admits the launch, so the fault
  fires only when the real quota has room. An attempt the quota refuses
  anyway, woken or timed, gets the real refusal and leaves the fault unspent.
  A call-site throw would decide outside that lock and could spend the fault
  on such an attempt. The parsed value reaches the claim from `config.ts`;
  the gateway reads no environment and has no test mode (no `IS_TEST`
  branch), so the provider-runtime lint rules hold. The claim raises the
  Local quota error for a Workload whose ID has the prefix, until it has
  raised it `n` times.
- **Prefix.** The prefix is one constant, `qw-passover`, which `e2e.sh` puts
  in the member's API environment and the Local quota-wait adapter supplies
  as profile data. The runner names waiter A with
  `names.workload('qw-passover')`, so A's generated ID, and no other
  Workload's, starts with it.

Its refusals take the product's own classification, scope and wake path; only
the reason for the refusal is injected. The count is process-local.

_Decided by the owner, 2026-11-11._ The alternatives were larger local VM
types, `local-2` and `local-4`, coded by hand (+24 source) or read from a
local catalog. A catalog does not stay small: a non-null `catalogFile` makes
Local one of `CATALOG_BACKED_CLOUDS`, so it would appear in `anycloud gpus`
rollups and Docker option checks, be downloaded from the external catalog
repository, enter the catalog workflow's fetch and
`scripts/validate-generated-catalog.ts`, and move Local's region and VM type
lists onto the catalog path in `cloud-config.ts`. Both would add a test-only
hardware choice that users could see, which the fault avoids.

### Data model

There is no migration, and no table, column, index or trigger changes. One
JSON key is added to an existing metadata shape. The placement change persists
nothing: `QuotaShort` lives only in the in-memory candidate snapshot, and the
launch it leads to writes the same `vms` row and `retrying` event as any
other launch.

| Table             | Before                                                                                                                                                                         | After                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workload_events` | A `queued` event after a retry carries no reason; `reason: 'resubmitted'` marks a resubmission. `retrying` carries `diagnosis`, `disposition`, `credentialId`, `targetRegion`. | A `queued` event that a release woke carries `reason: 'quota-released'`. `retrying` is unchanged, and the scope is derived from its existing keys. Writer: `workload-lifecycle.ts` `queueRetryCandidate`, unchanged. |
| `vms`             | `ended_at` is the billing end and cleanup fence.                                                                                                                               | Unchanged. It is also read as the release signal for a scope.                                                                                                                                                        |

What stays the same: every column, the event state machine, the write path of
`vms`, and the RFC 0022 retry facts derived in `retryCandidatesQuery`. The
queue order, valid releases, spent releases, passover counts and reservations
are not persisted. Queue order, valid releases, passover counts and
reservations are re-derived from the rows above; spent releases and woken
membership are process-local.

The Local quota adds test-substrate configuration, not schema:

| Setting                 | Before                                  | After                                                                                                                                           |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| API environment         | none                                    | `ANYCLOUD_LOCAL_VCPU_QUOTA`, read once into `LOCAL_VCPU_QUOTA` in `src/api/config.ts`; unset means unlimited, malformed stops the API at start. |
| API environment, E2E    | `ANYCLOUD_E2E_CAPACITY_FAULT` only      | Adds `ANYCLOUD_E2E_QUOTA_FAULT=<prefix>:<n>`, read in `config.ts` and applied inside the Local vCPU claim, under its lock.                      |
| `vms` row of a Local VM | `credential_id` null, `vm_type` `local` | Unchanged. The release query reads it for scope `account:local`.                                                                                |
| `api start`, `docs/`    | –                                       | Unchanged: neither setting is a user option.                                                                                                    |

### API and events

| Surface                                                                             | Before                                                                                                                                                                 | After                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/workloads/{id}` `retry`                                                    | `{attempt, earliestAt, latestAt}`                                                                                                                                      | Adds an optional `wait: {reason: 'quota', scope: 'account' \| 'region' \| 'spot', region: string \| null, position: number, waiters: number}` for a waiter. `earliestAt` and `latestAt` stay the RFC 0022 window; `latestAt` is still the latest the next attempt can start. |
| `workload_events` (status `events`)                                                 | A woken retry looks the same as a timed one.                                                                                                                           | `queued` with `reason: 'quota-released'` marks a wake. A quota wait runs from a `retrying` event with a quota diagnosis and `retry-same-target` to the next `queued` event.                                                                                                  |
| `GET /v1/workloads` list reason                                                     | "waiting for quota"                                                                                                                                                    | "waiting for account quota" or "waiting for regional quota"                                                                                                                                                                                                                  |
| CLI `status` and `wait`                                                             | `→ Attempt 3, next 14:02–14:07: Account quota exhausted (n2-standard-16, us-east4). Automatic.`                                                                        | `→ Attempt 3, waiting for account quota, 2nd of 6; starts when a VM on this credential is released, by 14:07 at the latest. Automatic.`                                                                                                                                      |
| Workload placement when every candidate's known quota has room for less than one VM | The Workload ends `invalid`: "All Azure regions for … lack enough quota or Compute access…", or for AWS "…have a vCPU quota of 0…". A node pool records a failed pass. | The candidates are tried in order. A refusal is an ordinary quota or `invalid-target` retry, so a pinned Workload on a full region waits on its regional quota. The Azure and AWS exhausted messages name only Compute access, region opt-in or offering.                    |

`retry.wait` is computed when `status` is read, from the same derivation the
reconciler uses, in the same database snapshot as the events. It is not the
reconciler's in-memory state, so it does not show a reservation. A client that
separates launch time from boot can sum quota waits from events alone, without
reading status at the time.

The field is additive on `workloadStatusResponseSchema`; the OpenAPI
document and the Python SDK are regenerated from it. The workload status route is
not a replica route.

A new Workload state, `quota-waiting`, was considered and rejected. It would
widen the transition map in `src/shared/workload.ts` and every consumer of it,
yet `retrying` already means waiting before another attempt.

### Multi-replica API behavior

The API runs one process per database, and this design depends on that in the
same way the reconciler already does. Queue order and valid releases come from
durable rows, and so do passover counts and reservations. Woken membership
and spent releases live in process memory.

- **Restart or upgrade.** With `Recreate`, the new process rebuilds queues on
  its first discovery pass. It may spend one release twice, which costs one
  extra attempt per waiter. Passover counts and reservations are re-derived
  from the rows. RFC 0022 timers
  continue in both cases.
- **Two API installations on one cloud account**, for example a local API and
  a hosted API sharing a GCP project, do not see each other's releases. Each
  coordinates its own Workloads and falls back to the curve for the other's.
- **If shared-database replicas are ever supported**, the wake is already safe
  to duplicate. `queueRetryCandidate` compare-and-sets on the retry revision,
  so two replicas waking one waiter queue it once. Fair order would need the
  walk to move into a durable claim, either a row per spent release or a
  per-scope lease. That change belongs with the RFC that adds replicas, along
  with the rest of the reconciler's process-local fairness.

### Accepted limitations

- Releases that anycloud does not perform are seen only through the RFC 0022
  timers. Adding a provider quota-usage read would be justified by evidence
  that such releases dominate a scope's waits.
- The key is the saved credential, not the cloud account. Keying by the cloud
  identity (project, account, subscription or API key hash) needs a resolved
  identity on each `vms` row. That would be justified by evidence of two saved
  credentials on one account that contend.
- The scope ignores the quota metric, as described above.
- GCP still classifies an API rate-limit `RESOURCE_EXHAUSTED` as quota
  (RFC 0022, latent defects). Such a waiter is woken on releases, which adds
  at most one call per release.
- Unpinned regional quota waits are not coordinated. A Workload that failed
  over is not pulled back when its first region frees quota.

## Required invariants

1. A wake only brings a waiter's retry deadline earlier; it never moves it
   later than the deadline the RFC 0022 curve sampled.
   _Enforcement: review — not built; the reconciler unit tests (S5) will hold it._
2. A woken retry still runs retry preparation and the durable VM eligibility
   check before `queueRetryCandidate` moves it to `queued`.
   _Enforcement: review — not built; the reconciler unit tests (S1) will hold it._
3. Only a `vms` row with `launch_diagnosis IS NULL`, a confirmed `ended_at`,
   and the waiter's credential (and region, for a regional scope) counts as a
   release. For `account:local`, the credential is null and the VM's Workload
   runs on Local.
   _Enforcement: review — not built; the repository test (S6) will hold it._
4. Each release causes at most one launch attempt per waiter on its scope.
   _Enforcement: review — not built; the walk unit tests (S2) will hold it._
5. A quota reading only reorders launch candidates. It never removes one, and
   it never makes a Workload `invalid` or a node pool pass fail.
   _Enforcement: review — not built; the placement unit tests (S10, S12) will hold it._
6. An unpinned Workload whose candidates are each refused as `invalid-target`
   within one placement pass, with none left untried, ends `invalid` after
   that pass.
   _Enforcement: review — not built; the placement unit tests (S13) will hold it._

7. With `ANYCLOUD_LOCAL_VCPU_QUOTA` set, the Local gateway refuses a launch
   before it creates a machine when the vCPUs of the live local machines and
   launches in flight, plus the new VM's, would exceed the quota, and the
   refusal is diagnosed `quota-exhausted-account`.
   _Enforcement: review — not built; the Local gateway unit tests (S14) and the Local `quota-wait` member (S17) will hold it._
8. Concurrent local launches in one API process never together exceed the
   Local vCPU quota.
   _Enforcement: review — not built; the Local gateway unit test (S14) will hold it with concurrent launches._
9. With `ANYCLOUD_LOCAL_VCPU_QUOTA` and `ANYCLOUD_E2E_QUOTA_FAULT` unset, no
   local launch is refused for quota, and a malformed quota value stops the
   API at startup instead of being read as unlimited.
   _Enforcement: review — not built; the config and Local gateway unit tests (S15) will hold it._

**0 of 9 verified wired, 0 cited, and 9 resting on review**: invariants 1, 2,
3, 4, 5, 6, 7, 8, and 9.

## Acceptance scenarios

Each coverage cell becomes a test token for this RFC and row when the implementation lands.

| ID  | Scenario                                                                                                                                                                                                                                                                   | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                    | Coverage               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| S1  | Three Workloads on one credential wait on `quota-exhausted-account`, first refused in the order A, B, C; a fourth Workload's VM on that credential is released                                                                                                             | A is queued within 2 s with `reason: 'quota-released'`; B and C keep their curve deadlines                                                                                                                                                                                                                                                                                                                                                         | review — not built yet |
| S2  | S1, and A is refused again on the same scope                                                                                                                                                                                                                               | B is woken with the same release; A keeps first place; if B and C are also refused, the release is dropped and no waiter is woken twice                                                                                                                                                                                                                                                                                                            | review — not built yet |
| S3  | A 16-vCPU waiter is first; 2-vCPU waiters behind it launch on three releases it could not use                                                                                                                                                                              | the 16-vCPU waiter holds a reservation; the next releases wake only it until it launches or 10 minutes pass; the 2-vCPU waiters' own timers still fire                                                                                                                                                                                                                                                                                             | review — not built yet |
| S4  | A region-pinned Workload waits on `quota-exhausted-region` in `us-east-1`; VMs on the same credential are released in `us-west-2`, then in `us-east-1`                                                                                                                     | the `us-west-2` release does not wake it, though it counts for the credential's account scope; a `us-east-1` release on another credential does not wake it; the `us-east-1` release on its credential does; an unpinned Workload refused on that regional quota fails over as today                                                                                                                                                               | review — not built yet |
| S5  | No release happens while a waiter's curve deadline passes                                                                                                                                                                                                                  | it retries at its sampled deadline, as today                                                                                                                                                                                                                                                                                                                                                                                                       | review — not built yet |
| S6  | A failed launch's `vms` row (with `launch_diagnosis`) is ended; a VM on a different credential is released                                                                                                                                                                 | neither wakes a waiter                                                                                                                                                                                                                                                                                                                                                                                                                             | review — not built yet |
| S7  | The API restarts with two waiters and one unspent release                                                                                                                                                                                                                  | the first discovery rebuilds the queue in first-refusal order and wakes the first waiter                                                                                                                                                                                                                                                                                                                                                           | review — not built yet |
| S8  | `status` is read for the second of three account-quota waiters                                                                                                                                                                                                             | `retry.wait` is `{reason: 'quota', scope: 'account', region: null, position: 2, waiters: 3}`; the list row reads "waiting for account quota"                                                                                                                                                                                                                                                                                                       | review — not built yet |
| S9  | Live, per release: on GCP a region-pinned burst exceeds a regional quota; on AWS and Azure a pinned Job waits on a full region (S11) and an unpinned Job lists that region and another                                                                                     | every refused Job completes; each `quota-released` wake follows a release on the same scope and goes to the earliest waiter in first-refusal order, unless every earlier waiter was refused after that release; no Job ends `invalid` from a quota reading; the unpinned Job's first attempt avoids the full region                                                                                                                                | review — not built yet |
| S10 | An unpinned Workload has candidates in regions A, B and C; Azure or AWS reads A's quota as under one VM                                                                                                                                                                    | B and C are tried before A; A is tried once B and C have each been refused; a node pool with the same candidates orders them the same way                                                                                                                                                                                                                                                                                                          | review — not built yet |
| S11 | A Workload is pinned to an Azure region whose family quota reads under one VM; another VM on the same credential in that region then ends                                                                                                                                  | the Workload launches instead of ending `invalid`, is refused with `quota-exhausted-region`, waits with `retry.wait.scope: 'region'`, and is queued within 2 s of the release with `reason: 'quota-released'`                                                                                                                                                                                                                                      | review — not built yet |
| S12 | The quota reading is wrong (shows full, launch succeeds), fails, is malformed, shows every candidate full, or is a stale cached reading                                                                                                                                    | wrong or stale: the target is tried after its peers and launches; failed or malformed: the candidate is `Unknown`, as today; every candidate full: all are tried in order; no case ends the Workload `invalid`                                                                                                                                                                                                                                     | review — not built yet |
| S13 | An unpinned Workload has candidates in two regions; each reports a known limit below one VM and each is refused as `invalid-target` within the same pass                                                                                                                   | the Workload ends `invalid` after that pass, with the existing exhausted-candidate message; a pass that also includes a quota refusal, or leaves a candidate untried, does not end the Workload                                                                                                                                                                                                                                                    | review — not built yet |
| S14 | Local API with `ANYCLOUD_LOCAL_VCPU_QUOTA=2`; two local VMs are live, or one launch is in flight beside one live VM, when a third launch starts; separately, two launches start at once with one vCPU free                                                                 | the third launch is refused before any machine is created, with `quota-exhausted-account` and `retry-same-target`; it waits in scope `account:local`; of the two concurrent launches exactly one is refused                                                                                                                                                                                                                                        | review — not built yet |
| S15 | The API starts with `ANYCLOUD_LOCAL_VCPU_QUOTA` unset, or set to `0` or `abc`                                                                                                                                                                                              | unset: no local launch is refused for quota; `0` or `abc`: the API exits at start, naming the variable                                                                                                                                                                                                                                                                                                                                             | review — not built yet |
| S16 | `ANYCLOUD_E2E_QUOTA_FAULT=qw-a:2`; a Local Workload whose ID starts with `qw-a` attempts launches with room under the quota, and once while the quota is full; another Local Workload launches with room                                                                   | the attempt while the quota is full gets the real refusal and does not spend the fault; the first two attempts with room are refused with the Local quota error and `quota-exhausted-account` before any machine is created, and the next launches; the other Workload is not refused                                                                                                                                                              | review — not built yet |
| S17 | Live, every pull request, Local `quota-wait` member at a 2-vCPU quota with the passover fault armed for waiter A: two holders run; waiters A to E are refused in that order; the runner ends running Jobs one at a time, then restarts the API with new waiters F, G and H | each release wakes A first with `quota-released`; A is refused and the release passes on to the next waiter; once three passovers of A are counted with the passover predicate, a release wakes only A until A launches; after F spends a release and the API restarts with the quota full, the first discovery wakes G, G is refused, the release passes to H, H is refused and the release is dropped, with one extra attempt each and no launch | review — not built yet |

## Test plan

**Unit, reconciler** (`test/unit/services/workload-reconciler.spec.ts`). These
use the existing fake clock and random ports, with retry candidates and
releases supplied directly. They cover S1–S3, S5 and S7: walk order,
passing a release on after a refusal, dropping a release, passover and reservation expiry,
deadlines only moving earlier, and rebuilding after a restart.

**Repository** (`test/unit/services/repositories/`). These run on a real
SQLite database through the migrations. They cover the scope derivation and
first-refusal order across resubmission and `initializing` boundaries, the
passover predicate with woken and timed later launches and reservation
expiry, and the
release query for S4 and S6, including spot, other credentials, other regions
on the same credential, and failed launch rows.

**Placement** (`test/unit/services/launch-targets.spec.ts`,
`candidate-availability.spec.ts`, `quota-azure.spec.ts`, `quota-aws.spec.ts`).
These cover S10, S12 and S13 with each provider's real assessment over
supplied quota readings: the Azure family, regional-total and spot headroom
checks, the AWS zero limit, the `pickTarget` tiebreak against failure counts
and the verified class, the node pool pass, and each failure direction that
rule lists. A case with every candidate quota-short asserts that the Workload is
placed, not made `invalid`. A case with every candidate refused
`invalid-target` within one pass asserts that the Workload ends `invalid`; a
case mixing an `invalid-target` refusal with a quota refusal, or leaving a
candidate untried, asserts that it does not.

**Status and CLI.** These cover `retry.wait` derivation (S8), the list reason,
and the renderer for both scopes. Assertions check the response object; the
renderer test asserts the line only because the line is what it promises.

**Local quota** (`test/unit/services/gateways/local.spec.ts` and the config
unit tests). These cover S14–S16 against the real gateway over a fake smolvm
client: usage from listed machines and launches in flight, the refusal before
any create, its diagnosis, two concurrent launches with one vCPU free, the
unset and malformed settings, and the passover fault's prefix and count. The
repository tests add the credentialless `account:local` scope and its release
query.

**E2E: the `quota-wait` contract family** (S9, S17). A new family under
`test/integration/e2e/`, following its README: a family rule first, then a
contract runner in `internal/contracts/quota-wait.ts`, target adapters, and
member specs in `specs/contracts/quota-wait/` that only select their target
and assert the completion record. The runner owns submission through the
canonical CLI path, every wait, the assertions, diagnostics and cleanup.
Adapters supply only validated profile data and named faults. Assertions are
correctness only, read from each Workload's events, `status` and the `vms`
rows; wake latencies and quota waits are written as plain timing records, not
asserted.

| Member             | Runs                                                    | Scope and placement exercised                                                                                                                                                                                                                                      | Named faults                                                      |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `local-quota-wait` | Every pull request, a new `integration.yml` Local suite | Account-wide, `account:local`, under `ANYCLOUD_LOCAL_VCPU_QUOTA=2`, which `e2e.sh` passes to this member's API only. One journey: wake, first-refusal order, a re-refusal passing the release on, passovers and the reservation, then restart (S1–S3, S7, S8, S17) | the passover fault for waiter A; the existing `LocalApiRestarter` |
| `gcp-quota-wait`   | Once per release, dispatch-only in `e2e-job.yml`        | Regional `CPUS`, a pinned burst (S4, S9)                                                                                                                                                                                                                           | none                                                              |
| `aws-quota-wait`   | Once per release, dispatch-only in `e2e-job.yml`        | Regional family vCPU quota: the pinned full-region wait (S11) and the unpinned rank-last check against a region whose family limit reads 0 (S10, S9)                                                                                                               | none                                                              |
| `azure-quota-wait` | Once per release, dispatch-only in `e2e-job.yml`        | Regional family cores quota: the pinned full-region wait (S11), with the region filled until its headroom reads under one VM, and the unpinned rank-last check against that region (S10, S9)                                                                       | none                                                              |
| Lambda             | Not run                                                 | –                                                                                                                                                                                                                                                                  | –                                                                 |

The Local journey runs at a 2-vCPU quota, with the passover fault armed for
waiter A's ID prefix and six attempts. Two `sleep` holders fill the quota.
Waiters A to E are submitted one at a time, each after the previous one's
refusal, so the first-refusal order is A to E, and `status` reports their
positions. The runner then ends one running Job at a time and checks each
step: the release wakes A with `quota-released`; the fault refuses A; the
release passes on and the next waiter launches on the freed vCPU. A waiter's
own RFC 0022 timer may start it at any point, so the runner does not assume a
fixed number of rounds; A's timed attempts while the quota is full get the
real refusal and leave the fault unspent. It counts A's passovers with the
predicate under "Wake order and fairness", over the same events and `vms`
rows the reconciler reads. It keeps ending
running Jobs, and submits another waiter whenever none is left behind A,
until that count reaches three. From then on A holds a reservation: the
runner checks that each later release wakes no other waiter, until A
launches with `quota-released` once the fault is spent. If the fault is
spent before three passovers are counted, the run fails as inconclusive. The
checks assert only what each wake did and accept any timed launch.

The restart stage uses new waiters. With A running and the quota full, the
runner submits 1-vCPU waiters F, G and H in that order and ends A. That
release wakes F, which launches and spends it. The runner then restarts the
API with `LocalApiRestarter`, leaving G and H waiting, the quota full, and
the release spent in the old process only. It checks that the first
discovery wakes G first, with `quota-released`; that G is refused, since F
took the freed vCPU; that the release then passes to H, which is refused too;
and that the release is then dropped, having caused one extra attempt each
for G and H and no launch.

Each cloud member reads its limit with `anycloud quota status`. Its adapter
names the credential, the region and a VM type whose family limit is small,
and for AWS a second region where that family's limit is 0. The runner sizes
the burst as enough holders to fill the limit plus two waiters, and fails
before any launch if that is more than eight VMs, so a raised limit cannot
make the run expensive. Holders run `sleep` until the runner ends them. GCP
runs only the regional burst, because the shared test project's global limit
is too high to reach cheaply and the owner chose no dedicated project (open
question 4). Lambda is not run, because its limit can't be read and the cost
of reaching it is unknown (open question 5); the Local member covers the
account-wide path it shares. Local placement reads no quota, so `QuotaShort`
is covered by the AWS and Azure members and the placement unit tests.

Per-release means a `RELEASE.md` checklist step: the three cloud members are
dispatched on each release candidate before `release.yml` is dispatched, and
their results are checked by hand. They do not gate `release.yml`, unlike the
hosted stage, because a provider's quota or capacity can fail a member
without a product defect, and a hard gate would then block a release on it. They stay out of the per-pull-request checks because each one buys VMs.

**A/B experiment, once** (`experiments/quota-wait-coordination/`). The
branch-versus-main comparison is not a test and never enters the E2E suites.
One `spike.yml` run, before the product pull request merges, runs the
branch's API and the main API as a control, one after the other, on the same
regional bursts on GCP, AWS and Azure as the cloud members, at about four
times each limit. It records each Job's quota wait and launch time for both.
The result goes into this RFC, and the experiment is deleted afterwards.
Local is not compared: it is a test substrate, and main has no Local quota.
Lambda is not run, as above. Cleanup uses the experiment's tracked inventory.

## Size estimate

| Part                                                                                                                                                                              | Product source | Unit tests | E2E  | Experiment |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- | ---- | ---------- |
| Waiter scope, first-refusal and passover derivation, release query (`retry-candidates.ts`)                                                                                        | +75            | +130       | –    | –          |
| Credentialless `account:local` scope in that derivation and release query                                                                                                         | +10            | +20        | –    | –          |
| Walk, spent releases, passover and reservation in `workload-reconciler.ts`; `noteRelease` hook                                                                                    | +130           | +200       | –    | –          |
| `queued` wake reason; `retry.wait` contract and derivation; list reason; CLI line                                                                                                 | +65            | +80        | –    | –          |
| `QuotaShort` verdict in Azure and AWS assessments and `createCandidateRegionFilter`; `pickTarget` and node pool tiebreak; exhausted messages; invalid-target-exhausted-pass check | +60            | +135       | –    | –          |
| Local vCPU quota: `LOCAL_VCPU_QUOTA` in `config.ts`, the gateway's usage count, lock and refusal, its diagnosis                                                                   | +52            | +55        | –    | –          |
| Passover fault: `ANYCLOUD_E2E_QUOTA_FAULT` in `config.ts`, applied inside the Local vCPU claim (`gateways/local-quota.ts`)                                                        | +20            | +15        | –    | –          |
| Docs: `docs/` retry behavior and placement; `ARCHITECTURE.md` workload controller; the per-release step in `RELEASE.md`                                                           | +45            | –          | –    | –          |
| `quota-wait` family: family rule and README, runner lifecycle and shared assertions                                                                                               | –              | –          | +190 | –          |
| `quota-wait` Local journey and adapter; `e2e.sh` settings; `integration.yml` suite                                                                                                | –              | –          | +230 | –          |
| `quota-wait` cloud journeys, GCP, AWS and Azure adapters, `e2e-job.yml` members                                                                                                   | –              | –          | +290 | –          |
| Four member specs and fixture wiring                                                                                                                                              | –              | –          | +70  | –          |
| One-time A/B experiment `experiments/quota-wait-coordination/`, branch against main on GCP, AWS and Azure                                                                         | –              | –          | –    | +180       |
| **Total**                                                                                                                                                                         | +457           | +635       | +780 | +180       |

Against the accepted estimate:

| Column         | Accepted | Amended | Change                                                                                                             |
| -------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Product source | +355     | +457    | +102: the Local quota (+52), the passover fault (+20), passover derivation (+15), `account:local` (+10), docs (+5) |
| Unit tests     | +525     | +635    | +110 for the Local quota, the fault, passover derivation and the scope                                             |
| E2E            | 0        | +780    | the new `quota-wait` family                                                                                        |
| Experiment     | +310     | +180    | correctness checks move to E2E; only the A/B comparison remains                                                    |

Product source includes docs (+45); code alone is +412. The experiment is
temporary and is deleted once its result is recorded here.

## Alternatives / open questions

### Alternatives

- **A per-credential token bucket for launches.** This limits how fast
  launches go out but knows nothing about when quota frees. Set slow, it
  delays Jobs that would fit. Set fast, it still sends refused attempts. RFC
  0022's amendment measured proactive Lambda pacing against reactive retry,
  and pacing did not improve completion while it worsened the median. A bucket
  would also delay every Workload on the credential, not only quota waiters.
- **Waking every waiter on each release.** This is simpler, but each release
  then causes one refused attempt per waiter, and the waiters race for the
  quota in random order. The walk costs the same in the worst case and
  is fair in the common case.
- **Checking quota usage before launch.** GCP, AWS and Azure expose usage
  against limit, so a launch that does not fit could be held back instead of
  refused. This needs per-cloud metric mapping, adds read calls on every
  waiter pass, and Lambda has no usage API. It is deferred until refused
  attempts are shown to matter in cost or throttling.
- **Keeping known-short targets excluded at placement.** This is what
  happens today. It saves one refused launch per short target, but a wrong or
  stale reading then blocks a launch that would succeed. It also ends
  a pinned Workload `invalid` instead of letting it wait for quota, and it
  breaks the reorder-only rule.
- **A durable wake queue table.** Order and releases can already be derived
  from `workload_events` and `vms`, so a table would duplicate them and need
  its own cleanup.
- **Raising quota automatically.** This is out of scope. Quota increases need
  provider approval and can change what a customer is billed, and anycloud
  retired its quota-increase submissions (`quota_operations` keeps only
  history). The existing hint that points to `anycloud quota` stays.

### Open questions

1. Decided by the owner, 2026-11-11: only the Workload release path wakes
   waiters at once. Node pool and cluster releases are found by the next
   discovery pass, within about 30 s, with no instant hook, because pool
   releases are infrequent.
2. Decided by the owner, 2026-11-11: three passovers and a 10-minute
   reservation, as constants in `config.ts`, not configurable until a live
   run says otherwise.
3. Decided by the owner, 2026-11-11: a wake-induced refusal counts toward the
   100-attempt budget and the curve index. The walk bounds them to one per
   release, and a request that never fits should still end.
4. Decided by the owner, 2026-11-11: no dedicated GCP project. GCP's live
   check is the regional burst. The account-wide path is checked live on
   Local instead, by the `local-quota-wait` member on every pull request
   (amendment of 2026-11-11).
5. Decided by the owner, 2026-11-11: no Lambda live check. Lambda's
   instance-launch limit can't be read, the cost of reaching it is unknown,
   and the account-wide wake shares its logic with the regional path. The
   account-wide path is checked live through the Local vCPU quota by the
   `local-quota-wait` member on every pull request (amendment of 2026-11-11),
   besides the unit and repository tests.
6. Decided by the owner, 2026-11-11: not in this RFC. An unpinned Workload
   refused on regional quota in every listed region stays on the RFC 0022
   curve and is not woken when a VM ends in one of those regions; pinning to
   a region gives the prompt retry. Revisit only if the live run shows
   unpinned regional waits dominate.
7. Decided by the owner, 2026-11-11: Local is a test substrate, with no
   users. Passovers on Local come from a named refusal fault, not from larger
   local VM types or a local catalog; see the Local vCPU quota section.

## Tracking

As changes ship, link each independently shippable change to its PR. The
product change, the Local quota and the `quota-wait` family are one pull
request. The A/B experiment runs once on that pull request's branch, its
result is recorded here, and it is deleted before merge.

## Decision

**Accepted, 2026-11-11, by the owner.** The owner answered "Yes, accept RFC
0051" to a direct question in the coordinating session, which relayed it.

Approved scope: per-credential and per-region coordination of quota-refused
retries as proposed (waiters ordered by first refusal, wake on a confirmed VM
release, passovers then a bounded reservation, RFC 0022 timers as the
fallback); the `retry.wait` status object and the `quota-released` wake reason;
known quota shortfalls ranked last at placement instead of excluded; and a
multi-region Workload that every region refuses as an invalid target ending
`invalid` after one pass (decided before acceptance; invariant 6 and S13). Not in scope:
waking unpinned multi-region Workloads on regional quota, and a dedicated GCP
project for an account-wide live check.

Every open question is answered (owner, 2026-11-11): only the Workload release
path wakes waiters at once, and pool and cluster releases wait for the next
discovery pass; three passovers and a 10-minute reservation, as constants; a
wake-induced refusal counts toward the attempt budget. Live checks run on GCP
(regional), AWS and Azure. Lambda is not run live: its limit can't be read and
the cost of reaching it is unknown.

**Amended after acceptance, 2026-11-11, by the owner.** The owner decided in
the coordinating session, which relayed it, to amend the test plan before the
build continues:

1. **Local vCPU quota.** A configurable vCPU cap on Local
   (`ANYCLOUD_LOCAL_VCPU_QUOTA`, unlimited by default), past which the Local
   gateway refuses launches with the account-wide quota diagnosis, so the
   real wake path runs on Local.
2. **A `quota-wait` E2E contract family.** The Local member runs on every pull
   request: the account-wide wake, first-refusal order, a re-refusal passing
   the release on, passovers and the reservation, and a restart through the
   existing `LocalApiRestarter`. The GCP regional member and the AWS and
   Azure members (the pinned full-region S11 and the unpinned rank-last
   check) run once per release, not per pull request. Assertions are
   correctness only, with plain timing records.
3. **A/B experiment.** The branch-versus-main comparison stays a one-time
   experiment under `experiments/`, recorded in this RFC, and never enters
   E2E.
4. **Coverage.** The account-wide path is now checked live through the Local
   member, and open questions 4 and 5, the live-check table, S9 and this
   section say so.

A second owner decision the same day set how: Local is testing-only ("there
is no such thing as local users"), so its quota is a test-substrate setting
with no `api start` option or `docs/` page, judged on test value and size.
Passovers on Local come from a named refusal fault,
`ANYCLOUD_E2E_QUOTA_FAULT`, chosen over larger local VM types after a local
catalog proved to spread into `anycloud gpus`, the catalog download and the
catalog workflow (open question 7).

The amendment added the Local quota section, the configuration Before /
After, invariants 7–9, scenarios S14–S17, the E2E and experiment test plan,
and the split size estimate.
