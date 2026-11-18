# Status-control diagnosis: no promotion

The approved bounded follow-up is complete. The saved audit and four profiled
trials did not demonstrate a correctable defect in the unprofiled harness or a
causal candidate-specific regression. No shared performance correction, new
A/A→A/B study or implementation PR follows. B stays parked and C stays rejected.

The completed v2 decision
is unchanged: list SQL improved 41–47% and HTTP p50 improved 37–42%, but the
status-p95 protection interval reached `1.0545436234` against `1.05`. Aggregation
remains unqualified for production. These diagnostic timings do not replace that
unprofiled evidence.

## What the four trials showed

Each endpoint had ten warmups and fifty diagnostic observations, plus separate
first requests. The original sequence was ordinary list, terminatable list,
daily cost and status; isolated trials made no list requests. Order was sequence
baseline/candidate, then isolated candidate/baseline.

| Profiled status trial | SQL mean, ms | HTTP p50, ms | HTTP p95, ms | Requests overlapping API GC |
| --------------------- | -----------: | -----------: | -----------: | --------------------------: |
| Sequence, baseline    |        2.322 |        6.959 |        9.057 |                       16/50 |
| Sequence, candidate   |        2.306 |        7.147 |        9.651 |                       18/50 |
| Isolated, candidate   |        2.729 |        9.244 |       12.909 |                       20/50 |
| Isolated, baseline    |        2.689 |        8.489 |       12.119 |                       19/50 |

All 242 status responses were the same 121,589 bytes and matched the prior study's
response hash. Each used five SQL calls and the same four distinct statements and
plans. The complete response hash is
`1ca10333fc423dfc00d100ad7040506f264cec8b7716a9c471d374a2ce69e0a0`.

API GC occurred outside the observed handler intervals. Both sequence p95
requests illustrate why handler duration alone misses it:

| Sequence p95 request    | HTTP, ms | Handler, ms | Before server observation, ms | API GC overlap before observation, ms |
| ----------------------- | -------: | ----------: | ----------------------------: | ------------------------------------: |
| Baseline `request-227`  |    9.057 |       5.904 |                         2.645 |                                 2.228 |
| Candidate `request-202` |    9.651 |       5.817 |                         3.254 |                                 1.988 |

Transport events place client header writes before those GC pauses end and server
observation afterward. The candidate's handler and overlapping GC duration were
shorter in these two examples; the remaining wait cannot be assigned to one
cause. Client GC also overlapped some slow requests, including the isolated
baseline's p95. The isolated candidate's p95 overlapped API GC after server
completion while its client completed the body. These are different timelines.

Individual journal-write p95s were 0.025–0.092 ms across the trials. Sequence
status serialization means were 0.394/0.375 ms for baseline/candidate. CPU profiles
also retain SQL, schema validation, wire JSON serialization and observer work.
Profiling and diagnostic writes perturb execution; their presence cannot prove
what caused the prior unprofiled interval. Slower isolated status in both builds
also prevents treating preceding list work as a demonstrated cause. No request,
control, GC interaction or timing threshold was removed to obtain a pass.

## Revisions, accounting and limits

The frozen protocol
ran as 35241899689,
using harness `e90cf6d34e5b16c2778e2e505a6ee081be558ae7`, application
`913f8e992adbefd8d236d59fcec89f99dd788503`, and unchanged aggregation patch
`36949d4347621af7fc7c2b4a899a6b44019a1cbbdccd0a3424b8abb3ff302f50`.
The fresh Ubuntu VM had two AMD EPYC 7763 vCPUs, 7.75 GiB RAM, Node 22.14.0,
better-sqlite3 11.10.0 and SQLite 3.49.2. The fixture contained 18,664 Workloads,
285,564 VMs and 1,994,751 events. All live copies were independent and validated
after health drainage.

Execution took 221.548 seconds of its 1,200-second budget. The diagnosis was
recorded 1,015.072 seconds after execution began, including download and analysis.
All 604 offered work requests completed, including 500 diagnostic samples; all
904 health offers completed. There were zero errors, skips, deadline misses,
unfinished requests or remaining handlers. This was matrix diagnosis, not load
or production qualification. One profiled trial per arm/scenario establishes no
confidence interval or causal treatment effect. CPU-profile alignment has a
14–22 ms start bracket and is used for phase summaries, not request-scale timing.

## Verification and retained evidence

CI `yarn verify` passed 10,187 tests in 422 files. The unchanged six-second
integration gate passed for 3,700 Workloads. Local preparation passed 73 focused
tests and 184 HTTP requests. CI readback and the downloaded standalone verifier
validated all four trials, twelve CPU profiles, complete responses, accounting,
plans and fingerprints. The generalized default verifier also reproduced v2's
unchanged result.

Raw artifacts expire September 24, 2026. The independently checked local archive
is `.context/list-status-control-20260917T150719Z/status-control-evidence.tar.gz`:
94,979,878 bytes, SHA-256
`04753d11369d7b29371b5d158cf2dd1fa809ad39591000d5d618e6a038c909e5`.
All 133 archived files match inventory
`cea8fe645caf73a892a1d0fd8a786a811306f269717f59887ab3492efb515db4`.
The same output directory retains the saved-evidence audit, failed local
preparations, analysis source and both analysis versions. The first analysis
checked API GC only inside handlers; the retained correction checks complete HTTP
intervals. It changes no raw measurement or qualification decision.

The [machine-readable receipt](status-control-receipt.json) records exact values,
artifact identifiers and hashes. Preserve the original archives and this decision.
The precise bounded-scan regression, full profile/scope/load/recovery work and
actual proposed-merge qualification remain unperformed because their prerequisite
was not met. Remove the temporary manual scenario and unused experiment after
review; merge, release and deployment remain outside this work.
