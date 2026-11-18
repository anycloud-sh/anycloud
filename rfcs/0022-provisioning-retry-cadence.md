# RFC 0022: Provisioning retry cadence

> Status: Accepted
> Date: 2026-08-23
> Author: Claude draft
> Amended: 2026-08-27 — Change 2 superseded by the Lambda amendment below
> Implemented: 2026-08-31 — all three changes

## Summary

A capacity-starved workload waits a mean 5.5–7.5 minutes between region
attempts, so covering a large candidate set takes hours. The cause is not a tuned
tradeoff: the provisioning backoff curve never escalates, because only its lower
bound doubles while its ceiling is pinned at ten minutes from the first attempt.

This proposes three independent changes — reshape the curve so it escalates from
a short first retry, fix a self-inflicted Lambda pacing rejection that a faster
cadence would make systematic, and let verified live capacity outrank least-tried
when picking the next region. It deliberately defers the cross-cloud throttle
detection and per-credential pacing that a substantially more aggressive cadence
would require, and records why that work is the prerequisite for going further.

The 2026-08-27 amendment preserves that original proposal as a decision record
but supersedes its Lambda pacing change. Live 50-workload Lambda `nuke` runs
found that reactive HTTP 429 retry matched the paced policy's reliability with
a better median and less shared state. The capacity-signal premise was also
validated against real launches. All three accepted outcomes are now
implemented.

## Context

### The curve does not escalate

`src/api/services/retry-backoff.ts:16-34`, provisioning branch:

```ts
const lowerBound = Math.min(
  RETRY_JITTER_BASE_MS * 2 ** (attempt - 1),
  RETRY_JITTER_CAP_MS * 0.5,
);
return Math.floor(lowerBound + jitter * (RETRY_JITTER_CAP_MS - lowerBound));
```

`src/api/config.ts:163` describes `RETRY_JITTER_BASE_MS` as "doubles per retry."
Only the lower bound doubles. The upper bound is `RETRY_JITTER_CAP_MS` — ten
minutes — from attempt one onward:

| attempt | draw range          | mean |
| ------- | ------------------- | ---- |
| 1       | uniform[60s, 600s]  | 330s |
| 2       | uniform[120s, 600s] | 360s |
| 3       | uniform[240s, 600s] | 420s |
| ≥4      | uniform[300s, 600s] | 450s |

The first retry is drawn from nearly the same window as the tenth. A customer
running an 8×H100 shape against 18 eligible Lambda regions observed gaps of 139s,
575s, and 523s — three independent draws, not backoff — covering three regions in
21 minutes. At the steady-state mean, covering all 18 takes roughly 2.2 hours.

`computeRetryWait` has exactly one production call site,
`src/api/services/workload-reconciler.ts:542`, which samples it once per durable
retry revision and holds the resulting deadline in memory.

### Retry cadence is the only control on provider load, and it is the wrong one

`MAX_ACTIVE_DEPLOY_PIPELINES = 50` (`src/api/config.ts:152`) is enforced at
`src/api/services/monitor.ts:2035-2039` as `slots = 50 - countDeploying()`. Retry
cadence therefore changes the _refill rate_ of fifty pipeline slots, never the
instantaneous occupancy. What the wide jitter window actually buys is fleet
de-synchronization: today's 540-second window divided across fifty workloads
gives ~10.8s mean spacing between launches on one credential.

That number is already marginally below Lambda's 12-second launch interval, which
is the first sign that cadence is a blunt instrument for this job. It regulates
the duty cycle while leaving the burst shape to chance.

### Throttle protection is asymmetric across clouds

| Cloud  | Client-side pacing | Throttle handling                                                                                                   |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Lambda | none               | `api()` retries every HTTP 429 with bounded exponential backoff; exhausted responses retain their provider code     |
| Azure  | none               | SDK honors 429 + `Retry-After` (`gateways/azure.ts:2487-2495`)                                                      |
| AWS    | none               | SDK `maxAttempts: 10` (`gateways/aws.ts:484-498`); `retryMode` is never set anywhere, so `standard`, not `adaptive` |
| GCP    | none               | throttles misclassified as quota (below)                                                                            |
| Vast   | none               | create reconciles instead of retrying (`gateways/vast.ts:1244-1308`); a 429 there ends the attempt as indeterminate |

`src/shared/cloud.ts:24-45` still has no cross-cloud rate-limit diagnosis.
Lambda is now the local exception: its gateway recognizes HTTP 429 for retry and
telemetry, then maps an exhausted response into an existing diagnosis. Shared
orchestration still cannot distinguish "you are going too fast" from other
temporary provider failures across clouds, so it cannot adaptively back off.

Three latent defects compound this, and each gets worse as cadence rises:

- **GCP** (`gateways/gcp.ts:2555-2565`) maps `RESOURCE_EXHAUSTED` to
  `QuotaExhaustedRegion`, which dispositions to `FailoverTarget`. GCP returns that
  code for per-minute API rate limits as well as real quota, so a throttle rotates
  the workload off a healthy region and penalizes its sibling zones
  (`services/optimizer.ts:180-189`). Its gRPC config retries the same code for
  `total_timeout_millis: 5_400_000` (`gateways/gcp.ts:393-560`) — 90 minutes,
  six times the 15-minute `PROVISIONING_TIMEOUT_MS`.
- **Vast** (`gateways/vast.ts:834-839`) checks 401/403 before the retryable check
  at `:843`. The edge/WAF HTML-403 shape its own `isRetryableVastApiError`
  documents at `:319-336` lands in the auth branch, classifies as `BadCredential`,
  and terminates the workload as `Invalid`. An infrastructure throttle can kill
  a customer's job.
- **AWS** (`gateways/aws.ts:3673-3680`) maps an opaque HTTP 400 to
  `ProvisioningRejected`, which on a pinned region burns the three-attempt budget
  at `src/api/config.ts:149`.

The 2026-07-22 queue-starvation postmortem records the failure mode this all
guards against — retry pressure earning an account-level throttle that slowed
even healthy calls — and states that no shared per-provider circuit breaker was added.

### Verified capacity is only a tie-break

`services/optimizer.ts:107-133` picks the least-tried candidate, comparing
strictly, so candidate-list order decides ties. `filterCandidateRegions` reorders
that list to `[...verified, ...unknown]` (`gateways/cloud.ts:1021`), and Lambda's
`assess` marks a region `Verified` when the account-wide inventory read reports it
under `regions_with_capacity_available` (`gateways/lambda.ts:1350-1357`, cached per
credential for 60s).

In the observed trace this worked correctly: the region that had capacity was
untried, tied at zero failures with fourteen others, and hoisting put it first.
But the mechanism is a tie-break, not a priority. Once a region has been tried
once, least-tried strictly outranks known-available, and a starved workload will
prefer untried regions the provider has already said are empty. Raising the
cadence without addressing this makes the system walk the dead regions faster.

## Goals

- Materially cut time-to-cover the first several candidate regions, on every
  cloud, without a per-cloud special case.
- Preserve fleet de-synchronization: the retry window must stay wide enough,
  relative to `MAX_ACTIVE_DEPLOY_PIPELINES`, that launches on one credential do
  not correlate.
- Never return a wait exceeding `RETRY_JITTER_CAP_MS`. That constant is used as a
  "definitely past due" sentinel at roughly 25 test sites in the shape
  `Date.now() - RETRY_JITTER_CAP_MS - 1000`; the bound is load-bearing.
- Make the cadence tunable by an operator without a release.
- Keep the increase in sustained API load to a single small constant, identical
  across clouds.

## Non-goals

- Simultaneous multi-region launch with loser teardown. Rejected below.
- A per-cloud cadence table. Deferred until throttle detection exists to justify
  the constants.
- A shared rate-limit diagnosis or cross-cloud adaptive brake. Lambda's later
  gateway-local HTTP 429 policy is recorded in the amendment; a general policy
  still belongs in its own RFC.
- Changing `MAX_ACTIVE_DEPLOY_PIPELINES`, `listQueued` lane fairness, or anything
  else in admission.
- Fixing the three latent throttle defects listed above. They are named here
  because this change raises their exposure, not because it addresses them.

## Proposal

Three changes. Each ships on its own, in any order, and is separately revertible.

### Change 1 — reshape the provisioning curve

Replace the provisioning branch of `computeRetryWait` with a capped exponential
carrying a _relative_ floor, so jitter stays proportionally wide at every attempt
rather than collapsing into a narrow band once the ceiling saturates:

```
ceiling(n) = min(RETRY_PROVISIONING_BASE_MS * 2**(n-1), RETRY_PROVISIONING_CAP_MS)
wait       = ceiling(n) * 0.1 + jitter * ceiling(n) * 0.9      // mean 0.55 * ceiling
```

```ts
export const RETRY_PROVISIONING_BASE_MS = positiveIntegerEnv(
  'RETRY_PROVISIONING_BASE_MS',
  150_000,
);
export const RETRY_PROVISIONING_CAP_MS = positiveIntegerEnv(
  'RETRY_PROVISIONING_CAP_MS',
  RETRY_JITTER_CAP_MS,
);
```

Defaulting the cap _to_ `RETRY_JITTER_CAP_MS` keeps every sentinel test site valid
and encodes the "no curve exceeds this" invariant in code rather than a comment.
Both constants are environment-overridable via the existing `positiveIntegerEnv`
helper at `src/api/config.ts:14`; no retry constant is today, and given the
production-incident history this converts a bad retune from a hotfix release
into an env var on the affected box.

While in the file: correct the "doubles per retry" comment at `config.ts:163`, and
have the non-provisioning branch use `RETRY_JITTER_BASE_MS` instead of its
hardcoded `60_000` so the constant is honest again.

At the default, folding in roughly 60s of per-attempt pipeline overhead:

|                                                     | today              | proposed            |
| --------------------------------------------------- | ------------------ | ------------------- |
| mean wait, attempt 1 / 2 / steady                   | 330s / 360s / 450s | 82.5s / 165s / 330s |
| time to third region                                | 13.5 min           | 6.1 min             |
| time to eighteenth region                           | 2.34 h             | 1.73 h              |
| sustained rate, chronically starved job             | 1.0×               | 1.31×               |
| burst: 50 correlated retries, launches in first 60s | 0                  | 16.7                |

Pinning the cap is what holds the sustained increase to one number across all
clouds — the cycle time moves from 510s to 390s. A 300-second cap would buy more
at the head of the curve at 2.27× sustained; lowering the cap later is easy,
raising it after an incident is not.

### Change 2 — fix the Lambda launch-gate rejection (superseded)

This section records the original accepted proposal. The 2026-08-27 amendment
below supersedes it with status-driven reactive retry and removes both Lambda
request gates.

`gateways/lambda.ts:449-510` has two coupled defects.

`api()` creates `AbortSignal.timeout(timeoutMs)` at `:455` and _then_ awaits
`paceRequest` at `:459`, so queueing for our own rate gate is charged against the
budget the HTTP call needs; an accepted 25-second pacing wait leaves the request
five seconds. And `paceRequest` passes `maxWaitMs = LAMBDA_API_TIMEOUT_MS = 30_000`
to `reserve`, so with launch reservations stacking twelve seconds apart the fourth
concurrent launch on one credential needs 36 seconds, is rejected, and throws an
error matching no `classifyError` pattern — falling through to
`TemporaryProviderFailure` and burning a retry attempt on a launch that never
happened.

Take the pacing wait before the request deadline exists, bounded on the caller's
signal, and give pacing its own budget:

```ts
const LAMBDA_LAUNCH_PACE_BUDGET_MS = 8 * LAMBDA_LAUNCH_INTERVAL_MS; // 96s
```

Well inside `PROVISIONING_TIMEOUT_MS`, so the pipeline deadline stays the outer
terminator. Eight-plus concurrent launchers per credential then queue instead of
three, and a rejection past that is correct backpressure rather than a
self-inflicted error. The two callers that treat `timeoutMs` as a total budget
stay bounded: `pollForAdoptableInstance` (`:869-880`) re-checks its own deadline
each iteration, and `runPreflight` (`:1337-1348`) is bounded independently by the
preflight cache's fail-open wait at `gateways/cloud.ts:935-976`.

This is a bug fix on its own merits. It is also the one conditional prerequisite
for Change 1: under the new curve, fifty workloads on one credential arrive
~2.7s apart rather than ~10.8s, so roughly thirteen land inside a 36-second
window and everything past the third would throw. A single workload walking a
region list never reaches this — it makes one launch call at a time — so the
ordering matters only for fleets sharing one Lambda API key.

### Change 3 — verified capacity outranks least-tried

Expose the classification `createCandidateRegionFilter` already computes at
`gateways/cloud.ts:980-1021` and currently collapses into
`[...verified, ...unknown]`. Add a `providesLiveCapacitySignal` opt-in to
`CandidateRegionFilterOps`, defaulting to `false`, following the existing
`terminalAuthErrorClassifierBrand` pattern at `gateways/cloud.ts:1040-1060`.

Only Lambda sets it (`gateways/lambda.ts:1329-1358`): its
`regions_with_capacity_available` is genuine live inventory. AWS and Azure
`Verified` means entitlement — region enabled, quota above zero — and GCP's means
catalog existence; none of the three correlates with current capacity, so opting
them in would accelerate every capacity-starved workload unconditionally
against an unpaced API, which is the 2026-07-22 shape.

`pickTarget` (`services/optimizer.ts:107-133`) takes an optional
`verifiedKeys: ReadonlySet<string>` and ranks by verified class, then least-tried,
then catalog order — applying the first tier only when the set is non-empty and
the cloud opted in. Behavior on every non-opted-in cloud is byte-identical. No
added API calls: the classification is already computed and discarded.

## Alternatives considered

**Simultaneous multi-region launch with loser teardown** — the shape the customer
asked for. The original gate-specific constraint no longer applies after Lambda's
launch-gate rejection was superseded, but the remaining rejection grounds stand. Lambda's launch endpoint has no
idempotency key (`gateways/lambda.ts:682-703`), which is why
`pollForAdoptableInstance` already exists to prevent double-launch on a lost
response; N concurrent launches under one workload tag make that window N-way.
Loser billing is unbounded in practice — termination confirmation runs up to 30
attempts at 10-second intervals per VM, on 8×H100 nodes — and parallel launches
amplify the edge throttling now handled reactively. Serial retry at inventory
cadence, which Changes 1 and 3 approximate, yields more targeted attempts per
unit time at a lower peak call rate with none of these hazards.

**A per-cloud cadence multiplier table** — attractive because throttle protection
is genuinely asymmetric, and considered in detail. Deferred: the postmortem
records "one state-based curve instead of separate admission gates and
diagnosis-specific cooldowns" as a deliberate remediation, and re-adding a
dimension should be justified by measured throttle telemetry rather than by
reading each gateway's source and guessing constants. The detection work below is
what produces that telemetry.

**A dedicated capacity-watch poller** that reads each provider's cached inventory
on a short interval and pulls retry deadlines in when capacity appears. This is
the only design that catches capacity opening _during_ a cooldown, which is the
customer's literal complaint. It is also roughly 780 LOC of new machinery —
a monitor, per-credential slot leasing, lane round-robin, a consecutive-
acceleration cap — for one cloud, since Lambda is the only provider with a real
capacity oracle today. Revisit if Changes 1 and 3 do not close the gap, or once a
second provider gains a live signal (Vast's `PUT /search/asks/` is the obvious
candidate).

**Setting AWS `retryMode: 'adaptive'`** — looks like a one-line answer to the
queue-starvation throttle. It is a placebo here: gateways are constructed fresh per
attempt (`services/cloud-config.ts:183-186`, no memoization), so the adaptive
rate limiter's state never accumulates across attempts. It would also hide the
throttle signal inside the SDK, which is the opposite of what detection needs.

**Lowering `RETRY_PROVISIONING_CAP_MS` to 300s** — 3–4× improvement at the head
of the curve instead of 2.2×, but 2.27× sustained load rather than 1.31×, and it
breaks the `RETRY_JITTER_CAP_MS` sentinel relationship. Reachable later by env
var if the sustained figure proves comfortable.

## Risks & caveats

- **Sustained provider API load rises 1.31× for chronically starved fleets.** This
  is the honest cost. It is uniform across clouds by construction, and revertible
  by env var without a release.
- **This does not fix the three latent throttle defects** in GCP, Vast, and AWS
  classification. It raises how often they are reached. If any of them is
  observed in the wild before the detection RFC lands, they should be fixed
  independently rather than by slowing the cadence back down.
- **The cross-cloud system still cannot diagnose throttling.** Lambda recognizes
  HTTP 429 locally and reports recovery or exhaustion, but the shared diagnosis
  model still has no rate-limit class and other providers retain their existing
  behavior.
- **`retryDueAt` is process-local.** `workload-reconciler.ts:531-547` re-samples
  the jitter on restart within the same durable window anchored to `lastRetryAt`.
  A restart can pull a wait in or push it out. This is pre-existing and unchanged,
  but the shorter curve makes the effect proportionally larger.
- **Change 3 helps exactly one cloud.** It is correct and cheap, but its value is
  bounded by Lambda's share of capacity-starved workloads.
- **Tension with the 2026-07-22 remediation.** That postmortem simplified retry
  policy deliberately. The original RFC kept the single curve; the amendment
  adds a bounded Lambda-local HTTP 429 policy without changing durable cadence
  or admission. Reviewers should still be pointed at that history.

## Deferred follow-ups

- `RETRY_PROVISIONING_BASE_MS = 150_000` shipped as the operator-tunable
  default. Any retune should use observed fleet load rather than reopen this
  RFC's implementation outcome.
- Should `local` workloads get a shorter cadence? There is no remote API to
  throttle, and a multi-minute cooldown on local iteration is pure waste. It is
  one line but it is the first per-cloud special case, so it is called out rather
  than assumed.
- Should other providers follow Lambda with gateway-local status-aware retry, or
  should a later RFC add a shared `RateLimited` diagnosis and adaptive brake?
  Lambda's HTTP 429 result does not resolve the GCP and Vast classification
  defects above.
- `Retry-After` remains deferred because the only observed Lambda value was
  zero, which does not provide a safe recovery interval.

## Tracking

Each change is independently shippable and separately revertible.

- Change 1, reshape the provisioning curve — shipped.
- Change 2, Lambda launch-gate rejection — original pacing fix
  superseded by the Lambda amendment below, with deadline and ambiguous-launch
  safety completed by the implementation that followed.
- Change 3, verified capacity outranks least-tried — shipped.

The original Change 1 dependency on Change 2 applied only to fleets sharing one
Lambda credential. The Lambda amendment retired the gate in favor of reactive retry, and the
follow-up implementation bounded that retry owner to an absolute provisioning deadline.
Implementation completed on 2026-08-31.

## Decision

Accepted 2026-08-25. Production data from a hosted API carrying Lambda traffic
confirms the motivating case: 360 of 362 Lambda launch errors were
`insufficient-capacity`, across 47 workloads and roughly six weeks, with
individual workloads retrying fifteen to twenty-five times before landing. At
the current curve that is hours per workload, which is the cost this proposes
to cut.

At acceptance, no throttle event had been observed — not one rate-limit response
and not one refusal from our own launch gate. The amendment below records the
later measurements that superseded that conclusion and supplied the missing
capacity-latency evidence.

### 2026-08-27 Lambda amendment

Live probes validated the capacity signal behind Change 3 in both directions.
`GET /instance-types` listed `us-east-1`; a launch there returned HTTP 200 in
4.8 seconds and the instance terminated cleanly. It omitted `us-west-2`; the
same launch returned HTTP 400 `insufficient-capacity`. This establishes that
`regions_with_capacity_available` describes current capacity rather than mere
entitlement. One launch in each class does not estimate a false-positive rate,
but the premise behind Change 3 is no longer untested.

The capacity watch also observed `gpu_1x_h100_sxm5` in `us-south-3` move from
unavailable to available in 7m06s. That supplies the capacity-latency measurement
requested by the original Decision and explains why retrying on roughly the same
period can repeatedly miss short availability windows.

The documented one-launch-per-12-seconds interval also did not describe observed
burst behavior. Six concurrent valid launch requests reached the allocator, while
later traffic encountered fast, non-JSON HTTP 429 responses at Lambda's edge.
An early no-gate nuke run then produced 176 edge 429s and 30 durable retries, but
its three launch attempts retried immediately. It demonstrated that hot-looping
is unsafe, not that proactive pacing is necessary.

Independent 50-workload nuke runs provided the fair comparison:

| policy                  | completed | durable retry transitions | time-to-completed min/median/max |
| ----------------------- | --------- | ------------------------- | -------------------------------- |
| fixed proactive pacing  | 50/50     | 6                         | 242s / 661s / 1290s              |
| final reactive HTTP 429 | 50/50     | 5 across 4 workloads      | 293s / 422s / 987s               |

These are live fleet runs rather than a deterministic benchmark, but pacing did
not improve completion reliability and the reactive run had a materially better
median and maximum. The shared gates therefore did not earn their queueing,
state, or failure modes.

This amendment supersedes Change 2. Lambda now has no proactive request gate. `api()`
retries every HTTP 429, regardless of response body or provider code, with 12
total attempts, a 10-second exponential base, a 100-second cap, and jitter over
the upper half of each window. The attempt count, base, and cap are operator-
tunable. This is the single retry owner for throttling; an exhausted launch 429
returns directly because `newVM()` has no second launch retry owner.

### 2026-08-31 implementation completion

This completion bounded each Lambda API request and all of its HTTP 429 retries to one
absolute deadline. The retry loop remains Lambda-owned because replay safety,
provider-error preservation, and uncertain mutation reconciliation are part of
the provider contract. A proposed cross-provider bounded-retry helper was not
adopted; it obscured those distinctions without supplying a genuinely shared
policy.

Every Lambda API call declares whether its operation is idempotent or may retry
only after an explicit rejection. Launch uses the latter: completed HTTP 429
responses can retry, while a transport failure, 5xx, or interrupted response
has an unknown outcome. `newVM()` observes the durable workload tag and adopts
a matching instance; if none is yet visible, it preserves the attempt for later
reconciliation instead of immediately re-sending or sweeping the launch.

HTTP status owns retryability while the provider code owns the final diagnosis.
A structured `global/quota-exceeded` 429 consumes the same local retry budget;
on exhaustion it becomes `QuotaExhaustedAccount`, presented to the user as
Lambda's account instance-launch limit. An unstructured edge 429 becomes
`TemporaryProviderFailure`. Both retry the same target because changing regions
cannot escape a credential-level condition.

`Retry-After` support remains deferred. Measurements did not yield a useful
recovery interval — one edge response reported `Retry-After: 0` — so treating
that header as authoritative would have recreated the immediate retry loop. The
remaining design gap is cross-cloud throttle diagnosis, not Lambda pacing or the
meaning of its capacity signal.
