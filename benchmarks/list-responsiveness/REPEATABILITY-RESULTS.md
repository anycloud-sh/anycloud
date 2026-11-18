# List repeatability v2: measured gains, no promotion

Decision: **complete, inconclusive; no promotion**.

The fresh-VM run
passed all twelve identical-build A/A calibration gates. The retained aggregation
candidate then reduced ordinary/terminatable list SQL time by **40.5%/47.1%**
and HTTP p50 by **36.9%/41.7%**. Eleven of twelve A/B gates passed. The
terminal-status HTTP p95 interval crossed the fixed protection boundary, so
the complete comparison remains inconclusive. No extra trials, full qualification
or implementation PR followed. This result establishes a list-path improvement
in the measured case, while leaving the required control protection unresolved.

The candidate selects page IDs, computes VM totals using those IDs, then projects
the public Workload/spec fields. Both arms use actual normally built applications.
It is the exact retained aggregation patch, without the original B predicate or
C index. The earlier [structural red/green/reversal result](AGGREGATION-RESULTS.md),
its failed local calibration and the [invalid v1 attempt](REPEATABILITY-FAILURE.md)
remain separate, unchanged records.

## Fixed timing decision

The sample contains six alternating complete pairs for A/A and six for A/B.
Each trial has a separate first ordinary request, then ten warmups and fifty
observations for each endpoint. All comparisons are unprofiled. The only
thresholded timing estimator is the geometric mean of paired trial ratios;
pointwise 95% intervals enumerate all 46,656 joint complete-pair bootstrap draws
with nearest-rank quantiles. No requests, arms or metrics are independently
resampled. The [frozen policy](REPEATABILITY.md) and exact intervals are retained
in the [receipt](repeatability-receipt.json).

All twelve A/A SQL-mean/HTTP-p50/HTTP-p95 intervals fit [0.95, 1.05]. These A/B
ratios compare the aggregation candidate with the stock baseline:

| Endpoint                 | SQL mean ratio [95% interval] | HTTP p50 ratio [95% interval] | HTTP p95 ratio [95% interval] |
| ------------------------ | ----------------------------- | ----------------------------- | ----------------------------- |
| Ordinary, limit 1000     | 0.5949 [0.5879, 0.6013]       | 0.6313 [0.6245, 0.6383]       | 0.6333 [0.6223, 0.6422]       |
| Terminatable, limit 1000 | 0.5287 [0.5232, 0.5331]       | 0.5834 [0.5757, 0.5902]       | 0.5897 [0.5791, 0.5986]       |
| Daily cost               | 0.9848 [0.9628, 1.0083]       | 0.9839 [0.9630, 1.0059]       | 0.9910 [0.9659, 1.0174]       |
| Terminal status          | 0.9884 [0.9486, 1.0187]       | 0.9663 [0.8836, 1.0342]       | **0.9946 [0.9396, 1.0545]**   |

Both primary SQL upper bounds pass 0.90. Every other upper bound must be at
most 1.05. Terminal-status HTTP p95 has exact interval
**[0.9395513019, 1.0545436234]**, which crosses that boundary. This neither proves
a regression nor establishes the required protection. Its point estimate below
one and four favorable paired signs cannot override the interval rule.

For scale only, medians of the six trial HTTP p50 values were 343.5 → 216.6 ms
for ordinary lists and 193.2 → 113.0 ms for terminatable lists. Terminal-status
p95 arm medians were 8.205 → 8.157 ms. These descriptive arm medians are not the
decision estimator. First ordinary requests are recorded separately: 517.5–559.4 ms
for baseline and 389.4–417.5 ms for candidate, without a cold-cache claim.

## What the setup correction established

Original fixture validation traversed 2,317,645 logical rows inside each API
process before HTTP. The replacement verifies a prepared seed's size/SHA-256
before opening each independent copy, then repeats complete logical, foreign-key
and integrity checks after work and health drain. Every validation passed.

The three diagnostic setup trials used the same stock application and fixture:

| Setup                        | Application ready | Heap in use at readiness | RSS at readiness |
| ---------------------------- | ----------------- | ------------------------ | ---------------- |
| Original validation          | 13.408 s          | 317.0 MiB                | 476.6 MiB        |
| File proof                   | 4.741 s           | 271.7 MiB                | 435.2 MiB        |
| Original validation restored | 13.295 s          | 305.7 MiB                | 470.7 MiB        |

The reversal supports a setup allocation cost from in-process logical hashing.
Application imports already account for about 269–271 MiB of heap in these
processes. This study also changed hosts, and did not run an original-validation
A/A sample on the new host; it cannot attribute the previous calibration failure
solely to hashing, GC or host contention. The setup trials are diagnostic and do
not enter the A/B timing decision.

The storage correction also completed successfully. All 27 large trial copies
were independently opened and validated, then shared the seed's storage only
after child exit and exact byte verification. Six correctness copies stayed
private. The lowest sampled admission headroom was 7.445 GiB, above the 4.464 GiB
per-trial requirement. This is an admission sample, not a continuous disk minimum.
All database paths remained available until successful upload.

## Correctness, accounting and scope

Six correctness trials retained **225 equal complete HTTP results**, including
33 expected error responses. Original validation, file proof and candidate agree
in user and hosted/API scopes. Existing cost/IP-null, provider, credential,
resubmission, ownership, authorization, filtering, ordering, limit/headroom,
event-tie, current Deployment-ID, Worker/Cluster and no-decryption regressions
remain covered. Full-fixture responses also match across every executed trial.

The inventory contains **33 complete trials, 6,072 HTTP requests and 10,418
health offers**. A/A and A/B each contain 2,400 measured requests, plus first
requests and warmups. All work completed within its deadline with the expected
HTTP status. There were zero work timeouts, late responses, skips, unfinished
requests, health deadline misses, or observed handlers remaining after drainage.
Complete bodies, request/server correlation, guards and response hashes passed.
Ordinary/terminatable response sizes were identical at 1,217,517/913,616 bytes.

Timing covers the full mixed fixture in user scope: 18,664 Workloads, 18,664
container specs, 285,564 VMs and 1,994,751 events. The fresh 661,377,024-byte seed
has logical SHA-256 `71be32cffdbb705f3c52ea89f06743397e26000d7ac8fc7b7180f2d944fba131`.
Hosted/API scope is correctness-only here. Other profiles, remaining list limits,
fixed-arrival load and recovery were not qualified. Zero health misses under this
serial matrix do not establish health protection under load.

Diagnostic median process CPU during A/B trial traffic was 45.43 → 32.65 seconds;
median event-loop p99 was 387.8 → 259.3 ms. Peak RSS ranges overlapped at
680.4–691.7/675.8–686.8 MiB. These metrics have no discretionary acceptance gate.

## Attribution, verification and retention

Application: `913f8e992adbefd8d236d59fcec89f99dd788503` (0.1.64).
Measured harness: `2dc2447cac405bff68b04927a717d20d19376a37`.
Protocol: `list-fixture-preflight-v2`; candidate patch SHA-256:
`36949d4347621af7fc7c2b4a899a6b44019a1cbbdccd0a3424b8abb3ff302f50`.
Node 22.14.0, better-sqlite3 11.10.0, SQLite 3.49.2. GitHub-hosted Ubuntu 24.04,
Linux 6.17.0-1022-azure, x64, two AMD EPYC 7763 virtual CPUs, 7.75 GiB RAM.
Both arms have the same native module, lockfile and migrations. Build, harness,
fixture, runtime and native fingerprints remain in the inventory.

Execution used **28.97 of 30 minutes**, including diagnostics, correctness,
calibration, comparison, validation and drainage. Builds, fixture preparation
and repository checks are separate. Before measurement, `yarn verify` passed
with **10,178 tests across 421 files**, and the unchanged six-second
`yarn test:long-history-responsiveness` gate passed with 3,700 Workloads.
The 69 focused harness/workflow regressions and 299 preparation-only HTTP checks
also passed. Preparation failures remain recorded separately from timing evidence.

The separate regular PR test job
tested merge build `8b3bbe103c747e6bbc2a64f57daf2db811db6cae` and failed an
SSH-process test with an undefined child PID (10,323 passes, one failure). Its log
and annotation are retained. The successful study verification does not erase
that failure. The
older isolated candidate's broad `SCAN d` plan assertion also remains unresolved,
as recorded in the aggregation decision; no test was relaxed here.

CI upload and download verification passed. Local verification using both the
checkout and the archived standalone verifier recomputed the same decisions and
verified **734 inventoried files**, complete trial order, trace counts, gzip
decoding, response equality, fixture proofs and storage receipts. Raw JSONL,
compressed complete responses/databases, SQL/plans, source, host/setup traces and
logs are retained in the seven-day CI artifact and the ignored local directory
`.context/list-repeatability-storage-20260917T065431Z/`. Its 98 MB
`list-repeatability-evidence.tar.gz` archive and inventory hashes are in the
committed [receipt](repeatability-receipt.json). The original aggregation archive
and inventory still match their original hashes.

## Disposition

Retain the candidate and this evidence for review. There is a measured
improvement worth preserving, but the frozen all-gates rule prevents advancing
this result to full qualification or an implementation PR. No new samples or
threshold changes are authorized by this result.

The smallest possible product change remains the selected-ID/VM-total/final
projection change in the two list queries, with a precise bounded-scan regression.
Any future qualification must first resolve the status-control uncertainty under
a separately justified, frozen protocol, then cover the complete six-profile,
both-scope matrix, load/recovery gates and actual proposed merge. Remove the
temporary manual job and unused experiment after review while retaining the
immutable decision and raw evidence. No production source, schema, public API,
dependency, merge, release or deployment changed.
