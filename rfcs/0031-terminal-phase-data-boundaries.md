# RFC 0031: Terminal-phase data boundaries

> Status: Accepted
> Ratified as implemented. Open follow-ups: a spike-gated machine
> release-window record, and extending delayed-release alerting to
> cluster-owned machines.
> Date: 2026-09-01
> Author: Luis Fernando De Pombo

## Summary

Ratify the data model of the terminal phase — which facts live as row columns,
which in the resource ledger, and which in the event log — and apply it to
record a durable teardown record. Three rules govern:

1. **Each row records its own episode.** Commit stamps the machine schedules
   on (`completed_at`, `cleaned_at`) live as columns on the row they fence;
   ledgers hold things that can leak or bill (`vms`); the event log holds
   append-only narration of actions.
2. **Queryable dimensions get typed columns; forensic blobs get JSON.**
3. **Version is a function of time, not a per-row stamp.** Which API version
   did anything is answered by joining a timestamp against a boot ledger,
   never by copying version strings onto rows.

Applying them completes the teardown record with two small schema additions
and a column removal — no new tables beyond a boot ledger, no new event
kinds, no FSM changes.

## Context / problem

A terminated 4xH100 node kept billing for 26m25s after the CLI printed
`terminated` (the 2026-08-21 VM teardown postmortem), and
attributing the regression to an API version required joining
`_migrations.applied_at` against `git tag --contains`, because nothing records
which API version was running when. The historical `deployments.version` column
(removed before the Workload rename) looks like the
answer and is not — it is the submitting CLI's version, and bucketing by it
produced a materially wrong first pass of that investigation. Cleanup attempts
write nothing, and the provider's answers during teardown are observed by the
confirmation poll and then discarded.

Underneath sits a structural fact: the terminal phase is two lifecycles
sharing one vocabulary. The workload outcome is noisy to determine (spot
exits, infrastructure kills misread as workload exits), so determination gets
confirmation windows and a `Finalizing` buffer, and the committed outcome is
absorbing — `publishTerminalOutcome` and `requestTermination` both refuse
terminal-to-terminal writes, a guard earned by historic completed↔terminated
flapping. Resource release is the opposite: a retryable, monotonic process
fenced by `cleaned_at` and the `vms` ledger. Because none of this was
ratified, a scheduling premise living in a code comment became
load-bearing, bent the teardown record's original design constraint, and
produced an entire PR built around mutating history. Earlier changes removed
the coupling: cleanup pacing and reconcile snapshot identity now derive from
`completed_at` alone, so nothing recorded during teardown can disturb retry
scheduling. An earlier change salvaged the `json_valid` repair.

## Proposal

1. **`api_versions` boot ledger.** A small table appended at API startup
   whenever the running version differs from the newest row. "Which version
   performed X" becomes a time-join for every timestamped fact — teardown
   included, but also every future investigation — replacing migration
   archaeology outright. One process writes per database, at boot, beside the
   migration runner.
2. **`workloads.cleanup_attempts INTEGER`.** Bumped as each cleanup pass
   begins; the final value commits in the same UPDATE that sets `cleaned_at`,
   so a cleaned workload can never lack its count. This column covers the
   episodes no `vms` row can see: the composite loop retrying storage, DNS,
   or networking after machines are gone, and workloads that never
   provisioned anything.
3. **Remove the historical `deployments.version` column.** The column recorded the submitting
   CLI's version and was never read back functionally; in the one
   investigation where it starred, it misled (it looks like the API's
   version and is not). Cloud-resource tags that previously carried it now
   carry the version of the software doing the setup (`config.currVersion`).
   The wire field remains for older CLIs and always reads null; a later
   release may mark it optional and eventually retire it. Historical values
   survive in pre-migration database snapshots.
4. **Per-machine release record: deferred, gated on a spike.**
   Release duration is already derivable per row (`removal_requested_at` →
   `ended_at`, workload- and cluster-owned alike). What the provider said
   mid-window needs a once-written summary — but the final answer alone is
   information-free (a row only closes when the provider confirms the machine
   gone), and provider classes observe differently (Lambda polls a status
   stream; Azure and GCP block on deletion), so the gateway confirmation loop
   is spiked before any schema lands.

Cluster-owned machines get every row-anchored fact for free — `vms` has been
owner-polymorphic since migration 0087 — while the workload columns describe
an episode only workloads have.

## Required invariants

1. Cleanup scheduling reads only `completed_at`; nothing appended to the
   event log can move a pending teardown's pacing or its reconcile identity.
   _Enforcement: regression tests in
   `workload-reconciler.spec.ts` (events landing mid-gap and mid-attempt)._
2. Terminal outcomes are absorbing: no code path rewrites a committed
   outcome, including during teardown.
   _Enforcement: transition guards in `workload-store.ts`; the
   exactly-once outcome contract in `notifications-monitor.spec.ts`; review
   for new writers._
3. Event rows are never repurposed as mutable state for an ongoing process.
   Enriching the owning transition's diagnostic metadata
   (`updateTerminalDiagnostics`) is chartered; tracking a process by patching
   history is not.
   _Enforcement: review — no mechanism yet; candidate for an RFC 0025-style
   check on event-write call sites._
4. A resource-owning attempt lives in the resource ledger. Provisioning
   attempts stay `vms` rows because a failed attempt may still own provider
   resources that recovery (RFC 0024) derives its delete set from.
   _Enforcement: review._
5. Version attribution flows only through `api_versions`; no new per-row
   version columns.
   _Enforcement: review._

## Alternatives considered

- **A `Terminating` FSM state** (dstack's shape): reopens the outcome races
  the absorbing commit closes, and misdescribes teardown after `Completed`
  and `Failed`. Declined permanently.
- **Mutating the terminal event with the record**: rewrites a
  timestamped record, holds only a final answer, and its timestamp-equality
  lookup must either wedge cleanup or drop the record on a miss.
- **A `cleanup_attempts` table**: a cleanup attempt owns no resource, so it
  has no ledger claim; diverges from the fold-in precedent that kept
  provisioning attempts inside `vms`.
- **Per-attempt `cleanup` events**: structurally sound — the log's charter
  already includes diagnostic metadata — but workload-scoped only, so
  useless for cluster capacity teardown, and not required by the teardown
  record's acceptance. Deferred, not rejected; whoever adds them must exclude the new
  state from the `latest_event_metadata` subqueries in `listWorkloads`, or
  `latestMessage` and nuke outcome classification silently break.
- **Per-row version stamps** (on `workloads` or `vms`): attribute to the
  version that finished, misattributing anything that spans an upgrade, and
  hold nothing for a still-stuck teardown — the only kind under
  investigation. The boot ledger answers by time instead.
- **Renaming `deployments.version` to `client_version`** instead of removing
  it: labeling-only, cost ~50 files of typed-fixture and raw-SQL churn, and
  the trip hazard survives on whichever surface keeps the old name. Removal
  eliminates the hazard on every surface for comparable mechanical cost.

## Risks & caveats

Live per-attempt logging and user-visible teardown narration stay out of
scope; the delayed-release alerts carry the operator signal, and a tracked
follow-up widens them past their current `workload_id IS NOT NULL`
restriction so cluster scale-downs page too. `terminated` continues to name
the decision rather than resource release; renaming the state is declined as
compatibility churn. `api_versions` assumes one API process per database,
which holds for local and hosted topologies today.

## Open questions

- Whether invariant 3 gets mechanical enforcement (an event-write chokepoint)
  or stays review-enforced.
- The exact shape of the window summary, owned by its spike.
