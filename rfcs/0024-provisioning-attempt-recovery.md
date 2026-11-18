# RFC 0024: Shared provisioning-attempt recovery

> Status: Proposed
> Date: 2026-08-25
> Author: Claude draft
> Updated: 2026-08-31 after RFC 0022's Lambda amendment and its implementation
> completion changed Lambda retry and reconciliation behavior without
> implementing this capability

## Summary

Three gateways independently reconstruct the same answer to one question: _did
this provisioning attempt already create a resource before we lost the
response?_ AWS and Vast implement the same six-rule policy near-verbatim. Lambda
implements a different one, and the difference is a defect rather than a
considered choice — it guesses among candidates where the other two refuse to.

This proposes a branded `ProvisioningAttemptRecovery` capability that owns the
policy, with each provider supplying only the lookup. It also gives Lambda the
attempt-scoped marker it currently lacks, which is what forces its deviation.

## Current state after RFC 0022

RFC 0022's implementation completion reduced Lambda's immediate duplicate-launch risk without implementing
this proposal. A dispatched launch whose response is interrupted, fails in
transport, or returns 5xx is now explicitly outcome-unknown and is reconciled
through the durable workload tag rather than immediately re-sent. That
reconciliation has one absolute settle deadline and preserves indeterminate
attempts for a later pass.

Lambda still has no attempt-scoped tag, still selects one region/type-matching
instance from a workload-scoped result, and AWS and Vast still own separate
copies of the six-rule policy. The capability-migration and attempt-tag work therefore remain open and
this RFC remains Proposed.

## Context

Provisioning is not idempotent by default. A launch the provider accepted but
whose response we lost must not be blindly re-issued, or the workload
double-launches and bills two machines. Every gateway solves this, and the
provider decides how hard it is:

| Gateway    | Attempt marker                                                        | Recovery lookup                                                              |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| AWS        | `ClientToken: vmId` (`aws.ts:970`) — EC2 dedupes server-side          | `findRecoverableInstanceByClientToken`, `aws.ts:738-773`                     |
| GCP        | `name: vmId` + `requestId` (`gcp.ts:1047, 1155`)                      | provider is idempotent; none needed                                          |
| Azure      | the VM name _is_ the key (`azure.ts:3182`)                            | provider is idempotent; none needed                                          |
| Vast       | `ATTEMPT_LABEL_PREFIX + attemptVmId` in the label (`vast.ts:386-399`) | `findInterruptedProvisioningInstance`, `vast.ts:986-1014`                    |
| **Lambda** | tags identify the Workload, user, and owning API — **no attempt id**  | `selectAdoptableInstance` + `pollForAdoptableInstance`, `lambda.ts:960-1027` |

### AWS and Vast already agree on the policy

Both enforce the same six rules, and the parallel error strings — "Could not
inspect {EC2,Vast} provisioning attempt {vmId}" and "Could not select one
{EC2,Vast} resource for provisioning attempt {vmId}" — show the second was
copied from the first:

1. a failed read raises `ResourceStateIndeterminateError` — never "nothing found"
2. filter to live / recoverable states
3. match on the attempt id
4. **more than one match raises `ResourceStateIndeterminateError`** — refuse to guess
5. exactly zero returns `null`, so it is safe to launch
6. exactly one is adopted

### Lambda inverts rule four

Lacking an attempt-scoped marker, Lambda cannot match on attempt id. Its
workload-scoped tag can return several instances, so `selectAdoptableInstance`
(`lambda.ts:960-972`) _picks a winner_: prefer `active` over `booting`, filtered
by region and instance type. Adopting the wrong one lets the keep-one sweep
terminate the healthy launch, and records the VM under a region and type that
are also how it is priced.

The keep-one sweep remains the compensating safety net. RFC 0022's implementation completion now prevents an
outcome-unknown launch from being immediately re-sent, but its workload-level
lookup cannot prove which durable VM attempt produced a matching instance.
Cost-safety in this area is not theoretical:
the 2026-08-21 VM teardown postmortem records 26m25s of post-terminal
billing on a $16.36/hr node.

### Nothing enforces the policy on a new provider

`rawAdoptProvisioningAttempt` is an optional hook (`cloud.ts:1152-1155`) that
`createCloudCompute` wraps with a `resolveGatewayVM` call and nothing else
(`cloud.ts:1280-1286`). A provider can implement it any way it likes. That is
precisely the shape RFC 0007 exists to prevent — `:15`, "shared cloud code
should own lifecycle policy so new clouds cannot compile while bypassing the
same guarantees" — and Lambda is the counterexample already in the tree.

RFC 0007 names Lambda as the first migration target for further policy
extraction (`:478`, `:513-514`). Hyperbolic is the next provider and is an
SSH-VM provider likely without idempotency, so landing this first is the
difference between it inheriting the property and it becoming a fourth
hand-rolled variant.

## Goals

- One implementation of the six rules, exercised by every provider that recovers
  an attempt.
- Remove Lambda's winner-picking: an ambiguous attempt state must be
  indeterminate everywhere, not resolved by heuristic on one cloud.
- Make the guarantee structural — a new provider supplies a lookup and inherits
  the policy, rather than reimplementing it.
- No behavior change for GCP and Azure, which are provider-idempotent and do not
  implement the hook.

## Non-goals

- **Unifying how the attempt id is stamped.** The three substrates differ
  genuinely: a first-class field the provider honours, one opaque delimited
  label, and a key/value tag list. Forcing a common stamping model is the
  lowest-common-denominator abstraction RFC 0007 rejects at `:565`.
- Removing Lambda's sweeps. The keep-one sweep remains the declared net for
  eventual-consistency and cleanup windows, which tagging does not close.
- Changing retry cadence or Lambda's HTTP 429 policy. RFC 0022 and its amendments
  own those decisions; Lambda no longer has proactive request gates.
- Backfilling attempt tags onto instances that already exist — Lambda accepts
  tags only at launch.

## Proposal

### The capability

A branded factory in `cloud.ts`, alongside the existing capability brands:

```ts
export interface ProvisioningAttemptRecoveryOps<TResource> {
  findAttemptResources(
    attempt: ProvisioningAttemptIdentity,
  ): Promise<TResource[]>;
  isRecoverable(resource: TResource): boolean;
  adopt(resource: TResource): Promise<GatewayVM>;
  describeProvider: string; // "EC2" | "Vast" | "Lambda"
  settleWindowMs?: number; // see below
}

export function createProvisioningAttemptRecovery<TResource>(
  ops: ProvisioningAttemptRecoveryOps<TResource>,
): ProvisioningAttemptRecovery;
```

The factory owns rules 1–6 and the error-message shape. `createCloudCompute`
wires `adoptProvisioningAttempt` from it, so the existing optional
`rawAdoptProvisioningAttempt` becomes the escape hatch of last resort rather
than the normal path.

### Lambda gets an attempt tag

Add `anycloud:attempt-id = vmId` to `lambdaInstanceTags` (`lambda.ts:280-285`),
mirroring Vast's `ATTEMPT_LABEL_PREFIX`. `selectAdoptableInstance`'s
winner-picking then deletes: the region and type filters exist only because a
workload-scoped tag can return the wrong instance, and an attempt id cannot.

### The one genuine addition: `settleWindowMs`

AWS's token-filtered `DescribeInstances` and Vast's list answer in a single
read. Lambda's `GET /instances` is eventually consistent, so a zero-match result
is only trustworthy after waiting. The shared policy therefore retries the
lookup until `settleWindowMs` elapses before returning `null`; a match short-
circuits immediately. Lambda passes one launch interval, which is what
`pollForAdoptableInstance` already uses (`lambda.ts:983-1027`). AWS and Vast
omit it.

**Verified against the live OpenAPI spec (2026-08-25): `GET /instances` filters
only by `cluster_id`.** There is no tag filter, so Lambda's lookup stays a full
account list per poll. RFC 0022's Lambda amendment removed the general request gate; each list is now
subject to Lambda's status-aware HTTP 429 handling and the absolute settle
deadline from its implementation completion. The account-wide read cost remains and must be stated in the
capability's docs so nobody assumes Lambda's lookup is as cheap as AWS's.

## Alternatives considered

**Leave it alone and fix only Lambda's inversion.** Cheaper, and it fixes the
live defect. Rejected because it leaves three hand-rolled copies of a policy
whose whole value is being uniform, and leaves the next provider free to invent
a fourth. The defect is the symptom; the missing contract is the cause.

**Abstract the tagging instead of the policy.** Considered and rejected: see
Non-goals. The tagging is where the providers genuinely differ, and the policy
is where they genuinely agree — abstracting the wrong one of the two produces an
interface nobody can implement cleanly.

**Give Lambda a per-attempt instance _name_ rather than a tag.** The name
already encodes `ac|userId|timestamp|random` and is parsed by the orphan sweeper
for billing `createdAt`. Overloading it with a third meaning would couple the
sweeper to the recovery path; tags are the field Lambda added for exactly this.

**Make the capability required rather than optional.** Attractive for the
"cannot forget" property, but GCP and Azure are provider-idempotent and have
nothing to recover, so a required hook would force two empty implementations —
the dead-stub shape `ADDING_PROVIDERS.md:20-35` records as a past mistake.

## Risks & caveats

- **This touches the duplicate-billing path on three gateways at once.** The
  failure mode is expensive and quiet. Characterize existing behavior with tests
  before changing anything underneath.
- **Lambda's eventual-consistency window remains.** Tagging makes the lookup
  exact; it does not make `GET /instances` immediately consistent. The
  deadline-bounded settle poll and keep-one sweep stay.
- **Existing Lambda instances carry no attempt tag.** Recovery of an attempt that
  started before this ships finds nothing and launches again — the same outcome
  as today's failure mode, not a new one, but it means the fix is not
  retroactive.
- **Tree-wide LOC is roughly break-even.** AWS sheds ~20 lines of policy, Vast
  ~18, Lambda sheds the winner-picking, and the factory costs that back. The
  return is one policy instead of three and a fixed inversion, not a smaller
  codebase.
- **`settleWindowMs` is a one-provider parameter today.** If a second provider
  ever needs a different timing mode, revisit before adding a third.

## Open questions

- Should `isRecoverable` be a predicate the provider supplies, or should the
  shared layer take a provider-neutral state enum? A predicate is simpler and
  matches how `isVastContractReleased` / EC2 state filters already work, but it
  leaves rule 2 provider-defined.
- Does Vast's existing `ApiOwnershipConflictError` path interact with rule 4?
  Both raise on ambiguity; they should probably not both fire for one attempt.
- Should the shared capability accept Lambda's existing absolute settle
  deadline, or own the 12-second window and polling cadence itself? RFC 0022's
  implementation completion made that deadline independent of request pacing.

## Tracking

- Capability + AWS and Vast migration — open
- Lambda attempt tag + winner-picking removal — open

RFC 0022's implementation completion is a prerequisite-hardening outcome, not completion of either item: it
made uncertain launches safe to defer but retained workload-scoped matching
and provider-private recovery policy.

## Decision

_(Filled when accepted, rejected, or superseded.)_
