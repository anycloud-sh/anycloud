# Bounded status-control diagnosis

Status: complete; [no promotion](STATUS-CONTROL-RESULTS.md).
This is the approved follow-up to the completed [repeatability study](REPEATABILITY-RESULTS.md).
It does not extend, regrade or replace that study. B stays parked and C stays
rejected. Promotion remains false throughout this diagnostic protocol.

## Saved-evidence audit

The retained v2 archive still has SHA-256
`866549ec0842d502c85462646b11fcefc15aba8e252c1dc72e7b10a2d25e9c01`;
its inventory is `99a8a685b07b42ad74ed2944be906b431648f04a9a929017ccc33cc8e854ff93`.
The archived standalone verifier passes. The bounded read-only audit inspected
all 1,200 measured status requests across the six A/A and six A/B pairs.
Every request has the same 121,589-byte public response, five SQL calls and the
same four distinct SQL statements/plans. Request accounting is complete.
Nearby one-second host samples show no swap-in, swap-out or major faults and
at least 6,122 MiB of available memory. Those samples cannot resolve individual
eight-millisecond requests.

The p95 is the 48th sorted observation in each fifty-request trial. The two
unfavorable A/B pairs do not show one consistent source of delay: in pair three,
the candidate's p95 request spent less time inside the server than baseline's
p95 request, while pair four included more server work. Comparing these different
requests is descriptive, not a causal decomposition. One HTTP-minus-server
duration is negative because the server's finish callback can run after the
client receives the body; that residual is preserved rather than clamped or
mislabelled as network time.

Unprofiled API traces lack a retained clock origin and detailed GC, transport,
response-preparation and observer-operation timing. Every status phase follows
ordinary list, terminatable list and daily cost. The audit therefore does not
establish a harness defect or an application regression. More attribution is
needed. The complete per-request CSV, p95 request IDs, host context, audit source
and limitations are retained in `.context/list-status-control-20260917T150719Z/`.

## Frozen diagnostic protocol

The versioned manifest is
[`status-control-policy.mjs`](../../test/helpers/list-aggregation/status-control-policy.mjs):
`list-status-control-v1`. Application source remains
`913f8e992adbefd8d236d59fcec89f99dd788503`, with the exact retained aggregation
patch `36949d4347621af7fc7c2b4a899a6b44019a1cbbdccd0a3424b8abb3ff302f50`.
Node is 22.14.0, better-sqlite3 11.10.0 and SQLite 3.49.2. Both applications are
built normally; no SQL is rewritten during requests. No index, migration,
dependency or public API change is admitted.

Prepare fresh current-schema fixtures containing 18,664 Workloads, 285,564 VMs
and 1,994,751 events. All live trials receive independent copies of the same
closed seed. Preserve file-proof validation before opening, full logical and
integrity checks after health drainage, disk admission and closed-copy storage
verification from v2. Freeze the manifest, harness, builds, runtime/native and
fixture fingerprints before the first diagnostic request.

Execute exactly four trials, sequentially, on one fresh GitHub-hosted Ubuntu
24.04 x64 VM after a fixed thirty-second settle:

| Order | Build                 | Requests                                                               |
| ----- | --------------------- | ---------------------------------------------------------------------- |
| 1     | Baseline              | Original ordinary-1000, terminatable-1000, daily-cost, status sequence |
| 2     | Aggregation candidate | Same original sequence                                                 |
| 3     | Aggregation candidate | Status alone                                                           |
| 4     | Baseline              | Status alone                                                           |

Each endpoint receives ten warmups and fifty measured diagnostic observations.
The sequence trials retain their separate first ordinary request. Each isolated
trial starts with a separate first status request and performs no list or cost
warmup. Expected totals are 604 HTTP requests and 500 diagnostic samples. There
are no calibration pairs, replacement trials or post-inspection extensions.

Preserve real HTTP, authentication, ownership, conversion, serialization and
complete response equality, including status across both scenarios. Business
time is frozen and timers remain real. The app exposes only the existing loopback
measurement endpoints and starts no lifecycle services. Provider operations,
outbound networking and child-created subprocesses remain forbidden; caught
guard violations fail the run. Health stays at 10 Hz with a one-second deadline;
work retains a fifteen-second deadline and twenty-second bounded drain.

Capture CPU profiles and GC/process/transport traces for API, driver and parent.
Retain real clock origins and request IDs. Observe synchronous SQL spans, the
public oRPC response serializer, Node response completion writes, server/client
journal writes, body hash/copy and initial compressed snapshots. The serializer
span includes recursive output conversion; wire JSON stringification is visible
in the sampled CPU profile rather than that span. Record diagnostic writer CPU
and wall cost separately. Spans can overlap and diagnostic writes themselves
perturb execution. Profiled timings cannot pass or fail a qualification timing
gate. Findings that exist only under profiling do not establish a defect in the
unprofiled v2 harness.

Execution is capped at twenty minutes including settling, all four trials,
validation, drainage and analysis. Each child has at most three minutes or the
remaining execution budget. The shared sixty-minute job reserves its final three
minutes for publication; elapsed setup reduces the available execution budget.
The existing twenty-five-minute checks and ten-minute download-audit jobs remain.
Preparation builds, seeding and functional checks are separate from diagnostic
observations. An incomplete run retains partial evidence and fails CI.

## Run and verification

The shared entrypoint adds an explicit study selection; its default repeatability
protocol and the billing workflow defaults remain available:

```sh
node experiments/list-responsiveness/repeatability.mjs prepare \
  --baseline /absolute/baseline --candidate /absolute/candidate \
  --output "$PWD/.context/list-status-control-NEW" --study status-control
node experiments/list-responsiveness/repeatability.mjs run \
  --output "$PWD/.context/list-status-control-NEW" --study status-control
node experiments/list-responsiveness/repeatability.mjs retain \
  --output "$PWD/.context/list-status-control-NEW" --study status-control
node experiments/list-responsiveness/repeatability.mjs verify \
  --output "$PWD/.context/list-status-control-NEW/evidence" --study status-control
```

Dispatch the manual API Performance scenario `list-status-control` at the frozen
harness commit. It uses the existing shared check, fresh-VM and readback jobs.
The workflow performs `yarn verify` and the unchanged six-second
`yarn test:long-history-responsiveness` gate before diagnostics. Focused checks
cover isolated request selection, unchanged exception propagation, fixed order,
missing transport attribution and missing profiles. Functional preparation must
exercise the actual HTTP paths and both built applications before the four-trial
budget is spent.

Local preparation passed 73 focused tests and 184 HTTP requests across both
builds and ownership scopes, including all twelve CPU profiles for the small
sequence/isolated checks. The updated default verifier reproduces v2's unchanged
decision. Two failed functional preparations are retained: an Express JSON hook
missed the actual oRPC serializer, and the original both-list-shapes assertion
prevented a status-only run. Regression coverage now observes the public oRPC
serializer and requires zero list SQL in that isolated case while retaining both
shapes for the original workload. These preparation fixes establish no defect in
the unprofiled v2 study and supply no qualification samples. A storage test's
local timeout is also retained; its unchanged isolated rerun passed.

Upload the complete seven-day inventory, including JSONL request/server/health/
diagnostic traces, JSON CPU profiles, compressed complete responses/databases,
SQL/plans, fixtures, source/runtime/build fingerprints and failures. Independently
verify hashes, decoding, response equality, exact request/trial order and counts,
all three profiles and required per-request attribution after download. Synthetic
output is removed only after successful upload. Retain a local archive as well.

## Decisions and deletion

A completed diagnostic run has no promotion decision. Its result must identify
an actionable mechanism present in the unprofiled harness before one shared
correction is permitted. That correction needs a regression that fails before
the fix and passes afterward. Do not remove genuine application/GC interactions,
change the control to an isolated workload for qualification, or attribute a
four-trial timing difference to the candidate without a demonstrated mechanism.

If the four trials reveal no actionable cause, or establish an application
regression, publish the evidence and stop this follow-up. A justified correction
permits a separately versioned, frozen thirty-minute discovery study using the
original four-endpoint sequence, six A/A pairs and conditional six A/B pairs.
Keep the joint paired-block estimator, confidence intervals, 10% benefit and 5%
protection bounds, complete correctness and drainage. Another inconclusive result
stops; no repetitions or thresholds change after inspection.

Only a complete discovery pass permits the precise bounded-scan regression and
full profile/scope/load/recovery qualification. Provisional success permits an
implementation draft; its actual proposed merge must qualify before readiness.
Keep the immutable decision and raw evidence, then remove this temporary manual
scenario and unused experiment after review. Merge, release and deployment
remain outside scope.
