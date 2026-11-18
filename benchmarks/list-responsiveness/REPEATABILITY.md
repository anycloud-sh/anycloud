# List fixture-validation and repeatability study

Status: v2 complete; calibration passes, comparison
inconclusive, no promotion. See the [measured results](REPEATABILITY-RESULTS.md)
and [artifact receipt](repeatability-receipt.json).
This is a separate follow-up to the completed [aggregation study](AGGREGATION-RESULTS.md),
authorized after its no-promotion decision. That study, its frozen source and
original raw archive remain unchanged. This protocol does not extend its sample.
The [v1 attempt lost its runner to disk exhaustion](REPEATABILITY-FAILURE.md)
and has no usable measurement evidence. Version 2 corrects that demonstrated
harness defect under the approved correction/regression/fresh-evidence rule.
It starts with new preparation and a complete fresh sample; it does not resume v1.

## Question and bounded change

The previous aggregation calibration ran the same application for both labels.
None of its twelve timing intervals calibrated. Before HTTP, the runner computed
the full fixture digest inside each API process, visiting 2,317,645 rows across
the fixture tables. Those runs began measurement with 254–310 MiB of V8 heap in
use. That is a lead, not proof that hashing caused the variation: application
imports and initialization also allocate memory. A subsequent local host check
found competing CPU work and approximately 6.3 GiB of swap in use; that snapshot
cannot establish historical host conditions.

Test one harness correction: validate a closed synthetic seed in its preparation
process, bind its full logical digest to a file size and SHA-256, and verify each
fresh copy's bytes before the API opens it. Repeat the full logical digest and
foreign-key/integrity checks after both work and health have drained. Reject
missing proofs, changed copies, symlinks, journal/WAL/SHM sidecars and changed
logical data. No fixture validation is omitted. Hash file bytes through a fixed
buffer, without constructing the fixture's rows in the API heap before HTTP.

Use the same actual application and ordinary SQL instrumentation in both arms.
Preserve authentication, ownership, conversion, serialization, business-clock
freezing, real timers, provider/network/subprocess guards, request journals and
health sampling. No lifecycle services start. Neither public queries nor
application source are rewritten during measurement.

## Frozen protocol

The versioned manifest is
[`repeatability-policy.mjs`](../../test/helpers/list-aggregation/repeatability-policy.mjs).
Its identifier is `list-fixture-preflight-v2`.
Preparation copies it and all measured helper/runner sources into each fresh
ignored output before execution. Runtime, source, build, lockfile, migrations,
native module and fixture hashes are pinned and checked. Each API child records
its actual native binary hash, including unprofiled trials.

Application source remains `913f8e992adbefd8d236d59fcec89f99dd788503` (0.1.64).
Use Node 22.14.0, better-sqlite3 11.10.0 and SQLite 3.49.2. The one application
candidate is exactly the already-observed aggregation patch, SHA-256
`36949d4347621af7fc7c2b4a899a6b44019a1cbbdccd0a3424b8abb3ff302f50`.
Build both applications normally before measuring. Product source in this
evidence branch remains unchanged. No B predicate, index, dependency upgrade,
migration or API/type change is added.

Use one fresh GitHub-hosted Ubuntu 24.04 x64 measurement job, sequentially, after
a separate job passes `yarn verify` and the unchanged six-second long-history
integration gate. Assert GitHub's documented
[`RUNNER_ENVIRONMENT`](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
value is `github-hosted`. Retain host CPU, memory, pressure and VM counters at 1 Hz.
CPU, memory, GC and event-loop observations remain diagnostic; no discretionary
timing exclusions or extra thresholds follow them. Make no cold OS cache claim.

Freshly seed current migrations with valid container specs. The full mixed
fixture has 18,664 workloads, 285,564 VMs and 1,994,751 events. Preserve the
previous databases and identify these new fixtures independently; fresh encrypted
fields can change their logical hashes. Every trial uses an identical fresh
copy within this study, verified against the same preparation receipt.

Before preparation, require 6 GiB of free disk capacity. Before each trial,
require four times the largest fixture's bytes plus a 2 GiB reporting reserve.
The frozen maximum fixture size is 1 GiB. After the child exits and complete
HTTP/logical validation passes, require every full mixed/user copy to match the
seed's exact size and hash, then atomically share its closed path's storage with
that retained seed. Every subsequent live trial uses a new independent copy.
Closed raw paths and contents remain available until successful artifact upload.
Retain the six small correctness databases privately, at most 16 MiB each, and
archive them individually: hosted authentication configures access-policy rows
without changing the workload fixture. Reject unexpected full-copy changes or
insufficient headroom; preserve the failed private copy and partial evidence.
Record each disk admission and storage receipt for independent verification.

Execute once, in this order:

1. Check all existing complete HTTP correctness cases in both user and hosted/API
   scopes for original validation, file-proof validation, and the aggregation
   candidate with file-proof validation. Compare full responses and retain the
   current Deployment-ID and Worker/Cluster regressions.
2. Audit setup on the full mixed/user fixture: original validation, file proof,
   then original validation again. Each uses the unchanged baseline, two
   warmups and three observations for ordinary/terminatable limit 1000, daily
   cost and cleaned-terminal status. Record memory at import, initialization,
   validation and application readiness, plus separate diagnostic GC/CPU traces.
   These timings cannot qualify a change. Complete response equality and the
   before-open/after-drain validation receipts must pass.
3. Run exactly six alternating A/A pairs with file-proof validation. Each trial
   records a separate first ordinary request, then ten warmups and fifty measured
   observations for each of the same four endpoints. Both labels use the same
   stock baseline build. No profiles run during this comparison.
4. Run six alternating A/B pairs only if every A/A gate passes. Both builds use
   identical file-proof validation, fixture copies, scheduling and instrumentation.
   A/A failure prevents every A/B timing request. Never replace a failed trial,
   add repetitions after inspection or relax a threshold.

Keep independent 10 Hz health probes, one-second health deadlines, 15-second
work deadlines and a 20-second bounded drain. Complete request bodies determine
latency; late successes remain misses. All matrix work must complete on time
and all observed handlers must drain. Preserve every offered request and health
observation, including caught isolation/accounting failures.

The timing decision is unchanged: compute each metric inside its trial, then
`exp(mean(log(B_i / A_i)))`. Enumerate all 46,656 complete-pair bootstrap draws
jointly across metrics, with pointwise two-sided 95% nearest-rank intervals.
All twelve A/A SQL-mean/HTTP-p50/HTTP-p95 intervals must fit [0.95, 1.05]. For
A/B, both list SQL upper bounds must be at most 0.90 and all other matrix upper
bounds at most 1.05. Arm medians and paired signs are descriptive. Health remains
diagnostic for this discovery matrix, as in the preceding aggregation protocol;
full load/phase/recovery qualification retains the approved tail and rate gates.

Execution has a 30-minute total budget, including setup trials, calibration,
conditional comparison, validation, drainage and analysis. Each child has at
most three minutes and never more than the remaining budget. Normal builds,
seeding and required repository checks are preparation. The measurement job
has 60 minutes total and reserves its last three minutes for artifacts; elapsed
checkout/build/setup time reduces the available execution budget. The checks
job has 25 minutes and the independent download audit 10 minutes. This manual
case remains within the approved 120-minute per-case ceiling. Billing defaults,
automatic workloads, backend eligibility and existing maximum parallelism remain
unchanged. Only the explicit manual study uses a fresh hosted measurement VM.

## Run and artifacts

From clean, separate application checkouts at the exact source pin, with the
pinned dependencies installed and the baseline built:

```sh
node experiments/list-responsiveness/repeatability.mjs prepare \
  --baseline /absolute/baseline --candidate /absolute/candidate \
  --output "$PWD/.context/list-repeatability-NEW"
```

`prepare` applies the exact retained candidate once, builds it, seeds fresh
databases and freezes the manifest, sources and fingerprints. `run` requires
the fresh hosted Linux job and its pre-checkout budget origin. Dispatch the
manual `API Performance` workflow at the frozen harness commit with scenario
`list-repeatability`; it runs checks, preparation, measurement and independent
artifact validation in the required order.

```sh
node experiments/list-responsiveness/repeatability.mjs run \
  --output "$PWD/.context/list-repeatability-NEW"
node experiments/list-responsiveness/repeatability.mjs retain \
  --output "$PWD/.context/list-repeatability-NEW"
node experiments/list-responsiveness/repeatability.mjs verify \
  --output "$PWD/.context/list-repeatability-NEW/evidence"
```

Keep raw synthetic databases under `working/` and the complete upload inventory
under `evidence/`. Upload the entire inventory, including JSONL request/server/
health/setup traces, compressed complete responses, gzip seed databases, SQL and
plans, source/runtime/harness fingerprints, verification logs and failures.
Include compressed complete correctness databases and the closed-copy storage
receipts that bind all shared full copies to their retained seed bytes.
Retain partial database copies on failure. Do not delete synthetic output until
upload succeeds. Retain CI artifacts for seven days and download them locally.

Independently validate file presence, hashes, trace counts, gzip decoding,
responses, exact expected trials, actual chronological order and the recomputed
paired decision after download. The archived source can run its verifier without
an application build or installed dependencies. Incomplete or corrupt evidence
fails CI; a complete timing rejection or inconclusive result is informational.

## Promotion and deletion

This discovery cannot qualify the product. A passing result permits full
six-profile/both-scope matrix and mixed-load/recovery qualification under the
existing fixed policy. The candidate's existing alias-based query-plan guard
also needs a precise regression before any implementation can qualify. Only
provisional success permits a separate draft implementation PR; its actual
proposed merge needs final qualification before becoming ready for review.

Failed or inconclusive A/A stops this study with no A/B timing or implementation
PR. Failed or inconclusive A/B records no promotion. Keep the immutable decision
and raw evidence; remove the temporary manual job and unused experiment after
review. A demonstrated harness defect requires a documented correction,
regression and complete fresh evidence under a separately frozen protocol,
as required by the approved defect-recovery rule; never replace a trial here. No merge,
release or deployment is part of this work.
