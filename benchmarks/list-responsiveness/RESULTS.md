# List responsiveness results

**Do not promote either candidate from this spike.** B preserves public behavior and
has large gains on retry-heavy pages, but its control qualification remains
inconclusive after six repetitions. Reject C for now: it fails a control screen
and its incremental benefit over B is inconsistent. Remaining health misses are
not an automatic rejection criterion. No production implementation or deployment
was performed.

Six repetitions per arm covered 96 cases: 86,400 HTTP observations in 216 fresh
processes, plus 36 load trials. Timing variation prompted three added repetitions
in both lanes; all slow trials remain included.

Values are milliseconds: SQL is the median per-trial mean synchronous SQL time;
HTTP is the median per-trial p50 through body completion. Each case has 50
observations after ten warmups.

| Fixture / scope / limit 1000 |  A SQL |  B SQL |  C SQL | A HTTP | B HTTP | C HTTP |
| ---------------------------- | -----: | -----: | -----: | -----: | -----: | -----: |
| retry / user / ordinary      | 412.14 | 131.24 | 123.22 | 402.28 | 140.33 | 135.87 |
| retry / user / terminatable  | 257.59 |  64.88 |  62.05 | 254.39 |  76.52 |  73.62 |
| retry / api / ordinary       | 251.67 |  81.95 |  77.40 | 263.35 | 101.04 |  93.29 |
| retry / api / terminatable   | 236.52 |  80.84 |  68.86 | 238.95 |  88.74 |  82.96 |
| mixed / user / ordinary      | 365.66 | 133.98 | 187.39 | 371.32 | 141.08 | 208.17 |
| mixed / user / terminatable  | 189.38 |  71.05 |  82.80 | 200.98 |  75.31 |  96.28 |
| mixed / api / ordinary       | 170.75 |  85.23 |  54.86 | 179.79 | 103.59 |  65.94 |
| mixed / api / terminatable   | 201.50 |  94.52 |  48.82 | 211.46 | 113.11 |  59.15 |

All 24 paired retry SQL comparisons in this table favor B by 60–83%. Mixed large
pages improve 50–63% by the ratio of trial medians, but user ordinary repetition
four reverses (+7.9% SQL), as does API terminatable repetition three (+3.6%).
Among 64 control cases, 17 B cases exceed the 5% median screen with mixed paired
directions. C has 26 uncertain controls and a history/API/default-terminatable
HTTP regression in every pair: +6.6% median paired change, ranging from +1.6% to
+96.5% (+20.8% by the ratio of trial medians). These results do not establish a
production cause for the variation.

Actual outer joins use `idx_vms_deployment_id` in A/B and `list_spike_vms_with_ip`
in C, without hints; provider fallback keeps its broad index. Response sizes and
statement counts match in every case. Mixed ordinary/1000 returns 1,215,517 bytes
with six SQL statements (four list) in user scope, versus 1,215,128 bytes and five
statements (two list) in API scope.

All 216 first requests succeeded and remain separate from steady-state results.
For mixed terminatable/1000, their A/B/C HTTP medians were 351.62/174.81/249.73 ms
in user scope and 229.44/194.74/109.11 ms in API scope. There is no cold OS-cache
claim.

The five-endpoint load used the full 30/60/90-second schedule at 2.4/8/2.4 requests
per second. Each row aggregates six trials: 4,608 work offers/admissions, 10,800
traffic health probes and 5,400 recovery probes. HTTP p95 is the median of trial
successful-response p95s; failures are separate.

| Scope / arm | Successes | Timeouts | Transport errors | Health misses | Recovery misses | HTTP p95 ms |
| ----------- | --------: | -------: | ---------------: | ------------: | --------------: | ----------: |
| user / A    |     3,565 |      186 |              857 |         3,549 |           1,129 |     3306.06 |
| user / B    |     4,473 |       34 |              101 |           483 |             104 |      175.33 |
| user / C    |     4,392 |       60 |              156 |         1,329 |             107 |      670.91 |
| api / A     |     4,056 |      126 |              426 |         2,695 |           1,309 |      667.13 |
| api / B     |     4,433 |       78 |               97 |         1,372 |             325 |      788.01 |
| api / C     |     4,460 |       44 |              104 |         1,312 |             147 |      680.96 |

B improves or ties user-scope completion and health outcomes in all six pairs.
The first API pair reverses: A/B successes are 742/679 and health misses are
243/480. Its unchanged daily-cost SQL averages 156/293 ms and terminal-status SQL
1.35/3.04 ms. Later API pairs improve or tie, but do not erase that reversal.
API B also has a higher median successful-response p95 than A.

All 27,648 offers were admitted. There were no scheduling/admission skips, HTTP
status errors, body-limit failures or unfinished requests. The 1,741 transport
failures never reached application request tracking; their retained message is
`fetch failed`, without a nested cause. All observed handlers drained. Peak
client concurrency was 88, below the 128 cap; this does not measure or bound the
server/network queue. Baseline health failures reached the end of the 90-second
recovery window in both scopes. Late successful probes count as deadline misses.

Medians across the six load trials follow. Loop is each trial’s maximum
event-loop delay; RSS is process peak and includes fixture initialization.

| Scope / arm | CPU seconds | Loop ms | Peak RSS MiB |
| ----------- | ----------: | ------: | -----------: |
| user / A    |       109.1 |  3379.6 |         1282 |
| user / B    |        60.6 |   335.4 |         1130 |
| user / C    |        78.2 |   714.7 |         1002 |
| api / A     |        91.7 |  1050.3 |         1208 |
| api / B     |        73.1 |   762.8 |         1057 |
| api / C     |        70.6 |   644.4 |         1045 |

Equal-work mixed matrix trials also reduced median CPU with B: 54.4 to 23.9
seconds in user scope and 41.3 to 26.1 seconds in API scope. Their peak RSS changed
from 805 to 819 MiB and 992 to 786 MiB respectively. Fixture validation and garbage
collection limit attribution of memory differences to the query change.

C’s mixed index occupies 1,511,424 bytes (1.44 MiB); allocated storage grows
1,515,520 bytes over a 649,355,264-byte database. Median build time is 53.4 ms
(18.0–606.5 ms), excluding subsequent statistics optimization. Across twelve
matrix trials per arm, the 10,000-row insert/membership-change/cost-update probe
medians are 49.2/18.0/25.2 ms for A, 51.7/18.0/26.8 for B and 43.8/18.1/19.5 for C.
A/B writes are identical; large ranges prevent resolving a precise incremental
write penalty. These rollback probes use ended VMs and exclude commit/fsync,
live-write distributions and concurrent writers. Every large-page C/B SQL
comparison above has at least one paired reversal, so the added index has not
earned promotion.

Separate full API/load CPU profiles attribute 41.9%/24.4%/24.0% of sampled time
to SQLite’s native `all()` beneath the production DB executor in A/B/C. It is the
largest active frame; the serialization frames each account for less than 0.4%.
These [diagnostic profiles](../../.context/list-profile-final/profile-summary.json)
are excluded from comparisons. V8 call-boundary attribution cannot isolate
SQLite operators, disk wait or the cause of host variation.

Correctness compares 213 complete HTTP responses per pass: status, bodies and
ordering match across both scopes and all arms. Coverage includes the specified
VM/cost edges, filters, ownership, authorization, selection/order rules and Worker
Job fields. Wrong-key public lists succeed without secret projection; full
hydration recovers canaries with the correct key and fails with the wrong one.
Caught isolation and SQL-shape violations remain fatal.

The original 322 focused tests and eight experiment regressions pass.
`yarn verify` passes: **365 files, 8,894 tests**, with eight existing lint warnings.
No measured harness or candidate code changed after verification. Failed pilots
are catalogued and excluded from every comparison.

Baseline: `02b2d81d878ba52abd62ba990892ea5156945f01` (`0.1.63`), including existing
bounded selection and public projection. Runtime: Node 22.14.0, SQLite 3.49.2,
macOS arm64, Apple M4, ten logical CPUs, 24 GiB memory. Migrated fixtures have
valid container specs; mixed contains 18,664 deployments, 1,994,751 events and
285,564 VMs. This synthetic, shared-Mac experiment freezes business time while
retaining real timers; it does not establish production capacity.

Build SHA-256:
`fcc297e2ad27b048e5eb69ec092b530faa0e082e6a856547a29f65652a7a28ef`.
Harness SHA-256:
`9b520c13bffdf5e3f9910cfac1a113412c895d96d7d9eec8b930cde08b9e16d4`.

See the [run instructions](README.md), [all case/trial results](../../.context/list-full-4/SUMMARY.md)
and [evidence map](../../.context/list-full-4/EVIDENCE.md). Keep both
`.context/list-full-3/` and `.context/list-full-4/`: the latter references the
original seeds and trials. Raw responses, SQL/plans, requests, health records,
fixture manifests, fingerprints, derivations and failures are retained there.

Further qualification needs a stable-runner A/A control and real builds in the
shared runner from earlier PRs. `origin/main` advanced to
`5b803d57d92572f5f807b382642d0886fc92fc95`; its newer Worker/Cluster filters need
coverage. If B qualifies later, the smallest product change is the two outer `ON`
predicates, preserving shared aggregates and existence checks. That work,
permanent CI integration and deployment remain outside this completed spike.
